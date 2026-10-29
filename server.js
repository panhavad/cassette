'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Aggregator } = require('./lib/feeds');
const { resolveCountry, parseLanguages, normalizeLanguage, countryCounts } = require('./lib/geo');
const { countryCodes } = require('./lib/mentions');
const { Broadcaster, stationKey } = require('./lib/station');
const { Presence } = require('./lib/presence');

const PORT = Number(process.env.PORT) || 8080;
const VERSION = (process.env.GIT_SHA || 'dev').slice(0, 12);
const APP_VERSION = (() => {
  try {
    return require('./package.json').version || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();
const PUBLIC_DIR = path.join(__dirname, 'public');
const SOURCES_FILE = process.env.SOURCES_FILE || path.join(__dirname, 'sources.json');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const REFRESH_MS = Math.max(1, Number(process.env.REFRESH_MINUTES) || 10) * 60e3;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const MAX_HOOK_BODY = 5 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.wav': 'audio/wav',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};
const TEMPLATED = new Set(['index.html', 'sw.js']);
const SECURITY_HEADERS = {
  'content-security-policy':
    "default-src 'self'; media-src 'self' https: http:; img-src 'self' data:; script-src 'self'; style-src 'self'; " +
    "connect-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
};

const aggregator = new Aggregator(JSON.parse(fs.readFileSync(SOURCES_FILE, 'utf8')), {
  limit: Number(process.env.ITEMS_PER_SOURCE) || undefined,
  maxAgeHours: Number(process.env.MAX_AGE_HOURS) || undefined,
});
aggregator.start(REFRESH_MS).catch((err) => console.error('[feeds] initial refresh failed', err));
const broadcaster = new Broadcaster(() => aggregator.items, { file: path.join(DATA_DIR, 'stations.json') });
const presence = new Presence();
presence.start();
const MAX_PRESENCE_BODY = 1024;
const ALL_COUNTRIES = countryCodes();

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

function sendJson(res, status, data) {
  send(res, status, JSON.stringify(data), { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
}

const staticCache = new Map();
function loadStatic(pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return null;
  if (staticCache.has(file)) return staticCache.get(file);
  let body;
  try {
    body = fs.readFileSync(file);
  } catch {
    return null;
  }
  if (TEMPLATED.has(rel)) {
    body = Buffer.from(body.toString('utf8').replaceAll('{{VERSION}}', VERSION).replaceAll('{{APP_VERSION}}', APP_VERSION));
  }
  const entry = {
    body,
    type: MIME[path.extname(file)] || 'application/octet-stream',
    etag: `"${crypto.createHash('sha1').update(body).digest('base64url').slice(0, 20)}"`,
  };
  staticCache.set(file, entry);
  return entry;
}

function safeEqual(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

function verifyHook(req, body) {
  if (!WEBHOOK_SECRET) return false;
  const sig = req.headers['x-hub-signature-256'];
  if (sig) {
    return safeEqual(sig, 'sha256=' + crypto.createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex'));
  }
  const token = req.headers['x-gitlab-token'] || req.headers['x-chassette-token'];
  return typeof token === 'string' && safeEqual(token, WEBHOOK_SECRET);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    const chunks = [];
    let size = 0;
    const tooLarge = () => {
      const err = new Error('too large');
      err.tooLarge = true;
      req.removeAllListeners('data');
      req.resume(); // discard the rest; the 413 response closes the connection
      reject(err);
    };
    if (declared > limit) return tooLarge();
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) tooLarge();
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handle(req, res) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    return send(res, 400, 'Bad request');
  }

  if (pathname === '/healthz') return send(res, 200, 'ok', { 'content-type': 'text/plain', 'cache-control': 'no-store' });

  if (pathname === '/api/live' && req.method === 'GET') {
    if (!aggregator.updatedAt && aggregator.ready) {
      await Promise.race([aggregator.ready.catch(() => {}), new Promise((r) => setTimeout(r, 15000))]);
    }
    const q = new URL(req.url, 'http://localhost').searchParams;
    const languages = parseLanguages(q.get('lang') || req.headers['accept-language']);
    const geo = { headers: req.headers, tz: q.get('tz'), languages };
    const detected = resolveCountry(geo);
    const { country, via } = q.get('country') ? resolveCountry({ ...geo, override: q.get('country') }) : detected;
    const language = normalizeLanguage(q.get('language'));
    const { serverTime, schedule } = broadcaster.schedule(country, language);
    return sendJson(res, 200, {
      version: VERSION,
      serverTime,
      country,
      countryVia: via,
      detected: detected.country,
      detectedVia: detected.via,
      countries: ALL_COUNTRIES,
      counts: countryCounts(aggregator.items, language),
      language,
      languages: aggregator.languages(),
      listeners: presence.count(stationKey(country, language)),
      schedule,
    });
  }

  // Heartbeat from an open tab. Body: { id, country, language, live }. Also sent via sendBeacon on close.
  if (pathname === '/api/presence') {
    if (req.method !== 'POST') return send(res, 405, 'Method not allowed', { allow: 'POST' });
    let data;
    try {
      data = JSON.parse((await readBody(req, MAX_PRESENCE_BODY)).toString('utf8'));
    } catch (err) {
      if (err.tooLarge) return send(res, 413, 'Payload too large', { connection: 'close' });
      return send(res, 400, 'Bad request');
    }
    if (!data || !Presence.validId(data.id)) return send(res, 400, 'Bad request');
    const { country } = resolveCountry({ override: data.country });
    const station = stationKey(country, normalizeLanguage(data.language));
    presence.beat(data.id, station, data.live === true);
    return sendJson(res, 200, { listeners: presence.count(station) });
  }

  if (pathname === '/api/version') return sendJson(res, 200, { version: VERSION, release: APP_VERSION });

  if (pathname === '/api/hook') {
    if (req.method !== 'POST') return send(res, 405, 'Method not allowed', { allow: 'POST' });
    let body;
    try {
      body = await readBody(req, MAX_HOOK_BODY);
    } catch {
      return send(res, 413, 'Payload too large', { connection: 'close' });
    }
    if (!verifyHook(req, body)) return send(res, 401, 'Unauthorized');
    const queued = typeof process.send === 'function';
    if (queued) process.send({ type: 'check-update' });
    return sendJson(res, 202, { queued });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', { allow: 'GET, HEAD' });

  const file = loadStatic(pathname);
  if (!file) return send(res, 404, 'Not found', { 'content-type': 'text/plain' });
  const headers = { 'content-type': file.type, etag: file.etag, 'cache-control': 'no-cache', 'accept-ranges': 'bytes' };
  if (req.headers['if-none-match'] === file.etag) return send(res, 304, null, headers);

  // Single byte ranges (Safari won't play media without them).
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range && (range[1] || range[2])) {
    const size = file.body.length;
    let start = range[1] ? Number(range[1]) : size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : size - 1;
    start = Math.max(0, start);
    end = Math.min(end, size - 1);
    if (start > end) return send(res, 416, null, { 'content-range': `bytes */${size}` });
    const chunk = file.body.subarray(start, end + 1);
    headers['content-range'] = `bytes ${start}-${end}/${size}`;
    headers['content-length'] = chunk.length;
    return send(res, 206, req.method === 'HEAD' ? null : chunk, headers);
  }

  headers['content-length'] = file.body.length;
  return send(res, 200, req.method === 'HEAD' ? null : file.body, headers);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error('[http]', err);
    if (!res.headersSent) send(res, 500, 'Internal error');
    else res.end();
  });
});

server.listen(PORT, () => console.log(`[chassette] v${APP_VERSION} (${VERSION}) listening on :${PORT}`));

function shutdown() {
  aggregator.stop();
  presence.stop();
  broadcaster.flush();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('disconnect', shutdown);
