// PlanetModel: the single source of truth for a landable world's shape and settlement layout.
// Pure JS, deterministic, allocation-free in the hot path, worker-safe (no three.js).
//
// The world is a small walkable sphere: radius R (metres, ~5-10 km) centred on the origin.
// A point on the surface in direction d (unit vector) sits at  d * (R + height(d)).
// Sea level (when desc.ocean exists) is height 0.
//
//   const model = new PlanetModel(planetDesc);
//   model.height(x, y, z, minWavelength = 0)   -> metres (d = (x,y,z) must be unit length)
//   model.climate(x, y, z, h, out)             -> out.temp, out.moist in [0,1]
//   model.sites                                -> settlement / landmark sites (terrain is flattened under them)
//   model.spawn                                -> { dir:[x,y,z], height } landing pad beside the capital
//
// `minWavelength` (metres) lets coarse LODs skip octaves they cannot represent — pass roughly the
// vertex spacing of the mesh being generated; pass 0 for full detail (physics, placement).
import { makeNoise3D } from '../core/noise.js';
import { RNG, seedFrom } from '../core/rng.js';
import { cityName } from './names.js';

const sstep = (a, b, x) => { let t = (x - a) / (b - a); t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); };

const DEFAULT_TERRAIN = { cf: 1.1, seaBias: 0.05, oceanDepth: 200, plains: 120, mAmp: 600, mFreq: 5, hAmp: 50, hFreq: 34, dAmp: 4, dFreq: 420, warp: 0.3, dunes: 0, duneFreq: 140, terrace: 0, terraceStep: 60, craters: 0, spires: 0 };

export class PlanetModel {
  constructor(desc) {
    this.desc = desc;
    this.seed = desc.seed >>> 0;
    this.R = desc.gameRadius || 8000;
    this.hasOcean = !!desc.ocean;
    this.t = { ...DEFAULT_TERRAIN, ...(desc.terrain || {}) };
    this.nA = makeNoise3D(seedFrom(this.seed, 'a'));
    this.nB = makeNoise3D(seedFrom(this.seed, 'b'));
    this.nC = makeNoise3D(seedFrom(this.seed, 'c'));
    this.nD = makeNoise3D(seedFrom(this.seed, 'd'));
    // random but fixed dune wind axis
    const r = new RNG(this.seed, 'wind'); const w = r.dir();
    this.wind = w;
    this.maxHeight = this.t.plains + this.t.mAmp + this.t.hAmp + 60;
    this.minHeight = this.hasOcean ? -this.t.oceanDepth : -this.t.hAmp - 40;
    /** @type {Array<{id:number,name:string,kind:string,dir:number[],radius:number,height:number,style:string,seed:number,cos:number,cosOuter:number,floating:boolean}>} */
    this.sites = [];
    this._sx = new Float64Array(0); // packed site data for the hot path
    this._buildSites();
  }

