(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const audio = $('audio');
  const VERSION = document.querySelector('meta[name="app-version"]').content;
  const COUNTRY_KEY = 'chassette:country';
  const LANG_KEY = 'chassette:language';
  const WAS_LIVE_KEY = 'chassette:was-live';
  const RELOADED_KEY = 'chassette:reloaded-at';
  const HISS = '/audio/hiss.wav';
  const WORLDWIDE = 'WW';
  const REFRESH_MS = 60 * 1000;
  const PRESENCE_MS = 15 * 1000;
  const RETRY_MS = 5000;
  const DRIFT_CHECK_MS = 30 * 1000;
  const MAX_DRIFT_S = 5;
  const BAR_CELLS = 24;
  const NEXT_SHOWN = 5;

  // Server-synchronised clock: everyone on a station follows the same wall-clock schedule.
  let clockOffset = 0;
  const now = () => Date.now() + clockOffset;

  let schedule = [];
  let geo = { country: null, via: null, detected: null, detectedVia: null, countries: [], language: 'en', languages: ['en'] };
  let live = false;
  let mode = null; // 'news' | 'hiss'
  let segment = null;
  let loadToken = 0;
  let switching = false;
  let blocked = false;
  let updatePending = false;
  let lastTry = 0;
  let lastDrift = 0;
  let fetching = null;
  let signalLost = false;

  // Listener presence. The id lives for the whole tab (reloads and navigating away and back reuse it),
  // so a lost goodbye beacon can never make one tab count twice. A duplicated tab inherits the stored
  // id; it asks the other open tabs and picks a fresh id if that one is already in use.
  const SESSION_KEY = 'chassette:session';
  const freshId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  let sessionId = (() => {
    try {
      const saved = sessionStorage.getItem(SESSION_KEY);
      if (/^[0-9a-f]{32}$/.test(saved || '')) return saved;
      const id = freshId();
      sessionStorage.setItem(SESSION_KEY, id);
      return id;
    } catch {
      return freshId();
    }
  })();
  const tabs = 'BroadcastChannel' in window ? new BroadcastChannel('chassette-presence') : null;
  if (tabs) {
    tabs.onmessage = (e) => {
      const msg = e.data || {};
      if (msg.ask === sessionId) tabs.postMessage({ taken: sessionId });
      else if (msg.taken === sessionId) {
        sessionId = freshId();
        try { sessionStorage.setItem(SESSION_KEY, sessionId); } catch { /* storage disabled */ }
        heartbeat();
      }
    };
    tabs.postMessage({ ask: sessionId });
  }
  let lastBeat = 0;
  let beatChain = Promise.resolve();
  let presenceKey = '';
  let listeners = null;

  /* Helpers */

  const regionNames = (() => {
    try { return new Intl.DisplayNames(['en'], { type: 'region' }); } catch { return null; }
  })();
  const languageNames = (() => {
    try { return new Intl.DisplayNames(['en'], { type: 'language' }); } catch { return null; }
  })();
  const languageOf = (code) => {
    try { return (languageNames && languageNames.of(code)) || code; } catch { return code; }
  };
  const flagOf = (code) => (code && /^[A-Z]{2}$/.test(code) && code !== WORLDWIDE
    ? String.fromCodePoint(...[...code].map((c) => 0x1f1a5 + c.charCodeAt(0)))
    : '🌐');
  const nameOf = (code) => {
    if (!code || code === WORLDWIDE) return 'Worldwide';
    try { return (regionNames && regionNames.of(code)) || code; } catch { return code; }
  };
  const VIA = { manual: 'chosen by you', network: 'from your network', timezone: 'from your time zone', language: 'from your browser language', default: 'location unknown' };
  const fmt = (sec) => {
    if (!Number.isFinite(sec) || sec < 0) sec = 0;
    sec = Math.floor(sec);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = String(sec % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
  };
  const clockText = (ms, seconds) => new Date(ms).toLocaleTimeString([], {
    hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}), hour12: false,
  });
  const onAir = () => {
    const t = now();
    return schedule.find((s) => s.start <= t && t < s.end) || null;
  };
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  /* Marquee: titles that don't fit scroll in a loop, like a radio display. */

  const MARQUEE_SPEED = 32; // px per second

  function setMarquee(node, text) {
    if (node.dataset.text === text) return;
    node.dataset.text = text;
    const copy = el('span', 'seg copy', text);
    copy.setAttribute('aria-hidden', 'true');
    const track = el('span', 'track');
    track.append(el('span', 'seg', text), copy);
    node.replaceChildren(track);
    if (node.isConnected) fitMarquee(node);
  }

  function fitMarquee(node) {
    const seg = node.querySelector('.seg');
    if (!seg) return;
    node.classList.remove('run');
    if (seg.getBoundingClientRect().width <= node.clientWidth + 1) return;
    node.classList.add('run');
    const shift = seg.getBoundingClientRect().width;
    node.style.setProperty('--shift', `-${shift.toFixed(1)}px`);
    node.style.setProperty('--dur', `${Math.max(4, shift / MARQUEE_SPEED).toFixed(1)}s`);
    node.style.setProperty('--steps', String(Math.max(1, Math.round(shift / 2))));
  }

  const fitAll = (root = document) => root.querySelectorAll('.marquee').forEach(fitMarquee);

  /* Rendering */

  const bar = $('bar');
  const cells = Array.from({ length: BAR_CELLS }, () => bar.appendChild(el('i')));

  function render() {
    renderNow();
    renderProgress();
    renderNext();
    renderState();
  }

  function renderState() {
    const playing = live && !audio.paused;
    document.body.classList.toggle('live-on', live);
    document.body.classList.toggle('playing', playing);
    document.body.classList.toggle('blocked', blocked);
    $('lamp').textContent = live ? 'ON AIR' : 'STOPPED';
    const liveKey = $('live');
    liveKey.setAttribute('aria-pressed', String(live));
    $('stop').setAttribute('aria-pressed', String(!live));
    let status = '';
    if (blocked) status = 'PRESS LIVE TO TUNE IN';
    else if (!schedule.length) status = 'NO SIGNAL · RETRYING';
    else if (live && signalLost) status = 'SIGNAL LOST · NEXT STORY SOON';
    $('status').textContent = status;
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
  }

  function shown() {
    return live && segment && now() < segment.end ? segment : onAir();
  }

  function renderNow() {
    const seg = shown();
    $('labelFlag').textContent = seg ? flagOf(seg.country) : '';
    $('labelSource').textContent = seg ? seg.source : 'NO TAPE';
    setMarquee($('labelTitle'), seg ? seg.title : '');
    setMarquee($('nowTitle'), seg ? seg.title : 'NO SIGNAL');
    const src = $('nowSource');
    if (seg) {
      src.textContent = seg.publisher && seg.publisher !== seg.source ? `${seg.source} · ${seg.publisher}` : seg.source;
      src.href = seg.link || seg.sourceUrl;
    } else {
      src.textContent = '';
      src.removeAttribute('href');
    }
    document.title = seg ? `${live ? '▶ ' : ''}${seg.title} — Chassette` : 'Chassette';
  }

  function renderProgress() {
    const t = now();
    $('clock').textContent = clockText(t, true);
    const seg = shown();
    const total = seg ? (seg.end - seg.start) / 1000 : 0;
    const elapsed = seg ? Math.min(total, Math.max(0, (t - seg.start) / 1000)) : 0;
    const p = total ? elapsed / total : 0;
    const lit = Math.round(p * BAR_CELLS);
    cells.forEach((c, i) => c.classList.toggle('on', i < lit));
    $('elapsed').textContent = fmt(elapsed);
    $('remain').textContent = `-${fmt(total - elapsed)}`;
    const left = 3 + Math.round(6 * (1 - p));
    const right = 3 + Math.round(6 * p);
    $('packL').setAttribute('r', String(left));
    $('packR').setAttribute('r', String(right));
    $('ringL').setAttribute('r', String(left - 1.5));
    $('ringR').setAttribute('r', String(right - 1.5));
  }

  let nextKey = '';
  function renderNext() {
    const t = now();
    const current = shown();
    const upcoming = schedule.filter((s) => s.start > t && (!current || s.key !== current.key)).slice(0, NEXT_SHOWN);
    const key = upcoming.map((s) => s.key).join('|');
    if (key === nextKey && key) return;
    nextKey = key;
    const ol = $('next');
    if (!upcoming.length) {
      ol.replaceChildren(el('li', 'empty', schedule.length ? 'END OF TAPE' : '—'));
      return;
    }
    ol.replaceChildren(...upcoming.map((s) => {
      const li = el('li');
      const src = el('span', 'src');
      src.append(el('span', 'flag', flagOf(s.country)), s.source);
      const ttl = el('span', 'ttl marquee');
      setMarquee(ttl, s.title);
      li.append(el('span', 'at', `${s.projected ? '~' : ''}${clockText(s.start)}`), src, ttl);
      return li;
    }));
    fitAll(ol);
  }

  function renderWhere() {
    const { country, via, detected, detectedVia, countries } = geo;
    $('whereFlag').textContent = flagOf(country);
    $('whereName').textContent = nameOf(country);
    $('where').title = `Station: ${nameOf(country)} (${VIA[via] || via}). Tap to change.`;
    const select = $('whereSelect');
    const chosen = localStorage.getItem(COUNTRY_KEY) || '';
    const opt = (value, text) => {
      const o = el('option', null, text);
      o.value = value;
      return o;
    };
    const codes = [...new Set([...countries, detected].filter((c) => c && c !== WORLDWIDE))]
      .sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
    select.replaceChildren(
      opt('', `Auto: ${flagOf(detected)} ${nameOf(detected)} (${VIA[detectedVia] || detectedVia})`),
      ...codes.map((c) => opt(c, `${flagOf(c)} ${nameOf(c)}`)),
      opt(WORLDWIDE, '🌐 Worldwide'),
    );
    select.value = chosen;

    const lang = geo.language || 'en';
    $('langName').textContent = lang.toUpperCase();
    $('langPill').title = `Language: ${languageOf(lang)}. Tap to change.`;
    const langs = [...new Set(['en', ...geo.languages, lang])];
    $('langSelect').replaceChildren(...langs.map((l) => opt(l, `${l.toUpperCase()} · ${languageOf(l)}${l === 'en' ? ' (default)' : ''}`)));
    $('langSelect').value = lang;
  }

  function setMediaSession(seg) {
    if (!('mediaSession' in navigator) || !seg) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: seg.title,
      artist: seg.source,
      album: `Chassette · ${nameOf(geo.country)} · ${(geo.language || 'en').toUpperCase()} live`,
      artwork: [{ src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' }],
    });
  }

  /* Live player */

  function tryPlay() {
    const p = audio.play();
    if (!p) return;
    p.then(() => {
      blocked = false;
      renderState();
    }).catch((err) => {
      if (err.name !== 'NotAllowedError') return; // AbortError: superseded by a newer source
      blocked = true;
      live = false;
      render();
    });
  }

  function setSource(url, loop) {
    switching = true;
    audio.loop = loop;
    audio.src = url;
    tryPlay();
  }

  function loadSegment(seg) {
    segment = seg;
    mode = 'news';
    signalLost = false;
    lastDrift = Date.now();
    const token = ++loadToken;
    audio.addEventListener('loadedmetadata', () => {
      if (token !== loadToken) return;
      const offset = (now() - seg.start) / 1000;
      if (Number.isFinite(audio.duration) && offset >= audio.duration - 0.5) playHiss();
      else if (offset > 1) audio.currentTime = offset;
    }, { once: true });
    setSource(seg.audio, false);
    setMediaSession(seg);
    nextKey = '';
    render();
  }

  // Tape hiss fills the gap until the next story starts (story ended early or its stream failed).
  function playHiss() {
    mode = 'hiss';
    ++loadToken;
    setSource(HISS, true);
    renderState();
  }

  function align() {
    if (!live) return;
    const seg = onAir();
    if (!seg) {
      if (mode !== 'hiss') playHiss();
      if (Date.now() - lastTry > RETRY_MS) refresh();
      return;
    }
    if (segment && segment.key === seg.key) return;
    if (updatePending && segment && document.visibilityState === 'visible') {
      reloadForUpdate();
      if (updatePending) return;
    }
    loadSegment(seg);
    if (schedule.filter((s) => s.end > now()).length < 3) refresh();
  }

  function correctDrift() {
    if (!live || mode !== 'news' || !segment || audio.seeking || audio.paused) return;
    lastDrift = Date.now();
    const expected = (now() - segment.start) / 1000;
    if (!Number.isFinite(audio.duration)) return;
    if (expected >= audio.duration - 0.5) return;
    if (Math.abs(audio.currentTime - expected) > MAX_DRIFT_S) audio.currentTime = expected;
  }

  /* Listeners */

  function presenceBody(onAir) {
    return JSON.stringify({ id: sessionId, country: geo.country || WORLDWIDE, language: geo.language || 'en', live: onAir });
  }

  function setListeners(n) {
    if (!Number.isFinite(n)) return;
    const changed = listeners !== null && n !== listeners;
    listeners = n;
    $('listeners').textContent = String(n);
    $('ears').title = `${n} ${n === 1 ? 'person is' : 'people are'} listening live to ${nameOf(geo.country)} · ${(geo.language || 'en').toUpperCase()} right now`;
    if (changed) {
      const ears = $('ears');
      ears.classList.remove('bump');
      void ears.offsetWidth;
      ears.classList.add('bump');
    }
  }

  // Heartbeats are chained so a stale "on air" can never land after a "stopped".
  function heartbeat() {
    if (!geo.country) return beatChain;
    lastBeat = Date.now();
    presenceKey = `${geo.country}:${geo.language}`;
    beatChain = beatChain.then(async () => {
      try {
        const res = await fetch('/api/presence', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: presenceBody(live),
          cache: 'no-store',
          keepalive: true,
        });
        if (res.ok) setListeners((await res.json()).listeners);
      } catch {
        /* offline: the server drops us after its timeout */
      }
    });
    return beatChain;
  }

  function leave() {
    const body = new Blob([presenceBody(false)], { type: 'text/plain' });
    if (!navigator.sendBeacon || !navigator.sendBeacon('/api/presence', body)) {
      fetch('/api/presence', { method: 'POST', body, keepalive: true }).catch(() => {});
    }
  }

  function goLive() {
    live = true;
    blocked = false;
    segment = null;
    mode = null;
    const seg = onAir();
    // Start audio synchronously so the tap counts as the user gesture that unlocks playback.
    if (seg) loadSegment(seg);
    else playHiss();
    if (Date.now() - lastTry > 15000) refresh();
    render();
    heartbeat();
  }

  function stop() {
    live = false;
    mode = null;
    segment = null;
    signalLost = false;
    ++loadToken;
    switching = true;
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    switching = false;
    render();
    heartbeat();
    if (updatePending) reloadForUpdate();
  }

  // Picks up a new deploy. Remembers whether we were on air so the reload doesn't override STOP.
  function reloadForUpdate() {
    const last = Number(sessionStorage.getItem(RELOADED_KEY)) || 0;
    if (Date.now() - last < 60000) {
      updatePending = false;
      return;
    }
    sessionStorage.setItem(RELOADED_KEY, String(Date.now()));
    sessionStorage.setItem(WAS_LIVE_KEY, live ? '1' : '0');
    location.reload();
  }

  function tick() {
    renderProgress();
    if (Date.now() - lastTry > (schedule.length ? REFRESH_MS : RETRY_MS)) refresh();
    if (geo.country && Date.now() - lastBeat >= PRESENCE_MS) heartbeat();
    if (!live) {
      renderNow();
      renderNext();
      return;
    }
    const t = now();
    if (!segment || t >= segment.end || t < segment.start) align();
    else if (Date.now() - lastDrift > DRIFT_CHECK_MS) correctDrift();
  }

  /* Network */

  function fetchLive() {
    if (fetching) return fetching;
    lastTry = Date.now();
    fetching = (async () => {
      const params = new URLSearchParams();
      try { params.set('tz', Intl.DateTimeFormat().resolvedOptions().timeZone || ''); } catch { /* no Intl tz */ }
      params.set('lang', (navigator.languages || [navigator.language]).filter(Boolean).join(','));
      const chosen = localStorage.getItem(COUNTRY_KEY);
      if (chosen) params.set('country', chosen);
      params.set('language', localStorage.getItem(LANG_KEY) || 'en');
      const t0 = Date.now();
      const res = await fetch(`/api/live?${params}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const t1 = Date.now();
      if (Number.isFinite(data.serverTime)) clockOffset = data.serverTime - (t0 + t1) / 2;
      geo = {
        country: data.country,
        via: data.countryVia,
        detected: data.detected,
        detectedVia: data.detectedVia,
        countries: Array.isArray(data.countries) ? data.countries : [],
        language: data.language || 'en',
        languages: Array.isArray(data.languages) ? data.languages : ['en'],
      };
      schedule = Array.isArray(data.schedule) ? data.schedule : [];
      if (data.version && data.version !== VERSION && VERSION !== '{{VERSION}}') updatePending = true;
      return data;
    })().finally(() => {
      fetching = null;
    });
    return fetching;
  }

  async function refresh() {
    try {
      const data = await fetchLive();
      renderWhere();
      setListeners(data.listeners);
      if (`${geo.country}:${geo.language}` !== presenceKey) heartbeat();
    } catch {
      /* keep the schedule we have; retry on the next tick */
    }
    if (updatePending && !live) {
      reloadForUpdate();
      if (updatePending) return;
    }
    nextKey = '';
    render();
    align();
  }

  /* Wiring */

  audio.addEventListener('playing', () => {
    switching = false;
    renderState();
  });
  audio.addEventListener('play', renderState);
  audio.addEventListener('pause', () => {
    // Paused by the OS / headset / media keys rather than by us: treat as STOP.
    if (live && !switching && !audio.ended) stop();
    else renderState();
  });
  audio.addEventListener('ended', () => {
    if (live && mode === 'news') playHiss();
  });
  audio.addEventListener('error', () => {
    if (!live || mode !== 'news') return;
    signalLost = true;
    playHiss();
  });
  audio.addEventListener('timeupdate', tick);

  $('live').addEventListener('click', goLive);
  $('stop').addEventListener('click', stop);

  $('whereSelect').addEventListener('change', (e) => {
    if (e.target.value) localStorage.setItem(COUNTRY_KEY, e.target.value);
    else localStorage.removeItem(COUNTRY_KEY);
    segment = null;
    refresh();
  });

  $('langSelect').addEventListener('change', (e) => {
    if (e.target.value && e.target.value !== 'en') localStorage.setItem(LANG_KEY, e.target.value);
    else localStorage.removeItem(LANG_KEY);
    segment = null;
    refresh();
  });

  // If autoplay was blocked, the first tap anywhere tunes in.
  document.addEventListener('pointerdown', (e) => {
    if (blocked && !e.target.closest('button, a, select')) goLive();
  }, true);

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.target.closest('button, a, input, select')) return;
    if (e.code === 'Space') {
      e.preventDefault();
      if (live) stop();
      else goLive();
    } else if (e.key === 'l') goLive();
    else if (e.key === 's') stop();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (live) {
      align();
      correctDrift();
    }
    if (Date.now() - lastTry > 30000) refresh();
  });

  if ('mediaSession' in navigator) {
    const handlers = { play: goLive, pause: stop, stop, nexttrack: null, previoustrack: null, seekto: null, seekbackward: null, seekforward: null };
    for (const [action, fn] of Object.entries(handlers)) {
      try { navigator.mediaSession.setActionHandler(action, fn); } catch { /* unsupported action */ }
    }
  }

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  }

  // Timer backup for UI + boundaries (media events drive switching while audio plays in the background).
  setInterval(tick, 1000);

  // Leaving (close, reload, navigate away) stops counting us right away; bfcache restores re-join.
  window.addEventListener('pagehide', leave);
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) heartbeat();
  });

  // Re-measure scrolling titles once the pixel font is in and whenever the layout width changes.
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => fitAll());
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => fitAll(), 150);
  });

  render();
  const wasLive = sessionStorage.getItem(WAS_LIVE_KEY);
  sessionStorage.removeItem(WAS_LIVE_KEY);
  refresh().then(() => {
    if (wasLive !== '0') goLive();
  });
})();
