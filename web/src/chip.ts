// A tiny 8-bit synthesizer: pulse, triangle and noise voices rendered into plain sample arrays.
// Everything here is a pure function (no Web Audio), so the same code plays in the browser and
// renders WAV files in Node (see tools/check-tracks.ts).

export const SAMPLE_RATE = 32000;

export type ChordQuality = 'maj' | 'min' | 'dom' | 'dim' | 'sus';
export type BassStyle = 'drive' | 'bounce' | 'walk' | 'pump';
export type ArpStyle = 'up' | 'updown' | 'broken' | 'none';

export interface Chord {
  root: string; // pitch class only: C, F#, Bb ...
  q: ChordQuality;
}

export interface Track {
  id: string;
  name: string;
  blurb: string;
  /** Where it plays: the final's own tune, or the lobby. Left out, it joins the race rotation. */
  use?: 'final' | 'lobby';
  bpm: number;
  chords: Chord[]; // one per bar; the track is this many bars long
  /** Melody in mini-notation: "E5/2 G5/2 r/4 ..." = note/length in sixteenth-note steps, r = rest. */
  lead: string;
  leadDuty: number; // pulse width of the lead voice
  arpDuty: number;
  bass: BassStyle;
  arp: ArpStyle;
  /** Sixteen characters per bar: k kick, s snare, h hat, o open hat, K kick+hat, S snare+hat, . nothing. */
  drums: { main: string; alt: string; fill: string };
}

export const STEPS_PER_BAR = 16;

// ---- notes -------------------------------------------------------------------------------

const SEMITONE: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

