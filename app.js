import * as THREE from './vendor/three.module.min.js';
import { OrbitControls } from './vendor/addons/controls/OrbitControls.js';
import { RoomEnvironment } from './vendor/addons/environments/RoomEnvironment.js';
import { mergeGeometries } from './vendor/addons/utils/BufferGeometryUtils.js';
import { TILES, UNIT_INCHES, THICKNESS_INCHES } from './tiles.js';
import { STARTERS } from './starter-builds.js';

const $ = (s) => document.querySelector(s);
const V3 = THREE.Vector3;
const M4 = THREE.Matrix4;
const rad = (d) => (d * Math.PI) / 180;
const THICK = THICKNESS_INCHES / UNIT_INCHES;
const SAVE_KEY = 'tileWorkshop.build.v1';
const MODE_KEY = 'tileWorkshop.unlimited';

// ---------------------------------------------------------------------------
// Tile types: turn the parts list into shapes, edges and 3D geometry
// ---------------------------------------------------------------------------
function brickTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#16323a';
  g.fillRect(0, 0, 256, 256);
  g.fillStyle = '#f4f7f9';
  const rows = 4, h = 256 / rows, w = 128, gap = 7;
  for (let r = 0; r < rows; r++) {
    const shift = r % 2 ? -w / 2 : 0;
    for (let k = 0; k < 4; k++) {
      const x = shift + k * w + gap / 2, y = r * h + gap / 2;
      g.beginPath();
      g.roundRect(x, y, w - gap, h - gap, 12);
      g.fill();
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function buildType(def) {
  const u = (v) => v / UNIT_INCHES;
  let pts, mag, corners;
  switch (def.shape) {
    case 'square': { const s = u(def.size); pts = [[0, 0], [s, 0], [s, s], [0, s]]; break; }
    case 'triangle': { const b = u(def.base), h = u(def.height); pts = [[0, 0], [b, 0], [b / 2, h]]; break; }
    case 'rightTriangle': { const a = u(def.a), b = u(def.b); pts = [[0, 0], [a, 0], [0, b]]; break; }
    case 'quarter': {
      const r = u(def.radius), N = 16;
      pts = [[0, 0]];
      for (let i = 0; i <= N; i++) pts.push([r * Math.cos((i / N) * Math.PI / 2), r * Math.sin((i / N) * Math.PI / 2)]);
      mag = [0, pts.length - 1];
      corners = [pts[0], pts[1], pts[pts.length - 1]];
      break;
    }
    case 'polygon': pts = def.points.map((p) => [u(p[0]), u(p[1])]); mag = def.magnetEdges; break;
    default: throw new Error('Unknown shape: ' + def.shape);
  }
  const n = pts.length;
  if (!mag) mag = pts.map((_, i) => i);
  if (!corners) corners = pts;
  const edges = pts.map((a, i) => {
    const b = pts[(i + 1) % n];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    return { a, b, len: Math.hypot(dx, dy), ang: Math.atan2(dy, dx), mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], dx, dy };
  });
  // area centroid
  let A = 0, cx = 0, cy = 0;
  for (let i = 0; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n], cr = p[0] * q[1] - q[0] * p[1];
    A += cr; cx += (p[0] + q[0]) * cr; cy += (p[1] + q[1]) * cr;
  }
  const centroid = [cx / (3 * A), cy / (3 * A)];

  const shape = new THREE.Shape(pts.map((p) => new THREE.Vector2(p[0], p[1])));
  const bt = THICK * 0.22, bs = 0.014;
  const geom = new THREE.ExtrudeGeometry(shape, {
    depth: THICK - 2 * bt, bevelEnabled: true, bevelThickness: bt, bevelSize: bs, bevelOffset: -bs, bevelSegments: 2, curveSegments: 4,
  });
  geom.translate(0, 0, -THICK / 2 + bt);
  const edgeGeom = new THREE.EdgesGeometry(geom, 35);

  const color = new THREE.Color(def.color);
  let mats;
  if (def.pattern === 'brick') {
    mats = [
      new THREE.MeshStandardMaterial({ map: brickTexture(), roughness: 0.45 }),
      new THREE.MeshStandardMaterial({ color: 0x16323a, roughness: 0.5 }),
    ];
  } else {
    const m = new THREE.MeshPhysicalMaterial({
      color, transparent: true, opacity: 0.6, roughness: 0.06, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.12, envMapIntensity: 1.15,
      side: THREE.DoubleSide,
    });
    mats = [m, m];
  }
  const selMats = mats.map((m) => { const c = m.clone(); c.emissive = new THREE.Color(0x6b5200); return c; });
  const ghostMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.45, depthWrite: false, side: THREE.DoubleSide });
  const lineColor = def.pattern ? new THREE.Color(0x16323a) : color.clone().multiplyScalar(0.62);
  const tint = (hex, col) => mats.map((m) => { const c = m.clone(); c.emissive = new THREE.Color(hex); c.color = new THREE.Color(col); c.map = null; c.opacity = 0.82; c.transparent = true; return c; });
  const fallMats = tint(0x7a0014, 0xff2038), wobMats = tint(0x6a3c00, 0xffa21f);
  // magnets: little grey bars just inside each magnetic edge, like the real tiles
  const bars = [];
  for (const ei of mag) {
    const e = edges[ei], n = Math.max(2, Math.round(e.len * 2)), blen = Math.min(0.3, (e.len / n) * 0.6);
    for (let k = 0; k < n; k++) {
      const f = 0.15 + (0.7 * (k + 0.5)) / n, g = new THREE.BoxGeometry(blen, 0.05, THICK * 0.66);
      g.rotateZ(e.ang);
      g.translate(e.a[0] + e.dx * f - (e.dy / e.len) * 0.075, e.a[1] + e.dy * f + (e.dx / e.len) * 0.075, 0);
      bars.push(g);
    }
  }
  const barGeom = bars.length ? mergeGeometries(bars) : null;
  return { def, pts, edges, mag, corners, centroid, geom, edgeGeom, barGeom, flatGeom: new THREE.ShapeGeometry(shape), mats, selMats, fallMats, wobMats, ghostMat, lineColor };
}

const BAR_MAT = new THREE.MeshStandardMaterial({ color: 0x8a93a3, roughness: 0.45, metalness: 0.55 });
const TYPES = {};
for (const def of TILES) TYPES[def.id] = buildType(def);

// Counts are per shape, so any tile can be any colour. A tile remembers its own colour.
const PAINTS = ['#e3262e', '#ff8a1f', '#ffd21f', '#22c04a', '#12a9d6', '#1f3fd6', '#7a2fd0', '#f0329a'];
const lookCache = new Map();
function lookFor(type, hex) {
  if (!hex) return type;
  const key = type.def.id + hex;
  if (!lookCache.has(key)) {
    const color = new THREE.Color(hex);
    const mats = type.mats.map((m) => { const c = m.clone(); c.color = color; return c; });
    const selMats = mats.map((m) => { const c = m.clone(); c.emissive = new THREE.Color(0x6b5200); return c; });
    lookCache.set(key, { mats, selMats, lineColor: color.clone().multiplyScalar(0.62) });
  }
  return lookCache.get(key);
}
const lastPaint = {}; // the colour last chosen for each shape

// ---------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------
const canvas = $('#scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const tableGroup = new THREE.Group(), tilesGroup = new THREE.Group();
scene.add(tableGroup, tilesGroup);
const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 200);
const HOME_POS = new V3(3.2, 4.4, 6.2), HOME_TARGET = new V3(0, 0.5, 0);
camera.position.copy(HOME_POS);

const controls = new OrbitControls(camera, canvas);
controls.target.copy(HOME_TARGET);
controls.enableDamping = true;
controls.dampingFactor = 0.12;
controls.maxPolarAngle = Math.PI / 2 - 0.03;
controls.minDistance = 1.5;
controls.maxDistance = 40;
controls.update();

const hemiLight = new THREE.HemisphereLight(0xffffff, 0xb9c6d8, 0.55);
scene.add(hemiLight);
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(6, 14, 8);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -14, right: 14, top: 14, bottom: -14, near: 1, far: 40 });
sun.shadow.bias = -0.0005;
scene.add(sun);

const MAT_SIZE = 10;
const TABLE_W = MAT_SIZE * 2 + 0.8;
const table = new THREE.Mesh(
  new THREE.BoxGeometry(TABLE_W, 0.5, TABLE_W),
  new THREE.MeshStandardMaterial({ color: 0xdfe3e9, roughness: 0.95, envMapIntensity: 0.12 }),
);
table.position.y = -0.25;
table.receiveShadow = true;
tableGroup.add(table);
const grid = new THREE.GridHelper(MAT_SIZE * 2, MAT_SIZE * 2, 0x8a96a8, 0x8a96a8);
grid.position.y = 0.002;
tableGroup.add(grid);
for (const alongX of [true, false]) {
  const bar = new THREE.Mesh(
    new THREE.BoxGeometry(alongX ? MAT_SIZE * 2 : 0.05, 0.004, alongX ? 0.05 : MAT_SIZE * 2),
    new THREE.MeshBasicMaterial({ color: 0x39445a }),
  );
  bar.position.y = 0.004;
  tableGroup.add(bar);
}

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

// ---------------------------------------------------------------------------
// Build state
// A tile is either on the table (parent == null, with x, z, yaw) or snapped to
// an edge of another tile (parent, pEdge). cEdge is the tile's own edge that
// forms the hinge, angle is the tilt about that hinge.
// ---------------------------------------------------------------------------
let state = { tiles: [], nextId: 1 };
let unlimited = false;
let history = [], hIndex = -1;
let byId = new Map();
let worlds = new Map();
let selectedId = null;
let held = null; // { type, cEdge, flip, yaw }
let ghostPlacement = null;
let standMode = true; // new tiles come in standing up (true) or lying flat (false)
let dragExclude = new Set();
let dragTile = null;
let mode = 'edit'; // 'edit' = building, 'view' = looking at a saved (protected) build
let draft = null; // the workbench, kept safe while a saved build is open
let viewBuild = null;
const player = { order: [], step: 0, playing: false, speed: 1, anim: null, nextAt: 0, showArrow: false, arrowAt: null };

const rotX = (a) => new M4().makeRotationX(a);
const rotY = (a) => new M4().makeRotationY(a);

function childLocal(type, cEdge, flip, offset) {
  const e = type.edges[cEdge];
  const m = new M4().makeTranslation(offset, 0, 0);
  if (flip) m.multiply(rotY(Math.PI));
  m.multiply(new M4().makeRotationZ(-e.ang));
  m.multiply(new M4().makeTranslation(-e.mid[0], -e.mid[1], 0));
  return m;
}

function edgeFrame(type, i) {
  const e = type.edges[i];
  const dx = e.dx / e.len, dy = e.dy / e.len;
  return new M4().makeBasis(new V3(-dx, -dy, 0), new V3(dy, -dx, 0), new V3(0, 0, 1)).setPosition(e.mid[0], e.mid[1], 0);
}

function parity(t) {
  let p = 0;
  while (t) { if (t.flip) p ^= 1; t = t.parent != null ? byId.get(t.parent) : null; }
  return p;
}

function hingeOffset(t, parentTile) {
  if (!parentTile) return 0;
  const lp = TYPES[parentTile.type].edges[t.pEdge].len, lc = TYPES[t.type].edges[t.cEdge].len;
  return (t.align || 0) * (lp - lc) / 2;
}

function worldFor(t, parentWorld, parentTile) {
  const type = TYPES[t.type];
  let H, sign = 1;
  if (parentTile) {
    H = parentWorld.clone().multiply(edgeFrame(TYPES[parentTile.type], t.pEdge));
    if (parity(parentTile)) sign = -1;
  } else {
    H = new M4().makeTranslation(t.x, THICK / 2, t.z).multiply(rotY(t.yaw || 0)).multiply(rotX(-Math.PI / 2));
  }
  return H.multiply(rotX(rad(t.angle || 0) * sign)).multiply(childLocal(type, t.cEdge, t.flip, hingeOffset(t, parentTile)));
}

function worldOfLoose(t) { // for ghosts and what-if maths; t need not be in state
  const p = t.parent != null ? byId.get(t.parent) : null;
  return worldFor(t, p ? worlds.get(p.id) : null, p);
}

function computeWorlds() {
  byId = new Map(state.tiles.map((t) => [t.id, t]));
  worlds = new Map();
  const get = (t) => {
    if (worlds.has(t.id)) return worlds.get(t.id);
    const p = t.parent != null ? byId.get(t.parent) : null;
    const w = worldFor(t, p ? get(p) : null, p);
    worlds.set(t.id, w);
    return w;
  };
  state.tiles.forEach(get);
}

const centroidWorld = (type, W) => new V3(type.centroid[0], type.centroid[1], 0).applyMatrix4(W);

function subtreeIds(id) {
  const out = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const t of state.tiles) if (t.parent != null && out.has(t.parent) && !out.has(t.id)) { out.add(t.id); grew = true; }
  }
  return out;
}

function usedCount(typeId) { return state.tiles.reduce((n, t) => n + (t.type === typeId ? 1 : 0), 0); }
function remaining(typeId) { return unlimited ? Infinity : owned(typeId) - usedCount(typeId); }

// ---------------------------------------------------------------------------
// Scene objects for tiles
// ---------------------------------------------------------------------------
const tileObjects = new Map(); // id -> group
const pickables = [];

function makeTileObject(type, ghost) {
  const g = new THREE.Group();
  g.matrixAutoUpdate = false;
  const mesh = new THREE.Mesh(type.geom, ghost ? type.ghostMat : type.mats);
  mesh.castShadow = !ghost;
  const lines = new THREE.LineSegments(type.edgeGeom, new THREE.LineBasicMaterial({ color: ghost ? 0xffffff : type.lineColor }));
  g.add(mesh, lines);
  if (!ghost && type.barGeom) g.add(new THREE.Mesh(type.barGeom, BAR_MAT));
  g.userData = { mesh, lines, type };
  return g;
}

