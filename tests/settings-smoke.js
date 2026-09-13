/*
 * Three things added in 1.60.0, and one bookkeeping rule that outlives all of them.
 *
 * WHY THIS SUITE EXISTS.
 *
 * RESET is the only button in the app that throws anything away, and the interesting failure is
 * not that it fails — it is that it takes too much. A reset that quietly forgets a person's
 * saved links or their music folder looks identical, on the screen, to a reset that worked. So
 * the cases below assert both halves: what must go, and what must stay. The bookkeeping case is
 * the one that matters in six months: it reads every storage key out of pocket.js and fails if
 * any of them is in neither list, which turns "did you decide what reset does to this?" from
 * something to remember into something that stops the build.
 *
 * EQUALIZER HEIGHT is a number in storage AND a box on screen, and only the second one is what
 * anyone sees. The renderer measures itself against its canvas box and re-measures on a window
 * resize, which a CSS change does not fire — so an app that saves the number, writes the custom
 * property and forgets the one re-measure by hand looks right on the next rotation and wrong
 * until then. That is the case that would otherwise ship.
 *
 * THE DICE is marked permanently, in CSS, since 1.65.0 (it pulsed until first pressed in 1.60.0
 * and Harold reversed that). What is asserted is that the mark lives in the stylesheet with no
 * JavaScript gate, that it is a compositor-only transform, and that it stops under reduced
 * motion - the one accessibility failure a header animation can have.
 *
 * NOT COVERED: pixels. The stub's canvas swallows every drawing call, so "the bars are half as
 * tall" is asserted as "the custom property says 50% and the renderer was told to re-measure",
 * never as a picture. Whether 50% is the right default is a judgement and not an assertion.
 * Whether the travelling highlight reads as inviting rather than busy is also a judgement.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { boot, fire, settle, makeCheck, shown } = require('./dom-stub');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'pocket.js'), 'utf8');
const VER = /const VERSION = '([^']+)'/.exec(SRC)[1];

/**
 * Wake the renderers. Nothing in this app builds them until there is something to draw, so a
 * height change on a cold app has no renderer to re-measure — correctly, and uselessly for the
 * one case that matters. Two fingers on the stage is the cheapest honest way in: it is a request
 * for the effects, and the effects are what build the pair.
 */
function startVisuals(app) {
  const stage = app.els('stage');
  fire(stage, 'pointerdown', { pointerId: 1, clientX: 80, clientY: 50 });
  fire(stage, 'pointerdown', { pointerId: 2, clientX: 200, clientY: 100 });
  fire(stage, 'pointerup', { pointerId: 1, clientX: 80, clientY: 50 });
  fire(stage, 'pointerup', { pointerId: 2, clientX: 200, clientY: 100 });
}

/** A store for an app that is not brand new: the tutorial is done. */
function usedStore(extra) {
  const m = new Map();
  m.set('hive-pocket.tutorial', VER);
  if (extra) for (const [k, v] of Object.entries(extra)) m.set(k, v);
  return m;
}

