// Deterministic hashing + PRNG. Pure JS (safe to import from workers).

export function hash32(a) {
  a = a | 0;
  a = Math.imul(a ^ (a >>> 16), 0x85ebca6b);
  a = Math.imul(a ^ (a >>> 13), 0xc2b2ae35);
  return (a ^ (a >>> 16)) >>> 0;
}

export function hashStr(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return hash32(h);
}

/** Combine any number of ints / strings into one 32-bit seed. */
export function seedFrom(...parts) {
  let h = 0x9e3779b9;
  for (const p of parts) {
    const v = typeof p === 'string' ? hashStr(p) : (Math.floor(p) | 0);
    h = hash32(h ^ (v + 0x9e3779b9 + (h << 6) + (h >>> 2)));
  }
  return h >>> 0;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class RNG {
  constructor(...seedParts) {
    this.seed = seedFrom(...seedParts);
    this._f = mulberry32(this.seed);
    this._spare = null;
  }
  /** [0,1) */
  next() { return this._f(); }
  /** [a,b) */
  float(a = 0, b = 1) { return a + (b - a) * this._f(); }
  /** integer in [a,b] inclusive */
  int(a, b) { return a + Math.floor(this._f() * (b - a + 1)); }
  chance(p) { return this._f() < p; }
  pick(arr) { return arr[Math.floor(this._f() * arr.length)]; }
  /** weighted pick: items [[value, weight], ...] */
  weighted(items) {
    let total = 0;
    for (const it of items) total += it[1];
    let r = this._f() * total;
    for (const it of items) { r -= it[1]; if (r <= 0) return it[0]; }
    return items[items.length - 1][0];
  }
  /** standard normal */
  gauss() {
    if (this._spare !== null) { const s = this._spare; this._spare = null; return s; }
    let u, v, s;
    do { u = this._f() * 2 - 1; v = this._f() * 2 - 1; s = u * u + v * v; } while (s >= 1 || s === 0);
    const m = Math.sqrt(-2 * Math.log(s) / s);
    this._spare = v * m;
    return u * m;
  }
  /** uniform direction on the unit sphere -> [x,y,z] */
  dir() {
    const z = this._f() * 2 - 1, a = this._f() * Math.PI * 2, r = Math.sqrt(1 - z * z);
    return [r * Math.cos(a), z, r * Math.sin(a)];
  }
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this._f() * (i + 1));
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }
  /** independent child stream */
  fork(...label) { return new RNG(this.seed, ...label); }
}

export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const lerp = (a, b, t) => a + (b - a) * t;
export const saturate = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const smoothstep = (a, b, x) => { const t = saturate((x - a) / (b - a)); return t * t * (3 - 2 * t); };
export const remap = (x, a, b, c, d) => c + (d - c) * saturate((x - a) / (b - a));
/** frame-rate independent exponential damping factor */
export const damp = (rate, dt) => 1 - Math.exp(-rate * dt);
