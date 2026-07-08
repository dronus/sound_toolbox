// ============================================================================
// groove.js — 溝モデル
//
// 座標系: 溝に沿った弧長 s [m] (パターン座標, 単調増加)。
// 断面: y上向き, x横方向, 原点=無変調時の溝底頂点。
//   左壁法線 nL=(+√½,+√½), 右壁法線 nR=(−√½,+√½) (いずれも溝内側向き)
//   45/45カッティング: 左壁法線変位 = dL(s), 右壁法線変位 = −dR(s)
//   (剛体Vカッターの並進 offset = dL·uL + dR·uR, uL=(√½,√½), uR=(√½,−√½))
//
// 物理が感じる実効表面 wallShift = 信号 + 粗さ(felt) + 埃/傷
// 描画の溝面 wallShiftVisual = 信号 + 粗さ(vis) + 傷のみ —
//   傷はビニルに彫られた損傷なので溝メッシュを変形させるが、埃は壁に乗った
//   異物なので溝は変形させず独立粒子として描画する (針はその上を乗り越える)
// ============================================================================
import { CONST } from './params.js?v=20260706-sigma13-cache';
import { SignalGenerator, makeRng, makeGauss } from './dsp.js?v=20260706-sigma13-cache';

const SIG_LEN = 1 << 15;    // 信号リング長 (32768サンプル ≈ 数cm)
const ROUGH_LEN = 1 << 18;  // 粗さリング長 (262144 × 50nm ≈ 13mm)
// 多スケール粗さ (実測ビニル表面のフラクタル的性状を3成分で近似):
//  fine: 相関長0.15µm — 分子塊/微結晶スケール
//  mid : 相関長2µm   — スタンパー転写・成形起因。可聴帯域ノイズの主因
//  wav : 相関長30µm  — うねり(カッティング/プレスの低周波誤差)。ランブル成分
//
// 接触パッチ (~5×7µm) は2次元に広がるため、針が「感じる」粗さは
// パッチ横方向の平均化で短波長成分ほど減衰する。1D溝モデルでは進行方向の
// 平均化しか自然に生じないため、横方向平均化を解析係数 κ=√(ℓ/(ℓ+a_t))
// (a_t≈2.5µm: 横方向パッチ半幅) として felt リングに事前適用する。
// → 「見える粗さ(visual)」と「針が感じる粗さ(felt)」の物理的に正しい分離。
//    これが分子スケールの凹凸があっても理想プレス盤が~70dB級に達し得る理由。
const CORR_FINE = 0.15e-6, CORR_MID = 2e-6, CORR_WAV = 30e-6;
const FRAC_FINE = 0.60, FRAC_MID = 0.30, FRAC_WAV = 0.10; // 分散比率
const PATCH_T = 2.5e-6; // 横方向パッチ半幅 [m]

// --- 埃の実世界モデリング ---
// 堆積: レコード表面へ一様に落下し、着地点で運命が分かれる:
//   ランド (溝の外, ~40%) → 針に触れない / 溝内 → 壁に付着 or V溝底へ転落。
//   壁付着確率 exp(−h/4µm): 小粒子は van der Waals 付着が支配的で壁に貼り付き、
//   大粒子は重力が勝って底へ転がり落ちる (V溝は埃のファネル)。
// サイズ: 対数正規分布 — 実測の堆積粉塵は小粒子が圧倒的多数・まれに大粒。
// 種別: flake=皮膚片/紙粉 (柔, 潰れて15%残留) / fiber=衣類繊維 (細長, 柔) /
//       grit=鉱物粒 (石英等, ほぼ潰れず針を打ち上げ → 通過後に弾き出される)
// 命中は創発: 針接触線 (壁上距離 t≈rSide) との横ズレ × 粒子の横広がりで実効
//   高さ hFelt が決まり (縁をかすめれば部分命中)、溝底の粒子は針先底面の
//   クリアランス (≈(√2−1)·rSide ≈7.5µm) を超える大粒のみ両壁を同時に押す。
// 潰れ: 弾塑性 — 針球面が実際に押し込んだ場所・深さでのみ降伏 (降伏深さ yld
//   超過分を恒久変形, 残留下限 res)。各埃の top[] = 針底面の通過最小ギャップ包絡線。
//   潰れ進行中も針は降伏反力を受け続ける (= ポップ音の源)。
const DUST_KIND = {
  flake: { yld: 0.5e-6, res: 0.15 },
  fiber: { yld: 0.2e-6, res: 0.10 },
  grit: { yld: 3.0e-6, res: 0.85 },
};
const TOP_N = 49;            // 圧痕包絡線のサンプル数 (足跡 ±4w を等分)
const KAPPA_FINE = Math.sqrt(CORR_FINE / (CORR_FINE + PATCH_T));
const KAPPA_MID = Math.sqrt(CORR_MID / (CORR_MID + PATCH_T));
const KAPPA_WAV = Math.sqrt(CORR_WAV / (CORR_WAV + PATCH_T));

