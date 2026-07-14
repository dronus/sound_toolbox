// ============================================================================
// render3d.js — 3D Rendering via Three.js
//
// World coordinates: 1 unit = 1µm. Origin = groove bottom vertex when unmodulated (stylus position).
// y-up, x-lateral, z: back (-z) = unplayed → front (+z) = played.
// The groove scrolls from back to front.
// Correspondence with pattern coordinate s: worldZ = (sStylus − s)·1e6
//
// Groove mesh is rebuilt every frame from wallShiftVisual(), same as physics.
// Uses a non-uniform grid (dense at center, geometric progression outwards)
// to prevent artifacts even at ultra-high magnification.
// ============================================================================
import * as THREE from '../lib/three.module.js';
import { CONST, ZOOM_MIN, ZOOM_MAX, hertzK, vtfNewton } from './params.js?v=20260706-sigma13-cache';
import { N_L, N_R, U_L, U_R } from './groove.js?v=20260706-sigma13-cache';
import { textFor } from './i18n.js?v=20260706-sigma13-cache';

const M2W = 1e6; // meters → world(µm)
const UP = new THREE.Vector3(0, 1, 0);

// Groove cross-section profile (implemented as grooveProfile in vertex shader): y(x) [µm]
// Left wall: y = √2·wL − x, Right wall: y = √2·wR + x, bottom is a smooth arc, top has edge rounding.
// min-composition with opposite walls of adjacent grooves correctly renders openings
// that cut into the ridge during large displacements.
const LAND_Y = CONST.GROOVE_DEPTH * M2W;      // 30 µm
const K_BOTTOM = 2 * CONST.GROOVE_BOTTOM_R * M2W; // Bottom fillet
const K_EDGE = 1.5;                            // Edge rounding [µm]
const PITCH_W = CONST.GROOVE_PITCH * M2W;      // Adjacent groove pitch 100 µm
const GROOVE_COLOR = 0x3c4046;
const CONTACT_HISTORY_N = 6;                   // Current contact + recovery history. Fixed length to reduce GPU load
const CONTACT_RECOVERY_TAU = 25e-6;            // PVC壁の見かけ回復時定数 [s] (描画のみ)
const CONTACT_HISTORY_MAX_AGE = CONTACT_RECOVERY_TAU * 6;
const CONTACT_HISTORY_MIN_UM = 0.015;
const CONTACT_HISTORY_SPACING_UM = 0.5;
const CONTACT_HISTORY_DT = 3e-6;
const MOLECULE_R_UM = CONST.MOLECULE_R * M2W;
const MOLECULE_INDICATOR_VIEW_HALF = 0.24;     // Show PVC molecule actual size scale when view width < 480nm
const MOLECULE_STRUCTURE_MIN_ZOOM = 1e5;        // Show PVC chain atomic structure at 100k magnification or higher
const MOLECULE_LAYOUT_LOCK_ZOOM = 1e5;          // Above this, fix screen ratio for molecule labels/layout
const MOLECULE_LAYOUT_LOCK_VIEW_HALF = 1500 / MOLECULE_LAYOUT_LOCK_ZOOM;
const RULER_AXIS_EDGE_ON_DOT = Math.cos(20 * Math.PI / 180);
const ERROR_LR_MIN_ZOOM = 100;
const ERROR_T_MIN_ZOOM = 100;
const PART_LABEL_COLOR = '#f2efe2';
const RECORD_CONTEXT_MAX_ZOOM = 0.1;          // 0.1倍未満ではLP盤を実寸表示
const RECORD_DISC_R_UM = 150e3;               // 12インチLP外径 約300mm
const RECORD_LABEL_R_UM = 50e3;
const RECORD_HOLE_R_UM = 3.65e3;              // センターホール直径 約7.3mm
const RECORD_INNER_GROOVE_R_UM = CONST.R_INNER * M2W;
const RECORD_OUTER_GROOVE_R_UM = CONST.R_OUTER * M2W;
const RECORD_PLANE_Y = LAND_Y - 18;
const RECORD_RING_SEGMENTS = 384;
const RECORD_GROOVE_LINE_COUNT = 96;
const RECORD_GROOVE_LINE_SEGMENTS = 192;
const rt = p => textFor(p.lang).renderer;
const NM_TO_UM = 1e-3;

const PVC_COVALENT_R_NM = { H: 0.031, C: 0.076, Cl: 0.102 };
const PVC_COLOR = { H: 0xf1efe6, C: 0x59616b, Cl: 0x62c66f };
const PVC_CC_NM = 0.154;                       // sp3 C-C single bond
const PVC_CH_NM = 0.109;                       // C-H single bond
const PVC_CCL_NM = 0.178;                      // Representative value for C-Cl single bond in PVC
const PVC_TETRA_ANGLE = 109.47 * Math.PI / 180;
const PVC_BACKBONE_ANGLE = 112 * Math.PI / 180;
const PVC_CHAIN_CARBONS = 10;

function norm3(v) {
  const l = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / l, y: v.y / l, z: v.z / l };
}

function buildPvcChainModel() {
  const halfTurn = (Math.PI - PVC_BACKBONE_ANGLE) * 0.5;
  const stepX = PVC_CC_NM * Math.cos(halfTurn);
  const stepY = PVC_CC_NM * Math.sin(halfTurn);
  const carbonAt = i => ({ x: i * stepX, y: i % 2 === 0 ? 0 : stepY, z: 0 });
  const carbonPos = Array.from({ length: PVC_CHAIN_CARBONS }, (_, i) => carbonAt(i));

  const atoms = [];
  const bonds = [];
  const addAtom = (id, element, p) => {
    atoms.push({ id, element, ...p, r: PVC_COVALENT_R_NM[element], color: PVC_COLOR[element] });
  };
  const addBond = (a, b) => bonds.push([a, b, 1]);

  for (let i = 0; i < carbonPos.length; i++) {
    addAtom(`c${i}`, 'C', carbonPos[i]);
    if (i > 0) addBond(`c${i - 1}`, `c${i}`);
  }

  const cosT = Math.cos(PVC_TETRA_ANGLE);
  for (let i = 0; i < carbonPos.length; i++) {
    const c = carbonPos[i];
    const prev = i > 0 ? carbonPos[i - 1] : carbonAt(i - 1);
    const next = i < carbonPos.length - 1 ? carbonPos[i + 1] : carbonAt(i + 1);
    const bPrev = norm3({ x: prev.x - c.x, y: prev.y - c.y, z: 0 });
    const bNext = norm3({ x: next.x - c.x, y: next.y - c.y, z: 0 });
    let side = norm3({ x: -(bPrev.x + bNext.x), y: -(bPrev.y + bNext.y), z: 0 });
    if (!Number.isFinite(side.x) || Math.hypot(side.x, side.y) < 1e-6) side = { x: 0, y: 1, z: 0 };
    const sideDot = side.x * bPrev.x + side.y * bPrev.y + side.z * bPrev.z;
    const a = Math.max(0, Math.min(0.95, cosT / sideDot));
    const z = Math.sqrt(Math.max(0, 1 - a * a));
    const subA = norm3({ x: side.x * a, y: side.y * a, z });
    const subB = norm3({ x: side.x * a, y: side.y * a, z: -z });
    const isChlorinated = i % 2 === 1;
    const attach = (suffix, element, len, dir) => {
      const id = `${element.toLowerCase()}${i}${suffix}`;
      addAtom(id, element, { x: c.x + dir.x * len, y: c.y + dir.y * len, z: c.z + dir.z * len });
      addBond(`c${i}`, id);
    };
    if (isChlorinated) {
      attach('Cl', 'Cl', PVC_CCL_NM, subA);
      attach('H', 'H', PVC_CH_NM, subB);
    } else {
      attach('Ha', 'H', PVC_CH_NM, subA);
      attach('Hb', 'H', PVC_CH_NM, subB);
    }
  }

  const bounds = atoms.reduce((b, atom) => ({
    minX: Math.min(b.minX, atom.x - atom.r), maxX: Math.max(b.maxX, atom.x + atom.r),
    minY: Math.min(b.minY, atom.y - atom.r), maxY: Math.max(b.maxY, atom.y + atom.r),
    minZ: Math.min(b.minZ, atom.z - atom.r), maxZ: Math.max(b.maxZ, atom.z + atom.r),
  }), { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity });
  const center = {
    x: (bounds.minX + bounds.maxX) * 0.5,
    y: (bounds.minY + bounds.maxY) * 0.5,
    z: (bounds.minZ + bounds.maxZ) * 0.5,
  };
  for (const atom of atoms) {
    atom.x -= center.x;
    atom.y -= center.y;
    atom.z -= center.z;
  }
  return { atoms, bonds };
}

const PVC_CHAIN_MODEL = buildPvcChainModel();
const PVC_CHAIN_ATOMS = PVC_CHAIN_MODEL.atoms;
const PVC_CHAIN_BONDS = PVC_CHAIN_MODEL.bonds;
const PVC_CHAIN_ATOM_BY_ID = new Map(PVC_CHAIN_ATOMS.map(a => [a.id, a]));

function dcContactUm(p) {
  const normalForce = vtfNewton(p) / Math.SQRT2;
  const d0 = Math.pow(normalForce / hertzK(p), 2 / 3);
  const t = (p.rSide - d0) * M2W;
  return {
    t: Math.min(Math.max(t, 0.5), Math.SQRT2 * LAND_Y),
    indent: d0 * M2W,
  };
}

function fmtTimeAbs(t) {
  if (t < 0.9995e-6) return (t * 1e9).toFixed(0) + ' ns';
  if (t < 0.9995e-3) return (t * 1e6).toFixed(0) + ' µs';
  if (t < 0.9995) return (t * 1e3).toFixed(t < 0.9995e-2 ? 1 : 0) + ' ms';
  return t.toFixed(1) + ' s';
}

function fmtZeroTime(referenceT) {
  if (referenceT < 0.9995e-6) return '0 ns';
  if (referenceT < 0.9995e-3) return '0 µs';
  if (referenceT < 0.9995) return '0 ms';
  return '0 s';
}

function fmtLenUm(um) {
  if (um < 0.9995e-3) return (um * 1e6).toFixed(0) + ' pm';
  if (um < 0.9995) return (um * 1e3).toFixed(0) + ' nm';
  if (um < 999.5) return um.toFixed(um < 9.995 ? 1 : 0) + ' µm';
  return (um / 1000).toFixed(um < 9995 ? 2 : 1) + ' mm';
}

function fmtZeroLenUm(referenceUm) {
  if (referenceUm < 0.9995e-3) return '0 pm';
  if (referenceUm < 0.9995) return '0 nm';
  if (referenceUm < 999.5) return '0 µm';
  return '0 mm';
}

function fmtSignedTime(t, zeroReferenceT = 1) {
  if (Math.abs(t) < 0.5e-12) return fmtZeroTime(Math.abs(zeroReferenceT));
  return (t < 0 ? '-' : '+') + fmtTimeAbs(Math.abs(t));
}

function fmtSignedLenUm(um, zeroReferenceUm = 1) {
  if (Math.abs(um) < 0.5e-9) return fmtZeroLenUm(Math.abs(zeroReferenceUm));
  return (um < 0 ? '-' : '+') + fmtLenUm(Math.abs(um));
}

function disposeSprite(sp) {
  if (!sp) return;
  if (sp.material?.map) sp.material.map.dispose();
  if (sp.material) sp.material.dispose();
}

function makeTextSprite(text, color = '#c3c2b7', background = true) {
  const lines = String(text).split('\n');
  const font = '600 26px system-ui, sans-serif';
  const lineH = 30;
  const padX = 16, padY = 10;
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  ctx.font = font;
  const w = Math.ceil(Math.max(...lines.map(line => ctx.measureText(line).width))) + padX;
  const h = lineH * lines.length + padY;
  c.width = w; c.height = h;
  const ctx2 = c.getContext('2d');
  ctx2.font = font;
  if (background) {
    ctx2.fillStyle = 'rgba(13,13,13,0.72)';
    ctx2.fillRect(0, 0, w, h);
  }
  ctx2.fillStyle = color;
  ctx2.textBaseline = 'middle';
  for (let i = 0; i < lines.length; i++) {
    ctx2.fillText(lines[i], 8, padY * 0.5 + lineH * (i + 0.5));
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  sp.userData.aspect = w / h;
  sp.userData.heightRatio = h / 40;
  sp.userData.text = text;
  return sp;
}

function makeBeveledBoxGeometry(w, h, d, bevel) {
  const x = w / 2, y = h / 2;
  const shape = new THREE.Shape()
    .moveTo(-x, -y)
    .lineTo(x, -y)
    .lineTo(x, y)
    .lineTo(-x, y)
    .lineTo(-x, -y);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: d,
    steps: 1,
    bevelEnabled: true,
    bevelSize: bevel,
    bevelThickness: bevel,
    bevelSegments: 1,
  });
  geo.center();
  return geo;
}

