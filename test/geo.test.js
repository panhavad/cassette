'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveCountry, parseLanguages, rankForStation, normalizeLanguage } = require('../lib/geo');

test('resolveCountry precedence: manual > network header > time zone > language', () => {
  const base = { headers: { 'cf-ipcountry': 'kr' }, tz: 'Asia/Tokyo', languages: ['en-US'] };
  assert.deepEqual(resolveCountry({ ...base, override: 'de' }), { country: 'DE', via: 'manual' });
  assert.deepEqual(resolveCountry({ ...base, override: 'ww' }), { country: 'WW', via: 'manual' });
  assert.deepEqual(resolveCountry(base), { country: 'KR', via: 'network' });
  assert.deepEqual(resolveCountry({ ...base, headers: { 'cf-ipcountry': 'XX' } }), { country: 'JP', via: 'timezone' });
  assert.deepEqual(resolveCountry({ tz: 'Asia/Calcutta' }), { country: 'IN', via: 'timezone' });
  assert.deepEqual(resolveCountry({ tz: 'Etc/UTC', languages: ['fr-CA'] }), { country: 'CA', via: 'language' });
  assert.deepEqual(resolveCountry({ override: 'not-a-country' }), { country: 'WW', via: 'default' });
});

test('parseLanguages handles Accept-Language weights and plain lists', () => {
  assert.deepEqual(parseLanguages('ja;q=0.5, en-US,de;q=0.8,*;q=0.1'), ['en-US', 'de', 'ja']);
  assert.deepEqual(parseLanguages('en-US,ja'), ['en-US', 'ja']);
  assert.deepEqual(parseLanguages(undefined), []);
});

const iso = (h) => new Date(Date.now() - h * 3600e3).toISOString();
const ITEMS = [
  { id: 'us', country: 'US', lang: 'en', scope: 'national', published: iso(1) },
  { id: 'jp-en', country: 'JP', lang: 'en', scope: 'global', published: iso(5) },
  { id: 'jp-ja', country: 'JP', lang: 'ja', scope: 'national', published: iso(2) },
  { id: 'bbc', country: 'GB', lang: 'en', scope: 'global', published: iso(3) },
  { id: 'th', country: 'JP', lang: 'th', scope: 'global', published: iso(1) },
  { id: 'de', country: 'DE', lang: 'de', scope: 'national', published: iso(1) },
];

test('English by default: local first, then world services, foreign domestic news dropped', () => {
  const ranked = rankForStation(ITEMS, { country: 'JP' });
  assert.deepEqual(ranked.map((i) => `${i.id}:${i.tier}`), ['jp-en:local', 'bbc:world']);
});

test('a chosen language plays only that language, including other countries in it', () => {
  assert.deepEqual(rankForStation(ITEMS, { country: 'JP', language: 'ja' }).map((i) => i.id), ['jp-ja']);
  assert.deepEqual(rankForStation(ITEMS, { country: 'TH', language: 'th' }).map((i) => `${i.id}:${i.tier}`), ['th:world']);
  assert.deepEqual(rankForStation(ITEMS, { country: 'JP', language: 'de' }).map((i) => i.id), ['de']);
});

test('worldwide mode keeps everything in the language, newest first', () => {
  const ranked = rankForStation(ITEMS, { country: 'WW', language: 'en' });
  assert.deepEqual(ranked.map((i) => i.id), ['us', 'bbc', 'jp-en']);
  assert.ok(ranked.every((i) => i.tier === 'world'));
});

test('normalizeLanguage falls back to English', () => {
  assert.equal(normalizeLanguage('ja-JP'), 'ja');
  assert.equal(normalizeLanguage(''), 'en');
  assert.equal(normalizeLanguage('<script>'), 'en');
});
