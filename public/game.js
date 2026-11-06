// ═══════════════════════════════════════════════════════
//  SKY FRONT — client
// ═══════════════════════════════════════════════════════
import * as THREE from 'three';

const socket = io({ transports: ['websocket', 'polling'] });
const $ = id => document.getElementById(id);

// ── constants (keep in sync with server) ──
const MAP_HALF = 4500;
// ground air-defence (ПВО) sites on mountain tops
// they only engage jets that cross the border hills (out of the battle area)
const SAM_RANGE = 3000, SAM_LOCK = 1.4, SAM_CD = 5, SAM_DMG = 40, EDGE = MAP_HALF - 40;
const MAX_HP = 100;
const BULLET_SPEED = 680, FIRE_RATE = 9, BULLET_LIFE = 1.3, CONVERGE = 360;
const HEAT_PER_SHOT = 0.05, COOL_RATE = 0.3, BASE_DMG = 7;
const MIN_SPEED = 60, CEILING = 3000;
// missiles: lock-on, chase for HOMING_TIME, then fly straight and self-destruct
const MISSILE_MAX = 2, MISSILE_RELOAD = 8, MISSILE_SPEED = 360, MISSILE_TURN = 2.1, HOMING_TIME = 4, MISSILE_LIFE = 6.5;
const MISSILE_DMG = 45, MISSILE_FUSE = 9, LOCK_TIME = 1.3, LOCK_CONE = 0.13, LOCK_KEEP = 0.24, LOCK_RANGE = 1100;
const FLARES_MAX = 3, FLARE_DECOY_RANGE = 650;
const TEAM_COL = [0x6f7d40, 0x3f6283];
const FFA_COLS = [0x6f7d40, 0x3f6283, 0x8a4b3a, 0x7a6a45, 0x5b5f66, 0x4a6e5c, 0x7b5a7a, 0x8a7a2e, 0x355058, 0x6b4f35];
const TAU = Math.PI * 2;

// ── state ──
let myId = null, room = null, inGame = false, worldSeed = null;
let roundStartAt = 0, spectating = false, specId = null, myDeathAt = 0;
const planes = new Map();     // id -> plane
let world = null;

// ═══════════ MENU / LOBBY UI ═══════════
const nameIn = $('name');
try { nameIn.value = localStorage.getItem('sf_name') || ''; } catch (e) {}
const digitEls = [...document.querySelectorAll('#digits input')];
digitEls.forEach((el, i) => {
  el.addEventListener('input', () => {
    el.value = el.value.replace(/\D/g, '').slice(-1);
    if (el.value && i < 5) digitEls[i + 1].focus();
    if (digitCode().length === 6) $('joinBtn').focus();
  });
  el.addEventListener('keydown', e => {
    if (e.key === 'Backspace' && !el.value && i > 0) digitEls[i - 1].focus();
    if (e.key === 'Enter') doJoin();
  });
  el.addEventListener('paste', e => {
    const t = (e.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, 6);
    if (t.length) { e.preventDefault(); t.split('').forEach((c, k) => digitEls[k] && (digitEls[k].value = c)); digitEls[Math.min(5, t.length)].focus(); }
  });
});
const digitCode = () => digitEls.map(e => e.value).join('');
const urlCode = (new URLSearchParams(location.search).get('code') || '').replace(/\D/g, '').slice(0, 6);
if (urlCode.length === 6) urlCode.split('').forEach((c, i) => digitEls[i].value = c);

function saveName() { try { localStorage.setItem('sf_name', nameIn.value.trim()); } catch (e) {} }
function showScreen(id) {
  for (const s of ['menu', 'lobby', 'pause', 'result']) $(s).classList.toggle('on', s === id);
}
$('createBtn').onclick = () => {
  audio.unlock(); saveName();
  socket.emit('create', { name: nameIn.value }, r => {
    if (!r.ok) return $('err').textContent = r.err;
    myId = r.id; history.replaceState(null, '', '?code=' + r.code); showScreen('lobby');
  });
};
function doJoin() {
  audio.unlock(); saveName();
  const code = digitCode();
  if (code.length !== 6) return $('err').textContent = 'Введите 6-значный код';
  socket.emit('join', { code, name: nameIn.value }, r => {
    if (!r.ok) return $('err').textContent = r.err;
    myId = r.id; history.replaceState(null, '', '?code=' + r.code); showScreen('lobby');
  });
}
$('joinBtn').onclick = doJoin;
$('copyBtn').onclick = () => {
  const link = location.origin + location.pathname + '?code=' + room.code;
  (navigator.clipboard ? navigator.clipboard.writeText(link) : Promise.reject()).then(
    () => { $('copyBtn').textContent = 'Ссылка скопирована'; setTimeout(() => $('copyBtn').textContent = 'Скопировать ссылку', 1500); },
    () => prompt('Ссылка-приглашение', link));
};
$('mTeam').onclick = () => socket.emit('setMode', 'team');
$('mFfa').onclick = () => socket.emit('setMode', 'ffa');
$('startBtn').onclick = () => { audio.unlock(); socket.emit('start'); };
$('leaveBtn').onclick = $('pLeaveBtn').onclick = $('resLeave').onclick = () => { location.href = location.pathname; };
$('resumeBtn').onclick = () => { showScreen(null); lockPointer(); };
$('pLobbyBtn').onclick = () => socket.emit('toLobby');
$('resLobby').onclick = () => socket.emit('toLobby');
$('resAgain').onclick = () => socket.emit('start');

function isHost() { return room && room.hostId === myId; }
function me() { return room && room.players.find(p => p.id === myId); }

function renderLobby() {
  if (!room) return;
  $('codebig').innerHTML = room.code.split('').map(c => `<b>${c}</b>`).join('');
  $('pcode').textContent = room.code;
  $('mTeam').classList.toggle('on', room.mode === 'team');
  $('mFfa').classList.toggle('on', room.mode === 'ffa');
  $('mTeam').disabled = $('mFfa').disabled = !isHost();
  const chip = p => `<div class="chip ${p.id === myId ? 'me' : ''}"><span>${esc(p.name)}</span>${p.id === room.hostId ? '<i>ХОСТ</i>' : ''}</div>`;
  if (room.mode === 'team') {
    const col = (t, nm, c) => `<div class="team"><h4 style="color:${c}">${nm}<button data-t="${t}">${me() && me().team === t ? 'ВАША КОМАНДА' : 'ВОЙТИ'}</button></h4>${room.players.filter(p => p.team === t).map(chip).join('')}</div>`;
    $('teams').innerHTML = col(0, 'АЛЬФА', 'var(--a)') + col(1, 'БРАВО', 'var(--b)');
    $('teams').querySelectorAll('button').forEach(b => b.onclick = () => socket.emit('setTeam', +b.dataset.t));
  } else {
    $('teams').innerHTML = `<div class="team"><h4>ВСЕ ПРОТИВ ВСЕХ · ${room.players.length}/10</h4>${room.players.map(chip).join('')}</div>`;
  }
  $('startBtn').disabled = !isHost();
  $('startBtn').textContent = isHost() ? (room.players.length < 2 ? 'Начать (тренировка)' : 'Начать бой') : 'Ожидание хоста…';
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ═══════════ AUDIO ═══════════
const audio = (() => {
  let ctx = null, master = null, muted = false, unlocked = false;
  const buffers = {};
  const music = new Audio('audio/tank_epic.mp3');
  music.loop = true; music.volume = 0.35;
  let engOsc, engOsc2, engGain, engFilter, noiseBuf = null;
  async function load(name) {
    try {
      const r = await fetch('audio/' + name + '.mp3');
      buffers[name] = await ctx.decodeAudioData(await r.arrayBuffer());
    } catch (e) {}
  }
  function unlock() {
    if (unlocked) return; unlocked = true;
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain(); master.gain.value = 0.9;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.knee.value = 8; comp.ratio.value = 6; comp.attack.value = 0.003; comp.release.value = 0.2;
    master.connect(comp); comp.connect(ctx.destination);
    // white-noise buffer for the missile launch whoosh
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 1.5, ctx.sampleRate);
    const nd = noiseBuf.getChannelData(0); for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    ['shoot', 'hit', 'ricochet', 'energy', 'victory'].forEach(load);
    // propeller engine drone
    engOsc = ctx.createOscillator(); engOsc.type = 'sawtooth'; engOsc.frequency.value = 70;
    engOsc2 = ctx.createOscillator(); engOsc2.type = 'square'; engOsc2.frequency.value = 35;
    engFilter = ctx.createBiquadFilter(); engFilter.type = 'lowpass'; engFilter.frequency.value = 400;
    engGain = ctx.createGain(); engGain.gain.value = 0;
    const g2 = ctx.createGain(); g2.gain.value = 0.4;
    engOsc.connect(engFilter); engOsc2.connect(g2); g2.connect(engFilter);
    engFilter.connect(engGain); engGain.connect(master);
    engOsc.start(); engOsc2.start();
    if (!muted) music.play().catch(() => {});
  }
  function play(name, vol = 1, pan = 0, rate = 1) {
    if (!ctx || muted || !buffers[name] || vol <= 0.01) return;
    const s = ctx.createBufferSource(); s.buffer = buffers[name]; s.playbackRate.value = rate;
    const g = ctx.createGain(); g.gain.value = vol;
    let node = s;
    if (ctx.createStereoPanner) { const p = ctx.createStereoPanner(); p.pan.value = Math.max(-1, Math.min(1, pan)); s.connect(p); node = p; }
    node.connect(g); g.connect(master); s.start();
  }
  function at(name, pos, vol = 1, rate = 1) {
    if (!camera) return play(name, vol);
    const dx = pos.x - camera.position.x, dz = pos.z - camera.position.z, dy = pos.y - camera.position.y;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const att = Math.max(0, 1 - d / 700) ** 1.6;
    camera.getWorldDirection(_a1);
    const right = _a2.set(-_a1.z, 0, _a1.x).normalize();
    const pan = d > 0.1 ? (dx * right.x + dz * right.z) / d : 0;
    play(name, vol * att, pan * 0.8, rate);
  }
  function engine(throttle, speed, boost) {
    if (!ctx) return;
    const t = ctx.currentTime, on = muted ? 0 : 1;
    engGain.gain.setTargetAtTime(on * (0.012 + throttle * 0.016 + boost * 0.014), t, 0.15);
    engOsc.frequency.setTargetAtTime(62 + throttle * 46 + speed * 18 + boost * 20, t, 0.25);
    engOsc2.frequency.setTargetAtTime(31 + throttle * 23 + speed * 9 + boost * 10, t, 0.25);
    engFilter.frequency.setTargetAtTime(380 + throttle * 500 + boost * 400, t, 0.25);
  }
  function engineOff() { if (ctx) engGain.gain.setTargetAtTime(0, ctx.currentTime, 0.3); }
  function setMusicVol(v) { music.volume = v; }
  function toggle() {
    muted = !muted;
    $('mute').textContent = muted ? '✕' : '♪';
    if (muted) { music.pause(); engineOff(); } else if (unlocked) music.play().catch(() => {});
  }
  function tone(freq, dur = 0.06, vol = 0.06) {
    if (!ctx || muted) return;
    const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = freq;
    const g = ctx.createGain(); g.gain.value = vol; g.gain.setTargetAtTime(0, ctx.currentTime + dur * 0.7, 0.01);
    o.connect(g); g.connect(master); o.start(); o.stop(ctx.currentTime + dur + 0.05);
  }
  // rocket motor: filtered noise sweeping up, fading out
  function whoosh(vol = 1, pan = 0) {
    if (!ctx || muted || !noiseBuf || vol <= 0.01) return;
    const t = ctx.currentTime;
    const s = ctx.createBufferSource(); s.buffer = noiseBuf;
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 0.9;
    f.frequency.setValueAtTime(350, t); f.frequency.exponentialRampToValueAtTime(2600, t + 0.35); f.frequency.exponentialRampToValueAtTime(900, t + 1.3);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol * 1.4, t + 0.05); g.gain.exponentialRampToValueAtTime(0.0001, t + 1.4);
    let node = f;
    s.connect(f);
    if (ctx.createStereoPanner) { const p = ctx.createStereoPanner(); p.pan.value = Math.max(-1, Math.min(1, pan)); f.connect(p); node = p; }
    node.connect(g); g.connect(master); s.start(t); s.stop(t + 1.5);
  }
  function whooshAt(pos, vol = 1) {
    const dx = pos.x - camera.position.x, dy = pos.y - camera.position.y, dz = pos.z - camera.position.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    whoosh(vol * Math.max(0, 1 - d / 700) ** 1.6, 0);
  }
  return { unlock, play, at, engine, engineOff, setMusicVol, toggle, tone, whoosh, whooshAt };
})();
$('mute').onclick = () => { audio.unlock(); audio.toggle(); };
const _a1 = new THREE.Vector3(), _a2 = new THREE.Vector3();

// ═══════════ THREE SETUP ═══════════
const canvas = $('gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
const scene = new THREE.Scene();
const SKY = new THREE.Color(0xbcc6c8);
scene.background = SKY;
scene.fog = new THREE.Fog(SKY, 1000, 4300);
const camera = new THREE.PerspectiveCamera(65, 1, 0.5, 6000);
camera.position.set(0, 300, 700); camera.lookAt(0, 0, 0);

const hemi = new THREE.HemisphereLight(0xe2e9ec, 0x4a4636, 1.3);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffe6c4, 2.3);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
const SC = 140;
Object.assign(sun.shadow.camera, { left: -SC, right: SC, top: SC, bottom: -SC, near: 1, far: 900 });
sun.shadow.bias = -0.0008; sun.shadow.normalBias = 1;
scene.add(sun, sun.target);
const SUN_DIR = new THREE.Vector3(0.55, 0.75, 0.35).normalize();

{
  const g = new THREE.SphereGeometry(3500, 24, 12);
  const m = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { top: { value: new THREE.Color(0x6f8ea6) }, bot: { value: SKY } },
    vertexShader: 'varying vec3 vp; void main(){ vp=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }',
    fragmentShader: 'uniform vec3 top; uniform vec3 bot; varying vec3 vp; void main(){ float h=clamp(normalize(vp).y*2.0,0.,1.); gl_FragColor=vec4(mix(bot,top,h),1.); }'
  });
  const sky = new THREE.Mesh(g, m); sky.renderOrder = -1; scene.add(sky);
  sky.onBeforeRender = () => sky.position.copy(camera.position);
}

const hud = $('hud'), hctx = hud.getContext('2d');
function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.updateProjectionMatrix();
  const dpr = Math.min(devicePixelRatio, 2);
  hud.width = w * dpr; hud.height = h * dpr; hctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
addEventListener('resize', resize);
resize();

const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _v4 = new THREE.Vector3();

// ═══════════ WORLD GENERATION ═══════════
function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function makeNoise(rand) {
  const p = new Uint8Array(512), v = new Float32Array(256);
  for (let i = 0; i < 256; i++) { p[i] = i; v[i] = rand(); }
  for (let i = 255; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); const t = p[i]; p[i] = p[j]; p[j] = t; }
  for (let i = 0; i < 256; i++) p[i + 256] = p[i];
  return (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi, X = xi & 255, Y = yi & 255;
    const a = v[p[p[X] + Y]], b = v[p[p[X + 1] + Y]], c = v[p[p[X] + Y + 1]], d = v[p[p[X + 1] + Y + 1]];
    const u = xf * xf * (3 - 2 * xf), w = yf * yf * (3 - 2 * yf);
    return a + (b - a) * u + (c - a) * w + (a - b - c + d) * u * w;
  };
}
const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;
let H = () => 0;
let terrainTop = 260, boxTop = 40;

