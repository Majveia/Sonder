// GLSL for the cosmic web. Three additive point layers share ONE geometry (four keyframe slots,
// Catmull-Rom interpolated in the vertex shader with periodic unwrap) plus an early-universe glow.
import GLSL from '../../core/glsl.js';

// Shared vertex core: reconstruct the particle's box-fraction position, velocity and fields.
export const CORE_VERT = /* glsl */`
${GLSL.common}
attribute vec3 p1; attribute vec3 p2; attribute vec3 p3;          // slot 0 is 'position'
attribute vec2 f0; attribute vec2 f1; attribute vec2 f2; attribute vec2 f3;
uniform vec4 uW;      // Catmull-Rom weights per slot
uniform vec4 uDW;     // derivative weights per slot
uniform vec4 uRef;    // one-hot: slot used as the unwrap reference
uniform vec3 uC;      // focus (box fractions, unbounded) — particles are drawn at their nearest image
uniform float uBox;   // world size of the box (includes expansion scale)
uniform float uTime;
uniform float uPx;    // pixels per world unit at distance 1
uniform float uReveal;
uniform float uA;     // display scale factor
uniform float uEarly; // 1 = dark-ages fog, 0 = structure colours
uniform float uFocusDist;
uniform float uSphere; // radius (box fractions) of the visible sphere around the focus

vec3 unwrapTo(vec3 p, vec3 r) { vec3 d = p - r; d -= floor(d + 0.5); return r + d; }

// log10 density -> designed colour ramp; heat = normalised log velocity dispersion
vec3 webRamp(float ld, float heat) {
  vec3 cVoid  = vec3(0.20, 0.07, 0.52);
  vec3 cWall  = vec3(0.10, 0.20, 0.85);
  vec3 cFil   = vec3(0.02, 0.70, 0.82);
  vec3 cFil2  = vec3(0.40, 0.95, 1.00);
  vec3 cShock = vec3(1.00, 0.20, 0.52);
  vec3 cGold  = vec3(1.00, 0.60, 0.20);
  vec3 cWhite = vec3(1.00, 0.93, 0.82);
  vec3 c = mix(cVoid, cWall, smoothstep(-0.9, -0.15, ld));
  c = mix(c, cFil, smoothstep(-0.15, 0.45, ld));
  c = mix(c, cFil2, smoothstep(0.45, 1.05, ld));
  c = mix(c, cShock, smoothstep(0.32, 0.62, heat) * smoothstep(0.15, 0.8, ld) * 0.9);
  c = mix(c, cGold, smoothstep(1.25, 1.85, ld));
  c = mix(c, cWhite, smoothstep(1.9, 2.6, ld));
  return c;
}

struct P { vec3 q; vec3 vel; float ld; float heat; float id; float rnd; float r; };

P particle() {
  P o;
  vec3 r = position * uRef.x + p1 * uRef.y + p2 * uRef.z + p3 * uRef.w;
  vec3 a0 = unwrapTo(position, r), a1 = unwrapTo(p1, r), a2 = unwrapTo(p2, r), a3 = unwrapTo(p3, r);
  vec3 q = a0 * uW.x + a1 * uW.y + a2 * uW.z + a3 * uW.w;
  o.vel = a0 * uDW.x + a1 * uDW.y + a2 * uDW.z + a3 * uDW.w;
  vec2 f = max(f0 * uW.x + f1 * uW.y + f2 * uW.z + f3 * uW.w, vec2(0.0));
  o.ld = f.x * 5.0 - 1.5;
  o.heat = f.y;
  vec3 rel = fract(q - uC + 0.5) - 0.5;
  o.r = length(rel);
  o.q = uC + rel;
  o.id = float(gl_VertexID);
  o.rnd = hash11(o.id * 0.6180339 + 0.123);
  return o;
}
vec3 worldOf(vec3 q) { return (q - 0.5) * uBox; }
`;

