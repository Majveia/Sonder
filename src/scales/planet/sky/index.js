// PLANET SKY — atmosphere, sun, night sky and the lighting environment of a world.
//
// Pass order (all inside the normal planet render; no customRender needed):
//   once at init   transmittance LUT (256x64 RGBA16F, (r, mu) Bruneton mapping) — GPU, + a JS copy for env
//   every update   sky-view LUT (lat-long around the camera, sun azimuth at u = 0.5, horizon at v = 0.5,
//                  sqrt-concentrated around the horizon; single + approx. multiple scattering + night glow).
//                  Rendered from update() because the camera has already moved (player runs first).
//   scene render   renderOrder -1001  star field (fallback points / guarded deep-space skybox), additive
//                  renderOrder -1000  sky dome: LUT radiance + sun disc + galactic band, blended
//                                     ONE, ONE_MINUS_SRC_ALPHA so the stars behind are attenuated by the
//                                     atmosphere's transmittance and drowned by its brightness
//                  everything else    terrain / water / life call sonderAtmosphere() = same LUT
//
// planet.systems.sky helpers:
//   sunElevation()              sine of the sun's elevation at the player (-1..1)
//   skyColorAt(dir, outColor)   approximate sky radiance (scene units) in a world direction from the player
//   model                       AtmosphereModel (JS twin of the shaders), params in model.p
//   sunE                        THREE.Color: sun irradiance above the atmosphere (scene units)
import * as THREE from 'three';
import { FullscreenPass } from '../../../core/post.js';
import { GLSL } from '../../../core/glsl.js';
import { RNG, smoothstep, clamp } from '../../../core/rng.js';
import { AtmosphereModel, atmosphereParams, TRANS_W, TRANS_H, LUMA } from './atmosphere.js';

const TRANS_FRAG = /* glsl */`
precision highp float;
uniform vec4 uSunsetTint;
void main() {
  vec2 x = (gl_FragCoord.xy - 0.5) / vec2(${TRANS_W - 1}.0, ${TRANS_H - 1}.0);
  float R = uAtmoR, top = uAtmoTop, H = sqrt(top * top - R * R);
  float rho = H * x.y, r = sqrt(rho * rho + R * R);
  float dmin = top - r, dmax = rho + H, d = dmin + x.x * (dmax - dmin);
  float mu = d <= 0.0 ? 1.0 : clamp((H * H - rho * rho - d * d) / (2.0 * r * d), -1.0, 1.0);
  float b = r * mu, c = r * r - top * top;
  float t1 = -b + sqrt(max(0.0, b * b - c));
  float ds = t1 / 40.0;
  vec3 tau = vec3(0.0);
  for (int i = 0; i < 40; i++) {
    float s = (float(i) + 0.5) * ds;
    float h = sqrt(r * r + s * s + 2.0 * r * mu * s) - R;
    tau += atmoExtinction(atmoDensity(h)) * ds;
  }
  vec3 T = exp(-tau);
  float l = dot(T, ATMO_LUMA);
  float w = uSunsetTint.a * smoothstep(0.6, 0.12, l);
  T = min(vec3(1.0), T + (uSunsetTint.rgb * l - T) * w);
  gl_FragColor = vec4(T, 1.0);
}`;

