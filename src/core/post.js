// HDR post pipeline: scene (RGBA16F, MSAA, depth texture) -> multi-mip bloom -> final composite
// (warp/radial streaks, chromatic aberration, exposure, tone map, grade, vignette, grain, dither).
//
// Everything rendered into the scene target must be LINEAR HDR (no tone mapping, no sRGB encode).
// True black is preserved end to end: grain/dither are luminance-weighted so (0,0,0) stays (0,0,0).
import * as THREE from 'three';

const FS_GEO = new THREE.BufferGeometry();
FS_GEO.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
FS_GEO.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));

const FS_VERT = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

/** Minimal fullscreen-triangle pass. Reusable by scales for their own offscreen work. */
export class FullscreenPass {
  constructor(fragmentShader, uniforms = {}, extra = {}) {
    this.material = new THREE.ShaderMaterial({
      vertexShader: FS_VERT, fragmentShader, uniforms,
      depthTest: false, depthWrite: false, toneMapped: false, ...extra,
    });
    this.mesh = new THREE.Mesh(FS_GEO, this.material);
    this.mesh.frustumCulled = false;
    this.scene = new THREE.Scene();
    this.scene.add(this.mesh);
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }
  get uniforms() { return this.material.uniforms; }
  render(renderer, target = null) {
    renderer.setRenderTarget(target);
    renderer.render(this.scene, this.camera);
  }
  dispose() { this.material.dispose(); }
}

const DOWN_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uFirst;      // 1 on the first (prefilter) level
uniform float uThreshold;  // HDR luminance where bloom begins
uniform float uKnee;       // soft knee width
vec3 s(vec2 o) { return min(texture2D(tSrc, vUv + o * uTexel).rgb, vec3(64.0)); }
float lum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float karis(vec3 c) { return 1.0 / (1.0 + lum(c)); }
vec3 prefilter(vec3 c) {
  float br = max(c.r, max(c.g, c.b));
  float soft = clamp(br - uThreshold + uKnee, 0.0, 2.0 * uKnee);
  soft = soft * soft / (4.0 * uKnee + 1e-5);
  float contrib = max(soft, br - uThreshold) / max(br, 1e-5);
  return c * max(contrib, 0.0);
}
void main() {
  vec3 a = s(vec2(-2.0, 2.0)), b = s(vec2(0.0, 2.0)), c = s(vec2(2.0, 2.0));
  vec3 d = s(vec2(-2.0, 0.0)), e = s(vec2(0.0, 0.0)), f = s(vec2(2.0, 0.0));
  vec3 g = s(vec2(-2.0, -2.0)), h = s(vec2(0.0, -2.0)), i = s(vec2(2.0, -2.0));
  vec3 j = s(vec2(-1.0, 1.0)), k = s(vec2(1.0, 1.0)), l = s(vec2(-1.0, -1.0)), m = s(vec2(1.0, -1.0));
  vec3 col;
  if (uFirst > 0.5) {
    // Partial Karis average on the first level: tames sub-pixel fireflies without killing star glints.
    vec3 g0 = (a + b + d + e) * 0.25, g1 = (b + c + e + f) * 0.25;
    vec3 g2 = (d + e + g + h) * 0.25, g3 = (e + f + h + i) * 0.25, g4 = (j + k + l + m) * 0.25;
    float w0 = karis(g0), w1 = karis(g1), w2 = karis(g2), w3 = karis(g3), w4 = karis(g4);
    vec3 kc = (g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3) * 0.125 + g4 * w4 * 0.5;
    kc /= (w0 + w1 + w2 + w3) * 0.125 + w4 * 0.5;
    vec3 plain = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
    col = prefilter(mix(plain, kc, 0.5));
  } else {
    col = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  }
  gl_FragColor = vec4(max(col, 0.0), 1.0);
}`;

const UP_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;   // lower-res (blurrier) level
uniform sampler2D tBase;  // this level's downsample
uniform vec2 uTexel;      // texel of tSrc
uniform float uRadius;    // 0..1 blend toward the blurrier level
vec3 s(vec2 o) { return texture2D(tSrc, vUv + o * uTexel).rgb; }
void main() {
  vec3 t = s(vec2(0.0)) * 4.0;
  t += (s(vec2(-1.0, 0.0)) + s(vec2(1.0, 0.0)) + s(vec2(0.0, -1.0)) + s(vec2(0.0, 1.0))) * 2.0;
  t += s(vec2(-1.0, -1.0)) + s(vec2(1.0, -1.0)) + s(vec2(-1.0, 1.0)) + s(vec2(1.0, 1.0));
  t *= 1.0 / 16.0;
  gl_FragColor = vec4(mix(texture2D(tBase, vUv).rgb, t, uRadius), 1.0);
}`;

