// ============================================================================
// dsp.js — Signal generation and filtering (operates on record time axis fs=192kHz)
//
// Signal chain (cutting/race simulation):
//   Source (pink noise M/S) → 20Hz rumble filter + music-like LF shaping (80Hz HPF)
//   → Side high-pass (bass mono) → M/S→L/R
//   → Mastering HF cutoff (Butterworth LPF) → Level (reference 5cm/s)
//   → RIAA recording pre-emphasis (velocity domain) → Leaky integration (velocity→displacement)
//   → Soft limiter (overcut prevention) → 45/45 wall displacement
// ============================================================================
import { CONST } from './params.js?v=20260706-sigma13-cache';

// --- Reproducible random number (mulberry32) ---
export function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Normal random number (Box-Muller)
export function makeGauss(rng) {
  let spare = null;
  return function () {
    if (spare !== null) { const v = spare; spare = null; return v; }
    let u, v, s;
    do { u = 2 * rng() - 1; v = 2 * rng() - 1; s = u * u + v * v; } while (s >= 1 || s === 0);
    const m = Math.sqrt(-2 * Math.log(s) / s);
    spare = v * m;
    return u * m;
  };
}

// --- Pink noise (Paul Kellet economical version, -3dB/oct 10Hz–20kHz) ---
// For white Gaussian input, output RMS ≈ PINK_RMS (normalization constant measured in calibrate.mjs)
export const PINK_RMS = 3.0548; // Measured value: output RMS for Gaussian input (calibrate.mjs [1])
// Measured peak cutter velocity [m/s] after pink noise passes through the mastering chain
// (20Hz HPF/80Hz LF shaping/mono/HF cutoff 16k/RIAA) (for unit RMS signal & amp=V_REF, calibrate.mjs [1b])
export const PINK_PEAK_VEL = 0.40707; // Measured (max |v| over 5 seconds, fixed seed)
export function makePink(gauss) {
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  return function () {
    const w = gauss();
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.96900 * b2 + w * 0.1538520;
    b3 = 0.86650 * b3 + w * 0.3104856;
    b4 = 0.55000 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.0168980;
    const out = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
    b6 = w * 0.115926;
    return out / PINK_RMS; // Normalize to unit RMS
  };
}

// --- 1st-order section (bilinear transform of analog (1+sTz)/(1+sTp)) ---
export class FirstOrder {
  constructor(Tz, Tp, fs) {
    const K = 2 * fs;
    const a0 = 1 + K * Tp;
    this.b0 = (1 + K * Tz) / a0;
    this.b1 = (1 - K * Tz) / a0;
    this.a1 = (1 - K * Tp) / a0;
    this.x1 = 0; this.y1 = 0;
  }
  process(x) {
    const y = this.b0 * x + this.b1 * this.x1 - this.a1 * this.y1;
    this.x1 = x; this.y1 = y;
    return y;
  }
  // Analog amplitude response (for normalization)
  static analogMag(Tz, Tp, f) {
    const w = 2 * Math.PI * f;
    return Math.sqrt((1 + (w * Tz) ** 2) / (1 + (w * Tp) ** 2));
  }
}

// --- RIAA recording pre-emphasis (velocity domain, normalized to 0dB at 1kHz) ---
// H(s) = (1+sT1)(1+sT3) / ((1+sT2)(1+sT4))
export class RiaaPreEmphasis {
  constructor(fs) {
    const { RIAA_T1: T1, RIAA_T2: T2, RIAA_T3: T3, RIAA_T4: T4 } = CONST;
    this.s1 = new FirstOrder(T1, T2, fs);
    this.s2 = new FirstOrder(T3, T4, fs);
    this.gain = 1 / (FirstOrder.analogMag(T1, T2, 1000) * FirstOrder.analogMag(T3, T4, 1000));
  }
  process(x) { return this.s2.process(this.s1.process(x)) * this.gain; }
}

// --- RIAA playback de-emphasis (inverse characteristic, used in measurement system) ---
export class RiaaDeEmphasis {
  constructor(fs) {
    const { RIAA_T1: T1, RIAA_T2: T2, RIAA_T3: T3, RIAA_T4: T4 } = CONST;
    this.s1 = new FirstOrder(T2, T1, fs);
    this.s2 = new FirstOrder(T4, T3, fs);
    this.gain = FirstOrder.analogMag(T1, T2, 1000) * FirstOrder.analogMag(T3, T4, 1000);
  }
  process(x) { return this.s2.process(this.s1.process(x)) * this.gain; }
}