function setMatrix(obj, W) { obj.matrix.copy(W); obj.matrixWorldNeedsUpdate = true; }

function makeHingeMarker(color) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 1, 10), new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95 }));
  m.renderOrder = 10;
  m.visible = false;
  scene.add(m);
  return m;
}
function placeHinge(marker, a, b) {
  marker.position.copy(a).add(b).multiplyScalar(0.5);
  marker.scale.set(1, a.distanceTo(b), 1);
  marker.quaternion.setFromUnitVectors(new V3(0, 1, 0), b.clone().sub(a).normalize());
  marker.visible = true;
}
const snapMarker = makeHingeMarker(0xffffff);
const selMarker = makeHingeMarker(0xffc21a);

let ghostObj = null;
function setGhost(placement) {
  ghostPlacement = placement;
  if (!placement) { if (ghostObj) ghostObj.visible = false; snapMarker.visible = false; return; }
  const type = TYPES[placement.type];
  if (!ghostObj || ghostObj.userData.type !== type) {
    if (ghostObj) scene.remove(ghostObj);
    ghostObj = makeTileObject(type, true);
    scene.add(ghostObj);
  }
  ghostObj.visible = true;
  setMatrix(ghostObj, worldOfLoose(placement));
}

function updateTransforms() {
  computeWorlds();
  for (const t of state.tiles) {
    const o = tileObjects.get(t.id);
    if (o) { setMatrix(o, worlds.get(t.id)); if (mode === 'edit') o.visible = true; }
  }
  const sel = selectedId != null ? byId.get(selectedId) : null;
  if (sel) {
    const e = TYPES[sel.type].edges[sel.cEdge], W = worlds.get(sel.id);
    placeHinge(selMarker, new V3(e.a[0], e.a[1], 0).applyMatrix4(W), new V3(e.b[0], e.b[1], 0).applyMatrix4(W));
  } else selMarker.visible = false;
  scene.updateMatrixWorld(true);
}

function syncObjects() {
  const live = new Set(state.tiles.map((t) => t.id));
  for (const [id, o] of tileObjects) {
    if (!live.has(id) || o.userData.type !== TYPES[byIdSafe(id)?.type]) { tilesGroup.remove(o); if (o.userData.shadow) shadowGroup.remove(o.userData.shadow); o.userData.lines.material.dispose(); tileObjects.delete(id); }
  }
  for (const t of state.tiles) {
    if (!tileObjects.has(t.id)) {
      const o = makeTileObject(TYPES[t.type], false);
      o.userData.mesh.userData.tileId = t.id;
      tileObjects.set(t.id, o);
      tilesGroup.add(o);
    }
    const o = tileObjects.get(t.id), type = TYPES[t.type], on = t.id === selectedId;
    const gs = gravityOn ? gravStatus.get(t.id) : null;
    const look = lookFor(type, t.color);
    o.userData.mesh.material = on ? look.selMats : gs === 'fall' ? type.fallMats : gs === 'wobbly' ? type.wobMats : look.mats;
    o.userData.lineColor = look.lineColor;
    o.userData.lines.material.color.set(on ? 0xffd54a : look.lineColor);
  }
  pickables.length = 0;
  for (const o of tileObjects.values()) pickables.push(o.userData.mesh);
}
function byIdSafe(id) { return state.tiles.find((t) => t.id === id); }

// ---------------------------------------------------------------------------
// History, saving
// ---------------------------------------------------------------------------
function save() { try { localStorage.setItem(SAVE_KEY, JSON.stringify(state)); } catch (e) { /* private mode etc. */ } }

function refresh() {
  if (selectedId != null && !byIdSafe(selectedId)) selectedId = null;
  tiltCtx = null;
  computeWorlds();
  gravStatus = gravityOn ? analyseGravity() : new Map();
  syncObjects();
  updateTransforms();
  renderTray();
  renderBar();
  renderGravity();
  if (lightMode === 'night') placeLamp();
  $('#undo').disabled = hIndex <= 0;
  $('#redo').disabled = hIndex >= history.length - 1;
}

function commit() {
  history = history.slice(0, hIndex + 1);
  history.push(JSON.stringify(state));
  if (history.length > 200) history.shift();
  hIndex = history.length - 1;
  save();
  refresh();
}

function travel(step) {
  const i = hIndex + step;
  if (i < 0 || i >= history.length) return;
  hIndex = i;
  state = JSON.parse(history[i]);
  save();
  refresh();
  refreshGhost();
}

// ---------------------------------------------------------------------------
// Sounds
// ---------------------------------------------------------------------------
let actx = null;
function blip(freq = 620, dur = 0.08, vol = 0.07) {
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    const o = actx.createOscillator(), g = actx.createGain(), t = actx.currentTime;
    o.type = 'triangle';
    o.frequency.setValueAtTime(freq, t);
    o.frequency.exponentialRampToValueAtTime(freq * 1.6, t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(actx.destination);
    o.start(t);
    o.stop(t + dur);
  } catch (e) { /* no audio */ }
}

// ---------------------------------------------------------------------------
// Pointer maths
// ---------------------------------------------------------------------------
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const groundPlane = new THREE.Plane(new V3(0, 1, 0), 0);

function setRay(x, y) {
  ndc.set((x / window.innerWidth) * 2 - 1, -(y / window.innerHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
}
function pickTile(x, y) {
  setRay(x, y);
  const hit = raycaster.intersectObjects(pickables, false).find((h) => h.object.parent.visible && !dragExclude.has(h.object.userData.tileId));
  return hit ? byId.get(hit.object.userData.tileId) : null;
}
function groundPoint(x, y) {
  setRay(x, y);
  const p = new V3();
  return raycaster.ray.intersectPlane(groundPlane, p) ? p : null;
}
function toScreen(v) {
  const p = v.clone().project(camera);
  if (p.z > 1 || p.z < -1) return null;
  return { x: (p.x + 1) / 2 * window.innerWidth, y: (1 - p.y) / 2 * window.innerHeight };
}
function distSeg(px, py, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy || 1e-9;
  const t = Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / l2));
  return { d: Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy)), t };
}

function nearestEdge(px, py, onlyTile, maxDist) {
  let best = null;
  for (const t of state.tiles) {
    if ((onlyTile && t !== onlyTile) || dragExclude.has(t.id)) continue;
    const type = TYPES[t.type], W = worlds.get(t.id);
    for (const ei of type.mag) {
      const e = type.edges[ei];
      const a = new V3(e.a[0], e.a[1], 0).applyMatrix4(W), b = new V3(e.b[0], e.b[1], 0).applyMatrix4(W);
      const sa = toScreen(a), sb = toScreen(b);
      if (!sa || !sb) continue;
      const r = distSeg(px, py, sa, sb);
      if (!best || r.d < best.d) best = { d: r.d, t: r.t, tile: t, ei, a, b };
    }
  }
  return best && best.d <= maxDist ? best : null;
}

// ---------------------------------------------------------------------------
// Holding a tile: where would it go?
// ---------------------------------------------------------------------------
let lastPointer = null;

function overlapsExisting(placement) {
  const c = centroidWorld(TYPES[placement.type], worldOfLoose(placement));
  for (const t of state.tiles) {
    if (!dragExclude.has(t.id) && centroidWorld(TYPES[t.type], worlds.get(t.id)).distanceTo(c) < 0.22) return true;
  }
  return false;
}

function computePlacement(x, y, isTouch, h = held) {
  if (!h) return null;
  const type = TYPES[h.type];
  const over = pickTile(x, y);
  const edge = over ? nearestEdge(x, y, over, Infinity) : nearestEdge(x, y, null, isTouch ? 54 : 38);
  if (edge) {
    const pType = TYPES[edge.tile.type];
    const lp = pType.edges[edge.ei].len, lc = type.edges[h.cEdge].len;
    let align = 0;
    if (Math.abs(lp - lc) > 0.02) {
      const want = -(edge.t - 0.5) * lp;
      let bestD = Infinity;
      for (const a of [-1, 0, 1]) { const d = Math.abs(a * (lp - lc) / 2 - want); if (d < bestD) { bestD = d; align = a; } }
    }
    const p = { type: h.type, parent: edge.tile.id, pEdge: edge.ei, cEdge: h.cEdge, flip: h.flip, align, angle: 0 };
    // "Stand up" mode: on the edge of a tile that is lying down, the new tile stands up like a wall
    let tries = [0, 90, -90, 180];
    if (h.stand) {
      const ny = new V3(0, 0, 1).transformDirection(worlds.get(edge.tile.id)).y;
      if (Math.abs(ny) > 0.9) { const upAngle = ny > 0 ? 90 : -90; tries = [upAngle, 0, -upAngle, 180]; }
    }
    for (const a of tries) { p.angle = a; if (!overlapsExisting(p)) break; }
    placeHinge(snapMarker, edge.a, edge.b);
    return p;
  }
  snapMarker.visible = false;
  const gp = groundPoint(x, y);
  if (!gp) return null;
  const p = { type: h.type, parent: null, x: 0, z: 0, yaw: h.yaw, cEdge: h.cEdge, flip: h.flip, angle: 0 };
  const c = centroidWorld(type, worldFor(p, null, null));
  const lim = MAT_SIZE - 1;
  p.x = Math.max(-lim, Math.min(lim, Math.round((gp.x - c.x) * 2) / 2));
  p.z = Math.max(-lim, Math.min(lim, Math.round((gp.z - c.z) * 2) / 2));
  if (h.stand) { // standing on its edge right where you point
    p.angle = 90;
    p.x = Math.max(-lim, Math.min(lim, Math.round(gp.x * 2) / 2));
    p.z = Math.max(-lim, Math.min(lim, Math.round(gp.z * 2) / 2));
  }
  return p;
}

function refreshGhost() {
  if (!held || !lastPointer) { setGhost(null); return; }
  setGhost(computePlacement(lastPointer.x, lastPointer.y, lastPointer.touch));
}

function hold(typeId) {
  if (mode !== 'edit') return;
  if (typeId && remaining(typeId) <= 0) { blip(180, 0.12); return; }
  held = typeId ? { type: typeId, cEdge: TYPES[typeId].mag[0], flip: false, yaw: 0, stand: standMode } : null;
  if (held) { selectedId = null; refresh(); hideHint(); }
  setGhost(null);
  renderTray();
  renderHand();
}

function placeHeld(isTouch) {
  if (!held || !ghostPlacement) return;
  if (remaining(held.type) <= 0) { hold(null); return; }
  const tile = { ...ghostPlacement, id: state.nextId++ };
  if (lastPaint[tile.type]) tile.color = lastPaint[tile.type];
  state.tiles.push(tile);
  blip(tile.parent != null ? 760 : 560);
  if (isTouch || remaining(held.type) <= 0) { held = null; selectedId = tile.id; setGhost(null); renderHand(); }
  commit();
  refreshGhost();
}

function heldTurn() {
  if (!held) return;
  if (ghostPlacement && ghostPlacement.parent == null) held.yaw = (held.yaw + rad(30)) % (Math.PI * 2);
  else { const mag = TYPES[held.type].mag; held.cEdge = mag[(mag.indexOf(held.cEdge) + 1) % mag.length]; }
  refreshGhost();
}
function heldFlip() { if (held) { held.flip = !held.flip; refreshGhost(); } }

// ---------------------------------------------------------------------------
// Selected tile actions
// ---------------------------------------------------------------------------
const selected = () => (selectedId != null ? byId.get(selectedId) : null);

function keepCentre(t, change) { // table tiles stay put while they turn or spin
  if (t.parent != null) { change(); return; }
  const type = TYPES[t.type];
  const c0 = centroidWorld(type, worldFor(t, null, null));
  change();
  const c1 = centroidWorld(TYPES[t.type], worldFor(t, null, null));
  t.x += c0.x - c1.x;
  t.z += c0.z - c1.z;
}

function actTurn() {
  const t = selected(); if (!t) return;
  const mag = TYPES[t.type].mag;
  if (mag.length < 2) { blip(180, 0.12); return; }
  keepCentre(t, () => { t.cEdge = mag[(mag.indexOf(t.cEdge) + 1) % mag.length]; });
  blip(500); commit();
}
function actFlip() {
  const t = selected(); if (!t) return;
  keepCentre(t, () => { t.flip = !t.flip; });
  blip(500); commit();
}
function actSlide() {
  const t = selected(); if (!t || t.parent == null) return;
  t.align = ((t.align || 0) + 2) % 3 - 1;
  blip(500); commit();
}
function actSpin() {
  const t = selected(); if (!t || t.parent != null) return;
  keepCentre(t, () => { t.yaw = ((t.yaw || 0) + rad(30)) % (Math.PI * 2); });
  blip(500); commit();
}
function actRemove() {
  const t = selected(); if (!t) return;
  const gone = subtreeIds(t.id);
  state.tiles = state.tiles.filter((x) => !gone.has(x.id));
  selectedId = null;
  blip(300, 0.12); commit();
}

// --- tilt with magnet snapping -------------------------------------------
let tiltCtx = null;
const SNAP_R = 0.2;

function beginTilt(t) {
  const skip = subtreeIds(t.id);
  const statics = [];
  for (const o of state.tiles) {
    if (skip.has(o.id)) continue;
    const W = worlds.get(o.id);
    for (const c of TYPES[o.type].corners) statics.push(new V3(c[0], c[1], 0).applyMatrix4(W));
  }
  const p = t.parent != null ? byId.get(t.parent) : null;
  // angles where one of this tile's points sits right above the middle of the tile it hangs from (pyramids)
  const special = [];
  if (p) {
    const pt = TYPES[p.type], inv = edgeFrame(pt, t.pEdge).invert();
    const pc = new V3(pt.centroid[0], pt.centroid[1], 0).applyMatrix4(inv);
    const local = childLocal(TYPES[t.type], t.cEdge, t.flip, hingeOffset(t, p));
    for (const c of TYPES[t.type].corners) {
      const v = new V3(c[0], c[1], 0).applyMatrix4(local);
      if (v.y > 0.05 && Math.abs(v.x - pc.x) < 0.06 && Math.abs(pc.y) < v.y) {
        const a = Math.acos(pc.y / v.y) * 180 / Math.PI;
        special.push(a, -a);
      }
    }
  }
  tiltCtx = { id: t.id, statics, special, parent: p, parentWorld: p ? worlds.get(p.id) : null, start: t.angle || 0, last: null };
}

