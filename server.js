// ═══════════════════════════════════════════════════════
//  SKY FRONT — 3D browser warplane battle
//  Express + Socket.io: 6-digit rooms, lobby, rounds, damage authority
// ═══════════════════════════════════════════════════════
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' }, pingInterval: 10000, pingTimeout: 30000 });

app.use(express.static(path.join(__dirname, 'public')));
app.use('/vendor/three', express.static(path.join(__dirname, 'node_modules/three/build')));

const PORT = process.env.PORT || 3000;

// ── game constants (keep in sync with client) ──
const MAX_PLAYERS = 10;
const MAX_HP = 100;
const MAP_HALF = 4500;
const ROUNDS_TO_WIN = 3;        // team battle: first to 3 rounds
const FFA_KILLS_TO_WIN = 10;    // free-for-all: first to 10 kills
const FFA_TIME = 8 * 60;        // seconds
const FFA_RESPAWN = 5;          // seconds
const CRATE_COUNT = 22;
const CRATE_RESPAWN = 25;       // seconds
const CRATE_HEAL = 35;

const rooms = new Map();        // code -> room

function newCode() {
  let c;
  do { c = String(Math.floor(100000 + Math.random() * 900000)); } while (rooms.has(c));
  return c;
}

function cleanName(n) {
  n = String(n || '').replace(/[<>]/g, '').trim().slice(0, 14);
  return n || 'Пилот' + Math.floor(Math.random() * 90 + 10);
}

function publicRoom(r) {
  return {
    code: r.code, hostId: r.hostId, state: r.state, mode: r.mode, seed: r.seed,
    round: r.round, scores: r.scores, endsAt: r.endsAt,
    timeLeft: r.endsAt && (r.state === 'playing' || r.state === 'between') ? Math.max(0, r.endsAt - Date.now()) : null,
    players: [...r.players.values()].map(p => ({
      id: p.id, name: p.name, team: p.team, hp: p.hp, alive: p.alive,
      kills: p.kills, deaths: p.deaths, dmg: p.dmg
    })),
    crates: r.crates.map(c => c.avail)
  };
}
function broadcastRoom(r) { io.to(r.code).emit('room', publicRoom(r)); }

function teamCount(r, t) { let n = 0; for (const p of r.players.values()) if (p.team === t) n++; return n; }

function spawnFor(r, p, idx, total) {
  if (r.mode === 'team') {
    // formation: wedge behind the leader, altitude staggered
    const side = p.team === 0 ? 1 : -1;
    const row = Math.floor((idx + 1) / 2), dir = idx % 2 ? 1 : -1;
    const x = dir * row * 40, z = side * (900 + row * 24);
    return { x, y: 190 + row * 12, z, yaw: side > 0 ? Math.PI : 0 };
  }
  // FFA: random point on a big ring, facing centre
  const a = Math.random() * Math.PI * 2;
  const rad = 600 + Math.random() * 300;
  const x = Math.cos(a) * rad, z = Math.sin(a) * rad;
  return { x, y: 170 + Math.random() * 80, z, yaw: Math.atan2(-x, -z) };
}

function startRound(r) {
  clearTimeout(r.timer);
  r.state = 'playing';
  r.round++;
  r.crates.forEach(c => { c.avail = true; clearTimeout(c.t); });
  const spawns = {};
  const byTeam = [[], []];
  for (const p of r.players.values()) {
    p.hp = MAX_HP; p.alive = true; p.lastHitBy = null;
    if (r.mode === 'team') byTeam[p.team].push(p);
  }
  if (r.mode === 'team') {
    for (const t of [0, 1]) byTeam[t].forEach((p, i) => { spawns[p.id] = spawnFor(r, p, i, byTeam[t].length); });
  } else {
    for (const p of r.players.values()) spawns[p.id] = spawnFor(r, p, 0, 1);
  }
  r.roundStartAt = Date.now() + 3000;
  broadcastRoom(r);
  io.to(r.code).emit('roundStart', { round: r.round, spawns, startAt: 3000 });
}

