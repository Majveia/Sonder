// Galaxy density model — pure JS (no three), deterministic from the GalaxyDesc.
//
// One explicit model drives everything the galaxy scale draws or places: resolved stars, the
// unresolved star-glow haze, dust, HII regions, (later) the visitable-star catalogue and the local
// star field. World units: 1 unit = 1000 ly. The galaxy lies in its own XZ plane (normal +Y).
//
// Structure by type
//   spiral / barred : exponential thin + thick disc, Hernquist bulge, optional bar, logarithmic
//                     m-armed density wave broken up by spiral-aligned noise (flocculence, spurs,
//                     bifurcations), dust on the arms' inner (concave) edges, HII on the outer edges.
//   lenticular      : disc + big bulge, no arms, faint dust ring.
//   elliptical      : triaxial Hernquist (≈ de Vaucouleurs in projection), old stars, globulars.
//   irregular       : a few offset star-forming clumps + bar-ish core, lots of HII and dust patches.
//   ring            : Cartwheel-like: nucleus, inner ring, expanding outer starburst ring, spokes.
//
// Rotation: flat rotation curve ω(r) = Ωp·rCo / √(r² + rc²) (solid body inside rc). Arms, bar,
// dust and young stars are (mostly) locked to the pattern speed Ωp so arms do not wind up within a
// session; old stars shear differentially. `omega(r, lock)` mirrors the vertex shader for picking.
import { RNG, seedFrom, clamp, smoothstep, lerp } from '../../core/rng.js';
import { makeNoise3D, fbm } from '../../core/noise.js';

const TAU = Math.PI * 2;

/** Pareto-ish luminosity: most ~1, a few very bright. */
function powerLum(rng, alpha, max) { return Math.min(max, Math.pow(1 - rng.next() * 0.9999, -1 / alpha)); }

export class GalaxyModel {
  constructor(desc) {
    this.desc = desc;
    this.type = desc.type;
    const R = this.R = (desc.radiusLy || 50000) / 1000;
    const rng = this.rng = new RNG(desc.seed, 'galaxy-model');
    this.noise = makeNoise3D(seedFrom(desc.seed, 'gal-noise'));
    this.noise2 = makeNoise3D(seedFrom(desc.seed, 'gal-noise-2'));
    const t = desc.type;
    const spiralish = t === 'spiral' || t === 'barred';
    const m = spiralish ? Math.max(2, desc.arms || 2) : 0;
    const bulge = clamp(desc.bulge ?? 0.3, 0, 1);
    const hue = clamp(desc.hue ?? 0, -1, 1);
    const p = this.p = {
      spiralish, m,
      pitch: clamp(desc.pitch || 0.24, 0.12, 0.5),
      Rd: R * (t === 'lenticular' ? 0.22 : 0.28),
      hThin: R * 0.0095, hThick: R * 0.032, hYoung: R * 0.0045, hDust: R * 0.0035,
      bulgeA: R * (0.028 + 0.06 * bulge) * (t === 'lenticular' ? 1.5 : 1),
      bulgeQ: 0.62 + 0.2 * rng.next(),
      bar: t === 'barred',
      barLen: R * (0.17 + 0.12 * bulge),
      barAngle: rng.float(0, TAU),
      phase0: rng.float(0, TAU),
      // flocculence: many-armed galaxies are flocculent, grand-design 2-armed are cleaner
      floc: clamp((m >= 4 ? 0.55 : m === 3 ? 0.45 : 0.3) + rng.float(-0.1, 0.15), 0.1, 0.8),
      youth: clamp(0.55 + 0.35 * hue, 0.15, 1),
      bulgeFrac: t === 'elliptical' ? 1 : clamp(0.08 + bulge * 0.45, 0.05, 0.5) * (t === 'lenticular' ? 1.4 : 1),
      // rotation
      omegaP: TAU / (t === 'elliptical' ? 2400 : t === 'irregular' ? 1500 : 900), // pattern: one turn / 15 min
      rCo: R * 0.62, rc: R * (0.05 + 0.04 * bulge),
      // elliptical shape
      triax: [1, rng.float(0.62, 0.95), rng.float(0.5, 0.85)],
      ellA: R * rng.float(0.13, 0.2),
    };
    p.barW = p.barLen * 0.3;
    p.r0 = p.bar ? p.barLen * 0.92 : R * 0.12;
    if (p.bar) p.phase0 = p.barAngle;
    p.tanP = Math.tan(p.pitch);
    // irregular clumps
    if (t === 'irregular') {
      p.clumps = [];
      const n = rng.int(4, 7);
      for (let i = 0; i < n; i++) {
        const a = rng.float(0, TAU), d = R * Math.sqrt(rng.next()) * 0.5;
        p.clumps.push({ x: Math.cos(a) * d, z: Math.sin(a) * d, s: R * rng.float(0.06, 0.18), w: rng.float(0.4, 1) });
      }
      p.irrAngle = rng.float(0, TAU);
    }
    if (t === 'ring') {
      p.ringR = R * 0.8; p.ringW = R * 0.05; p.innerR = R * 0.2;
      p.ringOff = [R * rng.float(-0.08, 0.08), R * rng.float(-0.08, 0.08)];
      p.spokes = rng.int(9, 14);
    }
  }

