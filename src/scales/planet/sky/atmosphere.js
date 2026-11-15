// Atmosphere model for SONDER's small worlds — ONE model, written twice in lockstep:
//   * JS  (AtmosphereModel): parameters from the descriptor, art-direction fit, a CPU transmittance LUT and a
//     coarse sky march used for the lighting environment (sun colour, ambient, fog) and gameplay queries.
//   * GLSL (ATMO_GLSL): the same density profiles, transmittance mapping, planet-shadow cheat and phase
//     functions, used by the GPU LUT passes, the sky dome and every material (via shared.js).
// If you change a formula in one half, change it in the other.
//
// Small-planet cheats (R ≈ 5–10 km, see the lead's playbook):
//   * scale heights are ~0.08 R (Rayleigh) / 0.3 of that (Mie); atmosphere top = R + 7 Hr;
//   * coefficients are rescaled so the ZENITH optical depth is Earth-like (τ = β·H), then boosted (KR) so the
//     short grazing air mass still reddens the sun;
//   * the descriptor's hex hints are FIT: Rayleigh chroma is solved so the zenith matches `sky`, an aerosol
//     tint so the horizon matches `horizon`, and the sun transmittance is pulled toward `sunset` along long paths;
//   * the planet's shadow uses a compressed horizon dip (uShadowDip) — on a 9 km world the upper air would
//     otherwise stay sunlit until the sun is 40° down and there would be no night.
import * as THREE from 'three';

export const LUMA = [0.2126, 0.7152, 0.0722];
const luma = (c) => c[0] * LUMA[0] + c[1] * LUMA[1] + c[2] * LUMA[2];
const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const hexLin = (hex) => { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; };

export const TRANS_W = 256, TRANS_H = 64;
const JS_TW = 96, JS_TH = 32;

/** Build the parameter set for a planet descriptor + star. Pure numbers; `fit()` then art-directs them. */
export function atmosphereParams(desc, star, R) {
  const a = desc.atmosphere;
  const Hr = Math.min(900, Math.max(420, R * 0.08));
  const Hm = Hr * 0.3;
  const p = {
    has: !!a,
    R, Hr, Hm,
    top: R + Hr * 7,
    ozoneC: Hr * 2.6, ozoneW: Hr * 2.0,
    betaR: [0, 0, 0], betaMs: [0, 0, 0], betaMe: [0, 0, 0], betaO: [0, 0, 0],
    mieG: 0.78,
    sunsetTint: [1, 0.5, 0.2], sunsetAmt: 0,
    shadowDip: 0.22,
    msK: 0.35,          // multiple-scattering strength (isotropic, fraction of single scattering light)
    skyHint: [0.25, 0.5, 1], horizonHint: [0.7, 0.8, 0.9],
  };
  if (!a) return p;
  const d = a.density ?? 1;
  const KR = 1.7; // grazing-path boost (see header)
  const ray = a.rayleigh || [5.8, 13.5, 33.1];
  for (let i = 0; i < 3; i++) p.betaR[i] = ray[i] * 1e-6 * (8000 / Hr) * d * KR;
  // aerosol zenith optical depth from mie + fog hints
  const tauM = 0.045 * (a.mie ?? 1) * (0.45 + (a.fog ?? 0.4)) * d;
  const bm = tauM / Hm;
  p.betaMs = [bm, bm, bm];
  p.betaMe = [bm / 0.9, bm / 0.9, bm / 0.9];
  // ozone-like absorber (Chappuis band): deepens blue hour and keeps twilight from going grey
  const ozTau = 0.05 * d;
  const oz = [0.65 / 1.88, 1, 0.085 / 1.88];
  for (let i = 0; i < 3; i++) p.betaO[i] = oz[i] * ozTau / p.ozoneW;
  p.mieG = Math.min(0.86, 0.72 + 0.03 * (a.mie ?? 1));
  p.skyHint = hexLin(a.sky || '#3f84e6');
  p.horizonHint = hexLin(a.horizon || '#bcd8f5');
  const st = hexLin(a.sunset || '#ff9a4d');
  const l = luma(st) || 1;
  p.sunsetTint = st.map((v) => v / l);
  p.sunsetAmt = 0.75;
  return p;
}

