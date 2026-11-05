'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { PHOTO, connectClient, closeAll, send, stateWhere } = require('./helpers');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'whose-meme-test-'));
const { server, rooms } = require('../server');

let base;
const client = () => connectClient(base);

test.before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  closeAll();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
});

test('a whole game over real sockets', async () => {
  const host = await client();
  const created = await send(host, 'host:create');
  assert.equal(created.ok, true);
  const { code } = created;
  assert.match(code, /^[A-Z]{4}$/);

  const qr = await fetch(`${base}/qr/${code}.svg`);
  assert.equal(qr.status, 200);
  assert.match(await qr.text(), /<svg/);

  const alice = await client();
  const bob = await client();
  const cara = await client();
  const joinA = await send(alice, 'player:join', { code: code.toLowerCase(), token: 'alice-token-0123456789', name: 'Alice', photo: PHOTO });
  assert.equal(joinA.ok, true, joinA.error);
  assert.equal((await send(bob, 'player:join', { code, token: 'bob-token-0123456789', name: 'Bob', photo: PHOTO })).ok, true);
  assert.equal((await send(cara, 'player:join', { code, token: 'cara-token-0123456789', name: 'Cara', photo: PHOTO })).ok, true);
  const noPhoto = await send(await client(), 'player:join', { code, token: 'dave-token-0123456789', name: 'Dave' });
  assert.equal(noPhoto.ok, false);

  // Photos are served from a URL, not stuffed into every state message.
  const lobby = await stateWhere(host, (s) => s.players.length === 3);
  const photo = await fetch(base + lobby.players[0].photo);
  assert.equal(photo.status, 200);
  assert.equal(photo.headers.get('content-type'), 'image/jpeg');

  assert.equal((await send(alice, 'player:addMeme', { url: 'example.com/funny-cat' })).ok, true);
  const bad = await send(bob, 'player:addMeme', { url: 'javascript:alert(1)' });
  assert.equal(bad.ok, false);
  assert.equal((await send(alice, 'host:start')).ok, false, 'phones cannot drive the game');

  assert.equal((await send(host, 'host:start')).ok, true);
  const round = await stateWhere(host, (s) => s.phase === 'guessing');
  assert.equal(round.round.url, 'https://example.com/funny-cat');
  const aliceRound = await stateWhere(alice, (s) => s.phase === 'guessing');
  assert.equal(aliceRound.round.isMine, true);
  const ids = Object.fromEntries(round.players.map((p) => [p.name, p.id]));

  await send(bob, 'player:guess', { targetId: ids.Alice });
  await send(cara, 'player:guess', { targetId: ids.Bob });
  const midway = await stateWhere(host, (s) => s.players.filter((p) => p.hasGuessed).length === 2);
  assert.equal(midway.phase, 'guessing');
  await send(alice, 'player:guess', { targetId: ids.Cara }); // bluff, last guess triggers the reveal

  const revealed = await stateWhere(host, (s) => s.phase === 'reveal');
  assert.equal(revealed.round.reveal.ownerName, 'Alice');
  const scores = Object.fromEntries(revealed.scoreboard.map((p) => [p.name, p.score]));
  assert.deepEqual(scores, { Alice: 1, Bob: 1, Cara: 0 });
  const bobReveal = await stateWhere(bob, (s) => s.phase === 'reveal');
  assert.equal(bobReveal.round.reveal.ownerId, ids.Alice);

  await send(host, 'host:next');
  await stateWhere(host, (s) => s.phase === 'over');
  await send(host, 'host:playAgain');
  const again = await stateWhere(host, (s) => s.phase === 'lobby');
  assert.equal(again.players.length, 3);
  assert.equal(again.memeCount, 0);
});

test('a phone can rejoin with its token, but nobody can hijack a player by public id', async () => {
  const host = await client();
  const { code } = await send(host, 'host:create');
  const phone = await client();
  const joined = await send(phone, 'player:join', { code, token: 'eve-token-0123456789', name: 'Eve', photo: PHOTO });
  phone.disconnect();

  const reloaded = await client();
  const rejoin = await send(reloaded, 'player:join', { code, token: 'eve-token-0123456789' });
  assert.equal(rejoin.ok, true);
  assert.equal(rejoin.playerId, joined.playerId);

  const attacker = await client();
  const hijack = await send(attacker, 'player:join', { code, token: joined.playerId });
  assert.equal(hijack.ok, false, 'a public id is not a login');
});

test('host can resume after a refresh, and only with the right token', async () => {
  const host = await client();
  const { code, hostToken } = await send(host, 'host:create');
  host.disconnect();
  const refreshed = await client();
  assert.equal((await send(refreshed, 'host:resume', { code, hostToken: 'nope' })).ok, false);
  assert.equal((await send(refreshed, 'host:resume', { code, hostToken })).ok, true);
  assert.ok(rooms.has(code));
});

test('a kicked phone is told it is gone', async () => {
  const host = await client();
  const { code } = await send(host, 'host:create');
  const phone = await client();
  const { playerId } = await send(phone, 'player:join', { code, token: 'kick-token-0123456789', name: 'Kickme', photo: PHOTO });
  await send(host, 'host:kick', { playerId });
  await stateWhere(phone, (s) => s.phase === 'gone');
  assert.equal((await send(phone, 'player:addMeme', { url: 'https://example.com' })).ok, false);
});
