const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// ─── Stockage des parties ───────────────────────────────────────────────────
const games = {};

// ─── Utilitaires ────────────────────────────────────────────────────────────
function generateCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function getDistance(lat1, lon1, lat2, lon2) {
  const R = 6371e3;
  const p1 = lat1 * Math.PI / 180;
  const p2 = lat2 * Math.PI / 180;
  const dp = (lat2 - lat1) * Math.PI / 180;
  const dl = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function createPlayer(socketId, name) {
  return {
    id: socketId,
    name,
    role: 'waiting',         // 'waiting' | 'chat' | 'souris'
    lat: 0,
    lng: 0,
    timeLeft: 900,           // 15 minutes en secondes
    timerRunning: false,
    points: 100,
    frozen: false,
    immune: false,
    totalTags: 0,
    totalSurvived: 0,
    connected: true
  };
}

// ─── Bonus disponibles ──────────────────────────────────────────────────────
const BONUSES = {
  time_30:    { label: '⚡ -30 secondes',          cost: 20,  timeOff: 30,  effect: null },
  time_60:    { label: '🕐 -1 minute',             cost: 35,  timeOff: 60,  effect: null },
  time_120:   { label: '💎 -2 minutes',            cost: 60,  timeOff: 120, effect: null },
  freeze:     { label: '🧊 Geler tous les chats',  cost: 50,  timeOff: 0,   effect: 'freeze', duration: 8 },
  immunity:   { label: '🛡️ Immunité 10s',          cost: 40,  timeOff: 0,   effect: 'immunity', duration: 10 },
  mega:       { label: '🚀 Méga fuite (-30s+10s)', cost: 45,  timeOff: 30,  effect: 'immunity', duration: 10 }
};

// ─── Connexion d'un joueur ──────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`Joueur connecté : ${socket.id}`);

  // === Créer une partie ====================================================
  socket.on('create_game', ({ playerName, numCats }) => {
    const gameCode = generateCode();
    games[gameCode] = {
      code: gameCode,
      numCats: Math.max(1, parseInt(numCats) || 1),
      players: {},
      started: false,
      hostId: socket.id,
      timerInterval: null,
      tagLog: [],
      startTime: null
    };

    games[gameCode].players[socket.id] = createPlayer(socket.id, playerName || 'Joueur');
    socket.join(gameCode);
    socket.gameCode = gameCode;
    socket.playerName = playerName;

    socket.emit('game_created', { gameCode });
    io.to(gameCode).emit('game_state', sanitize(games[gameCode]));
    console.log(`Partie créée : ${gameCode}`);
  });

  // === Rejoindre une partie =================================================
  socket.on('join_game', ({ playerName, gameCode }) => {
    const game = games[gameCode];
    if (!game) { socket.emit('error', { message: 'Partie introuvable !' }); return; }
    if (game.started) { socket.emit('error', { message: 'Partie déjà commencée !' }); return; }
    if (Object.keys(game.players).length >= 20) { socket.emit('error', { message: 'Partie pleine !' }); return; }

    game.players[socket.id] = createPlayer(socket.id, playerName || 'Joueur');
    socket.join(gameCode);
    socket.gameCode = gameCode;
    socket.playerName = playerName;

    socket.emit('joined_game', { gameCode });
    io.to(gameCode).emit('game_state', sanitize(game));
    io.to(gameCode).emit('notification', { msg: `${playerName} a rejoint la partie !` });
    console.log(`${playerName} a rejoint ${gameCode}`);
  });

  // === Démarrer la partie ===================================================
  socket.on('start_game', () => {
    const gameCode = socket.gameCode;
    const game = games[gameCode];
    if (!game) return;
    if (socket.id !== game.hostId) { socket.emit('error', { message: 'Seul le créateur peut démarrer !' }); return; }

    const ids = Object.keys(game.players);
    if (ids.length < 2) { socket.emit('error', { message: 'Il faut au moins 2 joueurs !' }); return; }

    // Mélange et attribution des rôles
    const shuffled = [...ids].sort(() => Math.random() - 0.5);
    const numCats = Math.min(game.numCats, ids.length - 1);

    ids.forEach((id, i) => {
      const p = game.players[id];
      if (shuffled.indexOf(id) < numCats) {
        p.role = 'chat';
        p.timerRunning = false;
        p.timeLeft = 0;
      } else {
        p.role = 'souris';
        p.timerRunning = true;
        p.timeLeft = 900;
      }
      p.points = 100;
      p.totalTags = 0;
    });

    game.started = true;
    game.startTime = Date.now();
    io.to(gameCode).emit('game_started', sanitize(game));

    // ── Timer serveur (chaque seconde) ────────────────────────────────────
    game.timerInterval = setInterval(() => {
      if (!games[gameCode]) { clearInterval(game.timerInterval); return; }

      let allMiceCaught = true;

      Object.values(game.players).forEach(p => {
        if (p.role === 'souris') {
          if (p.timerRunning) {
            p.timeLeft = Math.max(0, p.timeLeft - 1);
            p.totalSurvived += 1;
            // Gagner des points en survivant
            if (p.totalSurvived % 10 === 0) p.points += 2;
            if (p.timeLeft > 0) allMiceCaught = false;
          }
        } else if (p.role === 'chat') {
          allMiceCaught = false;
        }
      });

      io.to(gameCode).emit('game_state', sanitize(game));

      if (allMiceCaught) {
        endGame(gameCode, 'chats');
      }
    }, 1000);
  });

  // === Mettre à jour la position ===========================================
  socket.on('update_location', ({ lat, lng }) => {
    const game = games[socket.gameCode];
    if (!game) return;
    const p = game.players[socket.id];
    if (p) { p.lat = lat; p.lng = lng; }

    // Alertes de proximité : avertir les souris si un chat est à < 50m
    if (p && p.role === 'chat') {
      Object.values(game.players).forEach(other => {
        if (other.role === 'souris' && other.timerRunning) {
          const dist = getDistance(p.lat, p.lng, other.lat, other.lng);
          if (dist < 50) {
            io.to(other.id).emit('proximity_alert', { distance: Math.round(dist), catName: p.name });
          }
        }
      });
    }
  });

  // === Tagger un joueur ====================================================
  socket.on('tag_attempt', () => {
    const gameCode = socket.gameCode;
    const game = games[gameCode];
    if (!game || !game.started) return;

    const tagger = game.players[socket.id];
    if (!tagger || tagger.role !== 'chat') return;
    if (tagger.frozen) { socket.emit('tag_failed', { reason: 'Tu es gelé !' }); return; }

    // Trouver la souris la plus proche dans un rayon de 25m
    let closest = null, closestDist = Infinity;
    Object.values(game.players).forEach(other => {
      if (other.role === 'souris' && other.timerRunning && !other.immune) {
        const d = getDistance(tagger.lat, tagger.lng, other.lat, other.lng);
        if (d < 25 && d < closestDist) { closest = other; closestDist = d; }
      }
    });

    if (!closest) {
      socket.emit('tag_failed', { reason: `Aucune souris à portée (rayon 25m)` });
      return;
    }

    // ─ Taguer ! ──────────────────────────────────────────────────────────
    tagger.totalTags += 1;
    tagger.points += 30; // bonus pour avoir taggué

    // L'ancienne souris devient chat
    closest.role = 'chat';
    closest.timerRunning = false;
    closest.timeLeft = 0;

    // L'ancien chat devient souris avec 15 minutes et une immunité de 10s
    tagger.role = 'souris';
    tagger.timeLeft = 900;
    tagger.timerRunning = true;
    tagger.immune = true;
    setTimeout(() => { if (game.players[tagger.id]) tagger.immune = false; }, 10000);

    const entry = { taggerId: socket.id, targetId: closest.id, taggerName: tagger.name, targetName: closest.name, time: Date.now() };
    game.tagLog.unshift(entry);
    if (game.tagLog.length > 20) game.tagLog.pop();

    io.to(gameCode).emit('player_tagged', entry);
    io.to(gameCode).emit('game_state', sanitize(game));
    console.log(`${tagger.name} → ${closest.name} taggué !`);
  });

  // === Acheter un bonus ====================================================
  socket.on('buy_bonus', ({ bonusType }) => {
    const game = games[socket.gameCode];
    if (!game || !game.started) return;
    const p = game.players[socket.id];
    const bonus = BONUSES[bonusType];

    if (!p || !bonus) return;
    if (p.role !== 'souris') { socket.emit('bonus_failed', { reason: 'Seules les souris peuvent acheter des bonus !' }); return; }
    if (p.points < bonus.cost) { socket.emit('bonus_failed', { reason: 'Pas assez de points !' }); return; }

    p.points -= bonus.cost;

    // Appliquer la réduction de temps
    if (bonus.timeOff > 0) {
      p.timeLeft = Math.max(0, p.timeLeft - bonus.timeOff);
    }

    // Effets spéciaux
    if (bonus.effect === 'freeze') {
      Object.values(game.players).forEach(other => {
        if (other.role === 'chat') {
          other.frozen = true;
          setTimeout(() => { if (game.players[other.id]) other.frozen = false; }, bonus.duration * 1000);
        }
      });
      io.to(socket.gameCode).emit('notification', { msg: `🧊 ${p.name} a gelé tous les chats ${bonus.duration}s !` });
    }

    if (bonus.effect === 'immunity') {
      p.immune = true;
      setTimeout(() => { if (p) p.immune = false; }, bonus.duration * 1000);
      socket.emit('notification', { msg: `🛡️ Tu es immunisé ${bonus.duration}s !` });
    }

    socket.emit('bonus_applied', { bonusType, label: bonus.label, newTimeLeft: p.timeLeft, newPoints: p.points });
    io.to(socket.gameCode).emit('game_state', sanitize(game));
  });

  // === Récupérer la liste des bonus ========================================
  socket.on('get_bonuses', () => {
    socket.emit('bonus_list', BONUSES);
  });

  // === Déconnexion =========================================================
  socket.on('disconnect', () => {
    const gameCode = socket.gameCode;
    if (!gameCode || !games[gameCode]) return;
    const game = games[gameCode];
    const p = game.players[socket.id];

    if (p) {
      p.connected = false;
      io.to(gameCode).emit('notification', { msg: `${p.name} s'est déconnecté.` });
      // Attendre 30s avant de supprimer
      setTimeout(() => {
        if (games[gameCode] && !games[gameCode].players[socket.id]?.connected) {
          delete games[gameCode].players[socket.id];
          if (Object.keys(games[gameCode].players).length === 0) {
            clearInterval(games[gameCode].timerInterval);
            delete games[gameCode];
          } else {
            io.to(gameCode).emit('game_state', sanitize(games[gameCode]));
          }
        }
      }, 30000);
    }
  });
});

