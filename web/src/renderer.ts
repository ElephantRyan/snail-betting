import { SNAIL_COUNT, SNAILS } from './protocol';

// Everything is drawn at a tiny logical resolution and scaled up with nearest-neighbour
// filtering (CSS image-rendering: pixelated), which is what gives the 8-bit look.
const W = 400;
const LANE_H = 40;
const LANE_H_NAMED = 46; // taller lanes leave room above each snail for its name
const TOP = 6;
const SPRITE_W = 22;
const SPRITE_H = 14;
const SCALE = 2; // snails are drawn at double size
const SPR_W = SPRITE_W * SCALE;
const SPR_H = SPRITE_H * SCALE;
const TRACK_START = 26; // screen x where the track area begins (right of the lane chips)
const VIEW = W - TRACK_START;
// The world scrolls: a snail at progress p (0..1) has its left edge at p * TRACK_PX world pixels,
// and the finish line sits just past p = 1. The camera follows the leader, then stops with the line
// FINISH_MARGIN px from the right edge so snails run on through it and off screen. The server keeps
// simulating until progress reaches EXIT_PROGRESS (game.go: exitProgress), which clears the edge.
const TRACK_PX = 1200;
const FINISH_WORLD = TRACK_PX + SPR_W;
const FINISH_MARGIN = 60;
const FINISH_CELL = 6; // checker square size, scaled to the snails
const CAM_MAX = FINISH_WORLD - (VIEW - FINISH_MARGIN);
const LEAD_X = VIEW * 0.55; // where the leader sits on screen while the camera follows
const TRAIL_LEN = 120;
const PODIUM_H = TOP * 2 + LANE_H * SNAIL_COUNT; // podium canvas height, whatever the race had
const PODIUM_DROP_MS = 400; // stagger between podium arrivals
const PODIUM_FALL_MS = 450;

const GLYPHS: Record<string, string[]> = {
  '0': ['111', '101', '101', '101', '111'],
  '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
  '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'],
  '7': ['111', '001', '010', '010', '010'],
  '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111'],
  G: ['111', '100', '101', '101', '111'],
  O: ['111', '101', '101', '101', '111'],
  '!': ['010', '010', '010', '000', '010'],
};

type Ctx = CanvasRenderingContext2D;

function drawGlyphs(g: Ctx, text: string, x: number, y: number, scale: number, color: string): void {
  g.fillStyle = color;
  let cx = x;
  for (const ch of text) {
    const rows = GLYPHS[ch];
    if (rows) {
      rows.forEach((row, ry) => {
        [...row].forEach((bit, rx) => {
          if (bit === '1') g.fillRect(cx + rx * scale, y + ry * scale, scale, scale);
        });
      });
    }
    cx += 4 * scale;
  }
}

function shade(hex: string, amt: number): string {
  const n = parseInt(hex.slice(1), 16);
  const mix = (c: number) => Math.round(amt >= 0 ? c + (255 - c) * amt : c * (1 + amt));
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(mix) as [number, number, number];
  return `rgb(${r},${g},${b})`;
}

const BODY = '#d8c49a';
const BODY_DARK = '#a8946a';
const EYE = '#1b1b24';

// One sprite per (lane, animation frame): creamy body, coloured shell with the lane number on it.
function buildSprite(lane: number, frame: 0 | 1): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = SPRITE_W;
  c.height = SPRITE_H;
  const g = c.getContext('2d')!;
  const color = SNAILS[lane]!.color;
  const rect = (x: number, y: number, w: number, h: number, col: string) => {
    g.fillStyle = col;
    g.fillRect(x, y, w, h);
  };

  // foot + head: the whole body stretches one pixel forward on frame 1
  rect(3, 10, 15 + frame, 2, BODY);
  rect(3, 12, 15 + frame, 1, BODY_DARK);
  const headX = 14 + frame;
  rect(headX, 6, 5, 6, BODY);
  rect(headX, 12, 5, 1, BODY_DARK);
  // eye stalks lean forward on frame 1
  for (const sx of [headX + 1, headX + 4]) {
    rect(sx, 3, 1, 3, BODY);
    rect(sx + frame, 2, 1, 1, BODY);
    rect(sx + frame, 0, 2, 2, EYE);
    rect(sx + frame, 0, 1, 1, '#ffffff');
  }

  // shell
  const dark = shade(color, -0.4);
  const light = shade(color, 0.4);
  for (let y = 0; y <= 12; y++) {
    for (let x = 0; x <= 15; x++) {
      const dx = x + 0.5 - 8.5;
      const dy = y + 0.5 - 6.5;
      const d = Math.hypot(dx, dy);
      if (d > 6) continue;
      let col: string = color;
      if (d > 4.9) col = dark;
      else if (dx < -1 && dy < -1.5 && d > 3.4) col = light;
      rect(x, y, 1, 1, col);
    }
  }
  drawGlyphs(g, String(lane + 1), 8, 5, 1, dark); // shadow
  drawGlyphs(g, String(lane + 1), 7, 4, 1, '#ffffff');
  return c;
}

