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
        h('span', { class: 'mark' }, r.correct ? '✅' : '❌'),
      );
    }),
  );
  $('#reveal-scores').replaceChildren(...scoreItems(s));
  $('#next').textContent = round.number >= round.total ? 'Final results 🏆' : 'Next meme →';
}

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
  $('#final-scores').replaceChildren(...scoreItems(s));
}

// --- state ------------------------------------------------------------------------------

socket.on('state', (s) => {
  if (s.phase === 'lobby') renderLobby(s);
  if (s.phase === 'guessing') renderGuessing(s);
  if (s.phase === 'reveal') renderReveal(s);
  if (s.phase === 'over') renderOver(s);
  $('#top-right').replaceChildren(
    s.phase === 'lobby' ? h('button', { class: 'ghost', onclick: newRoom }, 'New room') : `Room ${s.code}`,
  );
  showScreen(s.phase);
});
