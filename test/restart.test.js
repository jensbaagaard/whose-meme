'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const test = require('node:test');
const assert = require('node:assert/strict');
const { PHOTO, connectClient, closeAll, send, stateWhere } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Runs the real server.js as its own process so we can kill it like systemd (or a crash) would.
function startServer(dataDir) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: '0', HOST: '127.0.0.1', DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
      const match = /listening on (http:\/\/\S+) \((\d+) saved/.exec(out);
      if (match) resolve({ child, base: match[1], loaded: Number(match[2]) });
    });
    child.on('exit', (code) => reject(new Error(`server exited early (${code}): ${out}`)));
  });
}

function stop(child, signal) {
  return new Promise((resolve) => {
    child.once('exit', resolve);
    child.kill(signal);
  });
}

test('a running game survives a restart and a crash', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whose-meme-restart-'));
  let srv = await startServer(dataDir);
  t.after(() => {
    closeAll();
    srv.child.kill('SIGKILL');
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  // Set up a game and get one guess in.
  const host = await connectClient(srv.base);
  const { code, hostToken } = await send(host, 'host:create');
  const names = ['Alice', 'Bob', 'Cara'];
  const token = (name) => `${name.toLowerCase()}-restart-0123456789`;
  const phones = {};
  for (const name of names) {
    phones[name] = await connectClient(srv.base);
    assert.equal((await send(phones[name], 'player:join', { code, token: token(name), name, photo: PHOTO })).ok, true);
  }
  await send(phones.Alice, 'player:addMeme', { url: 'https://example.com/alice' });
  await send(phones.Bob, 'player:addMeme', { url: 'https://example.com/bob' });
  await send(host, 'host:start');

  const before = await stateWhere(host, (s) => s.phase === 'guessing');
  const ids = Object.fromEntries(before.players.map((p) => [p.name, p.id]));
  let owner;
  for (const name of names) {
    if ((await stateWhere(phones[name], (s) => s.phase === 'guessing')).round.isMine) owner = name;
  }
  const [guesser, third] = names.filter((n) => n !== owner);
  await send(phones[guesser], 'player:guess', { targetId: ids[owner] });

  // SIGTERM straight away: the save is still waiting in its batch window, so this checks the shutdown flush.
  closeAll();
  await stop(srv.child, 'SIGTERM');
  srv = await startServer(dataDir);
  assert.equal(srv.loaded, 1);

  const host2 = await connectClient(srv.base);
  assert.equal((await send(host2, 'host:resume', { code, hostToken })).ok, true);
  const after = await stateWhere(host2, (s) => s.phase === 'guessing');
  assert.equal(after.round.number, before.round.number);
  assert.equal(after.round.url, before.round.url);
  assert.equal(after.players.find((p) => p.name === guesser).hasGuessed, true, 'guesses survive');
  assert.equal((await fetch(srv.base + after.players[0].photo)).status, 200, 'selfies survive');

  // Phones come back with nothing but their token, as the browser does on reconnect.
  const phones2 = {};
  for (const name of names) {
    phones2[name] = await connectClient(srv.base);
    const res = await send(phones2[name], 'player:join', { code, token: token(name) });
    assert.equal(res.ok, true, res.error);
    assert.equal(res.playerId, ids[name]);
  }
  await send(phones2[third], 'player:guess', { targetId: ids[guesser] }); // wrong
  await send(phones2[owner], 'player:guess', { targetId: ids[guesser] }); // bluff
  const revealed = await stateWhere(host2, (s) => s.phase === 'reveal');
  const scores = Object.fromEntries(revealed.scoreboard.map((p) => [p.name, p.score]));
  assert.deepEqual(scores, { [guesser]: 1, [owner]: 1, [third]: 0 });

  // A hard crash after the batch window still keeps the latest state.
  await send(host2, 'host:next');
  await stateWhere(host2, (s) => s.phase === 'guessing' && s.round.number === 2);
  await sleep(500);
  closeAll();
  await stop(srv.child, 'SIGKILL');
  srv = await startServer(dataDir);

  const host3 = await connectClient(srv.base);
  assert.equal((await send(host3, 'host:resume', { code, hostToken })).ok, true);
  const crashed = await stateWhere(host3, (s) => s.phase === 'guessing');
  assert.equal(crashed.round.number, 2);
  assert.deepEqual(Object.fromEntries(crashed.scoreboard.map((p) => [p.name, p.score])), scores);
});
