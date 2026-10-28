'use strict';

// Regenerates lib/tz-countries.json (IANA time zone -> ISO country code) from the IANA tz database.
// Usage: node scripts/build-tz-map.js

const fs = require('node:fs');
const path = require('node:path');

const BASE = 'https://raw.githubusercontent.com/eggert/tz/main/';

async function get(name) {
  const res = await fetch(BASE + name);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  return res.text();
}

(async () => {
  const [zoneTab, backward] = await Promise.all([get('zone.tab'), get('backward')]);
  const map = {};
  for (const line of zoneTab.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const [cc, , zone] = line.split('\t');
    if (cc && zone) map[zone] = cc;
  }
  const links = backward
    .split('\n')
    .filter((l) => l.startsWith('Link'))
    .map((l) => l.split(/\s+/).slice(1, 3));
  for (let pass = 0; pass < 3; pass++) {
    for (const [target, name] of links) if (map[target] && !map[name]) map[name] = map[target];
  }
  const sorted = Object.fromEntries(Object.entries(map).sort(([a], [b]) => a.localeCompare(b)));
  const out = path.join(__dirname, '..', 'lib', 'tz-countries.json');
  fs.writeFileSync(out, JSON.stringify(sorted) + '\n');
  console.log(`wrote ${Object.keys(sorted).length} zones to ${out}`);
})();
