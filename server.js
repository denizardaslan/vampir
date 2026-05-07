const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { randomInt } = require('crypto');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

app.use(express.static(path.join(__dirname, 'public')));

function makeGame() {
  return {
    phase: 'lobby', // lobby | role_reveal | night | day_reveal | day_discuss | day_vote | game_over
    players: [],    // [{ id, name, role, alive, socketId, isHost }]
    withSeer: true,
    noKillFirstNight: false,
    nightActions: {
      vampire: { selectedTarget: null, confirmedBy: [] },
      doctor: { target: null, lastSelfProtect: -2 },
      seer: { target: null, result: null }
    },
    votes: {},         // { voterId: targetId | 'abstain' }
    vampireChat: [],   // [{ name, message, timestamp }]
    dayNumber: 0,
    lastNightDeath: null,
    discussDuration: 5,
    winner: null,
    discussTimer: null,
    voteTimer: null
  };
}

let game = makeGame();

// ─── Helpers ────────────────────────────────────────────────────────────────

function getAlivePlayers() {
  return game.players.filter(p => p.alive);
}

function checkWinCondition() {
  const alive = getAlivePlayers();
  const vampires = alive.filter(p => p.role === 'vampire');
  const others = alive.filter(p => p.role !== 'vampire');
  if (vampires.length === 0) return 'villagers';
  if (vampires.length >= others.length) return 'vampires';
  return null;
}

function getAllRoles() {
  return game.players.map(p => ({ id: p.id, name: p.name, role: p.role, alive: p.alive }));
}

function notifyVampires(event, data) {
  game.players
    .filter(p => p.role === 'vampire' && p.alive)
    .forEach(p => {
      const s = io.sockets.sockets.get(p.socketId);
      if (s) s.emit(event, data);
    });
}

function sendSpectatorUpdate() {
  const dead = game.players.filter(p => !p.alive);
  if (dead.length === 0) return;
  const data = buildSpectatorData();
  dead.forEach(p => {
    const s = io.sockets.sockets.get(p.socketId);
    if (s) s.emit('spectator_update', data);
  });
}

function buildSpectatorData() {
  return {
    players: getAllRoles(),
    phase: game.phase,
    nightActions: {
      vampireTarget: game.nightActions.vampire.selectedTarget
        ? game.players.find(p => p.id === game.nightActions.vampire.selectedTarget)?.name
        : null,
      confirmedCount: game.nightActions.vampire.confirmedBy.length,
      doctorTarget: game.nightActions.doctor.target
        ? game.players.find(p => p.id === game.nightActions.doctor.target)?.name
        : null,
      seerTarget: game.nightActions.seer.target
        ? game.players.find(p => p.id === game.nightActions.seer.target)?.name
        : null,
      seerResult: game.nightActions.seer.result
    },
    votes: Object.entries(game.votes).reduce((acc, [vid, tid]) => {
      const voter = game.players.find(p => p.id === vid);
      const target = game.players.find(p => p.id === tid);
      acc.push({ voter: voter?.name, target: target?.name ?? tid });
      return acc;
    }, []),
    vampireChat: game.vampireChat
  };
}