(async () => {
  const t = makeCheck();
  const check = t.check;

  // ── 1. every key in the file has been decided about ──────────────────────────────────────
  // Read out of the source rather than out of the app, because the point is to catch a key that
  // was ADDED and never thought about — and a key nobody wired up is exactly the kind that the
  // running app would not mention.
  const app = boot({ store: usedStore() });
  await settle();
  const declared = [];
  const re = /const ([A-Z0-9_]+) = '(hive-pocket\.[a-z]+)'/g;
  let m;
  while ((m = re.exec(SRC))) declared.push({ name: m[1], key: m[2] });
  check('the file has storage keys to check', declared.length >= 15, String(declared.length));
  const decided = new Set([].concat(app.pocket.resetKeys, app.pocket.keepKeys));
  const orphans = declared.filter((d) => !decided.has(d.key)).map((d) => d.name);
  check('every key is either reset or kept', orphans.length === 0,
    'these are in neither RESET_KEYS nor KEEP_KEYS, so reset does something nobody chose: '
    + orphans.join(', '));
  check('and none is in both', app.pocket.resetKeys.filter((k) => app.pocket.keepKeys.includes(k)).length === 0);

  // ── 2. the equalizer has a height, and it is half ────────────────────────────────────────
  check('height defaults to half', app.pocket.eqHeight === 50, String(app.pocket.eqHeight));
  check('and the box is set at load', app.cssVars['--eq-h'] === '50%', String(app.cssVars['--eq-h']));

  // ── 3. moving it moves the BOX, not just the number ──────────────────────────────────────
  // The whole case. The renderer re-measures on a window resize and a custom property change
  // fires none, so an app that writes the number and the property and stops there draws at the
  // old size until the next rotation.
  startVisuals(app);
  check('the renderers are awake for this case', app.pocket.fairyRoamCount === 2,
    'without a live renderer the re-measure case below proves nothing');
  const before = app.resizes.eq;
  const slider = app.els('eqHeight');
  slider.value = '80';
  fire(slider, 'input');
  check('the number is saved', app.pocket.eqHeight === 80, String(app.pocket.eqHeight));
  check('the box follows it', app.cssVars['--eq-h'] === '80%', String(app.cssVars['--eq-h']));
  check('and the renderer is told to re-measure', app.resizes.eq > before,
    'without this the bars keep their old height until something else resizes the window');
  check('the readout agrees', app.els('eqHeightVal').textContent === '80%',
    app.els('eqHeightVal').textContent);
  check('and a moved height is marked', app.els('eqHeightRow').classList.contains('moved'));

  // ── 4. it survives a restart, and rubbish does not ───────────────────────────────────────
  const tall = boot({ store: usedStore({ 'hive-pocket.eqheight': '80' }) });
  await settle();
  check('a saved height comes back', tall.pocket.eqHeight === 80, String(tall.pocket.eqHeight));
  check('and is applied on load', tall.cssVars['--eq-h'] === '80%', String(tall.cssVars['--eq-h']));

  for (const bad of ['0', '500', '-20', 'tall', '']) {
    const junk = boot({ store: usedStore({ 'hive-pocket.eqheight': bad }) });
    await settle();
    check('"' + bad + '" falls back to half rather than to nothing', junk.pocket.eqHeight === 50,
      String(junk.pocket.eqHeight));
  }

  // ── 5. reset takes two presses ───────────────────────────────────────────────────────────
  const armed = boot({ store: usedStore({ 'hive-pocket.eqheight': '80', 'hive-pocket.ambient': 'fog' }) });
  await settle();
  fire(armed.els('resetAll'), 'click');
  check('one press changes nothing', armed.pocket.eqHeight === 80 && armed.pocket.ambient === 'fog',
    armed.pocket.eqHeight + ' / ' + armed.pocket.ambient);
  check('and says so on the button', /again/i.test(armed.els('resetAll').textContent),
    armed.els('resetAll').textContent);
  fire(armed.els('resetAll'), 'click');
  check('the second press does it', armed.pocket.eqHeight === 50 && armed.pocket.ambient !== 'fog',
    armed.pocket.eqHeight + ' / ' + armed.pocket.ambient);
  check('and the button goes back to what it was', !/again/i.test(armed.els('resetAll').textContent),
    armed.els('resetAll').textContent);

  // ── 6. reset puts the settings back ──────────────────────────────────────────────────────
  const dirty = boot({
    store: usedStore({
      'hive-pocket.eqheight': '95',
      'hive-pocket.ambient': 'fog',
      'hive-pocket.eqstyle': 'radial',
      'hive-pocket.palette': 'ice',
      'hive-pocket.player': 'mini',
      'hive-pocket.visuals': 'eq',
      'hive-pocket.advanced': JSON.stringify({ eq: { bands: 48 } }),
      'hive-pocket.links': JSON.stringify([{ name: 'a song', url: 'https://example.com/a.mp3' }]),
      'hive-pocket.report': 'half a sentence I was writing',
      'hive-pocket.tips': JSON.stringify({ off: true, shown: ['mic', 'paint'], last: 1 }),
    }),
  });
  await settle();
  check('it started dirty', dirty.pocket.eqHeight === 95 && dirty.pocket.ambient === 'fog');
  check('and with the reminders switched off', dirty.pocket.tips.off === true,
    String(dirty.store.get('hive-pocket.tips')));
  dirty.pocket.resetAll();

  check('height is back', dirty.pocket.eqHeight === 50, String(dirty.pocket.eqHeight));
  check('and the box with it', dirty.cssVars['--eq-h'] === '50%', String(dirty.cssVars['--eq-h']));
  check('background is back', dirty.pocket.ambient !== 'fog', dirty.pocket.ambient);
  check('equalizer style is back', dirty.pocket.eqStyle !== 'radial', dirty.pocket.eqStyle);
  check('colours are back', dirty.pocket.palette !== 'ice', dirty.pocket.palette);
  check('the player is whole again', dirty.pocket.playerSize === 'full', dirty.pocket.playerSize);
  check('the advanced knobs are back', !/bands/.test(dirty.store.get('hive-pocket.advanced') || ''),
    String(dirty.store.get('hive-pocket.advanced')));
  check('and the look reads as the shipped one rather than Custom', dirty.pocket.look === 'hive',
    dirty.pocket.look);

  // ── 7. …and leaves the person's own things alone ─────────────────────────────────────────
  // The half that is invisible when it breaks. A reset that also took the saved links looks
  // exactly like a reset that worked, until someone goes looking for a link.
  check('saved links are NOT a setting', dirty.pocket.links.length === 1,
    JSON.stringify(dirty.pocket.links));
  check('the half-written report is still there',
    /half a sentence/.test(dirty.store.get('hive-pocket.report') || ''),
    String(dirty.store.get('hive-pocket.report')));
  check('the tutorial does not start over', dirty.pocket.tutorialSeen === true);
  check('reminders come back ON, because the switch is a setting', dirty.pocket.tips.off === false,
    String(dirty.store.get('hive-pocket.tips')));
  check('but the ones already seen are still seen',
    (dirty.pocket.tips.shown || []).indexOf('mic') >= 0,
    'replaying eleven reminders at someone who has read them is the nagware the feature avoids: '
    + JSON.stringify(dirty.pocket.tips.shown));

  // ── 8. the dice is always marked, and it is marked in CSS ────────────────────────────────
  // 1.60.0 pulsed it until it had been pressed once; 1.65.0 reversed that on Harold's call -
  // always on, a highlight travelling round the outline. A permanent mark needs no state, so
  // the honest assertion is on the stylesheet: the animation is on #rollBtn unconditionally,
  // there is no class gate left in the app for it, and the once-only key is gone from the code.
  const CSS = fs.readFileSync(path.join(__dirname, '..', 'pocket.css'), 'utf8');
  check('the orbit is on the dice itself, not on a class',
    /#rollBtn::before\s*\{[^}]*animation:\s*dice-orbit/.test(CSS),
    'the travelling highlight must not depend on JavaScript adding a class');
  check('the orbit is a transform, which the compositor runs alone',
    /@keyframes dice-orbit\s*\{[^}]*transform:\s*rotate/.test(CSS));
  check('and it stops under reduced motion',
    /prefers-reduced-motion[^}]*\{[^]*?#rollBtn::before[^}]*animation:\s*none/.test(CSS),
    'a travelling light that ignores reduced-motion is the one accessibility failure a header can have');
  // The QUOTED literal - a string the code could read or write - not the bare name, which the
  // comment explaining its removal is allowed to say.
  check('the once-only key is gone from the app', SRC.indexOf("'hive-pocket.rolled'") < 0,
    'nothing should read or write it any more; old installs keep the value and nothing cares');
  check('and no code path toggles a hint class', SRC.indexOf("'hint'") < 0);

  // The app still has to KNOW nothing about it: pressing the dice, running the tour and reloading
  // change nothing, because there is nothing to change.
  const fresh = boot({ store: (() => { const s2 = new Map(); s2.set('hive-pocket.tutorial', VER); return s2; })() });
  await settle();
  fire(fresh.els('rollBtn'), 'click');
  check('pressing the dice writes no new key',
    [...fresh.store.keys()].every((k) => k !== 'hive-pocket.rolled'),
    JSON.stringify([...fresh.store.keys()]));

  // ── 10. the tour runs again when the TOUR changes, not when the app does ─────────────────
  // It used to key off VERSION, so a seven-step tutorial interrupted everyone on every release
  // — at a release every few days, that is a tour every few days at people who have taken it.
  // The revision is bumped by hand, which is the right call and the kind that goes stale, so
  // the steps are pinned to a digest here: change a step without bumping TUT_REV and this
  // fails, change nothing and it stays quiet.
  const TUT_TEXT = /const TUT = \[[\s\S]*?\n  \];/.exec(SRC)[0].replace(/\s+/g, ' ');
  const TUT_SHA = require('crypto').createHash('sha1').update(TUT_TEXT).digest('hex').slice(0, 12);
  const PINNED = { rev: 1, sha: '34aa8ea490a7' };
  const revNow = Number(/const TUT_REV = (\d+);/.exec(SRC)[1]);
  check('the tour is pinned to a revision',
    TUT_SHA === PINNED.sha || revNow > PINNED.rev,
    'the tutorial steps changed (' + TUT_SHA + ') but TUT_REV is still ' + revNow + '. Either '
    + 'the rewrite deserves to interrupt everyone again - bump TUT_REV and update PINNED here - '
    + 'or it does not, and only PINNED.sha moves.');
  check('and the revision is not a version string', /^\d+$/.test(String(revNow)), String(revNow));

  const cold = boot({ store: new Map() });
  await settle();
  check('a brand new app has not seen the tour', cold.pocket.tutorialSeen === false);

  const sameRev = boot({ store: (() => { const s = new Map(); s.set('hive-pocket.tutorial', String(revNow)); return s; })() });
  await settle();
  check('the same revision counts as seen', sameRev.pocket.tutorialSeen === true);

  const oldRev = boot({ store: (() => { const s = new Map(); s.set('hive-pocket.tutorial', String(revNow - 1)); return s; })() });
  await settle();
  check('an older revision runs it again', oldRev.pocket.tutorialSeen === false,
    'a rewritten tour must be able to reach someone who saw the old one');

  // The migration, and the whole point of the release. Every key written before 1.61.0 holds a
  // version string; not one of those people should be walked through the tour again.
  for (const old of ['1.60.0-beta', '1.24.0-beta', '1.58.0-beta']) {
    const carried = boot({ store: (() => { const s = new Map(); s.set('hive-pocket.tutorial', old); return s; })() });
    await settle();
    check('"' + old + '" counts as already seen', carried.pocket.tutorialSeen === true,
      'a version string in this key means a tour was taken; replaying it to celebrate a change '
      + 'in numbering is the bug this release removes');
  }

  // ── 11. the donate link is a link or it is nothing ───────────────────────────────────────
  // Ads were costed and refused because they would have cost the app its one claim — no network
  // at all after it loads — for about a coffee a month. What went in instead is a single link
  // out. The failure mode is a button that goes nowhere, which is worse than no button, and a
  // placeholder address is exactly the kind of thing that ships by accident.
  check('an unset donate link means no row at all', app.pocket.donateUrl === ''
    ? !shown(app.els('donateRow')) : true, 'DONATE_URL is set to ' + app.pocket.donateUrl);

  const DECL = "const DONATE_URL = '';";
  check('the donate constant is where this case thinks it is', SRC.indexOf(DECL) >= 0,
    'DONATE_URL has moved or been reworded - update this string rather than deleting the case');
  if (SRC.indexOf(DECL) >= 0) {
    const paid = boot({ src: SRC.replace(DECL, "const DONATE_URL = 'https://ko-fi.com/example';"), store: usedStore() });
    await settle();
    fire(paid.els('menuBtn'), 'click');
    await settle();
    check('a real https address shows the row', shown(paid.els('donateRow')));
    check('and puts the address on the link',
      paid.els('donateLink').getAttribute('href') === 'https://ko-fi.com/example',
      String(paid.els('donateLink').getAttribute('href')));
    check('the link opens away from the app', paid.els('donateLink').getAttribute('target') === '_blank');
    check('and cannot reach back into it',
      /noopener/.test(String(paid.els('donateLink').getAttribute('rel'))),
      String(paid.els('donateLink').getAttribute('rel')));

    // A payment link over http is not a small mistake, so it is refused rather than shown.
    const plain = boot({ src: SRC.replace(DECL, "const DONATE_URL = 'http://ko-fi.com/example';"), store: usedStore() });
    await settle();
    check('an http address is refused', !shown(plain.els('donateRow')),
      'a payment link served over http must not be offered at all');

    // AND NOT IN THE PLAY BUILD AT ALL. Google's Payments Policy section 3 allows a donation
    // link only for a validated tax-exempt organisation, and in August 2026 it made AnkiDroid
    // strip its Open Collective link after rejecting a 501(c)(6) determination letter. A live
    // link here is not a cosmetic bug, it is the listing.
    const LIVE = "const DONATE_URL = 'https://ko-fi.com/example';";
    const store = boot({
      src: SRC.replace(DECL, LIVE),
      store: usedStore(),
      referrer: 'android-app://online.kinghive.pocket',
    });
    await settle();
    fire(store.els('menuBtn'), 'click');
    await settle();
    check('the app knows it was launched from Play', store.pocket.fromPlay === true);
    check('and the donate link is not there', !shown(store.els('donateRow')),
      'a donate link inside the Play build is a payments-policy violation, not a design choice');
    check('while the web build still has it', paid.pocket.fromPlay === false
      && shown(paid.els('donateRow')));

    // An ordinary web referrer is not a Play launch, or every link from another site would
    // silently switch the feature off.
    const web = boot({
      src: SRC.replace(DECL, LIVE),
      store: usedStore(),
      referrer: 'https://github.com/cobrahjh/hive-pocket-media-player',
    });
    await settle();
    fire(web.els('menuBtn'), 'click');
    await settle();
    check('arriving from a website is not arriving from Play', web.pocket.fromPlay === false
      && shown(web.els('donateRow')));
  }

  // ── 12. this suite must be able to fail ──────────────────────────────────────────────────
  // Cut the re-measure out of applyEqHeight and require case 3 to collapse. Without this the
  // whole file could be asserting things that are true of a broken build as well.
  const LINE = "    if (eq && eqShown()) eq.resize();\n  }";
  check('the mutation target is still there', SRC.indexOf(LINE) >= 0,
    'applyEqHeight has been reworded - update this string, do not delete the case, or case 3 '
    + 'silently stops proving anything');
  if (SRC.indexOf(LINE) >= 0) {
    const broken = boot({ src: SRC.replace(LINE, "  }"), store: usedStore() });
    await settle();
    startVisuals(broken);
    const was = broken.resizes.eq;
    const s2 = broken.els('eqHeight');
    s2.value = '80';
    fire(s2, 'input');
    check('without the re-measure the number still moves', broken.pocket.eqHeight === 80);
    check('and THAT is what case 3 catches', broken.resizes.eq === was,
      'the mutation did not change anything, so case 3 was never proving the re-measure');
  }

  t.report();
})();
