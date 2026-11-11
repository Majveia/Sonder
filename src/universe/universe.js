// Deterministic universe description. Pure data, no rendering, no three.js (worker-safe).
//
//   const u = new Universe('sonder');
//   u.galaxy(id)                      -> GalaxyDesc      (id 0 = home galaxy "Halcyon")
//   u.system(galaxyId, starIndex)     -> SystemDesc      (starIndex 0 = the galaxy's central black hole)
//   u.home                            -> { galaxy: 0, star: 1, planet: 2 }  (Vesper system, Aurelia)
//
// Everything is a pure function of (universe seed, ids): the same address always yields the same place.
import { RNG, seedFrom, lerp, clamp } from '../core/rng.js';
import { galaxyName, starName, planetName, word } from './names.js';

export const HOME = Object.freeze({ galaxy: 0, star: 1, planet: 2 });

// ---------------------------------------------------------------------------------------------
// Stars
// ---------------------------------------------------------------------------------------------
const STAR_CLASSES = [
  // cls, weight, temp[min,max] K, radius[min,max] Rsun, lum[min,max] Lsun, mass[min,max]
  { cls: 'O', w: 1, temp: [30000, 42000], radius: [6.6, 12], lum: [30000, 300000], mass: [16, 60], kind: 'main', label: 'Blue supergiant' },
  { cls: 'B', w: 3, temp: [10000, 30000], radius: [1.8, 6.6], lum: [25, 30000], mass: [2.1, 16], kind: 'main', label: 'Blue-white star' },
  { cls: 'A', w: 6, temp: [7500, 10000], radius: [1.4, 1.8], lum: [5, 25], mass: [1.4, 2.1], kind: 'main', label: 'White star' },
  { cls: 'F', w: 11, temp: [6000, 7500], radius: [1.15, 1.4], lum: [1.5, 5], mass: [1.04, 1.4], kind: 'main', label: 'Yellow-white star' },
  { cls: 'G', w: 19, temp: [5200, 6000], radius: [0.96, 1.15], lum: [0.6, 1.5], mass: [0.8, 1.04], kind: 'main', label: 'Yellow dwarf' },
  { cls: 'K', w: 25, temp: [3700, 5200], radius: [0.7, 0.96], lum: [0.08, 0.6], mass: [0.45, 0.8], kind: 'main', label: 'Orange dwarf' },
  { cls: 'M', w: 27, temp: [2400, 3700], radius: [0.12, 0.7], lum: [0.0008, 0.08], mass: [0.08, 0.45], kind: 'main', label: 'Red dwarf' },
  { cls: 'M', w: 4, temp: [3000, 4600], radius: [20, 110], lum: [120, 3000], mass: [0.8, 6], kind: 'giant', label: 'Red giant' },
  { cls: 'D', w: 2.2, temp: [8000, 28000], radius: [0.011, 0.014], lum: [0.001, 0.04], mass: [0.5, 1.2], kind: 'dwarf', label: 'White dwarf' },
  { cls: 'N', w: 1.2, temp: [600000, 600000], radius: [0.00002, 0.00002], lum: [0.2, 1.5], mass: [1.3, 2.1], kind: 'pulsar', label: 'Pulsar' },
  { cls: 'X', w: 0.6, temp: [0, 0], radius: [0.0001, 0.0001], lum: [0, 0], mass: [5, 30], kind: 'blackhole', label: 'Stellar black hole' },
];

/** Approximate blackbody colour, linear RGB normalised to max 1. */
export function blackbodyRGB(T) {
  let t = clamp(T, 1000, 40000) / 100, r, g, b;
  r = t <= 66 ? 1 : clamp(1.292936186 * Math.pow(t - 60, -0.1332047592), 0, 1);
  g = t <= 66 ? clamp(0.390081579 * Math.log(t) - 0.631841444, 0, 1) : clamp(1.129890861 * Math.pow(t - 60, -0.0755148492), 0, 1);
  b = t >= 66 ? 1 : (t <= 19 ? 0 : clamp(0.543206789 * Math.log(t - 10) - 1.196254089, 0, 1));
  return [r * r, g * g, b * b];
}

function makeStar(rng, forced) {
  const c = forced || rng.weighted(STAR_CLASSES.map((s) => [s, s.w]));
  const k = rng.next();
  const temp = lerp(c.temp[0], c.temp[1], k);
  const star = {
    cls: c.cls, kind: c.kind, label: c.label,
    tempK: Math.round(temp),
    radiusSun: lerp(c.radius[0], c.radius[1], k),
    massSun: lerp(c.mass[0], c.mass[1], k),
    lumSun: c.lum[0] * Math.pow(c.lum[1] / Math.max(1e-6, c.lum[0]), k) || 0,
    color: c.kind === 'blackhole' ? [0, 0, 0] : c.kind === 'pulsar' ? [0.62, 0.78, 1.0] : blackbodyRGB(temp),
  };
  if (c.kind === 'main') star.spectral = `${c.cls}${Math.floor((1 - k) * 9.99)}V`;
  else if (c.kind === 'giant') star.spectral = `M${Math.floor((1 - k) * 6)}III`;
  else if (c.kind === 'dwarf') star.spectral = 'DA';
  else star.spectral = c.kind === 'pulsar' ? 'PSR' : 'BH';
  return star;
}