// ---------------------------------------------------------------------------------------------
// Layer: filaments (all particles, small crisp points)
// ---------------------------------------------------------------------------------------------
export const FIL_VERT = /* glsl */`
${CORE_VERT}
uniform float uSize; uniform float uMinPx; uniform float uMaxPx; uniform float uGain;
varying vec3 vCol; varying float vSharp;
void main() {
  P p = particle();
  vec4 mv = modelViewMatrix * vec4(worldOf(p.q), 1.0);
  gl_Position = projectionMatrix * mv;
  float dist = max(1e-3, -mv.z);
  float sphere = 1.0 - smoothstep(uSphere - 0.1, uSphere, p.r);
  // brightness: voids fall to black, filaments carry the light, nodes are left to the glints
  float b = mix(0.05, 1.0, smoothstep(-0.8, 0.5, p.ld)) * mix(1.0, 0.55, smoothstep(1.2, 2.4, p.ld));
  b *= 0.85 + 0.3 * p.rnd;
  float shimmer = 0.88 + 0.12 * sin(uTime * (0.6 + 1.7 * p.rnd) + p.rnd * 40.0);
  vec3 col = webRamp(p.ld, p.heat);
  // dark-ages fog: nearly uniform, glassy
  col = mix(col, vec3(0.32, 0.36, 0.75) * (0.75 + 1.4 * max(p.ld, -0.5)), uEarly);
  b = mix(b, 0.55, uEarly);
  // depth cue: far particles cooler and dimmer
  float far = smoothstep(uFocusDist * 0.7, uFocusDist * 2.0, dist);
  col = mix(col, col * vec3(0.55, 0.62, 1.0), far * 0.6);
  b *= mix(1.0, 0.55, far);
  float px = uSize * (0.75 + 0.5 * p.rnd) * uPx / dist;
  float e = 1.0;
  if (px < uMinPx) { e = (px * px) / (uMinPx * uMinPx); px = uMinPx; }
  if (px > uMaxPx) { e *= uMaxPx / px; px = uMaxPx; }
  // very near particles: soft and faint (bokeh) rather than a wall of sprites
  float nearK = smoothstep(0.0, 1.6, dist);
  e *= nearK;
  vSharp = mix(1.0, 0.25, smoothstep(6.0, uMaxPx, px));
  gl_PointSize = px;
  vCol = col * b * e * shimmer * sphere * uGain * uReveal;
  if (dot(vCol, vCol) < 1e-9) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}`;

export const FIL_FRAG = /* glsl */`
varying vec3 vCol; varying float vSharp;
void main() {
  vec2 d = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(d, d);
  if (r2 > 1.0) discard;
  float core = exp(-r2 * mix(3.0, 7.0, vSharp));
  float k = core * (1.0 - r2);
  gl_FragColor = vec4(vCol * k, 1.0);
}`;

// ---------------------------------------------------------------------------------------------
// Layer: haze (random subset, large faint sprites — the dark-matter "breath")
// ---------------------------------------------------------------------------------------------
export const HAZE_VERT = /* glsl */`
${CORE_VERT}
uniform float uSize; uniform float uMaxPx; uniform float uGain;
varying vec3 vCol;
void main() {
  P p = particle();
  vec4 mv = modelViewMatrix * vec4(worldOf(p.q), 1.0);
  gl_Position = projectionMatrix * mv;
  float dist = max(1e-3, -mv.z);
  float sphere = 1.0 - smoothstep(uSphere - 0.14, uSphere, p.r);
  float px = uSize * (0.6 + 0.8 * p.rnd) * uPx / dist;
  float e = 1.0;
  if (px > uMaxPx) { e = (uMaxPx * uMaxPx) / (px * px); px = uMaxPx; }
  if (px < 2.0) { e *= px * px / 4.0; px = 2.0; }
  e *= smoothstep(0.5, 6.0, dist);
  float b = smoothstep(-0.7, 0.6, p.ld) * mix(1.0, 0.35, smoothstep(1.0, 2.2, p.ld));
  vec3 col = webRamp(p.ld - 0.25, p.heat * 0.8);
  col = mix(col, vec3(0.30, 0.32, 0.80), 0.35);
  col = mix(col, vec3(0.5, 0.45, 0.9), uEarly);
  b = mix(b, 0.6, uEarly);
  gl_PointSize = px;
  vCol = col * b * e * sphere * uGain * uReveal;
  if (dot(vCol, vCol) < 1e-10) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}`;

