'use strict';

const http = require('http');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const { Room, GameError, REACTIONS } = require('./src/game');
const { RoomStore } = require('./src/store');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const ROOM_TTL_MS = (Number(process.env.ROOM_TTL_HOURS) || 3) * 60 * 60 * 1000;
const MAX_ROOMS = Number(process.env.MAX_ROOMS) || 500;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O, they read like 1 and 0
const store = new RoomStore(DATA_DIR);
const rooms = new Map(store.loadAll().map((room) => [room.code, room]));

function newRoomCode() {
  for (let attempt = 0; attempt < 1000; attempt++) {
    let code = '';
    for (let i = 0; i < 4; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    if (!rooms.has(code)) return code;
  }
  throw new GameError('Could not find a free room code, try again.');
}

const normalizeCode = (raw) => String(raw ?? '').trim().toUpperCase();

function getRoom(code) {
  const room = rooms.get(normalizeCode(code));
  if (!room) throw new GameError("That room doesn't exist (or it expired).");
  return room;
}

// --- http ------------------------------------------------------------------

const app = express();
app.set('trust proxy', 'loopback'); // trust X-Forwarded-* from a local nginx only
app.disable('x-powered-by');

app.get('/healthz', (req, res) => res.json({ ok: true, rooms: rooms.size }));

app.get('/qr/:code.svg', async (req, res) => {
  const code = normalizeCode(req.params.code);
  if (!rooms.has(code)) return res.status(404).end();
  const url = `${req.protocol}://${req.get('host')}/?room=${code}`;
  const svg = await QRCode.toString(url, { type: 'svg', margin: 1, color: { dark: '#000000', light: '#ffffff' } });
  res.type('image/svg+xml').set('Cache-Control', 'no-store').send(svg);
});

app.get('/avatar/:code/:playerId.jpg', (req, res) => {
  const room = rooms.get(normalizeCode(req.params.code));
  const player = room && room.players.get(req.params.playerId);
  if (!player || !player.photo) return res.status(404).end();
  // URLs carry ?v=<photoVersion>, so a retake gets a new URL and old ones can cache forever.
  res.type('image/jpeg').set('Cache-Control', 'private, max-age=86400').set('X-Content-Type-Options', 'nosniff');
  res.send(player.photo);
});

app.get('/host', (req, res) => res.sendFile(path.join(__dirname, 'public', 'host.html')));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 256 * 1024 }); // room for one selfie or doodle

// --- realtime ----------------------------------------------------------------

const hostChannel = (code) => `host:${code}`;
const playerChannel = (code, playerId) => `player:${code}:${playerId}`;
const roomChannel = (code) => `room:${code}`; // every screen in the room: host and phones

function broadcast(room) {
  io.to(hostChannel(room.code)).emit('state', room.hostView());
  for (const playerId of room.players.keys()) {
    io.to(playerChannel(room.code, playerId)).emit('state', room.playerView(playerId));
  }
}

// Wraps a socket handler: catches game errors, answers the ack, then saves and pushes fresh state
// for the room the socket was in before and after (joining, leaving and creating move sockets).
function handler(socket, fn) {
  return async (payload, ack) => {
    if (typeof payload === 'function') [payload, ack] = [{}, payload];
    const reply = typeof ack === 'function' ? ack : () => {};
    const before = socket.data.code;
    try {
      const result = await fn(payload || {});
      reply({ ok: true, ...result });
    } catch (err) {
      if (!(err instanceof GameError)) console.error(err);
      reply({ ok: false, error: err instanceof GameError ? err.message : 'Something went wrong.' });
    }
    for (const code of new Set([before, socket.data.code])) {
      const room = code && rooms.get(code);
      if (!room) continue;
      room.touch();
      store.save(room);
      broadcast(room);
    }
  };
}

function hostRoom(socket) {
  if (socket.data.role !== 'host') throw new GameError('Only the main screen can do that.');
  return getRoom(socket.data.code);
}

function playerRoom(socket) {
  if (socket.data.role !== 'player') throw new GameError('Join a room first.');
  const room = getRoom(socket.data.code);
  room.player(socket.data.playerId); // throws if they were kicked
  return room;
}

// Puts a socket into a room, as the host screen (no playerId) or as one player.
function attach(socket, room, playerId) {
  detach(socket);
  socket.data = playerId ? { role: 'player', code: room.code, playerId } : { role: 'host', code: room.code };
  socket.join(playerId ? playerChannel(room.code, playerId) : hostChannel(room.code));
  socket.join(roomChannel(room.code));
  if (playerId) room.setConnected(playerId, true);
  // Someone is mid-doodle: catch this screen up on the strokes so far.
  if (room.doodle) socket.emit('doodle:replay', { id: room.doodle.id, segments: room.doodle.segments });
}

// Moves a socket out of whatever room it was attached to before.
function detach(socket) {
  const { code, role, playerId } = socket.data;
  if (!code) return;
  const room = rooms.get(code);
  socket.leave(roomChannel(code));
  if (role === 'host') socket.leave(hostChannel(code));
  if (role === 'player') {
    socket.leave(playerChannel(code, playerId));
    if (room) room.setConnected(playerId, false);
  }
  socket.data = {};
  if (room) broadcast(room);
}

