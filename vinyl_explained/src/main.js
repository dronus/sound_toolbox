// ============================================================================
// main.js — App wiring: UI ⇔ Physics ⇔ 3D rendering ⇔ Measurement
// ============================================================================
import { defaultParams, CONST, ZOOM_MIN, ZOOM_MAX, SLOWDOWN_MIN, SLOWDOWN_MAX, grooveSpeed, sigmaToBits, snrToBits } from './params.js?v=20260706-sigma13-cache';
import { GrooveModel } from './groove.js?v=20260706-sigma13-cache';
import { StylusSim } from './physics.js?v=20260706-sigma13-cache';
import { Renderer3D } from './render3d.js?v=20260706-sigma13-cache';
import {
  Measurement, computeSpectra, computeSnr, computeThd, calibrateSigma,
  logSmooth, plotLines, CHART_COLORS as CH,
} from './analysis.js?v=20260706-sigma13-cache';
import {
  applyStaticI18n, normalizeLang, resolveLanguage, saveLanguagePreference, textFor,
} from './i18n.js?v=20260706-sigma13-cache';

const $ = id => document.getElementById(id);
const params = defaultParams();
params.lang = resolveLanguage();
const SEED = 20260705;

// Override parameters via URL hash (for sharing/testing): #zoom=30000&showRulerL=1&measure=1
const hashOpts = {};
for (const kv of location.hash.replace(/^#/, '').split('&')) {
  const [k, v] = kv.split('=');
  if (!k || v === undefined) continue;
  hashOpts[k] = v;
  if (k in params) {
    if (typeof params[k] === 'boolean') params[k] = v === '1' || v === 'true';
    else if (typeof params[k] === 'number') params[k] = parseFloat(v);
    else params[k] = v;
  }
}
if (!Number.isFinite(params.zoom)) params.zoom = 30;
params.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, params.zoom));
if (!Number.isFinite(params.slowdown)) params.slowdown = 3000;
params.slowdown = Math.max(SLOWDOWN_MIN, Math.min(SLOWDOWN_MAX, params.slowdown));
if (!Number.isFinite(params.stylusTransparency)) params.stylusTransparency = 0;
params.stylusTransparency = Math.max(0, Math.min(100, params.stylusTransparency));
params.lang = normalizeLang(params.lang);
applyStaticI18n(params.lang);

const ui = () => textFor(params.lang);
const locale = () => params.lang === 'ja' ? 'ja-JP' : 'en-US';

let groove, sim, renderer;
let lastSnr = null; // Last measured SNR
const counters = { skipSeen: 0, misSeen: 0, staticSeen: 0, dustSeen: 0 };
// Event rates (denominator is record time, display smoothing is wall-clock time τ=60s)
const rates = { mis: 0, skip: 0, stat: 0, dust: 0 };
const pending = { mis: 0, skip: 0, stat: 0, dust: 0 };
let statsLastRecordT = 0;
let stepAccum = 0, lastT = performance.now(), speedLimited = false;

// Interpolate between physics steps for display only. Does not affect physical calculations or measurement results.
const VIEW_KEYS = ['s', 't', 'x', 'y', 'vx', 'vy', 'restY', 'grooveVel', 'zcL', 'zcR'];
const DIAG_KEYS = ['FL', 'FR', 'dL', 'dR', 'pressL', 'pressR', 'fric'];
const displayPrev = { diag: {} };
const displayCurr = { diag: {} };
const displaySim = { diag: {} };

function snapshotSimView(dst, src) {
  for (const k of VIEW_KEYS) dst[k] = src[k];
  const sd = src.diag || {};
  for (const k of DIAG_KEYS) dst.diag[k] = sd[k] || 0;
  return dst;
}

const lerp = (a, b, f) => a + (b - a) * f;

function interpolatedSimView(alpha) {
  const f = Math.max(0, Math.min(1, alpha));
  for (const k of VIEW_KEYS) displaySim[k] = lerp(displayPrev[k], displayCurr[k], f);
  for (const k of DIAG_KEYS) displaySim.diag[k] = lerp(displayPrev.diag[k], displayCurr.diag[k], f);
  return displaySim;
}

