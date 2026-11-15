// Particle-mesh N-body simulation of ΛCDM structure formation in a periodic comoving box.
// Pure JS, no three.js — runs in the module worker (sim-worker.js) and in node for validation.
//
// Code units (Kravtsov, "Writing a PM code"): positions in mesh cells [0, M), time in 1/H0,
// p = a² dx/dt.   E(a) = sqrt(Ωm a⁻³ + ΩΛ),  f(a) = 1/(a E(a))
//   ∇²φ = (3Ωm / 2a) δ        dx/da = f(a) p / a²        dp/da = −f(a) ∇φ
// Leapfrog KDK in a; CIC deposit; FFT Poisson solve with the discrete-Laplacian Green's function;
// central-difference gradient on the mesh; CIC force interpolation.
// Initial conditions: Gaussian field, P(k) ∝ k^ns T_BBKS(k)², σ8-normalised, Zel'dovich at a_i.
import { RNG } from '../../core/rng.js';

// ---------------------------------------------------------------------------------------------
// FFT: in-place radix-2 complex FFT on separate re/im Float64Arrays, 3-D by axis lines.
// ---------------------------------------------------------------------------------------------
export class FFT3 {
  constructor(n) {
    if (n & (n - 1)) throw new Error('FFT size must be a power of two');
    this.n = n;
    this.cos = new Float64Array(n / 2); this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) { this.cos[i] = Math.cos(2 * Math.PI * i / n); this.sin[i] = Math.sin(2 * Math.PI * i / n); }
    this.rev = new Uint32Array(n);
    const bits = Math.log2(n);
    for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); this.rev[i] = r; }
    this.lr = new Float64Array(n); this.li = new Float64Array(n);
  }
  /** 1-D in place on this.lr/li. sign −1 forward, +1 inverse (unnormalised). */
  _line(sign) {
    const n = this.n, re = this.lr, im = this.li, rev = this.rev, C = this.cos, S = this.sin;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0, t = 0; k < half; k++, t += step) {
          const wr = C[t], wi = sign * S[t];
          const a = start + k, b = a + half;
          const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
        }
      }
    }
  }
  /** 3-D transform of (re, im), layout idx = (z*n + y)*n + x. inverse includes the 1/n³ factor. */
  transform(re, im, inverse = false) {
    const n = this.n, n2 = n * n, lr = this.lr, li = this.li, sign = inverse ? 1 : -1;
    // x lines
    for (let zy = 0; zy < n2; zy++) {
      const o = zy * n;
      for (let x = 0; x < n; x++) { lr[x] = re[o + x]; li[x] = im[o + x]; }
      this._line(sign);
      for (let x = 0; x < n; x++) { re[o + x] = lr[x]; im[o + x] = li[x]; }
    }
    // y lines
    for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) {
      const o = z * n2 + x;
      for (let y = 0; y < n; y++) { lr[y] = re[o + y * n]; li[y] = im[o + y * n]; }
      this._line(sign);
      for (let y = 0; y < n; y++) { re[o + y * n] = lr[y]; im[o + y * n] = li[y]; }
    }
    // z lines
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const o = y * n + x;
      for (let z = 0; z < n; z++) { lr[z] = re[o + z * n2]; li[z] = im[o + z * n2]; }
      this._line(sign);
      for (let z = 0; z < n; z++) { re[o + z * n2] = lr[z]; im[o + z * n2] = li[z]; }
    }
    if (inverse) { const s = 1 / (n2 * n); for (let i = 0; i < re.length; i++) { re[i] *= s; im[i] *= s; } }
  }
}

