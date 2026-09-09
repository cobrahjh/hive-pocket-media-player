/**
 * Ambient picker smoke — what the Settings list offers, and what happens when storm or lightning
 * is the thing chosen.
 *
 * Storm and lightning FLASH. The renderer's own rule is that they stay out of the random roll
 * (`random: false`) but are allowed "when chosen by name", and it enforces three caps as hard
 * constants no config can reach. This suite holds the app to that rule from both sides: the
 * picker may offer them, the defaults may never land on them, and the caps must stay unreachable.
 *
 * It runs the REAL renderer under Node with a stub canvas and a stub frame clock, because a
 * hidden or headless browser tab freezes its timers and never draws — a green run there would
 * mean nothing.
 *
 *   node tests/ambient-smoke.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

let pass = 0;
const fails = [];
function check(name, ok, detail) {
  // ok is a BOOLEAN, deliberately. An earlier suite in this codebase took a function here, and
  // three of its cases passed with the code under test deleted.
  if (ok === true) { pass++; console.log('  ok   ' + name); return; }
  fails.push(name + (detail ? ' - ' + detail : ''));
  console.log('  FAIL ' + name + (detail ? ' - ' + detail : ''));
}

// ── a canvas that records nothing and refuses nothing ──────────────────────────────────────
const noop = () => {};
function stubCtx() {
  const grad = { addColorStop: noop };
  const target = {
    createRadialGradient: () => grad,
    createLinearGradient: () => grad,
    measureText: () => ({ width: 10, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 }),
  };
  return new Proxy(target, {
    get(t, k) { return (k in t) ? t[k] : noop; },   // every draw call is a no-op
    set() { return true; },                        // fillStyle, globalAlpha, font, ... accepted
  });
}
function stubCanvas(w, h) {
  const c = {
    width: w || 300, height: h || 150, style: {},
    getContext: () => stubCtx(),
    // resize() measures the element; a fixed box keeps the backing store deterministic.
    getBoundingClientRect: () => ({ width: w || 300, height: h || 150, left: 0, top: 0 }),
    addEventListener: noop,
  };
  return c;
}

// ── a window the renderer can live in ──────────────────────────────────────────────────────
let clock = 0;                                     // ms, advanced by hand
const pending = [];
global.window = {
  devicePixelRatio: 1,
  requestAnimationFrame(fn) { pending.push(fn); return pending.length; },
  cancelAnimationFrame() {},
  setTimeout() { return 0; },
  addEventListener: noop,
};
global.document = { createElement: (t) => (t === 'canvas' ? stubCanvas(64, 64) : { style: {} }) };
global.performance = { now: () => clock };

const FxRender = require(path.join(ROOT, 'fx-render.js'));

/** Run `ms` of wall time at `fps`, pushing a loud spectrum every frame. Returns peak counts. */
function runMode(mode, ms, fps, cfg, lib) {
  clock = 0;
  pending.length = 0;
  const fx = (lib || FxRender).create(stubCanvas(900, 500));
  fx.setConfig(Object.assign({ ambient: mode }, cfg || {}));
  fx.start();
  const step = 1000 / fps;
  const bands = Array.from({ length: 64 }, (_, i) => Math.max(0, Math.round(200 * Math.exp(-i / 12))));
  let peakBolts = 0, peakAmb = 0, frames = 0;
  for (let t = 0; t < ms; t += step) {
    clock += step;
    fx.pushBands(bands);
    const due = pending.splice(0, pending.length);
    for (const fn of due) fn(clock);
    frames++;
    const s = fx.stats();
    if (s.bolts > peakBolts) peakBolts = s.bolts;
    if (s.ambient > peakAmb) peakAmb = s.ambient;
  }
  const out = { resolved: fx.getAmbientMode(), peakBolts, peakAmb, frames, drawn: fx.framesDrawn() };
  fx.stop();
  return out;
}

console.log('\nambient picker\n');

// ── 1. the two lists cannot drift ──────────────────────────────────────────────────────────
const pocketSrc = read('pocket.js');
const listMatch = pocketSrc.match(/const AMBIENTS = \[([\s\S]*?)\];/);
const appList = listMatch ? listMatch[1].match(/'[^']+'/g).map((s) => s.slice(1, -1)) : [];
// Scoped to the ambient <select>, not every option on the page — the Settings sheet has more
// than one picker now, and a page-wide scan silently folded the other one's values in here.
const html = read('index.html');
const selBody = (html.match(/<select id="ambientSel">([\s\S]*?)<\/select>/) || [, ''])[1];
const htmlList = [...selBody.matchAll(/<option value="([^"]+)">/g)].map((m) => m[1]);

check('the app offers a list at all', appList.length > 1, appList.length + ' entries');
check('picker markup and picker code agree',
  JSON.stringify(appList) === JSON.stringify(htmlList),
  'js=' + appList.join(',') + ' html=' + htmlList.join(','));

