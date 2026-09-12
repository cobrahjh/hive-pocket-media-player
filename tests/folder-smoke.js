/**
 * The remembered folder: what happens on the first touch after a cold start.
 *
 * WHY THIS SUITE EXISTS. Harold's 1.48.0 report said `folder permission after asking: denied`.
 * He had denied nothing. The app re-asked for the folder on the FIRST TOUCH anywhere, listening
 * on pointerdown because it arrives first - and on a touch screen a pointerdown carries no user
 * activation. The browser hands a finger its activation on pointerup and touchend; pointerdown
 * counts only for a mouse. So the very first touch on a phone called requestPermission() at a
 * moment Chrome was not allowed to show a sheet, and Chrome answers that by resolving 'denied'
 * and showing nothing. The app recorded a denial, told him the browser was blocking the folder,
 * and told him to choose it again. He had never been asked.
 *
 * Nothing in this folder could have caught it: the stub had no folder, no IndexedDB and no idea
 * what user activation was. The fake handle here is STRICTER than Chrome on purpose - it answers
 * 'denied' the same way, but it also records that the ask arrived without a gesture, so the
 * failure has a name instead of an impersonation.
 *
 * NOT COVERED: whether Chrome on Android actually grants activation on the events this now
 * listens on. That is the browser's behaviour, asserted from the HTML spec's list of
 * activation-triggering events (keydown, mousedown, pointerdown for mouse, pointerup for
 * non-mouse, touchend) and confirmable only from a phone report reading 'granted'.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { boot, fire, settle, makeCheck } = require('./dom-stub');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'pocket.js'), 'utf8');

/** The load sequence goes through IndexedDB twice and a permission query once; give it room. */
async function loaded(app) { for (let i = 0; i < 6; i++) await settle(); }