// ---------------------------------------------------------------------------------------------
// Cosmology
// ---------------------------------------------------------------------------------------------
export class Cosmology {
  constructor({ omegaM = 0.315, omegaL = 0.685, omegaB = 0.049, H0 = 67.4, sigma8 = 0.811, ns = 0.965 } = {}) {
    Object.assign(this, { omegaM, omegaL, omegaB, H0, sigma8, ns });
    this.h = H0 / 100;
    // linear growth table D(a) ∝ E(a) ∫₀ᵃ da' / (a' E(a'))³, normalised D(1) = 1
    const N = 4096;
    this._ga = new Float64Array(N + 1); this._gd = new Float64Array(N + 1);
    let integ = 0, prev = 0;
    const g = (a) => (a <= 0 ? 0 : 1 / Math.pow(a * this.E(a), 3));
    // integrate in ln a from tiny a (integrand ∝ a^{3/2} at early times: start analytic)
    const a0 = 1e-5;
    integ = (2 / 5) * Math.pow(a0, 2.5) / Math.pow(this.omegaM, 1.5);
    let la = Math.log(a0);
    const lEnd = Math.log(1.0001), dl = (lEnd - la) / N;
    prev = g(a0) * a0;
    for (let i = 0; i <= N; i++) {
      const a = Math.exp(la);
      if (i > 0) { const cur = g(a) * a; integ += 0.5 * (prev + cur) * dl; prev = cur; }
      this._ga[i] = a; this._gd[i] = this.E(a) * integ;
      la += dl;
    }
    const d1 = this._interpD(1);
    for (let i = 0; i <= N; i++) this._gd[i] /= d1;
  }
  E(a) { return Math.sqrt(this.omegaM / (a * a * a) + this.omegaL); }
  f(a) { return 1 / (a * this.E(a)); }
  _interpD(a) {
    const ga = this._ga, n = ga.length - 1;
    const l0 = Math.log(ga[0]), l1 = Math.log(ga[n]);
    const u = (Math.log(a) - l0) / (l1 - l0) * n;
    const i = Math.max(0, Math.min(n - 1, Math.floor(u))), t = u - i;
    return this._gd[i] * (1 - t) + this._gd[i + 1] * t;
  }
  D(a) { return this._interpD(a); }
  dDda(a) { const e = a * 1e-4; return (this.D(a + e) - this.D(a - e)) / (2 * e); }
  /** cosmic age in Gyr at scale factor a (flat ΛCDM, matter + Λ) */
  ageGyr(a) {
    const tH = 977.8 / this.H0; // 1/H0 in Gyr
    return tH * (2 / (3 * Math.sqrt(this.omegaL))) * Math.asinh(Math.sqrt(this.omegaL / this.omegaM) * Math.pow(Math.max(a, 1e-9), 1.5));
  }
  /** BBKS transfer function, k in h/Mpc, shape parameter with Sugiyama baryon correction */
  transfer(k) {
    const h = this.h, Om = this.omegaM, Ob = this.omegaB;
    const gamma = Om * h * Math.exp(-Ob - Math.sqrt(2 * h) * Ob / Om);
    const q = k / gamma;
    if (q < 1e-8) return 1;
    return Math.log(1 + 2.34 * q) / (2.34 * q) * Math.pow(1 + 3.89 * q + Math.pow(16.1 * q, 2) + Math.pow(5.46 * q, 3) + Math.pow(6.71 * q, 4), -0.25);
  }
  /** unnormalised P(k) */
  _pk(k) { const t = this.transfer(k); return Math.pow(k, this.ns) * t * t; }
  /** amplitude so that σ(8 Mpc/h) = sigma8 at a = 1 (linear) */
  normalise() {
    const R = 8;
    let s = 0;
    const lk0 = Math.log(1e-4), lk1 = Math.log(50), N = 8000, dl = (lk1 - lk0) / N;
    for (let i = 0; i <= N; i++) {
      const k = Math.exp(lk0 + i * dl), x = k * R;
      const W = 3 * (Math.sin(x) - x * Math.cos(x)) / (x * x * x);
      const w = (i === 0 || i === N) ? 0.5 : 1;
      s += w * k * k * k * this._pk(k) * W * W * dl; // ∫ k² P W² dk = ∫ k³ P W² dln k
    }
    s /= 2 * Math.PI * Math.PI;
    this.amp = this.sigma8 * this.sigma8 / s;
    return this.amp;
  }
  /** linear power spectrum at a = 1, (Mpc/h)³ */
  P(k) { if (this.amp === undefined) this.normalise(); return this.amp * this._pk(k); }
}

// ---------------------------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------------------------
/** Step schedule: log-spaced (Δln a = dlog) until Δa reaches daMax, then linear in a. */
export function makeSchedule(aStart, aEnd, dlog, daMax) {
  const out = [aStart];
  let a = aStart;
  while (a < aEnd - 1e-9) {
    const da = Math.min(a * dlog, daMax);
    a = Math.min(aEnd, a + da);
    if (aEnd - a < da * 0.35) a = aEnd;
    out.push(a);
  }
  return out;
}

