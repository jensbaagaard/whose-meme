'use strict';

const crypto = require('crypto');

const MB = 1024 * 1024;

const LIMITS = {
  nameLength: 20,
  photoBytes: 128 * 1024,
  imageBytes: 3 * MB, // phones shrink still images to ~300KB, so this is generous
  gifBytes: 6 * MB, // GIFs are uploaded untouched so they keep animating
  roomMediaBytes: (Number(process.env.MAX_ROOM_MEDIA_MB) || 150) * MB,
  urlLength: 2048,
  memesPerPlayer: Number(process.env.MAX_MEMES_PER_PLAYER) || 10,
  playersPerRoom: Number(process.env.MAX_PLAYERS_PER_ROOM) || 16,
};

const PHASE = {
  LOBBY: 'lobby',
  GUESSING: 'guessing',
  REVEAL: 'reveal',
  OVER: 'over',
};

// Scoring: a correct guess earns 1 point, and the uploader earns 1 point per player they fooled.
const POINTS_CORRECT = 1;
const POINTS_PER_FOOLED = 1;

// After each reveal, one random correct guesser gets to vandalise someone's face (and name).
const DOODLE = {
  pickMs: 15 * 1000,
  drawMs: 45 * 1000,
  graceMs: 5 * 1000, // time for the artist's phone to send its picture after the clock runs out
  colors: ['#111111', '#ffffff', '#ff3b3b', '#ffd23f', '#35d887', '#3b82f6', '#ff4f9a', '#8b5a2b'],
  widths: [0.012, 0.03, 0.06], // pen sizes, as a fraction of the image size
  stickers: ['🤡', '🥸', '👑', '🐽', '🕶️', '💩', '👀', '💋', '🔥', '🎩', '🦄', '💀'],
  stickerSizes: [0.14, 0.24, 0.38],
  maxPoints: 20000,
  maxPointsPerSegment: 400,
};

const REACTIONS = ['😂', '💀', '🔥', '😱', '🤡', '👀', '🫠', '💩'];

// Silly titles handed out at the end, from per-player stats.
const AWARDS = [
  { key: 'correct', emoji: '🕵️', title: 'Sherlock', detail: (n) => `${n} correct guess${n === 1 ? '' : 'es'}` },
  { key: 'fooled', emoji: '🎭', title: 'Master of Disguise', detail: (n) => `fooled people ${n} time${n === 1 ? '' : 's'}` },
  { key: 'wrong', emoji: '🤡', title: 'Most Gullible', detail: (n) => `${n} wrong guess${n === 1 ? '' : 'es'}` },
  { key: 'doodles', emoji: '🎨', title: 'Picasso', detail: (n) => `vandalised ${n} face${n === 1 ? '' : 's'}` },
  { key: 'doodled', emoji: '🖍️', title: 'Human Canvas', detail: (n) => `got doodled on ${n} time${n === 1 ? '' : 's'}` },
];

const emptyStats = () => ({ correct: 0, wrong: 0, fooled: 0, doodles: 0, doodled: 0 });

class GameError extends Error {}

const id = () => crypto.randomBytes(8).toString('hex');

function shuffle(items) {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function cleanName(raw) {
  const name = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!name) throw new GameError('Pick a name first.');
  if (name.length > LIMITS.nameLength) throw new GameError(`Names can be at most ${LIMITS.nameLength} characters.`);
  return name;
}

// Phones send a small JPEG selfie as a data URL; we keep the raw bytes.
function cleanPhoto(raw) {
  const match = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(raw ?? ''));
  if (!match) throw new GameError('Take a photo first.');
  const bytes = Buffer.from(match[1], 'base64');
  if (bytes.length > LIMITS.photoBytes) throw new GameError('That photo is too big.');
  if (bytes.length < 3 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
    throw new GameError("That photo didn't come through, try again.");
  }
  return bytes;
}

