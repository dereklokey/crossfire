const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');

const BOARD = {
  width: 1200,
  height: 700,
  goalLeftX: 130,
  goalRightX: 1070,
  top: 60,
  bottom: 640,
};

const AMMO_SPEED = 760;
const AMMO_RADIUS = 4;
const PIECE_BASE_RADIUS = 24;
const MAG_CAPACITY = 20;
const TOTAL_AMMO = 50;
const START_MAG = 20;
const START_BIN_EACH = Math.floor((TOTAL_AMMO - START_MAG * 2) / 2);
const RELOAD_MS = 700;
const ROOM_TIMEOUT_MS = 1000 * 60 * 30;
const INPUT_STALE_MS = 1000;
const CHAT_MAX_MESSAGES = 120;
const CHAT_MAX_CHARS = 240;
const PRESENCE_ACTIVE_MS = 30000;

const rooms = new Map();

function uid(len = 8) {
  return crypto.randomBytes(len).toString('hex');
}

function securityHeaders() {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com data:",
      "img-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'",
      "base-uri 'self'",
    ].join('; '),
  };
}

function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    ...securityHeaders(),
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function badRequest(res, message) {
  json(res, 400, { error: message });
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        reject(new Error('Body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function angleWrap(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function normalizeAimAngle(side, angle) {
  if (!Number.isFinite(angle)) return angle;
  const anchor = side === 0 ? 0 : Math.PI;
  const candidates = [angle, angle + Math.PI * 2, angle - Math.PI * 2];
  let best = candidates[0];
  let bestDist = Infinity;
  for (const c of candidates) {
    const dist = Math.abs(c - anchor);
    if (dist < bestDist) {
      best = c;
      bestDist = dist;
    }
  }
  return best;
}

function defaultPlayer(side) {
  return {
    side,
    gunAngle: side === 0 ? 0 : Math.PI,
    mag: START_MAG,
    bin: START_BIN_EACH,
    reloading: false,
    reloadUntil: 0,
    controls: {
      aimDir: 0,
      shooting: false,
      reloadPressed: false,
      desiredAngle: null,
    },
    shootCooldown: 0,
    token: uid(12),
    connected: false,
    lastSeenAt: 0,
    lastInputAt: 0,
    isAI: false,
    score: 0,
    lastShotAt: 0,
    ready: false,
  };
}

function makePiece(idx, total) {
  const shapes = ['circle', 'triangle', 'square', 'hex', 'star6', 'star8'];
  const laneTop = BOARD.top + 70;
  const laneBottom = BOARD.bottom - 70;
  const t = total <= 1 ? 0.5 : idx / (total - 1);
  return {
    id: uid(6),
    kind: 'piece',
    shape: shapes[idx % shapes.length],
    x: BOARD.width / 2,
    y: laneTop + (laneBottom - laneTop) * t,
    vx: 0,
    vy: 0,
    radius: PIECE_BASE_RADIUS + ((idx % 2) ? 4 : 0),
    mass: 8 + (idx % 3),
    spin: 0,
    angle: 0,
    scoredBy: null,
  };
}

function createPieces(pieceCount) {
  return Array.from({ length: pieceCount }, (_, i) => makePiece(i, pieceCount));
}

function addRoomMessage(room, sender, text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return;
  room.chat.push({
    id: uid(6),
    sender,
    text: clean.slice(0, CHAT_MAX_CHARS),
    ts: Date.now(),
  });
  if (room.chat.length > CHAT_MAX_MESSAGES) {
    room.chat.splice(0, room.chat.length - CHAT_MAX_MESSAGES);
  }
}

function resetPlayerForMatch(player) {
  player.gunAngle = player.side === 0 ? 0 : Math.PI;
  player.mag = START_MAG;
  player.bin = START_BIN_EACH;
  player.reloading = false;
  player.reloadUntil = 0;
  player.controls.aimDir = 0;
  player.controls.shooting = false;
  player.controls.reloadPressed = false;
  player.controls.desiredAngle = null;
  player.score = 0;
  player.lastShotAt = 0;
  player.ready = false;
}

function resetMatch(room, toLobby = false) {
  room.projectiles = [];
  room.pieces = createPieces(room.pieceCount);
  room.winner = null;
  room.players.forEach(resetPlayerForMatch);
  room.warmupAi = false;
  room.startedAt = Date.now();
  room.runStartedAt = 0;
  room.lastTickAt = Date.now();
  room.state = toLobby ? 'lobby' : 'countdown';
  room.resultAnnounced = false;
  addRoomMessage(room, 'System', 'Match reset.');
}

function startWarmupAiRound(room, announce = false) {
  room.projectiles = [];
  room.pieces = createPieces(room.pieceCount);
  room.winner = null;
  room.players.forEach(resetPlayerForMatch);
  room.players[1].isAI = true;
  room.players[1].connected = false;
  room.players[1].lastSeenAt = 0;
  room.players[1].lastInputAt = 0;
  room.players[1].ready = false;
  room.warmupAi = true;
  room.startedAt = Date.now();
  room.runStartedAt = Date.now();
  room.lastTickAt = Date.now();
  room.state = 'running';
  room.resultAnnounced = false;
  if (announce) {
    addRoomMessage(room, 'System', 'Warmup vs AI started while waiting for Player 2.');
  }
}

function createRoom({ mode, pieceSetting, aiDifficulty }) {
  let pieceCount;
  if (pieceSetting === 'random') {
    const options = [3, 5, 7];
    pieceCount = options[Math.floor(Math.random() * options.length)];
  } else {
    pieceCount = [3, 5, 7].includes(pieceSetting) ? pieceSetting : 5;
  }

  const roomId = uid(5);
  const players = [defaultPlayer(0), defaultPlayer(1)];
  players[0].connected = true;
  players[0].lastSeenAt = Date.now();

  if (mode === 'single') {
    players[1].connected = true;
    players[1].isAI = true;
    players[1].ready = true;
    players[1].lastSeenAt = Date.now();
  }

  const room = {
    id: roomId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    mode: mode === 'single' ? 'single' : 'network',
    aiDifficulty: ['easy', 'medium', 'hard'].includes(aiDifficulty) ? aiDifficulty : 'medium',
    pieceSetting,
    pieceCount,
    piecesNeeded: Math.floor(pieceCount / 2) + 1,
    state: 'lobby',
    startedAt: Date.now(),
    countdownMs: 5000,
    players,
    projectiles: [],
    pieces: createPieces(pieceCount),
    winner: null,
    runStartedAt: 0,
    lastTickAt: Date.now(),
    resultAnnounced: false,
    warmupAi: false,
    chat: [],
  };

  addRoomMessage(
    room,
    'System',
    mode === 'single'
      ? 'Single-player room created.'
      : 'Multiplayer room created. Press Practice to warm up vs AI while waiting for Player 2.'
  );

  rooms.set(roomId, room);
  return room;
}

function verifyPlayer(room, token) {
  if (!token) return null;
  return room.players.find((p) => p.token === token) || null;
}

function getAimBounds(side) {
  if (side === 0) return { min: -1.2, max: 1.2 };
  return { min: Math.PI - 1.2, max: Math.PI + 1.2 };
}

function gunPosition(side) {
  return {
    x: side === 0 ? 60 : BOARD.width - 60,
    y: BOARD.height / 2,
  };
}

function requestReload(player, now) {
  if (player.reloading) return;
  if (player.mag >= MAG_CAPACITY) return;
  if (player.bin <= 0) return;
  player.reloading = true;
  player.reloadUntil = now + RELOAD_MS;
}

function finishReload(player) {
  if (!player.reloading) return;
  const needed = MAG_CAPACITY - player.mag;
  if (needed <= 0) {
    player.reloading = false;
    return;
  }
  const moved = Math.min(needed, player.bin);
  player.bin -= moved;
  player.mag += moved;
  player.reloading = false;
}

function spawnProjectile(room, player, now) {
  if (player.mag <= 0) return;
  if (player.reloading) return;
  if (now - player.lastShotAt < 120) return;

  const gp = gunPosition(player.side);
  const dirX = Math.cos(player.gunAngle);
  const dirY = Math.sin(player.gunAngle);

  const shot = {
    id: uid(5),
    owner: player.side,
    x: gp.x + dirX * 26,
    y: gp.y + dirY * 26,
    vx: dirX * AMMO_SPEED,
    vy: dirY * AMMO_SPEED,
    radius: AMMO_RADIUS,
    ttl: 10000,
  };

  room.projectiles.push(shot);
  player.mag -= 1;
  player.lastShotAt = now;
}

function collideWithBounds(obj, restitution = 0.72) {
  if (obj.y - obj.radius < BOARD.top) {
    obj.y = BOARD.top + obj.radius;
    obj.vy = Math.abs(obj.vy) * restitution;
  }
  if (obj.y + obj.radius > BOARD.bottom) {
    obj.y = BOARD.bottom - obj.radius;
    obj.vy = -Math.abs(obj.vy) * restitution;
  }
}

function resolvePiecePiece(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const distSq = dx * dx + dy * dy;
  const minDist = a.radius + b.radius;
  if (distSq === 0 || distSq > minDist * minDist) return;

  const dist = Math.sqrt(distSq);
  const nx = dx / dist;
  const ny = dy / dist;
  const overlap = minDist - dist;

  a.x -= nx * (overlap / 2);
  a.y -= ny * (overlap / 2);
  b.x += nx * (overlap / 2);
  b.y += ny * (overlap / 2);

  const rvx = b.vx - a.vx;
  const rvy = b.vy - a.vy;
  const velAlongNormal = rvx * nx + rvy * ny;
  if (velAlongNormal > 0) return;

  const restitution = 0.35;
  const impulse = (-(1 + restitution) * velAlongNormal) / ((1 / a.mass) + (1 / b.mass));
  const ix = impulse * nx;
  const iy = impulse * ny;

  a.vx -= ix / a.mass;
  a.vy -= iy / a.mass;
  b.vx += ix / b.mass;
  b.vy += iy / b.mass;

  a.spin += (ny * ix - nx * iy) * 0.0006;
  b.spin -= (ny * ix - nx * iy) * 0.0006;
}

function projectileHitsPiece(shot, piece) {
  const dx = piece.x - shot.x;
  const dy = piece.y - shot.y;
  const distSq = dx * dx + dy * dy;
  const minDist = piece.radius + shot.radius;
  if (distSq > minDist * minDist || distSq === 0) return false;

  const dist = Math.sqrt(distSq);
  const nx = dx / dist;
  const ny = dy / dist;

  const relVel = shot.vx * nx + shot.vy * ny;
  if (relVel <= 0) return false;

  const tangentX = -ny;
  const tangentY = nx;
  // Measure off-center impact from shot travel direction against piece center.
  const shotSpeed = Math.hypot(shot.vx, shot.vy) || 1;
  const dirX = shot.vx / shotSpeed;
  const dirY = shot.vy / shotSpeed;
  const lineNormalX = -dirY;
  const lineNormalY = dirX;
  const centerFromShotX = piece.x - shot.x;
  const centerFromShotY = piece.y - shot.y;
  const hitOffset = Math.abs(centerFromShotX * lineNormalX + centerFromShotY * lineNormalY);
  const centerFactor = clamp(1 - hitOffset / piece.radius, 0, 1);

  // Heavy pieces mostly respond to center-mass shots.
  const linearTransfer = 0.15 + centerFactor * centerFactor * 0.95;
  const shotMass = 1;
  const impulse = relVel * shotMass * linearTransfer;

  piece.vx += (nx * impulse) / piece.mass;
  piece.vy += (ny * impulse) / piece.mass;

  const tangential = shot.vx * tangentX + shot.vy * tangentY;
  piece.spin += (tangential / piece.mass) * (1 - centerFactor) * 0.05;

  // Reflect and damp the ammo pellet so ammo can keep circulating.
  const bounce = 0.35;
  const vnX = nx * relVel;
  const vnY = ny * relVel;
  shot.vx = (shot.vx - 2 * vnX) * bounce + piece.vx * 0.05;
  shot.vy = (shot.vy - 2 * vnY) * bounce + piece.vy * 0.05;

  shot.x -= nx * 2;
  shot.y -= ny * 2;
  return true;
}

function scoreIfGoal(room, piece) {
  if (piece.scoredBy !== null) return;

  if (piece.x - piece.radius <= BOARD.goalLeftX) {
    piece.scoredBy = 1;
    room.players[1].score += 1;
  }

  if (piece.x + piece.radius >= BOARD.goalRightX) {
    piece.scoredBy = 0;
    room.players[0].score += 1;
  }
}

function collectAmmoIfGoal(room, shot, prevX) {
  // Collect when a pellet crosses from the field into either endzone.
  // Left goal belongs to player 0, right goal belongs to player 1.
  if (prevX > BOARD.goalLeftX && shot.x <= BOARD.goalLeftX) {
    room.players[0].bin += 1;
    return true;
  }
  if (prevX < BOARD.goalRightX && shot.x >= BOARD.goalRightX) {
    room.players[1].bin += 1;
    return true;
  }
  return false;
}

function aiStep(room, player, dtSec, now) {
  const diff = room.aiDifficulty;
  const config = {
    easy: { aimSpeed: 1.8, shootDelay: 360, jitter: 0.12, reloadAt: 4 },
    medium: { aimSpeed: 3.2, shootDelay: 220, jitter: 0.07, reloadAt: 6 },
    hard: { aimSpeed: 4.8, shootDelay: 140, jitter: 0.03, reloadAt: 9 },
  }[diff];

  const activePieces = room.pieces.filter((p) => p.scoredBy === null);
  if (!activePieces.length) return;

  let target = activePieces[0];
  let best = Infinity;
  for (const p of activePieces) {
    // AI prioritizes pieces that are currently scoreable toward opponent goal.
    const scoreBias = player.side === 0 ? (BOARD.goalRightX - p.x) : (p.x - BOARD.goalLeftX);
    const dy = Math.abs(p.y - BOARD.height / 2);
    const v = scoreBias + dy * 0.8;
    if (v < best) {
      best = v;
      target = p;
    }
  }

  const gp = gunPosition(player.side);
  const desired = Math.atan2(target.y - gp.y, target.x - gp.x) + ((Math.random() - 0.5) * config.jitter);
  const bounds = getAimBounds(player.side);
  const clampedDesired = clamp(normalizeAimAngle(player.side, desired), bounds.min, bounds.max);
  const delta = angleWrap(clampedDesired - player.gunAngle);
  player.gunAngle += clamp(delta, -config.aimSpeed * dtSec, config.aimSpeed * dtSec);

  if (player.mag <= config.reloadAt && player.bin > 0) {
    requestReload(player, now);
  }

  if (player.reloading || player.mag <= 0) return;

  const alignment = Math.abs(angleWrap(clampedDesired - player.gunAngle));
  const shootGate = diff === 'hard' ? 0.08 : diff === 'medium' ? 0.12 : 0.18;
  if (alignment < shootGate && now - player.lastShotAt > config.shootDelay) {
    spawnProjectile(room, player, now);
  }
}

function processControls(room, player, dtSec, now) {
  if (player.isAI) {
    aiStep(room, player, dtSec, now);
    return;
  }

  const controls = player.controls;
  const bounds = getAimBounds(player.side);

  if (typeof controls.desiredAngle === 'number') {
    const normalizedDesired = normalizeAimAngle(player.side, controls.desiredAngle);
    const clampedDesired = clamp(normalizedDesired, bounds.min, bounds.max);
    const delta = angleWrap(clampedDesired - player.gunAngle);
    const speed = 3.8;
    player.gunAngle += clamp(delta, -speed * dtSec, speed * dtSec);
  } else {
    const turnSpeed = 3.6;
    player.gunAngle += controls.aimDir * turnSpeed * dtSec;
  }

  player.gunAngle = clamp(player.gunAngle, bounds.min, bounds.max);

  if (controls.reloadPressed) {
    requestReload(player, now);
    controls.reloadPressed = false;
  }

  if (controls.shooting) {
    spawnProjectile(room, player, now);
  }
}

function roomSnapshot(room, forPlayer) {
  const bothConnected = room.players.every((p) => p.connected);
  const joinerConnected = room.mode === 'network' && room.players[1].connected;
  return {
    roomId: room.id,
    board: BOARD,
    mode: room.mode,
    state: room.state,
    winner: room.winner,
    pieceCount: room.pieceCount,
    piecesNeeded: room.piecesNeeded,
    countdownMs: room.state === 'countdown' ? Math.max(0, room.countdownMs - (Date.now() - room.startedAt)) : 0,
    runElapsedMs: room.state === 'running' && room.runStartedAt ? Math.max(0, Date.now() - room.runStartedAt) : 0,
    hostCanStart: forPlayer.side === 0
      && room.state === 'lobby'
      && (
        room.mode === 'single'
        || !joinerConnected
        || (bothConnected && room.players[1].ready)
      ),
    hostCanRematch: forPlayer.side === 0 && room.state === 'finished',
    joinerCanReady: room.mode === 'network' && forPlayer.side === 1 && room.state === 'lobby' && room.players[1].connected,
    warmupAi: Boolean(room.warmupAi),
    me: forPlayer.side,
    players: room.players.map((p) => ({
      side: p.side,
      mag: p.mag,
      bin: p.bin,
      reloading: p.reloading,
      reloadMs: p.reloading ? Math.max(0, p.reloadUntil - Date.now()) : 0,
      gunAngle: p.gunAngle,
      score: p.score,
      connected: p.connected,
      isAI: p.isAI,
      ready: p.ready,
    })),
    projectiles: room.projectiles.map((s) => ({
      x: s.x,
      y: s.y,
      r: s.radius,
      owner: s.owner,
      vx: s.vx,
      vy: s.vy,
    })),
    pieces: room.pieces.map((p) => ({
      id: p.id,
      x: p.x,
      y: p.y,
      r: p.radius,
      angle: p.angle,
      shape: p.shape,
      scoredBy: p.scoredBy,
    })),
    chat: room.chat,
  };
}

function tickRoom(room, now) {
  for (const player of room.players) {
    if (player.isAI) continue;
    if (player.connected && now - player.lastSeenAt > PRESENCE_ACTIVE_MS) {
      player.connected = false;
      player.ready = false;
      player.controls.shooting = false;
      player.controls.aimDir = 0;
      player.controls.desiredAngle = null;
    }
  }

  const dt = Math.min((now - room.lastTickAt) / 1000, 0.05);
  room.lastTickAt = now;

  if (room.state === 'finished') return;

  if (room.state === 'lobby') {
    return;
  }

  if (room.state === 'countdown') {
    if (now - room.startedAt >= room.countdownMs) {
      room.state = 'running';
      room.runStartedAt = now;
    }
    return;
  }

  for (const player of room.players) {
    if (player.reloading && now >= player.reloadUntil) {
      finishReload(player);
    }

    if (!player.isAI && now - player.lastInputAt > INPUT_STALE_MS) {
      player.controls.aimDir = 0;
      player.controls.shooting = false;
      player.controls.desiredAngle = null;
    }

    processControls(room, player, dt, now);
  }

  for (const piece of room.pieces) {
    if (piece.scoredBy !== null) continue;

    piece.x += piece.vx * dt;
    piece.y += piece.vy * dt;
    piece.angle += piece.spin * dt;

    piece.vx *= 0.987;
    piece.vy *= 0.987;
    piece.spin *= 0.982;

    collideWithBounds(piece, 0.5);

    if (piece.x - piece.radius < 0) {
      piece.x = piece.radius;
      piece.vx = Math.abs(piece.vx) * 0.5;
    }
    if (piece.x + piece.radius > BOARD.width) {
      piece.x = BOARD.width - piece.radius;
      piece.vx = -Math.abs(piece.vx) * 0.5;
    }

    scoreIfGoal(room, piece);
  }

  for (let i = 0; i < room.pieces.length; i++) {
    const a = room.pieces[i];
    if (a.scoredBy !== null) continue;
    for (let j = i + 1; j < room.pieces.length; j++) {
      const b = room.pieces[j];
      if (b.scoredBy !== null) continue;
      resolvePiecePiece(a, b);
    }
  }

  const keptShots = [];
  for (const shot of room.projectiles) {
    const prevX = shot.x;
    shot.x += shot.vx * dt;
    shot.y += shot.vy * dt;
    shot.ttl -= dt * 1000;

    shot.vx *= 0.999;
    shot.vy *= 0.999;

    collideWithBounds(shot, 0.85);

    // Keep pellets inside the board's horizontal extents.
    if (shot.x - shot.radius < 0) {
      shot.x = shot.radius;
      shot.vx = Math.abs(shot.vx) * 0.85;
    } else if (shot.x + shot.radius > BOARD.width) {
      shot.x = BOARD.width - shot.radius;
      shot.vx = -Math.abs(shot.vx) * 0.85;
    }

    let consumed = false;
    for (const piece of room.pieces) {
      if (piece.scoredBy !== null) continue;
      if (projectileHitsPiece(shot, piece)) break;
    }

    if (collectAmmoIfGoal(room, shot, prevX)) {
      consumed = true;
    }

    if (!consumed && shot.ttl <= 0) {
      // Keep total ammo conserved by returning stale pellets to nearest side bin.
      const side = shot.x < BOARD.width / 2 ? 0 : 1;
      room.players[side].bin += 1;
      consumed = true;
    }

    if (!consumed) {
      keptShots.push(shot);
    }
  }
  room.projectiles = keptShots;

  for (const side of [0, 1]) {
    if (room.players[side].score >= room.piecesNeeded) {
      if (room.warmupAi) {
        resetMatch(room, true);
        addRoomMessage(room, 'System', 'Practice round ended. Press Practice to start another.');
        room.updatedAt = now;
        return;
      }
      room.state = 'finished';
      room.winner = side;
    }
  }

  if (room.state === 'finished' && !room.resultAnnounced) {
    const p1 = room.players[0].score;
    const p2 = room.players[1].score;
    const winnerLabel = room.winner === 0 ? 'Player 1' : 'Player 2';
    addRoomMessage(room, 'System', `Final score: P1 ${p1} - P2 ${p2}. ${winnerLabel} wins.`);
    room.resultAnnounced = true;
  }

  room.updatedAt = now;
}

function maintenance(now) {
  for (const [id, room] of rooms.entries()) {
    tickRoom(room, now);
    if (room.mode === 'network' && !room.players[0].connected) {
      rooms.delete(id);
      continue;
    }
    if (now - room.updatedAt > ROOM_TIMEOUT_MS) {
      rooms.delete(id);
    }
  }
}

function serveStatic(req, res, pathname) {
  const safePath = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.join(PUBLIC_DIR, path.normalize(safePath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    const body = 'Forbidden';
    res.writeHead(403, {
      ...securityHeaders(),
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
    });
    res.end(body);
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      const body = 'Not found';
      res.writeHead(404, {
        ...securityHeaders(),
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
      });
      res.end(body);
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const type = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
    }[ext] || 'application/octet-stream';

    res.writeHead(200, {
      ...securityHeaders(),
      'Content-Type': type,
      'Content-Length': data.length,
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    if (req.method === 'GET' && pathname === '/api/rooms') {
      const now = Date.now();
      const openRooms = Array.from(rooms.values())
        .filter((room) => {
          if (room.mode !== 'network') return false;
          if (room.warmupAi) return true;
          if (room.state !== 'lobby') return false;
          const joinerPresent = room.players[1].connected && (now - room.players[1].lastSeenAt <= PRESENCE_ACTIVE_MS);
          return !joinerPresent;
        })
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 25)
        .map((room) => ({
          roomId: room.id,
          pieceCount: room.pieceCount,
          createdAt: room.createdAt,
        }));
      let onlinePlayers = 0;
      for (const room of rooms.values()) {
        for (const p of room.players) {
          if (p.isAI) continue;
          if (p.connected && (now - p.lastSeenAt <= PRESENCE_ACTIVE_MS)) {
            onlinePlayers += 1;
          }
        }
      }
      json(res, 200, { rooms: openRooms, onlinePlayers });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/create') {
      const body = await parseBody(req);
      const mode = body.mode === 'single' ? 'single' : 'network';
      const pieceSetting = body.pieceSetting === 'random' ? 'random' : Number(body.pieceSetting);
      const aiDifficulty = body.aiDifficulty;
      const room = createRoom({ mode, pieceSetting, aiDifficulty });
      json(res, 200, {
        roomId: room.id,
        token: room.players[0].token,
        side: 0,
        pieceCount: room.pieceCount,
        piecesNeeded: room.piecesNeeded,
      });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/join') {
      const body = await parseBody(req);
      const room = rooms.get(String(body.roomId || '').trim());
      if (!room) return badRequest(res, 'Room not found');
      if (room.mode !== 'network') return badRequest(res, 'Room is single-player');

      const p1 = room.players[1];
      if (p1.connected) return badRequest(res, 'Room already full');
      p1.connected = true;
      p1.isAI = false;
      p1.ready = false;
      p1.lastSeenAt = Date.now();
      p1.lastInputAt = Date.now();
      if (room.warmupAi) {
        resetMatch(room, true);
        room.warmupAi = false;
        addRoomMessage(room, 'System', 'Warmup ended. Lobby ready for multiplayer start.');
      }
      room.updatedAt = Date.now();
      addRoomMessage(room, 'System', 'Player 2 joined the room.');

      json(res, 200, {
        roomId: room.id,
        token: p1.token,
        side: 1,
        pieceCount: room.pieceCount,
        piecesNeeded: room.piecesNeeded,
      });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/chat') {
      const body = await parseBody(req);
      const room = rooms.get(String(body.roomId || '').trim());
      if (!room) return badRequest(res, 'Room not found');
      const player = verifyPlayer(room, body.token);
      if (!player) return badRequest(res, 'Invalid token');

      const raw = String(body.message || '');
      if (!raw.trim()) return badRequest(res, 'Message is empty');
      const sender = player.isAI ? 'AI' : `P${player.side + 1}`;
      addRoomMessage(room, sender, raw);
      room.updatedAt = Date.now();
      json(res, 200, { ok: true });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/input') {
      const body = await parseBody(req);
      const room = rooms.get(String(body.roomId || '').trim());
      if (!room) return badRequest(res, 'Room not found');
      const player = verifyPlayer(room, body.token);
      if (!player) return badRequest(res, 'Invalid token');

      const input = body.input || {};
      player.controls.aimDir = clamp(Number(input.aimDir) || 0, -1, 1);
      player.controls.shooting = Boolean(input.shooting);
      player.controls.reloadPressed = Boolean(input.reloadPressed);
      if (typeof input.desiredAngle === 'number' && Number.isFinite(input.desiredAngle)) {
        player.controls.desiredAngle = input.desiredAngle;
      } else {
        player.controls.desiredAngle = null;
      }

      player.lastInputAt = Date.now();
      player.lastSeenAt = Date.now();
      player.connected = true;
      room.updatedAt = Date.now();

      json(res, 200, { ok: true });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/ready') {
      const body = await parseBody(req);
      const room = rooms.get(String(body.roomId || '').trim());
      if (!room) return badRequest(res, 'Room not found');
      if (room.mode !== 'network') return badRequest(res, 'Ready is for multiplayer only');
      if (room.state !== 'lobby') return badRequest(res, 'Can only change ready state in lobby');
      const player = verifyPlayer(room, body.token);
      if (!player) return badRequest(res, 'Invalid token');
      if (player.side !== 1) return badRequest(res, 'Only joining player can toggle ready');

      player.ready = Boolean(body.ready);
      player.lastSeenAt = Date.now();
      player.connected = true;
      room.updatedAt = Date.now();
      json(res, 200, { ok: true, ready: player.ready });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/leave') {
      const body = await parseBody(req);
      const room = rooms.get(String(body.roomId || '').trim());
      if (!room) return badRequest(res, 'Room not found');
      const player = verifyPlayer(room, body.token);
      if (!player) return badRequest(res, 'Invalid token');
      player.lastSeenAt = Date.now();

      // Host leaving ends the room.
      if (player.side === 0) {
        rooms.delete(room.id);
        json(res, 200, { ok: true, deleted: true });
        return;
      }

      // Joiner leaving frees the room slot and clears ready state.
      player.connected = false;
      player.ready = false;
      player.controls.aimDir = 0;
      player.controls.shooting = false;
      player.controls.desiredAngle = null;

      if (room.mode === 'network' && room.players[0].connected) {
        startWarmupAiRound(room, true);
      }

      room.updatedAt = Date.now();
      addRoomMessage(room, 'System', 'Player 2 left the room.');
      json(res, 200, { ok: true, deleted: false });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/resign') {
      const body = await parseBody(req);
      const room = rooms.get(String(body.roomId || '').trim());
      if (!room) return badRequest(res, 'Room not found');
      const player = verifyPlayer(room, body.token);
      if (!player) return badRequest(res, 'Invalid token');
      player.lastSeenAt = Date.now();

      if (room.warmupAi) {
        resetMatch(room, true);
        addRoomMessage(room, 'System', 'Practice round resigned. Back to lobby.');
        room.updatedAt = Date.now();
        json(res, 200, { ok: true, winner: null });
        return;
      }

      const activeMatch = room.state === 'running' || room.state === 'countdown';
      if (!activeMatch) {
        if (room.mode === 'network' && player.side === 1) {
          player.connected = false;
          player.ready = false;
          player.controls.aimDir = 0;
          player.controls.shooting = false;
          player.controls.desiredAngle = null;
          if (room.players[0].connected) {
            startWarmupAiRound(room, true);
          }
          room.updatedAt = Date.now();
          addRoomMessage(room, 'System', 'Player 2 resigned and left the room.');
          json(res, 200, { ok: true, winner: null, left: true });
          return;
        }
        return badRequest(res, 'Can only resign during an active match');
      }

      const winner = player.side === 0 ? 1 : 0;
      room.state = 'finished';
      room.winner = winner;
      room.warmupAi = false;
      room.resultAnnounced = true;
      room.players[0].ready = false;
      room.players[1].ready = false;
      room.players[0].controls.shooting = false;
      room.players[1].controls.shooting = false;
      addRoomMessage(
        room,
        'System',
        `Player ${player.side + 1} resigned. Final score: P1 ${room.players[0].score} - P2 ${room.players[1].score}. Player ${winner + 1} wins.`
      );
      room.updatedAt = Date.now();
      json(res, 200, { ok: true, winner });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/start') {
      const body = await parseBody(req);
      const room = rooms.get(String(body.roomId || '').trim());
      if (!room) return badRequest(res, 'Room not found');
      const player = verifyPlayer(room, body.token);
      if (!player) return badRequest(res, 'Invalid token');
      player.lastSeenAt = Date.now();
      if (player.side !== 0) return badRequest(res, 'Only host can start');
      if (room.state !== 'lobby') return badRequest(res, 'Match is already in progress');
      if (room.mode === 'network' && !room.players[1].connected) {
        startWarmupAiRound(room, true);
        room.updatedAt = Date.now();
        json(res, 200, { ok: true, mode: 'practice' });
        return;
      }
      if (room.mode === 'network' && !room.players[1].ready) {
        return badRequest(res, 'Waiting for opponent to ready up');
      }

      room.state = 'countdown';
      room.players[0].ready = false;
      room.players[1].ready = false;
      room.startedAt = Date.now();
      room.runStartedAt = 0;
      room.lastTickAt = Date.now();
      room.updatedAt = Date.now();

      json(res, 200, { ok: true });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/rematch') {
      const body = await parseBody(req);
      const room = rooms.get(String(body.roomId || '').trim());
      if (!room) return badRequest(res, 'Room not found');
      const player = verifyPlayer(room, body.token);
      if (!player) return badRequest(res, 'Invalid token');
      player.lastSeenAt = Date.now();
      if (player.side !== 0) return badRequest(res, 'Only host can rematch');
      if (room.state !== 'finished') return badRequest(res, 'Match is not finished');

      resetMatch(room, true);
      room.updatedAt = Date.now();

      json(res, 200, { ok: true, state: room.state });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/state') {
      const body = await parseBody(req);
      const roomId = String(body.roomId || '').trim();
      const token = String(body.token || '').trim();
      const room = rooms.get(roomId);
      if (!room) return badRequest(res, 'Room not found');
      const player = verifyPlayer(room, token);
      if (!player) return badRequest(res, 'Invalid token');

      player.connected = true;
      player.lastSeenAt = Date.now();
      room.updatedAt = Date.now();

      json(res, 200, roomSnapshot(room, player));
      return;
    }

    serveStatic(req, res, pathname);
  } catch (err) {
    json(res, 500, { error: err.message || 'Server error' });
  }
});

setInterval(() => maintenance(Date.now()), 1000 / 60);

server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`Crossfire server running on http://${HOST}:${PORT}`);
});
