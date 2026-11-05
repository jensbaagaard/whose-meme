'use strict';

const socket = io();
connectionBanner(socket);

const HOST_KEY = 'wm.host'; // { code, hostToken } so a refresh keeps the same room

async function createRoom() {
  const res = await request(socket, 'host:create');
  if (!res.ok) return toast(res.error);
  storage.set(HOST_KEY, { code: res.code, hostToken: res.hostToken });
}

socket.on('connect', async () => {
  const saved = storage.get(HOST_KEY);
  if (saved) {
    const res = await request(socket, 'host:resume', saved);
    if (res.ok) return;
  }
  await createRoom();
});

socket.on('expired', () => {
  storage.remove(HOST_KEY);
  toast('The old room expired, here is a fresh one.');
  createRoom();
});

async function act(event, payload) {
  const res = await request(socket, event, payload);
  if (!res.ok) toast(res.error);
}

function newRoom() {
  if (!confirm('Start a brand new room? Everyone will have to join again.')) return;
  storage.remove(HOST_KEY);
  createRoom();
}

$('#start').addEventListener('click', () => act('host:start'));
$('#reveal').addEventListener('click', () => act('host:reveal'));
$('#next').addEventListener('click', () => act('host:next'));
$('#again').addEventListener('click', () => act('host:playAgain'));
$('#new-room-2').addEventListener('click', newRoom);
$('#skip-doodle').addEventListener('click', () => act('host:skipDoodle'));
for (const id of ['#end-1', '#end-2']) {
  $(id).addEventListener('click', () => confirm('End the game now and show final scores?') && act('host:end'));
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// --- lobby ---------------------------------------------------------------------

function renderLobby(s) {
  $('#join-url').textContent = location.host;
  $('#room-code').textContent = s.code;
  const qr = `/qr/${s.code}.svg`;
  if ($('#qr').getAttribute('src') !== qr) $('#qr').src = qr;

  const grid = $('#player-grid');
  if (!s.players.length) {
    grid.replaceChildren(h('div', { class: 'empty' }, 'Waiting for players… scan the code to join!'));
  } else {
    grid.replaceChildren(
      ...s.players.map((p) =>
        h(
          'div',
          { class: `player-card ${p.connected ? '' : 'offline-player'}` },
          avatar(p),
          h('div', {}, p.name),
          h('div', { class: 'count' }, plural(p.memeCount, 'meme')),
          h('button', {
            class: 'kick',
            title: `Remove ${p.name}`,
            onclick: () => confirm(`Remove ${p.name} from the room?`) && act('host:kick', { playerId: p.id }),
          }, '✕'),
        ),
      ),
    );
  }
  $('#pool').textContent = `${plural(s.memeCount, 'meme')} in the pool`;
  $('#start-problem').textContent = s.startProblem || `${plural(s.players.length, 'player')} ready`;
  $('#start').disabled = Boolean(s.startProblem);
}

// --- guessing --------------------------------------------------------------------

function setLink(anchor, url) {
  if (anchor.getAttribute('href') !== url) anchor.href = url;
}

function renderGuessing(s) {
  const { round } = s;
  const active = s.players.filter((p) => p.connected || p.hasGuessed);
  const locked = active.filter((p) => p.hasGuessed).length;
  $('#guess-round').textContent = `Meme ${round.number} of ${round.total} · ${locked}/${active.length} locked in`;
  setLink($('#meme-link'), round.url);
  $('#meme-host').textContent = hostnameOf(round.url);
  $('#meme-url').textContent = round.url;
  $('#locked-row').replaceChildren(
    ...active.map((p) => h('div', { class: `locked ${p.hasGuessed ? 'in' : ''}` }, avatar(p), h('span', {}, p.name))),
  );
}

// --- reveal -------------------------------------------------------------------------

function scoreItems(s) {
  return s.scoreboard.map((p, i) =>
    h(
      'li',
      {},
      h('span', { class: 'rank' }, i + 1),
      avatar(p, 'sm'),
      h('span', { class: 'who' }, p.name),
      h('span', { class: 'pts' }, p.score),
    ),
  );
}

function renderReveal(s) {
  const { round } = s;
  const { reveal } = round;
  const byId = new Map(s.players.map((p) => [p.id, p]));
  $('#reveal-round').textContent = `Meme ${round.number} of ${round.total}`;
  $('#owner-photo').src = reveal.ownerPhoto;
  $('#owner-name').textContent = reveal.ownerName;
  $('#fooled').textContent = reveal.fooled
    ? `fooled ${plural(reveal.fooled, 'person').replace('persons', 'people')} (+${reveal.ownerPoints})`
    : reveal.results.length
      ? 'Nobody was fooled!'
      : 'Nobody guessed…';
  setLink($('#reveal-link'), round.url);
  $('#reveal-host').textContent = hostnameOf(round.url);
  $('#guess-list').replaceChildren(
    ...reveal.results.map((r) => {
      const guesser = byId.get(r.playerId);
      const target = byId.get(r.targetId);
      if (!guesser || !target) return null;
      return h(
        'div',
        { class: `guess ${r.correct ? 'right' : ''}` },
        avatar(guesser, 'sm'),
        h('span', {}, guesser.name),
        h('span', { class: 'arrow' }, '→'),
        avatar(target, 'sm'),
        h('span', {}, target.name),
        h('span', { class: 'mark' }, r.playerId === reveal.artistId ? '🎰' : r.correct ? '✅' : '❌'),
      );
    }),
  );
  $('#reveal-scores').replaceChildren(...scoreItems(s));
  $('#next').disabled = Boolean(s.doodle);
  $('#next').textContent = s.doodle
    ? 'Doodle in progress…'
    : round.number >= round.total
      ? 'Final results 🏆'
      : 'Next meme →';
  const roundKey = `${s.code}:${round.number}`;
  if (roundKey !== confettiFor) {
    confettiFor = roundKey;
    if (reveal.results.some((r) => r.correct)) confetti();
    else $('#owner-photo').animate([{ transform: 'rotate(0)' }, { transform: 'rotate(-8deg)' }, { transform: 'rotate(8deg)' }, { transform: 'rotate(0)' }], { duration: 400, iterations: 3 });
  }
}

let confettiFor = null;

function confetti() {
  const layer = $('#reaction-layer');
  const colors = ['#ffd23f', '#ff4f9a', '#35d887', '#3b82f6', '#ffffff', '#ff3b3b'];
  for (let i = 0; i < 120; i++) {
    const bit = h('span', { class: 'confetti' });
    bit.style.left = `${Math.random() * 100}vw`;
    bit.style.background = colors[i % colors.length];
    layer.append(bit);
    const drift = (Math.random() - 0.5) * 300;
    bit
      .animate(
        [
          { transform: 'translate(0, -10vh) rotate(0deg)' },
          { transform: `translate(${drift}px, 110vh) rotate(${720 * Math.random()}deg)` },
        ],
        { duration: 2200 + Math.random() * 1800, delay: Math.random() * 400, easing: 'cubic-bezier(.2,.6,.4,1)' },
      )
      .finished.then(() => bit.remove());
  }
}

// --- the doodle ------------------------------------------------------------------------

const doodleView = new DoodleCanvas($('#host-doodle'));
const doodleClock = new Countdown((left) => {
  if (left != null && current && current.doodle) $('#doodle-sub').textContent = doodleSubtitle(current.doodle, left);
});
let current = null;
let shownDoodle = null; // the doodle the overlay is showing, kept briefly after it ends
let hideTimer = null;

socket.on('doodle:segment', ({ id, seg }) => doodleView.add(id, seg));
socket.on('doodle:undo', ({ id, s }) => doodleView.undo(id, s));
socket.on('doodle:replay', ({ id, segments }) => doodleView.replace(id, segments));

function doodleSubtitle(d, left) {
  return d.targetId ? `⏱ ${left}s` : `is picking a face to vandalise… ⏱ ${left}s`;
}

function renderDoodle(s) {
  const overlay = $('#doodle-overlay');
  const d = s.phase === 'reveal' ? s.doodle : null;
  if (d) {
    clearTimeout(hideTimer);
    shownDoodle = d;
    overlay.hidden = false;
    $('#skip-doodle').hidden = false;
    $('#doodle-artist').hidden = Boolean(d.targetId);
    $('#host-doodle').hidden = !d.targetId;
    if (!d.targetId) {
      $('#doodle-heading').textContent = `🎰 ${d.artistName} won the doodle!`;
      $('#doodle-artist').src = d.artistPhoto;
    } else {
      $('#doodle-heading').textContent = `✏️ ${d.artistName} is vandalising ${d.targetName}`;
      doodleView.show(d.id, d.targetPhoto);
    }
    doodleClock.set(d.remainingMs);
    return;
  }
  doodleClock.set(null);
  if (s.phase !== 'reveal') {
    clearTimeout(hideTimer);
    overlay.hidden = true;
    shownDoodle = null;
    return;
  }
  if (!shownDoodle) return;
  // It just ended. If it was finished (not skipped), show off the result for a moment.
  const done = s.round.reveal.doodle;
  shownDoodle = null;
  if (done) {
    const target = s.players.find((p) => p.id === done.targetId);
    if (target) doodleView.show(`done:${done.targetId}:${target.photo}`, target.photo);
    $('#doodle-heading').textContent = done.newName ? `🎨 Say hi to “${done.newName}”` : '🎨 Masterpiece!';
    $('#doodle-sub').textContent = done.newName ? `formerly known as ${done.oldName}` : '';
    $('#skip-doodle').hidden = true;
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => (overlay.hidden = true), 4500);
  } else {
    overlay.hidden = true;
  }
}