io.on('connection', (socket) => {
  socket.data = {};

  socket.on('host:create', handler(socket, () => {
    if (rooms.size >= MAX_ROOMS) throw new GameError('The server is full right now, try again later.');
    const room = new Room(newRoomCode());
    rooms.set(room.code, room);
    attach(socket, room);
    return { code: room.code, hostToken: room.hostToken };
  }));

  socket.on('host:resume', handler(socket, ({ code, hostToken }) => {
    const room = getRoom(code);
    if (room.hostToken !== hostToken) throw new GameError('That room belongs to another screen.');
    attach(socket, room);
    return { code: room.code };
  }));

  socket.on('host:start', handler(socket, () => hostRoom(socket).start()));
  socket.on('host:reveal', handler(socket, () => hostRoom(socket).reveal()));
  socket.on('host:next', handler(socket, () => hostRoom(socket).next()));
  socket.on('host:end', handler(socket, () => hostRoom(socket).end()));
  socket.on('host:playAgain', handler(socket, () => hostRoom(socket).playAgain()));
  socket.on('host:skipDoodle', handler(socket, () => hostRoom(socket).cancelDoodle()));

  socket.on('host:kick', handler(socket, ({ playerId }) => {
    const room = hostRoom(socket);
    room.kick(playerId);
    io.to(playerChannel(room.code, playerId)).emit('state', room.playerView(playerId));
  }));

  // New players send name + photo; returning phones only need their token.
  socket.on('player:join', handler(socket, ({ code, token, name, photo }) => {
    const room = getRoom(code);
    if (typeof token !== 'string' || !/^[a-zA-Z0-9-]{16,64}$/.test(token)) throw new GameError('Bad player token.');
    const player = room.join(token, name, photo);
    if (socket.data.code !== room.code || socket.data.playerId !== player.id) attach(socket, room, player.id);
    return { code: room.code, playerId: player.id };
  }));

  socket.on('player:setPhoto', handler(socket, ({ photo }) => {
    playerRoom(socket).setPhoto(socket.data.playerId, photo);
  }));

  socket.on('player:rename', handler(socket, ({ name }) => {
    playerRoom(socket).rename(socket.data.playerId, name);
  }));

  socket.on('player:leave', handler(socket, () => {
    const room = playerRoom(socket);
    room.leave(socket.data.playerId);
    detach(socket);
  }));

  socket.on('player:addMeme', handler(socket, ({ url }) => {
    playerRoom(socket).addMeme(socket.data.playerId, url);
  }));

  socket.on('player:removeMeme', handler(socket, ({ memeId }) => {
    playerRoom(socket).removeMeme(socket.data.playerId, memeId);
  }));

  socket.on('player:guess', handler(socket, ({ targetId }) => {
    const room = playerRoom(socket);
    room.guess(socket.data.playerId, targetId);
    if (room.everyoneGuessed()) room.reveal();
  }));

  // --- the doodle: a random correct guesser vandalises someone's face ---

  socket.on('doodle:pick', handler(socket, ({ targetId }) => {
    playerRoom(socket).pickDoodleTarget(socket.data.playerId, targetId);
  }));

  socket.on('doodle:done', handler(socket, ({ photo, name }) => {
    playerRoom(socket).finishDoodle(socket.data.playerId, { photo, name });
  }));

  // Strokes stream in many times a second, so they skip the save + full-state broadcast other events get.
  // A dropped stroke isn't worth bothering anyone about, so errors are ignored.
  socket.on('doodle:segment', (seg) => {
    try {
      const room = playerRoom(socket);
      const clean = room.addDoodleSegment(socket.data.playerId, seg);
      socket.to(roomChannel(room.code)).emit('doodle:segment', { id: room.doodle.id, seg: clean });
    } catch {}
  });

  socket.on('doodle:undo', (payload) => {
    try {
      const room = playerRoom(socket);
      const strokeId = payload && payload.s;
      room.undoDoodleStroke(socket.data.playerId, strokeId);
      socket.to(roomChannel(room.code)).emit('doodle:undo', { id: room.doodle.id, s: strokeId });
    } catch {}
  });

  // Emoji reactions float up the big screen. A few per second per phone is plenty.
  socket.on('react', (payload) => {
    try {
      const room = playerRoom(socket);
      const emoji = payload && payload.e;
      if (!REACTIONS.includes(emoji)) return;
      const now = Date.now();
      socket.data.reactedAt = (socket.data.reactedAt || []).filter((t) => now - t < 2000);
      if (socket.data.reactedAt.length >= 6) return;
      socket.data.reactedAt.push(now);
      io.to(hostChannel(room.code)).emit('reaction', { e: emoji, playerId: socket.data.playerId });
    } catch {}
  });

  socket.on('disconnect', () => detach(socket));
});

// The artist ran out of time and their phone never sent the picture (closed, asleep, ...): move on.
setInterval(() => {
  for (const room of rooms.values()) {
    if (room.doodleExpired()) {
      room.cancelDoodle();
      broadcast(room);
    }
  }
}, 1000).unref();

// Forget rooms nobody has touched in a while (including ones that went stale while we were down).
function expireRooms() {
  const cutoff = Date.now() - ROOM_TTL_MS;
  for (const [code, room] of rooms) {
    if (room.lastActivity < cutoff) {
      io.to(hostChannel(code)).emit('expired');
      rooms.delete(code);
      store.remove(code);
    }
  }
}
expireRooms();
setInterval(expireRooms, 60 * 1000).unref();

if (require.main === module) {
  // systemctl restart / deploys send SIGTERM: write out anything still pending before exiting.
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      store.flushAll();
      process.exit(0);
    });
  }
  server.listen(PORT, HOST, () => {
    const { address, port } = server.address();
    console.log(`Whose Meme? listening on http://${address}:${port} (${rooms.size} saved rooms loaded from ${DATA_DIR})`);
  });
}

module.exports = { server, rooms, store };