// ---------------------------------------------------------------------------------------------
// Planet archetypes. `terrain` feeds PlanetModel (heights in metres on a small walkable world),
// `palette` (sRGB hex) feeds terrain / flora / sky shading, `atmosphere`/`ocean`/`life` the rest.
// ---------------------------------------------------------------------------------------------
const ARCH = {
  terran: {
    label: 'Verdant world',
    terrain: { cf: 1.15, seaBias: 0.03, oceanDepth: 240, plains: 130, mAmp: 760, mFreq: 5.2, hAmp: 55, hFreq: 34, dAmp: 4.5, dFreq: 420, warp: 0.32, dunes: 0, terrace: 0, craters: 0, spires: 0 },
    palette: { sand: '#d9c9a0', soil: '#6b5136', grass: '#5d9e3e', grassDry: '#a8a850', forest: '#2e6b33', rock: '#7d7870', rockDark: '#4a463f', cliff: '#8d8474', snow: '#f4f7fb', flora1: '#3f8f45', flora2: '#e8c34a', glow: '#ffe9a8' },
    atmosphere: { density: 1.0, rayleigh: [5.8, 13.5, 33.1], mie: 1.0, sky: '#3f84e6', horizon: '#bcd8f5', sunset: '#ff9a4d', fog: 0.35, cloud: { cover: 0.45, color: '#ffffff', altitude: 900 } },
    ocean: { shallow: '#3fc4b8', deep: '#0b3f78', kind: 'water' },
    life: { flora: 0.9, fauna: 0.8, kind: 'earthlike' }, tempBase: 0.62,
  },
  ocean: {
    label: 'Ocean world',
    terrain: { cf: 1.3, seaBias: -0.3, oceanDepth: 420, plains: 70, mAmp: 380, mFreq: 6.5, hAmp: 40, hFreq: 38, dAmp: 4, dFreq: 420, warp: 0.4, dunes: 0, terrace: 0, craters: 0, spires: 0 },
    palette: { sand: '#efe2bd', soil: '#5c4a38', grass: '#4fae6a', grassDry: '#9dbf6a', forest: '#1f7a5a', rock: '#6f7682', rockDark: '#3b414c', cliff: '#7c8794', snow: '#f5fbff', flora1: '#2f9d7c', flora2: '#ff7fa8', glow: '#7ff5ff' },
    atmosphere: { density: 1.1, rayleigh: [5.2, 12.5, 30.0], mie: 1.3, sky: '#2f7fe0', horizon: '#c9e6f7', sunset: '#ff8f6b', fog: 0.5, cloud: { cover: 0.6, color: '#ffffff', altitude: 800 } },
    ocean: { shallow: '#35d0c0', deep: '#062a66', kind: 'water' },
    life: { flora: 0.7, fauna: 0.9, kind: 'earthlike' }, tempBase: 0.68,
  },
  desert: {
    label: 'Desert world',
    terrain: { cf: 0.9, seaBias: 0.55, oceanDepth: 0, plains: 90, mAmp: 520, mFreq: 4.2, hAmp: 28, hFreq: 30, dAmp: 3, dFreq: 380, warp: 0.3, dunes: 20, duneFreq: 150, terrace: 0.8, terraceStep: 64, craters: 0, spires: 0.12 },
    palette: { sand: '#e3b87a', soil: '#b5764a', grass: '#b8a25a', grassDry: '#c9a86a', forest: '#7a8a4a', rock: '#b06a4a', rockDark: '#6e3f30', cliff: '#c98058', snow: '#f7efe2', flora1: '#8a9a4f', flora2: '#e0563a', glow: '#ffd27a' },
    atmosphere: { density: 0.8, rayleigh: [9.5, 11.0, 14.0], mie: 2.4, sky: '#7fb0d8', horizon: '#f2d6a8', sunset: '#ff6f3a', fog: 0.55, cloud: { cover: 0.08, color: '#fff1dc', altitude: 1400 } },
    ocean: null,
    life: { flora: 0.25, fauna: 0.35, kind: 'arid' }, tempBase: 0.85,
  },
  jungle: {
    label: 'Jungle world',
    terrain: { cf: 1.5, seaBias: 0.12, oceanDepth: 120, plains: 90, mAmp: 520, mFreq: 6.0, hAmp: 70, hFreq: 40, dAmp: 5, dFreq: 430, warp: 0.5, dunes: 0, terrace: 0.25, terraceStep: 45, craters: 0, spires: 0.5 },
    palette: { sand: '#c9b98a', soil: '#4a3524', grass: '#3f9a3a', grassDry: '#7fae3f', forest: '#17592c', rock: '#5f6a5c', rockDark: '#2f3a30', cliff: '#6d7a66', snow: '#eef7ee', flora1: '#1f8a3f', flora2: '#ff4fd0', glow: '#9dff7a' },
    atmosphere: { density: 1.4, rayleigh: [5.0, 14.5, 26.0], mie: 2.2, sky: '#4fa0c8', horizon: '#cfeedd', sunset: '#ffb04f', fog: 0.9, cloud: { cover: 0.75, color: '#f4fff8', altitude: 700 } },
    ocean: { shallow: '#4fd0a0', deep: '#0c4a48', kind: 'water' },
    life: { flora: 1.0, fauna: 1.0, kind: 'earthlike' }, tempBase: 0.8,
  },
  fungal: {
    label: 'Bioluminescent moon',
    terrain: { cf: 1.6, seaBias: 0.1, oceanDepth: 90, plains: 80, mAmp: 420, mFreq: 6.5, hAmp: 60, hFreq: 42, dAmp: 5, dFreq: 430, warp: 0.6, dunes: 0, terrace: 0.3, terraceStep: 38, craters: 0, spires: 0.7 },
    palette: { sand: '#5a5f8a', soil: '#2a2440', grass: '#2f6f8a', grassDry: '#5a4f9a', forest: '#1c3f66', rock: '#3d3a5c', rockDark: '#1c1a30', cliff: '#4a4770', snow: '#cfe6ff', flora1: '#27d3c6', flora2: '#c44dff', glow: '#5fffe0' },
    atmosphere: { density: 1.3, rayleigh: [14.0, 9.0, 30.0], mie: 2.0, sky: '#3b2f8a', horizon: '#7a5fd0', sunset: '#ff5fc8', fog: 1.0, cloud: { cover: 0.5, color: '#b9a8ff', altitude: 650 } },
    ocean: { shallow: '#35e0d0', deep: '#141a5c', kind: 'water' },
    life: { flora: 1.0, fauna: 0.8, kind: 'fungal' }, tempBase: 0.6,
  },
  ice: {
    label: 'Ice world',
    terrain: { cf: 1.1, seaBias: 0.4, oceanDepth: 0, plains: 80, mAmp: 620, mFreq: 5.0, hAmp: 45, hFreq: 30, dAmp: 3.5, dFreq: 400, warp: 0.35, dunes: 6, duneFreq: 110, terrace: 0.15, terraceStep: 50, craters: 0.15, spires: 0.25 },
    palette: { sand: '#cfdcea', soil: '#8fa3b8', grass: '#b8d0e0', grassDry: '#a8bccc', forest: '#7fa0b8', rock: '#6b7f96', rockDark: '#3a4a5e', cliff: '#8aa5c0', snow: '#f8fcff', flora1: '#9fe8ff', flora2: '#d0b8ff', glow: '#a8f0ff' },
    atmosphere: { density: 0.6, rayleigh: [4.0, 10.0, 26.0], mie: 0.8, sky: '#5f9ae0', horizon: '#dff0ff', sunset: '#ffb0d0', fog: 0.4, cloud: { cover: 0.25, color: '#ffffff', altitude: 1100 } },
    ocean: null,
    life: { flora: 0.1, fauna: 0.15, kind: 'crystal' }, tempBase: 0.12,
  },
  lava: {
    label: 'Molten world',
    terrain: { cf: 1.4, seaBias: 0.1, oceanDepth: 60, plains: 110, mAmp: 900, mFreq: 4.6, hAmp: 60, hFreq: 28, dAmp: 6, dFreq: 360, warp: 0.5, dunes: 0, terrace: 0.2, terraceStep: 55, craters: 0.1, spires: 0.45 },
    palette: { sand: '#3a3030', soil: '#241c1c', grass: '#3d3232', grassDry: '#4a3a34', forest: '#2a2222', rock: '#2f2a2c', rockDark: '#141214', cliff: '#3b3336', snow: '#8a7a74', flora1: '#ff7a2a', flora2: '#ffd04a', glow: '#ff5a1a' },
    atmosphere: { density: 0.9, rayleigh: [20.0, 9.0, 5.0], mie: 3.0, sky: '#5a2418', horizon: '#ff7a3a', sunset: '#ffcf5a', fog: 0.9, cloud: { cover: 0.35, color: '#5a3a34', altitude: 1000 } },
    ocean: { shallow: '#ffb03a', deep: '#ff4a12', kind: 'lava' },
    life: { flora: 0.0, fauna: 0.05, kind: 'none' }, tempBase: 1.0,
  },
  barren: {
    label: 'Barren world',
    terrain: { cf: 1.0, seaBias: 0.5, oceanDepth: 0, plains: 70, mAmp: 520, mFreq: 4.0, hAmp: 40, hFreq: 26, dAmp: 3, dFreq: 380, warp: 0.2, dunes: 0, terrace: 0, craters: 1.0, spires: 0 },
    palette: { sand: '#9a948c', soil: '#6f6a64', grass: '#8a8580', grassDry: '#8a8580', forest: '#77726c', rock: '#77726c', rockDark: '#3d3a37', cliff: '#8c8680', snow: '#e8e8ec', flora1: '#a0a0a0', flora2: '#c0c0c8', glow: '#cfe0ff' },
    atmosphere: null,
    ocean: null,
    life: { flora: 0, fauna: 0, kind: 'none' }, tempBase: 0.4,
  },
  crystal: {
    label: 'Crystal world',
    terrain: { cf: 1.2, seaBias: 0.35, oceanDepth: 0, plains: 80, mAmp: 560, mFreq: 5.5, hAmp: 40, hFreq: 34, dAmp: 3.5, dFreq: 400, warp: 0.35, dunes: 0, terrace: 0.5, terraceStep: 40, craters: 0.1, spires: 1.0 },
    palette: { sand: '#b8a8d8', soil: '#5a4a7a', grass: '#8a7ac8', grassDry: '#a890d0', forest: '#5a4aa0', rock: '#6a5a9a', rockDark: '#2a2248', cliff: '#8f7fd0', snow: '#f0e8ff', flora1: '#7ff0ff', flora2: '#ff8ae8', glow: '#b8f8ff' },
    atmosphere: { density: 0.7, rayleigh: [12.0, 8.0, 28.0], mie: 1.0, sky: '#4a3aa8', horizon: '#c8b0ff', sunset: '#ff8ad8', fog: 0.5, cloud: { cover: 0.2, color: '#e8d8ff', altitude: 1200 } },
    ocean: null,
    life: { flora: 0.3, fauna: 0.2, kind: 'crystal' }, tempBase: 0.35,
  },
  gas: {
    label: 'Gas giant',
    terrain: null,
    palette: { band1: '#d8b890', band2: '#a87850', band3: '#f0e0c0', storm: '#c8553a', glow: '#ffe0b0' },
    atmosphere: { density: 3, rayleigh: [8, 10, 14], mie: 2, sky: '#d8b890', horizon: '#f0e0c0', sunset: '#ff9a5a', fog: 1, cloud: { cover: 1, color: '#f0e0c0', altitude: 0 } },
    ocean: null, life: { flora: 0, fauna: 0, kind: 'none' }, tempBase: 0.2,
  },
  icegiant: {
    label: 'Ice giant',
    terrain: null,
    palette: { band1: '#7fc8e8', band2: '#4a8fd0', band3: '#c8f0ff', storm: '#ffffff', glow: '#bfefff' },
    atmosphere: { density: 3, rayleigh: [4, 9, 20], mie: 1.5, sky: '#7fc8e8', horizon: '#c8f0ff', sunset: '#b0c8ff', fog: 1, cloud: { cover: 1, color: '#c8f0ff', altitude: 0 } },
    ocean: null, life: { flora: 0, fauna: 0, kind: 'none' }, tempBase: 0.08,
  },
};
export const ARCHETYPES = ARCH;