export class GrooveModel {
  constructor(params, seed = 12345) {
    this.p = params;
    this.gen = new SignalGenerator(params, seed);
    this.dzSig = (2 * Math.PI * (params.radiusMm * 1e-3) * (params.rpm / 60)) / CONST.FS;

    // 信号リング
    this.sigShiftL = new Float32Array(SIG_LEN);
    this.sigShiftR = new Float32Array(SIG_LEN);
    this.refVelL = new Float32Array(SIG_LEN);  // 測定用: 入力カッター速度
    this.refVelR = new Float32Array(SIG_LEN);
    this.sigN = -1; // 生成済み最終サンプル番号

    // 粗さリング (壁ごとに独立): vis=見える粗さ, felt=針が感じる粗さ(κ適用)
    this.roughVisL = new Float32Array(ROUGH_LEN);
    this.roughVisR = new Float32Array(ROUGH_LEN);
    this.roughFeltL = new Float32Array(ROUGH_LEN);
    this.roughFeltR = new Float32Array(ROUGH_LEN);
    this.roughN = -1;
    const aF = Math.exp(-CONST.ROUGH_DZ / CORR_FINE);
    const aM = Math.exp(-CONST.ROUGH_DZ / CORR_MID);
    const aW = Math.exp(-CONST.ROUGH_DZ / CORR_WAV);
    this.aF = aF; this.aM = aM; this.aW = aW;
    const sigma = params.roughSigma;
    // 各AR(1)の定常分散 g²/(1−a²) が指定比率になるよう解析的に正規化
    this.gF = sigma * Math.sqrt(FRAC_FINE * (1 - aF * aF));
    this.gM = sigma * Math.sqrt(FRAC_MID * (1 - aM * aM));
    this.gW = sigma * Math.sqrt(FRAC_WAV * (1 - aW * aW));
    this.stL = { f: 0, m: 0, w: 0 }; this.stR = { f: 0, m: 0, w: 0 };
    const rr = makeRng(seed ^ 0x51ab3d);
    this.gaussR = makeGauss(rr);

    // 埃
    this.dust = [];           // {s, wall(0=L,1=R,2=傷,3=溝底), loc, kind, h, w, hFelt, amp, top?, crushed}
    this.dustRng = makeRng(seed ^ 0xdeadbe);
    this.gaussD = makeGauss(this.dustRng); // 粒径の対数正規分布用
    this.spawnAhead = 400e-6; // 針の400µm先に出現(接近が見える)
    this.dustHits = 0;        // 針が踏んだ累積回数 (表示側でレート化)
    this.activeDust = [];     // 針近傍の埃 (塑性圧縮の対象キャッシュ, advanceDustで更新)
  }

  // s [m] まで生成済みであることを保証
  ensure(sMax) {
    const nSig = Math.ceil(sMax / this.dzSig) + 4;
    while (this.sigN < nSig) {
      this.sigN++;
      const i = this.sigN & (SIG_LEN - 1);
      const { dL, dR, vL, vR } = this.gen.next();
      this.sigShiftL[i] = dL;       // 左壁法線変位 = +dL
      this.sigShiftR[i] = -dR;      // 右壁法線変位 = −dR (45/45幾何)
      this.refVelL[i] = vL;
      this.refVelR[i] = vR;
    }
    const nR = Math.ceil(sMax / CONST.ROUGH_DZ) + 4;
    while (this.roughN < nR) {
      this.roughN++;
      const i = this.roughN & (ROUGH_LEN - 1);
      const g = this.gaussR;
      const L = this.stL, R = this.stR;
      L.f = this.aF * L.f + this.gF * g();
      R.f = this.aF * R.f + this.gF * g();
      L.m = this.aM * L.m + this.gM * g();
      R.m = this.aM * R.m + this.gM * g();
      L.w = this.aW * L.w + this.gW * g();
      R.w = this.aW * R.w + this.gW * g();
      this.roughVisL[i] = L.f + L.m + L.w;
      this.roughVisR[i] = R.f + R.m + R.w;
      this.roughFeltL[i] = KAPPA_FINE * L.f + KAPPA_MID * L.m + KAPPA_WAV * L.w;
      this.roughFeltR[i] = KAPPA_FINE * R.f + KAPPA_MID * R.m + KAPPA_WAV * R.w;
    }
  }

