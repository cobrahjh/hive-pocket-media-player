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
  const VERSION = '1.16.0-beta';

  const $ = (id) => document.getElementById(id);
  // A control's tooltip and the text a screen reader announces are the same sentence, set in
  // the same call. Two places to write it is two places for them to drift apart.
  function label(id, text) {
    $(id).setAttribute('aria-label', text);
    $(id).setAttribute('title', text);
  }
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
  // ── YouTube ──────────────────────────────────────────────────────────────────────────
  // A YouTube address is not a media file and no <audio> element will ever play one. It needs
  // YouTube's own player in an iframe, which is why this is the one thing in the app that
  // reaches the network, the one thing that needs a connection, and the one thing with no
  // equalizer over it — the sound belongs to another origin and cannot be read from here.
  //
  // The ids are matched against a strict character class rather than trusted, because they end
  // up in the src of a frame. Anything that is not exactly a YouTube id is not a YouTube link.
  const YT_HOSTS = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com',
                    'youtu.be', 'www.youtube-nocookie.com'];
  const YT_VIDEO = /^[A-Za-z0-9_-]{11}$/;
  const YT_LIST = /^[A-Za-z0-9_-]{12,42}$/;

  function parseYouTube(u) {
    let p;
    try { p = new URL(u); } catch (e) { return null; }
    if (!YT_HOSTS.includes(p.hostname)) return null;
    // A list wins over a video: an address carrying both is a video seen from inside a
    // playlist, and the playlist is what the person copied.
    const list = p.searchParams.get('list');
    if (list && YT_LIST.test(list)) return { kind: 'playlist', id: list };
    let id = p.searchParams.get('v');
    if (!id) {
      const seg = p.pathname.split('/').filter(Boolean);
      // youtu.be/ID, /shorts/ID, /embed/ID, /live/ID
      if (seg.length === 1 && p.hostname === 'youtu.be') id = seg[0];
      else if (seg.length === 2 && ['shorts', 'embed', 'live', 'v'].includes(seg[0])) id = seg[1];
    }
    return id && YT_VIDEO.test(id) ? { kind: 'video', id } : null;
  }

  function nameFromUrl(u) {
    const yt = parseYouTube(u);
    // A real title needs an API call, a key and a quota. The player hands one over for free the
    // moment it loads, and the row is renamed then; until it does, say which of the two it is.
    if (yt) return (yt.kind === 'playlist' ? 'YouTube playlist ' : 'YouTube video ') + yt.id;
    try {
      const last = decodeURIComponent(new URL(u).pathname.split('/').filter(Boolean).pop() || '');
      return (last.replace(/\.[^.]+$/, '') || new URL(u).hostname).slice(0, 200);
    } catch (e) { return u.slice(0, 60); }
  }

  // ── State ────────────────────────────────────────────────────────────────────────────
  let queue = [];          // { name, url, file?, link? }
  let current = -1;
  let audio = null;
  // What is on the stage. ONE stored value, not two booleans and not a second copy behind the
  // transport's effects button — that button writes here too, so the menu and the button can
  // never disagree about what you are looking at.
  const VISUALS_KEY = 'hive-pocket.visuals';
  const VISUALS = ['both', 'fx', 'eq'];
  let visuals = 'both';
  // Which backend owns the sound right now. Everything the transport does has to ask, because
  // the two have nothing in common: one is an <audio> element this page controls directly, the
  // other is a player inside somebody else's iframe reached through a script they serve.
  let ytOn = false;
  const fxShown = () => visuals !== 'eq';
  const eqShown = () => visuals !== 'fx';
  let shuffleOn = false;
  let repeatMode = 'off';        // 'off' | 'all' | 'one'
  // A shuffled ORDER, not a random pick each time: every track once before any repeats, which is
  // what people mean by shuffle. Rebuilt when the queue changes or shuffle is switched on.
  let order = null, orderPos = -1;

  function readVisuals() {
    try { const v = localStorage.getItem(VISUALS_KEY); return VISUALS.includes(v) ? v : 'both'; }
    catch (e) { return 'both'; }
  }

  const MODES_KEY = 'hive-pocket.modes';
  const AMBIENT_KEY = 'hive-pocket.ambient';
  // All thirteen the renderer knows. Storm and lightning flash, so they are last in the list,
  // labelled as flashing, and never a default — but they ARE offered, which is the renderer's
  // own policy: it keeps them out of the random roll because nobody chose them there, and
  // allows them "when chosen by name". Its safety caps are hard constants no setting reaches:
  // the whole-frame flash is capped at 0.12 alpha, strikes cannot land inside 800ms of each
  // other, and at most six bolts live at once.
  const AMBIENTS = ['off', 'stars', 'snow', 'rain', 'fireflies', 'bubbles', 'leaves', 'petals',
                    'sparks', 'meteors', 'clouds', 'fog', 'storm', 'lightning'];
  function readAmbient() {
    try { const v = localStorage.getItem(AMBIENT_KEY); return AMBIENTS.includes(v) ? v : 'stars'; }
    catch (e) { return 'stars'; }
  }
  function writeAmbient(v) { try { localStorage.setItem(AMBIENT_KEY, v); } catch (e) {} }

  // What a beat spawns. The renderer has had all six of these since long before this app
  // existed; Pocket simply never asked for any of them and took the default, so the only thing
  // anyone could change here was the weather. 'random' rolls a different one each burst.
  const BEAT_KEY = 'hive-pocket.beat';
  const BEAT_EFFECTS = ['fireworks', 'confetti', 'embers', 'hearts', 'fountain', 'nova', 'random'];
  function readBeatEffect() {
    try { const v = localStorage.getItem(BEAT_KEY); return BEAT_EFFECTS.includes(v) ? v : 'fireworks'; }
    catch (e) { return 'fireworks'; }
  }
  function writeBeatEffect(v) { try { localStorage.setItem(BEAT_KEY, v); } catch (e) {} }

  // How much a moment has to beat the running average to count as a hit. The renderer defaults
  // to 1.35, which is right for a clean file and wrong for a room: measured on Harold's phone
  // with music playing out loud, the bass was four times over the loudness floor (0.57 against
  // 0.12) and the biggest rise still only reached 1.1. Reverb smears the transients a file
  // delivers intact, so the average sits close under every peak and 1.35 is never cleared.
  // Hence a setting, and a default suited to a microphone rather than to a file.
  //
  // WHAT GOES AWAY AS THIS GETS EASIER: a burst stops meaning "a distinct beat". At 'easy' a
  // sustained loud passage can keep it firing, because 6% over the average is a low bar. The
  // rate is still bounded — the 0.12 floor rejects a quiet room outright, and the renderer's
  // own tempo sync allows one burst every two detected beats — but the bursts stop being
  // evidence that anything was actually hit.
  const SENS_KEY = 'hive-pocket.sens';
  const SENS = { easy: 1.06, room: 1.15, strict: 1.35 };
  function readSens() {
    try { const v = localStorage.getItem(SENS_KEY); return SENS[v] ? v : 'easy'; }
    catch (e) { return 'easy'; }
  }
  function writeSens(v) { try { localStorage.setItem(SENS_KEY, v); } catch (e) {} }

  // Colour. The renderer has carried five palettes the whole time and this app never asked for
  // one, so every build until now was orange. 'auto' on the ambient layer means it follows the
  // main palette, so one choice colours both the weather and the bursts.
  const PAL_KEY = 'hive-pocket.palette';
  const PALETTES = ['hive', 'fire', 'ice', 'vapor', 'mono', 'random'];
  function readPalette() {
    try { const v = localStorage.getItem(PAL_KEY); return PALETTES.includes(v) ? v : 'hive'; }
    catch (e) { return 'hive'; }
  }
  function writePalette(v) { try { localStorage.setItem(PAL_KEY, v); } catch (e) {} }

  // The equalizer's own styles. It has carried seven since long before this app, and Pocket
  // never called its setConfig at all — so every build until now drew bars, in orange, whatever
  // the effects were doing. Same shape of miss as the palettes and the beat effects.
  const EQ_KEY = 'hive-pocket.eqstyle';
  const EQ_SHAPES = ['bars', 'led', 'blocks', 'wave', 'line', 'dots', 'radial'];
  const EQ_STYLES = EQ_SHAPES.concat('random');
  function readEqStyle() {
    try { const v = localStorage.getItem(EQ_KEY); return EQ_STYLES.includes(v) ? v : 'bars'; }
    catch (e) { return 'bars'; }
  }
  function writeEqStyle(v) { try { localStorage.setItem(EQ_KEY, v); } catch (e) {} }

  const CONCRETE = ['hive', 'fire', 'ice', 'vapor', 'mono'];
  const pick = (list) => list[Math.floor(Math.random() * list.length)];

  // The equalizer cannot roll the way the effects do. An effect rolls per burst, which is a new
  // thing every second or so; a style that rolled per frame would be a strobe of seven layouts
  // and unreadable. So random means "pick one for me", rolled once when something is applied and
  // then REMEMBERED here — a resolver that rolled on every call would mean simply reading what
  // the equalizer is currently drawing changed it, which is not a thing a read should do.
  let eqShapeNow = null, eqPaletteNow = null;
  function rollEq() {
    const st = readEqStyle(), pl = readPalette();
    eqShapeNow = st === 'random' ? pick(EQ_SHAPES) : st;
    // The equalizer does not know 'random' and quietly falls back to orange when handed a name it
    // does not recognise, so it is resolved to a real one here rather than left to fail silently.
    eqPaletteNow = pl === 'random' ? pick(CONCRETE) : pl;
  }

  // Roll everything. Deliberately NOT a look: a look is a state you can come back to, and this is
  // an action whose result is whatever it landed on, so the picker reports Custom (or a real look,
  // if the dice happen to agree) rather than sitting on a name that describes nothing.
  //
  // Storm and lightning are excluded on purpose. They flash the screen, and the renderer's own
  // policy is that flashing is allowed when chosen by name and never when rolled — nobody
  // consented to it by pressing a button labelled Surprise me. Same reasoning, one layer up.
  const SAFE_AMBIENTS = AMBIENTS.filter((a) => a !== 'storm' && a !== 'lightning');
  function surprise() {
    writeEqStyle(pick(EQ_SHAPES));
    writeBeatEffect(pick(BEAT_EFFECTS.filter((e) => e !== 'random')));
    writePalette(pick(CONCRETE));
    writeAmbient(pick(SAFE_AMBIENTS));
    writeSens(pick(Object.keys(SENS)));
    applyRenderers();
    paintSheet();
  }

  // Looks. Four dropdowns is where good combinations go to die: the pleasure here is in
  // pairings, and nobody finds a pairing by working through a settings list. Each of these sets
  // all four at once. The dropdowns stay underneath for anyone who wants them, and the moment
  // one of them is moved the picker says Custom rather than keeping a name that is no longer true.
  const LOOKS = {
    // Deliberately the app's shipped defaults, so a fresh install reads as Hive rather than
    // as Custom — "you have not chosen anything" is a poor first thing to say.
    hive:    { eq: 'bars', effect: 'fireworks', palette: 'hive',  ambient: 'stars',    sens: 'easy' },
    bonfire: { eq: 'blocks', effect: 'embers',    palette: 'fire',  ambient: 'sparks',   sens: 'easy' },
    freeze:  { eq: 'line', effect: 'nova',      palette: 'ice',   ambient: 'snow',     sens: 'easy' },
    drive:   { eq: 'wave', effect: 'confetti',  palette: 'vapor', ambient: 'meteors',  sens: 'easy' },
    garden:  { eq: 'dots', effect: 'hearts',    palette: 'vapor', ambient: 'petals',   sens: 'easy' },
    ink:     { eq: 'led', effect: 'fountain',  palette: 'mono',  ambient: 'fog',      sens: 'room' },
    storm:   { eq: 'radial', effect: 'fireworks', palette: 'ice',   ambient: 'storm',    sens: 'room' },
  };

  function currentLook() {
    const now = { eq: readEqStyle(), effect: readBeatEffect(), palette: readPalette(), ambient: readAmbient(), sens: readSens() };
    for (const [name, l] of Object.entries(LOOKS)) {
      if (l.eq === now.eq && l.effect === now.effect && l.palette === now.palette
          && l.ambient === now.ambient && l.sens === now.sens) return name;
    }
    return 'custom';
  }

  function applyLook(name) {
    const l = LOOKS[name];
    if (!l) return;                       // 'custom' is a readout, never a thing to apply
    writeEqStyle(l.eq); writeBeatEffect(l.effect); writePalette(l.palette);
    writeAmbient(l.ambient); writeSens(l.sens);
    applyRenderers();
    paintSheet();
  }

  // How hard it works. Every number here is a lever the renderers already had: the effects take
  // a budget for burst particles and a separate one for the weather, and the equalizer takes a
  // frame cap per surface — its own comment says "the phone wanting 30 is the normal case".
  //
  // WHAT STOPS BEING VISIBLE AS THIS COMES DOWN, since it is a threshold and thresholds hide
  // things: bursts throw fewer pieces and the background carries fewer, so both thin out rather
  // than disappear; and at Saver the equalizer redraws at 24 a second, which is visibly less
  // fluid on a fast track. Nothing is removed and no effect becomes unavailable.
  //
  // The saving is NOT measured. Full was measured at about 12% of a battery an hour on Harold's
  // phone, screen and all; what these save against that is unknown until someone runs them.
  const QUAL_KEY = 'hive-pocket.quality';
  const QUALITY = {
    full:     { fps: 60, parts: 1200, amb: 400 },
    balanced: { fps: 40, parts: 700,  amb: 250 },
    saver:    { fps: 24, parts: 300,  amb: 120 },
  };
  function readQuality() {
    try { const v = localStorage.getItem(QUAL_KEY); return QUALITY[v] ? v : 'full'; }
    catch (e) { return 'full'; }
  }
  function writeQuality(v) { try { localStorage.setItem(QUAL_KEY, v); } catch (e) {} }

  // How big a burst is. beat.intensity already scaled every burst; it was simply never offered.
  // At Huge with Performance on Battery saver the particle budget clips the result — the cap is
  // the cap, and it is doing its job rather than failing.
  const PUNCH_KEY = 'hive-pocket.punch';
  const PUNCH = { subtle: 0.8, normal: 1.2, bold: 1.8, huge: 2.6 };
  function readPunch() {
    try { const v = localStorage.getItem(PUNCH_KEY); return PUNCH[v] ? v : 'normal'; }
    catch (e) { return 'normal'; }
  }
  function writePunch(v) { try { localStorage.setItem(PUNCH_KEY, v); } catch (e) {} }

  // FOUNTAIN, retuned. Its defaults make it the weakest of the six and the numbers say why, read
  // against its siblings: spread 0.55 is the narrowest of them all (every other effect is 1 or
  // more), gravity 520 the heaviest (confetti 420, hearts 280, fireworks 260), size 2.4 among the
  // smallest and glow 0.9 below fireworks. Narrow, heavy, small and dim: the particles leave the
  // nozzle and are pulled straight back before they can read as anything.
  //
  // The point is to keep it a FOUNTAIN and not turn it into fireworks. It stays the narrowest
  // effect and the second-heaviest, because rising in a column and falling back is the whole
  // idea; it just gets the room to do it. Wider by half, a third less gravity, half again the
  // life to see the arc, half again the particles because a jet should look continuous, and
  // enough size and glow to be visible on a phone in a lit room.
  //
  // Applied from here rather than by editing the renderer: fx-render.js is shared with the stream
  // overlays, and this is Pocket's opinion about one effect, not a fix to the renderer. The merge
  // is per named effect, so the other five keep their own defaults untouched.
  const FOUNTAIN = {
    count: 140,      // was 90 — a jet should look continuous
    spread: 0.85,    // was 0.55 — still the narrowest of the six
    gravity: 360,    // was 520 — still the second heaviest, so it still falls back
    life: 2.6,       // was 1.8 — long enough to watch the arc up and down
    size: 3.0,       // was 2.4
    glow: 1.15,      // was 0.9
    wander: 0.6,     // was 0.4 — a little life across the plume
  };

  // Hiding the player, not removing it. With the microphone able to see sound this app does not
  // own, the visuals stand on their own and the transport is often just something in the way.
  // Everything stays wired: turn this off and the queue, the saved links and the controls are
  // exactly where they were.
  const HIDE_KEY = 'hive-pocket.hideplayer';
  function readHidePlayer() {
    try { return localStorage.getItem(HIDE_KEY) === '1'; } catch (e) { return false; }
  }
  function writeHidePlayer(on) {
    try { localStorage.setItem(HIDE_KEY, on ? '1' : '0'); } catch (e) {}
  }

  // The parts that ARE the player. The stage, the menu button and the version chip are not in
  // this list on purpose: hiding the menu would strand you with no way back.
  const PLAYER_PARTS = ['#linkBtn', '#pickBtn', '#linkRow', '.now', '.controls', '.queue-wrap'];

  function applyHidePlayer() {
    const off = readHidePlayer();
    for (const sel of PLAYER_PARTS) {
      const el = document.querySelector(sel);
      if (!el) continue;
      // The link row has its own hidden state and must not be forced open when the player
      // comes back — it is a disclosure, closed by default.
      if (sel === '#linkRow') { if (off) el.hidden = true; continue; }
      el.hidden = off;
    }
    // Nothing on screen could stop a playing track once the transport is gone, so it stops here
    // rather than playing on out of reach. The lock screen would still have held controls, but
    // "I hid the player and the music kept going" is not a thing to leave to chance.
    if (off) {
      if (audio && !audio.paused) { try { audio.pause(); } catch (e) {} }
      if (ytOn) ytStop();
      paintPlay();
    }
    paintStageHint();
  }

  // One place decides what the empty stage says, because three different states can leave it
  // empty and each needs a different sentence.
  function paintStageHint() {
    const el = $('stageHint');
    if (!el) return;
    if (micLive || current >= 0) { el.hidden = true; return; }
    el.hidden = false;
    el.textContent = readHidePlayer()
      ? 'Turn on the microphone in the menu — the visuals follow whatever this phone can hear.'
      : 'Pick some music and press play — the visuals follow the sound. Tap them for full screen.';
  }

  // ONE place that talks to BOTH renderers, because each one's setConfig REPLACES its config:
  // they merge what you pass over their defaults, so a call carrying only `ambient` silently
  // resets the burst effect, and a call carrying only `style` silently resets the equalizer's
  // colour. Every setting this app owns goes in every call, to both.
  function applyRenderers() {
    rollEq();
    const q = QUALITY[readQuality()];
    if (eq) {
      eq.setConfig({ style: eqShapeNow, palette: eqPaletteNow });
      // Per SURFACE, deliberately not part of the saved config — the renderer keeps frame rate
      // out of setConfig for exactly this reason, so it is set separately every time.
      if (eq.setFps) eq.setFps(q.fps);
    }
    if (!fx) return;
    fx.setConfig({
      ambient: readAmbient(),
      palette: readPalette(),
      particleCap: q.parts,
      ambientCap: q.amb,
      effects: { fountain: FOUNTAIN },
      beat: {
        effect: readBeatEffect(),
        sensitivity: SENS[readSens()],
        intensity: PUNCH[readPunch()],
      },
    });
  }
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

  // The context, the element analyser and the shared band buffer. Split out of ensureGraph
  // because the microphone can now be the first thing this app ever opens: there may be no
  // track, no <audio> element and no play yet, and the graph still has to exist.
  function ensureCtx() {
    if (ctx) return true;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;                         // no Web Audio: still plays, just no visuals
    ctx = new AC();
    analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;                       // 512 bins, plenty for 64 bands
    analyser.smoothingTimeConstant = 0.75;
    freq = new Uint8Array(analyser.frequencyBinCount);
    return true;
  }

  function ensureGraph(el) {
    if (!ensureCtx()) return false;
    if (!srcNode) {
      srcNode = ctx.createMediaElementSource(el);
      srcNode.connect(analyser);
      analyser.connect(ctx.destination);           // ← the line whose absence is silence
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return true;
  }

  // ── The microphone ──────────────────────────────────────────────────────
  // Why this exists: everything else in this app can only see audio it owns. A file it plays,
  // yes; a YouTube video or a link from a host that will not grant permission, no — those come
  // back as silence and the visuals sit dead. The microphone is the one source that can see
  // ANY sound in the room, including music playing from another app entirely.
  //
  // ITS ANALYSER IS NEVER CONNECTED TO destination. The element path must be
  // (analyser -> destination is how the file reaches the speakers), and sending a microphone
  // down that same line on a phone — speaker centimetres from the mic — is a feedback howl.
  // Two analysers rather than one, so that line can never be shared by accident.
  const MIC_KEY = 'hive-pocket.mic';
  let micAnalyser = null, micSrc = null, micStream = null, micLive = false, micArmed = false;

  function readMicAuto() {
    try { return JSON.parse(localStorage.getItem(MIC_KEY) || '{}').auto === true; }
    catch (e) { return false; }
  }
  function writeMicAuto(on) {
    try { localStorage.setItem(MIC_KEY, JSON.stringify({ auto: on === true })); }
    catch (e) { /* private mode */ }
  }

  function micNote(msg) { const el = $('micNote'); if (el) el.textContent = msg; }

  // Keeping the screen awake. Measured before this shipped rather than after: a live microphone,
  // both canvases and a bright screen cost 3% of Harold's battery in 15 minutes — about 12% an
  // hour, which is ordinary screen-on territory and cheap enough that the density caps do not
  // need turning down to afford it.
  //
  // It follows the MICROPHONE, not full screen. A phone propped against something is listening
  // whether or not the stage fills the screen, and that is the case where sleeping ruins it.
  // Full screen stays a deliberate tap and does not imply this.
  let wakeLock = null;

  async function keepAwake(on) {
    if (!on) {
      const held = wakeLock; wakeLock = null;
      if (held) { try { await held.release(); } catch (e) { /* already gone */ } }
      return;
    }
    if (wakeLock || !navigator.wakeLock || document.visibilityState !== 'visible') return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      // The browser drops it on its own when the page is hidden, and does not tell this code
      // beforehand. Clearing the handle here keeps the re-acquire below from thinking it still
      // holds one it does not.
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch (e) {
      wakeLock = null;                 // refused, or no support: the app works, the screen sleeps
    }
  }

  // A wake lock is released whenever the page goes to the background, and is NOT restored when
  // it comes back. Without this, switching apps once and returning leaves the screen sleeping
  // again with the microphone still open, which reads as the feature having quietly broken.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && micLive) keepAwake(true);
  });

  function micPaint() {
    const b = $('micBtn');
    if (b) {
      b.textContent = micLive ? 'Stop listening' : 'Listen with the microphone';
      b.setAttribute('aria-pressed', micLive ? 'true' : 'false');
    }
    const c = $('micAuto');
    if (c) c.checked = readMicAuto();
    // Say it on the main screen too. A microphone that is open and unmentioned is the kind of
    // thing that should never be a surprise, and with no track loaded there is nothing else here.
    if (current < 0) {
      $('nowTitle').textContent = micLive ? 'Listening' : 'Nothing loaded';
      $('nowSub').textContent = micLive
        ? 'The visuals follow whatever this phone can hear.'
        : 'Tap the folder button to choose music from this phone';
    }
    paintStageHint();
  }

  async function micStart(fromGesture) {
    if (micLive) return true;
    // isSecureContext, not a protocol string. The browser is the authority on what counts —
    // it trusts 127.0.0.1 and localhost as well as https, and a hand-rolled check got that
    // wrong and refused to open on a local test server.
    if (!window.isSecureContext) {
      micNote('A microphone needs a secure address. This page is not on one.');
      return false;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      micNote('This browser will not open a microphone.');
      return false;
    }
    if (!ensureCtx()) { micNote('This browser has no Web Audio, so there is nothing to draw.'); return false; }
    try {
      // All three off, deliberately. They default ON because the default caller is a phone call,
      // and every one of them is wrong here: autoGainControl rides the level and flattens exactly
      // the dynamics the visuals exist to show, noiseSuppression is trained on speech and treats
      // sustained music as noise, and echoCancellation subtracts what the speakers are playing —
      // which, when the phone is listening to a speaker, is the whole signal.
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        video: false,
      });
    } catch (e) {
      micStream = null;
      const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
      micNote(denied
        ? 'The microphone was refused. Allow it for this site and try again.'
        : 'No microphone opened: ' + ((e && e.name) || 'unknown error') + '.');
      micPaint();
      return false;
    }
    if (!micAnalyser) {
      micAnalyser = ctx.createAnalyser();
      micAnalyser.fftSize = 1024;
      micAnalyser.smoothingTimeConstant = 0.75;
    }
    micSrc = ctx.createMediaStreamSource(micStream);
    micSrc.connect(micAnalyser);          // and NOWHERE else. See the note above.
    micLive = true;
    // Listening to the room while this app plays its own file would draw both at once, one of
    // them through a speaker. Pause rather than tear down, so play still resumes where it was.
    if (audio && !audio.paused) { try { audio.pause(); } catch (e) {} }
    if (ytOn) ytStop();
    paintPlay();
    initVisuals();
    startPump();
    // A context created without a gesture is born suspended, and resume() may be refused until
    // the page is touched. Say so rather than drawing a flat line and looking broken.
    if (ctx.state === 'suspended') {
      try { await ctx.resume(); } catch (e) { /* refused */ }
    }
    await keepAwake(true);
    const awake = wakeLock ? ' The screen will stay awake.' : '';
    if (ctx.state === 'suspended') {
      micNote('Listening — tap the screen once to let the phone start drawing.' + awake);
      armResume();
    } else {
      micNote((fromGesture === false
        ? 'Listening. Started by itself, because you asked it to.'
        : 'Listening.') + awake);
    }
    micPaint();
    return true;
  }

  // One tap, once, anywhere. Only armed when a context is stuck suspended.
  function armResume() {
    if (micArmed) return;
    micArmed = true;
    const go = () => {
      document.removeEventListener('pointerdown', go, true);
      micArmed = false;
      if (!ctx) return;
      ctx.resume().then(() => { if (micLive) micNote('Listening.'); }).catch(() => {});
    };
    document.addEventListener('pointerdown', go, true);
  }

  function micStop() {
    if (!micLive) return;
    micLive = false;
    try { if (micSrc) micSrc.disconnect(); } catch (e) {}
    micSrc = null;
    // Stop the TRACKS, not just the node: the phone keeps its recording indicator lit and holds
    // the device open until every track is stopped.
    if (micStream) {
      try { micStream.getTracks().forEach((t) => t.stop()); } catch (e) {}
      micStream = null;
    }
    if (current < 0) stopPump();
    keepAwake(false);
    micNote('Not listening.');
    micPaint();
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
    // The microphone wins while it is open: it is the source the person deliberately chose, and
    // the element analyser may still be holding the last frame of a paused track.
    const an = micLive && micAnalyser ? micAnalyser : analyser;
    if (!an || !freq) return null;
    an.getByteFrequencyData(freq);
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
    // Stars by default, never storm or lightning: those flash, so they are only ever on
    // because someone picked them in Settings.
    applyRenderers();
    eq.start();
    fx.start();
    applyVisuals(visuals);   // the canvases exist now, so the stored choice can take effect
  }

  // `hidden` and not opacity: an invisible canvas is still a canvas being painted every frame,
  // and this runs on a phone battery. The pump below stops feeding whichever one is off, and a
  // renderer re-measures on the way back because it was sized to a box of zero while away.
  // One place decides what is on the stage, because there are now two reasons for a canvas to
  // be hidden — the person chose to hide it, or YouTube is using the stage — and two booleans
  // fighting over the same element is how one of them wins by accident.
  function paintStage() {
    $('ytStage').hidden = !ytOn;
    $('eqCanvas').hidden = ytOn || !eqShown();
    $('fxCanvas').hidden = ytOn || !fxShown();
    if (!ytOn) {
      if (eq && eqShown()) eq.resize();
      if (fx && fxShown()) fx.resize();
    }
  }

  function applyVisuals(v) {
    visuals = VISUALS.includes(v) ? v : 'both';
    try { localStorage.setItem(VISUALS_KEY, visuals); } catch (e) { /* private mode */ }
    paintStage();
    $('visualsSel').value = visuals;
    const on = fxShown();
    $('fxBtn').setAttribute('aria-pressed', on ? 'true' : 'false');
    label('fxBtn', on ? 'Effects on' : 'Effects off');
  }

  // ── Full screen ──────────────────────────────────────────────────────────────────────
  // Native full screen is what a phone should get: it takes the browser's own bars away too.
  // It can also be absent, or refused when the tap does not look like a gesture to the browser,
  // and it gives no useful error when it is. So the class goes on FIRST and unconditionally —
  // that alone covers the screen — and the native request is a best-effort improvement on top.
  // The tap always does something visible, which is the whole contract of a tap.
  let covered = false;
  let tipTimer = 0;

  function nativeOn() {
    const el = $('stageWrap');
    const req = el.requestFullscreen || el.webkitRequestFullscreen;
    if (!req) return;
    try { Promise.resolve(req.call(el)).catch(() => {}); } catch (e) { /* refused */ }
  }
  function nativeOff() {
    const off = document.exitFullscreen || document.webkitExitFullscreen;
    if (!off || !(document.fullscreenElement || document.webkitFullscreenElement)) return;
    try { Promise.resolve(off.call(document)).catch(() => {}); } catch (e) { /* already out */ }
  }

  function setCover(on) {
    covered = on === true;
    // The WRAPPER, not the stage: YouTube's player is its sibling and has to come along, or
    // going full screen on a YouTube track would cover the screen with an empty canvas.
    $('stageWrap').classList.toggle('cover', covered);
    $('stage').setAttribute('aria-pressed', covered ? 'true' : 'false');
    label('stage', covered ? 'Tap to leave full screen' : 'Tap for full screen');
    // The way back has to be discoverable. It is the same tap, which is not obvious, so say so
    // once and then get out of the way of the thing the person went full screen to look at.
    clearTimeout(tipTimer);
    $('coverTip').hidden = !covered;
    $('coverTip').style.opacity = '';
    if (covered) tipTimer = setTimeout(() => { $('coverTip').style.opacity = '0'; }, 2600);
    if (covered) nativeOn(); else nativeOff();
    // The stage just changed size by a lot. A renderer that missed it draws into the old box.
    if (eq && eqShown()) eq.resize();
    if (fx && fxShown()) fx.resize();
  }

  function pump() {
    if (!pumping) return;
    const b = readBands();
    if (b) {
      if (eq && eqShown()) eq.push(b);
      if (fx && fxShown()) fx.pushBands(b);
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
      del.setAttribute('title', 'Remove ' + t.name);
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
      if (ytOn) ytStop();
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

  // ── YouTube's player ─────────────────────────────────────────────────────────────────
  let ytPlayer = null;      // the YT.Player, once the script has arrived and built one
  let ytPlaying = false;    // the player's own idea of whether it is playing
  let ytTick = 0;           // the progress poll: an iframe fires no timeupdate at this page
  let ytScript = null;      // the in-flight load, so a second track does not fetch it twice

  const YT_NOTE = 'From YouTube. No equalizer or effects: that sound comes from another site.';

  // Fetches YouTube's player script, once. Rejects rather than hanging if it never arrives,
  // which is what happens with no connection — and this is the one part of the app that needs
  // one, so it has to say so instead of sitting on a black rectangle.
  function ensureYT() {
    if (window.YT && window.YT.Player) return Promise.resolve(window.YT);
    if (ytScript) return ytScript;
    ytScript = new Promise((resolve, reject) => {
      const done = setTimeout(() => reject(new Error('timeout')), 12000);
      window.onYouTubeIframeAPIReady = () => { clearTimeout(done); resolve(window.YT); };
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      s.onerror = () => { clearTimeout(done); reject(new Error('blocked')); };
      document.head.appendChild(s);
    });
    // A failed load must not be remembered as in-flight forever; the next track tries again.
    ytScript.catch(() => { ytScript = null; });
    return ytScript;
  }

  function ytStop() {
    clearInterval(ytTick);
    ytTick = 0;
    ytPlaying = false;
    if (ytPlayer && ytPlayer.stopVideo) { try { ytPlayer.stopVideo(); } catch (e) {} }
    ytOn = false;
    paintStage();
  }

  function ytPoll() {
    if (!ytPlayer || !ytPlayer.getDuration) return;
    let d = 0, t = 0;
    try { d = ytPlayer.getDuration() || 0; t = ytPlayer.getCurrentTime() || 0; } catch (e) { return; }
    $('tNow').textContent = fmt(t);
    $('tEnd').textContent = fmt(d);
    const sk = $('seek');
    if (document.activeElement !== sk) { sk.max = String(d); sk.value = String(t); }
    // The player renames the row the moment it knows what it is playing. A playlist renames on
    // every track, which is the point: the queue says what is actually on.
    const data = ytPlayer.getVideoData ? ytPlayer.getVideoData() : null;
    const t0 = queue[current];
    if (data && data.title && t0 && t0.yt && t0.name !== data.title) {
      t0.name = String(data.title).slice(0, 200);
      renderQueue();
      $('nowTitle').textContent = t0.name;
    }
  }

  function ytState(ev) {
    // 1 playing, 2 paused, 0 ended. The rest are buffering and cueing, which are not states
    // the transport has anything to say about.
    if (ev.data === 1) {
      ytPlaying = true;
      ytPoll();                                    // name the row now, not on the next tick
      if (!ytTick) ytTick = setInterval(ytPoll, 500);
    }
    else if (ev.data === 2) ytPlaying = false;
    else if (ev.data === 0) { ytPlaying = false; next(true); return; }
    paintPlay();
  }

  function playYouTube(i, t) {
    teardown();          // whatever the <audio> element was doing, it is not doing it now
    current = i;
    ytOn = true;
    paintStage();
    $('nowTitle').textContent = t.name;
    $('nowSub').textContent = YT_NOTE;
    $('stageHint').hidden = true;
    renderQueue();
    paintPlay();

    ensureYT().then((YT) => {
      // The queue may have moved on while the script was in the air.
      if (!ytOn || queue[current] !== t) return;
      const load = () => {
        if (t.yt.kind === 'playlist') ytPlayer.loadPlaylist({ list: t.yt.id, listType: 'playlist' });
        else ytPlayer.loadVideoById(t.yt.id);
      };
      if (ytPlayer && ytPlayer.loadVideoById) { load(); return; }
      ytPlayer = new YT.Player('ytFrame', {
        // nocookie, and only the controls the player needs: this app is not in the business of
        // showing anyone related videos.
        host: 'https://www.youtube-nocookie.com',
        playerVars: { playsinline: 1, rel: 0, modestbranding: 1 },
        events: {
          onReady: load,
          onStateChange: ytState,
          onError: () => {
            $('nowSub').textContent = 'YouTube would not play that one. It may be private, '
              + 'removed, or blocked outside YouTube.';
            ytPlaying = false;
            paintPlay();
          },
        },
      });
    }).catch(() => {
      ytOn = false;
      paintStage();
      $('nowSub').textContent = 'YouTube could not be reached. It needs a connection; '
        + 'music on this phone does not.';
      paintPlay();
    });
  }

  // ── Playback ─────────────────────────────────────────────────────────────────────────
  const TAP_NOTE = 'Tap play to start — the phone needs a tap before it makes sound.';
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
    if (t.yt) { playYouTube(i, t); return; }
    // Coming back to ordinary audio: give the stage its canvases back before anything else,
    // or the equalizer draws behind an iframe nobody can see past.
    if (ytOn) ytStop();
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
    el.play().then(started).catch(() => {
      $('nowSub').textContent = TAP_NOTE;
      paintPlay();
    });
    paintPlay();
  }

  // Playback ACTUALLY began. Only now can the graph be built: a phone refuses the first
  // attempt, so this has to run on whichever attempt wins — the automatic one, or the tap
  // that follows it. Hanging it on play() alone left a blocked first track playing with a
  // dead stage for the rest of the session, because the resume path never built the graph.
  function started() {
    if (audio && ensureGraph(audio)) { initVisuals(); startPump(); }
    // The tap happened. Leave any other note alone — a link playing without visuals has its
    // own, and that one is still true.
    if ($('nowSub').textContent === TAP_NOTE) $('nowSub').textContent = 'From this device';
    paintMediaSession();
  }

  function toggle() {
    // Route on WHAT IS CURRENT, not on the flag. Picking new files sets current to -1 and leaves
    // YouTube playing, and a toggle that trusted the flag alone answered a press of Play by
    // pausing YouTube — the newly picked music never started, and the button looked broken.
    const t = queue[current];
    if (ytOn && t && t.yt) {
      if (!ytPlayer) return;                       // still fetching the script
      try { if (ytPlaying) ytPlayer.pauseVideo(); else ytPlayer.playVideo(); } catch (e) {}
      return;
    }
    if (ytOn) ytStop();                            // the queue has moved off it
    if (!audio || current < 0) { if (queue.length) play(0); return; }
    if (audio.paused) audio.play().then(started).catch(() => {});
    else audio.pause();
  }
  // fromEnd: a track that ran out, as opposed to the button. Only the former stops at the end
  // of the queue — pressing Next at the last track wrapping is what people expect.
  function next(fromEnd) {
    if (!queue.length) return;
    // Inside a YouTube playlist, Next means the next video in it — the whole playlist is one
    // row in this queue, and skipping past it would throw away the rest of what was asked for.
    // At the end of the playlist the player reports ENDED, which arrives here as fromEnd.
    if (ytOn && !fromEnd && ytPlayer && queue[current] && queue[current].yt
        && queue[current].yt.kind === 'playlist') {
      try { ytPlayer.nextVideo(); return; } catch (e) { /* fall through to the queue */ }
    }
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
    if (ytOn && ytPlayer) { try { ytPlayer.pauseVideo(); } catch (e) {} }
    else if (audio) audio.pause();
    $('nowSub').textContent = 'End of the queue.';
    paintPlay();
  }
  function prev() {
    if (!queue.length) return;
    if (ytOn && ytPlayer && queue[current] && queue[current].yt
        && queue[current].yt.kind === 'playlist') {
      try { ytPlayer.previousVideo(); return; } catch (e) { /* fall through to the queue */ }
    }
    if (!ytOn && audio && audio.currentTime > 3) { audio.currentTime = 0; return; }
    play(current <= 0 ? queue.length - 1 : current - 1);
  }

  // ── Painting ─────────────────────────────────────────────────────────────────────────
  function paintPlay() {
    const playing = ytOn ? ytPlaying : (!!audio && !audio.paused);
    $('playIcon').hidden = playing;
    $('pauseIcon').hidden = !playing;
    label('playBtn', playing ? 'Pause' : 'Play');
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
    // No pump for YouTube: there are no bands to push. The analyser cannot read another
    // origin's audio, so running the loop would only burn a phone battery drawing nothing.
    if (!playing || ytOn) stopPump(); else startPump();
  }

  function paintTime() {
    if (ytOn || !audio) return;   // the iframe has its own clock, polled in ytPoll()
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
    queue = queue.concat(readLinks().map((l) => ({ name: l.name, url: l.url, link: true, yt: parseYouTube(l.url) })));
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
    queue.push({ name: entry.name, url: entry.url, link: true, yt: parseYouTube(entry.url) });
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

  // ── Settings sheet ───────────────────────────────────────────────────────────────────
  // The OS asking for reduced motion is a real signal, but it is a DEFAULT and picking storm by
  // name is a decision. A default does not get to overrule a decision that came after it, so this
  // says so rather than silently forcing the picker back to stars — which would look like the
  // setting was broken. The default is already a non-flashing mode; nothing here needs vetoing.
  function reducedMotion() {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches === true; }
    catch (e) { return false; }
  }

  function paintLook() { const el = $('lookSel'); if (el) el.value = currentLook(); }

  function paintSheet() {
    $('ambientSel').value = readAmbient();
    $('beatSel').value = readBeatEffect();
    $('sensSel').value = readSens();
    $('punchSel').value = readPunch();
    $('hidePlayer').checked = readHidePlayer();
    $('qualSel').value = readQuality();
    $('palSel').value = readPalette();
    $('eqSel').value = readEqStyle();
    paintLook();
    $('visualsSel').value = visuals;
    $('motionNote').hidden = !reducedMotion();
    const n = readLinks().length;
    $('linkCount').textContent = n ? (n + ' saved. They come back every time you open the app.') : 'None saved.';
    $('forgetLinks').disabled = !n;
    $('aboutVer').textContent = 'beta ' + VERSION.replace(/-beta$/, '');
  }
  function openSheet() {
    paintSheet();
    $('sheetBack').hidden = false; $('sheet').hidden = false;
    $('menuBtn').setAttribute('aria-expanded', 'true');
    $('sheetClose').focus();
  }
  function closeSheet() {
    $('sheetBack').hidden = true; $('sheet').hidden = true;
    $('menuBtn').setAttribute('aria-expanded', 'false');
    $('menuBtn').focus();
  }

  // ── Wiring ───────────────────────────────────────────────────────────────────────────
  $('menuBtn').addEventListener('click', () => ($('sheet').hidden ? openSheet() : closeSheet()));
  $('sheetClose').addEventListener('click', closeSheet);
  $('sheetBack').addEventListener('click', closeSheet);
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && !$('sheet').hidden) closeSheet(); });
  $('ambientSel').addEventListener('change', () => {
    const v = AMBIENTS.includes($('ambientSel').value) ? $('ambientSel').value : 'stars';
    writeAmbient(v);
    paintLook();
    // Live: the renderer takes a new config without restarting, so the change is visible while
    // the sheet is still open rather than on the next track.
    applyRenderers();
  });
  $('forgetLinks').addEventListener('click', () => {
    writeLinks([]);
    // Take them out of the queue too — the queue IS the library for links, and leaving them
    // playing after "forget all" would make the button look like it did nothing.
    queue = queue.filter((t) => !t.link);
    if (current >= queue.length) { teardown(); current = -1; paintPlay(); }
    renderQueue(); paintLib(); paintSheet();
  });

  $('lookSel').addEventListener('change', () => applyLook($('lookSel').value));
  $('surpriseBtn').addEventListener('click', surprise);
  // The same action from the header. It flashes what it landed on, because a roll that changes
  // the picture with no word for what it did leaves you unable to ask for it again.
  $('rollBtn').addEventListener('click', () => { surprise(); sayRoll(); });

  // Names what was just rolled, on the stage, briefly. Uses the existing hint element rather than
  // adding a second overlay: it is already the one thing on the stage that speaks.
  let rollTimer = 0;
  function sayRoll() {
    const el = $('stageHint');
    if (!el) return;
    el.hidden = false;
    el.textContent = readBeatEffect() + ' · ' + readPalette() + ' · ' + readEqStyle()
      + (readAmbient() === 'off' ? '' : ' · ' + readAmbient());
    clearTimeout(rollTimer);
    rollTimer = setTimeout(paintStageHint, 1800);
  }
  $('eqSel').addEventListener('change', () => {
    writeEqStyle(EQ_STYLES.includes($('eqSel').value) ? $('eqSel').value : 'bars');
    applyRenderers(); paintLook();
  });
  $('palSel').addEventListener('change', () => {
    writePalette(PALETTES.includes($('palSel').value) ? $('palSel').value : 'hive');
    applyRenderers(); paintLook();
  });

  $('punchSel').addEventListener('change', () => {
    writePunch(PUNCH[$('punchSel').value] ? $('punchSel').value : 'normal');
    applyRenderers();
  });

  $('qualSel').addEventListener('change', () => {
    writeQuality(QUALITY[$('qualSel').value] ? $('qualSel').value : 'full');
    applyRenderers();
  });

  $('hidePlayer').addEventListener('change', () => {
    writeHidePlayer($('hidePlayer').checked);
    applyHidePlayer();
  });

  $('sensSel').addEventListener('change', () => {
    writeSens(SENS[$('sensSel').value] ? $('sensSel').value : 'easy');
    applyRenderers(); paintLook();
  });

  $('beatSel').addEventListener('change', () => {
    const v = BEAT_EFFECTS.includes($('beatSel').value) ? $('beatSel').value : 'fireworks';
    writeBeatEffect(v);
    applyRenderers(); paintLook();
  });

  $('micBtn').addEventListener('click', () => { if (micLive) micStop(); else micStart(true); });
  $('micAuto').addEventListener('change', () => {
    writeMicAuto($('micAuto').checked);
    // Ticking it is also a decision to listen NOW — otherwise the setting appears to do nothing
    // until the next cold start, which reads as broken.
    if ($('micAuto').checked && !micLive) micStart(true);
  });

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
  $('seek').addEventListener('input', () => {
    const v = Number($('seek').value);
    if (ytOn) { if (ytPlayer && ytPlayer.seekTo) { try { ytPlayer.seekTo(v, true); } catch (e) {} } return; }
    if (audio) audio.currentTime = v;
  });
  function paintModes() {
    const s = $('shuffleBtn');
    s.setAttribute('aria-pressed', shuffleOn ? 'true' : 'false');
    label('shuffleBtn', shuffleOn ? 'Shuffle on' : 'Shuffle off');
    const r = $('repeatBtn');
    r.setAttribute('aria-pressed', repeatMode !== 'off' ? 'true' : 'false');
    label('repeatBtn',
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

  // Effects off means the equalizer alone; effects on means both. Turning them on from
  // "equalizer only" cannot land on "effects only", because that would take away the thing
  // that was on screen a moment ago.
  $('stage').addEventListener('click', () => setCover(!covered));
  // Android's back gesture and Escape both leave native full screen without telling this code.
  // Without this the class would stay on and the stage would sit over the whole page with no
  // browser chrome to explain it.
  for (const ev of ['fullscreenchange', 'webkitfullscreenchange']) {
    document.addEventListener(ev, () => {
      const native = !!(document.fullscreenElement || document.webkitFullscreenElement);
      if (!native && covered) setCover(false);
    });
  }

  $('fxBtn').addEventListener('click', () => applyVisuals(fxShown() ? 'eq' : 'both'));
  $('visualsSel').addEventListener('change', () => applyVisuals($('visualsSel').value));

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
  micPaint();
  micNote('Not listening.');
  applyHidePlayer();
  // Remembered microphone, reopened without a tap. This works — and ONLY works — because
  // getUserMedia needs no gesture once permission has been granted for this origin. It is a
  // promise that could not be kept for system audio, which is refused without a fresh tap
  // every time, so nothing here offers that.
  if (readMicAuto()) {
    setTimeout(() => { micStart(false); }, 0);
  }
  applyVisuals(readVisuals());
  queue = readLinks().map((l) => ({ name: l.name, url: l.url, link: true, yt: parseYouTube(l.url) }));
  if (shuffleOn) buildOrder();
  renderQueue();
  paintLib();
  paintModes();

  window.__pocket = {
    version: VERSION,
    get links() { return readLinks(); },
    get modes() { return { shuffle: shuffleOn, repeat: repeatMode }; },
    get ambient() { return readAmbient(); },
    get palette() { return readPalette(); },
    get eqStyle() { return readEqStyle(); },
    get eqShape() { return eqShapeNow; },
    surprise,
    get look() { return currentLook(); },
    get beatEffect() { return readBeatEffect(); },
    get beatSens() { return { name: readSens(), value: SENS[readSens()] }; },
    get punch() { return { name: readPunch(), value: PUNCH[readPunch()] }; },
    get playerHidden() { return readHidePlayer(); },
    get quality() { return { name: readQuality(), caps: QUALITY[readQuality()] }; },
    addLink,
    removeAt,
    get queue() { return queue; },
    get current() { return current; },
    get bands() { return readBands(); },
    get graphReady() { return !!(ctx && analyser && srcNode); },
    get micLive() { return micLive; },
    get micAuto() { return readMicAuto(); },
    get awake() { return !!wakeLock; },
    // Reports only that the microphone has an analyser of its own. The guarantee that it never
    // reaches the speakers is STRUCTURAL — nothing is ever connected downstream of it — and no
    // getter can prove that from here; read the three connect() calls in this file instead.
    get micIsolated() { return !!(micAnalyser && micAnalyser !== analyser); },
    micStart, micStop,
    get visuals() { return visuals; },
    get covered() { return covered; },
    get youtube() { return ytOn; },
    parseYouTube,
    // Read-only counts from the effects renderer. Storm and lightning draw bolts as an event
    // subsystem separate from the weather particles, so 'is lightning actually striking' cannot
    // be answered from the config — only from here.
    get fxStats() { return fx ? fx.stats() : null; },
    get fxAmbient() { return fx ? fx.getAmbientMode() : null; },
    // What the effects renderer is actually holding. The particle count cannot answer "did that
    // setting arrive" once the budget is saturated — every size looks like 1200 — so the config
    // itself is the only honest check.
    get fxConfig() {
      if (!fx || !fx.getConfig) return null;
      const c = fx.getConfig();
      return { intensity: c.beat.intensity, effect: c.beat.effect, fountain: c.effects.fountain,
               hearts: c.effects.hearts, particleCap: c.particleCap };
    },
  };
})();
