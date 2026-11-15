// Shared planet shading state: ONE set of uniform objects and ONE atmosphere function used by every
// material on a world (terrain, water, flora, creatures, buildings, vehicles), so lighting, fog and
// aerial perspective always agree. This is what makes a world read as a single photographed place.
//
//   const shared = createShared(planet);
//   shared.uniforms   (objects shared by reference — never replace them, write .value)
//     uTime            float   seconds
//     uSunDir          vec3    unit, toward the sun, world space
//     uSunColor        vec3    sun IRRADIANCE at the camera (= env.sunColor * env.sunIntensity; already
//                              attenuated by the atmosphere: warm at sunset, 0 below the horizon)
//     uSkyColor        vec3    hemisphere ambient irradiance from the sky (upward-facing surface)
//     uGroundColor     vec3    hemisphere ambient irradiance bounced from the ground (downward-facing)
//                      Lighting convention (same as three's physical lights):
//                        radiance = albedo / PI * (uSunColor * NdotL * shadow
//                                                  + mix(uGroundColor, uSkyColor, dot(N, up) * 0.5 + 0.5))
//                      or just call sonderAmbient(N, worldPos) for the ambient part.
//     uFogColor        vec3    sky radiance at the horizon averaged over azimuth (for cheap effects)
//     uFogColorSun     vec3    sky radiance at the horizon toward the sun azimuth
//     uFogDensity      float   sea-level extinction, 1/metres (grey)
//     uCamPos          vec3    camera world position;  uCamWorld mat4 camera.matrixWorld
//     uPlanetR         float   planet radius (sea level)
//     uNight           float   0 day .. 1 deep night at the camera
//     uWind            vec4    xyz direction (world), w strength
//     -- atmosphere internals (owned by sky/, read-only for everyone else) --
//     uAtmoR, uAtmoTop float   sea-level radius / top of atmosphere radius
//     uAtmoShape       vec4    (Rayleigh scale height, Mie scale height, ozone centre, ozone half-width) m
//     uBetaR, uBetaMs, uBetaMe, uBetaO   vec3  Rayleigh scattering, Mie scattering, Mie extinction, ozone absorption (1/m)
//     uMieG            float   Mie anisotropy
//     uShadowDip       float   planet-shadow horizon-dip compression
//     uTransLUT        sampler2D  transmittance LUT 256x64 (r, mu)
//     uSkyLUT          sampler2D  sky-view LUT, re-rendered every frame around the camera
//     uSkyFrame        mat3       columns: sun-ward horizontal, side, up (at the camera)
//     uSkyHorizon      float      elevation (rad, <= 0) of the planet horizon seen from the camera
//
//   shared.glsl.pars   GLSL declarations + functions:
//     vec3 sonderAtmosphere(vec3 color, vec3 worldPos)   aerial perspective for a lit surface (extinction +
//                                                        in-scattering; distant things dissolve into exactly
//                                                        the sky-dome colour behind them)
//     vec3 sonderSky(vec3 dir)                           sky radiance in a world direction (no sun disc),
//                                                        for reflections and ambient; below the horizon it
//                                                        returns haze over a lit ground
//     vec3 sonderSunTransmittance(vec3 worldPos)         atmospheric transmittance from worldPos to the sun
//                                                        (incl. planet shadow) — multiply the star's colour
//     vec3 sonderAmbient(vec3 N, vec3 worldPos)          hemisphere ambient irradiance for normal N
//     vec4 sonderSkyLUT(vec3 dir)                        raw sky-view LUT (rgb radiance, a path transmittance)
//   shared.patchMaterial(mat)    make any built-in three material (Standard/Lambert/Basic/...) apply the
//                                shared atmosphere; returns the material. Safe to call once per material.
//   shared.attach(shaderMat)     merge the shared uniforms into a ShaderMaterial's uniforms (by reference)
//
// In your own ShaderMaterial fragment shader:
//     ${shared.glsl.pars}
//     ... col = sonderAtmosphere(col, vWorldPos);     // vWorldPos = world-space position varying
import * as THREE from 'three';
import { ATMO_GLSL } from './sky/atmosphere.js';

function blankTexture(rgba) {
  const t = new THREE.DataTexture(new Float32Array(rgba), 1, 1, THREE.RGBAFormat, THREE.FloatType);
  t.needsUpdate = true;
  return t;
}