function tiltScore(t, angle) {
  const keep = t.angle;
  t.angle = angle;
  const W = worldFor(t, tiltCtx.parentWorld, tiltCtx.parent);
  t.angle = keep;
  let s = 0;
  const v = new V3();
  for (const c of TYPES[t.type].corners) {
    v.set(c[0], c[1], 0).applyMatrix4(W);
    let dm = Infinity;
    for (const sv of tiltCtx.statics) { const d = v.distanceToSquared(sv); if (d < dm) dm = d; }
    s += Math.max(0, SNAP_R - Math.sqrt(dm));
  }
  return s;
}

function snapTilt(t, raw) {
  let best = raw, bestS = -1, minS = Infinity;
  for (let a = raw - 8; a <= raw + 8; a += 0.5) {
    const s = tiltScore(t, a);
    if (s > bestS + 1e-9) { bestS = s; best = a; }
    if (s < minS) minS = s;
  }
  if (bestS - minS > 0.04) {
    let fine = best, fineS = bestS;
    for (let a = best - 0.5; a <= best + 0.5; a += 0.05) { const s = tiltScore(t, a); if (s > fineS) { fineS = s; fine = a; } }
    return { angle: Math.round(fine * 100) / 100, magnet: true };
  }
  for (const a of tiltCtx.special) if (Math.abs(a - raw) <= 5) return { angle: Math.round(a * 100) / 100, magnet: true };
  const near = Math.round(raw / 15) * 15;
  if (Math.abs(near - raw) <= 4) return { angle: near, magnet: false };
  return { angle: raw, magnet: false };
}

function onTiltInput() {
  const t = selected(); if (!t) return;
  if (!tiltCtx || tiltCtx.id !== t.id) beginTilt(t);
  const r = snapTilt(t, Number($('#tilt').value));
  if (r.angle !== t.angle) {
    t.angle = r.angle;
    const key = (r.magnet ? 'm' : 's') + r.angle;
    if ((r.magnet || r.angle % 15 === 0) && tiltCtx.last !== key) blip(r.magnet ? 900 : 440, 0.05, r.magnet ? 0.08 : 0.035);
    tiltCtx.last = key;
    updateTransforms();
  }
}
function onTiltDone() {
  const t = selected(); if (!t || !tiltCtx) return;
  const changed = tiltCtx.start !== t.angle;
  tiltCtx = null;
  if (changed) commit(); else renderBar();
}

// ---------------------------------------------------------------------------
// UI rendering
// ---------------------------------------------------------------------------
function thumbSVG(type) {
  const xs = type.pts.map((p) => p[0]), ys = type.pts.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const s = 56 / Math.max(x1 - x0, y1 - y0, 1.45), w = (x1 - x0) * s, h = (y1 - y0) * s;
  const pts = type.pts.map((p) => `${(33 - w / 2 + (p[0] - x0) * s).toFixed(1)},${(33 + h / 2 - (p[1] - y0) * s).toFixed(1)}`).join(' ');
  const col = type.def.color, line = '#' + type.lineColor.getHexString();
  const fill = type.def.pattern ? col : col;
  const op = type.def.pattern ? 1 : 0.8;
  return `<svg viewBox="0 0 66 66"><polygon points="${pts}" fill="${fill}" fill-opacity="${op}" stroke="rgba(255,255,255,0.8)" stroke-width="2.5" stroke-linejoin="round"/></svg>`;
}

const cardsEl = $('#cards');
const cardEls = {};
function buildTray() {
  for (const def of TILES) {
    const el = document.createElement('button');
    el.className = 'card';
    el.title = def.name;
    el.innerHTML = thumbSVG(TYPES[def.id]) + '<span class="badge"></span>';
    el.dataset.type = def.id;
    cardsEl.appendChild(el);
    cardEls[def.id] = el;
    el.addEventListener('pointerdown', (e) => startCardPress(e, def.id));
    el.addEventListener('click', () => alongPick(def.id));
  }
}
function renderTray() {
  $('#usedCount').textContent = state.tiles.length ? state.tiles.length + (mode === 'view' ? ' tiles' : ' used') : '';
  if (mode === 'view') { renderNeeded(); return; }
  for (const def of TILES) {
    cardEls[def.id].style.display = '';
    cardEls[def.id].classList.remove('over');
    const el = cardEls[def.id], left = remaining(def.id);
    el.querySelector('.badge').textContent = unlimited ? '∞' : String(Math.max(0, left));
    el.classList.toggle('empty', left <= 0);
    el.classList.toggle('held', !!held && held.type === def.id);
  }
  const m = $('#mode');
  m.textContent = unlimited ? '∞ Unlimited' : 'Only mine';
  m.classList.toggle('unlimited', unlimited);
}
function renderHand() {
  $('#hand').classList.toggle('on', !!held);
  if (held) $('#handName').textContent = TYPES[held.type].def.name;
}
function renderBar() {
  const t = selected();
  $('#bar').classList.toggle('on', !!t && !held && mode === 'edit');
  if (!t || held || mode !== 'edit') $('#paintPop').classList.remove('on');
  if (!t) return;
  $('#tilt').value = String(Math.round(t.angle || 0));
  const p = t.parent != null ? byId.get(t.parent) : null;
  const canSlide = !!p && Math.abs(TYPES[p.type].edges[t.pEdge].len - TYPES[t.type].edges[t.cEdge].len) > 0.02;
  $('#slide').hidden = !canSlide;
  $('#spin').hidden = !!p;
  $('#turn').hidden = TYPES[t.type].mag.length < 2;
}
let hintGone = false;
function hideHint() { if (!hintGone) { hintGone = true; $('#hint').classList.add('off'); } }

// ---------------------------------------------------------------------------
// Tray: tap to pick up, or drag straight onto the table
// ---------------------------------------------------------------------------
let cardPress = null;
function startCardPress(e, typeId) {
  if (mode !== 'edit') return;
  cardPress = { typeId, x: e.clientX, y: e.clientY, dragging: false, touch: e.pointerType !== 'mouse', pid: e.pointerId };
}
window.addEventListener('pointermove', (e) => {
  if (!cardPress || e.pointerId !== cardPress.pid) return;
  if (!cardPress.dragging && Math.hypot(e.clientX - cardPress.x, e.clientY - cardPress.y) > 12) {
    cardPress.dragging = true;
    if (!held || held.type !== cardPress.typeId) hold(cardPress.typeId);
  }
  if (cardPress.dragging && held) {
    const overScene = document.elementFromPoint(e.clientX, e.clientY) === canvas;
    lastPointer = overScene ? { x: e.clientX, y: e.clientY, touch: cardPress.touch } : null;
    refreshGhost();
    dragChipAt(e.clientX, e.clientY, !overScene, cardPress.typeId);
  }
});
window.addEventListener('pointerup', (e) => {
  if (!cardPress || e.pointerId !== cardPress.pid) return;
  const cp = cardPress;
  cardPress = null;
  dragChipAt(0, 0, false);
  if (!cp.dragging) { hold(held && held.type === cp.typeId ? null : cp.typeId); return; }
  if (held && ghostPlacement) placeHeld(cp.touch);
  else if (cp.touch) hold(null);
});
window.addEventListener('pointercancel', (e) => {
  if (cardPress && e.pointerId === cardPress.pid) { if (cardPress.dragging) hold(null); cardPress = null; dragChipAt(0, 0, false); }
});

// ---------------------------------------------------------------------------
// Scene pointer handling
// ---------------------------------------------------------------------------
let press = null;

window.addEventListener('pointerdown', (e) => { // on the window so it always runs before the camera controls
  if (e.target !== canvas) return;
  closePops();
  $('#paintPop').classList.remove('on');
  if (mode !== 'edit' || fxBusy) { press = null; return; }
  press = { x: e.clientX, y: e.clientY, moved: false, pid: e.pointerId, touch: e.pointerType !== 'mouse', button: e.button, grab: null };
  if (held) {
    if (press.touch) {
      controls.enabled = false;
      lastPointer = { x: e.clientX, y: e.clientY, touch: true };
      refreshGhost();
    }
    return;
  }
  // a selected tile can be picked up and carried somewhere else
  const hit = pickTile(e.clientX, e.clientY);
  if (hit && selectedId != null && e.button === 0 && subtreeIds(selectedId).has(hit.id)) { // the selected tile, or anything built on it
    press.grab = byId.get(selectedId);
    controls.enabled = false;
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* not a real pointer */ }
  }
}, { capture: true });

canvas.addEventListener('pointermove', (e) => {
  if (press && e.pointerId === press.pid && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 8) press.moved = true;
  const touch = e.pointerType !== 'mouse';
  if (dragTile) { moveTileDrag(e.clientX, e.clientY, touch); return; }
  if (press && press.grab && press.moved) { startTileDrag(press.grab); moveTileDrag(e.clientX, e.clientY, touch); return; }
  if (held && !cardPress) {
    if (touch && !press) return;
    lastPointer = { x: e.clientX, y: e.clientY, touch };
    refreshGhost();
  }
});

function endPress(e, cancelled) {
  const p = press;
  press = null;
  controls.enabled = true;
  if (dragTile) { endTileDrag(e.clientX, e.clientY, cancelled); return; }
  if (!p || cancelled) return;
  if (held) {
    if (p.touch) placeHeld(true);
    else if (!p.moved && p.button === 0) { lastPointer = { x: e.clientX, y: e.clientY, touch: false }; refreshGhost(); placeHeld(false); }
    return;
  }
  if (!p.moved && p.button === 0) {
    const hit = pickTile(e.clientX, e.clientY);
    const id = hit ? hit.id : null;
    if (id !== selectedId) { selectedId = id; if (id != null) { blip(480, 0.04, 0.04); hideHint(); } refresh(); }
  }
}
canvas.addEventListener('pointerup', (e) => endPress(e, false));
canvas.addEventListener('pointercancel', (e) => endPress(e, true));
canvas.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse' && held && !cardPress) { lastPointer = null; setGhost(null); } });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

// ---------------------------------------------------------------------------
// Buttons and keys
// ---------------------------------------------------------------------------
$('#undo').onclick = () => travel(-1);
$('#redo').onclick = () => travel(1);
$('#home').onclick = () => { if (mode === 'view') fitCamera(camera, controls); else { camera.position.copy(HOME_POS); controls.target.copy(HOME_TARGET); controls.update(); } };
$('#clear').onclick = () => { if (!state.tiles.length) return; state.tiles = []; selectedId = null; blip(260, 0.15); commit(); };
$('#mode').onclick = () => {
  unlimited = !unlimited;
  try { localStorage.setItem(MODE_KEY, unlimited ? '1' : '0'); } catch (e) { /* ignore */ }
  if (held && remaining(held.type) <= 0) hold(null);
  renderTray();
};
$('#handTurn').onclick = heldTurn;
$('#handFlip').onclick = heldFlip;
$('#handDrop').onclick = () => hold(null);
$('#turn').onclick = actTurn;
$('#flip').onclick = actFlip;
$('#slide').onclick = actSlide;
$('#spin').onclick = actSpin;
$('#remove').onclick = actRemove;
$('#tilt').addEventListener('input', onTiltInput);
$('#tilt').addEventListener('change', onTiltDone);

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement && e.key !== 'Escape') return;
  const k = e.key.toLowerCase();
  if (fxBusy) return;
  if (mode === 'view') { viewKey(e, k); return; }
  if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); travel(e.shiftKey ? 1 : -1); }
  else if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); travel(1); }
  else if (k === 's') { setStand(!standMode); }
  else if (k === 'r') { held ? heldTurn() : actTurn(); }
  else if (k === 'f') { held ? heldFlip() : actFlip(); }
  else if (k === 'delete' || k === 'backspace') { actRemove(); }
  else if (k === 'escape') { if (held) hold(null); else if (selectedId != null) { selectedId = null; refresh(); } }
});

// ---------------------------------------------------------------------------
// Background colour
// ---------------------------------------------------------------------------
const BG_KEY = 'tileWorkshop.background';
const BGS = {
  navy: { name: 'Navy', css: 'linear-gradient(180deg, #1c2c4f 0%, #0d1526 100%)', flat: '#14213d' },
  charcoal: { name: 'Charcoal', css: 'linear-gradient(180deg, #3b3e46 0%, #1e2025 100%)', flat: '#2b2e35' },
  cream: { name: 'Cream', css: 'linear-gradient(180deg, #f8f0dd 0%, #eee1c4 100%)', flat: '#f3e9d2' },
  sage: { name: 'Sage green', css: 'linear-gradient(180deg, #d6e5d4 0%, #b7ceb6 100%)', flat: '#c7dac6' },
  teal: { name: 'Teal', css: 'linear-gradient(180deg, #186474 0%, #0a343e 100%)', flat: '#12505d' },
};
let bgName = 'navy';
try { const b = localStorage.getItem(BG_KEY); if (b && BGS[b]) bgName = b; } catch (e) { /* ignore */ }
function applyBg(name) {
  if (name && BGS[name]) { bgName = name; try { localStorage.setItem(BG_KEY, name); } catch (e) { /* ignore */ } }
  document.body.style.background = BGS[bgName].css;
  for (const el of document.querySelectorAll('.swatch')) el.classList.toggle('on', el.dataset.bg === bgName);
}
for (const [key, b] of Object.entries(BGS)) {
  const el = document.createElement('button');
  el.className = 'swatch';
  el.dataset.bg = key;
  el.title = b.name;
  el.style.background = b.css;
  el.onclick = () => applyBg(key);
  $('#bgPop').appendChild(el);
}

let toastTimer = 0;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('on'), 2200);
}