const SKY_FRAG = (steps) => /* glsl */`
precision highp float;
uniform vec3 uSunE;      // sun irradiance above the atmosphere (scene units, incl. sky gain)
uniform vec3 uNightE;    // isotropic night illumination of the air (stars, moons, giant-shine)
uniform float uMSK;
uniform vec2 uLutSize;
void main() {
  vec2 uv = gl_FragCoord.xy / uLutSize;
  float az = (uv.x - 0.5) * 6.2831853;
  float h = uSkyHorizon, el;
  if (uv.y >= 0.5) { float x = (uv.y - 0.5) * 2.0; el = h + x * x * (1.5707963 - h); }
  else { float x = (0.5 - uv.y) * 2.0; el = h - x * x * (h + 1.5707963); }
  vec3 rd = uSkyFrame * vec3(cos(el) * cos(az), cos(el) * sin(az), sin(el));
  vec3 ro = uCamPos; float r0 = length(ro);
  if (r0 < uAtmoR + 1.0) ro *= (uAtmoR + 1.0) / r0;
  vec2 ts = atmoRaySphere(ro, rd, uAtmoTop);
  if (ts.x > ts.y || ts.y < 0.0) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  float tS = max(ts.x, 0.0), tE = ts.y;
  vec2 g = atmoRaySphere(ro, rd, uAtmoR);
  if (g.x <= g.y && g.x > 0.0) tE = min(tE, g.x);
  float cosT = dot(rd, uSunDir);
  float phR = atmoPhaseR(cosT), phM = atmoPhaseM(cosT);
  vec3 L = vec3(0.0), Tv = vec3(1.0);
  const int N = ${steps};
  for (int i = 0; i < N; i++) {
    float a = float(i) / float(N), b = float(i + 1) / float(N);
    float s0 = tS + (tE - tS) * a * a, s1 = tS + (tE - tS) * b * b;
    float ds = s1 - s0, t = 0.5 * (s0 + s1);
    vec3 p = ro + rd * t; float pr = length(p);
    vec3 dn = atmoDensity(pr - uAtmoR);
    float muS = dot(p / pr, uSunDir);
    vec3 Ts = atmoTransmittanceRaw(pr, muS);
    float vis = atmoShadow(pr, muS, 0.0), visMs = atmoShadow(pr, muS, 0.09);
    vec3 sR = uBetaR * dn.x, sM = uBetaMs * dn.y;
    vec3 S = uSunE * Ts * (vis * (sR * phR + sM * phM) + visMs * (sR + sM) * uMSK * 0.0795775)
           + (sR + sM) * uNightE * 0.0795775;
    vec3 e = atmoExtinction(dn);
    vec3 Tst = exp(-e * ds);
    L += Tv * (S - S * Tst) / max(e, vec3(1e-12));
    Tv *= Tst;
  }
  gl_FragColor = vec4(L, dot(Tv, ATMO_LUMA));
}`;