function startMatch(r) {
  r.round = 0;
  r.scores = [0, 0];
  r.seed = Math.floor(Math.random() * 1e9);
  for (const p of r.players.values()) { p.kills = 0; p.deaths = 0; p.dmg = 0; }
  r.endsAt = r.mode === 'ffa' ? Date.now() + 3000 + FFA_TIME * 1000 : null;
  if (r.mode === 'ffa') {
    clearTimeout(r.ffaTimer);
    r.ffaTimer = setTimeout(() => endMatch(r), 3000 + FFA_TIME * 1000);
  }
  startRound(r);
}

function endMatch(r) {
  if (r.state !== 'playing' && r.state !== 'between') return;
  clearTimeout(r.timer); clearTimeout(r.ffaTimer);
  r.state = 'ended';
  let winner;
  if (r.mode === 'team') winner = r.scores[0] > r.scores[1] ? 0 : 1;
  else {
    const best = [...r.players.values()].sort((a, b) => b.kills - a.kills || b.dmg - a.dmg)[0];
    winner = best ? best.id : null;
  }
  io.to(r.code).emit('matchEnd', { winner, mode: r.mode });
  broadcastRoom(r);
}

function checkRoundEnd(r) {
  if (r.mode !== 'team' || r.state !== 'playing') return;
  const alive = [0, 0], present = [0, 0];
  for (const p of r.players.values()) { present[p.team]++; if (p.alive) alive[p.team]++; }
  // practice: only one side present -> never ends
  if (present[0] === 0 || present[1] === 0) return;
  let winTeam = null;
  if (alive[0] === 0 && alive[1] === 0) winTeam = -1;
  else if (alive[0] === 0) winTeam = 1;
  else if (alive[1] === 0) winTeam = 0;
  if (winTeam === null) return;
  if (winTeam >= 0) r.scores[winTeam]++;
  r.state = 'between';
  const matchOver = r.scores[0] >= ROUNDS_TO_WIN || r.scores[1] >= ROUNDS_TO_WIN;
  io.to(r.code).emit('roundEnd', { winner: winTeam, scores: r.scores, matchOver });
  broadcastRoom(r);
  r.timer = setTimeout(() => matchOver ? endMatch(r) : startRound(r), 4500);
}

function rebalance(r) {
  // keep teams within one of each other when someone leaves/joins in lobby
  const a = teamCount(r, 0), b = teamCount(r, 1);
  if (Math.abs(a - b) <= 1) return;
  const from = a > b ? 0 : 1;
  const mover = [...r.players.values()].reverse().find(p => p.team === from);
  if (mover) mover.team = 1 - from;
}