  /** Angular speed (rad/s, galaxy turns toward −θ) at cylindrical radius r for a pattern lock 0..1. */
  omega(r, lock = 0) {
    const p = this.p;
    const w = p.omegaP * p.rCo / Math.sqrt(r * r + p.rc * p.rc);
    return lerp(w, p.omegaP, lock);
  }

  // -------------------------------------------------------------------------------------------
  // Fields (evaluated at t = 0; the scene rotates them)
  // -------------------------------------------------------------------------------------------
  /** Spiral arm field at (x, z) in [0, ~1.2]; `shift` moves the crest (ψ radians, + = inner edge). */
  arm(x, z, shift = 0, sharp = 6) {
    const p = this.p, R = this.R;
    if (!p.m) return 0;
    const r = Math.hypot(x, z);
    if (r < 1e-4) return 0;
    const th = Math.atan2(z, x);
    const n = this.noise;
    const s = R * 0.32;
    const wth = p.floc * 0.55 * fbm(n, x / s, 1.37, z / s, 3);
    const lr = Math.log(Math.max(r, 1e-3) / p.r0);
    const psi = p.m * (th + wth - p.phase0 - lr / p.tanP) - shift;
    let c = 0.5 + 0.5 * Math.cos(psi);
    // arms broaden outward
    const sh = sharp * lerp(1.25, 0.7, clamp(r / R, 0, 1));
    c = Math.pow(c, sh);
    // along-arm breaks / knots
    const s2 = R * 0.11;
    const mod = clamp(0.25 + 1.1 * (0.5 + 0.5 * fbm(n, x / s2, 3.71, z / s2, 3)), 0, 1.3);
    // secondary arms (odd index) of 4-armed barred spirals are weaker
    let amp = 1;
    if (p.bar && p.m >= 4) {
      const k = Math.round(((th + wth - p.phase0 - lr / p.tanP) * p.m / TAU)) ;
      amp = ((k % 2) + 2) % 2 ? 0.7 : 1;
    }
    const env = smoothstep(p.r0 * 0.7, p.r0 * 1.3, r) * (1 - smoothstep(R * 0.8, R * 1.12, r));
    return c * mod * env * amp;
  }

  /** Spiral-aligned filaments (spurs, feathers, flocculent fragments) in [0,1]. */
  floc(x, z) {
    const p = this.p, R = this.R;
    if (!p.m) return 0;
    const r = Math.hypot(x, z);
    if (r < 1e-3) return 0;
    const lr = Math.log(r / p.r0);
    const a = Math.atan2(z, x) - lr / Math.tan(p.pitch * 1.45);
    const sL = R * 0.12, sS = R * 0.035;
    const v = this.noise2(r / sL, Math.cos(a) * r / sS, Math.sin(a) * r / sS);
    const v2 = this.noise2(r / (sL * 0.5) + 9.1, Math.cos(a) * r / (sS * 0.5), Math.sin(a) * r / (sS * 0.5));
    const f = clamp(1 - Math.abs(v * 0.75 + v2 * 0.35), 0, 1);
    const env = smoothstep(p.r0 * 0.6, p.r0 * 1.5, r) * (1 - smoothstep(R * 0.75, R * 1.1, r));
    return Math.pow(f, 5) * env;
  }

  /** Bar density (old stars) at t=0, peak 1. */
  barField(x, z) {
    const p = this.p;
    if (!p.bar) return 0;
    const c = Math.cos(-p.barAngle), s = Math.sin(-p.barAngle);
    const u = x * c - z * s, v = x * s + z * c;
    const q = (u / p.barLen) ** 2 + (v / p.barW) ** 2;
    return Math.exp(-q * q * 1.6) ;
  }

