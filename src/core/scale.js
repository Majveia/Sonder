// Scale = one self-contained "level of the universe" (cosmic web, galaxy, star system, planet).
// Each scale owns its scene, camera, units and controls. The ScaleManager swaps between them
// behind a hyperspace warp so the journey feels continuous.
import * as THREE from 'three';

export class Scale {
  /** Keep the instance alive between visits (init() runs once). */
  static persistent = false;

  /** @param {object} ctx shared context: { engine, renderer, post, input, audio, ui, universe, quality, scales, state, params } */
  constructor(ctx) {
    this.ctx = ctx;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.1, 1e6);
    /** Look overrides for this scale; see DEFAULT_GRADE in core/post.js */
    this.grade = {};
  }
  /** Build everything. May be async (workers, generation). The screen is covered while this runs. */
  async init(params) {}
  /** Called when the scale becomes the active one (after init). Set input scheme, UI, music here. */
  enter(params, fromName) {}
  /** Called when leaving. Remove UI, listeners. */
  exit() {}
  /** Per-frame simulation. dt in seconds (clamped), time = seconds since app start. */
  update(dt, time) {}
  /** Optional transition hook. phase: 'out' | 'in', k: 0..1 progress. Use it to rush the camera. */
  onTransition(phase, k) {}
  resize(width, height) {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }
  // Optional: custom multi-pass rendering. Must leave its result in `target` (linear HDR).
  // render(renderer, target, dt) {}
  dispose() {
    this.scene.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          for (const k in m) { const v = m[k]; if (v && v.isTexture) v.dispose(); }
          if (m.uniforms) for (const k in m.uniforms) { const v = m.uniforms[k]?.value; if (v && v.isTexture) v.dispose(); }
          m.dispose();
        }
      }
    });
  }
}

const easeIn = (k) => k * k * k;
const easeOut = (k) => 1 - Math.pow(1 - k, 3);
const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export class ScaleManager {
  constructor(ctx) {
    this.ctx = ctx;
    this.registry = new Map();   // name -> async loader returning the Scale class
    this.instances = new Map();  // persistent instances
    this.current = null;
    this.currentName = null;
    this.tr = null;              // active transition
    this.listeners = new Set();
  }
  register(name, loader) { this.registry.set(name, loader); }
  get busy() { return !!this.tr; }
  onChange(cb) { this.listeners.add(cb); return () => this.listeners.delete(cb); }

  /**
   * Travel to another scale.
   * @param {string} name registered scale name
   * @param {object} params passed to init()/enter()
   * @param {object} opts { style: 'warp' | 'fade' | 'flash' | 'cut', out: seconds, in: seconds, center: [u,v] }
   * @returns {Promise<boolean>} resolves when the new scale is fully in
   */
  go(name, params = {}, opts = {}) {
    if (this.tr) return Promise.resolve(false);
    if (!this.registry.has(name)) { console.error(`[scales] unknown scale "${name}"`); return Promise.resolve(false); }
    const style = opts.style ?? (this.current ? 'warp' : 'fade');
    const tr = {
      name, params, style,
      outDur: this.current && style !== 'cut' ? (opts.out ?? 1.25) : 0,
      inDur: style === 'cut' ? 0 : (opts.in ?? 1.5),
      phase: 'out', t: 0, hold: 0, next: null, ready: false, failed: null, fromBlack: !this.current,
    };
    if (opts.center) this.ctx.post.warpCenter.set(opts.center[0], opts.center[1]); else this.ctx.post.warpCenter.set(0.5, 0.5);
    this.tr = tr;
    const done = new Promise((res) => { tr.resolve = res; });
    this._prepare(tr);
    this.ctx.audio?.sfx?.(style === 'warp' ? 'warp' : 'transition');
    return done;
  }

  async _prepare(tr) {
    try {
      let inst = this.instances.get(tr.name);
      if (!inst) {
        const Cls = await this.registry.get(tr.name)();
        inst = new Cls(this.ctx);
        inst.name = tr.name;
        await inst.init(tr.params);
        if (Cls.persistent) this.instances.set(tr.name, inst);
      }
      tr.next = inst; tr.ready = true;
    } catch (err) {
      console.error(`[scales] failed to load "${tr.name}"`, err);
      tr.failed = err; tr.ready = true;
    }
  }

  _swap(tr) {
    const { ctx } = this;
    const prev = this.current, prevName = this.currentName;
    if (tr.failed || !tr.next) { return; }
    if (prev) {
      try { prev.exit(); } catch (e) { console.error(e); }
      if (!prev.constructor.persistent) { try { prev.dispose(); } catch (e) { console.error(e); } }
    }
    this.current = tr.next; this.currentName = tr.name;
    ctx.ui?.clearContext?.();
    const size = ctx.engine.size;
    this.current.resize(size.width, size.height);
    this.current.enter(tr.params, prevName);
    ctx.post.setGrade(this.current.grade, true);
    for (const cb of this.listeners) cb(tr.name, prevName, tr.params);
  }

  update(dt, time) {
    const post = this.ctx.post;
    const tr = this.tr;
    if (tr) {
      tr.t += dt;
      if (tr.phase === 'out') {
        const k = tr.outDur > 0 ? Math.min(1, tr.t / tr.outDur) : 1;
        this.current?.onTransition('out', k);
        if (tr.style === 'warp') { post.warp = easeIn(k); post.flash = sstep(0.62, 1, k); }
        else if (tr.style === 'flash') { post.flash = k; }
        else if (tr.style === 'fade') { post.fade = Math.max(post.fade, sstep(0, 1, k)); }
        if (k >= 1) { tr.phase = 'hold'; tr.t = 0; }
      }
      if (tr.phase === 'hold') {
        // If the next scale is still building, sink from white into black and wait there.
        if (!tr.ready) {
          tr.hold += dt;
          post.fade = Math.max(post.fade, Math.min(1, tr.hold / 0.3));
          if (post.fade >= 1) { post.flash = 0; post.warp = 0; tr.fromBlack = true; }
        } else {
          if (tr.style === 'fade' || tr.style === 'cut' || post.fade >= 1) tr.fromBlack = tr.style !== 'cut';
          this._swap(tr);
          if (tr.failed) { post.warp = 0; post.flash = 0; post.fade = 0; this.tr = null; tr.resolve(false); return; }
          tr.phase = 'in'; tr.t = 0;
          if (tr.fromBlack) { post.fade = 1; post.flash = 0; post.warp = tr.style === 'warp' ? 1 : 0; }
        }
      }
      if (tr.phase === 'in') {
        const k = tr.inDur > 0 ? Math.min(1, tr.t / tr.inDur) : 1;
        this.current?.onTransition('in', k);
        if (tr.style === 'warp') post.warp = 1 - easeOut(Math.min(1, k * 1.15));
        if (tr.fromBlack) post.fade = 1 - sstep(0, tr.style === 'warp' ? 0.45 : 1, k);
        else post.flash = 1 - sstep(0, 0.5, k);
        if (k >= 1) {
          post.warp = 0; post.flash = 0; post.fade = 0;
          this.tr = null;
          tr.resolve(true);
        }
      }
    }
    if (this.current) this.current.update(dt, time);
  }
}
