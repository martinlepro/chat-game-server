// ═══════════════════════════════════════════════════════
//  GameApp Server v3.0 — Node.js + WebSocket
//  Deploy on Render.com (Free tier)
//  Supports: TTT, Quiz, Agar, Draw&Guess, Tag, Giant-TTT
// ═══════════════════════════════════════════════════════
'use strict';
const http = require('http');
const WebSocket = require('ws');
const PORT = process.env.PORT || 8080;
const SERVER_VERSION = '3.0.0';
const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'ok',
    version: SERVER_VERSION,
    rooms: rooms.size,
    clients: clients.size,
    ts: new Date().toISOString()
  }));
});
const wss = new WebSocket.Server({ server: httpServer });
// ── State ────────────────────────────────────────────────
const rooms   = new Map();   // roomId → Room
const clients = new Map();   // ws → ClientInfo
let nextRoomId = 1000;
// ── Helpers ─────────────────────────────────────────────
function send(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(obj)); } catch (_) {}
  }
}
function generateId() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}
// ── Room class ───────────────────────────────────────────
class Room {
  constructor(id, gameType, hostName) {
    this.id        = id;
    this.gameType  = gameType;
    this.hostName  = hostName;
    this.players   = [];   // ws references
    this.state     = {};
    this.created   = Date.now();
    this.lastActivity = Date.now();
  }
  maxPlayers() {
    switch (this.gameType) {
      case 'ttt':       return 2;
      case 'quiz':      return 12;
      case 'agar':      return 20;
      case 'draw':      return 10;
      case 'tag':       return 16;
      case 'giant_ttt': return 2;
      default:          return 4;
    }
  }
  isFull() { return this.players.length >= this.maxPlayers(); }
  broadcast(msg, exclude = null) {
    const data = JSON.stringify(msg);
    this.players.forEach(ws => {
      if (ws !== exclude && ws.readyState === WebSocket.OPEN) {
        try { ws.send(data); } catch (_) {}
      }
    });
  }
  broadcastAll(msg) { this.broadcast(msg, null); }
  removePlayer(ws) {
    this.players = this.players.filter(p => p !== ws);
  }
  touch() { this.lastActivity = Date.now(); }
}
// ═══════════════════════════════════════════════════════
//  GAME LOGIC
// ═══════════════════════════════════════════════════════
// ── Tic-Tac-Toe ─────────────────────────────────────────
function initTTT(room) {
  room.state = { board: Array(9).fill(null), turn: 'X', winner: null, moves: 0 };
}
function playTTT(room, ws, { index }) {
  const s = room.state;
  if (s.winner || s.board[index] !== null || typeof index !== 'number') return;
  const playerIdx = room.players.indexOf(ws);
  if (playerIdx < 0) return;
  if ((s.turn === 'X' && playerIdx !== 0) || (s.turn === 'O' && playerIdx !== 1)) return;
  s.board[index] = s.turn;
  s.moves++;
  s.winner = checkTTTWinner(s.board);
  if (!s.winner && s.moves === 9) s.winner = 'draw';
  s.turn = s.turn === 'X' ? 'O' : 'X';
  room.broadcastAll({ type: 'ttt_state', state: s });
}
function checkTTTWinner(b) {
  const lines = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
  for (const [a, b2, c] of lines) {
    if (b[a] && b[a] === b[b2] && b[a] === b[c]) return b[a];
  }
  return null;
}
// ── Giant TTT (5-in-a-row on 20x20) ─────────────────────
function initGiantTTT(room) {
  const SIZE = 20;
  room.state = {
    board: Array(SIZE * SIZE).fill(null),
    size: SIZE,
    turn: 'X',
    winner: null,
    lastMove: -1
  };
}
function playGiantTTT(room, ws, { index }) {
  const s = room.state;
  if (s.winner || s.board[index] !== null || typeof index !== 'number') return;
  const playerIdx = room.players.indexOf(ws);
  if ((s.turn === 'X' && playerIdx !== 0) || (s.turn === 'O' && playerIdx !== 1)) return;
  s.board[index] = s.turn;
  s.lastMove = index;
  s.winner = checkFiveInRow(s.board, s.size, index, s.turn);
  s.turn = s.turn === 'X' ? 'O' : 'X';
  room.broadcastAll({ type: 'giant_ttt_state', state: { board: s.board, turn: s.turn, winner: s.winner, lastMove: s.lastMove } });
}
function checkFiveInRow(board, size, idx, mark) {
  const row = Math.floor(idx / size), col = idx % size;
  const dirs = [[0,1],[1,0],[1,1],[1,-1]];
  for (const [dr, dc] of dirs) {
    let count = 1;
    for (let d = 1; d <= 4; d++) {
      const r = row + dr*d, c = col + dc*d;
      if (r < 0 || r >= size || c < 0 || c >= size || board[r*size+c] !== mark) break;
      count++;
    }
    for (let d = 1; d <= 4; d++) {
      const r = row - dr*d, c = col - dc*d;
      if (r < 0 || r >= size || c < 0 || c >= size || board[r*size+c] !== mark) break;
      count++;
    }
    if (count >= 5) return mark;
  }
  return null;
}
// ── Quiz ─────────────────────────────────────────────────
const QUIZ_QUESTIONS = [
  { q: "Capitale de la France ?",           opts: ["Paris","Lyon","Marseille","Bordeaux"],         ans: 0 },
  { q: "Combien font 7 × 8 ?",              opts: ["54","56","58","52"],                           ans: 1 },
  { q: "Révolution française — année ?",    opts: ["1776","1789","1800","1815"],                   ans: 1 },
  { q: "Plus grand océan ?",               opts: ["Atlantique","Arctique","Pacifique","Indien"],   ans: 2 },
  { q: "Planète la plus proche du Soleil ?",opts: ["Vénus","Mercure","Mars","Terre"],              ans: 1 },
  { q: "Qui a peint la Joconde ?",          opts: ["Picasso","Michel-Ange","Da Vinci","Raphaël"],  ans: 2 },
  { q: "Symbole chimique de l'Or ?",        opts: ["Ag","Au","Al","Cu"],                           ans: 1 },
  { q: "Côtés d'un hexagone ?",            opts: ["5","7","6","8"],                               ans: 2 },
  { q: "Vitesse de la lumière (km/s) ?",   opts: ["150 000","299 792","500 000","100 000"],       ans: 1 },
  { q: "Vainqueur Coupe du Monde 2018 ?",  opts: ["Brésil","Argentine","France","Allemagne"],     ans: 2 },
  { q: "Auteur de Hamlet ?",               opts: ["Molière","Shakespeare","Hugo","Racine"],       ans: 1 },
  { q: "Capitale du Japon ?",              opts: ["Osaka","Kyoto","Tokyo","Hiroshima"],           ans: 2 },
  { q: "Planète la plus grande du système solaire ?",opts:["Saturne","Jupiter","Neptune","Uranus"],ans:1},
  { q: "Distance Terre-Lune (km) ?",       opts: ["180 000","384 400","500 000","100 000"],       ans: 1 },
  { q: "Monnaie du Royaume-Uni ?",         opts: ["Euro","Dollar","Livre Sterling","Franc"],      ans: 2 },
  { q: "Combien de dents a un adulte (dents de sagesse incluses) ?", opts:["28","30","32","36"],  ans: 2 },
  { q: "Qui a inventé le téléphone ?",     opts:["Edison","Bell","Tesla","Morse"],                ans: 1 },
  { q: "Année de la Révolution américaine ?",opts:["1776","1789","1800","1756"],                  ans: 0 },
  { q: "Plus long fleuve du monde ?",      opts:["Amazone","Mississippi","Nil","Yangtsé"],        ans: 2 },
  { q: "Formule chimique de l'eau ?",      opts:["H2O","CO2","NaCl","O2"],                       ans: 0 }
];
function initQuiz(room) {
  room.state = {
    scores: {},
    questionIdx: 0,
    phase: 'lobby',  // lobby | question | reveal | end
    answers: {},
    timer: null
  };
  room.players.forEach(ws => {
    const info = clients.get(ws);
    if (info) room.state.scores[info.name] = 0;
  });
}
function startQuizRound(room) {
  const s = room.state;
  if (s.questionIdx >= QUIZ_QUESTIONS.length) {
    s.phase = 'end';
    clearTimeout(s.timer);
    room.broadcastAll({ type: 'quiz_end', scores: s.scores });
    return;
  }
  s.answers = {};
  s.phase = 'question';
  const q = QUIZ_QUESTIONS[s.questionIdx];
  room.broadcastAll({
    type: 'quiz_question',
    question: q.q, options: q.opts,
    idx: s.questionIdx, total: QUIZ_QUESTIONS.length,
    timeMs: 12000
  });
  clearTimeout(s.timer);
  s.timer = setTimeout(() => revealQuizAnswer(room), 12000);
}
function answerQuiz(room, ws, { answer }) {
  const s = room.state;
  if (s.phase !== 'question') return;
  const info = clients.get(ws);
  if (!info || s.answers[info.name] !== undefined) return;
  s.answers[info.name] = answer;
  send(ws, { type: 'quiz_answered', answer });
  if (Object.keys(s.answers).length === room.players.length) {
    clearTimeout(s.timer);
    revealQuizAnswer(room);
  }
}
function revealQuizAnswer(room) {
  const s = room.state;
  s.phase = 'reveal';
  const q = QUIZ_QUESTIONS[s.questionIdx];
  Object.entries(s.answers).forEach(([name, ans]) => {
    if (ans === q.ans) s.scores[name] = (s.scores[name] || 0) + 100;
  });
  room.broadcastAll({ type: 'quiz_reveal', correct: q.ans, scores: s.scores, answers: s.answers });
  s.questionIdx++;
  clearTimeout(s.timer);
  s.timer = setTimeout(() => startQuizRound(room), 3500);
}
// ── Agar Clone ───────────────────────────────────────────
function initAgar(room) {
  room.state = {
    balls: {},
    food: [],
    worldSize: 2000
  };
  for (let i = 0; i < 80; i++) spawnFood(room.state, i);
}
function spawnFood(state, id) {
  state.food.push({
    x: Math.random() * state.worldSize,
    y: Math.random() * state.worldSize,
    id: id ?? generateId()
  });
}
function updateAgar(room, ws, { x, y, r }) {
  const info = clients.get(ws);
  if (!info) return;
  const s = room.state;
  const safR = Math.max(10, Math.min(r || 20, 500));
  s.balls[info.name] = { x, y, r: safR, name: info.name };
  // Food collision
  const eaten = [];
  s.food = s.food.filter(f => {
    const dx = f.x - x, dy = f.y - y;
    if (Math.sqrt(dx*dx + dy*dy) < safR) { eaten.push(f.id); return false; }
    return true;
  });
  while (s.food.length < 80) spawnFood(s);
  room.broadcastAll({ type: 'agar_state', balls: s.balls, food: s.food });
}
// ── Draw & Guess ─────────────────────────────────────────
const DRAW_WORDS = [
  'maison','chat','chien','voiture','arbre','soleil','lune','étoile','bateau','avion',
  'pizza','robot','dragon','château','sirène','fusée','dinosaure','arc-en-ciel','guitare','cactus'
];
function initDraw(room) {
  room.state = {
    phase: 'lobby', // lobby | drawing | reveal
    word: null,
    drawer: null,
    drawerIdx: 0,
    scores: {},
    strokes: [],
    roundTime: 60000,
    timer: null,
    round: 0,
    maxRounds: Math.min(room.players.length * 2, 10)
  };
  room.players.forEach(ws => {
    const info = clients.get(ws);
    if (info) room.state.scores[info.name] = 0;
  });
}
function startDrawRound(room) {
  const s = room.state;
  if (s.round >= s.maxRounds || room.players.length < 2) {
    room.broadcastAll({ type: 'draw_end', scores: s.scores });
    return;
  }
  s.drawerIdx = s.round % room.players.length;
  s.drawer = room.players[s.drawerIdx];
  s.word = DRAW_WORDS[Math.floor(Math.random() * DRAW_WORDS.length)];
  s.strokes = [];
  s.phase = 'drawing';
  s.guessed = {};
  s.round++;
  const drawerInfo = clients.get(s.drawer);
  // Tell drawer the word
  send(s.drawer, { type: 'draw_your_turn', word: s.word, round: s.round, maxRounds: s.maxRounds });
  // Tell others it started (masked word)
  room.broadcast({
    type: 'draw_start',
    drawer: drawerInfo ? drawerInfo.name : '?',
    wordLen: s.word.length,
    round: s.round,
    maxRounds: s.maxRounds
  }, s.drawer);
  clearTimeout(s.timer);
  s.timer = setTimeout(() => revealDraw(room), s.roundTime);
}
function handleDrawStroke(room, ws, { stroke }) {
  const s = room.state;
  if (ws !== s.drawer || s.phase !== 'drawing') return;
  s.strokes.push(stroke);
  room.broadcast({ type: 'draw_stroke', stroke }, ws);
}
function handleDrawGuess(room, ws, { guess }) {
  const s = room.state;
  if (s.phase !== 'drawing' || ws === s.drawer) return;
  const info = clients.get(ws);
  if (!info || s.guessed[info.name]) return;
  const correct = guess.trim().toLowerCase() === s.word.toLowerCase();
  if (correct) {
    s.guessed[info.name] = true;
    const points = Math.max(10, 100 - Math.floor((Date.now() - s.roundStart) / 1000) * 2);
    s.scores[info.name] = (s.scores[info.name] || 0) + points;
    room.broadcastAll({ type: 'draw_correct', name: info.name, scores: s.scores });
    if (Object.keys(s.guessed).length >= room.players.length - 1) {
      clearTimeout(s.timer);
      revealDraw(room);
    }
  } else {
    room.broadcastAll({ type: 'draw_guess', name: info.name, guess: guess.substring(0, 30) });
  }
}
function revealDraw(room) {
  const s = room.state;
  s.phase = 'reveal';
  room.broadcastAll({ type: 'draw_reveal', word: s.word, scores: s.scores });
  clearTimeout(s.timer);
  s.timer = setTimeout(() => startDrawRound(room), 5000);
}
// ── Tag (Chat & Souris) ──────────────────────────────────
function initTag(room) {
  room.state = { positions: {}, it: null, itName: null, scores: {}, started: false };
  room.players.forEach(ws => {
    const info = clients.get(ws);
    if (!info) return;
    room.state.positions[info.name] = {
      x: Math.random() * 800, y: Math.random() * 600
    };
    room.state.scores[info.name] = 0;
  });
}
function startTag(room) {
  const s = room.state;
  const firstPlayer = room.players[0];
  const info = clients.get(firstPlayer);
  s.it = firstPlayer;
  s.itName = info ? info.name : 'it';
  s.started = true;
  room.broadcastAll({ type: 'tag_state', positions: s.positions, it: s.itName, scores: s.scores });
}
function updateTagPosition(room, ws, { x, y }) {
  const s = room.state;
  if (!s.started) return;
  const info = clients.get(ws);
  if (!info) return;
  s.positions[info.name] = { x, y };
  // Check if 'it' catches someone
  if (ws === s.it) {
    const itPos = s.positions[info.name];
    room.players.forEach(other => {
      if (other === ws) return;
      const otherInfo = clients.get(other);
      if (!otherInfo) return;
      const op = s.positions[otherInfo.name];
      if (!op) return;
      const dx = op.x - itPos.x, dy = op.y - itPos.y;
      if (Math.sqrt(dx*dx + dy*dy) < 30) {
        // Tag! new 'it' is the caught player
        s.scores[info.name] = (s.scores[info.name] || 0) + 1;
        s.it = other;
        s.itName = otherInfo.name;
        room.broadcastAll({ type: 'tag_tagged', newIt: otherInfo.name, tagger: info.name });
      }
    });
  }
  room.broadcastAll({ type: 'tag_state', positions: s.positions, it: s.itName, scores: s.scores });
}
// ═══════════════════════════════════════════════════════
//  CONNECTION HANDLING
// ═══════════════════════════════════════════════════════
wss.on('connection', (ws, req) => {
  const defaultName = 'Joueur_' + Math.floor(Math.random() * 9999);
  clients.set(ws, { name: defaultName, room: null });
  console.log(`[+] Connected: ${defaultName}  (total: ${clients.size})`);
  send(ws, { type: 'welcome', version: SERVER_VERSION, ts: Date.now(), name: defaultName });
  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    const info = clients.get(ws);
    if (!info) return;
    try {
      handleMessage(ws, info, msg);
    } catch (err) {
      console.error('[msg error]', err.message);
      send(ws, { type: 'error', msg: 'Erreur interne du serveur' });
    }
  });
  ws.on('close', () => handleDisconnect(ws));
  ws.on('error', err => console.error('[ws error]', err.message));
});
function handleMessage(ws, info, msg) {
  switch (msg.type) {
    // ── Identity ──────────────────────────────────────
    case 'set_name': {
      const name = String(msg.name || '').replace(/[^a-zA-Z0-9_\- éàèùâêîôûäëïöü]/g, '').substring(0, 20);
      if (!name) return;
      info.name = name;
      send(ws, { type: 'name_set', name });
      break;
    }
    // ── Room Management ───────────────────────────────
    case 'create_room': {
      const gameType = String(msg.game || 'ttt');
      const room = new Room(nextRoomId++, gameType, info.name);
      room.players.push(ws);
      info.room = room.id;
      rooms.set(room.id, room);
      // Init game state
      switch (gameType) {
        case 'ttt':       initTTT(room); break;
        case 'giant_ttt': initGiantTTT(room); break;
        case 'quiz':      initQuiz(room); break;
        case 'agar':      initAgar(room); break;
        case 'draw':      initDraw(room); break;
        case 'tag':       initTag(room); break;
      }
      send(ws, { type: 'room_created', roomId: room.id, game: gameType });
      console.log(`[room] Created #${room.id} (${gameType}) by ${info.name}`);
      break;
    }
    case 'join_room': {
      const roomId = parseInt(msg.roomId);
      const room = rooms.get(roomId);
      if (!room) { send(ws, { type: 'error', msg: 'Salle introuvable' }); return; }
      if (room.isFull()) { send(ws, { type: 'error', msg: 'Salle pleine' }); return; }
      if (room.players.includes(ws)) return; // already in
      room.players.push(ws);
      info.room = room.id;
      room.touch();
      // Update game state for late joiners
      if (room.gameType === 'quiz' && room.state.scores) room.state.scores[info.name] = 0;
      if (room.gameType === 'agar' && room.state.balls) {
        room.state.balls[info.name] = { x: Math.random()*2000, y: Math.random()*2000, r: 20, name: info.name };
      }
      if (room.gameType === 'tag' && room.state.positions) {
        room.state.positions[info.name] = { x: Math.random()*800, y: Math.random()*600 };
        room.state.scores[info.name] = 0;
      }
      if (room.gameType === 'draw' && room.state.scores) room.state.scores[info.name] = 0;
      send(ws, {
        type: 'joined', roomId: room.id, game: room.gameType,
        playerIdx: room.players.length - 1,
        playerCount: room.players.length
      });
      room.broadcast({ type: 'player_joined', name: info.name, count: room.players.length }, ws);
      // Auto-start logic
      if (room.gameType === 'ttt' && room.players.length === 2) {
        room.broadcastAll({ type: 'ttt_start', state: room.state, players: getPlayerNames(room) });
      }
      if (room.gameType === 'giant_ttt' && room.players.length === 2) {
        room.broadcastAll({ type: 'giant_ttt_start', size: room.state.size, players: getPlayerNames(room) });
      }
      break;
    }
    case 'list_rooms': {
      const list = [];
      rooms.forEach(r => {
        if (!r.isFull()) {
          list.push({ id: r.id, game: r.gameType, players: r.players.length, max: r.maxPlayers(), host: r.hostName });
        }
      });
      send(ws, { type: 'rooms_list', rooms: list });
      break;
    }
    case 'leave_room': {
      handleDisconnect(ws, true);
      break;
    }
    // ── Game Actions ──────────────────────────────────
    case 'ttt_play': {
      const room = getPlayerRoom(ws, info);
      if (room && room.gameType === 'ttt') { room.touch(); playTTT(room, ws, msg); }
      break;
    }
    case 'ttt_restart': {
      const room = getPlayerRoom(ws, info);
      if (room && room.gameType === 'ttt' && room.players.length === 2) {
        initTTT(room);
        room.broadcastAll({ type: 'ttt_start', state: room.state, players: getPlayerNames(room) });
      }
      break;
    }
    case 'giant_ttt_play': {
      const room = getPlayerRoom(ws, info);
      if (room && room.gameType === 'giant_ttt') { room.touch(); playGiantTTT(room, ws, msg); }
      break;
    }
    case 'start_quiz': {
      const room = getPlayerRoom(ws, info);
      if (room && room.gameType === 'quiz' && room.players.length >= 1) {
        room.touch();
        if (room.state.phase === 'lobby' || !room.state.phase) {
          room.state.questionIdx = 0;
          room.state.scores = {};
          room.players.forEach(p => { const pi = clients.get(p); if (pi) room.state.scores[pi.name] = 0; });
          startQuizRound(room);
        }
      }
      break;
    }
    case 'quiz_answer': {
      const room = getPlayerRoom(ws, info);
      if (room && room.gameType === 'quiz') { room.touch(); answerQuiz(room, ws, msg); }
      break;
    }
    case 'agar_update': {
      const room = getPlayerRoom(ws, info);
      if (room && room.gameType === 'agar') updateAgar(room, ws, msg);
      break;
    }
    case 'draw_stroke': {
      const room = getPlayerRoom(ws, info);
      if (room && room.gameType === 'draw') { room.touch(); handleDrawStroke(room, ws, msg); }
      break;
    }
    case 'draw_guess': {
      const room = getPlayerRoom(ws, info);
      if (room && room.gameType === 'draw') { room.touch(); handleDrawGuess(room, ws, msg); }
      break;
    }
    case 'start_draw': {
      const room = getPlayerRoom(ws, info);
      if (room && room.gameType === 'draw' && room.players.length >= 2) {
        room.touch(); startDrawRound(room);
      }
      break;
    }
    case 'start_tag': {
      const room = getPlayerRoom(ws, info);
      if (room && room.gameType === 'tag' && room.players.length >= 2) {
        room.touch(); startTag(room);
      }
      break;
    }
    case 'tag_move': {
      const room = getPlayerRoom(ws, info);
      if (room && room.gameType === 'tag') updateTagPosition(room, ws, msg);
      break;
    }
    case 'chat': {
      const room = getPlayerRoom(ws, info);
      if (room) {
        const text = String(msg.text || '').substring(0, 200);
        room.broadcast({ type: 'chat', name: info.name, msg: text, ts: Date.now() }, ws);
      }
      break;
    }
    case 'ping':
      send(ws, { type: 'pong', ts: Date.now() });
      break;
    default:
      // Unknown message type — silently ignore
      break;
  }
}
function getPlayerRoom(ws, info) {
  if (!info || !info.room) return null;
  return rooms.get(info.room) || null;
}
function getPlayerNames(room) {
  return room.players.map(ws => {
    const i = clients.get(ws);
    return i ? i.name : '?';
  });
}
function handleDisconnect(ws, gentle = false) {
  const info = clients.get(ws);
  if (!info) return;
  if (info.room != null) {
    const room = rooms.get(info.room);
    if (room) {
      room.removePlayer(ws);
      room.broadcast({ type: 'player_left', name: info.name, count: room.players.length });
      // Clean up agar / tag state
      if (room.state.balls) delete room.state.balls[info.name];
      if (room.state.positions) delete room.state.positions[info.name];
      // Delete empty rooms
      if (room.players.length === 0) {
        clearTimeout(room.state.timer);
        rooms.delete(room.id);
        console.log(`[room] Deleted #${room.id} (empty)`);
      }
    }
  }
  if (!gentle) clients.delete(ws);
  else info.room = null;
  console.log(`[-] Disconnected: ${info.name}  (total: ${clients.size})`);
}
// ── Cleanup ──────────────────────────────────────────────
// Delete empty or stale rooms every 5 minutes
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  rooms.forEach((room, id) => {
    if (room.players.length === 0 || now - room.lastActivity > 30 * 60 * 1000) {
      clearTimeout(room.state.timer);
      rooms.delete(id);
      cleaned++;
    }
  });
  if (cleaned > 0) console.log(`[cleanup] Removed ${cleaned} stale rooms`);
}, 5 * 60 * 1000);
// ── Start ─────────────────────────────────────────────────
httpServer.listen(PORT, () => {
  console.log(`🎮 GameApp Server v${SERVER_VERSION} running on port ${PORT}`);
  console.log(`   Supported games: ttt, giant_ttt, quiz, agar, draw, tag`);
});