const known = ['off'].concat(FxRender.AMBIENT_MODE_NAMES);
const unknown = appList.filter((a) => !known.includes(a));
check('every option is a mode the renderer knows', unknown.length === 0, unknown.join(','));

// ── 2. offered, but never a default ────────────────────────────────────────────────────────
check('storm is offered', appList.includes('storm'));
check('lightning is offered', appList.includes('lightning'));
check('the fallback is stars, not a flashing mode',
  pocketSrc.includes("return AMBIENTS.includes(v) ? v : 'stars'")
  && pocketSrc.includes("catch (e) { return 'stars'; }"));
check('random never rolls a flashing mode',
  !FxRender.ROLLABLE_AMBIENTS.includes('storm') && !FxRender.ROLLABLE_AMBIENTS.includes('lightning'),
  FxRender.ROLLABLE_AMBIENTS.join(','));

// ── 3. the safety caps are constants, not settings ─────────────────────────────────────────
const fxSrc = read('fx-render.js');
check('flash ceiling is a hard constant', /const FLASH_ALPHA_MAX = 0\.12;/.test(fxSrc));
check('minimum gap between strikes is a hard constant', /const BOLT_MIN_GAP_MS = 800;/.test(fxSrc));
check('bolt count is a hard constant', /const MAX_BOLTS = 6;/.test(fxSrc));
const reassigned = fxSrc
  .replace(/const (FLASH_ALPHA_MAX|BOLT_MIN_GAP_MS|MAX_BOLTS) = /g, '')
  .match(/(FLASH_ALPHA_MAX|BOLT_MIN_GAP_MS|MAX_BOLTS)\s*=[^=]/g);
check('nothing writes to them', reassigned === null, String(reassigned));

// ── 4. chosen by name, it actually strikes ─────────────────────────────────────────────────
const storm = runMode('storm', 30000, 30, { effects: { ambient: { strikes: 30 } } });
check('storm resolves to storm', storm.resolved === 'storm', storm.resolved);
check('storm draws weather', storm.peakAmb > 0, 'peak ' + storm.peakAmb + ' particles');
check('storm strikes', storm.peakBolts > 0, 'peak ' + storm.peakBolts + ' bolts');
check('storm respects the bolt cap', storm.peakBolts <= 6, 'peak ' + storm.peakBolts);

const lightning = runMode('lightning', 30000, 30, { effects: { ambient: { strikes: 30 } } });
check('lightning strikes', lightning.peakBolts > 0, 'peak ' + lightning.peakBolts + ' bolts');
check('lightning respects the bolt cap', lightning.peakBolts <= 6, 'peak ' + lightning.peakBolts);

// The control that makes the two above mean something: a non-flashing mode must produce NO bolts
// over the same window. Without it, "peakBolts > 0" could be true of every mode and prove nothing.
const stars = runMode('stars', 30000, 30, { effects: { ambient: { strikes: 30 } } });
check('a non-flashing mode never strikes', stars.peakBolts === 0, 'peak ' + stars.peakBolts);
check('the control mode did draw', stars.peakAmb > 0, 'peak ' + stars.peakAmb + ' particles');

// ── 5. this suite must be able to fail ─────────────────────────────────────────────────────
// Load a build where storm has no bolt scheduler and require the strike check to collapse.
// Without this, "storm strikes" could be true of a renderer that flashes in every mode, or of
// none, and the run would read the same either way.
const vm = require('vm');
const brokenSrc = fxSrc.replace(/(storm:.*?)bolts: true/, '$1bolts: false');
check('the mutation applied', brokenSrc !== fxSrc);
const box = {
  module: { exports: {} },
  // A COPY of the window: the module wrapper assigns root.FxRender, and handing it the real one
  // would leave the broken build sitting on the global for anything after this.
  window: Object.assign({}, global.window),
  document: global.document,
  performance: global.performance,
  console: { log: noop },
};
box.globalThis = box;
vm.createContext(box);
new vm.Script(brokenSrc, { filename: 'fx-render.broken.js' }).runInContext(box);
const brokenLib = box.module.exports;
const brokenStorm = runMode('storm', 30000, 30, { effects: { ambient: { strikes: 30 } } }, brokenLib);
check('without the scheduler storm never strikes', brokenStorm.peakBolts === 0,
  'the mutated renderer still struck, so "storm strikes" proves nothing');
check('the mutation was targeted, not total', brokenStorm.peakAmb > 0,
  'the mutant drew no weather either, so it broke more than the one thing');

console.log('\n' + pass + ' passed, ' + fails.length + ' failed\n');
if (fails.length) { fails.forEach((f) => console.log('  ' + f)); process.exit(1); }
