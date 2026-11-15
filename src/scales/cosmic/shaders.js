// GLSL for the cosmic web. Three additive point layers share ONE set of attributes (four keyframe
// slots, Catmull-Rom interpolated in the vertex shader with periodic unwrap). Every layer is drawn
// once per periodic image of the box (object.position = image offset), so the web is an endless
// tapestry; far images are thinned per vertex (random prefix of the shuffled particle order) with
// energy compensation, so the LOD is seamless. Plus the early-universe glow.
import GLSL from '../../core/glsl.js';

export const CORE_VERT = /* glsl */`
${GLSL.common}
attribute vec3 p1; attribute vec3 p2; attribute vec3 p3;          // slot 0 is 'position'
attribute float f0; attribute float f1; attribute float f2; attribute float f3; // packed 5|3 bit fields
uniform vec4 uW;      // Catmull-Rom weights per slot
uniform vec4 uDW;     // derivative weights per slot
uniform vec4 uRef;    // one-hot: slot used as the unwrap reference
uniform vec3 uC;      // focus (box fractions, unbounded) — particles are drawn at their nearest image
uniform vec3 uFocusW; // focus in world units
uniform float uBox;   // world size of the box (includes expansion scale)
uniform float uS;     // expansion scale (1 = comoving)
uniform float uTime;
uniform float uPx;    // pixels per world unit at distance 1
uniform float uReveal;
uniform float uEarly; // 1 = dark-ages fog, 0 = structure colours
uniform float uFocusDist;
uniform float uFade0, uFade1; // world-space fade radii around the focus (the visible universe)
uniform float uLdGain;  // epoch-relative contrast
uniform float uJitter;  // early-time lattice jitter (box fractions)
uniform float uN;       // particle count
uniform float uLod;     // world distance within which every particle is drawn
uniform float uLodMin;  // smallest kept fraction
uniform float uFlow;    // streaming amplitude (keyframe intervals)

vec3 unwrapTo(vec3 p, vec3 r) { vec3 d = p - r; d -= floor(d + 0.5); return r + d; }
vec2 unpackF(float v) { float b = floor(v * 255.0 + 0.5); float d = floor(b / 8.0); return vec2(d, b - d * 8.0); }

// log10 density -> designed colour ramp; heat = normalised log velocity dispersion
vec3 webRamp(float ld, float heat) {
  vec3 cVoid  = vec3(0.16, 0.05, 0.42);
  vec3 cWall  = vec3(0.20, 0.10, 0.78);
  vec3 cFil   = vec3(0.02, 0.62, 0.86);
  vec3 cFil2  = vec3(0.36, 0.92, 1.00);
  vec3 cShock = vec3(1.00, 0.20, 0.55);
  vec3 cGold  = vec3(1.00, 0.62, 0.24);
  vec3 cWhite = vec3(1.00, 0.94, 0.84);
  vec3 c = mix(cVoid, cWall, smoothstep(-0.8, -0.1, ld));
  c = mix(c, cFil, smoothstep(0.0, 0.6, ld));
  c = mix(c, cFil2, smoothstep(0.6, 1.2, ld));
  c = mix(c, cShock, smoothstep(0.5, 0.8, heat) * smoothstep(0.5, 1.1, ld) * 0.85);
  c = mix(c, cGold, smoothstep(1.4, 2.0, ld));
  c = mix(c, cWhite, smoothstep(2.0, 2.7, ld));
  return c;
}

struct P { vec3 q; vec3 vel; float ld; float heat; float id; float rnd; float r; float keep; vec3 world; };

// world position of the reference slot only (cheap) for the LOD test
float lodKeep(out float comp) {
  vec3 r = position * uRef.x + p1 * uRef.y + p2 * uRef.z + p3 * uRef.w;
  vec3 rel = fract(r - uC + 0.5) - 0.5;
  vec3 w = (modelMatrix * vec4((uC + rel - 0.5) * uBox, 1.0)).xyz;
  float d = distance(w, cameraPosition);
  float f = clamp(uLod * uLod / max(d * d, 1e-4), uLodMin, 1.0);
  comp = 1.0 / f;
  return step(float(gl_VertexID) / uN, f);
}

P particle() {
  P o;
  vec3 r = position * uRef.x + p1 * uRef.y + p2 * uRef.z + p3 * uRef.w;
  vec3 a0 = unwrapTo(position, r), a1 = unwrapTo(p1, r), a2 = unwrapTo(p2, r), a3 = unwrapTo(p3, r);
  vec3 q = a0 * uW.x + a1 * uW.y + a2 * uW.z + a3 * uW.w;
  o.vel = a0 * uDW.x + a1 * uDW.y + a2 * uDW.z + a3 * uDW.w;
  vec2 u0 = unpackF(f0), u1 = unpackF(f1), u2 = unpackF(f2), u3 = unpackF(f3);
  vec2 f = max(u0 * uW.x + u1 * uW.y + u2 * uW.z + u3 * uW.w, vec2(0.0));
  o.ld = (f.x / 31.0 * 4.5 - 1.2) * uLdGain;
  o.heat = f.y / 7.0;
  o.id = float(gl_VertexID);
  o.rnd = hash11(o.id * 0.6180339 + 0.123);
  q += (hash33(vec3(o.id * 0.013, 1.7, 3.1)) - 0.5) * uJitter;
  vec3 rel = fract(q - uC + 0.5) - 0.5;
  o.q = uC + rel;
  return o;
}
vec3 worldOf(vec3 q) { return (q - 0.5) * uBox; }
float sphereFade(vec3 local) {
  vec3 w = (modelMatrix * vec4(local, 1.0)).xyz;
  return 1.0 - smoothstep(uFade0, uFade1, distance(w, uFocusW));
}
#define CULL { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
`;

