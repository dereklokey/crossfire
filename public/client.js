const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');

const modeSelect = document.getElementById('modeSelect');
const pieceBlock = document.getElementById('pieceBlock');
const aiBlock = document.getElementById('aiBlock');
const createBlock = document.getElementById('createBlock');
const joinBlock = document.getElementById('joinBlock');
const pieceSelect = document.getElementById('pieceSelect');
const aiSelect = document.getElementById('aiSelect');
const createBtn = document.getElementById('createBtn');
const joinBtn = document.getElementById('joinBtn');
const startBtn = document.getElementById('startBtn');
const rematchBtn = document.getElementById('rematchBtn');
const copyRoomBtn = document.getElementById('copyRoomBtn');
const joinInput = document.getElementById('joinInput');
const roomInput = document.getElementById('roomInput');
const statusText = document.getElementById('statusText');
const overlay = document.getElementById('overlay');

let session = {
  roomId: null,
  token: null,
  side: 0,
  state: null,
};

const controls = {
  aimDir: 0,
  shooting: false,
  desiredAngle: null,
};
let reloadQueued = 0;

function setStatus(msg) {
  statusText.textContent = msg;
}

function renderSetupMode() {
  const selected = modeSelect.value;
  const isSingle = selected === 'single';
  const isHost = selected === 'host';
  const isJoin = selected === 'join';

  pieceBlock.classList.toggle('hidden-ui', isJoin);
  aiBlock.classList.toggle('hidden-ui', !isSingle);
  createBlock.classList.toggle('hidden-ui', isJoin);
  joinBlock.classList.toggle('hidden-ui', !isJoin);

  createBtn.textContent = isSingle ? 'Create Single Player Match' : 'Create Multiplayer Room';
}

function updateActionButtons(state) {
  if (!state) {
    startBtn.disabled = true;
    rematchBtn.disabled = true;
    return;
  }
  startBtn.disabled = !state.hostCanStart;
  rematchBtn.disabled = !state.hostCanRematch;
}

function setSessionLocked(locked) {
  modeSelect.disabled = locked;
  pieceSelect.disabled = locked;
  aiSelect.disabled = locked;
  createBtn.disabled = locked;
  joinBtn.disabled = locked;
  joinInput.disabled = locked;
  if (locked && document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
  }
}

async function postJSON(url, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || 'Request failed');
  }
  return data;
}

async function createMatch() {
  try {
    setStatus('Creating match...');
    const selectedMode = modeSelect.value;
    const mode = selectedMode === 'single' ? 'single' : 'network';
    const pieceRaw = pieceSelect.value;
    const pieceSetting = pieceRaw === 'random' ? 'random' : Number(pieceRaw);
    const data = await postJSON('/api/create', {
      mode,
      pieceSetting,
      aiDifficulty: aiSelect.value,
    });

    session.roomId = data.roomId;
    session.token = data.token;
    session.side = data.side;
    roomInput.value = data.roomId;
    setSessionLocked(true);

    if (mode === 'network') {
      setStatus(`Room ${data.roomId} created. Share code, then press Start Match when ready.`);
    } else {
      setStatus(`Single-player room ${data.roomId} ready. Difficulty: ${aiSelect.value}.`);
    }
  } catch (err) {
    setStatus(`Create failed: ${err.message}`);
  }
}

async function joinMatch() {
  try {
    const roomId = joinInput.value.trim();
    if (!roomId) {
      setStatus('Enter room ID first.');
      return;
    }
    setStatus(`Joining room ${roomId}...`);
    const data = await postJSON('/api/join', { roomId });
    session.roomId = data.roomId;
    session.token = data.token;
    session.side = data.side;
    roomInput.value = data.roomId;
    joinInput.value = '';
    setSessionLocked(true);
    setStatus(`Joined room ${data.roomId} as Player ${data.side + 1}.`);
  } catch (err) {
    setStatus(`Join failed: ${err.message}`);
  }
}

async function startMatch() {
  if (!session.roomId || !session.token) {
    setStatus('Create or join a room first.');
    return;
  }
  try {
    await postJSON('/api/start', {
      roomId: session.roomId,
      token: session.token,
    });
    setStatus('Starting match...');
  } catch (err) {
    setStatus(`Start failed: ${err.message}`);
  }
}

