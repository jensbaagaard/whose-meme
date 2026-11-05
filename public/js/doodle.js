'use strict';

// Draws a doodle (the victim's photo + pen strokes + stickers) into a square canvas.
// The artist's phone, the big screen and the watching phones all use this, fed by the same segments.
class DoodleCanvas {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.id = null;
    this.photoUrl = null;
    this.photo = null;
    this.segments = [];
  }

  // Switch to a doodle; strokes are kept when it is the same one (state updates arrive all the time).
  show(id, photoUrl) {
    if (id !== this.id) {
      this.id = id;
      this.segments = [];
    }
    if (photoUrl !== this.photoUrl) {
      this.photoUrl = photoUrl;
      this.photo = null;
      if (photoUrl) {
        const img = new Image();
        img.onload = () => {
          if (this.photoUrl !== photoUrl) return;
          this.photo = img;
          this.redraw();
        };
        img.src = photoUrl;
      }
    }
    this.redraw();
  }

  // Everything so far, sent when a screen joins mid-doodle. Can arrive before the state that names the doodle.
  replace(id, segments) {
    this.id = id;
    this.segments = segments.slice();
    this.redraw();
  }

  add(id, seg) {
    if (id !== this.id) return;
    this.segments.push(seg);
    this.drawSegment(seg);
  }

  undo(id, strokeId) {
    if (id !== this.id) return;
    this.segments = this.segments.filter((seg) => seg.s !== strokeId);
    this.redraw();
  }

  lastStrokeId() {
    return this.segments.length ? this.segments[this.segments.length - 1].s : null;
  }

  redraw() {
    const { ctx } = this;
    const size = this.canvas.width;
    ctx.fillStyle = '#2d2644';
    ctx.fillRect(0, 0, size, size);
    if (this.photo) ctx.drawImage(this.photo, 0, 0, size, size);
    for (const seg of this.segments) this.drawSegment(seg);
  }

  drawSegment(seg) {
    const { ctx } = this;
    const size = this.canvas.width;
    if (seg.e) {
      ctx.font = `${Math.round(seg.z * size)}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(seg.e, seg.x * size, seg.y * size);
      return;
    }
    const p = seg.p;
    ctx.strokeStyle = ctx.fillStyle = seg.c;
    ctx.lineWidth = seg.w * size;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (p.length === 2) {
      ctx.beginPath();
      ctx.arc(p[0] * size, p[1] * size, ctx.lineWidth / 2, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    ctx.beginPath();
    ctx.moveTo(p[0] * size, p[1] * size);
    for (let i = 2; i < p.length; i += 2) ctx.lineTo(p[i] * size, p[i + 1] * size);
    ctx.stroke();
  }
}

// Counts down to a deadline the server gave us as "ms remaining" (phone clocks can't be trusted to match).
class Countdown {
  constructor(onTick) {
    this.onTick = onTick;
    this.deadline = null;
    this.timer = setInterval(() => this.tick(), 250);
  }

  set(remainingMs) {
    this.deadline = remainingMs == null ? null : Date.now() + remainingMs;
    this.tick();
  }

  secondsLeft() {
    return this.deadline == null ? null : Math.max(0, Math.ceil((this.deadline - Date.now()) / 1000));
  }

  tick() {
    this.onTick(this.secondsLeft());
  }
}

const SILLY_FIRST = [
  'Captain', 'Sir', 'Lady', 'Professor', 'Big', 'Little', 'Sneaky', 'Soggy', 'Spicy', 'Sleepy', 'Wobbly', 'Crunchy',
  'Moist', 'Turbo', 'Baby', 'Grandma', 'Lord', 'DJ', 'Agent', 'Saint', 'Funky', 'Greasy', 'Dramatic', 'Tiny',
];
const SILLY_LAST = [
  'Noodle', 'Pickle', 'Toast', 'Potato', 'Waffle', 'Nugget', 'Goblin', 'Burrito', 'Pancake', 'Muffin', 'Gremlin',
  'Meatball', 'Taco', 'Sock', 'Bean', 'Pigeon', 'Walrus', 'Spaghetti', 'Cabbage', 'Llama', 'Biscuit', 'Shrimp',
];

function sillyName() {
  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  return `${pick(SILLY_FIRST)} ${pick(SILLY_LAST)}`;
}
