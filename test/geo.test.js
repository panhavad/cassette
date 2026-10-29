'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveCountry, parseLanguages, rankForStation, countryCounts, normalizeLanguage } = require('../lib/geo');

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

const BASE = Date.now();
const iso = (h) => new Date(BASE - h * 3600e3).toISOString();
// `country` = publisher's country, `mentions` = countries the story is about.
const ITEMS = [
  { id: 'npr-kh', country: 'US', lang: 'en', scope: 'national', mentions: ['KH'], published: iso(4) },
  { id: 'bbc-th-kh', country: 'GB', lang: 'en', scope: 'global', mentions: ['TH', 'KH'], published: iso(1) },
  { id: 'kh-paper', country: 'KH', lang: 'en', scope: 'national', mentions: ['FR'], published: iso(2) },
  { id: 'us-politics', country: 'US', lang: 'en', scope: 'national', mentions: ['US'], published: iso(1) },
  { id: 'bbc-world', country: 'GB', lang: 'en', scope: 'global', mentions: ['BR'], published: iso(3) },
  { id: 'nhk-ja-kh', country: 'JP', lang: 'ja', scope: 'national', mentions: ['KH'], published: iso(2) },
  { id: 'th-lang', country: 'JP', lang: 'th', scope: 'global', mentions: [], published: iso(1) },
];
const ids = (list) => list.map((i) => `${i.id}:${i.tier}`);

test('a station plays news ABOUT the country from any publisher, main subject first, then world news', () => {
  assert.deepEqual(ids(rankForStation(ITEMS, { country: 'KH' })), ['npr-kh:about', 'bbc-th-kh:about', 'bbc-world:world']);
});

test("the publisher's own country does not make a story relevant", () => {
  const kh = rankForStation(ITEMS, { country: 'KH' }).map((i) => i.id);
  assert.ok(!kh.includes('kh-paper'), 'Cambodian paper writing about France is not Cambodia news');
  assert.ok(rankForStation(ITEMS, { country: 'FR' }).some((i) => i.id === 'kh-paper' && i.tier === 'about'));
});

test('country with no stories still gets world news; flags show what the story is about', () => {
  const lineup = rankForStation(ITEMS, { country: 'NO' });
  assert.deepEqual(ids(lineup), ['bbc-th-kh:world', 'bbc-world:world']);
  assert.deepEqual(lineup.map((i) => i.flag), ['TH', 'BR']);
  assert.ok(rankForStation(ITEMS, { country: 'KH' }).filter((i) => i.tier === 'about').every((i) => i.flag === 'KH'));
});

test('a chosen language plays only that language', () => {
  assert.deepEqual(ids(rankForStation(ITEMS, { country: 'KH', language: 'ja' })), ['nhk-ja-kh:about']);
  assert.deepEqual(ids(rankForStation(ITEMS, { country: 'TH', language: 'th' })), ['th-lang:world']);
});

test('worldwide mode keeps everything in the language, newest first', () => {
  const ranked = rankForStation(ITEMS, { country: 'WW', language: 'en' });
  assert.deepEqual(ranked.map((i) => i.id), ['bbc-th-kh', 'us-politics', 'kh-paper', 'bbc-world', 'npr-kh']);
  assert.ok(ranked.every((i) => i.tier === 'world'));
});

test('countryCounts counts stories about each country per language', () => {
  assert.deepEqual(countryCounts(ITEMS, 'en'), { KH: 2, TH: 1, FR: 1, US: 1, BR: 1 });
  assert.deepEqual(countryCounts(ITEMS, 'ja'), { KH: 1 });
});

test('normalizeLanguage falls back to English', () => {
  assert.equal(normalizeLanguage('ja-JP'), 'ja');
  assert.equal(normalizeLanguage(''), 'en');
  assert.equal(normalizeLanguage('<script>'), 'en');
});
