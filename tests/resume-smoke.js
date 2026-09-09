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
 * cannot see it: that suite stays green with this fix reverted. This one refuses the first play,
 * taps, and asks whether the graph exists. The browser it runs in is tests/dom-stub.js, which
 * explains why it is not a real one.
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
const { boot, fire, pick, settle, makeCheck } = require('./dom-stub');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'pocket.js'), 'utf8');
const t = makeCheck();
const check = t.check;

/** Queue a track, then press the transport's play button. */
async function pickAndPlay(app) {
  pick(app);
  await settle();
  fire(app.els('playBtn'), 'click');
  await settle();
}

(async function run() {
  console.log('\nresume after a blocked play\n');

  // ── 1. the phone refuses the first attempt ───────────────────────────────────────────────
  const blocked = boot({ blockFirstPlay: true });
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
  const clean = boot({});
  await pickAndPlay(clean);
  check('an allowed play builds the graph too', clean.pocket.graphReady === true);
  check('an allowed play is not called twice', clean.playCalls() === 1, String(clean.playCalls()));

  // ── 4. this suite must be able to fail ───────────────────────────────────────────────────
  // Cut the fix out and require case 2 to collapse. Without this, the whole file could be
  // asserting something that is true of the broken build as well, and nobody would know.
  const brokenSrc = SRC.replace('audio.play().then(started).catch(() => {});',
                                'audio.play().catch(() => {});');
  check('the mutation applied', brokenSrc !== SRC);
  const broken = boot({ src: brokenSrc, blockFirstPlay: true });
  await pickAndPlay(broken);
  fire(broken.els('playBtn'), 'click');
  await settle();
  check('without the fix the graph stays dead', broken.pocket.graphReady === false,
    'the mutated build still built a graph, so case 2 proves nothing');

  t.report();
})();