// dissolve geometry close to the camera (screen-door dither), so clouds/trees never block the view
function camFade(mat, near, far) {
  mat.onBeforeCompile = sh => {
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vCfWorld;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvec4 cfw = vec4(transformed,1.0);\n#ifdef USE_INSTANCING\ncfw = instanceMatrix * cfw;\n#endif\nvCfWorld = (modelMatrix * cfw).xyz;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vCfWorld;')
      .replace('void main() {', `void main() {
  float cfd = distance(vCfWorld, cameraPosition);
  if (cfd < ${far.toFixed(1)}) {
    float cfa = smoothstep(${near.toFixed(1)}, ${far.toFixed(1)}, cfd);
    vec2 cfp = floor(mod(gl_FragCoord.xy, 4.0));
    float cft = (mod(cfp.x * 2.0 + cfp.y * 3.0 + cfp.x * cfp.y, 4.0) + 0.5) / 4.0;
    if (cfa < 0.98 && cft > cfa) discard;
  }`);
  };
  mat.customProgramCacheKey = () => 'cf' + near + '_' + far;
  return mat;
}

function buildWorld(seed) {
  if (world) { scene.remove(world.group); world.group.traverse(o => { if (o.geometry) o.geometry.dispose(); }); }
  const rand = mulberry32(seed);
  const n1 = makeNoise(rand), n2 = makeNoise(rand);
  const fbm = (x, z) => { let s = 0, a = 1, f = 1; for (let i = 0; i < 5; i++) { s += (n1(x * f, z * f) - .5) * a; a *= .5; f *= 2.03; } return s; };
  const villages = [[0, 0], [-190, 150], [180, -160], [-1300, -900], [1250, 1050], [-1100, 1350], [1400, -1200], [600, -1700], [-1700, 300], [1750, 200], [-300, 1800], [300, -900],
    [-2700, -1900], [2600, 2200], [-2300, 2800], [2900, -2500], [1300, -3500], [-3600, 700], [3600, 400], [-700, 3700], [800, -2600], [-3200, -3300], [3400, 3500]];
  const vH = villages.map(([x, z]) => fbm(x * 0.003 + 11, z * 0.003 - 7) * 95);
  H = (x, z) => {
    let h = fbm(x * 0.003 + 11, z * 0.003 - 7) * 95;
    // carve a river valley across the map
    const rv = Math.abs(z - Math.sin(x * 0.008) * 70 - 40);
    h = lerp(h, Math.min(h, -8), 1 - smooth(10, 70, rv));
    h += (n2(x * 0.02, z * 0.02) - .5) * 5;
    for (let i = 0; i < villages.length; i++) h = lerp(h, vH[i], 1 - smooth(45, 95, Math.hypot(x - villages[i][0], z - villages[i][1])));
    const e = Math.max(Math.abs(x), Math.abs(z)) - (MAP_HALF - 40);
    if (e > 0) { const ee = Math.min(e, 260); h += ee * ee * 0.0045 + ee * 0.7 + (n2(x * 0.01, z * 0.01) - .5) * ee * 0.8; }
    return h;
  };

  const group = new THREE.Group();
  const boxes = [];
  const dummy = new THREE.Object3D();

  // ── terrain ──
  const SIZE = MAP_HALF * 2 + 1100, SEG = 310;
  let geo = new THREE.PlaneGeometry(SIZE, SIZE, SEG, SEG);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  terrainTop = 0;
  for (let i = 0; i < pos.count; i++) { const hh = H(pos.getX(i), pos.getZ(i)); pos.setY(i, hh); if (hh > terrainTop && Math.max(Math.abs(pos.getX(i)), Math.abs(pos.getZ(i))) < MAP_HALF + 300) terrainTop = hh; }
  terrainTop += 15;
  geo = geo.toNonIndexed();
  geo.computeVertexNormals();
  const p2 = geo.attributes.position, nrm = geo.attributes.normal;
  const cols = new Float32Array(p2.count * 3);
  const cGrass = new THREE.Color(0x6e7a45), cGrass2 = new THREE.Color(0x8a8a52), cField = new THREE.Color(0xa69a5c), cDirt = new THREE.Color(0x8a7a5c),
        cRock = new THREE.Color(0x7c7a74), cSnow = new THREE.Color(0xe2e2dc), cWater = new THREE.Color(0x4f6f7a), c = new THREE.Color();
  for (let i = 0; i < p2.count; i += 3) {
    const x = (p2.getX(i) + p2.getX(i + 1) + p2.getX(i + 2)) / 3, y = (p2.getY(i) + p2.getY(i + 1) + p2.getY(i + 2)) / 3, z = (p2.getZ(i) + p2.getZ(i + 1) + p2.getZ(i + 2)) / 3;
    const slope = 1 - nrm.getY(i);
    c.copy(cGrass).lerp(cGrass2, n2(x * 0.008 + 50, z * 0.008) * 1.2 - 0.1);
    // patchwork farm fields
    const fx = Math.floor(x / 70), fz = Math.floor(z / 55);
    if (((fx * 7 + fz * 13) & 7) === 0 && y < 40) c.lerp(cField, 0.7);
    if (slope > 0.12) c.lerp(cDirt, Math.min(1, (slope - 0.12) * 4));
    if (slope > 0.3) c.lerp(cRock, Math.min(1, (slope - 0.3) * 3));
    if (y < -5) c.lerp(cWater, Math.min(1, (-5 - y) / 3));
    if (y > 170) c.lerp(cSnow, Math.min(1, (y - 170) / 40));
    c.multiplyScalar(0.94 + rand() * 0.1);
    for (let k = 0; k < 3; k++) { cols[(i + k) * 3] = c.r; cols[(i + k) * 3 + 1] = c.g; cols[(i + k) * 3 + 2] = c.b; }
  }
  geo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  const terrain = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0, flatShading: true }));
  terrain.receiveShadow = true;
  group.add(terrain);
  // river water plane
  const water = new THREE.Mesh(new THREE.PlaneGeometry(SIZE, SIZE), new THREE.MeshStandardMaterial({ color: 0x5c7f8c, roughness: .35, metalness: .1, transparent: true, opacity: .85 }));
  water.rotation.x = -Math.PI / 2; water.position.y = -6.5; group.add(water);

  // ── villages (houses = crash obstacles) ──
  const wallMat = new THREE.MeshStandardMaterial({ color: 0xbdb4a2, roughness: .95, flatShading: true });
  const roofMat = new THREE.MeshStandardMaterial({ color: 0x7a4436, roughness: .9, flatShading: true });
  const houseList = [];
  villages.forEach(([vx, vz]) => {
    for (let gx = -3; gx <= 3; gx++) for (let gz = -3; gz <= 3; gz++) {
      if (rand() < 0.45) continue;
      const x = vx + gx * 17 + (rand() - .5) * 5, z = vz + gz * 17 + (rand() - .5) * 5;
      let w = 7 + rand() * 5, d = 6 + rand() * 4; if (rand() < .5) [w, d] = [d, w];
      const ht = 4.5 + rand() * 3, base = H(x, z) - 1.2;
      houseList.push({ x, z, w, d, ht, base });
      boxes.push({ x, z, hx: w / 2, hz: d / 2, y0: base, y1: base + ht + 1.2 + Math.min(w, d) * 0.42 });
    }
    // a church tower
    const tx = vx + 6, tz = vz - 4, tb = H(tx, tz) - 1;
    houseList.push({ x: tx, z: tz, w: 5, d: 5, ht: 20, base: tb, tower: true });
    boxes.push({ x: tx, z: tz, hx: 2.5, hz: 2.5, y0: tb, y1: tb + 27 });
  });
  const boxGeo = new THREE.BoxGeometry(1, 1, 1); boxGeo.translate(0, .5, 0);
  const roofGeo = new THREE.ConeGeometry(0.72, 1, 4, 1); roofGeo.rotateY(Math.PI / 4); roofGeo.translate(0, .5, 0);
  const walls = new THREE.InstancedMesh(boxGeo, wallMat, houseList.length);
  const roofs = new THREE.InstancedMesh(roofGeo, roofMat, houseList.length);
  houseList.forEach((hs, i) => {
    dummy.rotation.set(0, 0, 0);
    dummy.position.set(hs.x, hs.base, hs.z); dummy.scale.set(hs.w, hs.ht + 1.2, hs.d); dummy.updateMatrix(); walls.setMatrixAt(i, dummy.matrix);
    dummy.position.set(hs.x, hs.base + hs.ht + 1.2, hs.z); dummy.scale.set(hs.w * 1.05, hs.tower ? 7 : Math.min(hs.w, hs.d) * 0.42, hs.d * 1.05); dummy.updateMatrix(); roofs.setMatrixAt(i, dummy.matrix);
  });
  walls.castShadow = roofs.castShadow = true; walls.receiveShadow = true;
  group.add(walls, roofs);

  // ── forests ──
  const trunkGeo = new THREE.CylinderGeometry(.35, .5, 4, 5); trunkGeo.translate(0, 2, 0);
  const crownGeo = new THREE.ConeGeometry(3, 9, 6); crownGeo.translate(0, 8, 0);
  const pineMat = new THREE.MeshStandardMaterial({ color: 0x4b5e34, roughness: 1, flatShading: true });
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x5a4a3a, roughness: 1, flatShading: true });
  const trees = [];
  const clusters = Array.from({ length: 170 }, () => [(rand() * 2 - 1) * (MAP_HALF - 60), (rand() * 2 - 1) * (MAP_HALF - 60)]);
  for (let i = 0; i < 26000 && trees.length < 4600; i++) {
    const c0 = clusters[Math.floor(rand() * clusters.length)];
    const x = c0[0] + (rand() - .5) * 150, z = c0[1] + (rand() - .5) * 150;
    const y = H(x, z);
    if (y < -3 || y > 150) continue;
    if (villages.some(([vx, vz]) => Math.hypot(x - vx, z - vz) < 70)) continue;
    trees.push({ x, y, z, s: 0.8 + rand() * 0.7, r: rand() * TAU });
  }
  const tr = new THREE.InstancedMesh(trunkGeo, trunkMat, trees.length), cr = new THREE.InstancedMesh(crownGeo, pineMat, trees.length);
  trees.forEach((t, i) => { dummy.position.set(t.x, t.y - .3, t.z); dummy.rotation.set(0, t.r, 0); dummy.scale.setScalar(t.s); dummy.updateMatrix(); tr.setMatrixAt(i, dummy.matrix); cr.setMatrixAt(i, dummy.matrix); });
  cr.castShadow = true; cr.receiveShadow = true;
  group.add(tr, cr);

  // ── clouds (one instanced mesh of puffs; fade when you fly through) ──
  const cloudMat = camFade(new THREE.MeshStandardMaterial({ color: 0xf6f6f2, roughness: 1, flatShading: true, emissive: 0x30302c }), 12, 60);
  const puffs = [];
  for (let i = 0; i < 230; i++) {
    const cx = (rand() * 2 - 1) * (MAP_HALF + 200), cz = (rand() * 2 - 1) * (MAP_HALF + 200), cy = Math.max(230 + rand() * 170, H(cx, cz) + 120);
    const n = 4 + Math.floor(rand() * 5), sc = 14 + rand() * 18;
    for (let k = 0; k < n; k++) puffs.push([cx + (rand() - .5) * sc * 3.2, cy + (rand() - .5) * sc * 0.6, cz + (rand() - .5) * sc * 2, sc * (0.6 + rand() * 0.6)]);
  }
  const clouds = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), cloudMat, puffs.length);
  puffs.forEach((p, i) => { dummy.position.set(p[0], p[1], p[2]); dummy.rotation.set(rand(), rand(), 0); dummy.scale.set(p[3] * 1.3, p[3] * 0.7, p[3]); dummy.updateMatrix(); clouds.setMatrixAt(i, dummy.matrix); });
  group.add(clouds);

  // ── repair rings in the sky ──
  const ringGeo = new THREE.TorusGeometry(13, 1.2, 8, 30);
  const ringMat = new THREE.MeshStandardMaterial({ color: 0x8fe060, emissive: 0x3d7a20, roughness: .5 });
  const rings = [];
  for (let i = 0; i < 22; i++) {
    const a = i / 7 * TAU + 0.3 + rand() * 0.3, r = i < 7 ? 150 + rand() * 450 : i < 14 ? 900 + rand() * 1100 : 2200 + rand() * 1700;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const y = Math.max(H(x, z) + 70, 110 + rand() * 120);
    const m = new THREE.Mesh(ringGeo, ringMat); m.position.set(x, y, z); m.rotation.y = rand() * TAU;
    group.add(m);
    rings.push({ x, y, z, mesh: m, avail: true });
  }

  // ── ПВО sites: climb to mountain peaks, keep them spread out ──
  const sams = [];
  const padMat = new THREE.MeshStandardMaterial({ color: 0x8a867c, roughness: .9, flatShading: true });
  const samMat = new THREE.MeshStandardMaterial({ color: 0x5d6640, roughness: .8, flatShading: true });
  const samDark = new THREE.MeshStandardMaterial({ color: 0x2f3328, roughness: .7, flatShading: true });
  const samLamp = new THREE.MeshBasicMaterial({ color: 0xff3020 });
  const SAM_SIDE = 6, ring = EDGE + 190;
  for (let i = 0; i < SAM_SIDE * 4; i++) {
    const side = i / SAM_SIDE | 0, f = ((i % SAM_SIDE) + 0.5) / SAM_SIDE * 2 - 1;
    let x = [f * ring, ring, -f * ring, -ring][side], z = [-ring, f * ring, ring, -f * ring][side];
    x += (rand() - .5) * 200; if (side % 2) x = Math.sign(x) * ring; else z = Math.sign(z) * ring;
    const h = H(x, z);
    const g = new THREE.Group(); g.position.set(x, h - 0.5, z);
    const pad = new THREE.Mesh(new THREE.CylinderGeometry(15, 17, 2.5, 10), padMat); pad.position.y = 0.6; pad.receiveShadow = true; g.add(pad);
    for (let k = 0; k < 9; k++) { const b = new THREE.Mesh(new THREE.BoxGeometry(5, 1.4, 1.6), padMat); const aa = k / 9 * TAU; b.position.set(Math.cos(aa) * 16, 2.3, Math.sin(aa) * 16); b.rotation.y = -aa + Math.PI / 2; g.add(b); }
    const base = new THREE.Mesh(new THREE.BoxGeometry(6, 2.2, 9), samMat); base.position.set(-3, 3, 0); base.castShadow = true; g.add(base);
    const turn = new THREE.Group(); turn.position.set(-3, 4.3, 0); g.add(turn);
    const rack = new THREE.Group(); rack.rotation.x = -0.7; turn.add(rack);
    for (let k = 0; k < 4; k++) { const tube = new THREE.Mesh(new THREE.BoxGeometry(1.3, 1.3, 8.5), samMat); tube.position.set((k % 2 ? 0.75 : -0.75), (k < 2 ? 0.75 : -0.75) + 1.2, 1.5); tube.castShadow = true; rack.add(tube);
      const cap = new THREE.Mesh(new THREE.BoxGeometry(1.1, 1.1, 0.2), samDark); cap.position.set(tube.position.x, tube.position.y, 5.8); rack.add(cap); }
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.5, 9, 6), samDark); mast.position.set(7, 6.5, 0); g.add(mast);
    const radar = new THREE.Group(); radar.position.set(7, 11.2, 0); g.add(radar);
    const dish = new THREE.Mesh(new THREE.BoxGeometry(7, 2.6, 0.4), samMat); dish.position.z = 0.6; dish.rotation.x = -0.25; radar.add(dish);
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.5, 6, 4), samLamp); lamp.position.set(7, 12.8, 0); g.add(lamp);
    group.add(g);
    sams.push({ x, z, y: h, g, turn, rack, radar, lamp, top: new THREE.Vector3(x - 3, h + 7, z), lockT: 0, cd: 2 + rand() * 3, spin: rand() * TAU });
  }

  scene.add(group);
  boxTop = boxes.reduce((m, b) => Math.max(m, b.y1), 40) + 1;
  world = { group, boxes, crates: rings, trees, villages, seed, sams };
  buildMinimapBase();
}

