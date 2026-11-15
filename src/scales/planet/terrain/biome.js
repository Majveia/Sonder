// Biome rules for planet ground cover — ONE table shared by the terrain worker (which bakes the weights
// into every chunk vertex, so the shader paints exactly these numbers) and by gameplay/placement code
// (flora, fauna, civ) via biomeAt(). Pure JS, no three.js, worker-safe.
//
//   import { biomeAt, MATERIALS } from '../terrain/biome.js';
//   const b = biomeAt(planet.model, dx, dy, dz);           // unit direction
//   b.weights.forest > 0.5  -> the ground there is painted as forest floor: put trees on it
//   b.weights.cliff  > 0.3  -> nothing grows / stands here
//   { height, slope, temp, moist, shore, wet, macro, weights: { sand, grass, grassDry, forest, soil, rock, cliff, snow } }
//
// Materials (index = texture layer = slot in the per-vertex weight attributes aW0/aW1):
//   0 sand  1 grass  2 grassDry  3 forest  4 soil  5 rock  6 cliff  7 snow
// Colours come from desc.palette under the same names (soil -> palette.soil, ...).
//
// The shader (terrain/material.js) does NOT re-derive these rules: it receives the weights as vertex
// attributes and only sharpens the transitions with the detail textures' height channel (grass creeping
// into rock cracks, sand pooling in hollows). So biomeAt() and the painted ground always agree.

export const MATERIALS = ['sand', 'grass', 'grassDry', 'forest', 'soil', 'rock', 'cliff', 'snow'];
export const M = { sand: 0, grass: 1, grassDry: 2, forest: 3, soil: 4, rock: 5, cliff: 6, snow: 7 };

/** Biome slope is measured over SLOPE_SPAN metres on the terrain without octaves shorter than SLOPE_WL
 *  metres, so ground cover does not flicker with 1-m bumps and is identical at every mesh LOD finer than that. */
export const SLOPE_SPAN = 4, SLOPE_WL = 8;

const ss = (a, b, x) => { let t = (x - a) / (b - a); t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); };
const sat = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Per-world rule parameters, derived from the planet descriptor. */
export function biomeConfig(desc) {
  const type = desc.type || 'terran';
  const flora = desc.life ? desc.life.flora ?? 0 : 0;
  const cfg = {
    type,
    hasOcean: !!desc.ocean,
    lavaSea: !!(desc.ocean && desc.ocean.kind === 'lava'),
    veg: sat(flora * 1.25),              // how much of the flat, moist land carries vegetation
    snowT: 0.2,                           // temperature below which snow lies
    treeT: 0.33,                          // temperature below which forest gives way to alpine grass / rock
    beach: 2.6,                           // metres above sea level that stay sand
    bare: M.soil,                         // what un-vegetated flat ground is
    bareAlt: M.sand,                      // patchy alternative for bare ground
    cliffSlope: 0.66,                     // sin(slope) where faces become cliff
    rockSlope: 0.36,                      // sin(slope) where scree / bare rock starts
  };
  if (type === 'desert') { cfg.bare = M.sand; cfg.bareAlt = M.soil; cfg.snowT = 0.05; cfg.cliffSlope = 0.6; cfg.rockSlope = 0.32; }
  else if (type === 'ice') { cfg.snowT = 0.3; cfg.bare = M.snow; cfg.bareAlt = M.sand; }
  else if (type === 'lava') { cfg.snowT = -1; cfg.bare = M.soil; cfg.bareAlt = M.rock; cfg.beach = 0.8; }
  else if (type === 'barren') { cfg.snowT = -1; cfg.bare = M.sand; cfg.bareAlt = M.soil; }
  else if (type === 'crystal') { cfg.snowT = 0.12; cfg.bare = M.sand; cfg.bareAlt = M.soil; }
  else if (type === 'ocean') { cfg.beach = 3.4; }
  return cfg;
}

/** Large-scale boundary jitter in ~[-1,1] (so biome edges meander instead of following contour lines). */
export function jitterAt(model, x, y, z) {
  return model.nD(x * 37 + 3.7, y * 37 - 1.3, z * 37 + 8.1) * 0.55
    + model.nB(x * 151 - 6.1, y * 151 + 2.2, z * 151) * 0.3
    + model.nA(x * 610 + 1.9, y * 610, z * 610 - 4.4) * 0.15;
}

/** Two macro variation fields in ~[-1,1]: m1 ~1.2 km features, m2 ~200 m features. Used for colour. */
export function macroAt(model, x, y, z, out) {
  out[0] = model.nC(x * 7.3 + 5.5, y * 7.3 - 2.1, z * 7.3 + 9.9) * 0.7 + model.nA(x * 19 - 3, y * 19 + 7, z * 19) * 0.3;
  out[1] = model.nB(x * 44 - 3.3, y * 44 + 6.6, z * 44 + 1.1) * 0.65 + model.nD(x * 120 + 2, y * 120, z * 120 - 9) * 0.35;
  return out;
}

function over(w, k, a) {
  if (a <= 0) return;
  if (a > 1) a = 1;
  const r = 1 - a;
  for (let i = 0; i < 8; i++) w[i] *= r;
  w[k] += a;
}

/**
 * The rules. Inputs: height (m, sea level 0), slope (sin of the angle, 0 flat .. 1 vertical),
 * temp / moist in [0,1] (PlanetModel.climate), jitter j in ~[-1,1]. Writes 8 weights summing to 1 into w.
 */
