'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Aggregator } = require('./lib/feeds');

const PORT = Number(process.env.PORT) || 8080;
const VERSION = (process.env.GIT_SHA || 'dev').slice(0, 12);
const PUBLIC_DIR = path.join(__dirname, 'public');
const SOURCES_FILE = process.env.SOURCES_FILE || path.join(__dirname, 'sources.json');
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
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};
const TEMPLATED = new Set(['index.html', 'sw.js']);
const SECURITY_HEADERS = {
  'content-security-policy':
    "default-src 'self'; media-src https: http:; img-src 'self' data:; script-src 'self'; style-src 'self'; " +
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
  if (TEMPLATED.has(rel)) body = Buffer.from(body.toString('utf8').replaceAll('{{VERSION}}', VERSION));
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
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('too large'));
        req.destroy();
      } else chunks.push(c);
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

  if (pathname === '/api/news' && req.method === 'GET') {
    if (!aggregator.updatedAt && aggregator.ready) {
      await Promise.race([aggregator.ready.catch(() => {}), new Promise((r) => setTimeout(r, 15000))]);
    }
    return sendJson(res, 200, { version: VERSION, updatedAt: aggregator.updatedAt, items: aggregator.items });
  }

  if (pathname === '/api/version') return sendJson(res, 200, { version: VERSION });

  if (pathname === '/api/hook') {
    if (req.method !== 'POST') return send(res, 405, 'Method not allowed', { allow: 'POST' });
    let body;
    try {
      body = await readBody(req, MAX_HOOK_BODY);
    } catch {
      return send(res, 413, 'Payload too large');
    }
    if (!verifyHook(req, body)) return send(res, 401, 'Unauthorized');
    const queued = typeof process.send === 'function';
    if (queued) process.send({ type: 'check-update' });
    return sendJson(res, 202, { queued });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', { allow: 'GET, HEAD' });

  const file = loadStatic(pathname);
  if (!file) return send(res, 404, 'Not found', { 'content-type': 'text/plain' });
  const headers = { 'content-type': file.type, etag: file.etag, 'cache-control': 'no-cache' };
  if (req.headers['if-none-match'] === file.etag) return send(res, 304, null, headers);
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

server.listen(PORT, () => console.log(`[chassette] v${VERSION} listening on :${PORT}`));

function shutdown() {
  aggregator.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('disconnect', shutdown);
