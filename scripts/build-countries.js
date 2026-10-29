'use strict';

// Regenerates lib/countries.json: for every country, the words that show a story is about it
// (names, short names, demonyms, capital, cities over 1M people). Source: Wikidata (CC0), plus the
// curated aliases / exclusions below. Usage: node scripts/build-countries.js

const fs = require('node:fs');
const path = require('node:path');

const ENDPOINT = 'https://query.wikidata.org/sparql?format=json&query=';
const UA = 'Chassette/1.1 (country gazetteer build; https://github.com/panhavad/cassette)';

const COUNTRIES_QUERY = `
SELECT ?iso ?label ?demonym ?capitalLabel ?short WHERE {
  ?c wdt:P297 ?iso .
  FILTER NOT EXISTS { ?c wdt:P576 ?end }
  ?c rdfs:label ?label FILTER(lang(?label)='en')
  OPTIONAL { ?c wdt:P1549 ?demonym FILTER(lang(?demonym)='en') }
  OPTIONAL { ?c wdt:P36 ?capital . ?capital rdfs:label ?capitalLabel FILTER(lang(?capitalLabel)='en') }
  OPTIONAL { ?c wdt:P1813 ?short FILTER(lang(?short)='en') }
}`;

const CITIES_QUERY = `
SELECT ?iso ?cityLabel WHERE {
  ?city wdt:P1082 ?pop . FILTER(?pop > 1000000)
  ?city wdt:P31/wdt:P279? wd:Q515 .
  ?city wdt:P17 ?c . ?c wdt:P297 ?iso .
  ?city rdfs:label ?cityLabel FILTER(lang(?cityLabel)='en')
} GROUP BY ?iso ?cityLabel`;