  /** Terrain height before settlements flatten it. */
  baseHeight(x, y, z, minWl = 0) {
    const t = this.t, R = this.R, nA = this.nA, nB = this.nB, nC = this.nC, nD = this.nD;
    // domain warp (large, lazy swirls so coastlines and ranges feel geological, not noisy)
    const wf = 1.7, w = t.warp;
    const wx = nB(x * wf + 11.3, y * wf, z * wf) * w;
    const wy = nB(x * wf, y * wf + 27.1, z * wf) * w;
    const wz = nB(x * wf, y * wf, z * wf + 5.9) * w;
    const px = x + wx, py = y + wy, pz = z + wz;

    // continents
    let c = 0, a = 1, f = t.cf, norm = 0;
    for (let o = 0; o < 5; o++) { c += a * nA(px * f, py * f, pz * f); norm += a; a *= 0.5; f *= 2.03; }
    c = c / norm + t.seaBias;

    let h;
    if (c < 0) h = -t.oceanDepth * (1 - Math.exp(c * 3.2)) - 2.0 * sstep(0, -0.02, c);
    else h = t.plains * (c * c * (3 - 2 * Math.min(c, 1))) * 0.9 + t.plains * 0.1 * c;
    const land = sstep(-0.01, 0.16, c);
    const inland = sstep(0.05, 0.4, c);

    // mountain ranges: ridged multifractal masked by a slow "tectonic" field
    const mm = nC(px * 1.9 + 3.1, py * 1.9, pz * 1.9 - 7.7);
    const mmask = sstep(-0.15, 0.55, mm) * inland;
    let m = 0;
    if (mmask > 0.001) {
      let ra = 1, rf = t.mFreq, rn = 0, prev = 1, rs = 0;
      for (let o = 0; o < 7; o++) {
        if (minWl > 0 && R / rf < minWl * 1.6) break;
        let n = 1 - Math.abs(nB(px * rf, py * rf, pz * rf));
        n *= n; rs += n * ra * prev; rn += ra; prev = n; ra *= 0.5; rf *= 2.07;
      }
      m = rn > 0 ? rs / rn : 0;
      m = Math.pow(m, 1.35) * 1.9;
      h += m * t.mAmp * mmask;
    }

    // rolling hills
    {
      let s = 0, ha = 1, hf = t.hFreq, hn = 0;
      for (let o = 0; o < 4; o++) {
        if (minWl > 0 && R / hf < minWl * 1.6) break;
        s += ha * nC(px * hf, py * hf, pz * hf); hn += ha; ha *= 0.5; hf *= 2.1;
      }
      if (hn > 0) h += (s / hn) * t.hAmp * (0.25 + 0.75 * land) * (1 - 0.5 * mmask);
    }

    // mesas / terraces (stratified rock shelves)
    if (t.terrace > 0 && h > 4) {
      const tm = sstep(-0.2, 0.35, nD(x * 2.6 - 9.1, y * 2.6, z * 2.6 + 4.4)) * t.terrace;
      if (tm > 0.001) {
        const step = t.terraceStep || 60;
        const q = h / step, fl = Math.floor(q), fr = q - fl;
        const shelf = (fl + sstep(0.72, 0.96, fr)) * step;
        h += (shelf - h) * tm;
      }
    }

    // spires / karst towers / crystal needles
    if (t.spires > 0 && land > 0.2) {
      const sf = 95;
      if (!(minWl > 0 && R / sf < minWl * 1.2)) {
        const sm = sstep(0.1, 0.6, nD(x * 3.3 + 1.7, y * 3.3 - 2.2, z * 3.3)) * t.spires * land;
        if (sm > 0.001) {
          const n1 = 1 - Math.abs(nA(x * sf + 40, y * sf, z * sf));
          const sp = Math.pow(n1 < 0 ? 0 : n1, 9);
          h += sp * 170 * sm;
        }
      }
    }

    // dune seas
    if (t.dunes > 0 && land > 0) {
      const df = t.duneFreq || 140;
      if (!(minWl > 0 && R / df < minWl * 1.2)) {
        const dm = sstep(-0.1, 0.4, nD(x * 2.1, y * 2.1 + 8.8, z * 2.1)) * (1 - mmask) * land;
        if (dm > 0.001) {
          const wv = this.wind;
          const ph = (x * wv[0] + y * wv[1] + z * wv[2]) * df + nC(x * 18, y * 18, z * 18) * 2.6;
          const s1 = 1 - Math.abs(Math.sin(ph));
          const ph2 = ph * 2.7 + nC(x * 50 + 9, y * 50, z * 50) * 2.0;
          const s2 = 1 - Math.abs(Math.sin(ph2));
          h += (Math.pow(s1, 1.6) * t.dunes + s2 * s2 * t.dunes * 0.22) * dm;
        }
      }
    }

    // impact craters (airless worlds)
    if (t.craters > 0) {
      h += this._craters(x, y, z, 7.5, minWl) * 150 * t.craters;
      h += this._craters(x, y, z, 26, minWl) * 42 * t.craters;
      h += this._craters(x, y, z, 90, minWl) * 11 * t.craters;
    }

    // fine detail
    {
      let s = 0, da = 1, df2 = t.dFreq, dn = 0;
      for (let o = 0; o < 4; o++) {
        if (minWl > 0 && R / df2 < minWl * 1.6) break;
        s += da * nD(x * df2, y * df2, z * df2); dn += da; da *= 0.5; df2 *= 2.13;
      }
      if (dn > 0) h += (s / dn) * t.dAmp * (0.5 + m * 1.5) * dn / 1.875;
    }
    return h;
  }