// ═══════════ PLANE MODEL ═══════════
function buildPlane(color) {
  // low-poly fighter jet, ~17 units long (about twice the old prop plane)
  const g = new THREE.Group(); g.rotation.order = 'YXZ';
  const bodyMat = new THREE.MeshStandardMaterial({ color, roughness: .6, metalness: .35, flatShading: true, side: THREE.DoubleSide });
  const detMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(color).multiplyScalar(0.68), roughness: .65, metalness: .35, flatShading: true, side: THREE.DoubleSide });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x2a2b2c, roughness: .5, metalness: .6, flatShading: true, side: THREE.DoubleSide });
  const glassMat = new THREE.MeshStandardMaterial({ color: 0x1d2a38, roughness: .1, metalness: .7, emissive: 0x0a1420 });
  const whiteMat = new THREE.MeshStandardMaterial({ color: 0xdcdcd6, roughness: .5, metalness: .2, flatShading: true });
  const mats = [bodyMat, detMat];
  const add = (geo, mat, x, y, z, parent = g) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; parent.add(m); return m; };
  // extruded outline lying flat in the x/z plane; pts are [x, z]
  const flat = (pts, depth, mat) => {
    const sh = new THREE.Shape(); sh.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) sh.lineTo(pts[i][0], pts[i][1]); sh.closePath();
    const geo = new THREE.ExtrudeGeometry(sh, { depth, bevelEnabled: false });
    geo.rotateX(Math.PI / 2);          // shape y -> world z, extrusion depth -> downward thickness
    geo.translate(0, depth / 2, 0);
    const m = new THREE.Mesh(geo, mat); m.castShadow = true; return m;
  };
  // fuselage + nose
  const fus = add(new THREE.CylinderGeometry(1.05, 0.95, 11.5, 8), bodyMat, 0, 0, -0.2); fus.rotation.x = Math.PI / 2;
  add(new THREE.BoxGeometry(1.3, 0.7, 8), bodyMat, 0, 0.75, -1.2);                       // spine
  const nose = add(new THREE.ConeGeometry(1.05, 5, 8), bodyMat, 0, 0, 8.05); nose.rotation.x = Math.PI / 2;
  const tipC = add(new THREE.ConeGeometry(0.32, 1.4, 8), darkMat, 0, 0, 10.2); tipC.rotation.x = Math.PI / 2;
  const canopy = add(new THREE.SphereGeometry(0.8, 12, 8), glassMat, 0, 1.0, 4.4); canopy.scale.set(0.95, 0.85, 2.6);
  for (const sx of [-1, 1]) { const intake = add(new THREE.BoxGeometry(1.0, 1.35, 4.2), detMat, sx * 1.35, -0.25, 1.6); intake.rotation.z = sx * 0.12; }
  const nozzle = add(new THREE.CylinderGeometry(0.95, 0.75, 1.6, 10, 1, true), darkMat, 0, 0, -6.6); nozzle.rotation.x = Math.PI / 2;
  // afterburner flame (scaled by throttle / boost every frame)
  const flame = new THREE.Mesh(new THREE.ConeGeometry(0.7, 4, 10, 1, true), new THREE.MeshBasicMaterial({ color: 0xffa64a, transparent: true, opacity: .85, blending: THREE.AdditiveBlending, depthWrite: false }));
  flame.rotation.x = -Math.PI / 2; flame.position.z = -9.2; g.add(flame);
  const core = new THREE.Mesh(new THREE.ConeGeometry(0.4, 2.4, 8, 1, true), new THREE.MeshBasicMaterial({ color: 0xbfe2ff, transparent: true, opacity: .9, blending: THREE.AdditiveBlending, depthWrite: false }));
  core.rotation.x = -Math.PI / 2; core.position.z = -8.2; g.add(core);
  // swept wings, tailplanes, twin canted fins
  for (const sx of [-1, 1]) {
    const w = flat([[sx * 0.9, 3.0], [sx * 7.4, -3.4], [sx * 7.4, -4.6], [sx * 0.9, -4.8]], 0.28, bodyMat); w.position.y = -0.25; g.add(w);
    const st = flat([[sx * 0.8, -5.6], [sx * 4.0, -7.6], [sx * 4.0, -8.3], [sx * 0.8, -8.0]], 0.2, detMat); st.position.y = -0.1; g.add(st);
    // fin: outline in (height, z) drawn flat, then stood up and canted outward
    const fin = flat([[0, -4.4], [3.4, -6.5], [3.4, -8.2], [0, -7.9]], 0.2, detMat);
    fin.rotation.z = Math.PI / 2 - sx * 0.28; fin.position.set(sx * 1.0, 0.55, 0); g.add(fin);
    const rd = add(new THREE.CylinderGeometry(0.55, 0.55, 0.05, 16), new THREE.MeshBasicMaterial({ color: 0xe8e4d8 }), sx * 5.2, 0.05, -2.9); rd.castShadow = false; // roundel
  }
  // missiles on wing pylons (hidden once fired)
  const missiles = [];
  for (const sx of [-1, 1]) {
    const mg = new THREE.Group(); mg.position.set(sx * 4.0, -0.85, -1.4); g.add(mg);
    const tube = add(new THREE.CylinderGeometry(0.2, 0.2, 3.2, 8), whiteMat, 0, 0, 0, mg); tube.rotation.x = Math.PI / 2;
    const mn = add(new THREE.ConeGeometry(0.2, 0.7, 8), whiteMat, 0, 0, 1.95, mg); mn.rotation.x = Math.PI / 2;
    add(new THREE.BoxGeometry(0.9, 0.06, 0.5), darkMat, 0, 0, -1.4, mg);
    add(new THREE.BoxGeometry(0.06, 0.9, 0.5), darkMat, 0, 0, -1.4, mg);
    add(new THREE.BoxGeometry(0.15, 0.5, 1.4), darkMat, 0, 0.42, 0, mg);   // pylon
    missiles.push(mg);
  }
  const gunL = new THREE.Object3D(); gunL.position.set(1.1, 0.35, 5.8); g.add(gunL);
  const gunR = new THREE.Object3D(); gunR.position.set(-1.1, 0.35, 5.8); g.add(gunR);
  return { g, flame, core, guns: [gunL, gunR], missiles, mats, color: new THREE.Color(color) };
}

// ═══════════ PLANE ENTITIES ═══════════
function colorFor(p) {
  if (!room) return TEAM_COL[0];
  if (room.mode === 'team') return TEAM_COL[p.team] ?? TEAM_COL[0];
  const idx = room.players.findIndex(q => q.id === p.id);
  return FFA_COLS[(idx < 0 ? 0 : idx) % FFA_COLS.length];
}
function makePlane(p) {
  const vis = buildPlane(colorFor(p));
  scene.add(vis.g); vis.g.visible = false;
  const t = {
    id: p.id, isMe: p.id === myId, vis, alive: false, hp: MAX_HP,
    pos: new THREE.Vector3(), h: 0, p: 0, b: 0, speed: 120, throttle: 0.7, boost: 0, firing: false,
    tpos: new THREE.Vector3(), th: 0, tp: 0, tb: 0, tspeed: 0, recv: 0,
    fireAcc: 0, gunIdx: 0, misIdx: 0, falling: null, burnT: 0, smokeT: 0, inv: new THREE.Matrix4(), losVisible: false, marker: null
  };
  const mk = document.createElement('div');
  mk.className = 'mk'; mk.innerHTML = '<span></span><div class="bar"><i></i></div>';
  $('markers').appendChild(mk); t.marker = mk;
  planes.set(p.id, t);
  return t;
}
function removePlane(id) { const t = planes.get(id); if (!t) return; scene.remove(t.vis.g); t.marker.remove(); planes.delete(id); }
function syncPlanes() {
  if (!room) return;
  const ids = new Set(room.players.map(p => p.id));
  for (const id of [...planes.keys()]) if (!ids.has(id)) removePlane(id);
  for (const p of room.players) { let t = planes.get(p.id); if (!t) t = makePlane(p); t.isMe = p.id === myId; }
}
function setColor(t, col) { t.vis.color.set(col); t.vis.mats[0].color.set(col); t.vis.mats[1].color.set(col).multiplyScalar(0.7); }
function placePlane(t, s) {
  t.pos.set(s.x, Math.max(s.y, H(s.x, s.z) + 120), s.z); t.tpos.copy(t.pos);
  t.h = t.th = s.yaw; t.p = t.tp = 0; t.b = t.tb = 0; t.speed = t.tspeed = 170; t.throttle = 0.7; t.boost = 1; t.boosting = false;
  t.alive = true; t.hp = MAX_HP; t.falling = null; t.burnT = 0; t.firing = false; t.crashed = false;
  const p = room.players.find(q => q.id === t.id);
  setColor(t, colorFor(p || { id: t.id, team: 0 }));
  t.vis.g.visible = true;
  t.vis.missiles.forEach(m => m.visible = true);
  if (t.id === myId) { ammo.n = MISSILE_MAX; ammo.reload = [0, 0]; flares = FLARES_MAX; lock.id = null; lock.t = 0; lock.locked = false; }
  updatePlaneVis(t, 0);
}
function fwd(h, p, out) { return out.set(Math.sin(h) * Math.cos(p), Math.sin(p), Math.cos(h) * Math.cos(p)); }
function updatePlaneVis(t, dt) {
  const g = t.vis.g;
  g.position.copy(t.pos);
  g.rotation.set(-t.p, t.h, t.b);
  const fl = t.alive ? 0.45 + t.throttle * 0.6 + (t.boosting ? 0.9 : 0) : 0;
  t.vis.flame.visible = t.vis.core.visible = fl > 0;
  if (fl > 0) { const fk = fl * (0.9 + Math.random() * 0.2); t.vis.flame.scale.set(1, fk, 1); t.vis.flame.position.z = -7.4 - 2 * fk; t.vis.core.scale.set(1, fk * 0.8, 1); t.vis.core.position.z = -7.3 - 1.0 * fk; }
  if (t.alive) { const want = t.isMe ? ammo.n : (t.misShown ?? 2); t.vis.missiles.forEach((m, i) => m.visible = i < want); }
  g.updateMatrixWorld(true);
  t.inv.copy(g.matrixWorld).invert();
}
function startFalling(t) {
  t.alive = false; t.firing = false;
  for (const m of t.vis.mats) m.color.multiplyScalar(0.3);
  if (t.crashed) { crashFx(t); return; }
  t.falling = { vel: fwd(t.h, t.p, new THREE.Vector3()).multiplyScalar(Math.max(60, t.speed)), spin: (Math.random() < .5 ? -1 : 1) * (2 + Math.random() * 2.5) };
}
function crashFx(t) {
  t.falling = null;
  t.pos.y = Math.max(t.pos.y, H(t.pos.x, t.pos.z) + 0.6);
  t.p = -0.3;
  particles.explosion(t.pos, 1.6);
  audio.at('hit', t.pos, 1, 0.55);
  t.burnT = 10;
}