  // 信号成分のみ (Catmull-Rom 立方補間 — C1連続で接触力のδ̇も滑らか)
  signalShift(wall, s) {
    const f = s / this.dzSig;
    let n = Math.floor(f);
    const t = f - n;
    if (n < 1) n = 1;
    const arr = wall === 0 ? this.sigShiftL : this.sigShiftR;
    const M = SIG_LEN - 1;
    const p0 = arr[(n - 1) & M], p1 = arr[n & M];
    const p2 = arr[(n + 1) & M], p3 = arr[(n + 2) & M];
    return p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3
      + t * (3 * (p1 - p2) + p3 - p0)));
  }

  // 粗さ成分 (線形補間)。felt=true で針が感じる粗さ(パッチ2D平均化済)
  roughShift(wall, s, felt = false) {
    const f = s / CONST.ROUGH_DZ;
    let n = Math.floor(f);
    const t = f - n;
    if (n < 0) n = 0;
    const arr = felt
      ? (wall === 0 ? this.roughFeltL : this.roughFeltR)
      : (wall === 0 ? this.roughVisL : this.roughVisR);
    const i0 = n & (ROUGH_LEN - 1), i1 = (n + 1) & (ROUGH_LEN - 1);
    return arr[i0] * (1 - t) + arr[i1] * t;
  }

  // 埃/傷成分
  //  - hFelt: 針接触線での実効高さ (横ズレ減衰済)。wall=3(溝底)は両壁を等しく押す
  //  - amp: 出現時の成長係数 0→1 (瞬間出現のポップを防ぐ, 針到達より十分前に完了)
  //  - top: 塑性圧痕包絡線 — 針底面が実際に通過した最小ギャップ (plasticCrushが更新)。
  //    針が押した場所だけが潰れるため、飛び越えた/掠らなかった埃は無傷のまま残る
  //  - 傷: 中央の削れ(負) + 前後の塑性バリ(正)。正味で接触喪失も打ち上げも起こり得る
  dustShift(wall, s, scratchOnly = false) {
    let d = 0;
    for (let k = 0; k < this.dust.length; k++) {
      const D = this.dust[k];
      if (scratchOnly && D.wall !== 2) continue;
      let hEff;
      if (D.wall === 2) {
        const wallSkew = wall === 0 ? -(D.skew ?? 0) : (D.skew ?? 0);
        const u = (s - D.s - wallSkew) / D.w;
        if (u > 4 || u < -4) continue;
        const side = wall === 0 ? (D.wallL ?? 1) : (D.wallR ?? D.asym ?? 1);
        const g = Math.exp(-((u / D.gougeW) ** 2));
        const lead = Math.exp(-(((u + D.lipOffset) / D.lipW) ** 2));
        const trail = Math.exp(-(((u - D.lipOffset) / D.lipW) ** 2));
        const gouge = -D.gouge * g;
        const burr = D.burr * (D.lipLead * lead + D.lipTrail * trail);
        d += side * D.amp * (gouge + burr);
        continue;
      }
      else if (D.wall === 3 || D.wall === wall) hEff = D.hFelt;
      else continue;
      if (hEff < 1e-12) continue;
      const u = (s - D.s) / D.w;
      if (u > 4 || u < -4) continue;
      let h = hEff * D.amp * Math.exp(-u * u);
      if (D.top) {
        const f = (u + 4) * (TOP_N - 1) / 8;
        const i = Math.min(Math.floor(f), TOP_N - 2);
        const t = f - i;
        const cap = D.top[i] * (1 - t) + D.top[i + 1] * t;
        if (cap < h) h = cap;
      }
      d += h;
    }
    return d;
  }

  // 塑性圧縮 (物理サブステップごとに呼ばれる):
  //   針球面の底面高さ ballH(s) = dz²/(2·rScan) − base − 壁面変位(埃以外)
  //   埃が ballH + 降伏深さ(yld, 種別依存) を超える場所は降伏し、包絡線 top を
  //   そこまで切り下げる。残留下限 res·(局所高さ) = 圧密限界 (grit はほぼ潰れない)。
  //   base = rSide − (針の壁面距離)。wall=3(溝底) は両壁のどちらの接触でも潰れる
  plasticCrush(wall, sTip, base, rScan, win) {
    for (const D of this.activeDust) {
      if (D.wall !== wall && D.wall !== 3) continue;
      const s0 = D.s - 4 * D.w, ds = 8 * D.w / (TOP_N - 1);
      let k0 = Math.ceil((sTip - win - s0) / ds);
      let k1 = Math.floor((sTip + win - s0) / ds);
      if (k0 < 0) k0 = 0;
      if (k1 > TOP_N - 1) k1 = TOP_N - 1;
      for (let k = k0; k <= k1; k++) {
        const sk = s0 + k * ds;
        const u = (sk - D.s) / D.w;
        const g = D.hFelt * D.amp * Math.exp(-u * u);
        const cur = D.top && D.top[k] < g ? D.top[k] : g; // 現在の有効高さ
        if (cur <= 0) continue;
        const dz = sk - sTip;
        const ballH = (dz * dz) / (2 * rScan) - base
          - this.signalShift(wall, sk) - this.roughShift(wall, sk, true);
        // 接触判定は塑性変形と独立: 硬い粒 (grit) は潰れなくても「触れた」
        if (cur > ballH) D.touched = true;
        const allowed = Math.max(ballH + D.yld, D.res * g);
        if (allowed < cur) {
          if (!D.top) D.top = new Float32Array(TOP_N).fill(Infinity);
          D.top[k] = allowed;
        }
      }
    }
  }

  // 埃の潰れ度 0(無傷)–1(完全圧縮) — 描画用 (中心の残存高さ比から算出)
  dustCrushFrac(D) {
    if (!D.top || !(D.amp > 0) || !(D.hFelt > 0)) return 0;
    const h = D.hFelt * D.amp;
    const cap = D.top[(TOP_N - 1) >> 1];
    if (!(cap < h)) return 0;
    return Math.min(1, (1 - cap / h) / (1 - D.res));
  }

  // 壁面の総変位 [m] (法線方向, 正=針側へ隆起)
  // 物理(接触)用: パッチ平均化済み粗さを使用
  wallShift(wall, s) {
    return this.signalShift(wall, s) + this.roughShift(wall, s, true) + this.dustShift(wall, s);
  }

  // 描画用: 実際に存在する(見える)粗さ + 傷のみ。
  // 埃は溝の変形ではなく独立粒子としてrender側が描く (溝メッシュは元のまま)
  wallShiftVisual(wall, s) {
    return this.signalShift(wall, s) + this.roughShift(wall, s, false) + this.dustShift(wall, s, true);
  }

  // 入力基準速度 (測定用, L/Rチャンネル)
  refVelocity(s) {
    const n = Math.round(s / this.dzSig) & (SIG_LEN - 1);
    return { vL: this.refVelL[n], vR: this.refVelR[n] };
  }

  // 埃の生成/潰し処理: 針位置 sStylus, 経過レコード時間 dt
  // rateScale: 通常は1。検証用にだけPoisson発生率を明示加速できる。
  advanceDust(sStylus, dt, grooveVel, rateScale = 1) {
    const p = this.p;
    // 出現距離: 体感~2.5秒先。下限16µm = 接触走査窓(±6.4µm)の外を保証
    const ahead = Math.min(400e-6, Math.max(16e-6, grooveVel * 2.5 / rateScale));
    // ampRate: 針到達時間の~25%で成長完了 (到達時には必ず全高) [1/s 記録時間]
    if (p.dustRate > 0 && this.dustRng() < p.dustRate * dt * rateScale) {
      const r = this.dustRng;
      const D = { s: sStylus + ahead * (0.5 + r()), amp: 0, crushed: false };
      D.ampRate = grooveVel / (0.25 * (D.s - sStylus));
      // 種別とサイズ (対数正規: 小粒子が多数, まれに大粒)
      const kr = r();
      if (kr < 0.55) {
        D.kind = 'flake';
        D.h = Math.min(12e-6, Math.max(0.3e-6, 1.5e-6 * Math.exp(0.8 * this.gaussD())));
        D.w = D.h * (0.7 + 1.6 * r());
      } else if (kr < 0.85) {
        D.kind = 'fiber';
        D.h = (1 + 2 * r()) * 1e-6;              // 繊維径
        const L = (10 + 30 * r()) * 1e-6;        // 繊維長
        const phi = r() * Math.PI / 2;           // 溝方向に対する寝そべり角
        D.w = Math.max(D.h, 0.5 * L * Math.cos(phi));
        D.latHalf = Math.max(D.h, L * Math.sin(phi)) / 2;
      } else {
        D.kind = 'grit';
        D.h = Math.min(6e-6, Math.max(0.5e-6, 2e-6 * Math.exp(0.6 * this.gaussD())));
        D.w = D.h * (0.8 + 0.6 * r());
      }
      D.yld = DUST_KIND[D.kind].yld;
      D.res = DUST_KIND[D.kind].res;
      // 落下位置: ~40%はランド (針経路の外)。溝内は壁付着 or V溝底へ転落
      const pr = r();
      if (pr < 0.4) {
        D.loc = 'land';
        D.wall = r() < 0.5 ? 0 : 1;
        D.landX = (2 + 30 * r()) * 1e-6;         // 溝縁からの距離
        D.hFelt = 0;
      } else if (D.kind === 'fiber' || r() < Math.exp(-D.h / 4e-6)) {
        // 壁付着: 針接触線 (t≈rSide) との横ズレ分だけ実効高さが減衰 (縁かすり)
        D.loc = 'wall';
        D.wall = r() < 0.5 ? 0 : 1;
        D.t = (3 + 39 * r()) * 1e-6;             // 壁上距離 (底フィレット上〜ランド縁)
        const lam = (D.latHalf ?? 0.5 * D.h) + PATCH_T;
        const dLat = (D.t - p.rSide) / lam;
        D.hFelt = D.h * Math.exp(-dLat * dLat);
      } else {
        // 溝底に静置 (90°Vで頂点高さ = (√2+1)·h/2)。針先底面クリアランス
        // (√2−1)·rSide を超える大粒のみ両壁を同時に押す (モノラルの「ドスッ」)
        D.loc = 'bottom';
        D.wall = 3;
        const top = (Math.SQRT2 + 1) * 0.5 * D.h;
        D.hFelt = Math.SQRT1_2 * Math.max(0, top - (Math.SQRT2 - 1) * p.rSide);
      }
      this.dust.push(D);
    }
    // 傷 (スクラッチ): 横断傷は単純な障害物ではなく、削れた谷とその前後に押し出された
    // バリの組み合わせとして扱う。バリは針を打ち上げ、削れは接触喪失や片ch欠落を起こす。
    if (p.scratchRate > 0 && this.dustRng() < p.scratchRate * dt * rateScale) {
      const r = this.dustRng;
      const sAhead = ahead * (0.5 + r());
      const q = r();
      let scratchKind, gouge, burr, width, wallR;
      if (q < 0.28) {
        scratchKind = 'hairline';     // 浅い擦り傷。ほぼ見た目主体だが接触帯に入るとチッと出る
        gouge = (0.2 + 1.3 * r()) * 1e-6;
        burr = (0.1 + 0.9 * r()) * 1e-6;
        width = (18 + 55 * r()) * 1e-6;
        wallR = 0.65 + 0.30 * r();
      } else if (q < 0.63) {
        scratchKind = 'plough';       // 削れと縁バリが同居
        gouge = (4 + 10 * r()) * 1e-6;
        burr = (6 + 14 * r()) * 1e-6;
        width = (10 + 28 * r()) * 1e-6;
        wallR = 0.35 + 0.55 * r();
      } else if (q < 0.80) {
        scratchKind = 'burr';         // 押し出し/剥離片優勢。針飛びを起こしやすい
        gouge = (1 + 5 * r()) * 1e-6;
        burr = (12 + 18 * r()) * 1e-6;
        width = (8 + 24 * r()) * 1e-6;
        wallR = 0.25 + 0.55 * r();
      } else if (q < 0.95) {
        scratchKind = 'cut';          // 欠損優勢。接触喪失・ザッという歪みが主
        gouge = (8 + 14 * r()) * 1e-6;
        burr = (1 + 6 * r()) * 1e-6;
        width = (10 + 34 * r()) * 1e-6;
        wallR = 0.30 + 0.55 * r();
      } else {
        scratchKind = 'chip';         // 片壁寄りの深い欠け。少数だがミストラックが強い
        gouge = (12 + 16 * r()) * 1e-6;
        burr = (6 + 22 * r()) * 1e-6;
        width = (12 + 30 * r()) * 1e-6;
        wallR = 0.05 + 0.30 * r();
      }
      let lipLead = 0.45 + 0.95 * r();
      let lipTrail = 0.20 + 0.80 * r();
      if (r() < 0.5) [lipLead, lipTrail] = [lipTrail, lipLead];
      let wallL = 1;
      if (r() < 0.5) [wallL, wallR] = [wallR, wallL];
      this.dust.push({
        s: sStylus + sAhead,
        wall: 2,
        scratchKind,
        gouge,                         // 中央欠損の深さ
        burr,                          // 縁バリの高さ
        h: Math.max(gouge, burr),       // 描画・寿命管理用の代表高さ
        w: width,
        lipOffset: 0.75 + 0.55 * r(),   // 中央削れからバリ頂点までの距離 (w単位)
        lipW: 0.22 + 0.28 * r(),        // バリの鋭さ
        gougeW: 0.70 + 0.45 * r(),      // 削れ谷の広がり
        lipLead,
        lipTrail,
        wallL,
        wallR,
        skew: (r() - 0.5) * width * 1.4, // 斜め傷: L/R壁で通過タイミングが少しずれる
        asym: wallR,                     // 旧データ互換用
        amp: 0,
        ampRate: grooveVel / (0.25 * sAhead),
        crushed: false,
        scratch: true,
      });
    }
    for (let k = this.dust.length - 1; k >= 0; k--) {
      const D = this.dust[k];
      if (D.dying) {
        // 個数上限による除去: 成長と同レートで縮小し、消えてから配列から外す
        D.amp -= dt * D.ampRate;
        if (D.amp <= 0) this.dust.splice(k, 1);
        continue;
      }
      if (D.amp < 1) D.amp = Math.min(1, D.amp + dt * D.ampRate);
      if (!D.scratch && !D.crushed && sStylus > D.s + 2 * D.w) {
        D.crushed = true;
        if (D.touched) {
          this.dustHits++;                       // 実際に針が触れた粒子のみ計数
          if (D.kind === 'grit') D.dying = true; // 硬い鉱物粒は弾き飛ばされる
        }
      }
    }
    // 遠く後方 (視野外) の埃は即破棄。個数上限超過分は最古からフェードアウト
    while (this.dust.length && this.dust[0].s < sStylus - 5e-3) this.dust.shift();
    for (let k = 0; k < this.dust.length - 128; k++) this.dust[k].dying = true;
    while (this.dust.length > 176) this.dust.shift();
    // 針近傍の埃キャッシュ (物理サブステップの塑性圧縮が全走査しないため)。
    // 針に届き得る粒子 (hFelt>0) のみ — ランドや小粒の底埃は物理対象外
    this.activeDust.length = 0;
    for (const D of this.dust) {
      if (!D.scratch && D.hFelt > 1e-9 && Math.abs(D.s - sStylus) < 4 * D.w + 16e-6) {
        this.activeDust.push(D);
      }
    }
  }
}

// 壁法線・接線ベクトル (断面内)
export const N_L = { x: Math.SQRT1_2, y: Math.SQRT1_2 };
export const N_R = { x: -Math.SQRT1_2, y: Math.SQRT1_2 };
export const U_L = { x: Math.SQRT1_2, y: Math.SQRT1_2 };   // Lチャンネル変調方向
export const U_R = { x: Math.SQRT1_2, y: -Math.SQRT1_2 };  // Rチャンネル変調方向
