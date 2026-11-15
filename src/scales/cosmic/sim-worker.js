// Module worker: runs the PM simulation (pm.js) and streams keyframes to the main thread.
//
// in : { cmd: 'start', np, mesh, icMesh, boxMpc, cosmo, seed, ampBoost, aStart, every }
// out: { type: 'meta', N, np, mesh, keyA: [a...] }
//      { type: 'kf', index, a, pos: Uint16Array(N*3), fields: Uint8Array(N) (5 bit density | 3 bit heat) }   (transferred)
//      { type: 'progress', a, k }
//      { type: 'haloes', haloes: [{ pos:[x,y,z] (fraction of box), mass, massSun, elong, particle }] }
//      { type: 'done', ms, stats }
import { PMSim, makeSchedule } from './pm.js';

let running = false;

self.onmessage = (e) => {
  const m = e.data;
  if (m.cmd === 'start' && !running) { running = true; run(m).catch((err) => self.postMessage({ type: 'error', message: String(err?.stack || err) })); }
};

async function run(o) {
  const t0 = performance.now();
  const sim = new PMSim({
    np: o.np, mesh: o.mesh, icMesh: o.icMesh || 64, boxMpc: o.boxMpc, cosmo: o.cosmo,
    seed: o.seed, aStart: o.aStart || 0.02, ampBoost: o.ampBoost || 1,
  });
  const sched = makeSchedule(sim.aStart, 1, o.dlog || 0.06, o.daMax || 0.02);
  const every = o.every || 3;
  // keyframes: step indices 0, every, 2*every, … and always the last step
  const kIdx = [];
  for (let i = 0; i < sched.length; i += every) kIdx.push(i);
  if (kIdx[kIdx.length - 1] !== sched.length - 1) kIdx.push(sched.length - 1);
  const keyA = kIdx.map((i) => sched[i]);
  const nd = Math.min(128, Math.max(32, Math.round(o.np * 1.6)));
  const nh = Math.max(16, Math.round(o.np * 0.8));
  self.postMessage({ type: 'meta', N: sim.N, np: sim.np, mesh: sim.M, keyA, steps: sched.length - 1, order: null });

  sim.initialConditions();
  const D0 = sim.cosmo.D(sim.aStart);
  const rms0 = sim.rmsDelta();
  const stats = { rms: [[sim.aStart, rms0, 1]] };
  let kf = 0;
  const emit = () => {
    const pos = sim.packPositions(new Uint16Array(sim.N * 3));
    const fields = sim.packFields(new Uint8Array(sim.N), nd, nh);
    self.postMessage({ type: 'kf', index: kf, a: sim.a, pos, fields }, [pos.buffer, fields.buffer]);
    kf++;
  };
  emit();
  for (let i = 1; i < sched.length; i++) {
    sim.step(sched[i]);
    if (kIdx[kf] === i) {
      emit();
      if (kf % 6 === 0) { const r = sim.rmsDelta(); stats.rms.push([sim.a, r, (r / sim.cosmo.D(sim.a)) / (rms0 / D0)]); }
    }
    self.postMessage({ type: 'progress', a: sim.a, k: i / (sched.length - 1) });
    // yield so the worker can receive messages (and to be polite to a shared CPU)
    if (i % 4 === 0) await new Promise((r) => setTimeout(r, 0));
  }
  const mom = sim.totalMomentum();
  stats.momentum = Math.hypot(...mom.sum) / (sim.N * mom.rms);
  const haloes = sim.findHaloes(o.haloCount || 260, 1.2, 1.0).map((h) => ({
    pos: h.pos.map((v) => v / sim.M), mass: h.mass, massSun: h.massSun, elong: h.elong, peak: h.peak, particle: h.particle,
  }));
  self.postMessage({ type: 'haloes', haloes });
  self.postMessage({ type: 'done', ms: performance.now() - t0, stats });
}