export class PMSim {
  /**
   * @param {object} o { np: particles per side, mesh: force mesh (pow2), icMesh: IC grid (pow2),
   *   boxMpc, cosmo: Cosmology params, seed, aStart, ampBoost, densGrid }
   */
  constructor(o) {
    this.np = o.np; this.M = o.mesh; this.icM = o.icMesh || o.mesh;
    this.N = this.np ** 3;
    this.boxMpc = o.boxMpc;
    this.cosmo = new Cosmology(o.cosmo || {});
    this.seed = o.seed ?? 1;
    this.aStart = o.aStart ?? 0.02;
    this.ampBoost = o.ampBoost ?? 1;
    this.a = this.aStart;
    const M = this.M, M3 = M * M * M;
    this.fft = new FFT3(M);
    this.x = new Float32Array(this.N * 3);   // positions in force-mesh cells [0, M)
    this.p = new Float32Array(this.N * 3);   // momenta
    this.rho = new Float64Array(M3);         // density contrast mesh (re)
    this.im = new Float64Array(M3);
    this.gx = new Float32Array(M3); this.gy = new Float32Array(M3); this.gz = new Float32Array(M3);
    this.acc = new Float32Array(this.N * 3);  // interpolated −∇φ at current positions
    this.accA = -1;
    // Green's function −1/k² (discrete Laplacian, k=0 → 0)
    this.green = new Float64Array(M3);
    for (let z = 0; z < M; z++) for (let y = 0; y < M; y++) for (let x = 0; x < M; x++) {
      const k2 = (2 - 2 * Math.cos(2 * Math.PI * x / M)) + (2 - 2 * Math.cos(2 * Math.PI * y / M)) + (2 - 2 * Math.cos(2 * Math.PI * z / M));
      this.green[(z * M + y) * M + x] = k2 > 0 ? -1 / k2 : 0;
    }
    // shuffled particle order so any prefix is a random spatial subset (render LOD)
    this.order = new Uint32Array(this.N);
    for (let i = 0; i < this.N; i++) this.order[i] = i;
    const r = new RNG(this.seed, 'order');
    for (let i = this.N - 1; i > 0; i--) { const j = Math.floor(r.next() * (i + 1)); const t = this.order[i]; this.order[i] = this.order[j]; this.order[j] = t; }
  }

