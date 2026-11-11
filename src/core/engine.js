// Engine: renderer, main loop, resize / dynamic resolution, scale rendering through the HDR post pipeline.
import * as THREE from 'three';
import { PostFX } from './post.js';
import { Input } from './input.js';
import { ScaleManager } from './scale.js';
import { detectQuality } from './quality.js';

export class Engine {
  constructor(canvas, params = {}) {
    this.canvas = canvas;
    this.params = params;
    this.quality = detectQuality(params);
    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: false, alpha: false, depth: false, stencil: false,
      powerPreference: 'high-performance', logarithmicDepthBuffer: true,
    });
    this.renderer.toneMapping = THREE.NoToneMapping; // tone mapping happens in PostFX
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.info.autoReset = false;
    this.post = new PostFX(this.renderer, this.quality);
    this.input = new Input(canvas);
    this.size = { width: 1, height: 1, pixelRatio: 1 };
    this.time = 0;          // seconds of engine time (affected by timeScale / pause)
    this.frame = 0;
    this.timeScale = 1;
    this.paused = false;
    this.fps = 60;
    this.updaters = new Set(); // extra per-frame callbacks: (dt, time) => void
    this._last = 0;
    this._resScale = 1;
    this._acc = 0; this._accN = 0;
    this._dynRes = params.dynres !== '0';
    /** shared context handed to every scale */
    this.ctx = {
      engine: this, renderer: this.renderer, post: this.post, input: this.input, quality: this.quality, params,
      audio: null, ui: null, universe: null, scales: null,
      state: { location: {}, discovered: {}, flags: {} },
    };
    this.scales = new ScaleManager(this.ctx);
    this.ctx.scales = this.scales;
    this.resize();
    window.addEventListener('resize', () => this.resize());
    window.addEventListener('orientationchange', () => setTimeout(() => this.resize(), 250));
    this._tick = this._tick.bind(this);
  }

  resize() {
    const w = Math.max(1, window.innerWidth), h = Math.max(1, window.innerHeight);
    const pr = Math.min(window.devicePixelRatio || 1, this.quality.dprCap) * this._resScale;
    this.size.width = w; this.size.height = h; this.size.pixelRatio = pr;
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    this.post.setSize(Math.floor(w * pr), Math.floor(h * pr));
    this.scales.current?.resize(w, h);
  }

  start() { this._last = performance.now(); requestAnimationFrame(this._tick); }

  /** Advance the simulation without rendering (tests / fast-forward). */
  step(frames = 1, dt = 1 / 30) {
    for (let i = 0; i < frames; i++) this._update(dt);
  }

  _update(dt) {
    this.time += dt;
    this.input.update(dt);
    this.scales.update(dt, this.time);
    for (const fn of this.updaters) fn(dt, this.time);
    this.ctx.ui?.update?.(dt, this.time);
    this.ctx.audio?.update?.(dt, this.time);
    this.input.endFrame();
  }

  _render(dt) {
    const r = this.renderer, scale = this.scales.current;
    r.info.reset();
    if (scale) {
      if (scale.render) {
        scale.render(r, this.post.target, dt);
      } else {
        r.setRenderTarget(this.post.target);
        r.clear();
        r.render(scale.scene, scale.camera);
      }
    } else {
      r.setRenderTarget(this.post.target);
      r.clear();
    }
    this.post.render(dt, this.time);
  }

  _tick(now) {
    requestAnimationFrame(this._tick);
    const raw = Math.min(0.25, (now - this._last) / 1000);
    this._last = now;
    this.fps += ((raw > 0 ? 1 / raw : 60) - this.fps) * 0.05;
    const dt = this.paused ? 0 : Math.min(raw, 1 / 20) * this.timeScale;
    this._update(dt);
    this._render(dt);
    this.frame++;
    // dynamic resolution: hold frame rate on weaker GPUs, restore when there is headroom
    if (this._dynRes) {
      this._acc += raw; this._accN++;
      if (this._accN >= 90) {
        const avg = this._acc / this._accN; this._acc = 0; this._accN = 0;
        let s = this._resScale;
        if (avg > 1 / 40 && s > 0.6) s = Math.max(0.6, s * 0.88);
        else if (avg < 1 / 57 && s < 1) s = Math.min(1, s * 1.06);
        if (Math.abs(s - this._resScale) > 0.02) { this._resScale = s; this.resize(); }
      }
    }
  }
}