io.on('connection', socket => {
  let room = null;

  function attach(r, name) {
    room = r;
    socket.join(r.code);
    const team = teamCount(r, 0) <= teamCount(r, 1) ? 0 : 1;
    r.players.set(socket.id, {
      id: socket.id, name: cleanName(name), team, hp: MAX_HP,
      alive: false, kills: 0, deaths: 0, dmg: 0
    });
  }

  socket.on('create', (d, cb) => {
    if (room) return cb && cb({ ok: false, err: 'Вы уже в комнате' });
    const code = newCode();
    const r = {
      code, hostId: socket.id, players: new Map(), state: 'lobby', mode: 'team',
      seed: Math.floor(Math.random() * 1e9), round: 0, scores: [0, 0], endsAt: null,
      crates: Array.from({ length: CRATE_COUNT }, () => ({ avail: true, t: null }))
    };
    rooms.set(code, r);
    attach(r, d && d.name);
    cb && cb({ ok: true, code, id: socket.id });
    broadcastRoom(r);
  });

  socket.on('join', (d, cb) => {
    const code = String((d && d.code) || '').replace(/\D/g, '');
    const r = rooms.get(code);
    if (!r) return cb && cb({ ok: false, err: 'Нет игры с кодом ' + code });
    if (r.players.size >= MAX_PLAYERS) return cb && cb({ ok: false, err: 'Комната заполнена' });
    if (room) return cb && cb({ ok: false, err: 'Вы уже в комнате' });
    attach(r, d && d.name);
    cb && cb({ ok: true, code, id: socket.id });
    broadcastRoom(r);
    // late joiner during a match: spectate until next round (team) / spawn now (ffa)
    if (r.state === 'playing' || r.state === 'between') {
      socket.emit('lateJoin', { round: r.round });
      if (r.mode === 'ffa' && r.state === 'playing') {
        const p = r.players.get(socket.id);
        setTimeout(() => respawn(r, p), 1500);
      }
    }
  });

  function respawn(r, p) {
    if (!r.players.has(p.id) || r.state !== 'playing') return;
    p.hp = MAX_HP; p.alive = true; p.lastHitBy = null;
    io.to(r.code).emit('respawn', { id: p.id, spawn: spawnFor(r, p, 0, 1), hp: p.hp });
  }

  socket.on('setMode', m => {
    if (!room || room.hostId !== socket.id || room.state === 'playing') return;
    room.mode = m === 'ffa' ? 'ffa' : 'team';
    broadcastRoom(room);
  });

  socket.on('setTeam', t => {
    if (!room || room.state === 'playing' || room.state === 'between') return;
    const p = room.players.get(socket.id);
    if (p) { p.team = t ? 1 : 0; broadcastRoom(room); }
  });

  socket.on('start', () => {
    if (!room || room.hostId !== socket.id) return;
    if (room.state === 'playing' || room.state === 'between') return;
    startMatch(room);
  });

  socket.on('toLobby', () => {
    if (!room || room.hostId !== socket.id) return;
    clearTimeout(room.timer); clearTimeout(room.ffaTimer);
    room.state = 'lobby';
    for (const p of room.players.values()) { p.alive = false; p.hp = MAX_HP; }
    broadcastRoom(room);
    io.to(room.code).emit('lobby');
  });

  // ── realtime: own tank state, relayed to the others ──
  socket.on('st', s => {
    if (!room) return;
    socket.to(room.code).volatile.emit('st', socket.id, s);
  });

  // missiles: shooter simulates & reports hits; others get visuals
  socket.on('missile', m => {
    if (!room || !m) return;
    const p = room.players.get(socket.id);
    const now = Date.now();
    if (!p || !p.alive || now - (p.lastMissile || 0) < 400) return;
    p.lastMissile = now;
    socket.to(room.code).emit('missile', socket.id, m);
  });
  socket.on('mboom', m => { if (room && m) socket.to(room.code).emit('mboom', socket.id, m); });
  socket.on('flare', () => {
    if (!room) return;
    const p = room.players.get(socket.id);
    if (p && p.alive) io.to(room.code).emit('flare', socket.id);
  });
  socket.on('lock', l => { if (room && l) socket.to(room.code).emit('lock', socket.id, l); });

  socket.on('fire', f => {
    if (!room) return;
    const p = room.players.get(socket.id);
    if (!p || !p.alive) return;
    socket.to(room.code).emit('fire', socket.id, f);
  });

  // shooter reports a hit; server owns hp
  socket.on('hit', h => {
    if (!room || room.state !== 'playing' || !h) return;
    const shooter = room.players.get(socket.id);
    const target = room.players.get(h.target);
    if (!shooter || !target || !target.alive) return;
    if (Date.now() < room.roundStartAt) return;
    const pt = Array.isArray(h.pt) ? h.pt.slice(0, 3).map(Number) : [0, 0, 0];
    if (h.ric) { io.to(room.code).emit('ric', { target: target.id, by: shooter.id, pt }); return; }
    if (room.mode === 'team' && shooter.team === target.team) return; // no friendly fire
    // guns: max 15 per bullet; missiles: max 50, at most one missile hit per 0.3 s per shooter
    let cap = 15;
    if (h.m) {
      const now = Date.now();
      if (now - (shooter.lastMissileHit || 0) < 300) return;
      shooter.lastMissileHit = now; cap = 50;
    }
    const dmg = Math.max(1, Math.min(cap, Math.round(Number(h.dmg) || 0)));
    const real = Math.min(dmg, target.hp);
    target.hp -= real;
    shooter.dmg += real;
    target.lastHitBy = shooter.id; target.lastHitAt = Date.now();
    io.to(room.code).emit('dmg', { target: target.id, by: shooter.id, dmg: real, hp: target.hp, pt, zone: h.zone });
    if (target.hp <= 0) killPlayer(room, target, shooter, false);
  });

  function killPlayer(r, target, shooter, crash, sam) {
    target.alive = false;
    target.hp = 0;
    target.deaths++;
    if (shooter.id !== target.id) shooter.kills++;
    io.to(r.code).emit('kill', { target: target.id, by: shooter.id, crash, sam: !!sam });
    broadcastRoom(r);
    if (r.mode === 'ffa') {
      if (shooter.kills >= FFA_KILLS_TO_WIN) return setTimeout(() => endMatch(r), 1500);
      setTimeout(() => respawn(r, target), FFA_RESPAWN * 1000);
    } else checkRoundEnd(r);
  }

  // flew into the ground: last attacker (within 12 s) gets the kill
  socket.on('crash', () => {
    if (!room || room.state !== 'playing') return;
    const p = room.players.get(socket.id);
    if (!p || !p.alive) return;
    const att = p.lastHitBy && Date.now() - p.lastHitAt < 12000 && room.players.get(p.lastHitBy);
    killPlayer(room, p, att || p, true);
  });

  // hit by a ground SAM site (the victim's client simulates SAMs aimed at itself)
  socket.on('samhit', h => {
    if (!room || room.state !== 'playing' || !h) return;
    const p = room.players.get(socket.id);
    if (!p || !p.alive || Date.now() < room.roundStartAt) return;
    const now = Date.now();
    if (now - (p.lastSamHit || 0) < 300) return;
    p.lastSamHit = now;
    const pt = Array.isArray(h.pt) ? h.pt.slice(0, 3).map(Number) : [0, 0, 0];
    const real = Math.min(40, p.hp);
    p.hp -= real;
    io.to(room.code).emit('dmg', { target: p.id, by: p.id, dmg: real, hp: p.hp, pt, zone: 'sam' });
    if (p.hp <= 0) {
      const att = p.lastHitBy && now - p.lastHitAt < 12000 && room.players.get(p.lastHitBy);
      killPlayer(room, p, att || p, false, true);
    }
  });

  socket.on('pickup', i => {
    if (!room || room.state !== 'playing') return;
    const c = room.crates[i | 0];
    const p = room.players.get(socket.id);
    if (!c || !c.avail || !p || !p.alive) return;
    c.avail = false;
    p.hp = Math.min(MAX_HP, p.hp + CRATE_HEAL);
    io.to(room.code).emit('crate', { i: i | 0, avail: false, by: p.id, hp: p.hp });
    const r = room;
    c.t = setTimeout(() => { c.avail = true; io.to(r.code).emit('crate', { i: i | 0, avail: true }); }, CRATE_RESPAWN * 1000);
  });

  socket.on('chat', t => {
    if (!room) return;
    const p = room.players.get(socket.id);
    t = String(t || '').replace(/[<>]/g, '').slice(0, 80);
    if (p && t) io.to(room.code).emit('chat', { name: p.name, team: p.team, text: t });
  });

  socket.on('disconnect', () => {
    if (!room) return;
    const r = room;
    const p = r.players.get(socket.id);
    r.players.delete(socket.id);
    if (r.players.size === 0) {
      clearTimeout(r.timer); clearTimeout(r.ffaTimer);
      r.crates.forEach(c => clearTimeout(c.t));
      rooms.delete(r.code);
      return;
    }
    if (r.hostId === socket.id) r.hostId = r.players.keys().next().value;
    if (r.state === 'lobby') rebalance(r);
    io.to(r.code).emit('left', { id: socket.id, name: p ? p.name : '' });
    broadcastRoom(r);
    checkRoundEnd(r);
  });
});

server.listen(PORT, () => console.log('SKY FRONT running on http://localhost:' + PORT));