  /** Disc surface density (old light), peak 1 at centre. */
  disc(r) { const R = this.R; return Math.exp(-r / this.p.Rd) * (1 - smoothstep(R * 0.85, R * 1.25, r)); }

  /** Young / star-forming field (where blue stars, HII and dust live), ≥ 0. */
  young(x, z, shift = 0) {
    const p = this.p, R = this.R, t = this.type;
    const r = Math.hypot(x, z);
    if (p.spiralish) {
      const sf = Math.exp(-r / (R * 0.45)) * (1 - smoothstep(R * 0.8, R * 1.1, r));
      let v = this.arm(x, z, shift, 6) + p.floc * 0.9 * this.floc(x, z);
      if (p.bar) {
        // nuclear star-forming ring at the inner Lindblad resonance
        const nr = p.barLen * 0.24;
        v += 0.8 * Math.exp(-(((r - nr) / (nr * 0.22)) ** 2));
      }
      return v * sf;
    }
    if (t === 'irregular') {
      let v = 0;
      for (const c of p.clumps) v += c.w * Math.exp(-((x - c.x) ** 2 + (z - c.z) ** 2) / (2 * c.s * c.s));
      const s = R * 0.08;
      v *= 0.35 + 0.9 * clamp(0.5 + 0.7 * fbm(this.noise, x / s, 2.2, z / s, 3), 0, 1.2);
      return v;
    }
    if (t === 'ring') {
      const [ox, oz] = p.ringOff;
      const rr = Math.hypot(x - ox, z - oz), a = Math.atan2(z - oz, x - ox);
      const wob = p.ringR * (1 + 0.05 * Math.sin(a * 3 + 1.3) + 0.03 * this.noise(Math.cos(a) * 2, 5.5, Math.sin(a) * 2));
      const ring = Math.exp(-(((rr - wob) / p.ringW) ** 2));
      const inner = 0.5 * Math.exp(-(((r - p.innerR) / (p.innerR * 0.25)) ** 2));
      const knots = clamp(0.4 + 0.9 * this.noise(x / (R * 0.05), 1.1, z / (R * 0.05)), 0, 1.3);
      return (ring * knots + inner);
    }
    if (t === 'lenticular') return 0;
    return 0;
  }

