'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Room, GameError, cleanUrl, cleanPhoto } = require('../src/game');

const PHOTO = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]).toString('base64')}`;

function roomWith(...names) {
  const room = new Room('TEST');
  const players = names.map((name) => {
    const p = room.join(`token-${name}-0123456789`, name, PHOTO);
    room.setConnected(p.id, true);
    return p;
  });
  return { room, players };
}

test('cleanUrl adds a scheme and rejects non-http links', () => {
  assert.equal(cleanUrl('tiktok.com/@x/video/1'), 'https://tiktok.com/@x/video/1');
  assert.equal(cleanUrl('  https://youtu.be/abc  '), 'https://youtu.be/abc');
  assert.throws(() => cleanUrl('javascript:alert(1)'), GameError);
  assert.throws(() => cleanUrl('data:text/html,hi'), GameError);
  assert.throws(() => cleanUrl('not a link'), GameError);
  assert.throws(() => cleanUrl(''), GameError);
});

test('cleanPhoto only accepts small JPEG data URLs', () => {
  assert.ok(cleanPhoto(PHOTO) instanceof Buffer);
  assert.throws(() => cleanPhoto('data:image/png;base64,iVBORw0KGgo='), GameError);
  assert.throws(() => cleanPhoto(`data:image/jpeg;base64,${Buffer.from('<svg>').toString('base64')}`), GameError);
  const huge = Buffer.alloc(70 * 1024, 0xff);
  assert.throws(() => cleanPhoto(`data:image/jpeg;base64,${huge.toString('base64')}`), GameError);
  assert.throws(() => cleanPhoto(undefined), GameError);
});

test('joining needs a unique name and a photo; the same token rejoins', () => {
  const room = new Room('TEST');
  const alice = room.join('token-a-0123456789', 'Alice', PHOTO);
  assert.throws(() => room.join('token-b-0123456789', 'alice', PHOTO), /already has that name/);
  assert.throws(() => room.join('token-c-0123456789', 'Bob'), /photo/);
  assert.equal(room.join('token-a-0123456789'), alice);
  assert.notEqual(alice.id, 'token-a-0123456789', 'public id must not be the secret token');
});

test('nobody new can join once the game started, but players can rejoin', () => {
  const { room } = roomWith('Alice', 'Bob');
  room.addMeme(room.tokens.get('token-Alice-0123456789'), 'https://example.com/1');
  room.start();
  assert.throws(() => room.join('token-late-0123456789', 'Late', PHOTO), /already started/);
  assert.ok(room.join('token-Bob-0123456789'));
});

test('meme limits and duplicates', () => {
  const { room, players } = roomWith('Alice');
  const [alice] = players;
  room.addMeme(alice.id, 'https://example.com/a');
  assert.throws(() => room.addMeme(alice.id, 'example.com/a'), /already added/);
  for (let i = 1; i < 10; i++) room.addMeme(alice.id, `https://example.com/${i}`);
  assert.throws(() => room.addMeme(alice.id, 'https://example.com/x'), /Max/);
  room.removeMeme(alice.id, alice.memes[0].id);
  assert.equal(alice.memes.length, 9);
});

test('cannot start without two players and a meme', () => {
  const { room, players } = roomWith('Alice');
  assert.throws(() => room.start(), /2 players/);
  room.join('token-bob-0123456789', 'Bob', PHOTO);
  assert.throws(() => room.start(), /meme/);
  room.addMeme(players[0].id, 'https://example.com/a');
  room.start();
  assert.equal(room.phase, 'guessing');
});

test('a full round: guesses, auto-reveal condition, scoring and the bluff', () => {
  const { room, players } = roomWith('Alice', 'Bob', 'Cara');
  const [alice, bob, cara] = players;
  room.addMeme(alice.id, 'https://example.com/alice');
  room.start();

  assert.throws(() => room.guess(bob.id, bob.id), /yourself/);
  room.guess(bob.id, alice.id); // correct
  room.guess(cara.id, bob.id); // fooled
  assert.equal(room.everyoneGuessed(), false, 'Alice still has to bluff');
  room.guess(alice.id, bob.id); // the uploader's bluff
  assert.equal(room.everyoneGuessed(), true);

  room.reveal();
  assert.equal(room.phase, 'reveal');
  assert.equal(bob.score, 1);
  assert.equal(cara.score, 0);
  assert.equal(alice.score, 1, 'one point for fooling Cara');
  const { results } = room.hostView().round.reveal;
  assert.equal(results.length, 2, "the uploader's bluff is not shown");

  room.next();
  assert.equal(room.phase, 'over');
  assert.deepEqual(
    room.scoreboard().map((p) => p.name),
    ['Alice', 'Bob', 'Cara'],
  );
});

