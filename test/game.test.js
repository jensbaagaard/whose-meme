'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Room, GameError, DOODLE, LIMITS, cleanUrl, cleanPhoto, cleanImage, cleanSegment } = require('../src/game');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake png body')]);
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.from('fake gif body')]);

const PHOTO = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]).toString('base64')}`;
const DOODLED = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0xd0, 0x0d]).toString('base64')}`;

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
  const huge = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(130 * 1024)]);
  assert.throws(() => cleanPhoto(`data:image/jpeg;base64,${huge.toString('base64')}`), /too big/);
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

  assert.equal(room.doodle.artistId, bob.id, 'the only correct guesser gets the doodle');
  assert.throws(() => room.next(), /doodle/);
  room.cancelDoodle();
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

// Sets up a 4-player round where Bob, Cara and Dan all guess Alice correctly.
function revealedRound() {
  const { room, players } = roomWith('Alice', 'Bob', 'Cara', 'Dan');
  const [alice, bob, cara, dan] = players;
  room.addMeme(alice.id, 'https://example.com/alice');
  room.start();
  for (const p of [bob, cara, dan]) room.guess(p.id, alice.id);
  room.guess(alice.id, bob.id);
  room.reveal();
  return { room, alice, bob, cara, dan };
}

test('the doodle goes to a random correct guesser, never to a wrong one', () => {
  const seen = new Set();
  for (let i = 0; i < 60; i++) {
    const { room, alice, bob, cara, dan } = revealedRound();
    assert.ok([bob.id, cara.id, dan.id].includes(room.doodle.artistId));
    assert.notEqual(room.doodle.artistId, alice.id, 'the uploader never wins it');
    seen.add(room.players.get(room.doodle.artistId).name);
  }
  assert.equal(seen.size, 3, `all three correct guessers should win sometimes (saw ${[...seen]})`);
});

test('nobody correct means no doodle', () => {
  const { room, players } = roomWith('Alice', 'Bob', 'Cara');
  const [alice, bob, cara] = players;
  room.addMeme(alice.id, 'https://example.com/alice');
  room.start();
  room.guess(bob.id, cara.id);
  room.guess(cara.id, bob.id);
  room.reveal();
  assert.equal(room.doodle, null);
  room.next(); // not blocked
});

test('doodle flow: pick a victim, draw, rename, finish', () => {
  const { room } = revealedRound();
  const artist = room.players.get(room.doodle.artistId);
  const victim = [...room.players.values()].find((p) => p.id !== artist.id && p.name !== 'Alice');
  const outsider = [...room.players.values()].find((p) => p.id !== artist.id && p.id !== victim.id);

  assert.throws(() => room.pickDoodleTarget(outsider.id, victim.id), /not your turn/);
  assert.throws(() => room.addDoodleSegment(artist.id, { s: 'a', c: DOODLE.colors[0], w: DOODLE.widths[0], p: [0, 0] }), /Pick a face/);
  assert.throws(() => room.pickDoodleTarget(artist.id, artist.id), /someone else/);
  room.pickDoodleTarget(artist.id, victim.id);
  assert.throws(() => room.pickDoodleTarget(artist.id, outsider.id), /already picked/);

  room.addDoodleSegment(artist.id, { s: 'a', c: DOODLE.colors[2], w: DOODLE.widths[1], p: [0.1, 0.1, 0.5, 0.5] });
  room.addDoodleSegment(artist.id, { s: 'b', e: DOODLE.stickers[0], z: DOODLE.stickerSizes[1], x: 0.5, y: 0.4 });
  room.undoDoodleStroke(artist.id, 'b');
  assert.deepEqual(room.doodle.segments.map((s) => s.s), ['a']);

  const views = { artist: room.playerView(artist.id).doodle, victim: room.playerView(victim.id).doodle, host: room.hostView().doodle };
  assert.equal(views.artist.isArtist, true);
  assert.ok(views.artist.tools, 'only the artist gets the tools');
  assert.equal(views.victim.isTarget, true);
  assert.equal(views.victim.tools, undefined);
  assert.equal(views.host.targetName, victim.name);
  assert.ok(!JSON.stringify(views.host).includes('segments'), 'strokes are streamed, not put in every state');

  assert.throws(() => room.finishDoodle(artist.id, { photo: DOODLED, name: outsider.name }), /already has that name/);
  const oldName = victim.name;
  const version = victim.photoVersion;
  room.finishDoodle(artist.id, { photo: DOODLED, name: 'Sir Soggy Toast' });
  assert.equal(room.doodle, null);
  assert.equal(victim.name, 'Sir Soggy Toast');
  assert.equal(victim.photoVersion, version + 1);
  assert.deepEqual(victim.photo, Buffer.from(DOODLED.split(',')[1], 'base64'));
  assert.deepEqual(room.hostView().round.reveal.doodle, { artistId: artist.id, targetId: victim.id, oldName, newName: 'Sir Soggy Toast' });
  room.next();
});

