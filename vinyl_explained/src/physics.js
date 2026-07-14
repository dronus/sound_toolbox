// ============================================================================
// physics.js — Stylus, Cantilever, and Arm Dynamics (SI units, Semi-implicit Euler)
//
// Model:
//  - Effective tip mass m (2 DOF: x, y) — motion within the groove cross-section.
//  - Cantilever: spring k=1/compliance + damper (between tip and arm).
//  - Effective arm mass M (low-frequency resonance ~10Hz emerges naturally), tracking force Ft applied to arm.
//  - Groove wall contact: Winkler elastic foundation (spring bed) model.
//      F = k_f·∫max(0, δ(z))dz,  k_f = (E*/√2)·√(R_eff/r_scan)
//    Static characteristics strictly match 3D Hertz F=(4/3)E*√R_eff·δ^1.5 for spherical profiles.
//    Micro-roughness within the contact patch is naturally averaged by integration — 
//    matching real physics where contact pressure (~0.4GPa) exceeds PVC yield stress (~80MPa), crushing micro-asperities.
//    Tracing loss and pinch effect emerge naturally from the parabolic sag of the stylus scanning radius (rScan).
//    Damping is a Kelvin-Voigt viscoelastic foundation: F = k_f·(I + τ·dI/dt), I=∫δ⁺dz.
//    τ corresponds to PVC viscoelastic loss (tanδ), resulting in ζ≈0.25 at contact resonance (~40kHz).
//  - Friction: calculated as a diagnostic value only (z-DOF is constrained).
//  - Static: added as an electrical pulse to the output signal rather than a mechanical vibration (physically accurate).
//
// Validated orders of magnitude: 2g VTF → wall normal force ≈14mN, contact pressure ≈0.4GPa,
//   contact resonance ≈40kHz, cantilever static deflection ≈0.3mm, arm resonance ≈12Hz.
// ============================================================================
import { CONST, hertzK, vtfNewton } from './params.js?v=20260706-sigma13-cache';
import { makeRng } from './dsp.js?v=20260706-sigma13-cache';
import { N_L, N_R, U_L, U_R } from './groove.js?v=20260706-sigma13-cache';

const NSCAN = 25; // 走査窓のサンプル数 (窓±6.4µm → 間隔~0.53µm)

export class StylusSim {
  constructor(params, groove, seed = 777) {
    this.p = params;
    this.groove = groove;
    this.dt = CONST.PHYS_DT;
    this.grooveVel = groove.dzSig * CONST.FS; // 溝線速度 [m/s]
    this.kH = hertzK(params); // 静的着座の計算用 (Winklerと静特性一致)
    // Winkler基礎の線剛性 [N/m²]: 球面でHertzと厳密一致するよう校正
    const rEff = params.stylusShape === 'spherical'
      ? params.rSide : Math.sqrt(params.rSide * params.rScan);
    this.kF = (CONST.PVC_ESTAR / Math.SQRT2) * Math.sqrt(rEff / params.rScan);
    this.Ft = vtfNewton(params);
    this.kC = 1 / params.compliance;
    this.cC = 2 * params.dampZeta * Math.sqrt(this.kC * params.tipMass);
    this.cArm = 0.5; // アーム微小粘性 (軸受+空気, 数値安定用) [N·s/m]

    // Scan window (sufficiently covers contact patch + signal-induced movement)
    this.scanHalf = 0.8 * params.rScan;
    this.scanPts = new Float64Array(NSCAN);
    for (let j = 0; j < NSCAN; j++) {
      this.scanPts[j] = (j / (NSCAN - 1) * 2 - 1) * this.scanHalf;
    }
    this.scanDz = this.scanPts[1] - this.scanPts[0]; // 積分刻み

    // Static electricity
    this.staticRng = makeRng(seed);
    this.pops = []; // {t0, amp}
    this.staticFlash = 0; // 描画通知用 (メインが読んで消費)
    this.staticCount = 0;
    // イベント率スケール: 通常は1。検証用にだけ発生率を明示加速できる。
    this.eventRateScale = 1;

    // Exponentially decaying statistics (τ=50ms record time, updated at 192kHz):
    //   sL/sR: ideal displacement (signal), nL/nR: tracking error, j: contact point temporal jitter
    const mkStat = () => ({ m: 0, v: 0 });
    this.stats = { sL: mkStat(), sR: mkStat(), nL: mkStat(), nR: mkStat(), j: mkStat() };
    this.statAlpha = (CONST.PHYS_SUBSTEPS * CONST.PHYS_DT) / 0.05;
    this.zcL = 0; this.zcR = 0;

    // Counters and diagnostics
    this.mistrackCount = 0;
    this.skipCount = 0;
    this.contactLossT = 0;
    this.inLossEpisode = false;
    this.skipHoldoff = 0; // 針飛び直後の再カウント抑止 [s] (1つの傷=1イベント)
    this.diag = { FL: 0, FR: 0, dL: 0, dR: 0, pressL: 0, pressR: 0, fric: 0 };

    // Output (192kHz sample) callback: (vLp, vRp, s, t)
    this.onOutput = null;
    this.subCount = 0;
    this.outAccumL = 0;
    this.outAccumR = 0;
    this.outAccumN = 0;

    this.s = 0;      // 溝パターン座標 [m]
    this.t = 0;      // レコード時間 [s]
    this.reseat();
    this.dPrevL = 0; this.dPrevR = 0;     // 診断用 δ0
    this.iPrevL = null; this.iPrevR = null; // Kelvin-Voigt用 ∫δ⁺
  }