const DOME_VERT = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 c = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
  c.z = c.w * 0.99999;
  gl_Position = c;
}`;

const DOME_FRAG = /* glsl */`
precision highp float;
uniform vec3 uSunRad;       // sun disc radiance above the atmosphere
uniform float uSunAng;      // apparent angular radius (rad)
uniform mat3 uStarRot;      // world -> star frame
uniform float uBand;        // galactic band radiance
uniform float uStarFade;    // sky luminance at which stars vanish
varying vec3 vDir;
void main() {
  vec3 dir = normalize(vDir);
  vec4 s = sonderSkyLUT(dir);
  vec3 col = s.rgb;
  float rC = length(uCamPos); vec3 up = uCamPos / rC;
  vec2 g = atmoRaySphere(uCamPos, dir, uAtmoR);
  float ground = (g.x <= g.y && g.x > 0.0) ? 1.0 : 0.0;
  // sun disc with limb darkening, coloured by the actual path through the air
  float ang = atan(length(cross(dir, uSunDir)), dot(dir, uSunDir));
  float x = ang / uSunAng;
  if (x < 1.0 && ground < 0.5) {
    float mu = sqrt(max(0.0, 1.0 - x * x));
    float limb = 0.35 + 0.65 * pow(mu, 0.55);
    vec3 T = atmoTransmittanceRaw(rC, dot(up, dir));
    col += uSunRad * T * limb * (1.0 - smoothstep(0.82, 1.0, x));
  }
  // what the stars behind can still show: transmittance x darkness
  float skyL = dot(s.rgb, ATMO_LUMA);
  float vis = s.a * (1.0 - smoothstep(uStarFade * 0.05, uStarFade, skyL)) * (1.0 - ground);
  // faint galactic band (fallback; the deep-space skybox brings its own)
  vec3 sd = uStarRot * dir;
  float bd = sd.y + 0.08 * sin(atan(sd.z, sd.x) * 2.0);
  float band = exp(-bd * bd / 0.018) * (0.35 + 0.9 * vfbm(sd * 6.0, 4)) + 0.4 * exp(-bd * bd / 0.002) * vfbm(sd * 22.0 + 3.0, 3);
  float dust = smoothstep(0.55, 0.75, vfbm(sd * 14.0 + 7.0, 3)) * exp(-bd * bd / 0.004);
  col += vis * uBand * band * (1.0 - 0.8 * dust) * vec3(0.85, 0.82, 1.0);
  gl_FragColor = vec4(col, 1.0 - vis);
}`;

const STAR_VERT = /* glsl */`
attribute vec3 color;
attribute float size;
uniform float uDpr;
uniform float uTime;
varying vec3 vCol;
void main() {
  vec3 wd = mat3(modelMatrix) * position;
  vec4 c = projectionMatrix * vec4(mat3(viewMatrix) * wd, 1.0);
  c.z = c.w * 0.99999;
  gl_Position = c;
  float tw = 1.0 + 0.25 * sin(uTime * (6.0 + 9.0 * fract(position.x * 91.7)) + position.y * 400.0);
  vCol = color * tw;
  gl_PointSize = size * uDpr;
}`;
const STAR_FRAG = /* glsl */`
precision highp float;
varying vec3 vCol;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float a = exp(-d * d * 4.0) * (1.0 - smoothstep(0.8, 1.0, d));
  gl_FragColor = vec4(vCol * a, 1.0);
}`;

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _c = new THREE.Color();

export default class Sky {
  constructor(planet) { this.planet = planet; }

  async init() {
    const p = this.planet, ctx = p.ctx, q = ctx.quality, u = p.shared.uniforms;
    const star = p.sysDesc.star;
    this.params = atmosphereParams(p.desc, star, p.R);
    this.model = new AtmosphereModel(this.params);
    this.model.fit();
    const ap = this.params;

    // ---- star light ------------------------------------------------------------------------------
    const sc = star.color && star.kind !== 'blackhole' ? star.color : [1, 1, 1];
    const l = sc[0] * LUMA[0] + sc[1] * LUMA[1] + sc[2] * LUMA[2] || 1;
    const host = p.desc.parent != null ? p.sysDesc.planets[p.desc.parent] : p.desc;
    const aAU = host?.orbit?.a || 1;
    const flux = Math.max(star.lumSun || 1, 1e-3) / (aAU * aAU);
    this.Ebase = 4.2 * clamp(Math.pow(flux, 0.18), 0.45, 1.8);
    this.sunE = new THREE.Color(sc[0] / l, sc[1] / l, sc[2] / l).multiplyScalar(this.Ebase);
    this.skyGain = 1.6;
    // apparent sun size: physical, enlarged 2.5x for presence (min 0.3 deg)
    const physAng = (star.radiusSun || 1) * 0.00465 / aAU;
    this.sunAng = clamp(physAng * 2.5, 0.0052, 0.06);

    // ---- uniforms --------------------------------------------------------------------------------
    u.uAtmoR.value = ap.R; u.uAtmoTop.value = ap.top;
    u.uAtmoShape.value.set(ap.Hr, ap.Hm, ap.ozoneC, ap.ozoneW);
    u.uBetaR.value.fromArray(ap.betaR); u.uBetaMs.value.fromArray(ap.betaMs);
    u.uBetaMe.value.fromArray(ap.betaMe); u.uBetaO.value.fromArray(ap.betaO);
    u.uMieG.value = ap.mieG; u.uShadowDip.value = ap.shadowDip;

    // ---- transmittance LUT (once) -------------------------------------------------------------------
    const rtOpts = { type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, stencilBuffer: false, colorSpace: THREE.LinearSRGBColorSpace };
    this.transRT = new THREE.WebGLRenderTarget(TRANS_W, TRANS_H, rtOpts);
    const pars = p.shared.glsl.pars;
    const tp = new FullscreenPass(pars + TRANS_FRAG, p.shared.attach({ uniforms: { uSunsetTint: { value: new THREE.Vector4(...ap.sunsetTint, ap.sunsetAmt) } } }).uniforms);
    const renderer = ctx.renderer, prevRT = renderer.getRenderTarget();
    tp.render(renderer, this.transRT);
    renderer.setRenderTarget(prevRT);
    tp.dispose();
    u.uTransLUT.value = this.transRT.texture;

    // ---- sky-view LUT (per frame) -------------------------------------------------------------------
    const tier = q.tier || 'high';
    const size = { low: [128, 72], medium: [160, 90], high: [192, 108], ultra: [256, 144] }[tier] || [192, 108];
    const steps = Math.round(clamp(30 * (q.raymarch ?? 1), 16, 40));
    this.skyRT = new THREE.WebGLRenderTarget(size[0], size[1], { ...rtOpts, wrapS: THREE.RepeatWrapping });
    this.skyRT.texture.wrapS = THREE.RepeatWrapping;
    this.skyPass = new FullscreenPass(pars + SKY_FRAG(steps), p.shared.attach({ uniforms: {
      uSunE: { value: new THREE.Vector3() }, uNightE: { value: new THREE.Vector3() },
      uMSK: { value: ap.msK }, uLutSize: { value: new THREE.Vector2(size[0], size[1]) },
    } }).uniforms);
    u.uSkyLUT.value = this.skyRT.texture;

    // ---- dome -----------------------------------------------------------------------------------------
    this.domeMat = new THREE.ShaderMaterial({
      vertexShader: DOME_VERT,
      fragmentShader: GLSL.common + GLSL.vnoise + pars + DOME_FRAG,
      uniforms: p.shared.attach({ uniforms: {
        uSunRad: { value: new THREE.Vector3() }, uSunAng: { value: this.sunAng },
        uStarRot: { value: new THREE.Matrix3() }, uBand: { value: 0.006 }, uStarFade: { value: 0.06 },
      } }).uniforms,
      side: THREE.BackSide, depthTest: false, depthWrite: false, toneMapped: false,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 48), this.domeMat);
    this.dome.frustumCulled = false; this.dome.renderOrder = -1000;
    p.scene.add(this.dome);
    p.scene.background = null;

    // ---- stars: fallback points (always built; the deep-space skybox, if present, is added too) ------
    this.starGroup = new THREE.Group();
    this.starGroup.renderOrder = -1001;
    p.scene.add(this.starGroup);
    this._buildStars();
    this._tryDeepSky();

    // ---- night lights: moons / parent giant ---------------------------------------------------------
    const rng = new RNG(p.desc.seed ?? 1, 'sky');
    this.moons = (p.desc.moons || []).map((m) => ({ m, phase0: rng.next(), period: (m.periodDays || 20) * p.dayLength }));
    this.parentDir = p.desc.parent != null ? new THREE.Vector3(0.62, 0.35, -0.7).normalize() : null;
    this.nightFloor = 0.0016 * this.Ebase; // starlight irradiance — blue night, never pitch black
    this.nightE = new THREE.Vector3();

    // ---- shadows ------------------------------------------------------------------------------------
    this._setupShadows();

    // ---- JS env scratch ----------------------------------------------------------------------------
    this._out = { L: [0, 0, 0], T: 1 };
    this._ro = [0, 0, 0]; this._rd = [0, 0, 0]; this._sd = [0, 0, 0]; this._T = [0, 0, 0];
    this._frame = 0;
    this._skyIrr = new THREE.Color(); this._fog = new THREE.Color(); this._fogSun = new THREE.Color();
    this._gradeT = 0; this._exposure = 1;
    const pal = p.desc.palette || {};
    const gc = new THREE.Color(pal.grass || pal.sand || '#777777').lerp(new THREE.Color(pal.rock || '#777777'), 0.4);
    this.groundAlbedo = gc.multiplyScalar(0.9);
    this._updateFrame();
    this.update(0, 0);
  }

  _buildStars() {
    const p = this.planet, q = p.ctx.quality;
    const n = Math.round(6500 * clamp(q.particles ?? 1, 0.4, 1.6));
    const rng = new RNG(p.sysDesc.seed ?? 7, 'planet-stars');
    const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), size = new Float32Array(n);
    const bandN = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i < n; i++) {
      let d = rng.dir();
      // concentrate ~40% of stars toward the galactic plane (star frame y = 0)
      if (rng.chance(0.4)) { d = [d[0], d[1] * 0.18, d[2]]; const L = Math.hypot(...d); d = d.map((v) => v / L); }
      pos.set(d, i * 3);
      const u = rng.next();
      const bright = Math.pow(u, 14) * 6 + Math.pow(u, 3) * 0.12 + 0.012;
      const T = 2800 + Math.pow(rng.next(), 1.6) * 11000;
      _c.setRGB(...blackbody(T));
      col[i * 3] = _c.r * bright; col[i * 3 + 1] = _c.g * bright; col[i * 3 + 2] = _c.b * bright;
      size[i] = 1.3 + Math.min(2.2, Math.pow(u, 10) * 3.2);
    }
    void bandN;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('size', new THREE.BufferAttribute(size, 1));
    this.starMat = new THREE.ShaderMaterial({
      vertexShader: STAR_VERT, fragmentShader: STAR_FRAG,
      uniforms: { uDpr: { value: p.ctx.renderer.getPixelRatio() }, uTime: { value: 0 } },
      depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
    });
    this.stars = new THREE.Points(g, this.starMat);
    this.stars.frustumCulled = false; this.stars.renderOrder = -1001;
    this.starGroup.add(this.stars);
  }

  async _tryDeepSky() {
    // The system scale's deep-space skybox, when it exists. Guarded: the fallback points stay if not.
    try {
      const mod = await import('../../system/phenomena/skybox.js');
      if (!mod.createSkybox || this._disposed) return;
      const p = this.planet;
      const sb = mod.createSkybox(p.ctx, { galaxy: p.ctx.universe.galaxy(p.sysDesc.galaxy ?? 0), system: p.sysDesc });
      if (!sb?.object3D) return;
      sb.object3D.traverse((o) => { o.renderOrder = -1001; o.frustumCulled = false; });
      this.deepSky = sb;
      this.starGroup.add(sb.object3D);
      this.stars.visible = false;
      this.domeMat.uniforms.uBand.value = 0;
    } catch (e) { /* no skybox module yet — fallback stars */ }
  }

  _setupShadows() {
    const p = this.planet, q = p.ctx.quality, light = p.sunLight;
    this.shadowSize = q.shadows || 0;
    if (!this.shadowSize) { light.castShadow = false; return; }
    light.castShadow = true;
    const sh = light.shadow;
    sh.mapSize.set(this.shadowSize, this.shadowSize);
    const ext = 110;
    Object.assign(sh.camera, { left: -ext, right: ext, top: ext, bottom: -ext, near: 1, far: 1500 });
    sh.camera.updateProjectionMatrix();
    sh.bias = -0.0004; sh.normalBias = 0.06; sh.radius = 2.5;
    // texel snapping in light space so the shadow does not shimmer as the player moves
    const texel = (2 * ext) / this.shadowSize;
    const orig = sh.updateMatrices.bind(sh);
    const z = new THREE.Vector3(), x = new THREE.Vector3(), y = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), d = new THREE.Vector3();
    sh.updateMatrices = (lt) => {
      const t = lt.target.position;
      z.subVectors(lt.position, t).normalize();
      x.crossVectors(up, z); if (x.lengthSq() < 1e-8) x.set(1, 0, 0); x.normalize();
      y.crossVectors(z, x);
      const ox = t.dot(x), oy = t.dot(y);
      d.copy(x).multiplyScalar(Math.round(ox / texel) * texel - ox).addScaledVector(y, Math.round(oy / texel) * texel - oy);
      t.add(d); lt.position.add(d);
      lt.target.updateMatrixWorld(); lt.updateMatrixWorld();
      orig(lt);
    };
  }

  enter() {
    const r = this.planet.ctx.renderer;
    this._prevShadow = { enabled: r.shadowMap.enabled, type: r.shadowMap.type };
    if (this.shadowSize) { r.shadowMap.enabled = true; r.shadowMap.type = THREE.PCFShadowMap; }
  }
  exit() {
    const r = this.planet.ctx.renderer;
    if (this._prevShadow) { r.shadowMap.enabled = this._prevShadow.enabled; r.shadowMap.type = this._prevShadow.type; }
  }

  /** sky-view LUT frame: sun-ward horizontal axis, side axis, up — at the camera */
  _updateFrame() {
    const p = this.planet, u = p.shared.uniforms, cam = p.camera;
    const up = _v.copy(cam.position).normalize();
    const sx = _v2.copy(p.sunDir).addScaledVector(up, -p.sunDir.dot(up));
    if (sx.lengthSq() < 1e-8) { sx.set(1, 0, 0).addScaledVector(up, -up.x); }
    sx.normalize();
    const sy = new THREE.Vector3().crossVectors(up, sx);
    u.uSkyFrame.value.set(sx.x, sy.x, up.x, sx.y, sy.y, up.y, sx.z, sy.z, up.z);
    const r = Math.max(cam.position.length(), this.params.R + 1);
    u.uSkyHorizon.value = -Math.acos(Math.min(1, this.params.R / r));
    u.uCamPos.value.copy(cam.position);
  }

  sunElevation() { return this.planet.sunDir.dot(this.planet.player.up); }

  /** approximate sky radiance (scene units) in world direction `dir` as seen from the player */
  skyColorAt(dir, out = new THREE.Color()) {
    const p = this.planet, o = this._out;
    p.player.position.toArray(this._ro); dir.toArray(this._rd); p.sunDir.toArray(this._sd);
    this.model.sky(this._ro, this._rd, this._sd, o, 14, this._sunSky, this._nightArr);
    return out.setRGB(o.L[0], o.L[1], o.L[2]);
  }

  update(dt, time) {
    const p = this.planet, e = p.env, u = p.shared.uniforms, m = this.model, ap = this.params;
    const pl = p.player, pos = pl.position;
    const r = Math.max(pos.length(), ap.R + 1), up = _v.copy(pos).normalize();
    const muS = p.sunDir.dot(up);

    // ---- night lights ---------------------------------------------------------------------------
    let moonIrr = 0;
    for (const mo of this.moons) {
      const ph = ((time || 0) / mo.period + mo.phase0) % 1;          // 0 new .. 0.5 full
      const elong = ph * Math.PI * 2;
      const illum = 0.5 - 0.5 * Math.cos(elong);
      // moon direction: sun direction rotated by the elongation about the spin axis
      const a = Math.atan2(p.sunDir.z, p.sunDir.x) + elong;
      const md = _v2.set(Math.cos(a) * 0.98, p.sunDir.y * 0.6 + 0.08, Math.sin(a) * 0.98).normalize();
      const alt = md.dot(up);
      moonIrr += illum * smoothstep(-0.05, 0.25, alt) * 0.035 * this.Ebase * Math.min(1, (mo.m.radiusKm || 1000) / 1500);
    }
    if (this.parentDir) moonIrr += 0.06 * this.Ebase * smoothstep(-0.1, 0.3, this.parentDir.dot(up)) * (0.5 + 0.5 * Math.max(0, -muS));
    const nf = this.nightFloor + moonIrr;
    // moonlight reads blue (Purkinje): tint the night illumination
    this.nightE.set(nf * 0.62, nf * 0.8, nf * 1.25);
    this._nightArr = [this.nightE.x, this.nightE.y, this.nightE.z];
    const sg = this.skyGain;
    this._sunSky = [this.sunE.r * sg, this.sunE.g * sg, this.sunE.b * sg];

    // ---- sky-view LUT ---------------------------------------------------------------------------
    this._updateFrame();
    const su = this.skyPass.uniforms;
    su.uSunE.value.set(this._sunSky[0], this._sunSky[1], this._sunSky[2]);
    su.uNightE.value.copy(this.nightE);
    u.uSunDir.value.copy(p.sunDir);
    const renderer = p.ctx.renderer, prevRT = renderer.getRenderTarget();
    this.skyPass.render(renderer, this.skyRT);
    renderer.setRenderTarget(prevRT);

    // ---- dome / stars ---------------------------------------------------------------------------
    const du = this.domeMat.uniforms;
    const discScale = 1 / (Math.PI * this.sunAng * this.sunAng);
    const lum = this.sunE.r * LUMA[0] + this.sunE.g * LUMA[1] + this.sunE.b * LUMA[2];
    const k = Math.min(discScale, 60 / Math.max(lum, 1e-6));
    du.uSunRad.value.set(this.sunE.r * k, this.sunE.g * k, this.sunE.b * k);
    const spin = -Math.atan2(p.sunDir.z, p.sunDir.x);
    this.starGroup.position.set(0, 0, 0);
    this.starGroup.rotation.set(0.35, spin, 0, 'YXZ');
    this.starGroup.updateMatrixWorld();
    du.uStarRot.value.setFromMatrix4(this.starGroup.matrixWorld).transpose();
    this.starMat.uniforms.uTime.value = time || 0;
    if (this.deepSky) { try { this.deepSky.update(dt, p.camera); } catch (err) { /* foreign module */ } }

    // ---- lighting environment (JS twin of the shaders) ------------------------------------------
    const T = m.sunTransmittance(r, muS, this._T);
    const sr = this.sunE.r * T[0], sgc = this.sunE.g * T[1], sb = this.sunE.b * T[2];
    const smax = Math.max(sr, sgc, sb, 1e-6);
    e.sunIntensity = smax > 1e-5 ? smax : 0;
    e.sunColor.setRGB(sr / smax, sgc / smax, sb / smax);

    if ((this._frame++ & 1) === 0 || dt === 0) this._ambient(pos, up);
    const sky = this._skyIrr;
    // ambient: sky irradiance + night floor + moon (as soft fill)
    const amb = _c.copy(sky);
    const kmax = Math.max(amb.r, amb.g, amb.b, 1e-6);
    e.ambientIntensity = kmax;
    e.skyColor.copy(amb).multiplyScalar(1 / kmax);
    const gI = Math.max(0, muS);
    e.groundColor.setRGB(
      this.groundAlbedo.r * (sr * gI + sky.r), this.groundAlbedo.g * (sgc * gI + sky.g), this.groundAlbedo.b * (sb * gI + sky.b),
    ).multiplyScalar(1 / kmax);
    e.fogColor.copy(this._fog);
    u.uFogColorSun.value.copy(this._fogSun);
    const d0 = ap.has ? (ap.betaR[1] + ap.betaMe[1]) : 0;
    e.fogDensity = d0;
    e.night = 1 - smoothstep(-0.16, 0.06, muS);

    // ---- exposure / grade (gentle) ---------------------------------------------------------------
    this._gradeT -= dt;
    const target = 1.0 + 1.6 * smoothstep(0.0, 1.0, e.night);
    this._exposure += (target - this._exposure) * Math.min(1, dt * 0.8);
    if (dt === 0) this._exposure = target;
    const sc = p.ctx.scales;
    if (this._gradeT <= 0 && sc?.current === p && !sc.tr) {
      this._gradeT = 0.4;
      p.ctx.post.setGrade({ ...p.grade, exposure: (p.grade.exposure ?? 1) * this._exposure });
    }
  }

  /** hemisphere sky irradiance + horizon fog colours from the JS model (cheap: ~19 short marches) */
  _ambient(pos, up) {
    const p = this.planet, m = this.model, o = this._out, ro = this._ro, rd = this._rd, sd = this._sd;
    pos.toArray(ro); p.sunDir.toArray(sd);
    // local frame
    const sx = _v2.copy(p.sunDir).addScaledVector(up, -p.sunDir.dot(up));
    if (sx.lengthSq() < 1e-8) sx.set(1, 0, 0).addScaledVector(up, -up.x);
    sx.normalize();
    const sy = new THREE.Vector3().crossVectors(up, sx);
    const dir = (el, az) => {
      const ce = Math.cos(el), se = Math.sin(el), ca = Math.cos(az) * ce, sa = Math.sin(az) * ce;
      rd[0] = sx.x * ca + sy.x * sa + up.x * se; rd[1] = sx.y * ca + sy.y * sa + up.y * se; rd[2] = sx.z * ca + sy.z * sa + up.z * se;
    };
    const night = this._nightArr, sun = this._sunSky;
    const irr = [0, 0, 0];
    const bands = [[0, 0.45], [0.45, 0.96], [0.96, 1.43]];
    for (const [e1, e2] of bands) {
      const el = (e1 + e2) / 2, w = (2 * Math.PI * (Math.sin(e2) - Math.sin(e1))) / 6 * Math.sin(el);
      for (let i = 0; i < 6; i++) {
        dir(el, (i / 6) * Math.PI * 2 + 0.26);
        m.sky(ro, rd, sd, o, 12, sun, night);
        irr[0] += o.L[0] * w; irr[1] += o.L[1] * w; irr[2] += o.L[2] * w;
      }
    }
    dir(1.53, 0); m.sky(ro, rd, sd, o, 12, sun, night);
    const wz = 2 * Math.PI * (1 - Math.sin(1.43));
    irr[0] += o.L[0] * wz; irr[1] += o.L[1] * wz; irr[2] += o.L[2] * wz;
    // floor: direct starlight / moon fill so nights are readable even on airless worlds
    const nf = this.nightE;
    this._skyIrr.setRGB(irr[0] + nf.x * 0.5, irr[1] + nf.y * 0.5, irr[2] + nf.z * 0.5);
    // horizon colours: toward the sun and averaged
    dir(0.03, 0); m.sky(ro, rd, sd, o, 12, sun, night); this._fogSun.setRGB(o.L[0], o.L[1], o.L[2]);
    const f = [o.L[0], o.L[1], o.L[2]];
    for (const az of [Math.PI * 0.5, Math.PI, Math.PI * 1.5]) { dir(0.03, az); m.sky(ro, rd, sd, o, 12, sun, night); f[0] += o.L[0]; f[1] += o.L[1]; f[2] += o.L[2]; }
    this._fog.setRGB(f[0] / 4, f[1] / 4, f[2] / 4);
  }

  dispose() {
    this._disposed = true;
    const p = this.planet;
    p.scene.remove(this.dome, this.starGroup);
    this.dome.geometry.dispose(); this.domeMat.dispose();
    this.stars.geometry.dispose(); this.starMat.dispose();
    this.skyPass.dispose(); this.skyRT.dispose(); this.transRT.dispose();
    try { this.deepSky?.dispose(); } catch (e) { /* ignore */ }
  }
}

function blackbody(T) {
  const t = Math.min(40000, Math.max(1000, T)) / 100;
  const r = t <= 66 ? 1 : clamp(1.292936186 * Math.pow(t - 60, -0.1332047592), 0, 1);
  const g = t <= 66 ? clamp(0.390081579 * Math.log(t) - 0.631841444, 0, 1) : clamp(1.129890861 * Math.pow(t - 60, -0.0755148492), 0, 1);
  const b = t >= 66 ? 1 : t <= 19 ? 0 : clamp(0.543206789 * Math.log(t - 10) - 1.196254089, 0, 1);
  return [r * r, g * g, b * b];
}
