// GLSL for the galaxy scale. Everything renders without depth testing; correct dust extinction comes
// from draw ORDER (far layers → dust → near layers) and multiplicative blending, which commutes, so
// nothing has to be sorted. See index.js for the layer stack.
import { GLSL } from '../../core/glsl.js';

// Shared: galactic rotation (flat curve, pattern lock) + depth/side layer selection.
export const galCommon = /* glsl */`
uniform float uTime;
uniform float uOmegaP;
uniform float uRCo;
uniform float uRc;
uniform float uFocusDist;   // view-space depth of the orbit focus
uniform float uCamSide;     // sign of the camera's height above the galactic plane
uniform vec3 uSlice;        // (minRelDepth, maxRelDepth, side: -1 far side, +1 near side, 0 both)
uniform float uProj;        // render-target pixels per world unit at distance 1
vec3 galPos(vec3 orb, float lock) {
  float r = orb.x;
  float w = uOmegaP * uRCo / sqrt(r * r + uRc * uRc);
  w = mix(w, uOmegaP, lock);
  float th = orb.y - w * uTime;
  return vec3(r * cos(th), orb.z, r * sin(th));
}
bool inSlice(vec3 mv, float y) {
  float rel = -mv.z - uFocusDist;
  if (rel < uSlice.x || rel >= uSlice.y) return false;
  if (uSlice.z == 0.0) return true;
  float side = y * uCamSide >= 0.0 ? 1.0 : -1.0;
  return side == uSlice.z;
}
`;

// ---------------------------------------------------------------------------------------------
// Stars + haze (GL points). Each particle has a world-space gaussian sigma and a surface brightness.
// Projected sigma below uMinSigma px is clamped and the peak scaled by (true/clamped)^2, so the
// integrated flux is right and sub-pixel stars never shimmer.
// ---------------------------------------------------------------------------------------------
export const starVert = /* glsl */`
${GLSL.common}
${GLSL.blackbody}
${galCommon}
attribute vec3 aOrbit;
attribute vec4 aStar;     // lum, temperature K, world sigma, lock + 2*kind (kind 1 = haze)
uniform float uMinSigma;
uniform float uStarGain;
uniform float uHazeGain;
uniform float uPeakMax;
uniform float uMaxPoint;
uniform float uHazeMaxPx;
uniform float uStarNear;
uniform float uTwinkle;
varying vec3 vCol;
varying float vK;
void main() {
  float kind = step(1.5, aStar.w);
  float lock = aStar.w - kind * 2.0;
  vec3 p = galPos(aOrbit, lock);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  if (!inSlice(mv.xyz, p.y)) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
  float dist = max(length(mv.xyz), 1e-5);
  float sigT = aStar.z * uProj / dist;
  float sig = max(sigT, uMinSigma);
  float gain = mix(uStarGain, uHazeGain, kind);
  float ratio = sigT / sig;
  float peak = gain * aStar.x * ratio * ratio;
  float fade;
  if (kind > 0.5) fade = 1.0 - smoothstep(uHazeMaxPx * 0.45, uHazeMaxPx, sig);
  else {
    fade = smoothstep(uStarNear * 0.35, uStarNear, dist);
    // slow scintillation of the brightest, keeps the disc alive
    float h = hash11(aOrbit.y * 91.7 + aOrbit.x * 13.1);
    fade *= 1.0 + uTwinkle * smoothstep(8.0, 60.0, aStar.x) * sin(uTime * (0.6 + 1.7 * h) + h * 40.0);
  }
  peak = min(peak, uPeakMax) * fade;
  vCol = blackbody(aStar.y) * peak;
  if (peak < 1e-4) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
  float size = min(sig * 6.0, uMaxPoint);
  vK = sig * 6.0 / size;
  gl_PointSize = size;
  gl_Position = projectionMatrix * mv;
}
`;
export const starFrag = /* glsl */`
varying vec3 vCol;
varying float vK;
void main() {
  vec2 q = (gl_PointCoord - 0.5) * 2.0;
  float r2 = dot(q, q) * 9.0 * vK * vK;
  float g = exp(-0.5 * r2);
  // feather the square's edge so a clamped (capped) sprite never shows a hard rim
  g *= 1.0 - smoothstep(0.82, 1.0, dot(q, q));
  gl_FragColor = vec4(vCol * g, 1.0);
}
`;