  // -------------------------------------------------------------------------------------------
  // Sampling helpers
  // -------------------------------------------------------------------------------------------
  _sech2(rng, h) { // vertical sech² profile: z = h · atanh(2u − 1)
    const u = clamp(rng.next(), 1e-6, 1 - 1e-6);
    return h * 0.5 * Math.log(u / (1 - u));
  }
  _discR(rng, Rd) { return -Rd * Math.log(Math.max(1e-9, rng.next() * rng.next())); }
  _hernquist(rng, a, rmax) {
    for (let i = 0; i < 8; i++) {
      const s = Math.sqrt(rng.next());
      const r = a * s / (1 - s);
      if (r < rmax) return r;
    }
    return a;
  }
  /** Old-disc position (mild arm modulation). */
  _oldDisc(rng, out, thick = false) {
    const p = this.p, R = this.R;
    for (let tries = 0; tries < 30; tries++) {
      const r = this._discR(rng, p.Rd);
      if (r > R * 1.3) continue;
      const th = rng.float(0, TAU);
      const x = r * Math.cos(th), z = r * Math.sin(th);
      const w = p.m ? 0.45 + 0.55 * Math.min(1, this.arm(x, z, 0, 2) * 1.4) : 1;
      if (rng.next() > w) continue;
      out[0] = x; out[2] = z;
      out[1] = this._sech2(rng, (thick ? p.hThick : p.hThin) * (1 + r / R));
      return out;
    }
    out[0] = 0; out[1] = 0; out[2] = 0; return out;
  }
  /** Position drawn from the young field via rejection. */
  _young(rng, out, shift = 0, power = 1, hScale = 1) {
    const p = this.p, R = this.R, t = this.type;
    const ymax = this._ymax || (this._ymax = this._estimateYoungMax());
    for (let tries = 0; tries < 200; tries++) {
      let x, z;
      if (t === 'irregular') {
        const c = p.clumps[Math.floor(rng.next() * p.clumps.length)];
        x = c.x + rng.gauss() * c.s * 1.6; z = c.z + rng.gauss() * c.s * 1.6;
      } else if (t === 'ring') {
        const r = rng.next() < 0.75 ? p.ringR * (0.8 + 0.4 * rng.next()) : p.innerR * (0.5 + rng.next());
        const a = rng.float(0, TAU);
        x = r * Math.cos(a) + (r > p.innerR * 2 ? p.ringOff[0] : 0); z = r * Math.sin(a) + (r > p.innerR * 2 ? p.ringOff[1] : 0);
      } else {
        const r = Math.sqrt(rng.next()) * R * 1.1;
        const a = rng.float(0, TAU);
        x = r * Math.cos(a); z = r * Math.sin(a);
      }
      let v = this.young(x, z, shift) / ymax;
      if (power !== 1) v = Math.pow(Math.max(0, v), power);
      if (rng.next() < v) {
        out[0] = x; out[2] = z;
        const hy = (t === 'irregular' ? R * 0.03 : p.hYoung) * hScale;
        out[1] = this._sech2(rng, hy);
        return out;
      }
    }
    return this._oldDisc(rng, out);
  }
  _estimateYoungMax() {
    const rng = new RNG(this.desc.seed, 'ymax');
    let mx = 1e-6;
    for (let i = 0; i < 4000; i++) {
      const r = Math.sqrt(rng.next()) * this.R * 1.1, a = rng.float(0, TAU);
      mx = Math.max(mx, this.young(r * Math.cos(a), r * Math.sin(a)));
    }
    return mx * 0.85;
  }
  _bulge(rng, out) {
    const p = this.p;
    const r = this._hernquist(rng, p.bulgeA, this.R * 0.6);
    const d = rng.dir();
    out[0] = d[0] * r; out[1] = d[1] * r * p.bulgeQ; out[2] = d[2] * r;
    return out;
  }
  _bar(rng, out) {
    const p = this.p;
    const u = rng.gauss() * p.barLen * 0.5, v = rng.gauss() * p.barW * 0.45;
    const c = Math.cos(p.barAngle), s = Math.sin(p.barAngle);
    out[0] = u * c - v * s; out[2] = u * s + v * c;
    out[1] = rng.gauss() * p.barW * 0.35;
    // boxy/peanut: thicker towards the middle
    return out;
  }
  _elliptical(rng, out, scale = 1) {
    const p = this.p;
    const r = this._hernquist(rng, p.ellA * scale, this.R * 1.6);
    const d = rng.dir();
    out[0] = d[0] * r * p.triax[0]; out[1] = d[1] * r * p.triax[2]; out[2] = d[2] * r * p.triax[1];
    return out;
  }
  _irregularOld(rng, out) {
    const p = this.p, R = this.R;
    const c = Math.cos(p.irrAngle), s = Math.sin(p.irrAngle);
    if (rng.next() < 0.3) { // bar-ish core
      const u = rng.gauss() * R * 0.18, v = rng.gauss() * R * 0.06;
      out[0] = u * c - v * s; out[2] = u * s + v * c; out[1] = rng.gauss() * R * 0.04;
    } else {
      const k = p.clumps[Math.floor(rng.next() * p.clumps.length)];
      const sp = rng.next() < 0.5 ? 2.2 : 1.2;
      out[0] = k.x * 0.7 + rng.gauss() * k.s * sp + rng.gauss() * R * 0.12;
      out[2] = k.z * 0.7 + rng.gauss() * k.s * sp + rng.gauss() * R * 0.12;
      out[1] = rng.gauss() * R * 0.05;
    }
    return out;
  }
  _halo(rng, out) {
    const R = this.R;
    const r = R * 0.15 * Math.pow(1 - rng.next() * 0.995, -1 / 1.6);
    const d = rng.dir();
    const rr = Math.min(r, R * 1.8);
    out[0] = d[0] * rr; out[1] = d[1] * rr * 0.8; out[2] = d[2] * rr;
    return out;
  }