const FINAL_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tScene;
uniform sampler2D tBloom;
uniform vec2 uRes;
uniform float uTime;
uniform float uBloom;
uniform float uExposure;
uniform float uContrast;
uniform float uSaturation;
uniform vec3 uLift;       // added in shadows (keep tiny; 0 keeps OLED black)
uniform vec3 uGain;       // multiplies highlights / overall tint
uniform float uVignette;
uniform float uGrain;
uniform float uCA;        // chromatic aberration strength
uniform float uToneMap;   // 0 = AgX (filmic, gentle), 1 = ACES (punchy), 2 = neutral
uniform float uWarp;      // 0..1 hyperspace radial streak
uniform vec2 uWarpCenter; // uv
uniform float uFade;      // 0..1 fade to black
uniform float uFlash;     // 0..1 fade to white (added pre-tonemap)
uniform vec3 uFlashColor;
uniform float uLetterbox; // 0..1 cinematic bars (to 2.39:1)
uniform float uGamut;     // < 0: sRGB canvas. 0..1: Display-P3 canvas, 0 = colorimetric, 1 = fully vivid

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec3 RRTAndODTFit(vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}
vec3 ACESFilmic(vec3 color) {
  const mat3 ACESInputMat = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
  const mat3 ACESOutputMat = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
  color *= 1.0 / 0.6;
  color = ACESInputMat * color;
  color = RRTAndODTFit(color);
  color = ACESOutputMat * color;
  return clamp(color, 0.0, 1.0);
}
const mat3 LINEAR_REC2020_TO_LINEAR_SRGB = mat3(vec3(1.6605, -0.1246, -0.0182), vec3(-0.5876, 1.1329, -0.1006), vec3(-0.0728, -0.0083, 1.1187));
const mat3 LINEAR_SRGB_TO_LINEAR_REC2020 = mat3(vec3(0.6274, 0.0691, 0.0164), vec3(0.3293, 0.9195, 0.0880), vec3(0.0433, 0.0113, 0.8956));
vec3 agxDefaultContrastApprox(vec3 x) {
  vec3 x2 = x * x; vec3 x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}
