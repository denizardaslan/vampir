'use strict';

// ─── Player Identity ─────────────────────────────────────────────────────────
// sessionStorage: her tab kendi ID'sine sahip (test için kritik),
// sayfa yenilemede korunur (reconnect çalışır), tab kapatınca silinir.

function generateUUID() {
  // crypto.randomUUID eski iOS/Android'de yok, güvenli fallback
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    try { return crypto.randomUUID(); } catch (e) {}
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

function storageGet(key) {
  try { return sessionStorage.getItem(key); } catch (e) { return null; }
}
function storageSet(key, val) {
  try { sessionStorage.setItem(key, val); } catch (e) {}
}

let myPlayerId = storageGet('vk_player_id');
if (!myPlayerId) {
  myPlayerId = generateUUID();
  storageSet('vk_player_id', myPlayerId);
}

// ─── Client State ────────────────────────────────────────────────────────────
let myRole = null;
let myName = storageGet('vk_player_name');
let myLobbyCode = null;
let pendingJoinLobbyId = null;
let isHost = false;
let isAlive = true;
let fellowVampires = [];
let currentPhase = null;
let myDayNumber = 0;
let lastSelfProtectDay = -2;

// Per-phase transient state
let myVampireTargetId = null;
let iHaveConfirmed = false;
let seerDone = false;
let doctorDone = false;
let hasVoted = false;
let pendingVoteTargetId = null;
let noKillFirstNight = false;
let withDoctor = true;
let withSeer = true;
let vampireCount = 2;

let discussTimerInterval = null;
let voteTimerInterval = null;

// Alive players cache (updated from server events)
let _alivePlayers = [];
function getAlivePlayers() { return _alivePlayers; }
function setAlivePlayers(arr) { _alivePlayers = arr || []; }

// ─── Socket ──────────────────────────────────────────────────────────────────
const socket = io();

// Yükleme ekranı takılmasın: sunucudan yanıt gelmezse isim girişini göster
const _loadingFallback = setTimeout(() => {
  if (document.getElementById('screen-loading').classList.contains('active')) {
    if (myName) showLobbyBrowser(); else showScreen('name-entry');
  }
}, 2000);

socket.on('connect', () => socket.emit('hello', { playerId: myPlayerId }));

socket.on('connect_error', () => {
  clearTimeout(_loadingFallback);
  if (document.getElementById('screen-loading').classList.contains('active')) {
    if (myName) showLobbyBrowser(); else showScreen('name-entry');
    showToast('Sunucuya bağlanılamadı, tekrar deneniyor...');
  }
});

// ─── Screen Management ───────────────────────────────────────────────────────
function showBtnForceEnd() {
  if (isHost) document.getElementById('btn-force-end').classList.remove('hidden');
}
function hideBtnForceEnd() {
  document.getElementById('btn-force-end').classList.add('hidden');
  document.getElementById('force-end-overlay').classList.add('hidden');
}

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(el => el.classList.remove('active'));
  const el = document.getElementById('screen-' + id);
  if (el) { el.classList.add('active'); el.scrollTop = 0; }

  const night = ['night-vampire', 'night-doctor', 'night-seer', 'night-villager', 'role-reveal'];
  const day = ['day-reveal', 'day-discuss', 'day-vote'];
  document.body.className = night.includes(id) ? 'theme-night'
    : day.includes(id) ? 'theme-day'
    : id === 'spectator' ? 'theme-spectator'
    : '';

  const gameScreens = ['night-vampire','night-doctor','night-seer','night-villager',
                       'day-reveal','day-discuss','day-vote','spectator','role-reveal','death-flash'];
  if (gameScreens.includes(id)) showBtnForceEnd(); else hideBtnForceEnd();
}

// ─── Socket Events ────────────────────────────────────────────────────────────

socket.on('new_session', () => {
  clearTimeout(_loadingFallback);
  if (myName) {
    showLobbyBrowser();
  } else {
    showScreen('name-entry');
  }
});

socket.on('lobby_list', (data) => {
  renderLobbyList(data.lobbies || []);
});

socket.on('reconnected', (data) => {
  clearTimeout(_loadingFallback);
  myLobbyCode  = data.lobbyCode || myLobbyCode;
  myRole       = data.player.role;
  myName       = data.player.name;
  isHost       = data.player.isHost;
  isAlive      = data.player.alive;
  fellowVampires = data.fellowVampires || [];
  currentPhase = data.phase;

  if (data.alivePlayers) setAlivePlayers(data.alivePlayers);

  // game_over herkese gösterilir — ölü/canlı fark etmez, önce kontrol et
  if (data.phase === 'game_over') {
    if (data.allRoles) showGameOver(data.winner, data.allRoles);
    return;
  }

  if (!isAlive) {
    showScreen('spectator');
    updateSpectatorPhaseLabel(data.phase);
    return;
  }

  switch (data.phase) {
    case 'lobby':
      showScreen('lobby');
      break;
    case 'role_reveal':
      showRoleReveal();
      break;
    case 'night':
      myDayNumber = data.phaseData?.dayNumber || 1;
      updateDayNums(myDayNumber);
      if (myRole === 'vampire' && data.nightData) {
        updateVampireChat(data.nightData.vampireChat || []);
        if (data.nightData.selection.targetId) {
          myVampireTargetId = data.nightData.selection.targetId;
          updateVampireSelectionUI(data.nightData.selection);
        }
      }
      if (myRole === 'seer' && data.seerResult) showSeerResult(data.seerResult);
      showNightScreen();
      break;
    case 'day_reveal':
      showScreen('day-reveal');
      if (data.phaseData) showRevealContent(data.phaseData);
      break;
    case 'day_discuss':
      myDayNumber = data.phaseData?.dayNumber || 1;
      updateDayNums(myDayNumber);
      startDiscussTimer(data.phaseData?.duration || 5, data.phaseData?.remainingSeconds);
      showScreen('day-discuss');
      if (isHost) showEl('host-vote-btn-wrap'); else hideEl('host-vote-btn-wrap');
      break;
    case 'day_vote':
      showScreen('day-vote');
      if (data.phaseData) populateVoteList(data.phaseData.voters);
      break;
  }
});

