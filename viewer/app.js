import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { MapControls } from 'three/addons/controls/MapControls.js';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { Sky } from 'three/addons/objects/Sky.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

const MODEL = './model/';
const $ = (s) => document.querySelector(s);

const state = {
  layers: { gebouwen: true, bomen: true, water: true, buurtgrens: true, labels: true, maquette: false,
            bouwjaar: false, schaduw: true },
  walking: false, selected: null, flying: null,
};

// ---------- renderer, scene, camera ----------
const canvas = $('#c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.6;
const maxAniso = renderer.capabilities.getMaxAnisotropy();

const labelRenderer = new CSS2DRenderer();
labelRenderer.setSize(window.innerWidth, window.innerHeight);
labelRenderer.domElement.id = 'labels';
document.body.appendChild(labelRenderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0xcfd9e4, 2500, 11000);
const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 1, 30000);
const HOME = { pos: new THREE.Vector3(560, 430, 980), target: new THREE.Vector3(0, 0, -40) };
camera.position.copy(HOME.pos);

const controls = new MapControls(camera, renderer.domElement);
controls.target.copy(HOME.target);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.screenSpacePanning = false;
controls.maxPolarAngle = Math.PI / 2 - 0.03;
controls.minDistance = 4;
controls.maxDistance = 4500;
controls.zoomToCursor = true;
controls.listenToKeyEvents(window);          // pijltjes verschuiven, met Shift/Ctrl draaien

// ---------- licht en lucht ----------
const hemi = new THREE.HemisphereLight(0xcfe0ff, 0x857a66, 1.0);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff4e0, 3.0);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
Object.assign(sun.shadow.camera, { left: -1000, right: 1000, top: 1000, bottom: -1000, near: 50, far: 7000 });
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.6;
scene.add(sun);
scene.add(sun.target);

const sky = new Sky();
sky.scale.setScalar(14000);   // moet binnen camera.far (30000) blijven, anders wordt de lucht weggeknipt
scene.add(sky);
const su = sky.material.uniforms;
su.turbidity.value = 2.5;
su.rayleigh.value = 2.0;
su.mieCoefficient.value = 0.003;
su.mieDirectionalG.value = 0.85;

const ground = new THREE.Mesh(new THREE.PlaneGeometry(20000, 20000),
  new THREE.MeshStandardMaterial({ color: 0xb5bfa4, roughness: 1 }));
ground.rotation.x = -Math.PI / 2;
ground.position.y = -1.3;
scene.add(ground);

// ---------- hoogtegrid (2 m) ----------
let HM = null, HARR = null;
function groundHeight(x, z) {
  if (!HM) return 0;
  const fi = (x - HM.x0) / HM.dx, fj = (HM.z_south - z) / HM.dx;
  const i = Math.max(0, Math.min(HM.nx - 2, Math.floor(fi)));
  const j = Math.max(0, Math.min(HM.ny - 2, Math.floor(fj)));
  const tx = Math.min(1, Math.max(0, fi - i)), tz = Math.min(1, Math.max(0, fj - j));
  const h = (jj, ii) => HM.hmin + HARR[jj * HM.nx + ii] * HM.scale;
  return (h(j, i) * (1 - tx) + h(j, i + 1) * tx) * (1 - tz) + (h(j + 1, i) * (1 - tx) + h(j + 1, i + 1) * tx) * tz;
}