// ─── Fin de partie ──────────────────────────────────────────────────────────
function endGame(gameCode, winner) {
  const game = games[gameCode];
  if (!game) return;
  clearInterval(game.timerInterval);

  const scores = Object.values(game.players)
    .sort((a, b) => b.points - a.points)
    .map(p => ({ name: p.name, role: p.role, points: p.points, tags: p.totalTags, survived: p.totalSurvived }));

  io.to(gameCode).emit('game_over', { winner, scores, tagLog: game.tagLog });
  setTimeout(() => { delete games[gameCode]; }, 60000);
}

// ─── Nettoyer les données envoyées au client ─────────────────────────────────
function sanitize(game) {
  return {
    code: game.code,
    numCats: game.numCats,
    hostId: game.hostId,
    started: game.started,
    tagLog: game.tagLog || [],
    players: Object.fromEntries(
      Object.entries(game.players).map(([id, p]) => [id, {
        id: p.id, name: p.name, role: p.role,
        lat: p.lat, lng: p.lng,
        timeLeft: p.timeLeft, timerRunning: p.timerRunning,
        points: p.points, frozen: p.frozen, immune: p.immune,
        totalTags: p.totalTags, connected: p.connected
      }])
    )
  };
}

// ─── Health check pour Render ───────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'Chat Game Server Running 🐱' }));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Serveur démarré sur le port ${PORT}`));
