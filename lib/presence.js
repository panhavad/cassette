'use strict';

// Live listener count per station. Each browser tab sends a heartbeat with a random session id while
// the app is open; only sessions that are on air (LIVE) and checked in recently are counted.
// In-memory only: after a restart, counts rebuild within one heartbeat interval.

const SESSION_ID = /^[A-Za-z0-9_-]{8,64}$/;

class Presence {
  constructor(opts = {}) {
    this.ttlMs = opts.ttlMs || 35000; // client heartbeats every 15s; allow two misses
    this.max = opts.max || 100000;
    this.now = opts.now || Date.now;
    this.sessions = new Map(); // id -> { station, seen }
    this.counts = new Map(); // station -> active sessions
  }

  static validId(id) {
    return typeof id === 'string' && SESSION_ID.test(id);
  }

  add(station, delta) {
    const n = (this.counts.get(station) || 0) + delta;
    if (n > 0) this.counts.set(station, n);
    else this.counts.delete(station);
  }

  /** Records a heartbeat. `live: false` (stopped / closing) removes the session immediately. */
  beat(id, station, live) {
    if (!Presence.validId(id)) return false;
    const prev = this.sessions.get(id);
    if (!live) {
      if (prev) this.leave(id);
      return true;
    }
    if (!prev && this.sessions.size >= this.max) {
      this.prune();
      if (this.sessions.size >= this.max) return false;
    }
    if (prev && prev.station !== station) this.add(prev.station, -1);
    if (!prev || prev.station !== station) this.add(station, 1);
    this.sessions.set(id, { station, seen: this.now() });
    return true;
  }

  leave(id) {
    const prev = this.sessions.get(id);
    if (!prev) return;
    this.sessions.delete(id);
    this.add(prev.station, -1);
  }

  /** Drops sessions that stopped sending heartbeats (tab killed, network gone, device asleep). */
  prune() {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, s] of this.sessions) if (s.seen < cutoff) this.leave(id);
  }

  count(station) {
    return this.counts.get(station) || 0;
  }

  start(intervalMs = 10000) {
    this.timer = setInterval(() => this.prune(), intervalMs);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
  }
}

module.exports = { Presence };