async function rematch() {
  if (!session.roomId || !session.token) {
    setStatus('Create or join a room first.');
    return;
  }
  try {
    const data = await postJSON('/api/rematch', {
      roomId: session.roomId,
      token: session.token,
    });
    if (data.state === 'lobby') {
      setStatus('Rematch reset. Press Start Match when both players are ready.');
    } else {
      setStatus('Rematch started.');
    }
  } catch (err) {
    setStatus(`Rematch failed: ${err.message}`);
  }
}

async function copyRoomId() {
  const roomId = (session.roomId || roomInput.value || '').trim();
  if (!roomId) {
    setStatus('No room ID to copy.');
    return;
  }

  const fallbackCopy = () => {
    const ta = document.createElement('textarea');
    ta.value = roomId;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    document.body.removeChild(ta);
    return ok;
  };

  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(roomId);
      setStatus(`Copied room ID: ${roomId}`);
      return;
    }
    if (fallbackCopy()) {
      setStatus(`Copied room ID: ${roomId}`);
      return;
    }
    setStatus(`Copy blocked. Room ID: ${roomId}`);
  } catch {
    if (fallbackCopy()) {
      setStatus(`Copied room ID: ${roomId}`);
    } else {
      setStatus(`Copy blocked. Room ID: ${roomId}`);
    }
  }
}

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') {
    reloadQueued += 1;
    e.preventDefault();
  }
});

canvas.addEventListener('mousedown', (e) => {
  if (e.button === 0) {
    controls.shooting = true;
    e.preventDefault();
  }
});

window.addEventListener('mouseup', (e) => {
  if (e.button === 0) {
    controls.shooting = false;
  }
});

canvas.addEventListener('mousemove', (e) => {
  if (!session.state || !session.state.board) return;
  const rect = canvas.getBoundingClientRect();
  const sx = (e.clientX - rect.left) * (canvas.width / rect.width);
  const sy = (e.clientY - rect.top) * (canvas.height / rect.height);

  const gunX = session.side === 0 ? 60 : session.state.board.width - 60;
  const gunY = session.state.board.height / 2;
  controls.desiredAngle = Math.atan2(sy - gunY, sx - gunX);
});

createBtn.addEventListener('click', createMatch);
joinBtn.addEventListener('click', joinMatch);
startBtn.addEventListener('click', startMatch);
rematchBtn.addEventListener('click', rematch);
copyRoomBtn.addEventListener('click', copyRoomId);
modeSelect.addEventListener('change', () => {
  if (!modeSelect.disabled) renderSetupMode();
});

async function sendInputTick() {
  if (!session.roomId || !session.token) return;
  const sendReload = reloadQueued > 0;
  try {
    await postJSON('/api/input', {
      roomId: session.roomId,
      token: session.token,
      input: {
        aimDir: controls.aimDir,
        shooting: controls.shooting,
        desiredAngle: controls.desiredAngle,
        reloadPressed: sendReload,
      },
    });
    if (sendReload) {
      reloadQueued = Math.max(0, reloadQueued - 1);
    }
  } catch {
    // keep trying via poll loop
  }
}

