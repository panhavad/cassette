# Chassette

Non-stop audio news, played like an old cassette radio.

Chassette collects **audio-only** news episodes from trusted publishers' official podcast feeds
(NPR, BBC World Service, CBC, The Guardian, The New York Times, WSJ, PBS, RFI), and plays them
back-to-back as soon as you open it. Only the episode **title**, **audio file URL**, and **link to the
original source** are used — no article text is copied. Audio streams straight from the publisher.

- Vanilla JS, zero npm dependencies (Node ≥ 20)
- Installable PWA (manifest + service worker, offline shell, lock-screen media controls)
- Docker deployable, auto-updates itself on every new git commit

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

Audio and titles © their respective publishers.
