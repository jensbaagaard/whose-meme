'use strict';

const fs = require('fs');
const path = require('path');
const { Room } = require('./game');

// Keeps one JSON file per room so a restart (deploy, crash, reboot) doesn't end running games.
// Saves are batched per room; flushAll() writes everything that is still pending.
class RoomStore {
  constructor(dir, { delayMs = 200 } = {}) {
    this.dir = dir;
    this.delayMs = delayMs;
    this.pending = new Map(); // code -> { room, timer }
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
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
  }
}

module.exports = { RoomStore };
