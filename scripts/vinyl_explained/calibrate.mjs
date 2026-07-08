// キャリブレーション & 物理検証スクリプト (Node)
// 1) ピンクノイズ正規化定数の実測
// 2) 1kHz正弦波の再現性 (レベル/THD) — 物理チェーンの妥当性検証
// 3) 無音時ノイズ→SNR測定とσキャリブレーション (目標60dB = DR72dB @ ピーク+12dB)
// 4) ピンクノイズでのミストラック確認
import { defaultParams, sigmaToBits } from '../../vinyl_explained/src/params.js';
import { makeRng, makeGauss } from '../../vinyl_explained/src/dsp.js';
import { Measurement, computeSnr, computeThd, calibrateSigma, goertzelRms } from '../../vinyl_explained/src/analysis.js';

// --- 1) Kellet pinkフィルタの生RMS実測 ---
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
  console.log(`[1] pink raw RMS = ${Math.sqrt(sum / N).toFixed(4)} (dsp.js PINK_RMS に反映)`);
}

const base = defaultParams();

// --- 1b) ピンクノイズのチェーン通過後ピーク速度 (レベル正規化用) ---
{
  const { SignalGenerator } = await import('../../vinyl_explained/src/dsp.js');
  const p = { ...base, signalType: 'pink', levelDb: 0 };
  const gen = new SignalGenerator(p, 777);
  let peak = 0;
  const N = 5 * 192000; // 5秒
  for (let i = 0; i < N; i++) {
    const { vL, vR } = gen.next();
    const a = Math.max(Math.abs(vL), Math.abs(vR));
    if (a > peak) peak = a;
  }
  console.log(`[1b] pink peak vel = ${(peak * 100).toFixed(2)} cm/s (levelDb=0時)` +
    ` → dsp.js PINK_PEAK_VEL に「現行正規化での実測値×補正」を反映`);
}

// --- 2) 1kHz正弦波検証 ---
{
  const m = new Measurement(base, {
    signalType: 'sine', sineFreq: 1000, levelDb: 0,
    dustRate: 0, staticRate: 0, roughSigma: 1e-12,
  }, 0.3);
  const res = await m.run();
  const amp = goertzelRms(res.outDeL, res.fs, 1000);
  const thd = computeThd(res, 1000);
  console.log(`[2] 1kHz sine: 出力=${(amp * 100).toFixed(3)} cm/s RMS (期待≈5·√½=3.54: L=M/√2)  ` +
    `THD=${thd.thdPct.toFixed(3)}%  mistrack/s=${res.mistrackPerSec.toFixed(1)} skip/s=${res.skipPerSec}`);
}

// --- 3) σキャリブレーション ---
{
  const m0 = new Measurement(base, { signalType: 'silence', dustRate: 0, staticRate: 0 }, 0.35);
  const r0 = await m0.run();
  const s0 = computeSnr(r0);
  console.log(`[3] 既定σ=${(base.roughSigma * 1e9).toFixed(2)}nm → SNR=${s0.snr.toFixed(2)}dB (${s0.bits.toFixed(2)}bit)`);
  const sigma = await calibrateSigma(base, 60);
  const mv = new Measurement(base, {
    signalType: 'silence', dustRate: 0, staticRate: 0, roughSigma: sigma,
  }, 0.35);
  const rv = await mv.run();
  const sv = computeSnr(rv);
  console.log(`    キャリブ後 σ=${(sigma * 1e9).toFixed(2)}nm → SNR=${sv.snr.toFixed(2)}dB (${sv.bits.toFixed(2)}bit)  ` +
    `目盛り換算=${sigmaToBits(sigma, base.fullScaleDisp).toFixed(2)}bit`);
  console.log(`    → params.js の roughSigma 既定値に ${(sigma * 1e9).toFixed(2)}e-9 を設定`);
}

// --- 4) ピンクノイズ動作確認 ---
{
  const m = new Measurement(base, { dustRate: 0, staticRate: 0 }, 0.3);
  const res = await m.run();
  let rin = 0, rout = 0;
  for (let i = 0; i < res.outDeL.length; i++) {
    rin += res.inDeL[i] ** 2; rout += res.outDeL[i] ** 2;
  }
  rin = Math.sqrt(rin / res.inDeL.length); rout = Math.sqrt(rout / res.outDeL.length);
  console.log(`[4] pink: 入力=${(rin * 100).toFixed(2)}cm/s 出力=${(rout * 100).toFixed(2)}cm/s ` +
    `mistrack/s=${res.mistrackPerSec.toFixed(1)} skip/s=${res.skipPerSec}`);
}
