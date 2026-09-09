/* pocket.js — Hive Pocket Media Player, v1.
 *
 * Everything here runs on the device. There is no fetch to any service, no socket, no account.
 * The only inputs are files the person picked and the audio they produce.
 *
 * THE SHAPE OF IT
 *   <audio> element  ->  MediaElementSource  ->  AnalyserNode  ->  destination
 *                                                    |
 *                              getByteFrequencyData -+-> band buckets -> eq.push() / fx.pushBands()
 *
 * The analyser MUST also be wired through to destination. createMediaElementSource takes the
 * element's output exclusively: connect it to an analyser and forget the destination, and
 * playback goes silent with no error at all.
 */
(() => {
  'use strict';

  // THE version. It is shown on screen and it names the service worker's cache, so a build
  // and the files it cached can never disagree about which build they are. Bump this ONE
  // line for a release; sw.js reads the same string.
  const VERSION = '1.0.1-beta';

  const $ = (id) => document.getElementById(id);
  const fmt = (s) => {
    if (!isFinite(s) || s < 0) s = 0;
    const m = Math.floor(s / 60);
    const r = Math.floor(s % 60);
    return m + ':' + (r < 10 ? '0' : '') + r;
  };

  // ── State ────────────────────────────────────────────────────────────────────────────
  let queue = [];          // { name, url, file }
  let current = -1;
  let audio = null;
  let fxOn = true;

  // ── Audio graph, built once on the first real play ───────────────────────────────────
  // Once, because createMediaElementSource can only be called once per element and throws on a
  // second call — and because an AudioContext started before a user gesture is born suspended.
  let ctx = null, analyser = null, srcNode = null, freq = null;

  function ensureGraph(el) {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;                       // no Web Audio: still plays, just no visuals
      ctx = new AC();
      analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;                     // 512 bins, plenty for 64 bands
      analyser.smoothingTimeConstant = 0.75;
      freq = new Uint8Array(analyser.frequencyBinCount);
    }
    if (!srcNode) {
      srcNode = ctx.createMediaElementSource(el);
      srcNode.connect(analyser);
      analyser.connect(ctx.destination);           // ← the line whose absence is silence
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return true;
  }

  // ── Bands ────────────────────────────────────────────────────────────────────────────
  // The renderers take 0-255 per band. Buckets are logarithmic because hearing is: a linear
  // split puts almost every bar in a range where music has nothing to say.
  const BANDS = 64;
  const edges = (() => {
    const out = [];
    for (let i = 0; i <= BANDS; i++) out.push(Math.pow(i / BANDS, 2.2));
    return out;
  })();

  function readBands() {
    if (!analyser) return null;
    analyser.getByteFrequencyData(freq);
    const n = freq.length;
    const bands = new Array(BANDS);
    for (let i = 0; i < BANDS; i++) {
      const lo = Math.min(n - 1, Math.floor(edges[i] * n));
      const hi = Math.max(lo + 1, Math.min(n, Math.floor(edges[i + 1] * n)));
      let peak = 0;
      for (let j = lo; j < hi; j++) if (freq[j] > peak) peak = freq[j];
      bands[i] = peak;
    }
    return bands;
  }

  // ── Renderers ────────────────────────────────────────────────────────────────────────
  let eq = null, fx = null, pumping = false;

  function initVisuals() {
    if (eq) return;
    eq = EqRender.create($('eqCanvas'));
    fx = FxRender.create($('fxCanvas'));
    // The equalizer needs no configuration — its defaults draw as soon as bands arrive.
    // The effects DO need one thing said. Out of the box ambient is off and the only thing
    // that draws is a burst on a detected beat, so a quiet passage, or anything without
    // percussion, leaves the stage empty and looks broken. A calm always-on weather layer
    // means there is something to see from the first second, and the beat bursts land on top.
    // Stars, not storm or lightning: those flash, and this is a screen held close to a face.
    fx.setConfig({ ambient: "stars" });
    eq.start();
    fx.start();
  }

  function pump() {
    if (!pumping) return;
    const b = readBands();
    if (b) {
      if (eq) eq.push(b);
      if (fx && fxOn) fx.pushBands(b);
    }
    requestAnimationFrame(pump);
  }
  function startPump() { if (!pumping) { pumping = true; requestAnimationFrame(pump); } }
  function stopPump() { pumping = false; }

  // ── The queue ────────────────────────────────────────────────────────────────────────
  function renderQueue() {
    const ul = $('queue');
    ul.textContent = '';
    $('queueCount').textContent = queue.length ? queue.length + (queue.length === 1 ? ' track' : ' tracks') : '';
    queue.forEach((t, i) => {
      const li = document.createElement('li');
      li.className = 'row' + (i === current ? ' on' : '');
      const num = document.createElement('span');
      num.className = 'num mono';
      num.textContent = String(i + 1).padStart(2, '0');
      const nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = t.name;
      li.append(num, nm);
      li.addEventListener('click', () => play(i));
      ul.appendChild(li);
    });
  }

  // ── Playback ─────────────────────────────────────────────────────────────────────────
  function teardown() {
    if (!audio) return;
    try { audio.pause(); } catch (e) { /* already gone */ }
    // NOT removeChild + new element: a second createMediaElementSource on a NEW element would
    // be fine, but the old node would keep the graph alive. One element for the app's life.
    audio.removeAttribute('src');
    audio.load();
  }

  function ensureAudio() {
    if (audio) return audio;
    audio = document.createElement('audio');
    audio.preload = 'metadata';
    $('audioHost').appendChild(audio);
    audio.addEventListener('timeupdate', paintTime);
    audio.addEventListener('durationchange', paintTime);
    audio.addEventListener('play', () => { paintPlay(); startPump(); });
    audio.addEventListener('pause', () => { paintPlay(); });
    audio.addEventListener('ended', () => next());
    audio.addEventListener('error', () => {
      $('nowSub').textContent = 'That file would not play — skipping.';
      next();
    });
    return audio;
  }

  function play(i) {
    const t = queue[i];
    if (!t) return;
    const el = ensureAudio();
    teardown();
    current = i;
    el.src = t.url;
    $('nowTitle').textContent = t.name;
    $('nowSub').textContent = 'From this device';
    $('stageHint').hidden = true;
    renderQueue();
    // The graph is built on a real gesture-driven play, which is when a phone will allow it.
    el.play().then(() => {
      if (ensureGraph(el)) { initVisuals(); startPump(); }
      paintMediaSession();
    }).catch(() => {
      $('nowSub').textContent = 'Tap play to start — the phone needs a tap before it makes sound.';
      paintPlay();
    });
    paintPlay();
  }

  function toggle() {
    if (!audio || current < 0) { if (queue.length) play(0); return; }
    if (audio.paused) audio.play().catch(() => {});
    else audio.pause();
  }
  function next() { if (queue.length) play(current + 1 >= queue.length ? 0 : current + 1); }
  function prev() {
    if (!queue.length) return;
    if (audio && audio.currentTime > 3) { audio.currentTime = 0; return; }
    play(current <= 0 ? queue.length - 1 : current - 1);
  }

  // ── Painting ─────────────────────────────────────────────────────────────────────────
  function paintPlay() {
    const playing = !!audio && !audio.paused;
    $('playIcon').hidden = playing;
    $('pauseIcon').hidden = !playing;
    $('playBtn').setAttribute('aria-label', playing ? 'Pause' : 'Play');
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
    if (!playing) stopPump(); else startPump();
  }

  function paintTime() {
    if (!audio) return;
    const d = isFinite(audio.duration) ? audio.duration : 0;
    $('tNow').textContent = fmt(audio.currentTime);
    $('tEnd').textContent = fmt(d);
    const s = $('seek');
    if (document.activeElement !== s) { s.max = String(d || 0); s.value = String(audio.currentTime || 0); }
  }

  function paintMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const t = queue[current];
    try {
      navigator.mediaSession.metadata = t ? new MediaMetadata({
        title: t.name, artist: 'On this device', album: 'Hive Pocket',
        artwork: [{ src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
                  { src: 'icon-512.png', sizes: '512x512', type: 'image/png' }],
      }) : null;
    } catch (e) { /* older browser; the transport handlers below still work */ }
  }

  // ── Picking music ────────────────────────────────────────────────────────────────────
  // Plain <input type=file>. The folder-handle API that would let this be remembered is
  // desktop-only; see the note in index.html for why v1 does not copy the audio into storage
  // to fake it.
  function adopt(files) {
    const picked = [...files].filter((f) => /^audio\//.test(f.type) || /\.(mp3|m4a|aac|ogg|opus|wav|flac)$/i.test(f.name));
    if (!picked.length) { $('libNote').textContent = 'No playable audio in that selection'; return; }
    // Revoke the old blob URLs before dropping them, or the files stay in memory for the life
    // of the page — which on a phone, with a big library, is the difference between working and
    // being killed by the system.
    queue.forEach((t) => { try { URL.revokeObjectURL(t.url); } catch (e) {} });
    queue = picked
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
      .map((f) => ({ name: f.name.replace(/\.[^.]+$/, ''), url: URL.createObjectURL(f), file: f }));
    current = -1;
    $('libNote').textContent = queue.length + ' track' + (queue.length === 1 ? '' : 's') + ' on this device';
    renderQueue();
  }

  // ── Wiring ───────────────────────────────────────────────────────────────────────────
  $('pickBtn').addEventListener('click', () => $('filePick').click());
  $('filePick').addEventListener('change', (e) => adopt(e.target.files));
  $('playBtn').addEventListener('click', toggle);
  $('nextBtn').addEventListener('click', next);
  $('prevBtn').addEventListener('click', prev);
  $('seek').addEventListener('input', () => { if (audio) audio.currentTime = Number($('seek').value); });
  $('fxBtn').addEventListener('click', () => {
    fxOn = !fxOn;
    $('fxBtn').setAttribute('aria-pressed', fxOn ? 'true' : 'false');
    $('fxBtn').setAttribute('aria-label', fxOn ? 'Effects on' : 'Effects off');
    $('fxCanvas').style.opacity = fxOn ? '' : '0';
  });

  if ('mediaSession' in navigator) {
    const set = (a, fn) => { try { navigator.mediaSession.setActionHandler(a, fn); } catch (e) {} };
    set('play', () => { if (audio && audio.paused) toggle(); });
    set('pause', () => { if (audio && !audio.paused) toggle(); });
    set('previoustrack', prev);
    set('nexttrack', next);
  }

  // Offline is the point of this app, so it caches itself — unlike the ROCK-served one, which
  // has a server that can outrun a cache. Registered only on a secure origin, which is also the
  // only place it is allowed.
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('[pocket] no worker: ' + err.message));
  }

  // Paint the version chip. Text, never innerHTML — it ends up beside the app name.
  { const v = $('ver'); if (v) v.textContent = 'beta ' + VERSION.replace(/-beta$/, ''); }

  window.__pocket = {
    version: VERSION,
    get queue() { return queue; },
    get current() { return current; },
    get bands() { return readBands(); },
    get graphReady() { return !!(ctx && analyser && srcNode); },
  };
})();