vec3 AgX(vec3 color) {
  const mat3 AgXInsetMatrix = mat3(vec3(0.856627153315983, 0.137318972929847, 0.11189821299995), vec3(0.0951212405381588, 0.761241990602591, 0.0767994186031903), vec3(0.0482516061458583, 0.101439036467562, 0.811302368396859));
  const mat3 AgXOutsetMatrix = mat3(vec3(1.1271005818144368, -0.1413297634984383, -0.14132976349843826), vec3(-0.11060664309660323, 1.157823702216272, -0.11060664309660294), vec3(-0.016493938717834573, -0.016493938717834257, 1.2519364065950405));
  const float AgxMinEv = -12.47393; const float AgxMaxEv = 4.026069;
  color = LINEAR_SRGB_TO_LINEAR_REC2020 * color;
  color = AgXInsetMatrix * color;
  color = max(color, 1e-10); color = log2(color);
  color = (color - AgxMinEv) / (AgxMaxEv - AgxMinEv);
  color = clamp(color, 0.0, 1.0);
  color = agxDefaultContrastApprox(color);
  color = AgXOutsetMatrix * color;
  color = pow(max(vec3(0.0), color), vec3(2.2));
  color = LINEAR_REC2020_TO_LINEAR_SRGB * color;
  return clamp(color, 0.0, 1.0);
}
vec3 Neutral(vec3 color) {
  const float StartCompression = 0.8 - 0.04; const float Desaturation = 0.15;
  float x = min(color.r, min(color.g, color.b));
  float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
  color -= offset;
  float peak = max(color.r, max(color.g, color.b));
  if (peak < StartCompression) return color;
  float d = 1.0 - StartCompression;
  float newPeak = 1.0 - d * d / (peak + d - StartCompression);
  color *= newPeak / peak;
  float g = 1.0 - 1.0 / (Desaturation * (peak - newPeak) + 1.0);
  return mix(color, vec3(newPeak), g);
}
vec3 hdrAt(vec2 uv) {
  return texture2D(tScene, uv).rgb + texture2D(tBloom, uv).rgb * uBloom;
}
vec3 sampleHDR(vec2 uv) {
  vec2 c = uv - 0.5;
  float r2 = dot(c, c);
  float ca = (uCA + uWarp * 0.012) * r2;
  if (ca < 1e-5) return hdrAt(uv);
  vec3 col;
  col.r = hdrAt(uv - c * ca * 1.0).r;
  col.g = hdrAt(uv).g;
  col.b = hdrAt(uv + c * ca * 1.0).b;
  return col;
}
void main() {
  vec3 col;
  if (uWarp > 0.002) {
    // Hyperspace: radial streak toward the warp centre, energy pulled into long lines.
    vec2 dir = uWarpCenter - vUv;
    float n = hash12(gl_FragCoord.xy + fract(uTime) * 61.0);
    vec3 acc = vec3(0.0); float wsum = 0.0;
    const int TAPS = 14;
    for (int i = 0; i < TAPS; i++) {
      float t = (float(i) + n) / float(TAPS);
      float w = 1.0 - t * 0.6;
      acc += sampleHDR(vUv + dir * t * uWarp * 0.85) * w;
      wsum += w;
    }
    col = acc / wsum;
    col *= 1.0 + uWarp * uWarp * 2.5;
  } else {
    col = sampleHDR(vUv);
  }
  col = max(col, 0.0) * uExposure;
  col += uFlashColor * (uFlash * uFlash * 24.0);

  if (uToneMap < 0.5) col = AgX(col);
  else if (uToneMap < 1.5) col = ACESFilmic(col);
  else col = clamp(Neutral(col), 0.0, 1.0);

  // grade (display-linear)
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(l), col, uSaturation);
  col = col * uGain + uLift * (1.0 - col);
  col = max(col, 0.0);
  if (uGamut >= 0.0) {
    // Wide-gamut canvas (QD-OLED, recent phones/laptops): map linear sRGB into Display P3, then let
    // saturated colours stretch part of the way into the wider gamut. Neutrals are untouched.
    const mat3 SRGB_TO_P3 = mat3(vec3(0.8225, 0.0332, 0.0171), vec3(0.1774, 0.9669, 0.0724), vec3(0.0, 0.0, 0.9108));
    col = mix(SRGB_TO_P3 * col, col, uGamut);
  }
  // contrast around mid grey in a perceptual-ish domain; keeps 0 at 0
  col = pow(col, vec3(1.0 / 2.2));
  col = mix(col, col * col * (3.0 - 2.0 * col), clamp(uContrast - 1.0, -1.0, 1.0));

  // vignette
  vec2 q = vUv - 0.5;
  q.x *= mix(1.0, uRes.x / uRes.y, 0.35);
  float vig = smoothstep(0.95, 0.25, length(q));
  col *= mix(1.0, vig, uVignette);

  // film grain + dither, weighted so true black stays true black
  float lum2 = dot(col, vec3(0.299, 0.587, 0.114));
  float g1 = hash12(gl_FragCoord.xy + fract(uTime * 7.31) * 113.0) - 0.5;
  col += g1 * uGrain * sqrt(max(lum2, 0.0)) * 0.6;
  float dth = hash12(gl_FragCoord.xy * 1.7 + 17.0) - 0.5;
  col += dth * (1.0 / 255.0) * smoothstep(0.0, 0.01, lum2);

  col *= 1.0 - uFade;
  if (uLetterbox > 0.001) {
    float aspect = uRes.x / uRes.y;
    float bar = max(0.0, (1.0 - aspect / 2.39) * 0.5) * uLetterbox;
    // on narrow / portrait screens still give a slim cinematic band
    bar = max(bar, 0.045 * uLetterbox * step(aspect, 2.2));
    float edge = 1.5 / uRes.y;
    col *= smoothstep(bar - edge, bar + edge, vUv.y) * smoothstep(bar - edge, bar + edge, 1.0 - vUv.y);
  }
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

