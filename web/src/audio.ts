// Web Audio glue for the chiptune engine in chip.ts: loads/caches rendered buffers, plays the race
// soundtrack and the sound effects, and remembers each player's sound settings.
//
// Signal path:  music / effects  ->  musicBus / sfxBus (their own volume)  ->  master  ->  speakers
// A race gets its own gates in front of the two buses so everything scheduled for it can be cut off at once.

import { renderSfx, renderTrack, SAMPLE_RATE, type SfxName } from './chip';
import type { RaceEvent } from './protocol';
import { TRACKS, trackById } from './tracks';

export interface AudioSettings {
  music: boolean; // play the soundtrack
  sfx: boolean; // play sound effects
  volume: number; // overall, 0..1
  musicVolume: number; // soundtrack level, 0..1
  sfxVolume: number; // sound effects level, 0..1
}

const KEY = 'snail-audio';
const DEFAULTS: AudioSettings = { music: true, sfx: true, volume: 0.8, musicVolume: 0.35, sfxVolume: 0.65 };
const FLIGHT = 0.45; // seconds a thrown attack is in the air; matches the renderer
const BITES = 7; // leaf chunks; matches the renderer

const unit = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback);

function load(): AudioSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw) as Partial<AudioSettings>;
      return {
        music: s.music ?? DEFAULTS.music,
        sfx: s.sfx ?? DEFAULTS.sfx,
        volume: unit(s.volume, DEFAULTS.volume),
        musicVolume: unit(s.musicVolume, DEFAULTS.musicVolume),
        sfxVolume: unit(s.sfxVolume, DEFAULTS.sfxVolume),
      };
    }
  } catch {
    /* private mode: settings just won't persist */
  }
  return { ...DEFAULTS };
}

interface RaceSession {
  music: GainNode; // gate for the soundtrack (1, or 0 while music is switched off)
  sfx: GainNode; // gate for the countdown and attack sounds
  tune: AudioBufferSourceNode | null; // the looping soundtrack, stopped when the race ends
}

const rotation0 = (): string => TRACKS.find((t) => !t.use)!.id;

class Engine {
  settings: AudioSettings = load();
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private buffers = new Map<string, AudioBuffer>();
  private race: RaceSession | null = null;
  private lobby: { src: AudioBufferSourceNode; gain: GainNode } | null = null;
  private wokenAt = -1e9;
  private listeners: (() => void)[] = [];