socket.on('lobby_update', (data) => {
  currentPhase = 'lobby';
  if (!myName) return;
  myLobbyCode = data.lobbyCode || myLobbyCode;
  isHost = data.isHost;
  isAlive = true;
  if (data.gameState) {
    withDoctor = data.gameState.withDoctor !== false;
    withSeer = data.gameState.withSeer !== false;
    vampireCount = data.gameState.vampireCount || vampireCount;
    noKillFirstNight = !!data.gameState.noKillFirstNight;
  }
  if (data.players) setAlivePlayers(data.players);
  showScreen('lobby');
  updateLobbyUI(data);
});

socket.on('role_assigned', (data) => {
  myRole = data.role;
  fellowVampires = data.fellowVampires || [];
});

socket.on('phase_change', (data) => {
  currentPhase = data.phase;

  // Cache alive players whenever server sends them
  if (data.data?.alivePlayers) setAlivePlayers(data.data.alivePlayers);
  if (data.data?.voters)       setAlivePlayers(data.data.voters);

  switch (data.phase) {
    case 'role_reveal':
      playSound('role');
      showRoleReveal();
      break;

    case 'night':
      playSound('night');
      myDayNumber = data.data?.dayNumber || myDayNumber;
      noKillFirstNight = !!(data.data?.noKillFirstNight);
      updateDayNums(myDayNumber);
      myVampireTargetId = null;
      iHaveConfirmed = false;
      seerDone = false;
      doctorDone = false;
      hasVoted = false;
      clearVampireSelectionUI();
      if (!isAlive) { showScreen('spectator'); updateSpecHostPanel('night'); break; }
      showNightScreen();
      break;

    case 'day_reveal':
      stopTimers();
      const diedSelf = !!(data.data?.deathName && data.data.deathName === myName);
      if (diedSelf) isAlive = false;
      if (data.data?.deathName) {
        playSound('death');
        showDeathFlash(diedSelf, data.data.deathName, 'killed', () => {
          if (!isAlive) { showScreen('spectator'); updateSpecHostPanel('day_reveal'); }
          else { showScreen('day-reveal'); showRevealContent(data.data); }
        });
      } else {
        playSound('safe');
        showScreen('day-reveal');
        showRevealContent(data.data);
      }
      break;

    case 'day_discuss':
      playSound('day');
      myDayNumber = data.data?.dayNumber || myDayNumber;
      updateDayNums(myDayNumber);
      startDiscussTimer(data.data?.duration || 5, data.data?.remainingSeconds);
      if (!isAlive) { showScreen('spectator'); updateSpecHostPanel('day_discuss'); break; }
      showScreen('day-discuss');
      if (isHost) showEl('host-vote-btn-wrap'); else hideEl('host-vote-btn-wrap');
      break;

    case 'day_vote':
      playSound('vote');
      stopTimers();
      if (!isAlive) { showScreen('spectator'); updateSpecHostPanel('day_vote'); break; }
      showScreen('day-vote');
      hasVoted = false;
      populateVoteList(data.data?.voters || []);
      startVoteCountdown();
      break;
  }
});

socket.on('vampire_chat_update', (data) => {
  updateVampireChat(data.messages);
});

socket.on('vampire_selection_update', (data) => {
  myVampireTargetId = data.targetId;
  updateVampireSelectionUI(data);
});

socket.on('doctor_confirmed', (data) => {
  doctorDone = true;
  const el = document.getElementById('doctor-confirmed');
  if (el) { el.textContent = `✓ ${data.targetName}'ı koruyorsun. Bekleniyor...`; showEl('doctor-confirmed'); }
  disableTargetList('doctor-target-list');
});

socket.on('seer_result', (data) => {
  seerDone = true;
  showSeerResult(data);
  disableTargetList('seer-target-list');
});

socket.on('vote_update', (data) => {
  const el = document.getElementById('vote-progress');
  if (!el) return;
  let html = `<div class="vote-count">${data.votedCount} / ${data.totalVoters} oy kullandı</div>`;
  if (data.votes?.length) {
    html += `<ul class="live-votes">${data.votes.map(v => `<li>${v.voterName} → <strong>${v.targetName}</strong></li>`).join('')}</ul>`;
  }
  el.innerHTML = html;
});

