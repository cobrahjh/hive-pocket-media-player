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
  const VERSION = '1.1.0-beta';

  const $ = (id) => document.getElementById(id);
  const fmt = (s) => {
    if (!isFinite(s) || s < 0) s = 0;
    const m = Math.floor(s / 60);
    const r = Math.floor(s % 60);
    return m + ':' + (r < 10 ? '0' : '') + r;
  };

  // ── Saved links ──────────────────────────────────────────────────────────────────────
  // The ONLY thing this app can remember between sessions. A picked file cannot be kept — the
  // browser hands over the bytes and nothing durable — but a link is a string, so it survives.
  const LINKS_KEY = 'hive-pocket.links';

  function readLinks() {
    try {
      const raw = JSON.parse(localStorage.getItem(LINKS_KEY) || '[]');
      if (!Array.isArray(raw)) return [];
      // Rebuilt from an allowlist rather than trusted: this comes back from storage a person or
      // another script could have edited, and a bad `url` here becomes a <audio src>.
      return raw
        .map((x) => (x && typeof x === 'object' ? { name: String(x.name || '').slice(0, 200), url: String(x.url || '') } : null))
        .filter((x) => x && safeUrl(x.url));
    } catch (e) { return []; }
  }
  function writeLinks(list) {
    try { localStorage.setItem(LINKS_KEY, JSON.stringify(list.slice(0, 200))); } catch (e) { /* private mode, full disk */ }
  }
  // https only, and only ever handed to a media element. Rejecting everything else keeps
  // javascript:, data: and file: out of an attribute that would honour them.
  function safeUrl(u) {
    try {
      // NO BASE. With one, 'not a link' resolves to a path on this origin and sails through as
      // http — which is how a typed sentence became a saved track. An absolute URL or nothing.
      const p = new URL(u);
      if (p.protocol !== 'https:' && p.protocol !== 'http:') return false;
      if (!p.hostname) return false;
      // An http link on an https page is refused by the browser as mixed content, and the
      // content policy in index.html refuses it too. Both are silent. Rule it out HERE so the
      // person is told when they paste it, not left with a track that never starts.
      if (location.protocol === 'https:' && p.protocol === 'http:') return false;
      return true;
    } catch (e) { return false; }
  }
  // Why a link was rejected, in the words of the thing that rejected it.
  function whyBad(u) {
    try {
      const p = new URL(u);
      if (location.protocol === 'https:' && p.protocol === 'http:') {
        return 'That link is http. This app is served over https, and browsers refuse to play '
             + 'insecure media on a secure page. Try the https:// version of it.';
      }
      return 'That is not a web link. It needs to start with https://';
    } catch (e) { return 'That is not a web link. It needs to start with https://'; }
  }
  function nameFromUrl(u) {
    try {
      const last = decodeURIComponent(new URL(u).pathname.split('/').filter(Boolean).pop() || '');
      return (last.replace(/\.[^.]+$/, '') || new URL(u).hostname).slice(0, 200);
    } catch (e) { return u.slice(0, 60); }
  }

  // ── State ────────────────────────────────────────────────────────────────────────────
  let queue = [];          // { name, url, file?, link? }
  let current = -1;
  let audio = null;
  let fxOn = true;
  let shuffleOn = false;
  let repeatMode = 'off';        // 'off' | 'all' | 'one'
  // A shuffled ORDER, not a random pick each time: every track once before any repeats, which is
  // what people mean by shuffle. Rebuilt when the queue changes or shuffle is switched on.
  let order = null, orderPos = -1;

  const MODES_KEY = 'hive-pocket.modes';
  function readModes() {
    try {
      const m = JSON.parse(localStorage.getItem(MODES_KEY) || '{}');
      shuffleOn = m.shuffle === true;
      repeatMode = (m.repeat === 'all' || m.repeat === 'one') ? m.repeat : 'off';
    } catch (e) { /* private mode */ }
  }
  function writeModes() {
    try { localStorage.setItem(MODES_KEY, JSON.stringify({ shuffle: shuffleOn, repeat: repeatMode })); }
    catch (e) { /* private mode */ }
  }
  function buildOrder() {
    order = queue.map((_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    orderPos = order.indexOf(current);
  }

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
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'rowdel';
      del.setAttribute('aria-label', 'Remove ' + t.name);
      del.textContent = '\u00d7';
      // stopPropagation, or removing a row also starts playing whatever slid into its place.
      del.addEventListener('click', (ev) => { ev.stopPropagation(); removeAt(i); });
      li.append(num, nm, del);
      li.addEventListener('click', () => play(i));
      ul.appendChild(li);
    });
  }

  function removeAt(i) {
    const t = queue[i];
    if (!t) return;
    // A picked file's blob URL is memory held for the life of the page. Let it go.
    if (!t.link) { try { URL.revokeObjectURL(t.url); } catch (e) {} }
    // A saved link removed from the queue is removed from storage too — the queue IS the
    // library for links, and leaving it saved would resurrect it on the next start.
    if (t.link) writeLinks(readLinks().filter((l) => l.url !== t.url));

    const wasCurrent = i === current;
    queue.splice(i, 1);
    if (i < current) current--;
    else if (wasCurrent) {
      // Do not silently jump to another song. Stop, and leave the next press to the person.
      teardown();
      current = -1;
      $('nowTitle').textContent = queue.length ? 'Nothing loaded' : 'Nothing loaded';
      $('nowSub').textContent = 'Removed. Pick a track to start again.';
      paintPlay();
    }
    if (shuffleOn) buildOrder();
    renderQueue();
    paintLib();
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
    audio.addEventListener('ended', () => next(true));
    audio.addEventListener('error', () => {
      const t = queue[current];
      // A link that refused the CORS request: drop the request and take the audio without
      // visuals, rather than skipping a track that would have played perfectly well.
      if (t && t.link && audio.corsTried) {
        $('nowSub').textContent = 'Playing without visuals — that host does not allow this page to read its audio.';
        play(current, { noCors: true });
        return;
      }
      $('nowSub').textContent = t && t.link
        ? 'That link would not play. It has to point straight at an audio file.'
        : 'That file would not play — skipping.';
      if (!t || !t.link) next();
    });
    return audio;
  }

  function play(i, opts) {
    const t = queue[i];
    if (!t) return;
    const el = ensureAudio();
    teardown();
    current = i;
    // CROSS-ORIGIN AUDIO AND THE ANALYSER. A media element loaded from another origin without
    // CORS permission is opaque: it plays, but Web Audio refuses to let this page read it and
    // every band comes back zero, so the visuals sit dead with no error anywhere. Asking for
    // CORS is the only way to get them — and asking fails outright on a host that does not
    // grant it, which is why the error handler below retries once WITHOUT it. Sound first,
    // visuals if the host allows them.
    if (t.link && !(opts && opts.noCors)) el.crossOrigin = 'anonymous';
    else el.removeAttribute('crossorigin');
    el.corsTried = !!(t.link && !(opts && opts.noCors));
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
  // fromEnd: a track that ran out, as opposed to the button. Only the former stops at the end
  // of the queue — pressing Next at the last track wrapping is what people expect.
  function next(fromEnd) {
    if (!queue.length) return;
    if (fromEnd && repeatMode === 'one') { play(current); return; }
    if (shuffleOn) {
      if (!order || order.length !== queue.length) buildOrder();
      orderPos++;
      if (orderPos >= order.length) {
        if (fromEnd && repeatMode === 'off') { stopHere(); return; }
        buildOrder(); orderPos = 0;
      }
      play(order[orderPos]);
      return;
    }
    const n = current + 1;
    if (n >= queue.length) {
      if (fromEnd && repeatMode === 'off') { stopHere(); return; }
      play(0); return;
    }
    play(n);
  }
  // The queue ran out and nothing says to carry on. Stop where it is rather than looping
  // silently back to the top, which is how a player ends up playing all night.
  function stopHere() {
    if (audio) audio.pause();
    $('nowSub').textContent = 'End of the queue.';
    paintPlay();
  }
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
    // Saved links are kept: picking files replaces the FILES, not the library.
    queue = queue.concat(readLinks().map((l) => ({ name: l.name, url: l.url, link: true })));
    if (shuffleOn) buildOrder();
    renderQueue();
    paintLib();
  }

  function saveNote(msg, bad) {
    const el = $('linkNote');
    el.textContent = msg || '';
    el.hidden = !msg;
    el.classList.toggle('bad', !!bad);
  }

  function addLink(raw) {
    const u = String(raw || '').trim();
    if (!u) return;
    if (!safeUrl(u)) { saveNote(whyBad(u), true); return; }
    const links = readLinks();
    if (links.some((l) => l.url === u)) { saveNote('That link is already saved.'); return; }
    const entry = { name: nameFromUrl(u), url: u };
    links.push(entry);
    writeLinks(links);
    queue.push({ name: entry.name, url: entry.url, link: true });
    renderQueue();
    $('linkInput').value = '';
    saveNote('Saved. It will still be here next time you open the app.');
    paintLib();
  }

  function paintLib() {
    const files = queue.filter((t) => !t.link).length;
    const links = queue.filter((t) => t.link).length;
    const bits = [];
    if (files) bits.push(files + ' from this device');
    if (links) bits.push(links + ' saved link' + (links === 1 ? '' : 's'));
    $('libNote').textContent = bits.length ? bits.join(' · ') : 'No music picked yet';
  }

  // ── Wiring ───────────────────────────────────────────────────────────────────────────
  $('pickBtn').addEventListener('click', () => $('filePick').click());
  $('linkBtn').addEventListener('click', () => {
    const row = $('linkRow');
    row.hidden = !row.hidden;
    $('linkBtn').setAttribute('aria-expanded', row.hidden ? 'false' : 'true');
    if (!row.hidden) $('linkInput').focus();
  });
  $('linkAdd').addEventListener('click', () => addLink($('linkInput').value));
  $('linkInput').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); addLink($('linkInput').value); } });
  $('filePick').addEventListener('change', (e) => adopt(e.target.files));
  $('playBtn').addEventListener('click', toggle);
  $('nextBtn').addEventListener('click', () => next(false));
  $('prevBtn').addEventListener('click', prev);
  $('seek').addEventListener('input', () => { if (audio) audio.currentTime = Number($('seek').value); });
  function paintModes() {
    const s = $('shuffleBtn');
    s.setAttribute('aria-pressed', shuffleOn ? 'true' : 'false');
    s.setAttribute('aria-label', shuffleOn ? 'Shuffle on' : 'Shuffle off');
    const r = $('repeatBtn');
    r.setAttribute('aria-pressed', repeatMode !== 'off' ? 'true' : 'false');
    r.setAttribute('aria-label',
      repeatMode === 'one' ? 'Repeat one track' : repeatMode === 'all' ? 'Repeat the queue' : 'Repeat off');
    $('repeatOne').hidden = repeatMode !== 'one';
  }
  $('shuffleBtn').addEventListener('click', () => {
    shuffleOn = !shuffleOn;
    if (shuffleOn) buildOrder(); else { order = null; orderPos = -1; }
    writeModes(); paintModes();
  });
  $('repeatBtn').addEventListener('click', () => {
    repeatMode = repeatMode === 'off' ? 'all' : repeatMode === 'all' ? 'one' : 'off';
    writeModes(); paintModes();
  });

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
    set('nexttrack', () => next(false));
  }

  // Offline is the point of this app, so it caches itself — unlike the ROCK-served one, which
  // has a server that can outrun a cache. Registered only on a secure origin, which is also the
  // only place it is allowed.
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('[pocket] no worker: ' + err.message));
  }

  // Paint the version chip. Text, never innerHTML — it ends up beside the app name.
  { const v = $('ver'); if (v) v.textContent = 'beta ' + VERSION.replace(/-beta$/, ''); }

  // Saved links come back on their own; picked files cannot, and the note says which is which.
  readModes();
  queue = readLinks().map((l) => ({ name: l.name, url: l.url, link: true }));
  if (shuffleOn) buildOrder();
  renderQueue();
  paintLib();
  paintModes();

  window.__pocket = {
    version: VERSION,
    get links() { return readLinks(); },
    get modes() { return { shuffle: shuffleOn, repeat: repeatMode }; },
    addLink,
    removeAt,
    get queue() { return queue; },
    get current() { return current; },
    get bands() { return readBands(); },
    get graphReady() { return !!(ctx && analyser && srcNode); },
  };
})();