const CIV_STYLES = {
  // style -> architecture language the civilisation module interprets
  whitestone: { label: 'Hill towns of white stone and wind', people: 'the Aurel' },
  sandstone: { label: 'Caravan cities carved from mesa rock', people: 'the Sirocci' },
  stilt: { label: 'Tidal cities on stilts and floats', people: 'the Thalassans' },
  neon: { label: 'A rain-lit megacity that never sleeps', people: 'the Noctians' },
  organic: { label: 'Grown dwellings among glowing giants', people: 'the Myceli' },
  monolith: { label: 'Silent monuments older than their star', people: 'the Makers' },
  frontier: { label: 'Scattered frontier outposts', people: 'settlers' },
};
export const CIVS = CIV_STYLES;

function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }

function basePlanet(type, seed) {
  const a = ARCH[type];
  return {
    seed, type, label: a.label,
    terrain: clone(a.terrain), palette: clone(a.palette), atmosphere: clone(a.atmosphere), ocean: clone(a.ocean), life: clone(a.life),
    tempBase: a.tempBase,
    landable: !!a.terrain,
    rings: null, moons: [], civ: null, parent: null, signature: null, mood: null,
  };
}

// ---------------------------------------------------------------------------------------------
// The home system — hand-authored "signature worlds", each with its own art direction.
// ---------------------------------------------------------------------------------------------
function homeSystem(seed) {
  const star = { cls: 'G', kind: 'main', label: 'Yellow dwarf', spectral: 'G2V', tempK: 5780, radiusSun: 1.0, massSun: 1.0, lumSun: 1.0, color: blackbodyRGB(5780) };
  const P = (type, name, over) => {
    const p = basePlanet(type, seedFrom(seed, name));
    p.name = name;
    Object.assign(p, over);
    if (over.terrainOver) Object.assign(p.terrain, over.terrainOver);
    if (over.paletteOver) Object.assign(p.palette, over.paletteOver);
    if (over.atmoOver && p.atmosphere) {
      const { cloud, ...rest } = over.atmoOver;
      Object.assign(p.atmosphere, rest);
      if (cloud) Object.assign(p.atmosphere.cloud, cloud);
    }
    delete p.terrainOver; delete p.paletteOver; delete p.atmoOver;
    return p;
  };
  const planets = [
    P('lava', 'Cinder', {
      signature: 'cinder', orbit: { a: 0.32, e: 0.04, inc: 0.05, periodDays: 66, phase: 0.8 },
      radiusKm: 3100, gameRadius: 5200, gravity: 7.2, tilt: 0.02, dayLength: 2400,
      mood: { title: 'Cinder', line: 'A world still being forged.', inspiration: 'Turner seascapes, Beksinski, Mustafar', music: 'ember' },
    }),
    P('desert', 'Sirocco', {
      signature: 'sirocco', orbit: { a: 0.61, e: 0.02, inc: 0.03, periodDays: 171, phase: 2.2 },
      radiusKm: 5200, gameRadius: 8200, gravity: 8.6, tilt: 0.12, dayLength: 1500,
      civ: { style: 'sandstone', level: 'caravan', population: 4.1e6, cities: 9 },
      atmoOver: { sky: '#74bcc8', horizon: '#f6d9a6', sunset: '#ff6a3d' },
      paletteOver: { sand: '#e8b27a', rock: '#c0664a', cliff: '#d98a5c', flora2: '#3fb8b0' },
      mood: { title: 'Sirocco', line: 'Pastel mesas, slow caravans, a sky like old paper.', inspiration: 'Moebius, Dune, Lawrence of Arabia', music: 'dune' },
    }),
    P('terran', 'Aurelia', {
      signature: 'aurelia', orbit: { a: 1.0, e: 0.017, inc: 0.0, periodDays: 365, phase: 4.1 },
      radiusKm: 6370, gameRadius: 9000, gravity: 9.8, tilt: 0.41, dayLength: 1440,
      civ: { style: 'whitestone', level: 'pastoral', population: 2.3e8, cities: 14 },
      moons: [{ name: 'Lume', radiusKm: 1700, distRadii: 9, periodDays: 27, seed: seedFrom(seed, 'Lume'), type: 'barren', color: '#d8d4cc' }],
      paletteOver: { grass: '#62b043', forest: '#2f7a3a', flora2: '#f2c84b' },
      mood: { title: 'Aurelia', line: 'Wind in tall grass. White towns on green hills.', inspiration: 'Miyazaki, Breath of the Wild, Constable skies', music: 'meadow' },
    }),
    P('ocean', 'Thalassa', {
      signature: 'thalassa', orbit: { a: 1.42, e: 0.03, inc: 0.02, periodDays: 618, phase: 0.4 },
      radiusKm: 7100, gameRadius: 9800, gravity: 10.4, tilt: 0.3, dayLength: 1680,
      civ: { style: 'stilt', level: 'maritime', population: 3.6e7, cities: 10 },
      moons: [
        { name: 'Ebb', radiusKm: 900, distRadii: 7, periodDays: 11, seed: seedFrom(seed, 'Ebb'), type: 'barren', color: '#b8c4d0' },
        { name: 'Flow', radiusKm: 1300, distRadii: 12, periodDays: 31, seed: seedFrom(seed, 'Flow'), type: 'ice', color: '#dfeeff' },
      ],
      mood: { title: 'Thalassa', line: 'One ocean, thinking slowly.', inspiration: "Tarkovsky's Solaris, Hokusai, Ponyo", music: 'tide' },
    }),
    P('terran', 'Noctis', {
      signature: 'noctis', orbit: { a: 1.9, e: 0.05, inc: 0.06, periodDays: 957, phase: 5.3 },
      radiusKm: 5900, gameRadius: 8600, gravity: 9.1, tilt: 0.08, dayLength: 5400,
      civ: { style: 'neon', level: 'megacity', population: 4.2e10, cities: 12 },
      terrainOver: { seaBias: 0.22, mAmp: 420, plains: 70, hAmp: 30 },
      paletteOver: { sand: '#4a4a52', soil: '#2a2a30', grass: '#33403f', grassDry: '#3d3d44', forest: '#1f2e30', rock: '#3a3c44', rockDark: '#17181d', cliff: '#454852', snow: '#9aa0aa', flora1: '#2ad0c8', flora2: '#ff3fa0', glow: '#ff4fd8' },
      atmoOver: { density: 1.6, rayleigh: [9.0, 9.5, 16.0], mie: 4.0, sky: '#1b2540', horizon: '#5a4a6a', sunset: '#ff5f8a', fog: 1.4, cloud: { cover: 0.85, color: '#6a6a80', altitude: 600 } },
      ocean: { shallow: '#22505a', deep: '#06121e', kind: 'water' },
      weather: 'rain',
      mood: { title: 'Noctis', line: 'Rain, neon, and forty billion stories.', inspiration: 'Blade Runner, Cowboy Bebop, Wong Kar-wai', music: 'noir' },
    }),
    P('gas', 'Leviathan', {
      signature: 'leviathan', orbit: { a: 5.1, e: 0.048, inc: 0.02, periodDays: 4300, phase: 1.3 },
      radiusKm: 69000, gameRadius: 0, gravity: 24, tilt: 0.42, dayLength: 600,
      rings: { inner: 1.35, outer: 2.4, color: '#e8d2b0', color2: '#9a7f66', opacity: 0.85 },
      paletteOver: { band1: '#e0c090', band2: '#b07848', band3: '#f4e6c8', storm: '#d0583a' },
      mood: { title: 'Leviathan', line: 'A storm older than memory.', inspiration: '2001: A Space Odyssey, Cassini photographs', music: 'giant' },
    }),
    P('fungal', 'Mycelia', {
      signature: 'mycelia', parent: 5, orbit: { a: 6.2, e: 0.01, inc: 0.02, periodDays: 9, phase: 0.2 }, // a in parent radii
      radiusKm: 2600, gameRadius: 6000, gravity: 6.4, tilt: 0.05, dayLength: 1800,
      civ: { style: 'organic', level: 'symbiotic', population: 8.0e5, cities: 7 },
      mood: { title: 'Mycelia', line: 'The forest glows because it is listening.', inspiration: 'Nausicaa, Annihilation, Avatar', music: 'spore' },
    }),
    P('ice', 'Hyperborea', {
      signature: 'hyperborea', parent: 5, orbit: { a: 10.5, e: 0.02, inc: 0.04, periodDays: 21, phase: 3.9 },
      radiusKm: 2100, gameRadius: 5600, gravity: 5.8, tilt: 0.1, dayLength: 2100,
      civ: { style: 'monolith', level: 'vanished', population: 0, cities: 5 },
      aurora: true,
      mood: { title: 'Hyperborea', line: 'Something was left here for us to find.', inspiration: 'Kubrick, At the Mountains of Madness, Caspar David Friedrich', music: 'glass' },
    }),
    P('crystal', 'Eremos', {
      signature: 'eremos', orbit: { a: 11.8, e: 0.11, inc: 0.12, periodDays: 14800, phase: 2.9 },
      radiusKm: 1900, gameRadius: 5000, gravity: 4.9, tilt: 0.6, dayLength: 3000,
      civ: { style: 'monolith', level: 'vanished', population: 0, cities: 3 },
      mood: { title: 'Eremos', line: 'The edge of the map, singing quietly.', inspiration: 'Zdzislaw Beksinski, Journey, Arrival', music: 'glass' },
    }),
  ];
  planets.forEach((p, i) => { p.index = i; p.id = `0:1:${i}`; });
  return {
    id: '0:1', galaxy: 0, index: 1, seed, name: 'Vesper', home: true,
    star, companion: null, phenomenon: null,
    planets,
    belts: [{ innerAU: 2.6, outerAU: 3.4, count: 2600, color: '#8a8078' }, { innerAU: 16, outerAU: 22, count: 1800, color: '#b0c4d8', icy: true }],
    comets: 3,
    description: 'A quiet yellow star and the worlds that taught us to look up.',
  };
}

