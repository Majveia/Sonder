// Chunk mesh builder — pure JS (no three), used inside the terrain workers (and by node test scripts).
//
// A chunk is one cube-sphere quadtree node (face, level, ix, iy) meshed as (N+1)^2 vertices + a skirt ring.
// Heights are evaluated on an (N+3)^2 grid (one-cell border) so normals / slope / curvature are central
// differences that agree across chunk borders. Positions are Float32 relative to the chunk origin
// (= unit centre direction * R) for precision; the main thread places the mesh at that origin.
//
// Vertex layout: main grid index j*(N+1)+i (i along the face's `a` axis = s, j along `b` = t),
// then the skirt ring: bottom edge (j=0), top edge (j=N), left edge (i=0), right edge (i=N), each N+1 long.
import { faceDir, nodeBounds, nodeSize } from './cube.js';
import { biomeConfig, biomeWeights, jitterAt, macroAt } from './biome.js';

/** Shared index buffer for every chunk with `N` segments (Uint16 when it fits). */
export function buildIndices(N) {
  const V = N + 1, base = V * V;
  const tris = N * N * 2 + 4 * N * 2;
  const idx = base + 4 * V < 65535 ? new Uint16Array(tris * 3) : new Uint32Array(tris * 3);
  let k = 0;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const a = j * V + i, b = a + 1, c = a + V, d = c + 1;
    // alternate the diagonal in a checkerboard so ridges do not all lean one way
    if ((i + j) & 1) { idx[k++] = a; idx[k++] = b; idx[k++] = d; idx[k++] = a; idx[k++] = d; idx[k++] = c; }
    else { idx[k++] = a; idx[k++] = b; idx[k++] = c; idx[k++] = b; idx[k++] = d; idx[k++] = c; }
  }
  const sk = (e, i) => base + e * V + i; // skirt vertex for edge e, position i
  for (let i = 0; i < N; i++) {
    // bottom (j = 0), outward = -b
    let e0 = i, e1 = i + 1, s0 = sk(0, i), s1 = sk(0, i + 1);
    idx[k++] = e0; idx[k++] = s0; idx[k++] = e1; idx[k++] = e1; idx[k++] = s0; idx[k++] = s1;
    // top (j = N), outward = +b
    e0 = N * V + i; e1 = e0 + 1; s0 = sk(1, i); s1 = sk(1, i + 1);
    idx[k++] = e0; idx[k++] = e1; idx[k++] = s0; idx[k++] = e1; idx[k++] = s1; idx[k++] = s0;
    // left (i = 0), outward = -a
    e0 = i * V; e1 = (i + 1) * V; s0 = sk(2, i); s1 = sk(2, i + 1);
    idx[k++] = e0; idx[k++] = e1; idx[k++] = s0; idx[k++] = e1; idx[k++] = s1; idx[k++] = s0;
    // right (i = N), outward = +a
    e0 = i * V + N; e1 = (i + 1) * V + N; s0 = sk(3, i); s1 = sk(3, i + 1);
    idx[k++] = e0; idx[k++] = s0; idx[k++] = e1; idx[k++] = e1; idx[k++] = s0; idx[k++] = s1;
  }
  return idx;
}

const _d = new Float64Array(3), _cl = { temp: 0, moist: 0 }, _w = new Float32Array(8), _m = [0, 0];

/**
 * Build one chunk. job = { face, level, ix, iy, N, minWl, skirt }.
 * Returns typed arrays (transferable) + bounds.
 */
