'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mp3Duration, id3Size } = require('../lib/probe');

// MPEG-1 Layer III, 128 kbps, 44.1 kHz, stereo
const FRAME_HEADER = [0xff, 0xfb, 0x90, 0x00];

test('CBR duration from bitrate and file size', () => {
  const buf = Buffer.alloc(2048);
  Buffer.from(FRAME_HEADER).copy(buf, 100);
  const total = 100 + 16000 * 60; // 60 s at 128 kbps (16000 bytes/s)
  assert.equal(mp3Duration(buf, 0, total), 60);
});

test('VBR duration from Xing frame count', () => {
  const buf = Buffer.alloc(2048);
  Buffer.from(FRAME_HEADER).copy(buf, 0);
  const x = 4 + 32;
  buf.write('Xing', x, 'latin1');
  buf.writeUInt32BE(1, x + 4);
  buf.writeUInt32BE(2297, x + 8); // 2297 frames * 1152 / 44100 ≈ 60 s
  assert.equal(mp3Duration(buf, 0, null), 60);
});

test('ID3v2 size and unknown data', () => {
  const tag = Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0x02, 0x01]);
  assert.equal(id3Size(tag), 10 + 257);
  assert.equal(id3Size(Buffer.from('nope')), 0);
  assert.equal(mp3Duration(Buffer.alloc(100), 0, 1000), null);
});

test('MP4 duration from mvhd (version 0)', () => {
  const { mp4Duration } = require('../lib/probe');
  const buf = Buffer.alloc(64);
  buf.write('mvhd', 8, 'latin1');
  buf[12] = 0;
  buf.writeUInt32BE(1000, 24);
  buf.writeUInt32BE(185000, 28);
  assert.equal(mp4Duration(buf), 185);
});