export function createShared(planet) {
  const R = planet.R;
  const uniforms = {
    uTime: { value: 0 },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunColor: { value: new THREE.Color(1, 0.96, 0.9) },
    uSkyColor: { value: new THREE.Color(0.35, 0.5, 0.8) },
    uGroundColor: { value: new THREE.Color(0.2, 0.18, 0.15) },
    uFogColor: { value: new THREE.Color(0.6, 0.72, 0.9) },
    uFogColorSun: { value: new THREE.Color(0.7, 0.72, 0.8) },
    uFogDensity: { value: 0.00012 },
    uCamPos: { value: new THREE.Vector3() },
    uCamWorld: { value: new THREE.Matrix4() },
    uPlanetR: { value: R },
    uNight: { value: 0 },
    uWind: { value: new THREE.Vector4(1, 0, 0, 1) },
    // atmosphere (filled by sky/)
    uAtmoR: { value: R },
    uAtmoTop: { value: R + 5000 },
    uAtmoShape: { value: new THREE.Vector4(700, 210, 1800, 1400) },
    uBetaR: { value: new THREE.Vector3() },
    uBetaMs: { value: new THREE.Vector3() },
    uBetaMe: { value: new THREE.Vector3() },
    uBetaO: { value: new THREE.Vector3() },
    uMieG: { value: 0.78 },
    uShadowDip: { value: 0.22 },
    uTransLUT: { value: blankTexture([1, 1, 1, 1]) },
    uSkyLUT: { value: blankTexture([0, 0, 0, 1]) },
    uSkyFrame: { value: new THREE.Matrix3() },
    uSkyHorizon: { value: 0 },
  };

  const pars = /* glsl */`
#ifndef SONDER_PLANET_SHARED
#define SONDER_PLANET_SHARED
uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
uniform vec3 uGroundColor;
uniform vec3 uFogColor;
uniform vec3 uFogColorSun;
uniform float uFogDensity;
uniform vec3 uCamPos;
uniform mat4 uCamWorld;
uniform float uPlanetR;
uniform float uNight;
uniform vec4 uWind;
uniform float uAtmoR;
uniform float uAtmoTop;
uniform vec4 uAtmoShape;
uniform vec3 uBetaR;
uniform vec3 uBetaMs;
uniform vec3 uBetaMe;
uniform vec3 uBetaO;
uniform float uMieG;
uniform float uShadowDip;
uniform sampler2D uTransLUT;
uniform sampler2D uSkyLUT;
uniform mat3 uSkyFrame;
uniform float uSkyHorizon;
${ATMO_GLSL}
// Sky radiance in a world-space direction (without the sun disc). Used for reflections / ambient.
vec3 sonderSky(vec3 dir) {
  vec4 s = sonderSkyLUT(dir);
  // below the horizon the LUT path ends on the ground: add the lit ground seen through it
  vec2 g = atmoRaySphere(uCamPos, dir, uAtmoR);
  float hitsGround = step(0.0, g.x) * step(g.x, g.y);
  return s.rgb + hitsGround * s.a * uGroundColor * 0.31831;
}
vec3 sonderSunTransmittance(vec3 worldPos) {
  float r = length(worldPos);
  return atmoSunTransmittance(r, dot(worldPos / r, uSunDir));
}
vec3 sonderAmbient(vec3 N, vec3 worldPos) {
  return mix(uGroundColor, uSkyColor, dot(N, normalize(worldPos)) * 0.5 + 0.5);
}
// Aerial perspective: physically-based extinction along the view segment + in-scattering taken from the
// sky-view LUT in the same direction, scaled by the fraction of that path's extinction already reached.
vec3 sonderAtmosphere(vec3 color, vec3 worldPos) {
  vec3 ro = uCamPos;
  vec3 ray = worldPos - ro;
  float dist = length(ray);
  vec3 rd = ray / max(dist, 1e-4);
  vec2 ts = atmoRaySphere(ro, rd, uAtmoTop);
  float a = max(ts.x, 0.0), b = min(ts.y, dist);
  if (b <= a) return color;
  vec3 T = exp(-atmoOpticalDepth(ro, rd, a, b));
  vec4 sky = sonderSkyLUT(rd);
  float f = clamp((1.0 - dot(T, ATMO_LUMA)) / max(1.0 - sky.a, 1e-4), 0.0, 1.0);
  return color * T + sky.rgb * f;
}
#endif
`;

  function attach(material) {
    for (const k of Object.keys(uniforms)) material.uniforms[k] = uniforms[k];
    return material;
  }

  function patchMaterial(material) {
    if (material.userData.sonderPatched) return material;
    material.userData.sonderPatched = true;
    const prev = material.onBeforeCompile;
    material.onBeforeCompile = (shader, renderer) => {
      if (prev) prev.call(material, shader, renderer);
      for (const k of Object.keys(uniforms)) shader.uniforms[k] = uniforms[k];
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vSonderView;')
        .replace('#include <project_vertex>', '#include <project_vertex>\nvSonderView = mvPosition.xyz;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\nvarying vec3 vSonderView;\n${pars}`)
        .replace('#include <dithering_fragment>', `#include <dithering_fragment>\n{ vec3 sonderWorld = (uCamWorld * vec4(vSonderView, 1.0)).xyz; gl_FragColor.rgb = sonderAtmosphere(gl_FragColor.rgb, sonderWorld); }`);
    };
    const key = material.customProgramCacheKey ? material.customProgramCacheKey() : '';
    material.customProgramCacheKey = () => `${key}|sonder-atmo2`;
    material.needsUpdate = true;
    return material;
  }

  return { uniforms, glsl: { pars }, attach, patchMaterial };
}
