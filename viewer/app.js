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
  layers: { gebouwen: true, bomen: true, water: true, buurtgrens: false, labels: true, maquette: false, omgeving: true,
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
controls.maxPolarAngle = Math.PI / 2 - 0.005;
controls.minDistance = 1.5;
controls.maxDistance = 1800;
controls.zoomToCursor = true;
controls.listenToKeyEvents(window);          // pijltjes verschuiven, met Shift/Ctrl draaien

// ---------- licht en lucht ----------
const hemi = new THREE.HemisphereLight(0xcfe0ff, 0x857a66, 1.0);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff4e0, 3.0);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
Object.assign(sun.shadow.camera, { left: -1000, right: 1000, top: 1000, bottom: -1000, near: 10, far: 20000 });
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

// ---------- weer: bewolking, zicht en neerslag per uur van de gekozen dag ----------
// Bron: Open-Meteo (open data, CC BY 4.0) voor de werkelijke dag; zonder internet een klimatologische schatting.
const WX = { mode: 'echt', date: null, hours: null, source: '', cache: new Map(), pending: null, time: 0,
             cur: { cloud: 0.2, precip: 0, vis: 20000, fog: 0 } };
const WX_PRESETS = {
  helder: { cloud: 0.05, thick: 0.05, thin: 0, precip: 0, vis: 30000, temp: 15, snow: 0, snowfall: 0, ice: 0 },
  halfbewolkt: { cloud: 0.5, thick: 0.5, thin: 0, precip: 0, vis: 18000, temp: 14, snow: 0, snowfall: 0, ice: 0 },
  sluierbewolking: { cloud: 0.9, thick: 0.1, thin: 0.9, precip: 0, vis: 20000, temp: 12, snow: 0, snowfall: 0, ice: 0 },
  bewolkt: { cloud: 1.0, thick: 1.0, thin: 0, precip: 0, vis: 9000, temp: 10, snow: 0, snowfall: 0, ice: 0 },
  regen: { cloud: 1.0, thick: 1.0, thin: 0, precip: 1.5, vis: 4000, temp: 9, snow: 0, snowfall: 0, ice: 0 },
  mist: { cloud: 0.7, thick: 0.7, thin: 0, precip: 0, vis: 700, temp: 4, snow: 0, snowfall: 0, ice: 0 },
  sneeuw: { cloud: 1.0, thick: 1.0, thin: 0, precip: 0.4, vis: 2500, temp: -2, snow: 0.06, snowfall: 0.5, ice: 0.8 },
};
function dateKey(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function climatology(d) {   // seizoensgebonden, per dag vast (zelfde dag = zelfde weer)
  const doy = (d - new Date(d.getFullYear(), 0, 1)) / 86400000;
  let seed = d.getFullYear() * 367 + Math.floor(doy) * 31 + 11;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const meanCloud = 0.62 + 0.12 * Math.cos((doy - 15) / 365 * Math.PI * 2);     // winter bewolkter
  const meanTemp = 10.5 - 7.5 * Math.cos((doy - 20) / 365 * Math.PI * 2) + (rnd() - 0.5) * 6;
  const cold = meanTemp < 0.5 && rnd() < 0.5;                                       // zo nu en dan een vorstperiode
  const ice = cold ? rnd() * 0.8 : 0;
  const wet = rnd() < 0.3 + 0.15 * Math.cos((doy - 300) / 365 * Math.PI * 2);
  const foggy = rnd() < (doy > 260 || doy < 60 ? 0.12 : 0.04);
  let c = THREE.MathUtils.clamp(meanCloud + (rnd() - 0.5) * 0.8, 0, 1);
  const hours = [];
  for (let h = 0; h < 24; h++) {
    c = THREE.MathUtils.clamp(c + (rnd() - 0.5) * 0.25, 0, 1);
    const precip = wet && c > 0.7 && rnd() < 0.45 ? 0.3 + rnd() * 2 : 0;
    const vis = foggy && h >= 4 && h <= 10 ? 400 + rnd() * 1200 : precip ? 4000 + rnd() * 4000 : 12000 + rnd() * 18000;
    const thin = rnd() < 0.35 ? rnd() * 0.8 : 0;
    const temp = meanTemp - 2.5 * Math.cos((h - 15) / 24 * Math.PI * 2);
    const snowfall = precip > 0 && temp < 1.5 ? precip : 0;
    hours.push({ cloud: Math.max(c, thin * 0.9), thick: c, thin, precip: snowfall ? 0 : precip, vis, temp,
                 snowfall, snow: cold && rnd() < 0.6 ? 0.03 + rnd() * 0.06 : 0, ice });
  }
  return hours;
}
async function fetchWeather(d) {
  const key = dateKey(d);
  if (WX.cache.has(key)) return WX.cache.get(key);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = (d - today) / 86400000;
  const from = new Date(d); from.setDate(from.getDate() - 12);        // 12 dagen terug voor de vorstsom (ijs)
  const fromKey = dateKey(from);
  let url;
  const daily = 'temperature_2m_mean';
  if (diff >= -90 && diff <= 15) {
    const vars = 'cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high,precipitation,visibility,weather_code,temperature_2m,snowfall,snow_depth';
    url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=${vars}&daily=${daily}&timezone=Europe%2FAmsterdam&start_date=${fromKey}&end_date=${key}`;
  } else if (diff < -90) {
    const vars = 'cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high,precipitation,weather_code,temperature_2m,snowfall,snow_depth';
    url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&hourly=${vars}&daily=${daily}&timezone=Europe%2FAmsterdam&start_date=${fromKey}&end_date=${key}`;
  } else {
    return null;                                                         // te ver in de toekomst
  }
  const r = await fetch(url);
  if (!r.ok) throw new Error('weer ' + r.status);
  const j = await r.json();
  // IJs: vorstsom over de voorgaande dagen; dooi haalt er anderhalf keer zo snel vanaf
  let frost = 0;
  (j.daily?.temperature_2m_mean || []).forEach((tm) => { if (tm == null) return; frost = tm < 0 ? frost - tm : Math.max(0, frost - 1.5 * tm); });
  const ice = THREE.MathUtils.smoothstep(frost, 8, 25);
  const H = j.hourly;
  const hours = [];
  H.time.forEach((t, i) => {
    if (!t.startsWith(key)) return;
    const code = H.weather_code ? H.weather_code[i] : 0;
    let vis = H.visibility ? H.visibility[i] : (code === 45 || code === 48 ? 600 : 15000);
    if (vis == null) vis = 15000;
    const lo = (H.cloud_cover_low?.[i] ?? 0) / 100, mi = (H.cloud_cover_mid?.[i] ?? 0) / 100, hi = (H.cloud_cover_high?.[i] ?? 0) / 100;
    const thick = H.cloud_cover_low ? 1 - (1 - lo) * (1 - mi) : (H.cloud_cover[i] ?? 50) / 100;
    const snowfall = H.snowfall?.[i] ?? 0;                               // cm/uur
    hours.push({ cloud: (H.cloud_cover[i] ?? 50) / 100, thick, thin: H.cloud_cover_high ? hi : 0,
                 precip: Math.max(0, (H.precipitation[i] ?? 0) - snowfall * 0.7), vis,
                 temp: H.temperature_2m?.[i] ?? 10, snowfall, snow: H.snow_depth?.[i] ?? 0, ice });
  });
  if (hours.length < 24) return null;
  WX.cache.set(key, hours);
  return hours;
}
function weatherAt(date) {
  if (WX.mode !== 'echt') return { ...(WX_PRESETS[WX.mode] || WX_PRESETS.helder), source: 'ingesteld' };
  const key = dateKey(date);
  if (WX.date !== key) {                                                  // nieuwe dag: ophalen, tot dan klimatologie
    WX.date = key; WX.hours = climatology(date); WX.source = 'schatting';
    fetchWeather(date).then((h) => { if (h && WX.date === key) { WX.hours = h; WX.source = 'Open-Meteo'; seasonWeatherDirty = true; } })
      .catch(() => {});
  }
  const t = date.getHours() + date.getMinutes() / 60;
  const i = Math.min(23, Math.floor(t)), f = t - i, a = WX.hours[i], b = WX.hours[Math.min(23, i + 1)];
  const mix = (k) => a[k] * (1 - f) + b[k] * f;
  return { cloud: mix('cloud'), thick: mix('thick'), thin: mix('thin'), precip: mix('precip'), vis: mix('vis'),
           temp: mix('temp'), snowfall: mix('snowfall'), snow: mix('snow'), ice: a.ice ?? 0, source: WX.source };
}
let seasonWeatherDirty = false;

// Wolkendek: een groot vlak op 1500 m met procedurele ruis; dekking en dichtheid uit het weer.
function makeNoiseTexture() {
  const n = 256, g = 16, grid = [];
  let seed = 3;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  for (let i = 0; i < g * g; i++) grid.push(rnd());
  const data = new Uint8Array(n * n * 4);
  const val = (x, y) => {                                                 // naadloze waarde-ruis
    const gx = (x / n) * g, gy = (y / n) * g, x0 = Math.floor(gx), y0 = Math.floor(gy);
    const tx = THREE.MathUtils.smoothstep(gx - x0, 0, 1), ty = THREE.MathUtils.smoothstep(gy - y0, 0, 1);
    const v = (i, j) => grid[((j + g) % g) * g + ((i + g) % g)];
    return (v(x0, y0) * (1 - tx) + v(x0 + 1, y0) * tx) * (1 - ty) + (v(x0, y0 + 1) * (1 - tx) + v(x0 + 1, y0 + 1) * tx) * ty;
  };
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const v = 0.55 * val(x, y) + 0.3 * val((x * 2) % n, (y * 2) % n) + 0.15 * val((x * 4) % n, (y * 4) % n);
    data[(y * n + x) * 4] = data[(y * n + x) * 4 + 1] = data[(y * n + x) * 4 + 2] = Math.round(v * 255);
    data[(y * n + x) * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, n, n);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true; tex.needsUpdate = true;
  return tex;
}
const CLOUD_H = 1500;
const cloudNoise = `
  float cloudNoise(vec2 wp, float time) {
    vec2 uv = wp / 3750.0 + vec2(time * 0.006, time * 0.003);
    return texture2D(noiseTex, uv).r * 0.62 + texture2D(noiseTex, uv * 2.7 + vec2(0.31, 0.77) + time * 0.01).r * 0.28
         + texture2D(noiseTex, uv * 6.1 + vec2(0.5, 0.2)).r * 0.10;
  }`;
// Zichtbaar wolkendek: een koepel om de camera; per kijkrichting wordt de snijding met het vlak y = CLOUD_H
// berekend en daar de ruis bemonsterd. Zo loopt het dek tot exact de horizon door. De diepte staat op het verre
// vlak, dus terrein en gebouwen staan er altijd voor.
const cloudMat = new THREE.ShaderMaterial({
  uniforms: { noiseTex: { value: makeNoiseTexture() }, cover: { value: 0.2 }, dens: { value: 0.9 }, time: { value: 0 },
              tint: { value: new THREE.Color(0.98, 0.98, 1.0) }, haze: { value: new THREE.Color(0.8, 0.84, 0.9) },
              cloudH: { value: CLOUD_H } },
  vertexShader: `varying vec3 vWorld;
    void main(){
      vec4 wp = modelMatrix * vec4(position, 1.0); vWorld = wp.xyz;
      vec4 cp = projectionMatrix * viewMatrix * wp;
      cp.z = cp.w * 0.99999;                        // altijd op het verre vlak: wolken zijn 'lucht', achter alles
      gl_Position = cp;
    }`,
  fragmentShader: `uniform sampler2D noiseTex; uniform float cover, dens, time, cloudH; uniform vec3 tint, haze; varying vec3 vWorld;
    ${cloudNoise}
    void main(){
      vec3 dir = normalize(vWorld - cameraPosition);
      if (dir.y < -0.03 || cameraPosition.y >= cloudH) discard;   // ruim onder de horizon, of camera boven het dek
      float dy = max(dir.y, 0.002);                               // vlak onder de horizon: nevelkleur doortrekken
      float t = (cloudH - cameraPosition.y) / dy;
      vec2 hit = cameraPosition.xz + dir.xz * t;
      float n = cloudNoise(hit, time);
      float edge = 1.0 - cover;
      float a = smoothstep(edge - 0.10, edge + 0.22, n) * dens;
      float h = smoothstep(0.0, 0.16, dir.y);         // bij de horizon versmelt het dek met de nevel
      vec3 col = mix(haze, tint * (0.85 + 0.15 * n), h);
      a = mix(min(a * 1.6, 1.0) * step(0.02, cover), a, h);
      gl_FragColor = vec4(col, a);
    }`,
  transparent: true, depthWrite: false, depthTest: true, side: THREE.BackSide,
});
const cloudDome = new THREE.Mesh(new THREE.SphereGeometry(5000, 48, 24), cloudMat);
cloudDome.renderOrder = -1; cloudDome.frustumCulled = false;
scene.add(cloudDome);
// Schaduwwerper: plat vlak op CLOUD_H, alleen zichtbaar voor de schaduwcamera (laag 1)
const cloudPlane = new THREE.Mesh(new THREE.PlaneGeometry(400000, 400000), new THREE.MeshBasicMaterial({ visible: true }));
cloudPlane.rotation.x = -Math.PI / 2; cloudPlane.position.y = CLOUD_H; cloudPlane.frustumCulled = false;
cloudPlane.layers.set(1); camera.layers.disable(1);
cloudPlane.castShadow = true; cloudPlane.receiveShadow = false;
cloudPlane.customDepthMaterial = new THREE.ShaderMaterial({     // wolkenschaduw: dezelfde ruis bepaalt waar licht doorkomt
  uniforms: cloudMat.uniforms,
  vertexShader: 'varying vec3 vWorld; void main(){ vec4 wp = modelMatrix * vec4(position, 1.0); vWorld = wp.xyz; gl_Position = projectionMatrix * viewMatrix * wp; }',
  fragmentShader: `#include <packing>
    uniform sampler2D noiseTex; uniform float cover, dens, time; varying vec3 vWorld;
    ${cloudNoise}
    void main(){
      float n = cloudNoise(vWorld.xz, time);
      float edge = 1.0 - cover;
      float a = smoothstep(edge - 0.10, edge + 0.22, n) * dens;
      if (a < 0.5) discard;
      gl_FragColor = packDepthToRGBA(gl_FragCoord.z);
    }`,
  side: THREE.DoubleSide,
});
scene.add(cloudPlane);

// Sneeuwdek: witte laag op vlakken die naar boven kijken, via een kleine toevoeging aan de standaardshader
const SNOW = { value: 0 };
function enableSnow(material, mask = 1) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uSnow = SNOW;
    shader.uniforms.uSnowMask = { value: mask };
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uSnow; uniform float uSnowMask;')
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        float snowUp = smoothstep(0.3, 0.8, inverseTransformDirection(normal, viewMatrix).y);
        float snowK = uSnow * uSnowMask * snowUp;
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.92, 0.93, 0.96), snowK);
        roughnessFactor = mix(roughnessFactor, 0.95, snowK);`);
  };
  material.customProgramCacheKey = () => 'snow' + mask;
  material.needsUpdate = true;
}

// Regen of sneeuw: korte vallende strepen (regen) of trage vlokjes (sneeuw) rond de camera
const RAIN_N = 1600, rainPos = new Float32Array(RAIN_N * 2 * 3);
for (let i = 0; i < RAIN_N; i++) {
  const x = (Math.random() - 0.5) * 120, y = Math.random() * 90, z = (Math.random() - 0.5) * 120;
  rainPos.set([x, y, z, x, y - 1.4, z], i * 6);
}
const rainGeo = new THREE.BufferGeometry();
rainGeo.setAttribute('position', new THREE.BufferAttribute(rainPos, 3));
const rain = new THREE.LineSegments(rainGeo, new THREE.LineBasicMaterial({ color: 0xcfd8e4, transparent: true, opacity: 0.35 }));
rain.visible = false; rain.frustumCulled = false; rain.material.fog = false;
scene.add(rain);
function stepRain(dt) {
  if (!rain.visible) return;
  const p = rainGeo.attributes.position.array;
  const snowing = rain.userData.snow;
  const fall = snowing ? 1.6 : 16, len = snowing ? 0.25 : 1.4;
  for (let i = 0; i < RAIN_N; i++) {
    let y = p[i * 6 + 1] - fall * dt;
    if (snowing) { p[i * 6] += Math.sin(cloudMat.uniforms.time.value * 1.3 + i) * 0.4 * dt; p[i * 6 + 3] = p[i * 6]; }
    if (y < 0) {                                           // druppel terug naar boven, beide eindpunten op dezelfde plek
      y += 90;
      const x = (Math.random() - 0.5) * 120, z = (Math.random() - 0.5) * 120;
      p[i * 6] = x; p[i * 6 + 2] = z; p[i * 6 + 3] = x; p[i * 6 + 5] = z;
    }
    p[i * 6 + 1] = y; p[i * 6 + 4] = y - len;
  }
  rainGeo.attributes.position.needsUpdate = true;
  rain.position.set(camera.position.x, Math.max(camera.position.y - 45, groundHeight(camera.position.x, camera.position.z)), camera.position.z);
  const high = THREE.MathUtils.clamp(1 - (camera.position.y - 250) / 400, 0, 1);   // op grote hoogte minder nadrukkelijk
  rain.material.opacity = rain.userData.opacity * high;
}

// Weer toepassen op licht, lucht, mist en wolken; `day` = daglichtfactor uit setSun
function applyWeather(date, day, sunDir) {
  const w = weatherAt(date);
  WX.cur = w;
  const thick = THREE.MathUtils.clamp(w.thick ?? w.cloud, 0, 1), thin = THREE.MathUtils.clamp(w.thin ?? 0, 0, 1);
  const cloud = Math.max(thick, thin), precip = Math.max(0, w.precip), vis = Math.max(150, w.vis);
  const thinOnly = Math.max(0, thin - thick);                                  // hoge sluier zonder laag dek: melkwitte zon
  const dim = 1 - 0.78 * thick * thick - 0.3 * thinOnly - (precip > 0.1 ? 0.1 : 0);
  sun.intensity *= Math.max(0.12, dim);
  sun.castShadow = sun.castShadow && dim > 0.3;
  hemi.intensity *= 1 + 0.25 * cloud;
  hemi.color.setRGB(0.81 + 0.1 * cloud, 0.88 - 0.02 * cloud, 1.0 - 0.1 * cloud);
  renderer.toneMappingExposure *= 1 - 0.22 * cloud - (precip > 0.1 ? 0.08 : 0);
  const haze = 1 - THREE.MathUtils.clamp(vis / 25000, 0, 1);
  su.turbidity.value = 2.5 + 12 * haze * haze + 2 * cloud;
  su.rayleigh.value = 2.0 - 0.8 * cloud;
  scene.fog.near = THREE.MathUtils.clamp(0.25 * vis, 80, 2500);
  scene.fog.far = THREE.MathUtils.clamp(1.3 * vis, 600, 14000);
  const fogGrey = 0.09 + 0.86 * day;                                         // 's nachts donkere nevel, geen grijze band
  scene.fog.color.setRGB(fogGrey * (0.86 + 0.1 * (1 - cloud)), fogGrey * 0.9, fogGrey * (0.96 + 0.04 * (1 - cloud)));
  const sunLow = THREE.MathUtils.clamp(1 - sunDir.y * 6, 0, 1) * day;      // lage zon kleurt de wolken
  const base = 0.98 - 0.42 * cloud;
  cloudMat.uniforms.tint.value.setRGB(base * day * (1 + 0.1 * sunLow) + 0.03, base * day * (1 - 0.15 * sunLow) + 0.03, base * day * (1 - 0.3 * sunLow) + 0.05);
  cloudMat.uniforms.cover.value = cloud;
  cloudMat.uniforms.dens.value = thick > 0.02 ? 0.8 + 0.2 * thick : 0.45 + 0.2 * thin;   // sluier blijft doorschijnend
  cloudMat.uniforms.haze.value.copy(scene.fog.color);
  cloudPlane.visible = cloud > 0.03; cloudDome.visible = cloud > 0.03;
  const temp = w.temp ?? 10, snowfall = Math.max(0, w.snowfall ?? 0), snow = Math.max(0, w.snow ?? 0), ice = THREE.MathUtils.clamp(w.ice ?? 0, 0, 1);
  const snowing = snowfall > 0.05 || (precip > 0.1 && temp < 1.5);
  rain.visible = snowing || precip > 0.1;
  rain.userData.snow = snowing;
  rain.material.color.set(snowing ? 0xffffff : 0xcfd8e4);
  rain.userData.opacity = snowing ? Math.min(0.9, 0.5 + 0.3 * snowfall) : Math.min(0.5, 0.2 + 0.15 * precip);
  SNOW.value = THREE.MathUtils.clamp(snow / 0.03, 0, 1);                          // 3 cm = gesloten dek
  setIce(ice, SNOW.value);
  const temps = `${Math.round(temp)} °C`;
  const desc = snowing ? `sneeuw ${snowfall.toFixed(1).replace('.', ',')} cm/u` : precip > 0.1 ? `regen ${precip.toFixed(1).replace('.', ',')} mm/u` : vis < 1500 ? 'mist' : thick > 0.85 ? 'bewolkt' : thinOnly > 0.5 ? 'sluierbewolking' : cloud > 0.45 ? 'halfbewolkt' : cloud > 0.15 ? 'licht bewolkt' : 'helder';
  const extra = [snow > 0.005 ? `sneeuwdek ${Math.round(snow * 100)} cm` : '', ice > 0.3 ? (ice > 0.8 ? 'ijs' : 'dun ijs') : ''].filter(Boolean).join(', ');
  return `${temps}, ${desc}${extra ? ', ' + extra : ''}${w.source === 'schatting' ? ' (schatting)' : ''}`;
}

// ---------- obstakelgrid (2 m): botsingen met gebouwen, boomkronen, stammen en water ----------
let BM = null, BARR = null;
const blockTmp = { v: 0, water: false, top: 0, base: 0 };
function blockAt(x, z) {                     // top = absolute bovenkant (m), base = onderkant boven maaiveld (m)
  blockTmp.v = 0; blockTmp.water = false;
  if (!BM) return blockTmp;
  const i = Math.floor((x - BM.x0) / BM.dx + 0.5), j = Math.floor((BM.z_south - z) / BM.dx + 0.5);
  if (i < 0 || j < 0 || i >= BM.nx || j >= BM.ny) return blockTmp;
  const v = BARR[j * BM.nx + i];
  blockTmp.v = v;
  if (v === 0xFFFF) { blockTmp.water = true; return blockTmp; }
  blockTmp.top = BM.hmin + (v >> 6) * 0.1;
  blockTmp.base = v & 63;
  return blockTmp;
}
function walkBlocked(x, z) {                 // lopen: gevels en stammen (onderkant 0) blokkeren, water tenzij dik ijs
  const b = blockAt(x, z);
  if (b.v === 0) return false;
  if (b.water) return (WX.cur.ice || 0) < 0.8;
  return b.base === 0 && b.top > groundHeight(x, z) + 0.5;
}
function flyBlocked(x, y, z) {               // vrij rondkijken: alles tussen onderkant en bovenkant blokkeert
  const b = blockAt(x, z);
  if (b.v === 0 || b.water) return false;
  return y < b.top + 0.5 && y > groundHeight(x, z) + b.base - 0.5;
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
  sun.position.copy(dir).multiplyScalar(9000);   // ver genoeg om boven het wolkendek (1500 m) te staan
  sun.target.position.set(0, 0, 0);
  su.sunPosition.value.copy(dir);
  const day = THREE.MathUtils.smoothstep(p.altitude, -0.06, 0.12);
  sun.intensity = 3.2 * day;
  hemi.intensity = 0.45 + 0.6 * day;
  renderer.toneMappingExposure = 0.36 + 0.24 * day;
  sun.castShadow = state.layers.schaduw && day > 0.05;
  const wdesc = applyWeather(date, day, dir);
  const hh = String(date.getHours()).padStart(2, '0'), mm = String(date.getMinutes()).padStart(2, '0');
  $('#sunlabel').textContent = `${hh}:${mm} · zon ${(p.altitude * 180 / Math.PI).toFixed(0)}° · ${wdesc}`;
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
$('#weather').addEventListener('change', () => { WX.mode = $('#weather').value; setSun(DAY.playing ? new Date(DAY.start.getTime() + DAY.p * (DAY.end - DAY.start)) : currentSunDate()); });

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
  buurtgrens: new THREE.Group(), maquette: new THREE.Group(), labels: new THREE.Group(), omgeving: new THREE.Group(),
};
for (const g of Object.values(layers)) scene.add(g);
layers.maquette.visible = false;
layers.buurtgrens.visible = false;

const terrainMeshes = [];
const plainMat = new THREE.MeshStandardMaterial({ color: 0xcfc8b8, roughness: 1 });
enableSnow(plainMat, 1);
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
    enableSnow(m, 1);
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
  enableSnow(m, 1);
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

let tMesh = null, twigMesh = null, tTid = null;
let wSeason = null, wSpec = null, seasonKey = null, SPECIES = [], TREES = null;
// Kronen die met het seizoen meekleuren: wijkbomen, omgevingsbomen en het bosdek van de omgeving. Een set zonder
// takkenmodel krijgt een 'bare'-instelling: kale kronen worden doorzichtig in takkenkleur in plaats van onzichtbaar.
const seasonSets = [];
function addSeasonSet(mesh, bare = null, blend = null) {    // blend: 'depth' of 'nodepth' = gewone transparantie i.p.v. alpha-hash
  const g = mesh.geometry;
  const season = g.getAttribute('_season'), spec = g.getAttribute('_spec'), col = g.getAttribute('color');
  if (!season || !spec || !col) return;
  seasonSets.push({ mesh, orig: col.array.slice(), season, spec, crown: g.getAttribute('_crown'), bare, blend });
  seasonKey = null;
  applySeason(currentSunDate());
}
function setupTrees(root) {
  root.traverse((o) => {
    if (!o.isMesh) return;
    o.material.roughness = 0.95; o.material.metalness = 0;
    if (o.name === 'takken') {
      twigMesh = o;
      o.castShadow = true; o.receiveShadow = false;
      const m = o.material;
      m.map = makeTwigTexture(); m.alphaTest = 0.5; m.alphaToCoverage = true; m.alphaHash = false; m.transparent = false;
      m.side = THREE.DoubleSide; m.vertexColors = true; m.roughness = 1;
      enableSnow(m, 0.5);
      wSeason = o.geometry.getAttribute('_season'); wSpec = o.geometry.getAttribute('_spec');
    } else {
      tMesh = o;
      o.castShadow = o.receiveShadow = true;
      enableSnow(o.material, 0.8);
      tTid = o.geometry.getAttribute('_tid');
    }
  });
  layers.bomen.add(root);
  if (tMesh) addSeasonSet(tMesh);
  else applySeason(currentSunDate());
}

// Procedurele takkentextuur: atlas van 5 tegels. Tegel 0-3: zijaanzicht met oplopende stamdikte (fractie van de
// tegelbreedte 0.025, 0.045, 0.08, 0.13, zie TWIG_TRUNK_FRAC in build_trees.py); tegel 4: bovenaanzicht. De stam
// loopt van de onderrand tot 0.3 van de hoogte, waar de stamcilinder van het model eindigt. Vertakking volgens het
// pijpmodel: de doorsneden van de zijtakken samen zijn die van de tak eronder, zodat de dikte netjes verjongt.
// Het alfakanaal codeert de dikte: dunne twijgen hebben lagere alfa en verdwijnen bij het uitdunnen het eerst.
function makeTwigTexture() {
  const TILE = 1024, W = TILE * 5, H = TILE, c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  let seed = 11;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  ctx.lineCap = 'round';
  const drawTree = (ox, trunkW) => {
    const alphaFor = (w) => 0.56 + 0.44 * Math.sqrt(Math.min(1, w / trunkW));
    const seg = (x, y, len, ang, w, depth, up) => {
      const bend = (rnd() - 0.5) * 0.3;
      const xm = x + Math.cos(ang + bend) * len * 0.5, ym = y + Math.sin(ang + bend) * len * 0.5;
      const x2 = xm + Math.cos(ang) * len * 0.5, y2 = ym + Math.sin(ang) * len * 0.5;
      ctx.strokeStyle = `rgba(74,58,46,${alphaFor(w).toFixed(3)})`;
      ctx.lineWidth = w; ctx.beginPath(); ctx.moveTo(x, y); ctx.quadraticCurveTo(xm, ym, x2, y2); ctx.stroke();
      if (depth <= 0 || w < 0.8) return;
      const k = 2 + (rnd() < 0.5 ? 1 : 0);
      let shares = []; let tot = 0;
      for (let i = 0; i < k; i++) { const v = 0.6 + rnd(); shares.push(v); tot += v; }
      shares = shares.map((v) => v / tot * 0.92);                           // 8% verlies: taps toelopen
      for (let i = 0; i < k; i++) {
        const wc = w * Math.sqrt(shares[i]);
        const da = (rnd() - 0.5) * 1.0 + (i - (k - 1) / 2) * 0.62 - (up ? 0.1 : 0);
        seg(x2, y2, len * (0.55 + 0.35 * Math.sqrt(shares[i])) * (0.9 + rnd() * 0.2), ang + da, wc, depth - 1, up);
      }
    };
    // stam: van de onderrand (y=H) recht omhoog tot 0.3 H, daar splitst hij
    ctx.strokeStyle = `rgba(74,58,46,1)`; ctx.lineWidth = trunkW; ctx.lineCap = 'butt';
    ctx.beginPath(); ctx.moveTo(ox + TILE / 2, H); ctx.lineTo(ox + TILE / 2, H * 0.7); ctx.stroke();
    ctx.lineCap = 'round';
    const k = 3 + (rnd() < 0.5 ? 1 : 0);
    let shares = []; let tot = 0;
    for (let i = 0; i < k; i++) { const v = 0.6 + rnd(); shares.push(v); tot += v; }
    shares = shares.map((v) => v / tot * 0.95);
    for (let i = 0; i < k; i++) {
      const wc = trunkW * Math.sqrt(shares[i]);
      const ang = -Math.PI / 2 + (i - (k - 1) / 2) * 0.5 + (rnd() - 0.5) * 0.3;
      seg(ox + TILE / 2, H * 0.7, H * 0.26 * (0.8 + 0.4 * Math.sqrt(shares[i])), ang, wc, 9, true);
    }
  };
  [0.025, 0.045, 0.08, 0.13].forEach((f, i) => { seed = 11 + i * 97; drawTree(i * TILE, f * TILE); });
  seed = 5;                                                                   // bovenaanzicht: takken vanuit het midden
  const cx = 4 * TILE + TILE / 2, cy = TILE / 2;
  const k = 7 + (rnd() < 0.5 ? 1 : 0);
  for (let i = 0; i < k; i++) {
    const a = i / k * Math.PI * 2 + rnd() * 0.5;
    const w = 20;
    const seg2 = (x, y, len, ang, ww, depth) => {
      const x2 = x + Math.cos(ang) * len, y2 = y + Math.sin(ang) * len;
      ctx.strokeStyle = `rgba(74,58,46,${(0.56 + 0.44 * Math.sqrt(Math.min(1, ww / 20))).toFixed(3)})`;
      ctx.lineWidth = ww; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x2, y2); ctx.stroke();
      if (depth <= 0 || ww < 0.8) return;
      const kk = 2 + (rnd() < 0.4 ? 1 : 0);
      for (let j = 0; j < kk; j++) seg2(x2, y2, len * (0.6 + rnd() * 0.2), ang + (rnd() - 0.5) * 1.1 + (j - (kk - 1) / 2) * 0.5, ww * 0.62, depth - 1);
    };
    seg2(cx, cy, 150 + rnd() * 70, a, w, 7);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.flipY = false;                                                // uv's volgen de glTF-conventie (0,0 = linksboven)
  tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = maxAniso;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = true; tex.minFilter = THREE.LinearMipmapLinearFilter;
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
  if (!seasonSets.length || !SPECIES.length) return;
  const key = date.getFullYear() * 1000 + Math.floor((date - new Date(date.getFullYear(), 0, 1)) / 86400000);
  if (key === seasonKey) return;
  seasonKey = key;
  const doy0 = (date - new Date(date.getFullYear(), 0, 1)) / 86400000;
  for (const set of seasonSets) {
    const col = set.mesh.geometry.getAttribute('color');
    const arr = col.array, k = col.itemSize, orig = set.orig, crown = set.crown, bare = set.bare;
    let anyAlpha = false;
    for (let i = 0; i < col.count; i++) {
      if (crown && crown.getX(i) < 0.5) continue;
      const r = set.season.getX(i);
      const prof = SPECIES[set.spec.getX(i) | 0] || SPECIES[0];
      const doy = doy0 - (r - 0.5) * 14;                            // per boom tot een week vroeger of later
      const f = seasonFactors(doy, prof);
      let R = orig[i * k] / 255, G = orig[i * k + 1] / 255, B = orig[i * k + 2] / 255;
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
      let alpha = prof.evergreen ? 1 : THREE.MathUtils.clamp(Math.max(f.leaf, f.blossom * 0.95), 0, 1);
      if (bare && alpha < 1) {                                       // geen takkenmodel: kale kroon wordt doorzichtig bruin
        const t = 1 - alpha;
        R = R * (1 - t) + bare.col[0] * t; G = G * (1 - t) + bare.col[1] * t; B = B * (1 - t) + bare.col[2] * t;
        alpha = Math.max(alpha, bare.alpha);
      }
      arr[i * k] = Math.round(THREE.MathUtils.clamp(R, 0, 1) * 255);
      arr[i * k + 1] = Math.round(THREE.MathUtils.clamp(G, 0, 1) * 255);
      arr[i * k + 2] = Math.round(THREE.MathUtils.clamp(B, 0, 1) * 255);
      if (k === 4) {
        arr[i * k + 3] = Math.round(alpha * 255);
        if (alpha < 0.995) anyAlpha = true;
      }
    }
    col.needsUpdate = true;
    const m = set.mesh.material;
    if (set.blend) {                                                  // mengen in plaats van hash-ruis; 'depth' houdt de
      if (m.transparent !== anyAlpha) {                                 // dieptebuffer zodat kronen elkaar netjes afdekken
        m.transparent = anyAlpha; m.depthWrite = !anyAlpha || set.blend === 'depth'; m.needsUpdate = true;
      }
    } else if (m.alphaHash !== anyAlpha) { m.alphaHash = anyAlpha; m.transparent = false; m.needsUpdate = true; }
  }
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
    ${t.stamomtrek ? `<tr><td>Stamomtrek</td><td>${String(t.stamomtrek).replace('.', ',')} cm (register)</td></tr>` : t.stam ? `<tr><td>Stamdikte</td><td>${t.stam.toFixed(2).replace('.', ',')} m (geschat)</td></tr>` : ''}
    ${t.beschermd ? `<tr><td></td><td>Beschermwaardige boom</td></tr>` : ''}
    <tr><td>Bron</td><td>${bron}</td></tr>
  </table>`;
}