// ═══════════ COLLISION & RAYS ═══════════
function rayAABB(o, d, mn, mx, maxT) {
  let tmin = -Infinity, tmax = Infinity, axis = -1, sgn = 0;
  for (let a = 0; a < 3; a++) {
    if (Math.abs(d[a]) < 1e-9) { if (o[a] < mn[a] || o[a] > mx[a]) return null; continue; }
    let t1 = (mn[a] - o[a]) / d[a], t2 = (mx[a] - o[a]) / d[a], s = -1;
    if (t1 > t2) { const k = t1; t1 = t2; t2 = k; s = 1; }
    if (t1 > tmin) { tmin = t1; axis = a; sgn = s; }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  if (tmax < 0 || tmin > maxT) return null;
  return { t: Math.max(0, tmin), axis, sgn };
}
function rayTerrain(o, d, maxT, step = 4) {
  let prev = 0;
  if (o[1] < H(o[0], o[2])) return 0;
  for (let t = step; t <= maxT + step; t += step) {
    const tt = Math.min(t, maxT);
    if (o[1] + d[1] * tt < H(o[0] + d[0] * tt, o[2] + d[2] * tt)) {
      let a = prev, b = tt;
      for (let i = 0; i < 7; i++) { const m = (a + b) / 2; if (o[1] + d[1] * m < H(o[0] + d[0] * m, o[2] + d[2] * m)) b = m; else a = m; }
      return b;
    }
    prev = tt;
    if (tt >= maxT) break;
  }
  return null;
}
// plane hitboxes (local space, slightly generous): fuselage, wings, tail
const HITBOXES = [
  { mn: [-1.7, -1.3, -7.8], mx: [1.7, 1.6, 10.8], zone: 'body' },
  { mn: [-7.9, -0.9, -5.2], mx: [7.9, 0.5, 3.2], zone: 'wing' },
  { mn: [-4.3, -0.5, -8.6], mx: [4.3, 3.8, -4.4], zone: 'tail' }
];
const _lo = [0, 0, 0], _ld = [0, 0, 0];
// bullet / sight ray vs world. returns { t, kind, plane, zone }
function castRay(o, d, maxT, ignoreId, opts = {}) {
  let best = null, bt = maxT;
  if (!opts.noTerrain) {
    // fast path: only march when the segment can reach the ground
    const yEnd = o[1] + d[1] * maxT;
    if (Math.min(o[1], yEnd) < terrainTop) { const tt = rayTerrain(o, d, maxT, opts.step || 4); if (tt !== null) { bt = tt; best = { t: tt, kind: 'terrain' }; } }
  }
  if (Math.min(o[1], o[1] + d[1] * bt) < boxTop) for (const b of world.boxes) {
    const r = rayAABB(o, d, [b.x - b.hx, b.y0, b.z - b.hz], [b.x + b.hx, b.y1, b.z + b.hz], bt);
    if (r && r.t < bt) { bt = r.t; best = { t: r.t, kind: 'obj' }; }
  }
  if (!opts.noPlanes) for (const pl of planes.values()) {
    if (pl.id === ignoreId || !pl.vis.g.visible || (!pl.alive && !pl.falling)) continue;
    // closest approach of the segment to the plane centre
    const cx = pl.pos.x - o[0], cy = pl.pos.y - o[1], cz = pl.pos.z - o[2];
    const along = Math.max(0, Math.min(bt, cx * d[0] + cy * d[1] + cz * d[2]));
    const qx = cx - d[0] * along, qy = cy - d[1] * along, qz = cz - d[2] * along;
    if (qx * qx + qy * qy + qz * qz > 196) continue;
    _v1.set(o[0], o[1], o[2]).applyMatrix4(pl.inv); _lo[0] = _v1.x; _lo[1] = _v1.y; _lo[2] = _v1.z;
    _v2.set(d[0], d[1], d[2]).transformDirection(pl.inv); _ld[0] = _v2.x; _ld[1] = _v2.y; _ld[2] = _v2.z;
    for (const hb of HITBOXES) {
      const r = rayAABB(_lo, _ld, hb.mn, hb.mx, bt);
      if (r && r.t < bt) {
        bt = r.t;
        let zone = hb.zone;
        if (zone === 'body') { const lz = _lo[2] + _ld[2] * r.t; zone = lz > 6.5 ? 'body' : lz > 2.6 ? 'cockpit' : lz < -4.5 ? 'engine' : 'body'; }
        best = { t: r.t, kind: 'plane', plane: pl, zone, cos: Math.abs(_ld[r.axis]) };
      }
    }
  }
  return best;
}

// ═══════════ PARTICLES ═══════════
const particles = (() => {
  const cv = document.createElement('canvas'); cv.width = cv.height = 64;
  const c = cv.getContext('2d'); const gr = c.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.4, 'rgba(255,255,255,.6)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = gr; c.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(cv);
  const N = 800, pool = [];
  for (let i = 0; i < N; i++) {
    const m = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0 });
    const s = new THREE.Sprite(m); s.visible = false; scene.add(s);
    pool.push({ s, life: 0, max: 1, vx: 0, vy: 0, vz: 0, s0: 1, s1: 1, a0: 1, drag: 0, grav: 0 });
  }
  let idx = 0;
  function spawn(x, y, z, o) {
    const p = pool[idx]; idx = (idx + 1) % N;
    p.s.position.set(x, y, z); p.s.visible = true;
    p.vx = o.vx || 0; p.vy = o.vy || 0; p.vz = o.vz || 0;
    p.life = p.max = o.life || 1; p.s0 = o.s0 || 1; p.s1 = o.s1 ?? p.s0; p.a0 = o.a ?? 1; p.drag = o.drag || 0; p.grav = o.grav || 0;
    p.s.material.color.set(o.color ?? 0xffffff);
    p.s.material.blending = o.add ? THREE.AdditiveBlending : THREE.NormalBlending;
    p.s.material.opacity = p.a0; p.s.scale.setScalar(p.s0);
  }
  function update(dt) {
    for (const p of pool) {
      if (!p.s.visible) continue;
      p.life -= dt;
      if (p.life <= 0) { p.s.visible = false; continue; }
      const k = 1 - p.life / p.max, dr = Math.exp(-p.drag * dt);
      p.vx *= dr; p.vy = p.vy * dr - p.grav * dt; p.vz *= dr;
      p.s.position.x += p.vx * dt; p.s.position.y += p.vy * dt; p.s.position.z += p.vz * dt;
      p.s.scale.setScalar(lerp(p.s0, p.s1, k));
      p.s.material.opacity = p.a0 * (1 - k) * (k < 0.1 ? k * 10 : 1);
    }
  }
  const R = () => Math.random() - 0.5;
  return {
    update,
    muzzle(pos) { spawn(pos.x, pos.y, pos.z, { life: .05, s0: 1.6, s1: .6, color: 0xffd38a, add: true }); },
    spark(pos) {
      spawn(pos.x, pos.y, pos.z, { life: .1, s0: 2.2, s1: .6, color: 0xffc070, add: true });
      for (let i = 0; i < 4; i++) spawn(pos.x, pos.y, pos.z, { vx: R() * 30, vy: R() * 30, vz: R() * 30, life: .3, s0: .4, s1: .1, color: 0xffd080, add: true });
      spawn(pos.x, pos.y, pos.z, { vx: R() * 3, vy: R() * 3, vz: R() * 3, life: .8, s0: 1, s1: 3, color: 0x5a5550, a: .5, drag: 1 });
    },
    dirt(pos) {
      for (let i = 0; i < 3; i++) spawn(pos.x, pos.y, pos.z, { vx: R() * 6, vy: Math.random() * 8 + 3, vz: R() * 6, life: .8, s0: 1, s1: 2.6, color: 0x6e604a, a: .6, grav: 10, drag: 1.2 });
    },
    explosion(pos, big = 1) {
      spawn(pos.x, pos.y, pos.z, { life: .4, s0: 14 * big, s1: 6, color: 0xffb050, add: true });
      for (let i = 0; i < 22; i++) spawn(pos.x, pos.y, pos.z, { vx: R() * 40, vy: R() * 40 + 6, vz: R() * 40, life: .7 + Math.random() * .6, s0: 2, s1: .4, color: i % 2 ? 0xff8a3a : 0xffd27a, add: true, grav: 18, drag: 1.4 });
      for (let i = 0; i < 18; i++) spawn(pos.x + R() * 4, pos.y + R() * 4, pos.z + R() * 4, { vx: R() * 10, vy: Math.random() * 6 + 2, vz: R() * 10, life: 2.5 + Math.random() * 1.5, s0: 4 * big, s1: 12 * big, color: 0x3a3632, a: .7, drag: 1.2 });
    },
    smoke(pos, dark) { spawn(pos.x + R(), pos.y + R(), pos.z + R(), { vx: R() * 2, vy: 1.5, vz: R() * 2, life: 2.2 + Math.random(), s0: 1.6, s1: 6.5, color: dark ? 0x2a2826 : 0x6a6660, a: .55, drag: .5 }); },
    fire(pos) { spawn(pos.x + R(), pos.y + R(), pos.z + R(), { vy: 2, life: .45, s0: 2.2, s1: .6, color: 0xff7a2a, add: true }); },
    trail(pos) { spawn(pos.x, pos.y, pos.z, { life: .9, s0: .5, s1: 1.4, color: 0xffffff, a: .35 }); },
    mtrail(pos) { spawn(pos.x, pos.y, pos.z, { vx: R() * 1.5, vy: R() * 1.5 + .5, vz: R() * 1.5, life: 1.6, s0: 1.2, s1: 4.5, color: 0xd8d6d0, a: .55, drag: .8 }); },
    mflame(pos) { spawn(pos.x, pos.y, pos.z, { life: .06, s0: 2.2, s1: 1, color: 0xffb860, add: true }); },
    flare(pos, v) { spawn(pos.x, pos.y, pos.z, { vx: v.x, vy: v.y, vz: v.z, life: 2.6, s0: 4.5, s1: 1.8, color: 0xfff0b0, add: true, grav: 9, drag: .6 }); },
    flareSmoke(pos) { spawn(pos.x, pos.y, pos.z, { vy: .5, life: 1.4, s0: 1.2, s1: 4, color: 0xe8e6e0, a: .4, drag: 1 }); },
    heal(pos) { for (let i = 0; i < 16; i++) spawn(pos.x + R() * 8, pos.y + R() * 6, pos.z + R() * 8, { vx: R() * 6, vy: 4, vz: R() * 6, life: 1, s0: 1, s1: .3, color: 0x9bff7a, add: true }); }
  };
})();

// ═══════════ BULLETS ═══════════
const bulletGeo = new THREE.BoxGeometry(0.26, 0.26, 7.5);
const bulletMat = new THREE.MeshBasicMaterial({ color: 0xffd98a });
const bulletPool = [];
for (let i = 0; i < 360; i++) { const m = new THREE.Mesh(bulletGeo, bulletMat); m.visible = false; scene.add(m); bulletPool.push(m); }
let bulletIdx = 0;
const bullets = [];
function spawnBullet(o, v, owner, mine) {
  const m = bulletPool[bulletIdx]; bulletIdx = (bulletIdx + 1) % bulletPool.length;
  m.visible = true; m.position.copy(o); m.lookAt(_v1.copy(o).add(v));
  // a recycled mesh may still belong to an old bullet
  const old = bullets.findIndex(b => b.m === m); if (old >= 0) bullets.splice(old, 1);
  bullets.push({ m, p: o.clone(), v: v.clone(), owner, mine, life: BULLET_LIFE });
}
const _o = [0, 0, 0], _d = [0, 0, 0];
function updateBullets(dt) {
  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    b.life -= dt;
    b.v.y -= 6 * dt;
    const len = b.v.length() * dt;
    _o[0] = b.p.x; _o[1] = b.p.y; _o[2] = b.p.z;
    _d[0] = b.v.x / (len / dt); _d[1] = b.v.y / (len / dt); _d[2] = b.v.z / (len / dt);
    const hit = castRay(_o, _d, len, b.owner, { step: 6 });
    if (hit) {
      const pt = new THREE.Vector3(_o[0] + _d[0] * hit.t, _o[1] + _d[1] * hit.t, _o[2] + _d[2] * hit.t);
      onBulletHit(b, hit, pt);
      b.m.visible = false; bullets.splice(i, 1); continue;
    }
    b.p.addScaledVector(b.v, dt);
    b.m.position.copy(b.p);
    if (b.life <= 0) { b.m.visible = false; bullets.splice(i, 1); }
  }
}
let ricSoundT = 0;
function onBulletHit(b, hit, pt) {
  if (hit.kind === 'plane') {
    if (!b.mine) return; // owner reports, server echo shows the effect
    const pl = hit.plane;
    if (!pl.alive || !isEnemy(pl.id)) { particles.spark(pt); return; }
    const p = [+pt.x.toFixed(1), +pt.y.toFixed(1), +pt.z.toFixed(1)];
    if (hit.cos < 0.12) { socket.emit('hit', { target: pl.id, ric: true, pt: p }); return; } // grazing
    const mult = { engine: 1.4, cockpit: 1.3, body: 1.0, wing: 0.75, tail: 1.15 }[hit.zone] || 1;
    socket.emit('hit', { target: pl.id, dmg: BASE_DMG * mult * (0.8 + Math.random() * 0.4), pt: p, zone: hit.zone });
  } else {
    particles.dirt(pt);
    if (performance.now() - ricSoundT > 120) { ricSoundT = performance.now(); audio.at('ricochet', pt, .3, 1 + Math.random() * .4); }
  }
}

// ═══════════ INPUT ═══════════
const keys = {};
let camYaw = 0, camPitch = 0, camDist = 40, zoom = false, mouseFire = false, locked = false, chatOpen = false;
addEventListener('keydown', e => {
  if (chatOpen) {
    if (e.key === 'Enter') { const t = $('chatin').value.trim(); if (t) socket.emit('chat', t); closeChat(); }
    if (e.key === 'Escape') closeChat();
    return;
  }
  if (!inGame) return;
  keys[e.code] = true;
  if (e.code === 'Tab') { e.preventDefault(); $('board').classList.add('on'); renderBoard(); }
  if (e.code === 'KeyM') audio.toggle();
  if (e.code === 'Enter') { e.preventDefault(); openChat(); }
  if (e.code === 'Space' && (!myPlane() || !myPlane().alive)) cycleSpectate();
  if (e.code === 'KeyQ') fireMissile();
  if (e.code === 'KeyF') dropFlares();
  if (e.code === 'KeyC') zoom = true;
});
addEventListener('keyup', e => { keys[e.code] = false; if (e.code === 'Tab') $('board').classList.remove('on'); if (e.code === 'KeyC') zoom = false; });
function openChat() { chatOpen = true; const c = $('chatin'); c.style.display = 'block'; c.value = ''; document.exitPointerLock && document.exitPointerLock(); setTimeout(() => c.focus(), 0); }
function closeChat() { chatOpen = false; const c = $('chatin'); c.style.display = 'none'; c.blur(); lockPointer(); }
function lockPointer() { if (inGame && !isTouch && canvas.requestPointerLock) { try { const r = canvas.requestPointerLock(); if (r && r.catch) r.catch(() => {}); } catch (e) {} } }
canvas.addEventListener('mousedown', e => {
  if (!inGame) return;
  audio.unlock();
  if (!locked) { lockPointer(); return; }
  if (e.button === 0) mouseFire = true;
  if (e.button === 2) fireMissile();
});
addEventListener('mouseup', e => { if (e.button === 0) mouseFire = false; });
canvas.addEventListener('contextmenu', e => e.preventDefault());
document.addEventListener('pointerlockchange', () => {
  locked = document.pointerLockElement === canvas;
  if (!locked) { mouseFire = false; zoom = false; }
  if (!locked && inGame && !chatOpen && !$('result').classList.contains('on')) { $('pLobbyBtn').style.display = isHost() ? '' : 'none'; showScreen('pause'); }
  if (locked) showScreen(null);
});
addEventListener('mousemove', e => {
  if (!locked) return;
  const s = zoom ? 0.0008 : 0.0019;
  camYaw -= e.movementX * s;
  camPitch = Math.max(-1.35, Math.min(1.35, camPitch - e.movementY * s));
});
addEventListener('wheel', e => { if (inGame) camDist = Math.max(24, Math.min(80, camDist + Math.sign(e.deltaY) * 4)); }, { passive: true });

const isTouch = matchMedia('(pointer:coarse)').matches || 'ontouchstart' in window && innerWidth < 1100;
const touch = { jx: 0, jy: 0, joyId: null, lookId: null, lx: 0, ly: 0, fire: false, boost: false };
if (isTouch) {
  const joy = $('joy'), knob = $('joyk');
  addEventListener('touchstart', e => {
    if (!inGame) return;
    audio.unlock();
    for (const t of e.changedTouches) {
      if (t.target.id === 'tfire') { touch.fire = true; continue; }
      if (t.target.id === 'tzoom') { touch.boost = true; continue; }
      if (t.target.id === 'tmis') { fireMissile(); continue; }
      if (t.target.id === 'tflare') { dropFlares(); continue; }
      if (t.clientX < innerWidth * 0.4 && touch.joyId === null) { touch.joyId = t.identifier; moveJoy(t); }
      else if (touch.lookId === null) { touch.lookId = t.identifier; touch.lx = t.clientX; touch.ly = t.clientY; }
    }
  }, { passive: true });
  addEventListener('touchmove', e => {
    for (const t of e.changedTouches) {
      if (t.identifier === touch.joyId) moveJoy(t);
      if (t.identifier === touch.lookId) {
        camYaw -= (t.clientX - touch.lx) * 0.005;
        camPitch = Math.max(-1.35, Math.min(1.35, camPitch - (t.clientY - touch.ly) * 0.005));
        touch.lx = t.clientX; touch.ly = t.clientY;
      }
    }
  }, { passive: true });
  const end = e => {
    for (const t of e.changedTouches) {
      if (t.target.id === 'tfire') touch.fire = false;
      if (t.target.id === 'tzoom') touch.boost = false;
      if (t.identifier === touch.joyId) { touch.joyId = null; touch.jx = touch.jy = 0; knob.style.transform = ''; }
      if (t.identifier === touch.lookId) touch.lookId = null;
    }
  };
  addEventListener('touchend', end); addEventListener('touchcancel', end);
  function moveJoy(t) {
    const r = joy.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    let dx = (t.clientX - cx) / (r.width / 2), dy = (t.clientY - cy) / (r.height / 2);
    const l = Math.hypot(dx, dy); if (l > 1) { dx /= l; dy /= l; }
    touch.jx = dx; touch.jy = dy;
    knob.style.transform = `translate(${dx * 45}px,${dy * 45}px)`;
  }
}

// ═══════════ LOCAL PLAYER (flight model) ═══════════
const myPlane = () => planes.get(myId);
let heat = 0, overheated = false, sendT = 0, shake = 0, pickupCooldown = 0, gunSoundT = 0, warnText = '';
function wrap(a) { while (a > Math.PI) a -= TAU; while (a < -Math.PI) a += TAU; return a; }

