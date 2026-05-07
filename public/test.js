'use strict';

const socket = io();
let latestState = null;

const phaseLabel = document.getElementById('phase-label');
const dayLabel = document.getElementById('day-label');
const playerGrid = document.getElementById('player-grid');
const actionList = document.getElementById('action-list');
const voteList = document.getElementById('vote-list');

socket.on('connect', () => {
  socket.emit('test_observe');
});

socket.on('test_dashboard_update', (state) => {
  latestState = state;
  renderState(state);
});

document.getElementById('btn-seed').addEventListener('click', () => {
  socket.emit('test_seed_lobby', getTestConfig());
});

document.getElementById('btn-start-demo').addEventListener('click', () => {
  socket.emit('test_start_game', {
    lobbyCode: latestState?.lobbyCode,
    ...getTestConfig()
  });
});

function getTestConfig() {
  return {
    playerCount: Number(document.getElementById('test-player-count').value) || 6,
    vampireCount: Number(document.getElementById('test-vampire-count').value) || 2,
    withDoctor: document.getElementById('test-with-doctor').checked,
    withSeer: document.getElementById('test-with-seer').checked,
    noKillFirstNight: document.getElementById('test-no-kill').checked
  };
}

document.getElementById('btn-auto-night').addEventListener('click', () => {
  socket.emit('test_auto_night', { lobbyCode: latestState?.lobbyCode });
});

document.getElementById('btn-auto-vote').addEventListener('click', () => {
  socket.emit('test_auto_vote', { lobbyCode: latestState?.lobbyCode });
});

function renderState(state) {
  phaseLabel.textContent = state.phaseLabel || state.phase || '-';
  dayLabel.textContent = state.dayNumber ? `Gün ${state.dayNumber}` : '';
  text('state-phase', state.phaseLabel || state.phase || '-');
  text('state-day', state.dayNumber || '-');
  text('state-player-count', `${state.players?.length || 0}`);
  text('state-winner', winnerLabel(state.winner));

  renderActions(state.spectator?.nightActions || {});
  renderVotes(state.spectator?.votes || []);
  renderPlayers(state.players || []);
}

function renderActions(actions) {
  const items = [
    ['Vampir hedefi', actions.vampireTarget || 'Seçilmedi'],
    ['Vampir onayı', `${actions.confirmedCount || 0} onay`],
    ['Doktor koruması', actions.doctorTarget || 'Seçilmedi'],
    ['Kahin sorgusu', actions.seerTarget || 'Seçilmedi'],
    ['Kahin sonucu', seerResultLabel(actions.seerResult)]
  ];

  actionList.innerHTML = items.map(([label, value]) => (
    `<li><span>${esc(label)}</span><strong>${esc(value)}</strong></li>`
  )).join('');
}

function renderVotes(votes) {
  voteList.innerHTML = votes.length
    ? votes.map(v => `<li><span>${esc(v.voter || '-')}</span><strong>${esc(v.target || '-')}</strong></li>`).join('')
    : '<li><span>Oy</span><strong>Henüz yok</strong></li>';
}

function renderPlayers(players) {
  if (!players.length) {
    playerGrid.innerHTML = '<div class="empty-state">Demo lobisi kurarak veya gerçek oyuncuları bağlayarak paneli doldurabilirsin.</div>';
    return;
  }

  playerGrid.innerHTML = players.map(player => {
    const screen = player.screen || {};
    const status = player.alive ? 'Hayatta' : 'Ölü';
    const host = player.isHost ? '<span class="mini-badge">Host</span>' : '';
    const disconnected = player.connected ? '' : '<span class="mini-badge muted">Soket yok</span>';
    return `
      <article class="player-card role-${esc(player.role || 'none')} ${player.alive ? '' : 'is-dead'}">
        <div class="player-topline">
          <div>
            <h3>${esc(player.name)}</h3>
            <p>${esc(player.roleLabel || '-')}</p>
          </div>
          <div class="badge-stack">
            ${host}
            ${disconnected}
          </div>
        </div>
        <div class="screen-box">
          <span class="screen-name">${esc(screen.screen || '-')}</span>
          <strong>${esc(screen.headline || '-')}</strong>
          <p>${esc(screen.detail || '')}</p>
        </div>
        <footer>
          <span>${status}</span>
          <span>${latestState?.phaseLabel || '-'}</span>
        </footer>
      </article>
    `;
  }).join('');
}

function text(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function winnerLabel(winner) {
  return {
    vampires: 'Vampirler',
    villagers: 'Köylüler',
    draw: 'Berabere',
    ended: 'Erken bitirildi'
  }[winner] || '-';
}

function seerResultLabel(result) {
  if (!result) return 'Yok';
  return result.isVampire ? `${result.targetName}: Vampir` : `${result.targetName}: Temiz`;
}

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
