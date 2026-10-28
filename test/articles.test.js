'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractAudio, isoDuration } = require('../lib/articles');
const { Aggregator, parseArticleList } = require('../lib/feeds');

const URL_ = 'https://news.example/2026/10/28/story/';
const ctx = { fetch: async () => ({ ok: false }), userAgent: 'test', timeoutMs: 1000 };

test('JSON-LD AudioObject with ISO duration', async () => {
  const html = `<script type="application/ld+json">{"@type":"NewsArticle","articleBody":"secret text",
    "associatedMedia":{"@type":"AudioObject","contentUrl":"https://cdn.example/a.mp3","duration":"PT7M13S"}}</script>`;
  assert.deepEqual(await extractAudio(html, URL_, { extract: 'jsonld' }, ctx), { audio: 'https://cdn.example/a.mp3', duration: 433 });
  assert.equal(isoDuration('PT1H2M3S'), 3723);
});

test('<audio> tag with a relative URL', async () => {
  const html = '<div><audio id="audio" src="/media/speech/1.mp3"></audio></div>';
  assert.deepEqual(await extractAudio(html, URL_, { extract: 'audio' }, ctx), { audio: 'https://news.example/media/speech/1.mp3', duration: null });
});

test('per-site pattern unescapes JSON-embedded URLs', async () => {
  const html = '{\\"ttsUrl\\",\\"https:\\/\\/cdn.example\\/tts\\/9.mp3\\"}';
  const src = { extract: 'pattern', pattern: 'ttsUrl\\\\*"\\s*,\\s*\\\\*"(https?:[^"\\\\]*(?:\\\\/[^"\\\\]*)*?\\.mp3)' };
  const found = await extractAudio(html, URL_, src, ctx);
  assert.equal(found.audio, 'https://cdn.example/tts/9.mp3');
});

test('BeyondWords player API returns the article MP3 and duration', async () => {
  const html = `<script onload="new BeyondWords.Player({ target: this, projectId: 7914, sourceUrl: '${URL_}' })"></script>`;
  let asked = '';
  const fetchStub = async (u) => {
    asked = u;
    return {
      ok: true,
      json: async () => ({
        content: [{ title: 'T', body: 'secret text', audio: [
          { content_type: 'application/x-mpegURL', url: 'https://cdn.beyondwords.io/a.m3u8', duration: 236741 },
          { content_type: 'audio/mpeg', url: 'https://cdn.beyondwords.io/a.mp3', duration: 236748 },
        ] }],
      }),
    };
  };
  const found = await extractAudio(html, URL_, { extract: 'beyondwords' }, { ...ctx, fetch: fetchStub });
  assert.equal(asked, `https://api.beyondwords.io/v1/projects/7914/player/by_source_url/${encodeURIComponent(URL_)}`);
  assert.deepEqual(found, { audio: 'https://cdn.beyondwords.io/a.mp3', duration: 237 });
});

test('pages without audio yield nothing', async () => {
  assert.equal(await extractAudio('<p>text only</p>', URL_, {}, ctx), null);
});

test('article source: RSS title + article URL + audio only, each article fetched once', async () => {
  const now = new Date().toUTCString();
  const rss = `<rss><channel><title>Site</title>
    <item><title>With audio</title><link>https://news.example/a</link><pubDate>${now}</pubDate><description>body text</description></item>
    <item><title>No audio</title><link>https://news.example/b</link><pubDate>${now}</pubDate></item>
  </channel></rss>`;
  assert.equal(parseArticleList(rss).length, 2);
  const pages = { 'https://news.example/a': '<audio src="https://cdn.example/a.mp3"></audio><p>body text</p>', 'https://news.example/b': '<p>none</p>' };
  const hits = {};
  const fetch = async (u) => {
    hits[u] = (hits[u] || 0) + 1;
    if (u === 'https://news.example/rss') return { ok: true, text: async () => rss };
    return { ok: true, text: async () => pages[u] };
  };
  const agg = new Aggregator([{ type: 'articles', name: 'Site', feed: 'https://news.example/rss', country: 'jp', extract: 'audio', limit: 5 }], {
    fetch,
    log: { info() {}, warn() {} },
  });
  agg.fillDurations = async (items) => items.forEach((i) => { i.duration = 60; });
  const items = await agg.refresh();
  await agg.refresh();
  assert.deepEqual(items.map((i) => [i.title, i.link, i.audio, i.country]), [['With audio', 'https://news.example/a', 'https://cdn.example/a.mp3', 'JP']]);
  assert.ok(!JSON.stringify(items).includes('body text'));
  assert.equal(hits['https://news.example/a'], 1);
  assert.equal(hits['https://news.example/b'], 1);
});