function updateMe(dt, now) {
  const t = myPlane();
  if (!t || !t.alive || t.crashed) { audio.engineOff(); warnText = ''; return; }
  const frozen = now < roundStartAt;
  if (isTouch && touch.joyId !== null) { camYaw -= touch.jx * 1.4 * dt; camPitch = Math.max(-1.35, Math.min(1.35, camPitch - touch.jy * 1.2 * dt)); }

  // throttle & boost
  if (!chatOpen) {
    if (keys.KeyW || keys.ArrowUp) t.throttle = Math.min(1, t.throttle + 0.7 * dt);
    if (keys.KeyS || keys.ArrowDown) t.throttle = Math.max(0.15, t.throttle - 0.7 * dt);
  }
  const boosting = (keys.ShiftLeft || keys.ShiftRight || touch.boost) && t.boost > 0.02 && !frozen;
  t.boosting = boosting;
  t.boost = boosting ? Math.max(0, t.boost - 0.2 * dt) : Math.min(1, t.boost + 0.07 * dt);

  // ── steering: plane chases the mouse-aim direction ──
  let desH = camYaw, desP = camPitch;
  warnText = '';
  const edgeD = Math.max(Math.abs(t.pos.x), Math.abs(t.pos.z)) - EDGE;
  if (edgeD > 450) { desH = Math.atan2(-t.pos.x, -t.pos.z); desP = 0.05; }
  if (edgeD > 0) warnText = 'ВНЕ ЗОНЫ — ВАС ВИДИТ ПВО';
  else if (edgeD > -300) warnText = 'ГРАНИЦА ЗОНЫ: ПВО';
  if (t.pos.y > CEILING) desP = Math.min(desP, -0.15);
  const agl = t.pos.y - H(t.pos.x, t.pos.z);
  const turnK = Math.max(0.35, Math.min(1, (t.speed - 50) / 110)) * (boosting ? 0.85 : 1);
  const maxYaw = 1.25 * turnK, maxPitch = 1.15 * turnK;
  const dh = wrap(desH - t.h), dp = Math.max(-1.3, Math.min(1.3, desP)) - t.p;
  let yawRate = Math.max(-maxYaw, Math.min(maxYaw, dh * 2.4));
  const rudder = chatOpen ? 0 : (keys.KeyA || keys.ArrowLeft ? 1 : 0) - (keys.KeyD || keys.ArrowRight ? 1 : 0);
  yawRate += rudder * 0.45;
  let pitchRate = Math.max(-maxPitch, Math.min(maxPitch, dp * 2.4));
  // stall: nose drops when too slow
  if (t.speed < MIN_SPEED + 12) { const k = (MIN_SPEED + 12 - t.speed) / 12; pitchRate -= k * 0.8; warnText = warnText || 'СВАЛИВАНИЕ'; }
  if (!frozen) {
    t.h = wrap(t.h + yawRate * dt);
    t.p = Math.max(-1.3, Math.min(1.3, t.p + pitchRate * dt));
  }
  // bank into the turn (cosmetic but sells the flight)
  const wantBank = Math.max(-1.25, Math.min(1.25, -yawRate * 1.15 - rudder * 0.25));
  t.b += (wantBank - t.b) * (1 - Math.exp(-4 * dt));

  // speed: throttle, boost, climbing costs speed, diving gains
  const target = 100 + t.throttle * 110 + (boosting ? 95 : 0);
  t.speed += (target - t.speed) * 0.5 * dt - 34 * Math.sin(t.p) * dt;
  t.speed = Math.max(45, Math.min(340, t.speed));
  if (!frozen) t.pos.addScaledVector(fwd(t.h, t.p, _v1), t.speed * dt);

  if (agl < 70 && t.p < -0.15) warnText = 'ТЯНИ ВВЕРХ!';

  // crash into ground / buildings
  const ground = Math.max(H(t.pos.x, t.pos.z), -6.5);
  let hitObj = t.pos.y < ground + 1.2;
  if (!hitObj && t.pos.y < 60) for (const b of world.boxes) if (Math.abs(t.pos.x - b.x) < b.hx + 1 && Math.abs(t.pos.z - b.z) < b.hz + 1 && t.pos.y < b.y1) { hitObj = true; break; }
  if (hitObj && !frozen) {
    t.crashed = true; t.speed = 0;
    socket.emit('crash');
    shake = 1;
    return;
  }

  // ── guns ──
  heat = Math.max(0, heat - COOL_RATE * dt);
  if (overheated && heat < 0.35) overheated = false;
  const wantFire = (mouseFire || touch.fire) && !frozen && !chatOpen && !overheated;
  t.firing = wantFire;
  if (wantFire) {
    t.fireAcc += dt;
    while (t.fireAcc >= 1 / FIRE_RATE) {
      t.fireAcc -= 1 / FIRE_RATE;
      fireGun(t, true);
      heat += HEAT_PER_SHOT;
      if (heat >= 1) { heat = 1; overheated = true; break; }
    }
  } else t.fireAcc = Math.min(t.fireAcc, 1 / FIRE_RATE);

  // wing-tip vapour trails in hard turns / high speed
  if (Math.abs(yawRate) > 0.75 || t.speed > 260) for (const sx of [-7.3, 7.3]) particles.trail(_v2.set(sx, -0.2, -4.2).applyMatrix4(t.vis.g.matrixWorld));
  updateLock(t, dt);
  updateAmmo(dt);

  audio.engine(t.throttle, Math.min(1, t.speed / 300), boosting ? 1 : 0);

  // repair rings
  pickupCooldown -= dt;
  const meP = me();
  if (pickupCooldown <= 0 && meP && (meP.hp < MAX_HP || ammo.n < MISSILE_MAX || flares < FLARES_MAX)) {
    world.crates.forEach((c, i) => { if (c.avail && t.pos.distanceTo(_v3.set(c.x, c.y, c.z)) < 16) { socket.emit('pickup', i); pickupCooldown = 0.5; } });
  }

  sendT -= dt;
  if (sendT <= 0) {
    sendT = 0.05;
    socket.emit('st', [+t.pos.x.toFixed(1), +t.pos.y.toFixed(1), +t.pos.z.toFixed(1), +t.h.toFixed(3), +t.p.toFixed(3), +t.b.toFixed(2), +t.speed.toFixed(1), t.firing ? 1 : 0, +t.throttle.toFixed(2), t.boosting ? 1 : 0, ammo.n]);
  }
}

// fire one round from alternating wing guns; bullets converge at CONVERGE units
function fireGun(t, mine) {
  const gun = t.vis.guns[t.gunIdx]; t.gunIdx ^= 1;
  const o = gun.getWorldPosition(new THREE.Vector3());
  const f = fwd(t.h, t.p, _v3);
  const conv = _v4.copy(t.pos).addScaledVector(f, CONVERGE);
  const dir = conv.sub(o).normalize();
  dir.x += (Math.random() - .5) * 0.012; dir.y += (Math.random() - .5) * 0.012; dir.z += (Math.random() - .5) * 0.012; dir.normalize();
  const v = dir.multiplyScalar(BULLET_SPEED).addScaledVector(f, t.speed);
  spawnBullet(o, v, t.id, mine);
  particles.muzzle(o);
  const now = performance.now();
  if (mine) { audio.play('shoot', 1.3, 0, 1.45 + Math.random() * 0.2); shake = Math.max(shake, 0.16); }
  else if (now - (t.sndT || 0) > 100) { t.sndT = now; audio.at('shoot', o, 1.4, 1.45 + Math.random() * 0.2); }
}

// ═══════════ MISSILES, LOCK-ON, FLARES ═══════════
const ammo = { n: MISSILE_MAX, reload: 0 };
let flares = FLARES_MAX, flareCd = 0, misSeq = 0, warnBeepT = 0;
const lock = { id: null, t: 0, locked: false, lostT: 0, sentKey: '', sentAt: 0, beepT: 0 };
const missiles = [];      // { id, owner, target, pos, vel, age, mine, mesh, decoy }
const decoys = [];        // flare decoys: { pos, vel, life }
const lockedBy = new Map(); // shooterId -> 1 (locking me) | 2 (locked on me)
const _m1 = new THREE.Vector3(), _m2 = new THREE.Vector3(), _m3 = new THREE.Vector3();

const misTubeGeo = new THREE.CylinderGeometry(0.26, 0.26, 3.8, 8); misTubeGeo.rotateX(Math.PI / 2);
const misNoseGeo = new THREE.ConeGeometry(0.26, 0.9, 8); misNoseGeo.rotateX(Math.PI / 2); misNoseGeo.translate(0, 0, 2.35);
const misFinGeo = new THREE.BoxGeometry(1.2, 0.07, 0.6); misFinGeo.translate(0, 0, -1.6);
const misMat = new THREE.MeshStandardMaterial({ color: 0xe2e2dc, roughness: .5, metalness: .2, flatShading: true });
const misDark = new THREE.MeshStandardMaterial({ color: 0x2a2b2c, roughness: .6, flatShading: true });
const misGlow = new THREE.MeshBasicMaterial({ color: 0xffc070, transparent: true, opacity: .9, blending: THREE.AdditiveBlending, depthWrite: false });
function makeMissileMesh() {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(misTubeGeo, misMat), new THREE.Mesh(misNoseGeo, misMat));
  const f1 = new THREE.Mesh(misFinGeo, misDark), f2 = new THREE.Mesh(misFinGeo, misDark); f2.rotation.z = Math.PI / 2; g.add(f1, f2);
  const glow = new THREE.Mesh(new THREE.SphereGeometry(0.55, 8, 6), misGlow); glow.position.z = -2.2; g.add(glow);
  return g;
}

function updateAmmo(dt) {
  if (ammo.n < MISSILE_MAX) { ammo.reload += dt; if (ammo.reload >= MISSILE_RELOAD) { ammo.reload = 0; ammo.n++; } } else ammo.reload = 0;
  flareCd = Math.max(0, flareCd - dt);
}

// keep an enemy inside the aim circle for LOCK_TIME to lock it
function updateLock(t, dt) {
  const aim = _m1.set(Math.sin(camYaw) * Math.cos(camPitch), Math.sin(camPitch), Math.cos(camYaw) * Math.cos(camPitch));
  let best = null, bestA = LOCK_CONE, keep = false;
  if (ammo.n > 0) for (const o of planes.values()) {
    if (o === t || !o.alive || !isEnemy(o.id) || !o.losVisible) continue;
    const d = _m2.copy(o.pos).sub(camera.position), dist = d.length();
    if (dist > LOCK_RANGE) continue;
    const ang = Math.acos(Math.max(-1, Math.min(1, d.dot(aim) / dist)));
    if (o.id === lock.id && ang < LOCK_KEEP) { keep = true; best = o; break; }
    if (ang < bestA) { bestA = ang; best = o; }
  }
  if (best && (keep || best.id === lock.id)) { lock.t += dt; lock.lostT = 0; }
  else if (best) { lock.id = best.id; lock.t = 0; lock.locked = false; lock.lostT = 0; }
  else if (lock.id) { lock.lostT += dt; if (lock.lostT > 0.4) { lock.id = null; lock.t = 0; lock.locked = false; } }
  if (lock.id && lock.t >= LOCK_TIME && !lock.locked) { lock.locked = true; }
  // tones: slow beeps while locking, fast high beeps when locked
  lock.beepT -= dt;
  if (lock.id && lock.beepT <= 0) {
    if (lock.locked) { audio.tone(1500, 0.05, 0.05); lock.beepT = 0.09; }
    else { audio.tone(820 + lock.t / LOCK_TIME * 500, 0.06, 0.04); lock.beepT = 0.22; }
  }
  sendLock();
}
function sendLock(force) {
  const s = lock.id ? (lock.locked ? 2 : 1) : 0;
  const key = (lock.id || '') + s;
  const now = performance.now();
  if (key !== lock.sentKey || force || (s && now - lock.sentAt > 1000)) {
    socket.emit('lock', { target: lock.id, s });
    lock.sentKey = key; lock.sentAt = now;
  }
}
function resetLock() { lock.id = null; lock.t = 0; lock.locked = false; sendLock(true); }