export function biomeWeights(cfg, h, slope, temp, moist, j, w) {
  for (let i = 0; i < 8; i++) w[i] = 0;
  // ---- flat land: bare ground under a vegetation layer driven by moisture and warmth
  w[cfg.bare] = 1;
  over(w, cfg.bareAlt, ss(0.15, 0.55, j) * 0.85);
  const vegAmt = cfg.veg * ss(0.1, 0.32, moist + j * 0.06) * (1 - ss(0.93, 1.0, temp));
  if (vegAmt > 0) {
    const forest = ss(0.55, 0.68, moist + j * 0.09) * ss(cfg.treeT - 0.02, cfg.treeT + 0.1, temp) * (1 - ss(0.86, 0.96, temp));
    const dry = Math.max(ss(0.44, 0.3, moist + j * 0.07), ss(0.8, 0.92, temp + j * 0.03));
    // composite inside the vegetation layer: grass, then dry grass, then forest canopy floor
    const g = 1 - dry, d = dry * (1 - forest), f = forest;
    const s = g * (1 - forest) + d + f || 1;
    const veg = vegAmt;
    for (let i = 0; i < 8; i++) w[i] *= 1 - veg;
    w[1] += veg * (g * (1 - forest)) / s;
    w[2] += veg * d / s;
    w[3] += veg * f / s;
  }
  // ---- alpine: above the tree line meadows thin to scree
  over(w, 2, ss(cfg.treeT, cfg.treeT - 0.07, temp + j * 0.03) * cfg.veg * 0.7);
  over(w, 5, ss(cfg.treeT - 0.04, cfg.treeT - 0.14, temp + j * 0.04) * 0.75);
  // ---- shore: beaches, then mud on the sea floor
  if (cfg.hasOcean) {
    over(w, 0, ss(cfg.beach + 1.6 + j * 1.4, cfg.beach * 0.35, h));
    over(w, 4, ss(-3, -16, h) * 0.6);
  }
  // ---- slopes: scree / bare rock, snow (not on the steepest faces), then cliff faces
  over(w, 5, ss(cfg.rockSlope, cfg.rockSlope + 0.16, slope + j * 0.06));
  if (cfg.snowT > 0) over(w, 7, ss(cfg.snowT + 0.035, cfg.snowT - 0.035, temp + j * 0.045) * (1 - ss(0.5, 0.74, slope)));
  over(w, 6, ss(cfg.cliffSlope, cfg.cliffSlope + 0.14, slope + j * 0.04));
  return w;
}

const _w = new Float32Array(8), _m = [0, 0], _cl = { temp: 0, moist: 0 };
const _cfgCache = new WeakMap();

/**
 * Ground cover at a unit direction (x,y,z) on `model` — matches what the terrain shader paints.
 * opts.minWavelength (default 0 = full detail) for the height; slope uses SLOPE_SPAN / SLOPE_WL.
 */
export function biomeAt(model, x, y, z, out = {}, opts = {}) {
  let cfg = _cfgCache.get(model);
  if (!cfg) { cfg = biomeConfig(model.desc); _cfgCache.set(model, cfg); }
  const wl = opts.minWavelength || 0, span = SLOPE_SPAN, swl = Math.max(SLOPE_WL, wl);
  const h = model.height(x, y, z, wl);
  // slope from two tangent finite differences
  let tx = -z, tz = x; let l = Math.hypot(tx, tz);
  if (l < 1e-5) { tx = 1; tz = 0; l = 1; }
  tx /= l; tz /= l;
  const bx = y * tz, by = z * tx - x * tz, bz = -y * tx;
  const e = span / model.R;
  const h1 = hAt(model, x + tx * e, y, z + tz * e, swl), h2 = hAt(model, x + bx * e, y + by * e, z + bz * e, swl);
  const h3 = hAt(model, x - tx * e, y, z - tz * e, swl), h4 = hAt(model, x - bx * e, y - by * e, z - bz * e, swl);
  const gx = (h1 - h3) / (2 * span), gy = (h2 - h4) / (2 * span);
  const g2 = gx * gx + gy * gy;
  const slope = Math.sqrt(g2 / (1 + g2));
  model.climate(x, y, z, h, _cl);
  const j = jitterAt(model, x, y, z);
  biomeWeights(cfg, h, slope, _cl.temp, _cl.moist, j, _w);
  macroAt(model, x, y, z, _m);
  const W = out.weights || (out.weights = {});
  for (let i = 0; i < 8; i++) W[MATERIALS[i]] = _w[i];
  out.height = h; out.slope = slope; out.temp = _cl.temp; out.moist = _cl.moist;
  out.shore = cfg.hasOcean ? h : Infinity;           // metres above sea level (Infinity on dry worlds)
  out.wet = cfg.hasOcean ? wetness(h) : 0;
  out.macro = _m[0];
  let best = 0; for (let i = 1; i < 8; i++) if (_w[i] > _w[best]) best = i;
  out.dominant = MATERIALS[best];
  return out;
}

/** Shoreline wetness 0..1 from height above sea level (same curve as the shader). */
export function wetness(h) { return ss(1.6, 0.1, h); }

function hAt(model, x, y, z, wl) { const l = Math.hypot(x, y, z); return model.height(x / l, y / l, z / l, wl); }
