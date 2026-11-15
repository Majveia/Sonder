// Terrain material: MeshStandardMaterial (three's lights + shadow maps for free) extended through
// onBeforeCompile with
//   * per-vertex biome weights (aW0/aW1, baked by the worker from biome.js — the shader never re-derives
//     the rules, it only sharpens transitions with the detail textures' height channel),
//   * texture-based triplanar detail (one DataArrayTexture, one layer per material: normal.xy, height, luma)
//     at two scales (near ~3 m, mid ~23 m, rotated) with a distance fade,
//   * palette colours, macro colour variation (per-vertex 3-D noise fields: no tiling at any distance),
//     strata bands on cliffs, wet shores, curvature AO, snow glints,
//   * the shared planet atmosphere (shared.patchMaterial).
import * as THREE from 'three';
import { MATERIALS } from './biome.js';

const ROUGH = { sand: 0.93, grass: 0.9, grassDry: 0.92, forest: 0.95, soil: 0.9, rock: 0.82, cliff: 0.78, snow: 0.55 };

export function createTerrainMaterial(planet, texture) {
  const { desc, shared } = planet;
  const pal = desc.palette || {};
  const col = (k, fb) => new THREE.Color(pal[k] || fb);
  const palette = MATERIALS.map((k) => col(k, '#808080'));
  const uniforms = {
    uTerrainTex: { value: texture },
    uPal: { value: palette },
    uRough: { value: MATERIALS.map((k) => ROUGH[k]) },
    uRockDark: { value: col('rockDark', '#404040') },
    uSandCol: { value: col('sand', '#c0b090') },
    uDeep: { value: new THREE.Color(desc.ocean ? desc.ocean.deep : '#000000') },
    uHasSea: { value: desc.ocean && desc.ocean.kind !== 'lava' ? 1 : 0 },
    uStrata: { value: desc.type === 'desert' ? 1.0 : desc.type === 'crystal' ? 0.6 : 0.4 },
    uTileNear: { value: 1 / 3.1 },
    uTileMid: { value: 1 / 23.0 },
  };
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0 });
  mat.name = 'sonder-terrain';
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec4 aW0; attribute vec4 aW1; attribute vec4 aData;
varying vec4 vW0; varying vec4 vW1; varying vec4 vData; varying vec3 vTWorld; varying vec3 vTNormal;`)
      .replace('#include <project_vertex>', `#include <project_vertex>
vW0 = aW0; vW1 = aW1; vData = aData;
vTWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
vTNormal = normalize(mat3(modelMatrix) * objectNormal);`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
${FRAG_PARS}`)
      .replace('#include <map_fragment>', FRAG_ALBEDO)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = tRough;')
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\nnormal = normalize((viewMatrix * vec4(tNw, 0.0)).xyz);')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += tEmit;')
      .replace('#include <aomap_fragment>', '#include <aomap_fragment>\nreflectedLight.indirectDiffuse *= tAO; reflectedLight.indirectSpecular *= tAO;');
  };
  mat.customProgramCacheKey = () => 'sonder-terrain-v1';
  shared.patchMaterial(mat);
  mat.userData.terrainUniforms = uniforms;
  return mat;
}