function resetDisplayInterpolation() {
  if (!sim) return;
  stepAccum = 0;
  snapshotSimView(displayPrev, sim);
  snapshotSimView(displayCurr, sim);
  snapshotSimView(displaySim, sim);
}

function rebuild(kind = 'all') {
  const grooveChanged = kind === 'all' || !groove;
  if (grooveChanged) {
    groove = new GrooveModel(params, SEED);
  } else {
    // Since the stylus returns to s=0 while maintaining the groove, dust relative to the old stylus position is discarded
    groove.dust.length = 0;
    groove.activeDust.length = 0;
  }
  sim = new StylusSim(params, groove, SEED ^ 0xabc);
  if (renderer) renderer.rebuildStylus();
  counters.skipSeen = 0; counters.misSeen = 0; counters.staticSeen = 0; counters.dustSeen = 0;
  statsLastRecordT = 0;
  resetDisplayInterpolation();
  for (const k of ['mis', 'skip', 'stat', 'dust']) { rates[k] = 0; pending[k] = 0; }
}

// ---------------------------------------------------------------------------
// UI bindings
// ---------------------------------------------------------------------------
const fmtHz = v => v >= 1000 ? (v / 1000).toFixed(v % 1000 ? 1 : 0) + ' kHz' : v + ' Hz';
const fmtLen = um => {
  if (um >= 1000) return (um / 1000).toFixed(2) + ' mm';
  if (um >= 1) return um.toFixed(um < 10 ? 2 : 1) + ' µm';
  return (um * 1000).toFixed(0) + ' nm';
};
const fmtX = v => {
  if (v < 1) return '×' + v.toFixed(v < 0.1 ? 2 : 1);
  return '×' + Math.round(v).toLocaleString(locale());
};
const fmtInvX = v => `×1/${Math.round(v).toLocaleString(locale())}`;
const RATE_ZERO_LOG = -4;
const rateToSlider = v => v > 0 ? Math.log10(v) : RATE_ZERO_LOG;
const sliderToRate = v => v <= RATE_ZERO_LOG ? 0 : 10 ** v;
const fmtRate = v => {
  if (!(v > 0)) return '0 /s';
  if (v < 0.01) return v.toFixed(4) + ' /s';
  if (v < 0.1) return v.toFixed(3) + ' /s';
  if (v < 10) return v.toFixed(2) + ' /s';
  if (v < 100) return v.toFixed(1) + ' /s';
  return Math.round(v).toLocaleString(locale()) + ' /s';
};

let rebuildTimer = null;
function queueRebuild(kind) {
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => rebuild(kind), 250);
}

