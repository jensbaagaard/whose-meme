'use strict';

const crypto = require('crypto');

const LIMITS = {
  nameLength: 20,
  photoBytes: 64 * 1024,
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
    // playerId -> { id, token, name, photo, photoVersion, connections, score, memes: [{ id, url }] }
    // The id is public (other phones see it); the token is the secret a phone uses to rejoin.
    this.players = new Map();
    this.tokens = new Map(); // token -> playerId
    this.deck = [];
    this.roundIndex = -1;
    this.round = null; // { meme, ownerId, guesses: Map<playerId, targetId>, results }
    this.touch();
  }

  touch() {
    this.lastActivity = Date.now();
  }

  // --- players -------------------------------------------------------------

  join(token, rawName, rawPhoto) {
    const existingId = this.tokens.get(token);
    if (existingId) return this.players.get(existingId); // rejoin after refresh / phone sleep

    if (this.phase !== PHASE.LOBBY) throw new GameError('This game has already started. Wait for the next one!');
    if (this.players.size >= LIMITS.playersPerRoom) throw new GameError('This room is full.');
    const name = cleanName(rawName);
    for (const p of this.players.values()) {
      if (p.name.toLowerCase() === name.toLowerCase()) throw new GameError('Someone already has that name.');
    }
    const photo = cleanPhoto(rawPhoto);
    const player = { id: id(), token, name, photo, photoVersion: 1, connections: 0, score: 0, memes: [] };
    this.players.set(player.id, player);
    this.tokens.set(token, player.id);
    return player;
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

  addMeme(playerId, rawUrl) {
    const p = this.player(playerId);
    if (this.phase !== PHASE.LOBBY) throw new GameError('The game already started.');
    if (p.memes.length >= LIMITS.memesPerPlayer) throw new GameError(`Max ${LIMITS.memesPerPlayer} memes each.`);
    const url = cleanUrl(rawUrl);
    if (p.memes.some((m) => m.url === url)) throw new GameError('You already added that one.');
    const meme = { id: id(), url };
    p.memes.push(meme);
    return meme;
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
      if (correct) guesser.score += POINTS_CORRECT;
      else fooled += 1;
      results.push({ playerId: guesserId, targetId, correct, points: correct ? POINTS_CORRECT : 0 });
    }
    const ownerPoints = fooled * POINTS_PER_FOOLED;
    if (owner) owner.score += ownerPoints;
    this.round.results = { list: results, fooled, ownerPoints };
    this.phase = PHASE.REVEAL;
  }

  next() {
    if (this.phase !== PHASE.REVEAL) throw new GameError('Reveal this meme first.');
    this.nextRound();
  }

  end() {
    if (this.phase === PHASE.LOBBY) throw new GameError('The game has not started.');
    this.phase = PHASE.OVER;
    this.round = null;
  }

  // Back to the lobby with the same players, fresh scores and an empty meme pool.
  playAgain() {
    if (this.phase !== PHASE.OVER) throw new GameError('Finish the game first.');
    for (const p of this.players.values()) {
      p.score = 0;
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

  // --- views (what each screen is allowed to know) -------------------------

  photoUrl(p) {
    return `/avatar/${this.code}/${p.id}.jpg?v=${p.photoVersion}`;
  }

  scoreboard() {
    return [...this.players.values()]
      .map((p) => ({ id: p.id, name: p.name, photo: this.photoUrl(p), score: p.score }))
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
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
    };
    if (this.phase === PHASE.GUESSING || this.phase === PHASE.REVEAL) {
      view.round = { ...this.roundInfo(), url: this.round.meme.url };
      if (this.phase === PHASE.REVEAL) view.round.reveal = this.revealInfo();
    }
    return view;
  }

  playerView(playerId) {
    const me = this.players.get(playerId);
    if (!me) return { role: 'player', code: this.code, phase: 'gone' };
    const view = {
      role: 'player',
      code: this.code,
      phase: this.phase,
      me: { id: me.id, name: me.name, photo: this.photoUrl(me), score: me.score, memes: me.memes },
      players: [...this.players.values()].map((p) => ({
        id: p.id,
        name: p.name,
        photo: this.photoUrl(p),
        connected: p.connections > 0,
      })),
      memeCount: this.memeCount(),
      memeLimit: LIMITS.memesPerPlayer,
      scoreboard: this.scoreboard(),
    };
    if (this.phase === PHASE.GUESSING || this.phase === PHASE.REVEAL) {
      view.round = {
        ...this.roundInfo(),
        isMine: this.round.ownerId === playerId,
        myGuess: this.round.guesses.get(playerId) ?? null,
      };
      if (this.phase === PHASE.REVEAL) view.round.reveal = this.revealInfo();
    }
    return view;
  }
}

module.exports = { Room, GameError, PHASE, LIMITS, cleanUrl, cleanName, cleanPhoto };
