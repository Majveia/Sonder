// Shared GLSL chunks. Concatenate the strings you need into your ShaderMaterial sources:
//   fragmentShader: `${GLSL.common}${GLSL.simplex3}${GLSL.fbm} void main(){...}`
// All chunks are prefix-free of #version and work in WebGL2 through three's ShaderMaterial.

const common = /* glsl */`
#ifndef SONDER_COMMON
#define SONDER_COMMON
#define PI 3.141592653589793
#define TAU 6.283185307179586
#define sat(x) clamp(x, 0.0, 1.0)
float remap(float x, float a, float b, float c, float d) { return c + (d - c) * clamp((x - a) / (b - a), 0.0, 1.0); }
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float hash13(vec3 p3) { p3 = fract(p3 * 0.1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
vec3 hash33(vec3 p3) { p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yxz + 33.33); return fract((p3.xxy + p3.yxx) * p3.zyx); }
mat2 rot2(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }
#endif
`;

// Ashima / Ian McEwan 3D simplex noise, returns ~[-1,1].
const simplex3 = /* glsl */`
#ifndef SONDER_SIMPLEX3
#define SONDER_SIMPLEX3
vec3 _mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 _mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 _permute(vec4 x) { return _mod289(((x * 34.0) + 10.0) * x); }
vec4 _taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = _mod289(i);
  vec4 p = _permute(_permute(_permute(i.z + vec4(0.0, i1.z, i2.z, 1.0)) + i.y + vec4(0.0, i1.y, i2.y, 1.0)) + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = _taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.5 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 105.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}
#endif
`;

// Requires simplex3. fbm ~[-1,1]; ridged [0,1]; warped fbm for gas / nebula structure.
const fbm = /* glsl */`
#ifndef SONDER_FBM
#define SONDER_FBM
float fbm(vec3 p, int octaves) {
  float a = 0.5, s = 0.0, n = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= octaves) break;
    s += a * snoise(p); n += a; a *= 0.5; p = p * 2.02 + vec3(13.1, 7.7, 3.3);
  }
  return s / n;
}
float ridgedFbm(vec3 p, int octaves) {
  float a = 0.5, s = 0.0, n = 0.0, prev = 1.0;
  for (int i = 0; i < 8; i++) {
    if (i >= octaves) break;
    float r = 1.0 - abs(snoise(p)); r *= r;
    s += a * r * prev; n += a; prev = r; a *= 0.5; p = p * 2.07 + vec3(5.2, 1.3, 9.1);
  }
  return s / n;
}
float warpedFbm(vec3 p, int octaves, float strength) {
  vec3 q = vec3(fbm(p + vec3(0.0, 1.7, 9.2), 3), fbm(p + vec3(5.2, 1.3, 2.8), 3), fbm(p + vec3(8.3, 2.8, 4.1), 3));
  return fbm(p + strength * q, octaves);
}
#endif
`;

// Cheap value noise (hash based) for places where simplex is too heavy. Requires common.
const vnoise = /* glsl */`
#ifndef SONDER_VNOISE
#define SONDER_VNOISE
float vnoise(vec3 x) {
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash13(i), hash13(i + vec3(1, 0, 0)), f.x), mix(hash13(i + vec3(0, 1, 0)), hash13(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(hash13(i + vec3(0, 0, 1)), hash13(i + vec3(1, 0, 1)), f.x), mix(hash13(i + vec3(0, 1, 1)), hash13(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
float vfbm(vec3 p, int octaves) {
  float a = 0.5, s = 0.0, n = 0.0;
  for (int i = 0; i < 8; i++) { if (i >= octaves) break; s += a * vnoise(p); n += a; a *= 0.5; p = p * 2.03 + 17.0; }
  return s / n;
}
#endif
`;

// Blackbody colour (Kelvin -> linear RGB, normalised to max channel 1). Good for stars / accretion disks.
const blackbody = /* glsl */`
#ifndef SONDER_BLACKBODY
#define SONDER_BLACKBODY
vec3 blackbody(float T) {
  T = clamp(T, 1000.0, 40000.0) / 100.0;
  float r = T <= 66.0 ? 1.0 : clamp(1.292936186 * pow(T - 60.0, -0.1332047592), 0.0, 1.0);
  float g = T <= 66.0 ? clamp(0.390081579 * log(T) - 0.631841444, 0.0, 1.0) : clamp(1.129890861 * pow(T - 60.0, -0.0755148492), 0.0, 1.0);
  float b = T >= 66.0 ? 1.0 : (T <= 19.0 ? 0.0 : clamp(0.543206789 * log(T - 10.0) - 1.196254089, 0.0, 1.0));
  vec3 c = vec3(r, g, b);
  return c * c; // approx sRGB -> linear
}
#endif
`;

// Logarithmic depth support for custom ShaderMaterials (the renderer uses logarithmicDepthBuffer).
// Any ShaderMaterial that depth-tests against or writes scene depth MUST include these:
//   vertex:   #include <common>  +  logDepthParsVert at top,  logDepthVert right after gl_Position is set
//   fragment: logDepthParsFrag at top,  logDepthFrag as the first statement of main()
const logDepthParsVert = `\n#include <logdepthbuf_pars_vertex>\n`;
const logDepthVert = `\n#include <logdepthbuf_vertex>\n`;
const logDepthParsFrag = `\n#include <logdepthbuf_pars_fragment>\n`;
const logDepthFrag = `\n#include <logdepthbuf_fragment>\n`;

// Decode the scene depth texture (log depth) to a positive view-space distance along -Z.
// `logDepthBufFC` = 2.0 / log2(camera.far + 1.0) — pass as a uniform (uLogDepthFC).
const logDepthDecode = /* glsl */`
#ifndef SONDER_LOGDEPTH_DECODE
#define SONDER_LOGDEPTH_DECODE
float logDepthToViewZ(float depthSample, float logDepthFC) {
  return exp2(depthSample / (logDepthFC * 0.5)) - 1.0;
}
#endif
`;

export const GLSL = {
  common, simplex3, fbm, vnoise, blackbody,
  logDepthParsVert, logDepthVert, logDepthParsFrag, logDepthFrag, logDepthDecode,
};
export default GLSL;
