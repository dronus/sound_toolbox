// ============================================================================
// analysis.js — Measurement (offline high-speed simulation) and analysis/plotting
//
// Measurement runs a separate simulation instance from the visualization,
// collecting output at 192kHz (stylus velocity → 45/45 decoding → RIAA playback EQ)
// to calculate Welch PSD, transfer characteristics, SNR, equivalent bits, THD, and mistrack rate.
// ============================================================================
import { CONST, snrToBits } from './params.js?v=20260706-sigma13-cache';
import { RiaaDeEmphasis } from './dsp.js?v=20260706-sigma13-cache';
import { GrooveModel } from './groove.js?v=20260706-sigma13-cache';
import { StylusSim } from './physics.js?v=20260706-sigma13-cache';

// ---------------- FFT (radix-2, in-place) ----------------
export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cwr = 1, cwi = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cwr - im[i + k + len / 2] * cwi;
        const vi = re[i + k + len / 2] * cwi + im[i + k + len / 2] * cwr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const nwr = cwr * wr - cwi * wi;
        cwi = cwr * wi + cwi * wr; cwr = nwr;
      }
    }
  }
}

// Welch method one-sided PSD [unit²/Hz] (Hann window, 50% overlap)
export function welchPsd(x, fs, nfft = 8192) {
  const win = new Float64Array(nfft);
  let winPow = 0;
  for (let i = 0; i < nfft; i++) {
    win[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / nfft));
    winPow += win[i] * win[i];
  }
  const hop = nfft >> 1;
  const nSeg = Math.max(1, Math.floor((x.length - nfft) / hop) + 1);
  const psd = new Float64Array(nfft / 2 + 1);
  const re = new Float64Array(nfft), im = new Float64Array(nfft);
  for (let s = 0; s < nSeg; s++) {
    const off = s * hop;
    for (let i = 0; i < nfft; i++) { re[i] = (x[off + i] || 0) * win[i]; im[i] = 0; }
    fft(re, im);
    for (let k = 0; k <= nfft / 2; k++) {
      let p = (re[k] * re[k] + im[k] * im[k]) / (fs * winPow);
      if (k > 0 && k < nfft / 2) p *= 2;
      psd[k] += p;
    }
  }
  for (let k = 0; k < psd.length; k++) psd[k] /= nSeg;
  const freqs = new Float64Array(psd.length);
  for (let k = 0; k < psd.length; k++) freqs[k] = k * fs / nfft;
  return { freqs, psd };
}

// Band RMS (PSD integration)
export function bandRms(freqs, psd, f1, f2) {
  let p = 0;
  for (let k = 1; k < freqs.length; k++) {
    const f = freqs[k];
    if (f < f1 || f > f2) continue;
    p += psd[k] * (freqs[k] - freqs[k - 1]);
  }
  return Math.sqrt(p);
}

// 1/N-octave logarithmic smoothing
export function logSmooth(freqs, vals, perOct = 24) {
  const out = { f: [], v: [] };
  let f = 20;
  const r = Math.pow(2, 1 / perOct), rh = Math.pow(2, 0.5 / perOct);
  while (f <= 24000) {
    let sum = 0, n = 0;
    for (let k = 0; k < freqs.length; k++) {
      if (freqs[k] >= f / rh && freqs[k] < f * rh) { sum += vals[k]; n++; }
    }
    if (n > 0) { out.f.push(f); out.v.push(sum / n); }
    f *= r;
  }
  return out;
}

// Goertzel (RMS amplitude of a single frequency)
export function goertzelRms(x, fs, f) {
  const n = x.length;
  const w = 2 * Math.PI * f / fs, c = 2 * Math.cos(w);
  let s0 = 0, s1 = 0, s2 = 0;
  for (let i = 0; i < n; i++) { s0 = x[i] + c * s1 - s2; s2 = s1; s1 = s0; }
  const re = s1 - s2 * Math.cos(w), im = s2 * Math.sin(w);
  return Math.sqrt(re * re + im * im) * Math.SQRT2 / n;
}

// ---------------- Measurement Runner ----------------
export class Measurement {
  // overrides: Overwrites to params (e.g., {signalType:'silence'})
  constructor(params, overrides = {}, duration = 0.4, seed = 20260705) {
    this.params = Object.assign({}, params, overrides);
    this.duration = duration;
    this.seed = seed;
  }