export class AtmosphereModel {
  constructor(params) {
    this.p = params;
    this.lut = new Float32Array(JS_TW * JS_TH * 3);
    this.rebuild();
  }

  // ---- shared formulas (mirror of ATMO_GLSL) ----------------------------------------------------
  density(h, out) {
    const p = this.p;
    out[0] = Math.exp(-h / p.Hr); out[1] = Math.exp(-h / p.Hm);
    out[2] = Math.max(0, 1 - Math.abs(h - p.ozoneC) / p.ozoneW);
    return out;
  }
  ext(d, i) { const p = this.p; return p.betaR[i] * d[0] + p.betaMe[i] * d[1] + p.betaO[i] * d[2]; }

  /** Raw (un-shadowed, art-warped) transmittance from radius r along mu to the top of the atmosphere. */
  _transmittanceRaw(r, mu, out) {
    const p = this.p, R = p.R, top = p.top;
    const b = r * mu, c = r * r - top * top;
    const disc = b * b - c;
    const t1 = -b + Math.sqrt(Math.max(0, disc));
    const N = 40, ds = t1 / N, dd = [0, 0, 0];
    let t0 = 0, t1v = 0, t2 = 0;
    for (let i = 0; i < N; i++) {
      const s = (i + 0.5) * ds;
      const h = Math.sqrt(r * r + s * s + 2 * r * mu * s) - R;
      this.density(h, dd);
      t0 += this.ext(dd, 0) * ds; t1v += this.ext(dd, 1) * ds; t2 += this.ext(dd, 2) * ds;
    }
    out[0] = Math.exp(-t0); out[1] = Math.exp(-t1v); out[2] = Math.exp(-t2);
    return artT(out, p.sunsetTint, p.sunsetAmt);
  }

  rebuild() {
    const p = this.p, H = Math.sqrt(p.top * p.top - p.R * p.R), tmp = [0, 0, 0];
    for (let j = 0; j < JS_TH; j++) for (let i = 0; i < JS_TW; i++) {
      const xmu = i / (JS_TW - 1), xr = j / (JS_TH - 1);
      const { r, mu } = transUvInverse(xmu, xr, p.R, p.top, H);
      this._transmittanceRaw(r, mu, tmp);
      const o = (j * JS_TW + i) * 3; this.lut[o] = tmp[0]; this.lut[o + 1] = tmp[1]; this.lut[o + 2] = tmp[2];
    }
  }

  /** LUT transmittance (no planet shadow). */
  transmittance(r, mu, out) {
    const p = this.p, H = Math.sqrt(p.top * p.top - p.R * p.R);
    r = Math.min(Math.max(r, p.R + 1), p.top);
    const muH = -Math.sqrt(Math.max(0, 1 - (p.R / r) ** 2));
    mu = Math.max(mu, muH + 1e-4);
    const { x, y } = transUv(r, mu, p.R, p.top, H);
    const fx = x * (JS_TW - 1), fy = y * (JS_TH - 1);
    const i0 = Math.min(JS_TW - 2, Math.floor(fx)), j0 = Math.min(JS_TH - 2, Math.floor(fy));
    const ax = fx - i0, ay = fy - j0, L = this.lut;
    for (let k = 0; k < 3; k++) {
      const a00 = L[(j0 * JS_TW + i0) * 3 + k], a10 = L[(j0 * JS_TW + i0 + 1) * 3 + k];
      const a01 = L[((j0 + 1) * JS_TW + i0) * 3 + k], a11 = L[((j0 + 1) * JS_TW + i0 + 1) * 3 + k];
      out[k] = (a00 * (1 - ax) + a10 * ax) * (1 - ay) + (a01 * (1 - ax) + a11 * ax) * ay;
    }
    return out;
  }
  /** Soft planet-shadow visibility of the sun from radius r at cosine mu (compressed dip, see header). */
  shadow(r, mu, soft = 0) {
    const p = this.p;
    const sinDip = Math.sqrt(Math.max(0, 1 - (p.R / Math.max(r, p.R + 0.01)) ** 2));
    const muH = -Math.sin(Math.asin(sinDip) * p.shadowDip);
    const w = 0.012 + soft;
    return sstep(muH - w, muH + w, mu);
  }
  /** Sun transmittance incl. planet shadow. */
  sunTransmittance(r, mu, out, soft = 0) {
    this.transmittance(r, mu, out);
    const v = this.shadow(r, mu, soft);
    out[0] *= v; out[1] *= v; out[2] *= v;
    return out;
  }

