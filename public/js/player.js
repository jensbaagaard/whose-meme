'use strict';

const socket = io();
connectionBanner(socket);

const SESSION_KEY = 'wm.player'; // { code, token, name }
const PHOTO_KEY = 'wm.photo'; // data URL of the last selfie, reused as a default next time
const IMAGE_SIZE = 480; // selfies and doodles are this many pixels square
const MAX_IMAGE_BYTES = 120 * 1024; // the server allows 128KB

const urlRoom = (new URLSearchParams(location.search).get('room') || '').toUpperCase();
let session = storage.get(SESSION_KEY);
if (urlRoom && session && session.code !== urlRoom) session = null; // scanned a different room's QR
let photo = storage.get(PHOTO_KEY);
let state = null;
let lastPhase = null;

// crypto.randomUUID needs HTTPS; getRandomValues works on plain http too.
function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

// --- images --------------------------------------------------------------------

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Couldn't read that photo."));
    img.src = URL.createObjectURL(file);
  });
}

function canvasToJpeg(canvas) {
  for (const quality of [0.8, 0.65, 0.5, 0.35]) {
    const dataUrl = canvas.toDataURL('image/jpeg', quality);
    if (dataUrl.length * 0.75 < MAX_IMAGE_BYTES) return dataUrl;
  }
  throw new Error('That picture is too big, try another one.');
}

// Center-crop to a square and shrink to a small JPEG.
async function makeSelfie(file) {
  const img = await loadImage(file);
  const side = Math.min(img.naturalWidth, img.naturalHeight);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = IMAGE_SIZE;
  canvas.getContext('2d').drawImage(
    img,
    (img.naturalWidth - side) / 2,
    (img.naturalHeight - side) / 2,
    side,
    side,
    0,
    0,
    IMAGE_SIZE,
    IMAGE_SIZE,
  );
  URL.revokeObjectURL(img.src);
  return canvasToJpeg(canvas);
}

function pickPhoto(input) {
  return new Promise((resolve) => {
    input.value = '';
    input.onchange = async () => {
      const file = input.files && input.files[0];
      if (!file) return resolve(null);
      try {
        resolve(await makeSelfie(file));
      } catch (err) {
        toast(err.message);
        resolve(null);
      }
    };
    input.click();
  });
}

// --- join ----------------------------------------------------------------------

const codeInput = $('#code');
const nameInput = $('#name');
const shotButton = $('#shot-button');
const joinError = $('#join-error');

codeInput.value = urlRoom || (session && session.code) || '';
nameInput.value = (session && session.name) || storage.get('wm.name') || '';

function renderShot() {
  shotButton.replaceChildren(photo ? h('img', { src: photo, alt: 'Your photo' }) : '📸');
  shotButton.classList.toggle('has-photo', Boolean(photo));
  $('#shot-hint').textContent = photo
    ? 'Looking good! Tap to retake.'
    : 'Tap to take a selfie, people will guess by tapping your face';
}
renderShot();

shotButton.addEventListener('click', async () => {
  const shot = await pickPhoto($('#shot-input'));
  if (shot) {
    photo = shot;
    storage.set(PHOTO_KEY, photo);
    renderShot();
  }
});

$('#name-dice').addEventListener('click', () => (nameInput.value = sillyName()));

codeInput.addEventListener('input', () => {
  codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z]/g, '');
});

$('#join-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  joinError.textContent = '';
  if (!photo) return (joinError.textContent = 'Take a selfie first, it is how people pick you.');
  const code = codeInput.value.trim();
  const name = nameInput.value.trim();
  const token = newToken();
  $('#join-button').disabled = true;
  const res = await request(socket, 'player:join', { code, token, name, photo });
  $('#join-button').disabled = false;
  if (!res.ok) return (joinError.textContent = res.error);
  session = { code: res.code, token, name };
  storage.set(SESSION_KEY, session);
  storage.set('wm.name', name);
});

async function rejoin() {
  if (!session) {
    showScreen('join');
    return;
  }
  const res = await request(socket, 'player:join', { ...session, photo });
  if (!res.ok) {
    forgetSession();
    joinError.textContent = res.error;
    showScreen('join');
  }
}

function forgetSession() {
  session = null;
  storage.remove(SESSION_KEY);
  state = null;
  lastPhase = null;
}

