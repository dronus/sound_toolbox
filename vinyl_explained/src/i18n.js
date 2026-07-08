// ============================================================================
// i18n.js — UI language resources and browser-language resolution
// ============================================================================

export const LANG_STORAGE_KEY = 'vinyl-explained-lang';
export const APP_NAME = 'Frieve Vinyl Explained';

const HELP_EN = `
  <h3>What is this?</h3>
  <p>This app simulates an analog stylus tracing a vinyl groove in slow motion, using microscopic physics rather than a visual approximation: Hertz/Winkler contact, viscoelastic damping, and rigid-body dynamics. All core quantities use SI units, and the observable SNR, distortion, and resonance frequencies are checked against real-world orders of magnitude.</p>
  <h3>Cutting Signal Chain</h3>
  <p>Pink noise (a music-like long-term spectrum) passes through a 20Hz rumble filter, an 80Hz music LF shaper, bass mono filtering, HF cutoff, RIAA recording pre-emphasis including the Neumann 3.18µs pole, and velocity-to-displacement integration. The result drives 45/45 left and right wall normal displacement. The 0dB reference is a 5cm/s peak wall velocity.</p>
  <h3>Contact Physics</h3>
  <p>At 2g VTF, each wall carries roughly 14mN of normal force and the contact pressure reaches about 0.4GPa, well above the yield stress of PVC. Microscopic asperities inside the ~5×7µm contact patch are therefore crushed and averaged. The simulation separates visible roughness from the roughness actually felt by the stylus with an analytic patch-averaging factor.</p>
  <h3>Tracing Distortion</h3>
  <p>At each step, the simulator evaluates the stylus scanning-radius parabola against the wall gap, so inner-groove treble loss and pinch-effect distortion emerge from geometry rather than from an added distortion formula. Use sine mode to inspect it directly.</p>
  <h3>Bit Ruler</h3>
  <p>The ruler divides a ±15µm wall displacement full scale along each 45° modulation axis. The default roughness σ=13.17nm is calibrated to SNR 60.0dB, or 9.7 effective bits; at the default +12dB peak level this corresponds to DR 72dB. White markers show the instantaneous wall displacement.</p>
  <h3>Noise Sources</h3>
  <p>The main noise source is three-scale AR(1) groove roughness representing stamper precision and molecular-scale placement error. Dust follows a physical deposition model with flakes, fibers, and grit; only particles actually pressed by the stylus deform. Static is injected as an electrical pulse, as in a real playback chain, not as a mechanical vibration.</p>
  <h3>Main Simplifications</h3>
  <ul>
    <li>Two degrees of freedom in the groove cross-section; groove-direction vibration and stick-slip are omitted.</li>
    <li>Roughness is one-dimensional along the groove, with lateral patch averaging handled analytically.</li>
    <li>Groove walls are rendered as non-overhanging height fields.</li>
    <li>Wow, flutter, eccentricity, warp, and cartridge electrical loading are outside the model.</li>
  </ul>
  <h3>Validated Orders of Magnitude</h3>
  <ul>
    <li>1kHz, 5cm/s sine: output error &lt;0.03dB, THD≈0.6%.</li>
    <li>Contact resonance ~40kHz, cantilever static deflection ~0.3mm, arm resonance ~12Hz.</li>
    <li>SNR 60.0dB at σ=13.17nm, yielding DR 72dB at the default +12dB peak level.</li>
  </ul>
`;

