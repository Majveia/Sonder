// Procedural, TILEABLE ground detail textures (pure JS, worker-safe). No image assets exist in SONDER:
// every ground material's close-up detail is synthesised here at init, in the terrain workers.
//
// Each layer is RGBA8, size x size, and tiles seamlessly:
//   R, G  tangent-space normal x / y (128 = flat), derived from the height channel
//   B     height (0..255) — used for height-blended material transitions and parallax-free relief
//   A     albedo luminance multiplier (shader: albedo *= 0.35 + 1.3 * A, so 0.5 = unchanged)
//
// One layer per biome material (biome.js MATERIALS order): sand, grass, grassDry, forest, soil, rock, cliff, snow.
// A texture tile covers TILE metres in the shader (near scale); a second, rotated sample at ~8x covers the mid range.

const sstep = (a, b, x) => { let t = (x - a) / (b - a); t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); };
const fract = (x) => x - Math.floor(x);

function ihash(x, y, s) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(s | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const wrap = (i, p) => ((i % p) + p) % p;

/** Periodic gradient noise, period p cells, ~[-1,1]. */
function gnoise(x, y, p, s) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10), uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const g = (cx, cy, dx, dy) => { const a = ihash(wrap(cx, p), wrap(cy, p), s) * 6.283185; return Math.cos(a) * dx + Math.sin(a) * dy; };
  const n00 = g(ix, iy, fx, fy), n10 = g(ix + 1, iy, fx - 1, fy), n01 = g(ix, iy + 1, fx, fy - 1), n11 = g(ix + 1, iy + 1, fx - 1, fy - 1);
  return 1.41 * (n00 + (n10 - n00) * ux + (n01 - n00) * uy + (n00 - n10 - n01 + n11) * ux * uy);
}
/** Periodic fBm on the unit square: u,v in [0,1), base period `p` cells. */
function fbm(u, v, p, oct, s, gain = 0.5) {
  let a = 1, sum = 0, n = 0;
  for (let o = 0; o < oct; o++) { sum += a * gnoise(u * p, v * p, p, s + o * 101); n += a; a *= gain; p *= 2; }
  return sum / n;
}
/** Periodic Worley: returns [F1, F2, cellHash] for u,v in [0,1) with p cells, jitter j. */
const _wo = [0, 0, 0];
function worley(u, v, p, s, j = 0.9) {
  const x = u * p, y = v * p, ix = Math.floor(x), iy = Math.floor(y);
  let f1 = 9, f2 = 9, id = 0;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const cx = ix + dx, cy = iy + dy, wx = wrap(cx, p), wy = wrap(cy, p);
    const px = cx + 0.5 + (ihash(wx, wy, s) - 0.5) * j, py = cy + 0.5 + (ihash(wx, wy, s + 7) - 0.5) * j;
    const d = Math.hypot(px - x, py - y);
    if (d < f1) { f2 = f1; f1 = d; id = ihash(wx, wy, s + 13); } else if (d < f2) f2 = d;
  }
  _wo[0] = f1; _wo[1] = f2; _wo[2] = id; return _wo;
}