  // jittered-cell crater field; returns roughly [-1, 0.35]
  _craters(x, y, z, freq, minWl) {
    if (minWl > 0 && this.R / freq < minWl * 3) return 0;
    const px = x * freq, py = y * freq, pz = z * freq;
    const ix = Math.floor(px - 0.5), iy = Math.floor(py - 0.5), iz = Math.floor(pz - 0.5);
    let out = 0;
    const s = this.seed;
    for (let dz = 0; dz < 2; dz++) for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const cx = ix + dx, cy = iy + dy, cz = iz + dz;
      let hsh = (Math.imul(cx, 73856093) ^ Math.imul(cy, 19349663) ^ Math.imul(cz, 83492791) ^ s) >>> 0;
      hsh = Math.imul(hsh ^ (hsh >>> 15), 0x2c1b3c6d) >>> 0; const r1 = (hsh & 0xffff) / 65535;
      hsh = Math.imul(hsh ^ (hsh >>> 12), 0x297a2d39) >>> 0; const r2 = (hsh & 0xffff) / 65535;
      hsh = Math.imul(hsh ^ (hsh >>> 15), 0x85ebca6b) >>> 0; const r3 = (hsh & 0xffff) / 65535;
      const r4 = ((hsh >>> 16) & 0xffff) / 65535;
      if (r4 < 0.45) continue; // not every cell holds a crater
      const fx = cx + 0.5 + (r1 - 0.5) * 0.5, fy = cy + 0.5 + (r2 - 0.5) * 0.5, fz = cz + 0.5 + (r3 - 0.5) * 0.5;
      const rad = 0.16 + 0.26 * (r4 - 0.45) / 0.55;
      const d = Math.sqrt((px - fx) * (px - fx) + (py - fy) * (py - fy) + (pz - fz) * (pz - fz)) / rad;
      if (d > 1.9) continue;
      let v;
      if (d < 1) v = (d * d - 1) * 0.9 + 0.32 * d * d * d * d;       // bowl rising to the rim
      else { const e = d - 1; v = 0.32 * Math.exp(-e * e * 9); }      // ejecta rim falloff
      if (Math.abs(v) > Math.abs(out)) out = v;
    }
    return out;
  }

  /** Final terrain height in metres, including settlement terraces. */
  height(x, y, z, minWl = 0) {
    let h = this.baseHeight(x, y, z, minWl);
    const sx = this._sx;
    for (let i = 0; i < sx.length; i += 6) {
      const d = x * sx[i] + y * sx[i + 1] + z * sx[i + 2];
      if (d > sx[i + 4]) {
        // d = cos(angle); blend from untouched (outer) to fully flat (inner)
        const k = sstep(sx[i + 4], sx[i + 3], d);
        h += (sx[i + 5] - h) * k;
      }
    }
    return h;
  }

  /** Surface radius (R + height, clamped to sea level when `sea` is true). */
  radiusAt(x, y, z, sea = false) {
    const h = this.height(x, y, z);
    return this.R + (sea && this.hasOcean && h < 0 ? 0 : h);
  }

  /** Climate fields in [0,1]. temp: 0 frozen .. 1 scorching. moist: 0 arid .. 1 lush. */
  climate(x, y, z, h, out) {
    const lat = Math.abs(y);
    const n = this.nC(x * 2.3 + 31, y * 2.3, z * 2.3) * 0.5 + this.nD(x * 7.1, y * 7.1 + 3, z * 7.1) * 0.2;
    let temp = (this.desc.tempBase ?? 0.6) + 0.18 - lat * lat * 0.62 - Math.max(0, h) / 2600 + n * 0.14;
    let moist = 0.5 + this.nA(x * 1.6 - 17, y * 1.6 + 5, z * 1.6) * 0.55 + this.nB(x * 6 + 2, y * 6, z * 6) * 0.18;
    if (this.hasOcean) moist += 0.25 * Math.exp(-Math.max(0, h) / 140);
    out.temp = temp < 0 ? 0 : temp > 1 ? 1 : temp;
    out.moist = moist < 0 ? 0 : moist > 1 ? 1 : moist;
    return out;
  }

  /** Slope estimate (0 flat .. 1 vertical-ish) by finite differences over `span` metres. */
  slope(x, y, z, span = 6) {
    const e = span / this.R;
    // two tangent directions
    let tx = -z, ty = 0, tz = x; let l = Math.hypot(tx, tz);
    if (l < 1e-4) { tx = 1; ty = 0; tz = 0; l = 1; }
    tx /= l; tz /= l;
    const bx = y * tz - z * ty, by = z * tx - x * tz, bz = x * ty - y * tx;
    const h0 = this.height(x, y, z);
    const n1 = norm3(x + tx * e, y + ty * e, z + tz * e), n2 = norm3(x + bx * e, y + by * e, z + bz * e);
    const h1 = this.height(n1[0], n1[1], n1[2]), h2 = this.height(n2[0], n2[1], n2[2]);
    const g = Math.hypot(h1 - h0, h2 - h0) / span;
    return g / Math.sqrt(1 + g * g);
  }

  _buildSites() {
    const civ = this.desc.civ;
    const rng = new RNG(this.seed, 'sites');
    const out = [];
    const R = this.R;
    const wantCities = civ ? Math.max(3, civ.cities || 6) : 0;
    // kinds in descending importance; radius = flattened footprint in metres
    const plan = [];
    if (civ) {
      const vanished = civ.level === 'vanished';
      plan.push({ kind: vanished ? 'ruin-capital' : 'capital', radius: vanished ? 260 : (civ.style === 'neon' ? 620 : 400) });
      for (let i = 1; i < wantCities; i++) {
        const k = i < wantCities * 0.35 ? 'city' : i < wantCities * 0.75 ? 'town' : 'village';
        plan.push({ kind: vanished ? 'ruin' : k, radius: k === 'city' ? (civ.style === 'neon' ? 420 : 260) : k === 'town' ? 160 : 95 });
      }
      for (let i = 0; i < 6; i++) plan.push({ kind: 'landmark', radius: 55 });
      for (let i = 0; i < 5; i++) plan.push({ kind: 'outpost', radius: 45 });
    } else {
      // even lifeless worlds get a few mysteries worth walking to
      for (let i = 0; i < 4; i++) plan.push({ kind: 'landmark', radius: 55 });
    }
    const floatingOK = civ && civ.style === 'stilt';
    let capitalDir = null;
    for (let pi = 0; pi < plan.length; pi++) {
      const p = plan[pi];
      let best = null, bestScore = -1e9;
      const tries = p.kind === 'capital' || p.kind === 'ruin-capital' ? 260 : 70;
      for (let k = 0; k < tries; k++) {
        let d = rng.dir();
        // keep civilisation out of the polar caps; cluster towns loosely around the capital
        if (Math.abs(d[1]) > 0.8) continue;
        if (capitalDir && (p.kind === 'city' || p.kind === 'town' || p.kind === 'village') && rng.chance(0.65)) {
          const spread = 0.12 + 0.5 * rng.next();
          d = norm3(capitalDir[0] + (d[0]) * spread, capitalDir[1] + (d[1]) * spread, capitalDir[2] + (d[2]) * spread);
        }
        const h = this.baseHeight(d[0], d[1], d[2], 30);
        const water = this.hasOcean && h < 3;
        if (water && !(floatingOK && h > -60 && p.kind !== 'capital')) continue;
        if (!water && h > this.t.plains * 0.9 + 140 && p.kind !== 'landmark' && p.kind !== 'outpost') continue;
        // roughness over the footprint
        const e = (p.radius * 0.8) / R;
        let rough = 0;
        for (let q = 0; q < 4; q++) {
          const ang = q * 1.5708 + 0.4;
          const o = tangentOffset(d, Math.cos(ang) * e, Math.sin(ang) * e);
          rough += Math.abs(this.baseHeight(o[0], o[1], o[2], 30) - h);
        }
        rough /= 4;
        // spacing
        let near = 1e9;
        for (const s of out) {
          const dot = d[0] * s.dir[0] + d[1] * s.dir[1] + d[2] * s.dir[2];
          const dist = Math.acos(Math.min(1, dot)) * R - s.radius - p.radius;
          if (dist < near) near = dist;
        }
        if (near < 260) continue;
        let score = -rough * (p.kind === 'landmark' ? 0.3 : 1.6) + rng.next() * 12;
        if (this.hasOcean && !water) score += 40 * Math.exp(-Math.abs(h - 14) / 30); // coasts are loved
        if (p.kind === 'landmark') score += Math.min(h, 500) * 0.06;                   // landmarks like high places
        if (score > bestScore) { bestScore = score; best = { d, h, water }; }
      }
      if (!best) continue;
      const height = best.water ? 0 : Math.max(best.h, this.hasOcean ? 7 : best.h);
      const srng = rng.fork('site', pi);
      const site = {
        id: out.length, kind: p.kind, dir: best.d, radius: p.radius, height,
        style: civ ? civ.style : 'monolith', seed: srng.seed, floating: !!best.water,
        name: p.kind === 'landmark' ? `${cityName(srng, 'mixed').split(' ')[0]} ${srng.pick(['Stone', 'Arch', 'Eye', 'Needle', 'Gate', 'Cairn', 'Beacon'])}` : cityName(srng, 'soft'),
      };
      site.cos = Math.cos(site.radius / R);
      site.cosOuter = Math.cos((site.radius * 1.75 + 30) / R);
      out.push(site);
      if (!capitalDir && (p.kind === 'capital' || p.kind === 'ruin-capital')) capitalDir = best.d;
    }
    // landing pad beside the most important site (or anywhere flat-ish on wild worlds)
    let anchor = out[0];
    let padDir, padH;
    if (anchor) {
      let found = null;
      for (let k = 0; k < 40 && !found; k++) {
        const ang = rng.float(0, Math.PI * 2);
        const dist = (anchor.radius * 1.75 + 30 + 70 + k * 6) / R;
        const d = tangentOffset(anchor.dir, Math.cos(ang) * dist, Math.sin(ang) * dist);
        const h = this.baseHeight(d[0], d[1], d[2], 20);
        if (!this.hasOcean || h > 4) found = { d, h };
      }
      if (!found) found = { d: anchor.dir, h: anchor.height };
      padDir = found.d; padH = found.h;
    } else {
      for (let k = 0; k < 200; k++) {
        const d = rng.dir(); const h = this.baseHeight(d[0], d[1], d[2], 20);
        if ((!this.hasOcean || h > 6) && h < this.t.plains + 60) { padDir = d; padH = h; break; }
      }
      if (!padDir) { padDir = [0, 0, 1]; padH = Math.max(6, this.baseHeight(0, 0, 1)); }
    }
    const pad = { id: out.length, kind: 'landing', dir: padDir, radius: 34, height: Math.max(padH, this.hasOcean ? 6 : padH), style: civ ? civ.style : 'frontier', seed: seedFrom(this.seed, 'pad'), floating: false, name: 'Landing field' };
    pad.cos = Math.cos(pad.radius / R); pad.cosOuter = Math.cos((pad.radius * 1.9 + 16) / R);
    out.push(pad);
    this.sites = out;
    this.spawn = { dir: padDir, height: pad.height, site: pad.id };
    const flat = out.filter((s) => !s.floating);
    this._sx = new Float64Array(flat.length * 6);
    flat.forEach((s, i) => { this._sx.set([s.dir[0], s.dir[1], s.dir[2], s.cos, s.cosOuter, s.height], i * 6); });
  }

  /** Nearest site to a direction: { site, distance (metres along the surface) } */
  nearestSite(x, y, z) {
    let best = null, bd = -2;
    for (const s of this.sites) { const d = x * s.dir[0] + y * s.dir[1] + z * s.dir[2]; if (d > bd) { bd = d; best = s; } }
    return best ? { site: best, distance: Math.acos(Math.min(1, bd)) * this.R } : null;
  }
}

