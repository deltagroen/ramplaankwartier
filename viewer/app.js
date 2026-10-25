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
  applySeason(date);
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
let VER = '';   // cache-buster: bouwdatum uit scene.json, zodat browsers na een update de nieuwe modelbestanden laden
function loadGLB(name) {
  return new Promise((res, rej) => loader.load(MODEL + name + VER, res,
    (e) => { progress[name] = [e.loaded, e.total || e.loaded]; showProgress(); }, rej));
}
async function fetchJSON(u) {
  const r = await fetch(u + (u.endsWith('scene.json') ? '' : VER), { cache: u.endsWith('scene.json') ? 'no-cache' : 'default' });
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

let tMesh = null, twigMesh = null, tOrig = null, tSeason = null, tSpec = null, tCrown = null, tTid = null;
let wSeason = null, wSpec = null, seasonKey = null, SPECIES = [], TREES = null;
function setupTrees(root) {
  root.traverse((o) => {
    if (!o.isMesh) return;
    o.material.roughness = 0.95; o.material.metalness = 0;
    if (o.name === 'takken') {
      twigMesh = o;
      o.castShadow = true; o.receiveShadow = false;
      const m = o.material;
      m.map = makeTwigTexture(); m.alphaHash = true; m.transparent = false; m.side = THREE.DoubleSide;
      m.vertexColors = true; m.roughness = 1; m.needsUpdate = true;
      wSeason = o.geometry.getAttribute('_season'); wSpec = o.geometry.getAttribute('_spec');
    } else {
      tMesh = o;
      o.castShadow = o.receiveShadow = true;
      const g = o.geometry;
      tOrig = g.getAttribute('color').array.slice();
      tSeason = g.getAttribute('_season'); tSpec = g.getAttribute('_spec'); tCrown = g.getAttribute('_crown'); tTid = g.getAttribute('_tid');
    }
  });
  layers.bomen.add(root);
  applySeason(currentSunDate());
}

// Procedurele takkentextuur: links een zijaanzicht (vertakkende boom), rechts een bovenaanzicht (radiale takken)
function makeTwigTexture() {
  const W = 1024, H = 512, c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  let seed = 7;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  ctx.lineCap = 'round'; ctx.strokeStyle = 'rgb(58,44,34)';
  const branch = (x, y, len, ang, w, depth) => {
    const x2 = x + Math.cos(ang) * len, y2 = y + Math.sin(ang) * len;
    ctx.lineWidth = w; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x2, y2); ctx.stroke();
    if (depth <= 0 || w < 0.5) return;
    const k = 2 + (rnd() < 0.45 ? 1 : 0);
    for (let i = 0; i < k; i++) {
      const da = (rnd() - 0.5) * 1.3 + (i - (k - 1) / 2) * 0.55;
      branch(x2, y2, len * (0.62 + rnd() * 0.16), ang + da, w * 0.62, depth - 1);
    }
  };
  branch(256, 500, 150, -Math.PI / 2, 13, 7);                      // zijaanzicht
  for (let i = 0; i < 7; i++) {                                     // bovenaanzicht: takken vanuit het midden
    const a = i / 7 * Math.PI * 2 + rnd() * 0.5;
    branch(768, 256, 90 + rnd() * 40, a, 7, 5);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = maxAniso;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

// ---------- seizoenen: bladkleur, bloesem en bladbezetting per soort volgen de datum ----------
const ss = (x, a, b) => THREE.MathUtils.smoothstep(x, a, b);
function seasonFactors(doy, prof) {
  // standaard: uitlopen 29 mrt - 12 mei, verkleuren 23 sep - 31 okt, bladval 19 okt - 26 nov; per soort verschoven
  const lo = prof.lo || 0, as = prof.as || 0, fs = prof.fs || 0;
  const leafOut = ss(doy, 88 + lo, 132 + lo);
  const leaf = prof.evergreen ? 1 : Math.min(leafOut, 1 - ss(doy, 292 + fs, 330 + fs));
  const autumn = prof.evergreen ? 0 : ss(doy, 266 + as, 304 + as) * (1 - ss(doy, 320 + fs, 345 + fs));
  const spring = prof.evergreen ? 0 : leafOut * (1 - ss(doy, 128 + lo, 170 + lo));
  let blossom = 0;
  if (prof.blossom) { const d = (doy - prof.bdoy) / (prof.blen / 2); blossom = Math.exp(-2 * d * d); }
  return { leaf, autumn, spring, blossom };
}
function applySeason(date) {
  if (!tMesh || !tSeason || !tSpec || !SPECIES.length) return;
  const key = date.getFullYear() * 1000 + Math.floor((date - new Date(date.getFullYear(), 0, 1)) / 86400000);
  if (key === seasonKey) return;
  seasonKey = key;
  const doy0 = (date - new Date(date.getFullYear(), 0, 1)) / 86400000;
  const col = tMesh.geometry.getAttribute('color');
  const arr = col.array, k = col.itemSize;
  let anyAlpha = false;
  for (let i = 0; i < col.count; i++) {
    if (tCrown.getX(i) < 0.5) continue;
    const r = tSeason.getX(i);
    const prof = SPECIES[tSpec.getX(i) | 0] || SPECIES[0];
    const doy = doy0 - (r - 0.5) * 14;                            // per boom tot een week vroeger of later
    const f = seasonFactors(doy, prof);
    let R = tOrig[i * k] / 255, G = tOrig[i * k + 1] / 255, B = tOrig[i * k + 2] / 255;
    const sp = f.spring * 0.45;
    R = R * (1 - sp) + 0.42 * sp; G = G * (1 - sp) + 0.62 * sp; B = B * (1 - sp) + 0.12 * sp;
    if (f.autumn > 0) {
      const v = 0.86 + 0.28 * ((r * 5.3) % 1);                   // per boom lichter of donkerder herfstblad
      const a = f.autumn;
      R = R * (1 - a) + prof.autumn[0] * v * a; G = G * (1 - a) + prof.autumn[1] * v * a; B = B * (1 - a) + prof.autumn[2] * v * a;
    }
    if (f.blossom > 0.02) {
      const b = f.blossom * 0.9;
      R = R * (1 - b) + prof.blossom[0] * b; G = G * (1 - b) + prof.blossom[1] * b; B = B * (1 - b) + prof.blossom[2] * b;
    }
    arr[i * k] = Math.round(THREE.MathUtils.clamp(R, 0, 1) * 255);
    arr[i * k + 1] = Math.round(THREE.MathUtils.clamp(G, 0, 1) * 255);
    arr[i * k + 2] = Math.round(THREE.MathUtils.clamp(B, 0, 1) * 255);
    if (k === 4) {
      const alpha = prof.evergreen ? 1 : THREE.MathUtils.clamp(Math.max(f.leaf, f.blossom * 0.95), 0, 1);
      arr[i * k + 3] = Math.round(alpha * 255);
      if (alpha < 0.995) anyAlpha = true;
    }
  }
  col.needsUpdate = true;
  const m = tMesh.material;
  if (m.alphaHash !== anyAlpha) { m.alphaHash = anyAlpha; m.transparent = false; m.needsUpdate = true; }
  if (twigMesh && wSeason && wSpec) {                          // kale takken zichtbaar naarmate het blad valt
    const wc = twigMesh.geometry.getAttribute('color');
    const wa = wc.array, wk = wc.itemSize;
    let anyTwig = false;
    for (let i = 0; i < wc.count; i++) {
      const prof = SPECIES[wSpec.getX(i) | 0] || SPECIES[0];
      const doy = doy0 - (wSeason.getX(i) - 0.5) * 14;
      const f = seasonFactors(doy, prof);
      const a = prof.evergreen ? 0 : THREE.MathUtils.clamp(1 - Math.max(f.leaf, f.blossom), 0, 1);
      wa[i * wk + 3] = Math.round(a * 255);
      if (a > 0.005) anyTwig = true;
    }
    wc.needsUpdate = true;
    twigMesh.visible = anyTwig;
  }
}
function treeInfoHTML(t) {
  const prof = SPECIES[t.spec] || {};
  const naam = prof.nl ? prof.nl.charAt(0).toUpperCase() + prof.nl.slice(1) : 'Boom';
  const bron = t.bron === 'haarlem' ? `Gemeente Haarlem, boomnummer ${t.nr ?? '?'}` : t.bron === 'bgt' ? 'BGT-boompunt, soort onbekend' : 'gedetecteerd in het hoogtemodel, soort onbekend';
  return `<span class="close" id="infoclose">✕</span><h4>${naam}</h4><table>
    ${t.lt ? `<tr><td>Soort</td><td><i>${t.lt}</i></td></tr>` : ''}
    ${t.leeftijd ? `<tr><td>Leeftijd</td><td>${t.leeftijd} jaar</td></tr>` : ''}
    <tr><td>Hoogte</td><td>${t.h} m (uit AHN)</td></tr>
    ${t.kroon ? `<tr><td>Kroon</td><td>${t.kroon} m (register)</td></tr>` : ''}
    ${t.beschermd ? `<tr><td></td><td>Beschermwaardige boom</td></tr>` : ''}
    <tr><td>Bron</td><td>${bron}</td></tr>
  </table>`;
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
  const thits = layers.bomen.visible && tMesh && TREES ? raycaster.intersectObject(tMesh, false) : [];
  if (thits.length && (!hits.length || thits[0].distance < hits[0].distance)) {
    select(null);
    const t = TREES.trees[tTid.getX(thits[0].face.a) | 0];
    if (t) { $('#info').innerHTML = treeInfoHTML(t); $('#info').classList.remove('hidden'); $('#infoclose').onclick = () => $('#info').classList.add('hidden'); }
    return;
  }
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
const DAY = { playing: false, p: 0, duration: 130, start: null, end: null, N: 2400, P: null, T: null, knots: null,
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
  // Eén korte lage pas door een straatcorridor of over water (uit streets.json), ingevoegd waar de lus er het
  // dichtst bij komt, met aanvlieg- en uitvliegpunten in het verlengde van de corridor voor een rechte aanloop.
  DAY.street = null;
  const inside = (q, m) => q[0] > -424 - m && q[0] < 433 + m && q[2] > -381 - m && q[2] < 328 + m;
  const cands = STREETS.filter((s) => [s.a, s.b].every((q) => inside(q, s.type === 'water' ? 200 : 40)));
  if (cands.length) {
    const s = cands[Math.floor(Math.random() * cands.length)];
    const sa = V3(...s.a), sb = V3(...s.b);
    const mid = sa.clone().add(sb).multiplyScalar(0.5);
    const angM = Math.atan2(mid.z - C.z, mid.x - C.x);
    let best = 0, bestD = Infinity;
    tour.forEach((w, i) => { const dd = Math.abs(Math.atan2(Math.sin(w.ang - angM), Math.cos(w.ang - angM))); if (dd < bestD) { bestD = dd; best = i; } });
    // richting van de pas: die met de minste draai vanaf het vorige en naar het volgende punt van de lus
    const prev = tour[best].pos, next = (tour[best + 1] || { pos: V3(500, 100, -30) }).pos;
    const turnCost = (P0, P1) => {
      const dd = P1.clone().sub(P0).normalize();
      const inDir = P0.clone().addScaledVector(dd, -P1.distanceTo(P0)).sub(prev); inDir.y = 0;
      const outDir = next.clone().sub(P1.clone().addScaledVector(dd, P1.distanceTo(P0))); outDir.y = 0;
      const flat = V3(dd.x, 0, dd.z).normalize();
      return Math.acos(THREE.MathUtils.clamp(inDir.normalize().dot(flat), -1, 1)) + Math.acos(THREE.MathUtils.clamp(flat.dot(outDir.normalize()), -1, 1));
    };
    const flip = turnCost(sb, sa) < turnCost(sa, sb);
    const A = flip ? sb : sa, B = flip ? sa : sb;
    const ab = B.clone().sub(A);
    const L = ab.length();
    const d = ab.clone().normalize();
    const at = (f, h) => { const q = A.clone().addScaledVector(d, L * f); q.y = groundHeight(q.x, q.z) + h; return q; };
    const far = at(1.0, 6);
    const pass = [
      { pos: at(-1.0, 60), tgt: far, w: 1.2, street: true },      // aanvliegpunt, 1 corridorlengte ervoor
      { pos: at(0.0, 24), tgt: far, w: 1.5, street: true },
      { pos: at(0.3, 8), tgt: far, w: 2, street: true },
      { pos: at(0.7, 8), tgt: at(2.0, 10), w: 2, street: true },
      { pos: at(1.0, 24), tgt: at(2.0, 10), w: 1.5, street: true },
      { pos: at(2.0, 60), tgt: at(3.0, 20), w: 1.2, street: true },  // uitvliegpunt
    ];
    tour.splice(best + 1, 0, ...pass);
    DAY.street = { A, B, d, L };
  }
  // Vast einde: zonsondergang vanaf de oostkant, kijkend over de wijk
  const setCam = V3(rnd(440, 560), rnd(90, 130), rnd(-160, 100));
  const setTgt = setCam.clone().addScaledVector(set, 700);
  const endCam = setCam.clone().add(V3(-40, 6, -50));
  // Tijdverdeling: vertrek bij 0.13, vaste momenten voor zonsopkomst (0.075) en -ondergang (0.955); daartussen
  // naar rato van de afgelegde afstand (gewicht w maakt de lage pas langzamer).
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

  // Dicht bemonsteren
  const N = DAY.N, P = new Float32Array(N * 3), T0 = new Float32Array(N * 3), need = new Float32Array(N);
  const q = new THREE.Vector3();
  for (let i = 0; i < N; i++) {
    const u = dayU(i / (N - 1));
    posCurve.getPoint(u, q); P[i * 3] = q.x; P[i * 3 + 1] = q.y; P[i * 3 + 2] = q.z;
    tgtCurve.getPoint(u, q); T0[i * 3] = q.x; T0[i * 3 + 1] = q.y; T0[i * 3 + 2] = q.z;
    need[i] = surfaceMax(P[i * 3], P[i * 3 + 2], 6) + 12;
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
  // Hoogteprofiel: minstens 12 m boven het hoogste object binnen 6 m (gladgestreken), behalve in de corridor:
  // daar daalt de baan met een Hermite-overgang (aansluitende helling) naar 8 m boven weg of water en klimt
  // aan het eind net zo weer op.
  const needS = smooth(smooth(need, 20, 'max'), 25, 'avg');
  const base = new Float32Array(N);
  for (let i = 0; i < N; i++) base[i] = Math.max(P[i * 3 + 1], needS[i]);
  const inStreet = new Uint8Array(N);
  if (DAY.street) {
    const { A, d, L } = DAY.street;
    let i0 = -1, i1 = -1;
    for (let i = 0; i < N; i++) {
      const pi = i / (N - 1);
      if (pi < pIn || pi > pOut) continue;
      const dx = P[i * 3] - A.x, dz = P[i * 3 + 2] - A.z;
      const along = dx * d.x + dz * d.z, lat = Math.abs(dx * d.z - dz * d.x);
      if (along >= 0 && along <= L && lat < 6) { if (i0 < 0) i0 = i; i1 = i; }
    }
    if (i0 >= 8 && i1 > i0 + 20 && i1 < N - 8) {
      const span = i1 - i0, ramp = 0.35;
      const hIn = base[i0], hOut = base[i1];
      const mIn = (base[i0] - base[i0 - 8]) / 8 * (ramp * span);      // helling bij binnenkomst, per eenheid t
      const mOut = (base[i1 + 8] - base[i1]) / 8 * (ramp * span);
      const hermite = (t, y0, m0, y1, m1) => {
        const t2 = t * t, t3 = t2 * t;
        return (2 * t3 - 3 * t2 + 1) * y0 + (t3 - 2 * t2 + t) * m0 + (-2 * t3 + 3 * t2) * y1 + (t3 - t2) * m1;
      };
      for (let i = i0; i <= i1; i++) {
        const f = (i - i0) / span;
        const g = groundHeight(P[i * 3], P[i * 3 + 2]) + 8;
        let y = g;
        if (f < ramp) y = hermite(f / ramp, hIn, mIn, g, 0);
        else if (f > 1 - ramp) y = hermite((f - (1 - ramp)) / ramp, g, 0, hOut, mOut);
        base[i] = Math.max(y, g - 1);
        inStreet[i] = 1;
      }
    }
  }
  const y1 = smooth(base, 10, 'avg');
  for (let i = 0; i < N; i++) {
    const g = groundHeight(P[i * 3], P[i * 3 + 2]);
    P[i * 3 + 1] = inStreet[i] ? Math.max(y1[i], g + 6) : Math.max(y1[i], needS[i]);
  }

  // Herbemonstering op booglengte voor de bewegende fase (0.13 .. 0.955): constante snelheid, met een
  // geleidelijke vertraging tot 45% in de corridor. Daardoor geen snelheidssprongen bij de sleutelpunten.
  const streetW = smooth(Float32Array.from(inStreet), 40, 'avg');
  const iA = Math.round(0.13 * (N - 1)), iB = Math.round(0.955 * (N - 1));
  // In scherpe bochten langzamer (zoals een drone die inzet): factor uit de richtingsverandering per meter
  const bend = new Float32Array(N);
  for (let i = 1; i < N - 1; i++) {
    const ax = P[i * 3] - P[(i - 1) * 3], az = P[i * 3 + 2] - P[(i - 1) * 3 + 2], bx = P[(i + 1) * 3] - P[i * 3], bz = P[(i + 1) * 3 + 2] - P[i * 3 + 2];
    const la = Math.hypot(ax, az), lb = Math.hypot(bx, bz);
    if (la > 0.01 && lb > 0.01) bend[i] = Math.acos(THREE.MathUtils.clamp((ax * bx + az * bz) / (la * lb), -1, 1)) / ((la + lb) / 2);
  }
  const bendS = smooth(bend, 40, 'avg');
  const cost = new Float32Array(N);
  for (let i = iA + 1; i <= iB; i++) {
    const step = Math.hypot(P[i * 3] - P[(i - 1) * 3], P[i * 3 + 1] - P[(i - 1) * 3 + 1], P[i * 3 + 2] - P[(i - 1) * 3 + 2]);
    const speed = Math.min(1 - 0.55 * streetW[i], 1 / (1 + 35 * bendS[i]));
    cost[i] = cost[i - 1] + step / Math.max(0.35, speed);
  }
  const costTotal = cost[iB];
  const P2 = P.slice(), T02 = T0.slice(), inStreet2 = inStreet.slice();
  for (let k = iA; k <= iB; k++) {
    const want = costTotal * (k - iA) / (iB - iA);
    let lo = iA, hi = iB;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cost[m] <= want) lo = m; else hi = m; }
    const seg = cost[hi] - cost[lo], s = seg > 0 ? (want - cost[lo]) / seg : 0;
    for (let c = 0; c < 3; c++) {
      P2[k * 3 + c] = P[lo * 3 + c] * (1 - s) + P[hi * 3 + c] * s;
      T02[k * 3 + c] = T0[lo * 3 + c] * (1 - s) + T0[hi * 3 + c] * s;
    }
    inStreet2[k] = inStreet[s < 0.5 ? lo : hi];
  }

  // Kijkrichting: naar een punt 160 m verderop op de baan, zodat het hoofd meedraait in de richting waarin
  // daarna gevlogen wordt; het kijkpunt ligt wat lager zodat de wijk in beeld blijft. In de vaste begin- en
  // eindfase gelden de expliciete kijkpunten (zonsopkomst, zonsondergang).
  const arc = new Float32Array(N);
  for (let i = 1; i < N; i++) arc[i] = arc[i - 1] + Math.hypot(P2[i * 3] - P2[(i - 1) * 3], P2[i * 3 + 1] - P2[(i - 1) * 3 + 1], P2[i * 3 + 2] - P2[(i - 1) * 3 + 2]);
  const T2 = new Float32Array(N * 3);
  let j = 0;
  for (let i = 0; i < N; i++) {
    while (j < N - 1 && arc[j] - arc[i] < 200) j++;
    let tx, ty, tz;
    if (j > i && arc[j] - arc[i] >= 100) {
      tx = P2[j * 3]; ty = P2[j * 3 + 1]; tz = P2[j * 3 + 2];
    } else {                                       // bijna aan het eind: richting van de laatste 60 m doortrekken
      let k = i; while (k > 0 && arc[i] - arc[k] < 60) k--;
      const dx = P2[i * 3] - P2[k * 3], dy = P2[i * 3 + 1] - P2[k * 3 + 1], dz = P2[i * 3 + 2] - P2[k * 3 + 2];
      const l = Math.hypot(dx, dy, dz) || 1;
      tx = P2[i * 3] + dx / l * 160; ty = P2[i * 3 + 1] + dy / l * 160; tz = P2[i * 3 + 2] + dz / l * 160;
    }
    const g = groundHeight(tx, tz);
    ty = g + (ty - g) * (inStreet2[i] ? 0.8 : 0.45);
    T2[i * 3] = tx; T2[i * 3 + 1] = ty; T2[i * 3 + 2] = tz;
  }
  // Glad maken; aan begin en eind de kijkrichting geleidelijk (slerp) van en naar de zon draaien,
  // zodat er geen snelle zwaai ontstaat bij de overgang naar de vaste kijkpunten.
  const smT = [0, 1, 2].map((c) => { const col = new Float32Array(N); for (let i = 0; i < N; i++) col[i] = T2[i * 3 + c]; return smooth(col, 45, 'avg'); });
  const slerp = (a, b, t) => {
    const d = THREE.MathUtils.clamp(a.dot(b), -1, 1), ang = Math.acos(d);
    if (ang < 1e-4) return b.clone();
    return a.clone().multiplyScalar(Math.sin((1 - t) * ang) / Math.sin(ang)).addScaledVector(b, Math.sin(t * ang) / Math.sin(ang));
  };
  const gdir = new THREE.Vector3();
  const maxStep = THREE.MathUtils.degToRad(35) * DAY.duration / (N - 1);   // max. 35 graden per seconde
  let prevDir = null;
  for (let i = 0; i < N; i++) {
    const pi = i / (N - 1);
    if (pi < 0.075 || pi > 0.955) { T2[i * 3] = T02[i * 3]; T2[i * 3 + 1] = T02[i * 3 + 1]; T2[i * 3 + 2] = T02[i * 3 + 2]; continue; }
    gdir.set(smT[0][i] - P2[i * 3], smT[1][i] - P2[i * 3 + 1], smT[2][i] - P2[i * 3 + 2]).normalize();
    let dir = slerp(rise, gdir, THREE.MathUtils.smoothstep(pi, 0.13, 0.21));   // 0.075-0.13: blik op de opkomende zon
    dir = slerp(dir, set, THREE.MathUtils.smoothstep(pi, 0.88, 0.955));
    if (prevDir) {                                                              // niet sneller draaien dan maxStep
      const ang = Math.acos(THREE.MathUtils.clamp(prevDir.dot(dir), -1, 1));
      if (ang > maxStep) dir = slerp(prevDir, dir, maxStep / ang);
    }
    prevDir = dir.clone();
    T2[i * 3] = P2[i * 3] + dir.x * 150; T2[i * 3 + 1] = P2[i * 3 + 1] + dir.y * 150; T2[i * 3 + 2] = P2[i * 3 + 2] + dir.z * 150;
  }
  DAY.P = P2; DAY.T = T2;
  DAY.debug = { needS, inStreet: inStreet2, streetW, cost };
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
  VER = '?v=' + encodeURIComponent(meta.gebouwd || '');
  [lon, lat] = meta.origin_lonlat;
  HM = meta.heights;
  HARR = new Uint16Array(await (await fetch(MODEL + 'heights_2m.u16' + VER)).arrayBuffer());
  SM = meta.surface || null;
  if (SM) SARR = new Uint16Array(await (await fetch(MODEL + 'surface_4m.u16' + VER)).arrayBuffer());
  STREETS = await fetchJSON(MODEL + 'streets.json').catch(() => []);
  const s = meta.stats || {};
  $('#stats').textContent = `${s.gebouwen ?? '?'} panden · ${(s.bomen_bgt || 0) + (s.bomen_gedetecteerd || 0)} bomen, ${s.bomen_soort || 0} met soort · model van ${(meta.gebouwd || '').slice(0, 10)}`;
  sunNow(true);
  const [terrain, buildings, trees, water, maquette, binfo, grens, labels, speciesList, treeList] = await Promise.all([
    loadGLB('terrain.glb'), loadGLB('buildings.glb'), loadGLB('trees.glb'), loadGLB('water.glb'), loadGLB('maquette.glb'),
    fetchJSON(MODEL + 'buildings.json'), fetchJSON(MODEL + 'buurtgrens.json'), fetchJSON(MODEL + 'labels.json'),
    fetchJSON(MODEL + 'species.json').catch(() => []), fetchJSON(MODEL + 'trees.json').catch(() => null),
  ]);
  SPECIES = speciesList; TREES = treeList;
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
window.R3D = { THREE, scene, camera, renderer, controls, sun, hemi, sky, layers, state, setSun, flyTo, groundHeight, orbitBy, northUp, DAY, startDay, stopDay, setDayProgress, surfaceMax, applySeason, seasonFactors };

init().catch((e) => {
  console.error(e);
  $('#progress').textContent = 'Fout bij laden: ' + e.message + ' (open de viewer via een lokale webserver, zie README)';
});
