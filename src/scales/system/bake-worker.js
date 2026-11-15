// Web Worker: bakes a landable world's surface from its PlanetModel into cube-map faces, so the
// planet seen from orbit is exactly the planet you land on (continents, seas, ice, deserts, cities).
//
// message in : { id, desc, N, exag }            desc = planet descriptor (plain data)
// message out: { id, N, faces: [{ albedo, normal }] x 6 }   (Uint8Array RGBA, N*N each, transferred)
//   albedo.rgb = surface colour (sRGB 8-bit)   albedo.a = water mask (1 = specular ocean)
//   normal.rgb = object-space normal * 0.5 + 0.5   normal.a = emission (city lights / lava glow)
// Face order and orientation follow the WebGL cube-map convention (+X, -X, +Y, -Y, +Z, -Z; row 0 = t 0).
import { PlanetModel } from '../../universe/planet-model.js';

const sstep = (a, b, x) => { let t = (x - a) / (b - a); t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); };
const mix = (a, b, t) => a + (b - a) * t;
function hexLin(hex) {
  const n = parseInt((hex || '#808080').slice(1), 16);
  const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return [f((n >> 16) & 255), f((n >> 8) & 255), f(n & 255)];
}
const toSRGB8 = (v) => {
  v = v < 0 ? 0 : v > 1 ? 1 : v;
  const s = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return Math.round(s * 255);
};
function faceDir(f, s, t, out) {
  const sc = 2 * s - 1, tc = 2 * t - 1;
  let x, y, z;
  switch (f) {
    case 0: x = 1; y = -tc; z = -sc; break;
    case 1: x = -1; y = -tc; z = sc; break;
    case 2: x = sc; y = 1; z = tc; break;
    case 3: x = sc; y = -1; z = -tc; break;
    case 4: x = sc; y = -tc; z = 1; break;
    default: x = -sc; y = -tc; z = -1; break;
  }
  const l = Math.hypot(x, y, z);
  out[0] = x / l; out[1] = y / l; out[2] = z / l;
  return out;
}
function hash3(x, y, z) {
  let h = (Math.imul(x | 0, 73856093) ^ Math.imul(y | 0, 19349663) ^ Math.imul(z | 0, 83492791)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0; h = Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0;
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

const models = new Map();

self.onmessage = (e) => {
  const { id, desc, N, exag = 0.8 } = e.data;
  let model = models.get(desc.seed);
  if (!model) { model = new PlanetModel(desc); models.set(desc.seed, model); }
  const faces = bake(model, desc, N, exag);
  self.postMessage({ id, N, faces }, faces.flatMap((f) => [f.albedo.buffer, f.normal.buffer]));
};

function bake(model, desc, N, exag) {
  const R = model.R;
  const pal = desc.palette || {};
  const P = {};
  for (const k of Object.keys(pal)) P[k] = hexLin(pal[k]);
  const ocean = desc.ocean;
  const lavaWorld = desc.type === 'lava' || (ocean && ocean.kind === 'lava');
  const shallow = ocean ? hexLin(ocean.shallow) : [0, 0, 0], deep = ocean ? hexLin(ocean.deep) : [0, 0, 0];
  const flora = desc.life ? desc.life.flora : 0;
  const t = model.t;
  const minWl = (Math.PI * 0.5 * R) / N * 0.9;
  const M = N + 2; // one-texel border for finite differences
  const H = new Float32Array(M * M);
  const D = new Float32Array(M * M * 3);
  const dir = [0, 0, 0], clim = { temp: 0, moist: 0 };
  // settlement lights
  const civ = desc.civ;
  const lights = [];
  if (civ && civ.level !== 'vanished') {
    const w = { capital: 1.0, city: 0.75, town: 0.5, village: 0.3, outpost: 0.18, landing: 0.35 };
    for (const s of model.sites) {
      const k = w[s.kind]; if (!k) continue;
      const spread = (s.radius * (civ.style === 'neon' ? 5.5 : 3.6)) / R;
      lights.push([s.dir[0], s.dir[1], s.dir[2], k, spread, Math.cos(spread * 3.2)]);
    }
  }
  const popF = civ && civ.level !== 'vanished' ? Math.min(1, Math.max(0.2, (Math.log10(civ.population || 1e5) - 4) / 6)) : 0;
  const megacity = civ && civ.style === 'neon';
  const nA = model.nA, nB = model.nB, nC = model.nC, nD = model.nD;

  const out = [];
  for (let f = 0; f < 6; f++) {
    // heights with border (directions outside [0,1] extend naturally across the cube edge)
    for (let j = 0; j < M; j++) for (let i = 0; i < M; i++) {
      faceDir(f, (i - 0.5) / N, (j - 0.5) / N, dir);
      const k = j * M + i;
      H[k] = model.height(dir[0], dir[1], dir[2], minWl);
      D[k * 3] = dir[0]; D[k * 3 + 1] = dir[1]; D[k * 3 + 2] = dir[2];
    }
    const albedo = new Uint8Array(N * N * 4);
    const normal = new Uint8Array(N * N * 4);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const k = (j + 1) * M + (i + 1);
      const x = D[k * 3], y = D[k * 3 + 1], z = D[k * 3 + 2];
      const h = H[k];
      const water = !!ocean && h < 0;
      // normal from the displaced neighbours (sea surface flat)
      const hs = (q) => (ocean && H[q] < 0 ? 0 : H[q]) * exag;
      const kl = k - 1, kr = k + 1, kd = k - M, ku = k + M;
      const rl = R + hs(kl), rr = R + hs(kr), rd = R + hs(kd), ru = R + hs(ku);
      const ux = D[kr * 3] * rr - D[kl * 3] * rl, uy = D[kr * 3 + 1] * rr - D[kl * 3 + 1] * rl, uz = D[kr * 3 + 2] * rr - D[kl * 3 + 2] * rl;
      const vx = D[ku * 3] * ru - D[kd * 3] * rd, vy = D[ku * 3 + 1] * ru - D[kd * 3 + 1] * rd, vz = D[ku * 3 + 2] * ru - D[kd * 3 + 2] * rd;
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      let nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
      if (nx * x + ny * y + nz * z < 0) { nx = -nx; ny = -ny; nz = -nz; }
      const slope = 1 - (nx * x + ny * y + nz * z); // 0 flat .. ~0.3 steep
      model.climate(x, y, z, h, clim);
      const temp = clim.temp, moist = clim.moist;
      const n1 = nC(x * 23 + 4.1, y * 23, z * 23) * 0.6 + nD(x * 71, y * 71 - 2, z * 71) * 0.4; // texture variation
      let r, g, b, wmask = 0, emis = 0;
      if (water) {
        const d = Math.min(1, -h / Math.max(20, t.oceanDepth));
        const dd = Math.pow(d, 0.45);
        r = mix(shallow[0], deep[0], dd); g = mix(shallow[1], deep[1], dd); b = mix(shallow[2], deep[2], dd);
        if (lavaWorld) {
          // molten seas: dark cooling crust webbed with incandescent cracks
          const crack = Math.pow(1 - Math.abs(nB(x * 34, y * 34, z * 34)), 6);
          const crust = sstep(-0.2, 0.5, nA(x * 9, y * 9, z * 9));
          r = mix(0.09, 0.03, crust); g = mix(0.03, 0.02, crust); b = 0.02;
          emis = Math.min(1, (1 - crust) * 0.85 + crack * 0.6 + 0.12);
        } else wmask = 1;
        // sea ice where frozen
        const ice = !lavaWorld ? sstep(0.16, 0.06, temp) : 0;
        if (ice > 0) { r = mix(r, P.snow[0] * 0.9, ice); g = mix(g, P.snow[1] * 0.92, ice); b = mix(b, P.snow[2] * 0.95, ice); wmask *= 1 - ice; }
      } else {
        // land biome from the same climate fields the ground uses
        const veg = flora;
        let c0 = P.sand || [0.5, 0.5, 0.5];
        const dry = P.grassDry || c0, lush = P.grass || c0, forest = P.forest || lush, soil = P.soil || c0;
        r = c0[0]; g = c0[1]; b = c0[2];
        const wDry = sstep(0.22, 0.45, moist) * Math.min(1, veg * 1.6 + 0.25);
        r = mix(r, dry[0], wDry); g = mix(g, dry[1], wDry); b = mix(b, dry[2], wDry);
        const wLush = sstep(0.42, 0.62, moist) * veg;
        r = mix(r, lush[0], wLush); g = mix(g, lush[1], wLush); b = mix(b, lush[2], wLush);
        const wFor = sstep(0.6, 0.85, moist + n1 * 0.12) * veg * sstep(0.95, 0.55, temp);
        r = mix(r, forest[0], wFor); g = mix(g, forest[1], wFor); b = mix(b, forest[2], wFor);
        const wSoil = sstep(0.25, 0.7, n1) * 0.35;
        r = mix(r, soil[0], wSoil); g = mix(g, soil[1], wSoil); b = mix(b, soil[2], wSoil);
        // beaches
        if (ocean && !lavaWorld) { const wb = sstep(14, 3, h); r = mix(r, P.sand[0], wb); g = mix(g, P.sand[1], wb); b = mix(b, P.sand[2], wb); }
        // rock on steep ground and in the high ranges
        const hi = h / Math.max(200, t.plains + t.mAmp * 0.8);
        const wRock = Math.min(1, sstep(0.05, 0.16, slope) + sstep(0.45, 0.85, hi));
        const rk = P.rock || [0.3, 0.3, 0.3], rd2 = P.rockDark || rk, cl = P.cliff || rk;
        const rm = sstep(-0.4, 0.6, n1);
        const rr2 = mix(rd2[0], cl[0], rm), rg2 = mix(rd2[1], cl[1], rm), rb2 = mix(rd2[2], cl[2], rm);
        const rockW = wRock * (desc.type === 'barren' ? 0.6 : 0.85);
        r = mix(r, mix(rk[0], rr2, 0.5), rockW); g = mix(g, mix(rk[1], rg2, 0.5), rockW); b = mix(b, mix(rk[2], rb2, 0.5), rockW);
        if (desc.type === 'barren' || (t.craters || 0) > 0.5) {
          // maria / highlands contrast on airless worlds
          const mare = sstep(0.1, 0.45, nA(x * 1.7 + 9, y * 1.7, z * 1.7));
          const k2 = 1 - mare * 0.35;
          r *= k2; g *= k2; b *= k2;
        }
        // snow: polar caps + high peaks, from temperature
        const wSnow = sstep(0.2, 0.08, temp - Math.max(0, slope - 0.12) * 0.6);
        if (P.snow) { r = mix(r, P.snow[0], wSnow); g = mix(g, P.snow[1], wSnow); b = mix(b, P.snow[2], wSnow); }
        if (lavaWorld) {
          // lava rivers in the lowlands, glowing fissures on the slopes
          const fis = Math.pow(1 - Math.abs(nB(x * 26 + 3, y * 26, z * 26)), 10) * sstep(0.6, 0.0, hi);
          const low = sstep(40, 0, h);
          emis = Math.min(1, low * 0.7 + fis * 0.9);
          const k3 = 1 - emis * 0.5; r *= k3; g *= k3; b *= k3;
        }
      }
      // city lights at night
      if (lights.length && !water) {
        let L = 0;
        for (let q = 0; q < lights.length; q++) {
          const s = lights[q];
          const c = x * s[0] + y * s[1] + z * s[2];
          if (c < s[5]) continue;
          const ang = Math.acos(Math.min(1, c)) / s[4];
          L += s[3] * Math.exp(-ang * ang * 1.4);
        }
        if (megacity) L += 0.32 * sstep(-0.1, 0.5, nA(x * 3 + 1, y * 3, z * 3)) * sstep(2, 30, h) * sstep(0.1, 0.3, temp);
        if (L > 0.002) {
          // speckle: street grids and districts, not a soft blur
          const q = 260;
          const sp = hash3(Math.floor(x * q), Math.floor(y * q), Math.floor(z * q));
          const grain = 0.35 + 0.65 * sstep(0.35, 0.9, sp + L * 0.3);
          emis = Math.max(emis, Math.min(1, L * grain * (0.55 + popF * 0.6)));
        }
      }
      const o = (j * N + i) * 4;
      albedo[o] = toSRGB8(r); albedo[o + 1] = toSRGB8(g); albedo[o + 2] = toSRGB8(b); albedo[o + 3] = Math.round(wmask * 255);
      normal[o] = Math.round((nx * 0.5 + 0.5) * 255); normal[o + 1] = Math.round((ny * 0.5 + 0.5) * 255); normal[o + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      normal[o + 3] = Math.round(Math.sqrt(Math.min(1, emis)) * 255);
    }
    out.push({ albedo, normal });
  }
  return out;
}
