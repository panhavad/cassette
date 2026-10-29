'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { findMentions, isCountry } = require('../lib/mentions');

const about = (title, context = '', lang = 'en') => findMentions({ title, context }, lang);

test('names, demonyms, capitals and big cities map to countries', () => {
  assert.deepEqual(about('Cambodia to host ASEAN summit'), ['KH']);
  assert.deepEqual(about('Cambodian garment workers strike'), ['KH']);
  assert.deepEqual(about('Floods hit Phnom Penh'), ['KH']);
  assert.deepEqual(about('Siem Reap tourism rebounds'), ['KH']);
  assert.deepEqual(about('M5.4 quake shakes Tokyo'), ['JP']);
  assert.deepEqual(about('Toyota results', 'Sales slump in Osaka plants'), ['JP']);
  assert.deepEqual(about("Japan's exports rise"), ['JP']);
});

test('title mentions rank first, most-mentioned first', () => {
  assert.deepEqual(about('Thailand and Cambodia agree ceasefire', 'Talks in Kuala Lumpur'), ['TH', 'KH', 'MY']);
  assert.deepEqual(about('Trade talks', 'US and China officials met; China said...'), ['CN', 'US']);
});

test('longest phrase wins and region phrases do not tag a country', () => {
  assert.deepEqual(about('South Sudan clashes'), ['SS']);
  assert.deepEqual(about('Papua New Guinea quake'), ['PG']);
  assert.deepEqual(about('North Korea fires missile'), ['KP']);
  assert.deepEqual(about('Latin American leaders meet'), []);
  assert.deepEqual(about('South China Sea patrol'), []);
  assert.deepEqual(about("Mark Cuban says data center deals are 'contractual terrorism'"), []);
  assert.deepEqual(about('Cuban exiles rally in Florida'), ['CU', 'US']);
});

test('ambiguous words need a clear signal', () => {
  assert.deepEqual(about('Georgia voters head to the polls'), []);
  assert.deepEqual(about('Georgia protests grow', 'Crowds gathered in Tbilisi'), ['GE']);
});

test('case-sensitive, whole words only', () => {
  assert.deepEqual(about('the chad of it all'), []);
  assert.deepEqual(about('Thailandia festival'), []);
  assert.deepEqual(about('Turkey and Syria'), ['TR', 'SY']);
});

test('other languages use local country names', () => {
  assert.deepEqual(about('カンボジアで洪水', '', 'ja'), ['KH']);
  assert.deepEqual(about('Kambodscha: Wahlen', '', 'de'), ['KH']);
  assert.ok(isCountry('KH'));
  assert.ok(!isCountry('XX'));
});