// range: {id, get, set, fmt, rebuild:'all'|'sim'|null}
const ranges = [
  { id: 'zoom', get: () => Math.log10(params.zoom), set: v => { params.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, 10 ** v)); }, fmt: () => `${fmtX(params.zoom)}` },
  { id: 'slowdown', get: () => Math.log10(params.slowdown), set: v => { params.slowdown = Math.max(SLOWDOWN_MIN, Math.min(SLOWDOWN_MAX, 10 ** v)); }, fmt: () => fmtInvX(params.slowdown) },
  { id: 'stylusTransparency', get: () => params.stylusTransparency, set: v => { params.stylusTransparency = Math.max(0, Math.min(100, v)); }, fmt: () => Math.round(params.stylusTransparency) + '%' },
  { id: 'rulerBits', get: () => params.rulerBits, set: v => { params.rulerBits = Math.round(v); }, fmt: () => params.rulerBits + ' bit' },
  { id: 'levelDb', get: () => params.levelDb, set: v => { params.levelDb = v; }, fmt: () => (params.levelDb > 0 ? '+' : '') + params.levelDb + ' dB', rebuild: 'all' },
  { id: 'hfCutoff', get: () => params.hfCutoff, set: v => { params.hfCutoff = v; }, fmt: () => params.hfCutoff >= 22000 ? ui().format.none : fmtHz(params.hfCutoff), rebuild: 'all' },
  { id: 'monoBelow', get: () => params.monoBelow, set: v => { params.monoBelow = v; }, fmt: () => `${fmtHz(params.monoBelow)} ${ui().format.below}`, rebuild: 'all' },
  { id: 'radiusMm', get: () => params.radiusMm, set: v => { params.radiusMm = v; }, fmt: () => `${params.radiusMm}mm ${grooveSpeed(params).toFixed(2)}m/s`, rebuild: 'all' },
  { id: 'roughSigma', get: () => Math.log10(params.roughSigma * 1e9), set: v => { params.roughSigma = 10 ** v * 1e-9; }, fmt: () => (params.roughSigma * 1e9).toFixed(2) + ' nm', rebuild: 'all' },
  { id: 'dustRate', get: () => rateToSlider(params.dustRate), set: v => { params.dustRate = sliderToRate(v); }, fmt: () => fmtRate(params.dustRate) },
  { id: 'staticRate', get: () => rateToSlider(params.staticRate), set: v => { params.staticRate = sliderToRate(v); }, fmt: () => fmtRate(params.staticRate) },
  { id: 'scratchRate', get: () => rateToSlider(params.scratchRate), set: v => { params.scratchRate = sliderToRate(v); }, fmt: () => fmtRate(params.scratchRate) },
  { id: 'rSide', get: () => params.rSide * 1e6, set: v => { params.rSide = v * 1e-6; if (params.stylusShape === 'spherical') params.rScan = params.rSide; }, fmt: () => (params.rSide * 1e6).toFixed(1) + ' µm', rebuild: 'sim' },
  { id: 'rScan', get: () => params.rScan * 1e6, set: v => { params.rScan = v * 1e-6; }, fmt: () => (params.rScan * 1e6).toFixed(1) + ' µm', rebuild: 'sim' },
  { id: 'vtfGram', get: () => params.vtfGram, set: v => { params.vtfGram = v; }, fmt: () => params.vtfGram.toFixed(1) + ' g', rebuild: 'sim' },
  { id: 'tipMass', get: () => params.tipMass * 1e6, set: v => { params.tipMass = v * 1e-6; }, fmt: () => (params.tipMass * 1e6).toFixed(2) + ' mg', rebuild: 'sim' },
  { id: 'compliance', get: () => params.compliance * 1e3, set: v => { params.compliance = v * 1e-3; }, fmt: () => (params.compliance * 1e3).toFixed(0) + ' cu', rebuild: 'sim' },
];
for (const r of ranges) {
  const el = $(r.id), out = $(r.id + 'O');
  el.value = r.get();
  if (out) out.textContent = r.fmt();
  el.addEventListener('input', () => {
    r.set(parseFloat(el.value));
    if (out) out.textContent = r.fmt();
    if (r.id === 'roughSigma') updateBitNote();
    if (r.id === 'stylusTransparency' && renderer) renderer.updateStylusMaterial();
    if (r.rebuild) queueRebuild(r.rebuild);
  });
}
function syncRange(id) {
  const r = ranges.find(x => x.id === id);
  const el = $(id), out = $(id + 'O');
  el.value = r.get();
  if (out) out.textContent = r.fmt();
}

function syncRulerAutoControl() {
  const rulerVisible = !!(params.showRulerL || params.showRulerR);
  $('rulerAuto').disabled = !rulerVisible;
  $('rulerBits').disabled = !rulerVisible || !!params.rulerAuto;
}

$('language').value = params.lang;
$('language').addEventListener('change', () => setAppLanguage($('language').value, true));

