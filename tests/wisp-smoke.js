/**
 * Wisps: the two-finger gesture, what keeps them alive, and what is allowed to take them away.
 *
 * WHY THIS SUITE EXISTS. Three releases in a row fixed a wisp bug, and not one of them would have
 * been caught by anything in this folder. 1.44.0 made a summoned wisp open-ended; 1.45.0 found
 * that any box change silently deleted every wisp; 1.46.0 found that the box change the phone
 * actually performs — the viewport growing a frame AFTER full screen is requested — was never
 * measured at all, because the bolt layer had no resize listener while both renderers did.
 *
 * Every one of those three shipped with all three suites green. The reason is that the stub had a
 * frozen 300x150 screen and an inert requestAnimationFrame, so nothing in this browser could
 * change size and nothing could move. Both are now drivable, and this file is the case for it:
 * a wisp is a position integrated frame by frame inside a box, and none of that can be asserted
 * from a still frame.
 *
 * PROVED AGAINST THE BUILDS IT WAS WRITTEN FOR, by running these cases against the actual
 * historical pocket.js from each tag rather than trusting that they would have caught anything:
 *
 *   1.43.0 (3e16368)  two fingers again -> still 2, not 0   (no toggle)
 *                     45 simulated seconds -> 0             (the 28-32s timer)
 *                     tap for full screen -> 0              (clearBolts took them)
 *   1.44.0 (7a2e880)  tap for full screen -> 0              (clearBolts took them)
 *   1.45.0 (fc84d8f)  full screen fine; the resize listener is what is missing, which case 10
 *                     proves by cutting it back out of the current source.
 *
 * THAT EXERCISE CHANGED THE SUITE. The first cut asserted that a bare window resize kept the
 * wisps and thought it had covered 1.45.0 — but 1.44.0 had no resize listener at all, so the
 * event reached nothing, the wisps survived by accident and the case passed against the broken
 * build. What Harold actually did was TAP FOR FULL SCREEN, which is a different code path
 * (setCover reflows by hand). A case that cannot be shown to fail against the build it was
 * written for is decoration.
 *
 * WHAT IS STILL NOT COVERED, so nobody reads a green run as more than it is: this asserts
 * POSITIONS AND COUNTS, never pixels. The stub's canvas context is a proxy that swallows every
 * call, so "the tail fades rather than ending on an edge" — the thing Harold actually asked for
 * — is not tested here and cannot be from this stub. That one is still eyes on a screenshot.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { boot, fire, settle, makeCheck } = require('./dom-stub');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'pocket.js'), 'utf8');

/** Both fingers down, both up: one complete two-finger gesture. */
function twoFinger(app) {
  const stage = app.els('stage');
  fire(stage, 'pointerdown', { pointerId: 1, clientX: 80, clientY: 50 });
  fire(stage, 'pointerdown', { pointerId: 2, clientX: 200, clientY: 100 });
  fire(stage, 'pointerup', { pointerId: 1, clientX: 80, clientY: 50 });
  fire(stage, 'pointerup', { pointerId: 2, clientX: 200, clientY: 100 });
}

/** Resize the stage the way a phone does, then tell the page, the way a phone does. */
function resizeTo(app, w, h) {
  for (const id of ['boltCanvas', 'stage', 'stageWrap', 'fxCanvas', 'eqCanvas']) {
    app.els(id).rect = { width: w, height: h, left: 0, top: 0 };
  }
  const list = app.sandbox.winHandlers.resize || [];
  for (const fn of list.slice()) fn({ type: 'resize' });
}

