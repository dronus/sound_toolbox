// ============================================================================
// groove.js — Groove Model
//
// Coordinate system: arc length s [m] along the groove (pattern coordinate, monotonically increasing).
// Cross-section: y-up, x-lateral, origin = groove bottom vertex when unmodulated.
//   Left wall normal nL=(+√½,+√½), Right wall normal nR=(−√½,+√½) (both pointing inward).
//   45/45 cutting: Left wall normal displacement = dL(s), Right wall normal displacement = −dR(s)
//   (Rigid V-cutter translation offset = dL·uL + dR·uR, uL=(√½,√½), uR=(√½,−√½))
//
// Effective surface felt by physics: wallShift = signal + roughness(felt) + dust/scratches
// Visual groove surface: wallShiftVisual = signal + roughness(vis) + scratches only —
//   Scratches are damage carved into the vinyl, so they deform the groove mesh.
//   Dust consists of foreign particles on the wall, so the groove is not deformed; 
//   dust is rendered as independent particles (the stylus rides over them).
// ============================================================================
import { CONST } from './params.js?v=20260706-sigma13-cache';
import { SignalGenerator, makeRng, makeGauss } from './dsp.js?v=20260706-sigma13-cache';

const SIG_LEN = 1 << 15;    // Signal ring length (32768 samples ≈ few cm)
const ROUGH_LEN = 1 << 18;  // Roughness ring length (262144 × 50nm ≈ 13mm)
// Multi-scale roughness (approximating the fractal nature of measured vinyl surfaces with 3 components):
//  fine: correlation length 0.15µm — molecular cluster/micro-crystal scale
//  mid : correlation length 2µm   — caused by stamper transfer/molding. Main source of audible noise.
//  wav : correlation length 30µm  — waviness (low-frequency errors in cutting/pressing). Rumble component.
//
// Since the contact patch (~5×7µm) is 2D, the roughness "felt" by the stylus
// is attenuated for shorter wavelengths due to lateral averaging across the patch.
// In a 1D groove model, only longitudinal averaging occurs naturally.
// Therefore, lateral averaging is pre-applied to the "felt" ring using an analytic coefficient
// κ=√(ℓ/(ℓ+a_t)) (a_t≈2.5µm: lateral patch half-width).
// → This provides a physically correct separation between "visual roughness" and "felt roughness".
//    This explains why ideal pressings can reach ~70dB SNR despite molecular-scale irregularities.
const CORR_FINE = 0.15e-6, CORR_MID = 2e-6, CORR_WAV = 30e-6;
const FRAC_FINE = 0.60, FRAC_MID = 0.30, FRAC_WAV = 0.10; // 分散比率
const PATCH_T = 2.5e-6; // 横方向パッチ半幅 [m]