// Checkboxes / Selects
for (const id of ['showRulerL', 'showRulerR', 'showMolecules', 'showContactMarkers', 'showLabels', 'rulerAuto', 'showGhost', 'showTimeScale']) {
  $(id).checked = !!params[id];
  $(id).addEventListener('change', () => {
    params[id] = $(id).checked;
    if (id === 'showRulerL' || id === 'showRulerR' || id === 'rulerAuto') syncRulerAutoControl();
  });
}
$('timeScaleMode').value = params.timeScaleMode;
$('timeScaleMode').addEventListener('change', () => {
  params.timeScaleMode = $('timeScaleMode').value;
});
$('signalType').value = params.signalType;
$('signalType').addEventListener('change', () => {
  params.signalType = $('signalType').value;
  $('sineRow').style.display = params.signalType === 'sine' ? '' : 'none';
  // For sine waves, the displacement at music peak level (+12dB) is 31.7µm, which would be
  // clipped by the overcut limiter (25µm). Therefore, set to 0dB (5cm/s, 8µm displacement) when sine is selected.
  // Revert to default when returning to pink noise.
  if (params.signalType === 'sine') params.levelDb = 0;
  else if (params.signalType === 'pink') params.levelDb = defaultParams().levelDb;
  syncRange('levelDb');
  queueRebuild('all');
});
$('sineFreq').addEventListener('change', () => {
  params.sineFreq = parseFloat($('sineFreq').value);
  queueRebuild('all');
});
$('rpm').addEventListener('change', () => {
  params.rpm = parseFloat($('rpm').value);
  syncRange('radiusMm');
  queueRebuild('all');
});
$('stylusShape').value = params.stylusShape;
$('stylusShape').addEventListener('change', () => {
  params.stylusShape = $('stylusShape').value;
  if (params.stylusShape === 'spherical') {
    params.rSide = 15e-6; params.rScan = 15e-6;
    $('rScanRow').style.display = 'none';
  } else {
    params.rSide = 18e-6; params.rScan = 8e-6;
    $('rScanRow').style.display = '';
  }
  syncRange('rSide'); syncRange('rScan');
  queueRebuild('sim');
});

function updateBitNote() {
  const tx = ui();
  const bitDb = b => `${b.toFixed(1)}${tx.format.bit} (${tx.format.sn} ${(6.02 * b + 1.76).toFixed(0)}dB)`;
  const bitsSigma = sigmaToBits(params.roughSigma, params.fullScaleDisp);
  const bitsMol = Math.log2(2 * params.fullScaleDisp / (CONST.MOLECULE_R * 2 * Math.sqrt(12)));
  $('bitNote').innerHTML =
    `${tx.format.roughness}=${(params.roughSigma * 1e9).toFixed(2)}nm → <b>${bitDb(bitsSigma)}</b> ${tx.format.equivalent} / ` +
    `${tx.format.moleculeDiameter} → ${bitDb(bitsMol)} ${tx.format.equivalent} / ` +
    `${tx.format.measuredSn}: ${lastSnr !== null ? lastSnr.toFixed(1) + 'dB = ' + snrToBits(lastSnr).toFixed(1) + tx.format.bit : tx.format.notMeasured}`;
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------
let measuring = false;
const progressEl = $('progress').firstElementChild;
const chartStates = new Map(); // canvas → {redraw}
let tileRows = [];
let measureNoteState = { key: 'initial', args: [] };

function localizeChartState(st) {
  const c = ui().charts;
  for (const s of st.series) {
    if (s.labelId && c[s.labelId]) s.label = c[s.labelId];
  }
  st.opts.yLabel = c.yLabel;
}

function attachHover(canvas) {
  canvas.addEventListener('mousemove', e => {
    const st = chartStates.get(canvas);
    if (!st) return;
    st.redraw();
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const { map } = st;
    if (x < map.mL || x > map.mL + map.pw) return;
    const f = map.f1 * Math.pow(map.f2 / map.f1, (x - map.mL) / map.pw);
    const ctx = canvas.getContext('2d');
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(x, map.mT); ctx.lineTo(x, map.mT + map.ph); ctx.stroke();
    ctx.setLineDash([]);
    let text = f >= 1000 ? (f / 1000).toFixed(2) + 'kHz' : f.toFixed(0) + 'Hz';
    for (const s of st.series) {
      let best = null, bd = Infinity;
      for (let i = 0; i < s.f.length; i++) {
        const d = Math.abs(Math.log(s.f[i] / f));
        if (d < bd) { bd = d; best = s.v[i]; }
      }
      if (best !== null && isFinite(best)) text += `  ${s.label}: ${best.toFixed(1)}dB`;
    }
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText(text, map.mL + 4, 2);
  });
  canvas.addEventListener('mouseleave', () => {
    const st = chartStates.get(canvas);
    if (st) st.redraw();
  });
}
attachHover($('chartFreq'));
attachHover($('chartNoise'));

function drawChart(canvas, series, opts, kind) {
  const st = { series, opts, kind, map: null, redraw: null };
  st.redraw = () => {
    localizeChartState(st);
    const map = plotLines(canvas, st.series, st.opts);
    st.map = map;
    return map;
  };
  chartStates.set(canvas, st);
  st.redraw();
}

function smoothPsdDb(freqs, psd) {
  const sm = logSmooth(Array.from(freqs), Array.from(psd));
  return {
    f: sm.f,
    v: sm.v.map(v => 10 * Math.log10(Math.max(v, 1e-30) / (CONST.V_REF ** 2))),
  };
}

function placeholderChart(canvas, text) {
  chartStates.delete(canvas);
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  canvas.width = canvas.clientWidth * dpr; canvas.height = canvas.clientHeight * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.font = '12px system-ui, sans-serif';
  ctx.fillStyle = '#898781';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, canvas.clientWidth / 2, canvas.clientHeight / 2);
}

