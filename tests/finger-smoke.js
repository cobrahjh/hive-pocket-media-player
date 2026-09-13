/*
 * What a finger draws, and what it throws.
 *
 * WHY THIS SUITE EXISTS. Two things arrived in 1.64.0 and both of them fail invisibly.
 *
 * RIPPLES are a third kind of drawable on a canvas Pocket owns, alongside bolts and wisps, and
 * every one of those three has its own rule about what happens when the box changes or a setting
 * moves. The trap is the loop's own stop condition: it clears the canvas and returns when its
 * lists are empty, so a new list that is not in that check gets drawn once and then abandoned —
 * alive in memory, invisible on screen, with no error anywhere. That is exactly what went wrong
 * the first time a wisp was added, and it is asserted here rather than remembered.
 *
 * WHAT THE FINGER THROWS is a second effect name living beside the one the beat uses, and the
 * only way to get it wrong is for one of them to quietly win. A finger set to hearts while the
 * music throws fireworks has to produce hearts under the finger AND fireworks on the beat; an
 * app that reads the wrong one still draws something, still looks alive, and is simply wrong.
 *
 * NOT COVERED: pixels, as everywhere else in this folder. The stub's canvas swallows every
 * drawing call, so "a ring widens and fades" is asserted as "a ring exists, and stops existing
 * when it should". Whether ripples look good is a judgement and belongs on a phone.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { boot, fire, settle, makeCheck } = require('./dom-stub');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'pocket.js'), 'utf8');
const VER = /const VERSION = '([^']+)'/.exec(SRC)[1];

function seen() {
  const m = new Map();
  m.set('hive-pocket.tutorial', VER);
  m.set('hive-pocket.rolled', '1');
  return m;
}

/**
 * One finger down, moved, and up — a drag, which is what paints.
 *
 * COORDINATES MATTER HERE. paintAt() converts to 0-1 of the stage and returns early outside that
 * range, and the stub's default box is 300x150 — so a y of 300 is off the bottom of the stage and
 * every assertion below it quietly becomes "nothing happened". The first cut of this suite did
 * exactly that and reported eleven failures that were all one wrong number.
 */
function drag(app, x, y) {
  const st = app.els('stage');
  fire(st, 'pointerdown', { pointerId: 1, clientX: x, clientY: y });
  fire(st, 'pointermove', { pointerId: 1, clientX: x + 40, clientY: y + 40 });
  fire(st, 'pointerup', { pointerId: 1, clientX: x + 40, clientY: y + 40 });
}

function setSel(app, id, value) {
  const s = app.els(id);
  s.value = value;
  fire(s, 'change');
}