// ---------------------------------------------------------------------------------------------
// Layer: filaments (crisp points — they carry the image)
// ---------------------------------------------------------------------------------------------
export const FIL_VERT = /* glsl */`
${CORE_VERT}
uniform float uSize; uniform float uMinPx; uniform float uMaxPx; uniform float uGain;
varying vec3 vCol; varying float vSharp;
void main() {
  vCol = vec3(0.0); vSharp = 0.0;
  float comp; if (lodKeep(comp) < 0.5) CULL
  P p = particle();
  // matter streaming along filaments: a sparse subset runs ahead along its own trajectory
  float flow = step(0.86, p.rnd) * uFlow;
  float ph = fract(uTime * (0.07 + 0.05 * hash11(p.rnd * 91.0)) + p.rnd * 17.0);
  vec3 local = worldOf(p.q + p.vel * ph * flow);
  float sphere = sphereFade(local);
  if (sphere <= 0.0) CULL
  vec4 mv = modelViewMatrix * vec4(local, 1.0);
  gl_Position = projectionMatrix * mv;
  float dist = max(1e-3, -mv.z);
  // contrast: voids black, thin walls barely there, filaments bright, nodes left to the glints
  float bb = smoothstep(-0.2, 1.0, p.ld);
  float b = mix(0.004, 1.0, bb * bb * bb) * mix(1.0, 0.6, smoothstep(1.5, 2.6, p.ld));
  b *= 0.8 + 0.4 * p.rnd;
  b *= 1.0 + flow * 1.4 * sin(3.14159 * ph);
  float shimmer = 0.9 + 0.1 * sin(uTime * (0.6 + 1.7 * p.rnd) + p.rnd * 40.0);
  vec3 col = webRamp(p.ld, p.heat);
  col = mix(col, vec3(0.75, 0.95, 1.0), flow * 0.35);
  // dark ages: barely-there deep indigo fog
  col = mix(col, vec3(0.10, 0.08, 0.42) * (0.7 + 1.6 * max(p.ld, -0.4)), uEarly);
  b = mix(b, 0.12, uEarly);
  float far = smoothstep(uFocusDist * 0.8, uFocusDist * 3.0, dist);
  col = mix(col, col * vec3(0.5, 0.6, 1.0), far * 0.6);
  b *= mix(1.0, 0.6, far);
  float px = uSize * uS * (0.75 + 0.5 * p.rnd) * uPx / dist;
  float e = comp;
  if (px < uMinPx) { e *= (px * px) / (uMinPx * uMinPx); px = uMinPx; }
  if (px > uMaxPx) { e *= uMaxPx / px; px = uMaxPx; }
  e *= smoothstep(0.0, 1.4, dist);  // very near: fade (bokeh) rather than a wall of sprites
  vSharp = mix(1.0, 0.25, smoothstep(5.0, uMaxPx, px));
  gl_PointSize = px;
  vCol = col * b * e * shimmer * sphere * uGain * uReveal;
  if (dot(vCol, vCol) < 1e-10) CULL
}`;

