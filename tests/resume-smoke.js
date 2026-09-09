/**
 * Resume smoke — the one behaviour that regresses silently.
 *
 * A phone refuses the first play() a page makes. The app catches that, says "tap play", and the
 * person taps. THAT tap is what has to build the Web Audio graph, because the first attempt never
 * got far enough to build anything. Hanging the graph on the play() path alone left a blocked
 * first track playing for the rest of the session with a dead equalizer and a dead effects stage,
 * and nothing anywhere said so — the sound was fine.
 *
 * Nothing about that is visible in the picker, the markup or the renderer, so ambient-smoke.js
 * cannot see it: that suite stays green with this fix reverted. This one loads pocket.js into a
 * stub DOM, refuses the first play, taps, and asks whether the graph exists.
 *
 * It also mutates itself. The last case reloads the app with `.then(started)` cut out of toggle()
 * and requires the check above to FAIL. A suite that guards one line has to prove it would notice
 * that line going missing, or it is decoration.
 *
 *   node tests/resume-smoke.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'pocket.js'), 'utf8');

let pass = 0;
const fails = [];
function check(name, ok, detail) {
  if (ok === true) { pass++; console.log('  ok   ' + name); return; }
  fails.push(name + (detail ? ' - ' + detail : ''));
  console.log('  FAIL ' + name + (detail ? ' - ' + detail : ''));
}

const noop = () => {};

/** An element that answers everything the app asks of one, and remembers what it was told. */
function el(id) {
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
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    getBoundingClientRect: () => ({ width: 300, height: 150, left: 0, top: 0 }),
    getContext: () => new Proxy({}, { get: () => noop, set: () => true }),
  };
  return e;
}
function fire(target, type, ev) {
  const list = (target.handlers && target.handlers[type]) || [];
  for (const fn of list.slice()) fn(Object.assign({ type, target, preventDefault: noop, stopPropagation: noop }, ev || {}));
}

/**
 * Load the app into a stub DOM.
 * `src` lets a case load a deliberately broken build; `blockFirstPlay` makes the media element
 * refuse the first play() the way a phone does, and resolve every one after it.
 */
function boot(src, blockFirstPlay) {
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
    if (blockFirstPlay && playCalls === 1) return Promise.reject(new Error('NotAllowedError'));
    media.paused = false;
    return Promise.resolve();
  };
  media.pause = () => { media.paused = true; };
  media.load = () => { media.paused = true; media.currentTime = 0; };

  const store = new Map();
  const sandbox = {
    console: { log: noop, warn: noop, error: noop },
    setTimeout, clearTimeout, setInterval, clearInterval,
    Promise, Math, JSON, Date, String, Number, Array, Object, Boolean, Error,
    Uint8Array, Set, Map, isFinite, parseInt, parseFloat, URL: {
      createObjectURL: () => 'blob:stub/1',
      revokeObjectURL: noop,
    },
    performance: { now: () => Date.now() },
    // A plain http origin, so the worker registration is skipped — the worker is not what this
    // suite is about, and registering one would need a whole second set of stubs.
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
    matchMedia: () => ({ matches: false, addEventListener: noop }),
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
    // The renderers are exercised by ambient-smoke.js. Here they only need to exist, because the
    // question is whether the GRAPH was built, not what it drew.
    EqRender: { create: () => ({ push: noop, start: noop, stop: noop }) },
    FxRender: { create: () => ({ setConfig: noop, pushBands: noop, start: noop, stop: noop }) },
    document: {
      getElementById: get,
      createElement: (tag) => {
        const e = el('');
        e.tagName = String(tag).toUpperCase();
        return tag === 'audio' ? media : e;
      },
      addEventListener: noop,
      querySelectorAll: () => [],
      hidden: false,
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  new vm.Script(src, { filename: 'pocket.js' }).runInContext(sandbox);
  return { sandbox, els: get, media, pocket: sandbox.window.__pocket, playCalls: () => playCalls };
}

/** Queue one track the way the file picker does, then press the transport's play button. */
async function pickAndPlay(app) {
  const pick = app.els('filePick');
  pick.files = [{ name: 'tone.wav', type: 'audio/wav' }];
  fire(pick, 'change');
  await settle();
  fire(app.els('playBtn'), 'click');
  await settle();
}
const settle = () => new Promise((r) => setTimeout(r, 0));

(async function run() {
  console.log('\nresume after a blocked play\n');

  // ── 1. the phone refuses the first attempt ───────────────────────────────────────────────
  const blocked = boot(SRC, true);
  await pickAndPlay(blocked);
  const note = blocked.els('nowSub').textContent;
  check('a refused play says so', /Tap play to start/.test(note), note);
  check('a refused play builds no graph', blocked.pocket.graphReady === false);

  // ── 2. the tap that follows builds it ────────────────────────────────────────────────────
  fire(blocked.els('playBtn'), 'click');
  await settle();
  check('the tap starts the sound', blocked.media.paused === false);
  check('THE TAP BUILDS THE GRAPH', blocked.pocket.graphReady === true,
    'graphReady=' + blocked.pocket.graphReady + ' after ' + blocked.playCalls() + ' play calls');
  check('the tap clears the stale prompt',
    blocked.els('nowSub').textContent === 'From this device', blocked.els('nowSub').textContent);

  // ── 3. the ordinary path is unchanged ────────────────────────────────────────────────────
  const clean = boot(SRC, false);
  await pickAndPlay(clean);
  check('an allowed play builds the graph too', clean.pocket.graphReady === true);
  check('an allowed play is not called twice', clean.playCalls() === 1, String(clean.playCalls()));

  // ── 4. this suite must be able to fail ───────────────────────────────────────────────────
  // Cut the fix out and require case 2 to collapse. Without this, the whole file could be
  // asserting something that is true of the broken build as well, and nobody would know.
  const brokenSrc = SRC.replace('audio.play().then(started).catch(() => {});', 'audio.play().catch(() => {});');
  check('the mutation applied', brokenSrc !== SRC);
  const broken = boot(brokenSrc, true);
  await pickAndPlay(broken);
  fire(broken.els('playBtn'), 'click');
  await settle();
  check('without the fix the graph stays dead', broken.pocket.graphReady === false,
    'the mutated build still built a graph, so case 2 proves nothing');

  console.log('\n' + pass + ' passed, ' + fails.length + ' failed\n');
  if (fails.length) { fails.forEach((f) => console.log('  ' + f)); process.exit(1); }
})();