// --- Biquad ---
export class Biquad {
  constructor(b0, b1, b2, a1, a2) {
    this.b0 = b0; this.b1 = b1; this.b2 = b2; this.a1 = a1; this.a2 = a2;
    this.z1 = 0; this.z2 = 0;
  }
  process(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
  static lowpass(f0, Q, fs) {
    const w = 2 * Math.PI * f0 / fs, cw = Math.cos(w), sw = Math.sin(w);
    const al = sw / (2 * Q), a0 = 1 + al;
    return new Biquad((1 - cw) / 2 / a0, (1 - cw) / a0, (1 - cw) / 2 / a0,
      (-2 * cw) / a0, (1 - al) / a0);
  }
  static highpass(f0, Q, fs) {
    const w = 2 * Math.PI * f0 / fs, cw = Math.cos(w), sw = Math.sin(w);
    const al = sw / (2 * Q), a0 = 1 + al;
    return new Biquad((1 + cw) / 2 / a0, -(1 + cw) / a0, (1 + cw) / 2 / a0,
      (-2 * cw) / a0, (1 - al) / a0);
  }
}

// Butterworth 4次 LPF (Q = 0.5412, 1.3066)
export function butter4LP(fc, fs) {
  const s1 = Biquad.lowpass(fc, 0.5412, fs);
  const s2 = Biquad.lowpass(fc, 1.3066, fs);
  return (x) => s2.process(s1.process(x));
}
// Butterworth 2次 HPF
export function butter2HP(fc, fs) {
  const s = Biquad.highpass(fc, 0.7071, fs);
  return (x) => s.process(x);
}

// --- Leaky integrator (velocity→displacement, DC leak ~5Hz: equivalent to cutting low-end limit) ---
export class LeakyIntegrator {
  constructor(fs, fLeak = 5) {
    this.a = Math.exp(-2 * Math.PI * fLeak / fs);
    this.dt = 1 / fs;
    this.y = 0;
  }
  process(v) { this.y = this.a * this.y + v * this.dt; return this.y; }
}

// ============================================================================
// SignalGenerator — Generates (L displacement, R displacement, L velocity, R velocity) per sample
// Displacement [m] corresponds to channel displacement along 45/45 wall normal direction
// ============================================================================
export class SignalGenerator {
  constructor(params, seed = 12345) {
    this.p = params;
    const fs = CONST.FS;
    const rng = makeRng(seed);
    const g1 = makeGauss(rng);
    const rng2 = makeRng(seed ^ 0x9e3779b9);
    const g2 = makeGauss(rng2);
    this.pinkM = makePink(g1);
    this.pinkS = makePink(g2);
    this.sideHP = butter2HP(params.monoBelow, fs);
    // Rumble filter (20Hz, -12dB/oct): essential HPF in real cutting systems.
    // RIAA recording characteristic is constant velocity below 50Hz → displacement ∝ f^-1.5, increasing towards low frequencies.
    // Without this, the <20Hz components of pink noise would dominate displacement and stick to the limiter.
    this.rumbleHP = butter2HP(20, fs);
    // Music-like LF shaping (80Hz, -12dB/oct): the long-term average spectrum of mastered music
    // decays below ~80Hz (instrument fundamental limits + mastering HPF). Raw pink noise has excessive
    // low frequencies compared to music, and with only a 20Hz cut, displacement at 20-60Hz would remain stuck to the limiter.
    this.musicLF = butter2HP(80, fs);
    this.hfL = butter4LP(params.hfCutoff, fs);
    this.hfR = butter4LP(params.hfCutoff, fs);
    this.riaaL = new RiaaPreEmphasis(fs);
    this.riaaR = new RiaaPreEmphasis(fs);
    this.intL = new LeakyIntegrator(fs);
    this.intR = new LeakyIntegrator(fs);
    this.phase = 0;
    this.n = 0;
    // Soft limiter threshold (wall displacement): overcut prevention
    this.dispLimit = CONST.CUT_DISP_LIMIT;
  }

  // → {dL, dR, vL, vR}  d:変位[m] v:カッター速度[m/s](RIAA後)
  next() {
    const p = this.p;
    // Level is peak-based (analog mastering equivalent):
    //   0dB = 45/45 wall direction peak 5cm/s (matches mono lateral RMS 5cm/s reference)
    //   Pink noise is normalized by measured peak PINK_PEAK_VEL after passing through the chain.
    //   Music peaks on LP albums are typically +10 to +12dB above reference → default level +12dB
    const lvl = Math.pow(10, p.levelDb / 20);
    const amp = p.signalType === 'pink'
      ? lvl * CONST.V_REF * (CONST.V_REF / PINK_PEAK_VEL)
      : lvl * CONST.V_REF; // sine: 1kHzでピーク5cm/s
    let mRaw = 0, sRaw = 0;
    if (p.signalType === 'pink') {
      mRaw = this.musicLF(this.rumbleHP(this.pinkM()));
      sRaw = this.sideHP(this.pinkS()) * p.sideMix; // Sideは250Hz HPF済 (追加不要)
    } else if (p.signalType === 'sine') {
      // 1kHz 0dB = sine wave equivalent to mono lateral 5cm/s RMS (wall direction peak 5cm/s)
      mRaw = Math.SQRT2 * Math.sin(this.phase);
      this.phase += 2 * Math.PI * p.sineFreq / CONST.FS;
      if (this.phase > 2 * Math.PI) this.phase -= 2 * Math.PI;
      sRaw = 0;
    } // silence: 0のまま

    // M/S → L/R (electrical signal domain, unit RMS reference)
    const SQ = Math.SQRT1_2;
    let L = (mRaw + sRaw) * SQ;
    let R = (mRaw - sRaw) * SQ;

    // Mastering HF cutoff
    L = this.hfL(L); R = this.hfR(R);

    // Level → cutter velocity [m/s], RIAA recording equalization (velocity domain)
    const vL = this.riaaL.process(L * amp);
    const vR = this.riaaR.process(R * amp);

    // Velocity→displacement, soft limit (overcut prevention. Fully linear up to 70% threshold,
    // smooth knee above that — produces no distortion at low levels)
    const dL = softClip(this.intL.process(vL), this.dispLimit);
    const dR = softClip(this.intR.process(vR), this.dispLimit);
    this.n++;
    return { dL, dR, vL, vR };
  }
}

// C1 continuous soft clip: |x| ≤ 0.7·lim is identity, then tanh knee
export function softClip(x, lim) {
  const u = x / lim, au = Math.abs(u);
  if (au <= 0.7) return x;
  const s = u > 0 ? 1 : -1;
  return s * lim * (0.7 + 0.3 * Math.tanh((au - 0.7) / 0.3));
}