const waterMats = [];                  // [materiaal, basiskleur] van wijk- en omgevingswater
function setupWaterMaterial(m) {
  m.transparent = true; m.opacity = 0.82; m.depthWrite = false; m.roughness = 0.12; m.metalness = 0.05;
  waterMats.push([m, m.color.clone()]);
  enableSnow(m, 1);
}
function setupWater(root) {
  root.traverse((o) => { if (o.isMesh) { setupWaterMaterial(o.material); o.receiveShadow = true; } });
  layers.water.add(root);
}
function setIce(ice, snow) {          // bevroren water: mat, licht grijsblauw en dicht; sneeuw erop via de shader
  for (const [m, base] of waterMats) {
    m.color.copy(base).lerp(new THREE.Color(0.78, 0.83, 0.87), ice);
    m.opacity = 0.82 + 0.18 * ice;
    m.roughness = 0.12 + 0.55 * ice;
    m.depthWrite = ice > 0.5;
  }
}

// ---------- omgeving: ring (6 x 6 km) en buitenzone (10 x 10 km), grof en niet bevliegbaar ----------
// Meshnamen: *_terrein (luchtfototextuur), *_gebouwen[_nabij] (vlakke schaduw, nabij werpt schaduw), *_water,
// omgeving_bomen[_nabij] (kronen met seizoen, zonder takken), omgeving_bos (kroonlaag over dichte bossen).
function setupContext(gltf) {
  if (!gltf) return;
  const bareTree = { alpha: 0.35, col: [0.47, 0.42, 0.38] }, bareForest = { alpha: 0.55, col: [0.40, 0.35, 0.31] };
  const meshes = [];
  gltf.scene.traverse((o) => { if (o.isMesh) meshes.push(o); });
  for (const o of meshes) {
    const n = o.name, m = o.material;
    m.metalness = 0;
    if (n.includes('terrein')) {
      m.roughness = 1;
      if (m.map) m.map.anisotropy = maxAniso;
      o.receiveShadow = true;
      enableSnow(m, 1);
    } else if (n.includes('water')) {
      setupWaterMaterial(m);
    } else if (n.includes('bomen') || n.includes('bos')) {
      m.vertexColors = true; m.roughness = 0.95;
      if (n.includes('bos')) m.side = THREE.DoubleSide;
      enableSnow(m, 0.8);
      if (n.includes('nabij')) o.castShadow = o.receiveShadow = true;
      addSeasonSet(o, n.includes('bos') ? bareForest : bareTree, n.includes('nabij') ? 'depth' : 'nodepth');
    } else {
      m.vertexColors = true; m.flatShading = true; m.roughness = 0.9;
      enableSnow(m, 1);
      if (n.includes('nabij')) o.castShadow = o.receiveShadow = true;
    }
    layers.omgeving.add(o);
  }
  layers.omgeving.visible = state.layers.omgeving;
}