socket.on('connect', rejoin);

// --- lobby -----------------------------------------------------------------------

$('#meme-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = $('#meme-url');
  $('#meme-error').textContent = '';
  if (!input.value.trim()) return;
  const res = await request(socket, 'player:addMeme', { url: input.value });
  if (res.ok) input.value = '';
  else $('#meme-error').textContent = res.error;
});

$('#retake').addEventListener('click', async () => {
  const shot = await pickPhoto($('#retake-input'));
  if (!shot) return;
  const res = await request(socket, 'player:setPhoto', { photo: shot });
  if (!res.ok) return toast(res.error);
  photo = shot;
  storage.set(PHOTO_KEY, photo);
});

$('#lobby-name').addEventListener('click', async () => {
  const name = prompt('Your new name (tip: leave it empty for a random silly one)', state.me.name);
  if (name == null) return;
  const res = await request(socket, 'player:rename', { name: name.trim() || sillyName() });
  if (!res.ok) toast(res.error);
});

$('#leave').addEventListener('click', async () => {
  if (!confirm('Leave this room? Your memes go with you.')) return;
  const res = await request(socket, 'player:leave');
  if (!res.ok) return toast(res.error);
  forgetSession();
  showScreen('join');
});

function renderLobby(s) {
  $('#lobby-name').textContent = `${s.me.name} ✏️`;
  $('#lobby-code').textContent = s.code;
  $('#retake').replaceChildren(avatar(s.me, 'lg'));
  $('#meme-count').textContent = `${s.me.memes.length} / ${s.memeLimit} added`;
  $('#meme-list').replaceChildren(
    ...s.me.memes.map((meme) =>
      h(
        'li',
        {},
        h('span', { class: 'url' }, h('span', { class: 'domain' }, hostnameOf(meme.url)), h('span', { class: 'full' }, meme.url)),
        h('button', {
          class: 'ghost',
          'aria-label': 'Remove',
          onclick: () => request(socket, 'player:removeMeme', { memeId: meme.id }),
        }, '✕'),
      ),
    ),
  );
  const others = s.players.length - 1;
  $('#lobby-status').textContent =
    `${plural(others, 'other player')} · ${plural(s.memeCount, 'meme')} in the pool. ` +
    'Waiting for the main screen to start…';
}

// --- guessing ----------------------------------------------------------------------

// A grid of tappable faces. State updates arrive whenever anyone guesses or reconnects; rebuilding the
// buttons each time could swallow a tap that lands mid-rebuild, so they are only rebuilt when the faces change.
function renderFaces(container, choices, selectedId, onPick) {
  const key = choices.map((p) => `${p.id}|${p.name}|${p.photo}`).join(',');
  if (container.dataset.key !== key) {
    container.dataset.key = key;
    container.replaceChildren(
      ...choices.map((p) =>
        h(
          'button',
          {
            class: 'pick',
            'data-id': p.id,
            onclick: () => {
              for (const b of container.children) b.classList.toggle('selected', b.dataset.id === p.id);
              onPick(p);
            },
          },
          avatar(p),
          h('span', { class: 'label' }, p.name),
        ),
      ),
    );
  }
  for (const b of container.children) b.classList.toggle('selected', b.dataset.id === selectedId);
}

function renderGuessing(s) {
  $('#guess-round').textContent = `Meme ${s.round.number} of ${s.round.total}`;
  $('#yours').hidden = !s.round.isMine;
  const choices = s.players.filter((p) => p.id !== s.me.id);
  renderFaces($('#pick-grid'), choices, s.round.myGuess, async (p) => {
    const res = await request(socket, 'player:guess', { targetId: p.id });
    if (!res.ok) toast(res.error);
  });
  $('#guess-hint').textContent = s.round.myGuess
    ? 'Locked in! You can change your mind until the reveal.'
    : 'Watch the big screen, then tap a face.';
}

// --- the doodle ---------------------------------------------------------------------

const artistView = new DoodleCanvas($('#doodle-canvas'));
const watchView = new DoodleCanvas($('#watch-canvas'));
const views = [artistView, watchView];

socket.on('doodle:segment', ({ id, seg }) => views.forEach((v) => v.add(id, seg)));
socket.on('doodle:undo', ({ id, s }) => views.forEach((v) => v.undo(id, s)));
socket.on('doodle:replay', ({ id, segments }) => views.forEach((v) => v.replace(id, segments)));