// --- reactions -----------------------------------------------------------------------

socket.on('reaction', ({ e, playerId }) => {
  const player = current && current.players.find((p) => p.id === playerId);
  const bubble = h('div', { class: 'reaction' }, h('span', { class: 'reaction-emoji' }, e), player ? avatar(player, 'sm') : null);
  bubble.style.left = `${5 + Math.random() * 85}vw`;
  $('#reaction-layer').append(bubble);
  const sway = (Math.random() - 0.5) * 120;
  bubble
    .animate(
      [
        { transform: 'translate(0, 0) scale(0.6)', opacity: 0 },
        { transform: `translate(${sway / 2}px, -20vh) scale(1.1)`, opacity: 1, offset: 0.15 },
        { transform: `translate(${sway}px, -85vh) scale(1)`, opacity: 0 },
      ],
      { duration: 3200, easing: 'ease-out' },
    )
    .finished.then(() => bubble.remove());
});

// --- game over ------------------------------------------------------------------------

function renderOver(s) {
  const top = s.scoreboard.length ? s.scoreboard[0].score : 0;
  const winners = s.scoreboard.filter((p) => p.score === top).map((p) => p.name);
  $('#winner').textContent =
    top === 0
      ? 'Game over!'
      : winners.length === 1
        ? `🏆 ${winners[0]} wins!`
        : `🏆 ${winners.join(' & ')} tie!`;
  $('#awards').replaceChildren(
    ...(s.awards || []).map((a) =>
      h(
        'div',
        { class: 'award-card' },
        h('div', { class: 'award-emoji' }, a.emoji),
        avatar(a, 'lg'),
        h('div', { class: 'award-title' }, a.title),
        h('div', {}, a.name),
        h('div', { class: 'muted' }, a.detail),
      ),
    ),
  );
  $('#final-scores').replaceChildren(...scoreItems(s));
}

// --- state ------------------------------------------------------------------------------

socket.on('state', (s) => {
  if (s.phase === 'over' && current && current.phase !== 'over') confetti();
  current = s;
  if (s.phase === 'lobby') renderLobby(s);
  if (s.phase === 'guessing') renderGuessing(s);
  if (s.phase === 'reveal') renderReveal(s);
  if (s.phase === 'over') renderOver(s);
  renderDoodle(s);
  $('#top-right').replaceChildren(
    s.phase === 'lobby' ? h('button', { class: 'ghost', onclick: newRoom }, 'New room') : `Room ${s.code}`,
  );
  showScreen(s.phase);
});