function refreshCharts() {
  for (const st of chartStates.values()) st.redraw();
  if (!chartStates.has($('chartFreq'))) placeholderChart($('chartFreq'), ui().charts.freqPlaceholder);
  if (!chartStates.has($('chartNoise'))) placeholderChart($('chartNoise'), ui().charts.noisePlaceholder);
}

function tileLabel(row) {
  const value = ui().measurement.tiles[row.label];
  return typeof value === 'function' ? value(...(row.args || [])) : value;
}

function renderTiles() {
  $('tiles').innerHTML = tileRows.map(row =>
    [row.value, tileLabel(row)]).map(([v, u]) =>
    `<div class="tile"><div class="v">${v}</div><div class="u">${u}</div></div>`).join('');
}

function setTiles(items) {
  tileRows = items;
  renderTiles();
}

function renderMeasureNote() {
  const { key, args } = measureNoteState;
  const m = ui().measurement;
  let text;
  if (key === 'done') text = m.done(args[0]);
  else if (key === 'error') text = m.errorPrefix + args[0];
  else if (key === 'calibrated') text = m.calibrated(args[0]);
  else if (key === 'calibrationError') text = m.calibrationErrorPrefix + args[0];
  else text = m[key] || '';
  $('measNote').textContent = text;
}

function setMeasureNote(key, ...args) {
  measureNoteState = { key, args };
  renderMeasureNote();
}

function setAppLanguage(lang, persist = false) {
  params.lang = normalizeLang(lang);
  if (persist) saveLanguagePreference(params.lang);
  applyStaticI18n(params.lang);
  $('language').value = params.lang;
  for (const r of ranges) syncRange(r.id);
  syncRulerAutoControl();
  updateBitNote();
  renderTiles();
  renderMeasureNote();
  refreshCharts();
  statsLine = '';
  if (renderer?.setLanguage) renderer.setLanguage(params.lang);
}

