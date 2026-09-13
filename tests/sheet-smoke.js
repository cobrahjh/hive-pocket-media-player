/**
 * The settings sheet: every id the app paints into exists, every group says its value, and the
 * sheet opens at the top.
 *
 * WHY THIS SUITE EXISTS. The sheet was rebuilt on 2026-09-13 from loose headings and 2,800 words
 * into eight groups. A rebuild of markup is the one change where nothing in pocket.js changes
 * and everything can still break: paintSheet() writes into forty ids by name, the tutorial rings
 * seven of them, and a dropped id fails silently - setHidden(null) returns, textContent on a
 * missing element throws inside a handler nobody sees. So the first thing here is the plain
 * check that the ids pocket.js uses are still in index.html. It is read from BOTH files rather
 * than a list kept here, so it stays true when either changes.
 *
 * NOT COVERED: how it looks. Whether a card reads as a card and a readout sits on the right is
 * a screenshot's job, and one is taken by hand before a release.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { boot, fire, pick, settle, makeCheck, shown } = require('./dom-stub');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'pocket.js'), 'utf8');

(async () => {
  const t = makeCheck();
  const check = t.check;

  // ── 1. every id the app reaches for is in the markup ─────────────────────────────────────
  const sheetStart = HTML.indexOf('id="sheet"');
  const sheet = HTML.slice(HTML.lastIndexOf('<', sheetStart), HTML.indexOf('</section>', sheetStart));
  const inSheet = new Set([...sheet.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const inPage = new Set([...HTML.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const used = new Set([
    ...[...SRC.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]),
    ...[...SRC.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]),
    ...[...SRC.matchAll(/at: '#([^']+)'/g)].map((m) => m[1]),
  ]);
  const missing = [...used].filter((id) => !inPage.has(id) && !/^adv-/.test(id));
  check('every id pocket.js uses exists in index.html', missing.length === 0, missing.join(', '));
  check('the sheet holds the controls', ['lookSel', 'eqSel', 'beatSel', 'micBtn', 'folderPick', 'reportText', 'advEq', 'tutAgain']
    .every((id) => inSheet.has(id)));

  // ── 2. the tutorial's targets are all real ───────────────────────────────────────────────
  const tutTargets = [...SRC.matchAll(/at: '#([^']+)'/g)].map((m) => m[1]);
  check('the tutorial rings more than one thing', tutTargets.length >= 4, String(tutTargets.length));
  check('and every one of them exists', tutTargets.every((id) => inPage.has(id)),
    tutTargets.filter((id) => !inPage.has(id)).join(', '));

  // ── 3. every section is a group, and every group has a summary ───────────────────────────
  const looseHeadings = [...sheet.matchAll(/<h3 class="sheet-sec">/g)].length;
  check('no loose section headings remain', looseHeadings === 0, String(looseHeadings));
  // The regex sees nested groups too (How it works and Report a problem live inside Help), so
  // the order is checked as a subsequence: the eight appear, in this order, with anything else
  // allowed between them.
  const groups = [...sheet.matchAll(/<details class="grp"[^>]*>\s*<summary>([^<]+)/g)].map((m) => m[1].trim());
  const want = ['Music', 'Look', 'Equalizer', 'Effects', 'Screen', 'Advanced', 'Help', 'About'];
  let at = 0;
  for (const g of groups) if (g === want[at]) at++;
  check('the eight groups appear in the intended order', at === want.length, groups.join('|'));

  // ── 4. the readouts say the value, not the key ───────────────────────────────────────────
  const app = boot({});
  await settle();
  fire(app.els('menuBtn'), 'click');
  await settle();
  const v = (id) => app.els(id).textContent;
  check('Music says nothing yet on a cold app', v('valMusic') === 'Nothing yet', v('valMusic'));
  check('Look names the look', v('valLook') === 'Hive', v('valLook'));
  check('Equalizer names the style by label', v('valEq') === 'Bars', v('valEq'));
  check('Effects names the burst', v('valFx') === 'Fireworks', v('valFx'));
  check('Screen says player and performance', /Everything · Auto/.test(v('valScreen')), v('valScreen'));
  check('Advanced says Defaults', v('valAdv') === 'Defaults', v('valAdv'));

  // change a control: the readout follows through the delegated listener
  const eqSel = app.els('eqSel');
  eqSel.value = 'radial';
  fire(eqSel, 'change');
  fire(app.els('sheet'), 'change');
  await settle();
  check('a changed style reaches its readout', v('valEq') === 'Radial', v('valEq'));
  check('and the look drops to Custom', v('valLook') === 'Custom', v('valLook'));

  app.pocket.setAdv('eq', 'bands', 40);
  check('a moved advanced knob is counted', v('valAdv') === '1 changed', v('valAdv'));

  // music readout follows the queue and the microphone
  pick(app, 'song.mp3');
  await settle();
  fire(app.els('sheet'), 'change');
  check('a picked track is counted', v('valMusic') === '1 track', v('valMusic'));
  fire(app.els('micBtn'), 'click');
  for (let i = 0; i < 5; i++) await settle();
  check('listening wins the readout', v('valMusic') === 'Listening', v('valMusic'));

  // ── 5. nothing to forget, no red button ──────────────────────────────────────────────────
  check('Forget the folder is hidden with no folder', !shown(app.els('folderForget')));
  check('Forget all saved links is hidden with none', !shown(app.els('forgetLinks')));

  // ── 6. the sheet opens at the top ────────────────────────────────────────────────────────
  const sh = app.els('sheet');
  sh.scrollTop = 900;
  fire(app.els('sheetClose'), 'click');
  await settle();
  fire(app.els('menuBtn'), 'click');
  await settle();
  check('reopening puts the scroll at the top', sh.scrollTop === 0, String(sh.scrollTop));

  // ── 7. this suite must be able to fail ───────────────────────────────────────────────────
  // Rename one id in the markup the way a rebuild would, and require case 1 to see it.
  const brokenHtml = HTML.replace('id="eqSel"', 'id="equalizerSel"');
  check('the mutation applied', brokenHtml !== HTML);
  const ids2 = new Set([...brokenHtml.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const missing2 = [...used].filter((id) => !ids2.has(id) && !/^adv-/.test(id));
  check('a renamed id is caught', missing2.length === 1 && missing2[0] === 'eqSel', missing2.join(', '));

  t.report();
})();