(async () => {
  const t = makeCheck();
  const check = t.check;

  // ── 1. a cold start with a remembered, locked folder ─────────────────────────────────────
  const app = boot({ folder: { state: 'prompt' } });
  await loaded(app);
  check('the handle came back from storage', app.pocket.folderRemembered === true);
  check('and the browser said prompt', app.pocket.folderDiag.onLoad === 'prompt',
    JSON.stringify(app.pocket.folderDiag));
  check('the names are back as a locked queue', app.pocket.queue.length === 3
    && app.pocket.queue.every((x) => x.pending === true), JSON.stringify(app.pocket.queue.map((x) => x.name)));
  check('nothing was asked yet', app.folder.asks === 0, String(app.folder.asks));

  // ── 2. a finger landing does NOT spend the ask ───────────────────────────────────────────
  // This is the bug. pointerdown from a touch has no activation; asking here is asking to be
  // told 'denied' by a browser that showed nothing.
  app.activation(false);
  app.doc_fire('pointerdown', { pointerType: 'touch', pointerId: 1 });
  await settle();
  check('a touch pointerdown does not ask', app.folder.asks === 0, String(app.folder.asks));
  check('and nothing was recorded as denied', app.pocket.folderDiag.afterAsk !== 'denied',
    JSON.stringify(app.pocket.folderDiag));

  // ── 3. the finger lifting is the gesture, and it asks exactly once ───────────────────────
  app.activation(true);
  app.doc_fire('pointerup', { pointerType: 'touch', pointerId: 1 });
  await loaded(app);
  check('a touch pointerup asks', app.folder.asks === 1, String(app.folder.asks));
  check('with a gesture', !app.folder.askedWithoutGesture, String(app.folder.askedWithoutGesture));
  check('and it was granted', app.pocket.folderDiag.afterAsk === 'granted',
    JSON.stringify(app.pocket.folderDiag));
  check('and the music is back', app.pocket.queue.length === 3
    && app.pocket.queue.every((x) => !!x.handle), JSON.stringify(app.pocket.queue.map((x) => !!x.handle)));
  app.doc_fire('pointerup', { pointerType: 'touch', pointerId: 2 });
  await settle();
  check('a second touch does not ask again', app.folder.asks === 1, String(app.folder.asks));

  // ── 4. a mouse has its gesture on the way down ───────────────────────────────────────────
  const mouse = boot({ folder: { state: 'prompt' } });
  await loaded(mouse);
  mouse.activation(true);
  mouse.doc_fire('pointerdown', { pointerType: 'mouse', pointerId: 1 });
  await loaded(mouse);
  check('a mouse pointerdown asks', mouse.folder.asks === 1, String(mouse.folder.asks));
  check('and is granted', mouse.pocket.folderDiag.afterAsk === 'granted');

  // ── 5. the browser's own word is the last word ───────────────────────────────────────────
  // pointerup normally carries activation, but the check asks the browser rather than assuming:
  // a pointerup that the browser says carries no activation is not spent, and the trap stays
  // armed for the next one that does.
  const shy = boot({ folder: { state: 'prompt' } });
  await loaded(shy);
  shy.activation(false);
  shy.doc_fire('pointerup', { pointerType: 'touch', pointerId: 1 });
  await settle();
  check('no activation, no ask', shy.folder.asks === 0, String(shy.folder.asks));
  check('and the report says so, not denied',
    /not asked/.test(String(shy.pocket.folderDiag.afterAsk)), JSON.stringify(shy.pocket.folderDiag));
  shy.activation(true);
  shy.doc_fire('pointerup', { pointerType: 'touch', pointerId: 2 });
  await loaded(shy);
  check('the next one with activation asks', shy.folder.asks === 1, String(shy.folder.asks));
  check('and is granted', shy.pocket.folderDiag.afterAsk === 'granted');

  // ── 6. a real denial is recorded as one, and is not nagged ───────────────────────────────
  const no = boot({ folder: { state: 'prompt', answer: 'denied' } });
  await loaded(no);
  no.activation(true);
  no.doc_fire('pointerup', { pointerType: 'touch', pointerId: 1 });
  await loaded(no);
  check('a person saying no is recorded as denied', no.pocket.folderDiag.afterAsk === 'denied',
    JSON.stringify(no.pocket.folderDiag));
  check('the queue stays locked rather than emptied', no.pocket.queue.length === 3
    && no.pocket.queue.every((x) => x.pending === true));
  const note = no.els('folderNote').textContent;
  check('and the note says how to ask again, not to start over', /ask again/.test(note)
    && !/start over/.test(note), note);
  no.doc_fire('pointerup', { pointerType: 'touch', pointerId: 2 });
  await settle();
  check('the next touch does not ask again', no.folder.asks === 1,
    'every touch raising a system sheet after a no is nagging; the tracks and the button are the way back');

  // ── 7. the deliberate path checks too ────────────────────────────────────────────────────
  // A synthetic click, or a promise chain that awaited something before asking, arrives with no
  // activation. That records what it is rather than a denial nobody made.
  const btn = boot({ folder: { state: 'prompt' } });
  await loaded(btn);
  btn.activation(false);
  fire(btn.els('reconnectBtn'), 'click');
  await settle();
  check('a click with no activation does not ask', btn.folder.asks === 0);
  check('and says what happened', /not asked/.test(String(btn.pocket.folderDiag.afterAsk)),
    JSON.stringify(btn.pocket.folderDiag));
  btn.activation(true);
  fire(btn.els('reconnectBtn'), 'click');
  await loaded(btn);
  check('a real click asks', btn.folder.asks === 1);
  check('and is granted', btn.pocket.folderDiag.afterAsk === 'granted');

  // ── 8. this suite must be able to fail ───────────────────────────────────────────────────
  // Put the bug back: listen on pointerdown for every pointer type, no activation check in the
  // trap AND none on the deliberate path - there are two guards now, and the second one alone
  // was enough to keep the first cut of this mutation from reproducing anything, which is a
  // good sign for the app and the reason all three lines go. Case 2 must collapse: the touch
  // pointerdown asks, and the fake records the ask had no gesture.
  const GUARD1 = "if (ev && ev.type === 'pointerdown' && ev.pointerType && ev.pointerType !== 'mouse') return;";
  const GUARD2 = "if (!hasGesture()) { folderStateAfterAsk = 'not asked (no gesture on ' + (ev ? ev.type : '?') + ')'; return; }";
  const GUARD3 = "    if (!hasGesture()) {\n      folderStateAfterAsk = 'not asked (no gesture)';";
  const brokenSrc = SRC.replace(GUARD1, '').replace(GUARD2, '')
    .replace(GUARD3, "    if (false) {\n      folderStateAfterAsk = 'not asked (no gesture)';");
  check('the mutation applied', [GUARD1, GUARD2, GUARD3].every((g) => SRC.includes(g)) && brokenSrc !== SRC,
    'the lines this suite mutates have been reworded in pocket.js - update the strings, do not '
    + 'delete the case, or case 2 stops proving anything');
  const broken = boot({ folder: { state: 'prompt' }, src: brokenSrc });
  await loaded(broken);
  broken.activation(false);
  broken.doc_fire('pointerdown', { pointerType: 'touch', pointerId: 1 });
  await loaded(broken);
  check('without the fix the first touch asks with no gesture', broken.folder.askedWithoutGesture === 1,
    JSON.stringify(broken.folder));
  check('and is told denied by a browser that showed nothing',
    broken.pocket.folderDiag.afterAsk === 'denied', JSON.stringify(broken.pocket.folderDiag));

  t.report();
})();
