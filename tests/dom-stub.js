/**
 * A browser small enough to hold in your head, for testing pocket.js under plain Node.
 *
 * WHY NOT A REAL BROWSER. The Chrome reachable from a session on this machine is a HIDDEN tab,
 * and a hidden tab freezes requestAnimationFrame and clamps its timers to nothing: a canvas
 * renderer never draws a frame, setInterval never fires, and anything that awaits a frame hangs
 * until the debugger times out. That box also has no audio device, so a media element's play()
 * promise never settles. A green run there would have meant nothing, so the app is loaded into
 * a stub instead, where every one of those things is under the test's control.
 *
 * WHAT IS REAL HERE. Element state that the app reads back — textContent, hidden, value,
 * attributes, class membership — is stored and returned honestly, because a test that lets the
 * app write to a black hole can assert anything. Drawing is not: the renderers are stubbed, and
 * what they draw is ambient-smoke.js's job.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const noop = () => {};

class SandboxURL extends URL {}
SandboxURL.createObjectURL = () => 'blob:stub/1';
SandboxURL.revokeObjectURL = noop;

/** Dispatch to the listeners the app registered for `type`. */
function fire(target, type, ev) {
  const list = (target.handlers && target.handlers[type]) || [];
  for (const fn of list.slice()) {
    fn(Object.assign({ type, target, preventDefault: noop, stopPropagation: noop }, ev || {}));
  }
}

/** An element that answers everything the app asks of one, and remembers what it was told. */
function el(id) {
  const classes = new Set();
  const e = {
    id,
    tagName: 'DIV',
    textContent: '',
    value: '',
    hidden: false,
    disabled: false,
    className: '',
    style: {},
    attrs: {},
    children: [],
    handlers: {},
    files: null,
    addEventListener(t, fn) { (e.handlers[t] = e.handlers[t] || []).push(fn); },
    removeEventListener: noop,
    setAttribute(k, v) { e.attrs[k] = v; },
    removeAttribute(k) { delete e.attrs[k]; },
    getAttribute(k) { return k in e.attrs ? e.attrs[k] : null; },
    appendChild(c) { e.children.push(c); return c; },
    append(...cs) { e.children.push(...cs); },
    remove: noop,
    focus: noop,
    click() { fire(e, 'click'); },
    // Real membership, not a no-op: `covered` is read back off this and a stub that forgets
    // would let the full-screen tests pass against an app that never touched the class.
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) => (on === undefined ? (classes.has(c) ? classes.delete(c) : classes.add(c))
                                           : (on ? classes.add(c) : classes.delete(c))),
    },
    classes,
    getBoundingClientRect: () => ({ width: 300, height: 150, left: 0, top: 0 }),
    getContext: () => new Proxy({}, { get: () => noop, set: () => true }),
  };
  return e;
}

/**
 * Load the app.
 *
 *   opts.src            source to run (defaults to the real pocket.js) — a case can load a
 *                       deliberately broken build to prove its own assertion can fail
 *   opts.blockFirstPlay refuse the first play() the way a phone does, allow every one after
 *   opts.noFullscreen   no requestFullscreen on the element, as on a browser that lacks it
 *   opts.refuseFullscreen  the API exists and rejects, which is what a browser does when it
 *                       does not believe a gesture happened
 *   opts.reducedMotion  what matchMedia reports
 *   opts.brokenRenderer the equalizer throws when configured, the way a renderer that cannot
 *                       start does — the case whose silence cost a release to find
 *   opts.youtube        'ok' (default) the player script arrives and works, 'blocked' it fails
 *                       to load the way it does with no connection
 */