test('finishing without a new name keeps the old one', () => {
  const { room } = revealedRound();
  const artistId = room.doodle.artistId;
  const victim = [...room.players.values()].find((p) => p.id !== artistId);
  const name = victim.name;
  room.pickDoodleTarget(artistId, victim.id);
  room.finishDoodle(artistId, { photo: DOODLED, name: '   ' });
  assert.equal(victim.name, name);
  assert.equal(room.round.results.doodle.newName, null);
});

test('doodle strokes are checked and squashed into the picture', () => {
  const pen = { s: 'abc', c: DOODLE.colors[0], w: DOODLE.widths[0] };
  assert.deepEqual(cleanSegment({ ...pen, p: [-1, 2, 0.12345, 0.5] }).p, [0, 1, 0.123, 0.5]);
  assert.throws(() => cleanSegment({ ...pen, c: 'red', p: [0, 0] }), /brush/);
  assert.throws(() => cleanSegment({ ...pen, w: 5, p: [0, 0] }), /brush/);
  assert.throws(() => cleanSegment({ ...pen, p: [0, 0, 1] }), /stroke/);
  assert.throws(() => cleanSegment({ ...pen, p: [0, NaN] }), /stroke/);
  assert.throws(() => cleanSegment({ ...pen, p: new Array(2000).fill(0) }), /stroke/);
  assert.throws(() => cleanSegment({ ...pen, s: '<script>', p: [0, 0] }), /stroke/);
  assert.throws(() => cleanSegment({ s: 'a', e: '<img>', z: DOODLE.stickerSizes[0], x: 0, y: 0 }), /sticker/);
  assert.deepEqual(cleanSegment({ s: 'a', e: '👑', z: DOODLE.stickerSizes[0], x: 3, y: 0.5 }), {
    s: 'a',
    e: '👑',
    z: DOODLE.stickerSizes[0],
    x: 1,
    y: 0.5,
  });
});

test('a doodle that runs out of time expires', () => {
  const { room } = revealedRound();
  assert.equal(room.doodleExpired(), false);
  assert.equal(room.doodleExpired(room.doodle.deadline + DOODLE.graceMs + 1), true);
});

test('players can rename themselves, but not to a taken name', () => {
  const { room, players } = roomWith('Alice', 'Bob');
  room.rename(players[0].id, '  Captain   Noodle ');
  assert.equal(players[0].name, 'Captain Noodle');
  assert.throws(() => room.rename(players[0].id, 'bob'), /already has that name/);
  room.rename(players[1].id, 'BOB'); // changing your own capitalisation is fine
  assert.equal(players[1].name, 'BOB');
});

test('cleanImage trusts the bytes, not the label, and caps the size', () => {
  assert.equal(cleanImage(PNG).type, 'image/png');
  assert.equal(cleanImage(GIF).type, 'image/gif');
  assert.equal(cleanImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2])).type, 'image/jpeg');
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);
  assert.equal(cleanImage(webp).type, 'image/webp');
  assert.throws(() => cleanImage(Buffer.from('<svg onload="alert(1)"></svg>')), /Only JPEG/);
  assert.throws(() => cleanImage(Buffer.from('<html><script>')), /Only JPEG/);
  assert.throws(() => cleanImage(Buffer.alloc(0)), /Pick an image/);
  assert.throws(() => cleanImage({}), /Pick an image/);
  const bigJpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(LIMITS.imageBytes)]);
  assert.throws(() => cleanImage(bigJpeg), /too big/);
  const bigGif = Buffer.concat([GIF, Buffer.alloc(LIMITS.imageBytes)]); // fine for a GIF
  assert.equal(cleanImage(bigGif).type, 'image/gif');
  assert.notEqual(cleanImage(PNG).hash, cleanImage(GIF).hash);
});