  // Seat the stylus in the groove at static equilibrium
  reseat() {
    const p = this.p;
    const N = this.Ft / Math.SQRT2;              // 各壁の法線力
    const d0 = Math.pow(N / this.kH, 2 / 3);     // 静的めり込み
    this.x = 0;
    this.y = Math.SQRT2 * (p.rSide - d0);
    this.vx = 0; this.vy = 0;
    this.xa = 0;
    this.ya = this.y - this.Ft / this.kC;        // ばね予圧 (たわみ ≈0.3mm)
    this.vxa = 0; this.vya = 0;
    this.restY = this.y;
  }

  // Contact calculation for one wall (Winkler elastic foundation):
  //   δ(dz) = wall displacement(s+dz) − dz²/(2·rScan) + (rSide − D)
  //   integ = ∫max(0,δ)ddz (trapezoidal approximation), delta0 = max δ (for diagnostics/detection)
  //   zc = centroid offset of pressure distribution [m] — source of reading point temporal jitter
  wallContact(wall, D) {
    const g = this.groove, s = this.s, r2 = 2 * this.p.rScan;
    const base = this.p.rSide - D;
    let raw = 0, delta0 = -Infinity, zsum = 0;
    for (let j = 0; j < NSCAN; j++) {
      const dz = this.scanPts[j];
      let d = base + g.wallShift(wall, s + dz) - (dz * dz) / r2;
      if (d > delta0) delta0 = d;
      if (d > 0) {
        if (d > 5e-6) d = 5e-6; // 深埋没クランプ (埃衝突時の数値安全)
        raw += d;
        zsum += d * dz;
      }
    }
    return { integ: raw * this.scanDz, delta0, zc: raw > 0 ? zsum / raw : 0 };
  }

