// ============================================================================
// params.js — Physical constants and default parameters (all SI units: m, s, kg, N)
// Major physical constants and default values.
// ============================================================================

export const CONST = {
  // --- Reference level ---
  V_REF: 0.05,              // Reference velocity 5 cm/s (1kHz 0dB: mono lateral RMS=5cm/s, 45/45 wall direction peak=5cm/s)
  RULER_FULL_SCALE_DISP: 15e-6, // 0dBFS equivalent for ruler: typical LP album wall peak ±15 µm
  CUT_DISP_LIMIT: 25e-6,    // Hard limit ±25 µm (mono lateral peak ~35 µm, extreme low-frequency large amplitude)

  // --- Record disc geometry ---
  R_OUTER: 0.146,           // LP outermost groove radius 146 mm
  R_INNER: 0.060,           // LP innermost groove radius 60 mm

  // --- Groove geometry (standard stereo microgroove) ---
  GROOVE_HALF_WIDTH: 30e-6, // Groove top half-width 30 µm (total width ~60 µm)
  GROOVE_DEPTH: 30e-6,      // 90° V-shape: depth = half-width
  GROOVE_BOTTOM_R: 4e-6,    // Groove bottom fillet radius ~4 µm
  GROOVE_PITCH: 100e-6,     // Adjacent groove pitch ~100 µm (~10 grooves/mm)

  // --- Vinyl material (PVC/PVAc copolymer) ---
  PVC_E: 3.0e9,             // Young's modulus ~3 GPa
  PVC_NU: 0.4,              // Poisson's ratio
  // Diamond stylus approximated as rigid → E* = E/(1-ν²)
  MOLECULE_R: 0.55e-9,      // PVC chain local scale reference radius ~0.55 nm (for visualization. Not random coil diameter)

  // --- RIAA time constants ---
  RIAA_T1: 3180e-6,         // 3180 µs (50.05 Hz)
  RIAA_T2: 318e-6,          // 318 µs  (500.5 Hz)
  RIAA_T3: 75e-6,           // 75 µs   (2122 Hz)
  RIAA_T4: 3.18e-6,         // Neumann HF pole ~50 kHz (actual pole in cutting amps)

  // --- Sampling ---
  FS: 192000,               // Recorded signal sample rate [Hz] (record time axis)
  PHYS_SUBSTEPS: 20,        // Physics dt = 1/(FS*PHYS_SUBSTEPS) = 0.2604 µs
  ROUGH_DZ: 50e-9,          // Spatial sampling of roughness ring 50 nm
};

export const ZOOM_MIN = 0.005;
export const ZOOM_MAX = 1e7;
export const SLOWDOWN_MIN = 1e2;
export const SLOWDOWN_MAX = 1e6;

CONST.PHYS_DT = 1 / (CONST.FS * CONST.PHYS_SUBSTEPS);
CONST.PVC_ESTAR = CONST.PVC_E / (1 - CONST.PVC_NU * CONST.PVC_NU); // ≈3.57 GPa

// ---------------------------------------------------------------------------
// Default values for user-adjustable parameters
// ---------------------------------------------------------------------------
export function defaultParams() {
  return {
    // --- Signal ---
    signalType: 'pink',     // 'pink' | 'sine' | 'silence'
    sineFreq: 1000,         // [Hz] for sine
    levelDb: 12,            // Recording peak level [dB re 5cm/s peak]. Music peaks on LP albums are typically +10 to +12dB
    hfCutoff: 16000,        // Mastering HF cutoff [Hz]
    monoBelow: 250,         // Below this frequency is mostly mono [Hz] (equivalent to elliptic EQ)
    sideMix: 0.7,           // Amount of Side component (0=fully mono)

    // --- Record ---
    rpm: 100 / 3,           // 33⅓ rpm
    radiusMm: 120,          // Current groove radius [mm] (outer 146 ↔ inner 60)
    // Wall roughness RMS [m] — stamper precision/molecular placement error.
    // Calibrated to yield SNR=60.0dB (9.7bit) —
    // Combined with default peak level +12dB, DR=72dB (fits within the upper range of measured records).
    // Also consistent with AFM-measured vinyl groove roughness (several nm to tens of nm).
    roughSigma: 13.17e-9,
    dustRate: 2.0,          // Dust deposition rate [particles/s]. Typical for a listenable used record.
                            // Encounters with stylus emerge from position × particle size
    staticRate: 0.08,       // Static pulse rate [times/s]. A few times per tens of seconds in dry environments
    scratchRate: 0,         // Scratch encounter rate [times/s]. Default for normal records is none

    // --- Stylus / Cartridge ---
    stylusShape: 'elliptical', // 'spherical' | 'elliptical'
    rSide: 18e-6,           // Contact (side) radius [m] (spherical:15µm, elliptical:18µm)
    rScan: 8e-6,            // Scanning (travel direction) radius [m] (spherical: =rSide)
    vtfGram: 2.0,           // Tracking force [g]
    tipMass: 0.4e-6,        // Effective tip mass [kg] (0.4 mg)
    compliance: 15e-3,      // Compliance [m/N] (=15×10⁻⁶ cm/dyne)
    dampZeta: 0.25,         // Cantilever damper damping ratio
    armMass: 0.012,         // Tonearm effective mass [kg]
    kvTau: 2e-6,            // Kelvin-Voigt contact damping time constant [s] (PVC viscoelastic loss)
    mu: 0.3,                // Dynamic friction coefficient (for diagnostic display)

    // --- Display ---
    lang: 'en',             // UI language; main.js overrides this from storage/browser/hash
    zoom: 30,               // Magnification (0.005=600mm view .. 1e7=0.3nm view)
    slowdown: 3000,         // Real-time slowdown ratio
    showRulerL: false,
    showRulerR: false,
    rulerBits: 12,          // Bit ruler
    rulerAuto: true,        // Auto-follow noise equivalent bits
    fullScaleDisp: CONST.RULER_FULL_SCALE_DISP, // Full-scale wall displacement for digital conversion [m] (±15µm)
    showMolecules: true,
    showContactMarkers: false, // Contact point markers for left/right walls
    showLabels: true,        // Part labels based on zoom level
    showGhost: false,       // Ideal-tracking ghost stylus (offset=tracking error visualization)
    stylusTransparency: 0,   // Stylus transparency [%] (0=opaque, 100=fully transparent)
    showTimeScale: true,    // Travel direction ruler (stylus position reference)
    timeScaleMode: 'length', // 'time' | 'length'
  };
}

// Groove linear velocity [m/s]
export function grooveSpeed(p) {
  return 2 * Math.PI * (p.radiusMm * 1e-3) * (p.rpm / 60);
}

// Hertz contact stiffness coefficient k_h : F = k_h · δ^1.5
export function hertzK(p) {
  const rEff = p.stylusShape === 'spherical'
    ? p.rSide
    : Math.sqrt(p.rSide * p.rScan);   // Equivalent radius for elliptical contact (geometric mean approximation)
  return (4 / 3) * CONST.PVC_ESTAR * Math.sqrt(rEff);
}

// Tracking force [N]
export function vtfNewton(p) { return p.vtfGram * 1e-3 * 9.80665; }

// Quantization conversion: roughness σ → equivalent bit count (for q where q/√12 = σ)
export function sigmaToBits(sigma, fullScale) {
  const q = sigma * Math.sqrt(12);
  return Math.log2((2 * fullScale) / q);
}
export function snrToBits(snrDb) { return (snrDb - 1.76) / 6.02; }
