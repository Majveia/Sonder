// COSMIC WEB — the opening image of SONDER.
//
// A real particle-mesh N-body simulation of ΛCDM structure formation (pm.js) runs in a module
// worker (sim-worker.js) and streams ~50 keyframes of quantised particle positions + per-particle
// density / velocity-dispersion bytes. The GPU holds four keyframe slots and Catmull-Rom
// interpolates them in the vertex shader (periodic unwrap), so cosmic time can be scrubbed freely.
// Rendering: three additive layers from one geometry (haze, filaments, glints) + early-universe glow.
//
// Public API (used by the intro):
//   scale.cinematic   scale.setTime(a)   scale.time   scale.autoplay   scale.setReveal(k)
//   scale.setExpansion(k)   scale.homePosition   scale.haloes   scale.boxSize   scale.simProgress
//   scale.ready (Promise: haloes known)
//
// URL debug params: cosmicboost=<amp boost>  cosmictime=<a>  cosmicgrid=<particles per side>
import * as THREE from 'three';
import { Scale } from '../../core/scale.js';
import { OrbitRig } from '../../core/flycam.js';
import { damp, clamp, smoothstep } from '../../core/rng.js';
import { Cosmology } from './pm.js';
import { FIL_VERT, FIL_FRAG, HAZE_VERT, HAZE_FRAG, GLINT_VERT, GLINT_FRAG, GLOW_VERT, GLOW_FRAG } from './shaders.js';

const BOX = 100;            // world units per box side (comoving view)
const A_START = 0.02;
const PLAY_SECONDS = 48;    // autoplay duration from a≈0 to today
const TAU0 = 0.06;          // fraction of the timeline spent before the simulation starts (a < A_START)

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();

export default class CosmicScale extends Scale {
  static persistent = true;

  constructor(ctx) {
    super(ctx);
    this.cinematic = false;
    this.autoplay = true;
    this.boxSize = BOX;
    this.simProgress = 0;
    this.haloes = [];
    this.homePosition = new THREE.Vector3();
    this.home = null;
    this._a = 1;              // display scale factor
    this._reveal = 1; this._revealGoal = 1;
    this._expansion = 0; this._expansionGoal = 0;
    this.kfs = [];            // { a, pos: Uint16Array, fields: Uint8Array }
    this.keyA = [];
    this.focus = new THREE.Vector3(0.5, 0.5, 0.5); // box fractions (unbounded)
    this._slots = [-1, -1, -1, -1];
    this._detailT = 0;
  }

