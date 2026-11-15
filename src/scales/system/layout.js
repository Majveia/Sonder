// Star-system layout: the compressed scale mapping + Keplerian orbits. Pure math (no three.js).
//
// ── SCALE COMPRESSION ─────────────────────────────────────────────────────────────────────────
// True scale is unplayable (Aurelia would be a 0.003° dot seen from Cinder). One consistent,
// monotonic mapping is applied to every system so that order and ratios are preserved, nothing
// intersects, and a full crossing takes ~15–30 s:
//
//   orbits     r_world = clearance + R0 · (r_AU / hz)^P           R0 = 1000 u, P = 0.55
//              hz = √L★ (AU, centre of the habitable zone) — distances are measured in
//              "habitable-zone units", so a red-dwarf system and a giant's system both span
//              ~600–5000 u. Bodies follow TRUE Keplerian ellipses in AU space; only the radial
//              distance of each position is remapped (direction and timing are exact).
//              clearance = 2.2·R★ + 120 (+ the binary separation for binaries).
//   planets    R_world = 0.1253 · radiusKm^0.5                     (Aurelia 6370 km → 10 u,
//              Leviathan 69 000 km → 33 u, Cinder 3100 km → 7 u)
//   moons      decorative moons: R = R_parent · (km/km_parent)^0.8 ; orbit = distRadii · R_parent,
//              squeezed into 30 % of the gap to the neighbouring orbits (no overlaps, ever).
//              Landable moons (desc.parent set, orbit.a in parent radii): planet radius mapping,
//              orbit = a · R_parent (pushed beyond the rings).
//   star       R★ = 90 · radiusSun^0.35   (Sun 90 u, red giant 110 R☉ → 465 u, white dwarf 19 u)
//   time       simDays advance at `timeRate` days per second (T cycles 1 h/s … 60 d/s).
//
// Helpers exported below: mapAU, planetRadius, starRadius, keplerSolve, orbitPositionAU, makeLayout.

export const SCALE = Object.freeze({ R0: 1000, P: 0.55, KPLANET: 0.1253, KSTAR: 90, PSTAR: 0.35 });

const TAU = Math.PI * 2;
const hashf = (seed, k) => {
  let a = (seed ^ Math.imul(k + 1, 0x9e3779b1)) | 0;
  a = Math.imul(a ^ (a >>> 16), 0x85ebca6b); a = Math.imul(a ^ (a >>> 13), 0xc2b2ae35); a ^= a >>> 16;
  return (a >>> 0) / 4294967296;
};

/** Star radius in world units for a star descriptor (black holes / pulsars get a sensible stage size). */
export function starRadius(star) {
  if (!star) return 0;
  if (star.kind === 'blackhole') return star.supermassive ? 140 : 60;
  if (star.kind === 'pulsar') return 22;
  return SCALE.KSTAR * Math.pow(Math.max(star.radiusSun, 1e-3), SCALE.PSTAR);
}
/** Planet radius in world units from its true radius in km. */
export function planetRadius(radiusKm) { return SCALE.KPLANET * Math.sqrt(Math.max(radiusKm, 50)); }

/** Solve Kepler's equation M = E − e·sin E (Newton, robust for e < 0.99). */
export function keplerSolve(M, e) {
  M = ((M % TAU) + TAU) % TAU; if (M > Math.PI) M -= TAU;
  let E = e < 0.8 ? M : Math.sign(M || 1) * Math.PI;
  for (let i = 0; i < 12; i++) {
    const f = E - e * Math.sin(E) - M;
    const d = f / (1 - e * Math.cos(E));
    E -= d;
    if (Math.abs(d) < 1e-10) break;
  }
  return E;
}

/**
 * Orbit elements from a descriptor orbit {a, e, inc, periodDays, phase}, completed with a
 * deterministic node and argument of periapsis (the descriptors leave them out).
 */
export function elements(orbit, seed) {
  return {
    a: orbit.a, e: Math.min(orbit.e || 0, 0.97), inc: orbit.inc || 0,
    period: Math.max(orbit.periodDays || 365, 1e-3), phase: orbit.phase || 0,
    node: hashf(seed, 1) * TAU, argp: hashf(seed, 2) * TAU,
  };
}

/** Position on the orbit at time t (days), in the orbit's own units, ecliptic frame (y up). out = [x,y,z]. */
export function orbitPosition(el, tDays, out = [0, 0, 0]) {
  const M = el.phase + TAU * (tDays / el.period);
  const E = keplerSolve(M, el.e);
  const cosE = Math.cos(E), sinE = Math.sin(E);
  // perifocal coordinates
  const xp = el.a * (cosE - el.e);
  const yp = el.a * Math.sqrt(1 - el.e * el.e) * sinE;
  return perifocalToEcliptic(el, xp, yp, out);
}
/** Position on the orbit at eccentric anomaly E (for drawing the full ellipse). */
export function orbitPointE(el, E, out = [0, 0, 0]) {
  const xp = el.a * (Math.cos(E) - el.e);
  const yp = el.a * Math.sqrt(1 - el.e * el.e) * Math.sin(E);
  return perifocalToEcliptic(el, xp, yp, out);
}
function perifocalToEcliptic(el, xp, yp, out) {
  const cw = Math.cos(el.argp), sw = Math.sin(el.argp);
  const cO = Math.cos(el.node), sO = Math.sin(el.node);
  const ci = Math.cos(el.inc), si = Math.sin(el.inc);
  // standard rotation (z = orbit normal), then swap to y-up: (x, z_ecl, -y)
  const x1 = cw * xp - sw * yp, y1 = sw * xp + cw * yp;
  const X = cO * x1 - sO * ci * y1;
  const Y = sO * x1 + cO * ci * y1;
  const Z = si * y1;
  out[0] = X; out[1] = Z; out[2] = -Y;
  return out;
}

/**
 * Build the mapping for one system. Returns helpers bound to that system's star.
 *   L.mapAU(rAU)        radial distance in AU → world units
 *   L.toWorld([x,y,z])  AU-space position → world position (radial remap, in place)
 */
export function makeLayout(sys) {
  const star = sys.star;
  const lum = Math.max(star.lumSun || 0, 0.0005);
  const hz = Math.sqrt(lum);
  const starR = starRadius(star);
  const compR = sys.companion ? starRadius(sys.companion) : 0;
  let binarySep = 0;
  if (sys.companion) binarySep = (starR + compR) * 2.6 + 60;
  const clearance = starR * 2.2 + 120 + binarySep * 1.1;
  const mapAU = (rAU) => clearance + SCALE.R0 * Math.pow(Math.max(rAU, 0) / hz, SCALE.P);
  const toWorld = (p) => {
    const r = Math.hypot(p[0], p[1], p[2]);
    if (r < 1e-12) { p[0] = p[1] = p[2] = 0; return p; }
    const k = mapAU(r) / r;
    p[0] *= k; p[1] *= k; p[2] *= k;
    return p;
  };
  return { hz, starR, compR, binarySep, clearance, mapAU, toWorld, R0: SCALE.R0, P: SCALE.P };
}