  /**
   * Sky radiance seen from `ro` (array xyz) along unit `rd`, for unit sun illuminance (colour 1,1,1),
   * no night light. Returns { L:[r,g,b], T:grey transmittance of the path }.
   * `light2` optional { dir:[x,y,z], E:[r,g,b] }, `nightE` optional isotropic [r,g,b] in the same units.
   */
  sky(ro, rd, sunDir, out = { L: [0, 0, 0], T: 1 }, N = 20, sunE = [1, 1, 1], nightE = null) {
    const p = this.p;
    out.L[0] = out.L[1] = out.L[2] = 0; out.T = 1;
    if (!p.has) return out;
    let r = Math.hypot(ro[0], ro[1], ro[2]);
    const o = r < p.R + 1 ? [ro[0] / r * (p.R + 1), ro[1] / r * (p.R + 1), ro[2] / r * (p.R + 1)] : [ro[0], ro[1], ro[2]];
    const top = raySphere(o, rd, p.top); if (!top) return out;
    const tS = Math.max(top[0], 0); let tE = top[1];
    const g = raySphere(o, rd, p.R); if (g && g[0] > 0) tE = Math.min(tE, g[0]);
    const cosT = rd[0] * sunDir[0] + rd[1] * sunDir[1] + rd[2] * sunDir[2];
    const phR = phaseR(cosT), phM = phaseM(cosT, p.mieG);
    const Tv = [1, 1, 1], d = [0, 0, 0], Ts = [0, 0, 0], Tm = [0, 0, 0];
    for (let i = 0; i < N; i++) {
      const a = i / N, b = (i + 1) / N;
      const s0 = tS + (tE - tS) * a * a, s1 = tS + (tE - tS) * b * b, ds = s1 - s0, t = (s0 + s1) * 0.5;
      const px = o[0] + rd[0] * t, py = o[1] + rd[1] * t, pz = o[2] + rd[2] * t;
      const pr = Math.hypot(px, py, pz);
      this.density(pr - p.R, d);
      const muS = (px * sunDir[0] + py * sunDir[1] + pz * sunDir[2]) / pr;
      this.transmittance(pr, muS, Ts);
      const vis = this.shadow(pr, muS), visMs = this.shadow(pr, muS, 0.09);
      for (let k = 0; k < 3; k++) {
        const sR = p.betaR[k] * d[0], sM = p.betaMs[k] * d[1];
        let S = sunE[k] * Ts[k] * (vis * (sR * phR + sM * phM) + visMs * (sR + sM) * p.msK / (4 * Math.PI));
        if (nightE) S += (sR + sM) * nightE[k] / (4 * Math.PI);
        const e = this.ext(d, k), Tst = Math.exp(-e * ds);
        out.L[k] += Tv[k] * (e > 1e-12 ? (S - S * Tst) / e : S * ds);
        Tv[k] *= Tst;
      }
    }
    out.T = luma(Tv);
    return out;
  }