export function noteToMidi(name: string): number {
  const m = /^([A-G])([#b]?)(-?\d)?$/.exec(name);
  if (!m) throw new Error(`bad note "${name}"`);
  const octave = m[3] === undefined ? 4 : Number(m[3]);
  const accidental = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0;
  return 12 * (octave + 1) + SEMITONE[m[1]!]! + accidental;
}

export const midiToFreq = (midi: number): number => 440 * 2 ** ((midi - 69) / 12);

export interface NoteEv {
  at: number; // step the note starts on
  len: number; // length in steps
  midi: number;
}

export function parseMelody(src: string): { notes: NoteEv[]; steps: number } {
  const notes: NoteEv[] = [];
  let at = 0;
  for (const token of src.trim().split(/\s+/)) {
    const [name, length] = token.split('/');
    const len = Number(length);
    if (!name || !Number.isInteger(len) || len < 1) throw new Error(`bad token "${token}"`);
    if (name !== 'r') notes.push({ at, len, midi: noteToMidi(name) });
    at += len;
  }
  return { notes, steps: at };
}

// ---- accompaniment, generated from the chords ---------------------------------------------

const INTERVALS: Record<ChordQuality, number[]> = {
  maj: [0, 4, 7, 12],
  min: [0, 3, 7, 12],
  dom: [0, 4, 7, 10],
  dim: [0, 3, 6, 12],
  sus: [0, 5, 7, 12],
};

const pitchClass = (root: string): number => noteToMidi(`${root}4`) - 60;

function bassBar(ch: Chord, style: BassStyle): NoteEv[] {
  const root = 36 + pitchClass(ch.root); // octave 2
  const iv = INTERVALS[ch.q];
  const third = root + iv[1]!;
  const fifth = root + iv[2]!;
  switch (style) {
    case 'drive': {
      const pitches = [root, root, root + 12, root, root, root, root + 12, fifth];
      return pitches.map((midi, i) => ({ at: i * 2, len: 2, midi }));
    }
    case 'bounce':
      return [
        { at: 0, len: 3, midi: root },
        { at: 4, len: 3, midi: fifth },
        { at: 8, len: 3, midi: root },
        { at: 12, len: 2, midi: third },
        { at: 14, len: 2, midi: fifth },
      ];
    case 'walk':
      return [
        { at: 0, len: 3, midi: root },
        { at: 4, len: 3, midi: third },
        { at: 8, len: 3, midi: fifth },
        { at: 12, len: 3, midi: third },
      ];
    case 'pump':
      return Array.from({ length: STEPS_PER_BAR }, (_, at) => ({ at, len: 1, midi: at % 4 === 3 ? root + 12 : root }));
  }
}

function arpBar(ch: Chord, style: ArpStyle): NoteEv[] {
  if (style === 'none') return [];
  const root = 60 + pitchClass(ch.root); // octave 4
  const tones = INTERVALS[ch.q].map((i) => root + i);
  const order = style === 'up' ? [0, 1, 2, 3] : style === 'updown' ? [0, 1, 2, 3, 2, 1] : [0, 2, 1, 3, 0, 2, 1, 3];
  const len = style === 'broken' ? 2 : 1;
  return Array.from({ length: STEPS_PER_BAR / len }, (_, i) => ({ at: i * len, len, midi: tones[order[i % order.length]!]! }));
}

// ---- voices ---------------------------------------------------------------------------------

/** Deterministic noise (xorshift32), so a track renders identically every time. */
function noiseSource(seed: number): () => number {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return (x / 4294967296) * 2 - 1;
  };
}

type Shape = 'lead' | 'pluck' | 'hold';

function envelope(shape: Shape, t: number, dur: number): number {
  const attack = Math.min(1, t / 0.003);
  const release = Math.min(1, Math.max(0, (dur - t) / 0.004)); // a few ms of fade so notes never click
  let body: number;
  if (shape === 'pluck') body = 0.25 + 0.75 * Math.exp(-t * 16);
  else if (shape === 'lead') body = 1 - 0.3 * Math.min(1, t / dur);
  else body = 1 - 0.15 * Math.min(1, t / dur);
  const amp = Math.min(attack, release) * body;
  return Math.round(amp * 15) / 15; // 4-bit volume steps, like the old chips
}

function addTone(out: Float32Array, start: number, len: number, freq: number, wave: 'pulse' | 'tri', duty: number, gain: number, shape: Shape, vibrato = false): void {
  const end = Math.min(out.length, start + len);
  const dur = len / SAMPLE_RATE;
  let phase = 0;
  // centre the wave on zero (a narrow pulse otherwise carries a DC offset) and keep its peak at 1
  const pulseNorm = Math.max(2 - 2 * duty, 2 * duty) || 1;
  for (let i = start; i < end; i++) {
    const t = (i - start) / SAMPLE_RATE;
    const f = vibrato && t > 0.15 ? freq * (1 + 0.004 * Math.sin(2 * Math.PI * 6 * t)) : freq;
    phase += f / SAMPLE_RATE;
    if (phase >= 1) phase -= 1;
    const v = wave === 'pulse' ? ((phase < duty ? 1 : -1) - (2 * duty - 1)) / pulseNorm : 4 * Math.abs(phase - 0.5) - 1;
    out[i] = out[i]! + v * gain * envelope(shape, t, dur);
  }
}

function addKick(out: Float32Array, start: number): void {
  let phase = 0;
  const len = Math.floor(SAMPLE_RATE * 0.11);
  for (let i = 0; i < len && start + i < out.length; i++) {
    const t = i / SAMPLE_RATE;
    phase += (45 + 120 * Math.exp(-t * 30)) / SAMPLE_RATE;
    out[start + i] = out[start + i]! + Math.sin(2 * Math.PI * phase) * 0.85 * Math.exp(-t * 22);
  }
}

function addSnare(out: Float32Array, start: number, noise: () => number): void {
  const len = Math.floor(SAMPLE_RATE * 0.13);
  let phase = 0;
  for (let i = 0; i < len && start + i < out.length; i++) {
    const t = i / SAMPLE_RATE;
    phase += 190 / SAMPLE_RATE;
    if (phase >= 1) phase -= 1;
    const tone = 4 * Math.abs(phase - 0.5) - 1;
    out[start + i] = out[start + i]! + noise() * 0.55 * Math.exp(-t * 28) + tone * 0.3 * Math.exp(-t * 35);
  }
}

function addHat(out: Float32Array, start: number, noise: () => number, open: boolean): void {
  const len = Math.floor(SAMPLE_RATE * (open ? 0.16 : 0.035));
  let prev = 0;
  for (let i = 0; i < len && start + i < out.length; i++) {
    const t = i / SAMPLE_RATE;
    const n = noise();
    out[start + i] = out[start + i]! + (n - prev) * 0.28 * Math.exp(-t * (open ? 22 : 120)); // differencing keeps only the highs
    prev = n;
  }
}

function addDrum(out: Float32Array, start: number, code: string, noise: () => number): void {
  if (code === 'k' || code === 'K') addKick(out, start);
  if (code === 's' || code === 'S') addSnare(out, start, noise);
  if (code === 'h' || code === 'K' || code === 'S') addHat(out, start, noise, false);
  if (code === 'o') addHat(out, start, noise, true);
}

// ---- tracks ---------------------------------------------------------------------------------

export function trackBars(track: Track): number {
  return track.chords.length;
}

export function trackSeconds(track: Track): number {
  return (trackBars(track) * STEPS_PER_BAR * 60) / track.bpm / 4;
}

/** Renders one full loop. The length is a whole number of steps, so it loops without a seam. */
export function renderTrack(track: Track): Float32Array {
  const bars = trackBars(track);
  const stepSamples = Math.round((SAMPLE_RATE * 60) / track.bpm / 4);
  const out = new Float32Array(bars * STEPS_PER_BAR * stepSamples);
  const noise = noiseSource(0x5eed);

  const lead = parseMelody(track.lead);
  if (lead.steps !== bars * STEPS_PER_BAR) throw new Error(`${track.id}: the melody is ${lead.steps} steps, expected ${bars * STEPS_PER_BAR}`);
  for (const n of lead.notes) addTone(out, n.at * stepSamples, n.len * stepSamples, midiToFreq(n.midi), 'pulse', track.leadDuty, 0.24, 'lead', n.len >= 4);

  track.chords.forEach((chord, bar) => {
    const base = bar * STEPS_PER_BAR;
    for (const n of bassBar(chord, track.bass)) addTone(out, (base + n.at) * stepSamples, n.len * stepSamples, midiToFreq(n.midi), 'tri', 0, 0.32, 'hold');
    for (const n of arpBar(chord, track.arp)) addTone(out, (base + n.at) * stepSamples, n.len * stepSamples, midiToFreq(n.midi), 'pulse', track.arpDuty, 0.1, 'pluck');
    const pattern = bar % 8 === 7 ? track.drums.fill : bar % 2 === 1 ? track.drums.alt : track.drums.main;
    if (pattern.length !== STEPS_PER_BAR) throw new Error(`${track.id}: a drum pattern must be ${STEPS_PER_BAR} characters`);
    [...pattern].forEach((code, step) => addDrum(out, (base + step) * stepSamples, code, noise));
  });

  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  const scale = peak > 0 ? 0.9 / peak : 1; // every track ends up equally loud
  for (let i = 0; i < out.length; i++) out[i] = out[i]! * scale;
  return out;
}

// ---- sound effects ----------------------------------------------------------------------------

export const SFX_NAMES = ['beep', 'go', 'fanfare', 'whoosh', 'hiss', 'thud', 'bite', 'clink', 'coin'] as const;
export type SfxName = (typeof SFX_NAMES)[number];

const secs = (s: number): number => Math.round(s * SAMPLE_RATE);

/** Every effect is capped at half scale, so none of them jumps out over the soundtrack. */
export function renderSfx(name: SfxName): Float32Array {
  const out = synthSfx(name);
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  if (peak > 0.5) for (let i = 0; i < out.length; i++) out[i] = out[i]! * (0.5 / peak);
  return out;
}

function synthSfx(name: SfxName): Float32Array {
  const noise = noiseSource(0xbeef);
  const sine = (f: number, t: number): number => Math.sin(2 * Math.PI * f * t);
  const make = (seconds: number, fn: (t: number, i: number) => number): Float32Array => {
    const out = new Float32Array(secs(seconds));
    for (let i = 0; i < out.length; i++) out[i] = fn(i / SAMPLE_RATE, i);
    return out;
  };
  switch (name) {
    case 'beep': {
      const out = new Float32Array(secs(0.16));
      addTone(out, 0, out.length, 660, 'pulse', 0.5, 0.45, 'lead');
      return out;
    }
    case 'go': {
      const out = new Float32Array(secs(0.55));
      addTone(out, 0, secs(0.1), 880, 'pulse', 0.5, 0.4, 'lead');
      addTone(out, secs(0.1), secs(0.45), 1320, 'pulse', 0.5, 0.45, 'lead');
      return out;
    }
    case 'fanfare': {
      const out = new Float32Array(secs(1.7));
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => addTone(out, secs(i * 0.11), secs(0.11), f, 'pulse', 0.5, 0.4, 'lead'));
      addTone(out, secs(0.44), secs(1.1), 1046.5, 'pulse', 0.5, 0.3, 'lead', true);
      addTone(out, secs(0.44), secs(1.1), 1318.5, 'pulse', 0.25, 0.22, 'lead');
      addTone(out, secs(0.44), secs(1.1), 261.63, 'tri', 0, 0.4, 'hold');
      return out;
    }
    case 'whoosh': {
      let phase = 0;
      return make(0.28, (t) => {
        phase += (1400 * Math.exp(-t * 6) + 200) / SAMPLE_RATE;
        if (phase >= 1) phase -= 1;
        return ((phase < 0.5 ? 1 : -1) * 0.12 + noise() * 0.3) * Math.exp(-t * 8) * Math.min(1, t / 0.01);
      });
    }
    case 'hiss': {
      let prev = 0;
      return make(0.4, (t) => {
        const n = noise();
        const v = (n - prev) * 0.5 * Math.exp(-t * 7) * Math.min(1, t / 0.01);
        prev = n;
        return v;
      });
    }
    case 'thud': {
      let phase = 0;
      return make(0.16, (t) => {
        phase += (55 + 85 * Math.exp(-t * 25)) / SAMPLE_RATE;
        return Math.sin(2 * Math.PI * phase) * 0.65 * Math.exp(-t * 18) + (t < 0.005 ? noise() * 0.2 : 0);
      });
    }
    case 'bite': {
      // A cartoon chomp, shaped after a measured reference: bright crunchy chewing first (band-passed
      // noise plus a band around 1.2 kHz, its level wobbling every ~40 ms), then it darkens into a
      // low "doomp" whose pitch falls from ~350 Hz to ~110 Hz as the jaw shuts.
      let held = 0;
      let lp1 = 0; // noise low-passed at ~2.5 kHz ...
      let lp2 = 0; // ... minus the part under ~200 Hz leaves a band of crunch
      let bandPhase = 0;
      let thumpPhase = 0;
      return make(0.2, (t, i) => {
        if (i % 2 === 0) held = noise();
        lp1 += 0.39 * (held - lp1);
        lp2 += 0.04 * (lp1 - lp2);
        bandPhase += 1250 / SAMPLE_RATE;
        if (bandPhase >= 1) bandPhase -= 1;
        const chew = Math.min(1, t / 0.008) * (0.75 + 0.25 * Math.cos(2 * Math.PI * 25 * t)) * Math.exp(-Math.max(0, t - 0.07) * 32);
        const crunch = ((lp1 - lp2) * 0.75 + (4 * Math.abs(bandPhase - 0.5) - 1) * 0.14) * chew;
        const u = t - 0.05; // the thump starts as the crunch fades
        let thump = 0;
        if (u > 0) {
          thumpPhase += (110 + 240 * Math.exp(-u * 28)) / SAMPLE_RATE;
          if (thumpPhase >= 1) thumpPhase -= 1;
          const body = (4 * Math.abs(thumpPhase - 0.5) - 1) * 0.28 + (thumpPhase < 0.5 ? 1 : -1) * 0.12;
          thump = body * Math.min(1, u / 0.005) * Math.exp(-u * 14);
        }
        return crunch + thump;
      });
    }
    case 'clink':
      return make(0.3, (t) => sine(2600, t) * 0.4 * Math.exp(-t * 20) + sine(3900, t) * 0.25 * Math.exp(-t * 28));
    case 'coin': {
      const out = new Float32Array(secs(0.4));
      addTone(out, 0, secs(0.06), 987.77, 'pulse', 0.5, 0.35, 'lead');
      addTone(out, secs(0.06), secs(0.34), 1318.5, 'pulse', 0.5, 0.35, 'pluck');
      return out;
    }
  }
}