const HELP_JA = `
  <h3>これは何?</h3>
  <p>アナログレコードの針が溝をトレースする様子を、ミクロスケールの物理法則
  (Hertz/Winkler接触・粘弾性・剛体動力学) に基づき実時間より遥かに遅いスローモーションで
  シミュレーションします。すべてSI単位・実測物性値で構成され、観測される
  SN比・歪率・共振周波数が実物と整合するよう検証済みです。</p>
  <h3>信号チェーン (カッティング)</h3>
  <p>ピンクノイズ (音楽の平均スペクトル近似) → 20Hzランブルフィルタ +
  80Hz音楽相当LF整形 (マスタリング済み音楽の低域減衰を再現) →
  低域モノ化 (エリプティックEQ相当。
  低域の縦振幅過大による針飛びを防ぐ実際のマスタリング手法) → HFカット →
  RIAA録音プリエンファシス (T=3180/318/75µs + Neumann 3.18µs極) →
  速度→変位積分 → 45/45方式で左右壁の法線変位に。基準レベル 0dB =
  45/45壁方向ピーク5cm/s (モノ横RMS 5cm/s相当)。</p>
  <h3>接触の物理</h3>
  <p>針圧2gで壁面法線力は各~14mN、接触圧~0.4GPaに達しPVCの降伏応力(~80MPa)を超えます。
  このため接触パッチ (~5×7µm) 内のミクロ凹凸は潰れて平均化されます —
  分子スケールのランダムさがあっても理想的なプレス盤が70dB級のSNに達し得る理由です。
  本シミュレーションはWinkler弾性基礎 (球面プロファイルで3D Hertzと厳密一致) +
  Kelvin-Voigt粘弾性で接触を解き、パッチ横方向の平均化は解析係数
  κ=√(ℓ/(ℓ+a)) で「見える粗さ」と「針が感じる粗さ」を分離しています。</p>
  <h3>トレーシング歪み</h3>
  <p>針先の走査半径による放物線サグと壁面のギャップ最小化を毎ステップ解くため、
  内周・高域でのトレーシングロスやピンチエフェクト (縦方向2次歪み) が
  パラメトリックではなく幾何学から自然に発生します。正弦波モードで観察できます。</p>
  <h3>ビット目盛り</h3>
  <p>各壁の変調方向 (V字の45°法線) に沿って、フルスケール±15µmを 2ⁿ 分割した
  量子化目盛りを表示します。既定の粗さσ=13.17nmは測定SN 60.0dB (9.7bit相当) に
  キャリブレーション済み — 既定ピークレベル+12dBと合わせDR=72dBで、実測レコードの
  上限域に収まります。目盛りを9〜10bitにすると1LSBがノイズ振幅と
  同程度になるのが視認できます。白線=現在の壁変位の瞬時値。</p>
  <h3>ノイズ源</h3>
  <p>粗さ (スタンパー精度/分子配置誤差, 3スケールAR(1)過程) が主ノイズ。
  埃は実世界の粒径分布 (対数正規) と種別 (皮膚片/繊維/鉱物粒) で
  ランド・溝壁・溝底へ一様に堆積し、大半は針経路の外で無害です。
  針が実際に押した粒子だけが弾塑性的に潰れ (柔らかい粒は15%残留)、
  硬い鉱物粒はほぼ潰れず針を打ち上げて弾き飛ばされます。
  静電気は実物同様<em>電気的</em>パルスとして出力信号に加算されます
  (機械振動ではない)。</p>
  <h3>主な簡略化</h3>
  <ul>
    <li>断面内2自由度 (溝方向の針振動・スティックスリップは省略, 摩擦は診断値)</li>
    <li>粗さは溝方向1D (横方向平均化は解析係数で考慮)</li>
    <li>壁面はオーバーハングしない高さ場として描画</li>
    <li>ワウ・フラッター、偏心、反り、カートリッジ電磁系は対象外</li>
  </ul>
  <h3>検証値 (実測と整合)</h3>
  <ul>
    <li>1kHz 5cm/s正弦波 → 出力誤差 &lt;0.03dB, THD≈0.6%</li>
    <li>接触共振 ~40kHz / カンチレバー静的たわみ ~0.3mm / アーム共振 ~12Hz</li>
    <li>SN 60.0dB @ σ=13.17nm → DR 72dB @ ピーク+12dB (AFM実測のプレス盤粗さと同オーダー)</li>
  </ul>
`;