(async () => {
  const t = makeCheck();
  const check = t.check;

  // ── 1. the gesture is a toggle ───────────────────────────────────────────────────────────
  // Two fingers used to be a one-way door. Once a summoned wisp stopped expiring there had to be
  // an off, and the only honest off is the gesture that turned it on.
  const app = boot({ frames: true });
  await settle();
  check('no wisps before anything is touched', app.pocket.fairyRoamCount === 0);

  twoFinger(app);
  check('two fingers send two out', app.pocket.fairyRoamCount === 2,
    String(app.pocket.fairyRoamCount));

  twoFinger(app);
  check('two fingers again send them away', app.pocket.fairyRoamCount === 0,
    String(app.pocket.fairyRoamCount));

  twoFinger(app);
  check('and again brings them back', app.pocket.fairyRoamCount === 2,
    String(app.pocket.fairyRoamCount));

  // ── 2. one gesture is one launch ─────────────────────────────────────────────────────────
  // A second finger landing, moving and lifting inside one gesture must not fire again, or two
  // fingers becomes a second way of painting — which is what the first cut of this did.
  const once = boot({ frames: true });
  await settle();
  const stage = once.els('stage');
  fire(stage, 'pointerdown', { pointerId: 1, clientX: 80, clientY: 50 });
  fire(stage, 'pointerdown', { pointerId: 2, clientX: 200, clientY: 100 });
  fire(stage, 'pointermove', { pointerId: 2, clientX: 210, clientY: 110 });
  fire(stage, 'pointerdown', { pointerId: 3, clientX: 150, clientY: 70 });
  check('a held gesture launches once', once.pocket.fairyRoamCount === 2,
    String(once.pocket.fairyRoamCount));

  // ── 3. a summoned wisp does not expire ───────────────────────────────────────────────────
  // 45 simulated seconds at the app's own dt cap. The number matters: the previous answer was a
  // 28-32s timer, so anything under 32 seconds would pass against the build this replaced.
  const live = boot({ frames: true });
  await settle();
  twoFinger(live);
  live.frames(200, 50);            // 10s
  check('still there after 10s', live.pocket.fairyRoamCount === 2);
  live.frames(400, 50);            // 30s
  check('still there after 30s', live.pocket.fairyRoamCount === 2,
    'a 30s timer would have expired by now - that is the build this replaced');
  live.frames(300, 50);            // 45s
  check('still there after 45s', live.pocket.fairyRoamCount === 2);
  check('and it has been moving', live.pocket.fairyTrail.every((n) => n > 50),
    JSON.stringify(live.pocket.fairyTrail));

  // ── 4. a beat-thrown one still does expire ───────────────────────────────────────────────
  // The open-ended life belongs to the gesture, not to the effect. If this stops being true the
  // music fills the two slots permanently and the gesture can never be used again.
  const beat = boot({ frames: true });
  await settle();
  beat.pocket.spawnFairy(0.5, 0.5, 1, 'fire', false);
  check('the music can throw one', beat.pocket.fairies === 1);
  beat.frames(100, 50);            // 5s, against a 1.7-2.6s life
  check('and it is gone a few seconds later', beat.pocket.fairies === 0,
    String(beat.pocket.fairies));

  // ── 5. the wrap, and the break that has to come with it ──────────────────────────────────
  // A wisp leaving one edge arrives at the other. Without a pen-lift in the trail the next
  // segment joins the old edge to the new one and draws a line across the whole screen - the
  // classic wrap artifact, and at this tail length the most visible thing on the stage.
  const wrap = boot({ frames: true });
  await settle();
  twoFinger(wrap);
  wrap.frames(600, 50);            // 30s is several screen widths at a wisp's drift
  check('a wisp is always inside the box', wrap.pocket.fairyInBounds === true);
  const broke = wrap.pocket.fairyTrailRaw.some((tr) => tr.some((v) => !isFinite(v)));
  check('and its trail breaks where it wrapped', broke === true,
    'no pen-lift anywhere in 30s of drift - either the wrap stopped happening or the break did');

  // ── 6. a box change keeps the wisps and drops the bolts ──────────────────────────────────
  // This is the 1.45.0 bug. clearBolts() emptied both lists on any resize, which is right for a
  // bolt - a fixed path from a fixed point - and was never right for a wisp, which is a position
  // and a trail and both of those scale.
  const box = boot({ frames: true });
  await settle();
  twoFinger(box);
  box.frames(60, 50);
  box.pocket.strike(0.5, 0.5);
  check('a bolt is in the air', box.pocket.bolts > 0);
  // 1.5x on BOTH axes, which is the shape of the change this path is for: the stage growing as
  // the browser chrome goes away. A change that alters the aspect ratio is case 8's job.
  const before = box.pocket.fairyTrailRaw[0].filter((v) => isFinite(v)).slice(0, 2);
  resizeTo(box, 450, 225);
  box.frame(16);                   // the reflow is coalesced into one frame
  check('the wisps survive a resize', box.pocket.fairyRoamCount === 2,
    String(box.pocket.fairyRoamCount));
  check('the bolt does not', box.pocket.bolts === 0, String(box.pocket.bolts));
  const after = box.pocket.fairyTrailRaw[0].filter((v) => isFinite(v)).slice(0, 2);
  check('and the trail was scaled into the new box',
    after.length === 2 && Math.abs(after[0] - before[0] * 1.5) < 0.01
      && Math.abs(after[1] - before[1] * 1.5) < 0.01,
    JSON.stringify({ before, after }));
  check('with a pen-lift at the seam',
    !isFinite(box.pocket.fairyTrailRaw[0].slice(-2)[0]),
    'the old path and the new one are joined, which draws one wrong line across the stage');

  // ── 6b. and the tap that actually broke it ───────────────────────────────────────────────
  // THE CASE ABOVE DOES NOT CATCH THE 1.45.0 BUG, which is worth writing down because the first
  // cut of this suite thought it did. A bare window resize never reached that code at all in
  // 1.44.0 - there was no listener for it, which is the 1.46.0 bug - so the wisps survived by
  // accident and the case passed against the build it was written to catch.
  //
  // What Harold did was TAP FOR FULL SCREEN. That is setCover(), which reflows by hand, and in
  // 1.44.0 the hand-reflow was clearBolts() and it emptied both lists. So the tap is the case.
  const tap = boot({ frames: true });
  await settle();
  twoFinger(tap);
  tap.frames(40, 50);
  // The click straight after a two-finger gesture is SWALLOWED on purpose - `painting` stays set
  // until a click clears it, so the gesture cannot toggle full screen on its way out. Asserted
  // rather than worked around, because it is the guard that makes two fingers safe to use.
  fire(tap.els('stage'), 'click');
  check('the click ending the gesture does not toggle',
    tap.els('stageWrap').classList.contains('cover') === false);
  fire(tap.els('stage'), 'click');
  tap.frame(16);
  check('the next tap does go full screen',
    tap.els('stageWrap').classList.contains('cover') === true);
  check('and the wisps come through it', tap.pocket.fairyRoamCount === 2,
    String(tap.pocket.fairyRoamCount));
  fire(tap.els('stage'), 'click');
  tap.frame(16);
  check('coming back out keeps them too', tap.pocket.fairyRoamCount === 2,
    String(tap.pocket.fairyRoamCount));

  // ── 7. the bitmap follows the box ────────────────────────────────────────────────────────
  // This is the 1.46.0 bug, and it is the one that reached Harold's phone twice. Both renderers
  // register their own resize listener; the bolt layer did not, so the canvas kept the bitmap it
  // was given before the screen moved and the browser stretched it - 824x1830 pixels of wisp
  // squeezed into a 915x412 box, which is a smear in the wrong place rather than a light.
  //
  // The listener is what is under test here, NOT setCover(): nothing below taps anything. A
  // phone's viewport moves a frame or more AFTER the full-screen request, on its own.
  resizeTo(box, 412, 915);
  box.frame(16);
  const dprBox = box.pocket.boltBox;
  check('the canvas bitmap followed the box',
    dprBox.bw === Math.round(412 * dprBox.dpr) && dprBox.bh === Math.round(915 * dprBox.dpr),
    JSON.stringify(dprBox));
  check('and so did the box the wisps live in',
    dprBox.w === 412 && dprBox.h === 915, JSON.stringify(dprBox));
  check('the wisps came through that too', box.pocket.fairyRoamCount === 2,
    String(box.pocket.fairyRoamCount));

  // ── 8. a rotation is not a resize ────────────────────────────────────────────────────────
  // Scaling a trail is honest when both axes move by nearly the same amount and a lie when they
  // do not: a rotation multiplies x by 2.2 and y by 0.45, and three seconds of curve comes out
  // as a flat streak across the screen. Past the ratio the tail is dropped and redraws itself.
  const rot = boot({ frames: true });
  await settle();
  twoFinger(rot);
  rot.frames(80, 50);
  check('a tail to lose', rot.pocket.fairyTrail.every((n) => n > 40));
  resizeTo(rot, 150, 300);         // both axes swap: the same shape change a rotation makes
  rot.frame(16);
  check('a rotation keeps the wisp', rot.pocket.fairyRoamCount === 2,
    String(rot.pocket.fairyRoamCount));
  check('and drops the tail rather than stretching it',
    rot.pocket.fairyTrail.every((n) => n <= 2), JSON.stringify(rot.pocket.fairyTrail));
  rot.frames(80, 50);
  check('the tail comes back on its own', rot.pocket.fairyTrail.every((n) => n > 40),
    JSON.stringify(rot.pocket.fairyTrail));

  // ── 9. what may and may not take a wisp away ─────────────────────────────────────────────
  // The second bug 1.45.0 found: 'Your finger' is a setting about what a FINGER does, and it was
  // calling clearBolts(), which took out every wisp including ones the music had thrown.
  const set = boot({ frames: true });
  await settle();
  twoFinger(set);
  set.frames(20, 50);
  set.pocket.strike(0.5, 0.5);
  const finger = set.els('touchSel');
  finger.value = 'off';
  fire(finger, 'change');
  check('switching lightning off stops the bolts', set.pocket.bolts === 0);
  check('and leaves the wisps alone', set.pocket.fairyRoamCount === 2,
    String(set.pocket.fairyRoamCount));

  const vis = set.els('visualsSel');
  vis.value = 'eq';
  fire(vis, 'change');
  check('switching the effects off does take them', set.pocket.fairyRoamCount === 0,
    'the layer they are drawn on is gone, so they have to go with it');

  // ── 9b. effects off is not a reason to do nothing ────────────────────────────────────────
  // Harold's phone at 1.48.0: "On the stage: equalizer only", three gestures, every one refused,
  // nothing on screen to say why. A finger on the stage is a request for the effects and the
  // app now grants it - visibly, through the same setting the star button toggles.
  const off = boot({ frames: true });
  await settle();
  const sel = off.els('visualsSel');
  sel.value = 'eq';
  fire(sel, 'change');
  check('effects can be switched off', off.els('fxBtn').getAttribute('aria-pressed') === 'false');
  twoFinger(off);
  check('two fingers turn them back on', off.els('fxBtn').getAttribute('aria-pressed') === 'true');
  check('and the wisps go out', off.pocket.fairyRoamCount === 2, String(off.pocket.fairyRoamCount));
  check('and the log says a finger did it', off.pocket.wispLog.turnedOn === 1,
    JSON.stringify(off.pocket.wispLog));

  // A clean tap must NOT do this. It is full screen and nothing else, and an accidental brush
  // that turns a setting on is the cost this design accepted only for gestures that mean draw.
  const tapOnly = boot({ frames: true });
  await settle();
  const sel2 = tapOnly.els('visualsSel');
  sel2.value = 'eq';
  fire(sel2, 'change');
  fire(tapOnly.els('stage'), 'click');
  check('a plain tap leaves them off', tapOnly.els('fxBtn').getAttribute('aria-pressed') === 'false');
  check('and goes full screen instead', tapOnly.els('stageWrap').classList.contains('cover') === true);

  // ── 10. this suite must be able to fail ──────────────────────────────────────────────────
  // Cut the resize listener back out and require case 7 to collapse. Case 7 is the only one here
  // that would have caught the bug that reached the phone twice, so it is the one worth proving.
  const LISTENER = "for (const ev of ['resize', 'orientationchange']) window.addEventListener(ev, reflowSoon);";
  const brokenSrc = SRC.replace(LISTENER, '');
  check('the mutation applied', brokenSrc !== SRC,
    'the line this suite mutates has been reworded in pocket.js - update the string, do not '
    + 'delete the case, or case 7 stops proving anything');
  const broken = boot({ frames: true, src: brokenSrc });
  await settle();
  twoFinger(broken);
  broken.frames(20, 50);
  resizeTo(broken, 412, 915);
  broken.frame(16);
  const brokenBox = broken.pocket.boltBox;
  check('without the listener the bitmap is left behind',
    brokenBox.bw !== Math.round(412 * brokenBox.dpr),
    'the mutated build still re-measured, so case 7 proves nothing');

  t.report();
})();
