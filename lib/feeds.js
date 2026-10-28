'use strict';

const crypto = require('node:crypto');

const USER_AGENT = 'Chassette/1.0 (audio news radio)';
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
const AUDIO_EXT = /\.(mp3|m4a|aac|ogg|oga|opus|wav)(\?|#|$)/i;

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(n); } catch { return m; }
    }
    const v = ENTITIES[e.toLowerCase()];
    return v === undefined ? m : v;
  });
}

function cleanText(raw) {
  if (!raw) return '';
  const unwrapped = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, c) => c.replace(/<[^>]*>/g, ' '));
  return decodeEntities(unwrapped.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function getTag(xml, name) {
  const n = escapeRe(name);
  const m = xml.match(new RegExp(`<${n}(?:\\s[^>]*)?(?<!/)>([\\s\\S]*?)</${n}>`, 'i'));
  return m ? m[1] : '';
}

function getOpenTags(xml, name) {
  return xml.match(new RegExp(`<${escapeRe(name)}\\s[^>]*>`, 'gi')) || [];
}

function parseAttrs(tag) {
  const out = {};
  const re = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(tag))) out[m[1].toLowerCase()] = decodeEntities(m[2] !== undefined ? m[2] : m[3]);
  return out;
}

function safeUrl(value, base) {
  if (!value || !value.trim()) return null;
  try {
    const url = new URL(value.trim(), base || undefined);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

function isAudio(url, type) {
  if (type) return /^audio\//i.test(type.trim());
  return AUDIO_EXT.test(url);
}

function parseDuration(raw) {
  const s = cleanText(raw);
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s));
  const parts = s.split(':').map(Number);
  if (parts.length > 3 || parts.some((p) => !Number.isFinite(p))) return null;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

const shortHash = (s) => crypto.createHash('sha1').update(s).digest('base64url').slice(0, 12);

/**
 * Parses an RSS podcast feed and returns only items that carry an audio file.
 * Text bodies (descriptions, transcripts) are intentionally ignored.
 */
function parseFeed(xml, source = {}) {
  const firstItem = xml.search(/<item[\s>]/i);
  const head = firstItem === -1 ? xml : xml.slice(0, firstItem);
  const channelTitle = cleanText(getTag(head, 'title'));
  const channelLink = safeUrl(cleanText(getTag(head, 'link')));

  const items = [];
  const itemRe = /<item[\s>]([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = itemRe.exec(xml))) {
    const body = m[1];
    let audio = null;
    let type = '';
    for (const tag of [...getOpenTags(body, 'enclosure'), ...getOpenTags(body, 'media:content')]) {
      const a = parseAttrs(tag);
      const url = safeUrl(a.url, channelLink);
      if (url && isAudio(url, a.type)) {
        audio = url;
        type = a.type || 'audio/mpeg';
        break;
      }
    }
    if (!audio) continue;

    const title = cleanText(getTag(body, 'title'));
    if (!title) continue;

    const date = new Date(cleanText(getTag(body, 'pubDate')) || cleanText(getTag(body, 'dc:date')));
    const guid = cleanText(getTag(body, 'guid'));
    items.push({
      id: shortHash(`${source.feed || channelLink || ''}|${guid || audio}`),
      title,
      link: safeUrl(cleanText(getTag(body, 'link')), channelLink) || safeUrl(source.site) || channelLink,
      audio,
      type,
      published: Number.isNaN(date.getTime()) ? null : date.toISOString(),
      duration: parseDuration(getTag(body, 'itunes:duration')),
    });
  }
  return { title: channelTitle, link: channelLink, items };
}

class Aggregator {
  constructor(sources, opts = {}) {
    this.sources = (sources || []).filter((s) => s && s.feed && s.enabled !== false);
    this.fetch = opts.fetch || globalThis.fetch;
    this.timeoutMs = opts.timeoutMs || 20000;
    this.defaultLimit = opts.limit || 2;
    this.maxAgeHours = opts.maxAgeHours || 72;
    this.log = opts.log || console;
    this.bySource = new Map();
    this.items = [];
    this.updatedAt = null;
    this.pending = null;
    this.timer = null;
  }

  async fetchSource(src) {
    const res = await this.fetch(src.feed, {
      headers: { 'user-agent': USER_AGENT, accept: 'application/rss+xml, application/xml;q=0.9, */*;q=0.8' },
      redirect: 'follow',
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const feed = parseFeed(await res.text(), src);
    const now = Date.now();
    const maxAge = (src.maxAgeHours || this.maxAgeHours) * 3600e3;
    const sourceUrl = safeUrl(src.site) || feed.link;
    return feed.items
      .filter((i) => i.published && now - Date.parse(i.published) <= maxAge)
      .sort((a, b) => Date.parse(b.published) - Date.parse(a.published))
      .slice(0, src.limit || this.defaultLimit)
      .map((i) => ({
        ...i,
        source: src.name || feed.title,
        publisher: src.publisher || feed.title,
        sourceUrl: sourceUrl || i.link,
        country: (src.country || '').toUpperCase() || null,
        lang: (src.lang || 'en').toLowerCase(),
        scope: src.scope === 'global' ? 'global' : 'national',
      }));
  }

  /** Countries that have at least one configured station. */
  countries() {
    return [...new Set(this.sources.map((s) => (s.country || '').toUpperCase()))].filter((c) => /^[A-Z]{2}$/.test(c) && c !== 'EU').sort();
  }

  refresh() {
    if (this.pending) return this.pending;
    this.pending = (async () => {
      const results = await Promise.allSettled(this.sources.map((s) => this.fetchSource(s)));
      results.forEach((r, i) => {
        const src = this.sources[i];
        if (r.status === 'fulfilled') this.bySource.set(src.feed, r.value);
        else this.log.warn(`[feeds] ${src.name}: ${r.reason && r.reason.message}`);
      });
      const seen = new Set();
      this.items = [...this.bySource.values()]
        .flat()
        .filter((i) => !seen.has(i.audio) && seen.add(i.audio))
        .sort((a, b) => Date.parse(b.published) - Date.parse(a.published));
      this.updatedAt = new Date().toISOString();
      this.log.info(`[feeds] ${this.items.length} audio items from ${this.bySource.size}/${this.sources.length} sources`);
      return this.items;
    })().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  start(intervalMs) {
    this.ready = this.refresh();
    this.timer = setInterval(() => this.refresh().catch(() => {}), intervalMs);
    this.timer.unref();
    return this.ready;
  }

  stop() {
    clearInterval(this.timer);
  }
}

module.exports = { Aggregator, parseFeed, cleanText, parseDuration, decodeEntities };
