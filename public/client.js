const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');

const modeSelect = document.getElementById('modeSelect');
const pieceBlock = document.getElementById('pieceBlock');
const aiBlock = document.getElementById('aiBlock');
const createBlock = document.getElementById('createBlock');
const joinBlock = document.getElementById('joinBlock');
const roomBlock = document.getElementById('roomBlock');
const pieceSelect = document.getElementById('pieceSelect');
const aiSelect = document.getElementById('aiSelect');
const createBtn = document.getElementById('createBtn');
const joinBtn = document.getElementById('joinBtn');
const hostActionRow = document.getElementById('hostActionRow');
const startBtn = document.getElementById('startBtn');
const rematchBtn = document.getElementById('rematchBtn');
const readyBlock = document.getElementById('readyBlock');
const readyBtn = document.getElementById('readyBtn');
const leaveBtn = document.getElementById('leaveBtn');
const copyRoomBtn = document.getElementById('copyRoomBtn');
const searchRoomsBtn = document.getElementById('searchRoomsBtn');
const onlineCount = document.getElementById('onlineCount');
const roomSearchResults = document.getElementById('roomSearchResults');
const joinInput = document.getElementById('joinInput');
const roomInput = document.getElementById('roomInput');
const chatLog = document.getElementById('chatLog');
const chatInput = document.getElementById('chatInput');
const chatSendBtn = document.getElementById('chatSendBtn');
const overlay = document.getElementById('overlay');
const IDLE_BOARD = {
  width: canvas.width,
  height: canvas.height,
  goalLeftX: 130,
  goalRightX: canvas.width - 130,
  top: 60,
  bottom: 640,
};

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
let lastScores = null;
const scoreFlares = [];
let lastChatSignature = '';
const gunBubbles = [];
const bubbleCooldownBySide = [0, 0];
const bubbleCooldownByKey = new Map();
let lastChatterSnapshot = null;

function setStatus(msg) {
  // Status panel removed from UI; keep hook for non-visual state updates.
  void msg;
}

function renderChat(messages) {
  if (!messages || messages.length === 0) {
    chatLog.textContent = 'No messages yet.';
    lastChatSignature = '';
    return;
  }
  const signature = `${messages.length}:${messages[messages.length - 1].id}`;
  if (signature === lastChatSignature) return;
  lastChatSignature = signature;

  chatLog.innerHTML = '';
  for (const m of messages) {
    const row = document.createElement('div');
    row.className = 'chat-message';
    const sender = document.createElement('span');
    sender.className = 'chat-sender';
    sender.textContent = `${m.sender}:`;
    const text = document.createElement('span');
    text.textContent = m.text;
    row.appendChild(sender);
    row.appendChild(text);
    chatLog.appendChild(row);
  }
  chatLog.scrollTop = chatLog.scrollHeight;
}

async function sendChatMessage() {
  if (!session.roomId || !session.token) {
    setStatus('Join a room before sending chat.');
    return;
  }
  if (chatInput.disabled) return;
  const message = String(chatInput.value || '').trim();
  if (!message) return;
  try {
    await postJSON('/api/chat', {
      roomId: session.roomId,
      token: session.token,
      message,
    });
    chatInput.value = '';
  } catch (err) {
    setStatus(`Chat failed: ${err.message}`);
  }
}

function resetToLobbyState(message = 'Left room.') {
  session.roomId = null;
  session.token = null;
  session.side = 0;
  session.state = null;
  lastScores = null;
  scoreFlares.length = 0;
  gunBubbles.length = 0;
  bubbleCooldownBySide[0] = 0;
  bubbleCooldownBySide[1] = 0;
  bubbleCooldownByKey.clear();
  lastChatterSnapshot = null;
  reloadQueued = 0;
  lastChatSignature = '';
  controls.shooting = false;
  controls.desiredAngle = null;
  roomInput.value = '';
  chatLog.textContent = 'Create or join a room to start chat.';
  chatInput.value = '';
  setSessionLocked(false);
  updateActionButtons(null);
  overlay.classList.add('hidden');
  renderSetupMode();
  renderIdleCanvas();
  setStatus(message);
  searchOpenRooms();
}

function renderRoomSearchResults(rooms) {
  const visibleRooms = (rooms || []).filter((room) => room.roomId !== session.roomId);
  if (visibleRooms.length === 0) {
    if (roomSearchResults.childElementCount === 0
      && roomSearchResults.textContent === 'No open rooms found. Ask a host to create one.') {
      return;
    }
    roomSearchResults.textContent = 'No open rooms found. Ask a host to create one.';
    return;
  }
  roomSearchResults.innerHTML = '';
  for (const room of visibleRooms) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'room-item-btn';
    const alreadyInRoom = Boolean(session.roomId && session.token);
    btn.disabled = alreadyInRoom;
    const ageSec = Math.max(0, Math.floor((Date.now() - room.createdAt) / 1000));
    btn.textContent = alreadyInRoom
      ? `${room.roomId} • ${room.pieceCount} pieces • ${ageSec}s ago (leave current room to join)`
      : `${room.roomId} • ${room.pieceCount} pieces • ${ageSec}s ago`;
    btn.addEventListener('click', () => {
      joinMatch(room.roomId);
    });
    roomSearchResults.appendChild(btn);
  }
}