// ---------------------------------------------------------------------------
// Saved builds (protected: open to look and play, "Edit a copy" to change)
// ---------------------------------------------------------------------------
const BUILDS_KEY = 'tileWorkshop.builds.v1';
let builds = [];
try { const b = JSON.parse(localStorage.getItem(BUILDS_KEY) || '[]'); if (Array.isArray(b)) builds = b; } catch (e) { builds = []; }
// Ready-made starter builds come from starter-builds.js. They are added once,
// refreshed when a newer version ships, and stay deleted if the user deletes them.
const GONE_KEY = 'tileWorkshop.startersRemoved';
let startersGone = [];
try { const g = JSON.parse(localStorage.getItem(GONE_KEY) || '[]'); if (Array.isArray(g)) startersGone = g; } catch (e) { startersGone = []; }
builds = builds.filter((b) => !b.starter || STARTERS.some((s) => s.id === b.id)); // drop starters that no longer ship
for (const s of STARTERS) {
  if (startersGone.includes(s.id)) continue;
  const have = builds.find((b) => b.id === s.id);
  if (have && have.rev === s.rev) continue;
  const fresh = { id: s.id, name: s.name, rev: s.rev, starter: true, tiles: s.tiles, nextId: s.nextId, thumb: null, savedAt: 0 };
  if (have) builds[builds.indexOf(have)] = fresh; else builds.push(fresh);
}
function ensureThumbs() { // draw pictures for builds that do not have one yet
  const todo = builds.filter((b) => !b.thumb);
  if (!todo.length || mode !== 'edit') return;
  const keep = state, keepSel = selectedId;
  selectedId = null;
  for (const b of todo) {
    state = { tiles: b.tiles.filter((t) => TYPES[t.type]), nextId: b.nextId };
    syncObjects();
    updateTransforms();
    b.thumb = snapshot();
  }
  state = keep;
  selectedId = keepSel;
  refresh();
  persistBuilds();
}
function persistBuilds() { try { localStorage.setItem(BUILDS_KEY, JSON.stringify(builds)); return true; } catch (e) { return false; } }

const cornersWorld = (t) => TYPES[t.type].corners.map((c) => new V3(c[0], c[1], 0).applyMatrix4(worlds.get(t.id)));

function fitCamera(cam, ctl, margin = 1.3) {
  const box = new THREE.Box3();
  for (const t of state.tiles) for (const c of cornersWorld(t)) box.expandByPoint(c);
  let c = HOME_TARGET.clone(), pos = HOME_POS.clone();
  if (!box.isEmpty()) {
    c = box.getCenter(new V3());
    const r = Math.max(1.3, box.getSize(new V3()).length() / 2);
    const dist = (r / Math.sin(rad(cam.fov / 2))) * (cam.aspect < 1 ? margin / cam.aspect : margin);
    pos = c.clone().add(new V3(0.42, 0.55, 0.72).normalize().multiplyScalar(dist));
  }
  cam.position.copy(pos);
  cam.lookAt(c);
  if (ctl) { ctl.target.copy(c); ctl.update(); }
}

function snapshot() {
  const cam = new THREE.PerspectiveCamera(40, 4 / 3, 0.1, 200);
  fitCamera(cam, null);
  cam.updateMatrixWorld(true);
  const hide = [ghostObj, snapMarker, selMarker, arrow].filter((o) => o && o.visible);
  hide.forEach((o) => { o.visible = false; });
  // render into a 4:3 viewport so the picture is not stretched
  const w = canvas.width, h = canvas.height;
  const vw = Math.min(w, Math.round(h * 4 / 3)), vh = Math.round(vw * 3 / 4);
  renderer.setViewport(0, 0, vw / renderer.getPixelRatio(), vh / renderer.getPixelRatio());
  renderer.setScissor(0, 0, vw / renderer.getPixelRatio(), vh / renderer.getPixelRatio());
  renderer.setScissorTest(true);
  renderer.clear();
  renderer.render(scene, cam);
  const out = document.createElement('canvas');
  out.width = 400; out.height = 300;
  const g = out.getContext('2d');
  g.fillStyle = '#dfe6f0';
  g.fillRect(0, 0, 400, 300);
  g.drawImage(canvas, 0, h - vh, vw, vh, 0, 0, 400, 300);
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, w / renderer.getPixelRatio(), h / renderer.getPixelRatio());
  hide.forEach((o) => { o.visible = true; });
  renderer.render(scene, camera);
  return out.toDataURL('image/jpeg', 0.82);
}

function saveCurrent() {
  if (mode !== 'edit') return;
  if (!state.tiles.length) { blip(180, 0.12); toast('Build something first'); return; }
  hold(null);
  selectedId = null;
  refresh();
  const b = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: 'Build ' + (builds.length + 1),
    tiles: JSON.parse(JSON.stringify(state.tiles)),
    nextId: state.nextId,
    thumb: snapshot(),
    savedAt: Date.now(),
  };
  builds.unshift(b);
  if (!persistBuilds()) { builds.shift(); toast('Could not save: storage is full'); return; }
  blip(880, 0.12);
  toast('Saved to My Builds');
  openBuild(b);
}

function openBuild(b) {
  along = null;
  if (mode === 'edit') draft = state;
  held = null;
  setGhost(null);
  selectedId = null;
  state = { tiles: JSON.parse(JSON.stringify(b.tiles)).filter((t) => TYPES[t.type]), nextId: b.nextId };
  mode = 'view';
  viewBuild = b;
  refresh();
  player.order = buildOrder();
  player.playing = false;
  player.anim = null;
  player.showArrow = false;
  gotoStep(player.order.length, false);
  fitCamera(camera, controls);
  renderMode();
}

function exitView() {
  if (mode !== 'view') return;
  along = null;
  setGhost(null);
  state = draft || { tiles: [], nextId: 1 };
  draft = null;
  mode = 'edit';
  viewBuild = null;
  player.playing = false;
  player.anim = null;
  arrow.visible = false;
  refresh();
  renderMode();
}

function editCopy() {
  if (mode !== 'view') return;
  along = null;
  setGhost(null);
  const copy = { tiles: JSON.parse(JSON.stringify(state.tiles)), nextId: state.nextId };
  draft = null;
  mode = 'edit';
  viewBuild = null;
  player.playing = false;
  player.anim = null;
  arrow.visible = false;
  state = copy;
  commit(); // the old workbench is still one Undo away
  renderMode();
  toast('This is a copy. The saved build is safe.');
}

function renderMode() {
  const view = mode === 'view';
  document.body.classList.toggle('view', view);
  $('#viewChip').classList.toggle('on', view);
  renderAlong();
  $('#alongBtn').hidden = $('#guideBtn').hidden = !view;
  $('#trayTitle').textContent = view ? 'Tiles needed' : 'My Tiles';
  if (view) $('#viewName').textContent = (stars[viewBuild.id] ? '★ ' : '') + viewBuild.name;
  renderHand();
  renderBar();
  renderTray();
  if (view) renderPlayer();
}

function renderNeeded() {
  const cur = !along && player.showArrow && player.step > 0 ? byId.get(player.order[player.step - 1]) : null;
  for (const def of TILES) {
    const el = cardEls[def.id], n = usedCount(def.id);
    el.style.display = n ? '' : 'none';
    el.querySelector('.badge').textContent = '×' + n;
    el.classList.remove('empty');
    el.classList.toggle('over', n > owned(def.id));
    el.classList.toggle('held', !!cur && cur.type === def.id);
    if (cur && cur.type === def.id) el.scrollIntoView({ block: 'nearest' });
  }
}

function renderShelf() {
  const gridEl = $('#shelfGrid');
  gridEl.textContent = '';
  $('#shelfEmpty').hidden = builds.length > 0;
  for (const b of builds) {
    const card = document.createElement('div');
    card.className = 'build';
    const pic = document.createElement('button');
    pic.className = 'pic';
    pic.title = 'Open';
    const img = document.createElement('img');
    img.src = b.thumb;
    img.alt = '';
    pic.appendChild(img);
    pic.onclick = () => { $('#shelf').classList.remove('on'); openBuild(b); };
    const row = document.createElement('div');
    row.className = 'row';
    const name = document.createElement('input');
    name.value = b.name;
    name.maxLength = 30;
    name.onchange = () => { b.name = name.value.trim() || 'Build'; name.value = b.name; persistBuilds(); if (viewBuild === b) $('#viewName').textContent = b.name; };
    const n = document.createElement('span');
    n.className = 'n';
    n.textContent = (stars[b.id] ? '★'.repeat(Math.min(3, stars[b.id])) + ' ' : '') + b.tiles.length + ' tiles';
    const del = document.createElement('button');
    del.className = 'del';
    del.title = 'Delete this build';
    del.innerHTML = '<svg class="ic" viewBox="0 0 24 24"><path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="m6 7 1 13h10l1-13"/></svg>';
    del.onclick = () => {
      if (!del.classList.contains('sure')) {
        del.classList.add('sure');
        del.textContent = 'Delete?';
        setTimeout(() => { if (del.isConnected) renderShelf(); }, 3000);
        return;
      }
      builds = builds.filter((x) => x !== b);
      if (b.starter) { startersGone.push(b.id); try { localStorage.setItem(GONE_KEY, JSON.stringify(startersGone)); } catch (e) { /* ignore */ } }
      persistBuilds();
      if (viewBuild === b) exitView();
      renderShelf();
    };
    row.append(name, n, del);
    card.append(pic, row);
    gridEl.appendChild(card);
  }
}

// ---------------------------------------------------------------------------
// Build player: shows a saved build going together one tile at a time
// ---------------------------------------------------------------------------
const arrow = new THREE.Group();
{
  const mk = (color, s, order) => {
    const mat = new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true });
    const head = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.34, 24), mat);
    head.rotation.x = Math.PI;
    head.position.y = 0.17;
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.42, 16), mat);
    shaft.position.y = 0.53;
    const g = new THREE.Group();
    g.add(head, shaft);
    g.scale.set(s, 1, s);
    head.renderOrder = shaft.renderOrder = order;
    return g;
  };
  const back = mk(0x1a2238, 1.35, 19);
  back.scale.y = 1.06;
  back.position.y = -0.02;
  arrow.add(back, mk(0xffc21a, 1, 20));
  arrow.visible = false;
  scene.add(arrow);
}

// Work out a sensible order from the finished build: table first, then up
// layer by layer, and outward from the middle. Every tile touches one that
// is already there.
function buildOrder() {
  const G = linkedGeos();
  if (!G.length) return [];
  const mid = G.reduce((a, g) => a.add(g.cen), new V3()).multiplyScalar(1 / G.length);
  for (const g of G) {
    g.level = Math.round(g.cen.y * 4);
    g.dist = Math.hypot(g.cen.x - mid.x, g.cen.z - mid.z);
    g.around = Math.atan2(g.cen.z - mid.z, g.cen.x - mid.x);
  }
  const better = (a, b) => a.level - b.level || a.dist - b.dist || a.around - b.around;
  const left = new Set(G), placed = new Set(), order = [];
  while (left.size) {
    let pick = null, loose = null;
    for (const g of left) {
      if (!loose || better(g, loose) < 0) loose = g;
      let ok = false;
      for (const l of g.links) if (placed.has(l.o)) { ok = true; break; }
      if (ok && (!pick || better(g, pick) < 0)) pick = g;
    }
    pick = pick || loose; // "loose" only when nothing left touches the build (a separate piece)
    left.delete(pick);
    placed.add(pick);
    order.push(pick.t.id);
  }
  return order;
}

function gotoStep(s, animate) {
  const N = player.order.length;
  s = Math.max(0, Math.min(N, s));
  player.step = s;
  player.anim = null;
  updateTransforms();
  const curId = s > 0 ? player.order[s - 1] : null;
  player.order.forEach((id, i) => {
    const o = tileObjects.get(id);
    if (!o) return;
    o.visible = i < s;
    o.userData.lines.material.color.set(player.showArrow && id === curId ? 0xffd54a : (o.userData.lineColor || o.userData.type.lineColor));
  });
  const now = performance.now();
  if (animate && curId != null) {
    player.anim = { id: curId, t0: now, dur: 520 / player.speed };
    blip(700, 0.07, 0.06);
  }
  player.nextAt = now + 1250 / player.speed;
  arrow.visible = player.showArrow && curId != null;
  if (arrow.visible) {
    const t = byId.get(curId);
    player.arrowAt = centroidWorld(TYPES[t.type], worlds.get(curId));
  }
  renderPlayer();
  renderNeeded();
  if (along) alongTarget(); else renderAlong();
}

function stepBy(d) {
  if (mode !== 'view') return;
  player.playing = false;
  player.showArrow = true;
  gotoStep(player.step + d, d > 0);
}

function togglePlay() {
  if (mode !== 'view') return;
  if (player.playing) { player.playing = false; renderPlayer(); return; }
  player.showArrow = true;
  if (player.step >= player.order.length) gotoStep(0, false);
  player.playing = true;
  player.nextAt = performance.now() + 350;
  renderPlayer();
}

function playerTick() {
  const now = performance.now();
  if (player.anim) {
    const k = Math.min(1, (now - player.anim.t0) / player.anim.dur), e = 1 - Math.pow(1 - k, 3);
    const o = tileObjects.get(player.anim.id), W = worlds.get(player.anim.id);
    if (o && W) setMatrix(o, new M4().makeTranslation(0, (1 - e) * 1.8, 0).multiply(W));
    if (k >= 1) player.anim = null;
  }
  if (player.playing && !player.anim && now >= player.nextAt) {
    if (player.step < player.order.length) gotoStep(player.step + 1, true);
    else { player.playing = false; player.showArrow = false; gotoStep(player.step, false); blip(990, 0.2, 0.07); }
  }
  if (arrow.visible && player.arrowAt) {
    const drop = player.anim ? (1 - Math.min(1, (now - player.anim.t0) / player.anim.dur)) * 1.8 : 0;
    arrow.position.copy(player.arrowAt);
    arrow.position.y += 0.16 + drop + Math.abs(Math.sin(now / 260)) * 0.16;
  }
}

