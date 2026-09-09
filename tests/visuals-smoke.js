/**
 * Visuals smoke — what is on the stage, and the tap that makes it fill the screen.
 *
 * Two things here are easy to get wrong in a way no screenshot shows:
 *
 *   1. TWO CONTROLS, ONE SETTING. The effects button on the transport and the picker in Settings
 *      both decide whether effects are drawn. If they keep separate state they drift, and the
 *      menu ends up describing a screen that looks different. There is one stored value and both
 *      write to it.
 *   2. FULL SCREEN CANNOT DEPEND ON THE NATIVE API. requestFullscreen can be missing, and it
 *      rejects — silently, with nothing useful in the error — when the browser does not believe
 *      a gesture happened. So the tap covers the screen with layout first and asks for native
 *      full screen second. A tap that does nothing visible is the failure being guarded here,
 *      and both cases below run against a browser that refuses.
 *
 * Runs under tests/dom-stub.js, which explains why it is not a real browser.
 *
 *   node tests/visuals-smoke.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { boot, fire, pick, settle, makeCheck } = require('./dom-stub');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'pocket.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const t = makeCheck();
const check = t.check;

const covered = (app) => app.els('stage').classList.contains('cover');
const shown = (app) => ({ eq: !app.els('eqCanvas').hidden, fx: !app.els('fxCanvas').hidden });

/** Get an app to the point where the renderers exist, so the canvases are being managed. */
async function playing(opts) {
  const app = boot(opts || {});
  pick(app);
  await settle();
  fire(app.els('playBtn'), 'click');
  await settle();
  return app;
}

(async function run() {
  console.log('\nvisuals and full screen\n');

  // ── 1. the picker in the markup matches the values the app accepts ───────────────────────
  const selBody = (HTML.match(/<select id="visualsSel">([\s\S]*?)<\/select>/) || [, ''])[1];
  const htmlList = [...selBody.matchAll(/<option value="([^"]+)">/g)].map((m) => m[1]);
  const codeList = (SRC.match(/const VISUALS = \[([^\]]*)\]/) || [, ''])[1]
    .match(/'[^']+'/g).map((s) => s.slice(1, -1));
  check('the picker has options at all', htmlList.length === 3, htmlList.join(','));
  check('markup and code agree on the values',
    JSON.stringify(htmlList) === JSON.stringify(codeList),
    'html=' + htmlList.join(',') + ' code=' + codeList.join(','));

  // ── 2. each choice puts the right thing on screen ────────────────────────────────────────
  const app = await playing();
  check('both is the default', app.pocket.visuals === 'both', app.pocket.visuals);
  check('both shows both canvases', shown(app).eq === true && shown(app).fx === true);

  const sel = app.els('visualsSel');
  sel.value = 'eq';
  fire(sel, 'change');
  check('equalizer only hides the effects', shown(app).eq === true && shown(app).fx === false);

  sel.value = 'fx';
  fire(sel, 'change');
  check('effects only hides the equalizer', shown(app).eq === false && shown(app).fx === true);

  // A canvas that was hidden was measured at zero. Coming back it has to be told to re-measure,
  // or it draws into a box the size of nothing and the stage looks broken with no error.
  const before = app.resizes.eq;
  sel.value = 'both';
  fire(sel, 'change');
  check('a canvas coming back is re-measured', app.resizes.eq > before,
    'eq.resize() calls: ' + before + ' -> ' + app.resizes.eq);

  // ── 3. the transport button and the menu are the same setting ────────────────────────────
  fire(app.els('fxBtn'), 'click');
  check('the effects button turns effects off', app.pocket.visuals === 'eq', app.pocket.visuals);
  check('the menu followed the button', app.els('visualsSel').value === 'eq',
    app.els('visualsSel').value);
  check('the button says it is off', app.els('fxBtn').getAttribute('aria-pressed') === 'false');

  fire(app.els('fxBtn'), 'click');
  check('the effects button turns them back on', app.pocket.visuals === 'both', app.pocket.visuals);

  // From "effects only", the effects button must not leave an empty stage.
  const solo = await playing();
  solo.els('visualsSel').value = 'fx';
  fire(solo.els('visualsSel'), 'change');
  fire(solo.els('fxBtn'), 'click');
  check('turning effects off never leaves nothing on screen',
    shown(solo).eq === true || shown(solo).fx === true, JSON.stringify(shown(solo)));

  // ── 4. the choice survives a restart ─────────────────────────────────────────────────────
  check('the choice was stored', app.store.get('hive-pocket.visuals') === 'both',
    String(app.store.get('hive-pocket.visuals')));

  // ── 5. the tap covers the screen even where native full screen is refused ────────────────
  const refused = await playing({ refuseFullscreen: true });
  check('nothing is covered to start with', refused.pocket.covered === false);
  fire(refused.els('stage'), 'click');
  await settle();
  check('a refused request still covers the screen', covered(refused) === true);
  check('and the app knows it is covered', refused.pocket.covered === true);
  check('it asked for native full screen anyway', refused.fullscreen.requests === 1,
    String(refused.fullscreen.requests));
  check('the way back is on screen', refused.els('coverTip').hidden === false);

  fire(refused.els('stage'), 'click');
  await settle();
  check('a second tap comes back', covered(refused) === false && refused.pocket.covered === false);
  check('the way back is put away again', refused.els('coverTip').hidden === true);

  // ── 6. and where the API is missing entirely ─────────────────────────────────────────────
  const bare = await playing({ noFullscreen: true });
  fire(bare.els('stage'), 'click');
  await settle();
  check('no API at all still covers the screen', covered(bare) === true);
  check('and asks for nothing', bare.fullscreen.requests === 0);

  // ── 7. leaving by the system's own gesture puts the page back ────────────────────────────
  const native = await playing();
  fire(native.els('stage'), 'click');
  await settle();
  check('native full screen was entered', native.fullscreen.element !== null);
  const resizedAt = native.resizes.fx;
  // Android's back gesture and Escape both leave without going through the app.
  native.fullscreen.element = null;
  fire(native.doc, 'fullscreenchange');
  await settle();
  check('backing out drops the cover too', covered(native) === false,
    'the stage would have stayed over the whole page with no browser chrome to explain it');
  check('and the renderers re-measure on the way out', native.resizes.fx > resizedAt,
    'fx.resize() calls: ' + resizedAt + ' -> ' + native.resizes.fx);

  // ── 8. this suite must be able to fail ───────────────────────────────────────────────────
  // Cut the class out of setCover and require case 5 to collapse. If the checks above passed
  // against a build that never covers anything, they were measuring the stub, not the app.
  const brokenSrc = SRC.replace("$('stage').classList.toggle('cover', covered);", '');
  check('the mutation applied', brokenSrc !== SRC);
  const broken = await playing({ src: brokenSrc, refuseFullscreen: true });
  fire(broken.els('stage'), 'click');
  await settle();
  check('without the class nothing is covered', covered(broken) === false,
    'the mutated build still covered the screen, so case 5 proves nothing');

  t.report();
})();