  // Advance n physics steps
  step(nSteps) {
    const { dt, kF, p } = this;
    const m = p.tipMass, M = p.armMass;
    const tau = p.kvTau;
    const g = this.groove;

    for (let i = 0; i < nSteps; i++) {
      // Advance the groove (ensure generation including look-ahead)
      this.s += this.grooveVel * dt;
      this.t += dt;
      if ((i & 63) === 0) g.ensure(this.s + this.scanHalf + g.spawnAhead * 2 + 4 * g.dzSig);

      // --- Contact force (Winkler elastic foundation) ---
      const DL = this.x * N_L.x + this.y * N_L.y;  // 左壁面(無変調)までの距離
      const DR = this.x * N_R.x + this.y * N_R.y;
      // Plastic crushing of dust: permanently deform dust where and how deep the stylus bottom actually presses
      if (g.activeDust.length) {
        g.plasticCrush(0, this.s, p.rSide - DL, p.rScan, this.scanHalf);
        g.plasticCrush(1, this.s, p.rSide - DR, p.rScan, this.scanHalf);
      }
      const cL = this.wallContact(0, DL);
      const cR = this.wallContact(1, DR);
      const dL = cL.delta0, dR = cR.delta0;
      this.dPrevL = dL; this.dPrevR = dR;
      this.zcL = cL.zc; this.zcR = cR.zc;

      // Kelvin-Voigt: F = k_f·(I + τ·İ), F ≥ 0 (no tension transmitted)
      if (this.iPrevL === null) { this.iPrevL = cL.integ; this.iPrevR = cR.integ; }
      const iLdot = (cL.integ - this.iPrevL) / dt;
      const iRdot = (cR.integ - this.iPrevR) / dt;
      this.iPrevL = cL.integ; this.iPrevR = cR.integ;
      let FL = kF * (cL.integ + tau * iLdot);
      let FR = kF * (cR.integ + tau * iRdot);
      if (FL < 0 || cL.integ <= 0) FL = 0;
      if (FR < 0 || cR.integ <= 0) FR = 0;

      // --- Cantilever spring + damper ---
      const Fsx = this.kC * (this.xa - this.x) + this.cC * (this.vxa - this.vx);
      const Fsy = this.kC * (this.ya - this.y) + this.cC * (this.vya - this.vy);

      // --- Tip motion (semi-implicit Euler) ---
      const Fx = FL * N_L.x + FR * N_R.x + Fsx;
      const Fy = FL * N_L.y + FR * N_R.y + Fsy;
      this.vx += (Fx / m) * dt;
      this.vy += (Fy / m) * dt;
      this.x += this.vx * dt;
      this.y += this.vy * dt;

      // --- Arm motion (reaction force + tracking force) ---
      this.vxa += ((-Fsx - this.cArm * this.vxa) / M) * dt;
      this.vya += ((-Fsy - this.Ft - this.cArm * this.vya) / M) * dt;
      this.xa += this.vxa * dt;
      this.ya += this.vya * dt;

      // --- Mistracking/Skip detection ---
      // Mistrack = contact with either wall is lost for >30µs (condition for audible distortion)
      const anyLoss = dL <= 0 || dR <= 0;
      if (anyLoss) {
        this.contactLossT += dt;
        if (!this.inLossEpisode && this.contactLossT > 30e-6) {
          this.inLossEpisode = true;
          this.mistrackCount++;
        }
      } else {
        this.contactLossT = 0;
        this.inLossEpisode = false;
      }
      // Skip = stylus tip bottom exceeds record surface (land) by >6µm (jump/pop) or lateral deviation
      if (this.skipHoldoff > 0) this.skipHoldoff -= dt;
      if (this.y - p.rSide > CONST.GROOVE_DEPTH + 6e-6 ||
          Math.abs(this.x) > CONST.GROOVE_HALF_WIDTH * 2) {
        if (this.skipHoldoff <= 0) {
          this.skipCount++;
          this.skipHoldoff = 1.5e-3;
        }
        this.reseat();
      }

      this.diag.FL = FL; this.diag.FR = FR;
      this.diag.dL = dL; this.diag.dR = dR;

      // --- Static pulse (electrical event, Poisson) ---
      if (p.staticRate > 0 && this.staticRng() < p.staticRate * dt * this.eventRateScale) {
        this.pops.push({ t0: this.t, amp: (0.5 + 2.5 * this.staticRng()) * CONST.V_REF * (this.staticRng() < 0.5 ? -1 : 1) });
        this.staticFlash = 1;
        this.staticCount++;
        if (this.pops.length > 16) this.pops.shift();
      }

      // Simple anti-aliasing for output sampling:
      // Physics runs at 3.84MHz; high-order harmonics from non-linear contact
      // would alias into the audible band if decimated directly to 192kHz.
      // Average over one sample interval before outputting.
      if (this.onOutput) {
        // Cartridge generates voltage proportional to velocity: decode tip velocity via 45/45
        let vLp = this.vx * U_L.x + this.vy * U_L.y;
        let vRp = this.vx * U_R.x + this.vy * U_R.y;
        // Static pop (electrical pulse, τ=0.4ms decay)
        for (let k = this.pops.length - 1; k >= 0; k--) {
          const P = this.pops[k];
          const dtp = this.t - P.t0;
          if (dtp > 0.005) { this.pops.splice(k, 1); continue; }
          const e = P.amp * Math.exp(-dtp / 0.4e-3);
          vLp += e; vRp += e;
        }
        this.outAccumL += vLp;
        this.outAccumR += vRp;
        this.outAccumN++;
      }

      // --- Output sampling (192kHz) ---
      if (++this.subCount >= CONST.PHYS_SUBSTEPS) {
        this.subCount = 0;

        // Exponentially decaying statistics: S=ideal displacement, N=tracking error (real−ideal), J=reading point temporal jitter
        {
          const st = this.stats, al = this.statAlpha;
          const shL = g.signalShift(0, this.s), shR = g.signalShift(1, this.s);
          const ix = shL * N_L.x + shR * N_R.x;
          const iy = this.restY + shL * N_L.y + shR * N_R.y;
          const ex = this.x - ix, ey = this.y - iy;
          const upd = (o, x) => {
            const d = x - o.m;
            o.m += al * d;
            o.v += al * (d * d - o.v);
          };
          upd(st.sL, shL); upd(st.sR, shR);
          upd(st.nL, ex * U_L.x + ey * U_L.y);
          upd(st.nR, ex * U_R.x + ey * U_R.y);
          upd(st.j, 0.5 * (this.zcL + this.zcR) / this.grooveVel);
        }
        if (this.onOutput) {
          const nOut = Math.max(1, this.outAccumN);
          this.onOutput(this.outAccumL / nOut, this.outAccumR / nOut, this.s, this.t);
          this.outAccumL = 0;
          this.outAccumR = 0;
          this.outAccumN = 0;
        }
        g.advanceDust(this.s, CONST.PHYS_SUBSTEPS * dt, this.grooveVel, this.eventRateScale);
      }
    }

    // Diagnostic values (for HUD): contact pressure p_mean = F/(πa²), a=√(R·δ)
    const d = this.diag;
    d.pressL = d.dL > 0 ? d.FL / (Math.PI * this.p.rSide * d.dL) : 0;
    d.pressR = d.dR > 0 ? d.FR / (Math.PI * this.p.rSide * d.dR) : 0;
    d.fric = this.p.mu * (d.FL + d.FR);
  }
}