function boot(opts) {
  const o = opts || {};
  const src = o.src || fs.readFileSync(path.join(__dirname, '..', 'pocket.js'), 'utf8');
  const els = {};
  const get = (id) => (els[id] = els[id] || el(id));

  const media = el('theAudio');
  media.tagName = 'AUDIO';
  media.paused = true;
  media.currentTime = 0;
  media.duration = 30;
  media.src = '';
  let playCalls = 0;
  media.play = () => {
    playCalls++;
    if (o.blockFirstPlay && playCalls === 1) return Promise.reject(new Error('NotAllowedError'));
    media.paused = false;
    return Promise.resolve();
  };
  media.pause = () => { media.paused = true; };
  media.load = () => { media.paused = true; media.currentTime = 0; };

  // A stand-in for YouTube's player. It records what it was asked to load and lets a test drive
  // the state changes the real one fires, because those are what the transport reacts to.
  const yt = { scripts: 0, players: 0, player: null, loaded: [], calls: [] };
  function FakePlayer(mount, opts) {
    yt.players++;
    const ev = (opts && opts.events) || {};
    const self = {
      mount,
      opts,
      state: -1,
      loadVideoById(id) { yt.loaded.push({ kind: 'video', id }); self.fire(1); },
      loadPlaylist(o) { yt.loaded.push({ kind: 'playlist', id: o.list }); self.fire(1); },
      playVideo() { yt.calls.push('play'); self.fire(1); },
      pauseVideo() { yt.calls.push('pause'); self.fire(2); },
      stopVideo() { yt.calls.push('stop'); },
      nextVideo() { yt.calls.push('next'); },
      previousVideo() { yt.calls.push('previous'); },
      seekTo(t) { yt.calls.push('seek:' + t); },
      getDuration: () => 210,
      getCurrentTime: () => 12,
      getPlayerState: () => self.state,
      getVideoData: () => ({ title: 'A Song From YouTube' }),
      fire(state) { self.state = state; if (ev.onStateChange) ev.onStateChange({ data: state }); },
      error() { if (ev.onError) ev.onError({ data: 150 }); },
    };
    yt.player = self;
    // The real player calls onReady once the iframe is up, never synchronously.
    setTimeout(() => { if (ev.onReady) ev.onReady(); }, 0);
    return self;
  }

  const fullscreen = { element: null, requests: 0, exits: 0 };
  const store = new Map();
  const docHandlers = {};
  const doc = {
    getElementById: get,
    createElement: (tag) => {
      if (tag === 'audio') return media;
      const e = el('');
      e.tagName = String(tag).toUpperCase();
      return e;
    },
    handlers: docHandlers,
    addEventListener(t, fn) { (docHandlers[t] = docHandlers[t] || []).push(fn); },
    // Appending YouTube's script is a network fetch. Either it arrives and announces itself the
    // way the real one does, or it fails — which is the case with no connection, and the one
    // most likely to be handled badly.
    head: {
      appendChild(node) {
        yt.scripts++;
        setTimeout(() => {
          if (o.youtube === 'blocked') { if (node.onerror) node.onerror(); return; }
          sandbox.YT = { Player: FakePlayer };
          if (typeof sandbox.onYouTubeIframeAPIReady === 'function') sandbox.onYouTubeIframeAPIReady();
        }, 0);
        return node;
      },
    },
    // applyHidePlayer() walks a list of selectors, both ids and classes. Without this the stub
    // threw "document.querySelector is not a function" and took two whole smoke suites down with
    // it — a gap that had been there since hide-player shipped, and that made those suites look
    // like a code failure rather than a missing stub.
    querySelector: (sel) => {
      const s = String(sel || '');
      return s.charAt(0) === '#' ? get(s.slice(1)) : el(s);
    },
    querySelectorAll: () => [],
    hidden: false,
    get fullscreenElement() { return fullscreen.element; },
    exitFullscreen() {
      fullscreen.exits++;
      fullscreen.element = null;
      fire(doc, 'fullscreenchange');
      return Promise.resolve();
    },
  };

  const stage = get('stageWrap');
  if (!o.noFullscreen) {
    stage.requestFullscreen = () => {
      fullscreen.requests++;
      if (o.refuseFullscreen) return Promise.reject(new Error('NotAllowedError'));
      fullscreen.element = stage;
      fire(doc, 'fullscreenchange');
      return Promise.resolve();
    };
  }

  const sandbox = {
    console: { log: noop, warn: noop, error: noop },
    setTimeout, clearTimeout, setInterval, clearInterval,
    Promise, Math, JSON, Date, String, Number, Array, Object, Boolean, Error,
    Uint8Array, Set, Map, isFinite, parseInt, parseFloat,
    // The REAL URL class with the two blob helpers hung off it. It was a bare object once, and
    // every `new URL(...)` inside the app threw — which the app catches and reads as "not a
    // link", so link parsing silently failed and no suite noticed, because none added a link.
    URL: SandboxURL,
    performance: { now: () => Date.now() },
    // A plain http origin, so worker registration is skipped — the worker is not what these
    // suites are about, and registering one would need a second set of stubs.
    location: { protocol: 'http:', hostname: '127.0.0.1', href: 'http://127.0.0.1/' },
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: noop,
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    navigator: {
      mediaSession: { metadata: null, playbackState: 'none', setActionHandler: noop },
      serviceWorker: { register: () => Promise.resolve() },
    },
    MediaMetadata: function (m) { Object.assign(this, m); },
    matchMedia: () => ({ matches: o.reducedMotion === true, addEventListener: noop }),
    AudioContext: function () {
      this.state = 'running';
      this.destination = {};
      this.resume = () => Promise.resolve();
      this.createAnalyser = () => ({
        fftSize: 1024, frequencyBinCount: 512, smoothingTimeConstant: 0.75,
        connect: noop, getByteFrequencyData: noop,
      });
      this.createMediaElementSource = () => ({ connect: noop });
    },
    // Counted, not drawn: whether a renderer was told to re-measure after the stage changed
    // size is exactly the thing that is invisible in a screenshot and easy to forget in code.
    // THESE FAKES HAVE TO CARRY EVERY METHOD THE APP CALLS, and the reason is not tidiness.
    // EqRender's fake was missing setConfig, which pocket.js has called since 1.10.0. The app
    // threw on it inside started(), a `.catch(() => {})` two frames up swallowed the throw, and
    // the suite reported it as "the tap clears the stale prompt" failing — a message pointing at
    // a subtitle, three layers away from a missing stub method. A fake that is a subset of the
    // real thing does not make the suite weaker in an obvious place; it makes it wrong in a
    // confusing one. Anything added to a renderer and called from here belongs in this list.
    EqRender: {
      create: () => ({
        push: noop, start: noop, stop: noop, setFps: noop,
        // opts.brokenRenderer makes this throw, which is how a renderer that cannot start on a
        // real phone behaves. It exists because that failure used to be swallowed whole.
        setConfig: () => { if (o.brokenRenderer) throw new Error('renderer refused'); },
        resize: () => resizes.eq++,
      }),
    },
    FxRender: {
      create: () => ({
        setConfig: noop, pushBands: noop, start: noop, stop: noop, say: noop,
        setPlayerUp: noop, isAudioLive: () => false, getBpm: () => ({ bpm: null }),
        fire: () => fires.push([].slice.call(arguments)),
        stats: () => ({ parts: 0, ambient: 0, shells: 0, bolts: 0 }),
        getConfig: () => ({ beat: { intensity: 1, effect: 'fireworks', enabled: true },
                            effects: {}, particleCap: 0 }),
        resize: () => resizes.fx++,
      }),
      // Module-level exports, used by Pocket's own bolt layer rather than by an instance.
      boltPath: (x0, y0, x1, y1) => [[x0, y0], [x1, y1]],
      sample: () => [255, 255, 255],
      stopsFor: () => [[0, [255, 255, 255]], [1, [255, 255, 255]]],
    },
    document: doc,
  };
  const resizes = { eq: 0, fx: 0 };
  const fires = [];
  // A real window has addEventListener; this sandbox is the window, so it needs one or the app
  // dies at load the moment it listens for resize or orientationchange. Caught by the tutorial,
  // which measures its ring again when the screen changes shape — a listener no earlier version
  // of this app happened to need.
  const winHandlers = {};
  sandbox.addEventListener = (t, fn) => { (winHandlers[t] = winHandlers[t] || []).push(fn); };
  sandbox.removeEventListener = (t, fn) => {
    const l = winHandlers[t]; if (!l) return;
    const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1);
  };
  sandbox.winHandlers = winHandlers;
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  new vm.Script(src, { filename: 'pocket.js' }).runInContext(sandbox);

  return {
    sandbox,
    doc,
    els: get,
    media,
    fullscreen,
    yt,
    resizes,
    store,
    pocket: sandbox.window.__pocket,
    playCalls: () => playCalls,
  };
}