  // -------------------------------------------------------------------------------------------
  // Generators → flat typed arrays for the renderer
  // -------------------------------------------------------------------------------------------
  /**
   * Point particles: resolved stars + unresolved haze.
   * @returns {{ count, orbit: Float32Array(r,θ,y)*n, star: Float32Array(lum,tempK,sigma,lockKind)*n }}
   */
  points(nStars, nHaze) {
    const rng = new RNG(this.desc.seed, 'points');
    const n = nStars + nHaze;
    const orbit = new Float32Array(n * 3), star = new Float32Array(n * 4);
    const p = this.p, R = this.R, t = this.type;
    const o = [0, 0, 0];
    let i = 0;
    const push = (lum, temp, sigma, lock, kind) => {
      const r = Math.hypot(o[0], o[2]);
      orbit[i * 3] = r; orbit[i * 3 + 1] = Math.atan2(o[2], o[0]); orbit[i * 3 + 2] = o[1];
      star[i * 4] = lum; star[i * 4 + 1] = temp; star[i * 4 + 2] = sigma; star[i * 4 + 3] = lock + kind * 2;
      i++;
    };
    const starSigma = R * 0.00006 + 0.0015;

    // --- population mixture (fractions of nStars) ---
    const mix = this._starMix();
    const counts = {};
    let acc = 0;
    for (const k in mix) { counts[k] = Math.floor(mix[k] * nStars); acc += counts[k]; }
    counts.old += nStars - acc;

    // old disc (thin + thick)
    for (let k = 0; k < counts.old; k++) {
      if (t === 'elliptical') this._elliptical(rng, o);
      else if (t === 'irregular') this._irregularOld(rng, o);
      else this._oldDisc(rng, o, rng.next() < 0.22);
      const temp = rng.float(3300, 5900);
      push(powerLum(rng, 2.1, 60) * 0.8, temp, starSigma, t === 'elliptical' ? 1 : 0, 0);
    }
    for (let k = 0; k < counts.bulge; k++) {
      this._bulge(rng, o);
      push(powerLum(rng, 2.3, 40) * 0.8, rng.float(3200, 5000), starSigma, 0, 0);
    }
    for (let k = 0; k < counts.bar; k++) {
      this._bar(rng, o);
      push(powerLum(rng, 2.3, 40) * 0.8, rng.float(3300, 5200), starSigma, 1, 0);
    }
    for (let k = 0; k < counts.young; k++) {
      this._young(rng, o, rng.float(-0.35, 0.1), 1.3);
      const sg = rng.next() < 0.05; // red supergiant sprinkled in young regions
      push(powerLum(rng, 1.25, 400) * 1.6, sg ? rng.float(3300, 4200) : rng.float(8500, 32000), starSigma, 0.95, 0);
    }
    // OB associations / open clusters: tight knots along the arms
    let left = counts.cluster;
    while (left > 0) {
      const c = [0, 0, 0];
      this._young(rng, c, rng.float(-0.3, 0.05), 2.0);
      const nn = Math.min(left, rng.int(8, 40));
      const sz = R * rng.float(0.002, 0.007);
      for (let k = 0; k < nn; k++) {
        o[0] = c[0] + rng.gauss() * sz; o[1] = c[1] + rng.gauss() * sz * 0.6; o[2] = c[2] + rng.gauss() * sz;
        push(powerLum(rng, 1.2, 500) * 1.8, rng.float(9000, 34000), starSigma, 0.95, 0);
      }
      left -= nn;
    }
    for (let k = 0; k < counts.halo; k++) {
      this._halo(rng, o);
      push(powerLum(rng, 2.4, 20) * 0.6, rng.float(3800, 5600), starSigma, 0, 0);
    }
    // globular clusters
    left = counts.globular;
    while (left > 0) {
      const c = [0, 0, 0];
      this._halo(rng, c);
      if (t !== 'elliptical') { c[0] *= 0.6; c[1] *= 0.6; c[2] *= 0.6; }
      const nn = Math.min(left, rng.int(20, 60));
      const sz = R * rng.float(0.0015, 0.004);
      for (let k = 0; k < nn; k++) {
        const r = this._hernquist(rng, sz, sz * 20); const d = rng.dir();
        o[0] = c[0] + d[0] * r; o[1] = c[1] + d[1] * r; o[2] = c[2] + d[2] * r;
        push(powerLum(rng, 2.0, 30) * 0.9, rng.float(4200, 6500), starSigma, 0, 0);
      }
      left -= nn;
    }
    // satellite dwarfs (spirals / ellipticals)
    if (counts.dwarf > 0) {
      const nd = 2 + Math.floor(rng.next() * 2);
      for (let d = 0; d < nd; d++) {
        const a = rng.float(0, TAU), dist = R * rng.float(1.35, 2.1);
        const c = [Math.cos(a) * dist, rng.float(-0.4, 0.4) * R, Math.sin(a) * dist];
        const sz = R * rng.float(0.03, 0.07);
        const nn = Math.floor(counts.dwarf / nd);
        for (let k = 0; k < nn; k++) {
          o[0] = c[0] + rng.gauss() * sz; o[1] = c[1] + rng.gauss() * sz * 0.7; o[2] = c[2] + rng.gauss() * sz * 0.8;
          push(powerLum(rng, 2.0, 40) * 0.8, rng.next() < 0.3 ? rng.float(9000, 20000) : rng.float(3800, 5800), starSigma, 1, 0);
        }
      }
    }
    while (i < nStars) { this._oldDisc(rng, o); push(0.5, 4500, starSigma, 0, 0); }

    // --- haze: unresolved starlight, sampled from the total light model ---
    const hz = this._hazeMix();
    for (let k = 0; k < nHaze; k++) {
      const u = rng.next();
      let temp, sig, lock = 0;
      if (u < hz.bulge) {
        if (t === 'elliptical') this._elliptical(rng, o); else this._bulge(rng, o);
        const r3 = Math.hypot(o[0], o[1], o[2]);
        sig = clamp(r3 * 0.22, R * 0.0025, R * 0.03); temp = rng.float(3600, 4500);
      } else if (u < hz.bulge + hz.bar) {
        this._bar(rng, o); sig = R * rng.float(0.01, 0.02); temp = rng.float(3800, 4700); lock = 1;
      } else if (u < hz.bulge + hz.bar + hz.young) {
        this._young(rng, o, rng.float(-0.4, 0.1), 1.0, 2.5); sig = R * rng.float(0.006, 0.016); temp = rng.float(6500, 14000); lock = 0.95;
      } else {
        if (t === 'irregular') this._irregularOld(rng, o); else this._oldDisc(rng, o, rng.next() < 0.3);
        const r = Math.hypot(o[0], o[2]);
        sig = R * rng.float(0.012, 0.028) * (0.6 + r / R); temp = rng.float(4000, 5600); lock = 0.5;
      }
      push(rng.float(0.7, 1.3), temp, sig, lock, 1);
    }
    return { count: i, orbit, star };
  }

