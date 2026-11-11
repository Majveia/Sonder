// Shared planet shading state: ONE set of uniform objects and ONE atmosphere function used by every
// material on a world (terrain, water, flora, creatures, buildings, vehicles), so lighting, fog and
// aerial perspective always agree. This is what makes a world read as a single photographed place.
//
//   const shared = createShared(planet);
//   shared.uniforms              { uTime, uSunDir, uSunColor, uSkyColor, uGroundColor, uFogColor, uFogDensity,
//                                  uCamPos, uCamWorld, uPlanetR, uNight, uWind }   (objects shared by reference)
//   shared.glsl.pars             GLSL declarations + `vec3 sonderAtmosphere(vec3 color, vec3 worldPos)`
//   shared.patchMaterial(mat)    make any built-in three material (Standard/Lambert/Basic/...) apply the
//                                shared atmosphere; returns the material. Safe to call once per material.
//   shared.attach(shaderMat)     merge the shared uniforms into a ShaderMaterial's uniforms (by reference)
//
// In your own ShaderMaterial fragment shader:
//     ${shared.glsl.pars}
//     ... col = sonderAtmosphere(col, vWorldPos);     // vWorldPos = world-space position varying
//
// NOTE: internals here are a simple placeholder (exponential height fog). The sky/atmosphere system
// upgrades the function body; the names and signatures above are the stable contract.
import * as THREE from 'three';

export function createShared(planet) {
  const uniforms = {
    uTime: { value: 0 },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },        // unit, toward the sun, world space
    uSunColor: { value: new THREE.Color(1, 0.96, 0.9) },    // linear HDR radiance of direct sun at the camera
    uSkyColor: { value: new THREE.Color(0.35, 0.5, 0.8) },  // ambient from the sky dome (zenith-ish)
    uGroundColor: { value: new THREE.Color(0.2, 0.18, 0.15) },
    uFogColor: { value: new THREE.Color(0.6, 0.72, 0.9) },  // horizon haze colour (already lit)
    uFogDensity: { value: 0.00012 },                         // 1/metres at sea level
    uCamPos: { value: new THREE.Vector3() },
    uCamWorld: { value: new THREE.Matrix4() },               // camera.matrixWorld (view -> world)
    uPlanetR: { value: planet.R },
    uNight: { value: 0 },                                    // 0 day .. 1 deep night at the camera
    uWind: { value: new THREE.Vector4(1, 0, 0, 1) },         // xyz direction (world), w strength
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
uniform float uFogDensity;
uniform vec3 uCamPos;
uniform mat4 uCamWorld;
uniform float uPlanetR;
uniform float uNight;
uniform vec4 uWind;
// Aerial perspective: blend a lit surface colour toward the atmosphere along the view ray.
vec3 sonderAtmosphere(vec3 color, vec3 worldPos) {
  vec3 ray = worldPos - uCamPos;
  float dist = length(ray);
  vec3 dir = ray / max(dist, 1e-4);
  float h0 = max(length(uCamPos) - uPlanetR, 0.0);
  float h1 = max(length(worldPos) - uPlanetR, 0.0);
  float hm = 0.5 * (h0 + h1);
  float density = uFogDensity * exp(-hm / 900.0);
  float t = 1.0 - exp(-dist * density);
  float sunAmt = pow(max(dot(dir, uSunDir), 0.0), 8.0);
  vec3 fog = uFogColor + uSunColor * sunAmt * 0.25 * (1.0 - uNight);
  return mix(color, fog, clamp(t, 0.0, 1.0));
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
    material.customProgramCacheKey = () => `${key}|sonder-atmo`;
    material.needsUpdate = true;
    return material;
  }

  return { uniforms, glsl: { pars }, attach, patchMaterial };
}
