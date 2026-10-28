'use strict';

// Estimates the length of a remote MP3 from its first bytes (Xing/Info frame count, or CBR bitrate +
// file size). Used only when a feed doesn't publish <itunes:duration>.

const BITRATES = {
  1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const SAMPLE_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
const HEAD_BYTES = 64 * 1024;

async function readUpTo(res, n) {
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (size < n) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).subarray(0, n);
}

async function getRange(url, start, opts) {
  const res = await opts.fetch(url, {
    headers: { range: `bytes=${start}-${start + HEAD_BYTES - 1}`, 'user-agent': opts.userAgent },
    redirect: 'follow',
    signal: AbortSignal.timeout(opts.timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const range = res.headers.get('content-range') || '';
  const total = res.status === 206 ? Number(range.split('/')[1]) : Number(res.headers.get('content-length'));
  return { buf: await readUpTo(res, HEAD_BYTES), total: Number.isFinite(total) && total > 0 ? total : null };
}

function id3Size(buf) {
  if (buf.length < 10 || buf.toString('latin1', 0, 3) !== 'ID3') return 0;
  const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
  return 10 + size + (buf[5] & 0x10 ? 10 : 0);
}

function parseFrame(buf, i) {
  if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) return null;
  const version = (buf[i + 1] >> 3) & 3;
  const layer = (buf[i + 1] >> 1) & 3;
  const bitrateIdx = buf[i + 2] >> 4;
  const srIdx = (buf[i + 2] >> 2) & 3;
  if (version === 1 || layer !== 1 || bitrateIdx === 0 || bitrateIdx === 15 || srIdx === 3) return null;
  const mono = buf[i + 3] >> 6 === 3;
  return {
    bitrate: BITRATES[version === 3 ? 1 : 2][bitrateIdx] * 1000,
    sampleRate: SAMPLE_RATES[version][srIdx],
    samplesPerFrame: version === 3 ? 1152 : 576,
    sideInfo: version === 3 ? (mono ? 17 : 32) : mono ? 9 : 17,
  };
}

/** Returns duration in seconds, or null if it can't be determined. */
function mp3Duration(buf, audioStart, total) {
  for (let i = 0; i < buf.length - 4; i++) {
    const f = parseFrame(buf, i);
    if (!f) continue;
    const x = i + 4 + f.sideInfo;
    const tag = buf.toString('latin1', x, x + 4);
    if ((tag === 'Xing' || tag === 'Info') && buf.length >= x + 12 && buf.readUInt32BE(x + 4) & 1) {
      return Math.round((buf.readUInt32BE(x + 8) * f.samplesPerFrame) / f.sampleRate);
    }
    if (buf.toString('latin1', i + 36, i + 40) === 'VBRI' && buf.length >= i + 50) {
      return Math.round((buf.readUInt32BE(i + 46) * f.samplesPerFrame) / f.sampleRate);
    }
    if (!total) return null;
    return Math.round(((total - audioStart - i) * 8) / f.bitrate);
  }
  return null;
}

/** MP4/M4A duration from the 'mvhd' box (works when the moov box is at the front, i.e. "faststart"). */
function mp4Duration(buf) {
  const i = buf.indexOf('mvhd', 0, 'latin1');
  if (i < 4) return null;
  const version = buf[i + 4];
  if (version === 1 && buf.length >= i + 36) {
    const timescale = buf.readUInt32BE(i + 24);
    const duration = Number(buf.readBigUInt64BE(i + 28));
    return timescale ? Math.round(duration / timescale) : null;
  }
  if (buf.length < i + 24) return null;
  const timescale = buf.readUInt32BE(i + 16);
  return timescale ? Math.round(buf.readUInt32BE(i + 20) / timescale) : null;
}

async function probeDuration(url, opts) {
  const first = await getRange(url, 0, opts);
  if (first.buf.toString('latin1', 4, 8) === 'ftyp') return mp4Duration(first.buf);
  const skip = id3Size(first.buf);
  if (skip <= first.buf.length - 512) return mp3Duration(first.buf.subarray(skip), skip, first.total);
  // Large ID3 tag (embedded artwork): read again right after it.
  const next = await getRange(url, skip, opts);
  return mp3Duration(next.buf, skip, next.total || first.total);
}

module.exports = { probeDuration, mp3Duration, mp4Duration, id3Size };