// ---- the materials ------------------------------------------------------------------------------
// Each returns [height 0..1, luma 0..1] for (u, v) in [0,1).
const KINDS = {
  sand(u, v, s) {
    // wind ripples: asymmetric (gentle stoss, steep lee), bent by a lazy warp; plus grain speckle
    const warp = fbm(u, v, 3, 3, s) * 0.09 + fbm(u, v, 7, 2, s + 9) * 0.02;
    const ph = fract((v + warp) * 26 + u * 2);
    const rip = ph < 0.72 ? sstep(0, 0.72, ph) : 1 - sstep(0.72, 1, ph);
    const fade = 0.55 + 0.45 * sstep(-0.4, 0.5, fbm(u, v, 4, 2, s + 3));
    const grain = ihash((u * 1024) | 0, (v * 1024) | 0, s) - 0.5;
    const h = rip * 0.55 * fade + fbm(u, v, 16, 3, s + 5) * 0.12 + 0.3;
    const l = 0.5 + (rip - 0.5) * 0.08 * fade + grain * 0.14 + fbm(u, v, 8, 3, s + 11) * 0.08;
    return [h, l];
  },
  grass(u, v, s) {
    // clumps (Worley) of blades seen from above: streaky high-frequency detail, dark soil gaps
    const w = worley(u, v, 22, s, 1.0); const clump = 1 - sstep(0.0, 0.75, w[0]);
    const id = w[2];
    const blades = gnoise(u * 180 + v * 30, v * 60, 180, s + 2) * 0.6 + gnoise(u * 90, v * 240 + u * 40, 240, s + 4) * 0.4;
    const gap = sstep(0.55, 0.95, w[0] + fbm(u, v, 12, 2, s + 6) * 0.25);
    const h = clump * 0.6 + blades * 0.18 + 0.25 - gap * 0.2;
    const l = 0.52 + blades * 0.16 + (id - 0.5) * 0.18 + clump * 0.08 - gap * 0.22 + fbm(u, v, 5, 3, s + 8) * 0.08;
    return [h, l];
  },
  grassDry(u, v, s) {
    const w = worley(u, v, 16, s, 1.0); const clump = 1 - sstep(0.0, 0.8, w[0]);
    const straw = gnoise(u * 220, v * 50 + u * 12, 220, s + 3) * 0.7 + gnoise(u * 60 + v * 140, v * 140, 140, s + 1) * 0.3;
    const bare = sstep(0.1, 0.5, fbm(u, v, 6, 3, s + 5));
    const h = clump * 0.5 + straw * 0.15 + 0.3 - bare * 0.15;
    const l = 0.52 + straw * 0.2 + (w[2] - 0.5) * 0.16 - bare * 0.12 + clump * 0.06;
    return [h, l];
  },
  forest(u, v, s) {
    // leaf litter: overlapping leaves (two Worley layers), twigs, dark humus between
    const a = worley(u, v, 34, s, 1.0), f1 = a[0], id1 = a[2];
    const leafA = 1 - sstep(0.15, 0.5, f1 * (1 + 0.6 * Math.abs(gnoise(u * 34, v * 34, 34, s + 1))));
    const b = worley(u + 0.37, v + 0.11, 21, s + 20, 1.0), leafB = 1 - sstep(0.2, 0.55, b[0]);
    const twig = sstep(0.93, 0.99, 1 - Math.abs(gnoise(u * 40, v * 9, 40, s + 3))) * sstep(0.1, 0.4, gnoise(u * 12, v * 12, 12, s + 4));
    const h = 0.25 + leafA * 0.35 + leafB * 0.25 + twig * 0.3 + fbm(u, v, 8, 3, s + 5) * 0.1;
    const l = 0.42 + leafA * (id1 - 0.3) * 0.35 + leafB * (b[2] - 0.5) * 0.25 + twig * 0.15 + fbm(u, v, 6, 2, s + 6) * 0.08;
    return [h, l];
  },
  soil(u, v, s) {
    // dirt: clods, small pebbles, drying cracks
    const c = worley(u, v, 9, s, 0.95), crack = sstep(0.06, 0.0, c[1] - c[0]);
    const p = worley(u, v, 48, s + 3, 1.0), peb = (1 - sstep(0.18, 0.36, p[0])) * (p[2] > 0.72 ? 1 : 0);
    const n = fbm(u, v, 10, 4, s + 5);
    const h = 0.45 + n * 0.22 - crack * 0.25 + peb * 0.35;
    const l = 0.5 + n * 0.1 - crack * 0.18 + peb * (p[2] - 0.6) * 0.9;
    return [h, l];
  },
  rock(u, v, s) {
    // rough rock: fractured plates with sharp crack network and lichen-ish speckle
    const w = worley(u, v, 6, s, 0.95), edge = w[1] - w[0], pid = w[2];
    const crack = sstep(0.07, 0.0, edge) + 0.5 * sstep(0.03, 0.0, worley(u, v, 17, s + 9, 0.9)[1] - _wo[0]);
    const plate = (pid - 0.5) * 0.2;
    const n = fbm(u, v, 8, 5, s + 2, 0.55);
    const h = 0.55 + n * 0.3 + plate - crack * 0.3;
    const speck = ihash((u * 512) | 0, (v * 512) | 0, s + 1);
    const l = 0.5 + n * 0.14 + plate * 0.6 - crack * 0.22 + (speck > 0.985 ? 0.12 : 0) + fbm(u, v, 3, 2, s + 4) * 0.08;
    return [h, l];
  },
  cliff(u, v, s) {
    // big angular blocks with flat facets (Worley distance ridges), deep joints
    const w = worley(u, v, 4, s, 0.9), edge = w[1] - w[0];
    const facet = (w[2] - 0.5) * 0.35 + w[0] * 0.25;
    const joint = sstep(0.09, 0.0, edge);
    const n = fbm(u, v, 12, 4, s + 6, 0.5);
    const h = 0.5 + facet + n * 0.16 - joint * 0.35;
    const l = 0.5 + facet * 0.35 + n * 0.1 - joint * 0.25 + fbm(u, v, 2, 2, s + 1) * 0.1;
    return [h, l];
  },
  snow(u, v, s) {
    // soft wind-sculpted surface (sastrugi) + glittering grain
    const warp = fbm(u, v, 3, 2, s) * 0.12;
    const sas = Math.sin((v + warp) * 6.283185 * 9 + fbm(u, v, 5, 2, s + 2) * 2.5) * 0.5 + 0.5;
    const n = fbm(u, v, 6, 4, s + 3);
    const h = 0.45 + sas * 0.12 + n * 0.2;
    const l = 0.55 + n * 0.04 + (ihash((u * 1024) | 0, (v * 1024) | 0, s) > 0.992 ? 0.2 : 0);
    return [h, l];
  },
};
export const LAYER_KINDS = Object.keys(KINDS);
// normal-map strength per kind (bigger = deeper relief)
const STRENGTH = { sand: 2.2, grass: 3.0, grassDry: 2.6, forest: 3.2, soil: 2.6, rock: 4.0, cliff: 4.5, snow: 1.4 };