const FRAG_PARS = /* glsl */`
precision highp sampler2DArray;
uniform sampler2DArray uTerrainTex;
uniform vec3 uPal[8];
uniform float uRough[8];
uniform vec3 uRockDark; uniform vec3 uSandCol; uniform vec3 uDeep;
uniform float uHasSea; uniform float uStrata; uniform float uTileNear; uniform float uTileMid;
varying vec4 vW0; varying vec4 vW1; varying vec4 vData; varying vec3 vTWorld; varying vec3 vTNormal;
vec3 tNw; float tRough; float tAO; vec3 tEmit;
// constant rotation for the mid-scale sample so its grid never lines up with the near one
const mat3 T_ROT = mat3(0.8191, 0.3420, -0.4602, -0.2620, 0.9358, 0.2358, 0.5113, -0.0858, 0.8551);
float tHash(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
// triplanar sample of one layer: returns (height, luma) and the world-space normal perturbation (UDN)
vec2 triLayer(float layer, vec3 p, vec3 N, vec3 bw, vec3 dpx, vec3 dpy, float sc, out vec3 pert) {
  vec3 sg = vec3(N.x < 0.0 ? -1.0 : 1.0, N.y < 0.0 ? -1.0 : 1.0, N.z < 0.0 ? -1.0 : 1.0);
  vec2 uX = p.zy * sc, uY = p.xz * sc, uZ = p.xy * sc;
  vec2 xX = dpx.zy * sc, xY = dpx.xz * sc, xZ = dpx.xy * sc;
  vec2 yX = dpy.zy * sc, yY = dpy.xz * sc, yZ = dpy.xy * sc;
  uX.x *= sg.x; xX.x *= sg.x; yX.x *= sg.x;
  uY.x *= sg.y; xY.x *= sg.y; yY.x *= sg.y;
  uZ.x *= -sg.z; xZ.x *= -sg.z; yZ.x *= -sg.z;
  vec4 tX = textureGrad(uTerrainTex, vec3(uX, layer), xX, yX);
  vec4 tY = textureGrad(uTerrainTex, vec3(uY, layer), xY, yY);
  vec4 tZ = textureGrad(uTerrainTex, vec3(uZ, layer), xZ, yZ);
  vec2 nX = tX.rg * 2.0 - 1.0, nY = tY.rg * 2.0 - 1.0, nZ = tZ.rg * 2.0 - 1.0;
  nX.x *= sg.x; nY.x *= sg.y; nZ.x *= -sg.z;
  pert = vec3(0.0, nX.y, nX.x) * bw.x + vec3(nY.x, 0.0, nY.y) * bw.y + vec3(nZ.x, nZ.y, 0.0) * bw.z;
  return vec2(dot(vec3(tX.b, tY.b, tZ.b), bw), dot(vec3(tX.a, tY.a, tZ.a), bw));
}
`;

