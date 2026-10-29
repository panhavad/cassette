'use strict';

// Finds which countries a story is about, from its title and short feed metadata (summary, categories,
// keywords). Only the resulting country codes are kept; the text itself is never stored or served.

const { countries: COUNTRIES, notCountry: NOT_COUNTRY } = require('./countries.json');

const CODES = Object.keys(COUNTRIES);
const NO_WORD_BOUNDARY = /[\u0E00-\u0E7F\u3040-\u30FF\u3400-\u9FFF\uAC00-\uD7AF]/; // Thai, kana, CJK, Hangul

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function compile(entries) {
  // entries: [term, code|null, weak]
  const lookup = new Map();
  for (const [term, code, weak] of entries) if (!lookup.has(term)) lookup.set(term, { code, weak });
  const terms = [...lookup.keys()].sort((a, b) => b.length - a.length);
  const words = terms.filter((t) => !NO_WORD_BOUNDARY.test(t)).map(escapeRe);
  const scripts = terms.filter((t) => NO_WORD_BOUNDARY.test(t)).map(escapeRe);
  const parts = [];
  if (words.length) parts.push(`(?<![\\p{L}\\p{N}])(?:${words.join('|')})(?![\\p{L}\\p{N}])`);
  if (scripts.length) parts.push(`(?:${scripts.join('|')})`);
  return { re: parts.length ? new RegExp(parts.join('|'), 'gu') : null, lookup };
}

const matchers = new Map();

function matcher(lang) {
  const key = lang && lang !== 'en' ? lang : 'en';
  if (matchers.has(key)) return matchers.get(key);
  const entries = NOT_COUNTRY.map((t) => [t, null, false]);
  for (const code of CODES) {
    for (const t of COUNTRIES[code].terms) entries.push([t, code, false]);
    for (const t of COUNTRIES[code].weak || []) entries.push([t, code, true]);
  }
  if (key !== 'en') {
    // Country names in the story's own language (e.g. カンボジア, Kambodscha), from the runtime's ICU data.
    let names = null;
    try {
      names = new Intl.DisplayNames([key], { type: 'region', fallback: 'none' });
    } catch {
      names = null;
    }
    if (names) {
      for (const code of CODES) {
        const n = names.of(code);
        if (n && n.length >= 2 && n !== COUNTRIES[code].name) entries.push([n, code, false]);
      }
    }
  }
  const m = compile(entries);
  matchers.set(key, m);
  return m;
}

/**
 * Countries a story is about, strongest first: countries named in the title, then those named only in
 * the summary/keywords. Ambiguous ("weak") words count only when the country is also named clearly.
 */
function findMentions({ title = '', context = '' }, lang = 'en') {
  const { re, lookup } = matcher(lang);
  if (!re) return [];
  const scan = (text) => {
    const strong = new Map();
    const weak = new Set();
    if (!text) return { strong, weak };
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const hit = lookup.get(m[0]);
      if (!hit || !hit.code) continue;
      if (hit.weak) weak.add(hit.code);
      else strong.set(hit.code, (strong.get(hit.code) || 0) + 1);
    }
    return { strong, weak };
  };
  const t = scan(title);
  const c = scan(context);
  const confirmed = (code) => t.strong.has(code) || c.strong.has(code);
  const order = [];
  const push = (code) => !order.includes(code) && order.push(code);
  [...t.strong.entries()].sort((a, b) => b[1] - a[1]).forEach(([code]) => push(code));
  [...t.weak].filter(confirmed).forEach(push);
  [...c.strong.entries()].sort((a, b) => b[1] - a[1]).forEach(([code]) => push(code));
  [...c.weak].filter(confirmed).forEach(push);
  return order;
}

const isCountry = (code) => Object.hasOwn(COUNTRIES, code);
const countryCodes = () => CODES.slice();

module.exports = { findMentions, isCountry, countryCodes };