let artistDoodleId = null;
let submitting = false;
let sentOnTimeout = false;
let tools = null;
const tool = { kind: 'pen', color: null, sticker: null, size: 1 };

const artistClock = new Countdown((left) => {
  $('#doodle-timer').textContent = left == null ? '' : `⏱ ${left}s left`;
  const d = state && state.doodle;
  if (left === 0 && d && d.isArtist && d.targetId && !sentOnTimeout) {
    sentOnTimeout = true; // out of time: send what we have, once
    finishDoodle(true);
  }
});
const watchClock = new Countdown((left) => {
  $('#watch-timer').textContent = left == null ? '' : `⏱ ${left}s`;
});

function buildTools(t) {
  tools = t;
  tool.kind = 'pen';
  tool.color = t.colors[0];
  tool.sticker = t.stickers[0];
  tool.size = 1;
  $('#palette').replaceChildren(
    ...t.colors.map((c) =>
      h('button', { class: 'swatch', style: `--swatch: ${c}`, 'data-color': c, 'aria-label': c, onclick: () => setTool('pen', c) }),
    ),
  );
  $('#stickers').replaceChildren(
    ...t.stickers.map((e) => h('button', { class: 'sticker', 'data-sticker': e, onclick: () => setTool('sticker', e) }, e)),
  );
  $('#sizes').replaceChildren(
    ...[0, 1, 2].map((i) =>
      h('button', { class: 'size', 'data-size': i, 'aria-label': ['Small', 'Medium', 'Large'][i], onclick: () => setSize(i) }, h('span', { style: `--dot: ${8 + i * 8}px` })),
    ),
  );
  refreshTools();
}

function setTool(kind, value) {
  tool.kind = kind;
  if (kind === 'pen') tool.color = value;
  else tool.sticker = value;
  refreshTools();
}

function setSize(i) {
  tool.size = i;
  refreshTools();
}

function refreshTools() {
  for (const b of document.querySelectorAll('.swatch')) b.classList.toggle('on', tool.kind === 'pen' && b.dataset.color === tool.color);
  for (const b of document.querySelectorAll('.sticker')) b.classList.toggle('on', tool.kind === 'sticker' && b.dataset.sticker === tool.sticker);
  for (const b of document.querySelectorAll('.size')) b.classList.toggle('on', Number(b.dataset.size) === tool.size);
}

const strokeId = () => Math.random().toString(36).slice(2, 10) || 'z';

// Pen strokes are drawn locally right away and sent in small pieces (~25 per second) so the big screen draws along.
(function setupPen() {
  const canvas = artistView.canvas;
  let stroke = null; // { s, c, w, pending: [x, y, ...], last: [x, y] }
  let flushTimer = null;

  const pos = (e) => {
    const r = canvas.getBoundingClientRect();
    const clamp = (n) => Math.round(Math.min(1, Math.max(0, n)) * 1000) / 1000;
    return [clamp((e.clientX - r.left) / r.width), clamp((e.clientY - r.top) / r.height)];
  };

  function flush() {
    if (!stroke || !stroke.pending.length) return;
    const seg = { s: stroke.s, c: stroke.c, w: stroke.w, p: [...(stroke.last || []), ...stroke.pending] };
    stroke.last = stroke.pending.slice(-2);
    stroke.pending = [];
    artistView.segments.push(seg); // already on screen, keep it for redraws
    socket.emit('doodle:segment', seg);
  }

  canvas.addEventListener('pointerdown', (e) => {
    const d = state && state.doodle;
    if (!tools || !d || !d.isArtist || !d.targetId) return;
    e.preventDefault();
    const [x, y] = pos(e);
    if (tool.kind === 'sticker') {
      const seg = { s: strokeId(), e: tool.sticker, z: tools.stickerSizes[tool.size], x, y };
      artistView.add(artistView.id, seg);
      socket.emit('doodle:segment', seg);
      return;
    }
    canvas.setPointerCapture(e.pointerId);
    stroke = { s: strokeId(), c: tool.color, w: tools.widths[tool.size], pending: [x, y], last: null };
    artistView.drawSegment({ c: stroke.c, w: stroke.w, p: [x, y] });
    flush();
    flushTimer = setInterval(flush, 40);
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!stroke) return;
    const [x, y] = pos(e);
    const prev = stroke.pending.length ? stroke.pending.slice(-2) : stroke.last;
    artistView.drawSegment({ c: stroke.c, w: stroke.w, p: [...prev, x, y] });
    stroke.pending.push(x, y);
    if (stroke.pending.length >= 380) flush();
  });

  const end = () => {
    if (!stroke) return;
    flush();
    clearInterval(flushTimer);
    stroke = null;
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
})();