function setupMaquette(root) {
  root.traverse((o) => {
    if (!o.isMesh) return;
    const m = o.material;
    m.vertexColors = true; m.roughness = 1; m.metalness = 0;
    m.polygonOffset = true; m.polygonOffsetFactor = -1; m.polygonOffsetUnits = -2;
    o.receiveShadow = true;
    enableSnow(m, 1);
  });
  layers.maquette.add(root);
}

function setupGrens(data) {
  if (data.lijnen.length) GRENS = data.lijnen[0].map((p) => [p[0], p[2]]);
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
    case 'omgeving': layers.omgeving.visible = on; break;
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
  if (f.t >= f.dur) { state.flying = null; controls.enabled = true; controls.update(); camPrev.copy(camera.position); }
}
$('#btnOverzicht').addEventListener('click', () => flyTo(HOME.target, HOME.pos));

// ---------- dag afspelen: zon van opkomst tot ondergang met een willekeurige, botsingsvrije vlucht ----------
const DAY = { playing: false, p: 0, duration: 130, start: null, end: null, N: 2400, P: null, T: null, knots: null,
              panelWasCollapsed: false, street: null };
let SM = null, SARR = null, STREETS = [], GRENS = null;   // GRENS: buurtpolygoon als [x, z]-punten
const rnd = (a, b) => a + Math.random() * (b - a);
const DAY_C = { x: 5, z: -27 };                            // middelpunt van de buurt (lokaal: x oost, z zuid)
function grensRadius(ang) {   // afstand van het middelpunt tot de buurtgrens in richting ang
  if (!GRENS) return 350;
  const dx = Math.cos(ang), dz = Math.sin(ang);
  let best = 0;
  for (let i = 0; i < GRENS.length; i++) {
    const [ax, az] = GRENS[i], [bx, bz] = GRENS[(i + 1) % GRENS.length];
    const ex = bx - ax, ez = bz - az, den = dx * ez - dz * ex;
    if (Math.abs(den) < 1e-9) continue;
    const t = ((ax - DAY_C.x) * ez - (az - DAY_C.z) * ex) / den;   // afstand langs de straal
    const u = ((ax - DAY_C.x) * dz - (az - DAY_C.z) * dx) / den;   // positie op het grenssegment
    if (t > 0 && u >= 0 && u <= 1) best = Math.max(best, t);
  }
  return best || 350;
}
function grensDist(x, z) {    // afstand tot de buurtgrens, negatief binnen de buurt
  if (!GRENS) return -1;
  let inside = false, m = Infinity;
  for (let i = 0, j = GRENS.length - 1; i < GRENS.length; j = i++) {
    const [ax, az] = GRENS[i], [bx, bz] = GRENS[j];
    if ((az > z) !== (bz > z) && x < (bx - ax) * (z - az) / (bz - az) + ax) inside = !inside;
    const ex = bx - ax, ez = bz - az, L2 = ex * ex + ez * ez || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / L2));
    m = Math.min(m, Math.hypot(x - ax - t * ex, z - az - t * ez));
  }
  return inside ? -m : m;
}
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
  const C = V3(DAY_C.x, 0, DAY_C.z);
  const keys = [];
  // Vast begin: recht boven de wijk, kantelen, zonsopkomst vanaf de westkant, 40-110 m buiten de buurtgrens
  const edgeCam = (ang, h) => { const r = grensRadius(ang) + rnd(40, 110); return V3(C.x + Math.cos(ang) * r, h, C.z + Math.sin(ang) * r); };
  const riseCam = edgeCam(Math.PI + rnd(-0.1, 0.4), rnd(55, 85));
  keys.push({ p: 0.000, pos: V3(5, 900, 10), tgt: V3(5, 0, -60) });
  keys.push({ p: 0.040, pos: V3(-300, 380, 220), tgt: V3(20, 0, -60) });
  keys.push({ p: 0.075, pos: riseCam, tgt: riseCam.clone().addScaledVector(rise, 700) });
  // Willekeurige lus: van west naar oost, anderhalve ronde om en door de wijk op wisselende hoogtes; de straal
  // volgt de buurtpolygoon (55-100% van de afstand tot de grens, hooguit 30 m erbuiten)
  const dir = Math.random() < 0.5 ? 1 : -1;
  const n = 4 + Math.floor(Math.random() * 3);
  const a0 = Math.atan2(riseCam.z - C.z, riseCam.x - C.x);
  const total = Math.PI * rnd(2.7, 3.3);
  const randTgt = () => V3(rnd(-300, 300), rnd(5, 25), rnd(-260, 200));
  const tour = [];
  for (let i = 1; i <= n; i++) {
    const ang = a0 + dir * total * (i / (n + 1));
    const r = Math.max(150, grensRadius(ang) * rnd(0.55, 1.0) + rnd(-10, 30));
    tour.push({ pos: V3(C.x + Math.cos(ang) * r, rnd(45, 190), C.z + Math.sin(ang) * r), tgt: randTgt(), w: 1, ang });
  }
  // Eén korte lage pas door een straatcorridor of over water (uit streets.json) met beide einden binnen 40 m
  // (water: 150 m) van de buurtgrens, ingevoegd waar de lus er het dichtst bij komt, met aanvlieg- en
  // uitvliegpunten in het verlengde van de corridor (hooguit 120 m) voor een rechte aanloop.
  DAY.street = null;
  const cands = STREETS.filter((s) => [s.a, s.b].every((q) => grensDist(q[0], q[2]) <= (s.type === 'water' ? 150 : 40)));
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
    const atd = (m, h) => { const q = A.clone().addScaledVector(d, m); q.y = groundHeight(q.x, q.z) + h; return q; };
    const extent = (sign) => {        // aanloop in het verlengde: tot 120 m, maar hooguit 60 m buiten de buurtgrens
      let e = Math.min(L, 120);
      for (; e > 40; e -= 10) { const q = atd(sign > 0 ? L + e : -e, 0); if (grensDist(q.x, q.z) <= 60) break; }
      return e;
    };
    const extIn = extent(-1), extOut = extent(1);
    const far = atd(L, 6);
    const pass = [
      { pos: atd(-extIn, 60), tgt: far, w: 1.2, street: true },                 // aanvliegpunt
      { pos: atd(0, 24), tgt: far, w: 1.5, street: true },
      { pos: atd(0.3 * L, 12), tgt: far, w: 2, street: true },
      { pos: atd(0.7 * L, 12), tgt: atd(L + extOut, 10), w: 2, street: true },
      { pos: atd(L, 24), tgt: atd(L + extOut, 10), w: 1.5, street: true },
      { pos: atd(L + extOut, 60), tgt: atd(L + 2 * extOut, 20), w: 1.2, street: true },  // uitvliegpunt
    ];
    tour.splice(best + 1, 0, ...pass);
    DAY.street = { A, B, d, L };
  }
  // Vast einde: zonsondergang vanaf de oostkant, 40-110 m buiten de buurtgrens, kijkend over de wijk
  const setCam = edgeCam(rnd(-0.4, 0.25), rnd(90, 130));
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
  // daar daalt de baan met een Hermite-overgang (aansluitende helling) naar 12 m boven weg of water en klimt
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
        const g = groundHeight(P[i * 3], P[i * 3 + 2]) + 12;        // lage pas: 12 m boven weg of water
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
    P[i * 3 + 1] = inStreet[i] ? Math.max(y1[i], g + 10) : Math.max(y1[i], needS[i]);
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
  camPrev.copy(camera.position);
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
  camPrev.copy(camera.position);
});
$('#btnWalk').addEventListener('click', () => { if (state.walking) plc.unlock(); else enterWalk(); });
const walkPrev = new THREE.Vector3();
function stepWalk(dt) {
  const run = keys.ShiftLeft || keys.ShiftRight;
  const speed = run ? 12 : 6;                                     // stevig tempo; Shift = sprint
  const fwd = (keys.KeyW || keys.ArrowUp ? 1 : 0) - (keys.KeyS || keys.ArrowDown ? 1 : 0);
  const right = (keys.KeyD || keys.ArrowRight ? 1 : 0) - (keys.KeyA || keys.ArrowLeft ? 1 : 0);
  walkPrev.copy(camera.position);
  if (fwd) plc.moveForward(fwd * speed * dt);
  if (right) plc.moveRight(right * speed * dt);
  camera.position.x = THREE.MathUtils.clamp(camera.position.x, -695, 695);
  camera.position.z = THREE.MathUtils.clamp(camera.position.z, -595, 595);
  if (walkBlocked(camera.position.x, camera.position.z)) {        // botsing: glijd langs het obstakel
    const nx = camera.position.x, nz = camera.position.z;
    if (!walkBlocked(nx, walkPrev.z)) camera.position.z = walkPrev.z;
    else if (!walkBlocked(walkPrev.x, nz)) camera.position.x = walkPrev.x;
    else { camera.position.x = walkPrev.x; camera.position.z = walkPrev.z; }
  }
  const gy = groundHeight(camera.position.x, camera.position.z) + 1.7;
  camera.position.y += (gy - camera.position.y) * Math.min(1, dt * 10);
}
const camPrev = new THREE.Vector3(), camDelta = new THREE.Vector3();
const FENCE = { x: 700, z: 600, margin: 150, top: 1200 };
function clampCamera() {                                            // vrij rondkijken: niet onder de grond, niet door objecten
  // hek: kijkpunt in het werkgebied, camera hooguit `margin` daarbuiten en niet hoger dan `top`
  controls.target.x = THREE.MathUtils.clamp(controls.target.x, -FENCE.x, FENCE.x);
  controls.target.z = THREE.MathUtils.clamp(controls.target.z, -FENCE.z, FENCE.z);
  camera.position.x = THREE.MathUtils.clamp(camera.position.x, -FENCE.x - FENCE.margin, FENCE.x + FENCE.margin);
  camera.position.z = THREE.MathUtils.clamp(camera.position.z, -FENCE.z - FENCE.margin, FENCE.z + FENCE.margin);
  camera.position.y = Math.min(camera.position.y, FENCE.top);
  const gy = groundHeight(camera.position.x, camera.position.z) + 1.7;
  if (camera.position.y < gy) camera.position.y = gy;
  if (flyBlocked(camera.position.x, camera.position.y, camera.position.z)) {
    camDelta.subVectors(camPrev, camera.position);                  // terug naar de vorige vrije positie
    camera.position.copy(camPrev);
    controls.target.add(camDelta);
  }
  camPrev.copy(camera.position);
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
  cloudMat.uniforms.time.value += dt;
  cloudDome.position.copy(camera.position);
  stepRain(dt);
  if (seasonWeatherDirty) { seasonWeatherDirty = false; setSun(DAY.playing ? new Date(DAY.start.getTime() + DAY.p * (DAY.end - DAY.start)) : currentSunDate()); }
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
  const scriptVer = new URL(import.meta.url).searchParams.get('v');   // versie uit de deploy (git-commit), anders bouwdatum
  VER = '?v=' + encodeURIComponent(scriptVer && scriptVer !== '__VERSION__' ? scriptVer : (meta.gebouwd || ''));
  [lon, lat] = meta.origin_lonlat;
  HM = meta.heights;
  HARR = new Uint16Array(await (await fetch(MODEL + 'heights_2m.u16' + VER)).arrayBuffer());
  SM = meta.surface || null;
  if (SM) SARR = new Uint16Array(await (await fetch(MODEL + 'surface_4m.u16' + VER)).arrayBuffer());
  BM = meta.block || null;
  if (BM) BARR = new Uint16Array(await (await fetch(MODEL + 'block_2m.u16' + VER)).arrayBuffer());
  camPrev.copy(camera.position);
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
  let chain = Promise.resolve();
  for (const f of ['context_terrain.glb', 'context_objects.glb', 'context_trees.glb', 'context_outer_terrain.glb', 'context_outer_objects.glb'])
    chain = chain.then(() => loadGLB(f).then(setupContext).catch((e) => console.warn(f, e)));
}
window.R3D = { THREE, scene, camera, renderer, controls, sun, hemi, sky, layers, state, setSun, flyTo, groundHeight, orbitBy, northUp, DAY, startDay, stopDay, setDayProgress, surfaceMax, applySeason, seasonFactors, seasonSets, WX, applyWeather, cloudMat, cloudDome, cloudPlane, SNOW, blockAt, walkBlocked, flyBlocked, buildDay, grensRadius, grensDist, STREETS };

init().catch((e) => {
  console.error(e);
  $('#progress').textContent = 'Fout bij laden: ' + e.message + ' (open de viewer via een lokale webserver, zie README)';
});