function renderPlayer() {
  const N = player.order.length;
  $('#count').textContent = player.step + ' / ' + N;
  $('#scrub').max = String(Math.max(1, N));
  $('#scrub').value = String(player.step);
  $('#prev').disabled = player.step <= 0;
  $('#next').disabled = player.step >= N;
  $('#playIcon').innerHTML = player.playing ? '<path d="M8 5v14M16 5v14"/>' : '<path d="M7 4l13 8-13 8z"/>';
  $('#speed span').textContent = (player.speed === 0.5 ? '½' : player.speed) + '×';
}

function viewKey(e, k) {
  if (k === 'escape') { if ($('#shelf').classList.contains('on')) $('#shelf').classList.remove('on'); else exitView(); }
  else if (k === 'arrowright') { e.preventDefault(); stepBy(1); }
  else if (k === 'arrowleft') { e.preventDefault(); stepBy(-1); }
  else if (k === ' ') { e.preventDefault(); togglePlay(); }
}

const TRAY_KEY = 'tileWorkshop.trayHidden';
function setTrayHidden(h) {
  document.body.classList.toggle('trayHidden', h);
  try { localStorage.setItem(TRAY_KEY, h ? '1' : '0'); } catch (e) { /* ignore */ }
}
$('#trayHide').onclick = () => setTrayHidden(true);
$('#trayShow').onclick = () => setTrayHidden(false);
try { if (localStorage.getItem(TRAY_KEY) === '1') document.body.classList.add('trayHidden'); } catch (e) { /* ignore */ }
$('#save').onclick = saveCurrent;
$('#builds').onclick = () => { renderShelf(); $('#shelf').classList.add('on'); $('#bgPop').classList.remove('on'); };
$('#shelfClose').onclick = () => $('#shelf').classList.remove('on');
$('#shelf').addEventListener('pointerdown', (e) => { if (e.target === $('#shelf')) $('#shelf').classList.remove('on'); });
$('#editCopy').onclick = editCopy;
$('#backToBuild').onclick = exitView;
$('#prev').onclick = () => stepBy(-1);
$('#next').onclick = () => stepBy(1);
$('#play').onclick = togglePlay;
$('#speed').onclick = () => { player.speed = player.speed === 1 ? 2 : player.speed === 2 ? 0.5 : 1; renderPlayer(); };
$('#scrub').addEventListener('input', () => { player.playing = false; player.showArrow = true; gotoStep(Number($('#scrub').value), false); });
let tiltSign = 1;
$('#tiltSign').onclick = () => {
  tiltSign = -tiltSign;
  $('#tiltSign').textContent = tiltSign > 0 ? '+' : '−';
  const t = selected();
  if (t && t.angle) { tiltCtx = null; t.angle = -t.angle; blip(440, 0.05, 0.05); commit(); }
};
for (const b of document.querySelectorAll('[data-tilt]')) {
  b.onclick = () => {
    const t = selected();
    if (!t) return;
    tiltCtx = null;
    t.angle = tiltSign * Number(b.dataset.tilt);
    blip(440, 0.05, 0.05);
    commit();
  };
}

// ---------------------------------------------------------------------------
// Tile piles: named sets of tiles ("Our tiles", "Tiles from Mom's house").
// Switched-on piles are added together to give how many of each tile we have.
// ---------------------------------------------------------------------------
const PILES_KEY = 'tileWorkshop.piles.v1';
let piles = [];
try { const p = JSON.parse(localStorage.getItem(PILES_KEY) || '[]'); if (Array.isArray(p)) piles = p.filter((x) => x && x.counts); } catch (e) { piles = []; }
if (!piles.length) piles = [{ id: 'home', name: 'Our tiles', on: true, counts: Object.fromEntries(TILES.map((t) => [t.id, t.count])) }];
function persistPiles() { try { localStorage.setItem(PILES_KEY, JSON.stringify(piles)); } catch (e) { /* ignore */ } }
function owned(typeId) { return piles.reduce((n, p) => n + (p.on ? (p.counts[typeId] || 0) : 0), 0); }
const pileTotal = (p) => TILES.reduce((n, t) => n + (p.counts[t.id] || 0), 0);
let openPile = null;

function pilesChanged() {
  persistPiles();
  if (held && remaining(held.type) <= 0) hold(null);
  renderTray();
  const on = piles.filter((p) => p.on);
  const total = TILES.reduce((n, t) => n + owned(t.id), 0);
  $('#pilesSum').textContent = on.length ? `Building with ${on.map((p) => p.name).join(' + ')}: ${total} tiles` : 'No pile is switched on';
  if (gravityOn && mode === 'edit') refresh();
}

function renderPiles() {
  const list = $('#pilesList');
  list.textContent = '';
  for (const p of piles) {
    const el = document.createElement('div');
    el.className = 'pile' + (p.on ? ' use' : '') + (openPile === p.id ? ' open' : '');
    const head = document.createElement('div');
    head.className = 'pileHead';
    const sw = document.createElement('button');
    sw.className = 'switch' + (p.on ? ' on' : '');
    sw.title = 'Build with this pile';
    sw.onclick = () => { p.on = !p.on; pilesChanged(); renderPiles(); };
    const name = document.createElement('input');
    name.className = 'text';
    name.value = p.name;
    name.maxLength = 32;
    name.onchange = () => { p.name = name.value.trim() || 'Pile'; pilesChanged(); renderPiles(); };
    const tot = document.createElement('span');
    tot.className = 'tot';
    tot.textContent = pileTotal(p) + ' tiles';
    const edit = document.createElement('button');
    edit.className = 'pileBtn';
    edit.textContent = openPile === p.id ? 'Done' : 'Count tiles';
    edit.onclick = () => { openPile = openPile === p.id ? null : p.id; renderPiles(); };
    const del = document.createElement('button');
    del.className = 'del';
    del.title = 'Delete this pile';
    del.innerHTML = '<svg class="ic" viewBox="0 0 24 24"><path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="m6 7 1 13h10l1-13"/></svg>';
    del.hidden = piles.length < 2;
    del.onclick = () => {
      if (!del.classList.contains('sure')) { del.classList.add('sure'); del.textContent = 'Delete?'; setTimeout(() => { if (del.isConnected) renderPiles(); }, 3000); return; }
      piles = piles.filter((x) => x !== p);
      if (!piles.some((x) => x.on)) piles[0].on = true;
      pilesChanged();
      renderPiles();
    };
    head.append(sw, name, tot, edit, del);
    const grid = document.createElement('div');
    grid.className = 'pileGrid';
    for (const def of TILES) {
      const row = document.createElement('div');
      row.className = 'pc';
      row.title = def.name;
      row.innerHTML = thumbSVG(TYPES[def.id]);
      const input = document.createElement('input');
      input.type = 'number';
      input.min = '0';
      input.max = '999';
      input.inputMode = 'numeric';
      input.value = String(p.counts[def.id] || 0);
      const set = (v) => {
        p.counts[def.id] = Math.max(0, Math.min(999, Math.round(Number(v) || 0)));
        input.value = String(p.counts[def.id]);
        tot.textContent = pileTotal(p) + ' tiles';
        pilesChanged();
      };
      input.onchange = () => set(input.value);
      input.onfocus = () => input.select();
      const minus = document.createElement('button');
      minus.textContent = '−';
      minus.onclick = () => set((p.counts[def.id] || 0) - 1);
      const plus = document.createElement('button');
      plus.textContent = '+';
      plus.onclick = () => set((p.counts[def.id] || 0) + 1);
      row.append(minus, input, plus);
      grid.appendChild(row);
    }
    el.append(head, grid);
    list.appendChild(el);
  }
  pilesChanged();
}
$('#pilesBtn').onclick = () => { renderPiles(); $('#piles').classList.add('on'); };
$('#pilesClose').onclick = () => $('#piles').classList.remove('on');
$('#piles').addEventListener('pointerdown', (e) => { if (e.target === $('#piles')) $('#piles').classList.remove('on'); });
$('#pilesAdd').onclick = () => {
  const p = { id: Date.now().toString(36), name: 'New pile', on: true, counts: Object.fromEntries(TILES.map((t) => [t.id, 0])) };
  piles.push(p);
  openPile = p.id;
  renderPiles();
  $('#pilesList').scrollTop = $('#pilesList').scrollHeight;
};

// ---------------------------------------------------------------------------
// Shape helpers shared by the build player and the gravity check
// ---------------------------------------------------------------------------
function tileGeo(t) {
  const W = worlds.get(t.id), type = TYPES[t.type];
  if (type.radius == null) {
    type.radius = Math.max(...type.pts.map((p) => Math.hypot(p[0] - type.centroid[0], p[1] - type.centroid[1])));
    let a = 0;
    type.pts.forEach((p, i) => { const q = type.pts[(i + 1) % type.pts.length]; a += p[0] * q[1] - q[0] * p[1]; });
    type.area = Math.abs(a) / 2;
  }
  return {
    t, type,
    outline: type.pts.map((p) => new V3(p[0], p[1], 0).applyMatrix4(W)),
    corners: type.corners.map((p) => new V3(p[0], p[1], 0).applyMatrix4(W)),
    normal: new V3(0, 0, 1).transformDirection(W),
    cen: centroidWorld(type, W),
    links: [],
  };
}
const _ab = new V3(), _ap = new V3();
function distToSegment(p, a, b) {
  _ab.subVectors(b, a);
  const k = Math.max(0, Math.min(1, _ap.subVectors(p, a).dot(_ab) / (_ab.lengthSq() || 1e-9)));
  return _ap.copy(a).addScaledVector(_ab, k).distanceTo(p);
}
function distToOutline(p, g) {
  let d = Infinity;
  for (let i = 0; i < g.outline.length; i++) d = Math.min(d, distToSegment(p, g.outline[i], g.outline[(i + 1) % g.outline.length]));
  return d;
}
// where two tiles touch along their edges: null, or the two ends of the shared stretch
function contactLine(A, B) {
  if (A.cen.distanceTo(B.cen) > A.type.radius + B.type.radius + 0.12) return null;
  const pts = [];
  const add = (p) => { if (!pts.some((q) => q.distanceToSquared(p) < 0.01)) pts.push(p); };
  for (const p of A.corners) if (distToOutline(p, B) < 0.07) add(p);
  for (const p of B.corners) if (distToOutline(p, A) < 0.07) add(p);
  if (pts.length < 2) return null;
  let best = null, bd = -1;
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) { const d = pts[i].distanceToSquared(pts[j]); if (d > bd) { bd = d; best = [pts[i], pts[j]]; } }
  return best;
}
function linkedGeos() {
  const G = state.tiles.map(tileGeo);
  for (let i = 0; i < G.length; i++) {
    for (let j = i + 1; j < G.length; j++) {
      const A = G[i], B = G[j];
      let line = contactLine(A, B);
      if (!line && (A.t.parent === B.t.id || B.t.parent === A.t.id)) {
        const c = A.t.parent === B.t.id ? A : B, e = c.type.edges[c.t.cEdge], W = worlds.get(c.t.id);
        line = [new V3(e.a[0], e.a[1], 0).applyMatrix4(W), new V3(e.b[0], e.b[1], 0).applyMatrix4(W)];
      }
      if (line) { A.links.push({ o: B, a: line[0], b: line[1] }); B.links.push({ o: A, a: line[0], b: line[1] }); }
    }
  }
  return G;
}

// ---------------------------------------------------------------------------
// Gravity check: which tiles would fall, and which are only just holding on
// ---------------------------------------------------------------------------
let gravityOn = false;
let gravStatus = new Map(); // tile id -> 'fall' | 'wobbly'
try { gravityOn = localStorage.getItem('tileWorkshop.gravity') === '1'; } catch (e) { /* ignore */ }

function distToLine(p, a, b) {
  _ab.subVectors(b, a);
  const k = _ap.subVectors(p, a).dot(_ab) / (_ab.lengthSq() || 1e-9);
  return _ap.copy(a).addScaledVector(_ab, k).distanceTo(p);
}
function hull2D(points) { // convex hull of [x, z] pairs
  const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], hi = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo.at(-2), lo.at(-1), q) <= 0) lo.pop(); lo.push(q); }
  for (const q of p.slice().reverse()) { while (hi.length >= 2 && cross(hi.at(-2), hi.at(-1), q) <= 0) hi.pop(); hi.push(q); }
  return lo.slice(0, -1).concat(hi.slice(0, -1));
}
function insideHull(h, x, z, tol) {
  if (h.length < 3) return false;
  for (let i = 0; i < h.length; i++) {
    const a = h[i], b = h[(i + 1) % h.length];
    const ex = b[0] - a[0], ez = b[1] - a[1], len = Math.hypot(ex, ez) || 1e-9;
    if ((ex * (z - a[1]) - ez * (x - a[0])) / len < -tol) return false;
  }
  return true;
}

