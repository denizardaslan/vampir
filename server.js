const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { randomInt } = require('crypto');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

app.use(express.static(path.join(__dirname, 'public')));

const games = new Map();
const testDashboardRooms = new Map();

function makeGame({ code, password = '' }) {
  return {
    code,
    password,
    phase: 'lobby',
    players: [],
    withDoctor: true,
    withSeer: true,
    vampireCount: 2,
    noKillFirstNight: false,
    nightActions: {
      vampire: { selectedTarget: null, confirmedBy: [] },
      doctor: { target: null, lastSelfProtect: -2 },
      seer: { target: null, result: null }
    },
    votes: {},
    vampireChat: [],
    dayNumber: 0,
    lastNightDeath: null,
    discussDuration: 5,
    winner: null,
    discussTimer: null,
    voteTimer: null
  };
}

function makeLobbyCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  do {
    code = Array.from({ length: 5 }, () => alphabet[randomInt(0, alphabet.length)]).join('');
  } while (games.has(code));
  return code;
}

function normalizeCode(code) {
  return String(code || '').trim().toUpperCase();
}

function getAlivePlayers(game) {
  return game.players.filter(p => p.alive);
}

function findGameByPlayerId(playerId) {
  for (const game of games.values()) {
    const player = game.players.find(p => p.id === playerId);
    if (player) return { game, player };
  }
  return null;
}

function findGameBySocket(socket) {
  for (const game of games.values()) {
    const player = game.players.find(p => p.socketId === socket.id);
    if (player) return { game, player };
  }
  return null;
}

function roleLabel(role) {
  return { vampire: 'Vampir', doctor: 'Doktor', seer: 'Kahin', villager: 'Köylü' }[role] || 'Rol yok';
}

function phaseLabel(phase) {
  return {
    lobby: 'Lobi',
    role_reveal: 'Rol Açıklaması',
    night: 'Gece',
    day_reveal: 'Gündüz Açılışı',
    day_discuss: 'Tartışma',
    day_vote: 'Oylama',
    game_over: 'Oyun Sonu'
  }[phase] || phase;
}

function playerName(game, id) {
  return game.players.find(p => p.id === id)?.name || null;
}

function getAllRoles(game) {
  return game.players.map(p => ({ id: p.id, name: p.name, role: p.role, alive: p.alive }));
}

function getLobbyPlayers(game) {
  return game.players.map(p => ({
    id: p.id,
    name: p.name,
    isHost: p.isHost,
    connected: !p.disconnected,
    alive: p.alive
  }));
}

function getRoleConfig(game) {
  return {
    withDoctor: game.withDoctor,
    withSeer: game.withSeer,
    vampireCount: game.vampireCount,
    noKillFirstNight: game.noKillFirstNight,
    discussDuration: game.discussDuration
  };
}

function buildRoles(game) {
  const playerCount = game.players.length;
  const vampireCount = Math.min(game.vampireCount, Math.max(1, playerCount - 1));
  const roles = Array.from({ length: vampireCount }, () => 'vampire');
  if (game.withDoctor && roles.length < playerCount) roles.push('doctor');
  if (game.withSeer && roles.length < playerCount) roles.push('seer');
  while (roles.length < playerCount) roles.push('villager');
  return roles;
}

