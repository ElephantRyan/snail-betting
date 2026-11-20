// Renders every track and sound effect to WAV files and sanity-checks them (nobody can hear it
// from here, so this checks structure, loudness and loop seams, not taste):
//
//   node tools/check-tracks.ts <output folder>
//
// Open the WAVs in any player to audition the music without starting the game.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseMelody, renderSfx, renderTrack, SAMPLE_RATE, SFX_NAMES, STEPS_PER_BAR, trackBars, trackSeconds } from '../src/chip.ts';
import { TRACKS } from '../src/tracks.ts';

function wav(samples: Float32Array): Buffer {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((v, i) => data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), i * 2));
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVEfmt ', 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20); // PCM
  head.writeUInt16LE(1, 22); // mono
  head.writeUInt32LE(SAMPLE_RATE, 24);
  head.writeUInt32LE(SAMPLE_RATE * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36);
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

function stats(x: Float32Array) {
  let peak = 0;
  let sum = 0;
  let sq = 0;
  let clipped = 0;
  let quiet = 0;
  for (const v of x) {
    const a = Math.abs(v);
    peak = Math.max(peak, a);
    sum += v;
    sq += v * v;
    if (a >= 0.999) clipped++;
    if (a < 0.002) quiet++;
  }
  return { peak, rms: Math.sqrt(sq / x.length), dc: sum / x.length, clipped, quiet: quiet / x.length };
}

const out = process.argv[2];
if (!out) {
  console.error('usage: node tools/check-tracks.ts <output folder>');
  process.exit(2);
}
mkdirSync(out, { recursive: true });

let failures = 0;
const check = (ok: boolean, what: string) => {
  if (!ok) {
    failures++;
    console.log(`  FAIL: ${what}`);
  }
};

console.log(`${'track'.padEnd(16)} bars  seconds  notes  peak   rms   dc     silent  seam`);
for (const t of TRACKS) {
  const bars = trackBars(t);
  const lead = parseMelody(t.lead);
  check(lead.steps === bars * STEPS_PER_BAR, `${t.id}: melody is ${lead.steps} steps, expected ${bars * STEPS_PER_BAR}`);
  for (const p of [t.drums.main, t.drums.alt, t.drums.fill]) check(p.length === STEPS_PER_BAR, `${t.id}: drum pattern "${p}" is not ${STEPS_PER_BAR} long`);
  const x = renderTrack(t);
  const s = stats(x);
  const seam = Math.abs(x[0]! - x[x.length - 1]!);
  check(s.peak > 0.5 && s.peak <= 0.91, `${t.id}: peak ${s.peak.toFixed(2)} should be about 0.9`);
  check(s.clipped === 0, `${t.id}: ${s.clipped} clipped samples`);
  check(Math.abs(s.dc) < 0.02, `${t.id}: DC offset ${s.dc.toFixed(3)}`);
  check(s.quiet < 0.5, `${t.id}: ${(s.quiet * 100).toFixed(0)}% of the track is near silent`);
  check(seam < 0.3, `${t.id}: loop seam jumps by ${seam.toFixed(2)}`);
  check(Math.abs(x.length / SAMPLE_RATE - trackSeconds(t)) < 0.05, `${t.id}: length does not match its tempo`);
  console.log(
    `${t.id.padEnd(16)} ${String(bars).padStart(4)}  ${trackSeconds(t).toFixed(1).padStart(7)}  ${String(lead.notes.length).padStart(5)}  ${s.peak.toFixed(2)}  ${s.rms.toFixed(2)}  ${s.dc.toFixed(3).padStart(6)}  ${(s.quiet * 100).toFixed(0).padStart(4)}%   ${seam.toFixed(2)}`,
  );
  writeFileSync(join(out, `${t.id}.wav`), wav(x));
  // two loops back to back, to hear the seam
  const twice = new Float32Array(x.length * 2);
  twice.set(x);
  twice.set(x, x.length);
  writeFileSync(join(out, `${t.id}-x2.wav`), wav(twice));
}

console.log(`\n${'effect'.padEnd(10)} seconds  peak`);
for (const name of SFX_NAMES) {
  const x = renderSfx(name);
  const s = stats(x);
  check(s.peak > 0.1 && s.peak <= 1, `${name}: peak ${s.peak.toFixed(2)}`);
  console.log(`${name.padEnd(10)} ${(x.length / SAMPLE_RATE).toFixed(2).padStart(7)}  ${s.peak.toFixed(2)}`);
  writeFileSync(join(out, `sfx-${name}.wav`), wav(x));
}

if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log(`\nall checks passed; WAVs are in ${out}`);