function analyseGravity() {
  const out = new Map();
  const G = linkedGeos();
  for (const g of G) {
    g.ground = g.corners.filter((c) => c.y < 0.1);
    g.flat = g.ground.length >= 3;
    g.wob = false;
  }
  const S = new Set(G);
  for (let pass = 0; pass < 12; pass++) {
    let removed = false;
    // 1. every tile needs to be held along two different edges (or lie flat on the table)
    let again = true;
    while (again) {
      again = false;
      for (const g of S) {
        if (g.flat) continue;
        const lines = [];
        if (g.ground.length >= 2) lines.push({ a: g.ground[0], b: g.ground[1], o: null });
        for (const l of g.links) if (S.has(l.o)) lines.push(l);
        let solid = false;
        for (let i = 1; i < lines.length && !solid; i++) {
          if (distToLine(lines[i].a, lines[0].a, lines[0].b) > 0.12 || distToLine(lines[i].b, lines[0].a, lines[0].b) > 0.12) solid = true;
        }
        g.wob = false;
        if (solid) continue;
        // held along one edge only: fine if it stands straight up on a tile's magnets
        const l = lines.find((x) => x.o);
        const upright = l && Math.abs(g.normal.y) < 0.3 && Math.abs(l.a.y - l.b.y) < 0.15 && g.cen.y > (l.a.y + l.b.y) / 2 + 0.1;
        if (upright) g.wob = Math.abs(g.normal.y) > 0.14; // leaning a little: only just holding on
        else { S.delete(g); again = true; removed = true; }
      }
    }
    // 2. each connected group must rest on the table with its weight over its feet
    const seen = new Set();
    for (const start of S) {
      if (seen.has(start)) continue;
      const comp = [], stack = [start];
      seen.add(start);
      while (stack.length) { const g = stack.pop(); comp.push(g); for (const l of g.links) if (S.has(l.o) && !seen.has(l.o)) { seen.add(l.o); stack.push(l.o); } }
      const feet = [];
      let m = 0, cx = 0, cz = 0;
      for (const g of comp) { for (const c of g.ground) feet.push([c.x, c.z]); m += g.type.area; cx += g.cen.x * g.type.area; cz += g.cen.z * g.type.area; }
      const hull = hull2D(feet);
      if (!insideHull(hull, cx / m, cz / m, 0.04)) { for (const g of comp) S.delete(g); removed = true; }
    }
    if (!removed) break;
  }
  for (const g of G) { if (!S.has(g)) out.set(g.t.id, 'fall'); else if (g.wob) out.set(g.t.id, 'wobbly'); }
  return out;
}

function renderGravity() {
  $('#gravity').classList.toggle('on', gravityOn);
  const chip = $('#gravChip');
  chip.classList.toggle('on', gravityOn && state.tiles.length > 0 && !fxBusy);
  if (!gravityOn) return;
  let fall = 0, wob = 0;
  for (const v of gravStatus.values()) { if (v === 'fall') fall++; else wob++; }
  chip.classList.toggle('bad', fall > 0);
  chip.classList.toggle('wob', !fall && wob > 0);
  $('#gravText').textContent = fall ? `${fall} ${fall === 1 ? 'tile' : 'tiles'} would fall` : wob ? `${wob} a bit wobbly` : 'Stands strong';
  $('#gravDrop').hidden = fall === 0;
}
$('#gravity').onclick = () => {
  gravityOn = !gravityOn;
  try { localStorage.setItem('tileWorkshop.gravity', gravityOn ? '1' : '0'); } catch (e) { /* ignore */ }
  $('#bgPop').classList.remove('on');
  refresh();
  if (mode === 'view') gotoStep(player.step, false);
  if (gravityOn) toast('Gravity check is on: red tiles would fall');
};

// "Again": pick up another tile like the selected one
$('#copyTile').onclick = () => { const t = selected(); if (t) { if (t.color) lastPaint[t.type] = t.color; else delete lastPaint[t.type]; hold(t.type); } };

// Colour: paint the selected tile; new tiles of that shape keep the colour
{
  const pop = $('#paintPop');
  const add = (hex) => {
    const el = document.createElement('button');
    el.className = 'swatch';
    el.title = hex ? 'This colour' : 'Back to its first colour';
    el.style.background = hex || 'conic-gradient(#e3262e, #ffd21f, #22c04a, #12a9d6, #7a2fd0, #e3262e)';
    el.onclick = () => {
      const t = selected();
      if (!t) return;
      if (hex) { t.color = hex; lastPaint[t.type] = hex; } else { delete t.color; delete lastPaint[t.type]; }
      pop.classList.remove('on');
      blip(660, 0.05, 0.05);
      commit();
    };
    pop.appendChild(el);
  };
  PAINTS.forEach(add);
  add(null);
  $('#paint').onclick = () => {
    pop.style.bottom = Math.round(window.innerHeight - $('#bar').getBoundingClientRect().top + 10) + 'px'; // sit just above the tile bar
    pop.classList.toggle('on');
  };
}

// ---------------------------------------------------------------------------
// Little helpers: pop-up menus, confetti, stars
// ---------------------------------------------------------------------------
const POPS = ['#bgPop', '#disPop', '#lightPop'];
function togglePop(id) { for (const p of POPS) $(p).classList.toggle('on', p === id && !$(p).classList.contains('on')); }
function closePops() { for (const p of POPS) $(p).classList.remove('on'); }
$('#bg').onclick = () => togglePop('#bgPop');

const STARS_KEY = 'tileWorkshop.stars';
let stars = {};
try { const s = JSON.parse(localStorage.getItem(STARS_KEY) || '{}'); if (s && typeof s === 'object') stars = s; } catch (e) { stars = {}; }

function confetti() {
  const c = $('#confetti'), g = c.getContext('2d');
  c.width = window.innerWidth; c.height = window.innerHeight;
  c.style.display = 'block';
  const bits = Array.from({ length: 150 }, () => ({
    x: c.width / 2 + (Math.random() - 0.5) * 240, y: c.height * 0.5, vx: (Math.random() - 0.5) * 16, vy: -7 - Math.random() * 11,
    r: 4 + Math.random() * 6, col: PAINTS[Math.floor(Math.random() * PAINTS.length)], a: Math.random() * 6,
  }));
  const t0 = performance.now();
  const tick = () => {
    g.clearRect(0, 0, c.width, c.height);
    for (const p of bits) {
      p.vy += 0.36; p.x += p.vx; p.y += p.vy; p.a += 0.22;
      g.save(); g.translate(p.x, p.y); g.rotate(p.a); g.fillStyle = p.col; g.fillRect(-p.r, -p.r / 2, p.r * 2, p.r); g.restore();
    }
    if (performance.now() - t0 < 2800) requestAnimationFrame(tick); else c.style.display = 'none';
  };
  tick();
}
function fanfare() { [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => blip(f, 0.16, 0.08), i * 110)); }

// ---------------------------------------------------------------------------
// Dragging: a floating picture while dragging out of the tray, and a trash can
// ---------------------------------------------------------------------------
function dragChipAt(x, y, show, typeId) {
  const el = $('#dragChip');
  if (!show) { el.style.display = 'none'; return; }
  if (typeId && el.dataset.type !== typeId) { el.innerHTML = thumbSVG(TYPES[typeId]); el.dataset.type = typeId; }
  el.style.display = 'block';
  el.style.transform = `translate(${x}px, ${y}px)`;
}
function overTrash(x, y) {
  const r = $('#trash').getBoundingClientRect();
  if (r.width && x >= r.left - 12 && x <= r.right + 12 && y >= r.top - 12 && y <= r.bottom + 12) return true;
  if (document.body.classList.contains('trayHidden')) return false;
  return x <= $('#tray').getBoundingClientRect().right; // dropping back on the tray also puts it away
}

function startTileDrag(tile) {
  const ids = subtreeIds(tile.id);
  dragExclude = ids;
  for (const id of ids) { const o = tileObjects.get(id); if (o) o.visible = false; }
  selMarker.visible = false;
  dragTile = { tile, ids, h: { type: tile.type, cEdge: tile.cEdge, flip: !!tile.flip, yaw: tile.yaw || 0 } };
  document.body.classList.add('dragging');
  $('#paintPop').classList.remove('on');
  blip(480, 0.04, 0.04);
}
function moveTileDrag(x, y, touch) {
  const hot = overTrash(x, y);
  $('#trash').classList.toggle('hot', hot);
  setGhost(hot ? null : computePlacement(x, y, touch, dragTile.h));
  dragChipAt(x, y, hot, dragTile.tile.type);
}
function endTileDrag(x, y, cancelled) {
  const d = dragTile, p = ghostPlacement, hot = !cancelled && overTrash(x, y);
  dragTile = null;
  dragExclude = new Set();
  document.body.classList.remove('dragging');
  $('#trash').classList.remove('hot');
  dragChipAt(0, 0, false);
  setGhost(null);
  if (hot) {
    state.tiles = state.tiles.filter((t) => !d.ids.has(t.id));
    selectedId = null;
    blip(300, 0.12);
    commit();
    return;
  }
  if (p && !cancelled) {
    const t = d.tile, wasRoot = t.parent == null, keep = t.angle || 0;
    for (const k of ['parent', 'pEdge', 'align', 'x', 'z', 'yaw']) delete t[k];
    Object.assign(t, { parent: p.parent, angle: p.angle });
    if (p.parent == null) { t.x = p.x; t.z = p.z; t.yaw = p.yaw; if (wasRoot) t.angle = keep; } else { t.pEdge = p.pEdge; t.align = p.align; }
    blip(p.parent != null ? 760 : 560);
    commit();
    return;
  }
  refresh(); // dropped nowhere useful: it goes back where it was
}

// ---------------------------------------------------------------------------
// Magic fold: fold the flat tiles around a tile up into a box, tent or pyramid
// ---------------------------------------------------------------------------
function magicFold() {
  let t = selected();
  if (!t) return;
  while (t.parent != null) t = byId.get(t.parent);
  const kids = (id) => state.tiles.filter((c) => c.parent === id);
  const first = kids(t.id);
  if (!first.length) { toast('Snap tiles onto its edges first, then press Magic'); blip(180, 0.12); return; }
  const unfold = first.every((c) => Math.abs(c.angle || 0) > 1);
  const pt = TYPES[t.type];
  for (const c of first) {
    const ct = TYPES[c.type], inv = edgeFrame(pt, c.pEdge).invert();
    const pc = new V3(pt.centroid[0], pt.centroid[1], 0).applyMatrix4(inv); // parent's middle, seen from the hinge
    const local = childLocal(ct, c.cEdge, c.flip, hingeOffset(c, t));
    let reach = 0, apex = null;
    for (const k of ct.corners) { const v = new V3(k[0], k[1], 0).applyMatrix4(local); if (v.y > reach) { reach = v.y; apex = v; } }
    const pointy = ct.corners.length === 3 && apex && Math.abs(apex.x - pc.x) < 0.08 && Math.abs(pc.y) < reach;
    const sign = parity(t) ? -1 : 1;
    if (unfold) c.angle = 0;
    else if (Math.abs(c.angle || 0) < 1) c.angle = sign * (pointy ? (Math.acos(pc.y / reach) * 180) / Math.PI : 90);
    for (const g of kids(c.id)) { // tiles on top of a wall: a lid, or a roof that leans in
      if (unfold) { g.angle = 0; continue; }
      if (Math.abs(g.angle || 0) >= 1 || pointy) continue;
      const gt = TYPES[g.type], gl = childLocal(gt, g.cEdge, g.flip, hingeOffset(g, c));
      let gr = 0;
      for (const k of gt.corners) gr = Math.max(gr, new V3(k[0], k[1], 0).applyMatrix4(gl).y);
      g.angle = gt.corners.length === 3 && Math.abs(pc.y) < gr ? (Math.asin(Math.abs(pc.y) / gr) * 180) / Math.PI : 90;
    }
  }
  tiltCtx = null;
  [660, 880, 1100].forEach((f, i) => setTimeout(() => blip(f, 0.07, 0.06), i * 70));
  commit();
}
$('#magic').onclick = magicFold;

// Stand up / Lie flat: how new tiles arrive
try { standMode = localStorage.getItem('tileWorkshop.stand') !== '0'; } catch (e) { /* ignore */ }
function setStand(on) {
  standMode = on;
  try { localStorage.setItem('tileWorkshop.stand', on ? '1' : '0'); } catch (e) { /* ignore */ }
  $('#standUp').classList.toggle('on', on);
  $('#standFlat').classList.toggle('on', !on);
  if (held) { held.stand = on; refreshGhost(); }
}
$('#standUp').onclick = () => { setStand(true); blip(620, 0.04, 0.04); };
$('#standFlat').onclick = () => { setStand(false); blip(520, 0.04, 0.04); };
setStand(standMode);

// ---------------------------------------------------------------------------
// Light: sunshine with coloured shadows, and a night glow
// ---------------------------------------------------------------------------
let lightMode = 'day';
const shadowGroup = new THREE.Group();
shadowGroup.visible = false;
scene.add(shadowGroup);
const sunBall = new THREE.Mesh(new THREE.SphereGeometry(0.9, 24, 16), new THREE.MeshBasicMaterial({ color: 0xffe27a }));
sunBall.visible = false;
scene.add(sunBall);
const shadowMats = new Map();
const lightDir = new V3(0.4, 0.8, 0.45).normalize();
const lampPos = new V3(0, 6, 0);
const DAY = { hemi: hemiLight.intensity, sun: sun.intensity, table: table.material.color.clone(), env: scene.environment, sunPos: sun.position.clone() };
const _sm = new M4();

