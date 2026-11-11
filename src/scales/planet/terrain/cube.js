// Cube-sphere parameterisation shared by the terrain main thread and its workers (pure JS, no three).
//
// Six faces, each an equal-angle quad tree:  dir = normalize(n + a * tan(s*PI/4) + b * tan(t*PI/4)),  s,t in [-1, 1].
// The tangent warp keeps cells within ~±15% of the same size over the whole sphere (a plain cube is ±70%).
// A node is (face, level, ix, iy) with ix, iy in [0, 2^level).

export const FACES = [
  { n: [1, 0, 0], a: [0, 0, -1], b: [0, 1, 0] },
  { n: [-1, 0, 0], a: [0, 0, 1], b: [0, 1, 0] },
  { n: [0, 1, 0], a: [1, 0, 0], b: [0, 0, -1] },
  { n: [0, -1, 0], a: [1, 0, 0], b: [0, 0, 1] },
  { n: [0, 0, 1], a: [1, 0, 0], b: [0, 1, 0] },
  { n: [0, 0, -1], a: [-1, 0, 0], b: [0, 1, 0] },
];

const Q = Math.PI / 4;

/** Unit direction for face-local (s, t) in [-1,1]; writes into out[o..o+2]. */
export function faceDir(face, s, t, out, o = 0) {
  const F = FACES[face];
  const u = Math.tan(s * Q), v = Math.tan(t * Q);
  const x = F.n[0] + F.a[0] * u + F.b[0] * v;
  const y = F.n[1] + F.a[1] * u + F.b[1] * v;
  const z = F.n[2] + F.a[2] * u + F.b[2] * v;
  const l = 1 / Math.sqrt(x * x + y * y + z * z);
  out[o] = x * l; out[o + 1] = y * l; out[o + 2] = z * l;
  return out;
}

/** Inverse: unit direction -> { face, s, t } (s,t in [-1,1]). */
export function dirToFace(x, y, z, out = {}) {
  const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
  let face;
  if (ax >= ay && ax >= az) face = x > 0 ? 0 : 1;
  else if (ay >= az) face = y > 0 ? 2 : 3;
  else face = z > 0 ? 4 : 5;
  const F = FACES[face];
  const dn = x * F.n[0] + y * F.n[1] + z * F.n[2];
  const da = x * F.a[0] + y * F.a[1] + z * F.a[2];
  const db = x * F.b[0] + y * F.b[1] + z * F.b[2];
  out.face = face;
  out.s = Math.atan(da / dn) / Q;
  out.t = Math.atan(db / dn) / Q;
  return out;
}

/** Face-local bounds of a node. */
export function nodeBounds(level, ix, iy) {
  const n = 1 << level, d = 2 / n;
  return { s0: -1 + ix * d, t0: -1 + iy * d, d };
}

/** Approximate edge length (metres) of a node at `level` on a sphere of radius R. */
export const nodeSize = (R, level) => (R * Math.PI * 0.5) / (1 << level);

/** Deepest level whose vertex spacing (N-1 segments per chunk) is <= `spacing` metres. */
export function levelForSpacing(R, segments, spacing) {
  let L = 0;
  while (nodeSize(R, L) / segments > spacing && L < 22) L++;
  return L;
}