// ---------------------------------------------------------------------------------------------
// Dust: instanced billboards squashed along the disc normal (oblate clouds). Seen edge-on they
// become thin streaks with a longer optical path. Output is an absorbance; blending multiplies the
// destination by (1 - absorbance), reddening because blue is absorbed more.
// ---------------------------------------------------------------------------------------------
export const dustVert = /* glsl */`
${GLSL.common}
${galCommon}
attribute vec3 aOrbit;
attribute vec4 aPrm;      // radius, opacity, flatten, lock
attribute vec2 aTex;      // atlas tile, rotation
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform float uDust;
varying vec2 vUv;
varying vec2 vTile;
varying float vA;
void main() {
  vec3 c = galPos(aOrbit, aPrm.w);
  vec4 mvc = modelViewMatrix * vec4(c, 1.0);
  if (!inSlice(mvc.xyz, c.y)) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float dist = max(length(mvc.xyz), 1e-5);
  float size = aPrm.x;
  float px = size * uProj / dist;
  float minPx = 1.5;
  float grow = max(1.0, minPx / max(px, 1e-4));
  float cr = cos(aTex.y), sr = sin(aTex.y);
  vec2 q = vec2(cr * position.x - sr * position.y, sr * position.x + cr * position.y);
  vec3 off = (uCamRight * q.x + uCamUp * q.y) * size * grow;
  float flat = aPrm.z;
  off.y *= flat;
  vec3 wp = c + off;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  float incl = abs(normalize(c - cameraPosition).y);
  float tau = min(1.0 / max(incl, flat), 3.5);
  float nearFade = smoothstep(size * 0.6, size * 2.5, dist);
  vA = aPrm.y * uDust * tau * nearFade / (grow * grow);
  vUv = position.xy * 0.5 + 0.5;
  float t = aTex.x;
  vTile = vec2(mod(t, 4.0), floor(t / 4.0));
}
`;
export const dustFrag = /* glsl */`
uniform sampler2D tAtlas;
uniform vec3 uExtinction;
varying vec2 vUv;
varying vec2 vTile;
varying float vA;
void main() {
  float d = texture2D(tAtlas, (vTile + vUv) * 0.25).r;
  float a = 1.0 - exp(-d * vA * 2.2);
  gl_FragColor = vec4(clamp(a * uExtinction, 0.0, 0.985), 1.0);
}
`;

// ---------------------------------------------------------------------------------------------
// Nebulae (HII / OIII / reflection): instanced additive puffs, constant surface brightness.
// ---------------------------------------------------------------------------------------------
export const nebVert = /* glsl */`
${GLSL.common}
${galCommon}
attribute vec3 aOrbit;
attribute vec4 aPrm;      // radius, intensity, kind, lock
attribute vec2 aTex;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform float uNeb;
varying vec2 vUv;
varying vec2 vTile;
varying vec3 vCol;
varying vec3 vCore;
void main() {
  vec3 c = galPos(aOrbit, aPrm.w);
  vec4 mvc = modelViewMatrix * vec4(c, 1.0);
  if (!inSlice(mvc.xyz, c.y)) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float dist = max(length(mvc.xyz), 1e-5);
  float size = aPrm.x;
  float px = size * uProj / dist;
  float minPx = 1.6;
  float grow = max(1.0, minPx / max(px, 1e-4));
  float cr = cos(aTex.y), sr = sin(aTex.y);
  vec2 q = vec2(cr * position.x - sr * position.y, sr * position.x + cr * position.y);
  vec3 wp = c + (uCamRight * q.x + uCamUp * q.y) * size * grow;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  float nearFade = smoothstep(size * 0.8, size * 3.0, dist);
  float k = aPrm.z;
  vec3 ha = vec3(1.0, 0.16, 0.34);
  vec3 o3 = vec3(0.18, 0.95, 0.85);
  vec3 refl = vec3(0.32, 0.52, 1.0);
  vCol = (k < 0.5 ? ha : k < 1.5 ? mix(ha, o3, 0.35) : refl);
  vCore = (k > 0.5 && k < 1.5) ? o3 * 1.4 : vec3(0.75, 0.85, 1.0);
  float I = aPrm.y * uNeb * nearFade / (grow * grow);
  vCol *= I; vCore *= I;
  vUv = position.xy * 0.5 + 0.5;
  float t = aTex.x;
  vTile = vec2(mod(t, 4.0), floor(t / 4.0));
}
`;
export const nebFrag = /* glsl */`
uniform sampler2D tAtlas;
varying vec2 vUv;
varying vec2 vTile;
varying vec3 vCol;
varying vec3 vCore;
void main() {
  vec4 t = texture2D(tAtlas, (vTile + vUv) * 0.25);
  vec2 q = vUv * 2.0 - 1.0;
  float r2 = dot(q, q);
  float core = exp(-r2 * 18.0);
  vec3 col = vCol * t.g + vCore * core * (0.4 + t.b);
  gl_FragColor = vec4(col, 1.0);
}
`;