socket.on('vote_result', (data) => {
  stopTimers();
  if (data.hangedName && data.hangedName === myName) isAlive = false;

  if (data.hangedName) {
    playSound('hanged');
    const isSelf = (data.hangedName === myName);
    showDeathFlash(isSelf, data.hangedName, 'hanged', () => {
      const el = document.getElementById('vote-progress');
      if (el) {
        el.innerHTML = `<div class="reveal-death"><span class="death-icon">🪦</span><strong>${data.hangedName}</strong> asıldı.</div>`;
        const bd = data.voteBreakdown.map(v => `<li>${v.name}: <b>${v.votes}</b> oy</li>`).join('');
        el.innerHTML += `<ul class="vote-breakdown">${bd}</ul>`;
      }
      hideEl('vote-selection');
      hideEl('vote-confirm-panel');
      hideEl('vote-done-msg');
      if (!isAlive) { showScreen('spectator'); updateSpecHostPanel('day_vote'); }
      else showScreen('day-vote');
    });
  } else {
    playSound('safe');
    const el = document.getElementById('vote-progress');
    if (el) {
      el.innerHTML = `<div class="reveal-safe"><span>🤝</span> Eşit oy — kimse asılmadı.</div>`;
      const bd = data.voteBreakdown.map(v => `<li>${v.name}: <b>${v.votes}</b> oy</li>`).join('');
      el.innerHTML += `<ul class="vote-breakdown">${bd}</ul>`;
    }
    hideEl('vote-selection');
    hideEl('vote-confirm-panel');
    hideEl('vote-done-msg');
  }
});

socket.on('game_over', (data) => {
  stopTimers();
  currentPhase = 'game_over';
  if (data.winner === 'villagers') playSound('win_villagers');
  else if (data.winner === 'vampires') playSound('win_vampires');
  showGameOver(data.winner, data.allRoles);
});

socket.on('kicked', () => {
  myRole = null;
  isHost = false;
  storageSet('vk_player_id', generateUUID()); // yeni ID al, lobiye taze giriş
  myPlayerId = storageGet('vk_player_id');
  showToast('Lobi\'den çıkarıldınız.');
  showLobbyBrowser();
});

socket.on('became_host', () => {
  isHost = true;
  if (currentPhase === 'day_discuss') showEl('host-vote-btn-wrap');
  if (currentPhase === 'lobby') { showEl('host-controls'); hideEl('lobby-waiting'); }
  showToast('Artık hostsun!');
});

socket.on('spectator_update', (data) => {
  if (data.players) setAlivePlayers(data.players.filter(p => p.alive));
  if (!isAlive && currentPhase !== 'game_over') {
    showScreen('spectator');
    updateSpectatorUI(data);
    updateSpecHostPanel(data.phase);
  } else if (!isAlive) {
    updateSpectatorUI(data);
  }
});

socket.on('error', (data) => {
  const onBrowser = document.getElementById('screen-lobby-browser')?.classList.contains('active');
  showError(data.message, onBrowser ? 'error-lobby-browser' : 'error-name');
});

// ─── UI Builders ──────────────────────────────────────────────────────────────

function showRoleReveal() {
  showScreen('role-reveal');
  const icons  = { vampire: '🧛', doctor: '👨‍⚕️', seer: '🔮', villager: '🧑‍🌾' };
  const descs  = {
    vampire:  'Her gece bir köylüyü öldür. Diğer vampirle koordineli hareket et.',
    doctor:   'Her gece birini koru (art arda kendinizi koruyamazsınız).',
    seer:     'Her gece bir kişinin vampir olup olmadığını öğren.',
    villager: 'Gündüzleri vampirleri bul ve as!'
  };
  document.getElementById('role-icon').textContent  = icons[myRole]  || '❓';
  document.getElementById('role-name').textContent  = roleLabel(myRole);
  document.getElementById('role-desc').textContent  = descs[myRole]  || '';

  const fv = document.getElementById('fellow-vampires');
  if (myRole === 'vampire' && fellowVampires.length > 0) {
    fv.textContent = `Diğer vampir: ${fellowVampires.join(', ')}`;
    fv.classList.remove('hidden');
  } else {
    fv.classList.add('hidden');
  }

  playSound('role');
  if (navigator.vibrate) navigator.vibrate([200, 100, 200]);

  let count = 5;
  document.getElementById('role-countdown').textContent = count;
  const t = setInterval(() => {
    count--;
    const el = document.getElementById('role-countdown');
    if (el) el.textContent = count;
    if (count <= 0) clearInterval(t);
  }, 1000);
}

function showNightScreen() {
  if (myRole === 'vampire') {
    showScreen('night-vampire');
    const isFirstNightNoKill = noKillFirstNight && myDayNumber === 1;
    if (isFirstNightNoKill) {
      showEl('vampire-no-kill-banner');
      hideEl('vampire-kill-section');
    } else {
      hideEl('vampire-no-kill-banner');
      showEl('vampire-kill-section');
      populateVampireTargets();
    }
  } else if (myRole === 'doctor') {
    showScreen('night-doctor');
    populateDoctorTargets();
  } else if (myRole === 'seer') {
    showScreen('night-seer');
    populateSeerTargets();
  } else {
    showScreen('night-villager');
  }
}

