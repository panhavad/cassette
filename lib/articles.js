'use strict';

// Article-audio sources: news sites that publish an audio version ("listen to this article") of their
// stories. We read the site's RSS for article URLs, open each new article page once, and keep only the
// audio file URL. The title comes from the RSS feed; article text is never stored or served.

function unescapeJsonUrl(s) {
  return s
    .replace(/\\u002[fF]/g, '/')
    .replace(/\\u0026/g, '&')
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&');
}

function absolute(url, base) {
  try {
    const u = new URL(unescapeJsonUrl(url.trim()), base);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

function isoDuration(s) {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/i.exec(String(s || '').trim());
  if (!m) return null;
  const sec = (Number(m[1]) || 0) * 86400 + (Number(m[2]) || 0) * 3600 + (Number(m[3]) || 0) * 60 + (Number(m[4]) || 0);
  return sec > 0 ? Math.round(sec) : null;
}

function* walk(node) {
  if (Array.isArray(node)) for (const n of node) yield* walk(n);
  else if (node && typeof node === 'object') {
    yield node;
    for (const v of Object.values(node)) if (v && typeof v === 'object') yield* walk(v);
  }
}

const extractors = {
  /** schema.org AudioObject in JSON-LD. */
  jsonld(html, url) {
    const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    for (const m of html.matchAll(re)) {
      let data;
      try {
        data = JSON.parse(m[1]);
      } catch {
        continue;
      }
      for (const node of walk(data)) {
        const type = [].concat(node['@type'] || []);
        if (!type.includes('AudioObject')) continue;
        const audio = absolute(String(node.contentUrl || node.url || ''), url);
        if (audio) return { audio, duration: isoDuration(node.duration) };
      }
    }
    return null;
  },

  /** <audio src> or <audio><source type="audio/..."></audio>. */
  audio(html, url) {
    const tag = html.match(/<audio\b[^>]*\ssrc=["']([^"']+)["']/i) || html.match(/<source\b(?=[^>]*type=["']audio\/)[^>]*\ssrc=["']([^"']+)["']/i);
    const audio = tag && absolute(tag[1], url);
    return audio ? { audio, duration: null } : null;
  },

  /** Per-site regex (first capture group = audio URL), for players that keep the URL in page data. */
  pattern(html, url, src) {
    if (!src.pattern) return null;
    const m = html.match(new RegExp(src.pattern, 'i'));
    const audio = m && absolute(m[1], url);
    return audio ? { audio, duration: null } : null;
  },

  /** BeyondWords (formerly SpeechKit) player: ask its public player API for this article's MP3. */
  async beyondwords(html, url, src, ctx) {
    const project = html.match(/projectId["']?\s*[:=]\s*["']?(\d+)/i) || html.match(/data-project-id=["'](\d+)/i);
    if (!project) return null;
    const sourceUrl = (html.match(/sourceUrl\s*:\s*["']([^"']+)["']/i) || [])[1] || url;
    const api = `https://api.beyondwords.io/v1/projects/${project[1]}/player/by_source_url/${encodeURIComponent(sourceUrl)}`;
    const res = await ctx.fetch(api, { headers: { 'user-agent': ctx.userAgent, accept: 'application/json' }, signal: AbortSignal.timeout(ctx.timeoutMs) });
    if (!res.ok) return null;
    const data = await res.json();
    const content = Array.isArray(data.content) ? data.content[0] : null;
    const mp3 = content && Array.isArray(content.audio) ? content.audio.find((a) => /audio\/mpeg/i.test(a.content_type)) : null;
    const audio = mp3 && absolute(mp3.url, url);
    return audio ? { audio, duration: mp3.duration ? Math.round(mp3.duration / 1000) : null } : null;
  },
};

async function extractAudio(html, url, src, ctx) {
  const order = [].concat(src.extract || ['beyondwords', 'jsonld', 'audio']);
  for (const name of order) {
    const fn = extractors[name];
    if (!fn) continue;
    const found = await fn(html, url, src, ctx);
    if (found) return found;
  }
  return null;
}

/** Keyword/tag metadata of an article page (meta keywords, news_keywords, article:tag, og:description). */
function pageKeywords(html) {
  const out = [];
  const re = /<meta\b[^>]*>/gi;
  for (const m of html.matchAll(re)) {
    const tag = m[0];
    const key = (tag.match(/\b(?:name|property)=["']([^"']+)["']/i) || [])[1];
    if (!key || !/^(keywords|news_keywords|article:tag|og:description|description)$/i.test(key)) continue;
    const content = (tag.match(/\bcontent=["']([^"']*)["']/i) || [])[1];
    if (content) out.push(content.replace(/&amp;/g, '&').replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"'));
  }
  return out.join(' · ').slice(0, 800);
}

module.exports = { extractAudio, extractors, isoDuration, unescapeJsonUrl, pageKeywords };