function norm3(x, y, z) { const l = Math.hypot(x, y, z) || 1; return [x / l, y / l, z / l]; }

/** Move from unit direction d by (u, v) radians along a local tangent frame; returns a new unit direction. */
export function tangentOffset(d, u, v) {
  let tx = -d[2], ty = 0, tz = d[0]; let l = Math.hypot(tx, tz);
  if (l < 1e-5) { tx = 1; tz = 0; l = 1; }
  tx /= l; tz /= l;
  const bx = d[1] * tz - d[2] * ty, by = d[2] * tx - d[0] * tz, bz = d[0] * ty - d[1] * tx;
  return norm3(d[0] + tx * u + bx * v, d[1] + ty * u + by * v, d[2] + tz * u + bz * v);
}

/** Local east/north/up frame at unit direction d (each a [x,y,z]). */
export function tangentFrame(d) {
  let tx = -d[2], ty = 0, tz = d[0]; let l = Math.hypot(tx, tz);
  if (l < 1e-5) { tx = 1; tz = 0; l = 1; }
  tx /= l; tz /= l;
  const bx = d[1] * tz - d[2] * ty, by = d[2] * tx - d[0] * tz, bz = d[0] * ty - d[1] * tx;
  return { east: [tx, ty, tz], north: [bx, by, bz], up: [d[0], d[1], d[2]] };
}