function populateVampireTargets() {
  const list = document.getElementById('vampire-target-list');
  list.innerHTML = '';
  getAlivePlayers().filter(p => p.id !== myPlayerId && !fellowVampires.includes(p.name)).forEach(p => {
    const li = makeTargetItem(p, () => {
      myVampireTargetId = p.id;
      document.querySelectorAll('#vampire-target-list .target-item').forEach(el => el.classList.remove('selected'));
      li.classList.add('selected');
      socket.emit('vampire_select', { targetId: p.id });
    });
    if (myVampireTargetId === p.id) li.classList.add('selected');
    list.appendChild(li);
  });
}

function populateDoctorTargets() {
  if (noKillFirstNight && myDayNumber === 1) {
    showEl('doctor-no-kill-banner');
    document.getElementById('doctor-target-list').innerHTML = '';
    return;
  }
  hideEl('doctor-no-kill-banner');
  const list = document.getElementById('doctor-target-list');
  list.innerHTML = '';
  const cannotSelfProtect = lastSelfProtectDay === myDayNumber - 1;
  getAlivePlayers().forEach(p => {
    const blocked = p.id === myPlayerId && cannotSelfProtect;
    const li = makeTargetItem(p, blocked ? null : () => {
      if (doctorDone) return;
      socket.emit('doctor_select', { targetId: p.id });
    });
    if (blocked) { li.classList.add('disabled'); li.title = 'Bu gece kendinizi koruyamazsınız'; }
    list.appendChild(li);
  });
  if (cannotSelfProtect) showEl('self-protect-warning'); else hideEl('self-protect-warning');
}

function populateSeerTargets() {
  const list = document.getElementById('seer-target-list');
  list.innerHTML = '';
  getAlivePlayers().filter(p => p.id !== myPlayerId).forEach(p => {
    const li = makeTargetItem(p, () => {
      if (seerDone) return;
      socket.emit('seer_select', { targetId: p.id });
    });
    list.appendChild(li);
  });
}

function makeTargetItem(p, onClick) {
  const li = document.createElement('li');
  li.className = 'target-item';
  li.dataset.id = p.id;
  li.textContent = p.name;
  if (onClick) li.addEventListener('click', onClick);
  return li;
}

function updateVampireSelectionUI(data) {
  const status     = document.getElementById('vampire-selection-status');
  const confirmBtn = document.getElementById('btn-vampire-confirm');
  const target     = getAlivePlayers().find(p => p.id === data.targetId);
  const name       = target?.name || '?';

  // Highlight in list
  document.querySelectorAll('#vampire-target-list .target-item').forEach(el => {
    el.classList.toggle('selected', el.dataset.id === data.targetId);
  });

  status.classList.remove('hidden');

  if (data.autoConfirmed) {
    status.textContent = `✓ ${name} seçildi ve onaylandı. Bekleniyor...`;
    confirmBtn.classList.add('hidden');
    iHaveConfirmed = true;
    return;
  }

  const iAmSelector  = data.confirmedBy?.[0] === myPlayerId;
  const iConfirmed   = data.confirmedBy?.includes(myPlayerId);
  const count        = data.confirmedBy?.length || 0;
  const needed       = Math.max(1, fellowVampires.length + 1);

  if (iAmSelector || iConfirmed) {
    status.textContent = `${name} seçildi. (${count}/${needed} onay) Bekleniyor...`;
    confirmBtn.classList.add('hidden');
    iHaveConfirmed = true;
  } else {
    status.textContent = `Diğer vampir ${name}'ı seçti. Onaylıyor musun?`;
    confirmBtn.classList.remove('hidden');
  }
}

function clearVampireSelectionUI() {
  const status = document.getElementById('vampire-selection-status');
  const btn    = document.getElementById('btn-vampire-confirm');
  if (status) { status.textContent = ''; status.classList.add('hidden'); }
  if (btn)    btn.classList.add('hidden');
}

function showSeerResult(data) {
  const el = document.getElementById('seer-result');
  if (!el) return;
  el.classList.remove('hidden');
  el.innerHTML = data.isVampire
    ? `<span class="seer-vampire">🧛 ${data.targetName} VAMPİR!</span>`
    : `<span class="seer-safe">✅ ${data.targetName} vampir değil.</span>`;
}

function showDeathFlash(isSelf, name, verb, callback) {
  const screen = document.getElementById('screen-death-flash');
  const icon   = document.getElementById('death-flash-icon');
  const title  = document.getElementById('death-flash-title');
  const sub    = document.getElementById('death-flash-sub');
  screen.classList.remove('self-death', 'other-death');
  if (isSelf) {
    screen.classList.add('self-death');
    icon.textContent  = '💀';
    title.textContent = 'Öldün!';
    sub.textContent   = verb === 'hanged' ? 'Köylüler seni astı.' : 'Bu gece öldürüldün.';
  } else {
    screen.classList.add('other-death');
    icon.textContent  = verb === 'hanged' ? '🪦' : '🩸';
    title.textContent = name;
    sub.textContent   = verb === 'hanged' ? 'asıldı.' : 'bu gece öldürüldü.';
  }
  showScreen('death-flash');
  setTimeout(() => { callback(); }, 2800);
}

function showRevealContent(data) {
  const el = document.getElementById('reveal-content');
  if (!el) return;
  if (data.deathName) {
    el.innerHTML =
      `<div class="reveal-death">
        <div class="death-icon-big">🩸</div>
        <h2>${data.deathName}</h2>
        <p>bu gece öldürüldü.</p>
      </div>`;
  } else {
    el.innerHTML =
      `<div class="reveal-safe">
        <div class="safe-icon-big">🌅</div>
        <h2>Kimse ölmedi!</h2>
        <p>Doktor bu gece birini kurtardı.</p>
      </div>`;
  }
}

