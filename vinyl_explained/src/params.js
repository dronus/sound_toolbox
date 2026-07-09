// ============================================================================
// params.js — 物理定数・既定パラメータ（すべてSI単位: m, s, kg, N）
// 主要な物理定数と既定値。
// ============================================================================

export const CONST = {
  // --- 基準レベル ---
  V_REF: 0.05,              // 基準速度 5 cm/s (1kHz 0dB: モノ横RMS=5cm/s、45/45壁方向ピーク=5cm/s)
  RULER_FULL_SCALE_DISP: 15e-6, // 目盛り用0dBFS相当: 典型的なLPアルバムの壁面ピーク ±15 µm
  CUT_DISP_LIMIT: 25e-6,    // ハード上限 ±25 µm (モノ横ピーク約35 µm、低域大振幅の非常域)

  // --- レコード盤ジオメトリ ---
  R_OUTER: 0.146,           // LP最外周溝半径 146 mm
  R_INNER: 0.060,           // LP最内周溝半径 60 mm

  // --- 溝ジオメトリ (標準ステレオマイクログルーブ) ---
  GROOVE_HALF_WIDTH: 30e-6, // 溝上端の半幅 30 µm (全幅 ~60 µm)
  GROOVE_DEPTH: 30e-6,      // 90° V字: 深さ = 半幅
  GROOVE_BOTTOM_R: 4e-6,    // 溝底の丸み半径 ~4 µm
  GROOVE_PITCH: 100e-6,     // 隣接溝ピッチ ~100 µm (約10本/mm)

  // --- ビニール材料 (PVC/PVAc コポリマー) ---
  PVC_E: 3.0e9,             // ヤング率 ~3 GPa
  PVC_NU: 0.4,              // ポアソン比
  // ダイヤモンド針は剛体近似 → E* = E/(1-ν²)
  MOLECULE_R: 0.55e-9,      // PVC鎖の局所スケール参照半径 ~0.55 nm (可視化用。ランダムコイル径ではない)

  // --- RIAA 時定数 ---
  RIAA_T1: 3180e-6,         // 3180 µs (50.05 Hz)
  RIAA_T2: 318e-6,          // 318 µs  (500.5 Hz)
  RIAA_T3: 75e-6,           // 75 µs   (2122 Hz)
  RIAA_T4: 3.18e-6,         // Neumann HFポール ~50 kHz (カッティングアンプの実在極)

  // --- サンプリング ---
  FS: 192000,               // 記録信号サンプルレート [Hz] (レコード時間軸)
  PHYS_SUBSTEPS: 20,        // 物理dt = 1/(FS*PHYS_SUBSTEPS) = 0.2604 µs
  ROUGH_DZ: 50e-9,          // 粗さリングの空間サンプリング 50 nm
};

export const ZOOM_MIN = 0.005;
export const ZOOM_MAX = 1e7;
export const SLOWDOWN_MIN = 1e2;
export const SLOWDOWN_MAX = 1e6;

CONST.PHYS_DT = 1 / (CONST.FS * CONST.PHYS_SUBSTEPS);
CONST.PVC_ESTAR = CONST.PVC_E / (1 - CONST.PVC_NU * CONST.PVC_NU); // ≈3.57 GPa