export const HAZE_FRAG = /* glsl */`
varying vec3 vCol;
void main() {
  vec2 d = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(d, d);
  if (r2 > 1.0) discard;
  float k = exp(-r2 * 3.2) * (1.0 - r2);
  gl_FragColor = vec4(vCol * k, 1.0);
}`;

// ---------------------------------------------------------------------------------------------
// Layer: glints (only dense particles; HDR, bloom-driving "galaxies")
// ---------------------------------------------------------------------------------------------
export const GLINT_VERT = /* glsl */`
${CORE_VERT}
uniform float uSize; uniform float uMinPx; uniform float uMaxPx; uniform float uGain; uniform float uLight;
varying vec3 vCol; varying float vSharp;
void main() {
  P p = particle();
  float dense = smoothstep(0.95, 1.9, p.ld);
  // only a fraction of particles become galaxies: brighter for denser regions
  float pick = step(p.rnd, mix(0.12, 0.9, smoothstep(1.2, 2.4, p.ld)));
  float on = dense * pick * uLight;
  if (on < 0.002) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vCol = vec3(0.0); vSharp = 0.0; return; }
  vec4 mv = modelViewMatrix * vec4(worldOf(p.q), 1.0);
  gl_Position = projectionMatrix * mv;
  float dist = max(1e-3, -mv.z);
  float sphere = 1.0 - smoothstep(uSphere - 0.1, uSphere, p.r);
  float rnd2 = hash11(p.id * 1.37 + 7.1);
  float px = uSize * (0.5 + 1.0 * rnd2 * rnd2) * uPx / dist;
  float e = 1.0;
  if (px < uMinPx) { e = (px * px) / (uMinPx * uMinPx); px = uMinPx; }
  if (px > uMaxPx) { e *= uMaxPx / px; px = uMaxPx; }
  e *= smoothstep(0.2, 2.0, dist);
  float twinkle = 0.75 + 0.25 * sin(uTime * (0.4 + 2.0 * rnd2) + rnd2 * 60.0);
  vec3 col = mix(vec3(1.0, 0.55, 0.22), vec3(1.0, 0.9, 0.78), smoothstep(1.5, 2.5, p.ld));
  col = mix(col, vec3(0.65, 0.8, 1.0), step(0.82, rnd2) * 0.7);           // a few young blue galaxies
  col = mix(col, vec3(1.0, 0.35, 0.6), smoothstep(0.45, 0.7, p.heat) * 0.35);
  vSharp = 1.0 - smoothstep(4.0, uMaxPx, px);
  gl_PointSize = px;
  vCol = col * on * e * twinkle * sphere * uGain * uReveal * (0.6 + 1.6 * smoothstep(1.6, 2.6, p.ld));
}`;

export const GLINT_FRAG = /* glsl */`
varying vec3 vCol; varying float vSharp;
void main() {
  vec2 d = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(d, d);
  if (r2 > 1.0) discard;
  float k = exp(-r2 * mix(4.0, 16.0, vSharp)) * (1.0 - r2) + 0.15 * exp(-r2 * 2.5) * (1.0 - r2);
  gl_FragColor = vec4(vCol * k, 1.0);
}`;

// ---------------------------------------------------------------------------------------------
// Early universe: the hot, almost perfectly smooth glow (CMB-like mottling), view-direction fbm
// ---------------------------------------------------------------------------------------------
export const GLOW_VERT = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 p = projectionMatrix * mat4(mat3(viewMatrix)) * vec4(position, 1.0);
  gl_Position = p.xyww;
}`;

export const GLOW_FRAG = /* glsl */`
${GLSL.common}
${GLSL.simplex3}
uniform vec3 uGlowCol; uniform float uGlow; uniform float uTime; uniform float uMottle;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  float n = 0.0, amp = 0.5, f = 2.2;
  vec3 p = d + vec3(0.0, 0.0, uTime * 0.004);
  for (int i = 0; i < 5; i++) { n += amp * snoise(p * f); f *= 2.03; amp *= 0.55; }
  float m = 1.0 + n * uMottle;
  gl_FragColor = vec4(uGlowCol * uGlow * m, 1.0);
}`;