/** Synthesise one RGBA8 layer. */
export function synthLayer(kind, size, seed, opts = {}) {
  const f = KINDS[kind] || KINDS.rock;
  const H = new Float32Array(size * size), L = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const r = f(x / size, y / size, seed);
    H[y * size + x] = r[0]; L[y * size + x] = r[1];
  }
  const out = new Uint8Array(size * size * 4);
  const k = (opts.strength ?? STRENGTH[kind] ?? 2.5) * size / 512;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const xl = (x - 1 + size) % size, xr = (x + 1) % size, yd = (y - 1 + size) % size, yu = (y + 1) % size;
    const dx = (H[y * size + xr] - H[y * size + xl]) * k, dy = (H[yu * size + x] - H[yd * size + x]) * k;
    const il = 1 / Math.sqrt(dx * dx + dy * dy + 1);
    const i = (y * size + x) * 4;
    out[i] = Math.round((-dx * il * 0.5 + 0.5) * 255);
    out[i + 1] = Math.round((-dy * il * 0.5 + 0.5) * 255);
    const h = H[y * size + x], l = L[y * size + x];
    out[i + 2] = Math.round((h < 0 ? 0 : h > 1 ? 1 : h) * 255);
    out[i + 3] = Math.round((l < 0 ? 0 : l > 1 ? 1 : l) * 255);
  }
  return out;
}