  // --- initial conditions -------------------------------------------------------------------
  initialConditions() {
    const n = this.icM, n3 = n * n * n, cosmo = this.cosmo;
    const fft = n === this.M ? this.fft : new FFT3(n);
    const Lh = this.boxMpc * cosmo.h;           // box in Mpc/h
    const dxh = Lh / n;                          // IC cell in Mpc/h
    const vcell = dxh * dxh * dxh;
    const re = new Float64Array(n3), im = new Float64Array(n3);
    const rng = new RNG(this.seed, 'ic-noise');
    for (let i = 0; i < n3; i++) re[i] = rng.gauss();
    fft.transform(re, im, false);
    cosmo.normalise();
    // δ̃_k = w̃_k sqrt(P(k)/Vcell) (a = 1 linear amplitude), then ψ̃ = i k δ̃ / k²  (k in rad/cell)
    const dR = new Float64Array(n3), dI = new Float64Array(n3);
    const boost = this.ampBoost;
    for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const i = (z * n + y) * n + x;
      const kx = x <= n / 2 ? x : x - n, ky = y <= n / 2 ? y : y - n, kz = z <= n / 2 ? z : z - n;
      const kk = Math.sqrt(kx * kx + ky * ky + kz * kz);
      if (kk === 0) { dR[i] = dI[i] = 0; continue; }
      const kh = kk * 2 * Math.PI / Lh;                      // h/Mpc
      const amp = Math.sqrt(cosmo.P(kh) / vcell) * boost;
      dR[i] = re[i] * amp; dI[i] = im[i] * amp;
    }
    // remove the Nyquist planes (keeps the displacement field real and isotropic)
    const psi = [new Float32Array(n3), new Float32Array(n3), new Float32Array(n3)];
    for (let c = 0; c < 3; c++) {
      for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
        const i = (z * n + y) * n + x;
        const kv = [x <= n / 2 ? x : x - n, y <= n / 2 ? y : y - n, z <= n / 2 ? z : z - n];
        const nyq = x === n / 2 || y === n / 2 || z === n / 2;
        const k2 = kv[0] * kv[0] + kv[1] * kv[1] + kv[2] * kv[2];
        if (k2 === 0 || nyq) { re[i] = im[i] = 0; continue; }
        const kc = kv[c] * 2 * Math.PI / n, kk2 = k2 * (2 * Math.PI / n) ** 2;
        // i kc δ / k²  → (re, im) = (−kc δI, kc δR)/k²
        re[i] = -kc * dI[i] / kk2; im[i] = kc * dR[i] / kk2;
      }
      fft.transform(re, im, true);
      for (let i = 0; i < n3; i++) psi[c][i] = re[i];
    }
    this.icDelta = null;
    // lattice → particles: displacement (IC cells → force cells) trilinearly sampled at q
    const np = this.np, a = this.aStart, D = cosmo.D(a), dD = cosmo.dDda(a), E = cosmo.E(a);
    const toM = this.M / n;                 // IC cell → force-mesh cell
    const pfac = a * a * a * E * dD;
    const ord = this.order;
    let k = 0;
    for (let iz = 0; iz < np; iz++) for (let iy = 0; iy < np; iy++) for (let ix = 0; ix < np; ix++, k++) {
      const qx = (ix + 0.5) / np * n, qy = (iy + 0.5) / np * n, qz = (iz + 0.5) / np * n; // IC cells
      const s = [0, 0, 0];
      trilinear3(psi, n, qx - 0.5, qy - 0.5, qz - 0.5, s);
      const o = ord[k] * 3;
      for (let c = 0; c < 3; c++) {
        const q = (c === 0 ? qx : c === 1 ? qy : qz) * toM;
        const d = s[c] * toM;
        this.x[o + c] = wrap(q + D * d, this.M);
        this.p[o + c] = pfac * d;
      }
    }
    this.a = a;
    this.accA = -1;
  }

  // --- mesh operations ----------------------------------------------------------------------
  /** CIC deposit of particles into this.rho as δ = ρ/ρ̄ − 1 on the force mesh. */
  deposit() {
    const M = this.M, M2 = M * M, rho = this.rho, x = this.x, N = this.N;
    rho.fill(0);
    const w = (M * M * M) / N;
    for (let i = 0; i < N; i++) {
      let px = x[i * 3] - 0.5, py = x[i * 3 + 1] - 0.5, pz = x[i * 3 + 2] - 0.5;
      let ix = Math.floor(px), iy = Math.floor(py), iz = Math.floor(pz);
      const fx = px - ix, fy = py - iy, fz = pz - iz;
      ix = (ix + M) % M; iy = (iy + M) % M; iz = (iz + M) % M;
      const jx = ix + 1 === M ? 0 : ix + 1, jy = iy + 1 === M ? 0 : iy + 1, jz = iz + 1 === M ? 0 : iz + 1;
      const gx = 1 - fx, gy = 1 - fy, gz = 1 - fz;
      const a0 = iz * M2, a1 = jz * M2, b0 = iy * M, b1 = jy * M;
      rho[a0 + b0 + ix] += gx * gy * gz * w; rho[a0 + b0 + jx] += fx * gy * gz * w;
      rho[a0 + b1 + ix] += gx * fy * gz * w; rho[a0 + b1 + jx] += fx * fy * gz * w;
      rho[a1 + b0 + ix] += gx * gy * fz * w; rho[a1 + b0 + jx] += fx * gy * fz * w;
      rho[a1 + b1 + ix] += gx * fy * fz * w; rho[a1 + b1 + jx] += fx * fy * fz * w;
    }
    for (let i = 0; i < rho.length; i++) rho[i] -= 1;
  }

  /** Solve Poisson for the current density mesh, fill gx/gy/gz = −∇φ, interpolate to particles. */
  computeForces(a) {
    const M = this.M, M2 = M * M, rho = this.rho, im = this.im;
    this.deposit();
    if (!this.deltaMesh) this.deltaMesh = new Float32Array(rho.length);
    this.deltaMesh.set(rho);
    im.fill(0);
    this.fft.transform(rho, im, false);
    const s = 1.5 * this.cosmo.omegaM / a, g = this.green;
    for (let i = 0; i < rho.length; i++) { const f = g[i] * s; rho[i] *= f; im[i] *= f; }
    this.fft.transform(rho, im, true);  // rho now holds φ
    const phi = rho, gx = this.gx, gy = this.gy, gz = this.gz;
    for (let z = 0; z < M; z++) {
      const zp = ((z + 1) % M) * M2, zm = ((z + M - 1) % M) * M2, zo = z * M2;
      for (let y = 0; y < M; y++) {
        const yp = ((y + 1) % M) * M, ym = ((y + M - 1) % M) * M, yo = y * M;
        for (let x = 0; x < M; x++) {
          const xp = (x + 1) % M, xm = (x + M - 1) % M, i = zo + yo + x;
          gx[i] = -0.5 * (phi[zo + yo + xp] - phi[zo + yo + xm]);
          gy[i] = -0.5 * (phi[zo + yp + x] - phi[zo + ym + x]);
          gz[i] = -0.5 * (phi[zp + yo + x] - phi[zm + yo + x]);
        }
      }
    }
    // CIC interpolation back to particles
    const xA = this.x, acc = this.acc, N = this.N;
    for (let i = 0; i < N; i++) {
      let px = xA[i * 3] - 0.5, py = xA[i * 3 + 1] - 0.5, pz = xA[i * 3 + 2] - 0.5;
      let ix = Math.floor(px), iy = Math.floor(py), iz = Math.floor(pz);
      const fx = px - ix, fy = py - iy, fz = pz - iz;
      ix = (ix + M) % M; iy = (iy + M) % M; iz = (iz + M) % M;
      const jx = ix + 1 === M ? 0 : ix + 1, jy = iy + 1 === M ? 0 : iy + 1, jz = iz + 1 === M ? 0 : iz + 1;
      const hx = 1 - fx, hy = 1 - fy, hz = 1 - fz;
      const a0 = iz * M2, a1 = jz * M2, b0 = iy * M, b1 = jy * M;
      const i000 = a0 + b0 + ix, i100 = a0 + b0 + jx, i010 = a0 + b1 + ix, i110 = a0 + b1 + jx;
      const i001 = a1 + b0 + ix, i101 = a1 + b0 + jx, i011 = a1 + b1 + ix, i111 = a1 + b1 + jx;
      const w000 = hx * hy * hz, w100 = fx * hy * hz, w010 = hx * fy * hz, w110 = fx * fy * hz;
      const w001 = hx * hy * fz, w101 = fx * hy * fz, w011 = hx * fy * fz, w111 = fx * fy * fz;
      acc[i * 3] = gx[i000] * w000 + gx[i100] * w100 + gx[i010] * w010 + gx[i110] * w110 + gx[i001] * w001 + gx[i101] * w101 + gx[i011] * w011 + gx[i111] * w111;
      acc[i * 3 + 1] = gy[i000] * w000 + gy[i100] * w100 + gy[i010] * w010 + gy[i110] * w110 + gy[i001] * w001 + gy[i101] * w101 + gy[i011] * w011 + gy[i111] * w111;
      acc[i * 3 + 2] = gz[i000] * w000 + gz[i100] * w100 + gz[i010] * w010 + gz[i110] * w110 + gz[i001] * w001 + gz[i101] * w101 + gz[i011] * w011 + gz[i111] * w111;
    }
    this.accA = a;
  }

  /** One KDK leapfrog step from this.a to a1. */
  step(a1) {
    const a0 = this.a, da = a1 - a0, c = this.cosmo, M = this.M;
    if (this.accA !== a0) this.computeForces(a0);
    const x = this.x, p = this.p, acc = this.acc, n3 = this.N * 3;
    let k = c.f(a0) * da * 0.5;
    for (let i = 0; i < n3; i++) p[i] += acc[i] * k;
    const am = 0.5 * (a0 + a1);
    const d = c.f(am) / (am * am) * da;
    for (let i = 0; i < n3; i++) {
      let v = x[i] + p[i] * d;
      if (v < 0) v += M; else if (v >= M) v -= M;
      if (v < 0 || v >= M) v = wrap(v, M);
      x[i] = v;
    }
    this.computeForces(a1);
    k = c.f(a1) * da * 0.5;
    for (let i = 0; i < n3; i++) p[i] += acc[i] * k;
    this.a = a1;
  }

  // --- keyframe products --------------------------------------------------------------------
  /** Quantised positions (Uint16, fraction of box) for the renderer. */
  packPositions(out) {
    const n3 = this.N * 3, s = 65536 / this.M, x = this.x;
    for (let i = 0; i < n3; i++) out[i] = Math.min(65535, Math.floor(x[i] * s)) ;
    return out;
  }

  /**
   * Per-particle (log density, "heat") bytes from a CIC density + NGP velocity dispersion estimate
   * on a grid of nd cells per side (no FFT needed, any size).
   */
  packFields(out, nd) {
    const N = this.N, x = this.x, p = this.p, M = this.M, s = nd / M, nd2 = nd * nd, nd3 = nd2 * nd;
    if (!this._fd || this._fd.length !== nd3) {
      this._fd = new Float32Array(nd3); this._fn = new Float32Array(nd3);
      this._fpx = new Float32Array(nd3); this._fpy = new Float32Array(nd3); this._fpz = new Float32Array(nd3); this._fp2 = new Float32Array(nd3);
    }
    const den = this._fd, cnt = this._fn, spx = this._fpx, spy = this._fpy, spz = this._fpz, sp2 = this._fp2;
    den.fill(0); cnt.fill(0); spx.fill(0); spy.fill(0); spz.fill(0); sp2.fill(0);
    const w = nd3 / N;
    for (let i = 0; i < N; i++) {
      const px = x[i * 3] * s - 0.5, py = x[i * 3 + 1] * s - 0.5, pz = x[i * 3 + 2] * s - 0.5;
      let ix = Math.floor(px), iy = Math.floor(py), iz = Math.floor(pz);
      const fx = px - ix, fy = py - iy, fz = pz - iz;
      ix = (ix + nd) % nd; iy = (iy + nd) % nd; iz = (iz + nd) % nd;
      const jx = (ix + 1) % nd, jy = (iy + 1) % nd, jz = (iz + 1) % nd;
      const gx = 1 - fx, gy = 1 - fy, gz = 1 - fz;
      const a0 = iz * nd2, a1 = jz * nd2, b0 = iy * nd, b1 = jy * nd;
      den[a0 + b0 + ix] += gx * gy * gz * w; den[a0 + b0 + jx] += fx * gy * gz * w;
      den[a0 + b1 + ix] += gx * fy * gz * w; den[a0 + b1 + jx] += fx * fy * gz * w;
      den[a1 + b0 + ix] += gx * gy * fz * w; den[a1 + b0 + jx] += fx * gy * fz * w;
      den[a1 + b1 + ix] += gx * fy * fz * w; den[a1 + b1 + jx] += fx * fy * fz * w;
      // NGP velocity moments (peculiar velocity ∝ p / a)
      const c = ((Math.floor(pz + 0.5) + nd) % nd) * nd2 + ((Math.floor(py + 0.5) + nd) % nd) * nd + ((Math.floor(px + 0.5) + nd) % nd);
      const vx = p[i * 3], vy = p[i * 3 + 1], vz = p[i * 3 + 2];
      cnt[c] += 1; spx[c] += vx; spy[c] += vy; spz[c] += vz; sp2[c] += vx * vx + vy * vy + vz * vz;
    }
    // velocity scale: peculiar velocity v = p / a (code units, cells·H0); normalise heat by the
    // typical cell crossing speed so the byte means roughly the same thing at every epoch.
    const vscale = 1 / Math.max(1e-6, this.a);
    for (let i = 0; i < N; i++) {
      const px = x[i * 3] * s - 0.5, py = x[i * 3 + 1] * s - 0.5, pz = x[i * 3 + 2] * s - 0.5;
      let ix = Math.floor(px), iy = Math.floor(py), iz = Math.floor(pz);
      const fx = px - ix, fy = py - iy, fz = pz - iz;
      ix = (ix + nd) % nd; iy = (iy + nd) % nd; iz = (iz + nd) % nd;
      const jx = (ix + 1) % nd, jy = (iy + 1) % nd, jz = (iz + 1) % nd;
      const gx = 1 - fx, gy = 1 - fy, gz = 1 - fz;
      const a0 = iz * nd2, a1 = jz * nd2, b0 = iy * nd, b1 = jy * nd;
      const d = den[a0 + b0 + ix] * gx * gy * gz + den[a0 + b0 + jx] * fx * gy * gz + den[a0 + b1 + ix] * gx * fy * gz + den[a0 + b1 + jx] * fx * fy * gz
        + den[a1 + b0 + ix] * gx * gy * fz + den[a1 + b0 + jx] * fx * gy * fz + den[a1 + b1 + ix] * gx * fy * fz + den[a1 + b1 + jx] * fx * fy * fz;
      // log10(ρ/ρ̄) from −1.5 .. +3.5 → 0..255
      const ld = Math.log10(Math.max(1e-3, d));
      out[i * 2] = Math.max(0, Math.min(255, Math.round((ld + 1.5) / 5 * 255)));
      const c = ((Math.floor(pz + 0.5) + nd) % nd) * nd2 + ((Math.floor(py + 0.5) + nd) % nd) * nd + ((Math.floor(px + 0.5) + nd) % nd);
      const n = cnt[c];
      let sig = 0;
      if (n > 1.5) {
        const mx = spx[c] / n, my = spy[c] / n, mz = spz[c] / n;
        sig = Math.sqrt(Math.max(0, sp2[c] / n - (mx * mx + my * my + mz * mz))) * vscale;
      }
      // σ_v in cells per Hubble time: log map 0.03 .. 30
      const lh = Math.log10(Math.max(1e-3, sig));
      out[i * 2 + 1] = Math.max(0, Math.min(255, Math.round((lh + 1.5) / 3 * 255)));
    }
    return out;
  }

  /** rms of δ on the force mesh (deltaMesh from the last force evaluation, or a fresh deposit) */
  rmsDelta() {
    this.deposit();
    let s = 0; for (let i = 0; i < this.rho.length; i++) s += this.rho[i] * this.rho[i];
    return Math.sqrt(s / this.rho.length);
  }
  totalMomentum() {
    let sx = 0, sy = 0, sz = 0, s2 = 0; const p = this.p;
    for (let i = 0; i < this.N; i++) { sx += p[i * 3]; sy += p[i * 3 + 1]; sz += p[i * 3 + 2]; s2 += p[i * 3] ** 2 + p[i * 3 + 1] ** 2 + p[i * 3 + 2] ** 2; }
    return { sum: [sx, sy, sz], rms: Math.sqrt(s2 / this.N) };
  }

  // --- halo finder ---------------------------------------------------------------------------
  /**
   * Density peaks of the Gaussian-smoothed final field: local maxima above threshold, mass =
   * sum over the 3³ neighbourhood, centre refined by centre of mass. Returns top `count`.
   */
  findHaloes(count = 250, smoothCells = 1.2, minDelta = 2) {
    const M = this.M, M2 = M * M, M3 = M2 * M;
    this.deposit();
    const raw = Float32Array.from(this.rho);
    const re = this.rho, im = this.im;
    im.fill(0);
    this.fft.transform(re, im, false);
    for (let z = 0; z < M; z++) for (let y = 0; y < M; y++) for (let x = 0; x < M; x++) {
      const kx = (x <= M / 2 ? x : x - M), ky = (y <= M / 2 ? y : y - M), kz = (z <= M / 2 ? z : z - M);
      const k2 = (kx * kx + ky * ky + kz * kz) * (2 * Math.PI / M) ** 2;
      const w = Math.exp(-0.5 * k2 * smoothCells * smoothCells);
      const i = (z * M + y) * M + x; re[i] *= w; im[i] *= w;
    }
    this.fft.transform(re, im, true);
    const sm = re;
    const idx = (x, y, z) => (((z + M) % M) * M + ((y + M) % M)) * M + ((x + M) % M);
    const peaks = [];
    for (let z = 0; z < M; z++) for (let y = 0; y < M; y++) for (let x = 0; x < M; x++) {
      const v = sm[(z * M + y) * M + x];
      if (v < minDelta) continue;
      let isMax = true;
      for (let dz = -1; dz <= 1 && isMax; dz++) for (let dy = -1; dy <= 1 && isMax; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy && !dz) continue;
        if (sm[idx(x + dx, y + dy, z + dz)] > v) { isMax = false; break; }
      }
      if (!isMax) continue;
      let m = 0, cx = 0, cy = 0, cz = 0;
      for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const w = Math.max(0, raw[idx(x + dx, y + dy, z + dz)] + 1);
        m += w; cx += w * dx; cy += w * dy; cz += w * dz;
      }
      // anisotropy of the surrounding mass (filament vs node) in a radius-4 neighbourhood
      let Ixx = 0, Iyy = 0, Izz = 0, Ixy = 0, Ixz = 0, Iyz = 0, mw = 0;
      for (let dz = -4; dz <= 4; dz++) for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
        const r2 = dx * dx + dy * dy + dz * dz; if (r2 > 16 || r2 < 2) continue;
        const w = Math.max(0, sm[idx(x + dx, y + dy, z + dz)]);
        Ixx += w * dx * dx; Iyy += w * dy * dy; Izz += w * dz * dz; Ixy += w * dx * dy; Ixz += w * dx * dz; Iyz += w * dy * dz; mw += w;
      }
      const ev = eigSym3(Ixx, Iyy, Izz, Ixy, Ixz, Iyz);
      peaks.push({
        cell: [x, y, z],
        pos: [wrap(x + 0.5 + cx / m, M), wrap(y + 0.5 + cy / m, M), wrap(z + 0.5 + cz / m, M)],
        mass: m, peak: v, elong: ev[0] / Math.max(1e-6, ev[1]), env: mw,
      });
    }
    peaks.sort((a, b) => b.mass - a.mass);
    const out = peaks.slice(0, count);
    // nearest particle to each halo centre (so labels can follow the halo through cosmic time)
    const cellOf = new Map();
    out.forEach((h, i) => { h.particle = -1; h.best = 1e9; const k = (Math.floor(h.pos[2]) * M + Math.floor(h.pos[1])) * M + Math.floor(h.pos[0]); if (!cellOf.has(k)) cellOf.set(k, []); cellOf.get(k).push(i); });
    const x = this.x;
    for (let i = 0; i < this.N; i++) {
      const k = (Math.floor(x[i * 3 + 2]) * M + Math.floor(x[i * 3 + 1])) * M + Math.floor(x[i * 3]);
      const list = cellOf.get(k); if (!list) continue;
      for (const hi of list) {
        const h = out[hi];
        const d = (x[i * 3] - h.pos[0]) ** 2 + (x[i * 3 + 1] - h.pos[1]) ** 2 + (x[i * 3 + 2] - h.pos[2]) ** 2;
        if (d < h.best) { h.best = d; h.particle = i; }
      }
    }
    // mass in units of 10^12 solar masses: cell mass = Ωm ρcrit (L/M)³
    const cellMpc = this.boxMpc / M;
    const rhoM = 2.775e11 * this.cosmo.h * this.cosmo.h * this.cosmo.omegaM; // Msun / Mpc³
    for (const h of out) { h.massSun = h.mass * rhoM * cellMpc ** 3; delete h.best; }
    return out;
  }
}