// Extra ways news refers to a country.
const ALIASES = {
  US: ['US', 'U.S.', 'USA', 'U.S.A.', 'America', 'Americans', 'Washington', 'White House', 'Pentagon', 'Wall Street', 'New Jersey', 'New Mexico', 'New York', 'California', 'Texas', 'Florida'],
  GB: ['UK', 'U.K.', 'Britain', 'Great Britain', 'British', 'Briton', 'Britons', 'England', 'Scotland', 'Scottish', 'Wales', 'Welsh', 'Northern Ireland', 'Downing Street', 'Westminster', 'London'],
  KR: ['Korea', 'Korean', 'Koreans', 'South Korean', 'South Koreans'],
  KP: ['North Korea', 'North Korean', 'North Koreans', 'Pyongyang', 'DPRK'],
  CN: ['China', 'Chinese', 'Beijing', 'PRC'],
  TW: ['Taiwan', 'Taiwanese', 'Taipei'],
  HK: ['Hong Kong', 'Hongkongers'],
  MO: ['Macau', 'Macao'],
  RU: ['Russia', 'Russian', 'Russians', 'Kremlin', 'Moscow'],
  UA: ['Ukraine', 'Ukrainian', 'Ukrainians', 'Kyiv', 'Kiev'],
  AE: ['UAE', 'Emirati', 'Emiratis', 'Dubai', 'Abu Dhabi'],
  SA: ['Saudi', 'Saudis', 'Saudi Arabia', 'Riyadh'],
  CD: ['Congo', 'Congolese', 'DR Congo', 'DRC', 'Kinshasa'],
  CG: ['Congo-Brazzaville', 'Brazzaville'],
  CZ: ['Czech Republic', 'Czechia', 'Czech'],
  NL: ['Netherlands', 'Dutch', 'Holland', 'The Hague'],
  VA: ['Vatican', 'Holy See'],
  PS: ['Palestine', 'Palestinian', 'Palestinians', 'Gaza', 'West Bank'],
  IL: ['Israel', 'Israeli', 'Israelis', 'Tel Aviv'],
  MM: ['Myanmar', 'Burma', 'Burmese'],
  CI: ['Ivory Coast', "Côte d'Ivoire", "Cote d'Ivoire"],
  TR: ['Turkey', 'Türkiye', 'Turkiye', 'Turkish', 'Ankara', 'Istanbul'],
  CV: ['Cape Verde', 'Cabo Verde'],
  SZ: ['Eswatini', 'Swaziland'],
  MK: ['North Macedonia', 'Macedonia'],
  BA: ['Bosnia', 'Bosnian', 'Bosnia and Herzegovina'],
  VN: ['Vietnam', 'Viet Nam', 'Vietnamese'],
  LA: ['Laos', 'Lao'],
  IR: ['Iran', 'Iranian', 'Iranians', 'Tehran'],
  TL: ['East Timor', 'Timor-Leste', 'Timorese'],
  AU: ['Australia', 'Australian', 'Australians', 'Aussie', 'New South Wales', 'Queensland'],
  NZ: ['New Zealand', 'Kiwi', 'Kiwis'],
  IN: ['India', 'Indian', 'Indians', 'New Delhi', 'Delhi'],
  JP: ['Japan', 'Japanese', 'Tokyo'],
  FR: ['France', 'French', 'Élysée', 'Elysee'],
  DE: ['Germany', 'German', 'Germans', 'Berlin', 'Bundestag'],
  IT: ['Italy', 'Italian', 'Italians'],
  ES: ['Spain', 'Spanish', 'Spaniards'],
  PH: ['Philippines', 'Philippine', 'Filipino', 'Filipinos', 'Manila'],
  KH: ['Cambodia', 'Cambodian', 'Cambodians', 'Khmer', 'Phnom Penh', 'Siem Reap'],
  TH: ['Thailand', 'Thai', 'Thais', 'Bangkok'],
  MY: ['Malaysia', 'Malaysian', 'Malaysians', 'Kuala Lumpur'],
  SG: ['Singapore', 'Singaporean', 'Singaporeans'],
  ID: ['Indonesia', 'Indonesian', 'Indonesians', 'Jakarta', 'Bali'],
  VE: ['Venezuela', 'Venezuelan', 'Venezuelans', 'Caracas'],
  EG: ['Egypt', 'Egyptian', 'Cairo'],
  LB: ['Lebanon', 'Lebanese', 'Beirut', 'Hezbollah'],
  SY: ['Syria', 'Syrian', 'Syrians', 'Damascus'],
  YE: ['Yemen', 'Yemeni', 'Houthi', 'Houthis'],
};

// Ambiguous on their own (e.g. Georgia the US state): only count when the same story also has a
// non-ambiguous term for that country.
const WEAK = {
  GE: ['Georgia', 'Georgian', 'Georgians'],
  JE: ['Jersey'],
  CL: ['Santiago'],
  JM: ['Kingston'],
  GY: ['Georgetown'],
};

// Never use these (everyday words, or names shared by several places).
const EXCLUDE = new Set(['Male', 'Victoria', 'Kingston', 'Georgetown', 'Santiago', 'Jersey', 'City', 'Hamilton', 'Valencia', 'Hyderabad', 'San Jose', 'Córdoba', 'Cordoba', 'Birmingham', 'Of', 'Nice', 'Reading', 'Mobile', 'Split', 'Bath', 'Cork', 'Orange', 'Florence', 'Georgia']);

// Region phrases, people and things that contain a country word but aren't about that country.
const NOT_COUNTRY = ['Latin America', 'Latin American', 'Latin Americans', 'South America', 'South American', 'South Americans', 'North America', 'North American', 'North Americans', 'Central America', 'Central American', 'Central Americans', 'Native American', 'Native Americans', 'American Indian', 'Indian Ocean', 'Korean Peninsula', 'Arabian Sea', 'South China Sea', 'East China Sea', 'Persian Gulf', 'Gulf of Mexico', 'New Guinea',
  'Mark Cuban', 'Michael Jordan', 'Jordan Peterson', 'Indiana Jones', 'French fries', 'French Open', 'Dutch oven', 'Swiss cheese', 'Turkish delight', 'Danish pastry', 'Brazil nut', 'Panama hat', 'Japanese knotweed', 'English Channel'];