async function runMeasurement() {
  if (measuring) return;
  measuring = true;
  $('measureBtn').disabled = true; $('calibBtn').disabled = true;
  const dur = parseFloat($('measDur').value);
  try {
    // 1) Frequency response with current signal
    setMeasureNote('response');
    const m1 = new Measurement(params, {}, dur, SEED + 1);
    const res1 = await m1.run(f => { progressEl.style.width = (f * 50) + '%'; });
    const sp = computeSpectra(res1);
    const smIn = smoothPsdDb(sp.freqs, sp.psdIn);
    const smOut = smoothPsdDb(sp.freqs, sp.psdOut);
    drawChart($('chartFreq'), [
      { f: smIn.f, v: smIn.v, color: CH.s1, labelId: 'input' },
      { f: smOut.f, v: smOut.v, color: CH.s2, labelId: 'output' },
    ], { yLabel: ui().charts.yLabel }, 'freq');

    // 2) Noise/SNR in silent groove
    setMeasureNote('noise');
    const m2 = new Measurement(params, { signalType: 'silence' }, dur, SEED + 2);
    const res2 = await m2.run(f => { progressEl.style.width = (50 + f * 50) + '%'; });
    const nz = computeSnr(res2);
    lastSnr = nz.snr;
    const smNz = smoothPsdDb(nz.freqs, nz.psd);
    drawChart($('chartNoise'), [
      { f: smNz.f, v: smNz.v, color: CH.s3, labelId: 'noise' },
    ], { yLabel: ui().charts.yLabel }, 'noise');

    const tiles = [
      { value: nz.snr.toFixed(1) + ' dB', label: 'snr' },
      { value: snrToBits(nz.snr).toFixed(1) + ' bit', label: 'bits' },
      { value: res1.mistrackPerSec.toFixed(1) + ' /s', label: 'mistrack' },
      { value: res1.skipPerSec.toFixed(2) + ' /s', label: 'skip' },
    ];
    if (params.signalType === 'sine') {
      const thd = computeThd(res1, params.sineFreq);
      tiles.push({ value: thd.thdPct.toFixed(2) + ' %', label: 'thd', args: [params.sineFreq] });
    }
    setTiles(tiles);
    updateBitNote();
    setMeasureNote('done', dur);
  } catch (err) {
    setMeasureNote('error', err.message);
    console.error(err);
  } finally {
    progressEl.style.width = '0%';
    $('measureBtn').disabled = false; $('calibBtn').disabled = false;
    measuring = false;
  }
}
$('measureBtn').addEventListener('click', runMeasurement);

$('calibBtn').addEventListener('click', async () => {
  if (measuring) return;
  measuring = true;
  $('measureBtn').disabled = true; $('calibBtn').disabled = true;
  try {
    setMeasureNote('calibrating');
    const sigma = await calibrateSigma(params, 60, f => { progressEl.style.width = (f * 100) + '%'; });
    params.roughSigma = sigma;
    syncRange('roughSigma');
    updateBitNote();
    rebuild('all');
    setMeasureNote('calibrated', (sigma * 1e9).toFixed(2));
  } catch (err) {
    setMeasureNote('calibrationError', err.message);
  } finally {
    progressEl.style.width = '0%';
    $('measureBtn').disabled = false; $('calibBtn').disabled = false;
    measuring = false;
  }
});

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
rebuild('all');
renderer = new Renderer3D($('view'), params);
renderer.onZoomChange = () => syncRange('zoom');
if (hashOpts.az) renderer.az = parseFloat(hashOpts.az);
if (hashOpts.el) renderer.el = parseFloat(hashOpts.el);

const hud = $('hud');
const flash = $('flash');
const eventlog = $('eventlog');
// Update Tracking S/E and jitter display every 1 second (calculations are performed continuously via exponential decay in physics)
let statsLine = '', statsLastT = 0;
function fmtJitter(s) {
  if (!isFinite(s) || s <= 0) return '—';
  if (s < 0.9995e-6) return (s * 1e9).toFixed(s < 1e-7 ? 1 : 0) + ' ns';
  if (s < 0.9995e-3) return (s * 1e6).toFixed(1) + ' µs';
  return (s * 1e3).toFixed(2) + ' ms';
}
function fmtSignedJitter(s) {
  if (!isFinite(s)) return '—';
  if (Math.abs(s) < 0.5e-12) return '0 ns';
  return (s < 0 ? '−' : '+') + fmtJitter(Math.abs(s));
}
let flashTimer = null;

function doFlash(cls) {
  flash.className = cls;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { flash.className = ''; }, 120);
}

