// Calibration & Physical Verification Script (Node)
// 1) Measure pink noise normalization constant
// 2) 1kHz sine wave reproducibility (level/THD) — verify physical chain validity
// 3) Silence noise → SNR measurement and σ calibration (target 60dB = DR72dB @ peak +12dB)
// 4) Mistrack verification with pink noise
import { defaultParams, sigmaToBits } from '../../vinyl_explained/src/params.js';
import { makeRng, makeGauss } from '../../vinyl_explained/src/dsp.js';
import { Measurement, computeSnr, computeThd, calibrateSigma, goertzelRms } from '../../vinyl_explained/src/analysis.js';

// --- 1) Measure raw RMS of Kellet pink filter ---
{
  const g = makeGauss(makeRng(42));
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, sum = 0;
  const N = 2_000_000;
  for (let i = 0; i < N; i++) {
    const w = g();
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.96900 * b2 + w * 0.1538520;
    b3 = 0.86650 * b3 + w * 0.3104856;
    b4 = 0.55000 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.0168980;
    const out = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
    b6 = w * 0.115926;
    sum += out * out;
  }
  console.log(`[1] pink raw RMS = ${Math.sqrt(sum / N).toFixed(4)} (reflect in dsp.js PINK_RMS)`);
}

const base = defaultParams();

// --- 1b) Peak velocity of pink noise after passing through the chain (for level normalization) ---
{
  const { SignalGenerator } = await import('../../vinyl_explained/src/dsp.js');
  const p = { ...base, signalType: 'pink', levelDb: 0 };
  const gen = new SignalGenerator(p, 777);
  let peak = 0;
  const N = 5 * 192000; // 5 seconds
  for (let i = 0; i < N; i++) {
    const { vL, vR } = gen.next();
    const a = Math.max(Math.abs(vL), Math.abs(vR));
    if (a > peak) peak = a;
  }
  console.log(`[1b] pink peak vel = ${(peak * 100).toFixed(2)} cm/s (at levelDb=0)` +
    ` → reflect "measured value × correction at current normalization" in dsp.js PINK_PEAK_VEL`);
}

// --- 2) 1kHz sine wave verification ---
{
  const m = new Measurement(base, {
    signalType: 'sine', sineFreq: 1000, levelDb: 0,
    dustRate: 0, staticRate: 0, roughSigma: 1e-12,
  }, 0.3);
  const res = await m.run();
  const amp = goertzelRms(res.outDeL, res.fs, 1000);
  const thd = computeThd(res, 1000);
  console.log(`[2] 1kHz sine: output=${(amp * 100).toFixed(3)} cm/s RMS (expected ≈5·√½=3.54: L=M/√2)  ` +
    `THD=${thd.thdPct.toFixed(3)}%  mistrack/s=${res.mistrackPerSec.toFixed(1)} skip/s=${res.skipPerSec}`);
}

// --- 3) σ calibration ---
{
  const m0 = new Measurement(base, { signalType: 'silence', dustRate: 0, staticRate: 0 }, 0.35);
  const r0 = await m0.run();
  const s0 = computeSnr(r0);
  console.log(`[3] default σ=${(base.roughSigma * 1e9).toFixed(2)}nm → SNR=${s0.snr.toFixed(2)}dB (${s0.bits.toFixed(2)}bit)`);
  const sigma = await calibrateSigma(base, 60);
  const mv = new Measurement(base, {
    signalType: 'silence', dustRate: 0, staticRate: 0, roughSigma: sigma,
  }, 0.35);
  const rv = await mv.run();
  const sv = computeSnr(rv);
  console.log(`    after calib σ=${(sigma * 1e9).toFixed(2)}nm → SNR=${sv.snr.toFixed(2)}dB (${sv.bits.toFixed(2)}bit)  ` +
    `ruler equiv=${sigmaToBits(sigma, base.fullScaleDisp).toFixed(2)}bit`);
  console.log(`    → set ${(sigma * 1e9).toFixed(2)}e-9 as default roughSigma in params.js`);
}

// --- 4) Pink noise operation check ---
{
  const m = new Measurement(base, { dustRate: 0, staticRate: 0 }, 0.3);
  const res = await m.run();
  let rin = 0, rout = 0;
  for (let i = 0; i < res.outDeL.length; i++) {
    rin += res.inDeL[i] ** 2; rout += res.outDeL[i] ** 2;
  }
  rin = Math.sqrt(rin / res.inDeL.length); rout = Math.sqrt(rout / res.outDeL.length);
  console.log(`[4] pink: input=${(rin * 100).toFixed(2)}cm/s output=${(rout * 100).toFixed(2)}cm/s ` +
    `mistrack/s=${res.mistrackPerSec.toFixed(1)} skip/s=${res.skipPerSec}`);
}