/** Default look. A scale's `grade` object overrides any subset; values are eased between scales. */
export const DEFAULT_GRADE = Object.freeze({
  exposure: 1.0,
  bloom: 0.55,          // additive bloom strength
  bloomThreshold: 0.9,  // HDR luminance where bloom starts
  bloomKnee: 0.6,
  bloomRadius: 0.72,    // 0..1 (higher = wider, softer)
  contrast: 1.08,
  saturation: 1.08,
  lift: [0, 0, 0],
  gain: [1, 1, 1],
  vignette: 0.32,
  grain: 0.035,
  ca: 0.0018,
  toneMap: 1,           // 0 AgX, 1 ACES, 2 Neutral
});

export class PostFX {
  constructor(renderer, quality) {
    this.renderer = renderer;
    this.quality = quality;
    this.width = 1; this.height = 1;
    this.levels = quality.bloomLevels ?? 6;
    this.grade = { ...DEFAULT_GRADE, lift: [...DEFAULT_GRADE.lift], gain: [...DEFAULT_GRADE.gain] };
    this._target = { ...this.grade };
    // transition controls (driven by ScaleManager / intro)
    this.warp = 0; this.fade = 0; this.flash = 0; this.letterbox = 0;
    this.warpCenter = new THREE.Vector2(0.5, 0.5);
    this.flashColor = new THREE.Color(1, 1, 1);
    /** < 0 = sRGB canvas; 0..1 = Display-P3 canvas with this much gamut expansion (set by Engine). */
    this.gamut = -1;

    this.sceneRT = null;
    this.down = []; this.up = [];
    this.downPass = new FullscreenPass(DOWN_FRAG, {
      tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uFirst: { value: 0 },
      uThreshold: { value: 1 }, uKnee: { value: 0.5 },
    });
    this.upPass = new FullscreenPass(UP_FRAG, {
      tSrc: { value: null }, tBase: { value: null }, uTexel: { value: new THREE.Vector2() }, uRadius: { value: 0.7 },
    });
    this.finalPass = new FullscreenPass(FINAL_FRAG, {
      tScene: { value: null }, tBloom: { value: null }, uRes: { value: new THREE.Vector2(1, 1) }, uTime: { value: 0 },
      uBloom: { value: 0.5 }, uExposure: { value: 1 }, uContrast: { value: 1 }, uSaturation: { value: 1 },
      uLift: { value: new THREE.Vector3() }, uGain: { value: new THREE.Vector3(1, 1, 1) },
      uVignette: { value: 0.3 }, uGrain: { value: 0.03 }, uCA: { value: 0.002 }, uToneMap: { value: 1 },
      uWarp: { value: 0 }, uWarpCenter: { value: this.warpCenter }, uFade: { value: 0 }, uFlash: { value: 0 },
      uFlashColor: { value: this.flashColor }, uLetterbox: { value: 0 }, uGamut: { value: -1 },
    });
  }

  /** Scene colour target (linear HDR). Scales with a custom render() draw into this. */
  get target() { return this.sceneRT; }
  /** Scene depth texture (logarithmic depth; see GLSL.logDepthToViewZ). */
  get depthTexture() { return this.sceneRT.depthTexture; }

