'use strict';

// Live broadcast scheduler. Every country is a "station" with one shared timeline: a committed
// current + next segment (fixed start/end in wall-clock ms) and a projected lineup after that.
// All listeners of a station get the same timeline, so they hear the same story at the same second.

const fs = require('node:fs');
const path = require('node:path');
const { rankForStation, WORLDWIDE, DEFAULT_LANGUAGE } = require('./geo');

const GAP_MS = 4000; // short breather between stories (cassette hiss)
const MAX_IDLE_MS = 30 * 60e3; // a station idle longer than this restarts "now"
const COMMITTED_AHEAD = 2; // current + next are fixed; the rest is a forecast

const stationKey = (country, language) => `${country || WORLDWIDE}:${language || DEFAULT_LANGUAGE}`;

class Broadcaster {
  constructor(getItems, opts = {}) {
    this.getItems = getItems;
    this.file = opts.file || null;
    this.now = opts.now || Date.now;
    this.log = opts.log || console;
    this.defaultDuration = opts.defaultDuration || 600;
    this.maxDuration = opts.maxDuration || 2 * 3600;
    this.stations = new Map();
    this.saveTimer = null;
    this.load();
  }

  load() {
    if (!this.file) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const cutoff = this.now() - MAX_IDLE_MS;
      for (const [key, st] of Object.entries(data.stations || {})) {
        const segments = Array.isArray(st.segments) ? st.segments : [];
        if (!segments.some((s) => s.end > cutoff)) continue; // long idle: will restart anyway
        this.stations.set(key, { segments, aired: st.aired && typeof st.aired === 'object' ? st.aired : {} });
      }
    } catch (err) {
      if (err.code !== 'ENOENT') this.log.warn(`[live] could not load ${this.file}: ${err.message}`);
    }
  }

  flush() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ stations: Object.fromEntries(this.stations) }));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      this.log.warn(`[live] could not save ${this.file}: ${err.message}`);
    }
  }

  save() {
    if (!this.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.flush(), 1000);
    this.saveTimer.unref();
  }

  candidates(country, language) {
    return rankForStation(this.getItems() || [], { country, language });
  }

  slotMs(item) {
    const d = Number(item.duration) > 0 ? Math.min(Number(item.duration), this.maxDuration) : this.defaultDuration;
    return Math.round(d * 1000) + GAP_MS;
  }

  /** Newest story not yet aired (local first), otherwise the one aired longest ago. */
  pick(cands, aired, lastId) {
    const fresh = cands.find((c) => !Object.hasOwn(aired, c.id));
    if (fresh) return fresh;
    const pool = cands.length > 1 ? cands.filter((c) => c.id !== lastId) : cands;
    return pool.reduce((a, b) => (aired[b.id] < aired[a.id] ? b : a));
  }

  segment(item, start) {
    return {
      key: `${start.toString(36)}-${item.id}`,
      id: item.id,
      title: item.title,
      source: item.source,
      publisher: item.publisher,
      sourceUrl: item.sourceUrl,
      link: item.link,
      audio: item.audio,
      country: item.country,
      flag: item.flag || item.country || null,
      lang: item.lang,
      tier: item.tier,
      published: item.published,
      duration: item.duration || null,
      start,
      end: start + this.slotMs(item),
    };
  }

  station(key) {
    let st = this.stations.get(key);
    if (!st) {
      st = { segments: [], aired: {} };
      this.stations.set(key, st);
    }
    return st;
  }

  /** The station's timeline from "now": [current, next, ...forecast]. */
  schedule(country, language = DEFAULT_LANGUAGE, count = 6) {
    const now = this.now();
    const st = this.station(stationKey(country, language));
    const cands = this.candidates(country || WORLDWIDE, language);
    let changed = false;

    const tail = st.segments[st.segments.length - 1];
    if (!tail || now - tail.end > MAX_IDLE_MS) {
      if (st.segments.length) changed = true;
      st.segments = [];
    }

    while (cands.length && st.segments.filter((s) => s.end > now).length < COMMITTED_AHEAD) {
      const last = st.segments[st.segments.length - 1];
      const item = this.pick(cands, st.aired, last && last.id);
      const seg = this.segment(item, last ? last.end : now);
      st.segments.push(seg);
      st.aired[item.id] = seg.start;
      changed = true;
    }

    const before = st.segments.length;
    st.segments = st.segments.filter((s) => s.end > now);
    if (st.segments.length !== before) changed = true;

    if (cands.length) {
      const valid = new Set(cands.map((c) => c.id));
      for (const id of Object.keys(st.aired)) {
        if (!valid.has(id)) {
          delete st.aired[id];
          changed = true;
        }
      }
    }

    const out = st.segments.map((s) => ({ ...s, projected: false }));
    if (cands.length && out.length) {
      const aired = { ...st.aired };
      while (out.length < count) {
        const last = out[out.length - 1];
        const item = this.pick(cands, aired, last.id);
        const seg = { ...this.segment(item, last.end), projected: true };
        aired[item.id] = seg.start;
        out.push(seg);
      }
    }

    if (changed) this.save();
    return { serverTime: now, schedule: out.slice(0, count) };
  }
}

module.exports = { Broadcaster, stationKey, GAP_MS };
