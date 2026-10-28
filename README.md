# Chassette

Non-stop audio news, played like an old cassette radio.

Chassette collects **audio-only** news episodes from trusted publishers' official podcast feeds
(NPR, BBC, NHK, KBS, ABC Australia, CBC, RTÉ, RNZ, DW, tagesschau, Reuters, Al Jazeera, France 24 and more),
and plays them back-to-back as soon as you open it. Only the episode **title**, **audio file URL**, and **link to the
original source** are used — no article text is copied. Audio streams straight from the publisher.

- Vanilla JS, zero npm dependencies (Node ≥ 20)
- Installable PWA (manifest + service worker, offline shell, lock-screen media controls)
- Docker deployable, auto-updates itself on every new git commit
- Location-aware: local news first, flag shows which country is prioritized

## Location priority

The flag in the header shows the country news is prioritized for. Tap it to pick another country, or
"Worldwide" for no priority.

- Country detection (first match wins): manual choice → CDN geo header (`CF-IPCountry`, `CloudFront-Viewer-Country`,
  `X-Vercel-IP-Country`, …) → device time zone → browser language region. No third-party IP lookup is made.
- The tape plays **Local** stories (publisher in your country) first, then **World** services (`"scope": "global"`).
  Other countries' domestic programmes are left out.
- Only languages your browser accepts are played (English is always included).

## Run

```sh
docker compose up -d --build        # http://localhost:8080
```

Without Docker: `npm start` (or `npm run dev` to run only the web server).

## Auto-update on new commit

Set `GIT_REPO` (see [.env.example](.env.example)) and the container will:

1. clone the repo into the `chassette-live` volume,
2. poll `GIT_BRANCH` every `GIT_POLL_SECONDS` (default 60s),
3. on a new commit: pull, restart the server, and **roll back** automatically if the new commit fails to boot.

Open players notice the new version and reload themselves — between stories, never mid-sentence.

For instant deploys add a webhook pointing at `POST https://<host>/api/hook` with `WEBHOOK_SECRET`
(GitHub: content type `application/json`, secret = `WEBHOOK_SECRET`; GitLab: secret token).

> Changes to the `Dockerfile` itself (e.g. Node version) still need `docker compose up -d --build`.

## Sources

Edit [sources.json](sources.json). Each entry is an RSS podcast feed:

| field         | meaning                                              |
| ------------- | ---------------------------------------------------- |
| `name`        | label shown on the tape                              |
| `publisher`   | publisher name                                       |
| `feed`        | RSS feed URL (only items with an `audio/*` enclosure are used) |
| `site`        | link to the original source                          |
| `country`     | ISO 3166 code of the publisher (`EU` for pan-European) |
| `lang`        | spoken language (`en`, `ja`, `de`, …)                |
| `scope`       | `"global"` for international services played everywhere; omit for domestic news |
| `limit`       | newest N episodes to keep (default `ITEMS_PER_SOURCE`) |
| `maxAgeHours` | drop episodes older than this (default `MAX_AGE_HOURS`) |
| `enabled`     | set `false` to disable                               |

## Config

| env                 | default | |
| ------------------- | ------- | --- |
| `PORT`              | 8080    | host port (compose) |
| `REFRESH_MINUTES`   | 10      | feed refresh interval |
| `ITEMS_PER_SOURCE`  | 2       | default per-source limit |
| `MAX_AGE_HOURS`     | 72      | default freshness window |
| `GIT_REPO`          | –       | repo URL to follow (enables auto-update) |
| `GIT_BRANCH`        | main    | branch to follow |
| `GIT_POLL_SECONDS`  | 60      | poll interval (min 15) |
| `WEBHOOK_SECRET`    | –       | enables `POST /api/hook` |

## Player

Autoplay starts on open (if the browser blocks it, any tap starts the tape).
Keys: `Space` play/pause · `n` next · `p` previous · `←/→` ±15s.
Heard/skipped stories are dimmed; the tape always plays the newest unheard story next.

## Test

```sh
npm test
```

The time-zone → country table ([lib/tz-countries.json](lib/tz-countries.json)) comes from the IANA tz database;
refresh it with `node scripts/build-tz-map.js`.

Audio and titles © their respective publishers. Flag glyphs: Twemoji (CC-BY 4.0) via
country-flag-emoji-polyfill (MIT), see [public/fonts/LICENSE.txt](public/fonts/LICENSE.txt).