async function searchOpenRooms() {
  try {
    const res = await fetch('/api/rooms', { cache: 'no-store' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Room search failed');
    onlineCount.textContent = String(Number(data.onlinePlayers) || 0);
    renderRoomSearchResults(data.rooms || []);
  } catch (err) {
    roomSearchResults.textContent = `Room search failed: ${err.message}`;
    onlineCount.textContent = '?';
  }
}

function pickRandom(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function queueGunBubble(side, text, opts = {}) {
  const now = Date.now();
  const minGapMs = Number(opts.minGapMs) || 1400;
  const durationMs = Number(opts.durationMs) || 2500;
  const key = String(opts.key || `${side}:${text}`);
  const keyCooldownMs = Number(opts.keyCooldownMs) || 3200;

  if (now < bubbleCooldownBySide[side]) return;
  const keyUntil = bubbleCooldownByKey.get(key) || 0;
  if (now < keyUntil) return;

  bubbleCooldownBySide[side] = now + minGapMs;
  bubbleCooldownByKey.set(key, now + keyCooldownMs);
  gunBubbles.push({
    side,
    text,
    startedAt: now,
    durationMs,
  });
  if (gunBubbles.length > 8) gunBubbles.splice(0, gunBubbles.length - 8);
}

function updateGunChatter(data) {
  if (!data || !data.players || data.players.length < 2) return;
  const snap = {
    roomId: data.roomId,
    state: data.state,
    scores: [data.players[0].score, data.players[1].score],
    mags: [data.players[0].mag, data.players[1].mag],
    bins: [data.players[0].bin, data.players[1].bin],
    reloading: [Boolean(data.players[0].reloading), Boolean(data.players[1].reloading)],
  };

  if (!lastChatterSnapshot || lastChatterSnapshot.roomId !== snap.roomId) {
    lastChatterSnapshot = snap;
    return;
  }

  if (snap.state !== 'running') {
    lastChatterSnapshot = snap;
    return;
  }

  for (let side = 0; side < 2; side++) {
    const other = 1 - side;
    const prevScore = lastChatterSnapshot.scores[side];
    const nowScore = snap.scores[side];
    if (nowScore > prevScore) {
      queueGunBubble(side, pickRandom([
        'GOAL!!!',
        'Yes!',
        'Nailed it!',
        'Boom!',
        'Right on!',
        'Got it!',
        'What a shot!',
      ]), {
        key: `score-${side}`,
        minGapMs: 900,
        keyCooldownMs: 1500,
      });
      queueGunBubble(other, pickRandom([
        'Nooooo!',
        'Dang!',
        'Not good!',
        'Ugh!',
        'That hurts!',
        'No way!',
        'Not again!',
      ]), {
        key: `concede-${other}`,
        minGapMs: 1200,
      });
      const prevGap = prevScore - lastChatterSnapshot.scores[other];
      if (prevGap <= -2) {
        queueGunBubble(side, pickRandom([
          'Comeback time!',
          "I'm back in it!",
          "Not done yet!",
          'Momentum shift!',
          'Still alive!',
        ]), {
          key: `comeback-${side}`,
          minGapMs: 2200,
          keyCooldownMs: 4500,
        });
      }
    }
  }

  for (let side = 0; side < 2; side++) {
    const prevMag = lastChatterSnapshot.mags[side];
    const mag = snap.mags[side];
    const bin = snap.bins[side];
    const reloadingStarted = !lastChatterSnapshot.reloading[side] && snap.reloading[side];

    if (prevMag > 0 && mag === 0) {
      const text = bin > 0
        ? pickRandom(['Need a reload!', 'Reloading soon!', 'Mag empty!', 'Time to top up!'])
        : pickRandom(["I'm out!", 'No ammo!', 'Dry fire!', 'Completely empty!']);
      queueGunBubble(side, text, {
        key: `empty-${side}`,
        minGapMs: 1800,
      });
    } else if (reloadingStarted && mag === 0 && bin > 0) {
      queueGunBubble(side, pickRandom([
        'Reloading!',
        'Cover me!',
        'Swapping mags!',
        'Loading up!',
      ]), {
        key: `reload-${side}`,
        minGapMs: 1800,
      });
    }
  }

  lastChatterSnapshot = snap;
}

function trackScoreFlares(data) {
  if (!data || !data.players || data.players.length < 2) return;
  const current = [data.players[0].score, data.players[1].score];
  if (!lastScores) {
    lastScores = current;
    return;
  }

  for (let side = 0; side < 2; side++) {
    const delta = current[side] - lastScores[side];
    if (delta > 0) {
      for (let i = 0; i < delta; i++) {
        scoreFlares.push({
          side,
          startedAt: Date.now() + i * 70,
        });
      }
    }
  }
  lastScores = current;
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
  roomBlock.classList.toggle('hidden-ui', isSingle);

  createBtn.textContent = isSingle ? 'Create Single Player Match' : 'Create Multiplayer Room';
}

function updateActionButtons(state) {
  if (!state) {
    hostActionRow.classList.remove('hidden-ui');
    readyBlock.classList.add('hidden-ui');
    startBtn.disabled = true;
    rematchBtn.disabled = true;
    readyBtn.disabled = true;
    leaveBtn.disabled = true;
    startBtn.textContent = 'Start Match';
    chatInput.disabled = true;
    chatSendBtn.disabled = true;
    return;
  }

  const isJoinerMultiplayer = state.mode === 'network' && state.me === 1;
  hostActionRow.classList.toggle('hidden-ui', isJoinerMultiplayer);
  readyBlock.classList.toggle('hidden-ui', !isJoinerMultiplayer);

  const waitingForJoiner = state.mode === 'network' && state.me === 0 && state.state === 'lobby' && !state.players[1].connected;
  startBtn.textContent = waitingForJoiner ? 'Practice' : 'Start Match';
  startBtn.disabled = !state.hostCanStart;
  rematchBtn.disabled = !state.hostCanRematch;
  if (isJoinerMultiplayer) {
    const myReady = Boolean(state.players[state.me].ready);
    readyBtn.textContent = myReady ? 'Unready' : 'Ready';
    readyBtn.disabled = !state.joinerCanReady;
  } else {
    readyBtn.disabled = true;
  }
  leaveBtn.disabled = false;
  const canChat = state.state === 'lobby' || state.state === 'finished';
  chatInput.disabled = !canChat;
  chatSendBtn.disabled = !canChat;
  if (!canChat && document.activeElement === chatInput) {
    chatInput.blur();
  }
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
    lastScores = null;
    scoreFlares.length = 0;
    setSessionLocked(true);

    if (mode === 'network') {
      setStatus(`Room ${data.roomId} created. Share code, then press Start Match when ready.`);
    } else {
      setStatus(`Single-player room ${data.roomId} ready. Difficulty: ${aiSelect.value}.`);
    }
    searchOpenRooms();
  } catch (err) {
    setStatus(`Create failed: ${err.message}`);
  }
}

async function joinMatch(roomIdOverride = null) {
  try {
    const roomId = String(roomIdOverride || joinInput.value || '').trim();
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
    lastScores = null;
    scoreFlares.length = 0;
    joinInput.value = '';
    setSessionLocked(true);
    setStatus(`Joined room ${data.roomId} as Player ${data.side + 1}.`);
    searchOpenRooms();
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
    if (session.state && session.state.mode === 'network' && !session.state.players[1].connected) {
      setStatus('Starting practice vs AI...');
    } else {
      setStatus('Starting match...');
    }
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

async function toggleReady() {
  if (!session.roomId || !session.token || !session.state) {
    setStatus('Join a room first.');
    return;
  }
  try {
    const me = session.state.players[session.state.me];
    const targetReady = !Boolean(me.ready);
    const data = await postJSON('/api/ready', {
      roomId: session.roomId,
      token: session.token,
      ready: targetReady,
    });
    setStatus(data.ready ? 'Ready set. Waiting for host.' : 'Ready cleared.');
  } catch (err) {
    setStatus(`Ready failed: ${err.message}`);
  }
}

async function leaveRoom() {
  if (!session.roomId || !session.token) {
    resetToLobbyState('Not currently in a room.');
    return;
  }
  try {
    await postJSON('/api/leave', {
      roomId: session.roomId,
      token: session.token,
    });
    resetToLobbyState('Left room.');
  } catch (err) {
    setStatus(`Leave failed: ${err.message}`);
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
  const target = e.target;
  const isTypingTarget = target instanceof HTMLElement
    && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
  if (isTypingTarget) return;
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
readyBtn.addEventListener('click', toggleReady);
leaveBtn.addEventListener('click', leaveRoom);
copyRoomBtn.addEventListener('click', copyRoomId);
searchRoomsBtn.addEventListener('click', searchOpenRooms);
chatSendBtn.addEventListener('click', sendChatMessage);
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    sendChatMessage();
  }
});
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
    const data = await postJSON('/api/state', {
      roomId: session.roomId,
      token: session.token,
    });

    session.state = data;
    renderChat(data.chat);
    trackScoreFlares(data);
    updateGunChatter(data);
    updateActionButtons(data);
    render(data);

    const me = data.players[data.me];
    const them = data.players[1 - data.me];
    if (data.state === 'lobby') {
      if (data.mode === 'single') {
        setStatus(`Single-player ready. Press Start Match.`);
      } else if (data.me === 0) {
        const p2 = data.players[1];
        let hostMsg = 'Waiting for opponent to join. Press Practice to warm up vs AI.';
        if (p2.connected && !p2.ready) hostMsg = 'Opponent connected. Waiting for ready.';
        if (p2.connected && p2.ready) hostMsg = 'Opponent is ready. Press Start Match.';
        setStatus(`Room ${data.roomId} | Host | ${hostMsg}`);
      } else {
        const meReady = data.players[data.me].ready;
        const joinMsg = meReady ? 'Ready. Waiting for host to start.' : 'Press Ready when you are set.';
        setStatus(`Room ${data.roomId} | Joined as P2 | ${joinMsg}`);
      }
    } else {
      if (data.warmupAi && data.mode === 'network') {
        setStatus(
          `Room ${data.roomId} | Warmup vs AI (waiting for joiner) | Score ${me.score}-${them.score}`
        );
      } else {
        setStatus(
          `Room ${data.roomId} | You: P${data.me + 1} | Score ${me.score}-${them.score} | Mag ${me.mag}/20 | Bin ${me.bin}`
        );
      }
    }

    if (data.state === 'lobby') {
      overlay.classList.remove('hidden');
      if (data.mode === 'single') {
        overlay.textContent = 'Press Start Match';
      } else {
        if (data.me === 0) {
          if (!data.players[1].connected) {
            overlay.textContent = 'Press Practice';
          } else {
            overlay.textContent = data.players[1].ready ? 'Opponent Ready' : 'Waiting For Ready';
          }
        } else {
          overlay.textContent = data.players[data.me].ready ? 'Ready - Waiting For Host' : 'Press Ready';
        }
      }
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
    if (err && typeof err.message === 'string') {
      if (err.message.includes('Room not found') || err.message.includes('Invalid token')) {
        resetToLobbyState('Room closed by host.');
        return;
      }
    }
    setStatus(`Connection issue: ${err.message}`);
  }
}

function drawGoalLines(board) {
  ctx.shadowBlur = 18;
  ctx.shadowColor = 'rgba(122, 197, 228, 0.55)';
  ctx.strokeStyle = '#7ad4ff';
  ctx.lineWidth = 3.5;
  ctx.beginPath();
  ctx.moveTo(board.goalLeftX, board.top);
  ctx.lineTo(board.goalLeftX, board.bottom);
  ctx.stroke();

  ctx.shadowColor = 'rgba(240, 161, 131, 0.5)';
  ctx.strokeStyle = '#ffb298';
  ctx.beginPath();
  ctx.moveTo(board.goalRightX, board.top);
  ctx.lineTo(board.goalRightX, board.bottom);
  ctx.stroke();
  ctx.shadowBlur = 0;
}

function drawBoard(board) {
  // Keep non-playing bands dark.
  const outerGrad = ctx.createLinearGradient(0, 0, 0, board.height);
  outerGrad.addColorStop(0, '#12283a');
  outerGrad.addColorStop(1, '#0c1a27');
  ctx.fillStyle = outerGrad;
  ctx.fillRect(0, 0, board.width, board.height);

  // Green field only inside the playable surface.
  const fieldGrad = ctx.createLinearGradient(0, board.top, 0, board.bottom);
  fieldGrad.addColorStop(0, '#2b6f3a');
  fieldGrad.addColorStop(1, '#1f5a2f');
  ctx.fillStyle = fieldGrad;
  ctx.fillRect(0, board.top, board.width, board.bottom - board.top);

  const sheen = ctx.createRadialGradient(board.width / 2, (board.top + board.bottom) / 2, 80, board.width / 2, (board.top + board.bottom) / 2, board.width * 0.6);
  sheen.addColorStop(0, 'rgba(179, 229, 165, 0.12)');
  sheen.addColorStop(1, 'rgba(179, 229, 165, 0)');
  ctx.fillStyle = sheen;
  ctx.fillRect(0, board.top, board.width, board.bottom - board.top);

  // Subtle mowing stripes for a sports-field look.
  for (let x = 0; x < board.width; x += 80) {
    ctx.fillStyle = (Math.floor(x / 80) % 2 === 0) ? 'rgba(255, 255, 255, 0.035)' : 'rgba(0, 0, 0, 0.03)';
    ctx.fillRect(x, board.top, 80, board.bottom - board.top);
  }

  ctx.strokeStyle = '#4b7e58';
  ctx.lineWidth = 2.5;
  ctx.strokeRect(2, board.top, board.width - 4, board.bottom - board.top);

  ctx.strokeStyle = 'rgba(214, 242, 219, 0.14)';
  ctx.lineWidth = 1;
  for (let y = board.top + 22; y < board.bottom; y += 22) {
    ctx.beginPath();
    ctx.moveTo(4, y);
    ctx.lineTo(board.width - 4, y);
    ctx.stroke();
  }

  // Checker-style endzones with strong team colors.
  const leftZone = ctx.createLinearGradient(0, 0, board.goalLeftX, 0);
  leftZone.addColorStop(0, '#1a5f7f');
  leftZone.addColorStop(1, '#2f8bb5');
  ctx.fillStyle = leftZone;
  ctx.fillRect(0, board.top, board.goalLeftX, board.bottom - board.top);

  const rightZone = ctx.createLinearGradient(board.goalRightX, 0, board.width, 0);
  rightZone.addColorStop(0, '#9a553d');
  rightZone.addColorStop(1, '#bf7659');
  ctx.fillStyle = rightZone;
  ctx.fillRect(board.goalRightX, board.top, board.width - board.goalRightX, board.bottom - board.top);

  const cell = 26;
  for (let y = board.top; y < board.bottom; y += cell) {
    const h = Math.min(cell, board.bottom - y);
    for (let x = 0; x < board.goalLeftX; x += cell) {
      const w = Math.min(cell, board.goalLeftX - x);
      const on = ((Math.floor((x + y) / cell)) % 2) === 0;
      ctx.fillStyle = on ? 'rgba(230, 248, 255, 0.2)' : 'rgba(16, 62, 86, 0.18)';
      ctx.fillRect(x, y, w, h);
    }
    for (let x = board.goalRightX; x < board.width; x += cell) {
      const w = Math.min(cell, board.width - x);
      const on = ((Math.floor((x + y) / cell)) % 2) === 0;
      ctx.fillStyle = on ? 'rgba(255, 238, 230, 0.2)' : 'rgba(123, 64, 42, 0.18)';
      ctx.fillRect(x, y, w, h);
    }
  }

  // Gloss and glow for both checker endzones.
  const leftSheen = ctx.createLinearGradient(0, board.top, 0, board.top + 90);
  leftSheen.addColorStop(0, 'rgba(255, 255, 255, 0.18)');
  leftSheen.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = leftSheen;
  ctx.fillRect(0, board.top, board.goalLeftX, 90);

  const rightSheen = ctx.createLinearGradient(0, board.top, 0, board.top + 90);
  rightSheen.addColorStop(0, 'rgba(255, 255, 255, 0.16)');
  rightSheen.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = rightSheen;
  ctx.fillRect(board.goalRightX, board.top, board.width - board.goalRightX, 90);

  const leftGlow = ctx.createRadialGradient(board.goalLeftX - 8, board.height / 2, 8, board.goalLeftX - 8, board.height / 2, 140);
  leftGlow.addColorStop(0, 'rgba(126, 219, 255, 0.32)');
  leftGlow.addColorStop(1, 'rgba(126, 219, 255, 0)');
  ctx.fillStyle = leftGlow;
  ctx.fillRect(0, board.top, board.goalLeftX + 6, board.bottom - board.top);

  const rightGlow = ctx.createRadialGradient(board.goalRightX + 8, board.height / 2, 8, board.goalRightX + 8, board.height / 2, 140);
  rightGlow.addColorStop(0, 'rgba(255, 183, 156, 0.32)');
  rightGlow.addColorStop(1, 'rgba(255, 183, 156, 0)');
  ctx.fillStyle = rightGlow;
  ctx.fillRect(board.goalRightX - 6, board.top, board.width - board.goalRightX + 6, board.bottom - board.top);

  drawGoalLines(board);

  ctx.strokeStyle = 'rgba(224, 247, 232, 0.55)';
  ctx.lineWidth = 1;
  ctx.setLineDash([7, 7]);
  ctx.beginPath();
  ctx.moveTo(board.width / 2, board.top);
  ctx.lineTo(board.width / 2, board.bottom);
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawPiece(p) {
  const palette = {
    circle: { hi: '#f9f2cc', lo: '#d8b86e', edge: '#9a7c3a' },
    triangle: { hi: '#dff3ff', lo: '#79b7d8', edge: '#3e7f9f' },
    square: { hi: '#e7f8df', lo: '#8fc77a', edge: '#4e8b3c' },
    hex: { hi: '#ffe6ef', lo: '#d993b0', edge: '#95506d' },
    star6: { hi: '#f6e8ff', lo: '#b996e1', edge: '#7750a3' },
    star8: { hi: '#ffe8dd', lo: '#df9f83', edge: '#9a5f49' },
  };
  const c = palette[p.shape] || palette.circle;

  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(p.angle || 0);
  ctx.shadowBlur = 8;
  ctx.shadowColor = 'rgba(0, 0, 0, 0.25)';
  const g = ctx.createRadialGradient(-p.r * 0.32, -p.r * 0.36, p.r * 0.12, 0, 0, p.r * 1.05);
  g.addColorStop(0, c.hi);
  g.addColorStop(1, c.lo);
  ctx.fillStyle = g;
  ctx.strokeStyle = c.edge;
  ctx.lineWidth = 2.2;

  if (p.shape === 'triangle') {
    ctx.beginPath();
    for (let i = 0; i < 3; i++) {
      const a = -Math.PI / 2 + i * (Math.PI * 2 / 3);
      const x = Math.cos(a) * p.r;
      const y = Math.sin(a) * p.r;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
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

  ctx.shadowBlur = 0;
  // Center-weight marker: subtle metallic core with ring.
  const coreOffsetY = 0;
  ctx.translate(0, coreOffsetY);
  const core = ctx.createRadialGradient(-1, -1, 0.5, 0, 0, p.r * 0.29);
  core.addColorStop(0, '#f4fbff');
  core.addColorStop(1, '#8ea4b4');
  ctx.fillStyle = core;
  ctx.beginPath();
  ctx.arc(0, 0, p.r * 0.24, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(24, 36, 46, 0.45)';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.arc(0, 0, p.r * 0.31, 0, Math.PI * 2);
  ctx.stroke();

  ctx.restore();
}

function drawGun(side, angle, playerState) {
  const x = side === 0 ? 60 : 1140;
  const y = 350;
  const team = side === 0 ? '#6ac6ec' : '#ef9575';
  const teamGlow = side === 0 ? 'rgba(106, 198, 236, 0.42)' : 'rgba(239, 149, 117, 0.42)';

  ctx.save();
  ctx.translate(x, y);
  ctx.shadowBlur = 18;
  ctx.shadowColor = teamGlow;

  // Low-profile pedestal.
  const baseGrad = ctx.createRadialGradient(-2, -3, 2, 0, 0, 24);
  baseGrad.addColorStop(0, '#253c4d');
  baseGrad.addColorStop(1, '#101f2c');
  ctx.fillStyle = baseGrad;
  ctx.beginPath();
  ctx.ellipse(0, 0, 24, 20, 0, 0, Math.PI * 2);
  ctx.fill();

  // Team ring.
  ctx.strokeStyle = team;
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.ellipse(0, 0, 19.5, 16.5, 0, 0, Math.PI * 2);
  ctx.stroke();

  // Core hub.
  const pivotGrad = ctx.createRadialGradient(-3, -3, 2, 0, 0, 13);
  pivotGrad.addColorStop(0, '#e8f3fa');
  pivotGrad.addColorStop(1, '#6a8597');
  ctx.fillStyle = pivotGrad;
  ctx.beginPath();
  ctx.arc(0, 0, 12, 0, Math.PI * 2);
  ctx.fill();

  ctx.rotate(angle);
  ctx.shadowBlur = 0;

  // Armored body.
  const bodyGrad = ctx.createLinearGradient(0, -12, 0, 12);
  bodyGrad.addColorStop(0, '#d9e8f2');
  bodyGrad.addColorStop(1, '#7d97ab');
  ctx.fillStyle = bodyGrad;
  ctx.beginPath();
  ctx.moveTo(-1, -10);
  ctx.lineTo(10, -12);
  ctx.lineTo(27, -8);
  ctx.lineTo(27, 8);
  ctx.lineTo(10, 12);
  ctx.lineTo(-1, 10);
  ctx.closePath();
  ctx.fill();

  // Twin rail barrel.
  ctx.fillStyle = '#5f7a8d';
  ctx.fillRect(24, -8, 22, 5);
  ctx.fillRect(24, 3, 22, 5);
  ctx.fillStyle = '#d0deea';
  ctx.fillRect(24, -2, 22, 4);

  // Muzzle block.
  ctx.fillStyle = '#86a3b8';
  ctx.fillRect(46, -9, 7, 18);

  // Bore.
  ctx.fillStyle = '#1a2630';
  ctx.beginPath();
  ctx.arc(53, 0, 2.8, 0, Math.PI * 2);
  ctx.fill();

  // Accent strip and core light.
  ctx.fillStyle = team;
  ctx.globalAlpha = 0.9;
  ctx.fillRect(4, -8, 3, 16);
  ctx.globalAlpha = 0.75;
  ctx.fillRect(15, -1.5, 12, 3);
  ctx.globalAlpha = 1;

  ctx.restore();

  if (playerState.reloading) {
    ctx.fillStyle = '#ffe08b';
    ctx.font = '700 14px "Space Grotesk", "Trebuchet MS", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('RELOADING', x, y - 30);
  }
}

function drawProjectiles(projectiles) {
  for (const s of projectiles) {
    const vx = Number(s.vx) || 0;
    const vy = Number(s.vy) || 0;
    const speed = Math.hypot(vx, vy);
    if (speed > 380) {
      const dirX = vx / speed;
      const dirY = vy / speed;
      const tailLen = Math.min(22, Math.max(8, speed * 0.02));
      const grad = ctx.createLinearGradient(s.x, s.y, s.x - dirX * tailLen, s.y - dirY * tailLen);
      if (s.owner === 0) {
        grad.addColorStop(0, 'rgba(116, 217, 255, 0.8)');
        grad.addColorStop(1, 'rgba(116, 217, 255, 0)');
      } else {
        grad.addColorStop(0, 'rgba(255, 176, 142, 0.8)');
        grad.addColorStop(1, 'rgba(255, 176, 142, 0)');
      }
      ctx.strokeStyle = grad;
      ctx.lineWidth = Math.max(1.6, s.r * 1.1);
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(s.x - dirX * tailLen, s.y - dirY * tailLen);
      ctx.stroke();
    }

    ctx.fillStyle = s.owner === 0 ? '#74d9ff' : '#ffb08e';
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawGunBubbles() {
  if (!gunBubbles.length) return;
  const now = Date.now();
  const kept = [];

  for (const b of gunBubbles) {
    const age = now - b.startedAt;
    if (age < 0) {
      kept.push(b);
      continue;
    }
    if (age > b.durationMs) continue;
    kept.push(b);

    const t = age / b.durationMs;
    const rise = t * 12;
    const alpha = t < 0.15 ? t / 0.15 : (1 - t) / 0.85;
    const x = b.side === 0 ? 105 : 1095;
    const y = 286 - rise;
    const text = b.text;

    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
    ctx.font = '700 13px "Space Grotesk", "Trebuchet MS", sans-serif';
    const textWidth = ctx.measureText(text).width;
    const padX = 10;
    const w = textWidth + padX * 2;
    const h = 28;
    const left = b.side === 0 ? x : x - w;
    const top = y - h;
    const r = 9;

    ctx.fillStyle = 'rgba(11, 25, 36, 0.9)';
    ctx.strokeStyle = b.side === 0 ? 'rgba(116, 217, 255, 0.7)' : 'rgba(255, 176, 142, 0.7)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(left + r, top);
    ctx.lineTo(left + w - r, top);
    ctx.quadraticCurveTo(left + w, top, left + w, top + r);
    ctx.lineTo(left + w, top + h - r);
    ctx.quadraticCurveTo(left + w, top + h, left + w - r, top + h);
    if (b.side === 0) {
      ctx.lineTo(left + 18, top + h);
      ctx.lineTo(left + 8, top + h + 8);
      ctx.lineTo(left + 10, top + h - 1);
    } else {
      ctx.lineTo(left + w - 18, top + h);
      ctx.lineTo(left + w - 8, top + h + 8);
      ctx.lineTo(left + w - 10, top + h - 1);
    }
    ctx.lineTo(left + r, top + h);
    ctx.quadraticCurveTo(left, top + h, left, top + h - r);
    ctx.lineTo(left, top + r);
    ctx.quadraticCurveTo(left, top, left + r, top);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#eef8ff';
    ctx.textAlign = 'center';
    ctx.fillText(text, left + w / 2, top + 18);
    ctx.restore();
  }

  gunBubbles.length = 0;
  gunBubbles.push(...kept);
}

function drawScoreFlares(board) {
  if (!scoreFlares.length) return;
  const now = Date.now();
  const durationMs = 1150;
  const kept = [];

  for (const flare of scoreFlares) {
    const age = now - flare.startedAt;
    if (age < 0) {
      kept.push(flare);
      continue;
    }
    if (age > durationMs) continue;
    kept.push(flare);

    const t = age / durationMs;
    const easeOut = 1 - Math.pow(1 - t, 3);
    const pulse = 1 - t;
    const cx = flare.side === 0 ? board.goalRightX - 90 : board.goalLeftX + 90;
    const cy = board.height / 2;
    const base = flare.side === 0 ? '#74d9ff' : '#ffb08e';

    ctx.save();
    ctx.globalAlpha = 0.32 * pulse;
    ctx.strokeStyle = base;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(cx, cy, 26 + easeOut * 115, 0, Math.PI * 2);
    ctx.stroke();

    ctx.globalAlpha = 0.22 * pulse;
    ctx.beginPath();
    ctx.arc(cx, cy, 16 + easeOut * 72, 0, Math.PI * 2);
    ctx.stroke();

    ctx.globalAlpha = 0.95 * pulse;
    ctx.fillStyle = '#f2fbff';
    ctx.font = '700 30px "Space Grotesk", "Trebuchet MS", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('SCORE!', cx, cy - 18 - easeOut * 24);
    ctx.restore();
  }
  scoreFlares.length = 0;
  scoreFlares.push(...kept);
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
    ctx.font = '700 13px "Space Grotesk", "Trebuchet MS", sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(String(value), x - 8, y + h - 2);
  }

  function drawBarMax(x, y, w, h, max, color = '#88a9bc') {
    ctx.fillStyle = color;
    ctx.font = '600 12px "Space Grotesk", "Trebuchet MS", sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(String(max), x + w + 8, y + h - 1);
  }

  function drawReloadAlert(centerX, y, player, tint) {
    if (player.mag !== 0 || player.reloading) return;
    const pulse = 0.45 + 0.55 * Math.abs(Math.sin(Date.now() / 120));
    ctx.save();
    ctx.globalAlpha = pulse;
    ctx.fillStyle = tint;
    ctx.font = '700 16px "Space Grotesk", "Trebuchet MS", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('RELOAD!', centerX, y);
    ctx.restore();
  }

  function roundedRectPath(x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.arcTo(x + w, y, x + w, y + rr, rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
    ctx.lineTo(x + rr, y + h);
    ctx.arcTo(x, y + h, x, y + h - rr, rr);
    ctx.lineTo(x, y + rr);
    ctx.arcTo(x, y, x + rr, y, rr);
    ctx.closePath();
  }

  function drawScoreCard(x, y, w, h, label, score, accent) {
    roundedRectPath(x, y, w, h, 11);
    const bg = ctx.createLinearGradient(x, y, x, y + h);
    bg.addColorStop(0, 'rgba(16, 33, 47, 0.94)');
    bg.addColorStop(1, 'rgba(12, 24, 35, 0.94)');
    ctx.fillStyle = bg;
    ctx.fill();
    ctx.strokeStyle = 'rgba(126, 174, 204, 0.25)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = accent;
    ctx.fillRect(x + 1.5, y + 1.5, 4, h - 3);

    ctx.fillStyle = '#8fb3c8';
    ctx.font = '600 11px "Space Grotesk", "Trebuchet MS", sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(label, x + 13, y + 13);

    ctx.fillStyle = '#edf7ff';
    ctx.font = '700 24px "Space Grotesk", "Trebuchet MS", sans-serif';
    ctx.fillText(String(score), x + 13, y + h - 8);
  }

  function getCenterBadgeText() {
    const formatClock = (ms) => {
      const totalSec = Math.floor((Number(ms) || 0) / 1000);
      const min = Math.floor(totalSec / 60);
      const sec = totalSec % 60;
      return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    };

    if (data.state === 'countdown') {
      return {
        top: 'MATCH STARTS',
        bottom: String(Math.max(1, Math.ceil((data.countdownMs || 0) / 1000))),
      };
    }
    if (data.state === 'running') {
      return {
        top: 'MATCH TIME',
        bottom: formatClock(data.runElapsedMs),
      };
    }
    if (data.state === 'lobby') {
      return {
        top: 'IN LOBBY',
        bottom: data.mode === 'network' ? `ROOM ${data.roomId}` : 'READY TO START',
      };
    }
    if (data.state === 'finished') {
      const winnerLabel = typeof data.winner === 'number' ? `PLAYER ${data.winner + 1} WINS` : 'MATCH COMPLETE';
      return { top: 'FINAL', bottom: winnerLabel };
    }
    return { top: 'CROSSFIRE', bottom: '' };
  }

  // Top match banner.
  roundedRectPath(280, 8, 640, 46, 14);
  const topGrad = ctx.createLinearGradient(280, 8, 280, 44);
  topGrad.addColorStop(0, 'rgba(21, 45, 62, 0.7)');
  topGrad.addColorStop(1, 'rgba(15, 32, 45, 0.7)');
  ctx.fillStyle = topGrad;
  ctx.fill();
  ctx.strokeStyle = 'rgba(130, 188, 221, 0.24)';
  ctx.lineWidth = 1;
  ctx.stroke();

  drawScoreCard(18, 10, 180, 44, 'PLAYER 1', data.players[0].score, '#6ac6ec');
  drawScoreCard(1002, 10, 180, 44, 'PLAYER 2', data.players[1].score, '#ef9575');

  roundedRectPath(492, 10, 216, 44, 10);
  const midGrad = ctx.createLinearGradient(520, 10, 520, 42);
  midGrad.addColorStop(0, 'rgba(28, 57, 76, 0.95)');
  midGrad.addColorStop(1, 'rgba(19, 40, 55, 0.95)');
  ctx.fillStyle = midGrad;
  ctx.fill();
  ctx.strokeStyle = 'rgba(131, 190, 223, 0.28)';
  ctx.stroke();

  const badge = getCenterBadgeText();
  ctx.fillStyle = '#8eb2c7';
  ctx.font = '600 10px "Space Grotesk", "Trebuchet MS", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(badge.top, 600, 28);
  ctx.fillStyle = '#e7f5ff';
  ctx.font = '700 15px "Space Grotesk", "Trebuchet MS", sans-serif';
  ctx.fillText(badge.bottom, 600, 46);

  const barW = 220;
  const barH = 14;
  const leftX = 34;
  const rightX = 1200 - barW - 34;
  const topY = 648;
  const gap = 22;
  const p1 = data.players[0];
  const p2 = data.players[1];

  drawBar(leftX, topY, barW, barH, p1.mag, MAG_MAX, getMagColor(p1.mag));
  drawBar(leftX, topY + gap, barW, barH, p1.bin, BIN_MAX, '#6ac6ec');
  drawBarValue(leftX, topY, barH, p1.mag);
  drawBarValue(leftX, topY + gap, barH, p1.bin);
  drawBarMax(leftX, topY, barW, barH, MAG_MAX);
  drawBarMax(leftX, topY + gap, barW, barH, BIN_MAX);

  drawBar(rightX, topY, barW, barH, p2.mag, MAG_MAX, getMagColor(p2.mag));
  drawBar(rightX, topY + gap, barW, barH, p2.bin, BIN_MAX, '#ef9575');
  drawBarValue(rightX, topY, barH, p2.mag);
  drawBarValue(rightX, topY + gap, barH, p2.bin);
  drawBarMax(rightX, topY, barW, barH, MAG_MAX);
  drawBarMax(rightX, topY + gap, barW, barH, BIN_MAX);

  ctx.fillStyle = '#8fb2c6';
  ctx.font = '600 12px "Space Grotesk", "Trebuchet MS", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Loaded Ammo', 600, topY + barH - 1);
  ctx.fillText('Reload Ammo', 600, topY + gap + barH - 1);

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
  drawGunBubbles();
  drawScoreFlares(board);
  drawHUD(data);
}

function renderIdleCanvas() {
  const idle = {
    board: IDLE_BOARD,
    state: 'lobby',
    mode: 'single',
    roomId: '',
    players: [
      { score: 0, mag: 0, bin: 0, reloading: false },
      { score: 0, mag: 0, bin: 0, reloading: false },
    ],
    countdownMs: 0,
    runElapsedMs: 0,
  };

  drawBoard(idle.board);
  drawHUD(idle);

  ctx.fillStyle = 'rgba(7, 18, 27, 0.52)';
  ctx.fillRect(330, 315, 540, 70);
  ctx.strokeStyle = 'rgba(158, 203, 229, 0.35)';
  ctx.lineWidth = 1;
  ctx.strokeRect(330, 315, 540, 70);

  ctx.fillStyle = '#d8ebf9';
  ctx.font = '700 24px "Space Grotesk", "Trebuchet MS", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Create or join a match to begin.', canvas.width / 2, 360);
}

setInterval(sendInputTick, 50);
setInterval(pollStateTick, 50);
setInterval(searchOpenRooms, 5000);

renderSetupMode();
updateActionButtons(null);
renderIdleCanvas();
searchOpenRooms();
