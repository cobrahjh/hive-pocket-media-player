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

  const stage = get('stage');
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
    URL: { createObjectURL: () => 'blob:stub/1', revokeObjectURL: noop },
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
    EqRender: { create: () => ({ push: noop, start: noop, stop: noop, resize: () => resizes.eq++ }) },
    FxRender: {
      create: () => ({
        setConfig: noop, pushBands: noop, start: noop, stop: noop, resize: () => resizes.fx++,
      }),
    },
    document: doc,
  };
  const resizes = { eq: 0, fx: 0 };
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
    if (state.fails.length) { state.fails.forEach((f) => console.log('  ' + f)); process.exit(1); }
  };
  return state;
}

module.exports = { boot, fire, el, pick, settle, makeCheck, noop };