function playerName(id) {
  return game.players.find(p => p.id === id)?.name || null;
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

function getPlayerScreen(player) {
  if (!player) return { screen: 'Bilinmiyor', headline: 'Oyuncu yok', detail: '' };
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
        detail: `${game.players.filter(p => !p.disconnected).length} / 6 oyuncu lobide.`
      };
    case 'role_reveal':
      return {
        screen: 'Rol Açıklaması',
        headline: `Rolünü görür: ${roleLabel(player.role)}`,
        detail: player.role === 'vampire'
          ? `Diğer vampir: ${game.players.filter(p => p.role === 'vampire' && p.id !== player.id).map(p => p.name).join(', ') || '-'}`
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
            : `Hedef: ${playerName(game.nightActions.vampire.selectedTarget) || 'seçilmedi'}; onay: ${game.nightActions.vampire.confirmedBy.length}/${getAlivePlayers().filter(p => p.role === 'vampire').length}`
        };
      }
      if (player.role === 'doctor') {
        return {
          screen: 'Gece - Doktor',
          headline: firstNightSkip ? 'İlk gece koruma kapalı' : 'Korunacak kişiyi seçer',
          detail: firstNightSkip ? 'Sabahı bekler.' : `Koruma: ${playerName(game.nightActions.doctor.target) || 'seçilmedi'}`
        };
      }
      if (player.role === 'seer') {
        const result = game.nightActions.seer.result;
        return {
          screen: 'Gece - Kahin',
          headline: 'Sorgulanacak kişiyi seçer',
          detail: game.nightActions.seer.target
            ? `${playerName(game.nightActions.seer.target)} sonucu: ${result ? (result.isVampire ? 'Vampir' : 'Temiz') : 'bekleniyor'}`
            : 'Henüz seçim yapılmadı.'
        };
      }
      return {
        screen: 'Gece - Köylü',
        headline: 'Uyuyor',
        detail: 'Gece aksiyonu yok.'
      };
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
        detail: vote ? `Oy: ${vote === 'abstain' ? 'Çekimser' : playerName(vote)}` : `${Object.keys(game.votes).length}/${getAlivePlayers().length} oy kullanıldı.`
      };
    }
    case 'game_over':
      return {
        screen: 'Oyun Sonu',
        headline: `Kazanan: ${game.winner || '-'}`,
        detail: 'Tüm roller görünür.'
      };
    default:
      return { screen: phaseLabel(game.phase), headline: '', detail: '' };
  }
}

function buildTestDashboardData() {
  return {
    phase: game.phase,
    phaseLabel: phaseLabel(game.phase),
    dayNumber: game.dayNumber,
    withSeer: game.withSeer,
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
      screen: getPlayerScreen(p)
    })),
    spectator: buildSpectatorData()
  };
}

function sendTestDashboardUpdate() {
  io.to('test-dashboard').emit('test_dashboard_update', buildTestDashboardData());
}

function sendLobbyUpdate() {
  const players = game.players.map(p => ({
    id: p.id, name: p.name, isHost: p.isHost,
    connected: !p.disconnected
  }));
  game.players.forEach(p => {
    const s = io.sockets.sockets.get(p.socketId);
    if (s) {
      s.emit('lobby_update', {
        players,
        isHost: p.isHost,
        gameState: { phase: game.phase, discussDuration: game.discussDuration, noKillFirstNight: game.noKillFirstNight }
      });
    }
  });
  sendTestDashboardUpdate();
}

// ─── Phase Logic ─────────────────────────────────────────────────────────────

function startNight() {
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

  io.emit('phase_change', {
    phase: 'night',
    data: {
      dayNumber: game.dayNumber,
      alivePlayers: getAlivePlayers().map(p => ({ id: p.id, name: p.name })),
      noKillFirstNight: game.noKillFirstNight
    }
  });
  sendSpectatorUpdate();
  sendTestDashboardUpdate();
}

function checkNightComplete() {
  if (game.phase !== 'night') return;

  const alive = getAlivePlayers();
  const vampires = alive.filter(p => p.role === 'vampire');
  const doctor = alive.find(p => p.role === 'doctor');
  const seer = game.withSeer ? alive.find(p => p.role === 'seer') : null;

  // İlk gece öldürme yoksa vampir ve doktor beklenmez, sadece kahin
  const firstNightSkip = game.noKillFirstNight && game.dayNumber === 1;

  let vampireDone;
  if (firstNightSkip || vampires.length === 0) {
    vampireDone = true;
  } else if (vampires.length === 1) {
    vampireDone = game.nightActions.vampire.selectedTarget !== null;
  } else {
    vampireDone = game.nightActions.vampire.selectedTarget !== null
      && game.nightActions.vampire.confirmedBy.length >= vampires.length;
  }

  const doctorDone = firstNightSkip || !doctor || game.nightActions.doctor.target !== null;
  // Kahin oyundaysa ve hayattaysa mutlaka seçim yapmalı
  const seerDone = !seer || game.nightActions.seer.target !== null;

  console.log(`[Gece ${game.dayNumber}] vampir:${vampireDone} doktor:${doctorDone} kahin:${seerDone} (withSeer:${game.withSeer})`);

  if (vampireDone && doctorDone && seerDone) {
    resolveNight();
  }
}