$('#undo').addEventListener('click', () => {
  const last = artistView.lastStrokeId();
  if (!last) return;
  artistView.undo(artistView.id, last);
  socket.emit('doodle:undo', { s: last });
});

$('#new-name-dice').addEventListener('click', () => ($('#new-name').value = sillyName()));
$('#doodle-done').addEventListener('click', () => finishDoodle(false));

async function finishDoodle(outOfTime) {
  if (submitting || !artistView.photo) return;
  submitting = true;
  const picture = canvasToJpeg(artistView.canvas);
  let res = await request(socket, 'doodle:done', { photo: picture, name: $('#new-name').value });
  // Out of time with a bad name (taken, too long): at least keep the drawing.
  if (!res.ok && outOfTime) res = await request(socket, 'doodle:done', { photo: picture });
  if (!res.ok) {
    submitting = false;
    toast(res.error);
  }
}

function renderDoodle(s) {
  const d = s.doodle;
  if (d.id !== artistDoodleId) {
    artistDoodleId = d.id;
    submitting = false;
    sentOnTimeout = false;
    $('#new-name').value = '';
    buildTools(d.tools);
  }
  $('#doodle-pick').hidden = Boolean(d.targetId);
  $('#doodle-draw').hidden = !d.targetId;
  if (!d.targetId) {
    const choices = s.players.filter((p) => p.id !== s.me.id);
    renderFaces($('#doodle-pick-grid'), choices, null, async (p) => {
      const res = await request(socket, 'doodle:pick', { targetId: p.id });
      if (!res.ok) toast(res.error);
    });
  } else {
    $('#doodle-title').textContent = `✏️ Vandalise ${d.targetName}!`;
    $('#new-name').placeholder = d.targetName;
    artistView.show(d.id, d.targetPhoto);
  }
  artistClock.set(d.remainingMs);
}

let wasTarget = false;

function renderWatch(s) {
  const d = s.doodle;
  const done = s.round.reveal.doodle;
  const watch = $('#watch');
  const canvas = $('#watch-canvas');
  const nameOf = (id) => (s.players.find((p) => p.id === id) || { name: '???' }).name;
  if (d) {
    watch.hidden = false;
    canvas.hidden = !d.targetId;
    if (!d.targetId) {
      $('#watch-title').textContent = `🎰 ${d.artistName} won the doodle and is picking a victim…`;
    } else {
      $('#watch-title').textContent = d.isTarget
        ? `😱 ${d.artistName} is drawing on YOUR face!`
        : `✏️ ${d.artistName} is doodling on ${d.targetName}`;
      watchView.show(d.id, d.targetPhoto);
    }
    if (d.isTarget && !wasTarget && navigator.vibrate) navigator.vibrate([120, 60, 120]);
    wasTarget = d.isTarget;
    watchClock.set(d.remainingMs);
  } else if (done) {
    const target = s.players.find((p) => p.id === done.targetId);
    watch.hidden = !target;
    canvas.hidden = false;
    if (target) watchView.show(`done:${done.targetId}`, target.photo);
    $('#watch-title').textContent = done.newName
      ? `🎨 ${nameOf(done.artistId)} turned ${done.oldName} into “${done.newName}”`
      : `🎨 ${nameOf(done.artistId)} doodled on ${done.oldName}`;
    watchClock.set(null);
    wasTarget = false;
  } else {
    watch.hidden = true;
    watchClock.set(null);
    wasTarget = false;
  }
}

// --- reveal / game over --------------------------------------------------------------

function scoreItems(s) {
  return s.scoreboard.map((p, i) =>
    h(
      'li',
      { class: p.id === s.me.id ? 'me' : '' },
      h('span', { class: 'rank' }, i + 1),
      avatar(p, 'sm'),
      h('span', { class: 'who' }, p.name),
      h('span', { class: 'pts' }, p.score),
    ),
  );
}

