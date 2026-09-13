/**
 * Feature reminders: the rules that stop a helpful thing becoming nagware.
 *
 * WHY THIS SUITE EXISTS. Every assertion here is a promise made to the person using the app, and
 * every one of them is invisible when broken — a tip that comes back a second time, or arrives
 * during the tutorial, or keeps appearing because the timestamp was never written, all look
 * exactly like "working" for the first five minutes and like nagware by the end of the week. The
 * failure mode is not an error, it is annoyance, and nothing else in this folder can see it.
 *
 * NOT COVERED: whether the tips are worth reading, and whether one a day is the right rate. Both
 * are judgements, not assertions, and the rate is one constant if it turns out to be wrong.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { boot, fire, settle, makeCheck, shown } = require('./dom-stub');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'pocket.js'), 'utf8');
const DAY = 24 * 60 * 60 * 1000;

/** The tutorial has been seen, which is the state every case below except one is about. */
function seenStore(extra) {
  const m = new Map();
  const v = /const VERSION = '([^']+)'/.exec(SRC)[1];
  m.set('hive-pocket.tutorial', v);
  if (extra) for (const [k, val] of Object.entries(extra)) m.set(k, JSON.stringify(val));
  return m;
}

(async () => {
  const t = makeCheck();
  const check = t.check;

  // ── 1. a tip is not an ambush ────────────────────────────────────────────────────────────
  const app = boot({ store: seenStore() });
  await settle();
  check('nothing is showing on load', app.pocket.tipShowing === false);
  check('and there is something to say', typeof app.pocket.nextTip === 'string', String(app.pocket.nextTip));
  check('reminders are on by default', app.pocket.tips.on === true);

  // ── 2. shown once, and then never again ──────────────────────────────────────────────────
  const first = app.pocket.nextTip;
  app.pocket.showTip({ id: first, text: 'x' });
  check('it is on screen', app.pocket.tipShowing === true);
  check('and recorded', (app.pocket.tips.shown || []).indexOf(first) >= 0, JSON.stringify(app.pocket.tips.shown));
  check('the next one is a different one', app.pocket.nextTip !== first, String(app.pocket.nextTip));

  // ── 3. dismiss is not the same as off ────────────────────────────────────────────────────
  fire(app.els('tipHide'), 'click');
  check('Got it hides it', app.pocket.tipShowing === false);
  check('but leaves reminders on', app.pocket.tips.on === true,
    'dismissing one must not silently switch the feature off');

  // ── 4. the switch is a switch ────────────────────────────────────────────────────────────
  const sw = app.els('tipsOn');
  sw.checked = false;
  fire(sw, 'change');
  check('off is remembered', app.pocket.tips.on === false);
  app.pocket.armTips();
  app.pocket.hideTip();
  check('and nothing is armed while off', app.pocket.tipShowing === false);
  sw.checked = true;
  fire(sw, 'change');
  check('and back on again', app.pocket.tips.on === true);

  // ── 5. one a day, not one an opening ─────────────────────────────────────────────────────
  // The gap is the whole difference between a reminder and a nag, and it has to survive a
  // restart — which means it lives in storage, not in a variable.
  const justNow = boot({ store: seenStore({ 'hive-pocket.tips': { shown: ['mic'], last: Date.now() } }) });
  await settle();
  justNow.pocket.armTips();
  check('a tip an hour ago means no tip now', justNow.pocket.tipShowing === false);

  const longAgo = boot({ store: seenStore({ 'hive-pocket.tips': { shown: ['mic'], last: Date.now() - 2 * DAY } }) });
  await settle();
  check('and two days later there is one waiting', typeof longAgo.pocket.nextTip === 'string',
    String(longAgo.pocket.nextTip));

  // ── 6. it runs out and goes quiet ────────────────────────────────────────────────────────
  const all = TIP_IDS();
  const done = boot({ store: seenStore({ 'hive-pocket.tips': { shown: all, last: 0 } }) });
  await settle();
  check('every tip shown means no next tip', done.pocket.nextTip === null, String(done.pocket.nextTip));
  done.pocket.armTips();
  check('and nothing appears', done.pocket.tipShowing === false,
    'the pool empties and the feature goes silent for good, rather than starting over');

  // ── 7. never during the tutorial ─────────────────────────────────────────────────────────
  // A new person meets the tutorial. A tip on top of it is two voices at once, and the tutorial
  // is the one that was asked for.
  const fresh = boot({});                       // no tutorial key: it has never been seen
  await settle();
  fresh.pocket.armTips();
  check('a first-ever opening arms nothing', fresh.pocket.tipShowing === false);
  const running = boot({ store: seenStore() });
  await settle();
  running.pocket.tutStart();
  check('the tutorial is up', shown(running.els('tut')));
  running.pocket.showTip({ id: 'x', text: 'y' });
  check('a tip started by hand still shows', running.pocket.tipShowing === true,
    'the guard belongs in armTips, not in showTip - a deliberate call must still work');
  running.pocket.tutStart();
  check('and starting the tutorial clears it', running.pocket.tipShowing === false);

  // ── 8. it never takes a tap away ─────────────────────────────────────────────────────────
  // Asserted against the stylesheet, because this is the rule the tutorial overlay broke in
  // 1.28.0 and it cost an unusable installed app.
  const css = fs.readFileSync(path.join(__dirname, '..', 'pocket.css'), 'utf8');
  const bar = /\.tip-bar\s*\{([^}]*)\}/.exec(css);
  check('the bar itself takes no pointer events', !!bar && /pointer-events:\s*none/.test(bar[1]),
    bar ? bar[1] : 'no .tip-bar rule');
  const x = /\.tip-x\s*\{([^}]*)\}/.exec(css);
  check('only its button does', !!x && /pointer-events:\s*auto/.test(x[1]), x ? x[1] : 'no .tip-x rule');

  // A <button> INSIDE A <button> IS NOT A THING HTML HAS, and the first cut of this put the
  // dismiss button inside #stage, which is one. The parser closes the outer button at the inner
  // start tag: the dismiss button never rendered, and the stage's own markup was restructured
  // around it. Nothing threw, nothing logged, and it took a zoomed screenshot to see.
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const stageOpen = html.indexOf('<button class="stage"');
  const stageClose = html.indexOf('</button>', stageOpen);
  const stageInner = html.slice(stageOpen, stageClose);
  check('the tip bar is not inside the stage button', stageInner.indexOf('id="tipBar"') < 0,
    'a <button> cannot contain a <button>; keep the tip a sibling inside #stageWrap');
  check('but it is inside the wrapper, so it travels into full screen',
    /id="stageWrap"[\s\S]*id="tipBar"[\s\S]*<section class="now"/.test(html));
  // The slice starts AT the stage's own opening tag, so skip past it before looking for another.
  const afterOpen = stageInner.slice(stageInner.indexOf('>') + 1);
  check('and no other button is nested in the stage', afterOpen.indexOf('<button') < 0,
    afterOpen.slice(Math.max(0, afterOpen.indexOf('<button')), afterOpen.indexOf('<button') + 90));

  // and touching the stage puts it away rather than fighting the gesture
  const gest = boot({ store: seenStore() });
  await settle();
  gest.pocket.showTip({ id: 'x', text: 'y' });
  fire(gest.els('stage'), 'pointerdown', { pointerId: 1, clientX: 10, clientY: 10 });
  check('a finger on the stage clears it', gest.pocket.tipShowing === false);

  // ── 9. this suite must be able to fail ───────────────────────────────────────────────────
  // Stop recording the timestamp. Case 5 must collapse: every opening would show one.
  const brokenSrc = SRC.replace('    st.last = Date.now();\n', '');
  check('the mutation applied', brokenSrc !== SRC,
    'the line this suite mutates has been reworded in pocket.js - update the string, do not '
    + 'delete the case, or case 5 stops proving anything');
  const broken = boot({ src: brokenSrc, store: seenStore() });
  await settle();
  broken.pocket.showTip({ id: 'mic', text: 'x' });
  check('without it nothing remembers when the last one was',
    !broken.pocket.tips.last, JSON.stringify(broken.pocket.tips));

  t.report();

  function TIP_IDS() {
    const block = /const TIPS = \[([\s\S]*?)\n  \];/.exec(SRC)[1];
    return [...block.matchAll(/id: '([^']+)'/g)].map((m) => m[1]);
  }
})();