// ---------- zon ----------
let lat = 52.3827, lon = 4.6058;
function currentSunDate() {
  const d = $('#sundate').value ? new Date($('#sundate').value + 'T00:00:00') : new Date();
  const m = parseInt($('#suntime').value || '720', 10);
  d.setHours(Math.floor(m / 60), m % 60, 0, 0);
  return d;
}
function setSun(date) {
  const p = SunCalc.getPosition(date, lat, lon);   // azimuth: 0 = zuid, +west; altitude in rad
  const ca = Math.cos(p.altitude);
  const dir = new THREE.Vector3(-Math.sin(p.azimuth) * ca, Math.sin(p.altitude), Math.cos(p.azimuth) * ca); // x oost, y omhoog, z zuid
  sun.position.copy(dir).multiplyScalar(3000);
  sun.target.position.set(0, 0, 0);
  su.sunPosition.value.copy(dir);
  const day = THREE.MathUtils.smoothstep(p.altitude, -0.06, 0.12);
  sun.intensity = 3.2 * day;
  hemi.intensity = 0.45 + 0.6 * day;
  renderer.toneMappingExposure = 0.36 + 0.24 * day;
  sun.castShadow = state.layers.schaduw && day > 0.05;
  const hh = String(date.getHours()).padStart(2, '0'), mm = String(date.getMinutes()).padStart(2, '0');
  $('#sunlabel').textContent = `${hh}:${mm} · zon ${(p.altitude * 180 / Math.PI).toFixed(0)}°`;
}
function sunNow(forceDaylight = false) {
  const n = new Date();
  $('#sundate').value = `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
  $('#suntime').value = n.getHours() * 60 + n.getMinutes();
  if (forceDaylight && SunCalc.getPosition(n, lat, lon).altitude < 0.09) $('#suntime').value = 13 * 60 + 30;  // 's nachts: toon de middag
  setSun(currentSunDate());
}
$('#sundate').addEventListener('input', () => setSun(currentSunDate()));
$('#suntime').addEventListener('input', () => setSun(currentSunDate()));
$('#sunnow').addEventListener('click', () => sunNow(false));

// ---------- laden ----------
const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);
const progress = {};
function showProgress() {
  let l = 0, t = 0;
  for (const v of Object.values(progress)) { l += v[0]; t += v[1]; }
  $('#barfill').style.width = (t ? 100 * l / t : 0) + '%';
  $('#progress').textContent = `Model laden… ${(l / 1e6).toFixed(1)} MB`;
}
function loadGLB(name) {
  return new Promise((res, rej) => loader.load(MODEL + name, res,
    (e) => { progress[name] = [e.loaded, e.total || e.loaded]; showProgress(); }, rej));
}
async function fetchJSON(u) {
  const r = await fetch(u);
  if (!r.ok) throw new Error(`${u}: ${r.status}`);
  return r.json();
}

const layers = {
  gebouwen: new THREE.Group(), bomen: new THREE.Group(), water: new THREE.Group(),
  buurtgrens: new THREE.Group(), maquette: new THREE.Group(), labels: new THREE.Group(),
};
for (const g of Object.values(layers)) scene.add(g);
layers.maquette.visible = false;

const terrainMeshes = [];
const plainMat = new THREE.MeshStandardMaterial({ color: 0xcfc8b8, roughness: 1 });
let bMesh = null, bInfo = [], bCSR = null, bOrig = null, bidAttr = null, colAttr = null, roofAttr = null;
let labelObjs = [];

function setupTerrain(root) {
  root.traverse((o) => {
    if (!o.isMesh) return;
    o.receiveShadow = true;
    o.castShadow = false;
    const m = o.material;
    m.roughness = 1; m.metalness = 0;
    if (m.map) { m.map.anisotropy = maxAniso; m.map.needsUpdate = true; }
    o.userData.photoMat = m;
    o.userData.stdMap = m.map;
    terrainMeshes.push(o);
  });
  scene.add(root);
}

function setupBuildings(root, info) {
  root.traverse((o) => { if (o.isMesh) bMesh = o; });
  bInfo = info;
  bMesh.castShadow = bMesh.receiveShadow = true;
  const m = bMesh.material;
  m.vertexColors = true; m.roughness = 0.9; m.metalness = 0;
  const g = bMesh.geometry;
  bidAttr = g.getAttribute('_bid');
  roofAttr = g.getAttribute('_roof');
  colAttr = g.getAttribute('color');
  bOrig = colAttr.array.slice();
  const n = info.length;
  const counts = new Uint32Array(n + 1);
  for (let i = 0; i < bidAttr.count; i++) counts[bidAttr.getX(i) + 1]++;
  for (let i = 0; i < n; i++) counts[i + 1] += counts[i];
  const fill = counts.slice(0, n);
  const idx = new Uint32Array(bidAttr.count);
  for (let i = 0; i < bidAttr.count; i++) { const b = bidAttr.getX(i); idx[fill[b]++] = i; }
  bCSR = { counts, idx };
  layers.gebouwen.add(root);
}

function setupTrees(root) {
  root.traverse((o) => { if (o.isMesh) { o.castShadow = o.receiveShadow = true; o.material.roughness = 0.95; o.material.metalness = 0; } });
  layers.bomen.add(root);
}

function setupWater(root) {
  root.traverse((o) => {
    if (!o.isMesh) return;
    const m = o.material;
    m.transparent = true; m.opacity = 0.82; m.depthWrite = false; m.roughness = 0.12; m.metalness = 0.05;
    o.receiveShadow = true;
  });
  layers.water.add(root);
}

function setupMaquette(root) {
  root.traverse((o) => {
    if (!o.isMesh) return;
    const m = o.material;
    m.vertexColors = true; m.roughness = 1; m.metalness = 0;
    m.polygonOffset = true; m.polygonOffsetFactor = -1; m.polygonOffsetUnits = -2;
    o.receiveShadow = true;
  });
  layers.maquette.add(root);
}

function setupGrens(data) {
  const mat = new THREE.MeshBasicMaterial({ color: 0xff7a00, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
  for (const line of data.lijnen) {
    const pts = line.map((p) => new THREE.Vector3(p[0], p[1] + 0.3, p[2]));
    const n = pts.length, pos = new Float32Array(n * 2 * 3), idx = [];
    const up = new THREE.Vector3(0, 1, 0), dir = new THREE.Vector3(), side = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
      dir.subVectors(b, a); dir.y = 0; dir.normalize();
      side.crossVectors(up, dir).multiplyScalar(0.8);
      pos.set([pts[i].x + side.x, pts[i].y, pts[i].z + side.z, pts[i].x - side.x, pts[i].y, pts[i].z - side.z], i * 6);
      if (i < n - 1) idx.push(2 * i, 2 * i + 1, 2 * i + 2, 2 * i + 1, 2 * i + 3, 2 * i + 2);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setIndex(idx);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.material.side = THREE.DoubleSide;
    layers.buurtgrens.add(mesh);
  }
}

function setupLabels(data) {
  const streets = new Map();
  for (const l of data) {
    if (!['Weg', 'Water'].includes(l.type)) continue;
    const div = document.createElement('div');
    div.className = 'label' + (l.type === 'Water' ? ' water' : '');
    div.textContent = l.t;
    const obj = new CSS2DObject(div);
    obj.position.set(l.x, l.y + 2.5, l.z);
    obj.userData.type = l.type;
    obj.userData.name = l.t;
    layers.labels.add(obj);
    labelObjs.push(obj);
    if (l.type === 'Weg' && !streets.has(l.t)) streets.set(l.t, obj.position.clone());
  }
  const sel = $('#streets');
  for (const name of [...streets.keys()].sort((a, b) => a.localeCompare(b, 'nl'))) {
    const o = document.createElement('option');
    o.value = name; o.textContent = name;
    sel.appendChild(o);
  }
  sel.addEventListener('change', () => {
    const p = streets.get(sel.value);
    if (!p) return;
    flyTo(new THREE.Vector3(p.x, groundHeight(p.x, p.z), p.z), new THREE.Vector3(p.x + 40, groundHeight(p.x, p.z) + 70, p.z + 150));
    sel.value = '';
  });
}

// ---------- kleuren per bouwjaar / selectie ----------
const BJ = [[1900, [0.48, 0.12, 0.12]], [1930, [0.75, 0.22, 0.17]], [1945, [0.90, 0.49, 0.13]], [1970, [0.95, 0.77, 0.06]],
            [1990, [0.18, 0.80, 0.44]], [2010, [0.10, 0.74, 0.61]], [9999, [0.20, 0.60, 0.86]]];
function bouwjaarColor(y) {
  if (!y) return [0.6, 0.6, 0.6];
  for (const [lim, c] of BJ) if (y < lim) return c;
  return [0.6, 0.6, 0.6];
}
function paintBuilding(bid, rgb) {
  const arr = colAttr.array, k = colAttr.itemSize;
  for (let p = bCSR.counts[bid]; p < bCSR.counts[bid + 1]; p++) {
    const i = bCSR.idx[p];
    if (rgb) {
      const roof = roofAttr ? roofAttr.getX(i) > 0.5 : bOrig[i * k + 1] < 150;
      const f = roof ? 1.0 : 0.55;
      arr[i * k] = Math.round(255 * (rgb[0] * f + (1 - f) * 0.9));
      arr[i * k + 1] = Math.round(255 * (rgb[1] * f + (1 - f) * 0.9));
      arr[i * k + 2] = Math.round(255 * (rgb[2] * f + (1 - f) * 0.9));
    } else {
      arr[i * k] = bOrig[i * k]; arr[i * k + 1] = bOrig[i * k + 1]; arr[i * k + 2] = bOrig[i * k + 2];
    }
  }
}
function repaintAll() {
  for (let b = 0; b < bInfo.length; b++) {
    paintBuilding(b, state.layers.bouwjaar ? bouwjaarColor(bInfo[b].bouwjaar) : null);
  }
  if (state.selected != null) paintBuilding(state.selected, [1.0, 0.85, 0.2]);
  colAttr.needsUpdate = true;
}
function select(bid) {
  state.selected = bid;
  repaintAll();
  const info = $('#info');
  if (bid == null) { info.classList.add('hidden'); return; }
  const b = bInfo[bid];
  const bagid = (b.id || '').split('.').pop();
  info.innerHTML = `<span class="close" id="infoclose">✕</span><h4>Pand ${bagid}</h4><table>
    <tr><td>Bouwjaar</td><td>${b.bouwjaar ?? 'onbekend'}</td></tr>
    <tr><td>Hoogte</td><td>${b.h} m boven maaiveld</td></tr>
    <tr><td>Maaiveld</td><td>${b.z0} m NAP</td></tr>
    <tr><td>Gevel</td><td>${b.gevel_mat ?? '–'}${b.gevel_bron === 'schatting' ? ' <span class="muted">(schatting)</span>' : ''}</td></tr>
    <tr><td>Detail</td><td>LoD ${b.lod}</td></tr>
    <tr><td></td><td><a href="https://bagviewer.kadaster.nl/lvbag/bag-viewer/?objectId=${bagid}" target="_blank" rel="noopener">BAG-viewer ↗</a></td></tr>
  </table>`;
  info.classList.remove('hidden');
  $('#infoclose').onclick = () => select(null);
}

const raycaster = new THREE.Raycaster();
let downPos = null;
renderer.domElement.addEventListener('pointerdown', (e) => { downPos = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!downPos || state.walking || !bMesh) return;
  if (Math.hypot(e.clientX - downPos[0], e.clientY - downPos[1]) > 5) return;
  const ndc = new THREE.Vector2((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const hits = layers.gebouwen.visible ? raycaster.intersectObject(bMesh, false) : [];
  select(hits.length ? bidAttr.getX(hits[0].face.a) : null);
});

// ---------- lagen ----------
function setLayer(name, on) {
  state.layers[name] = on;
  switch (name) {
    case 'gebouwen': layers.gebouwen.visible = on; if (!on) select(null); break;
    case 'bomen': layers.bomen.visible = on; break;
    case 'water': layers.water.visible = on; break;
    case 'buurtgrens': layers.buurtgrens.visible = on; break;
    case 'maquette':
      layers.maquette.visible = on;
      for (const m of terrainMeshes) m.material = on ? plainMat : m.userData.photoMat;
      break;
    case 'bouwjaar': $('#legend').classList.toggle('hidden', !on); if (bMesh) repaintAll(); break;
    case 'schaduw': setSun(currentSunDate()); break;
    default: break;
  }
}
for (const cb of document.querySelectorAll('#panel input[type=checkbox]')) {
  cb.addEventListener('change', () => setLayer(cb.dataset.layer, cb.checked));
}
$('#collapse').addEventListener('click', () => {
  const p = $('#panel');
  p.classList.toggle('collapsed');
  $('#collapse').textContent = p.classList.contains('collapsed') ? '+' : '–';
});

// ---------- navigatie: vliegen, wandelen ----------
function flyTo(target, pos, dur = 1.4) {
  stopDay();
  state.flying = { t: 0, dur, p0: camera.position.clone(), t0: controls.target.clone(), p1: pos.clone(), t1: target.clone() };
  controls.enabled = false;
}
function stepFly(dt) {
  const f = state.flying;
  f.t = Math.min(f.dur, f.t + dt);
  const s = THREE.MathUtils.smootherstep(f.t / f.dur, 0, 1);
  camera.position.lerpVectors(f.p0, f.p1, s);
  controls.target.lerpVectors(f.t0, f.t1, s);
  camera.lookAt(controls.target);
  if (f.t >= f.dur) { state.flying = null; controls.enabled = true; controls.update(); }
}
$('#btnOverzicht').addEventListener('click', () => flyTo(HOME.target, HOME.pos));

// ---------- dag afspelen: zon van opkomst tot ondergang met een willekeurige, botsingsvrije vlucht ----------
const DAY = { playing: false, p: 0, duration: 110, start: null, end: null, N: 2400, P: null, T: null, knots: null,
              panelWasCollapsed: false, street: null };
let SM = null, SARR = null, STREETS = [];
const rnd = (a, b) => a + Math.random() * (b - a);
const V3 = (x, y, z) => new THREE.Vector3(x, y, z);
function surfaceMax(x, z, r = 6) {   // hoogste punt (gebouw, boom, mast) binnen r m, uit het 4 m-oppervlaktegrid
  if (!SM) return groundHeight(x, z);
  const i0 = Math.max(0, Math.floor((x - r - SM.x0) / SM.dx)), i1 = Math.min(SM.nx - 1, Math.floor((x + r - SM.x0) / SM.dx));
  const j0 = Math.max(0, Math.floor((SM.z_south - (z + r)) / SM.dx)), j1 = Math.min(SM.ny - 1, Math.floor((SM.z_south - (z - r)) / SM.dx));
  let m = -1;
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) m = Math.max(m, SARR[j * SM.nx + i]);
  return m < 0 ? groundHeight(x, z) : SM.hmin + m * SM.scale;
}
function sunDirAt(date, elev) {
  const q = SunCalc.getPosition(date, lat, lon);
  const ca = Math.cos(elev);
  return new THREE.Vector3(-Math.sin(q.azimuth) * ca, Math.sin(elev), Math.cos(q.azimuth) * ca);
}
function buildDay(date) {
  const t = SunCalc.getTimes(date, lat, lon);
  DAY.start = new Date(t.sunrise.getTime() - 20 * 60000);
  DAY.end = new Date(t.sunset.getTime() + 20 * 60000);
  const rise = sunDirAt(t.sunrise, 0.03), set = sunDirAt(t.sunset, 0.025);
  const C = V3(5, 0, -27);                                   // middelpunt van de buurt (lokaal: x oost, z zuid)
  const keys = [];
  // Vast begin: recht boven de wijk, kantelen, zonsopkomst vanaf de westkant
  const riseCam = V3(rnd(-600, -480), rnd(55, 85), rnd(40, 260));
  keys.push({ p: 0.000, pos: V3(5, 900, 10), tgt: V3(5, 0, -60) });
  keys.push({ p: 0.040, pos: V3(-300, 380, 220), tgt: V3(20, 0, -60) });
  keys.push({ p: 0.075, pos: riseCam, tgt: riseCam.clone().addScaledVector(rise, 700) });
  // Willekeurige lus: van west naar oost, anderhalve ronde om en door de wijk op wisselende hoogtes
  const dir = Math.random() < 0.5 ? 1 : -1;
  const n = 4 + Math.floor(Math.random() * 3);
  const a0 = Math.atan2(riseCam.z - C.z, riseCam.x - C.x);
  const total = Math.PI * rnd(2.7, 3.3);
  const randTgt = () => V3(rnd(-300, 300), rnd(5, 25), rnd(-260, 200));
  const tour = [];
  for (let i = 1; i <= n; i++) {
    const ang = a0 + dir * total * (i / (n + 1));
    const r = rnd(230, 470);
    tour.push({ pos: V3(C.x + Math.cos(ang) * r, rnd(45, 190), C.z + Math.sin(ang) * r), tgt: randTgt(), w: 1, ang });
  }
  // Eén korte lage pas door een straatcorridor (uit streets.json), ingevoegd waar de lus er het dichtst bij komt
  DAY.street = null;
  const inside = (q, m) => q[0] > -424 - m && q[0] < 433 + m && q[2] > -381 - m && q[2] < 328 + m;
  const cands = STREETS.filter((s) => [s.a, s.b].every((q) => inside(q, s.type === 'water' ? 200 : 40)));
  if (cands.length) {
    const s = cands[Math.floor(Math.random() * cands.length)];
    const flip = Math.random() < 0.5;
    const A = V3(...(flip ? s.b : s.a)), B = V3(...(flip ? s.a : s.b));
    const ab = B.clone().sub(A);
    const L = ab.length();
    const d = ab.clone().normalize();
    const mid = A.clone().addScaledVector(d, L / 2);
    const angM = Math.atan2(mid.z - C.z, mid.x - C.x);
    let best = 0, bestD = Infinity;
    tour.forEach((w, i) => { const dd = Math.abs(Math.atan2(Math.sin(w.ang - angM), Math.cos(w.ang - angM))); if (dd < bestD) { bestD = dd; best = i; } });
    const at = (f, h) => { const q = A.clone().addScaledVector(d, L * f); q.y = groundHeight(q.x, q.z) + h; return q; };
    const ahead = at(1.0, 6), beyond = B.clone().addScaledVector(d, 150); beyond.y = groundHeight(beyond.x, beyond.z) + 12;
    const pass = [
      { pos: at(0.0, 20), tgt: ahead, w: 1.5, street: true },
      { pos: at(0.25, 8), tgt: ahead, w: 2, street: true },
      { pos: at(0.75, 8), tgt: beyond, w: 2, street: true },
      { pos: at(1.0, 20), tgt: beyond, w: 1.5, street: true },
    ];
    tour.splice(best + 1, 0, ...pass);
    DAY.street = { A, B, d, L };
  }
  // Vast einde: zonsondergang vanaf de oostkant, kijkend over de wijk
  const setCam = V3(rnd(440, 560), rnd(90, 130), rnd(-160, 100));
  const setTgt = setCam.clone().addScaledVector(set, 700);
  const endCam = setCam.clone().add(V3(-40, 6, -50));
  // Tijdverdeling: vertrek bij 0.13, vaste momenten voor zonsopkomst (0.075) en -ondergang (0.955); daartussen
  // naar rato van de afgelegde afstand (gewicht w maakt de straatpas langzamer).
  const depart = riseCam.clone().lerp(tour[0].pos, 0.12); depart.y = riseCam.y + 5;
  const moving = [{ pos: depart, tgt: riseCam.clone().addScaledVector(rise, 700).lerp(tour[0].tgt, 0.3), w: 1 }, ...tour,
                  { pos: setCam, tgt: setTgt, w: 1 }];
  const dist = [0];
  for (let i = 1; i < moving.length; i++) dist.push(dist[i - 1] + moving[i].pos.distanceTo(moving[i - 1].pos) * (moving[i].w || 1));
  const span = dist[dist.length - 1];
  moving.forEach((k, i) => keys.push({ p: 0.13 + (0.955 - 0.13) * dist[i] / span, pos: k.pos, tgt: k.tgt, street: !!k.street }));
  const streetP = keys.filter((k) => k.street).map((k) => k.p);
  const pIn = streetP.length ? Math.min(...streetP) - 0.01 : 2, pOut = streetP.length ? Math.max(...streetP) + 0.01 : -1;
  keys.push({ p: 1.0, pos: endCam, tgt: endCam.clone().addScaledVector(set, 700) });
  DAY.knots = keys.map((k) => k.p);
  const posCurve = new THREE.CatmullRomCurve3(keys.map((k) => k.pos), false, 'centripetal', 0.5);
  const tgtCurve = new THREE.CatmullRomCurve3(keys.map((k) => k.tgt), false, 'centripetal', 0.5);
  // Dicht bemonsteren en de hoogte botsingsvrij maken: minstens 12 m boven het hoogste object binnen 6 m,
  // behalve in de straatcorridor (8 m boven de weg, met op- en afrit in het eerste en laatste kwart).
  const N = DAY.N, P = new Float32Array(N * 3), T = new Float32Array(N * 3), req = new Float32Array(N);
  const q = new THREE.Vector3();
  for (let i = 0; i < N; i++) {
    const u = dayU(i / (N - 1));
    posCurve.getPoint(u, q); P[i * 3] = q.x; P[i * 3 + 1] = q.y; P[i * 3 + 2] = q.z;
    tgtCurve.getPoint(u, q); T[i * 3] = q.x; T[i * 3 + 1] = q.y; T[i * 3 + 2] = q.z;
    req[i] = surfaceMax(P[i * 3], P[i * 3 + 2], 6) + 12;
  }
  const smooth = (arr, k, op) => {            // lopend maximum of gemiddelde over +-k monsters
    const out = new Float32Array(arr.length);
    for (let i = 0; i < arr.length; i++) {
      let m = op === 'max' ? -Infinity : 0, c = 0;
      for (let j = Math.max(0, i - k); j <= Math.min(arr.length - 1, i + k); j++) { if (op === 'max') m = Math.max(m, arr[j]); else { m += arr[j]; c++; } }
      out[i] = op === 'max' ? m : m / c;
    }
    return out;
  };
  let need = smooth(smooth(req, 20, 'max'), 25, 'avg');
  const inStreet = new Uint8Array(N);
  if (DAY.street) {
    const { A, d, L } = DAY.street;
    for (let i = 0; i < N; i++) {
      const pi = i / (N - 1);
      if (pi < pIn || pi > pOut) continue;          // alleen het stuk van de vlucht dat de straatpas is
      const dx = P[i * 3] - A.x, dz = P[i * 3 + 2] - A.z;
      const along = dx * d.x + dz * d.z, lat = Math.abs(dx * d.z - dz * d.x);
      const f = along / L;
      if (f >= 0 && f <= 1 && lat < 6) {
        const ramp = Math.max(0, 1 - Math.min(f, 1 - f) / 0.25);
        need[i] = groundHeight(P[i * 3], P[i * 3 + 2]) + 8 + 14 * ramp * ramp;
        inStreet[i] = 1;
      }
    }
  }
  const y0 = new Float32Array(N);
  for (let i = 0; i < N; i++) y0[i] = Math.max(P[i * 3 + 1], need[i]);
  const y1 = smooth(y0, 12, 'avg');
  for (let i = 0; i < N; i++) P[i * 3 + 1] = inStreet[i] ? need[i] : Math.max(y1[i], need[i]);
  DAY.P = P; DAY.T = T;
}
function dayU(p) {   // voortgang -> curveparameter, zodat de sleutelmomenten precies op hun tijd vallen
  const k = DAY.knots, n = k.length - 1;
  for (let i = 0; i < n; i++) {
    if (p <= k[i + 1]) return (i + (p - k[i]) / (k[i + 1] - k[i])) / n;
  }
  return 1;
}
const dayPos = new THREE.Vector3(), dayTgt = new THREE.Vector3();
function setDayProgress(p) {
  DAY.p = THREE.MathUtils.clamp(p, 0, 1);
  const f = DAY.p * (DAY.N - 1), i = Math.min(DAY.N - 2, Math.floor(f)), s = f - i;
  const P = DAY.P, T = DAY.T;
  dayPos.set(P[i * 3] * (1 - s) + P[(i + 1) * 3] * s, P[i * 3 + 1] * (1 - s) + P[(i + 1) * 3 + 1] * s, P[i * 3 + 2] * (1 - s) + P[(i + 1) * 3 + 2] * s);
  dayTgt.set(T[i * 3] * (1 - s) + T[(i + 1) * 3] * s, T[i * 3 + 1] * (1 - s) + T[(i + 1) * 3 + 1] * s, T[i * 3 + 2] * (1 - s) + T[(i + 1) * 3 + 2] * s);
  camera.position.copy(dayPos);
  camera.lookAt(dayTgt);
  const when = new Date(DAY.start.getTime() + DAY.p * (DAY.end - DAY.start));
  $('#suntime').value = when.getHours() * 60 + when.getMinutes();
  setSun(when);
}
function startDay() {
  if (state.walking) plc.unlock();
  state.flying = null;
  select(null);
  buildDay($('#sundate').value ? new Date($('#sundate').value + 'T12:00:00') : new Date());
  DAY.playing = true;
  controls.enabled = false;
  DAY.panelWasCollapsed = $('#panel').classList.contains('collapsed');
  $('#panel').classList.add('collapsed');
  $('#collapse').textContent = '+';
  $('#dayplay').innerHTML = '&#x25A0; Stop';
  setDayProgress(0);
}
function stopDay() {
  if (!DAY.playing) return;
  DAY.playing = false;
  controls.enabled = true;
  controls.target.copy(dayTgt);
  controls.update();
  if (!DAY.panelWasCollapsed) { $('#panel').classList.remove('collapsed'); $('#collapse').textContent = '–'; }
  $('#dayplay').innerHTML = '&#x25B6; Dag afspelen';
}
function stepDay(dt) {
  setDayProgress(DAY.p + dt / DAY.duration);
  if (DAY.p >= 1) stopDay();
}
$('#dayplay').addEventListener('click', () => (DAY.playing ? stopDay() : startDay()));
renderer.domElement.addEventListener('pointerdown', stopDay);
renderer.domElement.addEventListener('wheel', stopDay, { passive: true });
$('#sunnow').addEventListener('click', stopDay);
$('#suntime').addEventListener('pointerdown', stopDay);
$('#sundate').addEventListener('input', stopDay);

// Draaien en kantelen om het kijkpunt (controls.target)
const sph = new THREE.Spherical();
const offV = new THREE.Vector3();
let rotPending = 0, tiltPending = 0;          // nog uit te voeren hoek (rad), geanimeerd
const hold = { dir: 0, tilt: 0, since: 0 };
function orbitBy(dAz, dPolar) {
  offV.copy(camera.position).sub(controls.target);
  sph.setFromVector3(offV);
  sph.theta += dAz;
  sph.phi = THREE.MathUtils.clamp(sph.phi + dPolar, 0.08, controls.maxPolarAngle);
  offV.setFromSpherical(sph);
  camera.position.copy(controls.target).add(offV);
  camera.lookAt(controls.target);
}
function northUp() {
  offV.copy(camera.position).sub(controls.target);
  sph.setFromVector3(offV);
  let d = -sph.theta;                          // theta 0 = camera ten zuiden van het kijkpunt, kijkend naar het noorden
  d = Math.atan2(Math.sin(d), Math.cos(d));    // kortste draairichting
  rotPending += d;
}
function stepRotate(dt) {
  if (state.walking || state.flying) return;
  const held = hold.dir || hold.tilt;
  if (held && performance.now() - hold.since > 220) orbitBy(hold.dir * 1.4 * dt, hold.tilt * 0.8 * dt);
  const kq = (keys.KeyQ ? 1 : 0) - (keys.KeyE ? 1 : 0);
  const kr = (keys.KeyR ? -1 : 0) + (keys.KeyF ? 1 : 0);
  if (kq || kr) orbitBy(kq * 1.4 * dt, kr * 0.8 * dt);
  if (rotPending) {
    const step = Math.sign(rotPending) * Math.min(Math.abs(rotPending), 3.0 * dt);
    orbitBy(step, 0); rotPending -= step;
    if (Math.abs(rotPending) < 1e-4) rotPending = 0;
  }
  if (tiltPending) {
    const step = Math.sign(tiltPending) * Math.min(Math.abs(tiltPending), 2.0 * dt);
    orbitBy(0, step); tiltPending -= step;
    if (Math.abs(tiltPending) < 1e-4) tiltPending = 0;
  }
}
function holdButton(id, dir, tilt) {
  const el = $(id);
  const start = (e) => { e.preventDefault(); stopDay(); hold.dir = dir; hold.tilt = tilt; hold.since = performance.now(); };
  const stop = () => {
    if (!hold.dir && !hold.tilt) return;
    if (performance.now() - hold.since <= 220) { rotPending += dir * Math.PI / 6; tiltPending += tilt * 0.2; }  // korte klik: stapje
    hold.dir = 0; hold.tilt = 0;
  };
  el.addEventListener('pointerdown', start);
  el.addEventListener('pointerup', stop);
  el.addEventListener('pointerleave', stop);
  el.addEventListener('pointercancel', stop);
}
holdButton('#rotL', 1, 0);
holdButton('#rotR', -1, 0);
holdButton('#tiltUp', 0, -1);
holdButton('#tiltDown', 0, 1);
$('#north').addEventListener('click', () => { stopDay(); northUp(); });
$('#compass').addEventListener('click', northUp);

const plc = new PointerLockControls(camera, renderer.domElement);
const keys = {};
const tmpV = new THREE.Vector3();
function isTyping(e) { return ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName); }
window.addEventListener('keydown', (e) => {
  if (isTyping(e)) return;
  if (e.code === 'Space') { e.preventDefault(); DAY.playing ? stopDay() : startDay(); return; }
  if (['KeyQ', 'KeyE', 'KeyR', 'KeyF', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) stopDay();
  keys[e.code] = true;
  if (e.code === 'KeyW' && !state.walking && !state.flying) enterWalk();
  if (e.code === 'KeyO' && !state.walking) flyTo(HOME.target, HOME.pos);
});
window.addEventListener('keyup', (e) => { keys[e.code] = false; });
function enterWalk() {
  stopDay();
  plc.lock();   // camera wordt verplaatst zodra de browser de muis echt vastzet ('lock')
}
plc.addEventListener('lock', () => {
  const t = controls.target;
  const x = THREE.MathUtils.clamp(t.x, -690, 690), z = THREE.MathUtils.clamp(t.z, -590, 590);
  camera.getWorldDirection(tmpV); tmpV.y = 0; tmpV.normalize();
  camera.position.set(x, groundHeight(x, z) + 1.7, z);
  camera.lookAt(x + tmpV.x * 10, camera.position.y, z + tmpV.z * 10);
  state.walking = true; controls.enabled = false; $('#btnWalk').textContent = 'Stop wandelen (Esc)';
  select(null);
});
plc.addEventListener('unlock', () => {
  state.walking = false; controls.enabled = true; $('#btnWalk').textContent = 'Wandelen';
  camera.getWorldDirection(tmpV);
  controls.target.copy(camera.position).addScaledVector(tmpV, 40);
  controls.target.y = Math.max(controls.target.y, groundHeight(controls.target.x, controls.target.z));
  controls.update();
});
$('#btnWalk').addEventListener('click', () => { if (state.walking) plc.unlock(); else enterWalk(); });
function stepWalk(dt) {
  const run = keys.ShiftLeft || keys.ShiftRight;
  const speed = run ? 7 : 2.4;
  const fwd = (keys.KeyW || keys.ArrowUp ? 1 : 0) - (keys.KeyS || keys.ArrowDown ? 1 : 0);
  const right = (keys.KeyD || keys.ArrowRight ? 1 : 0) - (keys.KeyA || keys.ArrowLeft ? 1 : 0);
  if (fwd) plc.moveForward(fwd * speed * dt);
  if (right) plc.moveRight(right * speed * dt);
  camera.position.x = THREE.MathUtils.clamp(camera.position.x, -695, 695);
  camera.position.z = THREE.MathUtils.clamp(camera.position.z, -595, 595);
  const gy = groundHeight(camera.position.x, camera.position.z) + 1.7;
  camera.position.y += (gy - camera.position.y) * Math.min(1, dt * 10);
}
function clampCamera() {
  const gy = groundHeight(camera.position.x, camera.position.z) + 2.0;
  if (camera.position.y < gy) camera.position.y = gy;
}

// ---------- lus ----------
const clock = new THREE.Clock();
let frames = 0, fpsT = 0;
function updateLabels() {
  const on = state.layers.labels;
  const maxD = state.walking ? 250 : 800;
  const best = new Map();   // per naam het dichtstbijzijnde label
  for (const l of labelObjs) {
    l.visible = false;
    if (DAY.playing) continue;                 // tijdens het vliegen geen straatnamen
    const d = camera.position.distanceTo(l.position);
    if (!on || d > maxD) continue;
    const b = best.get(l.userData.name);
    if (!b || d < b[0]) best.set(l.userData.name, [d, l]);
  }
  for (const [, l] of best.values()) l.visible = true;
}
function updateCompass() {
  camera.getWorldDirection(tmpV);
  const az = Math.atan2(tmpV.x, -tmpV.z);
  $('#needle').style.transform = `rotate(${-az}rad)`;
}
function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.1);
  if (DAY.playing) stepDay(dt);
  else if (state.flying) stepFly(dt);
  else if (state.walking) stepWalk(dt);
  else { stepRotate(dt); controls.update(); clampCamera(); }
  updateLabels();
  updateCompass();
  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
  frames++; fpsT += dt;
  if (fpsT >= 1) {
    $('#perf').textContent = `${(renderer.info.render.triangles / 1e6).toFixed(2)} M driehoeken · ${Math.round(frames / fpsT)} fps`;
    frames = 0; fpsT = 0;
  }
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  labelRenderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------- start ----------
async function init() {
  const meta = await fetchJSON(MODEL + 'scene.json');
  [lon, lat] = meta.origin_lonlat;
  HM = meta.heights;
  HARR = new Uint16Array(await (await fetch(MODEL + 'heights_2m.u16')).arrayBuffer());
  SM = meta.surface || null;
  if (SM) SARR = new Uint16Array(await (await fetch(MODEL + 'surface_4m.u16')).arrayBuffer());
  STREETS = await fetchJSON(MODEL + 'streets.json').catch(() => []);
  const s = meta.stats || {};
  $('#stats').textContent = `${s.gebouwen ?? '?'} panden · ${(s.bomen_bgt || 0) + (s.bomen_gedetecteerd || 0)} bomen · model van ${(meta.gebouwd || '').slice(0, 10)}`;
  sunNow(true);
  const [terrain, buildings, trees, water, maquette, binfo, grens, labels] = await Promise.all([
    loadGLB('terrain.glb'), loadGLB('buildings.glb'), loadGLB('trees.glb'), loadGLB('water.glb'), loadGLB('maquette.glb'),
    fetchJSON(MODEL + 'buildings.json'), fetchJSON(MODEL + 'buurtgrens.json'), fetchJSON(MODEL + 'labels.json'),
  ]);
  setupTerrain(terrain.scene);
  setupBuildings(buildings.scene, binfo);
  setupTrees(trees.scene);
  setupWater(water.scene);
  setupMaquette(maquette.scene);
  setupGrens(grens);
  setupLabels(labels);
  $('#overlay').classList.add('hidden');
  animate();
  startDay();
}
window.R3D = { THREE, scene, camera, renderer, controls, sun, hemi, sky, layers, state, setSun, flyTo, groundHeight, orbitBy, northUp, DAY, startDay, stopDay, setDayProgress, surfaceMax };

init().catch((e) => {
  console.error(e);
  $('#progress').textContent = 'Fout bij laden: ' + e.message + ' (open de viewer via een lokale webserver, zie README)';
});