  setSize(w, h) {
    w = Math.max(2, Math.floor(w)); h = Math.max(2, Math.floor(h));
    if (w === this.width && h === this.height && this.sceneRT) return;
    this.width = w; this.height = h;
    this.sceneRT?.dispose();
    for (const t of this.down) t.dispose();
    for (const t of this.up) t.dispose();
    const depthTexture = new THREE.DepthTexture(w, h);
    depthTexture.type = THREE.UnsignedIntType;
    this.sceneRT = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat, colorSpace: THREE.LinearSRGBColorSpace,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      samples: this.quality.msaa ?? 4, depthBuffer: true, stencilBuffer: false, depthTexture,
    });
    this.down = []; this.up = [];
    let bw = w, bh = h;
    for (let i = 0; i < this.levels; i++) {
      bw = Math.max(2, Math.floor(bw / 2)); bh = Math.max(2, Math.floor(bh / 2));
      const opts = { type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, colorSpace: THREE.LinearSRGBColorSpace };
      this.down.push(new THREE.WebGLRenderTarget(bw, bh, opts));
      if (i < this.levels - 1) this.up.push(new THREE.WebGLRenderTarget(bw, bh, opts));
    }
    this.finalPass.uniforms.uRes.value.set(w, h);
  }

  /** Set the look the pipeline eases toward (scale grade). Unspecified keys fall back to defaults. */
  setGrade(grade = {}, immediate = false) {
    this._target = { ...DEFAULT_GRADE, ...grade };
    if (immediate) {
      for (const k of Object.keys(DEFAULT_GRADE)) {
        const v = this._target[k];
        this.grade[k] = Array.isArray(v) ? [...v] : v;
      }
    }
  }

  _ease(dt) {
    const k = 1 - Math.exp(-dt * 2.2);
    for (const key of Object.keys(DEFAULT_GRADE)) {
      const tv = this._target[key];
      if (key === 'toneMap') { this.grade.toneMap = tv; continue; }
      if (Array.isArray(tv)) {
        for (let i = 0; i < 3; i++) this.grade[key][i] += (tv[i] - this.grade[key][i]) * k;
      } else {
        this.grade[key] += (tv - this.grade[key]) * k;
      }
    }
  }

  /** Run bloom + final composite from the scene target to the canvas. */
  render(dt, time) {
    const r = this.renderer;
    this._ease(dt);
    const g = this.grade;
    // bloom downsample chain
    const d = this.downPass.uniforms;
    d.uThreshold.value = g.bloomThreshold; d.uKnee.value = Math.max(1e-3, g.bloomKnee);
    let src = this.sceneRT.texture, sw = this.width, sh = this.height;
    for (let i = 0; i < this.levels; i++) {
      d.tSrc.value = src; d.uTexel.value.set(1 / sw, 1 / sh); d.uFirst.value = i === 0 ? 1 : 0;
      this.downPass.render(r, this.down[i]);
      src = this.down[i].texture; sw = this.down[i].width; sh = this.down[i].height;
    }
    // upsample chain
    const u = this.upPass.uniforms;
    u.uRadius.value = g.bloomRadius;
    let low = this.down[this.levels - 1];
    for (let i = this.levels - 2; i >= 0; i--) {
      u.tSrc.value = low.texture; u.tBase.value = this.down[i].texture; u.uTexel.value.set(1 / low.width, 1 / low.height);
      this.upPass.render(r, this.up[i]);
      low = this.up[i];
    }
    const f = this.finalPass.uniforms;
    f.tScene.value = this.sceneRT.texture; f.tBloom.value = low.texture;
    f.uTime.value = time % 1000;
    f.uBloom.value = g.bloom; f.uExposure.value = g.exposure; f.uContrast.value = g.contrast; f.uSaturation.value = g.saturation;
    f.uLift.value.fromArray(g.lift); f.uGain.value.fromArray(g.gain);
    f.uVignette.value = g.vignette; f.uGrain.value = g.grain; f.uCA.value = g.ca; f.uToneMap.value = g.toneMap;
    f.uWarp.value = this.warp; f.uFade.value = this.fade; f.uFlash.value = this.flash; f.uLetterbox.value = this.letterbox;
    f.uGamut.value = this.gamut;
    this.finalPass.render(r, null);
  }
}