const FRAG_ALBEDO = /* glsl */`
{
  vec3 P = vTWorld;
  vec3 Ng = normalize(vTNormal);
  vec3 upv = normalize(P);
  vec3 toCam = cameraPosition - P;
  float dist = length(toCam);
  float hgt = vData.x;
  float w[8];
  w[0] = vW0.x; w[1] = vW0.y; w[2] = vW0.z; w[3] = vW0.w; w[4] = vW1.x; w[5] = vW1.y; w[6] = vW1.z; w[7] = vW1.w;
  // the two strongest materials get textured detail
  int ia = 0; int ib = 1;
  if (w[1] > w[0]) { ia = 1; ib = 0; }
  for (int i = 2; i < 8; i++) {
    if (w[i] > w[ia]) { ib = ia; ia = i; } else if (w[i] > w[ib]) { ib = i; }
  }
  vec3 bw = pow(abs(Ng), vec3(6.0)); bw /= (bw.x + bw.y + bw.z);
  vec3 dpx = dFdx(P), dpy = dFdy(P);
  float kNear = 1.0 - smoothstep(25.0, 260.0, dist);   // near detail fades out
  float kMid = 1.0 - smoothstep(700.0, 2600.0, dist);  // mid detail fades out
  vec2 hlA = vec2(0.5), hlB = vec2(0.5);
  vec3 pA = vec3(0.0), pB = vec3(0.0);
  if (kMid > 0.0) {
    vec3 q; vec2 r;
    vec3 Pm = T_ROT * P, Nm = T_ROT * Ng, dxm = T_ROT * dpx, dym = T_ROT * dpy;
    vec3 bwm = pow(abs(Nm), vec3(6.0)); bwm /= (bwm.x + bwm.y + bwm.z);
    r = triLayer(float(ia), Pm, Nm, bwm, dxm, dym, uTileMid, q);
    hlA = mix(hlA, r, kMid * 0.75); pA += (q * T_ROT) * 0.8 * kMid;
    r = triLayer(float(ib), Pm, Nm, bwm, dxm, dym, uTileMid, q);
    hlB = mix(hlB, r, kMid * 0.75); pB += (q * T_ROT) * 0.8 * kMid;
    if (kNear > 0.0) {
      r = triLayer(float(ia), P, Ng, bw, dpx, dpy, uTileNear, q);
      hlA = vec2(mix(hlA.x, r.x, kNear * 0.7), hlA.y + (r.y - 0.5) * kNear); pA += q * kNear;
      r = triLayer(float(ib), P, Ng, bw, dpx, dpy, uTileNear, q);
      hlB = vec2(mix(hlB.x, r.x, kNear * 0.7), hlB.y + (r.y - 0.5) * kNear); pB += q * kNear;
    }
  }
  // height-blended weights (texture height decides who wins inside a transition)
  float x[8]; float mx = -1.0;
  for (int i = 0; i < 8; i++) {
    float hh = i == ia ? hlA.x : (i == ib ? hlB.x : 0.5);
    x[i] = w[i] > 0.004 ? w[i] + hh * 0.55 : -1.0;
    mx = max(mx, x[i]);
  }
  float fsum = 0.0; float f[8];
  for (int i = 0; i < 8; i++) { f[i] = max(x[i] - (mx - 0.14), 0.0); fsum += f[i]; }
  // strata bands for cliffs / rock: sedimentary layering follows altitude (correct on a sphere)
  float m1 = vData.z, m2 = vData.w;
  float bnd = 0.5 + 0.5 * sin(hgt * 0.19 + m2 * 1.7 + m1 * 4.0);
  float bnd2 = 0.5 + 0.5 * sin(hgt * 0.83 + m1 * 6.0 + 1.3);
  vec3 strat = mix(uPal[6], uPal[5], smoothstep(0.35, 0.75, bnd));
  strat = mix(strat, uSandCol, smoothstep(0.78, 0.96, bnd2) * 0.55);
  strat *= 0.82 + 0.3 * bnd2;
  vec3 alb = vec3(0.0); float rough = 0.0;
  for (int i = 0; i < 8; i++) {
    float fi = f[i] / max(fsum, 1e-4);
    if (fi <= 0.0) continue;
    vec3 c = uPal[i];
    if (i == 6) c = mix(c, strat, uStrata);
    else if (i == 5) c = mix(c, strat, uStrata * 0.45);
    float lum = i == ia ? hlA.y : (i == ib ? hlB.y : 0.5);
    alb += fi * c * (0.35 + 1.3 * clamp(lum, 0.0, 1.0));
    rough += fi * uRough[i];
  }
  float fa = f[ia], fb = f[ib];
  vec3 pert = (pA * fa + pB * fb) / max(fa + fb, 1e-4);
  // macro variation: value + slight warm/cool drift over km / 200 m (per-vertex 3-D noise, never tiles)
  alb *= 1.0 + 0.16 * m1 + 0.1 * m2;
  alb *= vec3(1.0 + 0.045 * m2 - 0.02 * m1, 1.0, 1.0 - 0.05 * m2 + 0.03 * m1);
  // wet shores and the sea floor
  if (uHasSea > 0.5) {
    float wet = smoothstep(1.6, 0.1, hgt);
    alb *= 1.0 - 0.42 * wet;
    rough = mix(rough, 0.32, wet * smoothstep(-1.0, 0.3, hgt));
    alb = mix(alb, uDeep * 0.6, smoothstep(-2.0, -70.0, hgt) * 0.8);
  }
  // ambient occlusion: concave ground (curvature) + micro occlusion from the detail height
  float curv = vData.y;
  float hAO = mix(hlA.x, hlB.x, fb / max(fa + fb, 1e-4));
  tAO = clamp(1.0 - max(curv, 0.0) * 1.2, 0.45, 1.0) * mix(1.0, 0.55 + 0.6 * hAO, kNear * 0.8);
  tNw = normalize(Ng + pert * 0.9);
  // keep detail normals from flipping the surface away from the camera at grazing angles
  vec3 V = toCam / max(dist, 1e-3);
  tNw = normalize(tNw + Ng * max(0.0, -dot(tNw, V)) * 1.2);
  tRough = rough;
  // snow glints: sparse sun-aligned facets in the snow material
  tEmit = vec3(0.0);
  float fSnow = f[7] / max(fsum, 1e-4);
  if (fSnow > 0.05 && dist < 60.0) {
    float g = step(0.985, tHash(floor(P * 38.0)));
    vec3 hv = normalize(V + uSunDir);
    tEmit = uSunColor * g * fSnow * pow(max(dot(tNw, hv), 0.0), 24.0) * 0.35 * (1.0 - smoothstep(20.0, 60.0, dist));
  }
  diffuseColor.rgb = alb;
}
`;