function populateVoteList(voters) {
  const list = document.getElementById('vote-target-list');
  list.innerHTML = '';
  voters.forEach(p => {
    const li = makeTargetItem(p, () => {
      if (hasVoted) return;
      pendingVoteTargetId = p.id;
      document.getElementById('vote-confirm-name').textContent = p.name;
      showEl('vote-confirm-panel');
      hideEl('vote-selection');
    });
    list.appendChild(li);
  });
  showEl('vote-selection');
  hideEl('vote-confirm-panel');
  hideEl('vote-done-msg');
  document.getElementById('vote-progress').textContent = `0 / ${voters.length} oy kullandı`;
}

function updateLobbyUI(data) {
  const players = data.players || [];
  const connected = players.filter(p => p.connected !== false);
  document.getElementById('lobby-count').textContent = `${connected.length} oyuncu`;

  const nameLabel = document.getElementById('lobby-name-label');
  if (nameLabel && data.lobbyName) {
    nameLabel.textContent = data.lobbyName;
    showEl('lobby-meta');
  }
  const passLabel = document.getElementById('lobby-password-label');
  if (passLabel) {
    const strong = passLabel.querySelector('strong');
    if (data.lobbyPassword) {
      if (strong) strong.textContent = data.lobbyPassword;
      passLabel.classList.remove('hidden');
    } else {
      passLabel.classList.add('hidden');
    }
  }

  const list = document.getElementById('lobby-player-list');
  list.innerHTML = '';
  players.forEach(p => {
    const disc = p.connected === false;
    const li = document.createElement('li');
    li.className = disc ? 'player-disconnected' : '';
    li.innerHTML = `
      <span>${p.name}${p.isHost ? ' <span class="host-badge">Host</span>' : ''}${disc ? ' <span class="disc-badge">⏳</span>' : ''}</span>
      ${data.isHost && !p.isHost ? `<button class="btn btn-sm btn-kick" data-id="${p.id}">Çıkar</button>` : ''}
    `;
    list.appendChild(li);
  });
  list.querySelectorAll('.btn-kick').forEach(btn => {
    btn.addEventListener('click', () => socket.emit('kick_player', { targetId: btn.dataset.id }));
  });

  if (data.isHost) {
    showEl('host-controls');
    hideEl('lobby-waiting');
    syncHostControls(data.gameState || {});
    const btn = document.getElementById('btn-start');
    const canStart = connected.length >= 3 && connected.length > vampireCount;
    btn.disabled = !canStart;
    btn.textContent = canStart ? 'Oyunu Başlat!' : `Başlat (${Math.max(3, vampireCount + 1)}+ oyuncu gerekli)`;
  } else {
    hideEl('host-controls');
    showEl('lobby-waiting');
  }
}

function showLobbyBrowser() {
  document.getElementById('browser-player-name').textContent = myName || '';
  hideEl('join-password-panel');
  document.getElementById('input-join-password').value = '';
  showScreen('lobby-browser');
  socket.emit('list_lobbies');
}

function renderLobbyList(lobbies) {
  const list = document.getElementById('open-lobby-list');
  const empty = document.getElementById('empty-lobby-list');
  if (!list) return;

  if (!lobbies.length) {
    list.innerHTML = '';
    showEl('empty-lobby-list');
    return;
  }

  hideEl('empty-lobby-list');
  list.innerHTML = lobbies.map(lobby => `
    <li class="open-lobby-item">
      <span>
        <span class="open-lobby-name">${escHtml(lobby.name)}</span>
        <span class="open-lobby-meta">${lobby.playerCount} oyuncu${lobby.hostName ? ` · Host: ${escHtml(lobby.hostName)}` : ''}${lobby.hasPassword ? ' · Şifreli' : ''}</span>
      </span>
      <button class="btn btn-sm btn-primary btn-open-lobby" data-id="${escHtml(lobby.id)}" data-name="${escHtml(lobby.name)}" data-password="${lobby.hasPassword ? '1' : '0'}">Katıl</button>
    </li>
  `).join('');

  list.querySelectorAll('.btn-open-lobby').forEach(btn => {
    btn.addEventListener('click', () => {
      pendingJoinLobbyId = btn.dataset.id;
      if (btn.dataset.password === '1') {
        document.getElementById('join-password-title').textContent = `${btn.dataset.name} şifresi`;
        document.getElementById('input-join-password').value = '';
        showEl('join-password-panel');
        document.getElementById('input-join-password').focus();
      } else {
        joinSelectedLobby('');
      }
    });
  });
}

function joinSelectedLobby(password) {
  if (!pendingJoinLobbyId || !myName) return;
  socket.emit('join_lobby', {
    name: myName,
    playerId: myPlayerId,
    lobbyId: pendingJoinLobbyId,
    lobbyPassword: password
  });
}