test('disconnected players do not hold up the reveal', () => {
  const { room, players } = roomWith('Alice', 'Bob', 'Cara');
  const [alice, bob, cara] = players;
  room.addMeme(alice.id, 'https://example.com/alice');
  room.start();
  room.setConnected(cara.id, false);
  room.guess(alice.id, bob.id);
  room.guess(bob.id, alice.id);
  assert.equal(room.everyoneGuessed(), true);
});

test('views never leak who posted the meme before the reveal', () => {
  const { room, players } = roomWith('Alice', 'Bob');
  const [alice, bob] = players;
  room.addMeme(alice.id, 'https://example.com/alice');
  assert.ok(!JSON.stringify(room.playerView(bob.id)).includes('example.com/alice'), "lobby hides others' memes");
  assert.ok(!JSON.stringify(room.hostView()).includes('example.com/alice'), 'host only sees meme counts');
  room.start();

  const hostJson = JSON.stringify(room.hostView());
  const bobJson = JSON.stringify(room.playerView(bob.id));
  assert.ok(!hostJson.includes('ownerId'));
  assert.ok(!bobJson.includes('ownerId'));
  assert.ok(!bobJson.includes('example.com/alice'), 'phones do not need the link');
  assert.equal(room.playerView(alice.id).round.isMine, true);
  assert.equal(room.playerView(bob.id).round.isMine, false);
  for (const json of [hostJson, bobJson]) assert.ok(!json.includes('token-'), 'tokens stay secret');
});

test('play again keeps players but clears memes and scores', () => {
  const { room, players } = roomWith('Alice', 'Bob');
  const [alice, bob] = players;
  room.addMeme(alice.id, 'https://example.com/alice');
  room.start();
  room.guess(bob.id, alice.id);
  room.reveal();
  room.end();
  room.playAgain();
  assert.equal(room.phase, 'lobby');
  assert.equal(room.players.size, 2);
  assert.equal(alice.memes.length, 0);
  assert.equal(bob.score, 0);
});

test('kicking frees the name and invalidates the token', () => {
  const { room, players } = roomWith('Alice', 'Bob');
  room.kick(players[1].id);
  assert.equal(room.tokens.has('token-Bob-0123456789'), false);
  assert.ok(room.join('token-new-0123456789', 'Bob', PHOTO));
});

test('a room survives a snapshot round trip mid-round', () => {
  const { room, players } = roomWith('Alice', 'Bob', 'Cara');
  const [alice, bob, cara] = players;
  room.addMeme(alice.id, 'https://example.com/alice');
  room.addMeme(bob.id, 'https://example.com/bob');
  room.start();
  const ownerId = room.round.ownerId;
  const guesser = [alice, bob, cara].find((p) => p.id !== ownerId);
  room.guess(guesser.id, ownerId);

  const copy = Room.restore(JSON.parse(JSON.stringify(room.snapshot())));
  assert.equal(copy.phase, 'guessing');
  assert.equal(copy.hostToken, room.hostToken);
  assert.equal(copy.round.meme.url, room.round.meme.url);
  assert.equal(copy.round.guesses.get(guesser.id), ownerId);
  assert.deepEqual(copy.players.get(alice.id).photo, alice.photo);
  assert.equal(copy.join('token-Bob-0123456789').id, bob.id, 'tokens still rejoin');
  assert.equal(copy.players.get(bob.id).connections, 0, 'nobody is connected after a restart');

  // The restored room plays on as normal.
  for (const p of copy.players.values()) copy.setConnected(p.id, true);
  for (const p of copy.players.values()) {
    if (p.id === guesser.id) continue;
    copy.guess(p.id, [...copy.players.keys()].find((id) => id !== p.id));
  }
  assert.equal(copy.everyoneGuessed(), true);
  copy.reveal();
  assert.equal(copy.players.get(guesser.id).score, 1);
});