export const UI_TEXT = {
  en: {
    appName: APP_NAME,
    meta: {
      title: `${APP_NAME} — Microscopic Stylus/Groove Physics Simulation`,
      description: 'A real-time microscopic physics simulation of a record stylus tracing a vinyl groove.',
    },
    subtitle: 'Microscopic stylus/groove physics simulation<br>Drag=orbit / wheel/pinch=zoom',
    groups: {
      view: 'View',
      bitRuler: 'Bit Ruler (Digital Reference)',
      signal: 'Signal (Mastering)',
      record: 'Record',
      stylus: 'Stylus / Cartridge',
      analysis: 'Measurement / Analysis',
      help: 'Guide (Physics Model)',
    },
    labels: {
      language: 'Language',
      zoom: 'Zoom',
      slowdown: 'Speed',
      pause: 'Pause',
      showContactMarkers: 'Contact markers (red=no contact)',
      showLabels: 'Part labels (by zoom)',
      showMolecules: 'PVC chain-scale reference (high zoom)',
      showGhost: 'Ideal-tracking ghost stylus (offset=tracking error)',
      stylusTransparency: 'Stylus transparency',
      showTimeScale: 'Travel-axis ruler (0=stylus)',
      showRulerL: 'L-wall ruler (modulation axis)',
      showRulerR: 'R-wall ruler (modulation axis)',
      rulerBits: 'Bits',
      rulerAuto: 'Auto-scale with zoom',
      signalType: 'Signal',
      sineFreq: 'Frequency',
      levelDb: 'Peak level',
      hfCutoff: 'HF cutoff',
      monoBelow: 'Bass mono below',
      rpm: 'Speed',
      radiusMm: 'Groove radius',
      roughSigma: 'Roughness σ',
      dustRate: 'Dust deposition',
      staticRate: 'Static',
      scratchRate: 'Scratches',
      stylusShape: 'Stylus shape',
      rSide: 'Side radius',
      rScan: 'Scanning radius',
      vtfGram: 'Tracking force',
      tipMass: 'Tip mass',
      compliance: 'Compliance',
      measDur: 'Measurement time',
    },
    options: {
      langEn: 'English',
      langJa: 'Japanese',
      time: 'Time',
      length: 'Distance',
      pink: 'Pink noise (music-like)',
      sine: 'Sine wave (test)',
      silence: 'Silence (noise view)',
      elliptical: 'Elliptical (0.3×0.7 mil)',
      spherical: 'Spherical (0.6 mil)',
      durFast: '0.25 s (fast)',
      durAccurate: '1.0 s (more accurate)',
    },
    buttons: {
      measure: 'Run Measurement',
      calibrate: 'Calibrate to SNR 60dB',
    },
    charts: {
      freqTitle: 'Frequency response (after phono EQ, 1/24-oct smoothing)',
      noiseTitle: 'Noise spectrum (silent groove)',
      freqPlaceholder: 'Not measured — click Run Measurement',
      noisePlaceholder: 'Not measured',
      input: 'input',
      output: 'output',
      noise: 'noise',
      yLabel: 'dB/Hz',
    },
    helpBody: HELP_EN,
    format: {
      none: 'none',
      below: 'below',
      notMeasured: 'not measured',
      measuredSn: 'measured SNR',
      roughness: 'roughness σ',
      moleculeDiameter: 'PVC chain scale 1.1nm',
      equivalent: 'equiv.',
      bit: 'bit',
      sn: 'SNR',
      computeLimit: 'compute cap',
      viewWidth: value => `view width ${value}`,
    },
    measurement: {
      initial: 'Run Measurement to measure frequency response, SNR, and skip rate for the current settings. It takes a few seconds.',
      response: 'Measuring (1/2): signal response...',
      noise: 'Measuring (2/2): noise floor...',
      done: dur => `Measurement complete (${dur}s ×2 runs). The noise pass includes the current dust and static settings.`,
      errorPrefix: 'Measurement error: ',
      calibrating: 'Calibrating: searching for the roughness σ that yields SNR 60dB...',
      calibrated: sigmaNm => `Calibration complete: σ=${sigmaNm}nm (SNR≈60dB, DR≈72dB). Run Measurement to confirm.`,
      calibrationErrorPrefix: 'Calibration error: ',
      tiles: {
        snr: 'SNR (20Hz–20kHz, re 5cm/s)',
        bits: 'Digital-equivalent resolution',
        mistrack: 'Mistrack rate (during signal playback)',
        skip: 'Skip rate',
        thd: freq => `THD @ ${freq}Hz`,
      },
    },
    hud: {
      trackingErrorLR: 'Tracking error L/R',
      trackingErrorTime: 'Tracking error time axis',
      trackingSE: 'Tracking S/E',
      jitter: 'jitter σ',
      mistrack: 'Mistrack',
      skip: 'Skip',
      static: 'Static',
      dustHit: 'Dust hits',
      contactForce: 'Contact force L/R',
      indentation: 'Indentation δ',
      contactPressure: 'Contact pressure',
      tipVelocity: 'Tip velocity',
      friction: 'Friction',
      grooveSpeed: 'groove speed',
      slowdown: 'Speed',
    },
    renderer: {
      moleculeLabel: 'PVC chain scale',
      partLabels: {
        stylusTip: 'Stylus tip',
        cantilever: 'Cantilever',
        damper: 'Damper',
        magnetYoke: 'Magnet / yoke',
        cartridge: 'Cartridge',
        headshell: 'Headshell',
        tonearm: 'Tonearm',
        pivot: 'Pivot',
        counterweight: 'Counterweight',
      },
      bitLegendTitle: 'Bit ruler L/R shared',
      minorLine: 'minor',
      majorLine: 'major',
      equivalent: 'equiv.',
      snEquivalent: 'SNR equiv.',
      equals16Minor: '=16 minor',
    },
  },
  ja: {
    appName: APP_NAME,
    meta: {
      title: `${APP_NAME} — レコード針×溝 ミクロ物理シミュレーション`,
      description: 'アナログレコードの針が溝をトレースする様子を、ミクロ物理法則でリアルタイム3DシミュレーションするWebアプリ。',
    },
    subtitle: 'レコード針×溝 ミクロ物理シミュレーション<br>ドラッグ=視点回転 / ホイール/ピンチ=ズーム',
    groups: {
      view: '表示',
      bitRuler: 'ビット目盛り (デジタル換算)',
      signal: '信号 (マスタリング)',
      record: 'レコード',
      stylus: '針・カートリッジ',
      analysis: '測定・解析',
      help: '解説 (物理モデル)',
    },
    labels: {
      language: '言語',
      zoom: 'ズーム',
      slowdown: '速度',
      pause: '一時停止',
      showContactMarkers: '接触点表示 (赤=非接触)',
      showLabels: '部品ラベル (ズーム連動)',
      showMolecules: 'PVC鎖スケール表示 (高倍率で有効)',
      showGhost: '理想追従ゴースト針 (ズレ=追従誤差)',
      stylusTransparency: '針先透明度',
      showTimeScale: '進行方向目盛り (0=針位置)',
      showRulerL: 'L壁 (変調方向) 目盛り',
      showRulerR: 'R壁 (変調方向) 目盛り',
      rulerBits: 'bit数',
      rulerAuto: 'ズームに応じて自動スケール',
      signalType: '信号',
      sineFreq: '周波数',
      levelDb: 'ピークレベル',
      hfCutoff: 'HFカット',
      monoBelow: '低域モノ化',
      rpm: '回転数',
      radiusMm: '溝半径',
      roughSigma: '粗さσ',
      dustRate: '埃堆積',
      staticRate: '静電気',
      scratchRate: '傷',
      stylusShape: '針先形状',
      rSide: '横半径',
      rScan: '走査半径',
      vtfGram: '針圧',
      tipMass: 'チップ質量',
      compliance: 'コンプライアンス',
      measDur: '測定時間',
    },
    options: {
      langEn: 'English',
      langJa: '日本語',
      time: '時間',
      length: '距離',
      pink: 'ピンクノイズ (音楽相当)',
      sine: '正弦波 (測定用)',
      silence: '無音 (ノイズ観察)',
      elliptical: '楕円 (0.3×0.7 mil)',
      spherical: '球 (0.6 mil)',
      durFast: '0.25 s (速い)',
      durAccurate: '1.0 s (高精度)',
    },
    buttons: {
      measure: '測定実行',
      calibrate: 'SN 60dB キャリブレーション',
    },
    charts: {
      freqTitle: '周波数特性 (フォノイコ後, 1/24oct平滑)',
      noiseTitle: 'ノイズスペクトル (無音溝)',
      freqPlaceholder: '未測定 — 「測定実行」を押してください',
      noisePlaceholder: '未測定',
      input: '入力',
      output: '出力',
      noise: 'ノイズ',
      yLabel: 'dB/Hz',
    },
    helpBody: HELP_JA,
    format: {
      none: 'なし',
      below: '以下',
      notMeasured: '未測定',
      measuredSn: '実測SN',
      roughness: '粗さσ',
      moleculeDiameter: 'PVC鎖スケール1.1nm',
      equivalent: '相当',
      bit: 'bit',
      sn: 'SN',
      computeLimit: '演算上限',
      viewWidth: value => `横視野 ${value}`,
    },
    measurement: {
      initial: '「測定実行」で現在の設定の周波数特性・SN・針飛び率を測定します (数秒かかります)。',
      response: '測定中 (1/2): 信号応答…',
      noise: '測定中 (2/2): ノイズフロア…',
      done: dur => `測定完了 (${dur}s ×2回)。ノイズ測定は現在の埃/静電気設定を含みます。`,
      errorPrefix: '測定エラー: ',
      calibrating: 'キャリブレーション中: SN 60dB となる粗さσを探索…',
      calibrated: sigmaNm => `キャリブレーション完了: σ=${sigmaNm}nm (SN≈60dB, DR≈72dB)。「測定実行」で確認できます。`,
      calibrationErrorPrefix: 'キャリブレーションエラー: ',
      tiles: {
        snr: 'SN比 (20Hz–20kHz, re 5cm/s)',
        bits: 'デジタル等価分解能',
        mistrack: 'ミストラック率 (信号再生時)',
        skip: '針飛び率',
        thd: freq => `THD @ ${freq}Hz`,
      },
    },
    hud: {
      trackingErrorLR: '追従誤差 L/R',
      trackingErrorTime: '追従誤差 時間軸',
      trackingSE: '追従S/E',
      jitter: 'ジッタσ',
      mistrack: 'ミストラック',
      skip: '針飛び',
      static: '静電気',
      dustHit: '埃衝突',
      contactForce: '接触力 L/R',
      indentation: 'めり込み δ',
      contactPressure: '接触圧',
      tipVelocity: '針速度',
      friction: '摩擦力',
      grooveSpeed: '溝速度',
      slowdown: '速度',
    },
    renderer: {
      moleculeLabel: 'PVC鎖スケール',
      partLabels: {
        stylusTip: 'スタイラスチップ',
        cantilever: 'カンチレバー',
        damper: 'ダンパー',
        magnetYoke: 'マグネット/ヨーク',
        cartridge: 'カートリッジ',
        headshell: 'ヘッドシェル',
        tonearm: 'トーンアーム',
        pivot: 'ピボット',
        counterweight: 'カウンターウェイト',
      },
      bitLegendTitle: 'ビット目盛り L/R共通',
      minorLine: '細線',
      majorLine: '太線',
      equivalent: '相当',
      snEquivalent: 'SN換算',
      equals16Minor: '=16細線',
    },
  },
};

