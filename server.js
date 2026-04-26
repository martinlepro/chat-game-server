// ═══════════════════════════════════════════════════════
//  GameApp Server — Node.js + WebSocket
//  Deploy on Render.com (Free tier)
//  All 15+ online games backend
// ═══════════════════════════════════════════════════════
const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const server = http.createServer((req, res) => {
  res.writeHead(200, {'Content-Type': 'text/plain'});
  res.end('GameApp Server Running — ' + new Date().toISOString());
});

const wss = new WebSocket.Server({ server });

// ── State ────────────────────────────────────────────────
const rooms = new Map();     // roomId → Room
const clients = new Map();   // ws → ClientInfo
let nextRoomId = 1000;

class Room {
  constructor(id, gameType) {
    this.id = id;
    this.gameType = gameType;
    this.players = [];
    this.state = {};
    this.created = Date.now();
  }
  isFull() { return this.players.length >= this.maxPlayers(); }
  maxPlayers() {
    switch (this.gameType) {
      case 'ttt': return 2;
      case 'quiz': return 8;
      case 'agar': return 16;
      default: return 4;
    }
  }
  broadcast(msg, exclude = null) {
    const data = JSON.stringify(msg);
    this.players.forEach(ws => { if (ws !== exclude && ws.readyState === WebSocket.OPEN) ws.send(data); });
  }
  broadcastAll(msg) {
    const data = JSON.stringify(msg);
    this.players.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(data); });
  }
}

// ── Tic-Tac-Toe State ────────────────────────────────────
function initTTT(room) {
  room.state = { board: Array(9).fill(null), turn: 'X', winner: null };
}

function playTTT(room, ws, { index }) {
  const s = room.state;
  const info = clients.get(ws);
  if (s.winner || s.board[index] !== null) return;
  if ((s.turn === 'X' && room.players[0] !== ws) ||
      (s.turn === 'O' && room.players[1] !== ws)) return;
  s.board[index] = s.turn;
  s.winner = checkTTTWinner(s.board);
  s.turn = s.turn === 'X' ? 'O' : 'X';
  room.broadcastAll({ type: 'ttt_state', state: s });
}

function checkTTTWinner(b) {
  const lines = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
  for (const [a,b2,c] of lines) { if (b[a] && b[a] === b[b2] && b[a] === b[c]) return b[a]; }
  if (b.every(x => x !== null)) return 'draw';
  return null;
}

// ── Quiz State ───────────────────────────────────────────
const QUIZ_QUESTIONS = [
  { q: "Quelle est la capitale de la France ?", opts: ["Paris","Lyon","Marseille","Bordeaux"], ans: 0 },
  { q: "Combien font 7 × 8 ?", opts: ["54","56","58","52"], ans: 1 },
  { q: "En quelle année a eu lieu la Révolution française ?", opts: ["1776","1789","1800","1815"], ans: 1 },
  { q: "Quel est le plus grand océan ?", opts: ["Atlantique","Arctique","Pacifique","Indien"], ans: 2 },
  { q: "Quelle planète est la plus proche du Soleil ?", opts: ["Vénus","Mercure","Mars","Terre"], ans: 1 },
  { q: "Qui a peint la Joconde ?", opts: ["Picasso","Michel-Ange","Da Vinci","Raphaël"], ans: 2 },
  { q: "Quel est l'élément chimique de symbole Au ?", opts: ["Argent","Or","Aluminium","Cuivre"], ans: 1 },
  { q: "Combien de côtés a un hexagone ?", opts: ["5","7","6","8"], ans: 2 },
  { q: "Quelle est la vitesse de la lumière (km/s) ?", opts: ["150 000","299 792","500 000","100 000"], ans: 1 },
  { q: "Quel pays a remporté la Coupe du Monde 2018 ?", opts: ["Brésil","Argentine","France","Allemagne"], ans: 2 }
];

function startQuizRound(room) {
  room.state.questionIdx = (room.state.questionIdx || 0);
  if (room.state.questionIdx >= QUIZ_QUESTIONS.length) {
    room.broadcastAll({ type: 'quiz_end', scores: room.state.scores });
    return;
  }
  room.state.answers = {};
  const q = QUIZ_QUESTIONS[room.state.questionIdx];
  room.broadcastAll({ type: 'quiz_question', question: q.q, options: q.opts, idx: room.state.questionIdx, total: QUIZ_QUESTIONS.length });
  room.state.timer = setTimeout(() => revealQuizAnswer(room), 10000);
}

function answerQuiz(room, ws, { answer }) {
  const s = room.state;
  const info = clients.get(ws);
  if (s.answers[info.name]) return;
  s.answers[info.name] = { answer, time: Date.now() };
  ws.send(JSON.stringify({ type: 'quiz_answered' }));
  if (Object.keys(s.answers).length === room.players.length) {
    clearTimeout(s.timer); revealQuizAnswer(room);
  }
}

function revealQuizAnswer(room) {
  const q = QUIZ_QUESTIONS[room.state.questionIdx];
  const correct = q.ans;
  Object.entries(room.state.answers).forEach(([name, { answer }]) => {
    if (answer === correct) room.state.scores[name] = (room.state.scores[name] || 0) + 100;
  });
  room.broadcastAll({ type: 'quiz_reveal', correct, scores: room.state.scores, answers: room.state.answers });
  room.state.questionIdx++;
  setTimeout(() => startQuizRound(room), 3000);
}