export function buildChunk(model, job, cfg = biomeConfig(model.desc)) {
  const { face, level, ix, iy, N } = job;
  const R = model.R;
  const V = N + 1, G = N + 3, base = V * V, count = base + 4 * V;
  const { s0, t0, d } = nodeBounds(level, ix, iy);
  const step = d / N;
  const spacing = nodeSize(R, level) / N;
  const minWl = job.minWl ?? spacing;
  // chunk origin: centre direction * R
  faceDir(face, s0 + d * 0.5, t0 + d * 0.5, _d);
  const ox = _d[0] * R, oy = _d[1] * R, oz = _d[2] * R;

  // ---- heights + world positions on the bordered grid (float64 for the differences)
  const gx = new Float64Array(G * G), gy = new Float64Array(G * G), gz = new Float64Array(G * G), gh = new Float64Array(G * G);
  const dirs = new Float64Array(G * G * 3);
  for (let j = 0; j < G; j++) {
    const t = t0 + (j - 1) * step;
    for (let i = 0; i < G; i++) {
      const s = s0 + (i - 1) * step;
      const g = j * G + i;
      faceDir(face, s, t, dirs, g * 3);
      const x = dirs[g * 3], y = dirs[g * 3 + 1], z = dirs[g * 3 + 2];
      const h = model.height(x, y, z, minWl);
      const r = R + h;
      gh[g] = h; gx[g] = x * r; gy[g] = y * r; gz[g] = z * r;
    }
  }

  const position = new Float32Array(count * 3);
  const normal = new Float32Array(count * 3);
  const w0 = new Uint8Array(count * 4), w1 = new Uint8Array(count * 4);
  const data = new Float32Array(count * 4); // height, curvature, macro1, macro2
  let minH = Infinity, maxH = -Infinity, br2 = 0;
  const inv = 1 / (2 * spacing);

  for (let j = 0; j < V; j++) for (let i = 0; i < V; i++) {
    const g = (j + 1) * G + (i + 1), v = j * V + i;
    const x = dirs[g * 3], y = dirs[g * 3 + 1], z = dirs[g * 3 + 2];
    const px = gx[g] - ox, py = gy[g] - oy, pz = gz[g] - oz;
    position[v * 3] = px; position[v * 3 + 1] = py; position[v * 3 + 2] = pz;
    const r2 = px * px + py * py + pz * pz; if (r2 > br2) br2 = r2;
    // central-difference normal
    const gl = g - 1, gr = g + 1, gd = g - G, gu = g + G;
    const ax = gx[gr] - gx[gl], ay = gy[gr] - gy[gl], az = gz[gr] - gz[gl];
    const bx = gx[gu] - gx[gd], by = gy[gu] - gy[gd], bz = gz[gu] - gz[gd];
    let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    const nl = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz); nx *= nl; ny *= nl; nz *= nl;
    normal[v * 3] = nx; normal[v * 3 + 1] = ny; normal[v * 3 + 2] = nz;
    const cosA = nx * x + ny * y + nz * z;
    const slope = Math.sqrt(Math.max(0, 1 - cosA * cosA));
    const h = gh[g];
    if (h < minH) minH = h; if (h > maxH) maxH = h;
    const curv = ((gh[gl] + gh[gr] + gh[gd] + gh[gu]) * 0.25 - h) / spacing;
    model.climate(x, y, z, h, _cl);
    const jit = jitterAt(model, x, y, z);
    biomeWeights(cfg, h, slope, _cl.temp, _cl.moist, jit, _w);
    macroAt(model, x, y, z, _m);
    const q = v * 4;
    w0[q] = (_w[0] * 255 + 0.5) | 0; w0[q + 1] = (_w[1] * 255 + 0.5) | 0; w0[q + 2] = (_w[2] * 255 + 0.5) | 0; w0[q + 3] = (_w[3] * 255 + 0.5) | 0;
    w1[q] = (_w[4] * 255 + 0.5) | 0; w1[q + 1] = (_w[5] * 255 + 0.5) | 0; w1[q + 2] = (_w[6] * 255 + 0.5) | 0; w1[q + 3] = (_w[7] * 255 + 0.5) | 0;
    data[q] = h; data[q + 1] = curv; data[q + 2] = _m[0]; data[q + 3] = _m[1];
  }
  void inv;

  // ---- skirts: copy of the edge vertex dropped along -up
  const skirt = job.skirt ?? Math.max(1.5, spacing * 2.5);
  const edgeVertex = (e, k) => (e === 0 ? k : e === 1 ? N * V + k : e === 2 ? k * V : k * V + N);
  for (let e = 0; e < 4; e++) for (let k = 0; k < V; k++) {
    const src = edgeVertex(e, k), dst = base + e * V + k;
    const ii = src % V, jj = (src / V) | 0, g = (jj + 1) * G + (ii + 1);
    const x = dirs[g * 3], y = dirs[g * 3 + 1], z = dirs[g * 3 + 2];
    position[dst * 3] = position[src * 3] - x * skirt;
    position[dst * 3 + 1] = position[src * 3 + 1] - y * skirt;
    position[dst * 3 + 2] = position[src * 3 + 2] - z * skirt;
    normal[dst * 3] = normal[src * 3]; normal[dst * 3 + 1] = normal[src * 3 + 1]; normal[dst * 3 + 2] = normal[src * 3 + 2];
    for (let c = 0; c < 4; c++) { w0[dst * 4 + c] = w0[src * 4 + c]; w1[dst * 4 + c] = w1[src * 4 + c]; data[dst * 4 + c] = data[src * 4 + c]; }
  }

  return {
    origin: [ox, oy, oz], spacing, minH, maxH, radius: Math.sqrt(br2) + skirt,
    position, normal, w0, w1, data,
  };
}
