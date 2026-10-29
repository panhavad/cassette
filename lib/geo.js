'use strict';

const TZ_COUNTRIES = require('./tz-countries.json');

// Country headers set by common CDNs / proxies (IP-based, reflects where the listener is right now).
const COUNTRY_HEADERS = ['cf-ipcountry', 'x-vercel-ip-country', 'cloudfront-viewer-country', 'x-appengine-country', 'x-country-code'];
const WORLDWIDE = 'WW';
const DEFAULT_LANGUAGE = 'en';

const isCountry = (c) => typeof c === 'string' && /^[A-Z]{2}$/.test(c) && !['XX', 'T1', 'ZZ'].includes(c);

/**
 * Picks the listener's country: manual choice > CDN geo header > device time zone > browser language region.
 * Nothing leaves the server; no third-party IP lookup is used.
 */
function resolveCountry({ override, headers = {}, tz, languages = [] }) {
  const o = String(override || '').toUpperCase();
  if (o === WORLDWIDE) return { country: WORLDWIDE, via: 'manual' };
  if (isCountry(o)) return { country: o, via: 'manual' };

  for (const h of COUNTRY_HEADERS) {
    const v = String(headers[h] || '').toUpperCase();
    if (isCountry(v)) return { country: v, via: 'network' };
  }

  const fromTz = tz && TZ_COUNTRIES[tz];
  if (fromTz) return { country: fromTz, via: 'timezone' };

  for (const l of languages) {
    const region = (l.split('-')[1] || '').toUpperCase();
    if (isCountry(region)) return { country: region, via: 'language' };
  }
  return { country: WORLDWIDE, via: 'default' };
}

/** Parses "en-US,ja;q=0.8" (or a plain comma list) into ordered language tags. */
function parseLanguages(value) {
  return String(value || '')
    .split(',')
    .map((part) => {
      const [tag, ...params] = part.trim().split(';');
      const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
      return { tag: tag.trim(), q: q ? Number(q.slice(2)) : 1 };
    })
    .filter((l) => /^[a-z]{2,3}(-[a-z0-9]+)*$/i.test(l.tag) && l.q > 0)
    .sort((a, b) => b.q - a.q)
    .map((l) => l.tag)
    .slice(0, 10);
}

/**
 * Lineup for a station (country + language). Only stories in the station's language are used.
 *
 * "About" tier: stories from ANY publisher worldwide that talk about the country (it's named in the
 * title, summary or tags). Stories where it's the main subject come first. The publisher's own
 * country doesn't matter. "World" tier: international news services, so the station never runs dry.
 * Non-English stations (opted into by the listener) also fall back to any other story in that language.
 */
function rankForStation(items, { country, language = DEFAULT_LANGUAGE }) {
  const lang = String(language || DEFAULT_LANGUAGE).toLowerCase();
  const time = (i) => Date.parse(i.published) || 0;
  const byDate = (a, b) => time(b) - time(a);
  const flagOf = (i) => (i.mentions && i.mentions[0]) || i.country || null;
  const audible = items.filter((i) => (i.lang || DEFAULT_LANGUAGE).toLowerCase() === lang);
  if (!country || country === WORLDWIDE) return audible.map((i) => ({ ...i, tier: 'world', flag: flagOf(i) })).sort(byDate);

  const rank = (i) => (i.mentions || []).indexOf(country);
  const secondary = (i) => (rank(i) === 0 ? 0 : 1); // main subject first, then passing mentions
  const about = audible
    .filter((i) => rank(i) >= 0)
    .sort((a, b) => secondary(a) - secondary(b) || byDate(a, b))
    .map((i) => ({ ...i, tier: 'about', flag: country }));
  const used = new Set(about.map((i) => i.id));
  const world = audible
    .filter((i) => !used.has(i.id) && i.scope === 'global')
    .sort(byDate)
    .map((i) => ({ ...i, tier: 'world', flag: flagOf(i) }));
  world.forEach((i) => used.add(i.id));
  const others =
    lang === DEFAULT_LANGUAGE
      ? []
      : audible.filter((i) => !used.has(i.id)).sort(byDate).map((i) => ({ ...i, tier: 'world', flag: flagOf(i) }));
  return [...about, ...world, ...others];
}

/** How many stories (in a language) talk about each country. */
function countryCounts(items, language = DEFAULT_LANGUAGE) {
  const counts = {};
  for (const i of items) {
    if ((i.lang || DEFAULT_LANGUAGE).toLowerCase() !== language) continue;
    for (const code of i.mentions || []) counts[code] = (counts[code] || 0) + 1;
  }
  return counts;
}

const normalizeLanguage = (value) => {
  const l = String(value || '').toLowerCase().split('-')[0];
  return /^[a-z]{2,3}$/.test(l) ? l : DEFAULT_LANGUAGE;
};

module.exports = { resolveCountry, parseLanguages, rankForStation, countryCounts, normalizeLanguage, WORLDWIDE, DEFAULT_LANGUAGE };
