'use strict';

const socket = io();
connectionBanner(socket);

const SESSION_KEY = 'wm.player'; // { code, token, name }
const PHOTO_KEY = 'wm.photo'; // data URL of the last selfie, reused as a default next time

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

// --- selfie ------------------------------------------------------------------

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Couldn't read that photo."));
    img.src = URL.createObjectURL(file);
  });
}

// Center-crop to a square and shrink to a small JPEG (well under the server's 64KB cap).
async function makeSelfie(file) {
  const img = await loadImage(file);
  const side = Math.min(img.naturalWidth, img.naturalHeight);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  canvas.getContext('2d').drawImage(
    img,
    (img.naturalWidth - side) / 2,
    (img.naturalHeight - side) / 2,
    side,
    side,
    0,
    0,
    canvas.width,
    canvas.height,
  );
  URL.revokeObjectURL(img.src);
  for (const quality of [0.75, 0.6, 0.45, 0.3]) {
    const dataUrl = canvas.toDataURL('image/jpeg', quality);
    if (dataUrl.length * 0.75 < 60 * 1024) return dataUrl;
  }
  throw new Error('That photo is too big, try another one.');
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

$('#leave').addEventListener('click', async () => {
  if (!confirm('Leave this room? Your memes go with you.')) return;
  const res = await request(socket, 'player:leave');
  if (!res.ok) return toast(res.error);
  forgetSession();
  showScreen('join');
});

function renderLobby(s) {
  $('#lobby-name').textContent = s.me.name;
  $('#lobby-code').textContent = s.code;
  $('#retake').replaceChildren(avatar(s.me));
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
    `${others} other player${others === 1 ? '' : 's'} · ${s.memeCount} meme${s.memeCount === 1 ? '' : 's'} in the pool. ` +
    'Waiting for the main screen to start…';
}

// --- guessing ----------------------------------------------------------------------

function renderGuessing(s) {
  $('#guess-round').textContent = `Meme ${s.round.number} of ${s.round.total}`;
  $('#yours').hidden = !s.round.isMine;
  const choices = s.players.filter((p) => p.id !== s.me.id);
  $('#pick-grid').replaceChildren(
    ...choices.map((p) =>
      h(
        'button',
        {
          class: `pick ${s.round.myGuess === p.id ? 'selected' : ''}`,
          onclick: async (e) => {
            for (const node of document.querySelectorAll('.pick')) node.classList.remove('selected');
            e.currentTarget.classList.add('selected');
            const res = await request(socket, 'player:guess', { targetId: p.id });
            if (!res.ok) toast(res.error);
          },
        },
        avatar(p),
        h('span', { class: 'label' }, p.name),
      ),
    ),
  );
  $('#guess-hint').textContent = s.round.myGuess
    ? 'Locked in! You can change your mind until the reveal.'
    : 'Watch the big screen, then tap a face.';
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
    detail = `You fooled ${reveal.fooled} ${reveal.fooled === 1 ? 'person' : 'people'} (+${reveal.ownerPoints})`;
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
    h('div', { class: 'owner-line' }, h('img', { class: 'avatar', src: reveal.ownerPhoto, alt: '' }), `It was ${reveal.ownerName}`),
  );
  $('#reveal-scores').replaceChildren(...scoreItems(s));
}

function renderOver(s) {
  const top = s.scoreboard[0] ? s.scoreboard[0].score : 0;
  const rank = s.scoreboard.findIndex((p) => p.id === s.me.id) + 1;
  const won = s.me.score === top && top > 0;
  $('#final').replaceChildren(
    h('div', { class: 'big' }, won ? '🏆 You won!' : `You came #${rank}`),
    h('div', {}, `${s.me.score} point${s.me.score === 1 ? '' : 's'}`),
  );
  $('#final-scores').replaceChildren(...scoreItems(s));
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
  if (s.phase === 'lobby') renderLobby(s);
  if (s.phase === 'guessing') renderGuessing(s);
  if (s.phase === 'reveal') renderReveal(s);
  if (s.phase === 'over') renderOver(s);
  showScreen(s.phase);
});
