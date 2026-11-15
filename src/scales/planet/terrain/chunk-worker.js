// Terrain worker (module worker): builds chunk meshes and detail textures off the main thread.
//   { type: 'init', desc }                         -> builds the PlanetModel once
//   { type: 'chunk', id, job }                     -> { type: 'chunk', id, ms, ...buildChunk() }   (buffers transferred)
//   { type: 'tex', id, layer, size, seed, kind }   -> { type: 'tex', id, layer, pixels }          (RGBA8)
import { PlanetModel } from '../../../universe/planet-model.js';
import { buildChunk } from './chunk-build.js';
import { biomeConfig } from './biome.js';
import { synthLayer } from './textures.js';

let model = null, cfg = null;

self.onmessage = (e) => {
  const m = e.data;
  try {
    if (m.type === 'init') {
      model = new PlanetModel(m.desc);
      cfg = biomeConfig(m.desc);
      self.postMessage({ type: 'init' });
    } else if (m.type === 'chunk') {
      const t0 = performance.now();
      const r = buildChunk(model, m.job, cfg);
      r.type = 'chunk'; r.id = m.id; r.ms = performance.now() - t0;
      self.postMessage(r, [r.position.buffer, r.normal.buffer, r.w0.buffer, r.w1.buffer, r.data.buffer]);
    } else if (m.type === 'tex') {
      const t0 = performance.now();
      const pixels = synthLayer(m.kind, m.size, m.seed, m.opts || {});
      self.postMessage({ type: 'tex', id: m.id, layer: m.layer, pixels, ms: performance.now() - t0 }, [pixels.buffer]);
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: m.id, message: String(err && err.stack || err) });
  }
};