  // Chunked execution (to avoid blocking the UI). => returns result object
  async run(progressCb = null) {
    const p = this.params;
    const groove = new GrooveModel(p, this.seed);
    const sim = new StylusSim(p, groove, this.seed ^ 0xabc);
    const fs = CONST.FS;
    const nTotal = Math.floor(this.duration * fs);
    const outL = new Float64Array(nTotal), outR = new Float64Array(nTotal);
    const inL = new Float64Array(nTotal), inR = new Float64Array(nTotal);
    let n = 0;
    sim.onOutput = (vLp, vRp, s) => {
      if (n >= nTotal) return;
      const ref = groove.refVelocity(s);
      outL[n] = vLp; outR[n] = vRp;
      inL[n] = ref.vL; inR[n] = ref.vR;
      n++;
    };
    const stepsTotal = nTotal * CONST.PHYS_SUBSTEPS;
    const chunk = Math.floor(0.02 * fs) * CONST.PHYS_SUBSTEPS; // 20ms刻み
    let done = 0;
    while (done < stepsTotal) {
      const k = Math.min(chunk, stepsTotal - done);
      sim.step(k);
      done += k;
      if (progressCb) progressCb(done / stepsTotal);
      await new Promise(r => setTimeout(r, 0));
    }

    // RIAA playback de-emphasis (phono EQ equivalent) — applied to both input and output.
    // To prevent filter transients from entering the measurement window, 
    // it is applied to the full range and the first 50ms are discarded.
    const deo = { L: new RiaaDeEmphasis(fs), R: new RiaaDeEmphasis(fs) };
    const dei = { L: new RiaaDeEmphasis(fs), R: new RiaaDeEmphasis(fs) };
    const outDeFullL = new Float64Array(n), outDeFullR = new Float64Array(n);
    const inDeFullL = new Float64Array(n), inDeFullR = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      outDeFullL[i] = deo.L.process(outL[i]); outDeFullR[i] = deo.R.process(outR[i]);
      inDeFullL[i] = dei.L.process(inL[i]); inDeFullR[i] = dei.R.process(inR[i]);
    }

    // Discard the first 50ms (settling period)
    const skip = Math.floor(0.05 * fs);
    const oL = outL.subarray(skip, n), oR = outR.subarray(skip, n);
    const outDeL = outDeFullL.subarray(skip, n), outDeR = outDeFullR.subarray(skip, n);
    const inDeL = inDeFullL.subarray(skip, n), inDeR = inDeFullR.subarray(skip, n);

    const time = this.duration - 0.05;
    return {
      fs, params: p,
      outDeL, outDeR, inDeL, inDeR,
      outRawL: oL, outRawR: oR,
      mistrackPerSec: sim.mistrackCount / time,
      skipPerSec: sim.skipCount / time,
      sim, groove, time,
    };
  }
}

// Full spectra (after de-emphasis, L+R average power)
export function computeSpectra(res, nfft = 8192) {
  const a = welchPsd(res.outDeL, res.fs, nfft);
  const b = welchPsd(res.outDeR, res.fs, nfft);
  const ai = welchPsd(res.inDeL, res.fs, nfft);
  const bi = welchPsd(res.inDeR, res.fs, nfft);
  const psdOut = a.psd.map((v, k) => (v + b.psd[k]) / 2);
  const psdIn = ai.psd.map((v, k) => (v + bi.psd[k]) / 2);
  return { freqs: a.freqs, psdOut, psdIn };
}

// SNR [dB re 5cm/s] and bit equivalence (based on noise measurement)
export function computeSnr(res) {
  const { freqs, psd } = (() => {
    const a = welchPsd(res.outDeL, res.fs);
    const b = welchPsd(res.outDeR, res.fs);
    return { freqs: a.freqs, psd: a.psd.map((v, k) => (v + b.psd[k]) / 2) };
  })();
  const noise = bandRms(freqs, psd, 20, 20000);
  const snr = 20 * Math.log10(CONST.V_REF / Math.max(noise, 1e-12));
  return { snr, bits: snrToBits(snr), noiseRms: noise, freqs, psd };
}

// THD (during sine measurement): fundamental and 2nd to 9th harmonics
export function computeThd(res, f0) {
  const x = res.outDeL;
  const fund = goertzelRms(x, res.fs, f0);
  let harmPow = 0;
  const harms = [];
  for (let h = 2; h <= 9; h++) {
    if (h * f0 > res.fs * 0.45) break;
    const a = goertzelRms(x, res.fs, h * f0);
    harms.push({ h, db: 20 * Math.log10(a / Math.max(fund, 1e-12)) });
    harmPow += a * a;
  }
  return { thdPct: 100 * Math.sqrt(harmPow) / Math.max(fund, 1e-12), fund, harms };
}

// σ calibration: adjust SNR to target value using silence measurement (2 iterations)
export async function calibrateSigma(params, targetDb = 70, progressCb = null, duration = 0.35) {
  let sigma = params.roughSigma;
  for (let it = 0; it < 2; it++) {
    const m = new Measurement(params, {
      signalType: 'silence', roughSigma: sigma, dustRate: 0, staticRate: 0,
    }, duration);
    const res = await m.run(progressCb ? f => progressCb((it + f) / 2) : null);
    const { snr } = computeSnr(res);
    sigma = sigma * Math.pow(10, (snr - targetDb) / 20);
  }
  return sigma;
}