function resolveNight() {
  const vampireTargetId = game.nightActions.vampire.selectedTarget;
  const doctorTargetId = game.nightActions.doctor.target;

  // Doctor self-protect tracking
  let newLastSelfProtect = game.nightActions.doctor.lastSelfProtect;
  if (doctorTargetId) {
    const doc = game.players.find(p => p.role === 'doctor' && p.alive);
    if (doc && doctorTargetId === doc.id) {
      newLastSelfProtect = game.dayNumber;
    }
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

  io.emit('phase_change', { phase: 'day_reveal', data: revealData });
  sendSpectatorUpdate();
  sendTestDashboardUpdate();

  const winner = checkWinCondition();
  if (winner) {
    game.winner = winner;
    game.phase = 'game_over';
    setTimeout(() => {
      io.emit('game_over', { winner, allRoles: getAllRoles() });
    }, 4000);
    return;
  }

  setTimeout(() => startDiscuss(), 5000);
}

function startDiscuss() {
  if (game.phase !== 'day_reveal') return;
  game.phase = 'day_discuss';
  game.discussStartTime = Date.now();
  if (game.discussTimer) clearTimeout(game.discussTimer);

  io.emit('phase_change', {
    phase: 'day_discuss',
    data: { duration: game.discussDuration, dayNumber: game.dayNumber, remainingSeconds: game.discussDuration * 60 }
  });
  sendSpectatorUpdate();
  sendTestDashboardUpdate();

  game.discussTimer = setTimeout(() => startVoting(), game.discussDuration * 60 * 1000);
}

function startVoting() {
  if (game.phase !== 'day_discuss') return;
  if (game.discussTimer) { clearTimeout(game.discussTimer); game.discussTimer = null; }

  game.phase = 'day_vote';
  game.votes = {};

  const alive = getAlivePlayers();
  io.emit('phase_change', {
    phase: 'day_vote',
    data: { voters: alive.map(p => ({ id: p.id, name: p.name })) }
  });
  sendSpectatorUpdate();
  sendTestDashboardUpdate();

  if (game.voteTimer) clearTimeout(game.voteTimer);
  game.voteTimer = setTimeout(() => resolveVoting(), 60 * 1000);
}

function resolveVoting() {
  if (game.voteTimer) { clearTimeout(game.voteTimer); game.voteTimer = null; }
  if (game.phase !== 'day_vote') return;

  const alive = getAlivePlayers();
  const voteCounts = {};

  for (const voter of alive) {
    const vote = game.votes[voter.id];
    if (vote && vote !== 'abstain') {
      voteCounts[vote] = (voteCounts[vote] || 0) + 1;
    }
  }

  let maxVotes = 0;
  let topPlayers = [];
  for (const [pid, count] of Object.entries(voteCounts)) {
    if (count > maxVotes) { maxVotes = count; topPlayers = [pid]; }
    else if (count === maxVotes) topPlayers.push(pid);
  }

  const voteBreakdown = alive.map(p => ({
    id: p.id, name: p.name, votes: voteCounts[p.id] || 0
  }));

  let hangedName = null, hangedRole = null;

  if (topPlayers.length === 1 && maxVotes > 0) {
    const hanged = game.players.find(p => p.id === topPlayers[0]);
    if (hanged && hanged.alive) {
      hanged.alive = false;
      hangedName = hanged.name;
      hangedRole = hanged.role;
    }
  }

  io.emit('vote_result', { hangedName, hangedRole, voteBreakdown });
  sendSpectatorUpdate();
  sendTestDashboardUpdate();

  const winner = checkWinCondition();
  if (winner) {
    game.winner = winner;
    game.phase = 'game_over';
    setTimeout(() => io.emit('game_over', { winner, allRoles: getAllRoles() }), 4000);
    return;
  }

  if (game.dayNumber >= 10) {
    game.phase = 'game_over';
    setTimeout(() => io.emit('game_over', { winner: 'draw', allRoles: getAllRoles() }), 4000);
    return;
  }

  setTimeout(() => startNight(), 4000);
}

// ─── Socket.IO ───────────────────────────────────────────────────────────────

io.on('connection', (socket) => {

  socket.on('test_observe', () => {
    socket.join('test-dashboard');
    socket.emit('test_dashboard_update', buildTestDashboardData());
  });

  socket.on('test_seed_lobby', () => {
    if (game.discussTimer) clearTimeout(game.discussTimer);
    if (game.voteTimer) clearTimeout(game.voteTimer);
    game = makeGame();
    const names = ['Ada', 'Bora', 'Cem', 'Derya', 'Ece', 'Fırat'];
    game.players = names.map((name, index) => ({
      id: `test-${index + 1}`,
      name,
      role: null,
      alive: true,
      socketId: null,
      isHost: index === 0,
      disconnected: false
    }));
    sendLobbyUpdate();
    sendTestDashboardUpdate();
  });

  socket.on('test_start_game', ({ withSeer = true, noKillFirstNight = false } = {}) => {
    if (game.phase !== 'lobby') return;
    if (game.players.length !== 6) return;

    game.withSeer = !!withSeer;
    game.noKillFirstNight = !!noKillFirstNight;

    const roles = ['vampire', 'vampire', 'doctor',
      ...(game.withSeer ? ['seer', 'villager', 'villager'] : ['villager', 'villager', 'villager'])];
    for (let i = roles.length - 1; i > 0; i--) {
      const j = randomInt(0, i + 1);
      [roles[i], roles[j]] = [roles[j], roles[i]];
    }
    game.players.forEach((p, i) => { p.role = roles[i]; p.alive = true; });
    game.phase = 'role_reveal';
    io.emit('phase_change', { phase: 'role_reveal', data: {} });
    sendTestDashboardUpdate();
    setTimeout(() => startNight(), 5000);
  });

  socket.on('test_auto_night', () => {
    if (game.phase !== 'night') return;
    const alive = getAlivePlayers();
    const firstNightSkip = game.noKillFirstNight && game.dayNumber === 1;
    const vampires = alive.filter(p => p.role === 'vampire');
    const doctor = alive.find(p => p.role === 'doctor');
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
    sendSpectatorUpdate();
    sendTestDashboardUpdate();
    checkNightComplete();
  });

  socket.on('test_auto_vote', () => {
    if (game.phase === 'day_discuss') startVoting();
    if (game.phase !== 'day_vote') return;
    const alive = getAlivePlayers();
    const target = alive.find(p => p.role === 'vampire') || alive[0];
    if (!target) return;
    alive.forEach(p => {
      game.votes[p.id] = p.id === target.id ? 'abstain' : target.id;
    });
    const voteList = Object.entries(game.votes).map(([vid, tid]) => ({
      voterName: game.players.find(p => p.id === vid)?.name,
      targetName: tid === 'abstain' ? 'Çekimser' : game.players.find(p => p.id === tid)?.name
    }));
    io.emit('vote_update', { votedCount: alive.length, totalVoters: alive.length, votes: voteList });
    sendSpectatorUpdate();
    sendTestDashboardUpdate();
    resolveVoting();
  });

  socket.on('hello', ({ playerId }) => {
    const existing = game.players.find(p => p.id === playerId);
    if (existing) {
      // Eğer aynı ID için başka bir aktif socket varsa → yeni oturum aç
      const prevSocket = io.sockets.sockets.get(existing.socketId);
      if (prevSocket && prevSocket.id !== socket.id) {
        socket.emit('new_session', {});
        return;
      }

      // Lobby'de "bağlantı kesik" timer varsa iptal et
      if (existing.removeTimer) {
        clearTimeout(existing.removeTimer);
        existing.removeTimer = null;
      }
      existing.disconnected = false;
      existing.socketId = socket.id;
      socket.emit('reconnected', {
        phase: game.phase,
        player: {
          id: existing.id, name: existing.name, role: existing.role,
          alive: existing.alive, isHost: existing.isHost
        },
        fellowVampires: existing.role === 'vampire'
          ? game.players.filter(p => p.role === 'vampire' && p.id !== existing.id).map(p => p.name)
          : [],
        nightData: existing.role === 'vampire' && game.phase === 'night' ? {
          vampireChat: game.vampireChat,
          selection: {
            targetId: game.nightActions.vampire.selectedTarget,
            confirmedBy: game.nightActions.vampire.confirmedBy
          }
        } : null,
        seerResult: existing.role === 'seer' && game.nightActions.seer.result
          ? game.nightActions.seer.result
          : null,
        phaseData: getPhaseData(),
        allRoles: game.phase === 'game_over' ? getAllRoles() : null,
        winner: game.winner,
        alivePlayers: getAlivePlayers().map(p => ({ id: p.id, name: p.name }))
      });

      if (!existing.alive) {
        setTimeout(() => {
          const s = io.sockets.sockets.get(existing.socketId);
          if (s) s.emit('spectator_update', buildSpectatorData());
        }, 200);
      }
    } else {
      socket.emit('new_session', {});
    }
  });

  socket.on('join_lobby', ({ name, playerId, password }) => {
    if (game.phase !== 'lobby') {
      socket.emit('error', { message: 'Oyun zaten başlamış.' });
      return;
    }

    const trimmed = (name || '').trim();
    if (!trimmed) { socket.emit('error', { message: 'İsim boş olamaz.' }); return; }

    // "Bağlantı kesilmiş" ama hâlâ kayıtlı oyuncuyu restore et
    const ghost = game.players.find(p => p.id === playerId && p.disconnected);
    if (ghost) {
      if (ghost.removeTimer) { clearTimeout(ghost.removeTimer); ghost.removeTimer = null; }
      ghost.disconnected = false;
      ghost.socketId = socket.id;
      ghost.name = trimmed;
      sendLobbyUpdate();
      return;
    }

    if (game.players.length >= 6) {
      socket.emit('error', { message: 'Oyun dolu (maksimum 6 kişi).' });
      return;
    }
    if (game.players.some(p => p.name.toLowerCase() === trimmed.toLowerCase())) {
      socket.emit('error', { message: 'Bu isim zaten kullanılıyor.' }); return;
    }

    // Şifre "1" ise host ol (başka host yoksa)
    const wantsHost = password === '1';
    const hostTaken = game.players.some(p => p.isHost);
    if (wantsHost && hostTaken) {
      socket.emit('error', { message: 'Host zaten var, şifresiz katıl.' }); return;
    }
    const isHost = wantsHost;
    game.players.push({ id: playerId, name: trimmed, role: null, alive: true, socketId: socket.id, isHost });
    sendLobbyUpdate();
  });

  socket.on('kick_player', ({ targetId }) => {
    const player = game.players.find(p => p.socketId === socket.id);
    if (!player?.isHost || game.phase !== 'lobby') return;
    const target = game.players.find(p => p.id === targetId);
    if (!target || target.isHost) return; // host kendini veya başka hostu atamaz

    game.players = game.players.filter(p => p.id !== targetId);
    const targetSocket = io.sockets.sockets.get(target.socketId);
    if (targetSocket) targetSocket.emit('kicked');
    sendLobbyUpdate();
  });

  socket.on('start_game', ({ withSeer, noKillFirstNight }) => {
    const player = game.players.find(p => p.socketId === socket.id);
    if (!player?.isHost) { socket.emit('error', { message: 'Sadece host oyunu başlatabilir.' }); return; }
    if (game.players.length !== 6) { socket.emit('error', { message: '6 oyuncu gerekli.' }); return; }
    if (game.phase !== 'lobby') return;

    game.withSeer = withSeer;
    game.noKillFirstNight = !!noKillFirstNight;

    const roles = ['vampire', 'vampire', 'doctor',
      ...(withSeer ? ['seer', 'villager', 'villager'] : ['villager', 'villager', 'villager'])];

    // Fisher-Yates shuffle (crypto.randomInt — OS-level entropy)
    for (let i = roles.length - 1; i > 0; i--) {
      const j = randomInt(0, i + 1);
      [roles[i], roles[j]] = [roles[j], roles[i]];
    }

    game.players.forEach((p, i) => { p.role = roles[i]; p.alive = true; });

    const vampireNames = game.players.filter(p => p.role === 'vampire').map(p => p.name);

    game.phase = 'role_reveal';

    game.players.forEach(p => {
      const s = io.sockets.sockets.get(p.socketId);
      if (s) {
        s.emit('role_assigned', {
          role: p.role,
          fellowVampires: p.role === 'vampire' ? vampireNames.filter(n => n !== p.name) : []
        });
      }
    });

    io.emit('phase_change', { phase: 'role_reveal', data: {} });
    sendTestDashboardUpdate();
    setTimeout(() => startNight(), 5000);
  });

  socket.on('vampire_select', ({ targetId }) => {
    if (game.phase !== 'night') return;
    const player = game.players.find(p => p.socketId === socket.id);
    if (!player || player.role !== 'vampire' || !player.alive) return;
    if (!game.players.find(p => p.id === targetId && p.alive)) return;

    const aliveVampires = game.players.filter(p => p.role === 'vampire' && p.alive);
    game.nightActions.vampire.selectedTarget = targetId;
    game.nightActions.vampire.confirmedBy = [player.id];

    if (aliveVampires.length === 1) {
      notifyVampires('vampire_selection_update', {
        targetId, confirmedBy: game.nightActions.vampire.confirmedBy, autoConfirmed: true
      });
      sendSpectatorUpdate();
      sendTestDashboardUpdate();
      checkNightComplete();
    } else {
      notifyVampires('vampire_selection_update', {
        targetId, confirmedBy: game.nightActions.vampire.confirmedBy, autoConfirmed: false
      });
      sendSpectatorUpdate();
      sendTestDashboardUpdate();
    }
  });

  socket.on('vampire_confirm', () => {
    if (game.phase !== 'night') return;
    const player = game.players.find(p => p.socketId === socket.id);
    if (!player || player.role !== 'vampire' || !player.alive) return;
    if (!game.nightActions.vampire.selectedTarget) return;

    if (!game.nightActions.vampire.confirmedBy.includes(player.id)) {
      game.nightActions.vampire.confirmedBy.push(player.id);
    }

    const aliveVampires = game.players.filter(p => p.role === 'vampire' && p.alive);
    notifyVampires('vampire_selection_update', {
      targetId: game.nightActions.vampire.selectedTarget,
      confirmedBy: game.nightActions.vampire.confirmedBy,
      autoConfirmed: false
    });
    sendSpectatorUpdate();
    sendTestDashboardUpdate();

    if (game.nightActions.vampire.confirmedBy.length >= aliveVampires.length) {
      checkNightComplete();
    }
  });

  socket.on('vampire_message', ({ text }) => {
    if (game.phase !== 'night') return;
    const player = game.players.find(p => p.socketId === socket.id);
    if (!player || player.role !== 'vampire' || !player.alive) return;
    const trimmed = (text || '').trim();
    if (!trimmed) return;

    const msg = { name: player.name, message: trimmed, timestamp: Date.now() };
    game.vampireChat.push(msg);
    notifyVampires('vampire_chat_update', { messages: game.vampireChat });
    sendTestDashboardUpdate();
  });

  socket.on('doctor_select', ({ targetId }) => {
    if (game.phase !== 'night') return;
    const player = game.players.find(p => p.socketId === socket.id);
    if (!player || player.role !== 'doctor' || !player.alive) return;

    if (targetId === player.id && game.nightActions.doctor.lastSelfProtect === game.dayNumber - 1) {
      socket.emit('error', { message: 'Art arda iki gece kendinizi koruyamazsınız.' });
      return;
    }

    if (!game.players.find(p => p.id === targetId && p.alive)) return;

    game.nightActions.doctor.target = targetId;
    const targetName = game.players.find(p => p.id === targetId)?.name;
    socket.emit('doctor_confirmed', { targetName });
    sendSpectatorUpdate();
    sendTestDashboardUpdate();
    checkNightComplete();
  });

  socket.on('seer_select', ({ targetId }) => {
    if (game.phase !== 'night') return;
    const player = game.players.find(p => p.socketId === socket.id);
    if (!player || player.role !== 'seer' || !player.alive) return;

    const target = game.players.find(p => p.id === targetId && p.alive && p.id !== player.id);
    if (!target) return;

    game.nightActions.seer.target = targetId;
    const result = { targetName: target.name, isVampire: target.role === 'vampire' };
    game.nightActions.seer.result = result;
    socket.emit('seer_result', result);
    sendSpectatorUpdate();
    sendTestDashboardUpdate();
    // Kahin sonucu okusun, 3 saniye sonra gece kontrolü
    setTimeout(() => checkNightComplete(), 3000);
  });

  socket.on('cast_vote', ({ targetId }) => {
    if (game.phase !== 'day_vote') return;
    const player = game.players.find(p => p.socketId === socket.id);
    if (!player || !player.alive) return;

    game.votes[player.id] = targetId;

    const alive = getAlivePlayers();
    const votedCount = Object.keys(game.votes).length;
    const voteList = Object.entries(game.votes).map(([vid, tid]) => ({
      voterName: game.players.find(p => p.id === vid)?.name,
      targetName: tid === 'abstain' ? 'Çekimser' : game.players.find(p => p.id === tid)?.name
    }));
    io.emit('vote_update', { votedCount, totalVoters: alive.length, votes: voteList });
    sendSpectatorUpdate();
    sendTestDashboardUpdate();

    if (votedCount >= alive.length) {
      if (game.voteTimer) { clearTimeout(game.voteTimer); game.voteTimer = null; }
      resolveVoting();
    }
  });

  socket.on('start_voting', () => {
    const player = game.players.find(p => p.socketId === socket.id);
    if (!player?.isHost || game.phase !== 'day_discuss') return;
    startVoting();
  });

  socket.on('set_discuss_duration', ({ minutes }) => {
    const player = game.players.find(p => p.socketId === socket.id);
    if (!player?.isHost) return;
    if ([3, 5, 7].includes(minutes)) game.discussDuration = minutes;
  });

  socket.on('force_end_game', () => {
    const player = game.players.find(p => p.socketId === socket.id);
    if (!player?.isHost) return;
    if (game.phase === 'lobby' || game.phase === 'game_over') return;
    if (game.discussTimer) clearTimeout(game.discussTimer);
    if (game.voteTimer)    clearTimeout(game.voteTimer);
    game.phase = 'game_over';
    game.winner = 'ended';
    io.emit('game_over', { winner: 'ended', allRoles: getAllRoles() });
    sendTestDashboardUpdate();
  });

  socket.on('new_game', () => {
    const player = game.players.find(p => p.socketId === socket.id);
    if (!player?.isHost || game.phase !== 'game_over') return;

    if (game.discussTimer) clearTimeout(game.discussTimer);
    if (game.voteTimer) clearTimeout(game.voteTimer);

    const survivors = game.players.map(p => ({
      id: p.id, name: p.name, socketId: p.socketId,
      isHost: p.isHost, role: null, alive: true
    }));
    game = makeGame();
    game.players = survivors;

    sendLobbyUpdate();
  });

  socket.on('disconnect', () => {
    const player = game.players.find(p => p.socketId === socket.id);
    if (!player) return;

    if (game.phase === 'lobby') {
      // 30 saniye bekle, reconnect etmezse çıkar. Host kalıcı — transfer yok.
      player.disconnected = true;
      sendLobbyUpdate();
      player.removeTimer = setTimeout(() => {
        game.players = game.players.filter(p => p.id !== player.id);
        sendLobbyUpdate();
      }, 30000);
    }
    // Oyun sırasında: hiçbir şey yapma, oyuncu reconnect eder.
    // Host kalıcıdır — transfer edilmez.
  });
});

function getPhaseData() {
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
      return { voters: getAlivePlayers().map(p => ({ id: p.id, name: p.name })) };
    default:
      return {};
  }
}

const PORT = Number(process.env.PORT || 3000);

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`\nVampir Köylü sunucu çalışıyor!`);
  console.log(`  Yerel:   http://localhost:${PORT}`);
  console.log(`\nTelefonlar için IP adresini öğrenmek üzere şunu çalıştır:`);
  console.log(`  ipconfig getifaddr en0\n`);
});