// ---------------------------------------------------------------------------------------------
function wrap(v, M) { v %= M; return v < 0 ? v + M : v; }

function trilinear3(f, n, x, y, z, out) {
  let ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  ix = ((ix % n) + n) % n; iy = ((iy % n) + n) % n; iz = ((iz % n) + n) % n;
  const jx = (ix + 1) % n, jy = (iy + 1) % n, jz = (iz + 1) % n;
  const n2 = n * n;
  const w = [(1 - fx) * (1 - fy) * (1 - fz), fx * (1 - fy) * (1 - fz), (1 - fx) * fy * (1 - fz), fx * fy * (1 - fz), (1 - fx) * (1 - fy) * fz, fx * (1 - fy) * fz, (1 - fx) * fy * fz, fx * fy * fz];
  const id = [iz * n2 + iy * n + ix, iz * n2 + iy * n + jx, iz * n2 + jy * n + ix, iz * n2 + jy * n + jx, jz * n2 + iy * n + ix, jz * n2 + iy * n + jx, jz * n2 + jy * n + ix, jz * n2 + jy * n + jx];
  for (let c = 0; c < 3; c++) { let s = 0; for (let k = 0; k < 8; k++) s += f[c][id[k]] * w[k]; out[c] = s; }
}

/** eigenvalues (descending) of a symmetric 3×3 matrix (analytic) */
function eigSym3(a, b, c, d, e, f) {
  // matrix [[a,d,e],[d,b,f],[e,f,c]]
  const p1 = d * d + e * e + f * f;
  if (p1 < 1e-12) return [a, b, c].sort((x, y) => y - x);
  const q = (a + b + c) / 3;
  const p2 = (a - q) ** 2 + (b - q) ** 2 + (c - q) ** 2 + 2 * p1;
  const p = Math.sqrt(p2 / 6);
  const B = [(a - q) / p, d / p, e / p, d / p, (b - q) / p, f / p, e / p, f / p, (c - q) / p];
  const detB = B[0] * (B[4] * B[8] - B[5] * B[7]) - B[1] * (B[3] * B[8] - B[5] * B[6]) + B[2] * (B[3] * B[7] - B[4] * B[6]);
  const r = Math.max(-1, Math.min(1, detB / 2));
  const phi = Math.acos(r) / 3;
  const e1 = q + 2 * p * Math.cos(phi), e3 = q + 2 * p * Math.cos(phi + 2 * Math.PI / 3);
  return [e1, 3 * q - e1 - e3, e3];
}