function renderReveal(s) {
  const { reveal, isMine, myGuess } = s.round;
  $('#reveal-round').textContent = `Meme ${s.round.number} of ${s.round.total}`;
  const verdict = $('#verdict');
  let tone;
  let headline;
  let detail;
  if (isMine) {
    tone = reveal.fooled > 0 ? 'good' : 'neutral';
    headline = reveal.fooled > 0 ? '😎 Gotcha!' : '🙈 Busted';
    detail = `You fooled ${plural(reveal.fooled, 'person', 'people')} (+${reveal.ownerPoints})`;
  } else if (!myGuess) {
    tone = 'neutral';
    headline = '⏰ Too slow';
    detail = 'You did not guess this one.';
  } else if (myGuess === reveal.ownerId) {
    tone = 'good';
    headline = '✅ Correct!';
    detail = '+1 point';
  } else {
    tone = 'bad';
    headline = '❌ Nope';
    detail = 'Better luck next meme.';
  }
  verdict.className = `verdict ${tone}`;
  verdict.replaceChildren(
    h('div', { class: 'big' }, headline),
    h('div', {}, detail),
    h('div', { class: 'owner-line' }, h('img', { class: 'avatar lg', src: reveal.ownerPhoto, alt: '' }), `It was ${reveal.ownerName}`),
  );
  renderWatch(s);
  $('#reveal-scores').replaceChildren(...scoreItems(s));
}

function renderOver(s) {
  const top = s.scoreboard[0] ? s.scoreboard[0].score : 0;
  const rank = s.scoreboard.findIndex((p) => p.id === s.me.id) + 1;
  const won = s.me.score === top && top > 0;
  $('#final').replaceChildren(
    h('div', { class: 'big' }, won ? '🏆 You won!' : `You came #${rank}`),
    h('div', {}, plural(s.me.score, 'point')),
  );
  $('#my-awards').replaceChildren(
    ...(s.awards || []).map((a) =>
      h(
        'div',
        { class: `award ${a.playerId === s.me.id ? 'mine' : ''}` },
        h('span', { class: 'award-emoji' }, a.emoji),
        h('span', { class: 'award-text' }, h('b', {}, a.title), h('span', {}, `${a.name} · ${a.detail}`)),
        avatar(a, 'sm'),
      ),
    ),
  );
  $('#final-scores').replaceChildren(...scoreItems(s));
}

// --- reactions --------------------------------------------------------------------------

let reactionsBuilt = false;

function renderReactions(s) {
  const bar = $('#reactions');
  if (!reactionsBuilt && s.reactions) {
    bar.replaceChildren(
      ...s.reactions.map((e) =>
        h('button', {
          class: 'react',
          onclick: (ev) => {
            socket.emit('react', { e });
            ev.currentTarget.animate([{ transform: 'scale(1.5)' }, { transform: 'scale(1)' }], { duration: 250 });
          },
        }, e),
      ),
    );
    reactionsBuilt = true;
  }
  const busyDrawing = s.doodle && s.doodle.isArtist;
  bar.hidden = !['guessing', 'reveal', 'over'].includes(s.phase) || busyDrawing;
  document.body.classList.toggle('has-reactions', !bar.hidden);
}

// --- state --------------------------------------------------------------------------

socket.on('state', (s) => {
  if (s.phase === 'gone') {
    forgetSession();
    joinError.textContent = 'You were removed from the room.';
    showScreen('join');
    return;
  }
  state = s;
  if (s.phase === 'guessing' && lastPhase !== 'guessing' && navigator.vibrate) navigator.vibrate(80);
  lastPhase = s.phase;
  let screen = s.phase;
  if (s.phase === 'lobby') renderLobby(s);
  if (s.phase === 'guessing') renderGuessing(s);
  if (s.phase === 'reveal') {
    if (s.doodle && s.doodle.isArtist) {
      renderDoodle(s);
      screen = 'doodle';
    } else {
      renderReveal(s);
    }
  }
  if (!s.doodle) artistClock.set(null);
  if (s.phase === 'over') renderOver(s);
  renderReactions(s);
  showScreen(screen);
});
