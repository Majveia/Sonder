// COSMIC WEB — the opening image of SONDER.
//
// A real particle-mesh N-body simulation of ΛCDM structure formation (pm.js) runs in a module
// worker (sim-worker.js) and streams ~29 keyframes of quantised particle positions + one packed
// byte per particle (5-bit log density | 3-bit velocity dispersion). The GPU holds four keyframe
// slots and Catmull-Rom interpolates them in the vertex shader (periodic unwrap), so cosmic time
// can be scrubbed freely. Rendering: three additive layers (haze, filaments, glints), each drawn
// for the 27 nearest periodic images of the box (endless tapestry, per-vertex LOD), plus the
// early-universe glow.
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
import { TimeScrubber } from './scrubber.js';

const BOX = 100;            // world units per box side (comoving view)
const A_START = 0.02;
const PLAY_SECONDS = 52;    // autoplay duration from a≈0 to today
const TAU0 = 0.1;           // fraction of the timeline spent before the simulation starts (a < A_START)
const HAZE_FRAC = 0.2;
const TYPE_NAMES = { spiral: 'Spiral galaxy', barred: 'Barred spiral', elliptical: 'Elliptical galaxy', lenticular: 'Lenticular galaxy', irregular: 'Irregular galaxy', ring: 'Ring galaxy' };

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const easeIn = (k) => k * k * k;

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
    this._sPrev = 1;
    this.kfs = [];            // { a, pos: Uint16Array, fields: Uint8Array }
    this.keyA = [];
    this.focus = new THREE.Vector3(0.5, 0.5, 0.5); // box fractions (unbounded)
    this._slots = [-1, -1, -1, -1];
    this._detailT = 0;
    this._breath = 0;
    this._hover = null;
    this._dive = null;
    this.images = [];
  }

  // ------------------------------------------------------------------------------------------
  async init(params = {}) {
    const t0 = performance.now();
    const { ctx } = this;
    const q = ctx.quality, P = ctx.params || {};
    const cos = ctx.universe.cosmology;
    this.cosmo = new Cosmology(cos);
    // particles per side: simGrid, capped at 72 on high (keyframe memory ≲ 80 MB)
    const np = Number(P.cosmicgrid) || (q.tier === 'high' ? Math.min(72, q.simGrid) : q.simGrid) || 64;
    const mesh = q.tier === 'ultra' ? 128 : 64;
    this.np = np;
    // LOD: world distance inside which every particle of every image is drawn
    this.lod = BOX * (q.tier === 'low' ? 0.32 : q.tier === 'medium' ? 0.42 : q.tier === 'ultra' ? 0.7 : 0.52);
    this.lodMin = q.tier === 'low' ? 0.04 : 0.06;

    this.camera.near = 0.02; this.camera.far = 6000; this.camera.fov = 55;
    this.camera.updateProjectionMatrix();
    // start INSIDE the web: filaments cross the whole frame with parallax
    this.rig = new OrbitRig(this.camera, { distance: 30, minDistance: 0.6, maxDistance: 360, pitch: 0.22, yaw: 0.6, autoRotate: 0.03 });
    this.rig.smooth = 3.2;

    this.grade = {
      exposure: 1.0, bloom: 0.7, bloomThreshold: 0.6, bloomKnee: 0.55, bloomRadius: 0.8,
      contrast: 1.16, saturation: 1.2, lift: [0, 0, 0], gain: [1, 1, 1], vignette: 0.45, grain: 0.028, ca: 0.0026, toneMap: 1,
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
      else if (m.type === 'done') {
        this.simProgress = 1; this.simStats = m.stats; this.simMs = m.ms;
        const mb = this.kfs.reduce((s, k) => s + (k ? k.pos.byteLength + k.fields.byteLength : 0), 0) / 1048576;
        this.keyframeMB = mb;
        console.info(`[cosmic] simulation done in ${(m.ms / 1000).toFixed(1)} s · ${this.kfs.length} keyframes · ${mb.toFixed(1)} MB`);
      } else if (m.type === 'error') { console.error('[cosmic worker]', m.message); firstResolve(); }
    };
    this.worker.onerror = (e) => { console.error('[cosmic worker]', e.message || e); firstResolve(); };
    this.worker.postMessage({
      cmd: 'start', np, mesh, icMesh: 64, boxMpc: cos.boxMpc, seed: ctx.universe.seed,
      cosmo: { H0: cos.H0, omegaM: cos.omegaM, omegaL: cos.omegaL, omegaB: cos.omegaB, sigma8: cos.sigma8, ns: cos.ns },
      ampBoost: Number(P.cosmicboost) || 1.3, aStart: A_START, every: 3,
    });

    // ---- early-universe glow (sky sphere) ----
    this.glowMat = new THREE.ShaderMaterial({
      vertexShader: GLOW_VERT, fragmentShader: GLOW_FRAG, side: THREE.BackSide, depthTest: false, depthWrite: false,
      uniforms: { uHeat: { value: 0 }, uGlow: { value: 0 }, uTime: { value: 0 }, uFwd: { value: new THREE.Vector3(0, 0, -1) } },
    });
    this.glow = new THREE.Mesh(new THREE.SphereGeometry(10, 64, 32), this.glowMat);
    this.glow.frustumCulled = false; this.glow.renderOrder = -10;
    this.scene.add(this.glow);

    this.scrubber = new TimeScrubber(ctx.ui.root, {
      getTau: () => this._aToTau(this._a),
      getMaxTau: () => this._aToTau(this._maxA()),
      setTau: (t) => { this.autoplay = false; this._breathing = false; this._a = clamp(this._tauToA(t), 0, this._maxA()); },
      togglePlay: () => this._togglePlay(),
      toggleExpansion: () => { this._expansionGoal = this._expansionGoal > 0.5 ? 0 : 1; },
      isPlaying: () => this.autoplay,
      isExpanding: () => this._expansionGoal > 0.5,
    });

    await Promise.race([first, new Promise((r) => setTimeout(r, 12000))]);
    this.initMs = performance.now() - t0;
    console.info(`[cosmic] init resolved in ${this.initMs.toFixed(0)} ms`);

    if (params.intro) { this.cinematic = true; this._a = 0; this._reveal = this._revealGoal = 0; this.autoplay = false; }
    else {
      const t = Number(P.cosmictime);
      this._a = Number.isFinite(t) && P.cosmictime !== undefined ? t : 0;
    }
  }

  _countAvail() { let n = 0; while (this.kfs[n]) n++; return n; }

  _buildGeometry(N) {
    const g = new THREE.BufferGeometry();
    this.posAttrs = ['position', 'p1', 'p2', 'p3'].map((nm) => { const a = new THREE.BufferAttribute(new Uint16Array(N * 3), 3, true); a.setUsage(THREE.DynamicDrawUsage); g.setAttribute(nm, a); return a; });
    this.fieldAttrs = ['f0', 'f1', 'f2', 'f3'].map((nm) => { const a = new THREE.BufferAttribute(new Uint8Array(N), 1, true); a.setUsage(THREE.DynamicDrawUsage); g.setAttribute(nm, a); return a; });
    this.geometry = g;
    this.bsphere = new THREE.Sphere(new THREE.Vector3(), BOX);

    const shared = {
      uW: { value: new THREE.Vector4(1, 0, 0, 0) }, uDW: { value: new THREE.Vector4() }, uRef: { value: new THREE.Vector4(1, 0, 0, 0) },
      uC: { value: this.focus }, uFocusW: { value: new THREE.Vector3() }, uBox: { value: BOX }, uS: { value: 1 }, uTime: { value: 0 },
      uPx: { value: 500 }, uReveal: { value: 1 }, uEarly: { value: 0 }, uFocusDist: { value: 30 },
      uFade0: { value: BOX * 0.95 }, uFade1: { value: BOX * 1.48 }, uLdGain: { value: 1 }, uJitter: { value: 0 },
      uLod: { value: this.lod }, uLodMin: { value: this.lodMin }, uFlow: { value: 0 },
    };
    this.uniforms = shared;
    const mk = (vs, fs, extra) => new THREE.ShaderMaterial({
      vertexShader: vs, fragmentShader: fs, uniforms: { ...shared, ...extra },
      blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, transparent: true,
    });
    // particle-count compensation: fewer particles → each one a little brighter / larger
    const dens = Math.pow(72 / this.np, 3);
    this.filMat = mk(FIL_VERT, FIL_FRAG, { uN: { value: N }, uSize: { value: 0.15 * Math.pow(dens, 0.33) }, uMinPx: { value: 1.1 }, uMaxPx: { value: 22 }, uGain: { value: 0.42 * dens } });
    this.hazeMat = mk(HAZE_VERT, HAZE_FRAG, { uN: { value: N * HAZE_FRAC }, uSize: { value: 2.2 }, uMaxPx: { value: 56 }, uGain: { value: 0.012 * Math.sqrt(dens) } });
    this.glintMat = mk(GLINT_VERT, GLINT_FRAG, { uN: { value: N }, uSize: { value: 0.26 }, uMinPx: { value: 1.5 }, uMaxPx: { value: 30 }, uGain: { value: 3.2 } });
    this.layers = [
      { mat: this.hazeMat, frac: HAZE_FRAC, order: 1 },
      { mat: this.filMat, frac: 1, order: 2 },
      { mat: this.glintMat, frac: 1, order: 3 },
    ];
    // the 27 nearest periodic images (union covers a 3-box cube: no gap inside the fade radius)
    for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) {
      const img = { o: new THREE.Vector3(x, y, z), objs: [] };
      for (const L of this.layers) {
        const geo = new THREE.BufferGeometry();
        for (const nm of Object.keys(g.attributes)) geo.setAttribute(nm, g.attributes[nm]);
        geo.boundingSphere = this.bsphere;
        const pts = new THREE.Points(geo, L.mat);
        pts.renderOrder = L.order; pts.frustumCulled = true;
        this.scene.add(pts);
        img.objs.push({ pts, geo, frac: L.frac });
      }
      this.images.push(img);
    }
  }

  _setHaloes(list) {
    const { universe } = this.ctx;
    // home: a modest halo sitting in a filament (mid-mass rank, most elongated surroundings)
    const n = list.length;
    let best = -1, bestScore = -1;
    for (let i = Math.floor(n * 0.3); i < Math.floor(n * 0.65); i++) {
      if (list[i].elong > bestScore) { bestScore = list[i].elong; best = i; }
    }
    this.haloes = list.map((h, i) => {
      const id = i === best ? 0 : 1 + i;
      const g = universe.galaxy(id);
      return {
        id, index: i, name: g.name, desc: g, mass: h.massSun, frac: new THREE.Vector3(...h.pos), particle: h.particle,
        position: new THREE.Vector3(), central: new THREE.Vector3(), elong: h.elong, home: id === 0,
        sub: id === 0 ? 'Home · ' + this._describe(g, h.massSun) : this._describe(g, h.massSun),
      };
    });
    this.home = this.haloes.find((h) => h.home) || null;
    this._updateHaloPositions();
  }

  _describe(g, mass) {
    const stars = g.starCount >= 1e12 ? `${(g.starCount / 1e12).toFixed(1)} trillion stars` : `${Math.round(g.starCount / 1e9)} billion stars`;
    const exp = Math.floor(Math.log10(mass)), m = mass / 10 ** exp;
    return `${TYPE_NAMES[g.type] || 'Galaxy'}${g.active ? ' · active nucleus' : ''} · ${stars} · halo ${m.toFixed(1)}×10${sup(exp)} M☉`;
  }

  // ------------------------------------------------------------------------------------------
  // public API
  get time() { return this._a; }
  setTime(a) { this._a = clamp(a, 0, this._maxA()); this._breathing = false; }
  setReveal(k, immediate = true) { this._revealGoal = clamp(k, 0, 1); if (immediate) this._reveal = this._revealGoal; }
  setExpansion(k, immediate = true) { this._expansionGoal = clamp(k, 0, 1); if (immediate) this._expansion = this._expansionGoal; }
  get expansion() { return this._expansion; }
  get reveal() { return this._reveal; }
  _maxA() { const n = this._avail || 0; return n ? this.kfs[n - 1].a : A_START; }

  /** timeline coordinate τ ∈ [0,1] ↔ scale factor a (pre-simulation section, then keyframe index) */
  _aToTau(a) {
    if (a <= A_START || !this.keyA.length) return Math.pow(clamp(a / A_START, 0, 1), 0.4) * TAU0;
    return TAU0 + (1 - TAU0) * this._aToU(a) / (this.keyA.length - 1);
  }
  _tauToA(tau) {
    if (tau <= TAU0 || !this.keyA.length) return A_START * Math.pow(clamp(tau / TAU0, 0, 1), 2.5);
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
  _togglePlay() {
    if (!this.autoplay && this._a >= this._maxA() - 1e-4 && this.simProgress >= 1) this._a = 0;
    this.autoplay = !this.autoplay;
    this._breathing = false;
  }

  // ------------------------------------------------------------------------------------------
  enter(params = {}, fromName) {
    const { ui, input, audio } = this.ctx;
    input.setScheme({ pointerLock: false, joystick: false });
    audio?.setScene?.('cosmic');
    if (params.intro) this.cinematic = true;
    this._dive = null;
    this._updateLocation(true);
    if (!this.cinematic) {
      ui.setHints?.([
        { key: 'Drag', text: 'Orbit' }, { key: 'Wheel', text: 'Zoom' }, { key: 'W A S D', text: 'Drift through the web' },
        { key: 'E', text: 'Enter a galaxy' }, { key: 'T', text: 'Play / pause cosmic time' }, { key: 'V', text: 'Comoving / expanding' },
      ]);
    }
    if (params.focus !== undefined && this.haloes.length) {
      const h = this.haloes.find((x) => x.id === params.focus);
      if (h) {
        this.focus.copy(h.frac);
        this.rig.distance = 1.5; this.rig.goalDistance = 22;
        this.rig.target.set((h.frac.x - 0.5) * BOX * this._expScale(), (h.frac.y - 0.5) * BOX * this._expScale(), (h.frac.z - 0.5) * BOX * this._expScale());
      }
    }
    this._untap = input.onTap((p) => this._onTap(p));
    this.scrubber.setVisible(!this.cinematic);
  }

  exit() {
    const { ui } = this.ctx;
    this._untap?.(); this._untap = null;
    ui.removeLabel?.('cosmic-home'); ui.removeLabel?.('cosmic-hover');
    ui.prompt?.(null);
    this.scrubber.setVisible(false);
  }

  _updateLocation(force) {
    const a = this._a, z = a > 1e-5 ? 1 / a - 1 : Infinity;
    const age = this.cosmo.ageGyr(Math.max(a, 1e-7));
    const ageTxt = age < 0.001 ? `${Math.max(1, Math.round(age * 1e6)).toLocaleString('en-US')} thousand years` : age < 1 ? `${Math.round(age * 1000)} million years` : `${age.toFixed(1)} billion years`;
    const detail = `${ageTxt}  ·  z = ${z === Infinity ? '∞' : z < 10 ? z.toFixed(2) : Math.round(z).toLocaleString('en-US')}`;
    if (force || detail !== this._detail) {
      this._detail = detail;
      this.ctx.ui.setLocation({ kicker: 'The observable universe', name: 'Cosmic web', detail });
      this.scrubber?.setReadout(detail);
    }
  }

  // ------------------------------------------------------------------------------------------
  update(dt, time) {
    if (!this.geometry) return;
    const { input } = this.ctx;
    const interactive = !this.cinematic && !this._dive;
    // ---- time ----
    if (interactive) {
      if (input.hit('time')) this._togglePlay();
      if (input.hit('view')) this._expansionGoal = this._expansionGoal > 0.5 ? 0 : 1;
    }
    const maxA = this._maxA();
    if (this.autoplay && !this._breathing) {
      const tau = this._aToTau(this._a) + dt / PLAY_SECONDS;
      this._a = Math.min(this._tauToA(Math.min(1, tau)), maxA);
      // reached today with the whole run computed: settle into a gentle breathing near the present
      if (this.simProgress >= 1 && this._a >= maxA - 1e-4 && !this.cinematic) { this._breathing = true; this._breath = 0; }
    }
    if (this._breathing && this.autoplay) {
      this._breath += dt;
      const k = 0.5 - 0.5 * Math.cos(this._breath * Math.PI * 2 / 46);
      this._a = maxA - 0.06 * k * k;
    }
    this._a = Math.min(this._a, maxA);
    this._reveal += (this._revealGoal - this._reveal) * damp(2.5, dt);
    this._expansion += (this._expansionGoal - this._expansion) * damp(1.5, dt);

    // ---- camera ----
    const s = this._expScale();
    const boxW = BOX * s;
    // physical view: the camera rides the expansion so early epochs stay framed
    if (Math.abs(s - this._sPrev) > 1e-6) {
      const r = Math.pow(s / this._sPrev, 0.85);
      this.rig.distance *= r; this.rig.goalDistance *= r;
      this._sPrev = s;
    }
    if (interactive) {
      const mv = input.move;
      const up = (input.held('jump') ? 1 : 0) - (input.held('descend') ? 1 : 0);
      this.camera.getWorldDirection(_v);
      if (mv.x || mv.y || up) {
        const sp = (input.held('sprint') ? 3 : 1) * Math.max(2, this.rig.distance) * 0.6 * dt / boxW;
        _v2.crossVectors(_v, this.camera.up).normalize();
        this.focus.addScaledVector(_v, mv.y * sp).addScaledVector(_v2, mv.x * sp);
        this.focus.y += up * sp;
        this.rig.idle = 0;
      } else if (this.rig.idle > 7) {
        // idle drift: slowly travel through the web
        this.focus.addScaledVector(_v, 0.0035 * dt * Math.min(1, (this.rig.idle - 7) / 5));
      }
      this.rig.enabled = true;
    }
    if (!this.cinematic && !this._dive) {
      this.rig.goalTarget.set((this.focus.x - 0.5) * boxW, (this.focus.y - 0.5) * boxW, (this.focus.z - 0.5) * boxW);
      this.rig.update(dt, interactive ? input : null);
    }

    // ---- keyframes → GPU slots ----
    this._applyTimeline();
    const u = this.uniforms;
    u.uTime.value = time;
    u.uBox.value = boxW;
    u.uS.value = s;
    u.uFocusW.value.set((this.focus.x - 0.5) * boxW, (this.focus.y - 0.5) * boxW, (this.focus.z - 0.5) * boxW);
    u.uFade0.value = boxW * 0.95; u.uFade1.value = boxW * 1.48;
    u.uLod.value = this.lod * s;
    u.uReveal.value = this._reveal * smoothstep(0.01, 0.03, this._a);
    u.uLdGain.value = Math.min(5, Math.pow(1 / Math.max(0.02, this.cosmo.D(Math.max(this._a, A_START))), 0.7));
    u.uJitter.value = (1 / this.np) * 0.9 * (1 - smoothstep(0.04, 0.25, this._a));
    u.uEarly.value = 1 - smoothstep(0.035, 0.15, this._a);
    u.uFlow.value = 1.6 * smoothstep(0.3, 0.6, this._a);
    u.uFocusDist.value = Math.max(2, this.cinematic ? this.camera.position.distanceTo(u.uFocusW.value) : this.rig.distance);
    const size = this.ctx.engine.size;
    u.uPx.value = (size.height * size.pixelRatio) / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2));
    this.glintMat.uniforms.uLight.value = smoothstep(0.055, 0.16, this._a);
    this._updateImages(boxW);

    // ---- early-universe glow ----
    const a = this._a, g = this.glowMat.uniforms;
    const heat = a <= 0.0004 ? 1 : clamp(1 - Math.log(a / 0.0004) / Math.log(0.026 / 0.0004), 0, 1);
    g.uHeat.value = heat;
    g.uGlow.value = this._reveal;
    g.uTime.value = time;
    this.camera.getWorldDirection(g.uFwd.value);
    this.glow.visible = heat > 0.001 && this._reveal > 0.001;
    this.glow.position.copy(this.camera.position);

    this._updateHaloPositions();
    this._updateLabels(dt);
    this.scrubber.setVisible(!this.cinematic && !this._dive);
    this.scrubber.update();
    this._detailT -= dt;
    if (this._detailT <= 0) { this._detailT = 0.25; this._updateLocation(false); }
  }

  _expScale() {
    const s = Math.max(this._a, 0.06);
    return 1 + (s - 1) * this._expansion;
  }

  /** per periodic image: visibility (fade radius), frustum sphere, LOD draw range */
  _updateImages(boxW) {
    const C = this.focus, cam = this.camera.position, fw = this.uniforms.uFocusW.value;
    const N = this.N, lod = this.lod * (boxW / BOX), fade1 = boxW * 1.48, h = boxW * 0.5;
    this.bsphere.center.copy(fw); this.bsphere.radius = boxW * 0.87;
    for (const img of this.images) {
      const cx = fw.x + img.o.x * boxW, cy = fw.y + img.o.y * boxW, cz = fw.z + img.o.z * boxW;
      // nearest distance from the focus / camera to this image's cube
      const df = Math.hypot(Math.max(0, Math.abs(fw.x - cx) - h), Math.max(0, Math.abs(fw.y - cy) - h), Math.max(0, Math.abs(fw.z - cz) - h));
      const dc = Math.hypot(Math.max(0, Math.abs(cam.x - cx) - h), Math.max(0, Math.abs(cam.y - cy) - h), Math.max(0, Math.abs(cam.z - cz) - h));
      const vis = df < fade1 && this._reveal > 0.001;
      const f = clamp((lod * lod) / Math.max(dc * dc, 1e-6), this.lodMin, 1);
      for (const ob of img.objs) {
        ob.pts.visible = vis;
        ob.pts.position.copy(img.o).multiplyScalar(boxW);
        ob.geo.setDrawRange(0, Math.min(Math.ceil(N * ob.frac), Math.ceil(N * ob.frac * f) + 64));
      }
    }
  }

  /** Map display a → keyframe slots + Catmull-Rom weights; upload keyframes as needed. */
  _applyTimeline() {
    const n = this._avail || 0;
    if (!n) return;
    const uMax = n - 1;
    const u = Math.min(this._aToU(Math.max(this._a, A_START)), uMax);
    const i = Math.min(Math.floor(u), Math.max(0, uMax - 1)), t = n > 1 ? clamp(u - i, 0, 1) : 0;
    const ks = [i - 1, i, i + 1, i + 2].map((k) => clamp(k, 0, uMax));
    const t2 = t * t, t3 = t2 * t;
    const w = [-0.5 * t3 + t2 - 0.5 * t, 1.5 * t3 - 2.5 * t2 + 1, -1.5 * t3 + 2 * t2 + 0.5 * t, 0.5 * t3 - 0.5 * t2];
    const dw = [-1.5 * t2 + 2 * t - 0.5, 4.5 * t2 - 5 * t, -4.5 * t2 + 4 * t + 0.5, 1.5 * t2 - t];
    const W = [0, 0, 0, 0], DW = [0, 0, 0, 0], R = [0, 0, 0, 0];
    for (let j = 0; j < 4; j++) {
      const k = ks[j], slot = k % 4;
      if (this._slots[slot] !== k) this._upload(slot, k);
      W[slot] += w[j]; DW[slot] += dw[j];
    }
    R[ks[1] % 4] = 1;
    this.uniforms.uW.value.fromArray(W);
    this.uniforms.uDW.value.fromArray(DW);
    this.uniforms.uRef.value.fromArray(R);
    this._ks = ks; this._w = W;
  }

  _upload(slot, k) {
    const kf = this.kfs[k];
    const pa = this.posAttrs[slot], fa = this.fieldAttrs[slot];
    pa.array = kf.pos; pa.needsUpdate = true;
    fa.array = kf.fields; fa.needsUpdate = true;
    this._slots[slot] = k;
  }

  /** CPU version of the vertex-shader interpolation for one particle → box fraction (nearest image to focus). */
  particleFrac(index, out) {
    const ks = this._ks; if (!ks) return out.copy(this.focus);
    const W = this._w, i3 = index * 3;
    const ref = this.kfs[ks[1]].pos;
    const v = [0, 0, 0];
    for (let slot = 0; slot < 4; slot++) {
      if (!W[slot]) continue;
      const p = this.kfs[this._slots[slot]].pos;
      for (let c = 0; c < 3; c++) {
        const r = ref[i3 + c] / 65535;
        let d = p[i3 + c] / 65535 - r; d -= Math.floor(d + 0.5);
        v[c] += (r + d) * W[slot];
      }
    }
    return out.set(nearest(v[0], this.focus.x), nearest(v[1], this.focus.y), nearest(v[2], this.focus.z));
  }

  _updateHaloPositions() {
    if (!this.haloes.length) return;
    const boxW = BOX * this._expScale(), cam = this.camera.position;
    for (const h of this.haloes) {
      if (h.particle >= 0 && this._ks) this.particleFrac(h.particle, _v3);
      else _v3.set(nearest(h.frac.x, this.focus.x), nearest(h.frac.y, this.focus.y), nearest(h.frac.z, this.focus.z));
      h.central.set((_v3.x - 0.5) * boxW, (_v3.y - 0.5) * boxW, (_v3.z - 0.5) * boxW);
      // the periodic image of this halo nearest to the camera (what the player sees and picks)
      h.position.set(
        h.central.x + Math.round((cam.x - h.central.x) / boxW) * boxW,
        h.central.y + Math.round((cam.y - h.central.y) / boxW) * boxW,
        h.central.z + Math.round((cam.z - h.central.z) / boxW) * boxW);
    }
    if (this.home) this.homePosition.copy(this.home.central);
  }

  /** screen-space projection of a halo; null when behind the camera, off-screen or too far */
  _screen(h, out) {
    const size = this.ctx.engine.size;
    const d = h.position.distanceTo(this.camera.position);
    if (d > BOX * this._expScale() * 1.25) return null;
    _v.copy(h.position).project(this.camera);
    if (!Number.isFinite(_v.x) || !Number.isFinite(_v.y) || _v.z >= 1 || _v.z <= -1 || Math.abs(_v.x) > 0.98 || Math.abs(_v.y) > 0.96) return null;
    out.x = (_v.x * 0.5 + 0.5) * size.width; out.y = (-_v.y * 0.5 + 0.5) * size.height; out.d = d;
    return out;
  }

  _pick(px, py, radius) {
    let best = null, bestS = Infinity;
    const o = {};
    for (const h of this.haloes) {
      if (!this._screen(h, o)) continue;
      const r = Math.hypot(o.x - px, o.y - py);
      if (r > radius) continue;
      const score = r + o.d * 0.08 - Math.log10(h.mass) * 2;
      if (score < bestS) { bestS = score; best = h; }
    }
    return best;
  }

  _onTap(p) {
    if (this.cinematic || this._dive || this._a < 0.3 || !this.haloes.length) return;
    const touch = this.ctx.input.isTouch;
    const h = this._pick(p.x, p.y, touch ? 46 : 30);
    if (!h) { if (touch) this._hover = null; return; }
    if (touch && this._hover !== h) { this._hover = h; this._hoverHold = 6; return; } // first tap: show
    this._diveInto(h);
  }

  _diveInto(h) {
    if (this._dive || this.ctx.scales.busy) return;
    const o = {};
    const scr = this._screen(h, o);
    const size = this.ctx.engine.size;
    const center = scr ? [o.x / size.width, 1 - o.y / size.height] : [0.5, 0.5];
    this._dive = { halo: h, from: this.camera.position.clone(), target: h.position.clone(), look: this.rig.target.clone() };
    this.ctx.ui.removeLabel?.('cosmic-hover');
    this.ctx.ui.prompt?.(null);
    this.ctx.state.location = { galaxy: h.id };
    this.ctx.scales.go('galaxy', { galaxy: h.id }, { style: 'warp', center }).then((ok) => { if (!ok) this._dive = null; });
  }

  onTransition(phase, k) {
    if (phase === 'out' && this._dive) {
      const d = this._dive, e = easeIn(k);
      this.camera.position.lerpVectors(d.from, d.target, e * 0.97);
      _v.lerpVectors(d.look, d.target, Math.min(1, k * 2.5));
      this.camera.lookAt(_v);
    }
    if (phase === 'in' && k >= 1) this._dive = null;
  }

  _updateLabels(dt) {
    const { ui, input } = this.ctx;
    const o = {};
    const show = !this.cinematic && !this._dive && this._reveal > 0.5 && this._a > 0.3 && this.haloes.length;
    // home marker
    if (show && this.home && this._screen(this.home, o)) {
      ui.label('cosmic-home', { x: o.x, y: o.y, text: 'Halcyon', sub: 'home', visible: this._hover !== this.home, kind: 'faint', priority: 1 });
    } else ui.removeLabel?.('cosmic-home');
    if (!show) { ui.removeLabel?.('cosmic-hover'); if (this._prompted) { ui.prompt?.(null); this._prompted = false; } return; }
    // hover (desktop) / tapped (touch)
    if (!input.isTouch) {
      const p = input.pointer;
      this._hover = p.over && !p.down ? this._pick(p.x, p.y, 30) : null;
    } else if (this._hover) {
      this._hoverHold -= dt; if (this._hoverHold <= 0) this._hover = null;
    }
    const h = this._hover && this._screen(this._hover, o) ? this._hover : null;
    if (h) {
      ui.label('cosmic-hover', { x: o.x, y: o.y, text: h.name, sub: h.sub, visible: true, kind: h.home ? 'target' : '', priority: 5 });
      if (this._prompted !== h) { ui.prompt?.({ key: 'E', text: `Enter ${h.name}`, action: 'interact' }); this._prompted = h; }
    } else {
      ui.removeLabel?.('cosmic-hover');
      if (this._prompted) { ui.prompt?.(null); this._prompted = false; }
    }
    if (input.hit('interact')) {
      const size = this.ctx.engine.size;
      const t = h || this._pick(size.width / 2, size.height / 2, 90);
      if (t) this._diveInto(t);
    }
  }

  dispose() {
    this.worker?.terminate();
    this.scrubber?.dispose();
    for (const img of this.images) for (const ob of img.objs) ob.geo.dispose();
    this.geometry?.dispose();
    super.dispose();
  }
}

function nearest(v, c) { return c + ((((v - c + 0.5) % 1) + 1) % 1) - 0.5; }
function sup(n) { const m = { '-': '⁻', 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' }; return String(n).split('').map((c) => m[c] || c).join(''); }