export interface RaceAnim {
  frames: number[][];
  fps: number;
  startLocal: number; // Date.now() when the race (after countdown) starts
  order: number[]; // lanes, first across the line first
  labels?: string[] | null; // decision mode: the name on each lane
}

export class TrackRenderer {
  private canvas: HTMLCanvasElement;
  private g!: Ctx;
  private sprites: HTMLCanvasElement[][] = [];
  private race: RaceAnim | null = null;
  private selected: number | null = null;
  private finishedFired = false;
  private restOrder: number[] | null = null; // reconnected after the race: podium without the animation
  private doneAt = 0; // when the podium started to appear
  private lanes = SNAIL_COUNT;
  private advance: number | null = null; // decision-mode heat: how many snails move on (null = tiered podium)
  private labels: string[] | null = null; // null = lanes are just numbered (classic)
  private laneH = LANE_H;
  private H = TOP * 2 + LANE_H * SNAIL_COUNT;
  onFinish: () => void = () => {};

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.layout(SNAIL_COUNT, null);
    for (let i = 0; i < SNAILS.length; i++) this.sprites.push([buildSprite(i, 0), buildSprite(i, 1)]);
    requestAnimationFrame(this.tick);
  }

  /** Lane count and names decide the canvas height; named lanes get extra room for the label. */
  private layout(lanes: number, labels: string[] | null): void {
    this.lanes = lanes;
    this.labels = labels;
    this.laneH = labels ? LANE_H_NAMED : LANE_H;
    this.H = TOP * 2 + this.laneH * lanes;
    if (this.canvas.width !== W || this.canvas.height !== this.H) {
      this.canvas.width = W; // resizing wipes the context state
      this.canvas.height = this.H;
    }
    this.g = this.canvas.getContext('2d')!;
    this.g.imageSmoothingEnabled = false;
  }

  /** A heat that isn't the final shows one flat platform of the snails moving on, not the 1-2-3 podium. */
  setAdvance(n: number | null): void {
    this.advance = n;
  }

  setSelected(lane: number | null): void {
    this.selected = lane;
  }

  /** Put every snail back on the start line. */
  reset(lanes = SNAIL_COUNT, labels: string[] | null = null): void {
    this.race = null;
    this.restOrder = null;
    this.finishedFired = false;
    this.doneAt = 0;
    this.layout(lanes, labels);
  }

  /** Reconnected after the race: go straight to the finished podium. */
  parkPodium(order: number[], labels: string[] | null = null): void {
    this.race = null;
    this.restOrder = order;
    this.layout(order.length, labels);
  }

  startRace(r: RaceAnim): void {
    this.race = r;
    this.restOrder = null;
    this.finishedFired = false;
    this.doneAt = 0;
    this.layout(r.frames[0]!.length, r.labels ?? null);
  }

  /** True while the countdown or the race animation is still playing. */
  get running(): boolean {
    if (!this.race) return false;
    return !this.isDone(Date.now());
  }

  private isDone(now: number): boolean {
    const r = this.race!;
    return (now - r.startLocal) / 1000 * r.fps >= r.frames.length - 1;
  }

  private tick = (): void => {
    this.draw(Date.now());
    requestAnimationFrame(this.tick);
  };

  private progress(now: number): { p: number[]; moving: boolean; countdown: number | null; done: boolean } {
    const zero = new Array<number>(this.lanes).fill(0);
    const r = this.race;
    if (!r) return { p: zero, moving: false, countdown: null, done: this.restOrder !== null };
    const f = ((now - r.startLocal) / 1000) * r.fps;
    if (f < 0) return { p: zero, moving: false, countdown: Math.ceil(-f / r.fps), done: false };
    const last = r.frames.length - 1;
    if (f >= last) return { p: r.frames[last]!.map((v) => v / 1000), moving: false, countdown: null, done: true };
    const i = Math.floor(f);
    const t = f - i;
    const a = r.frames[i]!;
    const b = r.frames[i + 1]!;
    return { p: a.map((v, k) => (v + (b[k]! - v) * t) / 1000), moving: true, countdown: null, done: false };
  }

  private draw(now: number): void {
    const { lanes, laneH } = this;
    const { p, moving, countdown, done } = this.progress(now);
    // the podium scene has its own height, so an 8-lane race doesn't leave it floating in empty sky
    const H = done ? PODIUM_H : this.H;
    if (this.canvas.height !== H) {
      this.canvas.height = H;
      this.g.imageSmoothingEnabled = false;
    }
    const g = this.g;
    if (done && this.race && !this.finishedFired) {
      this.finishedFired = true;
      this.doneAt = now;
      this.onFinish();
    }
    g.clearRect(0, 0, W, H);
    if (done) {
      const order = this.race ? this.race.order : this.restOrder!;
      this.drawPodium(g, now, order, this.race ? now - this.doneAt : Infinity);
      return;
    }

    g.fillStyle = '#1d2a22';
    g.fillRect(0, 0, W, H);

    const lefts = p.map((v) => v * TRACK_PX);
    const cam = Math.min(CAM_MAX, Math.max(0, Math.max(...lefts) - LEAD_X));
    const sx = (wx: number) => Math.round(TRACK_START + wx - cam); // world x -> screen x

    for (let i = 0; i < lanes; i++) {
      g.fillStyle = i % 2 ? '#2a5e34' : '#2f6b3a';
      g.fillRect(TRACK_START - 4, TOP + i * laneH, W - TRACK_START + 4, laneH);
    }

    // everything in the world is clipped to the track area so it slides under the lane chips
    g.save();
    g.beginPath();
    g.rect(TRACK_START - 4, 0, W - TRACK_START + 4, H);
    g.clip();
    for (let i = 0; i < lanes; i++) {
      const y = TOP + i * laneH;
      // grass tufts, fixed in the world so they stream past as the camera moves
      g.fillStyle = i % 2 ? '#357a42' : '#3a8548';
      for (let wx = 20 + ((i * 11) % 13); wx < FINISH_WORLD + VIEW; wx += 23) {
        const x = sx(wx);
        if (x > TRACK_START - 6 && x < W) g.fillRect(x, y + 5 + ((wx + i) % 3) * 11, 3, 2);
      }
      if (this.selected === i) {
        g.fillStyle = 'rgba(255,255,255,0.12)';
        g.fillRect(TRACK_START - 4, y, W - TRACK_START + 4, laneH);
      }
    }
    // start line
    g.fillStyle = '#f5f5f5';
    for (let y = TOP; y < H - TOP; y += 6) g.fillRect(sx(0), y, 1, 3);
    // finish line (checkered)
    const fx = sx(FINISH_WORLD);
    for (let y = TOP; y < H - TOP; y += FINISH_CELL) {
      for (let k = 0; k < 3; k++) {
        g.fillStyle = (Math.floor((y - TOP) / FINISH_CELL) + k) % 2 ? '#111' : '#f5f5f5';
        g.fillRect(fx + k * FINISH_CELL, y, FINISH_CELL, Math.min(FINISH_CELL, H - TOP - y));
      }
    }

    // snails (trails first so every sprite sits on top of every trail)
    for (let i = 0; i < lanes; i++) {
      const groundY = TOP + i * laneH + (laneH - SPR_H) / 2 + 24;
      this.drawTrail(g, SNAILS[i]!.color, sx(lefts[i]!) + 6, groundY, sx(0));
    }
    for (let i = 0; i < lanes; i++) {
      const spriteY = TOP + i * laneH + (laneH - SPR_H) / 2;
      const rate = moving ? 5 : 1.6;
      const frame = (Math.floor((now / 1000) * rate + i) % 2) as 0 | 1;
      const bob = moving && frame === 1 ? -1 : 0;
      g.drawImage(this.sprites[i]![frame]!, sx(lefts[i]!), spriteY + bob, SPR_W, SPR_H);
    }
    if (this.labels) {
      for (let i = 0; i < lanes; i++) this.drawName(g, this.labels[i]!, sx(lefts[i]!) + 2, TOP + i * laneH + 2, 16, 'left');
    }
    g.restore();

    // lane chips stay put on the left
    g.fillStyle = '#1d2a22';
    g.fillRect(0, 0, TRACK_START - 4, H);
    for (let i = 0; i < lanes; i++) {
      const y = TOP + i * laneH + (laneH - 26) / 2;
      const color = SNAILS[i]!.color;
      g.fillStyle = color;
      g.fillRect(3, y, 14, 12);
      g.fillStyle = shade(color, -0.45);
      g.fillRect(3, y + 10, 14, 2);
      drawGlyphs(g, String(i + 1), 8, y + 3, 1, '#fff');
      if (this.selected === i) {
        g.fillStyle = '#fff';
        g.fillRect(0, y + 4, 1, 4);
        g.fillRect(1, y + 3, 1, 6);
        g.fillRect(2, y + 2, 1, 8);
      }
    }

    if (countdown !== null) {
      g.fillStyle = 'rgba(0,0,0,0.45)';
      g.fillRect(0, H / 2 - 20, W, 40);
      drawGlyphs(g, String(countdown), W / 2 - 5, H / 2 - 12, 4, '#fff');
    } else if (this.race && moving && (now - this.race.startLocal) < 700) {
      g.fillStyle = 'rgba(0,0,0,0.45)';
      g.fillRect(0, H / 2 - 20, W, 40);
      drawGlyphs(g, 'GO!', W / 2 - 23, H / 2 - 12, 4, '#c4b5fd');
    }
  }

  /** Canvas text in the pixel style: dark drop shadow, truncated with an ellipsis. */
  private drawName(g: Ctx, text: string, x: number, y: number, maxChars: number, align: CanvasTextAlign, color = '#fff', shadow = '#000'): void {
    const chars = [...text];
    const t = chars.length > maxChars ? chars.slice(0, maxChars - 1).join('') + '…' : text;
    g.font = '8px ui-monospace, Consolas, monospace';
    g.textBaseline = 'top';
    g.textAlign = align;
    g.fillStyle = shadow;
    g.fillText(t, x + 1, y + 1);
    g.fillStyle = color;
    g.fillText(t, x, y);
  }

  /** 2nd - 1st - 3rd blocks centred; everyone else lines up on the floor beside them. */
  private drawPodium(g: Ctx, now: number, order: number[], sinceDone: number): void {
    if (this.advance !== null) {
      this.drawAdvancing(g, now, order, sinceDone, this.advance);
      return;
    }
    const H = PODIUM_H;
    const floor = H - 28;
    g.fillStyle = '#1d2a22';
    g.fillRect(0, 0, W, H);
    g.fillStyle = '#2f6b3a';
    g.fillRect(0, floor, W, H - floor);
    g.fillStyle = '#3a8548';
    g.fillRect(0, floor, W, 3);

    const bw = 80;
    const x1 = Math.round(W / 2 - bw / 2);
    // [index into order, block x, block height, block colour, digit]
    const blocks: [number, number, number, string, string][] = [
      [1, x1 - bw, 80, '#b8bcc6', '2'],
      [0, x1, 110, '#e0b630', '1'],
      [2, x1 + bw, 56, '#b07a45', '3'],
    ];
    for (const [place, bx, bh, col, digit] of blocks) {
      const lane = order[place];
      if (lane === undefined) continue;
      const top = floor - bh;
      g.fillStyle = col;
      g.fillRect(bx, top, bw, bh);
      g.fillStyle = shade(col, 0.35);
      g.fillRect(bx, top, bw, 3);
      g.fillStyle = shade(col, -0.35);
      g.fillRect(bx + bw - 4, top, 4, bh);
      drawGlyphs(g, digit, bx + bw / 2 - 6, top + 10, 4, shade(col, -0.55));
      if (this.labels) this.drawName(g, this.labels[lane]!, bx + bw / 2, top + 36, 13, 'center', '#1a1a1a', shade(col, 0.4));

      // third drops in first, the winner last
      const delay = (2 - place) * PODIUM_DROP_MS;
      const t = Math.min(1, Math.max(0, (sinceDone - delay) / PODIUM_FALL_MS));
      if (t <= 0) continue;
      const rest = top - SPR_H;
      const y = rest - (1 - t) * (1 - t) * 160;
      const frame = (Math.floor(now / 400 + lane) % 2) as 0 | 1;
      g.drawImage(this.sprites[lane]![frame]!, bx + (bw - SPR_W) / 2, y, SPR_W, SPR_H);
      if (place === 0 && t >= 1) this.drawCrown(g, bx + bw / 2 - 3, rest - 4 + (Math.floor(now / 250) % 2));
    }

    // 4th onwards, small, on the floor: three to the right of the podium, then three to the left
    order.slice(3).forEach((lane, k) => {
      const x = k < 3 ? x1 + bw * 2 + 6 + k * 25 : 4 + (k - 3) * 25;
      g.drawImage(this.sprites[lane]![0]!, x, floor - SPRITE_H + 2);
      drawGlyphs(g, String(k + 4), x + 7, floor + 8, 2, '#8fa596');
    });
  }

  /** One level, no placings: everyone moving on stands on the same platform; the rest wait on the floor. */
  private drawAdvancing(g: Ctx, now: number, order: number[], sinceDone: number, advance: number): void {
    const H = PODIUM_H;
    const floor = H - 28;
    g.fillStyle = '#1d2a22';
    g.fillRect(0, 0, W, H);
    g.fillStyle = '#2f6b3a';
    g.fillRect(0, floor, W, H - floor);
    g.fillStyle = '#3a8548';
    g.fillRect(0, floor, W, 3);

    const slot = 90;
    const bh = 70;
    const col = '#8b7bd8';
    const left = Math.round((W - slot * advance) / 2);
    const top = floor - bh;
    g.fillStyle = col;
    g.fillRect(left, top, slot * advance, bh);
    g.fillStyle = shade(col, 0.35);
    g.fillRect(left, top, slot * advance, 3);
    g.fillStyle = shade(col, -0.35);
    g.fillRect(left + slot * advance - 4, top, 4, bh);
    this.drawName(g, 'MOVING ON', W / 2, top + 12, 12, 'center', '#fff', shade(col, -0.55));

    order.slice(0, advance).forEach((lane, k) => {
      const x = left + k * slot;
      if (k > 0) {
        g.fillStyle = shade(col, -0.2);
        g.fillRect(x, top + 3, 1, bh - 3);
      }
      if (this.labels) this.drawName(g, this.labels[lane]!, x + slot / 2, top + 40, 14, 'center', '#fff', shade(col, -0.55));
      // arrivals drop in from the back of the line to the front
      const delay = (advance - 1 - k) * PODIUM_DROP_MS;
      const t = Math.min(1, Math.max(0, (sinceDone - delay) / PODIUM_FALL_MS));
      if (t <= 0) return;
      const rest = top - SPR_H;
      const y = rest - (1 - t) * (1 - t) * 160;
      const frame = (Math.floor(now / 400 + lane) % 2) as 0 | 1;
      g.drawImage(this.sprites[lane]![frame]!, x + (slot - SPR_W) / 2, y, SPR_W, SPR_H);
    });

    // knocked out: small, on the floor
    order.slice(advance).forEach((lane, k) => {
      g.drawImage(this.sprites[lane]![0]!, 8 + k * 27, floor - SPRITE_H + 2);
    });
  }

  // Slime trail: solid next to the snail, fading with distance, never drawn behind the start line.
  private drawTrail(g: Ctx, color: string, tailX: number, y: number, startX: number): void {
    g.fillStyle = shade(color, 0.3);
    const from = Math.max(startX - 2, tailX - TRAIL_LEN);
    for (let x = from; x < tailX; x++) {
      const a = 1 - (tailX - x) / TRAIL_LEN;
      if (a < 0.45 && x % 2) continue; // thin out with distance
      g.globalAlpha = a > 0.75 ? 0.95 : a > 0.5 ? 0.7 : a > 0.28 ? 0.45 : 0.22;
      g.fillRect(x, y, 1, 3);
      if (x % 7 === 0) g.fillRect(x, y - 1, 1, 1);
    }
    g.globalAlpha = 1;
  }

  private drawCrown(g: Ctx, x: number, y: number): void {
    g.fillStyle = '#ffd23f';
    g.fillRect(x, y + 1, 7, 2);
    g.fillRect(x, y, 1, 1);
    g.fillRect(x + 3, y - 1, 1, 2);
    g.fillRect(x + 6, y, 1, 1);
    g.fillStyle = '#c8921a';
    g.fillRect(x, y + 2, 7, 1);
  }
}
