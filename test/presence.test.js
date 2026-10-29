'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Presence } = require('../lib/presence');

const ID = (n) => `session-${String(n).padStart(4, '0')}`;

function setup(opts = {}) {
  const clock = { t: 1_000_000 };
  const p = new Presence({ ttlMs: 45000, now: () => clock.t, ...opts });
  return { p, clock };
}

test('counts only sessions that are live on the same station', () => {
  const { p } = setup();
  p.beat(ID(1), 'JP:en', true);
  p.beat(ID(2), 'JP:en', true);
  p.beat(ID(3), 'JP:ja', true);
  p.beat(ID(4), 'JP:en', false);
  assert.equal(p.count('JP:en'), 2);
  assert.equal(p.count('JP:ja'), 1);
  assert.equal(p.count('US:en'), 0);
});

test('repeated heartbeats do not double count; stopping removes the listener', () => {
  const { p } = setup();
  for (let i = 0; i < 5; i++) p.beat(ID(1), 'JP:en', true);
  assert.equal(p.count('JP:en'), 1);
  p.beat(ID(1), 'JP:en', false);
  assert.equal(p.count('JP:en'), 0);
  assert.equal(p.sessions.size, 0);
});

test('switching station moves the listener', () => {
  const { p } = setup();
  p.beat(ID(1), 'JP:en', true);
  p.beat(ID(1), 'SG:en', true);
  assert.equal(p.count('JP:en'), 0);
  assert.equal(p.count('SG:en'), 1);
});

test('sessions without a recent heartbeat expire', () => {
  const { p, clock } = setup();
  p.beat(ID(1), 'JP:en', true);
  clock.t += 30000;
  p.beat(ID(2), 'JP:en', true);
  clock.t += 20000;
  p.prune();
  assert.equal(p.count('JP:en'), 1, 'first session (50s silent) dropped, second (20s) kept');
  clock.t += 30000;
  p.prune();
  assert.equal(p.count('JP:en'), 0);
});

test('rejects malformed ids and caps memory', () => {
  const { p } = setup({ max: 2 });
  assert.equal(p.beat('x', 'JP:en', true), false);
  assert.equal(p.beat('../../etc', 'JP:en', true), false);
  assert.equal(p.beat({}, 'JP:en', true), false);
  assert.equal(p.beat(ID(1), 'JP:en', true), true);
  assert.equal(p.beat(ID(2), 'JP:en', true), true);
  assert.equal(p.beat(ID(3), 'JP:en', true), false, 'full');
  assert.equal(p.beat(ID(1), 'JP:en', true), true, 'existing session still refreshes');
  assert.equal(p.count('JP:en'), 2);
});
