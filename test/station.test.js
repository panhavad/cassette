'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Broadcaster, stationKey, GAP_MS } = require('../lib/station');

const T0 = Date.UTC(2026, 9, 28, 12, 0, 0);
const iso = (h) => new Date(T0 - h * 3600e3).toISOString();
// `country` = the country the story is about (and, for simplicity here, its publisher's country).
const item = (id, country, opts = {}) => ({
  id,
  title: `Story ${id}`,
  source: `Src ${id}`,
  audio: `https://cdn.example/${id}.mp3`,
  country,
  mentions: [country],
  lang: 'en',
  scope: 'national',
  duration: 60,
  published: iso(1),
  ...opts,
});

function setup(items, startAt = T0, file = null) {
  const clock = { t: startAt };
  const b = new Broadcaster(() => items, { now: () => clock.t, file, log: { warn() {} } });
  return { b, clock };
}

test('listeners of the same station get the same timeline, joining mid-story', () => {
  const items = [item('jp1', 'JP'), item('jp2', 'JP', { published: iso(2) }), item('bbc', 'GB', { scope: 'global', published: iso(3) })];
  const { b, clock } = setup(items);
  const first = b.schedule('JP').schedule;
  assert.equal(first[0].id, 'jp1');
  assert.equal(first[0].start, T0);
  assert.equal(first[0].end, T0 + 60000 + GAP_MS);
  assert.equal(first[1].id, 'jp2');
  assert.equal(first[1].start, first[0].end);
  assert.equal(first[2].id, 'bbc');
  assert.equal(first[2].projected, true);

  clock.t = T0 + 30000;
  const later = b.schedule('JP').schedule;
  assert.equal(later[0].key, first[0].key, 'second listener joins the same segment');
  assert.equal(later[0].start, T0);

  clock.t = first[1].start + 1000;
  const next = b.schedule('JP').schedule;
  assert.equal(next[0].key, first[1].key);
  assert.equal(next[1].id, 'bbc');
  assert.equal(next[1].projected, false);
});

test('different countries are independent stations; foreign domestic news is excluded', () => {
  const items = [item('jp1', 'JP'), item('us1', 'US'), item('bbc', 'GB', { scope: 'global' })];
  const { b } = setup(items);
  const jp = b.schedule('JP').schedule.map((s) => s.id);
  const us = b.schedule('US').schedule.map((s) => s.id);
  assert.ok(!jp.includes('us1'));
  assert.ok(!us.includes('jp1'));
  assert.equal(jp[0], 'jp1');
  assert.equal(us[0], 'us1');
});

test('breaking story airs right after the committed next segment', () => {
  const items = [item('a', 'JP'), item('b', 'JP', { published: iso(2) }), item('c', 'JP', { published: iso(3) })];
  const { b, clock } = setup(items);
  const s1 = b.schedule('JP').schedule;
  items.unshift(item('breaking', 'JP', { published: iso(0) }));
  clock.t = s1[1].start + 1;
  const s2 = b.schedule('JP').schedule;
  assert.equal(s2[0].id, 'b');
  assert.equal(s2[1].id, 'breaking');
});

test('rotation replays the least recently aired story when everything has aired', () => {
  const items = [item('a', 'JP'), item('b', 'JP', { published: iso(2) })];
  const { b, clock } = setup(items);
  const ids = [];
  for (let i = 0; i < 6; i++) {
    const s = b.schedule('JP').schedule;
    ids.push(s[0].id);
    clock.t = s[0].end;
  }
  assert.deepEqual(ids, ['a', 'b', 'a', 'b', 'a', 'b']);
});

test('station fills short idle gaps contiguously and restarts after long idle', () => {
  const items = [item('a', 'JP'), item('b', 'JP', { published: iso(2) })];
  const { b, clock } = setup(items);
  const s1 = b.schedule('JP').schedule;
  clock.t = s1[1].end + 5 * 60e3;
  const s2 = b.schedule('JP').schedule;
  assert.ok(s2[0].start <= clock.t && clock.t < s2[0].end, 'covers now');
  assert.equal((s2[0].start - s1[0].start) % (60000 + GAP_MS), 0, 'still on the original grid');

  clock.t += 2 * 3600e3;
  const s3 = b.schedule('JP').schedule;
  assert.equal(s3[0].start, clock.t, 'fresh start after long idle');
});

test('timeline persists across restarts', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'chassette-')), 'stations.json');
  const items = [item('a', 'JP'), item('b', 'JP', { published: iso(2) })];
  const first = setup(items, T0, file);
  const s1 = first.b.schedule('JP').schedule;
  first.b.flush();
  const second = setup(items, T0 + 10000, file);
  const s2 = second.b.schedule('JP').schedule;
  assert.equal(s2[0].key, s1[0].key);
  assert.equal(s2[1].key, s1[1].key);
});

test('missing duration falls back to a default slot; empty station has empty schedule', () => {
  const { b } = setup([item('x', 'JP', { duration: null })]);
  const [seg] = b.schedule('JP').schedule;
  assert.equal(seg.end - seg.start, 600000 + GAP_MS);
  assert.deepEqual(setup([]).b.schedule('JP').schedule, []);
});

test('stations are per country and language; English is the default', () => {
  const items = [item('jp-en', 'JP'), item('jp-ja', 'JP', { lang: 'ja' }), item('bbc', 'GB', { scope: 'global' })];
  const { b } = setup(items);
  assert.deepEqual(b.schedule('JP').schedule.map((s) => s.id).slice(0, 2), ['jp-en', 'bbc']);
  assert.deepEqual(b.schedule('JP', 'ja').schedule.map((s) => s.id).slice(0, 1), ['jp-ja']);
  assert.ok(b.stations.has(stationKey('JP', 'en')));
  assert.ok(b.stations.has(stationKey('JP', 'ja')));
});