  /**
   * Art-direction fit: adjust Rayleigh chroma until the zenith matches the `sky` hint and an aerosol tint
   * until the horizon matches `horizon` (both at a mid-morning sun), keeping overall optical depths.
   */
  fit(strength = 0.85) {
    const p = this.p; if (!p.has) return;
    const R = p.R, ro = [0, R + 2, 0];
    const sun = [Math.cos(0.6), Math.sin(0.6), 0];
    const zen = [0, 1, 0];
    const hz = [0, Math.sin(0.05), Math.cos(0.05)];
    const lR = luma(p.betaR), r0 = [...p.betaR];
    const lM = luma(p.betaMs), m0 = [...p.betaMs];
    const tint = [1, 1, 1];
    const out = { L: [0, 0, 0], T: 1 };
    const chroma = (c) => { const l = luma(c) || 1e-9; return c.map((v) => Math.max(v / l, 1e-4)); };
    // targets: blend hint chroma with the physical result (keep some physics)
    this.sky(ro, zen, sun, out); const z0 = chroma(out.L);
    this.sky(ro, hz, sun, out); const h0 = chroma(out.L);
    const zt = chroma(p.skyHint).map((v, i) => Math.pow(v, strength) * Math.pow(z0[i], 1 - strength));
    const ht = chroma(p.horizonHint).map((v, i) => Math.pow(v, strength) * Math.pow(h0[i], 1 - strength));
    for (let it = 0; it < 6; it++) {
      this.sky(ro, zen, sun, out); const zc = chroma(out.L);
      for (let k = 0; k < 3; k++) p.betaR[k] = Math.min(r0[k] * 6, Math.max(r0[k] / 6, p.betaR[k] * Math.pow(zt[k] / zc[k], 0.9)));
      const l = luma(p.betaR); for (let k = 0; k < 3; k++) p.betaR[k] *= lR / l;
      this.rebuild();
      this.sky(ro, hz, sun, out); const hc = chroma(out.L);
      for (let k = 0; k < 3; k++) tint[k] = Math.min(1.6, Math.max(0.25, tint[k] * Math.pow(ht[k] / hc[k], 1.2)));
      const mx = Math.max(...tint); for (let k = 0; k < 3; k++) { tint[k] /= mx; p.betaMs[k] = m0[k] * tint[k]; }
      const lm = luma(p.betaMs); for (let k = 0; k < 3; k++) p.betaMs[k] *= lM / Math.max(lm, 1e-12);
      this.rebuild();
    }
    p.mieTint = tint;
  }
}

// ---- small helpers (JS) ------------------------------------------------------------------------
export function raySphere(o, d, rad) {
  const b = o[0] * d[0] + o[1] * d[1] + o[2] * d[2];
  const c = o[0] * o[0] + o[1] * o[1] + o[2] * o[2] - rad * rad;
  const disc = b * b - c; if (disc < 0) return null;
  const s = Math.sqrt(disc); return [-b - s, -b + s];
}
export function phaseR(c) { return (3 / (16 * Math.PI)) * (1 + c * c); }
export function phaseM(c, g) {
  const g2 = g * g;
  return (3 / (8 * Math.PI)) * ((1 - g2) * (1 + c * c)) / ((2 + g2) * Math.pow(1 + g2 - 2 * g * c, 1.5));
}
function artT(T, tint, amt) {
  const l = luma(T);
  const w = amt * sstep(0.92, 0.3, l);
  for (let k = 0; k < 3; k++) T[k] = Math.min(1, T[k] + (tint[k] * l - T[k]) * w);
  return T;
}
function transUv(r, mu, R, top, H) {
  const rho = Math.sqrt(Math.max(0, r * r - R * R));
  const disc = r * r * (mu * mu - 1) + top * top;
  const d = Math.max(0, -r * mu + Math.sqrt(Math.max(0, disc)));
  const dmin = top - r, dmax = rho + H;
  return { x: (d - dmin) / Math.max(dmax - dmin, 1e-6), y: rho / H };
}
function transUvInverse(xmu, xr, R, top, H) {
  const rho = H * xr, r = Math.sqrt(rho * rho + R * R);
  const dmin = top - r, dmax = rho + H, d = dmin + xmu * (dmax - dmin);
  const mu = d === 0 ? 1 : Math.min(1, Math.max(-1, (H * H - rho * rho - d * d) / (2 * r * d)));
  return { r, mu };
}