export const FIL_FRAG = /* glsl */`
varying vec3 vCol; varying float vSharp;
void main() {
  vec2 d = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(d, d);
  if (r2 > 1.0) discard;
  float k = exp(-r2 * mix(3.0, 8.0, vSharp)) * (1.0 - r2);
  gl_FragColor = vec4(vCol * k, 1.0);
}`;

// ---------------------------------------------------------------------------------------------
// Layer: haze (random subset, large faint sprites — dark, blue, barely there)
// ---------------------------------------------------------------------------------------------
export const HAZE_VERT = /* glsl */`
${CORE_VERT}
uniform float uSize; uniform float uMaxPx; uniform float uGain;
varying vec3 vCol;
void main() {
  vCol = vec3(0.0);
  float comp; if (lodKeep(comp) < 0.5) CULL
  P p = particle();
  vec3 local = worldOf(p.q);
  float sphere = sphereFade(local);
  if (sphere <= 0.0) CULL
  vec4 mv = modelViewMatrix * vec4(local, 1.0);
  gl_Position = projectionMatrix * mv;
  float dist = max(1e-3, -mv.z);
  float px = uSize * uS * (0.6 + 0.8 * p.rnd) * uPx / dist;
  float e = comp;
  if (px > uMaxPx) { e *= (uMaxPx * uMaxPx) / (px * px); px = uMaxPx; }
  if (px < 2.0) { e *= px * px / 4.0; px = 2.0; }
  e *= smoothstep(0.5, 6.0, dist);
  float b = smoothstep(0.0, 1.0, p.ld) * mix(1.0, 0.4, smoothstep(1.3, 2.3, p.ld));
  vec3 col = mix(webRamp(p.ld - 0.3, p.heat * 0.7), vec3(0.10, 0.16, 0.62), 0.5);
  col = mix(col, vec3(0.16, 0.12, 0.5), uEarly);
  b = mix(b, 0.25, uEarly);
  gl_PointSize = px;
  vCol = col * b * e * sphere * uGain * uReveal;
  if (dot(vCol, vCol) < 1e-11) CULL
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
// Layer: glints (dense particles only; HDR white-gold with tight cores — the galaxies)
// ---------------------------------------------------------------------------------------------
export const GLINT_VERT = /* glsl */`
${CORE_VERT}
uniform float uSize; uniform float uMinPx; uniform float uMaxPx; uniform float uGain; uniform float uLight;
varying vec3 vCol; varying float vSharp;
void main() {
  vCol = vec3(0.0); vSharp = 0.0;
  float comp; if (lodKeep(comp) < 0.5) CULL
  P p = particle();
  float dense = smoothstep(1.1, 2.0, p.ld);
  float pick = step(p.rnd, mix(0.1, 0.85, smoothstep(1.4, 2.6, p.ld)));
  float on = dense * pick * uLight;
  if (on < 0.002) CULL
  vec3 local = worldOf(p.q);
  float sphere = sphereFade(local);
  if (sphere <= 0.0) CULL
  vec4 mv = modelViewMatrix * vec4(local, 1.0);
  gl_Position = projectionMatrix * mv;
  float dist = max(1e-3, -mv.z);
  float rnd2 = hash11(p.id * 1.37 + 7.1);
  float px = uSize * uS * (0.45 + 1.0 * rnd2 * rnd2) * uPx / dist;
  float e = comp;
  if (px < uMinPx) { e *= (px * px) / (uMinPx * uMinPx); px = uMinPx; }
  if (px > uMaxPx) { e *= uMaxPx / px; px = uMaxPx; }
  e *= smoothstep(0.2, 2.0, dist);
  float twinkle = 0.78 + 0.22 * sin(uTime * (0.4 + 2.0 * rnd2) + rnd2 * 60.0);
  vec3 col = mix(vec3(1.0, 0.58, 0.24), vec3(1.0, 0.92, 0.80), smoothstep(1.7, 2.6, p.ld));
  col = mix(col, vec3(0.62, 0.8, 1.0), step(0.84, rnd2) * 0.7);           // a few young blue galaxies
  col = mix(col, vec3(1.0, 0.35, 0.62), smoothstep(0.6, 0.9, p.heat) * 0.3);
  vSharp = 1.0 - smoothstep(4.0, uMaxPx, px);
  gl_PointSize = px;
  vCol = col * on * e * twinkle * sphere * uGain * uReveal * (0.5 + 2.2 * smoothstep(1.8, 2.8, p.ld));
}`;

export const GLINT_FRAG = /* glsl */`
varying vec3 vCol; varying float vSharp;
void main() {
  vec2 d = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(d, d);
  if (r2 > 1.0) discard;
  float k = exp(-r2 * mix(5.0, 22.0, vSharp)) * (1.0 - r2) + 0.08 * exp(-r2 * 2.5) * (1.0 - r2);
  gl_FragColor = vec4(vCol * k, 1.0);
}`;

// ---------------------------------------------------------------------------------------------
// Early universe: the last-scattering glow. Temperature-driven colour (white-hot → pale gold →
// ember → blood red → black), fine boiling multi-octave mottling that perturbs the local
// temperature (≈ 1 part in 10 visually), darker toward the edges of view. Never a flat fill.
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
uniform float uHeat;   // 1 = white-hot … 0 = black
uniform float uGlow;   // master
uniform float uTime;
uniform vec3 uFwd;     // camera forward (world)
varying vec3 vDir;
vec3 tempRamp(float t) {
  vec3 c = vec3(0.0);
  c = mix(c, vec3(0.30, 0.012, 0.008), smoothstep(0.0, 0.22, t));     // deep blood red
  c = mix(c, vec3(0.95, 0.26, 0.05) * 0.75, smoothstep(0.2, 0.48, t)); // ember orange
  c = mix(c, vec3(1.0, 0.74, 0.40) * 1.05, smoothstep(0.45, 0.75, t)); // pale gold
  c = mix(c, vec3(1.0, 0.95, 0.88) * 1.7, smoothstep(0.72, 1.0, t));   // white-hot
  return c;
}
void main() {
  vec3 d = normalize(vDir);
  // boiling granular field: each octave drifts on its own
  float n = 0.0, amp = 0.5, f = 3.0, norm = 0.0;
  for (int i = 0; i < 6; i++) {
    float fi = float(i);
    vec3 drift = vec3(sin(fi * 1.7), cos(fi * 2.3), sin(fi * 0.9 + 1.0)) * uTime * 0.012 * (1.0 + fi * 0.6);
    n += amp * snoise(d * f + drift + fi * 7.31);
    norm += amp; f *= 2.15; amp *= 0.62;
  }
  n /= norm;
  float grain = snoise(d * 220.0 + uTime * 0.05) * 0.5;
  float t = uHeat * (1.0 + 0.16 * n + 0.04 * grain);
  vec3 col = tempRamp(clamp(t, 0.0, 1.0));
  col *= 1.0 + 0.22 * n;
  // radial falloff: darker toward the edges of view
  float k = dot(d, normalize(uFwd));
  col *= mix(0.28, 1.0, smoothstep(0.55, 0.98, k));
  gl_FragColor = vec4(col * uGlow, 1.0);
}`;
