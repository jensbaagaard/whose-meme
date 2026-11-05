'use strict';

// Tiny DOM helpers shared by the host screen and the phone page.

const $ = (selector, root = document) => root.querySelector(selector);

// h('div', { class: 'x', onclick: fn }, 'text', childNode, [moreChildren])
function h(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key === 'class') node.className = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function showScreen(name) {
  for (const screen of document.querySelectorAll('[data-screen]')) {
    screen.hidden = screen.dataset.screen !== name;
  }
}

function avatar(player, size = '') {
  return h('img', { class: `avatar ${size}`, src: player.photo, alt: player.name, draggable: 'false' });
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

let toastTimer;
function toast(message) {
  let node = $('#toast');
  if (!node) {
    node = h('div', { id: 'toast', role: 'status' });
    document.body.append(node);
  }
  node.textContent = message;
  node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), 3500);
}

// socket.emit with an ack, as a promise that resolves to { ok, error, ... }.
function request(socket, event, payload) {
  return new Promise((resolve) => {
    socket.timeout(10000).emit(event, payload || {}, (err, res) => {
      resolve(err ? { ok: false, error: 'No answer from the server, check your connection.' } : res);
    });
  });
}

const storage = {
  get(key) {
    try {
      return JSON.parse(localStorage.getItem(key));
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // private mode or full storage: we just lose auto-rejoin
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch {}
  },
};

function connectionBanner(socket) {
  const banner = h('div', { class: 'offline', hidden: true }, 'Reconnecting…');
  document.body.append(banner);
  socket.on('connect', () => (banner.hidden = true));
  socket.on('disconnect', () => (banner.hidden = false));
}