// ---------------------------------------------------------------------------
// ユーザー可変パラメータの既定値
// ---------------------------------------------------------------------------
export function defaultParams() {
  return {
    // --- 信号 ---
    signalType: 'pink',     // 'pink' | 'sine' | 'silence'
    sineFreq: 1000,         // [Hz] sine時
    levelDb: 12,            // 録音ピークレベル [dB re 5cm/sピーク]。LPアルバムの音楽ピークは+10〜+12dB程度が典型
    hfCutoff: 16000,        // マスタリングHFカット [Hz]
    monoBelow: 250,         // この周波数以下はほぼモノラル [Hz] (エリプティックEQ相当)
    sideMix: 0.7,           // Side成分の量 (0=完全モノ)

    // --- レコード ---
    rpm: 100 / 3,           // 33⅓ rpm
    radiusMm: 120,          // 現在の溝半径 [mm] (外周146↔内周60)
    // 壁面粗さRMS [m] — スタンパー精度/分子配置誤差。
    // SNR=60.0dB (9.7bit) となるよう校正済み —
    // 既定ピークレベル +12dB と合わせて DR=72dB (実測レコードの上限域に収まる設定)。
    // AFM実測のビニル溝面粗さ(数nm〜数十nm)とも整合する。
    roughSigma: 13.17e-9,
    dustRate: 2.0,          // 埃堆積率 [個/秒]。普通に聴ける中古盤の目安。
                            // 針との遭遇は位置×粒径から創発
    staticRate: 0.08,       // 静電気パルス率 [回/秒]。乾燥気味の環境で数十秒に数回
    scratchRate: 0,         // 傷(スクラッチ)遭遇率 [回/秒]。通常盤の既定はなし

    // --- 針・カートリッジ ---
    stylusShape: 'elliptical', // 'spherical' | 'elliptical'
    rSide: 18e-6,           // 接触(横)半径 [m] (球:15µm, 楕円:18µm)
    rScan: 8e-6,            // 走査(進行方向)半径 [m] (球では=rSide)
    vtfGram: 2.0,           // 針圧 [g]
    tipMass: 0.4e-6,        // 実効チップ質量 [kg] (0.4 mg)
    compliance: 15e-3,      // コンプライアンス [m/N] (=15×10⁻⁶ cm/dyne)
    dampZeta: 0.25,         // カンチレバーダンパ減衰比
    armMass: 0.012,         // トーンアーム実効質量 [kg]
    kvTau: 2e-6,            // Kelvin-Voigt接触減衰時定数 [s] (PVC粘弾性損失)
    mu: 0.3,                // 動摩擦係数 (診断表示用)

    // --- 表示 ---
    lang: 'en',             // UI language; main.js overrides this from storage/browser/hash
    zoom: 30,               // 倍率 (0.005=視野600mm .. 1e7=視野0.3nm)
    slowdown: 3000,         // 実時間比スロー倍率
    showRulerL: false,
    showRulerR: false,
    rulerBits: 12,          // ビット目盛り
    rulerAuto: true,        // ノイズ等価bitに自動追従
    fullScaleDisp: CONST.RULER_FULL_SCALE_DISP, // デジタル換算のフルスケール壁面変位 [m] (±15µm)
    showMolecules: true,
    showContactMarkers: false, // 左右壁の接触点マーカー
    showLabels: true,        // ズーム倍率に応じた部品ラベル
    showGhost: false,       // 理想追従ゴースト針 (ズレ=追従誤差の可視化)
    stylusTransparency: 0,   // 針先透明度 [%] (0=不透明, 100=完全透明)
    showTimeScale: true,    // 進行方向の目盛り (針位置基準)
    timeScaleMode: 'length', // 'time'(時間) | 'length'(距離)
  };
}

// 溝の線速度 [m/s]
export function grooveSpeed(p) {
  return 2 * Math.PI * (p.radiusMm * 1e-3) * (p.rpm / 60);
}

// Hertz接触剛性係数 k_h : F = k_h · δ^1.5
export function hertzK(p) {
  const rEff = p.stylusShape === 'spherical'
    ? p.rSide
    : Math.sqrt(p.rSide * p.rScan);   // 楕円接触の等価半径(幾何平均近似)
  return (4 / 3) * CONST.PVC_ESTAR * Math.sqrt(rEff);
}

// 針圧 [N]
export function vtfNewton(p) { return p.vtfGram * 1e-3 * 9.80665; }

// 量子化換算: 粗さσ → 等価bit数 (q/√12 = σ となる q に対して)
export function sigmaToBits(sigma, fullScale) {
  const q = sigma * Math.sqrt(12);
  return Math.log2((2 * fullScale) / q);
}
export function snrToBits(snrDb) { return (snrDb - 1.76) / 6.02; }
