// Quality tiers. Every heavy subsystem scales itself from these knobs rather than sniffing devices.
//   ?quality=low|medium|high|ultra  overrides auto-detection.

const TIERS = {
  low: {
    tier: 'low', dprCap: 1.25, msaa: 0, bloomLevels: 5,
    particles: 0.3,   // multiplier for particle / instance counts
    detail: 0.6,      // geometry density, LOD distance, draw distance multiplier
    shadows: 0,       // shadow map size (0 = off)
    raymarch: 0.5,    // step-count multiplier for volumetrics / ray marching
    simGrid: 48,      // cosmic N-body grid per side
  },
  medium: {
    tier: 'medium', dprCap: 1.5, msaa: 2, bloomLevels: 6,
    particles: 0.6, detail: 0.8, shadows: 1024, raymarch: 0.75, simGrid: 64,
  },
  high: {
    tier: 'high', dprCap: 2, msaa: 4, bloomLevels: 7,
    particles: 1, detail: 1, shadows: 2048, raymarch: 1, simGrid: 80,
  },
  ultra: {
    tier: 'ultra', dprCap: 3, msaa: 4, bloomLevels: 7,
    particles: 2, detail: 1.35, shadows: 4096, raymarch: 1.5, simGrid: 96,
  },
};

export function detectQuality(params = {}) {
  let tier = params.quality;
  if (!TIERS[tier]) {
    const coarse = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
    const small = Math.min(screen.width, screen.height) < 820;
    const mem = navigator.deviceMemory || 8;
    const cores = navigator.hardwareConcurrency || 8;
    if (coarse && small) tier = mem >= 6 && cores >= 8 ? 'medium' : 'low';
    else if (coarse) tier = 'medium';
    else tier = cores >= 8 && mem >= 8 ? 'high' : 'medium';
  }
  const q = { ...TIERS[tier] };
  q.mobile = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
  if (params.dpr) q.dprCap = Math.max(0.5, parseFloat(params.dpr));
  if (params.msaa !== undefined) q.msaa = parseInt(params.msaa, 10) || 0;
  return q;
}
