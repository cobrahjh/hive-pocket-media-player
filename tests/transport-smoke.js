/**
 * The play button's glyph: does the thing on screen change when the app starts producing sound.
 *
 * WHY THIS SUITE EXISTS. Harold reported "the play button doesn't show pause when playing" three
 * times - 1.34.0, 1.36.0 and again at 1.50.0. The first two reports produced real fixes (the
 * label had been replaced with a sentence; a live microphone was not counted as running) and
 * neither changed anything he could see, because the code both fixes drove was
 *
 *     $('playIcon').hidden = running;
 *
 * and the glyphs are <svg>. `hidden` is an IDL attribute on HTMLElement; SVGElement does not
 * have it, so that line sets a JavaScript property, writes no content attribute, and the
 * [hidden] rule in the stylesheet never matches. playIcon has no hidden attribute in the markup
 * and pauseIcon has one, so the pair sat at its markup defaults: triangle always, bars never.
 *
 * A CORRECT FIX IS WHAT MADE IT LOOK DEAD. An earlier release found both glyphs drawing at once
 * and added `[hidden] { display: none !important }` so the attribute would beat the `.ctl svg`
 * display rule. Right, and it turned "both showing" into "one showing forever" - a button that
 * reads as unresponsive rather than as broken.
 *
 * WHY NO SUITE COULD SEE IT: every element in the stub was a plain object with a `hidden` field,
 * so a property assignment and an attribute write were the same thing and the case that fails
 * did not exist. The stub now reads the real index.html to learn which ids are <svg> and gives
 * those a `hidden` that is a dead property, exactly as the DOM does. shown() asks the question
 * CSS asks - is the content attribute there - and every check below goes through it.
 *
 * NOT COVERED: pixels. Nothing here proves the glyph is painted, only that the attribute the
 * stylesheet keys on is right.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { boot, fire, pick, settle, makeCheck, shown } = require('./dom-stub');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'pocket.js'), 'utf8');

const glyph = (a) => (shown(a.els('playIcon')) ? 'play' : '') + (shown(a.els('pauseIcon')) ? 'pause' : '');

(async () => {
  const t = makeCheck();
  const check = t.check;

  // ── 0. the stub knows what the markup says ───────────────────────────────────────────────
  // If this fails the rest of the file proves nothing, because every element would be an HTML
  // one again and the bug would be unexpressible.
  const probe = boot({});
  check('the glyphs are modelled as svg', probe.els('playIcon').isSvg === true
    && probe.els('pauseIcon').isSvg === true);
  check('an ordinary element is not', probe.els('playBtn').isSvg === false);

  // ── 1. idle, then playing a file ─────────────────────────────────────────────────────────
  const app = boot({});
  await settle();
  check('idle shows the triangle alone', glyph(app) === 'play', glyph(app));

  pick(app, 'song.mp3');
  await settle();
  fire(app.els('playBtn'), 'click');
  for (let i = 0; i < 4; i++) await settle();
  check('the file is playing', app.media.paused === false);
  check('and the button shows the bars alone', glyph(app) === 'pause', glyph(app));
  check('with the label to match', app.els('playBtn').getAttribute('aria-label') === 'Pause',
    String(app.els('playBtn').getAttribute('aria-label')));

  fire(app.els('playBtn'), 'click');
  for (let i = 0; i < 3; i++) await settle();
  check('paused goes back to the triangle', glyph(app) === 'play', glyph(app));

  // ── 2. listening is playing, as far as this button is concerned ──────────────────────────
  // The 1.36.0 fix. It was correct then and invisible then; this is the check that would have
  // said so.
  const mic = boot({});
  await settle();
  fire(mic.els('micBtn'), 'click');
  for (let i = 0; i < 5; i++) await settle();
  check('the microphone is live', mic.pocket.micLive === true);
  check('and the button shows the bars', glyph(mic) === 'pause', glyph(mic));
  check('labelled for what it stops',
    mic.els('playBtn').getAttribute('aria-label') === 'Stop listening',
    String(mic.els('playBtn').getAttribute('aria-label')));
  fire(mic.els('micBtn'), 'click');
  for (let i = 0; i < 4; i++) await settle();
  check('stopping puts the triangle back', glyph(mic) === 'play', glyph(mic));

  // ── 3. never both at once ────────────────────────────────────────────────────────────────
  // The failure that preceded this one: both glyphs drawn, a triangle wearing a pause symbol.
  // Cheap to assert and it is the other half of the same attribute being right.
  check('idle is never both', glyph(app) !== 'playpause');
  check('and playing is never both', glyph(mic) !== 'playpause');

  // ── 4. this suite must be able to fail ───────────────────────────────────────────────────
  // Put the property assignment back. Against that build the triangle never leaves and the bars
  // never arrive, however correctly the rest of paintPlay() reasons about what is running.
  const brokenSrc = SRC
    .replace("setHidden($('playIcon'), running);", "$('playIcon').hidden = running;")
    .replace("setHidden($('pauseIcon'), !running);", "$('pauseIcon').hidden = !running;");
  check('the mutation applied', brokenSrc !== SRC,
    'the two lines this suite mutates have been reworded in pocket.js - update the strings, do '
    + 'not delete the case, or every check above stops proving anything');
  const broken = boot({ src: brokenSrc });
  await settle();
  pick(broken, 'song.mp3');
  await settle();
  fire(broken.els('playBtn'), 'click');
  for (let i = 0; i < 4; i++) await settle();
  check('without the fix the file still plays', broken.media.paused === false,
    'the mutation must break only the glyph, or this proves the wrong thing');
  check('and the button is stuck on the triangle', glyph(broken) === 'play', glyph(broken));

  t.report();
})();