  /** Browsers only allow sound after a click or key press; call this from one (it is cheap to repeat). */
  unlock(): AudioContext | null {
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      try {
        this.ctx = new Ctor();
      } catch {
        return null;
      }
      this.master = this.ctx.createGain();
      this.musicBus = this.ctx.createGain();
      this.sfxBus = this.ctx.createGain();
      this.musicBus.connect(this.master);
      this.sfxBus.connect(this.master);
      this.master.gain.value = this.settings.volume;
      this.musicBus.gain.value = this.settings.musicVolume;
      this.sfxBus.gain.value = this.settings.sfxVolume;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') {
      this.wokenAt = performance.now();
      void this.ctx.resume();
    }
    return this.ctx;
  }

  /** True if the tap or key press being handled right now is what just woke the audio up. */
  justWoke(): boolean {
    return performance.now() - this.wokenAt < 500;
  }

  subscribe(fn: () => void): void {
    this.listeners.push(fn);
  }

  private changed(): void {
    for (const fn of this.listeners) fn();
  }

  private applyLevels(): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.musicBus || !this.sfxBus) return;
    const now = ctx.currentTime;
    this.master.gain.setTargetAtTime(this.settings.volume, now, 0.02);
    this.musicBus.gain.setTargetAtTime(this.settings.musicVolume, now, 0.02);
    this.sfxBus.gain.setTargetAtTime(this.settings.sfxVolume, now, 0.02);
    this.race?.music.gain.setTargetAtTime(this.settings.music ? 1 : 0, now, 0.05);
    this.lobby?.gain.gain.setTargetAtTime(this.settings.music ? 1 : 0, now, 0.05);
  }

  set(patch: Partial<AudioSettings>): void {
    this.settings = { ...this.settings, ...patch };
    try {
      localStorage.setItem(KEY, JSON.stringify(this.settings));
    } catch {
      /* ignore */
    }
    this.applyLevels();
    this.changed();
  }

  private buffer(key: string, make: () => Float32Array): AudioBuffer | null {
    const ctx = this.ctx;
    if (!ctx) return null;
    let buf = this.buffers.get(key);
    if (!buf) {
      const data = make();
      buf = ctx.createBuffer(1, data.length, SAMPLE_RATE);
      buf.getChannelData(0).set(data);
      this.buffers.set(key, buf);
    }
    return buf;
  }

  /** Play a sound effect now, or `delay` seconds from now. `force` plays it even with effects switched off (the test buttons). */
  sfx(name: SfxName, delay = 0, gate?: AudioNode, rate = 1, force = false): void {
    if (!force && !this.settings.sfx) return;
    const ctx = this.unlock();
    if (!ctx || !this.sfxBus) return;
    if (ctx.state !== 'running') return; // a blocked context would hold every sound and fire them all at once when it wakes
    const buf = this.buffer(`sfx:${name}`, () => renderSfx(name));
    if (!buf) return;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    src.connect(gate ?? this.sfxBus);
    src.start(ctx.currentTime + Math.max(0, delay));
  }

  /** Which track a race gets: the final has its own tune, and the rest rotate. */
  pick(final: boolean, round: number): string {
    if (final) return TRACKS.find((t) => t.use === 'final')?.id ?? rotation0();
    const rotation = TRACKS.filter((t) => !t.use);
    return rotation[Math.abs(round) % rotation.length]!.id;
  }

  /** The waiting-room tune: on the home screen and in the lobby, stopped when a game gets going (call it as the screen changes). */
  setLobby(on: boolean): void {
    if (on) this.startLobby();
    else this.stopLobby();
  }

  private startLobby(): void {
    if (this.lobby || this.race) return;
    const track = TRACKS.find((t) => t.use === 'lobby');
    const ctx = this.unlock();
    if (!track || !ctx || !this.musicBus) return;
    const buf = this.buffer(`track:${track.id}`, () => renderTrack(track));
    if (!buf) return;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.gain.setTargetAtTime(this.settings.music ? 1 : 0, ctx.currentTime, 0.4); // fade in
    gain.connect(this.musicBus);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.connect(gain);
    src.start();
    this.lobby = { src, gain };
  }

  private stopLobby(): void {
    const l = this.lobby;
    this.lobby = null;
    if (!l || !this.ctx) return;
    l.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.15);
    setTimeout(() => {
      try {
        l.src.stop();
      } catch {
        /* already stopped */
      }
      l.gain.disconnect();
    }, 900);
  }

  /** Countdown beeps, the soundtrack from GO, and a sound for every attack, all lined up with the race clock. */
  startRace(o: { startLocal: number; fps: number; events: RaceEvent[]; track: string }): void {
    this.stopRace();
    this.stopLobby();
    const ctx = this.unlock();
    if (!ctx || !this.musicBus || !this.sfxBus) return;
    const music = ctx.createGain();
    music.gain.value = this.settings.music ? 1 : 0;
    music.connect(this.musicBus);
    const sfx = ctx.createGain();
    sfx.connect(this.sfxBus);
    const session: RaceSession = { music, sfx, tune: null };
    this.race = session;
    const lead = (o.startLocal - Date.now()) / 1000; // seconds until GO (negative if we joined late)

    for (const k of [3, 2, 1]) if (lead - k > -0.05) this.sfx('beep', lead - k, sfx);
    if (lead > -0.05) this.sfx('go', lead, sfx);

    const track = trackById(o.track);
    const buf = track ? this.buffer(`track:${track.id}`, () => renderTrack(track)) : null;
    if (buf) {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.connect(music); // always running, so switching music on mid-race brings it in
      src.start(ctx.currentTime + Math.max(0, lead), lead < 0 ? -lead % buf.duration : 0);
      session.tune = src;
    }

    for (const e of o.events) {
      const t = lead + e.t / o.fps;
      if (t < -0.05) continue;
      this.sfx('whoosh', t, sfx);
      const land = t + FLIGHT;
      if (e.blocked) {
        this.sfx('clink', land, sfx);
      } else if (e.kind === 'salt') {
        this.sfx('hiss', land, sfx);
      } else {
        this.sfx('thud', land, sfx);
        const eat = Math.max(0.1, e.dur / o.fps);
        for (let k = 1; k <= BITES; k++) this.sfx('bite', land + (k / BITES) * eat, sfx, 0.85 + Math.random() * 0.3);
      }
    }
  }

  private cut(r: RaceSession, timeConstant: number, disconnectAfterMs: number): void {
    const now = this.ctx!.currentTime;
    r.music.gain.cancelScheduledValues(now);
    r.music.gain.setTargetAtTime(0, now, timeConstant);
    r.sfx.gain.setTargetAtTime(0, now, timeConstant);
    try {
      r.tune?.stop(now + disconnectAfterMs / 1000);
    } catch {
      /* never started */
    }
    setTimeout(() => {
      r.music.disconnect();
      r.sfx.disconnect();
    }, disconnectAfterMs);
  }

  /** Cut the race audio, including everything still scheduled. */
  stopRace(): void {
    const r = this.race;
    this.race = null;
    if (r && this.ctx) this.cut(r, 0.04, 400);
  }

  /** The race animation is over: fade the music and play the finish fanfare. */
  finish(): void {
    const r = this.race;
    this.race = null;
    if (!r || !this.ctx) return;
    this.cut(r, 0.2, 1500);
    this.sfx('fanfare', 0.25);
  }
}

export const audio = new Engine();
