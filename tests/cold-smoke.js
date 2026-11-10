/**
 * Cold-start smoke — pressing Play first thing gives the music back in the right place.
 *
 * On a cold start the remembered folder is not readable yet. The app shows its tracks by name,
 * locked, and the first tap unlocks them. Until 1.73.0 two things were wrong with that list:
 *
 *   - it was in the order the folder had LISTED its files, while the real queue is sorted. So the
 *     list changed order the moment it unlocked, and its first row could be any track at all;
 *   - Play pressed on it played that first row by name. In the review that found this, the first
 *     row was the last track in the sorted queue, so one song played and the queue ended.
 *
 * And Play did not resume the track you were on, though the Reconnect button beside it did.
 *
 * The browser is tests/dom-stub.js. Its fake folder lists files in the order given, which is
 * the whole point here: every case below gives them out of order.
 *
 *   node tests/cold-smoke.js
 *   POCKET_SRC=path\to\old\pocket.js node tests/cold-smoke.js     (must fail on 1.72.0)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { boot, fire, settle, makeCheck } = require('./dom-stub');

const SRC = fs.readFileSync(process.env.POCKET_SRC || path.join(__dirname, '..', 'pocket.js'), 'utf8');
const t = makeCheck();
const check = t.check;

const loaded = async () => { for (let i = 0; i < 14; i++) await settle(); };
// Listed the way a real folder might: by nothing in particular.
// "mango 2" beside "mango" is deliberate: with the extension on, "mango 2.mp3" sorts BEFORE
// "mango.mp3"; without it, after. The locked list has no extensions to sort by, so the real
// queue must not use them either or the two orders part company on exactly such a pair.
const LISTED = ['zebra.mp3', 'apple.mp3', 'track 10.mp3', 'mango 2.mp3', 'track 2.mp3', 'mango.mp3'];
const SORTED = ['apple', 'mango', 'mango 2', 'track 2', 'track 10', 'zebra'];
const names = (app, pending) => app.pocket.queue.filter((x) => (pending ? x.pending : (x.handle || x.file))).map((x) => x.name);
const playingCount = (app) => app.medias.filter((m) => !m.paused).length;

async function cold(folder, before) {
  const app = boot({ src: SRC, folder: Object.assign({ state: 'prompt', files: LISTED }, folder || {}) });
  if (before) before(app);
  await loaded();
  return app;
}

(async function run() {
  console.log('\nplay as the first press on a cold start\n');

  // ── 1. the locked list is in the order it will have once unlocked ────────────────────────
  const first = await cold();
  check('the remembered tracks are shown locked', names(first, true).length === LISTED.length);
  check('IN SORTED ORDER, not the order the folder listed them', names(first, true).join('|') === SORTED.join('|'),
    names(first, true).join(', '));

  // ── 2. Play, with nothing remembered about last time: the first track ────────────────────
  first.activation(true);
  fire(first.els('playBtn'), 'click');
  await loaded();
  check('the folder came back', names(first, false).join('|') === SORTED.join('|'), names(first, false).join(', '));
  check('and it is playing', playingCount(first) === 1);
  check('THE FIRST TRACK, not whichever the folder listed first', first.els('nowTitle').textContent === 'apple',
    first.els('nowTitle').textContent);
  check('the names are stored in the real order from now on',
    first.store.get('hive-pocket.foldernames') === JSON.stringify(SORTED), String(first.store.get('hive-pocket.foldernames')));

  // ── 3. Play, with a track remembered: that track ─────────────────────────────────────────
  const resume = await cold(null, (app) => app.store.set('hive-pocket.lasttrack', 'track 2'));
  resume.activation(true);
  fire(resume.els('playBtn'), 'click');
  await loaded();
  check('PLAY RESUMES THE TRACK YOU WERE ON', resume.els('nowTitle').textContent === 'track 2' && playingCount(resume) === 1,
    resume.els('nowTitle').textContent);

  // A remembered track that is no longer in the folder falls back to the first.
  const gone = await cold(null, (app) => app.store.set('hive-pocket.lasttrack', 'deleted since'));
  gone.activation(true);
  fire(gone.els('playBtn'), 'click');
  await loaded();
  check('a remembered track that has gone means the first one', gone.els('nowTitle').textContent === 'apple',
    gone.els('nowTitle').textContent);

  // ── 4. the same tap arriving twice, as it does on a phone ────────────────────────────────
  // pointerup fires the first-touch reconnect, then the button's click arrives. One ask, and
  // the click's wish to play must land on it.
  const both = await cold({ defer: true }, (app) => app.store.set('hive-pocket.lasttrack', 'mango'));
  both.activation(true);
  both.doc_fire('pointerup', { pointerType: 'touch', pointerId: 1 });
  fire(both.els('playBtn'), 'click');
  await settle();
  check('one tap is still one ask', both.folder.asks === 1, String(both.folder.asks));
  both.folder.answer('granted');
  await loaded();
  check('and it plays the remembered track', both.els('nowTitle').textContent === 'mango' && playingCount(both) === 1,
    both.els('nowTitle').textContent + ', ' + playingCount(both) + ' playing');

  // The first touch has ALREADY brought the folder back when the click lands (no sheet to
  // wait for). Nothing is locked any more, and Play must still resume, not start at the top.
  const late = await cold({ answer: 'granted' }, (app) => app.store.set('hive-pocket.lasttrack', 'track 2'));
  late.activation(true);
  late.doc_fire('pointerup', { pointerType: 'touch', pointerId: 1 });
  await loaded();
  check('the first touch alone brings the folder back and plays nothing',
    names(late, false).length === LISTED.length && playingCount(late) === 0);
  fire(late.els('playBtn'), 'click');
  await loaded();
  check('PLAY ON A FOLDER ALREADY BACK RESUMES TOO', late.els('nowTitle').textContent === 'track 2'
    && playingCount(late) === 1, late.els('nowTitle').textContent);

  // ── 5. a wish to play must not outlive the attempt that carried it ───────────────────────
  // Play pressed with no gesture the browser recognises: nothing can be asked, nothing plays.
  // A LATER stray touch reconnects the folder and must not start music on the strength of it.
  const stale = await cold();
  stale.activation(false);
  fire(stale.els('playBtn'), 'click');
  await loaded();
  check('with no gesture nothing is asked and nothing plays', stale.folder.asks === 0 && playingCount(stale) === 0);
  stale.activation(true);
  stale.doc_fire('pointerup', { pointerType: 'touch', pointerId: 1 });
  await loaded();
  check('the later touch brings the folder back', names(stale, false).length === LISTED.length);
  check('AND DOES NOT START MUSIC NOBODY ASKED FOR', playingCount(stale) === 0,
    'an old press of play was still waiting, and a stray touch set it off');

  // ── 6. the folder is refused ─────────────────────────────────────────────────────────────
  const no = await cold({ answer: 'denied' });
  no.activation(true);
  fire(no.els('playBtn'), 'click');
  await loaded();
  check('a refused folder plays nothing', playingCount(no) === 0);
  check('and the list stays, locked, to ask again', names(no, true).length === LISTED.length);

  // ── 7. what must not change ──────────────────────────────────────────────────────────────
  // Shuffle on: Play still resumes the remembered track; shuffle decides what comes after.
  const mixed = await cold(null, (app) => { app.store.set('hive-pocket.lasttrack', 'zebra'); });
  fire(mixed.els('shuffleBtn'), 'click');
  await settle();
  mixed.activation(true);
  fire(mixed.els('playBtn'), 'click');
  await loaded();
  check('with shuffle on, Play still resumes the remembered track',
    mixed.els('nowTitle').textContent === 'zebra' && playingCount(mixed) === 1, mixed.els('nowTitle').textContent);
  fire(mixed.els('nextBtn'), 'click');
  await loaded();
  check('and Next then plays something', playingCount(mixed) === 1);

  // ── 8. this suite must be able to fail ───────────────────────────────────────────────────
  // Case 5 guards one assignment. Cut it out and the stray touch must start the music.
  if (!process.env.POCKET_SRC) {
    const CLEAR = ' reconnectWantPlay = false; });';
    const mutated = SRC.replace(CLEAR, ' });');
    check('the mutation applied', mutated !== SRC,
      'reconnectFolder() has been reworded - update the string, do not delete the case');
    const leaky = boot({ src: mutated, folder: { state: 'prompt', files: LISTED } });
    await loaded();
    leaky.activation(false);
    fire(leaky.els('playBtn'), 'click');
    await loaded();
    leaky.activation(true);
    leaky.doc_fire('pointerup', { pointerType: 'touch', pointerId: 1 });
    await loaded();
    check('without it, the stray touch plays', playingCount(leaky) === 1,
      'the mutated build stayed quiet, so case 5 proves nothing');
  }

  t.report();
})();