function validateStartConfig(game) {
  const connectedCount = game.players.filter(p => !p.disconnected).length;
  if (connectedCount !== game.players.length) return 'Bağlantısı kopmuş oyuncu varken oyun başlatılamaz.';
  if (game.players.length < 3) return 'Oyunu başlatmak için en az 3 oyuncu gerekli.';
  if (game.vampireCount < 1 || game.vampireCount > 3) return 'Vampir sayısı 1, 2 veya 3 olmalı.';
  if (game.vampireCount >= game.players.length) return 'Vampir sayısı oyuncu sayısından az olmalı.';
  return null;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function emitToPlayer(player, event, data) {
  const socket = io.sockets.sockets.get(player.socketId);
  if (socket) socket.emit(event, data);
}

function notifyVampires(game, event, data) {
  game.players
    .filter(p => p.role === 'vampire' && p.alive)
    .forEach(p => emitToPlayer(p, event, data));
}

function sendLobbyUpdate(game) {
  const players = getLobbyPlayers(game);
  game.players.forEach(p => {
    emitToPlayer(p, 'lobby_update', {
      lobbyCode: game.code,
      lobbyPassword: p.isHost ? game.password : null,
      players,
      isHost: p.isHost,
      gameState: { phase: game.phase, ...getRoleConfig(game) }
    });
  });
  sendTestDashboardUpdate(game);
}

function buildSpectatorData(game) {
  return {
    lobbyCode: game.code,
    players: getAllRoles(game),
    phase: game.phase,
    nightActions: {
      vampireTarget: playerName(game, game.nightActions.vampire.selectedTarget),
      confirmedCount: game.nightActions.vampire.confirmedBy.length,
      doctorTarget: playerName(game, game.nightActions.doctor.target),
      seerTarget: playerName(game, game.nightActions.seer.target),
      seerResult: game.nightActions.seer.result
    },
    votes: Object.entries(game.votes).map(([vid, tid]) => {
      const voter = game.players.find(p => p.id === vid);
      return { voter: voter?.name, target: tid === 'abstain' ? 'Çekimser' : playerName(game, tid) };
    }),
    vampireChat: game.vampireChat
  };
}

function sendSpectatorUpdate(game) {
  const dead = game.players.filter(p => !p.alive);
  if (!dead.length) return;
  const data = buildSpectatorData(game);
  dead.forEach(p => emitToPlayer(p, 'spectator_update', data));
}

function checkWinCondition(game) {
  const alive = getAlivePlayers(game);
  const vampires = alive.filter(p => p.role === 'vampire');
  const others = alive.filter(p => p.role !== 'vampire');
  if (vampires.length === 0) return 'villagers';
  if (vampires.length >= others.length) return 'vampires';
  return null;
}

function finishGame(game, winner, delay = 0) {
  game.winner = winner;
  game.phase = 'game_over';
  if (game.discussTimer) clearTimeout(game.discussTimer);
  if (game.voteTimer) clearTimeout(game.voteTimer);
  setTimeout(() => {
    io.to(game.code).emit('game_over', { winner, allRoles: getAllRoles(game) });
    sendTestDashboardUpdate(game);
  }, delay);
}

function startNight(game) {
  game.dayNumber++;
  game.phase = 'night';
  const prevLastSelfProtect = game.nightActions.doctor.lastSelfProtect;
  game.nightActions = {
    vampire: { selectedTarget: null, confirmedBy: [] },
    doctor: { target: null, lastSelfProtect: prevLastSelfProtect },
    seer: { target: null, result: null }
  };
  game.vampireChat = [];
  game.votes = {};

  io.to(game.code).emit('phase_change', {
    phase: 'night',
    data: {
      dayNumber: game.dayNumber,
      alivePlayers: getAlivePlayers(game).map(p => ({ id: p.id, name: p.name })),
      noKillFirstNight: game.noKillFirstNight
    }
  });
  sendSpectatorUpdate(game);
  sendTestDashboardUpdate(game);
}

function checkNightComplete(game) {
  if (game.phase !== 'night') return;

  const alive = getAlivePlayers(game);
  const vampires = alive.filter(p => p.role === 'vampire');
  const doctor = game.withDoctor ? alive.find(p => p.role === 'doctor') : null;
  const seer = game.withSeer ? alive.find(p => p.role === 'seer') : null;
  const firstNightSkip = game.noKillFirstNight && game.dayNumber === 1;

  const vampireDone = firstNightSkip || vampires.length === 0
    ? true
    : game.nightActions.vampire.selectedTarget !== null
      && game.nightActions.vampire.confirmedBy.length >= vampires.length;
  const doctorDone = firstNightSkip || !doctor || game.nightActions.doctor.target !== null;
  const seerDone = !seer || game.nightActions.seer.target !== null;

  if (vampireDone && doctorDone && seerDone) resolveNight(game);
}

function resolveNight(game) {
  const vampireTargetId = game.nightActions.vampire.selectedTarget;
  const doctorTargetId = game.nightActions.doctor.target;

  let newLastSelfProtect = game.nightActions.doctor.lastSelfProtect;
  if (doctorTargetId) {
    const doc = game.players.find(p => p.role === 'doctor' && p.alive);
    if (doc && doctorTargetId === doc.id) newLastSelfProtect = game.dayNumber;
  }

  let death = null;
  const firstNightNoKill = game.noKillFirstNight && game.dayNumber === 1;
  if (!firstNightNoKill && vampireTargetId && vampireTargetId !== doctorTargetId) {
    const victim = game.players.find(p => p.id === vampireTargetId && p.alive);
    if (victim) {
      victim.alive = false;
      death = { name: victim.name, role: victim.role };
    }
  }

  game.lastNightDeath = death;
  game.nightActions.doctor.lastSelfProtect = newLastSelfProtect;
  game.phase = 'day_reveal';

  const revealData = death
    ? { deathName: death.name, deathRole: death.role }
    : { deathName: null, deathRole: null };

  io.to(game.code).emit('phase_change', { phase: 'day_reveal', data: revealData });
  sendSpectatorUpdate(game);
  sendTestDashboardUpdate(game);

  const winner = checkWinCondition(game);
  if (winner) {
    finishGame(game, winner, 4000);
    return;
  }

  setTimeout(() => startDiscuss(game), 5000);
}

function startDiscuss(game) {
  if (game.phase !== 'day_reveal') return;
  game.phase = 'day_discuss';
  game.discussStartTime = Date.now();
  if (game.discussTimer) clearTimeout(game.discussTimer);

  io.to(game.code).emit('phase_change', {
    phase: 'day_discuss',
    data: { duration: game.discussDuration, dayNumber: game.dayNumber, remainingSeconds: game.discussDuration * 60 }
  });
  sendSpectatorUpdate(game);
  sendTestDashboardUpdate(game);

  game.discussTimer = setTimeout(() => startVoting(game), game.discussDuration * 60 * 1000);
}

function startVoting(game) {
  if (game.phase !== 'day_discuss') return;
  if (game.discussTimer) { clearTimeout(game.discussTimer); game.discussTimer = null; }

  game.phase = 'day_vote';
  game.votes = {};

  const alive = getAlivePlayers(game);
  io.to(game.code).emit('phase_change', {
    phase: 'day_vote',
    data: { voters: alive.map(p => ({ id: p.id, name: p.name })) }
  });
  sendSpectatorUpdate(game);
  sendTestDashboardUpdate(game);

  if (game.voteTimer) clearTimeout(game.voteTimer);
  game.voteTimer = setTimeout(() => resolveVoting(game), 60 * 1000);
}

function resolveVoting(game) {
  if (game.voteTimer) { clearTimeout(game.voteTimer); game.voteTimer = null; }
  if (game.phase !== 'day_vote') return;

  const alive = getAlivePlayers(game);
  const voteCounts = {};

  for (const voter of alive) {
    const vote = game.votes[voter.id];
    if (vote && vote !== 'abstain') voteCounts[vote] = (voteCounts[vote] || 0) + 1;
  }

  let maxVotes = 0;
  let topPlayers = [];
  for (const [pid, count] of Object.entries(voteCounts)) {
    if (count > maxVotes) { maxVotes = count; topPlayers = [pid]; }
    else if (count === maxVotes) topPlayers.push(pid);
  }

  const voteBreakdown = alive.map(p => ({ id: p.id, name: p.name, votes: voteCounts[p.id] || 0 }));
  let hangedName = null;
  let hangedRole = null;

  if (topPlayers.length === 1 && maxVotes > 0) {
    const hanged = game.players.find(p => p.id === topPlayers[0]);
    if (hanged && hanged.alive) {
      hanged.alive = false;
      hangedName = hanged.name;
      hangedRole = hanged.role;
    }
  }

  io.to(game.code).emit('vote_result', { hangedName, hangedRole, voteBreakdown });
  sendSpectatorUpdate(game);
  sendTestDashboardUpdate(game);

  const winner = checkWinCondition(game);
  if (winner) {
    finishGame(game, winner, 4000);
    return;
  }

  if (game.dayNumber >= 10) {
    finishGame(game, 'draw', 4000);
    return;
  }

  setTimeout(() => startNight(game), 4000);
}

function getPhaseData(game) {
  switch (game.phase) {
    case 'night':
      return { dayNumber: game.dayNumber };
    case 'day_reveal':
      return game.lastNightDeath
        ? { deathName: game.lastNightDeath.name, deathRole: game.lastNightDeath.role }
        : { deathName: null, deathRole: null };
    case 'day_discuss': {
      const elapsed = game.discussStartTime ? Math.floor((Date.now() - game.discussStartTime) / 1000) : 0;
      const remaining = Math.max(0, game.discussDuration * 60 - elapsed);
      return { duration: game.discussDuration, dayNumber: game.dayNumber, remainingSeconds: remaining };
    }
    case 'day_vote':
      return { voters: getAlivePlayers(game).map(p => ({ id: p.id, name: p.name })) };
    default:
      return {};
  }
}

function getPlayerScreen(game, player) {
  if (!player.alive && game.phase !== 'game_over') {
    return {
      screen: 'İzleyici',
      headline: 'Ölü oyuncu izleyici ekranında',
      detail: `${phaseLabel(game.phase)} akışını ve gizli aksiyon özetlerini görür.`
    };
  }

  switch (game.phase) {
    case 'lobby':
      return {
        screen: 'Lobi',
        headline: player.isHost ? 'Host kontrol paneli açık' : 'Host oyunu başlatana kadar bekliyor',
        detail: `${game.players.filter(p => !p.disconnected).length} oyuncu lobide.`
      };
    case 'role_reveal':
      return {
        screen: 'Rol Açıklaması',
        headline: `Rolünü görür: ${roleLabel(player.role)}`,
        detail: player.role === 'vampire'
          ? `Diğer vampirler: ${game.players.filter(p => p.role === 'vampire' && p.id !== player.id).map(p => p.name).join(', ') || '-'}`
          : 'Gece başlamadan önce rol kartı gösterilir.'
      };
    case 'night': {
      const firstNightSkip = game.noKillFirstNight && game.dayNumber === 1;
      if (player.role === 'vampire') {
        return {
          screen: firstNightSkip ? 'Gece - Vampir Tanışma' : 'Gece - Vampir',
          headline: firstNightSkip ? 'İlk gece öldürme kapalı' : 'Kurban seçimi ekranında',
          detail: firstNightSkip
            ? 'Vampir sohbeti açık, hedef seçimi gizli.'
            : `Hedef: ${playerName(game, game.nightActions.vampire.selectedTarget) || 'seçilmedi'}; onay: ${game.nightActions.vampire.confirmedBy.length}/${getAlivePlayers(game).filter(p => p.role === 'vampire').length}`
        };
      }
      if (player.role === 'doctor') {
        return {
          screen: 'Gece - Doktor',
          headline: firstNightSkip ? 'İlk gece koruma kapalı' : 'Korunacak kişiyi seçer',
          detail: firstNightSkip ? 'Sabahı bekler.' : `Koruma: ${playerName(game, game.nightActions.doctor.target) || 'seçilmedi'}`
        };
      }
      if (player.role === 'seer') {
        const result = game.nightActions.seer.result;
        return {
          screen: 'Gece - Kahin',
          headline: 'Sorgulanacak kişiyi seçer',
          detail: game.nightActions.seer.target
            ? `${playerName(game, game.nightActions.seer.target)} sonucu: ${result ? (result.isVampire ? 'Vampir' : 'Temiz') : 'bekleniyor'}`
            : 'Henüz seçim yapılmadı.'
        };
      }
      return { screen: 'Gece - Köylü', headline: 'Uyuyor', detail: 'Gece aksiyonu yok.' };
    }
    case 'day_reveal':
      return {
        screen: 'Gündüz Açılışı',
        headline: game.lastNightDeath ? `${game.lastNightDeath.name} öldürüldü` : 'Kimse ölmedi',
        detail: game.lastNightDeath ? `Rol: ${roleLabel(game.lastNightDeath.role)}` : 'Doktor koruması veya ilk gece kuralı nedeniyle ölüm yok.'
      };
    case 'day_discuss':
      return {
        screen: 'Tartışma',
        headline: `Gün ${game.dayNumber} tartışması`,
        detail: player.isHost ? 'Host oylamaya geçebilir.' : 'Yüz yüze tartışma ekranında bekler.'
      };
    case 'day_vote': {
      const vote = game.votes[player.id];
      return {
        screen: 'Oylama',
        headline: vote ? 'Oyunu kullandı' : 'Oy hedefi seçer',
        detail: vote ? `Oy: ${vote === 'abstain' ? 'Çekimser' : playerName(game, vote)}` : `${Object.keys(game.votes).length}/${getAlivePlayers(game).length} oy kullanıldı.`
      };
    }
    case 'game_over':
      return { screen: 'Oyun Sonu', headline: `Kazanan: ${game.winner || '-'}`, detail: 'Tüm roller görünür.' };
    default:
      return { screen: phaseLabel(game.phase), headline: '', detail: '' };
  }
}

function buildTestDashboardData(game) {
  if (!game) {
    return {
      lobbyCode: null,
      phase: 'none',
      phaseLabel: 'Lobi yok',
      dayNumber: 0,
      players: [],
      lobbies: Array.from(games.values()).map(g => ({ code: g.code, players: g.players.length, phase: g.phase }))
    };
  }

  return {
    lobbyCode: game.code,
    phase: game.phase,
    phaseLabel: phaseLabel(game.phase),
    dayNumber: game.dayNumber,
    withDoctor: game.withDoctor,
    withSeer: game.withSeer,
    vampireCount: game.vampireCount,
    noKillFirstNight: game.noKillFirstNight,
    winner: game.winner,
    players: game.players.map(p => ({
      id: p.id,
      name: p.name,
      role: p.role,
      roleLabel: roleLabel(p.role),
      alive: p.alive,
      isHost: p.isHost,
      connected: !p.disconnected && !!p.socketId,
      screen: getPlayerScreen(game, p)
    })),
    spectator: buildSpectatorData(game),
    lobbies: Array.from(games.values()).map(g => ({ code: g.code, players: g.players.length, phase: g.phase }))
  };
}

function sendTestDashboardUpdate(game) {
  const rooms = game ? [game.code] : Array.from(testDashboardRooms.keys());
  rooms.forEach(code => {
    const room = `test-dashboard:${code}`;
    io.to(room).emit('test_dashboard_update', buildTestDashboardData(games.get(code) || null));
  });
}

function attachPlayerToGame(socket, game, player) {
  if (player.removeTimer) {
    clearTimeout(player.removeTimer);
    player.removeTimer = null;
  }
  player.disconnected = false;
  player.socketId = socket.id;
  socket.join(game.code);
}

function emitReconnect(socket, game, player) {
  socket.emit('reconnected', {
    lobbyCode: game.code,
    phase: game.phase,
    player: {
      id: player.id,
      name: player.name,
      role: player.role,
      alive: player.alive,
      isHost: player.isHost
    },
    fellowVampires: player.role === 'vampire'
      ? game.players.filter(p => p.role === 'vampire' && p.id !== player.id).map(p => p.name)
      : [],
    nightData: player.role === 'vampire' && game.phase === 'night' ? {
      vampireChat: game.vampireChat,
      selection: {
        targetId: game.nightActions.vampire.selectedTarget,
        confirmedBy: game.nightActions.vampire.confirmedBy
      }
    } : null,
    seerResult: player.role === 'seer' && game.nightActions.seer.result ? game.nightActions.seer.result : null,
    phaseData: getPhaseData(game),
    allRoles: game.phase === 'game_over' ? getAllRoles(game) : null,
    winner: game.winner,
    alivePlayers: getAlivePlayers(game).map(p => ({ id: p.id, name: p.name }))
  });

  if (!player.alive) {
    setTimeout(() => emitToPlayer(player, 'spectator_update', buildSpectatorData(game)), 200);
  }
}

function createLobby(socket, { name, playerId, password }) {
  const trimmed = String(name || '').trim();
  if (!trimmed) { socket.emit('error', { message: 'İsim boş olamaz.' }); return; }

  const code = makeLobbyCode();
  const game = makeGame({ code, password: String(password || '').trim() });
  games.set(code, game);
  const player = { id: playerId, name: trimmed, role: null, alive: true, socketId: socket.id, isHost: true };
  game.players.push(player);
  attachPlayerToGame(socket, game, player);
  sendLobbyUpdate(game);
}

function joinLobby(socket, { name, playerId, lobbyCode, lobbyPassword }) {
  const code = normalizeCode(lobbyCode);
  const game = games.get(code);
  if (!game) { socket.emit('error', { message: 'Lobi bulunamadı.' }); return; }
  if (game.phase !== 'lobby') { socket.emit('error', { message: 'Bu lobide oyun başlamış.' }); return; }
  if (game.password && game.password !== String(lobbyPassword || '').trim()) {
    socket.emit('error', { message: 'Lobi şifresi yanlış.' });
    return;
  }

  const trimmed = String(name || '').trim();
  if (!trimmed) { socket.emit('error', { message: 'İsim boş olamaz.' }); return; }

  const ghost = game.players.find(p => p.id === playerId && p.disconnected);
  if (ghost) {
    ghost.name = trimmed;
    attachPlayerToGame(socket, game, ghost);
    sendLobbyUpdate(game);
    return;
  }

  if (game.players.some(p => p.name.toLowerCase() === trimmed.toLowerCase())) {
    socket.emit('error', { message: 'Bu isim bu lobide kullanılıyor.' });
    return;
  }

  const player = { id: playerId, name: trimmed, role: null, alive: true, socketId: socket.id, isHost: false };
  game.players.push(player);
  attachPlayerToGame(socket, game, player);
  sendLobbyUpdate(game);
}

io.on('connection', (socket) => {
  socket.on('hello', ({ playerId }) => {
    const found = findGameByPlayerId(playerId);
    if (!found) {
      socket.emit('new_session', {});
      return;
    }

    const { game, player } = found;
    const prevSocket = io.sockets.sockets.get(player.socketId);
    if (prevSocket && prevSocket.id !== socket.id) {
      socket.emit('new_session', {});
      return;
    }

    attachPlayerToGame(socket, game, player);
    emitReconnect(socket, game, player);
    sendLobbyUpdate(game);
  });

  socket.on('create_lobby', (data) => createLobby(socket, data));
  socket.on('join_lobby', (data) => joinLobby(socket, data));

  socket.on('kick_player', ({ targetId }) => {
    const found = findGameBySocket(socket);
    if (!found) return;
    const { game, player } = found;
    if (!player.isHost || game.phase !== 'lobby') return;
    const target = game.players.find(p => p.id === targetId);
    if (!target || target.isHost) return;

    game.players = game.players.filter(p => p.id !== targetId);
    emitToPlayer(target, 'kicked');
    sendLobbyUpdate(game);
  });

  socket.on('set_role_config', ({ withDoctor, withSeer, vampireCount, noKillFirstNight }) => {
    const found = findGameBySocket(socket);
    if (!found) return;
    const { game, player } = found;
    if (!player.isHost || game.phase !== 'lobby') return;
    game.withDoctor = !!withDoctor;
    game.withSeer = !!withSeer;
    game.vampireCount = Math.max(1, Math.min(3, Number(vampireCount) || 1));
    game.noKillFirstNight = !!noKillFirstNight;
    sendLobbyUpdate(game);
  });

  socket.on('set_discuss_duration', ({ minutes }) => {
    const found = findGameBySocket(socket);
    if (!found) return;
    const { game, player } = found;
    if (!player.isHost) return;
    if ([3, 5, 7].includes(minutes)) game.discussDuration = minutes;
    sendLobbyUpdate(game);
  });

  socket.on('start_game', ({ withDoctor, withSeer, vampireCount, noKillFirstNight } = {}) => {
    const found = findGameBySocket(socket);
    if (!found) return;
    const { game, player } = found;
    if (!player.isHost) { socket.emit('error', { message: 'Sadece host oyunu başlatabilir.' }); return; }
    if (game.phase !== 'lobby') return;

    game.withDoctor = withDoctor !== undefined ? !!withDoctor : game.withDoctor;
    game.withSeer = withSeer !== undefined ? !!withSeer : game.withSeer;
    game.vampireCount = vampireCount !== undefined ? Math.max(1, Math.min(3, Number(vampireCount) || 1)) : game.vampireCount;
    game.noKillFirstNight = noKillFirstNight !== undefined ? !!noKillFirstNight : game.noKillFirstNight;

    const validationError = validateStartConfig(game);
    if (validationError) { socket.emit('error', { message: validationError }); return; }

    const roles = shuffle(buildRoles(game));
    game.players.forEach((p, i) => { p.role = roles[i]; p.alive = true; });
    const vampireNames = game.players.filter(p => p.role === 'vampire').map(p => p.name);
    game.phase = 'role_reveal';

    game.players.forEach(p => {
      emitToPlayer(p, 'role_assigned', {
        role: p.role,
        fellowVampires: p.role === 'vampire' ? vampireNames.filter(n => n !== p.name) : []
      });
    });

    io.to(game.code).emit('phase_change', { phase: 'role_reveal', data: {} });
    sendTestDashboardUpdate(game);
    setTimeout(() => startNight(game), 5000);
  });

  socket.on('vampire_select', ({ targetId }) => {
    const found = findGameBySocket(socket);
    if (!found) return;
    const { game, player } = found;
    if (game.phase !== 'night' || player.role !== 'vampire' || !player.alive) return;
    const target = game.players.find(p => p.id === targetId && p.alive && p.role !== 'vampire');
    if (!target) return;

    const aliveVampires = getAlivePlayers(game).filter(p => p.role === 'vampire');
    game.nightActions.vampire.selectedTarget = targetId;
    game.nightActions.vampire.confirmedBy = [player.id];

    notifyVampires(game, 'vampire_selection_update', {
      targetId,
      confirmedBy: game.nightActions.vampire.confirmedBy,
      autoConfirmed: aliveVampires.length === 1
    });
    if (aliveVampires.length === 1) game.nightActions.vampire.confirmedBy = aliveVampires.map(p => p.id);
    sendSpectatorUpdate(game);
    sendTestDashboardUpdate(game);
    if (aliveVampires.length === 1) checkNightComplete(game);
  });

  socket.on('vampire_confirm', () => {
    const found = findGameBySocket(socket);
    if (!found) return;
    const { game, player } = found;
    if (game.phase !== 'night' || player.role !== 'vampire' || !player.alive) return;
    if (!game.nightActions.vampire.selectedTarget) return;

    if (!game.nightActions.vampire.confirmedBy.includes(player.id)) {
      game.nightActions.vampire.confirmedBy.push(player.id);
    }

    const aliveVampires = getAlivePlayers(game).filter(p => p.role === 'vampire');
    notifyVampires(game, 'vampire_selection_update', {
      targetId: game.nightActions.vampire.selectedTarget,
      confirmedBy: game.nightActions.vampire.confirmedBy,
      autoConfirmed: false
    });
    sendSpectatorUpdate(game);
    sendTestDashboardUpdate(game);

    if (game.nightActions.vampire.confirmedBy.length >= aliveVampires.length) checkNightComplete(game);
  });

  socket.on('vampire_message', ({ text }) => {
    const found = findGameBySocket(socket);
    if (!found) return;
    const { game, player } = found;
    if (game.phase !== 'night' || player.role !== 'vampire' || !player.alive) return;
    const trimmed = String(text || '').trim();
    if (!trimmed) return;

    game.vampireChat.push({ name: player.name, message: trimmed, timestamp: Date.now() });
    notifyVampires(game, 'vampire_chat_update', { messages: game.vampireChat });
    sendTestDashboardUpdate(game);
  });

  socket.on('doctor_select', ({ targetId }) => {
    const found = findGameBySocket(socket);
    if (!found) return;
    const { game, player } = found;
    if (game.phase !== 'night' || player.role !== 'doctor' || !player.alive) return;

    if (targetId === player.id && game.nightActions.doctor.lastSelfProtect === game.dayNumber - 1) {
      socket.emit('error', { message: 'Art arda iki gece kendinizi koruyamazsınız.' });
      return;
    }
    if (!game.players.find(p => p.id === targetId && p.alive)) return;

    game.nightActions.doctor.target = targetId;
    socket.emit('doctor_confirmed', { targetName: playerName(game, targetId) });
    sendSpectatorUpdate(game);
    sendTestDashboardUpdate(game);
    checkNightComplete(game);
  });

  socket.on('seer_select', ({ targetId }) => {
    const found = findGameBySocket(socket);
    if (!found) return;
    const { game, player } = found;
    if (game.phase !== 'night' || player.role !== 'seer' || !player.alive) return;

    const target = game.players.find(p => p.id === targetId && p.alive && p.id !== player.id);
    if (!target) return;

    game.nightActions.seer.target = targetId;
    const result = { targetName: target.name, isVampire: target.role === 'vampire' };
    game.nightActions.seer.result = result;
    socket.emit('seer_result', result);
    sendSpectatorUpdate(game);
    sendTestDashboardUpdate(game);
    setTimeout(() => checkNightComplete(game), 3000);
  });

  socket.on('cast_vote', ({ targetId }) => {
    const found = findGameBySocket(socket);
    if (!found) return;
    const { game, player } = found;
    if (game.phase !== 'day_vote' || !player.alive) return;

    game.votes[player.id] = targetId;
    const alive = getAlivePlayers(game);
    const votedCount = Object.keys(game.votes).length;
    const voteList = Object.entries(game.votes).map(([vid, tid]) => ({
      voterName: playerName(game, vid),
      targetName: tid === 'abstain' ? 'Çekimser' : playerName(game, tid)
    }));
    io.to(game.code).emit('vote_update', { votedCount, totalVoters: alive.length, votes: voteList });
    sendSpectatorUpdate(game);
    sendTestDashboardUpdate(game);

    if (votedCount >= alive.length) resolveVoting(game);
  });

  socket.on('start_voting', () => {
    const found = findGameBySocket(socket);
    if (!found) return;
    const { game, player } = found;
    if (!player.isHost || game.phase !== 'day_discuss') return;
    startVoting(game);
  });

  socket.on('force_end_game', () => {
    const found = findGameBySocket(socket);
    if (!found) return;
    const { game, player } = found;
    if (!player.isHost || game.phase === 'lobby' || game.phase === 'game_over') return;
    finishGame(game, 'ended');
  });

  socket.on('new_game', () => {
    const found = findGameBySocket(socket);
    if (!found) return;
    const { game, player } = found;
    if (!player.isHost || game.phase !== 'game_over') return;

    if (game.discussTimer) clearTimeout(game.discussTimer);
    if (game.voteTimer) clearTimeout(game.voteTimer);
    game.phase = 'lobby';
    game.players.forEach(p => {
      p.role = null;
      p.alive = true;
      p.disconnected = false;
    });
    game.nightActions = {
      vampire: { selectedTarget: null, confirmedBy: [] },
      doctor: { target: null, lastSelfProtect: -2 },
      seer: { target: null, result: null }
    };
    game.votes = {};
    game.vampireChat = [];
    game.dayNumber = 0;
    game.lastNightDeath = null;
    game.winner = null;
    sendLobbyUpdate(game);
  });

  socket.on('test_observe', ({ lobbyCode } = {}) => {
    const code = normalizeCode(lobbyCode) || Array.from(games.keys())[0] || null;
    if (!code) {
      socket.emit('test_dashboard_update', buildTestDashboardData(null));
      return;
    }
    const room = `test-dashboard:${code}`;
    socket.join(room);
    testDashboardRooms.set(code, room);
    socket.emit('test_dashboard_update', buildTestDashboardData(games.get(code) || null));
  });

  socket.on('test_seed_lobby', ({ playerCount = 6, withDoctor = true, withSeer = true, vampireCount = 2, noKillFirstNight = false } = {}) => {
    const code = makeLobbyCode();
    const game = makeGame({ code, password: 'demo' });
    game.withDoctor = !!withDoctor;
    game.withSeer = !!withSeer;
    game.vampireCount = Math.max(1, Math.min(3, Number(vampireCount) || 2));
    game.noKillFirstNight = !!noKillFirstNight;
    const names = ['Ada', 'Bora', 'Cem', 'Derya', 'Ece', 'Fırat', 'Güneş', 'Hale', 'Işık', 'Jale'];
    const count = Math.max(3, Math.min(10, Number(playerCount) || 6));
    game.players = names.slice(0, count).map((name, index) => ({
      id: `test-${code}-${index + 1}`,
      name,
      role: null,
      alive: true,
      socketId: null,
      isHost: index === 0,
      disconnected: false
    }));
    games.set(code, game);
    socket.join(`test-dashboard:${code}`);
    testDashboardRooms.set(code, `test-dashboard:${code}`);
    socket.emit('test_dashboard_update', buildTestDashboardData(game));
  });

  socket.on('test_start_game', ({ lobbyCode, withDoctor = true, withSeer = true, vampireCount = 2, noKillFirstNight = false } = {}) => {
    const game = games.get(normalizeCode(lobbyCode)) || Array.from(games.values()).at(-1);
    if (!game || game.phase !== 'lobby') return;
    game.withDoctor = !!withDoctor;
    game.withSeer = !!withSeer;
    game.vampireCount = Math.max(1, Math.min(3, Number(vampireCount) || 2));
    game.noKillFirstNight = !!noKillFirstNight;
    const validationError = validateStartConfig(game);
    if (validationError) return;
    const roles = shuffle(buildRoles(game));
    game.players.forEach((p, i) => { p.role = roles[i]; p.alive = true; });
    game.phase = 'role_reveal';
    sendTestDashboardUpdate(game);
    setTimeout(() => startNight(game), 5000);
  });

  socket.on('test_auto_night', ({ lobbyCode } = {}) => {
    const game = games.get(normalizeCode(lobbyCode)) || Array.from(games.values()).at(-1);
    if (!game || game.phase !== 'night') return;
    const alive = getAlivePlayers(game);
    const firstNightSkip = game.noKillFirstNight && game.dayNumber === 1;
    const vampires = alive.filter(p => p.role === 'vampire');
    const doctor = game.withDoctor ? alive.find(p => p.role === 'doctor') : null;
    const seer = game.withSeer ? alive.find(p => p.role === 'seer') : null;

    if (!firstNightSkip && vampires.length > 0 && !game.nightActions.vampire.selectedTarget) {
      const target = alive.find(p => p.role !== 'vampire');
      if (target) {
        game.nightActions.vampire.selectedTarget = target.id;
        game.nightActions.vampire.confirmedBy = vampires.map(p => p.id);
      }
    }
    if (!firstNightSkip && doctor && !game.nightActions.doctor.target) {
      const target = alive.find(p => p.id !== game.nightActions.vampire.selectedTarget) || doctor;
      game.nightActions.doctor.target = target.id;
    }
    if (seer && !game.nightActions.seer.target) {
      const target = alive.find(p => p.id !== seer.id);
      if (target) {
        game.nightActions.seer.target = target.id;
        game.nightActions.seer.result = { targetName: target.name, isVampire: target.role === 'vampire' };
      }
    }
    sendSpectatorUpdate(game);
    sendTestDashboardUpdate(game);
    checkNightComplete(game);
  });

  socket.on('test_auto_vote', ({ lobbyCode } = {}) => {
    const game = games.get(normalizeCode(lobbyCode)) || Array.from(games.values()).at(-1);
    if (!game) return;
    if (game.phase === 'day_discuss') startVoting(game);
    if (game.phase !== 'day_vote') return;
    const alive = getAlivePlayers(game);
    const target = alive.find(p => p.role === 'vampire') || alive[0];
    if (!target) return;
    alive.forEach(p => { game.votes[p.id] = p.id === target.id ? 'abstain' : target.id; });
    const voteList = Object.entries(game.votes).map(([vid, tid]) => ({
      voterName: playerName(game, vid),
      targetName: tid === 'abstain' ? 'Çekimser' : playerName(game, tid)
    }));
    io.to(game.code).emit('vote_update', { votedCount: alive.length, totalVoters: alive.length, votes: voteList });
    sendSpectatorUpdate(game);
    sendTestDashboardUpdate(game);
    resolveVoting(game);
  });

  socket.on('disconnect', () => {
    const found = findGameBySocket(socket);
    if (!found) return;
    const { game, player } = found;

    if (game.phase === 'lobby') {
      player.disconnected = true;
      sendLobbyUpdate(game);
      player.removeTimer = setTimeout(() => {
        game.players = game.players.filter(p => p.id !== player.id);
        if (player.isHost && game.players.length) game.players[0].isHost = true;
        if (!game.players.length) games.delete(game.code);
        else sendLobbyUpdate(game);
      }, 30000);
    }
  });
});

const PORT = Number(process.env.PORT || 3000);
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`\nVampir Köylü sunucu çalışıyor!`);
  console.log(`  Yerel:   http://localhost:${PORT}`);
  console.log(`\nTelefonlar için IP adresini öğrenmek üzere şunu çalıştır:`);
  console.log(`  ipconfig getifaddr en0\n`);
});