// ---------------------------------------------------------------------------------------------
export class Universe {
  constructor(seed = 'sonder') {
    this.seedStr = String(seed);
    this.seed = seedFrom(this.seedStr);
    this.home = HOME;
    this._gal = new Map();
    this._sys = new Map();
    // Real cosmological parameters used by the cosmic web simulation (Planck 2018-ish).
    this.cosmology = { H0: 67.4, omegaM: 0.315, omegaL: 0.685, omegaB: 0.049, sigma8: 0.811, ns: 0.965, boxMpc: 300, ageGyr: 13.8 };
  }

  galaxy(id) {
    id = Math.floor(id);
    if (this._gal.has(id)) return this._gal.get(id);
    const rng = new RNG(this.seed, 'galaxy', id);
    let g;
    if (id === 0) {
      g = { id, seed: rng.seed, name: 'Halcyon', type: 'barred', arms: 4, pitch: 0.24, radiusLy: 52000, bulge: 0.38, starCount: 2.4e11, ageGyr: 13.1, hue: 0.0, active: false, home: true, tilt: [0.35, 0.1] };
    } else {
      const type = rng.weighted([['spiral', 40], ['barred', 24], ['elliptical', 14], ['lenticular', 8], ['irregular', 9], ['ring', 5]]);
      g = {
        id, seed: rng.seed, type, name: galaxyName(rng, type),
        arms: type === 'spiral' || type === 'barred' ? rng.weighted([[2, 5], [3, 2], [4, 4], [5, 1], [6, 1]]) : 0,
        pitch: rng.float(0.16, 0.42),
        radiusLy: Math.round(rng.float(18000, 110000)),
        bulge: type === 'elliptical' ? 1 : rng.float(0.15, 0.6),
        starCount: Math.pow(10, rng.float(9.6, 12.1)),
        ageGyr: rng.float(3, 13.4),
        hue: rng.float(-1, 1),      // -1 older/redder ... +1 younger/bluer star-forming
        active: rng.chance(0.08),   // active nucleus / quasar
        home: false,
        tilt: [rng.float(-1.2, 1.2), rng.float(-1.2, 1.2)],
      };
    }
    g.blackHoleMassSun = Math.pow(10, 6 + (g.bulge) * 3 + (rng.next() - 0.5));
    this._gal.set(id, g);
    return g;
  }