// Uploaded meme images are trusted by their first bytes, never by the name or Content-Type they came with.
// No SVG: it can carry scripts.
function sniffImageType(bytes) {
  const starts = (...sig) => sig.every((b, i) => bytes[i] === b);
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (starts(0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes.length > 12 && bytes.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function cleanImage(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new GameError('Pick an image first.');
  const type = sniffImageType(bytes);
  if (!type) throw new GameError('Only JPEG, PNG, GIF and WebP images work.');
  const max = type === 'image/gif' ? LIMITS.gifBytes : LIMITS.imageBytes;
  if (bytes.length > max) throw new GameError(`That image is too big (max ${Math.round(max / MB)}MB).`);
  return { type, bytes: bytes.length, hash: crypto.createHash('sha1').update(bytes).digest('hex') };
}

const clamp01 = (n) => Math.round(Math.min(1, Math.max(0, n)) * 1000) / 1000;
const isNumber = (n) => typeof n === 'number' && Number.isFinite(n);

// One piece of a doodle, in 0..1 image coordinates. Either a pen stroke segment
// { s: stroke id, c: color, w: width, p: [x, y, x, y, ...] } or a sticker { s, e: emoji, z: size, x, y }.
function cleanSegment(raw) {
  const { s } = raw || {};
  if (typeof s !== 'string' || !/^[a-z0-9]{1,12}$/.test(s)) throw new GameError('Bad stroke.');
  if ('e' in raw) {
    const { e, z, x, y } = raw;
    if (!DOODLE.stickers.includes(e) || !DOODLE.stickerSizes.includes(z)) throw new GameError('Bad sticker.');
    if (!isNumber(x) || !isNumber(y)) throw new GameError('Bad sticker.');
    return { s, e, z, x: clamp01(x), y: clamp01(y) };
  }
  const { c, w, p } = raw;
  if (!DOODLE.colors.includes(c) || !DOODLE.widths.includes(w)) throw new GameError('Bad brush.');
  if (!Array.isArray(p) || p.length < 2 || p.length % 2 || p.length > DOODLE.maxPointsPerSegment * 2) {
    throw new GameError('Bad stroke.');
  }
  if (!p.every(isNumber)) throw new GameError('Bad stroke.');
  return { s, c, w, p: p.map(clamp01) };
}

function cleanUrl(raw) {
  let text = String(raw ?? '').trim();
  if (!text) throw new GameError('Paste a link first.');
  if (text.length > LIMITS.urlLength) throw new GameError('That link is too long.');
  // People often paste "tiktok.com/..." without the scheme.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(text)) text = `https://${text}`;
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new GameError("That doesn't look like a link.");
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new GameError('Only http(s) links work.');
  if (!url.hostname.includes('.')) throw new GameError("That doesn't look like a link.");
  return url.href;
}

class Room {
  constructor(code) {
    this.code = code;
    this.hostToken = id();
    this.phase = PHASE.LOBBY;
    // playerId -> { id, token, name, photo, photoVersion, connections, score, stats, memes }
    // where a meme is { id, kind: 'link', url } or { id, kind: 'image', type, bytes, hash } (the file lives on disk).
    // The id is public (other phones see it); the token is the secret a phone uses to rejoin.
    this.players = new Map();
    this.tokens = new Map(); // token -> playerId
    this.deck = [];
    this.roundIndex = -1;
    this.round = null; // { meme, ownerId, guesses: Map<playerId, targetId>, results }
    this.doodle = null; // { id, artistId, targetId, deadline, segments, points } while someone draws (not saved)
    this.touch();
  }

  touch() {
    this.lastActivity = Date.now();
  }

  // --- persistence -----------------------------------------------------------

  // Plain JSON for the disk. Connection counts are left out: after a restart nobody is connected yet.
  snapshot() {
    return {
      version: 1,
      code: this.code,
      hostToken: this.hostToken,
      phase: this.phase,
      lastActivity: this.lastActivity,
      players: [...this.players.values()].map((p) => ({
        id: p.id,
        token: p.token,
        name: p.name,
        photo: p.photo.toString('base64'),
        photoVersion: p.photoVersion,
        score: p.score,
        stats: p.stats,
        memes: p.memes,
      })),
      deck: this.deck,
      roundIndex: this.roundIndex,
      round: this.round && {
        ownerId: this.round.ownerId,
        guesses: [...this.round.guesses],
        results: this.round.results,
      },
    };
  }

  static restore(data) {
    if (data.version !== 1) throw new Error(`Unknown room snapshot version ${data.version}`);
    const room = new Room(data.code);
    room.hostToken = data.hostToken;
    room.phase = data.phase;
    room.lastActivity = data.lastActivity;
    const withKind = (m) => ({ kind: 'link', ...m }); // saves from before image memes only had links
    for (const p of data.players) {
      room.players.set(p.id, {
        ...p,
        photo: Buffer.from(p.photo, 'base64'),
        stats: { ...emptyStats(), ...p.stats },
        memes: p.memes.map(withKind),
        connections: 0,
      });
      room.tokens.set(p.token, p.id);
    }
    room.deck = data.deck.map(withKind);
    room.roundIndex = data.roundIndex;
    if (data.round) {
      room.round = {
        meme: room.deck[room.roundIndex],
        ownerId: data.round.ownerId,
        guesses: new Map(data.round.guesses),
        results: data.round.results,
      };
    }
    return room;
  }

  // --- players -------------------------------------------------------------

  nameTaken(name, exceptId) {
    for (const p of this.players.values()) {
      if (p.id !== exceptId && p.name.toLowerCase() === name.toLowerCase()) return true;
    }
    return false;
  }

  join(token, rawName, rawPhoto) {
    const existingId = this.tokens.get(token);
    if (existingId) return this.players.get(existingId); // rejoin after refresh / phone sleep

    if (this.phase !== PHASE.LOBBY) throw new GameError('This game has already started. Wait for the next one!');
    if (this.players.size >= LIMITS.playersPerRoom) throw new GameError('This room is full.');
    const name = cleanName(rawName);
    if (this.nameTaken(name)) throw new GameError('Someone already has that name.');
    const photo = cleanPhoto(rawPhoto);
    const player = {
      id: id(),
      token,
      name,
      photo,
      photoVersion: 1,
      connections: 0,
      score: 0,
      stats: emptyStats(),
      memes: [],
    };
    this.players.set(player.id, player);
    this.tokens.set(token, player.id);
    return player;
  }

  rename(playerId, rawName) {
    const p = this.player(playerId);
    const name = cleanName(rawName);
    if (this.nameTaken(name, playerId)) throw new GameError('Someone already has that name.');
    p.name = name;
  }

  setPhoto(playerId, rawPhoto) {
    const p = this.player(playerId);
    p.photo = cleanPhoto(rawPhoto);
    p.photoVersion += 1;
  }

  remove(playerId) {
    const p = this.players.get(playerId);
    if (!p) return;
    this.players.delete(playerId);
    this.tokens.delete(p.token);
  }

  leave(playerId) {
    if (this.phase !== PHASE.LOBBY) throw new GameError("You can't leave in the middle of a game.");
    this.remove(playerId);
  }

  setConnected(playerId, connected) {
    const p = this.players.get(playerId);
    if (!p) return;
    p.connections = Math.max(0, p.connections + (connected ? 1 : -1));
  }

  player(playerId) {
    const p = this.players.get(playerId);
    if (!p) throw new GameError("You're not in this room.");
    return p;
  }

  // --- memes ---------------------------------------------------------------

  playerWithRoomForMeme(playerId) {
    const p = this.player(playerId);
    if (this.phase !== PHASE.LOBBY) throw new GameError('The game already started.');
    if (p.memes.length >= LIMITS.memesPerPlayer) throw new GameError(`Max ${LIMITS.memesPerPlayer} memes each.`);
    return p;
  }

  addMeme(playerId, rawUrl) {
    const p = this.playerWithRoomForMeme(playerId);
    const url = cleanUrl(rawUrl);
    if (p.memes.some((m) => m.url === url)) throw new GameError('You already added that one.');
    const meme = { id: id(), kind: 'link', url };
    p.memes.push(meme);
    return meme;
  }

  // `image` comes from cleanImage(); the caller stores the bytes on disk under the returned meme's id.
  addImageMeme(playerId, image) {
    const p = this.playerWithRoomForMeme(playerId);
    if (p.memes.some((m) => m.hash === image.hash)) throw new GameError('You already added that one.');
    if (this.mediaBytes() + image.bytes > LIMITS.roomMediaBytes) {
      throw new GameError('This room is out of space for images. Try a link instead!');
    }
    const meme = { id: id(), kind: 'image', type: image.type, bytes: image.bytes, hash: image.hash };
    p.memes.push(meme);
    return meme;
  }

  // Every image meme the room still needs (in someone's list or in the deck being played).
  imageMemes() {
    const byId = new Map();
    for (const p of this.players.values()) for (const m of p.memes) if (m.kind === 'image') byId.set(m.id, m);
    for (const m of this.deck) if (m.kind === 'image') byId.set(m.id, m);
    return byId;
  }

  mediaBytes() {
    let total = 0;
    for (const m of this.imageMemes().values()) total += m.bytes;
    return total;
  }

  removeMeme(playerId, memeId) {
    const p = this.player(playerId);
    if (this.phase !== PHASE.LOBBY) throw new GameError('The game already started.');
    p.memes = p.memes.filter((m) => m.id !== memeId);
  }

  memeCount() {
    let n = 0;
    for (const p of this.players.values()) n += p.memes.length;
    return n;
  }

  // --- game flow -----------------------------------------------------------

  canStart() {
    if (this.players.size < 2) return 'Need at least 2 players.';
    if (this.memeCount() < 1) return 'Nobody has added a meme yet.';
    return null;
  }

  start() {
    if (this.phase !== PHASE.LOBBY) throw new GameError('The game already started.');
    const problem = this.canStart();
    if (problem) throw new GameError(problem);
    const all = [];
    for (const p of this.players.values()) {
      p.score = 0;
      p.stats = emptyStats();
      for (const m of p.memes) all.push({ ...m, ownerId: p.id });
    }
    this.deck = shuffle(all);
    this.roundIndex = -1;
    this.nextRound();
  }

  nextRound() {
    this.roundIndex += 1;
    if (this.roundIndex >= this.deck.length) {
      this.phase = PHASE.OVER;
      this.round = null;
      return;
    }
    const meme = this.deck[this.roundIndex];
    this.round = { meme, ownerId: meme.ownerId, guesses: new Map(), results: null };
    this.phase = PHASE.GUESSING;
  }

  guess(playerId, targetId) {
    this.player(playerId);
    if (this.phase !== PHASE.GUESSING) throw new GameError('Not guessing right now.');
    if (targetId === playerId) throw new GameError("You can't pick yourself.");
    if (!this.players.has(targetId)) throw new GameError('That player is gone.');
    this.round.guesses.set(playerId, targetId);
  }

  // Everyone who is currently connected has locked in a guess.
  everyoneGuessed() {
    if (this.phase !== PHASE.GUESSING) return false;
    let connected = 0;
    for (const p of this.players.values()) {
      if (p.connections === 0) continue;
      connected += 1;
      if (!this.round.guesses.has(p.id)) return false;
    }
    return connected > 0;
  }

  reveal() {
    if (this.phase !== PHASE.GUESSING) throw new GameError('Nothing to reveal.');
    const { ownerId, guesses } = this.round;
    const owner = this.players.get(ownerId);
    const results = [];
    let fooled = 0;
    for (const [guesserId, targetId] of guesses) {
      if (guesserId === ownerId) continue; // the uploader's pick is only a bluff
      const guesser = this.players.get(guesserId);
      if (!guesser) continue;
      const correct = targetId === ownerId;
      if (correct) {
        guesser.score += POINTS_CORRECT;
        guesser.stats.correct += 1;
      } else {
        fooled += 1;
        guesser.stats.wrong += 1;
      }
      results.push({ playerId: guesserId, targetId, correct, points: correct ? POINTS_CORRECT : 0 });
    }
    const ownerPoints = fooled * POINTS_PER_FOOLED;
    if (owner) {
      owner.score += ownerPoints;
      owner.stats.fooled += fooled;
    }
    const winners = results.filter((r) => r.correct).map((r) => r.playerId);
    const artistId = winners.length ? winners[crypto.randomInt(winners.length)] : null;
    this.round.results = { list: results, fooled, ownerPoints, artistId, doodle: null };
    this.phase = PHASE.REVEAL;
    if (artistId) this.startDoodle(artistId);
  }

  next() {
    if (this.phase !== PHASE.REVEAL) throw new GameError('Reveal this meme first.');
    if (this.doodle) throw new GameError('Wait for the doodle to finish, or skip it.');
    this.nextRound();
  }

  end() {
    if (this.phase === PHASE.LOBBY) throw new GameError('The game has not started.');
    this.doodle = null;
    this.phase = PHASE.OVER;
    this.round = null;
  }

  // Back to the lobby with the same players, fresh scores and an empty meme pool.
  playAgain() {
    if (this.phase !== PHASE.OVER) throw new GameError('Finish the game first.');
    for (const p of this.players.values()) {
      p.score = 0;
      p.stats = emptyStats();
      p.memes = [];
    }
    this.deck = [];
    this.roundIndex = -1;
    this.round = null;
    this.phase = PHASE.LOBBY;
  }

  kick(playerId) {
    if (this.phase !== PHASE.LOBBY) throw new GameError('You can only remove players in the lobby.');
    this.remove(playerId);
  }

  // --- doodles --------------------------------------------------------------

  startDoodle(artistId) {
    this.doodle = { id: id(), artistId, targetId: null, deadline: Date.now() + DOODLE.pickMs, segments: [], points: 0 };
  }

  artistDoodle(playerId) {
    if (!this.doodle || this.doodle.artistId !== playerId) throw new GameError("It's not your turn to doodle.");
    return this.doodle;
  }

  pickDoodleTarget(playerId, targetId) {
    const doodle = this.artistDoodle(playerId);
    if (doodle.targetId) throw new GameError('You already picked a face.');
    if (targetId === playerId) throw new GameError('Pick someone else!');
    if (!this.players.has(targetId)) throw new GameError('That player is gone.');
    doodle.targetId = targetId;
    doodle.deadline = Date.now() + DOODLE.drawMs;
  }

  addDoodleSegment(playerId, raw) {
    const doodle = this.artistDoodle(playerId);
    if (!doodle.targetId) throw new GameError('Pick a face first.');
    const seg = cleanSegment(raw);
    const cost = seg.p ? seg.p.length / 2 : 50; // stickers are cheap to send but still capped
    if (doodle.points + cost > DOODLE.maxPoints) throw new GameError("That's enough ink!");
    doodle.points += cost;
    doodle.segments.push(seg);
    return seg;
  }

  undoDoodleStroke(playerId, strokeId) {
    const doodle = this.artistDoodle(playerId);
    doodle.segments = doodle.segments.filter((seg) => seg.s !== strokeId);
  }

  // The artist's phone sends the finished picture (photo + ink) and, optionally, a new name for the victim.
  finishDoodle(playerId, { photo: rawPhoto, name: rawName } = {}) {
    const doodle = this.artistDoodle(playerId);
    if (!doodle.targetId) throw new GameError('Pick a face first.');
    const target = this.players.get(doodle.targetId);
    const photo = cleanPhoto(rawPhoto);
    let newName = null;
    if (target && rawName != null && String(rawName).trim() && cleanName(rawName) !== target.name) {
      newName = cleanName(rawName);
      if (this.nameTaken(newName, target.id)) throw new GameError('Someone already has that name.');
    }
    const oldName = target ? target.name : '???';
    if (target) {
      target.photo = photo;
      target.photoVersion += 1;
      if (newName) target.name = newName;
      target.stats.doodled += 1;
    }
    const artist = this.players.get(playerId);
    if (artist) artist.stats.doodles += 1;
    if (this.round && this.round.results) {
      this.round.results.doodle = { artistId: playerId, targetId: doodle.targetId, oldName, newName };
    }
    this.doodle = null;
  }

  cancelDoodle() {
    this.doodle = null;
  }

  doodleExpired(now = Date.now()) {
    return Boolean(this.doodle) && now > this.doodle.deadline + DOODLE.graceMs;
  }

  // --- views (what each screen is allowed to know) -------------------------

  photoUrl(p) {
    return `/avatar/${this.code}/${p.id}.jpg?v=${p.photoVersion}`;
  }

  mediaUrl(meme) {
    return `/media/${this.code}/${meme.id}`;
  }

  memeView(meme) {
    return meme.kind === 'image'
      ? { id: meme.id, kind: 'image', image: this.mediaUrl(meme), bytes: meme.bytes }
      : { id: meme.id, kind: 'link', url: meme.url };
  }

  scoreboard() {
    return [...this.players.values()]
      .map((p) => ({ id: p.id, name: p.name, photo: this.photoUrl(p), score: p.score }))
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  }

  awards() {
    const ranked = this.scoreboard().map((s) => this.players.get(s.id));
    const out = [];
    for (const award of AWARDS) {
      let best = null;
      for (const p of ranked) if (p.stats[award.key] > (best ? best.stats[award.key] : 0)) best = p;
      if (!best) continue;
      out.push({
        emoji: award.emoji,
        title: award.title,
        detail: award.detail(best.stats[award.key]),
        playerId: best.id,
        name: best.name,
        photo: this.photoUrl(best),
      });
    }
    return out;
  }

  roundInfo() {
    return { number: this.roundIndex + 1, total: this.deck.length };
  }

  revealInfo() {
    const owner = this.players.get(this.round.ownerId);
    return {
      ownerId: this.round.ownerId,
      ownerName: owner ? owner.name : '???',
      ownerPhoto: owner ? this.photoUrl(owner) : null,
      results: this.round.results.list,
      fooled: this.round.results.fooled,
      ownerPoints: this.round.results.ownerPoints,
      artistId: this.round.results.artistId ?? null,
      doodle: this.round.results.doodle ?? null,
    };
  }

  doodleInfo(viewerId) {
    const d = this.doodle;
    if (!d) return null;
    const artist = this.players.get(d.artistId);
    const target = d.targetId ? this.players.get(d.targetId) : null;
    return {
      id: d.id,
      artistId: d.artistId,
      artistName: artist ? artist.name : '???',
      artistPhoto: artist ? this.photoUrl(artist) : null,
      targetId: d.targetId,
      targetName: target ? target.name : null,
      targetPhoto: target ? this.photoUrl(target) : null,
      remainingMs: Math.max(0, d.deadline - Date.now()),
      isArtist: viewerId === d.artistId,
      isTarget: Boolean(viewerId) && viewerId === d.targetId,
      tools:
        viewerId === d.artistId
          ? { colors: DOODLE.colors, widths: DOODLE.widths, stickers: DOODLE.stickers, stickerSizes: DOODLE.stickerSizes }
          : undefined,
    };
  }

  hostView() {
    const view = {
      role: 'host',
      code: this.code,
      phase: this.phase,
      players: [...this.players.values()].map((p) => ({
        id: p.id,
        name: p.name,
        photo: this.photoUrl(p),
        connected: p.connections > 0,
        score: p.score,
        memeCount: p.memes.length,
        hasGuessed: this.phase === PHASE.GUESSING && this.round.guesses.has(p.id),
      })),
      memeCount: this.memeCount(),
      startProblem: this.phase === PHASE.LOBBY ? this.canStart() : null,
      scoreboard: this.scoreboard(),
      doodle: this.doodleInfo(null),
    };
    if (this.phase === PHASE.GUESSING || this.phase === PHASE.REVEAL) {
      const { id: _id, ...meme } = this.memeView(this.round.meme);
      view.round = { ...this.roundInfo(), ...meme };
      if (this.phase === PHASE.REVEAL) view.round.reveal = this.revealInfo();
    }
    if (this.phase === PHASE.OVER) view.awards = this.awards();
    return view;
  }

  playerView(playerId) {
    const me = this.players.get(playerId);
    if (!me) return { role: 'player', code: this.code, phase: 'gone' };
    const view = {
      role: 'player',
      code: this.code,
      phase: this.phase,
      me: {
        id: me.id,
        name: me.name,
        photo: this.photoUrl(me),
        score: me.score,
        memes: me.memes.map((m) => this.memeView(m)),
      },
      players: [...this.players.values()].map((p) => ({
        id: p.id,
        name: p.name,
        photo: this.photoUrl(p),
        connected: p.connections > 0,
      })),
      memeCount: this.memeCount(),
      memeLimit: LIMITS.memesPerPlayer,
      scoreboard: this.scoreboard(),
      doodle: this.doodleInfo(playerId),
      reactions: REACTIONS,
    };
    if (this.phase === PHASE.GUESSING || this.phase === PHASE.REVEAL) {
      view.round = {
        ...this.roundInfo(),
        isMine: this.round.ownerId === playerId,
        myGuess: this.round.guesses.get(playerId) ?? null,
      };
      if (this.phase === PHASE.REVEAL) view.round.reveal = this.revealInfo();
    }
    if (this.phase === PHASE.OVER) view.awards = this.awards();
    return view;
  }
}

module.exports = {
  Room,
  GameError,
  PHASE,
  LIMITS,
  DOODLE,
  REACTIONS,
  cleanUrl,
  cleanName,
  cleanPhoto,
  cleanImage,
  cleanSegment,
  sniffImageType,
};
