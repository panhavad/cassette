'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveCountry, parseLanguages, rankForListener } = require('../lib/geo');

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

test('rankForListener puts local first, then world services, drops foreign domestic news', () => {
  const ranked = rankForListener(ITEMS, { country: 'JP', languages: ['ja-JP', 'en'] });
  assert.deepEqual(ranked.map((i) => `${i.id}:${i.tier}`), ['jp-ja:local', 'jp-en:local', 'bbc:world']);
});

test('rankForListener filters out languages the listener does not accept (English always kept)', () => {
  const ranked = rankForListener(ITEMS, { country: 'JP', languages: ['en-US'] });
  assert.deepEqual(ranked.map((i) => i.id), ['jp-en', 'bbc']);
  const thai = rankForListener(ITEMS, { country: 'TH', languages: ['th'] });
  assert.deepEqual(thai.map((i) => `${i.id}:${i.tier}`), ['th:world', 'bbc:world', 'jp-en:world']);
});

test('rankForListener worldwide mode keeps everything audible, newest first', () => {
  const ranked = rankForListener(ITEMS, { country: 'WW', languages: ['en'] });
  assert.deepEqual(ranked.map((i) => i.id), ['us', 'bbc', 'jp-en']);
  assert.ok(ranked.every((i) => i.tier === 'world'));
});
