// SONDER — entry point. Wires the engine, universe, UI, audio and the four scales together.
//
// URL parameters (all optional; handy for testing and deep links):
//   scale=cosmic|galaxy|system|planet   start directly in a scale (skips the intro)
//   galaxy=<id> star=<index> planet=<index>   address (defaults to the home system: 0 / 1 / 2)
//   intro=0            skip the cinematic intro
//   quality=low|medium|high|ultra   dpr=<cap>   msaa=<n>   dynres=0
//   mute=1   hud=0   seed=<universe seed>
// plus scale-specific debug parameters documented in each scale.
import * as THREE from 'three';
import { Engine } from './core/engine.js';
import { Universe, HOME } from './universe/universe.js';
import { UI } from './ui/ui.js';
import { AudioEngine } from './audio/audio.js';
import { runIntro } from './intro/intro.js';

const params = Object.fromEntries(new URLSearchParams(location.search));
const canvas = document.getElementById('view');

let engine;
try {
  engine = new Engine(canvas, params);
} catch (err) {
  document.body.insertAdjacentHTML('beforeend', `<div style="position:fixed;inset:0;display:grid;place-items:center;color:#9ab;font:300 14px/1.6 sans-serif;letter-spacing:.2em;text-align:center;padding:2em">SONDER NEEDS WEBGL 2<br><span style="opacity:.5">${String(err.message || err)}</span></div>`);
  throw err;
}
const ctx = engine.ctx;
ctx.universe = new Universe(params.seed || 'sonder');
ctx.ui = new UI(document.getElementById('ui'), ctx);
ctx.audio = new AudioEngine(ctx);
if (params.mute === '1') ctx.audio.setMuted(true);
if (params.hud === '0') ctx.ui.setVisible(false);
engine.input.onGesture(() => ctx.audio.unlock());

const scales = engine.scales;
scales.register('cosmic', () => import('./scales/cosmic/index.js').then((m) => m.default));
scales.register('galaxy', () => import('./scales/galaxy/index.js').then((m) => m.default));
scales.register('system', () => import('./scales/system/index.js').then((m) => m.default));
scales.register('planet', () => import('./scales/planet/index.js').then((m) => m.default));

const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const address = {
  galaxy: num(params.galaxy, HOME.galaxy),
  star: num(params.star, HOME.star),
  planet: num(params.planet, HOME.planet),
};
ctx.state.location = { ...address };

let resolveReady;
const ready = new Promise((r) => { resolveReady = r; });

// Debug / test handle (used by tools/shot.cjs and for poking around in the console).
window.SONDER = {
  THREE, engine, ctx, params, ready,
  go: (name, p, o) => scales.go(name, p, o),
  step: (frames, dt) => engine.step(frames, dt),
  get scale() { return scales.current; },
  errors: [],
};
window.addEventListener('error', (e) => window.SONDER.errors.push(String(e.message || e)));
window.addEventListener('unhandledrejection', (e) => window.SONDER.errors.push(String(e.reason?.stack || e.reason)));

async function boot() {
  engine.start();
  const startScale = params.scale || 'cosmic';
  const playIntro = !params.scale && params.intro !== '0';
  if (playIntro) { ctx.ui.setVisible(false); engine.input.enabled = false; }
  await scales.go(startScale, { ...address, intro: playIntro }, { style: 'fade', in: playIntro ? 0.01 : 1.6 });
  if (playIntro) {
    try { await runIntro(ctx); } catch (err) { console.error('[intro]', err); }
    engine.input.enabled = true;
    ctx.ui.setVisible(params.hud !== '0');
  }
  resolveReady(true);
}
boot();
