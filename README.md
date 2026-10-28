# Chassette

Live audio-news radio with an 8-bit cassette look.

Chassette finds news that publishers already offer **as audio** and plays it as a live radio station:
- article audio from news sites ("listen to this article" read-outs) — The Japan Times, Bloomberg, NBC News,
  TIME, Los Angeles Times, CNBC, Business Insider, NPR, Deseret News, The Straits Times, The Business Times,
  SCMP, Bangkok Post, Mint, The Indian Express and Daily Maverick;
- news bulletins and podcasts from NPR, BBC, NHK, KBS, ABC, CBC, RTÉ, RNZ, Reuters, Al Jazeera, France 24 and others.

Only the **title** (from the site's RSS feed), the **audio file URL**, and the **link to the original article** are
used. Article text is never stored or shown. Audio streams straight from the publisher.

- Vanilla JS, zero npm dependencies (Node ≥ 20)
- Installable PWA, keeps playing in the background, lock-screen controls
- Docker deployable, auto-updates itself on every new git commit

## Live, like radio

Every **country + language** pair is one station with one shared timeline. Everyone tuned to the same station
hears the same story at the same second. Opening the app (or pressing **LIVE**) joins mid-story, at the live
position; there is no seeking, skipping or rewinding.

- Controls: **STOP** and **LIVE** only. `Space` toggles, `L` = live, `S` = stop.
- The cassette rolls while on air (reels turn, tape runs past the head). Long titles scroll like a radio display.
- **Up next** shows the coming stories with start times (`~` = forecast). It is display-only.
- The server commits the current and next story per station. The rest is a forecast that can change when
  breaking news arrives; the newest story the station hasn't aired yet always goes next.
- Between stories (or if a stream fails) a quiet tape hiss plays until the next slot. That keeps everyone aligned
  and keeps background playback alive on mobile.
- Station timelines are saved under `DATA_DIR` (the `chassette-data` volume), so restarts and redeploys don't
  jump listeners.

## Language

**English by default.** The `EN` pill lets a listener pick another available language (Japanese, German,
French, Thai, Indonesian, Vietnamese, …). The station then plays only that language, home country first.

## Location

The flag pill shows the country the station is for. Tap it to pick another, or "Worldwide".

- Detection (first match wins): manual choice → CDN geo header (`CF-IPCountry`, `CloudFront-Viewer-Country`,
  `X-Vercel-IP-Country`, …) → device time zone → browser language region. No third-party IP lookup is made.
- Order: **local** publishers first, then **world** services (`"scope": "global"`). In English, other
  countries' domestic news is left out.

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

Open players pick up the new version between stories while visible, or right away when stopped.

For instant deploys add a webhook pointing at `POST https://<host>/api/hook` with `WEBHOOK_SECRET`
(GitHub: content type `application/json`, secret = `WEBHOOK_SECRET`; GitLab: secret token).

> Changes to the `Dockerfile` itself (e.g. Node version) still need `docker compose up -d --build`.

## Sources

Edit [sources.json](sources.json). Two kinds of entry:

**Podcast / bulletin feeds** (default): an RSS feed whose items carry an `audio/*` enclosure.

**Article audio** (`"type": "articles"`): the site's RSS feed of articles. Each new article page is opened once,
and only its audio URL is kept. Pick an extractor with `extract`:

| `extract`     | finds the audio in                                                     |
| ------------- | ---------------------------------------------------------------------- |
| `beyondwords` | BeyondWords/SpeechKit player (`projectId`) → BeyondWords player API MP3 |
| `jsonld`      | schema.org `AudioObject` in JSON-LD                                    |
| `audio`       | an `<audio src>` / `<source type="audio/…">` tag                       |
| `pattern`     | a site-specific regex in `pattern` (first capture group = audio URL)   |

Common fields:

| field         | meaning                                              |
| ------------- | ---------------------------------------------------- |
| `name`        | label shown on the tape                              |
| `publisher`   | publisher name                                       |
| `feed`        | RSS/Atom feed URL                                    |
| `site`        | link to the original source                          |
| `country`     | ISO 3166 code of the publisher (`EU` for pan-European) |
| `lang`        | spoken language (`en`, `ja`, `de`, …)                |
| `scope`       | `"global"` for international coverage; omit for domestic news |
| `limit`       | newest N stories to keep (default `ITEMS_PER_SOURCE`) |
| `scan`        | article sources: newest N articles to check (default 12) |
| `maxAgeHours` | drop stories older than this (default `MAX_AGE_HOURS`) |
| `enabled`     | set `false` to disable                               |

Durations come from the feed or player API. If those don't give one, they're measured from the MP3/M4A header.

## Config

| env                 | default | |
| ------------------- | ------- | --- |
| `PORT`              | 8080    | host port (compose) |
| `REFRESH_MINUTES`   | 10      | feed refresh interval |
| `ITEMS_PER_SOURCE`  | 2       | default per-source limit |
| `MAX_AGE_HOURS`     | 72      | default freshness window |
| `DATA_DIR`          | `./data` (`/srv/data` in Docker) | station timelines |
| `GIT_REPO`          | –       | repo URL to follow (enables auto-update) |
| `GIT_BRANCH`        | main    | branch to follow |
| `GIT_POLL_SECONDS`  | 60      | poll interval (min 15) |
| `WEBHOOK_SECRET`    | –       | enables `POST /api/hook` |

## Test

```sh
npm test
```

Generated assets: [lib/tz-countries.json](lib/tz-countries.json) (IANA tz database, `node scripts/build-tz-map.js`)
and [public/audio/hiss.wav](public/audio/hiss.wav) (`node scripts/build-hiss.js`).

Audio and titles © their respective publishers. Pixel font: Press Start 2P (SIL OFL 1.1, see
[public/fonts/OFL-PressStart2P.txt](public/fonts/OFL-PressStart2P.txt)). Flag glyphs: Twemoji (CC-BY 4.0) via
country-flag-emoji-polyfill (MIT), see [public/fonts/LICENSE.txt](public/fonts/LICENSE.txt).
