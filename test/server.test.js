const assert = require('node:assert/strict');
const { after, describe, it } = require('node:test');

const {
  MAX_PLAYERS,
  httpServer,
  makeGame,
  validateStartConfig,
  sanitizeName,
  sanitizeLobbyName,
  sanitizePassword,
  sanitizeChat,
  isSafePlayerId,
  startNight
} = require('../server');

after(() => {
  httpServer.close();
});

function makePlayers(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `player-${index + 1}`,
    reconnectToken: `token-${index + 1}`,
    name: `Player ${index + 1}`,
    role: null,
    alive: true,
    socketId: `socket-${index + 1}`,
    isHost: index === 0,
    disconnected: false
  }));
}

function configuredGame({ players, vampireCount, withDoctor = true, withSeer = true }) {
  const game = makeGame({ code: 'TEST1', name: 'Test' });
  game.players = makePlayers(players);
  game.vampireCount = vampireCount;
  game.withDoctor = withDoctor;
  game.withSeer = withSeer;
  return game;
}

describe('start configuration validation', () => {
  it('rejects combinations where vampires can win at the start', () => {
    assert.match(validateStartConfig(configuredGame({ players: 4, vampireCount: 2 })), /oyun başında/);
    assert.match(validateStartConfig(configuredGame({ players: 6, vampireCount: 3 })), /oyun başında/);
  });

  it('accepts balanced combinations inside the supported player range', () => {
    const fivePlayerGame = configuredGame({ players: 5, vampireCount: 2 });
    fivePlayerGame.noKillFirstNight = true;
    const sevenPlayerGame = configuredGame({ players: 7, vampireCount: 3 });
    sevenPlayerGame.noKillFirstNight = true;

    assert.equal(validateStartConfig(fivePlayerGame), null);
    assert.equal(validateStartConfig(sevenPlayerGame), null);
  });

  it('rejects combinations where the first unprotected night kill decides the game', () => {
    assert.match(validateStartConfig(configuredGame({ players: 3, vampireCount: 1 })), /İlk gece/);
    assert.match(validateStartConfig(configuredGame({ players: 5, vampireCount: 2 })), /İlk gece/);

    const protectedOpening = configuredGame({ players: 5, vampireCount: 2 });
    protectedOpening.noKillFirstNight = true;
    assert.equal(validateStartConfig(protectedOpening), null);
  });

  it('rejects oversized lobbies', () => {
    assert.match(validateStartConfig(configuredGame({ players: MAX_PLAYERS + 1, vampireCount: 3 })), /En fazla/);
  });
});

describe('input hardening', () => {
  it('trims control characters and caps display text length', () => {
    assert.equal(sanitizeName('  Ada\u0000<script>0123456789  '), 'Ada<script>012345678');
    assert.equal(sanitizeLobbyName(` ${'L'.repeat(40)} `).length, 28);
    assert.equal(sanitizePassword(` ${'p'.repeat(40)} `).length, 24);
    assert.equal(sanitizeChat(` ${'m'.repeat(500)} `).length, 300);
  });

  it('accepts only bounded URL-safe player ids', () => {
    assert.equal(isSafePlayerId('22a7f6b8-89aa-4d4f-93e5-f4e641e6e0ab'), true);
    assert.equal(isSafePlayerId('test-AB123-1'), true);
    assert.equal(isSafePlayerId('<script>'), false);
    assert.equal(isSafePlayerId('short'), false);
  });
});

describe('phase guards', () => {
  it('does not let a delayed night transition revive a finished game', () => {
    const game = configuredGame({ players: 5, vampireCount: 1 });
    game.phase = 'game_over';
    game.dayNumber = 3;

    startNight(game, 'role_reveal');

    assert.equal(game.phase, 'game_over');
    assert.equal(game.dayNumber, 3);
  });
});

describe('production test dashboard hardening', () => {
  it('does not serve the test dashboard or its static assets unless explicitly enabled', async () => {
    const server = httpServer.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const { port } = server.address();

    const responses = await Promise.all([
      fetch(`http://127.0.0.1:${port}/test.html`),
      fetch(`http://127.0.0.1:${port}/test.js`),
      fetch(`http://127.0.0.1:${port}/test.css`)
    ]);

    assert.deepEqual(responses.map(response => response.status), [404, 404, 404]);
  });
});