async function pollStateTick() {
  if (!session.roomId || !session.token) return;

  try {
    const res = await fetch(`/api/state?roomId=${encodeURIComponent(session.roomId)}&token=${encodeURIComponent(session.token)}`, {
      cache: 'no-store',
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'State poll failed');

    session.state = data;
    updateActionButtons(data);
    render(data);

    const me = data.players[data.me];
    const them = data.players[1 - data.me];
    if (data.state === 'lobby') {
      if (data.me === 0) {
        const ready = data.players[1].connected ? 'Opponent connected. Press Start Match.' : 'Waiting for opponent to join.';
        setStatus(`Room ${data.roomId} | Host | ${ready}`);
      } else {
        setStatus(`Room ${data.roomId} | Joined as P2 | Waiting for host to start match.`);
      }
    } else {
      setStatus(
        `Room ${data.roomId} | You: P${data.me + 1} | Score ${me.score}-${them.score} | Mag ${me.mag}/20 | Bin ${me.bin}`
      );
    }

    if (data.state === 'lobby') {
      overlay.classList.remove('hidden');
      overlay.textContent = data.me === 0 ? 'Press Start Match' : 'Waiting For Host';
    } else if (data.state === 'countdown') {
      overlay.classList.remove('hidden');
      overlay.textContent = `Match starts in ${Math.ceil(data.countdownMs / 1000)}`;
    } else if (data.state === 'finished') {
      overlay.classList.remove('hidden');
      overlay.textContent = data.winner === data.me ? 'Victory' : 'Defeat';
    } else {
      overlay.classList.add('hidden');
    }
  } catch (err) {
    setStatus(`Connection issue: ${err.message}`);
  }
}

function drawGoalLines(board) {
  ctx.strokeStyle = '#7ac5e4';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(board.goalLeftX, board.top);
  ctx.lineTo(board.goalLeftX, board.bottom);
  ctx.stroke();

  ctx.strokeStyle = '#f0a183';
  ctx.beginPath();
  ctx.moveTo(board.goalRightX, board.top);
  ctx.lineTo(board.goalRightX, board.bottom);
  ctx.stroke();
}

function drawBoard(board) {
  const grad = ctx.createLinearGradient(0, 0, 0, board.height);
  grad.addColorStop(0, '#132739');
  grad.addColorStop(1, '#0d1b28');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, board.width, board.height);

  ctx.strokeStyle = '#2e4f64';
  ctx.lineWidth = 3;
  ctx.strokeRect(2, board.top, board.width - 4, board.bottom - board.top);

  drawGoalLines(board);

  ctx.strokeStyle = '#2f5970';
  ctx.lineWidth = 1;
  ctx.setLineDash([7, 7]);
  ctx.beginPath();
  ctx.moveTo(board.width / 2, board.top);
  ctx.lineTo(board.width / 2, board.bottom);
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawPiece(p) {
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(p.angle || 0);
  ctx.fillStyle = '#d9ece7';
  ctx.strokeStyle = '#8ec8bc';
  ctx.lineWidth = 2;

  if (p.shape === 'triangle') {
    ctx.beginPath();
    ctx.moveTo(0, -p.r);
    ctx.lineTo(p.r * 0.9, p.r * 0.8);
    ctx.lineTo(-p.r * 0.9, p.r * 0.8);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  } else if (p.shape === 'square') {
    ctx.beginPath();
    ctx.rect(-p.r * 0.85, -p.r * 0.85, p.r * 1.7, p.r * 1.7);
    ctx.fill();
    ctx.stroke();
  } else if (p.shape === 'hex') {
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 3) * i;
      const x = Math.cos(a) * p.r;
      const y = Math.sin(a) * p.r;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  } else if (p.shape === 'star6') {
    ctx.beginPath();
    for (let i = 0; i < 12; i++) {
      const a = (Math.PI / 6) * i - Math.PI / 2;
      const rr = i % 2 === 0 ? p.r : p.r * 0.45;
      const x = Math.cos(a) * rr;
      const y = Math.sin(a) * rr;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  } else if (p.shape === 'star8') {
    ctx.beginPath();
    for (let i = 0; i < 16; i++) {
      const a = (Math.PI / 8) * i - Math.PI / 2;
      const rr = i % 2 === 0 ? p.r : p.r * 0.5;
      const x = Math.cos(a) * rr;
      const y = Math.sin(a) * rr;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.arc(0, 0, p.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  ctx.restore();
}

function drawGun(side, angle, playerState) {
  const x = side === 0 ? 60 : 1140;
  const y = 350;

  ctx.save();
  ctx.translate(x, y);

  ctx.fillStyle = side === 0 ? '#6ac6ec' : '#ef9575';
  ctx.beginPath();
  ctx.arc(0, 0, 20, 0, Math.PI * 2);
  ctx.fill();

  ctx.rotate(angle);
  ctx.fillStyle = '#d8eaf2';
  ctx.fillRect(0, -5, 34, 10);

  ctx.restore();

  if (playerState.reloading) {
    ctx.fillStyle = '#ffe08b';
    ctx.font = 'bold 14px Trebuchet MS';
    ctx.textAlign = 'center';
    ctx.fillText('RELOADING', x, y - 30);
  }
}

function drawProjectiles(projectiles) {
  ctx.fillStyle = '#ffe7a1';
  for (const s of projectiles) {
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawHUD(data) {
  const MAG_MAX = 20;
  const BIN_MAX = 50;

  function getMagColor(value) {
    const ratio = value / MAG_MAX;
    if (ratio > 0.6) return '#50d16f';
    if (ratio > 0.25) return '#f0b24d';
    return '#e45454';
  }

  function drawBar(x, y, w, h, value, max, fill) {
    const v = Number(value) || 0;
    const m = Number(max) || 1;
    const ratio = Math.max(0, Math.min(1, v / m));
    ctx.fillStyle = '#0e1d29';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = '#385b70';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x, y, w, h);

    ctx.fillStyle = fill;
    ctx.fillRect(x + 2, y + 2, (w - 4) * ratio, h - 4);
  }

  function drawBarValue(x, y, h, value, color = '#d7e7f2') {
    ctx.fillStyle = color;
    ctx.font = 'bold 13px Trebuchet MS';
    ctx.textAlign = 'right';
    ctx.fillText(String(value), x - 8, y + h - 2);
  }

  function drawReloadAlert(centerX, y, player, tint) {
    if (player.mag !== 0 || player.reloading) return;
    const pulse = 0.45 + 0.55 * Math.abs(Math.sin(Date.now() / 120));
    ctx.save();
    ctx.globalAlpha = pulse;
    ctx.fillStyle = tint;
    ctx.font = 'bold 16px Trebuchet MS';
    ctx.textAlign = 'center';
    ctx.fillText('RELOAD!', centerX, y);
    ctx.restore();
  }

  ctx.fillStyle = '#cfe2ef';
  ctx.font = 'bold 18px Trebuchet MS';
  ctx.textAlign = 'left';
  ctx.fillText(`P1 Score: ${data.players[0].score}`, 18, 32);
  ctx.fillText(`P2 Score: ${data.players[1].score}`, 1010, 32);

  ctx.textAlign = 'center';
  ctx.fillText(`Majority Wins: ${data.piecesNeeded}`, 600, 32);

  const barW = 220;
  const barH = 14;
  const leftX = 24;
  const rightX = 1200 - barW - 24;
  const topY = 648;
  const gap = 22;
  const p1 = data.players[0];
  const p2 = data.players[1];

  drawBar(leftX, topY, barW, barH, p1.mag, MAG_MAX, getMagColor(p1.mag));
  drawBar(leftX, topY + gap, barW, barH, p1.bin, BIN_MAX, '#6ac6ec');
  drawBarValue(leftX, topY, barH, p1.mag);
  drawBarValue(leftX, topY + gap, barH, p1.bin);

  drawBar(rightX, topY, barW, barH, p2.mag, MAG_MAX, getMagColor(p2.mag));
  drawBar(rightX, topY + gap, barW, barH, p2.bin, BIN_MAX, '#ef9575');
  drawBarValue(rightX, topY, barH, p2.mag);
  drawBarValue(rightX, topY + gap, barH, p2.bin);

  drawReloadAlert(leftX + barW / 2, topY - 8, p1, '#ffd36a');
  drawReloadAlert(rightX + barW / 2, topY - 8, p2, '#ffd36a');
}

function render(data) {
  const board = data.board;
  if (!board) return;

  drawBoard(board);

  for (const p of data.pieces) {
    if (p.scoredBy !== null) continue;
    drawPiece(p);
  }

  drawProjectiles(data.projectiles);
  drawGun(0, data.players[0].gunAngle, data.players[0]);
  drawGun(1, data.players[1].gunAngle, data.players[1]);
  drawHUD(data);
}

setInterval(sendInputTick, 50);
setInterval(pollStateTick, 50);

ctx.fillStyle = '#8aa4b8';
ctx.font = 'bold 22px Trebuchet MS';
ctx.textAlign = 'center';
ctx.fillText('Create or join a match to begin.', canvas.width / 2, canvas.height / 2);

renderSetupMode();
