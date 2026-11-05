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

  // Bob was the only one right, so Bob gets to doodle on someone's face.
  assert.equal(bobReveal.doodle.isArtist, true);
  assert.equal((await send(host, 'host:next')).ok, false, 'next waits for the doodle');
  assert.equal((await send(cara, 'doodle:pick', { targetId: ids.Alice })).ok, false, 'only the artist can pick');
  assert.equal((await send(bob, 'doodle:pick', { targetId: ids.Cara })).ok, true);
  await stateWhere(cara, (s) => s.doodle && s.doodle.isTarget);

  // Strokes stream live to every other screen.
  const seen = new Promise((resolve) => host.once('doodle:segment', resolve));
  const caraSees = new Promise((resolve) => cara.once('doodle:segment', resolve));
  bob.emit('doodle:segment', { s: 'abc', c: '#ff3b3b', w: 0.03, p: [0.2, 0.2, 0.8, 0.8] });
  const streamed = await seen;
  assert.deepEqual(streamed.seg.p, [0.2, 0.2, 0.8, 0.8]);
  assert.equal(streamed.id, bobReveal.doodle.id);
  await caraSees;

  // A screen that shows up mid-doodle gets caught up on the strokes so far.
  const lateHost = await client();
  const replay = new Promise((resolve) => lateHost.once('doodle:replay', resolve));
  await send(lateHost, 'host:resume', { code, hostToken: created.hostToken });
  assert.equal((await replay).segments.length, 1);

  const doodled = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xd0, 0x0d, 0x1e]).toString('base64')}`;
  assert.equal((await send(bob, 'doodle:done', { photo: doodled, name: 'Captain Pickle' })).ok, true);
  const afterDoodle = await stateWhere(host, (s) => !s.doodle && s.round.reveal.doodle);
  const renamed = afterDoodle.players.find((p) => p.id === ids.Cara);
  assert.equal(renamed.name, 'Captain Pickle');
  const newFace = await fetch(base + renamed.photo);
  assert.deepEqual(Buffer.from(await newFace.arrayBuffer()), Buffer.from(doodled.split(',')[1], 'base64'));

  // Reactions float up the big screen, and spamming them is capped.
  let reactions = 0;
  host.on('reaction', () => (reactions += 1));
  for (let i = 0; i < 20; i++) alice.emit('react', { e: '😂' });
  alice.emit('react', { e: '<b>hi</b>' });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(reactions, 6);

  await send(host, 'host:next');
  const over = await stateWhere(host, (s) => s.phase === 'over');
  assert.ok(over.awards.some((a) => a.title === 'Picasso' && a.name === 'Bob'));
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

test('image memes: upload, show on the big screen, clean up from disk', async () => {
  const host = await client();
  const { code } = await send(host, 'host:create');
  const phone = await client();
  const token = 'img-token-0123456789';
  await send(phone, 'player:join', { code, token, name: 'Imogen', photo: PHOTO });
  const other = await client();
  await send(other, 'player:join', { code, token: 'other-token-0123456789', name: 'Otto', photo: PHOTO });

  const upload = (body, headers = {}) =>
    fetch(`${base}/api/rooms/${code}/memes`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/png', 'X-Player-Token': token, ...headers },
      body,
    });
  const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.from('a very animated meme')]);

  assert.equal((await (await upload(gif, { 'X-Player-Token': 'not-a-player-0123456789' })).json()).ok, false);
  const svg = await upload(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'));
  assert.equal(svg.status, 400);
  assert.match((await svg.json()).error, /Only JPEG/);
  const huge = await upload(Buffer.concat([gif, Buffer.alloc(7 * 1024 * 1024)]));
  assert.equal(huge.status, 413);
  assert.equal((await huge.json()).ok, false);

  // The label says PNG but the bytes say GIF: the bytes win.
  const res = await upload(gif);
  const body = await res.json();
  assert.equal(body.ok, true, body.error);
  const mine = await stateWhere(phone, (s) => s.me.memes.length === 1);
  const meme = mine.me.memes[0];
  assert.equal(meme.kind, 'image');
  const served = await fetch(base + meme.image);
  assert.equal(served.headers.get('content-type'), 'image/gif');
  assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), gif);

  // A second image, removed again: its file goes away once the room is saved.
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9]);
  assert.equal((await (await upload(jpeg)).json()).ok, true);
  const two = await stateWhere(phone, (s) => s.me.memes.length === 2);
  const removed = two.me.memes[1];
  const file = path.join(process.env.DATA_DIR, 'media', code, removed.id);
  assert.ok(fs.existsSync(file));
  await send(phone, 'player:removeMeme', { memeId: removed.id });
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(fs.existsSync(file), false);
  assert.equal((await fetch(base + removed.image)).status, 404);

  // The game: the only meme is the GIF, so it is what the big screen shows.
  await send(host, 'host:start');
  const round = await stateWhere(host, (s) => s.phase === 'guessing');
  assert.equal(round.round.kind, 'image');
  assert.equal(round.round.image, meme.image);
  const nope = await upload(jpeg);
  assert.match((await nope.json()).error, /already started/);
});