function fireMissile() {
  const t = myPlane();
  if (!inGame || !t || !t.alive || t.crashed || performance.now() < roundStartAt || ammo.n <= 0 || chatOpen) return;
  ammo.n--;
  const pyl = t.vis.missiles[t.misIdx]; t.misIdx ^= 1;
  const o = pyl.getWorldPosition(new THREE.Vector3());
  const vel = fwd(t.h, t.p, new THREE.Vector3()).multiplyScalar(t.speed + 30);
  vel.y -= 6;   // drops off the rail
  const target = lock.locked ? lock.id : null;
  const id = myId + ':' + (misSeq++);
  spawnMissile({ id, owner: myId, target, pos: o, vel, mine: true });
  socket.emit('missile', { id, o: [+o.x.toFixed(1), +o.y.toFixed(1), +o.z.toFixed(1)], v: [+vel.x.toFixed(1), +vel.y.toFixed(1), +vel.z.toFixed(1)], target });
  audio.play('shoot', 1.8, 0, 0.6); audio.whoosh(1);
  shake = Math.max(shake, 0.3);
  if (!target) logMsg('Ракета без захвата');
  lock.t = 0; lock.locked = false;
}
function spawnMissile(m) {
  m.age = 0; m.mesh = makeMissileMesh(); m.mesh.position.copy(m.pos); scene.add(m.mesh);
  m.trailT = 0;
  missiles.push(m);
}
function detonate(i, pt, hitPlane) {
  const m = missiles[i];
  scene.remove(m.mesh); missiles.splice(i, 1);
  particles.explosion(pt, hitPlane ? 0.9 : 0.6);
  audio.at('hit', pt, hitPlane ? 1 : 0.7, 0.75);
  if (m.mine) {
    socket.emit('mboom', { id: m.id, pt: [+pt.x.toFixed(1), +pt.y.toFixed(1), +pt.z.toFixed(1)] });
    if (hitPlane && m.sam) socket.emit('samhit', { pt: [+pt.x.toFixed(1), +pt.y.toFixed(1), +pt.z.toFixed(1)] });
    else if (hitPlane) socket.emit('hit', { target: hitPlane.id, dmg: MISSILE_DMG, pt: [+pt.x.toFixed(1), +pt.y.toFixed(1), +pt.z.toFixed(1)], zone: 'missile', m: true });
  }
}
// closest distance from point c to segment p -> p+s
function segDist(p, s, c) {
  const len2 = s.lengthSq();
  const k = len2 > 0 ? Math.max(0, Math.min(1, _m3.copy(c).sub(p).dot(s) / len2)) : 0;
  return _m3.copy(p).addScaledVector(s, k).distanceTo(c);
}
// ── ПВО: each client runs the SAM sites against its own jet only ──
const SAM_HOME = 7, SAM_LIFE = 10, SAM_TURN = 1.7, SAM_SPEED = 400;
let samLock = 0, samSeq = 0;
function updateSams(dt) {
  if (!world || !world.sams) return;
  const now = performance.now();
  const t = myPlane();
  const live = inGame && t && t.alive && !t.crashed && now > roundStartAt;
  let lvl = 0;
  for (const sm of world.sams) {
    sm.spin += dt * (sm.lockT > 0 ? 4 : 1.2);
    sm.radar.rotation.y = sm.spin;
    sm.lamp.visible = sm.lockT > 0 ? (now % 300 < 150) : (now % 1600 < 120);
    sm.cd -= dt;
    let sees = false;
    if (live) {
      const dx = t.pos.x - sm.x, dz = t.pos.z - sm.z, hd = Math.hypot(dx, dz);
      const out = Math.max(Math.abs(t.pos.x), Math.abs(t.pos.z)) > EDGE;
      if (out && hd < SAM_RANGE) {
        sees = true;   // border radar sees anything that leaves the battle area
      }
      if (sees) {
        sm.turn.rotation.y += (Math.atan2(dx, dz) - sm.turn.rotation.y) * Math.min(1, dt * 3);
        sm.lockT += dt;
      } else sm.lockT = Math.max(0, sm.lockT - dt * 1.5);
    } else sm.lockT = 0;
    if (sm.lockT > 0) lvl = Math.max(lvl, sm.lockT > SAM_LOCK * 0.5 ? 2 : 1);
    if (sees && sm.lockT >= SAM_LOCK && sm.cd <= 0 && !missiles.some(m => m.samIdx === sm && m.age < SAM_HOME)) {
      sm.cd = SAM_CD; sm.lockT = SAM_LOCK * 0.4;
      const o = sm.top.clone().add(new THREE.Vector3(Math.sin(sm.turn.rotation.y) * 4, 4, Math.cos(sm.turn.rotation.y) * 4));
      const vel = new THREE.Vector3(Math.sin(sm.turn.rotation.y) * 45, 90, Math.cos(sm.turn.rotation.y) * 45);
      const id = myId + ':s' + (samSeq++);
      spawnMissile({ id, owner: 'sam', target: myId, pos: o, vel, mine: true, sam: true, samIdx: sm, home: SAM_HOME, life: SAM_LIFE, turn: SAM_TURN, spd: SAM_SPEED });
      socket.emit('missile', { id, o: [+o.x.toFixed(1), +o.y.toFixed(1), +o.z.toFixed(1)], v: [+vel.x.toFixed(1), +vel.y.toFixed(1), +vel.z.toFixed(1)], sam: 1 });
      audio.at('shoot', o, 2.2, 0.45); audio.whooshAt(o, 1.3);
      particles.explosion(o, 0.35);
      logMsg('<b style="color:#ff6a50">ПВО: пуск ракеты!</b>');
    }
  }
  samLock = live ? lvl : 0;
}
function updateMissiles(dt) {
  for (let i = missiles.length - 1; i >= 0; i--) {
    const m = missiles[i];
    m.age += dt;
    const homeT = m.home || HOMING_TIME;
    let sp = Math.min(m.spd || MISSILE_SPEED, m.vel.length() + 170 * dt);
    const dir = _m1.copy(m.vel).normalize();
    // homing phase: chase the target (or a flare) with a limited turn rate, so hard turns can dodge
    if (m.age < homeT && m.age > (m.sam ? 0.8 : 0.25)) {
      let aimPos = null;
      if (m.decoy) aimPos = m.decoy.pos;
      else if (m.target) {
        const tg = planes.get(m.target);
        if (tg && tg.alive) {
          const dist = tg.pos.distanceTo(m.pos);
          aimPos = _m2.copy(tg.pos).addScaledVector(fwd(tg.h, tg.p, _m3), tg.speed * Math.min(1.5, dist / sp) * 0.55);
        }
      }
      if (aimPos) {
        const want = _m2.copy(aimPos).sub(m.pos).normalize();
        const ang = Math.acos(Math.max(-1, Math.min(1, dir.dot(want))));
        if (ang > 1e-4) dir.lerp(want, Math.min(1, (m.turn || MISSILE_TURN) * dt / ang)).normalize();
      }
    }
    m.vel.copy(dir).multiplyScalar(sp);
    const step = _m2.copy(m.vel).multiplyScalar(dt);
    let hit = null;
    // proximity fuse (owner's missile decides damage; others just show the blast)
    for (const pl of planes.values()) {
      if (pl.id === m.owner || !pl.alive) continue;
      if (m.sam) { if (pl.id !== m.target) continue; }
      else {
        if (m.mine && !isEnemy(pl.id)) continue;
        if (!m.mine && pl.id !== m.target) continue;
      }
      if (segDist(m.pos, step, pl.pos) < MISSILE_FUSE) { hit = pl; break; }
    }
    if (hit) { detonate(i, _m3.copy(hit.pos).lerp(m.pos, 0.3).clone(), m.mine ? hit : null); continue; }
    m.pos.add(step);
    if (m.pos.y < Math.max(H(m.pos.x, m.pos.z), -6.5) + 0.5) { detonate(i, m.pos.clone(), null); continue; }
    if (m.age > (m.life || MISSILE_LIFE)) { detonate(i, m.pos.clone(), null); continue; }   // self-destruct
    m.mesh.position.copy(m.pos);
    m.mesh.lookAt(_m3.copy(m.pos).add(m.vel));
    m.trailT -= dt;
    if (m.trailT <= 0) { m.trailT = 0.025; particles.mtrail(_m3.copy(m.pos).addScaledVector(dir, -2.6)); particles.mflame(_m3.copy(m.pos).addScaledVector(dir, -2.4)); }
  }
  for (let i = decoys.length - 1; i >= 0; i--) {
    const d = decoys[i];
    d.life -= dt; d.vel.y -= 9 * dt; d.vel.multiplyScalar(Math.exp(-0.6 * dt)); d.pos.addScaledVector(d.vel, dt);
    if (Math.random() < 0.5) particles.flareSmoke(d.pos);
    if (d.life <= 0) decoys.splice(i, 1);
  }
}
function clearMissiles() {
  for (const m of missiles) scene.remove(m.mesh);
  missiles.length = 0; decoys.length = 0; lockedBy.clear();
}

function dropFlares() {
  const t = myPlane();
  if (!inGame || !t || !t.alive || t.crashed || flares <= 0 || flareCd > 0 || chatOpen) return;
  flares--; flareCd = 1.2;
  socket.emit('flare');
}
socket.on('flare', id => {
  const pl = planes.get(id); if (!pl || !world) return;
  const f = fwd(pl.h, pl.p, new THREE.Vector3());
  const base = pl.pos.clone().addScaledVector(f, -9);
  const decoy = { pos: base.clone(), vel: f.clone().multiplyScalar(pl.speed * 0.35).add(new THREE.Vector3(0, -6, 0)), life: 3 };
  decoys.push(decoy);
  for (let k = 0; k < 8; k++) {
    const side = (k % 2 ? 1 : -1) * (6 + k * 2);
    const right = _m1.set(-Math.cos(pl.h), 0, Math.sin(pl.h));
    particles.flare(base, _m2.copy(f).multiplyScalar(pl.speed * 0.3).addScaledVector(right, side).add(_m3.set(0, -4 - k, 0)));
  }
  audio.at('ricochet', base, 0.5, 1.8);
  // missiles chasing this plane go for the flare, unless they are already too close
  for (const m of missiles) {
    if (m.target !== id || m.decoy || m.age >= (m.home || HOMING_TIME)) continue;
    const d = m.pos.distanceTo(pl.pos);
    if (d > 55 && d < FLARE_DECOY_RANGE) m.decoy = decoy;
  }
  if (id === myId) logMsg('Ловушки сброшены');
});
socket.on('missile', (owner, m) => {
  if (!world || !inGame) return;
  const pos = new THREE.Vector3(...m.o);
  if (m.sam) spawnMissile({ id: m.id, owner: 'sam', target: owner, pos, vel: new THREE.Vector3(...m.v), mine: false, sam: true, home: SAM_HOME, life: SAM_LIFE, turn: SAM_TURN, spd: SAM_SPEED });
  else spawnMissile({ id: m.id, owner, target: m.target, pos, vel: new THREE.Vector3(...m.v), mine: false });
  audio.at('shoot', pos, 1.6, 0.6); audio.whooshAt(pos, 1);
});
socket.on('mboom', (owner, m) => {
  const i = missiles.findIndex(x => x.id === m.id);
  if (i >= 0) detonate(i, new THREE.Vector3(...m.pt), null);
});
socket.on('lock', (sid, l) => {
  if (l.target === myId && l.s) lockedBy.set(sid, l.s); else lockedBy.delete(sid);
});

// warnings for the player being hunted
function drawThreats(dt) {
  const t = myPlane();
  const el = $('mwarn');
  if (!inGame || !t || !t.alive) { el.style.display = 'none'; return; }
  const incoming = missiles.filter(m => m.target === myId && !m.decoy && m.age < (m.home || HOMING_TIME));
  for (const [sid] of lockedBy) { const s = planes.get(sid); if (!s || !s.alive) lockedBy.delete(sid); }
  let locked = 0; for (const v of lockedBy.values()) locked = Math.max(locked, v);
  warnBeepT -= dt;
  if (incoming.length) {
    let near = incoming[0], nd = Infinity;
    for (const m of incoming) { const d = m.pos.distanceTo(t.pos); if (d < nd) { nd = d; near = m; } }
    el.style.display = 'block'; el.className = ''; el.textContent = 'РАКЕТА! ' + Math.round(nd) + 'м';
    if (warnBeepT <= 0) { audio.tone(1150, 0.07, 0.07); warnBeepT = Math.max(0.07, Math.min(0.45, nd / 900)); }
    // pointer to the nearest missile: circle if on screen, arrow at the screen edge if not
    const w = innerWidth, h = innerHeight;
    const v = _m1.copy(near.pos).applyMatrix4(camera.matrixWorldInverse);
    const p2 = project(near.pos);
    if (p2 && v.z < 0 && p2[0] > 0 && p2[0] < w && p2[1] > 0 && p2[1] < h) {
      hctx.strokeStyle = '#ff4a36'; hctx.lineWidth = 3; hctx.beginPath(); hctx.arc(p2[0], p2[1], 18, 0, TAU); hctx.stroke();
    } else {
      let ax = v.x, ay = v.y; if (v.z > 0) { ax = -ax; ay = -ay; }
      const ang = Math.atan2(-ay, ax), R = Math.min(w, h) * 0.32;
      const cx = w / 2 + Math.cos(ang) * R, cy = h / 2 + Math.sin(ang) * R;
      hctx.save(); hctx.translate(cx, cy); hctx.rotate(ang);
      hctx.fillStyle = '#ff4a36'; hctx.beginPath(); hctx.moveTo(22, 0); hctx.lineTo(-10, -14); hctx.lineTo(-4, 0); hctx.lineTo(-10, 14); hctx.closePath(); hctx.fill();
      hctx.restore();
    }
  } else if (samLock) {
    el.style.display = 'block'; el.className = 'lock'; el.textContent = samLock === 2 ? 'ПВО: ЗАХВАТ! ВЕРНИТЕСЬ В ЗОНУ!' : 'ПВО: РАДАР';
    if (warnBeepT <= 0) { audio.tone(samLock === 2 ? 900 : 560, 0.08, 0.05); warnBeepT = samLock === 2 ? 0.16 : 0.5; }
  } else if (locked) {
    el.style.display = 'block'; el.className = 'lock'; el.textContent = locked === 2 ? 'ВАС ЗАХВАТИЛИ' : 'ВАС ЗАХВАТЫВАЮТ';
    if (locked === 2 && warnBeepT <= 0) { audio.tone(700, 0.08, 0.05); warnBeepT = 0.35; }
  } else el.style.display = 'none';
}
// lock-on brackets around my target + the lock circle
function drawLockUi() {
  const t = myPlane(); if (!t || !t.alive || t.crashed) return;
  const w = innerWidth, h = innerHeight;
  if (ammo.n > 0) {
    const r = LOCK_CONE / (camera.fov * Math.PI / 360) * (h / 2);
    hctx.setLineDash([4, 6]); hctx.lineWidth = 1; hctx.strokeStyle = 'rgba(255,255,255,.35)';
    hctx.beginPath(); hctx.arc(w / 2, h / 2, r, 0, TAU); hctx.stroke(); hctx.setLineDash([]);
  }
  if (!lock.id) return;
  const o = planes.get(lock.id); if (!o) return;
  const p = project(o.pos); if (!p) return;
  const k = Math.min(1, lock.t / LOCK_TIME);
  const s = 22 + (1 - k) * 34, c = lock.locked ? '#ff3a26' : '#e3a53c';
  hctx.strokeStyle = c; hctx.lineWidth = lock.locked ? 3 : 2;
  for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    hctx.beginPath(); hctx.moveTo(p[0] + sx * s, p[1] + sy * (s - 10)); hctx.lineTo(p[0] + sx * s, p[1] + sy * s); hctx.lineTo(p[0] + sx * (s - 10), p[1] + sy * s); hctx.stroke();
  }
  hctx.font = '800 11px Unbounded'; hctx.textAlign = 'center'; hctx.fillStyle = c;
  hctx.fillText(lock.locked ? 'ЗАХВАТ · ПКМ' : 'ЗАХВАТ ' + Math.round(k * 100) + '%', p[0], p[1] + s + 16);
}
function updateAmmoHud() {
  const el = $('mis');
  if (el.children.length !== MISSILE_MAX) el.innerHTML = '<u><i></i></u>'.repeat(MISSILE_MAX);
  [...el.children].forEach((u, i) => {
    const pct = i < ammo.n ? 100 : i === ammo.n ? ammo.reload / MISSILE_RELOAD * 100 : 0;
    u.firstChild.style.height = pct + '%';
    u.firstChild.style.background = i < ammo.n ? '#f3f1e8' : '#e3a53c';
  });
  $('flr').textContent = flares;
}

// ═══════════ REMOTE PLANES ═══════════
socket.on('st', (id, s) => {
  const t = planes.get(id); if (!t || t.isMe) return;
  t.tpos.set(s[0], s[1], s[2]); t.th = s[3]; t.tp = s[4]; t.tb = s[5]; t.tspeed = s[6]; t.firing = !!s[7]; t.throttle = s[8]; t.boosting = !!s[9]; t.misShown = s[10] ?? 2;
  t.recv = performance.now();
});
function updateRemote(t, dt, now) {
  if (!t.alive) return;
  // extrapolate the last packet along the flight path, then smooth toward it
  const ex = Math.min(0.25, (now - t.recv) / 1000);
  const f = fwd(t.th, t.tp, _v1);
  const px = t.tpos.x + f.x * t.tspeed * ex, py = t.tpos.y + f.y * t.tspeed * ex, pz = t.tpos.z + f.z * t.tspeed * ex;
  const k = 1 - Math.exp(-dt * 10);
  if (t.pos.distanceToSquared(_v2.set(px, py, pz)) > 160 * 160) t.pos.set(px, py, pz);
  else { t.pos.x = lerp(t.pos.x, px, k); t.pos.y = lerp(t.pos.y, py, k); t.pos.z = lerp(t.pos.z, pz, k); }
  t.h = wrap(t.h + wrap(t.th - t.h) * k); t.p = lerp(t.p, t.tp, k); t.b = lerp(t.b, t.tb, k); t.speed = t.tspeed;
  if (t.firing) {
    t.fireAcc += dt;
    while (t.fireAcc >= 1 / FIRE_RATE) { t.fireAcc -= 1 / FIRE_RATE; fireGun(t, false); }
  }
}

// ═══════════ CAMERA ═══════════
function updateCamera(dt, now) {
  const t = myPlane();
  let focus = t && (t.alive || t.falling || now - myDeathAt < 2500) ? t : null;
  if (!focus) {
    spectating = true;
    let st = planes.get(specId);
    if (!st || !st.alive) { specId = pickSpectate(); st = planes.get(specId); }
    focus = st || t;
  } else spectating = false;
  $('spec').style.display = spectating && inGame ? 'block' : 'none';
  if (spectating) {
    const p = focus && room.players.find(q => q.id === focus.id);
    $('spec').textContent = focus && focus.alive && focus !== t ? `НАБЛЮДЕНИЕ: ${p ? p.name.toUpperCase() : ''} · ПРОБЕЛ — СЛЕДУЮЩИЙ` : 'ВАС СБИЛИ · ОЖИДАНИЕ';
  }
  if (!focus) return;
  const d = _v1.set(Math.sin(camYaw) * Math.cos(camPitch), Math.sin(camPitch), Math.cos(camYaw) * Math.cos(camPitch));
  const base = focus.pos;
  const dist = zoom && !spectating ? camDist * 0.6 : camDist;
  const cp = _v3.copy(base).addScaledVector(d, -dist);
  cp.y += dist * 0.2;
  const gh = H(cp.x, cp.z) + 3;
  if (cp.y < gh) cp.y = gh;
  camera.fov = lerp(camera.fov, zoom && !spectating ? 30 : 65, 1 - Math.exp(-10 * dt));
  camera.updateProjectionMatrix();
  shake = Math.max(0, shake - dt * 1.5);
  const sk = shake * shake * 0.7;
  camera.position.set(cp.x + (Math.random() - .5) * sk, cp.y + (Math.random() - .5) * sk, cp.z + (Math.random() - .5) * sk);
  camera.lookAt(_v4.copy(camera.position).add(d));
  sun.position.set(base.x + SUN_DIR.x * 400, base.y + SUN_DIR.y * 400, base.z + SUN_DIR.z * 400);
  sun.target.position.copy(base);
}
function pickSpectate() {
  const meP = me();
  const alive = [...planes.values()].filter(t => t.alive && t.id !== myId);
  const pref = room && room.mode === 'team' && meP ? alive.filter(t => (room.players.find(p => p.id === t.id) || {}).team === meP.team) : [];
  return (pref[0] || alive[0] || {}).id || null;
}
function cycleSpectate() {
  const alive = [...planes.values()].filter(t => t.alive && t.id !== myId);
  if (!alive.length) return;
  const i = alive.findIndex(t => t.id === specId);
  specId = alive[(i + 1) % alive.length].id;
}
function isEnemy(id) {
  if (!room) return true;
  if (room.mode === 'ffa') return id !== myId;
  const a = room.players.find(p => p.id === id), b = me();
  return a && b ? a.team !== b.team : true;
}