  system(galaxyId, starIndex) {
    galaxyId = Math.floor(galaxyId); starIndex = Math.floor(starIndex);
    const key = `${galaxyId}:${starIndex}`;
    if (this._sys.has(key)) return this._sys.get(key);
    const rng = new RNG(this.seed, 'system', galaxyId, starIndex);
    let s;
    if (galaxyId === HOME.galaxy && starIndex === HOME.star) s = homeSystem(rng.seed);
    else if (starIndex === 0) s = this._coreSystem(galaxyId, rng);
    else s = this._proceduralSystem(galaxyId, starIndex, rng);
    this._sys.set(key, s);
    return s;
  }

  _coreSystem(galaxyId, rng) {
    const g = this.galaxy(galaxyId);
    return {
      id: `${galaxyId}:0`, galaxy: galaxyId, index: 0, seed: rng.seed,
      name: galaxyId === 0 ? 'Sagitta A*' : `${g.name.split(' ')[0]} Core`,
      star: { cls: 'X', kind: 'blackhole', label: 'Supermassive black hole', spectral: 'SMBH', tempK: 0, radiusSun: 0, massSun: g.blackHoleMassSun, lumSun: 0, color: [0, 0, 0], supermassive: true, spin: rng.float(0.4, 0.98), diskTempK: rng.float(4500, 9000) },
      companion: null, phenomenon: 'blackhole', planets: [], belts: [], comets: 0,
      description: 'Where the galaxy keeps its silence. Light bends; time slows.',
    };
  }

