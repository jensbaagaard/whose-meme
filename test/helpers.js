'use strict';

const { io: connect } = require('socket.io-client');

const PHOTO = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 1, 2, 3]).toString('base64')}`;

const open = new Set();

// A socket.io client that remembers the latest state the server pushed to it.
async function connectClient(base) {
  const socket = connect(base, { transports: ['websocket'], forceNew: true, reconnection: false });
  open.add(socket);
  socket.latest = null;
  socket.waiters = [];
  socket.on('state', (s) => {
    socket.latest = s;
    socket.waiters = socket.waiters.filter((w) => !(w.pred(s) && (w.resolve(s), true)));
  });
  await new Promise((resolve) => socket.on('connect', resolve));
  return socket;
}

function closeAll() {
  for (const socket of open) socket.disconnect();
  open.clear();
}

const send = (socket, event, payload = {}) => socket.timeout(2000).emitWithAck(event, payload);

function stateWhere(socket, pred) {
  if (socket.latest && pred(socket.latest)) return Promise.resolve(socket.latest);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out; last state: ${JSON.stringify(socket.latest)}`)), 2000);
    socket.waiters.push({ pred, resolve: (s) => (clearTimeout(timer), resolve(s)) });
  });
}

module.exports = { PHOTO, connectClient, closeAll, send, stateWhere };