async function sparql(query) {
  const res = await fetch(ENDPOINT + encodeURIComponent(query), { headers: { 'user-agent': UA, accept: 'application/sparql-results+json' } });
  if (!res.ok) throw new Error(`Wikidata HTTP ${res.status}`);
  return (await res.json()).results.bindings;
}

const fold = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const clean = (s) => s.replace(/,? D\.C\.$/, '').replace(/\s*\(.*\)$/, '').trim();

(async () => {
  const [countryRows, cityRows] = await Promise.all([sparql(COUNTRIES_QUERY), sparql(CITIES_QUERY)]);
  const out = {};
  const add = (iso, term, weak = false) => {
    if (!out[iso] || !term) return;
    term = clean(term);
    if (term.length < 2 || EXCLUDE.has(term)) return;
    const list = weak ? out[iso].weak : out[iso].terms;
    for (const t of new Set([term, fold(term)])) if (!list.includes(t)) list.push(t);
  };

  for (const r of countryRows) {
    const iso = r.iso.value;
    if (!/^[A-Z]{2}$/.test(iso)) continue;
    out[iso] ||= { name: r.label.value, terms: [], weak: [] };
  }
  for (const r of countryRows) {
    const iso = r.iso.value;
    if (!out[iso]) continue;
    add(iso, r.label.value);
    if (r.short && /^[A-Z.]{3,}$|^[A-Z][a-z]/.test(r.short.value)) add(iso, r.short.value);
    if (r.demonym) {
      add(iso, r.demonym.value);
      if (!/s$/.test(r.demonym.value)) add(iso, `${r.demonym.value}s`);
    }
    if (r.capitalLabel) add(iso, r.capitalLabel.value);
  }

  // Cities over 1M: only names that point to a single country.
  const cityCountries = new Map();
  for (const r of cityRows) {
    const name = clean(r.cityLabel.value);
    if (/[–—/]/.test(name) || /\b(Prefecture|Province|District|County|Metropolitan|Region|Municipality)\b/.test(name)) continue;
    if (!cityCountries.has(name)) cityCountries.set(name, new Set());
    cityCountries.get(name).add(r.iso.value);
  }
  for (const [name, isos] of cityCountries) if (isos.size === 1) add([...isos][0], name);

  for (const [iso, terms] of Object.entries(ALIASES)) for (const t of terms) add(iso, t);
  for (const [iso, terms] of Object.entries(WEAK)) {
    if (!out[iso]) continue;
    out[iso].terms = out[iso].terms.filter((t) => !terms.includes(t));
    for (const t of terms) if (!out[iso].weak.includes(t)) out[iso].weak.push(t);
  }

  // A term may only belong to one country. Curated aliases win; other terms claimed twice are dropped.
  const forced = new Map();
  for (const [iso, terms] of Object.entries({ ...ALIASES, ...WEAK })) for (const t of terms) forced.set(t, iso);
  const owner = new Map();
  for (const [iso, c] of Object.entries(out)) {
    for (const t of [...c.terms, ...c.weak]) {
      if (forced.has(t)) owner.set(t, forced.get(t));
      else owner.set(t, owner.has(t) && owner.get(t) !== iso ? null : iso);
    }
  }
  for (const [iso, c] of Object.entries(out)) {
    c.terms = c.terms.filter((t) => owner.get(t) === iso).sort();
    c.weak = c.weak.filter((t) => owner.get(t) === iso).sort();
    if (!c.weak.length) delete c.weak;
  }

  const sorted = Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
  const file = path.join(__dirname, '..', 'lib', 'countries.json');
  fs.writeFileSync(file, JSON.stringify({ notCountry: NOT_COUNTRY, countries: sorted }, null, 0).replace(/\],"/g, '],\n"') + '\n');
  console.log(`wrote ${Object.keys(sorted).length} countries to ${file}`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