/** Queue one track the way the file picker does. */
function pick(app, name) {
  const p = app.els('filePick');
  p.files = [{ name: name || 'tone.wav', type: 'audio/wav' }];
  fire(p, 'change');
}

const settle = () => new Promise((r) => setTimeout(r, 0));

/** A counter with the one property that matters: it can report a failure. */
function makeCheck() {
  const state = { pass: 0, fails: [] };
  state.check = function (name, ok, detail) {
    // ok is a BOOLEAN, deliberately. An earlier suite in this codebase took a function here,
    // and three of its cases passed with the code under test deleted.
    if (ok === true) { state.pass++; console.log('  ok   ' + name); return; }
    state.fails.push(name + (detail ? ' - ' + detail : ''));
    console.log('  FAIL ' + name + (detail ? ' - ' + detail : ''));
  };
  state.report = function () {
    console.log('\n' + state.pass + ' passed, ' + state.fails.length + ' failed\n');
    if (state.fails.length) state.fails.forEach((f) => console.log('  ' + f));
    // EXIT, do not fall off the end. The app sets a repeating timer while YouTube plays, and an
    // open interval keeps Node alive forever — a suite that has printed its result and then
    // hangs looks exactly like a suite stuck in a loop.
    process.exit(state.fails.length ? 1 : 0);
  };
  return state;
}

module.exports = { boot, fire, el, pick, settle, makeCheck, noop };
