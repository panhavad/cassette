(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const audio = $('audio');
  const cassette = $('cassette');
  const seek = $('seek');
  const VERSION = document.querySelector('meta[name="app-version"]').content;
  const PLAYED_KEY = 'chassette:played';
  const RESUME_KEY = 'chassette:resume';
  const REFRESH_MS = 5 * 60 * 1000;

  let items = [];
  let current = null;
  const played = new Set(load(localStorage, PLAYED_KEY, []));
  let updatePending = false;
  let blocked = false;
  let errorStreak = 0;
  let dragging = false;

  function load(store, key, fallback) {
    try {
      const v = JSON.parse(store.getItem(key));
      return v == null ? fallback : v;
    } catch {
      return fallback;
    }
  }
  function save(store, key, value) {
    try { store.setItem(key, JSON.stringify(value)); } catch { /* storage full or disabled */ }
  }

  const fmt = (sec) => {
    if (!Number.isFinite(sec) || sec < 0) return '0:00';
    sec = Math.floor(sec);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = String(sec % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
  };
  const ago = (iso) => {
    const s = (Date.now() - Date.parse(iso)) / 1000;
    if (!Number.isFinite(s)) return '';
    if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86400)}d ago`;
  };
  const indexOf = (item) => (item ? items.findIndex((i) => i.id === item.id) : -1);
  const nextUnplayed = (exclude) => items.find((i) => !played.has(i.id) && (!exclude || i.id !== exclude.id));

  function setStatus(text) { $('status').textContent = text || ''; }

  function markPlayed(item) {
    if (!item || played.has(item.id)) return;
    played.add(item.id);
    save(localStorage, PLAYED_KEY, [...played].slice(-500));
    renderQueue();
  }

  /* Rendering */

  function renderNow() {
    if (!current) return;
    $('labelSource').textContent = current.source;
    $('labelTitle').textContent = current.title;
    const title = $('nowTitle');
    title.textContent = current.title;
    title.href = current.link || current.sourceUrl;
    const src = $('nowSource');
    src.textContent = current.publisher && current.publisher !== current.source ? `${current.source} · ${current.publisher}` : current.source;
    src.href = current.sourceUrl || current.link;
    $('nowWhen').textContent = ago(current.published);
    document.title = `${current.title} — Chassette`;
  }

  function renderQueue() {
    const ol = $('queue');
    ol.replaceChildren(...items.map((item) => {
      const li = document.createElement('li');
      if (played.has(item.id)) li.classList.add('played');
      if (current && item.id === current.id) li.classList.add('current');

      const btn = document.createElement('button');
      btn.type = 'button';
      const t = document.createElement('span');
      t.className = 'q-title';
      t.textContent = item.title;
      const m = document.createElement('span');
      m.className = 'q-meta';
      m.textContent = [item.source, ago(item.published), item.duration ? fmt(item.duration) : ''].filter(Boolean).join(' · ');
      btn.append(t, m);
      btn.addEventListener('click', () => play(item));

      const a = document.createElement('a');
      a.className = 'q-link';
      a.href = item.link || item.sourceUrl;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = '↗';
      a.title = `Open on ${item.source}`;
      a.setAttribute('aria-label', `Open “${item.title}” on ${item.source}`);

      li.append(btn, a);
      return li;
    }));
  }

  function setPlaying(on) {
    document.body.classList.toggle('playing', on);
    const btn = $('play');
    btn.setAttribute('aria-pressed', String(on));
    btn.setAttribute('aria-label', on ? 'Pause' : 'Play');
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = on ? 'playing' : 'paused';
  }

  function setBlocked(on) {
    blocked = on;
    document.body.classList.toggle('blocked', on);
    setStatus(on ? 'Press ▶ to roll the tape' : '');
  }

  function setMediaSession() {
    if (!('mediaSession' in navigator) || !current) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: current.title,
      artist: current.source,
      album: 'Chassette',
      artwork: [{ src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' }],
    });
  }

  /* Playback */

  function tryPlay() {
    if (!audio.src) return;
    const p = audio.play();
    if (p) {
      p.then(() => setBlocked(false)).catch((err) => {
        if (err.name === 'NotAllowedError') setBlocked(true);
      });
    }
  }

  function play(item, startAt = 0) {
    if (!item) return;
    current = item;
    audio.src = item.audio;
    if (startAt > 0) audio.addEventListener('loadedmetadata', () => { audio.currentTime = startAt; }, { once: true });
    cassette.style.setProperty('--p', '0');
    renderNow();
    renderQueue();
    setMediaSession();
    tryPlay();
  }

  function next() {
    if (!items.length) return;
    play(nextUnplayed(current) || items[(indexOf(current) + 1) % items.length]);
  }

  function skip() {
    markPlayed(current);
    next();
  }

  function prev() {
    if (audio.currentTime > 5 || !items.length) {
      audio.currentTime = 0;
      return;
    }
    const i = indexOf(current);
    play(items[(i - 1 + items.length) % items.length]);
  }

  function toggle() {
    if (!current) return;
    if (audio.paused) tryPlay();
    else audio.pause();
  }

  function start() {
    const resume = load(sessionStorage, RESUME_KEY, null);
    sessionStorage.removeItem(RESUME_KEY);
    const resumed = resume && items.find((i) => i.id === resume.id);
    if (resumed) play(resumed, resume.t || 0);
    else play(nextUnplayed() || items[0]);
  }

  /* Data + updates */

  function reloadForUpdate(keepPosition) {
    if (keepPosition && current) save(sessionStorage, RESUME_KEY, { id: current.id, t: audio.currentTime });
    location.reload();
  }

  function requestUpdate() {
    if (updatePending) return;
    updatePending = true;
    if (navigator.serviceWorker) navigator.serviceWorker.getRegistration().then((r) => r && r.update()).catch(() => {});
    // Never cut a story mid-sentence: update now if idle, otherwise at the end of the current track.
    if (audio.paused) reloadForUpdate(true);
  }

  let refreshTimer = null;
  let lastRefresh = 0;

  async function refresh() {
    clearTimeout(refreshTimer);
    lastRefresh = Date.now();
    try {
      const res = await fetch('/api/news', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.version && data.version !== VERSION && VERSION !== '{{VERSION}}') requestUpdate();
      items = Array.isArray(data.items) ? data.items : [];
      if (current && indexOf(current) === -1) items.unshift(current);
      renderQueue();
      if (!items.length) setStatus('No fresh audio on air yet — retrying…');
      else if (!current) start();
    } catch {
      if (!items.length) setStatus('Searching for signal…');
    }
    refreshTimer = setTimeout(refresh, items.length ? REFRESH_MS : 10000);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - lastRefresh > 60000) refresh();
  });

  /* Wiring */

  audio.addEventListener('play', () => setPlaying(true));
  audio.addEventListener('pause', () => setPlaying(false));
  audio.addEventListener('playing', () => {
    errorStreak = 0;
    setBlocked(false);
  });
  audio.addEventListener('timeupdate', () => {
    const d = audio.duration;
    const p = Number.isFinite(d) && d > 0 ? audio.currentTime / d : 0;
    cassette.style.setProperty('--p', p.toFixed(4));
    if (!dragging) seek.value = Math.round(p * 1000);
    $('cur').textContent = fmt(audio.currentTime);
    $('dur').textContent = fmt(d);
  });
  audio.addEventListener('ended', () => {
    markPlayed(current);
    if (updatePending) reloadForUpdate(false);
    else next();
  });
  audio.addEventListener('error', () => {
    if (!current || !audio.getAttribute('src')) return;
    errorStreak++;
    markPlayed(current);
    if (errorStreak >= items.length) {
      setStatus('Tape jammed — no source is reachable right now');
      return;
    }
    setStatus(`Couldn't load ${current.source} — skipping`);
    setTimeout(next, 1200);
  });

  seek.addEventListener('pointerdown', () => { dragging = true; });
  seek.addEventListener('pointerup', () => { dragging = false; });
  seek.addEventListener('input', () => {
    if (Number.isFinite(audio.duration)) audio.currentTime = (seek.value / 1000) * audio.duration;
  });

  $('play').addEventListener('click', toggle);
  $('next').addEventListener('click', skip);
  $('prev').addEventListener('click', prev);

  // Autoplay may be blocked until the first interaction; any tap on the page starts the tape.
  const unlock = (e) => {
    if (!blocked || e.target.closest('button, a, input')) return;
    tryPlay();
  };
  document.addEventListener('pointerdown', unlock, true);

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.target.closest('button, a, input')) return;
    if (e.code === 'Space' || e.key === 'k') { e.preventDefault(); toggle(); }
    else if (e.key === 'n') skip();
    else if (e.key === 'p') prev();
    else if (e.key === 'ArrowRight') audio.currentTime += 15;
    else if (e.key === 'ArrowLeft') audio.currentTime = Math.max(0, audio.currentTime - 15);
  });

  if ('mediaSession' in navigator) {
    const handlers = {
      play: tryPlay,
      pause: () => audio.pause(),
      nexttrack: skip,
      previoustrack: prev,
      seekto: (d) => { audio.currentTime = d.seekTime; },
    };
    for (const [action, fn] of Object.entries(handlers)) {
      try { navigator.mediaSession.setActionHandler(action, fn); } catch { /* unsupported action */ }
    }
  }

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  }

  refresh();
})();