// ═══════════ HUD ═══════════
function project(v) {
  _v2.copy(v).project(camera);
  if (_v2.z > 1) return null;
  return [(_v2.x * .5 + .5) * innerWidth, (-_v2.y * .5 + .5) * innerHeight];
}
function drawHud(now, dt) {
  const w = innerWidth, h = innerHeight;
  hctx.clearRect(0, 0, w, h);
  if (!inGame) return;
  const t = myPlane();
  if (t && t.alive && !t.crashed) {
    // mouse-aim circle (where you want to fly)
    hctx.lineWidth = 3; hctx.strokeStyle = 'rgba(0,0,0,.35)';
    hctx.beginPath(); hctx.arc(w / 2, h / 2, 12, 0, TAU); hctx.stroke();
    hctx.lineWidth = 1.5; hctx.strokeStyle = 'rgba(255,255,255,.8)';
    hctx.beginPath(); hctx.arc(w / 2, h / 2, 12, 0, TAU); hctx.stroke();
    // gun cross (where the bullets go)
    const gp = project(_v3.copy(t.pos).addScaledVector(fwd(t.h, t.p, _v4), CONVERGE));
    let gunPt = null;
    if (gp) {
      gunPt = gp;
      const col = overheated ? '#ff5a46' : heat > 0.7 ? '#e3a53c' : '#f3f1e8';
      for (const [lw, sc] of [[4, 'rgba(0,0,0,.45)'], [2, col]]) {
        hctx.lineWidth = lw; hctx.strokeStyle = sc;
        hctx.beginPath();
        hctx.moveTo(gp[0] - 16, gp[1]); hctx.lineTo(gp[0] - 6, gp[1]); hctx.moveTo(gp[0] + 6, gp[1]); hctx.lineTo(gp[0] + 16, gp[1]);
        hctx.moveTo(gp[0], gp[1] - 16); hctx.lineTo(gp[0], gp[1] - 6); hctx.moveTo(gp[0], gp[1] + 6); hctx.lineTo(gp[0], gp[1] + 16);
        hctx.stroke();
        hctx.beginPath(); hctx.arc(gp[0], gp[1], 22, 0, TAU); hctx.stroke();
      }
      // heat arc
      if (heat > 0.02) { hctx.lineWidth = 3; hctx.strokeStyle = overheated ? '#ff5a46' : '#e3a53c'; hctx.beginPath(); hctx.arc(gp[0], gp[1], 28, -Math.PI / 2, -Math.PI / 2 + TAU * heat); hctx.stroke(); }
    }
    // lead markers for visible enemies in range
    for (const o of planes.values()) {
      if (o === t || !o.alive || !isEnemy(o.id) || !o.losVisible) continue;
      const r = _v3.copy(o.pos).sub(t.pos), dist = r.length();
      if (dist > 900) continue;
      const tf = dist / (BULLET_SPEED + t.speed);
      const lead = _v4.copy(o.pos).addScaledVector(fwd(o.h, o.p, _v1), o.speed * tf);
      const lp = project(lead), op = project(o.pos);
      if (!lp || !op) continue;
      hctx.strokeStyle = 'rgba(255,110,90,.5)'; hctx.lineWidth = 1;
      hctx.beginPath(); hctx.moveTo(op[0], op[1]); hctx.lineTo(lp[0], lp[1]); hctx.stroke();
      const near = gunPt && Math.hypot(gunPt[0] - lp[0], gunPt[1] - lp[1]) < 24;
      hctx.fillStyle = near ? '#ff3a26' : 'rgba(255,110,90,.9)';
      hctx.beginPath(); hctx.moveTo(lp[0], lp[1] - 7); hctx.lineTo(lp[0] + 7, lp[1]); hctx.lineTo(lp[0], lp[1] + 7); hctx.lineTo(lp[0] - 7, lp[1]); hctx.closePath(); hctx.fill();
      hctx.font = '700 9px Unbounded'; hctx.textAlign = 'center'; hctx.fillText(Math.round(dist) + ' м', lp[0], lp[1] + 18);
    }
  }
  drawLockUi();
  drawThreats(dt);
  if (!locked && !isTouch && t && t.alive) {
    hctx.font = '700 12px Unbounded'; hctx.textAlign = 'center'; hctx.fillStyle = 'rgba(0,0,0,.55)';
    hctx.fillRect(w / 2 - 170, h * 0.66 - 20, 340, 32); hctx.fillStyle = '#e3a53c';
    hctx.fillText('КЛИКНИТЕ, ЧТОБЫ УПРАВЛЯТЬ', w / 2, h * 0.66);
  }
  if (now < roundStartAt) {
    const s = Math.ceil((roundStartAt - now) / 1000);
    centerMsg(String(s), room && room.mode === 'team' ? 'РАУНД ' + room.round : 'ПРИГОТОВЬТЕСЬ', 400);
  }
  const wEl = $('warn');
  const wt = overheated && t && t.alive ? (warnText || 'ПУЛЕМЁТЫ ПЕРЕГРЕТЫ') : warnText;
  wEl.style.display = wt && inGame ? 'block' : 'none';
  if (wt) wEl.textContent = wt;
}

let centerTimer = 0;
function centerMsg(big, small = '', ms = 1800, color = '') {
  const c = $('center');
  c.innerHTML = `<span style="color:${color}">${esc(big)}</span>${small ? `<small>${esc(small)}</small>` : ''}`;
  c.style.opacity = 1;
  clearTimeout(centerTimer); centerTimer = setTimeout(() => c.style.opacity = 0, ms);
}
function feed(html) {
  const d = document.createElement('div'); d.innerHTML = html; $('feed').prepend(d);
  setTimeout(() => d.remove(), 6000);
  while ($('feed').children.length > 6) $('feed').lastChild.remove();
}
function logMsg(html) {
  const d = document.createElement('div'); d.innerHTML = html; $('log').prepend(d);
  setTimeout(() => d.remove(), 5000);
  while ($('log').children.length > 5) $('log').lastChild.remove();
}
function nameOf(id) { const p = room && room.players.find(q => q.id === id); return p ? esc(p.name) : '???'; }
function nameCol(id) { if (!room) return '#fff'; if (id === myId) return 'var(--acc)'; return isEnemy(id) ? '#ff7a68' : '#a4e07a'; }
function floatText(pos, text, cls = '') {
  const p = project(pos); if (!p) return;
  const d = document.createElement('div'); d.className = 'dmgnum ' + cls; d.textContent = text;
  d.style.left = p[0] + 'px'; d.style.top = p[1] + 'px';
  $('markers').appendChild(d); setTimeout(() => d.remove(), 1100);
}

let roomRecv = 0;
function updateTopBar() {
  if (!room) return;
  if (room.mode === 'team') {
    $('top').innerHTML = `<span class="sc tA">${room.scores[0]}</span><div class="mid">АЛЬФА · РАУНД ${room.round} · БРАВО<br><span style="color:var(--txt)">${aliveCount(0)} против ${aliveCount(1)}</span></div><span class="sc tB">${room.scores[1]}</span>`;
  } else {
    const left = room.timeLeft != null ? Math.max(0, Math.round((room.timeLeft - (performance.now() - roomRecv)) / 1000)) : 0;
    const lead = [...room.players].sort((a, b) => b.kills - a.kills)[0];
    const mm = Math.floor(left / 60), ss = String(left % 60).padStart(2, '0');
    $('top').innerHTML = `<div class="mid">ВРЕМЯ<br><span style="color:var(--txt);font-size:16px">${mm}:${ss}</span></div><div class="mid">ЛИДЕР<br><span style="color:var(--acc);font-size:12px">${lead ? esc(lead.name) + ' · ' + lead.kills : '-'}</span></div><div class="mid">ВЫ<br><span style="color:var(--txt);font-size:16px">${me() ? me().kills : 0}</span></div>`;
  }
}
function aliveCount(team) { return room.players.filter(p => p.team === team && (planes.get(p.id) || {}).alive).length; }
function updateBottom() {
  const p = me(), t = myPlane();
  const hp = t && t.alive ? (p ? p.hp : MAX_HP) : 0;
  $('hptxt').textContent = Math.max(0, hp);
  $('hpfill').style.width = Math.max(0, hp) + '%';
  $('hpfill').style.background = hp > 50 ? 'linear-gradient(90deg,#8fbf55,#b6d35f)' : hp > 25 ? 'linear-gradient(90deg,#d29a35,#e3b54a)' : 'linear-gradient(90deg,#c9432f,#e0503f)';
  $('myname').textContent = p ? p.name.toUpperCase() : '';
  if (t) {
    $('spd').textContent = Math.round(t.speed * 3.6);
    $('alt').textContent = Math.max(0, Math.round(t.pos.y - H(t.pos.x, t.pos.z)));
    $('thr').style.width = t.throttle * 100 + '%';
    $('bst').style.width = t.boost * 100 + '%';
    $('heat').style.width = heat * 100 + '%';
    $('heat').style.background = overheated ? '#e0503f' : '#e3a53c';
  }
}
function renderBoard() {
  if (!room) return;
  const rows = ps => ps.sort((a, b) => b.kills - a.kills || b.dmg - a.dmg).map(p =>
    `<tr class="${p.id === myId ? 'me' : ''} ${(planes.get(p.id) || {}).alive ? '' : 'dead'}"><td>${esc(p.name)}</td><td class="n">${p.kills}</td><td class="n">${p.dmg}</td><td class="n">${p.deaths}</td></tr>`).join('');
  const head = '<tr><th>ПИЛОТ</th><th class="n">СБИТО</th><th class="n">УРОН</th><th class="n">СМЕРТИ</th></tr>';
  if (room.mode === 'team') {
    $('board').innerHTML = [0, 1].map(tm => `<div style="font-size:10px;letter-spacing:.25em;color:${tm ? 'var(--b)' : 'var(--a)'};margin:${tm ? 14 : 0}px 0 4px">${tm ? 'БРАВО' : 'АЛЬФА'} · ${room.scores[tm]}</div><table>${head}${rows(room.players.filter(p => p.team === tm))}</table>`).join('');
  } else $('board').innerHTML = `<table>${head}${rows([...room.players])}</table>`;
}

// markers above planes (enemies only in line of sight: hills block, clouds don't)
let losT = 0; const _mkTop = new THREE.Vector3();
function updateMarkers(dt) {
  losT -= dt;
  const doLos = losT <= 0; if (doLos) losT = 0.2;
  for (const t of planes.values()) {
    const mk = t.marker;
    if (!inGame || t.id === myId || !t.alive || !t.vis.g.visible) { mk.style.display = 'none'; continue; }
    const enemy = isEnemy(t.id);
    const top = _mkTop.copy(t.pos); top.y += 4;
    if (doLos) {
      if (!enemy) t.losVisible = true;
      else {
        const dx = t.pos.x - camera.position.x, dy = t.pos.y - camera.position.y, dz = t.pos.z - camera.position.z, d = Math.hypot(dx, dy, dz);
        _o[0] = camera.position.x; _o[1] = camera.position.y; _o[2] = camera.position.z; _d[0] = dx / d; _d[1] = dy / d; _d[2] = dz / d;
        t.losVisible = d < 2600 && !castRay(_o, _d, d - 3, myId, { noPlanes: true, step: 12 });
      }
    }
    const p2 = project(top);
    if (!p2 || !t.losVisible) { mk.style.display = 'none'; continue; }
    const p = room.players.find(q => q.id === t.id);
    const dist = t.pos.distanceTo(camera.position);
    mk.style.display = 'block';
    mk.className = 'mk ' + (enemy ? 'en' : 'al');
    mk.style.left = p2[0] + 'px'; mk.style.top = p2[1] + 'px';
    mk.firstChild.textContent = (p ? p.name : '') + (dist > 250 ? ' · ' + Math.round(dist) + ' м' : '');
    mk.querySelector('i').style.width = (p ? p.hp : 0) + '%';
  }
}

// ── minimap ──
const mm = $('minimap'), mctx = mm.getContext('2d');
let mmBase = null;
function buildMinimapBase() {
  const S = 380; mmBase = document.createElement('canvas'); mmBase.width = mmBase.height = S;
  const c = mmBase.getContext('2d');
  const k = S / (MAP_HALF * 2);
  const img = c.createImageData(S, S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const wx = (x / S * 2 - 1) * MAP_HALF, wz = (y / S * 2 - 1) * MAP_HALF;
    const hh = H(wx, wz), i = (y * S + x) * 4;
    const sh = (H(wx + 6, wz + 6) - hh) * 3;
    if (hh < -5) { img.data[i] = 70; img.data[i + 1] = 100; img.data[i + 2] = 112; img.data[i + 3] = 255; continue; }
    const base = 70 + hh * 0.5 - sh;
    img.data[i] = base * 0.92; img.data[i + 1] = base; img.data[i + 2] = base * 0.78; img.data[i + 3] = 255;
  }
  c.putImageData(img, 0, 0);
  c.strokeStyle = 'rgba(255,255,255,.08)'; c.lineWidth = 1;
  for (let i = 1; i < 10; i++) { c.beginPath(); c.moveTo(i * S / 10, 0); c.lineTo(i * S / 10, S); c.moveTo(0, i * S / 10); c.lineTo(S, i * S / 10); c.stroke(); }
  c.fillStyle = 'rgba(40,60,30,.5)';
  for (const t of world.trees) c.fillRect((t.x + MAP_HALF) * k, (t.z + MAP_HALF) * k, 2, 2);
  c.fillStyle = '#c9c0ae';
  for (const b of world.boxes) c.fillRect((b.x - b.hx + MAP_HALF) * k, (b.z - b.hz + MAP_HALF) * k, Math.max(2, b.hx * 2 * k), Math.max(2, b.hz * 2 * k));
}
function drawMinimap() {
  if (!mmBase || !inGame) return;
  const S = 380, k = S / (MAP_HALF * 2);
  mctx.clearRect(0, 0, S, S);
  mctx.drawImage(mmBase, 0, 0);
  const P = (x, z) => [(x + MAP_HALF) * k, (z + MAP_HALF) * k];
  for (const sm of world.sams) {
    const [x, y] = P(sm.x, sm.z);
    mctx.fillStyle = '#ff4a36'; mctx.beginPath(); mctx.moveTo(x, y - 6); mctx.lineTo(x + 5, y + 4); mctx.lineTo(x - 5, y + 4); mctx.closePath(); mctx.fill();
  }
  for (const c of world.crates) if (c.avail) { const [x, y] = P(c.x, c.z); mctx.strokeStyle = '#9bff7a'; mctx.lineWidth = 3; mctx.beginPath(); mctx.arc(x, y, 6, 0, TAU); mctx.stroke(); }
  for (const t of planes.values()) {
    if (!t.vis.g.visible || (!t.alive && !t.falling)) continue;
    const enemy = isEnemy(t.id), isMe = t.id === myId;
    if (enemy && !t.losVisible) continue;
    const [x, y] = P(t.pos.x, t.pos.z);
    mctx.save(); mctx.translate(x, y); mctx.rotate(-t.h + Math.PI);
    mctx.fillStyle = !t.alive ? '#555' : isMe ? '#fff' : enemy ? '#ff5a46' : '#8fe060';
    mctx.beginPath(); mctx.moveTo(0, -11); mctx.lineTo(9, 7); mctx.lineTo(0, 3); mctx.lineTo(-9, 7); mctx.closePath(); mctx.fill();
    if (isMe) { mctx.strokeStyle = '#111'; mctx.lineWidth = 2; mctx.stroke(); }
    mctx.restore();
  }
  const t = myPlane();
  if (t) {
    const [x, y] = P(t.pos.x, t.pos.z);
    mctx.strokeStyle = 'rgba(255,255,255,.5)'; mctx.lineWidth = 2;
    for (const off of [-0.5, 0.5]) { const a = camYaw + off; mctx.beginPath(); mctx.moveTo(x, y); mctx.lineTo(x + Math.sin(a) * 60, y + Math.cos(a) * 60); mctx.stroke(); }
  }
  // battle-area border
  const inset = (MAP_HALF - 30) * k;
  mctx.strokeStyle = 'rgba(255,90,70,.45)'; mctx.lineWidth = 2; mctx.strokeRect(S / 2 - inset, S / 2 - inset, inset * 2, inset * 2);
}