function syncHostControls(gameState) {
  const doctorToggle = document.getElementById('toggle-doctor');
  const seerToggle = document.getElementById('toggle-seer');
  const noKillToggle = document.getElementById('toggle-no-kill');
  if (doctorToggle) doctorToggle.checked = gameState.withDoctor !== false;
  if (seerToggle) seerToggle.checked = gameState.withSeer !== false;
  if (noKillToggle) noKillToggle.checked = !!gameState.noKillFirstNight;

  vampireCount = Number(gameState.vampireCount || vampireCount || 2);
  document.querySelectorAll('.vampire-count-btn').forEach(btn => {
    btn.classList.toggle('active', Number(btn.dataset.count) === vampireCount);
  });

  if (gameState.discussDuration) {
    document.querySelectorAll('.discuss-btn').forEach(btn => {
      btn.classList.toggle('active', Number(btn.dataset.min) === Number(gameState.discussDuration));
    });
  }
}

function updateVampireChat(messages) {
  ['vampire-chat-messages', 'spec-chat'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = messages.map(m =>
      `<div class="chat-msg"><span class="chat-name">${m.name}:</span> ${escHtml(m.message)}</div>`
    ).join('');
    el.scrollTop = el.scrollHeight;
  });
}

function updateSpectatorUI(data) {
  updateSpectatorPhaseLabel(data.phase);

  const pList = document.getElementById('spec-players');
  if (pList) {
    pList.innerHTML = (data.players || []).map(p =>
      `<li class="role-item ${p.alive ? '' : 'dead'}">
        <span class="player-name">${p.name}</span>
        <span class="role-badge role-${p.role}">${roleLabel(p.role)}</span>
        ${p.alive ? '' : '<span class="dead-label">✝</span>'}
      </li>`
    ).join('');
  }

  const aEl = document.getElementById('spec-actions');
  if (aEl) {
    const na = data.nightActions || {};
    const items = [];
    if (na.vampireTarget) {
      const c = na.confirmedCount >= 2 ? '✓ onaylandı' : '⏳ bekleniyor';
      items.push(`<li>🧛 Hedef: <strong>${na.vampireTarget}</strong> — ${c}</li>`);
    }
    if (na.doctorTarget)  items.push(`<li>👨‍⚕️ Koruma: <strong>${na.doctorTarget}</strong></li>`);
    if (na.seerTarget) {
      const r = na.seerResult ? (na.seerResult.isVampire ? ' → 🧛 Vampir' : ' → ✅ Temiz') : '';
      items.push(`<li>🔮 Sorgulama: <strong>${na.seerTarget}</strong>${r}</li>`);
    }
    aEl.innerHTML = items.length ? items.join('') : '<li style="color:var(--text-muted)">Henüz aksiyon yok</li>';
  }

  const vEl = document.getElementById('spec-votes');
  if (vEl) {
    vEl.innerHTML = (data.votes || []).length
      ? data.votes.map(v => `<li>${v.voter} → <strong>${v.target}</strong></li>`).join('')
      : '<li style="color:var(--text-muted)">Henüz oy yok</li>';
  }

  if (data.vampireChat?.length) {
    showEl('spec-chat-section');
    updateVampireChat(data.vampireChat);
  } else {
    hideEl('spec-chat-section');
  }

  const nightPhases = ['night', 'day_reveal'];
  if (nightPhases.includes(data.phase)) showEl('spec-night-section'); else hideEl('spec-night-section');
  if (data.phase === 'day_vote')        showEl('spec-votes-section'); else hideEl('spec-votes-section');
}

function updateSpecHostPanel(phase) {
  if (!isHost) return;
  if (phase === 'day_discuss') showEl('spec-host-panel');
  else hideEl('spec-host-panel');
}

function updateSpectatorPhaseLabel(phase) {
  const labels = {
    night: '🌙 Gece', day_reveal: '🌅 Gündüz Açılışı',
    day_discuss: '💬 Tartışma', day_vote: '🗳️ Oylama',
    game_over: '🏁 Oyun Bitti', lobby: '🏠 Lobi'
  };
  const el = document.getElementById('spectator-phase');
  if (el) el.textContent = labels[phase] || phase;
}

function showGameOver(winner, allRoles) {
  showScreen('game-over');
  const banner = document.getElementById('winner-banner');
  hideBtnForceEnd();
  const configs = {
    vampires:  ['winner-vampires', '🧛', 'Vampirler Kazandı!'],
    villagers: ['winner-villagers', '🎉', 'Köylüler Kazandı!'],
    draw:      ['winner-draw',     '🤝', 'Berabere!'],
    ended:     ['winner-draw',     '⏹',  'Oyun Erken Bitirildi']
  };
  const [cls, icon, text] = configs[winner] || configs.draw;
  banner.innerHTML = `<div class="${cls}"><span>${icon}</span><h2>${text}</h2></div>`;

  document.getElementById('all-roles-list').innerHTML = allRoles.map(p =>
    `<li class="role-item ${p.alive ? '' : 'dead'}">
      <span class="player-name">${p.name}</span>
      <span class="role-badge role-${p.role}">${roleLabel(p.role)}</span>
      ${p.alive ? '' : '<span class="dead-label">✝</span>'}
    </li>`
  ).join('');

  if (isHost) { showEl('host-newgame-wrap'); hideEl('waiting-host-newgame'); }
  else        { hideEl('host-newgame-wrap'); showEl('waiting-host-newgame'); }
}