function makeUnitCircleGeometry(segments = RECORD_RING_SEGMENTS) {
  const pos = new Float32Array(segments * 3);
  for (let i = 0; i < segments; i++) {
    const a = i / segments * Math.PI * 2;
    const o = i * 3;
    pos[o] = Math.cos(a);
    pos[o + 1] = 0;
    pos[o + 2] = Math.sin(a);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  return geo;
}

function makeRecordGrooveLineGeometry() {
  const pos = new Float32Array(RECORD_GROOVE_LINE_COUNT * RECORD_GROOVE_LINE_SEGMENTS * 2 * 3);
  let o = 0;
  for (let i = 0; i < RECORD_GROOVE_LINE_COUNT; i++) {
    const q = RECORD_GROOVE_LINE_COUNT <= 1 ? 0 : i / (RECORD_GROOVE_LINE_COUNT - 1);
    const r = RECORD_INNER_GROOVE_R_UM + (RECORD_OUTER_GROOVE_R_UM - RECORD_INNER_GROOVE_R_UM) * q;
    for (let j = 0; j < RECORD_GROOVE_LINE_SEGMENTS; j++) {
      const a0 = j / RECORD_GROOVE_LINE_SEGMENTS * Math.PI * 2;
      const a1 = (j + 1) / RECORD_GROOVE_LINE_SEGMENTS * Math.PI * 2;
      pos[o++] = Math.cos(a0) * r; pos[o++] = 0; pos[o++] = Math.sin(a0) * r;
      pos[o++] = Math.cos(a1) * r; pos[o++] = 0; pos[o++] = Math.sin(a1) * r;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  return geo;
}

function makeRecordLabelTitleTexture() {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 512;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = 'rgba(0,0,0,0.5)';
  ctx.shadowBlur = 12;
  ctx.shadowOffsetY = 5;
  ctx.fillStyle = '#f1ecd8';
  ctx.font = '800 116px Georgia, "Times New Roman", serif';
  ctx.fillText('Vinyl Explained', c.width * 0.5, c.height * 0.48);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

export class Renderer3D {
  constructor(canvas, params) {
    this.p = params;
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.2;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0d0d0d);
    // Dedicated ghost scene: by clearing depth and overlaying after the main scene,
    // Z-fighting/flickering with the real stylus is eliminated, ensuring it's always semi-transparent and on top.
    this.ghostScene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.01, 1e7);

    // Orbit camera state
    this.az = -0.35; this.el = 0.45;
    this.target = new THREE.Vector3(0, 10, 0);
    this._initOrbit(canvas);

    // Lights
    const hemi = new THREE.HemisphereLight(0x8899bb, 0x201a14, 0.9);
    const key = new THREE.DirectionalLight(0xfff2e0, 2.2);
    key.position.set(0.5, 1.4, 1.0);
    const fill = new THREE.DirectionalLight(0x99bbff, 0.7);
    fill.position.set(-1.2, 0.6, -0.6);
    this.scene.add(hemi, key, fill);
    this.keyLight = key;
    // Headlamp (follows camera, allows inspection of shadowed wall surfaces at high magnification)
    this.headLamp = new THREE.PointLight(0xffffff, 0.0, 0, 2);
    this.scene.add(this.headLamp);
    this._buildRecordDisk();

    // Groove mesh: GPU vertex shader displacement method.
    // Wall displacements are uploaded every frame to a float texture (range auto-adapted to view),
    // and deformation/normal calculations are performed on the GPU — CPU cost is only texture generation.
    // At maximum zoom, it achieves ultra-high resolution (effectively 0.0005nm steps in z).
    // The mesh consists of 3 columns: the main groove + adjacent ±1. Beyond that is a static baked far-field.
    this.mainGroove = this._makeGrooveShaderMesh(160, 1024, 2048, 0);
    // nbrOff: signal s offset of left/right adjacent grooves (relative to this mesh's sBase).
    // Supplies opposite wall shifts of adjacent grooves to texture z/w channels for min-composition.
    this.mainGroove.nbrOff = [0.5e-3, 0.5e-3];
    this.scene.add(this.mainGroove.mesh);
    this.neighborGrooves = [];
    for (const k of [-1, 1]) {
      const gm = this._makeGrooveShaderMesh(96, 512, 1024, 0.5e-3);
      gm.mesh.position.x = k * CONST.GROOVE_PITCH * M2W;
      // Neighbor on the main groove side is sBase−0.5mm (=main groove), outer side is pseudo +0.5mm ahead
      gm.nbrOff = k === -1 ? [0.5e-3, -0.5e-3] : [-0.5e-3, 0.5e-3];
      this.scene.add(gm.mesh);
      this.neighborGrooves.push(gm);
    }
    this.contactHistory = [[], []];
    this.partLabelSpecs = [];
    this.partLabelSprites = new Map();
    this._buildStylus();
    this._buildContactMarkers();
    this._buildMolecules();
    this._buildRulers();
    this._buildTimeRuler();
    this.dustMeshes = new Map();
    this.dustGeo = new THREE.IcosahedronGeometry(1, 1);
    this.dustMat = new THREE.MeshStandardMaterial({ color: 0xb9b3a4, roughness: 0.9 });
    this.dustCol = {
      flake: new THREE.Color(0xb9b3a4), // 皮膚片/紙粉 (黄褐)
      fiber: new THREE.Color(0xd8d3c6), // 衣類繊維 (淡)
      grit: new THREE.Color(0x8e929c),  // 鉱物粒 (青灰)
    };
    this.dustColCrushed = new THREE.Color(0x6b665c);
    this._dustN = new THREE.Vector3();
    this._rulerDir = new THREE.Vector3();
    this._moleculeRight = new THREE.Vector3();
    this._moleculeUp = new THREE.Vector3();
    this._moleculeAxisX = new THREE.Vector3();
    this._moleculeAxisY = new THREE.Vector3();
    this._moleculeAxisZ = new THREE.Vector3();
    this._moleculeMatrix = new THREE.Matrix4();
    this._errDir = new THREE.Vector3();

    this.viewHalf = 50; // [µm] 視野半幅 (updateで計算)
    this.viewWidth = this.viewHalf * 2;
    this.viewHeight = this.viewHalf * 2;
    this.viewExtentHalf = this.viewHalf;
    this.pxPerUm = 1;
    this._cssW = 0;
    this._cssH = 0;
    this._pixelRatio = 0;
  }

  setLanguage(lang) {
    this.p.lang = lang;
    if (this.moleculeLabel) {
      this.scene.remove(this.moleculeLabel);
      disposeSprite(this.moleculeLabel);
      this.moleculeLabel = makeTextSprite(rt(this.p).moleculeLabel, '#e6e1cf', false);
      this.moleculeLabel.material.depthWrite = false;
      this.moleculeLabel.renderOrder = 9;
      this.moleculeLabel.frustumCulled = false;
      this.moleculeLabel.visible = false;
      this.scene.add(this.moleculeLabel);
    }
    if (this.rulerLegend) {
      this.scene.remove(this.rulerLegend);
      disposeSprite(this.rulerLegend);
      this.rulerLegend = null;
    }
    this._buildPartLabels();
  }

  // ---------------- Camera controls ----------------
  _initOrbit(canvas) {
    const pointers = new Map();
    let orbitPointerId = null, px = 0, py = 0;
    let pinchDist0 = 0, pinchZoom0 = this.p.zoom;
    let gestureZoom0 = this.p.zoom;

    const setZoom = zoom => {
      const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom));
      if (next === this.p.zoom) return;
      this.p.zoom = next;
      if (this.onZoomChange) this.onZoomChange(this.p.zoom);
    };
    const firstPointers = () => Array.from(pointers.entries()).slice(0, 2);
    const resetPinch = () => {
      const pts = firstPointers().map(([, p]) => p);
      if (pts.length < 2) {
        pinchDist0 = 0;
        return;
      }
      pinchDist0 = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      pinchZoom0 = this.p.zoom;
    };
    const resetOrbit = () => {
      if (pointers.size !== 1) {
        orbitPointerId = null;
        return;
      }
      const [id, p] = pointers.entries().next().value;
      orbitPointerId = id;
      px = p.x;
      py = p.y;
    };

    canvas.addEventListener('pointerdown', e => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      canvas.setPointerCapture(e.pointerId);
      if (pointers.size === 1) resetOrbit();
      else {
        orbitPointerId = null;
        resetPinch();
      }
    });
    const endPointer = e => {
      if (!pointers.has(e.pointerId)) return;
      e.preventDefault();
      pointers.delete(e.pointerId);
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
      if (pointers.size >= 2) resetPinch();
      else resetOrbit();
    };
    canvas.addEventListener('pointerup', endPointer);
    canvas.addEventListener('pointercancel', endPointer);
    canvas.addEventListener('pointermove', e => {
      if (!pointers.has(e.pointerId)) return;
      e.preventDefault();
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size >= 2) {
        const pts = firstPointers().map(([, p]) => p);
        const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        if (pinchDist0 > 1 && dist > 1) setZoom(pinchZoom0 * dist / pinchDist0);
        return;
      }
      if (orbitPointerId !== e.pointerId) return;
      this.az -= (e.clientX - px) * 0.005;
      this.el += (e.clientY - py) * 0.005;
      this.el = Math.max(0.05, Math.min(1.45, this.el));
      px = e.clientX; py = e.clientY;
    });
    canvas.addEventListener('wheel', e => {
      e.preventDefault();
      let dy = e.deltaY;
      if (e.deltaMode === WheelEvent.DOM_DELTA_LINE) dy *= 16;
      else if (e.deltaMode === WheelEvent.DOM_DELTA_PAGE) dy *= canvas.clientHeight || 800;
      dy = Math.max(-240, Math.min(240, dy));
      const sensitivity = e.ctrlKey ? 0.0075 : 0.0022;
      setZoom(this.p.zoom * Math.exp(-dy * sensitivity));
    }, { passive: false });
    canvas.addEventListener('gesturestart', e => {
      e.preventDefault();
      gestureZoom0 = this.p.zoom;
    }, { passive: false });
    canvas.addEventListener('gesturechange', e => {
      e.preventDefault();
      if (Number.isFinite(e.scale) && e.scale > 0) setZoom(gestureZoom0 * e.scale);
    }, { passive: false });
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.floor(rect.width), h = Math.floor(rect.height);
    if (w === 0 || h === 0) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (dpr !== this._pixelRatio) {
      this.renderer.setPixelRatio(dpr);
      this._pixelRatio = dpr;
    }
    if (w === this._cssW && h === this._cssH) return;
    this._cssW = w;
    this._cssH = h;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // ---------------- Geometry construction ----------------
  _buildRecordDisk() {
    const g = new THREE.Group();
    g.visible = false;
    g.frustumCulled = false;

    const vinylMat = new THREE.MeshStandardMaterial({
      color: GROOVE_COLOR, roughness: 0.42, metalness: 0.15,
      emissive: 0x111318, emissiveIntensity: 0.22,
      side: THREE.DoubleSide,
    });
    const grooveBandMat = new THREE.MeshStandardMaterial({
      color: 0x50565f, roughness: 0.38, metalness: 0.18,
      emissive: 0x15181e, emissiveIntensity: 0.2,
      side: THREE.DoubleSide,
    });
    const labelMat = new THREE.MeshStandardMaterial({
      color: 0x394c5b, roughness: 0.58, metalness: 0.02, side: THREE.DoubleSide,
    });

    const addRingMesh = (inner, outer, mat, yOffset) => {
      const mesh = new THREE.Mesh(new THREE.RingGeometry(inner, outer, RECORD_RING_SEGMENTS, 1), mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.y = RECORD_PLANE_Y + yOffset;
      mesh.frustumCulled = false;
      g.add(mesh);
      return mesh;
    };
    addRingMesh(RECORD_HOLE_R_UM, RECORD_DISC_R_UM, vinylMat, 0);
    addRingMesh(RECORD_INNER_GROOVE_R_UM, RECORD_OUTER_GROOVE_R_UM, grooveBandMat, 1.5);
    addRingMesh(RECORD_HOLE_R_UM, RECORD_LABEL_R_UM, labelMat, 3);

    this.recordLabelTitleGroup = new THREE.Group();
    this.recordLabelTitleGroup.position.y = RECORD_PLANE_Y + 9;
    this.recordLabelTitleGroup.frustumCulled = false;
    const titleTex = makeRecordLabelTitleTexture();
    this.recordLabelTitle = new THREE.Mesh(
      new THREE.PlaneGeometry(RECORD_LABEL_R_UM * 1.72, RECORD_LABEL_R_UM * 0.56),
      new THREE.MeshBasicMaterial({
        map: titleTex, transparent: true, depthTest: true, depthWrite: false,
        side: THREE.DoubleSide,
      }));
    this.recordLabelTitle.rotation.x = -Math.PI / 2;
    this.recordLabelTitle.renderOrder = 5;
    this.recordLabelTitle.frustumCulled = false;
    this.recordLabelTitleGroup.add(this.recordLabelTitle);
    g.add(this.recordLabelTitleGroup);

    const grooveLines = new THREE.LineSegments(
      makeRecordGrooveLineGeometry(),
      new THREE.LineBasicMaterial({ color: 0x2b2e35, transparent: true, opacity: 0.34, depthTest: true }));
    grooveLines.position.y = RECORD_PLANE_Y + 4.5;
    grooveLines.frustumCulled = false;
    g.add(grooveLines);

    const unitCircle = makeUnitCircleGeometry();
    const addCircle = (radius, color, opacity, yOffset) => {
      const line = new THREE.LineLoop(unitCircle.clone(), new THREE.LineBasicMaterial({
        color, transparent: true, opacity, depthTest: true,
      }));
      line.position.y = RECORD_PLANE_Y + yOffset;
      line.scale.set(radius, 1, radius);
      line.frustumCulled = false;
      g.add(line);
      return line;
    };
    addCircle(RECORD_DISC_R_UM, 0x686b72, 0.55, 6);
    addCircle(RECORD_OUTER_GROOVE_R_UM, 0x50545c, 0.5, 6.5);
    addCircle(RECORD_INNER_GROOVE_R_UM, 0x50545c, 0.5, 6.5);
    addCircle(RECORD_LABEL_R_UM, 0x607080, 0.45, 6.5);
    addCircle(RECORD_HOLE_R_UM, 0xa5a9ad, 0.55, 7);

    this.recordCurrentGroove = addCircle(1, 0xf0c46c, 0.9, 8);
    this.recordRadiusLine = new THREE.LineSegments(
      new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3)),
      new THREE.LineBasicMaterial({ color: 0xf0c46c, transparent: true, opacity: 0.42, depthTest: false }));
    this.recordRadiusLine.renderOrder = 6;
    this.recordRadiusLine.frustumCulled = false;
    g.add(this.recordRadiusLine);

    this.recordNeedleMarker = new THREE.Mesh(
      new THREE.SphereGeometry(1, 18, 10),
      new THREE.MeshBasicMaterial({ color: 0xf7d786, transparent: true, opacity: 0.95, depthTest: false }));
    this.recordNeedleMarker.renderOrder = 7;
    this.recordNeedleMarker.frustumCulled = false;
    g.add(this.recordNeedleMarker);

    this.recordGroup = g;
    this.scene.add(g);
  }

  _updateRecordDisk(viewHalf, sim = null) {
    if (!this.recordGroup) return;
    const show = this.p.zoom < RECORD_CONTEXT_MAX_ZOOM;
    this.recordGroup.visible = show;
    if (!show) return;

    const grooveRadiusUm = Math.max(1, (Number.isFinite(this.p.radiusMm) ? this.p.radiusMm : 120) * 1000);
    this.recordGroup.position.set(-grooveRadiusUm, 0, 0);
    this.recordCurrentGroove.scale.set(grooveRadiusUm, 1, grooveRadiusUm);

    const radiusPos = this.recordRadiusLine.geometry.attributes.position.array;
    radiusPos[0] = 0; radiusPos[1] = RECORD_PLANE_Y + 10; radiusPos[2] = 0;
    radiusPos[3] = grooveRadiusUm; radiusPos[4] = RECORD_PLANE_Y + 10; radiusPos[5] = 0;
    this.recordRadiusLine.geometry.attributes.position.needsUpdate = true;

    const markerR = Math.max(320, Math.min(1800, viewHalf * 0.012));
    this.recordNeedleMarker.position.set(grooveRadiusUm, RECORD_PLANE_Y + 15, 0);
    this.recordNeedleMarker.scale.setScalar(markerR);

    if (this.recordLabelTitleGroup) {
      const t = Number.isFinite(sim?.t) ? sim.t : 0;
      const rpm = Number.isFinite(this.p.rpm) ? this.p.rpm : 100 / 3;
      this.recordLabelTitleGroup.rotation.y = -2 * Math.PI * (rpm / 60) * t;
    }
  }

  // Groove mesh via GPU displacement:
  //  - Map PlaneGeometry (u,v) to cross-section x and groove direction z
  //  - Wall displacements are supplied every frame from CPU to an RGBA32F texture with texN samples:
  //    (own groove wL, own groove wR, left adjacent groove wR, right adjacent groove wL) — opposite walls of adjacent grooves
  //    are used for min-composition to render encroachment onto the ridge during large displacements
  //  - Vertex shader evaluates cross-section profile and analytical normals
  _makeGrooveShaderMesh(segX, segZ, texN, sOffset) {
    const data = new Float32Array(texN * 4);
    const tex = new THREE.DataTexture(data, texN, 1, THREE.RGBAFormat, THREE.FloatType);
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    const uni = {
      shiftTex: { value: tex },
      uZMin: { value: -100 }, uZMax: { value: 100 },
      uXHalf: { value: CONST.GROOVE_PITCH * M2W / 2 * 1.02 },
      // Each vec4: t-center, z-center, indentation, t-radius [µm]. z-radius is managed separately in a float array.
      uContactL: { value: Array.from({ length: CONTACT_HISTORY_N }, () => new THREE.Vector4(0, 0, 0, 1)) },
      uContactR: { value: Array.from({ length: CONTACT_HISTORY_N }, () => new THREE.Vector4(0, 0, 0, 1)) },
      uContactZRadL: { value: new Float32Array(CONTACT_HISTORY_N).fill(1) },
      uContactZRadR: { value: new Float32Array(CONTACT_HISTORY_N).fill(1) },
    };
    const mat = new THREE.MeshStandardMaterial({
      color: GROOVE_COLOR, roughness: 0.42, metalness: 0.15, side: THREE.DoubleSide,
    });
    const header = /* glsl */`
uniform sampler2D shiftTex;
uniform float uZMin, uZMax, uXHalf;
uniform vec4 uContactL[${CONTACT_HISTORY_N}];
uniform vec4 uContactR[${CONTACT_HISTORY_N}];
uniform float uContactZRadL[${CONTACT_HISTORY_N}];
uniform float uContactZRadR[${CONTACT_HISTORY_N}];
vec4 grooveShift(float z) {
  float f = clamp((z - uZMin) / (uZMax - uZMin), 0.0, 1.0) * ${(texN - 1).toFixed(1)};
  int i = int(floor(f));
  float t = f - float(i);
  vec4 a = texelFetch(shiftTex, ivec2(i, 0), 0);
  vec4 b = texelFetch(shiftTex, ivec2(min(i + 1, ${texN - 1}), 0), 0);
  return mix(a, b, t);
}
// Land edge rounding with min(v, LAND_Y)
float landCap(float v) {
  float h2 = clamp(0.5 - 0.5 * (v - ${LAND_Y.toFixed(5)}) / ${K_EDGE.toFixed(5)}, 0.0, 1.0);
  return mix(${LAND_Y.toFixed(5)}, v, h2) - ${K_EDGE.toFixed(5)} * h2 * (1.0 - h2) * 0.5;
}
float contactDent(float t, float z, vec4 c, float rz) {
  if (c.z <= 0.0) return 0.0;
  float dt = (t - c.x) / max(c.w, 0.001);
  float dz = (z - c.y) / max(rz, 0.001);
  float q = 1.0 - dt * dt - dz * dz;
  if (q <= 0.0) return 0.0;
  return c.z * q;
}
// min-composition of own groove (w.xy) and opposite walls of adjacent grooves (w.z=left adj wR, w.w=right adj wL, center ±PITCH)
// = lower envelope of each groove cut. Ensures correct surface even if opening spreads to ridge during large displacement
float grooveProfile(float x, float z, vec4 w) {
  float a0 = 1.4142135624 * w.x - x;
  float b0 = 1.4142135624 * w.y + x;
  // Visual elastic deformation: PVC wall locally displaces outward by the physical indentation amount δ.
  // Physical calculations are solved separately using Winkler foundation; this is for visual representation only to avoid clipping.
  float tL = 0.7071067812 * (a0 - x);
  float tR = 0.7071067812 * (b0 + x);
  float dL = 0.0;
  float dR = 0.0;
  for (int i = 0; i < ${CONTACT_HISTORY_N}; i++) {
    dL = max(dL, contactDent(tL, z, uContactL[i], uContactZRadL[i]));
    dR = max(dR, contactDent(tR, z, uContactR[i], uContactZRadR[i]));
  }
  float a = 1.4142135624 * (w.x - dL) - x;
  float b = 1.4142135624 * (w.y - dR) + x;
  float h = clamp(0.5 + 0.5 * (a - b) / ${K_BOTTOM.toFixed(5)}, 0.0, 1.0);
  float y = landCap(mix(b, a, h) + ${K_BOTTOM.toFixed(5)} * h * (1.0 - h) * 0.5);
  float yl = landCap(1.4142135624 * w.z + (x + ${PITCH_W.toFixed(3)}));
  float yr = landCap(1.4142135624 * w.w - (x - ${PITCH_W.toFixed(3)}));
  return min(y, min(yl, yr));
}
// z is mapped in descending order relative to pq.y (to keep the winding order for an upward-facing surface)
vec3 grooveVertex(vec2 pq) {
  float x = pq.x * 2.0 * uXHalf;
  float z = mix(uZMax, uZMin, pq.y + 0.5);
  return vec3(x, grooveProfile(x, z, grooveShift(z)), z);
}
vec3 grooveNormalCalc(vec2 pq) {
  float x = pq.x * 2.0 * uXHalf;
  float z = mix(uZMax, uZMin, pq.y + 0.5);
  float dzf = (uZMax - uZMin) / ${texN.toFixed(1)};
  float dxf = uXHalf * 0.01;
  vec4 w = grooveShift(z);
  float yx0 = grooveProfile(x - dxf, z, w);
  float yx1 = grooveProfile(x + dxf, z, w);
  float yz0 = grooveProfile(x, z - dzf, grooveShift(z - dzf));
  float yz1 = grooveProfile(x, z + dzf, grooveShift(z + dzf));
  return normalize(vec3(-(yx1 - yx0) / (2.0 * dxf), 1.0, -(yz1 - yz0) / (2.0 * dzf)));
}
`;
    mat.onBeforeCompile = sh => {
      Object.assign(sh.uniforms, uni);
      sh.vertexShader = header + sh.vertexShader
        .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = grooveNormalCalc(position.xy);')
        .replace('#include <begin_vertex>', 'vec3 transformed = grooveVertex(position.xy);');
    };
    mat.customProgramCacheKey = () => 'groove' + texN;
    const geo = new THREE.PlaneGeometry(1, 1, segX, segZ);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    return { mesh, tex, data, uni, texN, sOffset };
  }

  // Groove texture update: texN samples covering [zMin, zMax] (world µm).
  // The sampling grid snaps to an absolute grid fixed to the groove pattern coordinates (0.1nm × 2^k ladder)
  // — this prevents phase shifts during scrolling that would occur if sampled relative to the screen,
  // which would cause micro-structures to appear to jitter every frame (resampling aliasing).
  _updateGrooveTex(gm, groove, sBase, zMin, zMax) {
    const n = gm.texN;
    const dsRaw = (zMax - zMin) / (n - 1);
    const BASE = 1e-4; // 0.1nm [µm]
    const dsq = BASE * Math.pow(2, Math.max(0, Math.ceil(Math.log2(dsRaw / BASE))));
    const sBaseUm = sBase * 1e6;
    const Aq = Math.ceil((sBaseUm - zMin) / dsq) * dsq; // zMin側のs[µm] (格子上)
    const zMinQ = sBaseUm - Aq;
    gm.uni.uZMin.value = zMinQ;
    gm.uni.uZMax.value = zMinQ + (n - 1) * dsq;
    const d = gm.data;
    const [oL, oR] = gm.nbrOff;
    for (let i = 0; i < n; i++) {
      const s = (Aq - i * dsq) * 1e-6;
      d[i * 4] = groove.wallShiftVisual(0, s) * M2W;
      d[i * 4 + 1] = groove.wallShiftVisual(1, s) * M2W;
      d[i * 4 + 2] = groove.wallShiftVisual(1, s + oL) * M2W; // Right wall of left adjacent groove
      d[i * 4 + 3] = groove.wallShiftVisual(0, s + oR) * M2W; // Left wall of right adjacent groove
    }
    gm.tex.needsUpdate = true;
  }

  _updateContactDeformation(sim) {
    const gm = this.mainGroove;
    if (!gm) return;
    if (!this.contactHistory) this.contactHistory = [[], []];
    const p = this.p;
    const tx = sim.x * M2W, ty = sim.y * M2W;
    const sideR = Math.max(p.rSide * M2W, 0.001);
    const scanR = Math.max((p.stylusShape === 'spherical' ? p.rSide : p.rScan) * M2W, 0.001);
    const now = Number.isFinite(sim.t) ? sim.t : 0;
    for (const hist of this.contactHistory) {
      if (hist.length && now + 1e-9 < hist[hist.length - 1].t0) hist.length = 0;
    }
    const clearSlot = (contacts, zRads, i) => {
      contacts[i].set(0, 0, 0, 1);
      zRads[i] = 1;
    };
    const pushHistory = (wall, entry) => {
      const hist = this.contactHistory[wall];
      const last = hist[hist.length - 1];
      const movedUm = last ? Math.abs((entry.sAbs - last.sAbs) * M2W) : Infinity;
      const elapsed = last ? entry.t0 - last.t0 : Infinity;
      if (!last || movedUm >= CONTACT_HISTORY_SPACING_UM || elapsed >= CONTACT_HISTORY_DT || entry.dUm > last.dUm * 1.35) {
        hist.push(entry);
        const keep = CONTACT_HISTORY_N * 6;
        if (hist.length > keep) hist.splice(0, hist.length - keep);
      } else if (entry.dUm >= last.dUm) {
        Object.assign(last, entry);
      }
    };
    const fillWall = (wall, d, zc) => {
      const contacts = wall === 0 ? gm.uni.uContactL.value : gm.uni.uContactR.value;
      const zRads = wall === 0 ? gm.uni.uContactZRadL.value : gm.uni.uContactZRadR.value;
      let slot = 0;
      const dUm = Number.isFinite(d) ? Math.max(0, Math.min(d * M2W, 5)) : 0;
      if (dUm > 0) {
        const zcM = Number.isFinite(zc) ? zc : 0;
        const tC = wall === 0 ? Math.SQRT1_2 * (ty - tx) : Math.SQRT1_2 * (ty + tx);
        const zC = -zcM * M2W;
        const tRad = Math.max(0.25, Math.sqrt(2 * sideR * dUm));
        const zRadius = Math.max(0.25, Math.sqrt(2 * scanR * dUm));
        contacts[slot].set(tC, zC, dUm, tRad);
        zRads[slot] = zRadius;
        slot++;
        if (dUm >= CONTACT_HISTORY_MIN_UM) {
          pushHistory(wall, { tC, sAbs: sim.s + zcM, dUm, tRad, zRadius, t0: now });
        }
      }
      const hist = this.contactHistory[wall];
      for (let i = hist.length - 1; i >= 0 && slot < CONTACT_HISTORY_N; i--) {
        const entry = hist[i];
        const age = now - entry.t0;
        if (!Number.isFinite(age) || age < 0) continue;
        const amp = entry.dUm * Math.exp(-age / CONTACT_RECOVERY_TAU);
        if (age > CONTACT_HISTORY_MAX_AGE || amp < CONTACT_HISTORY_MIN_UM) {
          hist.splice(i, 1);
          continue;
        }
        const zC = (sim.s - entry.sAbs) * M2W;
        contacts[slot].set(entry.tC, zC, amp, entry.tRad);
        zRads[slot] = entry.zRadius;
        slot++;
      }
      for (; slot < CONTACT_HISTORY_N; slot++) clearSlot(contacts, zRads, slot);
    };
    fillWall(0, sim.diag.dL, sim.zcL);
    fillWall(1, sim.diag.dR, sim.zcR);
  }

  // Analytical normals for height-field grid: n = normalize(−∂y/∂x, 1, −∂y/∂z)
  // Faster than computeVertexNormals and avoids facets on non-uniform grids
  static _heightFieldNormals(pos, nrm, nz, nx) {
    for (let i = 0; i < nz; i++) {
      const i0 = Math.max(0, i - 1), i1 = Math.min(nz - 1, i + 1);
      for (let j = 0; j < nx; j++) {
        const j0 = Math.max(0, j - 1), j1 = Math.min(nx - 1, j + 1);
        const o = (i * nx + j) * 3;
        const dx = pos[(i * nx + j1) * 3] - pos[(i * nx + j0) * 3];
        const dyx = pos[(i * nx + j1) * 3 + 1] - pos[(i * nx + j0) * 3 + 1];
        const dz = pos[(i1 * nx + j) * 3 + 2] - pos[(i0 * nx + j) * 3 + 2];
        const dyz = pos[(i1 * nx + j) * 3 + 1] - pos[(i0 * nx + j) * 3 + 1];
        const nxv = dx !== 0 ? -dyx / dx : 0, nzv = dz !== 0 ? -dyz / dz : 0;
        const il = 1 / Math.sqrt(nxv * nxv + 1 + nzv * nzv);
        nrm[o] = nxv * il; nrm[o + 1] = il; nrm[o + 2] = nzv * il;
      }
    }
  }


  // Build stylus to cartridge at actual scale (units: µm):
  //  Diamond: tip radius rSide + cone (44° apex angle) height 0.12mm + beveled shank
  //  Cantilever: flat crushed tip + tapered aluminum pipe φ0.21→0.46mm, length 6.5mm, angle 21° (VTA)
  //  Rubber damper + tension wire + magnet + yoke + body (14×6.5×15mm)
  _buildStylus() {
    if (this.stylusGroup) {
      this._disposePartLabels();
      this.scene.remove(this.stylusGroup);
      this.stylusGroup.traverse(o => { if (o.geometry) o.geometry.dispose(); });
    }
    const p = this.p;
    const g = new THREE.Group();
    const rS = p.rSide * M2W;
    const rZ = (p.stylusShape === 'spherical' ? p.rSide : p.rScan) * M2W;
    const matNeedleMetal = new THREE.MeshStandardMaterial({
      color: 0xc2c7ce, roughness: 0.34, metalness: 0.62,
    });
    const matDia = new THREE.MeshPhysicalMaterial({
      color: 0xf8fbff, roughness: 0.015, metalness: 0.0,
      side: THREE.FrontSide,
      thickness: 120, ior: 2.42,
      attenuationColor: 0xeaf3ff, attenuationDistance: 220,
      clearcoat: 1, clearcoatRoughness: 0.015,
      specularIntensity: 1, specularColor: 0xffffff,
    });
    const matDiaEdge = new THREE.LineBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.28, depthWrite: false,
    });
    this._attachStylusGrooveClip(matDia);
    this.matDia = matDia;
    this.matDiaEdge = matDiaEdge;
    this.updateStylusMaterial();

    // --- Diamond tip: lathe geometry (spherical tip → cone, 32° apex angle) ---
    // Slim cone: minimizes overhang over the land to avoid looking like it's "sinking in"
    const coneHalf = 16 * Math.PI / 180;
    const a0 = Math.PI / 2 - coneHalf;      // Sphere→cone connection angle
    const pts = [];
    for (let k = 0; k <= 12; k++) {
      const a = a0 * k / 12;
      pts.push(new THREE.Vector2(rS * Math.sin(a), rS * (1 - Math.cos(a))));
    }
    const H = 150;                            // Cone height [µm]
    const yTan = rS * (1 - Math.cos(a0));
    const rTop = rS * Math.sin(a0) + (H - yTan) * Math.tan(coneHalf);
    pts.push(new THREE.Vector2(rTop, H));
    const latheGeo = new THREE.LatheGeometry(pts, 48);
    const tip = new THREE.Mesh(latheGeo, matDia);
    tip.position.y = -rS;                     // 原点=球中心 (物理のチップ位置)
    tip.scale.z = rZ / rS;                    // 楕円針: 進行方向を圧縮
    g.add(tip);

    // --- Beveled shank (nude diamond, 0.12mm square) ---
    const shankW = 115, shankH = 105, shankD = 115;
    const shank = new THREE.Mesh(makeBeveledBoxGeometry(shankW, shankH, shankD, 10), matDia);
    shank.position.y = -rS + H + 52;
    shank.add(new THREE.LineSegments(new THREE.EdgesGeometry(shank.geometry, 15), matDiaEdge));
    g.add(shank);

    // --- Cantilever: tapered pipe (tip φ210 → pivot φ460, 6.5mm, 21°) ---
    const matAl = matNeedleMetal;
    const vta = 21 * Math.PI / 180;
    const dir = new THREE.Vector3(0, Math.sin(vta), -Math.cos(vta));
    const cantLen = 6500;
    const end = new THREE.Vector3(0, -rS + H + 160, -60); // Diamond attachment point
    // Flat tip to mimic real-world adhesive/crushing process. Spans the diamond top and overlaps the tube end.
    const flatAngle = 8 * Math.PI / 180;
    const flatDir = new THREE.Vector3(0, Math.sin(flatAngle), -Math.cos(flatAngle));
    const flatLen = 720, flatThick = 78;
    const shankTopY = shank.position.y + shankH / 2;
    const flatFront = new THREE.Vector3(0, shankTopY + 26, 95);
    const flatTip = new THREE.Mesh(makeBeveledBoxGeometry(300, flatThick, flatLen, 8), matAl);
    flatTip.position.copy(flatFront).addScaledVector(flatDir, flatLen / 2);
    flatTip.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), flatDir);
    g.add(flatTip);
    const pivot = end.clone().addScaledVector(dir, cantLen);
    const cant = new THREE.Mesh(new THREE.CylinderGeometry(230, 105, cantLen, 24, 1, true), matAl);
    cant.position.copy(end).addScaledVector(dir, cantLen / 2);
    cant.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    g.add(cant);

    // --- Suspension: rubber damper (donut) + magnet + yoke ---
    const matRubber = new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.9 });
    const damper = new THREE.Mesh(new THREE.TorusGeometry(260, 130, 12, 32), matRubber);
    damper.position.copy(pivot).addScaledVector(dir, -350);
    damper.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
    g.add(damper);
    const matMag = matNeedleMetal;
    const magnet = new THREE.Mesh(new THREE.CylinderGeometry(300, 300, 650, 20), matMag);
    magnet.position.copy(pivot).addScaledVector(dir, 400);
    magnet.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    g.add(magnet);
    const matYoke = new THREE.MeshStandardMaterial({ color: 0xaeb4bd, roughness: 0.32, metalness: 0.9 });
    const yoke = new THREE.Mesh(new THREE.BoxGeometry(2400, 2000, 1100), matYoke);
    yoke.position.copy(pivot).addScaledVector(dir, 950);
    g.add(yoke);

    // --- Cartridge body (16×12.5×17mm) ---
    // Based on real hardware: record surface clearance 3.2mm, tip to mounting surface 15.7mm (within 15-18mm spec)
    const CLEAR = 3200;                        // Record surface to body bottom [µm]
    const CART_H = 12500;                      // Body height [µm]
    const matBody = new THREE.MeshStandardMaterial({
      color: 0x59616b, roughness: 0.5, metalness: 0.08,
      emissive: 0x14171c, emissiveIntensity: 0.18,
    });
    const body = new THREE.Mesh(new THREE.BoxGeometry(16000, CART_H, 17000), matBody);
    body.position.set(0, CLEAR + CART_H / 2, -4300 - 8500);
    g.add(body);
    // Front nose (where cantilever emerges, extends below body bottom)
    const nose = new THREE.Mesh(new THREE.BoxGeometry(6000, 2600, 3200), matYoke);
    nose.position.set(0, 2850, -5700);
    g.add(nose);

    // --- Headshell (13×2.5×52mm, body top = mounting surface) ---
    const matShell = new THREE.MeshStandardMaterial({ color: 0x8f939a, roughness: 0.4, metalness: 0.85 });
    const shellTopY = CLEAR + CART_H;          // Mounting surface (15.7mm from record surface)
    const shell = new THREE.Mesh(new THREE.BoxGeometry(13000, 2500, 52000), matShell);
    shell.position.set(0, shellTopY + 1250, 2000 - 26000); // z: +2mm〜−50mm
    g.add(shell);
    // Mounting screw heads x2
    const matSteel = new THREE.MeshStandardMaterial({ color: 0xb0b3b8, roughness: 0.35, metalness: 0.9 });
    for (const zScrew of [-6000, -18000]) {
      const screw = new THREE.Mesh(new THREE.CylinderGeometry(1400, 1400, 900, 16), matSteel);
      screw.position.set(0, shellTopY + 2500 + 450, zScrew);
      g.add(screw);
    }

    // --- Tonearm: horizontal straight arm ---
    // Effective length 230mm (9-inch standard), pipe φ11mm, bottom 30mm from record surface
    const armY = 30000 + 5500;                 // Pipe center height [µm]
    const pivotZ = -230000;                    // Stylus→pivot 23cm
    // Swan neck (lifts from headshell rear to collet)
    const neckFrom = new THREE.Vector3(0, shellTopY + 2500, -38000);
    const neckTo = new THREE.Vector3(0, armY, -60000);
    const neckDir = neckTo.clone().sub(neckFrom);
    const neck = new THREE.Mesh(
      new THREE.CylinderGeometry(2800, 2800, neckDir.length(), 16), matShell);
    neck.position.copy(neckFrom).addScaledVector(neckDir, 0.5);
    neck.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), neckDir.clone().normalize());
    g.add(neck);
    // Collet (bayonet ring)
    const matDark = new THREE.MeshStandardMaterial({ color: 0x1c1e22, roughness: 0.5, metalness: 0.6 });
    const collet = new THREE.Mesh(new THREE.CylinderGeometry(8000, 8000, 13000, 24), matDark);
    collet.position.set(0, armY, -66000);
    collet.rotation.x = Math.PI / 2;
    g.add(collet);
    // Arm pipe (horizontal, collet rear → pivot)
    const matArm = new THREE.MeshStandardMaterial({ color: 0xb9bcc2, roughness: 0.3, metalness: 0.9 });
    const pipeLen = -72500 - pivotZ;
    const armPipe = new THREE.Mesh(new THREE.CylinderGeometry(5500, 5500, pipeLen, 24), matArm);
    armPipe.position.set(0, armY, -72500 - pipeLen / 2);
    armPipe.rotation.x = Math.PI / 2;
    g.add(armPipe);
    // Pivot housing + pillar
    const housing = new THREE.Mesh(new THREE.BoxGeometry(26000, 34000, 26000), matDark);
    housing.position.set(0, armY, pivotZ - 13000);
    g.add(housing);
    const pillar = new THREE.Mesh(new THREE.CylinderGeometry(9000, 9000, 46000, 20), matDark);
    pillar.position.set(0, armY - 17000 - 23000, pivotZ - 13000);
    g.add(pillar);
    // Counterweight
    const cw = new THREE.Mesh(new THREE.CylinderGeometry(18000, 18000, 28000, 28), matDark);
    cw.position.set(0, armY, pivotZ - 13000 - 13000 - 25000);
    cw.rotation.x = Math.PI / 2;
    g.add(cw);

    this.partLabelSpecs = [
      { key: 'stylusTip', minZoom: 0.5, maxZoom: 5, position: new THREE.Vector3(170, -rS + H + 120, 150) },
      { key: 'cantilever', minZoom: 0.05, maxZoom: 3, position: cant.position.clone().add(new THREE.Vector3(820, 520, 0)) },
      { key: 'damper', minZoom: 0.08, maxZoom: 1.3, position: damper.position.clone().add(new THREE.Vector3(900, 520, 0)) },
      { key: 'magnetYoke', minZoom: 0.06, maxZoom: 0.85, position: yoke.position.clone().add(new THREE.Vector3(-2100, 1650, 0)) },
      { key: 'cartridge', minZoom: 0.035, maxZoom: 0.42, position: body.position.clone().add(new THREE.Vector3(0, CART_H * 0.56, 0)) },
      { key: 'headshell', minZoom: 0.018, maxZoom: 0.16, position: shell.position.clone().add(new THREE.Vector3(-7800, 2450, 2000)) },
      { key: 'tonearm', minZoom: 0.01, maxZoom: 0.05, position: new THREE.Vector3(0, armY + 8500, -65000) },
      { key: 'pivot', minZoom: 0.01, maxZoom: 0.04, position: housing.position.clone().add(new THREE.Vector3(0, 21000, 0)) },
      { key: 'counterweight', minZoom: 0.01, maxZoom: 0.04, position: cw.position.clone().add(new THREE.Vector3(0, 21000, 0)) },
    ];
    this.stylusGroup = g;
    this.scene.add(g);
    this._buildPartLabels();

    // --- Ideal-tracking ghost: stylus position if it perfectly traced the signal ---
    // Offset from real stylus = tracking error (tracing loss, resonance, roughness-induced jitter, dust)
    // Overlaid last in a dedicated scene (with depth clear) to eliminate Z-fighting
    if (this.ghostGroup) {
      this.ghostScene.remove(this.ghostGroup);
      this.ghostGroup.traverse(o => {
        if (o.geometry) o.geometry.dispose();
        if (o.material?.map) o.material.map.dispose();
        if (o.material) o.material.dispose();
      });
    }
    const matGhost = new THREE.MeshBasicMaterial({
      color: 0xffb347, transparent: true, opacity: 0.35, depthWrite: false,
    });
    const gg = new THREE.Group();
    const gTip = new THREE.Mesh(latheGeo.clone(), matGhost);
    gTip.position.y = -rS;
    gTip.scale.z = rZ / rS;
    gg.add(gTip);
    const gShank = new THREE.Mesh(makeBeveledBoxGeometry(shankW, shankH, shankD, 10), matGhost);
    gShank.position.y = -rS + H + 52;
    gg.add(gShank);

    this.errorVectorState = null;
    this.ghostGroup = gg;
    this.ghostScene.add(gg);
  }

  _disposePartLabels() {
    if (!this.partLabelSprites) return;
    for (const sp of this.partLabelSprites.values()) {
      if (sp.parent) sp.parent.remove(sp);
      disposeSprite(sp);
    }
    this.partLabelSprites.clear();
  }

  _buildPartLabels() {
    this._disposePartLabels();
    if (!this.stylusGroup || !this.partLabelSpecs) return;
    const labels = rt(this.p).partLabels || {};
    for (const spec of this.partLabelSpecs) {
      const sp = makeTextSprite(labels[spec.key] || spec.key, PART_LABEL_COLOR, true);
      sp.material.depthTest = false;
      sp.material.depthWrite = false;
      sp.renderOrder = 16;
      sp.frustumCulled = false;
      sp.visible = false;
      sp.position.copy(spec.position);
      this.stylusGroup.add(sp);
      this.partLabelSprites.set(spec.key, sp);
    }
  }

  _updatePartLabels(viewHalf) {
    if (!this.partLabelSprites) return;
    const show = !!this.p.showLabels;
    const zoom = this.p.zoom;
    const h = Math.max(viewHalf * 0.052, 14);
    for (const spec of this.partLabelSpecs) {
      const sp = this.partLabelSprites.get(spec.key);
      if (!sp) continue;
      const visible = show && zoom >= spec.minZoom && zoom <= spec.maxZoom;
      sp.visible = visible;
      if (visible) sp.scale.set(h * sp.userData.aspect, h, 1);
    }
  }

  _buildContactMarkers() {
    const mk = () => {
      const m = new THREE.Mesh(
        new THREE.SphereGeometry(1, 12, 8),
        new THREE.MeshBasicMaterial({ color: 0x27c840, transparent: true, opacity: 0.85, depthTest: false }));
      m.renderOrder = 5;
      this.scene.add(m);
      return m;
    };
    this.markL = mk(); this.markR = mk();
  }

  _makeMoleculeStructure() {
    const g = new THREE.Group();
    g.visible = false;
    g.frustumCulled = false;
    g.renderOrder = 10;

    const bondGeo = new THREE.CylinderGeometry(1, 1, 1, 10);
    const bondMat = new THREE.MeshBasicMaterial({
      color: 0xd8d3c4,
      depthTest: true,
      depthWrite: true,
    });
    const atomGeo = new THREE.SphereGeometry(1, 18, 12);
    const atomMaterials = new Map();
    const atomMaterial = atom => {
      const key = atom.element;
      if (!atomMaterials.has(key)) {
        atomMaterials.set(key, new THREE.MeshBasicMaterial({
          color: atom.color,
          transparent: true,
          opacity: 0.78,
          depthTest: true,
          depthWrite: false,
        }));
      }
      return atomMaterials.get(key);
    };

    const addBond = (a, b, offset) => {
      const va = new THREE.Vector3(a.x, a.y, a.z);
      const vb = new THREE.Vector3(b.x, b.y, b.z);
      const dir = vb.clone().sub(va);
      const len0 = dir.length();
      if (!(len0 > 1e-9)) return;
      dir.multiplyScalar(1 / len0);
      const side = new THREE.Vector3(-dir.y, dir.x, 0).normalize();
      const start = va.addScaledVector(side, offset);
      const end = vb.addScaledVector(side, offset);
      const delta = end.clone().sub(start);
      const len = delta.length();
      if (!(len > 1e-9)) return;
      const bond = new THREE.Mesh(bondGeo, bondMat);
      bond.position.copy(start).addScaledVector(delta, 0.5);
      bond.quaternion.setFromUnitVectors(UP, delta.normalize());
      bond.scale.set(0.008, len, 0.008);
      bond.renderOrder = 10;
      bond.frustumCulled = false;
      g.add(bond);
    };

    for (const [aId, bId, order] of PVC_CHAIN_BONDS) {
      const a = PVC_CHAIN_ATOM_BY_ID.get(aId);
      const b = PVC_CHAIN_ATOM_BY_ID.get(bId);
      if (!a || !b) continue;
      const offsets = order === 2 ? [-0.015, 0.015] : [0];
      for (const offset of offsets) addBond(a, b, offset);
    }

    for (const atom of PVC_CHAIN_ATOMS) {
      const mesh = new THREE.Mesh(atomGeo, atomMaterial(atom));
      mesh.position.set(atom.x, atom.y, atom.z);
      mesh.scale.setScalar(atom.r);
      mesh.renderOrder = atom.element === 'C' ? 12 : 11;
      mesh.frustumCulled = false;
      g.add(mesh);

      const labelColor = atom.element === 'H' ? '#111317' : '#f7f4e9';
      const label = makeTextSprite(atom.element, labelColor, false);
      label.material.depthWrite = false;
      label.renderOrder = 14;
      label.frustumCulled = false;
      const h = atom.r * (atom.element === 'Cl' ? 0.78 : 0.9);
      label.scale.set(h * label.userData.aspect, h, 1);
      label.position.set(atom.x, atom.y, atom.z + atom.r * 1.08);
      g.add(label);
    }
    return g;
  }

  _buildMolecules() {
    const mat = new THREE.MeshBasicMaterial({
      color: 0x0b1113,
      transparent: true,
      opacity: 1,
      depthTest: false,
      depthWrite: false,
    });
    const rimMat = new THREE.MeshBasicMaterial({
      color: 0x566d75,
      transparent: true,
      opacity: 0.52,
      side: THREE.BackSide,
      depthTest: false,
      depthWrite: false,
    });
    this.moleculeRim = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), rimMat);
    this.moleculeRim.renderOrder = 7;
    this.moleculeRim.frustumCulled = false;
    this.moleculeRim.visible = false;
    this.scene.add(this.moleculeRim);

    const outlinePts = [];
    for (let i = 0; i < 128; i++) {
      const a = i / 128 * Math.PI * 2;
      outlinePts.push(new THREE.Vector3(Math.cos(a), Math.sin(a), 0));
    }
    const outlineGeo = new THREE.BufferGeometry().setFromPoints(outlinePts);
    const outlineMat = new THREE.LineBasicMaterial({
      color: 0xb2c8ca,
      transparent: true,
      opacity: 0.95,
      depthTest: false,
      depthWrite: false,
    });
    this.moleculeOutline = new THREE.LineLoop(outlineGeo, outlineMat);
    this.moleculeOutline.renderOrder = 10;
    this.moleculeOutline.frustumCulled = false;
    this.moleculeOutline.visible = false;
    this.scene.add(this.moleculeOutline);

    this.moleculeSphere = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), mat);
    this.moleculeSphere.renderOrder = 8;
    this.moleculeSphere.frustumCulled = false;
    this.moleculeSphere.visible = false;
    this.scene.add(this.moleculeSphere);

    const highlightMat = new THREE.MeshBasicMaterial({
      color: 0xd8f0f2,
      transparent: true,
      opacity: 0.48,
      depthTest: false,
      depthWrite: false,
    });
    this.moleculeHighlight = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 8), highlightMat);
    this.moleculeHighlight.renderOrder = 9;
    this.moleculeHighlight.frustumCulled = false;
    this.moleculeHighlight.visible = false;
    this.scene.add(this.moleculeHighlight);

    this.moleculeStructure = this._makeMoleculeStructure();
    this.scene.add(this.moleculeStructure);

    this.moleculeLabel = makeTextSprite(rt(this.p).moleculeLabel, '#e6e1cf', false);
    this.moleculeLabel.material.depthWrite = false;
    this.moleculeLabel.renderOrder = 9;
    this.moleculeLabel.frustumCulled = false;
    this.moleculeLabel.visible = false;
    this.scene.add(this.moleculeLabel);
  }

  _buildRulers() {
    const mkLines = (color, width2) => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6000 * 3), 3));
      const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: width2 ? 1 : 0.55, depthTest: false });
      const l = new THREE.LineSegments(geo, mat);
      l.renderOrder = 6;
      l.frustumCulled = false;
      this.scene.add(l);
      return l;
    };
    // L=blue, R=aqua (unify channel colors with graph)
    this.rulerL = {
      major: mkLines(0x3987e5, true), minor: mkLines(0x3987e5, false),
      marker: mkLines(0xffffff, true), error: this._makeRulerErrorOverlay(0x79b8ff, '#79b8ff'),
    };
    this.rulerR = {
      major: mkLines(0x199e70, true), minor: mkLines(0x199e70, false),
      marker: mkLines(0xffffff, true), error: this._makeRulerErrorOverlay(0x56d69d, '#56d69d'),
    };
    this.rulerLegend = null;
  }

  rebuildStylus() {
    this.contactHistory = [[], []];
    this._buildStylus();
  }

  updateStylusMaterial() {
    const t = Math.max(0, Math.min(100, this.p.stylusTransparency ?? 0)) / 100;
    const opacity = 1 - t;
    if (this.matDia) {
      this.matDia.transparent = t > 0;
      this.matDia.opacity = opacity;
      this.matDia.depthWrite = t <= 0;
      this.matDia.transmission = 0.45 * t;
      this.matDia.needsUpdate = true;
    }
    if (this.matDiaEdge) {
      this.matDiaEdge.opacity = 0.28 * opacity;
      this.matDiaEdge.visible = opacity > 0;
      this.matDiaEdge.needsUpdate = true;
    }
  }

  _attachStylusGrooveClip(mat) {
    const gm = this.mainGroove;
    if (!gm) return;
    const texN = gm.texN;
    const clipHeader = /* glsl */`
varying vec3 vStylusWorldPos;
uniform sampler2D clipShiftTex;
uniform float clipZMin, clipZMax, clipXHalf;
uniform vec4 clipContactL[${CONTACT_HISTORY_N}];
uniform vec4 clipContactR[${CONTACT_HISTORY_N}];
uniform float clipContactZRadL[${CONTACT_HISTORY_N}];
uniform float clipContactZRadR[${CONTACT_HISTORY_N}];
vec4 clipGrooveShift(float z) {
  float f = clamp((z - clipZMin) / (clipZMax - clipZMin), 0.0, 1.0) * ${(texN - 1).toFixed(1)};
  int i = int(floor(f));
  float t = f - float(i);
  vec4 a = texelFetch(clipShiftTex, ivec2(i, 0), 0);
  vec4 b = texelFetch(clipShiftTex, ivec2(min(i + 1, ${texN - 1}), 0), 0);
  return mix(a, b, t);
}
float clipLandCap(float v) {
  float h2 = clamp(0.5 - 0.5 * (v - ${LAND_Y.toFixed(5)}) / ${K_EDGE.toFixed(5)}, 0.0, 1.0);
  return mix(${LAND_Y.toFixed(5)}, v, h2) - ${K_EDGE.toFixed(5)} * h2 * (1.0 - h2) * 0.5;
}
float clipContactDent(float t, float z, vec4 c, float rz) {
  if (c.z <= 0.0) return 0.0;
  float dt = (t - c.x) / max(c.w, 0.001);
  float dz = (z - c.y) / max(rz, 0.001);
  float q = 1.0 - dt * dt - dz * dz;
  if (q <= 0.0) return 0.0;
  return c.z * q;
}
float clipGrooveProfile(float x, float z, vec4 w) {
  float a0 = 1.4142135624 * w.x - x;
  float b0 = 1.4142135624 * w.y + x;
  float tL = 0.7071067812 * (a0 - x);
  float tR = 0.7071067812 * (b0 + x);
  float dL = 0.0;
  float dR = 0.0;
  for (int i = 0; i < ${CONTACT_HISTORY_N}; i++) {
    dL = max(dL, clipContactDent(tL, z, clipContactL[i], clipContactZRadL[i]));
    dR = max(dR, clipContactDent(tR, z, clipContactR[i], clipContactZRadR[i]));
  }
  float a = 1.4142135624 * (w.x - dL) - x;
  float b = 1.4142135624 * (w.y - dR) + x;
  float h = clamp(0.5 + 0.5 * (a - b) / ${K_BOTTOM.toFixed(5)}, 0.0, 1.0);
  float y = clipLandCap(mix(b, a, h) + ${K_BOTTOM.toFixed(5)} * h * (1.0 - h) * 0.5);
  float yl = clipLandCap(1.4142135624 * w.z + (x + ${PITCH_W.toFixed(3)}));
  float yr = clipLandCap(1.4142135624 * w.w - (x - ${PITCH_W.toFixed(3)}));
  return min(y, min(yl, yr));
}
`;
    mat.onBeforeCompile = sh => {
      Object.assign(sh.uniforms, {
        clipShiftTex: gm.uni.shiftTex,
        clipZMin: gm.uni.uZMin,
        clipZMax: gm.uni.uZMax,
        clipXHalf: gm.uni.uXHalf,
        clipContactL: gm.uni.uContactL,
        clipContactR: gm.uni.uContactR,
        clipContactZRadL: gm.uni.uContactZRadL,
        clipContactZRadR: gm.uni.uContactZRadR,
      });
      sh.vertexShader = 'varying vec3 vStylusWorldPos;\n' + sh.vertexShader
        .replace('#include <begin_vertex>',
          '#include <begin_vertex>\nvStylusWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      sh.fragmentShader = clipHeader + sh.fragmentShader
        .replace('#include <clipping_planes_fragment>',
          '#include <clipping_planes_fragment>\nif (vStylusWorldPos.y < clipGrooveProfile(vStylusWorldPos.x, vStylusWorldPos.z, clipGrooveShift(vStylusWorldPos.z)) + 0.03) discard;');
    };
    mat.customProgramCacheKey = () => `stylus-groove-clip-${texN}`;
  }

  // ---------------- Per-frame update ----------------
  // state: {sim, groove, params}
  update(state) {
    const { sim, groove } = state;
    const p = this.p;
    this.resize();

    const viewHalf = 1500 / p.zoom; // [µm]
    this.viewHalf = viewHalf;
    const sS = sim.s; // 針のパターン座標 [m]

    // Camera focus: wide view = DC tip → high magnification = current R-wall contact point,
    // continuously interpolated by zoom level.
    // Contact point is defined same as existing contact markers, without temporal smoothing.
    const tx = sim.x * M2W, ty = sim.y * M2W;
    const dc = dcContactUm(p);
    const dcRestY = Math.SQRT2 * dc.t;
    const dcTipY = dcRestY - p.rSide * M2W;
    let wallFocus = (50 - viewHalf) / (50 - 15);
    wallFocus = Math.max(0, Math.min(1, wallFocus));
    const dcWallX = dc.t * Math.SQRT1_2 - N_R.x * dc.indent;
    const dcWallY = dc.t * Math.SQRT1_2 - N_R.y * dc.indent;
    // Common reference for rulers is always the R-wall DC contact point.
    // At low magnification, applying wallFocus shifts it toward the opposite side.
    const rulerBaseTarget = {
      x: dcWallX,
      y: dcWallY,
      z: 0,
    };
    const rContactX = tx - N_R.x * p.rSide * M2W;
    const rContactY = ty - N_R.y * p.rSide * M2W;
    const rContactZ = sim.diag.dR > 0 && Number.isFinite(sim.zcR) ? -sim.zcR * M2W : 0;
    this.target.set(
      rContactX * wallFocus,
      dcTipY * (1 - wallFocus) + rContactY * wallFocus,
      rContactZ * wallFocus);
    const rulerOffset = {
      x: this.target.x - dcWallX,
      y: this.target.y - dcWallY,
      z: this.target.z,
    };
    const wallReferenceOffset = {
      x: (rContactX - dcWallX) * wallFocus,
      y: (rContactY - dcWallY) * wallFocus,
      z: rulerOffset.z,
    };
    // Focus for mesh/molecules/rulers (pattern coordinates)
    const focusS = sS - this.target.z * 1e-6;
    this.focusS = focusS;
    const halfFovTan = Math.tan(this.camera.fov * Math.PI / 360);
    const aspect = Math.max(this.camera.aspect, 1e-6);
    // Zoom value is treated as physical field of view based on the short side. Resizing vertically tall
    // won't make horizontal narrower than expected, and wide aspect maintains vertical FOV as before.
    const dist = viewHalf / (halfFovTan * Math.min(1, aspect));
    const vHalf = halfFovTan * dist;
    const hHalf = vHalf * aspect;
    this.viewWidth = hHalf * 2;
    this.viewHeight = vHalf * 2;
    this.viewExtentHalf = Math.max(hHalf, vHalf);
    this.pxPerUm = this._cssW > 0 ? this._cssW / this.viewWidth : 1;
    const ce = Math.cos(this.el), se = Math.sin(this.el);
    this.camera.position.set(
      this.target.x + dist * ce * Math.sin(this.az),
      this.target.y + dist * se,
      this.target.z + dist * ce * Math.cos(this.az));
    this.camera.lookAt(this.target);
    this.camera.near = Math.max(dist * 0.03, 1e-4);
    this.camera.far = dist * 60 + 4000;
    this.camera.updateProjectionMatrix();

    // Headlamp: brightens as you zoom in to make shadowed wall surfaces visible
    this.headLamp.position.copy(this.camera.position);
    const lampFade = Math.max(0, Math.min(1, (40 - viewHalf) / 32));
    this.headLamp.intensity = 1.6 * dist * dist * lampFade;
    this._updateRecordDisk(viewHalf, sim);

    // Ensure generation (visible range + adjacent groove offsets)
    const viewExtentHalf = this.viewExtentHalf;
    const zSpanM = Math.min(1.5e-3, Math.max(2e-6, viewExtentHalf * 2.6e-6));
    groove.ensure(sS + zSpanM + 3.2e-3);

    // --- Groove mesh update (GPU displacement: texture range auto-adapted to view + focus) ---
    const zHalfW = Math.min(viewExtentHalf * 2.6, 1500);
    const zMin = this.target.z - zHalfW, zMax = this.target.z + zHalfW;
    this._updateContactDeformation(sim);
    this._updateGrooveTex(this.mainGroove, groove, sS, zMin, zMax);
    for (const gm of this.neighborGrooves) {
      // Different section of the same signal ring = music from the adjacent rotation (0.5mm offset)
      const vis = viewExtentHalf > 25;
      gm.mesh.visible = vis;
      if (vis) this._updateGrooveTex(gm, groove, sS + gm.sOffset, zMin, zMax);
    }

    // --- Stylus ---
    this.stylusGroup.position.set(tx, ty, 0);

    // --- Ideal-tracking ghost (rigid V-translation of signal only, excluding roughness/dust/dynamics) ---
    this.ghostGroup.visible = !!p.showGhost;
    if (p.showGhost) {
      const shL = groove.signalShift(0, sS);
      const shR = groove.signalShift(1, sS);
      const ix = (shL * N_L.x + shR * N_R.x) * M2W;
      const iy = (sim.restY + shL * N_L.y + shR * N_R.y) * M2W;
      this.ghostGroup.position.set(ix, iy, 0);
      this.idealPos = { x: ix * 1e-6, y: iy * 1e-6 }; // [m] HUD用
      this._updateGhostErrorVector(sim, tx, ty, ix, iy);
    } else {
      this.errorVectorState = null;
    }

    // --- Contact markers ---
    const mScale = Math.max(viewHalf * 0.014, 0.002);
    const showMarkers = !!p.showContactMarkers && p.zoom > 3;
    const setMark = (mark, contact, nx, ny, zc) => {
      mark.visible = showMarkers;
      if (!showMarkers) return;
      const rr = p.rSide * M2W;
      const z = contact && Number.isFinite(zc) ? -zc * M2W : 0;
      mark.position.set(tx - nx * rr, ty - ny * rr, z);
      mark.scale.setScalar(mScale);
      mark.material.color.set(contact ? 0x27c840 : 0xd03b3b);
    };
    setMark(this.markL, sim.diag.dL > 0, Math.SQRT1_2, Math.SQRT1_2, sim.zcL);
    setMark(this.markR, sim.diag.dR > 0, -Math.SQRT1_2, Math.SQRT1_2, sim.zcR);

    // --- Molecular scale / Rulers / Dust ---
    this._updatePartLabels(viewHalf);
    this._updateMolecules(viewHalf, wallReferenceOffset);
    this._updateRulers(groove, viewHalf, focusS, wallReferenceOffset);
    this._updateTimeRuler(sim, viewHalf, rulerOffset, rulerBaseTarget);
    this._updateDust(groove, sS);

    this.renderer.render(this.scene, this.camera);
    // Ghost is overlaid semi-transparently after depth clear (prevents Z-order flickering)
    if (p.showGhost) {
      this.renderer.autoClear = false;
      this.renderer.clearDepth();
      this.renderer.render(this.ghostScene, this.camera);
      this.renderer.autoClear = true;
    }
  }

  _makeRulerErrorOverlay(color, textColor) {
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1, depthTest: false, depthWrite: false });
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 16), mat);
    shaft.renderOrder = 13;
    shaft.frustumCulled = false;
    const head = new THREE.Mesh(
      new THREE.ConeGeometry(1, 1, 20),
      mat.clone());
    head.renderOrder = 14;
    head.frustumCulled = false;
    this.scene.add(shaft, head);
    const overlay = { shaft, head, label: null, text: '', textColor };
    this._hideRulerErrorOverlay(overlay);
    return overlay;
  }

  _hideRulerErrorOverlay(overlay) {
    if (!overlay) return;
    overlay.shaft.visible = false;
    overlay.head.visible = false;
    if (overlay.label) overlay.label.visible = false;
  }

  _setRulerErrorLabel(overlay, text) {
    if (overlay.text === text) return;
    if (overlay.label) {
      this.scene.remove(overlay.label);
      disposeSprite(overlay.label);
    }
    overlay.text = text;
    overlay.label = text ? makeTextSprite(text, overlay.textColor, true) : null;
    if (overlay.label) {
      overlay.label.material.depthTest = false;
      overlay.label.material.depthWrite = false;
      overlay.label.renderOrder = 15;
      overlay.label.frustumCulled = false;
      this.scene.add(overlay.label);
    }
  }

  _updateRulerErrorOverlay(overlay, start, delta, viewHalf, labelText, labelDir) {
    const len = delta.length();
    if (!(len > 1e-9)) {
      this._hideRulerErrorOverlay(overlay);
      return;
    }
    const end = start.clone().add(delta);

    const dir = this._errDir.copy(delta).multiplyScalar(1 / len);
    const headLen = Math.min(len, Math.min(Math.max(viewHalf * 0.03, len * 0.2), viewHalf * 0.075));
    const shaftLen = Math.max(len - headLen * 0.55, len * 0.35);
    const shaftR = viewHalf * 0.006;
    overlay.shaft.position.copy(start).addScaledVector(dir, shaftLen * 0.5);
    overlay.shaft.quaternion.setFromUnitVectors(UP, dir);
    overlay.shaft.scale.set(shaftR, shaftLen, shaftR);
    overlay.shaft.visible = true;

    overlay.head.position.copy(end).addScaledVector(dir, -headLen * 0.5);
    overlay.head.quaternion.setFromUnitVectors(UP, dir);
    overlay.head.scale.set(headLen * 0.45, headLen, headLen * 0.45);
    overlay.head.visible = true;

    this._setRulerErrorLabel(overlay, labelText);
    if (overlay.label) {
      const showLabel = len >= viewHalf * 0.08;
      overlay.label.visible = showLabel;
      if (showLabel) {
        const h = Math.max(viewHalf * 0.07, headLen * 1.2);
        overlay.label.scale.set(h * overlay.label.userData.aspect, h, 1);
        overlay.label.position.copy(end)
          .addScaledVector(labelDir, Math.max(viewHalf * 0.06, headLen))
          .addScaledVector(dir, headLen * 0.25);
      }
    }
  }

  _updateRulerErrorOnAxis(overlay, base, axis, startD, deltaD, viewHalf, labelText, labelDir, lo, hi) {
    if (!this.errorVectorState || !(Math.abs(deltaD) > 1e-9) ||
        Math.max(startD, startD + deltaD) < lo || Math.min(startD, startD + deltaD) > hi) {
      this._hideRulerErrorOverlay(overlay);
      return;
    }
    const start = base.clone().addScaledVector(axis, startD);
    this._updateRulerErrorOverlay(overlay, start, axis.clone().multiplyScalar(deltaD), viewHalf, labelText, labelDir);
  }

  _updateGhostErrorVector(sim, tx, ty, ix, iy) {
    const ex = tx - ix;
    const ey = ty - iy;
    const zc = 0.5 * ((Number.isFinite(sim.zcL) ? sim.zcL : 0) + (Number.isFinite(sim.zcR) ? sim.zcR : 0));
    const ez = -zc * M2W; // 画面上の時間軸は world z。+z=再生済み側。
    this.errorVectorState = {
      lNm: (ex * U_L.x + ey * U_L.y) * 1000,
      rNm: (ex * U_R.x + ey * U_R.y) * 1000,
      lWallUm: ex * N_L.x + ey * N_L.y,
      rWallUm: ex * N_R.x + ey * N_R.y,
      tUm: ez,
      tSec: ez * 1e-6 / sim.grooveVel,
    };
  }

  // Molecular scale: shows a real-size PVC chain reference near the R-wall ruler anchor.
  // At 100k magnification and above, the "molecule sphere" is not rendered as a solid; only a reference circle of ~1.1nm remains.
  _updateMolecules(viewHalf, rulerOffset = null) {
    const show = !!this.p.showMolecules && viewHalf < MOLECULE_INDICATOR_VIEW_HALF;
    const showStructure = show && this.p.zoom >= MOLECULE_STRUCTURE_MIN_ZOOM;
    this.moleculeRim.visible = show && !showStructure;
    this.moleculeOutline.visible = showStructure;
    this.moleculeSphere.visible = show && !showStructure;
    this.moleculeHighlight.visible = show && !showStructure;
    this.moleculeLabel.visible = show;
    this.moleculeStructure.visible = showStructure;
    this.moleculeSphere.material.opacity = 1;
    this.moleculeRim.material.opacity = 0.52;
    if (!show) return;

    const SQ = Math.SQRT1_2;
    const nx = N_R.x, ny = N_R.y;             // R壁法線 (変調方向)
    const dc = dcContactUm(this.p);
    const bx = dc.t * SQ - nx * dc.indent;
    const by = dc.t * SQ - ny * dc.indent;
    const baseX = bx + (rulerOffset?.x ?? 0);
    const baseY = by + (rulerOffset?.y ?? 0);
    const z = rulerOffset?.z ?? 0;
    // Above 100k magnification, the margins and labels would occupy too much of the screen,
    // so that specific part is locked to the appearance at 100k. Molecule/atom sphere dimensions are not locked.
    const layoutViewHalf = Math.max(viewHalf, MOLECULE_LAYOUT_LOCK_VIEW_HALF);
    const layoutScale = Math.min(1, MOLECULE_LAYOUT_LOCK_ZOOM / Math.max(this.p.zoom, 1));

    const right = this._moleculeRight.set(ny, -nx, 0).normalize(); // Cross-section direction within R-wall surface
    if (!Number.isFinite(right.x)) right.set(SQ, SQ, 0);
    const normal = this._moleculeAxisZ.set(nx, ny, 0).normalize(); // R-wall normal = R-ruler axis
    const alignToRRuler = !!this.p.showRulerR;
    const axisX = alignToRRuler
      ? this._moleculeAxisX.copy(normal)
      : this._moleculeAxisX.set(0, 0, 1);
    const axisZ = this._moleculeAxisY.copy(alignToRRuler ? right : normal);
    const axisY = this._moleculeAxisZ.crossVectors(axisZ, axisX).normalize();
    const moleculeBasis = this._moleculeMatrix.makeBasis(axisX, axisY, axisZ);

    this.camera.updateMatrixWorld();
    const up = this._moleculeUp.setFromMatrixColumn(this.camera.matrixWorld, 1);
    const gap = Math.max(layoutViewHalf * 0.14, MOLECULE_R_UM * 3.5) * layoutScale;
    const x = baseX + nx * MOLECULE_R_UM + right.x * gap;
    const y = baseY + ny * MOLECULE_R_UM + right.y * gap;
    const zPos = z;

    this.moleculeRim.position.set(x, y, zPos);
    this.moleculeRim.scale.setScalar(MOLECULE_R_UM * 1.14);
    this.moleculeOutline.position.set(x, y, zPos);
    this.moleculeOutline.quaternion.setFromRotationMatrix(moleculeBasis);
    this.moleculeOutline.scale.setScalar(MOLECULE_R_UM);
    this.moleculeSphere.position.set(x, y, zPos);
    this.moleculeSphere.scale.setScalar(MOLECULE_R_UM);
    this.moleculeHighlight.position.set(x, y, zPos)
      .addScaledVector(right, -MOLECULE_R_UM * 0.24)
      .addScaledVector(up, MOLECULE_R_UM * 0.28);
    this.moleculeHighlight.scale.setScalar(MOLECULE_R_UM * 0.14);

    const labelH = Math.max(layoutViewHalf * 0.055, MOLECULE_R_UM * 2.8) * layoutScale;
    const labelGap = Math.max(layoutViewHalf * 0.022, MOLECULE_R_UM * 1.2) * layoutScale;
    this.moleculeLabel.scale.set(labelH * this.moleculeLabel.userData.aspect, labelH, 1);
    this.moleculeLabel.position.set(x, y, zPos)
      .addScaledVector(up, -(MOLECULE_R_UM + labelGap + labelH * 0.55));

    if (showStructure) {
      this.moleculeStructure.position.set(x, y, zPos);
      this.moleculeStructure.quaternion.setFromRotationMatrix(moleculeBasis);
      this.moleculeStructure.scale.setScalar(NM_TO_UM);
    }
  }

  // Bit ruler: quantization scale along the wall normal (modulation axis) + current value marker.
  // Placement principles —
  //  - Local anchor = contact point assumed during DC static seating. For both L/R, 
  //    includes the same indentation d0 as physics.reseat() along the wall normal.
  //  - Ruler center on cross-section: fixed to DC contact point at low magnification,
  //    shifts toward current contact point at high magnification.
  //  - Scale grid is an absolute grid with the reference plane as 0 (displacement is directly readable).
  //    Rendering clips the grid to the view window [0±1.25 view] ∩ [±full scale] —
  //    the DC plane is always the center of the scale, and only the current value marker follows wall displacement.
  //  - Scale marks are oriented perpendicular to the axis on screen (normal × view direction) — readable from any angle.
  _updateRulers(groove, viewHalf, focusS, rulerOffset = null) {
    const p = this.p;
    const camDir = this._rulerDir.subVectors(this.camera.position, this.target).normalize();
    const FS = p.fullScaleDisp * M2W;        // Full scale [µm]
    const pxPerUm = this.pxPerUm || this.canvas.clientHeight / (2 * viewHalf);
    let bits = p.rulerBits;
    if (p.rulerAuto) {
      // Auto-scale with zoom: select bit count where tick interval is ~12px on screen
      bits = Math.round(Math.log2(2 * FS * pxPerUm / 12));
      bits = Math.max(2, Math.min(24, bits));
      this.autoBits = bits;
    }
    const q = 2 * FS / Math.pow(2, bits);    // 1LSB [µm]
    // Thin out minor ticks to ensure at least 5px spacing on screen (insurance for manual bit mode)
    let stepMul = 1;
    while (q * stepMul * pxPerUm < 5 && stepMul < 1 << 20) stepMul <<= 1;
    const qs = q * stepMul;
    const minorBits = bits - Math.log2(stepMul);
    const majorBits = minorBits - 4;
    const majorStep = qs * 16;
    const showMinorTicks = minorBits >= 1;
    const showMajorTicks = majorBits >= 1;
    const showAnyTicks = showMinorTicks || showMajorTicks;
    // If major lines are as coarse as 1 bit, prevent the axis from extending beyond the peak (±FS).
    // At 1 bit, major line interval = FS, so total axis length is at most 2 ticks.
    const axisHalfLimit = majorBits <= 1 ? Math.min(FS, majorStep) : FS * 1.02;
    const dcContact = dcContactUm(p);
    const offX = rulerOffset?.x ?? 0;
    const offY = rulerOffset?.y ?? 0;
    const offZ = rulerOffset?.z ?? 0;
    const showError = !!(p.showGhost && this.errorVectorState && p.zoom >= ERROR_LR_MIN_ZOOM);
    let visibleTickRulers = 0;

    for (const [wall, ruler, show] of [[0, this.rulerL, p.showRulerL], [1, this.rulerR, p.showRulerR]]) {
      const sign = wall === 0 ? -1 : 1;
      const SQ = Math.SQRT1_2;
      const nx = -sign * SQ, ny = SQ;          // 壁法線 (溝内側向き) = 変調方向
      const tx2 = sign * SQ, ty2 = SQ;         // 壁接線 (上向き)
      // 目盛り軸をほぼ軸方向から見ると投影が潰れるため、読めない状態では消す。
      const edgeOn = Math.abs(camDir.x * nx + camDir.y * ny) > RULER_AXIS_EDGE_ON_DOT;
      const readable = show && !edgeOn;
      ruler.major.visible = readable;          // 軸線は太線目盛りの有無に関わらず描く
      ruler.minor.visible = readable && showMinorTicks;
      ruler.marker.visible = readable;
      if (!readable) {
        this._hideRulerErrorOverlay(ruler.error);
        continue;
      }
      if (showAnyTicks) visibleTickRulers++;

      const tC = dcContact.t;
      const bx = sign * tC * SQ - nx * dcContact.indent + offX;
      const by = tC * SQ - ny * dcContact.indent + offY;
      const zR = offZ;

      // Tick mark orientation: normal × view direction (perpendicular to axis on screen). Use wall tangent when view ≈ normal.
      let ux = ny * camDir.z, uy = -nx * camDir.z, uz = nx * camDir.y - ny * camDir.x;
      const ul = Math.hypot(ux, uy, uz);
      if (ul > 0.2) { ux /= ul; uy /= ul; uz /= ul; }
      else { ux = tx2; uy = ty2; uz = 0; }

      // Rendering range (normal distance from reference plane): clip the view window to full scale
      const axisCenter = 0;
      const lo = Math.max(axisCenter - viewHalf * 1.25, -axisHalfLimit);
      const hi = Math.min(axisCenter + viewHalf * 1.25, axisHalfLimit);

      const wNow = groove.wallShiftVisual(wall, focusS) * M2W;

      const majPos = ruler.major.geometry.attributes.position.array;
      const minPos = ruler.minor.geometry.attributes.position.array;
      let mo = 0, no = 0;
      // Axis line (normal direction = modulation direction)
      majPos[mo++] = bx + nx * lo; majPos[mo++] = by + ny * lo; majPos[mo++] = zR;
      majPos[mo++] = bx + nx * hi; majPos[mo++] = by + ny * hi; majPos[mo++] = zR;
      const tickLen = Math.min(viewHalf * 0.06, 4);
      for (let k = Math.ceil(lo / qs); k <= Math.floor(hi / qs); k++) {
        const d = k * qs;
        const px = bx + nx * d, py = by + ny * d;
        // Major lines every 16 minor lines, origin (amplitude 0) is longer and emphasized
        const major = k % 16 === 0 && showMajorTicks;
        if (!major && !showMinorTicks) continue;
        const L = k === 0 && showMajorTicks ? tickLen * 2.9 : major ? tickLen * 1.8 : tickLen;
        const arr = major ? majPos : minPos;
        let off = major ? mo : no;
        if (off + 6 > arr.length) continue;
        arr[off++] = px - ux * L; arr[off++] = py - uy * L; arr[off++] = zR - uz * L;
        arr[off++] = px + ux * L; arr[off++] = py + uy * L; arr[off++] = zR + uz * L;
        if (major) mo = off; else no = off;
      }
      this._finishLines(ruler.major, mo);
      this._finishLines(ruler.minor, no);

      // Current value marker (absolute position of signal + roughness displacement, evaluated at focus position)
      const mkPos = ruler.marker.geometry.attributes.position.array;
      let ko = 0;
      const mx = bx + nx * wNow, my = by + ny * wNow;
      const ml = tickLen * 2.6;
      mkPos[ko++] = mx - ux * ml; mkPos[ko++] = my - uy * ml; mkPos[ko++] = zR - uz * ml;
      mkPos[ko++] = mx + ux * ml; mkPos[ko++] = my + uy * ml; mkPos[ko++] = zR + uz * ml;
      this._finishLines(ruler.marker, ko);

      const err = this.errorVectorState;
      if (showError && show && err) {
        const axis = new THREE.Vector3(nx, ny, 0);
        const base = new THREE.Vector3(bx, by, zR);
        const labelDir = new THREE.Vector3(ux, uy, uz);
        const deltaD = wall === 0 ? err.lWallUm : err.rWallUm;
        const label = wall === 0 ? 'ΔL' : 'ΔR';
        this._updateRulerErrorOnAxis(ruler.error, base, axis, 0, deltaD,
          viewHalf, label, labelDir, lo, hi);
      } else {
        this._hideRulerErrorOverlay(ruler.error);
      }
    }

    // Common legend at bottom-right: shows the actually rendered thin/thick line intervals converted to bits/SNR.
    if (visibleTickRulers === 0) {
      if (this.rulerLegend) this.rulerLegend.visible = false;
      return;
    }
    {
      const fmtQ = (um) => {
        const nm = um * 1000;
        return nm >= 1 ? nm.toFixed(1) + 'nm' : (nm * 1000).toFixed(0) + 'pm';
      };
      const fmtBit = bit => `${Math.abs(bit - Math.round(bit)) < 1e-6 ? Math.round(bit) : bit.toFixed(1)}bit`;
      const fmtSn = bit => (6.02 * bit + 1.76).toFixed(0);
      const textR = rt(p);
      const rows = [textR.bitLegendTitle];
      if (showMinorTicks) rows.push(`${textR.minorLine}: ${fmtBit(minorBits)} ${textR.equivalent} ${fmtQ(qs)}, ${textR.snEquivalent} ${fmtSn(minorBits)}dB`);
      if (showMajorTicks) rows.push(`${textR.majorLine}: ${fmtBit(majorBits)} ${textR.equivalent} ${fmtQ(qs * 16)}, ${textR.snEquivalent} ${fmtSn(majorBits)}dB (${textR.equals16Minor})`);
      const text = rows.join('\n');
      if (!this.rulerLegend || this.rulerLegend.userData.text !== text) {
        if (this.rulerLegend) { this.scene.remove(this.rulerLegend); disposeSprite(this.rulerLegend); }
        this.rulerLegend = makeTextSprite(text, '#d9d8cf');
        this.scene.add(this.rulerLegend);
      }
      this.rulerLegend.visible = true;
      this._placeScreenSprite(this.rulerLegend, 0.046, 0.055);
    }
  }

  // Time ruler: time scale along the travel axis (z). 0=stylus position, +: played side.
  // Automatically selects main tick intervals using the 1-2-5 series based on zoom.
  _buildTimeRuler() {
    const mkLine = (opacity) => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(4096 * 3), 3));
      const l = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
        color: 0xd9d8cf, transparent: true, opacity, depthTest: false,
      }));
      l.renderOrder = 7;
      l.frustumCulled = false;
      this.scene.add(l);
      return l;
    };
    this.timeRuler = {
      major: mkLine(0.85), minor: mkLine(0.35), labels: new Map(),
      error: this._makeRulerErrorOverlay(0xffc46c, '#ffc46c'),
    };
  }

  _updateTimeRuler(sim, viewHalf, rulerOffset = null, baseTarget = null) {
    const tr = this.timeRuler, p = this.p;
    const camDir = this._rulerDir.subVectors(this.camera.position, this.target).normalize();
    const edgeOn = Math.abs(camDir.z) > RULER_AXIS_EDGE_ON_DOT;
    const showError = !!(p.showGhost && this.errorVectorState && p.zoom >= ERROR_T_MIN_ZOOM);
    const show = !!(p.showTimeScale || showError) && !edgeOn;
    tr.major.visible = tr.minor.visible = show;
    if (!show) {
      for (const sp of tr.labels.values()) sp.visible = false;
      this._hideRulerErrorOverlay(tr.error);
      return;
    }
    const v = sim.grooveVel;
    const pxPerUm = this.pxPerUm || this.canvas.clientHeight / (2 * viewHalf);
    // Main tick interval: 1-2-5 series that results in ~150px on screen (time mode / distance mode)
    const lengthMode = p.timeScaleMode === 'length';
    const raw = lengthMode
      ? 150 / pxPerUm                  // [µm]
      : (150 / pxPerUm) * 1e-6 / v;    // [s]
    const pow = Math.pow(10, Math.floor(Math.log10(raw)));
    const m = raw / pow;
    const step = (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * pow;
    const sStep = lengthMode ? step : step * v * M2W; // 主目盛り間隔 [µm]
    const zSpan = viewHalf * 1.55;
    const offX = rulerOffset?.x ?? 0;
    const offY = rulerOffset?.y ?? 0;
    const offZ = rulerOffset?.z ?? 0;
    const baseX = baseTarget?.x ?? this.target.x - offX;
    const baseY = baseTarget?.y ?? this.target.y - offY;
    const baseZ = baseTarget?.z ?? this.target.z - offZ;
    const ax = baseX + offX;
    const ay = Math.min(LAND_Y + viewHalf * 0.08, baseY + viewHalf * 0.45) + offY;
    const az = baseZ + offZ;
    // Tick mark orientation: perpendicular to the screen baseline (z-axis) in the x-y plane (ẑ × view direction).
    // A fixed y-direction would overlap with the baseline when viewed from the front, making it unreadable.
    let ux = this.target.y - this.camera.position.y;
    let uy = this.camera.position.x - this.target.x;
    const ul = Math.hypot(ux, uy) || 1;
    ux /= ul; uy /= ul;
    const nMin = Math.ceil((baseZ - zSpan) / sStep), nMax = Math.floor((baseZ + zSpan) / sStep);
    const maj = tr.major.geometry.attributes.position.array;
    const min_ = tr.minor.geometry.attributes.position.array;
    let mo = 0, no = 0;
    // Baseline
    maj[mo++] = ax; maj[mo++] = ay; maj[mo++] = az - zSpan;
    maj[mo++] = ax; maj[mo++] = ay; maj[mo++] = az + zSpan;
    const tickL = viewHalf * 0.045;
    const sub = sStep / 5;
    for (let n = (nMin - 1) * 5; n <= (nMax + 1) * 5; n++) {
      const zBase = n * sub;
      if (zBase < baseZ - zSpan || zBase > baseZ + zSpan) continue;
      const z = zBase + offZ;
      const isMajor = n % 5 === 0;
      const L = isMajor ? tickL * (n === 0 ? 2.6 : 1.6) : tickL * 0.8;
      const arr = isMajor ? maj : min_;
      let o = isMajor ? mo : no;
      if (o + 6 > arr.length) continue;
      arr[o++] = ax - ux * L; arr[o++] = ay - uy * L; arr[o++] = z;
      arr[o++] = ax + ux * L; arr[o++] = ay + uy * L; arr[o++] = z;
      if (isMajor) mo = o; else no = o;
    }
    this._finishLines(tr.major, mo);
    this._finishLines(tr.minor, no);
    // Labels: not a legend, but relative time/distance from the stylus position (0) for each main tick.
    const wanted = [];
    const nCenter = 0;
    for (let n = nMin; n <= nMax; n++) {
      if (nMax - nMin > 2 && (n === nMin || n === nMax)) continue;
      if (Math.abs(n - nCenter) > 2) continue;
      const zBase = n * sStep;
      if (Math.abs(zBase - baseZ) > zSpan * 0.6) continue;
      const text = lengthMode ? fmtSignedLenUm(zBase, sStep) : fmtSignedTime(zBase * 1e-6 / v, step);
      wanted.push([`major:${n}`, text, zBase]);
    }
    const seen = new Set();
    for (const [key, text, zBase] of wanted) {
      const zPos = zBase + offZ;
      const labelD = tickL * 2.6;
      const pA = new THREE.Vector3(ax + ux * labelD, ay + uy * labelD, zPos).project(this.camera);
      const pB = new THREE.Vector3(ax - ux * labelD, ay - uy * labelD, zPos).project(this.camera);
      const useA = Math.abs(pA.x) + Math.abs(pA.y) <= Math.abs(pB.x) + Math.abs(pB.y);
      const pLabel = useA ? pA : pB;
      let sp = tr.labels.get(key);
      if (!sp || sp.userData.text !== text) {
        if (sp) { this.scene.remove(sp); sp.material.map.dispose(); }
        sp = makeTextSprite(text, '#d9d8cf', false);
        this.scene.add(sp);
        tr.labels.set(key, sp);
      }
      const lh = viewHalf * 0.045;
      const halfW = Math.max(this.viewWidth * 0.5, 1e-6);
      const halfH = Math.max(this.viewHeight * 0.5, 1e-6);
      const ndcHalfW = (lh * sp.userData.aspect * 0.9) / halfW;
      const ndcHalfH = (lh * 0.9) / halfH;
      if (Math.abs(pLabel.x) + ndcHalfW > 0.96 || Math.abs(pLabel.y) + ndcHalfH > 0.96) continue;
      seen.add(key);
      sp.visible = true;
      sp.scale.set(lh * sp.userData.aspect, lh, 1);
      const side = useA ? 1 : -1;
      sp.position.set(ax + ux * labelD * side, ay + uy * labelD * side, zPos);
    }
    for (const [key, sp] of tr.labels) {
      if (!seen.has(key)) {
        this.scene.remove(sp);
        sp.material.map.dispose();
        tr.labels.delete(key);
      }
    }

    const err = this.errorVectorState;
    if (showError && err) {
      this._updateRulerErrorOnAxis(tr.error,
        new THREE.Vector3(ax, ay, offZ),
        new THREE.Vector3(0, 0, 1),
        0,
        err.tUm,
        viewHalf,
        'Δt',
        new THREE.Vector3(ux, uy, 0),
        baseZ - zSpan,
        baseZ + zSpan);
    } else {
      this._hideRulerErrorOverlay(tr.error);
    }
  }

  _finishLines(lineObj, usedFloats) {
    const attr = lineObj.geometry.attributes.position;
    // 未使用部分は縮退させる
    lineObj.geometry.setDrawRange(0, usedFloats / 3);
    attr.needsUpdate = true;
  }

  _placeScreenSprite(sp, marginX, marginY) {
    this.camera.updateMatrixWorld();
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
    const forward = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 2).negate();
    const dist = this.camera.position.distanceTo(this.target);
    const vHalf = Math.tan(this.camera.fov * Math.PI / 360) * dist;
    const hHalf = vHalf * this.camera.aspect;
    const screenHalf = Math.min(hHalf, vHalf);
    const h = screenHalf * 0.052 * (sp.userData.heightRatio ?? 1);
    const w = h * sp.userData.aspect;
    const x = hHalf - w * 0.5 - hHalf * marginX;
    const y = -vHalf + h * 0.5 + vHalf * marginY;
    sp.scale.set(w, h, 1);
    sp.position.copy(this.camera.position)
      .addScaledVector(forward, dist)
      .addScaledVector(right, x)
      .addScaledVector(up, y);
  }

  // Dust particles: since the groove mesh is not deformed by dust (wallShiftVisual excludes dust),
  // these particle meshes are the only visual representation of the bumps felt by the stylus.
  // Shape and color change continuously based on amp (growth 0→1 upon appearance) 
  // and crush fraction c (0→1 from plastic indentation).
  _updateDust(groove, sS) {
    const seen = new Set();
    const EPS = 1e-3;
    for (const D of groove.dust) {
      seen.add(D);
      let m = this.dustMeshes.get(D);
      if (!m) {
        m = new THREE.Mesh(this.dustGeo, this.dustMat.clone());
        this.dustMeshes.set(D, m);
        this.scene.add(m);
      }
      const grow = Math.max(D.amp, EPS);
      if (D.wall === 2) {
        // Scratch: actual shape is included in groove mesh as gouge + burr via wallShiftVisual.
        // Auxiliary mesh only slightly improves visibility of transverse lips.
        const lip = Math.max(D.burr ?? D.h, 0.2e-6) * M2W * grow;
        m.position.set(0, 12 + lip * 0.18, (sS - D.s) * M2W);
        m.rotation.set(0, Math.atan2((D.skew ?? 0) * M2W * 2, 38), 0);
        m.scale.set(38, Math.max(lip, EPS), D.w * M2W * 2.4);
        m.material.color.set(GROOVE_COLOR);
      } else if (D.loc === 'land') {
        // On land: outside stylus path, remains intact and lying flat
        const sign = D.wall === 0 ? -1 : 1;
        const hN = Math.max(0.35 * D.h * M2W * grow, EPS);
        const aZ = Math.max(D.w * M2W, 0.6 * D.h * M2W) * grow;
        m.position.set(sign * (30 + D.landX * M2W), LAND_Y + hN, (sS - D.s) * M2W);
        m.quaternion.identity();
        m.scale.set(Math.max(D.kind === 'fiber' ? hN * 1.4 : aZ * 0.8, EPS), hN, Math.max(aZ, EPS));
        m.material.color.copy(this.dustCol[D.kind]);
      } else if (D.loc === 'bottom') {
        // At groove bottom: resting in V-shape (center height √2·h/2). Only large particles touch the stylus bottom and get crushed
        const c = groove.dustCrushFrac(D);
        const hV = Math.max(0.5 * D.h * M2W * grow * (1 - 0.85 * c), EPS);
        const aZ = Math.max(D.w * M2W, 0.6 * D.h * M2W) * grow * (1 + 0.4 * c);
        m.position.set(0, Math.SQRT2 * hV, (sS - D.s) * M2W);
        m.quaternion.identity();
        m.scale.set(Math.max(aZ * 0.9, EPS), hV, Math.max(aZ, EPS));
        m.material.color.copy(this.dustCol[D.kind]).lerp(this.dustColCrushed, c);
      } else {
        // Wall adhesion: placed at actual adhesion height t. Crush degree = actual plastic indentation × graze factor
        // (particles grazing the edge are partially deformed). Particles not touched by the stylus pass through intact
        const graze = D.h > 0 ? D.hFelt / D.h : 0;
        const c = groove.dustCrushFrac(D) * graze;
        const sign = D.wall === 0 ? -1 : 1;
        const SQ = Math.SQRT1_2;
        const wsh = groove.wallShiftVisual(D.wall, D.s) * M2W; // Wall surface excluding dust
        const t = D.t * M2W;
        const hN = Math.max(0.5 * D.h * M2W * grow * (1 - 0.85 * c), EPS); // 法線半径
        const aZ = Math.max(D.w * M2W, 0.6 * D.h * M2W) * grow * (1 + 0.4 * c);
        const nx = -sign * SQ, ny = SQ; // 壁法線 (溝内側向き)
        m.position.set(sign * t * SQ + nx * (wsh + hN),
          t * SQ + ny * (wsh + hN),
          (sS - D.s) * M2W);
        m.quaternion.setFromUnitVectors(UP, this._dustN.set(nx, ny, 0));
        m.scale.set(Math.max(D.kind === 'fiber' ? hN * 1.4 : aZ * 0.8, EPS), hN, Math.max(aZ, EPS));
        m.material.color.copy(this.dustCol[D.kind]).lerp(this.dustColCrushed, c);
      }
      m.visible = Math.abs((sS - D.s) * M2W) < this.viewExtentHalf * 3;
    }
    for (const [D, m] of this.dustMeshes) {
      if (!seen.has(D)) {
        this.scene.remove(m);
        m.material.dispose();
        this.dustMeshes.delete(D);
      }
    }
  }
}