  _proceduralSystem(galaxyId, starIndex, rng) {
    const star = makeStar(rng);
    const name = starName(rng);
    const sys = {
      id: `${galaxyId}:${starIndex}`, galaxy: galaxyId, index: starIndex, seed: rng.seed, name, star,
      companion: null, phenomenon: null, planets: [], belts: [], comets: rng.int(0, 4), description: '',
    };
    if (star.kind === 'blackhole') { sys.phenomenon = 'blackhole'; star.spin = rng.float(0.2, 0.95); star.diskTempK = rng.float(5000, 12000); }
    else if (star.kind === 'pulsar') sys.phenomenon = 'pulsar';
    else if (rng.chance(0.16)) { sys.companion = makeStar(rng.fork('companion')); sys.phenomenon = 'binary'; }
    if (star.kind === 'giant' && rng.chance(0.3)) sys.phenomenon = 'nebula';

    const L = Math.max(star.lumSun, 0.0005);
    const hz = Math.sqrt(L); // AU, centre of the habitable zone
    const nPlanets = star.kind === 'blackhole' ? rng.int(0, 3) : star.kind === 'pulsar' ? rng.int(0, 3) : rng.int(2, 9);
    let a = hz * rng.float(0.18, 0.42);
    let giantIndex = -1;
    for (let i = 0; i < nPlanets; i++) {
      const r = a / hz;
      let type;
      if (r < 0.4) type = rng.weighted([['lava', 6], ['barren', 4]]);
      else if (r < 0.78) type = rng.weighted([['desert', 5], ['barren', 3], ['lava', 1], ['crystal', 1]]);
      else if (r < 1.45) type = rng.weighted([['terran', 4], ['ocean', 3], ['jungle', 3], ['desert', 2], ['fungal', 1.5], ['crystal', 1]]);
      else if (r < 2.6) type = rng.weighted([['ice', 4], ['barren', 3], ['desert', 1], ['crystal', 1.5], ['gas', 2]]);
      else type = rng.weighted([['gas', 5], ['icegiant', 3], ['ice', 3], ['barren', 1]]);
      const prng = rng.fork('planet', i);
      const p = basePlanet(type, prng.seed);
      p.index = sys.planets.length;
      const giant = type === 'gas' || type === 'icegiant';
      p.orbit = { a, e: prng.float(0, 0.12), inc: prng.float(-0.08, 0.08), periodDays: 365 * Math.sqrt((a * a * a) / Math.max(0.08, star.massSun)), phase: prng.float(0, Math.PI * 2) };
      p.radiusKm = giant ? prng.float(22000, 74000) : prng.float(1900, 8200);
      p.gameRadius = giant ? 0 : Math.round(lerp(4600, 10000, clamp((p.radiusKm - 1900) / 6300, 0, 1)) / 100) * 100;
      p.gravity = giant ? prng.float(9, 26) : lerp(4.5, 12.5, clamp((p.radiusKm - 1900) / 6300, 0, 1));
      p.tilt = prng.float(0, 0.5);
      p.dayLength = Math.round(prng.float(900, 2400));
      if (giant) {
        giantIndex = p.index;
        if (prng.chance(0.6)) p.rings = { inner: prng.float(1.25, 1.6), outer: prng.float(1.9, 2.8), color: prng.pick(['#e8d2b0', '#cfd8e8', '#d8b8a0', '#b8c8d8']), color2: '#8a7a70', opacity: prng.float(0.4, 0.9) };
        this._tintGiant(p, prng);
      } else {
        this._varyPlanet(p, prng, star);
        if (prng.chance(0.07)) p.rings = { inner: 1.4, outer: prng.float(1.8, 2.3), color: '#d8ccc0', color2: '#8a8078', opacity: 0.5 };
      }
      const inhabited = p.life.fauna > 0.4 && prng.chance(0.55) || (p.landable && prng.chance(0.08));
      if (inhabited && p.landable) {
        const style = p.type === 'desert' ? 'sandstone' : p.type === 'ocean' ? 'stilt' : p.type === 'fungal' || p.type === 'jungle' ? 'organic'
          : p.type === 'ice' || p.type === 'crystal' || p.type === 'barren' ? prng.pick(['monolith', 'frontier']) : prng.pick(['whitestone', 'neon', 'frontier']);
        p.civ = { style, level: style === 'monolith' ? 'vanished' : prng.pick(['frontier', 'pastoral', 'industrial', 'spacefaring']), population: Math.round(Math.pow(10, prng.float(3, 9.5))), cities: prng.int(3, 10) };
      }
      p.name = planetName(prng, name, p.index, !!p.civ);
      p.id = `${sys.id}:${p.index}`;
      const nm = giant ? prng.int(1, 4) : prng.weighted([[0, 5], [1, 4], [2, 1]]);
      for (let m = 0; m < nm; m++) {
        p.moons.push({ name: word(prng, 'soft'), radiusKm: prng.float(300, 1800), distRadii: (giant ? 4 : 6) + m * prng.float(2.5, 4.5), periodDays: prng.float(2, 40), seed: prng.fork('moon', m).seed, type: prng.pick(['barren', 'ice', 'barren']), color: prng.pick(['#c8c4bc', '#dfe8f0', '#b8a898', '#a8b0b8']) });
      }
      sys.planets.push(p);
      a *= rng.float(1.42, 2.05);
    }
    if (rng.chance(0.55) && nPlanets > 2) {
      const at = hz * rng.float(2.0, 3.2);
      sys.belts.push({ innerAU: at, outerAU: at * rng.float(1.2, 1.5), count: rng.int(1200, 3200), color: '#8a8078' });
    }
    const life = sys.planets.filter((p) => p.civ).length;
    sys.description = sys.phenomenon === 'blackhole' ? 'A collapsed star, wearing its last light as a ring.'
      : sys.phenomenon === 'pulsar' ? 'A dead star keeping perfect time.'
      : sys.phenomenon === 'binary' ? 'Two suns in a slow waltz.'
      : life ? `${life} inhabited world${life > 1 ? 's' : ''}.` : `${sys.planets.length} worlds, unvisited.`;
    void giantIndex;
    return sys;
  }