// ================================================================================================
// GLSL half. Requires the uniforms declared in shared.js (uAtmo*, uBeta*, uTransLUT, uSkyLUT, uSkyFrame…).
// ================================================================================================
export const ATMO_GLSL = /* glsl */`
#ifndef SONDER_ATMO
#define SONDER_ATMO
#define ATMO_PI 3.141592653589793
const vec3 ATMO_LUMA = vec3(0.2126, 0.7152, 0.0722);
// ray / sphere centred at the origin: returns (t0, t1); t0 > t1 means miss
vec2 atmoRaySphere(vec3 ro, vec3 rd, float rad) {
  float b = dot(ro, rd); float c = dot(ro, ro) - rad * rad; float disc = b * b - c;
  if (disc < 0.0) return vec2(1e9, -1e9);
  float s = sqrt(disc); return vec2(-b - s, -b + s);
}
vec3 atmoDensity(float h) {
  return vec3(exp(-h / uAtmoShape.x), exp(-h / uAtmoShape.y), max(0.0, 1.0 - abs(h - uAtmoShape.z) / uAtmoShape.w));
}
vec3 atmoExtinction(vec3 d) { return uBetaR * d.x + uBetaMe * d.y + uBetaO * d.z; }
float atmoPhaseR(float c) { return 0.0596831 * (1.0 + c * c); }
float atmoPhaseM(float c) {
  float g = uMieG, g2 = g * g;
  return 0.1193662 * ((1.0 - g2) * (1.0 + c * c)) / ((2.0 + g2) * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5));
}
vec2 atmoTransUv(float r, float mu) {
  float R = uAtmoR, top = uAtmoTop;
  float H = sqrt(top * top - R * R);
  float rho = sqrt(max(0.0, r * r - R * R));
  float disc = r * r * (mu * mu - 1.0) + top * top;
  float d = max(0.0, -r * mu + sqrt(max(0.0, disc)));
  float dmin = top - r, dmax = rho + H;
  vec2 x = vec2((d - dmin) / max(dmax - dmin, 1e-3), rho / H);
  return vec2(0.5 / 256.0, 0.5 / 64.0) + x * vec2(255.0 / 256.0, 63.0 / 64.0);
}
// transmittance to the top of the atmosphere (no planet shadow)
vec3 atmoTransmittanceRaw(float r, float mu) {
  r = clamp(r, uAtmoR + 1.0, uAtmoTop);
  float muH = -sqrt(max(0.0, 1.0 - (uAtmoR / r) * (uAtmoR / r)));
  return texture2D(uTransLUT, atmoTransUv(r, max(mu, muH + 1e-4))).rgb;
}
// soft planet shadow with a compressed horizon dip (see sky/atmosphere.js header)
float atmoShadow(float r, float mu, float soft) {
  float q = uAtmoR / max(r, uAtmoR + 0.01);
  float sinDip = sqrt(max(0.0, 1.0 - q * q));
  float muH = -sin(asin(sinDip) * uShadowDip);
  float w = 0.012 + soft;
  return smoothstep(muH - w, muH + w, mu);
}
vec3 atmoSunTransmittance(float r, float mu) { return atmoTransmittanceRaw(r, mu) * atmoShadow(r, mu, 0.0); }
// sky-view LUT addressing (lat-long around the camera's up, sun azimuth at u = 0.5, horizon at v = 0.5)
vec2 atmoSkyUv(vec3 dir) {
  vec3 l = dir * uSkyFrame;                    // = transpose(frame) * dir -> (sunward, side, up)
  float el = asin(clamp(l.z, -1.0, 1.0));
  float az = atan(l.y, l.x);
  float h = uSkyHorizon;
  float v = el >= h ? 0.5 + 0.5 * sqrt(clamp((el - h) / (1.5707963 - h), 0.0, 1.0))
                    : 0.5 - 0.5 * sqrt(clamp((h - el) / (h + 1.5707963), 0.0, 1.0));
  return vec2(az * 0.15915494 + 0.5, v);
}
// rgb: in-scattered radiance along dir (scene units, to ground or space); a: grey transmittance of that path
vec4 sonderSkyLUT(vec3 dir) { return texture2D(uSkyLUT, atmoSkyUv(dir)); }
// optical depth (rgb) along ro + rd*[a,b] — 5-point Simpson on the exponential profiles
vec3 atmoOpticalDepth(vec3 ro, vec3 rd, float a, float b) {
  float hs = (b - a) * 0.25;
  vec3 acc = vec3(0.0);
  for (int i = 0; i < 5; i++) {
    float w = (i == 0 || i == 4) ? 1.0 : ((i == 2) ? 2.0 : 4.0);
    vec3 p = ro + rd * (a + hs * float(i));
    acc += w * atmoDensity(length(p) - uAtmoR);
  }
  acc *= hs / 3.0;
  return atmoExtinction(acc);
}
#endif
`;