// ---------------------------------------------------------------------------------------------
// Procedural sprite atlas (4x4 tiles): R = dust density, G = emission nebula, B = soft core mask.
// ---------------------------------------------------------------------------------------------
export const atlasFrag = /* glsl */`
precision highp float;
${GLSL.common}
${GLSL.simplex3}
${GLSL.fbm}
varying vec2 vUv;
void main() {
  vec2 cell = floor(vUv * 4.0);
  vec2 uv = fract(vUv * 4.0);
  vec2 p = uv * 2.0 - 1.0;
  float seed = cell.x + cell.y * 4.0;
  vec3 s = vec3(seed * 7.13, seed * 3.71, seed * 1.9);
  float r = length(p);
  float fall = smoothstep(1.0, 0.25, r);
  // dust: warped fbm, half the tiles filamentary (ridged)
  float n = warpedFbm(vec3(p * 1.4, 0.0) + s, 5, 0.9) * 0.5 + 0.5;
  float rid = ridgedFbm(vec3(p * 1.1, 1.7) + s, 5);
  float fil = mod(seed, 2.0) < 0.5 ? 0.0 : 1.0;
  float dust = mix(smoothstep(0.32, 0.78, n), smoothstep(0.25, 0.75, rid) * (0.6 + 0.6 * n), fil);
  dust *= fall * fall;
  // emission: clumpy, brighter towards the middle, ragged edge
  float e = fbm(vec3(p * 2.3, 4.0) + s, 5) * 0.5 + 0.5;
  float neb = pow(clamp(e * 1.25 - r * 0.55, 0.0, 1.0), 2.2) * smoothstep(1.0, 0.45, r);
  float soft = exp(-r * r * 3.0) * (0.6 + 0.8 * e);
  gl_FragColor = vec4(dust, neb, soft, 1.0);
}
`;

// ---------------------------------------------------------------------------------------------
// Deep field: thousands of faint distant galaxies at infinity.
// ---------------------------------------------------------------------------------------------
export const deepVert = /* glsl */`
attribute vec3 aDir;
attribute vec4 aShape;    // size px, axis ratio, angle, brightness
attribute vec4 aCol;      // rgb, type (0 elliptical, 1 spiral, 2 edge-on)
uniform float uPx;
varying vec3 vCol;
varying vec3 vShape;
void main() {
  vec3 d = mat3(viewMatrix) * aDir;
  gl_Position = projectionMatrix * vec4(d, 1.0);
  gl_Position.z = gl_Position.w * 0.9999;
  float s = aShape.x * uPx;
  gl_PointSize = max(s, 2.0);
  float comp = s < 2.0 ? (s * s) / 4.0 : 1.0;
  vCol = aCol.rgb * aShape.w * comp;
  vShape = vec3(aShape.y, aShape.z, aCol.a);
}
`;
export const deepFrag = /* glsl */`
varying vec3 vCol;
varying vec3 vShape;
void main() {
  vec2 q = (gl_PointCoord - 0.5) * 2.0;
  float c = cos(vShape.y), s = sin(vShape.y);
  q = vec2(c * q.x - s * q.y, s * q.x + c * q.y);
  q.y /= max(vShape.x, 0.08);
  float r = length(q);
  float g;
  if (vShape.z < 0.5) g = exp(-r * r * 6.0);                                   // elliptical
  else {
    float a = atan(q.y, q.x);
    float arms = 0.65 + 0.35 * cos(2.0 * a - 7.0 * r);
    g = exp(-r * 4.5) * arms + exp(-r * r * 40.0) * 0.8;                       // tiny spiral
  }
  g *= smoothstep(1.0, 0.7, r);
  gl_FragColor = vec4(vCol * g, 1.0);
}
`;