// ---------------- Plotting (Canvas 2D, validated palette for dark surfaces) ----------------
const CH = {
  surface: '#1a1a19', grid: '#2c2c2a', axis: '#383835',
  muted: '#898781', ink: '#ffffff', ink2: '#c3c2b7',
  s1: '#3987e5',  // Series 1: Input (blue)
  s2: '#199e70',  // Series 2: Output (aqua)
  s3: '#c98500',  // Series 3: Noise etc. (yellow)
  crit: '#d03b3b',
};
const FONT = '11px system-ui, -apple-system, "Segoe UI", sans-serif';

function setupCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr; canvas.height = h * dpr;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

// Line chart with logarithmic frequency axis + dB axis
// series: [{f:[], v:[](dB), color, label}]
export function plotLines(canvas, series, opts = {}) {
  const { ctx, w, h } = setupCanvas(canvas);
  const mL = 46, mR = 64, mT = 24, mB = 26;
  const pw = w - mL - mR, ph = h - mT - mB;
  const f1 = opts.fMin ?? 20, f2 = opts.fMax ?? 24000;
  let vMin = opts.vMin, vMax = opts.vMax;
  if (vMin === undefined || vMax === undefined) {
    let lo = Infinity, hi = -Infinity;
    for (const s of series) for (const v of s.v) {
      if (!isFinite(v)) continue;
      if (v < lo) lo = v; if (v > hi) hi = v;
    }
    vMax = vMax ?? Math.ceil((hi + 5) / 10) * 10;
    vMin = vMin ?? Math.max(vMax - 120, Math.floor((lo - 5) / 10) * 10);
  }
  const xOf = f => mL + pw * Math.log(f / f1) / Math.log(f2 / f1);
  const yOf = v => mT + ph * (1 - (v - vMin) / (vMax - vMin));

  // Grid (thin lines, recessed color)
  ctx.font = FONT;
  ctx.lineWidth = 1;
  ctx.strokeStyle = CH.grid;
  ctx.fillStyle = CH.muted;
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (const f of [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]) {
    if (f < f1 || f > f2) continue;
    const x = xOf(f);
    ctx.beginPath(); ctx.moveTo(x, mT); ctx.lineTo(x, mT + ph); ctx.stroke();
    ctx.fillText(f >= 1000 ? (f / 1000) + 'k' : '' + f, x, mT + ph + 6);
  }
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  const step = (vMax - vMin) <= 60 ? 10 : 20;
  for (let v = vMin; v <= vMax; v += step) {
    const y = yOf(v);
    ctx.strokeStyle = CH.grid;
    ctx.beginPath(); ctx.moveTo(mL, y); ctx.lineTo(mL + pw, y); ctx.stroke();
    ctx.fillText(v.toFixed(0), mL - 6, y);
  }
  // Axis lines
  ctx.strokeStyle = CH.axis;
  ctx.beginPath(); ctx.moveTo(mL, mT); ctx.lineTo(mL, mT + ph); ctx.lineTo(mL + pw, mT + ph); ctx.stroke();
  // Axis labels (Y-axis unit above the scale, X-axis unit to the right of the axis)
  ctx.fillStyle = CH.muted;
  ctx.textAlign = 'right'; ctx.textBaseline = 'top';
  ctx.fillText(opts.yLabel ?? 'dB', mL - 6, 2);
  ctx.textAlign = 'left';
  ctx.fillText('Hz', mL + pw + 6, mT + ph + 6);

  // Series (2px lines) + direct labels at the right end
  ctx.save();
  ctx.beginPath(); ctx.rect(mL, mT, pw, ph); ctx.clip();
  for (const s of series) {
    ctx.strokeStyle = s.color; ctx.lineWidth = 2;
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < s.f.length; i++) {
      if (s.f[i] < f1 || s.f[i] > f2 || !isFinite(s.v[i])) continue;
      const x = xOf(s.f[i]), y = Math.max(mT - 200, Math.min(mT + ph + 200, yOf(s.v[i])));
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.restore();
  // Direct labels (right margin, avoiding vertical collisions)
  const used = [];
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  for (const s of series) {
    let lastV = null;
    for (let i = s.f.length - 1; i >= 0; i--) {
      if (s.f[i] <= f2 && isFinite(s.v[i])) { lastV = s.v[i]; break; }
    }
    if (lastV === null) continue;
    let y = Math.max(mT + 6, Math.min(mT + ph - 6, yOf(lastV)));
    for (const u of used) if (Math.abs(y - u) < 13) y = u + 13;
    used.push(y);
    ctx.fillStyle = s.color;
    ctx.fillText(s.label, mL + pw + 6, y);
  }
  return { xOf, yOf, f1, f2, vMin, vMax, mL, mT, pw, ph };
}

export const CHART_COLORS = CH;