// --- Real-world Dust Modeling ---
// Deposition: Particles fall uniformly onto the record surface, and their fate depends on the landing site:
//   Land (outside groove, ~40%) → no stylus contact / Inside groove → adhere to wall or fall to V-bottom.
//   Wall adhesion probability exp(−h/4µm): small particles adhere via van der Waals forces,
//   while large particles are dominated by gravity and roll to the bottom (V-groove acts as a dust funnel).
// Size: Log-normal distribution — measured deposited dust consists mostly of small particles, rarely large ones.
// Types: flake=skin/paper (soft, 15% remains after crushing) / fiber=clothing (elongated, soft) /
//       grit=mineral (quartz, etc., barely crushes, kicks stylus up → ejected after passing).
// Hit detection is emergent: effective height hFelt is determined by the lateral offset from the
//   stylus contact line (wall distance t≈rSide) × particle width (partial hits occur at edges).
//   Particles at the groove bottom only push both walls simultaneously if they exceed the
//   stylus tip bottom clearance (≈(√2−1)·rSide ≈7.5µm).
// Crushing: Elasto-plastic — yield occurs only where and how deep the stylus sphere actually presses
//   (permanent deformation for depth exceeding yield depth yld, with a residual limit res).
//   Each dust particle's top[] = envelope of the minimum gap passed by the stylus bottom.
//   The stylus continues to receive yield reaction force during crushing (= source of pop sounds).
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

    // Signal ring
    this.sigShiftL = new Float32Array(SIG_LEN);
    this.sigShiftR = new Float32Array(SIG_LEN);
    this.refVelL = new Float32Array(SIG_LEN);  // For measurement: input cutter velocity
    this.refVelR = new Float32Array(SIG_LEN);
    this.sigN = -1; // 生成済み最終サンプル番号

    // Roughness ring (independent per wall): vis=visible roughness, felt=roughness felt by stylus (κ applied)
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
    // Analytically normalize so that the stationary variance g²/(1−a²) of each AR(1) matches the specified ratio
    this.gF = sigma * Math.sqrt(FRAC_FINE * (1 - aF * aF));
    this.gM = sigma * Math.sqrt(FRAC_MID * (1 - aM * aM));
    this.gW = sigma * Math.sqrt(FRAC_WAV * (1 - aW * aW));
    this.stL = { f: 0, m: 0, w: 0 }; this.stR = { f: 0, m: 0, w: 0 };
    const rr = makeRng(seed ^ 0x51ab3d);
    this.gaussR = makeGauss(rr);

    // Dust
    this.dust = [];           // {s, wall(0=L,1=R,2=scratch,3=groove bottom), loc, kind, h, w, hFelt, amp, top?, crushed}
    this.dustRng = makeRng(seed ^ 0xdeadbe);
    this.gaussD = makeGauss(this.dustRng); // 粒径の対数正規分布用
    this.spawnAhead = 400e-6; // Appear 400µm ahead of stylus (so approach is visible)
    this.dustHits = 0;        // Cumulative count of particles hit by stylus (converted to rate in UI)
    this.activeDust = [];     // 針近傍の埃 (塑性圧縮の対象キャッシュ, advanceDustで更新)
  }

  // Ensure generation up to sMax [m]
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

  // Signal component only (Catmull-Rom cubic interpolation — C1 continuous for smooth contact force δ̇)
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

  // Roughness component (linear interpolation). felt=true for roughness felt by stylus (2D patch averaged)
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

  // Dust/Scratch components
  //  - hFelt: effective height at the stylus contact line (lateral offset attenuated). wall=3 (bottom) pushes both walls equally.
  //  - amp: growth coefficient 0→1 upon appearance (prevents pops from instant appearance, completes well before stylus arrival).
  //  - top: plastic indentation envelope — minimum gap actually passed by the stylus bottom (updated by plasticCrush).
  //    Only the parts pressed by the stylus are crushed; particles jumped over or barely grazed remain intact.
  //  - Scratches: central gouge (negative) + leading/trailing plastic burrs (positive). Can cause contact loss or lift-off.
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

  // Plastic crushing (called every physics substep):
  //   Stylus sphere bottom height ballH(s) = dz²/(2·rScan) − base − wall displacement (excluding dust).
  //   Where dust exceeds ballH + yield depth (yld, type-dependent), it yields, and the envelope top
  //   is clipped to that level. Residual limit res·(local height) = compaction limit (grit barely crushes).
  //   base = rSide − (stylus wall distance). wall=3 (bottom) is crushed by contact with either wall.
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
        const cur = D.top && D.top[k] < g ? D.top[k] : g; // Current effective height
        if (cur <= 0) continue;
        const dz = sk - sTip;
        const ballH = (dz * dz) / (2 * rScan) - base
          - this.signalShift(wall, sk) - this.roughShift(wall, sk, true);
        // Contact detection is independent of plastic deformation: hard particles (grit) are "touched" even if not crushed
        if (cur > ballH) D.touched = true;
        const allowed = Math.max(ballH + D.yld, D.res * g);
        if (allowed < cur) {
          if (!D.top) D.top = new Float32Array(TOP_N).fill(Infinity);
          D.top[k] = allowed;
        }
      }
    }
  }

  // Dust crush fraction 0(intact)–1(fully compressed) — for rendering (calculated from residual height ratio at center)
  dustCrushFrac(D) {
    if (!D.top || !(D.amp > 0) || !(D.hFelt > 0)) return 0;
    const h = D.hFelt * D.amp;
    const cap = D.top[(TOP_N - 1) >> 1];
    if (!(cap < h)) return 0;
    return Math.min(1, (1 - cap / h) / (1 - D.res));
  }

  // Total wall displacement [m] (normal direction, positive = protrusion toward stylus)
  // For physics (contact): uses patch-averaged roughness
  wallShift(wall, s) {
    return this.signalShift(wall, s) + this.roughShift(wall, s, true) + this.dustShift(wall, s);
  }

  // For rendering: only actual (visible) roughness + scratches.
  // Dust is rendered as independent particles by the renderer, not as groove deformation (groove mesh remains original).
  wallShiftVisual(wall, s) {
    return this.signalShift(wall, s) + this.roughShift(wall, s, false) + this.dustShift(wall, s, true);
  }

  // Input reference velocity (for measurement, L/R channels)
  refVelocity(s) {
    const n = Math.round(s / this.dzSig) & (SIG_LEN - 1);
    return { vL: this.refVelL[n], vR: this.refVelR[n] };
  }

  // Dust generation/crushing process: stylus position sStylus, elapsed record time dt
  // rateScale: normally 1. Can be explicitly accelerated for Poisson occurrence rate during verification.
  advanceDust(sStylus, dt, grooveVel, rateScale = 1) {
    const p = this.p;
    // Appearance distance: approx 2.5s ahead. Lower limit 16µm ensures it's outside the contact scan window (±6.4µm).
    const ahead = Math.min(400e-6, Math.max(16e-6, grooveVel * 2.5 / rateScale));
    // ampRate: growth completes in ~25% of the time until stylus arrival (always full height upon arrival) [1/s record time]
    if (p.dustRate > 0 && this.dustRng() < p.dustRate * dt * rateScale) {
      const r = this.dustRng;
      const D = { s: sStylus + ahead * (0.5 + r()), amp: 0, crushed: false };
      D.ampRate = grooveVel / (0.25 * (D.s - sStylus));
      // Type and size (log-normal: mostly small particles, rarely large ones)
      const kr = r();
      if (kr < 0.55) {
        D.kind = 'flake';
        D.h = Math.min(12e-6, Math.max(0.3e-6, 1.5e-6 * Math.exp(0.8 * this.gaussD())));
        D.w = D.h * (0.7 + 1.6 * r());
      } else if (kr < 0.85) {
        D.kind = 'fiber';
        D.h = (1 + 2 * r()) * 1e-6;              // Fiber diameter
        const L = (10 + 30 * r()) * 1e-6;        // Fiber length
        const phi = r() * Math.PI / 2;           // Lean angle relative to groove direction
        D.w = Math.max(D.h, 0.5 * L * Math.cos(phi));
        D.latHalf = Math.max(D.h, L * Math.sin(phi)) / 2;
      } else {
        D.kind = 'grit';
        D.h = Math.min(6e-6, Math.max(0.5e-6, 2e-6 * Math.exp(0.6 * this.gaussD())));
        D.w = D.h * (0.8 + 0.6 * r());
      }
      D.yld = DUST_KIND[D.kind].yld;
      D.res = DUST_KIND[D.kind].res;
      // Landing position: ~40% on land (outside stylus path). Inside groove: adhere to wall or fall to V-bottom.
      const pr = r();
      if (pr < 0.4) {
        D.loc = 'land';
        D.wall = r() < 0.5 ? 0 : 1;
        D.landX = (2 + 30 * r()) * 1e-6;         // Distance from groove edge
        D.hFelt = 0;
      } else if (D.kind === 'fiber' || r() < Math.exp(-D.h / 4e-6)) {
        // Wall adhesion: effective height is attenuated by the lateral offset from the stylus contact line (t≈rSide) (edge grazing)
        D.loc = 'wall';
        D.wall = r() < 0.5 ? 0 : 1;
        D.t = (3 + 39 * r()) * 1e-6;             // Distance on wall (from bottom fillet to land edge)
        const lam = (D.latHalf ?? 0.5 * D.h) + PATCH_T;
        const dLat = (D.t - p.rSide) / lam;
        D.hFelt = D.h * Math.exp(-dLat * dLat);
      } else {
        // Resting at groove bottom (vertex height = (√2+1)·h/2 for 90°V).
        // Only large particles exceeding the stylus tip bottom clearance (≈(√2−1)·rSide) push both walls simultaneously (monaural "thump").
        D.loc = 'bottom';
        D.wall = 3;
        const top = (Math.SQRT2 + 1) * 0.5 * D.h;
        D.hFelt = Math.SQRT1_2 * Math.max(0, top - (Math.SQRT2 - 1) * p.rSide);
      }
      this.dust.push(D);
    }
    // Scratches: transverse scratches are not simple obstacles, but a combination of a carved valley
    // and plastic burrs pushed out before and after it. Burrs lift the stylus, while gouges cause contact loss or channel dropouts.
    if (p.scratchRate > 0 && this.dustRng() < p.scratchRate * dt * rateScale) {
      const r = this.dustRng;
      const sAhead = ahead * (0.5 + r());
      const q = r();
      let scratchKind, gouge, burr, width, wallR;
      if (q < 0.28) {
        scratchKind = 'hairline';     // Shallow scratch. Mostly visual, but produces a "tick" when entering contact zone
        gouge = (0.2 + 1.3 * r()) * 1e-6;
        burr = (0.1 + 0.9 * r()) * 1e-6;
        width = (18 + 55 * r()) * 1e-6;
        wallR = 0.65 + 0.30 * r();
      } else if (q < 0.63) {
        scratchKind = 'plough';       // Combined gouge and edge burr
        gouge = (4 + 10 * r()) * 1e-6;
        burr = (6 + 14 * r()) * 1e-6;
        width = (10 + 28 * r()) * 1e-6;
        wallR = 0.35 + 0.55 * r();
      } else if (q < 0.80) {
        scratchKind = 'burr';         // Dominant extrusion/peeling. Prone to causing skips
        gouge = (1 + 5 * r()) * 1e-6;
        burr = (12 + 18 * r()) * 1e-6;
        width = (8 + 24 * r()) * 1e-6;
        wallR = 0.25 + 0.55 * r();
      } else if (q < 0.95) {
        scratchKind = 'cut';          // Dominant loss of material. Main effect is contact loss and "scratchy" distortion
        gouge = (8 + 14 * r()) * 1e-6;
        burr = (1 + 6 * r()) * 1e-6;
        width = (10 + 34 * r()) * 1e-6;
        wallR = 0.30 + 0.55 * r();
      } else {
        scratchKind = 'chip';         // Deep chip near one wall. Rare, but causes strong mistracking
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
        gouge,                         // depth of central gouge
        burr,                          // height of edge burr
        h: Math.max(gouge, burr),       // representative height for rendering/lifetime management
        w: width,
        lipOffset: 0.75 + 0.55 * r(),   // distance from central gouge to burr peak (in w units)
        lipW: 0.22 + 0.28 * r(),        // burr sharpness
        gougeW: 0.70 + 0.45 * r(),      // gouge valley width
        lipLead,
        lipTrail,
        wallL,
        wallR,
        skew: (r() - 0.5) * width * 1.4, // diagonal scratch: passing timing differs slightly between L/R walls
        asym: wallR,                     // for legacy data compatibility
        amp: 0,
        ampRate: grooveVel / (0.25 * sAhead),
        crushed: false,
        scratch: true,
      });
    }
    for (let k = this.dust.length - 1; k >= 0; k--) {
      const D = this.dust[k];
      if (D.dying) {
        // Removal due to count limit: shrink at the same rate as growth, then remove from array
        D.amp -= dt * D.ampRate;
        if (D.amp <= 0) this.dust.splice(k, 1);
        continue;
      }
      if (D.amp < 1) D.amp = Math.min(1, D.amp + dt * D.ampRate);
      if (!D.scratch && !D.crushed && sStylus > D.s + 2 * D.w) {
        D.crushed = true;
        if (D.touched) {
          this.dustHits++;                       // count only particles actually touched by the stylus
          if (D.kind === 'grit') D.dying = true; // hard mineral particles are kicked away
        }
      }
    }
    // Immediately discard dust far behind (outside view). Fade out oldest if count limit exceeded.
    while (this.dust.length && this.dust[0].s < sStylus - 5e-3) this.dust.shift();
    for (let k = 0; k < this.dust.length - 128; k++) this.dust[k].dying = true;
    while (this.dust.length > 176) this.dust.shift();
    // Dust cache near the stylus (to avoid full scan during physics substep plastic crushing).
    // Only particles that can reach the stylus (hFelt>0) — land dust or small bottom dust are excluded.
    this.activeDust.length = 0;
    for (const D of this.dust) {
      if (!D.scratch && D.hFelt > 1e-9 && Math.abs(D.s - sStylus) < 4 * D.w + 16e-6) {
        this.activeDust.push(D);
      }
    }
  }
}

// Wall normal and tangent vectors (within cross-section)
export const N_L = { x: Math.SQRT1_2, y: Math.SQRT1_2 };
export const N_R = { x: -Math.SQRT1_2, y: Math.SQRT1_2 };
export const U_L = { x: Math.SQRT1_2, y: Math.SQRT1_2 };   // Lチャンネル変調方向
export const U_R = { x: Math.SQRT1_2, y: -Math.SQRT1_2 };  // Rチャンネル変調方向