  _starMix() {
    const t = this.type, p = this.p;
    if (t === 'elliptical') return { old: 0.86, bulge: 0, bar: 0, young: 0, cluster: 0, halo: 0.05, globular: 0.09, dwarf: 0 };
    if (t === 'irregular') return { old: 0.48, bulge: 0, bar: 0, young: 0.36, cluster: 0.14, halo: 0.02, globular: 0, dwarf: 0 };
    if (t === 'lenticular') return { old: 0.6, bulge: 0.3, bar: 0, young: 0, cluster: 0, halo: 0.04, globular: 0.06, dwarf: 0 };
    const y = 0.2 * p.youth;
    const b = p.bulgeFrac * 0.55;
    const bar = p.bar ? 0.06 : 0;
    return { old: 1 - y - y * 0.3 - b - bar - 0.03 - 0.025 - 0.015, bulge: b, bar, young: y, cluster: y * 0.3, halo: 0.03, globular: 0.025, dwarf: 0.015 };
  }
  _hazeMix() {
    const t = this.type, p = this.p;
    if (t === 'elliptical') return { bulge: 1, bar: 0, young: 0 };
    if (t === 'irregular') return { bulge: 0, bar: 0, young: 0.45 };
    if (t === 'lenticular') return { bulge: 0.45, bar: 0, young: 0 };
    if (t === 'ring') return { bulge: 0.12, bar: 0, young: 0.5 };
    return { bulge: p.bulgeFrac, bar: p.bar ? 0.08 : 0, young: 0.3 * p.youth };
  }