  // ------------------------------------------------------------------------------------------
  async init(params = {}) {
    const { ctx } = this;
    const q = ctx.quality, P = ctx.params || {};
    const cos = ctx.universe.cosmology;
    this.cosmo = new Cosmology(cos);
    const np = Number(P.cosmicgrid) || q.simGrid || 64;
    const mesh = q.tier === 'ultra' ? 128 : 64;
    this.np = np;

    this.camera.near = 0.02; this.camera.far = 6000; this.camera.fov = 50;
    this.camera.updateProjectionMatrix();
    this.rig = new OrbitRig(this.camera, { distance: 150, minDistance: 0.6, maxDistance: 420, pitch: 0.32, yaw: 0.6, autoRotate: 0.035 });
    this.rig.smooth = 3.2;

    this.grade = {
      exposure: 1.0, bloom: 0.95, bloomThreshold: 0.28, bloomKnee: 0.7, bloomRadius: 0.86,
      contrast: 1.12, saturation: 1.18, lift: [0, 0, 0], gain: [1, 1, 1], vignette: 0.42, grain: 0.03, ca: 0.0026, toneMap: 1,
    };

    // ---- simulation worker ----
    this.worker = new Worker(new URL('./sim-worker.js', import.meta.url), { type: 'module' });
    let firstResolve; const first = new Promise((r) => { firstResolve = r; });
    let haloResolve; this.ready = new Promise((r) => { haloResolve = r; });
    this.worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'meta') { this.N = m.N; this.keyA = m.keyA; this._buildGeometry(m.N); }
      else if (m.type === 'kf') { this.kfs[m.index] = { a: m.a, pos: m.pos, fields: m.fields }; this._avail = this._countAvail(); if (this._avail >= 2) firstResolve(); }
      else if (m.type === 'progress') this.simProgress = m.k;
      else if (m.type === 'haloes') { this._setHaloes(m.haloes); haloResolve(this.haloes); }
      else if (m.type === 'done') { this.simProgress = 1; this.simStats = m.stats; this.simMs = m.ms; console.info(`[cosmic] simulation done in ${(m.ms / 1000).toFixed(1)} s`, m.stats); }
      else if (m.type === 'error') { console.error('[cosmic worker]', m.message); firstResolve(); }
    };
    this.worker.onerror = (e) => { console.error('[cosmic worker]', e.message || e); firstResolve(); };
    this.worker.postMessage({
      cmd: 'start', np, mesh, icMesh: 64, boxMpc: cos.boxMpc, seed: ctx.universe.seed,
      cosmo: { H0: cos.H0, omegaM: cos.omegaM, omegaL: cos.omegaL, omegaB: cos.omegaB, sigma8: cos.sigma8, ns: cos.ns },
      ampBoost: Number(P.cosmicboost) || 1.2, aStart: A_START, every: 2,
    });

    // ---- early-universe glow (sky sphere) ----
    this.glowMat = new THREE.ShaderMaterial({
      vertexShader: GLOW_VERT, fragmentShader: GLOW_FRAG, side: THREE.BackSide, depthTest: false, depthWrite: false,
      uniforms: { uGlowCol: { value: new THREE.Color() }, uGlow: { value: 0 }, uTime: { value: 0 }, uMottle: { value: 0.1 } },
    });
    this.glow = new THREE.Mesh(new THREE.SphereGeometry(10, 48, 24), this.glowMat);
    this.glow.frustumCulled = false; this.glow.renderOrder = -10;
    this.scene.add(this.glow);

    await Promise.race([first, new Promise((r) => setTimeout(r, 12000))]);

    if (params.intro) { this.cinematic = true; this._a = 0; this._reveal = this._revealGoal = 0; this.autoplay = false; }
    else {
      const t = Number(P.cosmictime);
      this._a = Number.isFinite(t) && P.cosmictime !== undefined ? t : 0.03;
    }
  }

  _countAvail() { let n = 0; while (this.kfs[n]) n++; return n; }

  _buildGeometry(N) {
    const g = new THREE.BufferGeometry();
    const names = ['position', 'p1', 'p2', 'p3'];
    this.posAttrs = names.map((nm) => { const a = new THREE.BufferAttribute(new Uint16Array(N * 3), 3, true); a.setUsage(THREE.DynamicDrawUsage); g.setAttribute(nm, a); return a; });
    this.fieldAttrs = ['f0', 'f1', 'f2', 'f3'].map((nm) => { const a = new THREE.BufferAttribute(new Uint8Array(N * 2), 2, true); a.setUsage(THREE.DynamicDrawUsage); g.setAttribute(nm, a); return a; });
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.geometry = g;

    const q = this.ctx.quality;
    const shared = {
      uW: { value: new THREE.Vector4(1, 0, 0, 0) }, uDW: { value: new THREE.Vector4() }, uRef: { value: new THREE.Vector4(1, 0, 0, 0) },
      uC: { value: this.focus }, uBox: { value: BOX }, uTime: { value: 0 }, uPx: { value: 500 }, uReveal: { value: 1 },
      uA: { value: 1 }, uEarly: { value: 0 }, uFocusDist: { value: 150 }, uSphere: { value: 0.48 },
    };
    this.uniforms = shared;
    const mk = (vs, fs, extra) => new THREE.ShaderMaterial({
      vertexShader: vs, fragmentShader: fs, uniforms: { ...shared, ...extra },
      blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, transparent: true,
    });
    // particle count compensation: fewer particles → each one a little brighter / larger
    const dens = Math.pow(80 / this.np, 3);
    this.filMat = mk(FIL_VERT, FIL_FRAG, { uSize: { value: 0.16 * Math.pow(dens, 0.33) }, uMinPx: { value: 1.15 }, uMaxPx: { value: 24 }, uGain: { value: 0.32 * dens } });
    this.hazeMat = mk(HAZE_VERT, HAZE_FRAG, { uSize: { value: 2.4 }, uMaxPx: { value: 60 }, uGain: { value: 0.03 * dens } });
    this.glintMat = mk(GLINT_VERT, GLINT_FRAG, { uSize: { value: 0.3 }, uMinPx: { value: 1.6 }, uMaxPx: { value: 36 }, uGain: { value: 2.6 }, uLight: { value: 1 } });

    this.haze = new THREE.Points(g, this.hazeMat);
    // haze uses a random subset: particles are shuffled in the worker, so any prefix is random
    this.hazeGeo = new THREE.BufferGeometry();
    for (const nm of Object.keys(g.attributes)) this.hazeGeo.setAttribute(nm, g.attributes[nm]);
    this.hazeGeo.boundingSphere = g.boundingSphere;
    this.hazeGeo.setDrawRange(0, Math.floor(N / (q.tier === 'low' ? 6 : 5)));
    this.haze.geometry = this.hazeGeo;
    this.fil = new THREE.Points(g, this.filMat);
    this.glints = new THREE.Points(g, this.glintMat);
    for (const [o, r] of [[this.haze, 1], [this.fil, 2], [this.glints, 3]]) { o.frustumCulled = false; o.renderOrder = r; this.scene.add(o); }
  }

  _setHaloes(list) {
    const { universe } = this.ctx;
    // home: a modest halo sitting in a filament (mid-mass rank, most elongated surroundings)
    const n = list.length;
    let best = -1, bestScore = -1;
    for (let i = Math.floor(n * 0.3); i < Math.floor(n * 0.65); i++) {
      const h = list[i];
      const score = h.elong;
      if (score > bestScore) { bestScore = score; best = i; }
    }
    this.haloes = list.map((h, i) => {
      const id = i === best ? 0 : 1 + i;
      const g = universe.galaxy(id);
      return {
        id, index: i, name: g.name, desc: g, mass: h.massSun, frac: new THREE.Vector3(...h.pos), particle: h.particle,
        position: new THREE.Vector3(), elong: h.elong, home: id === 0,
      };
    });
    this.home = this.haloes.find((h) => h.home) || null;
    this._updateHaloPositions();
  }

  // ------------------------------------------------------------------------------------------
  // public API
  get time() { return this._a; }
  setTime(a) { this._a = clamp(a, 0, this._maxA()); }
  setReveal(k, immediate = true) { this._revealGoal = clamp(k, 0, 1); if (immediate) this._reveal = this._revealGoal; }
  setExpansion(k, immediate = true) { this._expansionGoal = clamp(k, 0, 1); if (immediate) this._expansion = this._expansionGoal; }
  get expansion() { return this._expansion; }
  get reveal() { return this._reveal; }
  _maxA() { const n = this._avail || 0; return n ? this.kfs[n - 1].a : A_START; }

  /** timeline coordinate τ ∈ [0,1] ↔ scale factor a (pre-simulation section, then keyframe index) */
  _aToTau(a) {
    if (a <= A_START || !this.keyA.length) return clamp(a / A_START, 0, 1) * TAU0;
    const u = this._aToU(a);
    return TAU0 + (1 - TAU0) * u / (this.keyA.length - 1);
  }
  _tauToA(tau) {
    if (tau <= TAU0 || !this.keyA.length) return A_START * clamp(tau / TAU0, 0, 1);
    const u = (tau - TAU0) / (1 - TAU0) * (this.keyA.length - 1);
    const i = Math.min(this.keyA.length - 2, Math.floor(u)), t = u - i;
    return this.keyA[i] + (this.keyA[i + 1] - this.keyA[i]) * t;
  }
  _aToU(a) {
    const K = this.keyA;
    if (!K.length || a <= K[0]) return 0;
    for (let i = 0; i < K.length - 1; i++) if (a <= K[i + 1]) return i + (a - K[i]) / (K[i + 1] - K[i]);
    return K.length - 1;
  }

  // ------------------------------------------------------------------------------------------
  enter(params = {}, fromName) {
    const { ui, input, audio } = this.ctx;
    input.setScheme({ pointerLock: false, joystick: false });
    audio?.setScene?.('cosmic');
    if (params.intro) { this.cinematic = true; }
    this._updateLocation(true);
    if (!this.cinematic) {
      ui.setHints?.([
        { key: 'Drag', text: 'Orbit' }, { key: 'Wheel', text: 'Zoom' }, { key: 'WASD', text: 'Fly' },
        { key: 'T', text: 'Play / pause cosmic time' }, { key: 'V', text: 'Comoving / expanding' },
      ]);
    }
    if (params.focus !== undefined && this.haloes.length) {
      const h = this.haloes.find((x) => x.id === params.focus);
      if (h) { this.focus.copy(h.frac); this.rig.distance = 3; this.rig.goalDistance = 26; }
    }
    this.ctx.state.location = { ...this.ctx.state.location };
  }

  exit() {
    const { ui } = this.ctx;
    ui.removeLabel?.('cosmic-home');
  }

  _updateLocation(force) {
    const a = this._a, z = a > 1e-4 ? 1 / a - 1 : Infinity;
    const age = this.cosmo.ageGyr(Math.max(a, 1e-6));
    const ageTxt = age < 0.001 ? `${Math.round(age * 1e6).toLocaleString('en-US')} thousand years` : age < 1 ? `${Math.round(age * 1000)} million years` : `${age.toFixed(1)} billion years`;
    const detail = `${ageTxt}  ·  z = ${z === Infinity ? '∞' : z < 10 ? z.toFixed(2) : z.toFixed(0)}`;
    if (force || detail !== this._detail) {
      this._detail = detail;
      this.ctx.ui.setLocation({ kicker: 'The observable universe', name: 'Cosmic web', detail });
    }
  }

  // ------------------------------------------------------------------------------------------
  update(dt, time) {
    if (!this.geometry) return;
    const { input } = this.ctx;
    // ---- time ----
    if (!this.cinematic) {
      if (input.hit('time')) {
        if (!this.autoplay && this._a >= this._maxA() - 1e-4) this._a = 0;
        this.autoplay = !this.autoplay;
      }
      if (input.hit('view')) this._expansionGoal = this._expansionGoal > 0.5 ? 0 : 1;
    }
    if (this.autoplay) {
      const tau = this._aToTau(this._a) + dt / PLAY_SECONDS;
      this._a = Math.min(this._tauToA(Math.min(1, tau)), this._maxA());
    }
    this._a = Math.min(this._a, this._maxA());
    this._reveal += (this._revealGoal - this._reveal) * damp(2.5, dt);
    this._expansion += (this._expansionGoal - this._expansion) * damp(1.5, dt);

    // ---- camera ----
    const s = this._expScale();
    const boxW = BOX * s;
    if (!this.cinematic) {
      // WASD flies the focus through the (periodic, endless) web
      const mv = input.move;
      const up = (input.held('jump') ? 1 : 0) - (input.held('descend') ? 1 : 0);
      if (mv.x || mv.y || up) {
        const sp = (input.held('sprint') ? 3 : 1) * Math.max(2, this.rig.distance) * 0.6 * dt / boxW;
        this.camera.getWorldDirection(_v);
        _v2.crossVectors(_v, this.camera.up).normalize();
        this.focus.addScaledVector(_v, mv.y * sp).addScaledVector(_v2, mv.x * sp);
        this.focus.y += up * sp;
        this.rig.idle = 0;
      }
      this.rig.enabled = true;
      this.rig.goalTarget.set((this.focus.x - 0.5) * boxW, (this.focus.y - 0.5) * boxW, (this.focus.z - 0.5) * boxW);
      this.rig.update(dt, input);
    }

    // ---- keyframes → GPU slots ----
    this._applyTimeline();
    const u = this.uniforms;
    u.uTime.value = time;
    u.uBox.value = boxW;
    u.uA.value = this._a;
    u.uReveal.value = this._reveal;
    u.uEarly.value = 1 - smoothstep(0.03, 0.14, this._a);
    // focus for depth cue: distance from camera to the box centre / orbit target
    const fd = this.cinematic ? this.camera.position.distanceTo(_v.set((this.focus.x - 0.5) * boxW, (this.focus.y - 0.5) * boxW, (this.focus.z - 0.5) * boxW)) : this.rig.distance;
    u.uFocusDist.value = Math.max(2, fd);
    // when the camera is inside the box the sphere of visibility follows the camera's focus
    const size = this.ctx.engine.size;
    u.uPx.value = (size.height * size.pixelRatio) / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2));
    // first light: galaxies ignite around z ~ 15 … 6
    this.glintMat.uniforms.uLight.value = smoothstep(0.055, 0.16, this._a);

    // ---- early-universe glow ----
    const a = this._a;
    const g = this.glowMat.uniforms;
    // recombination glow (a ≲ 0.001) cooling through amber and deep red into the dark ages
    const kHot = 1 - smoothstep(0.0, 0.004, a), kAmber = 1 - smoothstep(0.003, 0.011, a), kRed = 1 - smoothstep(0.008, 0.026, a);
    const col = g.uGlowCol.value;
    col.setRGB(1.0, 0.86, 0.62).multiplyScalar(kHot * 2.2)
      .add(_c1.setRGB(1.0, 0.42, 0.10).multiplyScalar((kAmber - kHot * 0.5) * 0.9))
      .add(_c2.setRGB(0.55, 0.06, 0.03).multiplyScalar(Math.max(0, kRed - kAmber) * 0.6));
    g.uGlow.value = this._reveal;
    g.uTime.value = time;
    g.uMottle.value = 0.08 + 0.12 * smoothstep(0.002, 0.02, a);
    this.glow.visible = kRed > 0.001 && this._reveal > 0.001;
    this.glow.position.copy(this.camera.position);

    this._updateHaloPositions();
    this._updateLabels();
    this._detailT -= dt;
    if (this._detailT <= 0) { this._detailT = 0.25; this._updateLocation(false); }
  }

  _expScale() {
    const s = Math.max(this._a, 0.06);
    return 1 + (s - 1) * this._expansion;
  }

  /** Map display a → keyframe slots + Catmull-Rom weights; upload keyframes as needed. */
  _applyTimeline() {
    const n = this._avail || 0;
    if (!n) return;
    const uMax = n - 1;
    const u = Math.min(this._aToU(Math.max(this._a, A_START)), uMax);
    const i = Math.min(Math.floor(u), Math.max(0, uMax - 1)), t = n > 1 ? clamp(u - i, 0, 1) : 0;
    const ks = [i - 1, i, i + 1, i + 2].map((k) => clamp(k, 0, uMax));
    // Catmull-Rom weights and their derivatives
    const t2 = t * t, t3 = t2 * t;
    const w = [-0.5 * t3 + t2 - 0.5 * t, 1.5 * t3 - 2.5 * t2 + 1, -1.5 * t3 + 2 * t2 + 0.5 * t, 0.5 * t3 - 0.5 * t2];
    const dw = [-1.5 * t2 + 2 * t - 0.5, 4.5 * t2 - 5 * t, -4.5 * t2 + 4 * t + 0.5, 1.5 * t2 - t];
    const W = [0, 0, 0, 0], DW = [0, 0, 0, 0], R = [0, 0, 0, 0];
    // assign each needed keyframe to slot (k mod 4); duplicates (clamped ends) share a slot
    for (let j = 0; j < 4; j++) {
      const k = ks[j], slot = k % 4;
      if (this._slots[slot] !== k) this._upload(slot, k);
      W[slot] += w[j]; DW[slot] += dw[j];
    }
    R[ks[1] % 4] = 1;
    this.uniforms.uW.value.fromArray(W);
    this.uniforms.uDW.value.fromArray(DW);
    this.uniforms.uRef.value.fromArray(R);
    this._u = u; this._ks = ks; this._w = W;
  }

  _upload(slot, k) {
    const kf = this.kfs[k];
    const pa = this.posAttrs[slot], fa = this.fieldAttrs[slot];
    pa.array = kf.pos; pa.needsUpdate = true;
    fa.array = kf.fields; fa.needsUpdate = true;
    this._slots[slot] = k;
  }

  /** CPU version of the vertex-shader interpolation for one particle → world position. */
  particleWorld(index, out) {
    const ks = this._ks; if (!ks) return out.set(0, 0, 0);
    const W = this._w, i3 = index * 3;
    const ref = this.kfs[ks[1]].pos;
    let x = 0, y = 0, z = 0;
    for (let slot = 0; slot < 4; slot++) {
      if (!W[slot]) continue;
      const p = this.kfs[this._slots[slot]].pos;
      for (let c = 0; c < 3; c++) {
        const r = ref[i3 + c] / 65536;
        let d = p[i3 + c] / 65536 - r; d -= Math.floor(d + 0.5);
        const v = (r + d) * W[slot];
        if (c === 0) x += v; else if (c === 1) y += v; else z += v;
      }
    }
    const C = this.focus, boxW = BOX * this._expScale();
    x = C.x + (((x - C.x + 0.5) % 1) + 1) % 1 - 0.5;
    y = C.y + (((y - C.y + 0.5) % 1) + 1) % 1 - 0.5;
    z = C.z + (((z - C.z + 0.5) % 1) + 1) % 1 - 0.5;
    return out.set((x - 0.5) * boxW, (y - 0.5) * boxW, (z - 0.5) * boxW);
  }

  _updateHaloPositions() {
    if (!this.haloes.length || !this._ks) return;
    for (const h of this.haloes) this.particleWorld(h.particle, h.position);
    if (this.home) this.homePosition.copy(this.home.position);
  }

  _updateLabels() {
    const { ui } = this.ctx;
    if (this.cinematic || !this.home || this._reveal < 0.5) { ui.removeLabel?.('cosmic-home'); return; }
    _v.copy(this.home.position).project(this.camera);
    const size = this.ctx.engine.size;
    const vis = _v.z < 1 && Math.abs(_v.x) < 1.1 && Math.abs(_v.y) < 1.1 && this._a > 0.5;
    ui.label('cosmic-home', {
      x: (_v.x * 0.5 + 0.5) * size.width, y: (-_v.y * 0.5 + 0.5) * size.height,
      text: `${this.home.name}`, sub: 'home', visible: vis, kind: 'marker faint',
    });
  }

  resize(w, h) { super.resize(w, h); }

  dispose() {
    this.worker?.terminate();
    this.hazeGeo?.dispose();
    super.dispose();
  }
}

const _c1 = new THREE.Color(), _c2 = new THREE.Color();