// ─── Timers ───────────────────────────────────────────────────────────────────
function startDiscussTimer(minutes, remainingSeconds) {
  if (discussTimerInterval) clearInterval(discussTimerInterval);
  let secs = remainingSeconds !== undefined ? remainingSeconds : minutes * 60;
  const mainEl  = document.getElementById('discuss-timer');
  const specEl  = document.getElementById('spec-discuss-timer');
  const render = () => {
    const txt = `${Math.floor(secs/60)}:${String(secs%60).padStart(2,'0')}`;
    if (mainEl) mainEl.textContent = txt;
    if (specEl) specEl.textContent = `⏱ ${txt}`;
  };
  render();
  discussTimerInterval = setInterval(() => {
    secs--;
    render();
    if (secs <= 0) clearInterval(discussTimerInterval);
  }, 1000);
}

function startVoteCountdown() {
  if (voteTimerInterval) clearInterval(voteTimerInterval);
  let secs = 60;
  voteTimerInterval = setInterval(() => { if (--secs <= 0) clearInterval(voteTimerInterval); }, 1000);
}

function stopTimers() {
  if (discussTimerInterval) { clearInterval(discussTimerInterval); discussTimerInterval = null; }
  if (voteTimerInterval)    { clearInterval(voteTimerInterval);    voteTimerInterval    = null; }
}

// ─── UI Event Listeners ───────────────────────────────────────────────────────
document.getElementById('btn-name-next').addEventListener('click', () => {
  const name = document.getElementById('input-name').value.trim();
  if (!name) { showError('İsim giriniz.', 'error-name'); return; }
  myName = name;
  storageSet('vk_player_name', myName);
  showLobbyBrowser();
});

document.getElementById('btn-create-lobby').addEventListener('click', () => {
  const lobbyName = document.getElementById('input-lobby-name').value.trim();
  const password = document.getElementById('input-create-password').value;
  if (!myName) { showScreen('name-entry'); return; }
  if (!lobbyName) { showError('Lobi adı giriniz.', 'error-lobby-browser'); return; }
  socket.emit('create_lobby', { name: myName, playerId: myPlayerId, lobbyName, password });
});

document.getElementById('input-name').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('btn-name-next').click();
});
document.getElementById('input-lobby-name').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('btn-create-lobby').click();
});
document.getElementById('input-create-password').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('btn-create-lobby').click();
});
document.getElementById('btn-refresh-lobbies').addEventListener('click', () => socket.emit('list_lobbies'));
document.getElementById('btn-change-name').addEventListener('click', () => {
  myName = null;
  storageSet('vk_player_name', '');
  showScreen('name-entry');
});
document.getElementById('btn-join-password-confirm').addEventListener('click', () => {
  joinSelectedLobby(document.getElementById('input-join-password').value);
});
document.getElementById('btn-join-password-cancel').addEventListener('click', () => {
  pendingJoinLobbyId = null;
  hideEl('join-password-panel');
});
document.getElementById('input-join-password').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('btn-join-password-confirm').click();
});

document.getElementById('btn-start').addEventListener('click', () => {
  socket.emit('start_game', {
    withDoctor: document.getElementById('toggle-doctor').checked,
    withSeer: document.getElementById('toggle-seer').checked,
    vampireCount,
    noKillFirstNight: document.getElementById('toggle-no-kill').checked
  });
});

function emitRoleConfig() {
  if (!isHost) return;
  socket.emit('set_role_config', {
    withDoctor: document.getElementById('toggle-doctor').checked,
    withSeer: document.getElementById('toggle-seer').checked,
    vampireCount,
    noKillFirstNight: document.getElementById('toggle-no-kill').checked
  });
}

['toggle-doctor', 'toggle-seer', 'toggle-no-kill'].forEach(id => {
  document.getElementById(id).addEventListener('change', emitRoleConfig);
});

document.querySelectorAll('.vampire-count-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    vampireCount = Number(btn.dataset.count);
    document.querySelectorAll('.vampire-count-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    emitRoleConfig();
  });
});

document.querySelectorAll('.discuss-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.discuss-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    socket.emit('set_discuss_duration', { minutes: parseInt(btn.dataset.min) });
  });
});

document.getElementById('btn-vampire-confirm').addEventListener('click', () => {
  socket.emit('vampire_confirm');
  iHaveConfirmed = true;
  document.getElementById('btn-vampire-confirm').classList.add('hidden');
  const s = document.getElementById('vampire-selection-status');
  if (s) s.textContent = 'Onayladın, bekleniyor...';
});

function sendVampireChat() {
  const input = document.getElementById('vampire-chat-input');
  const text = input.value.trim();
  if (!text) return;
  socket.emit('vampire_message', { text });
  input.value = '';
}
document.getElementById('btn-send-chat').addEventListener('click', sendVampireChat);
document.getElementById('vampire-chat-input').addEventListener('keydown', e => { if (e.key === 'Enter') sendVampireChat(); });

document.getElementById('btn-start-voting').addEventListener('click', () => socket.emit('start_voting'));
document.getElementById('btn-start-voting-spec').addEventListener('click', () => socket.emit('start_voting'));

document.getElementById('btn-vote-yes').addEventListener('click', () => {
  if (!pendingVoteTargetId) return;
  socket.emit('cast_vote', { targetId: pendingVoteTargetId });
  hasVoted = true;
  hideEl('vote-confirm-panel');
  hideEl('vote-selection');
  showEl('vote-done-msg');
});