  /**
   * Dust clouds: centre orbit (r,θ,y) + (radius, opacity, flatten, lock) + (tile, rotation).
   */
  dust(n) {
    const rng = new RNG(this.desc.seed, 'dust');
    const t = this.type, p = this.p, R = this.R;
    const orbit = new Float32Array(n * 3), prm = new Float32Array(n * 4), tex = new Float32Array(n * 2);
    if (t === 'elliptical') return { count: 0, orbit, prm, tex };
    const o = [0, 0, 0];
    let i = 0;
    const push = (size, op, flat, lock) => {
      orbit[i * 3] = Math.hypot(o[0], o[2]); orbit[i * 3 + 1] = Math.atan2(o[2], o[0]); orbit[i * 3 + 2] = o[1];
      prm[i * 4] = size; prm[i * 4 + 1] = op; prm[i * 4 + 2] = flat; prm[i * 4 + 3] = lock;
      tex[i * 2] = Math.floor(rng.next() * 16); tex[i * 2 + 1] = rng.float(0, TAU);
      i++;
    };
    for (let k = 0; k < n; k++) {
      const u = rng.next();
      if (t === 'lenticular') {
        const r = R * (0.35 + rng.gauss() * 0.04), a = rng.float(0, TAU);
        o[0] = r * Math.cos(a); o[2] = r * Math.sin(a); o[1] = rng.gauss() * p.hDust;
        push(R * rng.float(0.01, 0.025), rng.float(0.25, 0.6), 0.12, 0.9);
        continue;
      }
      if (p.bar && u < 0.12) {
        // straight dust lanes on the bar's leading edges, curving into the arms
        const side = rng.next() < 0.5 ? 1 : -1;
        const s = rng.float(0.15, 1.05);
        const along = s * p.barLen * side;
        const off = -side * p.barW * (0.55 + 0.25 * s) ;
        const ca = Math.cos(p.barAngle), sa = Math.sin(p.barAngle);
        o[0] = along * ca - off * sa + rng.gauss() * R * 0.004;
        o[2] = along * sa + off * ca + rng.gauss() * R * 0.004;
        o[1] = rng.gauss() * p.hDust;
        push(R * rng.float(0.006, 0.014), rng.float(0.5, 0.9), 0.1, 1);
        continue;
      }
      if (t === 'irregular' || t === 'ring') {
        this._young(rng, o, 0, 1.2, 1.5);
        push(R * rng.float(0.008, 0.03), rng.float(0.2, 0.6), 0.25, 0.95);
        continue;
      }
      // spiral: inner-edge lanes (most), flocculent filaments, diffuse disc dust
      if (u < 0.78) {
        this._young(rng, o, 0.55, 1.6, 0.8);
        const r = Math.hypot(o[0], o[2]);
        push(R * rng.float(0.006, 0.016) * (0.6 + r / R), rng.float(0.45, 0.95), 0.1, 0.95);
      } else {
        this._oldDisc(rng, o);
        o[1] = rng.gauss() * p.hDust * 1.5;
        push(R * rng.float(0.01, 0.03), rng.float(0.1, 0.3), 0.15, 0.6);
      }
    }
    return { count: i, orbit, prm, tex };
  }

  /** HII regions / emission + reflection nebulae: orbit + (radius, intensity, kind, lock) + tex. */
  nebulae(n) {
    const rng = new RNG(this.desc.seed, 'hii');
    const t = this.type, p = this.p, R = this.R;
    const orbit = new Float32Array(n * 3), prm = new Float32Array(n * 4), tex = new Float32Array(n * 2);
    if (t === 'elliptical' || t === 'lenticular') return { count: 0, orbit, prm, tex };
    const o = [0, 0, 0];
    let i = 0;
    for (let k = 0; k < n; k++) {
      this._young(rng, o, -0.3 + rng.gauss() * 0.15, 2.2, 0.8);
      orbit[i * 3] = Math.hypot(o[0], o[2]); orbit[i * 3 + 1] = Math.atan2(o[2], o[0]); orbit[i * 3 + 2] = o[1];
      // kind: 0 = Hα emission (pink), 1 = OIII-rich (teal core), 2 = blue reflection
      const kind = rng.weighted([[0, 80], [1, 8], [2, 12]]);
      const big = rng.next() < 0.06;
      prm[i * 4] = R * (big ? rng.float(0.006, 0.012) : rng.float(0.0015, 0.005));
      prm[i * 4 + 1] = (kind === 2 ? 0.35 : 1) * rng.float(0.6, 1.4) * (big ? 0.7 : 1);
      prm[i * 4 + 2] = kind;
      prm[i * 4 + 3] = 0.95;
      tex[i * 2] = Math.floor(rng.next() * 16); tex[i * 2 + 1] = rng.float(0, TAU);
      i++;
    }
    return { count: i, orbit, prm, tex };
  }
}