function shadowMat(hex) {
  const key = lightMode + hex;
  if (!shadowMats.has(key)) {
    shadowMats.set(key, new THREE.MeshBasicMaterial({
      color: hex, transparent: true, opacity: lightMode === 'night' ? 0.5 : 0.56, depthWrite: false, side: THREE.DoubleSide,
      blending: lightMode === 'night' ? THREE.AdditiveBlending : THREE.NormalBlending,
    }));
  }
  return shadowMats.get(key);
}
function updateShadows() {
  if (lightMode === 'day') return;
  // flatten every tile onto the table, away from the light
  const h = 0.008, L = lightMode === 'night' ? [lampPos.x, lampPos.y, lampPos.z, 1] : [lightDir.x, lightDir.y, lightDir.z, 0];
  const P = [0, 1, 0, -h], dot = P[1] * L[1] + P[3] * L[3];
  const e = [];
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) e.push((r === c ? dot : 0) - L[r] * P[c]);
  _sm.set(...e);
  for (const [id, o] of tileObjects) {
    let sh = o.userData.shadow;
    if (!sh) {
      sh = o.userData.shadow = new THREE.Mesh(o.userData.type.flatGeom, shadowMat(0xffffff));
      sh.matrixAutoUpdate = false;
      sh.frustumCulled = false;
      sh.renderOrder = 1;
      shadowGroup.add(sh);
    }
    const t = byId.get(id);
    sh.visible = o.visible && !!t && (lightMode !== 'night' || worlds.get(id) && centroidWorld(o.userData.type, o.matrix).y < lampPos.y - 0.3);
    if (!sh.visible) continue;
    sh.material = shadowMat((t.color ? new THREE.Color(t.color) : o.userData.type.mats[0].color).getHex());
    sh.matrix.multiplyMatrices(_sm, o.matrix);
    sh.matrixWorldNeedsUpdate = true;
  }
}
function placeSun() {
  const a = rad(18 + ($('#sunPos').value / 100) * 144);
  lightDir.set(Math.cos(a) * 0.95, Math.sin(a) * 0.75 + 0.22, 0.5).normalize();
  sun.position.copy(lightDir).multiplyScalar(16);
  sunBall.position.copy(controls.target).addScaledVector(lightDir, 30);
}
function setLight(m) {
  lightMode = m;
  const night = m === 'night';
  shadowGroup.visible = m !== 'day';
  sunBall.visible = m === 'sun';
  hemiLight.intensity = night ? 0.14 : DAY.hemi;
  sun.intensity = night ? 0.1 : DAY.sun;
  scene.environment = night ? null : DAY.env;
  table.material.color.set(night ? 0x2b3142 : DAY.table);
  grid.material.color.set(night ? 0x596277 : 0xffffff);
  if (m === 'sun') placeSun(); else sun.position.copy(DAY.sunPos);
  const glow = (mats) => { for (const mat of new Set(mats)) { if (night) mat.emissive.copy(mat.color).multiplyScalar(0.62); else mat.emissive.set(0x000000); } };
  for (const type of Object.values(TYPES)) glow(type.mats);
  for (const look of lookCache.values()) glow(look.mats);
  for (const o of tileObjects.values()) o.userData.mesh.castShadow = m === 'day';
  for (const b of document.querySelectorAll('[data-light]')) b.classList.toggle('on', b.dataset.light === m);
  $('#sunBox').classList.toggle('on', m === 'sun');
  $('#light').classList.toggle('on', m !== 'day');
  placeLamp();
}
function placeLamp() { // the night lamp hangs above the middle of the build
  const box = new THREE.Box3();
  for (const t of state.tiles) for (const c of cornersWorld(t)) box.expandByPoint(c);
  if (box.isEmpty()) lampPos.set(0, 5, 0); else { box.getCenter(lampPos); lampPos.y = box.max.y + 2.2; lampPos.x += 0.9; lampPos.z -= 0.9; }
}
$('#light').onclick = () => togglePop('#lightPop');
for (const b of document.querySelectorAll('[data-light]')) b.onclick = () => setLight(b.dataset.light);
$('#sunPos').addEventListener('input', placeSun);

// ---------------------------------------------------------------------------
// Falling tiles: simple physics for the drop test and the disasters
// ---------------------------------------------------------------------------
const GRAV = 26;
const _r = new V3(), _vp = new V3(), _t = new V3(), _c = new V3(), _dq = new THREE.Quaternion();
function makeBody(id) {
  const t = byId.get(id), type = TYPES[t.type], W = worlds.get(id);
  if (type.radius == null) tileGeo(t);
  const pts = [];
  for (const c of type.corners) for (const z of [THICK / 2, -THICK / 2]) pts.push(new V3(c[0] - type.centroid[0], c[1] - type.centroid[1], z));
  return {
    id, type, obj: tileObjects.get(id), pos: centroidWorld(type, W), q: new THREE.Quaternion().setFromRotationMatrix(W),
    v: new V3(), w: new V3(), pts, I: 0.3 * type.radius * type.radius, asleep: false, still: 0,
  };
}
function stepBody(b, dt) {
  if (b.asleep) return;
  b.v.y -= GRAV * dt;
  b.pos.addScaledVector(b.v, dt);
  const wl = b.w.length();
  if (wl > 1e-5) { _dq.setFromAxisAngle(_t.copy(b.w).multiplyScalar(1 / wl), wl * dt); b.q.premultiply(_dq).normalize(); }
  let pen = 0, touching = false;
  for (const lp of b.pts) {
    _r.copy(lp).applyQuaternion(b.q);
    const y = b.pos.y + _r.y;
    if (y >= 0) continue;
    touching = true;
    pen = Math.max(pen, -y);
    _vp.crossVectors(b.w, _r).add(b.v);
    if (_vp.y >= 0) continue;
    const j = (-1.25 * _vp.y) / (1 + (_r.z * _r.z + _r.x * _r.x) / b.I);
    b.v.y += j;
    b.w.x += (-_r.z * j) / b.I;
    b.w.z += (_r.x * j) / b.I;
    const sl = Math.hypot(_vp.x, _vp.z);
    if (sl > 1e-4) {
      _t.set(_vp.x / sl, 0, _vp.z / sl);
      _c.crossVectors(_r, _t);
      const jt = Math.min(0.6 * j, sl / (1 + _c.lengthSq() / b.I));
      b.v.addScaledVector(_t, -jt);
      b.w.addScaledVector(_c, -jt / b.I);
    }
  }
  if (pen > 0) b.pos.y += pen * 0.8;
  b.v.multiplyScalar(touching ? 0.98 : 0.999);
  b.w.multiplyScalar(touching ? 0.95 : 0.996);
  if (touching && b.v.lengthSq() < 0.03 && b.w.lengthSq() < 0.08) { if (++b.still > 24) b.asleep = true; } else b.still = 0;
}
const _m = new M4(), _one = new V3(1, 1, 1);
function drawBody(b, scale = 1) {
  if (!b.obj) return;
  _m.compose(b.pos, b.q, _one.setScalar(scale));
  setMatrix(b.obj, _m.multiply(new M4().makeTranslation(-b.type.centroid[0], -b.type.centroid[1], 0)));
}
const rnd = (n) => (Math.random() - 0.5) * 2 * n;
function kick(b, vx, vy, vz, spin = 8) { b.asleep = false; b.frozen = false; b.still = 0; b.v.set(vx, vy, vz); b.w.set(rnd(spin), rnd(spin / 2), rnd(spin)); }

// things that turn up for a disaster
const props = new THREE.Group();
scene.add(props);
const wreckBall = new THREE.Mesh(new THREE.SphereGeometry(1, 28, 20), new THREE.MeshStandardMaterial({ color: 0x2b2f38, roughness: 0.35, metalness: 0.8 }));
const wreckChain = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 14, 8), new THREE.MeshStandardMaterial({ color: 0x555b66, metalness: 0.7, roughness: 0.4 }));
wreckChain.position.y = 8;
wreckBall.add(wreckChain);
const giantFoot = new THREE.Group();
{
  const skin = new THREE.MeshStandardMaterial({ color: 0x7a4a2b, roughness: 0.8 });
  const sole = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.7, 5.2), new THREE.MeshStandardMaterial({ color: 0x2c2018, roughness: 0.9 }));
  sole.position.y = 0.35;
  const boot = new THREE.Mesh(new THREE.BoxGeometry(3, 2.2, 4.6), skin);
  boot.position.set(0, 1.8, -0.2);
  const leg = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.4, 12, 20), skin);
  leg.position.set(0, 8.8, -1.2);
  giantFoot.add(sole, boot, leg);
  giantFoot.scale.setScalar(0.62);
}
const funnel = new THREE.Mesh(new THREE.ConeGeometry(2.6, 7, 28, 6, true), new THREE.MeshBasicMaterial({ color: 0xb9c2d0, transparent: true, opacity: 0.32, side: THREE.DoubleSide, depthWrite: false, wireframe: false }));
funnel.rotation.x = Math.PI;
for (const p of [wreckBall, giantFoot, funnel]) { p.visible = false; props.add(p); }

let fx = null, fxBusy = false, lastFx = 0;
function rumble(dur) {
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    const n = Math.floor(actx.sampleRate * dur), buf = actx.createBuffer(1, n, actx.sampleRate), d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < n; i++) { last = last * 0.96 + (Math.random() * 2 - 1) * 0.04; d[i] = last * 9 * Math.sin((Math.PI * i) / n); }
    const src = actx.createBufferSource(), g = actx.createGain();
    src.buffer = buf;
    g.gain.value = 0.5;
    src.connect(g).connect(actx.destination);
    src.start();
  } catch (e) { /* no audio */ }
}
function fxBegin(kind) {
  if (fxBusy || !state.tiles.length) return false;
  if (along) stopAlong(false);
  held = null;
  setGhost(null);
  selectedId = null;
  player.playing = false;
  player.showArrow = false;
  if (mode === 'view') gotoStep(player.order.length, false);
  refresh();
  arrow.visible = false;
  selMarker.visible = false;
  fxBusy = true;
  document.body.classList.add('busy');
  closePops();
  renderGravity();
  const box = new THREE.Box3();
  for (const t of state.tiles) for (const c of cornersWorld(t)) box.expandByPoint(c);
  fx = { kind, phase: '', t0: performance.now(), bodies: [], anims: [], mid: box.getCenter(new V3()), top: box.max.y, size: box.getSize(new V3()) };
  lastFx = performance.now();
  return true;
}
function fxEnd() {
  fx = null;
  fxBusy = false;
  document.body.classList.remove('busy');
  tableGroup.position.set(0, 0, 0);
  tilesGroup.position.set(0, 0, 0);
  for (const p of props.children) p.visible = false;
  for (const o of tileObjects.values()) o.visible = true;
  refresh();
  if (mode === 'view') gotoStep(player.order.length, false);
}
const allBodies = () => state.tiles.map((t) => makeBody(t.id));
function disaster(kind) {
  closePops();
  if (!fxBegin(kind)) { if (!fxBusy) toast('Build something first'); return; }
  fx.phase = kind;
  if (kind === 'quake') rumble(2.6);
  if (kind === 'tornado') { fx.bodies = allBodies(); for (const b of fx.bodies) kick(b, rnd(1), 1 + Math.random() * 2, rnd(1), 3); funnel.visible = true; rumble(3.4); }
  if (kind === 'ball') { fx.bodies = allBodies(); for (const b of fx.bodies) { b.asleep = true; b.frozen = true; } wreckBall.visible = true; }
  if (kind === 'stomp') { fx.bodies = allBodies(); for (const b of fx.bodies) { b.asleep = true; b.frozen = true; } giantFoot.visible = true; }
  if (kind === 'blast') rumble(2.2);
}
function dropTest() {
  const falling = [...gravStatus].filter(([, v]) => v === 'fall').map(([id]) => id);
  if (!falling.length || !fxBegin('drop')) return;
  fx.phase = 'fall';
  fx.t0 = performance.now();
  fx.bodies = falling.map((id) => { const b = makeBody(id); const a = Math.random() * 6.283; b.w.set(Math.cos(a) * 2.6, 0, Math.sin(a) * 2.6); return b; });
}
function fxTick() {
  if (!fx) return;
  const now = performance.now(), el = (now - fx.t0) / 1000;
  let dt = Math.min(0.05, (now - lastFx) / 1000);
  lastFx = now;
  const shake = (amp) => {
    const x = Math.sin(now / 17) * amp + Math.sin(now / 7.3) * amp * 0.5, z = Math.cos(now / 13) * amp + Math.sin(now / 5.1) * amp * 0.5;
    tableGroup.position.set(x, 0, z);
    return [x, z];
  };
  const simulate = (extra) => {
    while (dt > 0) { const h = Math.min(dt, 1 / 120); for (const b of fx.bodies) { if (extra) extra(b, h); stepBody(b, h); } dt -= h; }
    for (const b of fx.bodies) drawBody(b);
  };
  const toFall = () => { fx.phase = 'fall'; fx.t0 = now; };
  const mid = fx.mid;

  if (fx.phase === 'quake') {
    const [x, z] = shake(0.03 + 0.14 * Math.min(1, el / 0.9));
    tilesGroup.position.set(x, 0, z);
    if (el > 0.95) {
      tilesGroup.position.set(0, 0, 0);
      fx.bodies = allBodies();
      for (const b of fx.bodies) { b.pos.x += x; b.pos.z += z; kick(b, rnd(2.5), 0.6 + Math.random() * 2.4, rnd(2.5), 9); }
      fx.shakeFor = 1.5;
      blip(140, 0.3, 0.12);
      toFall();
    }
  } else if (fx.phase === 'tornado') {
    funnel.position.set(mid.x + Math.sin(el * 2.2) * 0.8, 3.5, mid.z + Math.cos(el * 1.7) * 0.8);
    funnel.rotation.y = el * 9;
    simulate((b, h) => { // swirl around the middle and lift
      const rx = b.pos.x - funnel.position.x, rz = b.pos.z - funnel.position.z, d = Math.hypot(rx, rz) || 0.01;
      b.asleep = false;
      b.v.x += ((-rz / d) * 24 - rx * 5) * h;
      b.v.z += ((rx / d) * 24 - rz * 5) * h;
      b.v.y += (GRAV + 9 - b.pos.y * 2.2) * h;
      b.w.y += 4 * h;
    });
    if (el > 3.1) { funnel.visible = false; for (const b of fx.bodies) { b.v.x += rnd(3); b.v.z += rnd(3); } toFall(); }
  } else if (fx.phase === 'ball') {
    const bx = mid.x - 11 + (el / 1.5) * 22, by = Math.max(1.05, Math.min(fx.top * 0.6, 3)) + Math.pow((bx - mid.x) / 11, 2) * 3;
    wreckBall.position.set(bx, by, mid.z);
    for (const b of fx.bodies) {
      if (b.frozen && Math.hypot(b.pos.x - bx, (b.pos.y - by) * 0.6, (b.pos.z - mid.z) * 0.55) < 1.7) { kick(b, 9 + Math.random() * 5, 2 + Math.random() * 4, rnd(4), 10); if (!fx.hit) { fx.hit = true; blip(110, 0.35, 0.14); } }
    }
    simulate();
    if (el > 1.5) { wreckBall.visible = false; for (const b of fx.bodies) if (b.frozen) kick(b, rnd(1.2), 0.4, rnd(1.2), 3); toFall(); }
  } else if (fx.phase === 'stomp') {
    const k = Math.min(1, el / 0.75), y = 12 - (12 - 0.05) * k * k;
    giantFoot.position.set(mid.x, y, mid.z + 0.6);
    for (const b of fx.bodies) {
      if (b.frozen && b.pos.y > y - 0.2) { const dx = b.pos.x - mid.x, dz = b.pos.z - mid.z, d = Math.hypot(dx, dz) || 0.01; kick(b, (dx / d) * (4 + Math.random() * 5), 0.5 + Math.random(), (dz / d) * (4 + Math.random() * 5), 6); }
    }
    simulate();
    if (k >= 1 && !fx.hit) { fx.hit = true; blip(90, 0.4, 0.16); rumble(0.9); for (const b of fx.bodies) if (b.frozen) kick(b, rnd(5), 1 + Math.random() * 2, rnd(5), 6); }
    if (fx.hit) shake(0.2 * Math.max(0, 1 - (el - 0.75) / 0.6));
    if (el > 1.6) { giantFoot.visible = false; fx.shakeFor = 0; toFall(); }
  } else if (fx.phase === 'blast') {
    const y = 0.5 * 7 * el * el;
    shake(0.05);
    tilesGroup.position.set(Math.sin(now / 21) * 0.05, y, Math.cos(now / 19) * 0.05);
    if (el > 1.7) {
      tilesGroup.position.set(0, 0, 0);
      tableGroup.position.set(0, 0, 0);
      fx.bodies = allBodies();
      for (const b of fx.bodies) { b.pos.y += y; kick(b, rnd(4), 4 + Math.random() * 5, rnd(4), 10); }
      blip(200, 0.3, 0.12);
      toFall();
    }
  } else if (fx.phase === 'fall') {
    if (fx.shakeFor) shake(0.17 * Math.max(0, 1 - el / fx.shakeFor));
    simulate();
    const limit = fx.kind === 'drop' ? 3 : 4.6;
    if (el > limit || (el > 1.2 && fx.bodies.every((b) => b.asleep))) { fx.phase = fx.kind === 'drop' ? 'rest' : 'fade'; fx.t0 = now; tableGroup.position.set(0, 0, 0); }
  } else if (fx.phase === 'rest') {
    if (el > 0.9) { blip(520, 0.08); fxEnd(); }
  } else if (fx.phase === 'fade') {
    const k = Math.min(1, el / 0.45);
    for (const b of fx.bodies) drawBody(b, Math.max(0.001, 1 - k));
    if (k >= 1) {
      updateTransforms();
      for (const o of tileObjects.values()) o.visible = false;
      fx.order = buildOrder();
      fx.i = 0;
      fx.gap = Math.min(1250 / 4, 14000 / Math.max(1, fx.order.length)); // four times the player's normal speed
      fx.nextAt = now + 250;
      fx.phase = 'rebuild';
    }
  } else if (fx.phase === 'rebuild') {
    while (fx.i < fx.order.length && now >= fx.nextAt) {
      const id = fx.order[fx.i++], o = tileObjects.get(id);
      if (o) { o.visible = true; fx.anims.push({ id, o, t0: now, dur: Math.max(120, fx.gap * 1.3) }); }
      if (fx.i % 2 === 1) blip(520 + (fx.i % 7) * 60, 0.04, 0.035);
      fx.nextAt += fx.gap;
    }
    for (const a of fx.anims) {
      const k = Math.min(1, (now - a.t0) / a.dur), e = 1 - Math.pow(1 - k, 3);
      setMatrix(a.o, new M4().makeTranslation(0, (1 - e) * 1.8, 0).multiply(worlds.get(a.id)));
      a.done = k >= 1;
    }
    fx.anims = fx.anims.filter((a) => !a.done);
    if (fx.i >= fx.order.length && !fx.anims.length) { blip(990, 0.2, 0.07); fxEnd(); }
  }
}
$('#quake').onclick = () => togglePop('#disPop');
for (const b of document.querySelectorAll('[data-dis]')) b.onclick = () => disaster(b.dataset.dis);
$('#gravDrop').onclick = dropTest;

