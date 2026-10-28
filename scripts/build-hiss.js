'use strict';

// Generates public/audio/hiss.wav: a quiet, seamless loop of cassette tape hiss with soft crackles.
// Played between stories (and when a stream fails) so the radio never goes silent mid-broadcast,
// which also keeps background playback alive on mobile.
// Usage: node scripts/build-hiss.js

const fs = require('node:fs');
const path = require('node:path');

const RATE = 8000;
const SECONDS = 6;
const n = RATE * SECONDS;
const samples = new Float32Array(n);

let seed = 0x2f6b1d;
const rand = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 0xffffffff - 0.5;
};

// Pink-ish noise: low-passed white noise with a slow wobble, like worn tape.
let lp = 0;
for (let i = 0; i < n; i++) {
  lp += 0.18 * (rand() - lp);
  const wobble = 1 + 0.25 * Math.sin((2 * Math.PI * i) / n);
  samples[i] = lp * 0.09 * wobble;
}
for (let c = 0; c < 14; c++) {
  const at = Math.floor((rand() + 0.5) * (n - 40));
  const amp = 0.08 + (rand() + 0.5) * 0.08;
  for (let k = 0; k < 24; k++) samples[at + k] += amp * Math.exp(-k / 4) * (k % 2 ? -1 : 1);
}
// Crossfade the ends so the loop point is inaudible.
const fade = RATE / 4;
for (let i = 0; i < fade; i++) {
  const w = i / fade;
  samples[i] = samples[i] * w + samples[n - fade + i] * (1 - w);
}
const body = samples.subarray(0, n - fade);

const data = Buffer.alloc(body.length);
body.forEach((s, i) => {
  data[i] = Math.max(0, Math.min(255, Math.round(128 + s * 127)));
});

const header = Buffer.alloc(44);
header.write('RIFF', 0);
header.writeUInt32LE(36 + data.length, 4);
header.write('WAVE', 8);
header.write('fmt ', 12);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20); // PCM
header.writeUInt16LE(1, 22); // mono
header.writeUInt32LE(RATE, 24);
header.writeUInt32LE(RATE, 28);
header.writeUInt16LE(1, 32);
header.writeUInt16LE(8, 34);
header.write('data', 36);
header.writeUInt32LE(data.length, 40);

const out = path.join(__dirname, '..', 'public', 'audio', 'hiss.wav');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, Buffer.concat([header, data]));
console.log(`wrote ${out} (${header.length + data.length} bytes)`);