// ═══════════ NETWORK EVENTS ═══════════
socket.on('room', r => {
  room = r;
  roomRecv = performance.now();
  if (world && r.crates) r.crates.forEach((a, i) => { if (world.crates[i]) world.crates[i].avail = a; });
  if (r.state === 'lobby' && (!inGame && !$('result').classList.contains('on'))) showScreen(myId ? 'lobby' : 'menu');
  if (!myId) return;
  renderLobby();
  if (inGame) { syncPlanes(); for (const p of r.players) { const t = planes.get(p.id); if (t) t.hp = p.hp; } }
  if ($('board').classList.contains('on')) renderBoard();
});
socket.on('roundStart', d => {
  if (!room) return;
  if (worldSeed !== room.seed) { buildWorld(room.seed); worldSeed = room.seed; }
  enterGame(); showScreen(null);
  syncPlanes();
  for (const b of bullets) b.m.visible = false; bullets.length = 0;
  clearMissiles(); resetLock();
  for (const t of planes.values()) { t.vis.g.visible = false; t.alive = false; t.falling = null; t.burnT = 0; }
  for (const [id, sp] of Object.entries(d.spawns)) { const t = planes.get(id); if (t) placePlane(t, sp); }
  const t = myPlane();
  if (t && t.alive) { camYaw = t.h; camPitch = 0; }
  heat = 0; overheated = false; zoom = false;
  roundStartAt = performance.now() + d.startAt;
  world.crates.forEach(c => c.avail = true);
});
socket.on('respawn', d => {
  const t = planes.get(d.id); if (!t) return;
  placePlane(t, d.spawn);
  const rp = room.players.find(q => q.id === d.id); if (rp) { rp.hp = d.hp; rp.alive = true; }
  if (d.id === myId) { camYaw = t.h; camPitch = 0; heat = 0; overheated = false; centerMsg('СНОВА В ВОЗДУХЕ', '', 1200); }
});
socket.on('lateJoin', () => {
  if (worldSeed !== room.seed) { buildWorld(room.seed); worldSeed = room.seed; }
  enterGame(); syncPlanes();
  centerMsg('ВЫ ВОШЛИ ВО ВРЕМЯ БОЯ', room.mode === 'team' ? 'Вылет со следующего раунда' : 'Взлёт…', 2500);
});
// my damage is summed per target, so a burst shows one number
const dmgAcc = new Map();
let hitSoundT = 0, flashT = 0;
socket.on('dmg', d => {
  const pl = planes.get(d.target);
  const pt = new THREE.Vector3(...d.pt);
  particles.spark(pt);
  if (pl) pl.hp = d.hp;
  const p = room && room.players.find(q => q.id === d.target); if (p) p.hp = d.hp;
  const now = performance.now();
  if (d.target === myId) {
    if (now - hitSoundT > 110) { hitSoundT = now; audio.play('hit', 0.45, 0, 1.4 + Math.random() * .3); }
    shake = Math.max(shake, 0.3);
    if (now - flashT > 250) {
      flashT = now;
      $('flash').style.transition = 'none'; $('flash').style.boxShadow = 'inset 0 0 140px rgba(220,40,30,.6)';
      requestAnimationFrame(() => { $('flash').style.transition = 'box-shadow .5s'; $('flash').style.boxShadow = 'inset 0 0 140px rgba(220,40,30,0)'; });
    }
  } else if (now - (pl && pl.hitSnd || 0) > 120) { if (pl) pl.hitSnd = now; audio.at('hit', pt, 0.4, 1.5); }
  if (d.by === myId && d.target !== myId) {
    const a = dmgAcc.get(d.target) || { n: 0, pt, t: now, zone: d.zone };
    a.n += d.dmg; a.pt = pt; if (d.zone === 'engine' || d.zone === 'cockpit' || d.zone === 'missile') a.zone = d.zone;
    dmgAcc.set(d.target, a);
  }
});
function flushDamage(now) {
  for (const [id, a] of dmgAcc) {
    if (now - a.t < 350) continue;
    floatText(a.pt, '−' + a.n + (a.zone === 'missile' ? ' РАКЕТА' : a.zone === 'engine' ? ' ДВИГАТЕЛЬ' : a.zone === 'cockpit' ? ' КАБИНА' : ''));
    logMsg(`Попадание: <b style="color:${nameCol(id)}">${nameOf(id)}</b> <span style="color:#ffcf6a">−${a.n}</span>`);
    dmgAcc.delete(id);
  }
}
socket.on('ric', d => {
  const pt = new THREE.Vector3(...d.pt);
  particles.spark(pt);
  if (d.by === myId && performance.now() - ricSoundT > 200) { ricSoundT = performance.now(); audio.at('ricochet', pt, 0.5, 1.3); }
});
socket.on('kill', d => {
  const pl = planes.get(d.target);
  if (pl) {
    if (d.crash) pl.crashed = true;
    if (d.target === myId) samLock = 0;
    startFalling(pl);
    if (!d.crash) { particles.explosion(pl.pos, 0.8); audio.at('hit', pl.pos, 0.9, 0.8); }
    if (d.target === myId) { myDeathAt = performance.now(); shake = 1; audio.engineOff(); zoom = false; specId = d.by !== myId ? d.by : null; resetLock(); lockedBy.clear(); }
    if (lock.id === d.target) { lock.id = null; lock.t = 0; lock.locked = false; }
  }
  const verb = d.sam ? 'сбит ПВО' : d.crash ? (d.by === d.target ? 'разбился' : 'загнал в землю') : '';
  if (d.by === d.target) feed(`<b style="color:${nameCol(d.target)}">${nameOf(d.target)}</b><span class="x">${verb || '✕'}</span>`);
  else feed(`<b style="color:${nameCol(d.by)}">${nameOf(d.by)}</b><span class="x">${verb || '✕'}</span><b style="color:${nameCol(d.target)}">${nameOf(d.target)}</b>`);
  if (d.by === myId && d.target !== myId) centerMsg('СБИТ', nameOf(d.target).toUpperCase(), 1500, '#ff7a68');
  if (d.target === myId) centerMsg(d.sam && d.by === myId ? 'СБИТ ПВО' : d.crash && d.by === myId ? 'ВЫ РАЗБИЛИСЬ' : 'ВАС СБИЛИ', d.by !== myId ? 'пилот ' + nameOf(d.by) : '', 2500, '#ff7a68');
});
socket.on('roundEnd', d => {
  const meP = me();
  if (d.winner === -1) centerMsg('НИЧЬЯ', `${d.scores[0]} : ${d.scores[1]}`, 4000);
  else {
    const won = meP && meP.team === d.winner;
    centerMsg(won ? 'РАУНД ВЫИГРАН' : 'РАУНД ПРОИГРАН', `АЛЬФА ${d.scores[0]} : ${d.scores[1]} БРАВО`, 4000, won ? '#b6d35f' : '#ff7a68');
    if (won && !d.matchOver) audio.play('energy', 0.6);
  }
});
socket.on('matchEnd', d => {
  const meP = me();
  let won, title, sub;
  if (d.mode === 'team') {
    won = meP && meP.team === d.winner;
    title = won ? 'ПОБЕДА' : 'ПОРАЖЕНИЕ';
    sub = (d.winner === 0 ? 'АЛЬФА' : 'БРАВО') + ' побеждает · ' + room.scores[0] + ' : ' + room.scores[1];
  } else { won = d.winner === myId; title = won ? 'ПОБЕДА' : 'ПОРАЖЕНИЕ'; sub = nameOf(d.winner) + ' — лучший ас'; }
  if (won) audio.play('victory', 0.9);
  setTimeout(() => showResult(title, sub, won), 1200);
});
function showResult(title, sub, won) {
  document.exitPointerLock && document.exitPointerLock();
  $('resTitle').textContent = title; $('resTitle').style.color = won ? 'var(--acc)' : '#e0503f';
  $('resSub').textContent = sub;
  const head = '<tr><th>ПИЛОТ</th><th class="n">СБИТО</th><th class="n">УРОН</th><th class="n">СМЕРТИ</th></tr>';
  const rows = [...room.players].sort((a, b) => b.kills - a.kills || b.dmg - a.dmg).map(p => `<tr class="${p.id === myId ? 'me' : ''}"><td style="text-align:left">${esc(p.name)}${room.mode === 'team' ? ` <span style="color:${p.team ? 'var(--b)' : 'var(--a)'};font-size:9px">${p.team ? 'БРАВО' : 'АЛЬФА'}</span>` : ''}</td><td class="n">${p.kills}</td><td class="n">${p.dmg}</td><td class="n">${p.deaths}</td></tr>`).join('');
  $('resTable').innerHTML = `<table>${head}${rows}</table>`;
  $('resAgain').style.display = $('resLobby').style.display = isHost() ? '' : 'none';
  $('resWait').textContent = isHost() ? '' : 'Ожидание хоста…';
  showScreen('result');
}
socket.on('lobby', () => { leaveGame(); showScreen('lobby'); renderLobby(); });
socket.on('crate', d => {
  if (!world) return;
  const c = world.crates[d.i]; if (!c) return;
  c.avail = d.avail;
  if (!d.avail) {
    const p = room.players.find(q => q.id === d.by); if (p) p.hp = d.hp;
    const t = planes.get(d.by); if (t) { t.hp = d.hp; particles.heal(t.pos); }
    if (d.by === myId) { audio.play('energy', 0.7); ammo.n = MISSILE_MAX; ammo.reload = 0; flares = FLARES_MAX; centerMsg('+35 РЕМОНТ · РАКЕТЫ', '', 1100, '#9bff7a'); }
    else audio.at('energy', new THREE.Vector3(c.x, c.y, c.z), 0.5);
  }
});
socket.on('left', d => { if (inGame) feed(`<span style="color:var(--dim)">${esc(d.name)} вышел</span>`); });
socket.on('chat', d => {
  const el = document.createElement('div');
  el.innerHTML = `<b style="color:${room && room.mode === 'team' ? (d.team ? '#7fa6c9' : '#a9b86a') : 'var(--acc)'}">${esc(d.name)}:</b> ${esc(d.text)}`;
  $('chatlog').appendChild(el);
  while ($('chatlog').children.length > 6) $('chatlog').firstChild.remove();
  setTimeout(() => { el.style.opacity = 0; setTimeout(() => el.remove(), 1000); }, 9000);
});
socket.on('disconnect', () => { if (myId) centerMsg('СОЕДИНЕНИЕ ПОТЕРЯНО', 'Обновите страницу, чтобы вернуться', 99999, '#ff7a68'); });

function enterGame() {
  if (inGame) return;
  inGame = true;
  showScreen(null);
  $('ui').classList.add('on');
  if (isTouch) $('touch').classList.add('on');
  audio.setMusicVol(0.12);
  lockPointer();
}
function leaveGame() {
  inGame = false;
  $('ui').classList.remove('on'); $('touch').classList.remove('on'); $('warn').style.display = 'none';
  for (const id of [...planes.keys()]) removePlane(id);
  for (const b of bullets) b.m.visible = false; bullets.length = 0;
  clearMissiles();
  audio.engineOff(); audio.setMusicVol(0.35);
  document.exitPointerLock && document.exitPointerLock();
}

// ═══════════ MAIN LOOP ═══════════
let last = performance.now(), menuAngle = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  if (inGame && world) {
    for (const t of planes.values()) if (!t.isMe) updateRemote(t, dt, now);
    updateMe(dt, now);
    for (const t of planes.values()) {
      if (!t.vis.g.visible) continue;
      if (t.falling) {
        // shot down: tumble out of the sky trailing fire
        const f = t.falling;
        f.vel.y -= 30 * dt; f.vel.multiplyScalar(Math.exp(-0.15 * dt));
        t.pos.addScaledVector(f.vel, dt);
        t.b += f.spin * dt; t.p = Math.max(-1.2, t.p - 0.5 * dt);
        t.smokeT -= dt;
        if (t.smokeT <= 0) { t.smokeT = 0.03; particles.smoke(t.pos, true); particles.fire(t.pos); }
        if (t.pos.y < H(t.pos.x, t.pos.z) + 1) crashFx(t);
      } else if (!t.alive) {
        if (t.burnT > 0) {
          t.burnT -= dt; t.smokeT -= dt;
          if (t.smokeT <= 0) { t.smokeT = 0.15; particles.smoke(_v1.copy(t.pos).setY(t.pos.y + 2), true); if (Math.random() < .5) particles.fire(t.pos); }
        }
      } else if (t.hp < 50) {
        // damaged: smoke trail, fire when critical
        t.smokeT -= dt;
        if (t.smokeT <= 0) { t.smokeT = t.hp < 25 ? 0.035 : 0.07; const tail = _v1.set(0, 0.3, 3.5).applyMatrix4(t.vis.g.matrixWorld); particles.smoke(tail, t.hp < 25); if (t.hp < 25) particles.fire(tail); }
      }
      updatePlaneVis(t, dt);
    }
    updateCamera(dt, now);
    updateBullets(dt);
    updateSams(dt);
    updateMissiles(dt);
    for (const c of world.crates) { c.mesh.visible = c.avail; c.mesh.rotation.y += dt * 0.6; }
    updateMarkers(dt);
    flushDamage(now);
    updateTopBar(); updateBottom(); updateAmmoHud(); drawMinimap();
  } else {
    menuAngle += dt * 0.04;
    if (!world) { buildWorld(12345); worldSeed = null; }
    camera.position.set(Math.sin(menuAngle) * 520, 260, Math.cos(menuAngle) * 520);
    camera.lookAt(0, 40, 0);
    sun.position.set(SUN_DIR.x * 400, SUN_DIR.y * 400, SUN_DIR.z * 400); sun.target.position.set(0, 0, 0);
  }
  particles.update(dt);
  drawHud(now, dt);
  renderer.render(scene, camera);
}
requestAnimationFrame(frame);
