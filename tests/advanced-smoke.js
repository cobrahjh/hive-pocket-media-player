/**
 * Advanced settings: the renderers' own knobs, reachable at last.
 *
 * WHY THIS SUITE EXISTS. setConfig REPLACES the renderer's config rather than merging into it,
 * which is the single fact this feature can get wrong in a way nothing on screen would show. A
 * call carrying only the keys the app has always sent silently resets every advanced value to
 * the renderer's default; a call carrying only the advanced values silently resets the style and
 * the palette. Both failures look like "the setting did not take" and neither raises anything.
 *
 * So the assertions below are mostly about WHAT ARRIVES AT THE RENDERER, captured from the fake,
 * rather than about what is in storage. Storage being right while the renderer never hears about
 * it is exactly the class of bug the play/pause glyph was.
 *
 * The other thing under test is that the control tables are built from the renderers' exported
 * DEFAULTS rather than from numbers retyped here. A default that moves in a renderer has to move
 * in this app with no edit, or the app is quietly overriding a value it was never asked to.
 *
 * NOT COVERED: whether any of these knobs actually changes a pixel. The renderers are stubbed
 * here and what they draw is not this suite's job.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { boot, fire, pick, settle, makeCheck } = require('./dom-stub');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'pocket.js'), 'utf8');

/**
 * The renderers do not exist until something starts them — the app builds them on the first
 * play, the first listen or the first finger, deliberately, so a cold page costs nothing. Every
 * case below is about what reaches a renderer, so every case needs one.
 */
async function started(app) {
  pick(app, 'song.mp3');
  await settle();
  fire(app.els('playBtn'), 'click');
  for (let i = 0; i < 4; i++) await settle();
  return app;
}

(async () => {
  const t = makeCheck();
  const check = t.check;

  const app = boot({});
  await settle();
  await started(app);
  const P = app.pocket;
  check('the renderers are running', app.eqConfigs.length > 0 && app.fxConfigs.length > 0,
    'nothing below can be asserted without them');

  // ── 1. nothing is overridden until something is moved ────────────────────────────────────
  check('starts with no overrides', JSON.stringify(P.advanced) === '{}', JSON.stringify(P.advanced));
  check('and reads the renderer default through', P.advValue('eq', 'bands') === app.sandbox.EqRender.DEFAULTS.bands,
    String(P.advValue('eq', 'bands')));
  check('including a nested one', P.advValue('fx', 'beat.minGapMs') === app.sandbox.FxRender.DEFAULTS.beat.minGapMs,
    String(P.advValue('fx', 'beat.minGapMs')));

  // ── 2. a moved knob reaches the renderer ─────────────────────────────────────────────────
  app.eqConfigs.length = 0;
  P.setAdv('eq', 'bands', 48);
  const eqCfg = app.eqConfigs[app.eqConfigs.length - 1];
  check('the equalizer was reconfigured', !!eqCfg);
  check('with the moved value', eqCfg && eqCfg.bands === 48, JSON.stringify(eqCfg));

  // ── 3. and the keys the app has always sent survive it ───────────────────────────────────
  // This is the whole point. setConfig replaces, so an advanced value that arrives WITHOUT the
  // style and palette beside it has just reset both to the renderer's defaults.
  check('style still went with it', eqCfg && typeof eqCfg.style === 'string' && eqCfg.style.length > 0,
    JSON.stringify(eqCfg && eqCfg.style));
  check('palette still went with it', eqCfg && typeof eqCfg.palette === 'string' && eqCfg.palette.length > 0,
    JSON.stringify(eqCfg && eqCfg.palette));

  // ── 4. the same, on the effects side, through a nested path ──────────────────────────────
  app.fxConfigs.length = 0;
  P.setAdv('fx', 'beat.minGapMs', 400);
  const fxCfg = app.fxConfigs[app.fxConfigs.length - 1];
  check('the effects were reconfigured', !!fxCfg);
  check('the nested value arrived', fxCfg && fxCfg.beat && fxCfg.beat.minGapMs === 400,
    JSON.stringify(fxCfg && fxCfg.beat));
  check('and its siblings in beat survived', fxCfg && fxCfg.beat
    && typeof fxCfg.beat.sensitivity === 'number' && typeof fxCfg.beat.effect === 'string',
    'plant() replaced the beat object instead of writing one key into it');
  check('and the caps the quality tier owns survived', fxCfg && typeof fxCfg.particleCap === 'number',
    JSON.stringify(fxCfg && fxCfg.particleCap));

  // ── 5. it outlives a reload ──────────────────────────────────────────────────────────────
  const again = boot({ store: app.store });
  await settle();
  await started(again);
  check('overrides come back', again.pocket.advValue('eq', 'bands') === 48,
    String(again.pocket.advValue('eq', 'bands')));
  check('and are handed to the renderer on load', again.eqConfigs.some((c) => c && c.bands === 48),
    JSON.stringify(again.eqConfigs.slice(0, 2)));

  // ── 6. reset puts the renderer's own default back, not a number from this app ────────────
  app.eqConfigs.length = 0;
  P.resetAdv('eq');
  check('the override is gone', P.advanced.eq === undefined, JSON.stringify(P.advanced));
  check('the effects side is untouched by an equalizer reset',
    P.advValue('fx', 'beat.minGapMs') === 400, String(P.advValue('fx', 'beat.minGapMs')));
  const after = app.eqConfigs[app.eqConfigs.length - 1];
  check('and the renderer was told', !!after);
  check('with its own default rather than one of ours',
    after && after.bands === undefined || (after && after.bands === app.sandbox.EqRender.DEFAULTS.bands),
    'a reset that sends an explicit number is this app overriding a default it was never asked to');

  // ── 7. the rows are built, and from the renderer's tables ────────────────────────────────
  fire(app.els('menuBtn'), 'click');
  await settle();
  const eqRows = app.els('advEq').children.length;
  const fxRows = app.els('advFx').children.length;
  check('equalizer rows were built', eqRows > 10, String(eqRows));
  check('effects rows were built', fxRows > 3, String(fxRows));
  check('and a reset button exists for each',
    !!app.els('advEqReset') && !!app.els('advFxReset'));

  // ── 8. this suite must be able to fail ───────────────────────────────────────────────────
  // Cut withAdv() out of the equalizer call. The override still saves, the UI still marks it as
  // moved, and the renderer never hears about it — which is the failure that would ship.
  const brokenSrc = SRC.replace(
    "eq.setConfig(withAdv('eq', { style: eqShapeNow, palette: eqPaletteNow }));",
    "eq.setConfig({ style: eqShapeNow, palette: eqPaletteNow });");
  check('the mutation applied', brokenSrc !== SRC,
    'the line this suite mutates has been reworded in pocket.js - update the string, do not '
    + 'delete the case, or cases 2 and 3 stop proving anything');
  const broken = boot({ src: brokenSrc });
  await settle();
  await started(broken);
  broken.eqConfigs.length = 0;
  broken.pocket.setAdv('eq', 'bands', 48);
  const brokenCfg = broken.eqConfigs[broken.eqConfigs.length - 1];
  check('without the fix the value is saved', broken.pocket.advValue('eq', 'bands') === 48);
  check('and the renderer never hears it', !brokenCfg || brokenCfg.bands === undefined,
    JSON.stringify(brokenCfg));

  t.report();
})();