test('image memes share the meme limit, reject duplicates and respect the room budget', () => {
  const { room, players } = roomWith('Alice', 'Bob');
  const [alice, bob] = players;
  const meme = room.addImageMeme(alice.id, cleanImage(PNG));
  assert.equal(meme.kind, 'image');
  assert.throws(() => room.addImageMeme(alice.id, cleanImage(PNG)), /already added/);
  room.addImageMeme(bob.id, cleanImage(PNG)); // someone else may post the same image

  assert.deepEqual(room.playerView(alice.id).me.memes, [
    { id: meme.id, kind: 'image', image: `/media/TEST/${meme.id}`, bytes: PNG.length },
  ]);
  assert.ok(!JSON.stringify(room.hostView()).includes(meme.id), 'the big screen does not see it before its round');

  for (let i = 1; i < LIMITS.memesPerPlayer; i++) room.addMeme(alice.id, `https://example.com/${i}`);
  assert.throws(() => room.addImageMeme(alice.id, cleanImage(GIF)), /Max/);

  const saved = LIMITS.roomMediaBytes;
  LIMITS.roomMediaBytes = room.mediaBytes() + 5;
  try {
    assert.throws(() => room.addImageMeme(bob.id, cleanImage(GIF)), /out of space/);
  } finally {
    LIMITS.roomMediaBytes = saved;
  }
});

test('an image meme shows on the big screen when it comes up, never on the phones', () => {
  const { room, players } = roomWith('Alice', 'Bob');
  const [alice, bob] = players;
  const meme = room.addImageMeme(alice.id, cleanImage(GIF));
  room.start();
  const round = room.hostView().round;
  assert.equal(round.kind, 'image');
  assert.equal(round.image, `/media/TEST/${meme.id}`);
  assert.equal(round.url, undefined);
  assert.ok(!JSON.stringify(room.playerView(bob.id)).includes(meme.id), 'phones watch the big screen');
});

test('the room keeps the images it still needs, and lets go of the rest', () => {
  const { room, players } = roomWith('Alice', 'Bob');
  const [alice, bob] = players;
  const a = room.addImageMeme(alice.id, cleanImage(PNG));
  const b = room.addImageMeme(bob.id, cleanImage(GIF));
  room.removeMeme(bob.id, b.id);
  assert.deepEqual([...room.imageMemes().keys()], [a.id]);
  assert.equal(room.mediaBytes(), PNG.length);
  room.start();
  room.end();
  assert.deepEqual([...room.imageMemes().keys()], [a.id], 'kept until play again');
  room.playAgain();
  assert.equal(room.imageMemes().size, 0);
});

test('image memes survive a snapshot, and old link-only saves still load', () => {
  const { room, players } = roomWith('Alice', 'Bob');
  const meme = room.addImageMeme(players[0].id, cleanImage(PNG));
  room.addMeme(players[1].id, 'https://example.com/b');
  room.start();
  const copy = Room.restore(JSON.parse(JSON.stringify(room.snapshot())));
  assert.equal(copy.imageMemes().get(meme.id).type, 'image/png');

  // Saves from before images existed: link memes without a kind.
  const old = JSON.parse(JSON.stringify(room.snapshot()));
  old.players[1].memes = [{ id: 'abc', url: 'https://example.com/old' }];
  for (const m of old.deck) if (m.kind === 'link') delete m.kind;
  const restored = Room.restore(old);
  assert.equal(restored.players.get(players[1].id).memes[0].kind, 'link');
  assert.ok(restored.deck.every((m) => m.kind === 'link' || m.kind === 'image'));
});

test('silly awards at the end', () => {
  const { room, alice } = revealedRound();
  const artistId = room.doodle.artistId;
  room.pickDoodleTarget(artistId, alice.id);
  room.finishDoodle(artistId, { photo: DOODLED });
  room.next();
  assert.equal(room.phase, 'over');
  const awards = Object.fromEntries(room.hostView().awards.map((a) => [a.title, a.name]));
  assert.equal(awards.Picasso, room.players.get(artistId).name);
  assert.equal(awards['Human Canvas'], 'Alice');
  assert.equal(awards['Master of Disguise'], undefined, 'nobody was fooled, so no award');
  assert.ok(awards.Sherlock);
});
