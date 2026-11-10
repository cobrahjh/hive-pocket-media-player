/**
 * Note smoke — the line under the title has to be true.
 *
 * It is one line, it is the only place the app says what it is doing, and until 1.71.0 it was
 * wrong in four ordinary situations. None of them is a crash and none shows in a screenshot of a
 * working app, which is why each survived: the music was right and the sentence under it was not.
 *
 *   1. Paused while a track was still loading  -> "Tap play to start", as if the phone had refused
 *   2. A dead YouTube row pressed mid-song     -> the old song carried on under the new title
 *   3. Play pressed after "five tracks stopped" -> the stop notice stayed up over the music
 *   4. Play pressed after "End of the queue."   -> the same
 *
 * The browser is tests/dom-stub.js. To run every case against another build of the app:
 *
 *   node tests/note-smoke.js
 *   POCKET_SRC=path\to\old\pocket.js node tests/note-smoke.js     (must fail on 1.70.0)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { boot, fire, pick, settle, makeCheck } = require('./dom-stub');

const SRC = fs.readFileSync(process.env.POCKET_SRC || path.join(__dirname, '..', 'pocket.js'), 'utf8');
const t = makeCheck();
const check = t.check;

const rest = async () => { for (let i = 0; i < 6; i++) await settle(); };
const press = async (app, id) => { fire(app.els(id), 'click'); await rest(); };
const playing = (app) => app.medias.filter((m) => !m.paused);
const note = (app) => app.els('nowSub').textContent;
/** Queue n tracks the way the file picker does. */
function pickMany(app, n) {
  const p = app.els('filePick');
  p.files = [];
  for (let i = 0; i < n; i++) p.files.push({ name: 'track' + i + '.wav', type: 'audio/wav' });
  fire(p, 'change');
}
/** The track ran out. A real element pauses itself and then fires `ended`. */
async function runOut(app) {
  const m = playing(app)[0];
  if (!m) return;
  m.pause();
  fire(m, 'ended');
  await rest();
}

(async function run() {
  console.log('\nthe line under the title\n');

  // ── 1. paused while still loading ────────────────────────────────────────────────────────
  const slow = boot({ src: SRC, slowPlay: true });
  pick(slow);
  await settle();
  await press(slow, 'playBtn');
  check('a track that is loading counts as playing', playing(slow).length === 1);
  await press(slow, 'playBtn');
  check('pause stops it', playing(slow).length === 0);
  check('AND DOES NOT CLAIM THE PHONE WANTS A TAP', !/Tap play to start/.test(note(slow)), note(slow));

  // A phone that really refuses must still be told about. resume-smoke owns that case in full;
  // this is the one line that proves the fix above did not simply delete the message.
  const refused = boot({ src: SRC, blockFirstPlay: true });
  pick(refused);
  await settle();
  await press(refused, 'playBtn');
  check('a real refusal still says tap play', /Tap play to start/.test(note(refused)), note(refused));

  // ── 2. a row that cannot play, pressed while something else is playing ───────────────────
  const yt = boot({ src: SRC,
    store: new Map([['hive-pocket.links', JSON.stringify([{ name: 'a video', url: 'https://www.youtube.com/watch?v=abc' }])]]) });
  pick(yt);
  await settle();
  await press(yt, 'playBtn');
  check('the file is playing first', playing(yt).length === 1);
  await press(yt, 'nextBtn');
  check('the dead row says why it cannot play', /YouTube links cannot play here/.test(note(yt)), note(yt));
  check('AND THE SONG BEFORE IT HAS STOPPED', playing(yt).length === 0,
    playing(yt).length + ' still playing under the dead row\'s title');
  await press(yt, 'playBtn');
  check('play on a dead row plays nothing', playing(yt).length === 0);
  check('and still says why', /YouTube links cannot play here/.test(note(yt)), note(yt));
  await press(yt, 'prevBtn');
  check('going back to the file plays it again', playing(yt).length === 1 && note(yt) === 'From this device',
    playing(yt).length + ' playing, ' + note(yt));

  // The same row pressed FIRST, before any audio element exists. Play must not start row 0.
  const cold = boot({ src: SRC, store: new Map([['hive-pocket.links', JSON.stringify([
    { name: 'a song', url: 'https://open.example/loud.mp3' },
    { name: 'a video', url: 'https://www.youtube.com/watch?v=abc' }])]]) });
  await press(cold, 'prevBtn');           // from nothing, Previous lands on the last row
  check('a dead row pressed first says why', /YouTube links cannot play here/.test(note(cold)), note(cold));
  await press(cold, 'playBtn');
  check('AND PLAY DOES NOT START A DIFFERENT TRACK', playing(cold).length === 0 && /YouTube/.test(note(cold)),
    playing(cold).length + ' playing, ' + note(cold));

  // ── 3. five tracks in a row that ended at once ───────────────────────────────────────────
  const short = boot({ src: SRC });
  pickMany(short, 8);
  await settle();
  await press(short, 'playBtn');
  for (let i = 0; i < 5; i++) await runOut(short);
  check('five instant endings stop the queue and say so', /Five tracks in a row stopped/.test(note(short))
    && playing(short).length === 0, note(short));
  await press(short, 'playBtn');
  check('play carries on, as the notice offers', playing(short).length === 1);
  check('AND THE NOTICE COMES DOWN', note(short) === 'From this device', note(short));

  // ── 4. the end of the queue ──────────────────────────────────────────────────────────────
  const last = boot({ src: SRC });
  pick(last);
  await settle();
  await press(last, 'playBtn');
  await runOut(last);
  check('the last track ending says so', note(last) === 'End of the queue.', note(last));
  await press(last, 'playBtn');
  check('play starts it again', playing(last).length === 1);
  check('AND "END OF THE QUEUE" COMES DOWN', note(last) === 'From this device', note(last));

  // ── 5. the notice that must still be there after a start ─────────────────────────────────
  // started() takes notes down now, so the one it puts UP has to come after. This does not tell
  // "a list of notes" from "clear whatever is there" - nothing on screen does, today - it only
  // proves the visuals notice was not lost to the new code.
  const bad = boot({ src: SRC, brokenRenderer: true });
  pick(bad);
  await settle();
  await press(bad, 'playBtn');
  check('a renderer that cannot start is still reported', /visuals would not start/.test(note(bad)), note(bad));

  t.report();
})();