document.getElementById('btn-vote-cancel').addEventListener('click', () => {
  pendingVoteTargetId = null;
  hideEl('vote-confirm-panel');
  showEl('vote-selection');
});

document.getElementById('btn-abstain').addEventListener('click', () => {
  if (hasVoted) return;
  pendingVoteTargetId = 'abstain';
  document.getElementById('vote-confirm-name').textContent = 'çekimser (kimseye oy vermiyorsun)';
  showEl('vote-confirm-panel');
  hideEl('vote-selection');
});

document.getElementById('btn-new-game').addEventListener('click', () => socket.emit('new_game'));

// ─── Force End (host only) ────────────────────────────────────────────────────
document.getElementById('btn-force-end').addEventListener('click', () => {
  document.getElementById('force-end-overlay').classList.remove('hidden');
});
document.getElementById('btn-force-end-no').addEventListener('click', () => {
  document.getElementById('force-end-overlay').classList.add('hidden');
});
document.getElementById('btn-force-end-yes').addEventListener('click', () => {
  document.getElementById('force-end-overlay').classList.add('hidden');
  socket.emit('force_end_game');
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function roleLabel(role) {
  return { vampire: 'Vampir', doctor: 'Doktor', seer: 'Kahin', villager: 'Köylü' }[role] || role;
}

function updateDayNums(n) {
  document.querySelectorAll('.day-num').forEach(el => { el.textContent = n; });
}

function disableTargetList(id) {
  document.querySelectorAll(`#${id} .target-item`).forEach(li => {
    li.classList.add('disabled');
    const clone = li.cloneNode(true);
    li.parentNode.replaceChild(clone, li);
  });
}

function showEl(id) { const el = document.getElementById(id); if (el) el.classList.remove('hidden'); }
function hideEl(id) { const el = document.getElementById(id); if (el) el.classList.add('hidden'); }

function showError(msg, elementId) {
  const el = document.getElementById(elementId || 'error-name');
  if (el) { el.textContent = msg; setTimeout(() => { el.textContent = ''; }, 4000); }
  else showToast(msg);
}

function showToast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

function escHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ─── Ses Sistemi (Web Audio API) ──────────────────────────────────────────────
let _audioCtx = null;
function getAudioCtx() {
  if (!_audioCtx) {
    try {
      _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    } catch (e) { return null; }
  }
  // iOS requires resume after user gesture
  if (_audioCtx.state === 'suspended') _audioCtx.resume();
  return _audioCtx;
}

function tone(freq, start, duration, vol = 0.25, type = 'sine') {
  const ctx = getAudioCtx();
  if (!ctx) return;
  const osc  = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(vol, ctx.currentTime + start);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + start + duration);
  osc.start(ctx.currentTime + start);
  osc.stop(ctx.currentTime + start + duration + 0.05);
}

function playSound(name) {
  try {
    switch (name) {
      case 'night':     // Karanlık, uğursuz iniş
        tone(220, 0.0, 1.2, 0.20, 'sine');
        tone(185, 0.3, 1.4, 0.15, 'sine');
        tone(150, 0.7, 1.8, 0.10, 'sine');
        break;
      case 'day':       // Güneş doğuşu, üç yükselen nota
        tone(440, 0.0, 0.35, 0.20, 'sine');
        tone(554, 0.2, 0.35, 0.20, 'sine');
        tone(659, 0.4, 0.60, 0.25, 'sine');
        break;
      case 'death':     // Ağır, kasvetli
        tone(180, 0.0, 0.8, 0.25, 'sawtooth');
        tone(150, 0.5, 1.2, 0.18, 'sine');
        tone(120, 1.0, 2.0, 0.12, 'sine');
        break;
      case 'vote':      // Gerilim davulu
        [0, 0.35, 0.60, 0.85].forEach(t => tone(90, t, 0.25, 0.3, 'square'));
        break;
      case 'hanged':    // İdam
        tone(200, 0.0, 0.4, 0.22, 'sawtooth');
        tone(150, 0.3, 0.6, 0.18, 'sawtooth');
        tone(100, 0.7, 1.5, 0.15, 'sine');
        break;
      case 'safe':      // Kimse ölmedi
        tone(523, 0.0, 0.35, 0.2, 'sine');
        tone(659, 0.2, 0.50, 0.2, 'sine');
        break;
      case 'role':      // Dramatik rol açılışı
        tone(300, 0.0, 0.15, 0.3, 'triangle');
        tone(400, 0.15, 0.20, 0.3, 'triangle');
        tone(500, 0.35, 0.40, 0.3, 'triangle');
        break;
      case 'win_villagers':
        tone(523, 0.0, 0.3, 0.25, 'sine');
        tone(659, 0.2, 0.3, 0.25, 'sine');
        tone(784, 0.4, 0.5, 0.3,  'sine');
        tone(1047,0.6, 0.8, 0.3,  'sine');
        break;
      case 'win_vampires':
        tone(220, 0.0, 0.6, 0.25, 'sawtooth');
        tone(185, 0.4, 0.8, 0.22, 'sawtooth');
        tone(150, 0.9, 1.2, 0.20, 'sine');
        break;
    }
  } catch (e) { /* ses çalamadı, önemli değil */ }
}