  _tintGiant(p, rng) {
    const sets = p.type === 'gas'
      ? [['#e0c090', '#b07848', '#f4e6c8', '#d0583a'], ['#d8c8a8', '#8a6a58', '#f0e8d8', '#b05038'], ['#c8a0d8', '#6a4a9a', '#f0d8ff', '#ff7ab0'], ['#a8d8a0', '#4a8a6a', '#e0f8d8', '#f0e070'], ['#f0a878', '#a0483a', '#ffe0c0', '#fff0a0']]
      : [['#7fc8e8', '#4a8fd0', '#c8f0ff', '#ffffff'], ['#6ad8c8', '#2a8a9a', '#c0fff0', '#ffffff'], ['#8a9af0', '#4a4ac0', '#d0d8ff', '#ffffff']];
    const s = rng.pick(sets);
    p.palette = { band1: s[0], band2: s[1], band3: s[2], storm: s[3], glow: s[2] };
  }

  /** Give procedural worlds individuality: palette hue drift, terrain variation, sky tint by star colour. */
  _varyPlanet(p, rng, star) {
    const t = p.terrain;
    t.cf *= rng.float(0.8, 1.3); t.seaBias += rng.float(-0.08, 0.08);
    t.mAmp *= rng.float(0.6, 1.4); t.mFreq *= rng.float(0.8, 1.3);
    t.hAmp *= rng.float(0.7, 1.5); t.warp *= rng.float(0.7, 1.5);
    if (rng.chance(0.25)) t.terrace = Math.max(t.terrace, rng.float(0.3, 0.8)), t.terraceStep = t.terraceStep || rng.float(35, 80);
    if (rng.chance(0.2)) t.spires = Math.max(t.spires, rng.float(0.3, 0.9));
    const shift = rng.float(-0.09, 0.09);
    for (const k of Object.keys(p.palette)) p.palette[k] = shiftHue(p.palette[k], shift * (k === 'snow' ? 0.2 : 1), rng.float(0.9, 1.12));
    if (rng.chance(0.3) && p.life.flora > 0.3) {
      // alien chlorophyll: push vegetation to a different hue
      const h = rng.pick([0.45, 0.62, 0.78, 0.92, 0.05]);
      for (const k of ['grass', 'forest', 'flora1', 'grassDry']) p.palette[k] = setHue(p.palette[k], h + rng.float(-0.04, 0.04));
    }
    if (p.atmosphere) {
      p.atmosphere.density *= rng.float(0.7, 1.4);
      p.atmosphere.cloud.cover = clamp(p.atmosphere.cloud.cover * rng.float(0.5, 1.6), 0, 0.95);
      if (star.tempK < 4000) { p.atmosphere.sunset = '#ff5a3a'; }
      if (rng.chance(0.25)) {
        const h = rng.next();
        p.atmosphere.sky = setHue(p.atmosphere.sky, h); p.atmosphere.horizon = setHue(p.atmosphere.horizon, h + 0.06);
        p.atmosphere.rayleigh = rng.shuffle([...p.atmosphere.rayleigh]);
      }
    }
    if (p.ocean && rng.chance(0.3)) { const h = rng.next(); p.ocean.shallow = setHue(p.ocean.shallow, h); p.ocean.deep = setHue(p.ocean.deep, h + 0.05); }
    p.aurora = rng.chance(p.type === 'ice' ? 0.6 : 0.12);
    p.mood = null;
  }
}

// --- tiny colour helpers (hex <-> hsl) ---------------------------------------------------------
function hexToHsl(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  let h = 0, s = 0;
  if (mx !== mn) {
    const d = mx - mn;
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6;
  }
  return [h, s, l];
}
function hslToHex(h, s, l) {
  h = ((h % 1) + 1) % 1; s = clamp(s, 0, 1); l = clamp(l, 0, 1);
  const f = (n) => {
    const k = (n + h * 12) % 12, a = s * Math.min(l, 1 - l);
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return '#' + [f(0), f(8), f(4)].map((v) => v.toString(16).padStart(2, '0')).join('');
}
export function shiftHue(hex, dh, satMul = 1) { const [h, s, l] = hexToHsl(hex); return hslToHex(h + dh, s * satMul, l); }
export function setHue(hex, h) { const [, s, l] = hexToHsl(hex); return hslToHex(h, s, l); }