export function normalizeLang(lang) {
  return lang === 'ja' ? 'ja' : 'en';
}

export function browserDefaultLang() {
  if (typeof navigator === 'undefined') return 'en';
  const primary = (navigator.languages && navigator.languages[0]) || navigator.language || '';
  return primary.toLowerCase().startsWith('ja') ? 'ja' : 'en';
}

export function resolveLanguage() {
  try {
    const stored = localStorage.getItem(LANG_STORAGE_KEY);
    if (stored === 'ja' || stored === 'en') return stored;
  } catch (e) {
    // ignore storage failures
  }
  return browserDefaultLang();
}

export function saveLanguagePreference(lang) {
  try {
    localStorage.setItem(LANG_STORAGE_KEY, normalizeLang(lang));
  } catch (e) {
    // ignore storage failures
  }
}

export function textFor(lang) {
  return UI_TEXT[normalizeLang(lang)];
}

function lookup(obj, path) {
  return path.split('.').reduce((acc, key) => acc && acc[key], obj);
}

export function applyStaticI18n(lang, root = document) {
  const l = normalizeLang(lang);
  const t = textFor(l);
  document.documentElement.lang = l;
  document.documentElement.dataset.lang = l;
  document.title = t.meta.title;
  const desc = document.querySelector('meta[name="description"]');
  if (desc) desc.setAttribute('content', t.meta.description);

  root.querySelectorAll('[data-i18n]').forEach(el => {
    const value = lookup(t, el.dataset.i18n);
    if (typeof value === 'string') el.textContent = value;
  });
  root.querySelectorAll('[data-i18n-html]').forEach(el => {
    const value = lookup(t, el.dataset.i18nHtml);
    if (typeof value === 'string') el.innerHTML = value;
  });
  const help = root.getElementById ? root.getElementById('helpBody') : document.getElementById('helpBody');
  if (help) help.innerHTML = t.helpBody;
}