// ── Agar Clone State ─────────────────────────────────────
function initAgar(room) {
  room.state = { balls: {}, food: [] };
  for (let i = 0; i < 50; i++) {
    room.state.food.push({ x: Math.random()*2000, y: Math.random()*2000, id: i });
  }
}

function updateAgarPlayer(room, ws, { x, y, r }) {
  const info = clients.get(ws);
  const s = room.state;
  s.balls[info.name] = { x, y, r: r || 20, name: info.name };

  // Check food eaten
  const eaten = [];
  s.food = s.food.filter(f => {
    const dx = f.x - x; const dy = f.y - y;
    if (Math.sqrt(dx*dx+dy*dy) < r) { eaten.push(f.id); return false; }
    return true;
  });
  if (eaten.length > 0) {
    while (s.food.length < 50) s.food.push({ x: Math.random()*2000, y: Math.random()*2000, id: Date.now()+Math.random() });
  }

  room.broadcastAll({ type: 'agar_state', balls: s.balls, food: s.food });
}

// ── Connection Handling ──────────────────────────────────
wss.on('connection', (ws) => {
  clients.set(ws, { name: 'Player_' + Math.floor(Math.random()*9999), room: null });
  console.log('Client connected. Total:', clients.size);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch(e) { return; }
    const info = clients.get(ws);

    switch (msg.type) {
      // ── Identity ──
      case 'set_name':
        info.name = msg.name.substring(0, 20);
        ws.send(JSON.stringify({ type: 'name_set', name: info.name }));
        break;

      // ── Room Management ──
      case 'create_room': {
        const room = new Room(nextRoomId++, msg.game);
        room.players.push(ws);
        info.room = room.id;
        rooms.set(room.id, room);
        if (msg.game === 'ttt') initTTT(room);
        if (msg.game === 'quiz') { room.state = { scores: {}, questionIdx: 0 }; room.state.scores[info.name] = 0; }
        if (msg.game === 'agar') initAgar(room);
        ws.send(JSON.stringify({ type: 'room_created', roomId: room.id, game: msg.game }));
        console.log(`Room ${room.id} created for game ${msg.game}`);
        break;
      }

      case 'join_room': {
        const room = rooms.get(parseInt(msg.roomId));
        if (!room) { ws.send(JSON.stringify({ type: 'error', msg: 'Salle introuvable' })); return; }
        if (room.isFull()) { ws.send(JSON.stringify({ type: 'error', msg: 'Salle pleine' })); return; }
        room.players.push(ws);
        info.room = room.id;
        if (room.gameType === 'quiz') room.state.scores[info.name] = 0;
        ws.send(JSON.stringify({ type: 'joined', roomId: room.id, game: room.gameType, playerIdx: room.players.length - 1 }));
        room.broadcast({ type: 'player_joined', name: info.name, count: room.players.length }, ws);

        // Auto-start
        if (room.gameType === 'ttt' && room.players.length === 2) {
          room.broadcastAll({ type: 'ttt_start', state: room.state });
        }
        break;
      }

      case 'list_rooms': {
        const list = [];
        rooms.forEach(r => { if (!r.isFull()) list.push({ id: r.id, game: r.gameType, players: r.players.length, max: r.maxPlayers() }); });
        ws.send(JSON.stringify({ type: 'rooms_list', rooms: list }));
        break;
      }

      case 'start_quiz': {
        const room = rooms.get(info.room);
        if (room && room.gameType === 'quiz') startQuizRound(room);
        break;
      }

      // ── Game Actions ──
      case 'ttt_play': {
        const room = rooms.get(info.room);
        if (room) playTTT(room, ws, msg);
        break;
      }

      case 'quiz_answer': {
        const room = rooms.get(info.room);
        if (room) answerQuiz(room, ws, msg);
        break;
      }

      case 'agar_update': {
        const room = rooms.get(info.room);
        if (room) updateAgarPlayer(room, ws, msg);
        break;
      }

      case 'chat': {
        const room = rooms.get(info.room);
        if (room) room.broadcast({ type: 'chat', name: info.name, msg: msg.text.substring(0, 200) }, ws);
        break;
      }

      case 'ping':
        ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
        break;
    }
  });

  ws.on('close', () => {
    const info = clients.get(ws);
    if (info && info.room) {
      const room = rooms.get(info.room);
      if (room) {
        room.players = room.players.filter(p => p !== ws);
        room.broadcast({ type: 'player_left', name: info.name, count: room.players.length });
        if (room.players.length === 0) { rooms.delete(room.id); console.log(`Room ${room.id} deleted`); }
      }
    }
    clients.delete(ws);
    console.log('Client disconnected. Total:', clients.size);
  });

  ws.on('error', (err) => console.error('WS error:', err.message));

  // Welcome
  ws.send(JSON.stringify({ type: 'welcome', msg: 'GameApp Server v2.0', ts: Date.now() }));
});

// Cleanup old empty rooms every 10 min
setInterval(() => {
  const now = Date.now();
  rooms.forEach((room, id) => {
    if (room.players.length === 0 && now - room.created > 600000) rooms.delete(id);
  });
}, 600000);

server.listen(PORT, () => console.log(`🎮 GameApp Server running on port ${PORT}`));