// ---------------------------------------------------------------------------
// Build-along: the workshop shows the next tile, the builder taps it in the tray
// ---------------------------------------------------------------------------
let along = null;
function renderAlong() {
  const view = mode === 'view';
  $('#player').classList.toggle('on', view && !along);
  $('#alongDock').classList.toggle('on', view && !!along);
  if (!along) { for (const el of Object.values(cardEls)) el.classList.remove('want'); return; }
  const N = player.order.length;
  $('#alongCount').textContent = player.step + ' / ' + N;
  $('#alongFill').style.width = (N ? (player.step / N) * 100 : 0) + '%';
}
function alongTarget() {
  const id = player.order[player.step];
  if (id == null) { finishAlong(); return; }
  const t = byId.get(id);
  setGhost(t);
  arrow.visible = true;
  player.arrowAt = centroidWorld(TYPES[t.type], worlds.get(id));
  for (const [type, el] of Object.entries(cardEls)) { el.classList.toggle('want', type === t.type); if (type === t.type) el.scrollIntoView({ block: 'nearest' }); }
  $('#alongText').textContent = 'Tap the glowing ' + TYPES[t.type].def.name.toLowerCase();
  renderAlong();
}
function startAlong() {
  if (mode !== 'view' || fxBusy || !player.order.length) return;
  setTrayHidden(false);
  player.playing = false;
  along = { misses: 0 };
  player.showArrow = false;
  gotoStep(0, false);
  toast('Tap the glowing tile to put it on');
}
function stopAlong(finished) {
  along = null;
  setGhost(null);
  arrow.visible = false;
  renderAlong();
  if (!finished && mode === 'view') { player.showArrow = false; gotoStep(player.order.length, false); }
}
function finishAlong() {
  const b = viewBuild;
  stopAlong(true);
  player.showArrow = false;
  gotoStep(player.order.length, false);
  if (b) { stars[b.id] = (stars[b.id] || 0) + 1; try { localStorage.setItem(STARS_KEY, JSON.stringify(stars)); } catch (e) { /* ignore */ } }
  confetti();
  fanfare();
  toast('You built it! You earned a star ★');
  renderMode();
}
function alongPick(typeId) {
  if (!along || fxBusy || mode !== 'view') return;
  const t = byId.get(player.order[player.step]);
  if (!t) return;
  if (t.type === typeId) { setGhost(null); gotoStep(player.step + 1, true); }
  else {
    along.misses++;
    blip(170, 0.14, 0.06);
    const el = cardEls[typeId];
    el.classList.remove('nope'); void el.offsetWidth; el.classList.add('nope');
  }
}
$('#alongBtn').onclick = startAlong;
$('#alongStop').onclick = () => stopAlong(false);
$('#alongHelp').onclick = () => { const t = along && byId.get(player.order[player.step]); if (t) alongPick(t.type); };

// ---------------------------------------------------------------------------
// Build instructions: a printable booklet with a picture for every step
// ---------------------------------------------------------------------------
function shot(cam, w, h) { // a picture of the scene as it is right now
  const cw = canvas.width, ch = canvas.height, pr = renderer.getPixelRatio();
  const vw = Math.min(cw, Math.round((ch * w) / h)), vh = Math.round((vw * h) / w);
  renderer.setViewport(0, 0, vw / pr, vh / pr);
  renderer.setScissor(0, 0, vw / pr, vh / pr);
  renderer.setScissorTest(true);
  renderer.clear();
  renderer.render(scene, cam);
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const g = out.getContext('2d');
  g.fillStyle = '#e8edf4';
  g.fillRect(0, 0, w, h);
  g.drawImage(canvas, 0, ch - vh, vw, vh, 0, 0, w, h);
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, cw / pr, ch / pr);
  return out.toDataURL('image/jpeg', 0.84);
}
function partsHTML(counts) {
  return '<div class="gParts">' + Object.entries(counts).map(([type, n]) => `<span class="gPart">${thumbSVG(TYPES[type])}×${n}</span>`).join('') + '</div>';
}
function showInstructions() {
  if (mode !== 'view' || fxBusy) return;
  if (along) stopAlong(false);
  player.playing = false;
  const order = player.order, keepStep = player.step, keepMode = lightMode;
  if (lightMode !== 'day') setLight('day');
  // group the steps: up to four of the same tile at a time
  const groups = [];
  for (const id of order) {
    const t = byId.get(id), g = groups.at(-1);
    if (g && g.type === t.type && g.ids.length < 4) g.ids.push(id); else groups.push({ type: t.type, ids: [id] });
  }
  const cam = new THREE.PerspectiveCamera(40, 4 / 3, 0.1, 200);
  fitCamera(cam, null, 0.74);
  cam.updateMatrixWorld(true);
  arrow.visible = false;
  selMarker.visible = false;
  setGhost(null);
  updateTransforms();
  for (const o of tileObjects.values()) o.visible = true;
  scene.updateMatrixWorld(true);
  const cover = shot(cam, 720, 540);
  const total = {};
  for (const t of state.tiles) total[t.type] = (total[t.type] || 0) + 1;
  let html = `<div class="gCover"><img src="${cover}" alt=""><div><h3></h3><p>${state.tiles.length} tiles, ${groups.length} steps. You will need:</p>${partsHTML(total)}</div></div>`;
  const pointers = [];
  const shown = new Set();
  groups.forEach((g, i) => {
    for (const id of g.ids) shown.add(id);
    for (const [id, o] of tileObjects) {
      o.visible = shown.has(id);
      const fresh = g.ids.includes(id), look = lookFor(o.userData.type, byId.get(id)?.color);
      o.userData.mesh.material = fresh ? look.selMats || o.userData.type.selMats : look.mats;
      o.userData.lines.material.color.set(fresh ? 0xffd54a : look.lineColor);
    }
    while (pointers.length < g.ids.length) { const a = arrow.clone(); scene.add(a); pointers.push(a); }
    pointers.forEach((a, k) => {
      a.visible = k < g.ids.length;
      if (a.visible) { const t = byId.get(g.ids[k]); a.position.copy(centroidWorld(TYPES[t.type], worlds.get(t.id))); a.position.y += 0.2; }
    });
    scene.updateMatrixWorld(true);
    html += `<div class="gStep"><span class="num">${i + 1}</span><img src="${shot(cam, 560, 420)}" alt="">${partsHTML({ [g.type]: g.ids.length })}</div>`;
  });
  for (const a of pointers) scene.remove(a);
  $('#guidePages').innerHTML = html;
  $('#guidePages').querySelector('h3').textContent = viewBuild.name;
  $('#guideTitle').textContent = viewBuild.name + ': build instructions';
  $('#guide').classList.add('on');
  $('#guidePages').scrollTop = 0;
  if (keepMode !== 'day') setLight(keepMode);
  refresh();
  gotoStep(keepStep, false);
  renderer.render(scene, camera);
}
$('#guideBtn').onclick = showInstructions;
$('#guideClose').onclick = () => $('#guide').classList.remove('on');
$('#guide').addEventListener('pointerdown', (e) => { if (e.target === $('#guide')) $('#guide').classList.remove('on'); });
$('#guidePrint').onclick = () => window.print();

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
try { unlimited = localStorage.getItem(MODE_KEY) === '1'; } catch (e) { /* ignore */ }
try {
  const saved = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null');
  if (saved && Array.isArray(saved.tiles)) {
    saved.tiles = saved.tiles.filter((t) => TYPES[t.type] && TYPES[t.type].mag.includes(t.cEdge));
    const ids = new Set(saved.tiles.map((t) => t.id));
    saved.tiles = saved.tiles.filter((t) => t.parent == null || ids.has(t.parent));
    state = saved;
  }
} catch (e) { /* start fresh */ }

buildTray();
commit();
applyBg();
renderMode();
ensureThumbs();

// handy for testing and for future features
window.workshop = {
  get state() { return state; },
  TYPES, hold, placeHeld, computePlacement, setGhost, commit, refresh, toScreen,
  worldOf: (id) => worlds.get(id),
  get held() { return held; },
  get mode() { return mode; },
  get gravStatus() { return gravStatus; },
  get piles() { return piles; },
  get busy() { return fxBusy; },
  disaster, dropTest, analyseGravity, linkedGeos, setLight, magicFold, startAlong, alongPick, showInstructions,
  get along() { return along; },
  get stars() { return stars; },
  check: () => { // used when testing models
    const G = linkedGeos(), seen = new Set(); let comps = 0;
    for (const g of G) { if (seen.has(g)) continue; comps++; const st = [g]; seen.add(g); while (st.length) { const x = st.pop(); for (const l of x.links) if (!seen.has(l.o)) { seen.add(l.o); st.push(l.o); } } }
    let dup = 0, low = 0;
    for (let i = 0; i < G.length; i++) { if (G[i].corners.some((c) => c.y < -0.05)) low++; for (let j = i + 1; j < G.length; j++) if (G[i].cen.distanceTo(G[j].cen) < 0.12) dup++; }
    const gs = analyseGravity(); let fall = [], wob = 0; for (const [id, v] of gs) { if (v === 'fall') fall.push(id); else wob++; }
    return { tiles: G.length, pieces: comps, overlaps: dup, belowTable: low, fall, wobbly: wob };
  },
  get builds() { return builds; },
  player, saveCurrent, openBuild, exitView, editCopy, gotoStep, stepBy, togglePlay, buildOrder,
  get ghost() { return ghostPlacement; },
  edgeScreen: (id, ei, out = 0) => {
    const t = byId.get(id), e = TYPES[t.type].edges[ei];
    return toScreen(new V3(e.mid[0] + (e.dy / e.len) * out, e.mid[1] - (e.dx / e.len) * out, 0).applyMatrix4(worlds.get(id)));
  },
  corners: (id) => { const t = byId.get(id); return TYPES[t.type].corners.map((c) => new V3(c[0], c[1], 0).applyMatrix4(worlds.get(id)).toArray().map((n) => +n.toFixed(3))); },
  select: (id) => { selectedId = id; refresh(); },
  setTilt: (deg) => { $('#tilt').value = String(deg); onTiltInput(); onTiltDone(); },
};

renderer.setAnimationLoop(() => {
  controls.update();
  if (fxBusy) fxTick(); else if (mode === 'view') playerTick();
  updateShadows();
  renderer.render(scene, camera);
});