function fmtDb(v) {
  const db = 20 * Math.log10(Math.max(v, 1e-9) / CONST.V_REF);
  return db <= -80 ? '−∞' : db.toFixed(1);
}

function frame(now) {
  requestAnimationFrame(frame);
  const dtWall = Math.min((now - lastT) / 1000, 0.05);
  lastT = now;

  if (!$('pause').checked && !measuring) {
    stepAccum += (dtWall / params.slowdown) / CONST.PHYS_DT;
    let steps = Math.floor(stepAccum);
    const CAP = 12000;
    speedLimited = steps > CAP;
    if (speedLimited) { steps = CAP; stepAccum = 0; } else stepAccum -= steps;
    // 埃/静電気/傷の発生率はレコード時間基準。スロー表示中は画面上の頻度も同じ倍率で遅くなる。
    sim.eventRateScale = 1;
    if (steps > 0) {
      const skipBefore = sim.skipCount;
      if (steps > 1) sim.step(steps - 1);
      snapshotSimView(displayPrev, sim);
      sim.step(1);
      snapshotSimView(displayCurr, sim);
      if (sim.skipCount > skipBefore) snapshotSimView(displayPrev, sim);
    }
  }
  const renderSim = interpolatedSimView(stepAccum);

  // Event detection (accumulate differences for rate estimation)
  if (sim.staticFlash) { sim.staticFlash = 0; doFlash('static'); }
  pending.stat += Math.max(0, sim.staticCount - counters.staticSeen);
  counters.staticSeen = sim.staticCount;
  if (sim.skipCount > counters.skipSeen) doFlash('skip');
  pending.skip += Math.max(0, sim.skipCount - counters.skipSeen);
  counters.skipSeen = sim.skipCount;
  pending.mis += Math.max(0, sim.mistrackCount - counters.misSeen);
  counters.misSeen = sim.mistrackCount;
  pending.dust += Math.max(0, groove.dustHits - counters.dustSeen);
  counters.dustSeen = groove.dustHits;

  // Stop 3D rendering during measurement to focus computation on measurement
  if (measuring) return;
  renderer.update({ sim: renderSim, groove, params });

  // HUD
  const tx = ui();
  const d = renderSim.diag;
  const vTip = Math.hypot(renderSim.vx, renderSim.vy);
  // Tracking error: real stylus position − ideal tracking position (decomposed into channel directions)
  let errText = '';
  if (params.showGhost && renderer.idealPos) {
    const dx = renderSim.x - renderer.idealPos.x, dy = renderSim.y - renderer.idealPos.y;
    const eL = (dx * Math.SQRT1_2 + dy * Math.SQRT1_2) * 1e9;
    const eR = (dx * Math.SQRT1_2 - dy * Math.SQRT1_2) * 1e9;
    const eT = renderer.errorVectorState ? fmtSignedJitter(renderer.errorVectorState.tSec) : '—';
    errText = `\n${tx.hud.trackingErrorLR}: <b>${eL.toFixed(1)} / ${eR.toFixed(1)}</b> nm\n${tx.hud.trackingErrorTime}: <b>${eT}</b>`;
  }
  // Tracking S/E, jitter + event rates (exponential decay, display updates ~every 1s)
  if (now - statsLastT > 1000) {
    const dtWallStats = Math.min((now - statsLastT) / 1000, 10);
    statsLastT = now;
    const st = sim.stats;
    const vS = st.sL.v + st.sR.v, vN = st.nL.v + st.nR.v;
    const snTxt = vS > 1e-20 && vN > 0
      ? (10 * Math.log10(vS / vN)).toFixed(1) + ' dB' : '—';
    statsLine = `${tx.hud.trackingSE}: <b>${snTxt}</b>   ${tx.hud.jitter}: <b>${fmtJitter(Math.sqrt(Math.max(st.j.v, 0)))}</b>`;
    // Calculate physical rate as events per record elapsed time, and smooth HUD responsiveness using wall-clock time.
    let dtRecord = sim.t - statsLastRecordT;
    if (!Number.isFinite(dtRecord) || dtRecord < 0) dtRecord = 0;
    statsLastRecordT = sim.t;
    if (dtRecord > 0) {
      const decay = Math.exp(-dtWallStats / 60);
      for (const k of ['mis', 'skip', 'stat', 'dust']) {
        rates[k] = rates[k] * decay + (pending[k] / dtRecord) * (1 - decay);
        pending[k] = 0;
      }
    }
    const fr = v => v < 0.005 ? '0' : v.toFixed(v < 0.1 ? 2 : 1);
    eventlog.innerHTML =
      `${tx.hud.mistrack}: ${fr(rates.mis)} /s` +
      `<br><span class="${rates.skip > 0.005 ? 'crit' : ''}">${tx.hud.skip}: ${fr(rates.skip)} /s</span>` +
      `<br><span class="${rates.stat > 0.005 ? 'warn' : ''}">${tx.hud.static}: ${fr(rates.stat)} /s</span>` +
      `<br>${tx.hud.dustHit}: ${fr(rates.dust)} /s`;
  }
  hud.innerHTML =
    `${tx.hud.contactForce}: <b>${(d.FL * 1e3).toFixed(1)} / ${(d.FR * 1e3).toFixed(1)}</b> mN\n` +
    `${tx.hud.indentation}: ${(Math.max(0, d.dL) * 1e9).toFixed(0)} / ${(Math.max(0, d.dR) * 1e9).toFixed(0)} nm\n` +
    `${tx.hud.contactPressure}: ${(d.pressL * 1e-9).toFixed(2)} / ${(d.pressR * 1e-9).toFixed(2)} GPa\n` +
    `${tx.hud.tipVelocity}: <b>${(vTip * 100).toFixed(2)}</b> cm/s (${fmtDb(vTip)} dB)\n` +
    `${tx.hud.friction}(µN): ${(d.fric * 1e6).toFixed(0)}   ${tx.hud.grooveSpeed}: ${sim.grooveVel.toFixed(2)} m/s\n` +
    `${tx.hud.slowdown}: ${fmtInvX(params.slowdown)}${speedLimited ? ` <span style="color:#c98500">(${tx.format.computeLimit})</span>` : ''}\n` +
    statsLine +
    errText;

  // UI synchronization for auto-bit ruler
  if (params.rulerAuto && renderer.autoBits && renderer.autoBits !== params.rulerBits) {
    params.rulerBits = renderer.autoBits;
    syncRange('rulerBits');
  }

  // Scale bar
  const vw = renderer.viewWidth || renderer.viewHalf * 2; // Horizontal field of view width [µm]
  const targetUm = vw * 0.25;
  const pow = 10 ** Math.floor(Math.log10(targetUm));
  const nice = [1, 2, 5, 10].map(m => m * pow).reduce((a, b) =>
    Math.abs(b - targetUm) < Math.abs(a - targetUm) ? b : a);
  const px = nice / vw * $('view').clientWidth;
  const sb = $('scalebar');
  sb.firstElementChild.style.width = px + 'px';
  sb.lastElementChild.textContent = `${fmtLen(nice)} (${tx.format.viewWidth(fmtLen(vw))})`;
}

updateBitNote();
renderMeasureNote();
refreshCharts();
$('sineRow').style.display = params.signalType === 'sine' ? '' : 'none';
$('rScanRow').style.display = params.stylusShape === 'spherical' ? 'none' : '';
// Reflect hash options to UI
for (const r of ranges) syncRange(r.id);
for (const id of ['showRulerL', 'showRulerR', 'showMolecules', 'showContactMarkers', 'showLabels', 'rulerAuto', 'showGhost', 'showTimeScale']) $(id).checked = !!params[id];
syncRulerAutoControl();
$('language').value = params.lang;
$('signalType').value = params.signalType;
$('stylusShape').value = params.stylusShape;
if (hashOpts.measDur) $('measDur').value = hashOpts.measDur;
if (hashOpts.measure) setTimeout(runMeasurement, 400);
requestAnimationFrame(frame);