(async () => {
  const t = makeCheck();
  const check = t.check;

  // ── 1. ripples exist, and only when asked for ────────────────────────────────────────────
  const app = boot({ store: seen(), frames: true });
  await settle();
  check('nothing is rippling on a cold app', app.pocket.ripples === 0);

  drag(app, 100, 50);
  check('the default finger does not ripple', app.pocket.ripples === 0,
    'Lightning and a burst is the default and must stay exactly what it was');

  setSel(app, 'touchSel', 'ripple');
  drag(app, 100, 50);
  check('Ripples makes rings', app.pocket.ripples > 0, String(app.pocket.ripples));
  check('and three of them per touch', app.pocket.ripples === 3, String(app.pocket.ripples));

  // ── 2. the loop lets go of them ──────────────────────────────────────────────────────────
  // The case the wisps taught. A drawable the loop's stop condition does not know about is drawn
  // once and then left there, and nothing on screen says so.
  app.frames(70, 16);           // ~1.1s, past the longest ring's 880ms
  check('a ring is not immortal', app.pocket.ripples === 0,
    'rings outlived their duration, so the loop is not stepping them: ' + app.pocket.ripples);

  // ── 3. a box change drops them rather than stretching them ───────────────────────────────
  setSel(app, 'touchSel', 'ripple');
  drag(app, 100, 50);
  check('rings are out again', app.pocket.ripples === 3);
  for (const id of ['boltCanvas', 'stage', 'stageWrap', 'fxCanvas', 'eqCanvas']) {
    app.els(id).rect = { width: 900, height: 400, left: 0, top: 0 };
  }
  for (const fn of (app.sandbox.winHandlers.resize || []).slice()) fn({ type: 'resize' });
  app.frames(2, 16);
  check('a box change drops the rings', app.pocket.ripples === 0,
    'a ring is a position and a RADIUS, and a box whose axes moved differently has no single '
    + 'radius to scale it to - the honest shapes are an ellipse it never was, or nothing');

  // ── 4. changing what a finger does stops what the finger had in the air ──────────────────
  const off = boot({ store: seen(), frames: true });
  await settle();
  setSel(off, 'touchSel', 'ripple');
  drag(off, 100, 50);
  check('rings are out', off.pocket.ripples === 3);
  setSel(off, 'touchSel', 'off');
  check('and Nothing takes them away', off.pocket.ripples === 0);
  drag(off, 110, 60);
  check('and no more arrive', off.pocket.ripples === 0);

  // ── 5. rings and a burst are not the same option ─────────────────────────────────────────
  const both = boot({ store: seen(), frames: true });
  await settle();
  setSel(both, 'touchSel', 'ripplefx');
  drag(both, 100, 50);
  check('Ripples and a burst makes rings', both.pocket.ripples === 3, String(both.pocket.ripples));
  check('and fires a burst too', both.fxFires.length > 0,
    'the burst half of "Ripples and a burst" never reached the renderer');

  // ── 6. the finger throws what it was told to, not what the music is throwing ─────────────
  // The whole point of the setting, and the one way it fails without looking broken.
  const solo = boot({ store: seen(), frames: true });
  await settle();
  setSel(solo, 'beatSel', 'fireworks');
  setSel(solo, 'touchSel', 'effect');
  setSel(solo, 'throwSel', 'hearts');
  check('the setting is remembered', solo.pocket.fingerThrow === 'hearts', solo.pocket.fingerThrow);
  check('and the music still throws its own', solo.pocket.beatEffect === 'fireworks',
    solo.pocket.beatEffect);
  const before = solo.fxFires.length;
  drag(solo, 100, 50);
  const mine = solo.fxFires.slice(before);
  check('the finger threw something', mine.length > 0);
  check('and it threw HEARTS', mine.every((f) => f.effect === 'hearts'),
    JSON.stringify(mine.map((f) => f.effect)));

  // ── 7. "the same as the beat" is what it always was ──────────────────────────────────────
  const tied = boot({ store: seen(), frames: true });
  await settle();
  setSel(tied, 'beatSel', 'confetti');
  setSel(tied, 'touchSel', 'effect');
  check('beat is the default', tied.pocket.fingerThrow === 'beat');
  const was = tied.fxFires.length;
  drag(tied, 100, 50);
  const tiedFires = tied.fxFires.slice(was);
  check('a finger following the beat throws the beat effect',
    tiedFires.length > 0 && tiedFires.every((f) => f.effect === 'confetti'),
    JSON.stringify(tiedFires.map((f) => f.effect)));

  // ── 8. the two Pocket-owned throws go through their own paths ────────────────────────────
  // Neither is one of the renderer's six, and handing fire() a name it does not know makes it
  // fall back SILENTLY - which is why both are intercepted before they reach it.
  const bolt = boot({ store: seen(), frames: true });
  await settle();
  setSel(bolt, 'touchSel', 'effect');
  setSel(bolt, 'throwSel', 'lightning');
  const boltWas = bolt.fxFires.length;
  drag(bolt, 100, 50);
  check('a finger throwing lightning strikes', bolt.pocket.bolts > 0, String(bolt.pocket.bolts));
  check('and never hands the renderer a name it does not know',
    bolt.fxFires.slice(boltWas).every((f) => f.effect !== 'lightning'),
    JSON.stringify(bolt.fxFires.slice(boltWas).map((f) => f.effect)));

  const fae = boot({ store: seen(), frames: true });
  await settle();
  setSel(fae, 'touchSel', 'effect');
  setSel(fae, 'throwSel', 'fairy');
  const faeWas = fae.fxFires.length;
  drag(fae, 100, 50);
  check('a finger throwing fairy spawns one', fae.pocket.fairies > 0, String(fae.pocket.fairies));
  check('and that one is not roaming — a finger-thrown wisp is a burst, not a summons',
    fae.pocket.fairyRoamCount === 0, String(fae.pocket.fairyRoamCount));
  check('and the renderer never hears "fairy"',
    fae.fxFires.slice(faeWas).every((f) => f.effect !== 'fairy'),
    JSON.stringify(fae.fxFires.slice(faeWas).map((f) => f.effect)));

  // ── 9. this suite must be able to fail ───────────────────────────────────────────────────
  // Cut the override out of fireOne and require case 6 to collapse. Without this the whole file
  // could be asserting things that are true of a build that ignores the setting entirely.
  const LINE = "    let effect = want || readBeatEffect();";
  check('the mutation target is still there', SRC.indexOf(LINE) >= 0,
    'fireOne has been reworded - update this string, do not delete the case, or case 6 silently '
    + 'stops proving anything');
  if (SRC.indexOf(LINE) >= 0) {
    const broken = boot({
      src: SRC.replace(LINE, "    let effect = readBeatEffect();"),
      store: seen(), frames: true,
    });
    await settle();
    setSel(broken, 'beatSel', 'fireworks');
    setSel(broken, 'touchSel', 'effect');
    setSel(broken, 'throwSel', 'hearts');
    const bWas = broken.fxFires.length;
    drag(broken, 100, 50);
    const bMine = broken.fxFires.slice(bWas);
    check('without the override the finger throws the beat effect instead',
      bMine.length > 0 && bMine.every((f) => f.effect === 'fireworks'),
      'the mutation changed nothing, so case 6 was never proving the override: '
      + JSON.stringify(bMine.map((f) => f.effect)));
  }

  t.report();
})();
