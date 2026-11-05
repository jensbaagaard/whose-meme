'use strict';

const fs = require('fs');
const path = require('path');
const { Room } = require('./game');

// Keeps one JSON file per room so a restart (deploy, crash, reboot) doesn't end running games.
// Saves are batched per room; flushAll() writes everything that is still pending.
// Uploaded meme images are kept next to it as media/<code>/<memeId>, written once, and pruned
// whenever a room is saved and no longer refers to them.
class RoomStore {
  constructor(dir, { delayMs = 200 } = {}) {
    this.dir = dir;
    this.mediaDir = path.join(dir, 'media');
    this.delayMs = delayMs;
    this.pending = new Map(); // code -> { room, timer }
    fs.mkdirSync(this.mediaDir, { recursive: true, mode: 0o700 });
  }

  file(code) {
    return path.join(this.dir, `${code}.json`);
  }

  loadAll() {
    const rooms = [];
    for (const name of fs.readdirSync(this.dir)) {
      if (!/^[A-Z]{4}\.json$/.test(name)) continue;
      const file = path.join(this.dir, name);
      try {
        rooms.push(Room.restore(JSON.parse(fs.readFileSync(file, 'utf8'))));
      } catch (err) {
        console.error(`Skipping unreadable room file ${file}: ${err.message}`);
      }
    }
    // Media for rooms that are gone (expired while we were down, unreadable) goes too.
    const codes = new Set(rooms.map((r) => r.code));
    for (const name of fs.readdirSync(this.mediaDir)) {
      if (!codes.has(name)) fs.rmSync(path.join(this.mediaDir, name), { recursive: true, force: true });
    }
    for (const room of rooms) this.pruneMedia(room);
    return rooms;
  }

  save(room) {
    const entry = this.pending.get(room.code);
    if (entry) {
      entry.room = room;
      return;
    }
    const timer = setTimeout(() => this.flush(room.code), this.delayMs);
    this.pending.set(room.code, { room, timer });
  }

  flush(code) {
    const entry = this.pending.get(code);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(code);
    try {
      // Write-then-rename, so a crash mid-write never leaves a half-written file behind.
      const tmp = `${this.file(code)}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(entry.room.snapshot()), { mode: 0o600 });
      fs.renameSync(tmp, this.file(code));
      this.pruneMedia(entry.room);
    } catch (err) {
      console.error(`Could not save room ${code}: ${err.message}`);
    }
  }

  flushAll() {
    for (const code of [...this.pending.keys()]) this.flush(code);
  }

  remove(code) {
    const entry = this.pending.get(code);
    if (entry) clearTimeout(entry.timer);
    this.pending.delete(code);
    fs.rmSync(this.file(code), { force: true });
    fs.rmSync(path.join(this.mediaDir, code), { recursive: true, force: true });
  }

  // --- uploaded images --------------------------------------------------------

  mediaPath(code, memeId) {
    return path.join(this.mediaDir, code, memeId);
  }

  saveMedia(code, memeId, bytes) {
    fs.mkdirSync(path.join(this.mediaDir, code), { recursive: true, mode: 0o700 });
    const file = this.mediaPath(code, memeId);
    fs.writeFileSync(`${file}.tmp`, bytes, { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
  }

  // Deletes images the room no longer needs (removed memes, players who left, a finished game).
  pruneMedia(room) {
    const dir = path.join(this.mediaDir, room.code);
    if (!fs.existsSync(dir)) return;
    const keep = room.imageMemes();
    for (const name of fs.readdirSync(dir)) {
      if (!keep.has(name)) fs.rmSync(path.join(dir, name), { force: true });
    }
  }
}

module.exports = { RoomStore };
