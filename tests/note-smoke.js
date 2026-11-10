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
 * Since 1.75.0, a track that ENDS no longer walks onto a row that cannot play (case 7).
 *
 * And since 1.73.0 one place where the line was merely SILENT: the press that stops the
 * microphone, with music waiting, now says that the next press plays it.
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

  // ── 6. the microphone was listening, and the press stopped it ───────────────────────────
  // By design the button stops whatever its pause bars are showing for, and with the microphone
  // open that is the microphone. With music waiting it read as a play button that did not play.
  // The behaviour stays; the line under the title now says what the next press will do.
  const ear = boot({ src: SRC });
  pick(ear);
  await settle();
  fire(ear.els('micBtn'), 'click');
  await rest();
  check('the microphone is listening, with music queued', ear.pocket.micLive === true && playing(ear).length === 0);
  await press(ear, 'playBtn');
  check('the press stops the microphone, as before', ear.pocket.micLive === false && playing(ear).length === 0);
  check('AND SAYS WHAT THE NEXT PRESS DOES', /Stopped listening\. Press play for your music/.test(note(ear)), note(ear));
  await press(ear, 'playBtn');
  check('the next press plays', playing(ear).length === 1);
  check('and the hint is gone', note(ear) === 'From this device', note(ear));

  // Nothing to play: the hint would be a promise the button cannot keep.
  const empty = boot({ src: SRC });
  fire(empty.els('micBtn'), 'click');
  await rest();
  await press(empty, 'playBtn');
  check('with no music queued there is no such hint', empty.pocket.micLive === false
    && !/Press play for your music/.test(note(empty)), note(empty));

  // A track that was already chosen keeps its own line.
  const mid = boot({ src: SRC });
  pick(mid);
  await settle();
  await press(mid, 'playBtn');
  fire(mid.els('micBtn'), 'click');          // listening pauses the file
  await rest();
  check('listening pauses the file', mid.pocket.micLive === true && playing(mid).length === 0);
  await press(mid, 'playBtn');
  check('a paused track keeps its own line when listening stops', mid.pocket.micLive === false
    && note(mid) === 'From this device', note(mid));

  // Names remembered but the folder itself forgotten: the rows are locked and nothing here can
  // unlock them, so a press of play would do nothing. That is not music waiting.
  const lost = boot({ src: SRC, store: new Map([['hive-pocket.foldernames', JSON.stringify(['one', 'two'])]]) });
  await rest();
  check('locked rows are shown with no folder behind them', lost.pocket.queue.length === 2
    && lost.pocket.queue.every((x) => x.pending), JSON.stringify(lost.pocket.queue));
  fire(lost.els('micBtn'), 'click');
  await rest();
  await press(lost, 'playBtn');
  check('and rows nothing can unlock get no such hint either', lost.pocket.micLive === false
    && !/Press play for your music/.test(note(lost)), note(lost));

  // ── 7. the queue runs onto a row that cannot play ───────────────────────────────────────
  // A kept YouTube link sits in the queue and explains itself when pressed. When a track simply
  // ENDED and that row was next, the app "played" it: the sound stopped, mid-queue, for good.
  const YT = { name: 'a video', url: 'https://www.youtube.com/watch?v=abc' };
  const OK = { name: 'a song', url: 'https://ok.example/a.mp3' };
  const through = boot({ src: SRC, store: new Map([['hive-pocket.links', JSON.stringify([YT, OK])]]) });
  pickMany(through, 2);                       // track0, track1, a video (dead), a song
  await settle();
  await press(through, 'playBtn');
  await press(through, 'nextBtn');
  check('playing the row before the dead one', through.els('nowTitle').textContent === 'track1'
    && playing(through).length === 1, through.els('nowTitle').textContent);
  await runOut(through);
  check('A TRACK THAT ENDS STEPS OVER THE ROW THAT CANNOT PLAY', playing(through).length === 1
    && through.els('nowTitle').textContent === 'a song',
    through.els('nowTitle').textContent + ', ' + playing(through).length + ' playing: ' + note(through));
  // The button is different: pressing your way onto the row is asking what it is.
  await press(through, 'prevBtn');
  check('the Previous button still lands on it and says why', /YouTube links cannot play here/.test(note(through)),
    note(through));

  // Nothing but dead rows after the last track: that is the end of the queue, said as such,
  // with the title still the track that played.
  const tail = boot({ src: SRC, store: new Map([['hive-pocket.links', JSON.stringify([YT])]]) });
  pickMany(tail, 2);
  await settle();
  await press(tail, 'playBtn');
  await press(tail, 'nextBtn');
  await runOut(tail);
  check('dead rows at the end are the end of the queue', playing(tail).length === 0
    && note(tail) === 'End of the queue.' && tail.els('nowTitle').textContent === 'track1',
    tail.els('nowTitle').textContent + ': ' + note(tail));
  await press(tail, 'nextBtn');
  check('and the Next button there still shows the row', /YouTube links cannot play here/.test(note(tail)), note(tail));

  // Repeat all: round past the dead row to the top.
  const round = boot({ src: SRC, store: new Map([['hive-pocket.links', JSON.stringify([YT])]]) });
  pickMany(round, 2);
  await settle();
  await press(round, 'repeatBtn');             // off -> all
  await press(round, 'playBtn');
  await press(round, 'nextBtn');
  await runOut(round);
  check('with repeat all it goes round past the dead row', playing(round).length === 1
    && round.els('nowTitle').textContent === 'track0',
    round.pocket.repeatMode + ': ' + round.els('nowTitle').textContent + ', ' + note(round));

  // Shuffle: whatever order it draws, a track that ends never leaves the music on the dead row.
  // Fresh boots, four endings each: in this stub a track "ends" the instant it starts, and five
  // of those in a row is the app's own limit for giving up (RAN_OUT_NOTE), which is not this.
  let stranded = 0;
  for (let b = 0; b < 6; b++) {
    const mix = boot({ src: SRC, store: new Map([['hive-pocket.links', JSON.stringify([YT])]]) });
    pickMany(mix, 3);
    await settle();
    await press(mix, 'shuffleBtn');
    await press(mix, 'repeatBtn');
    await press(mix, 'playBtn');
    for (let i = 0; i < 4; i++) { await runOut(mix); if (playing(mix).length !== 1) stranded++; }
  }
  check('shuffled, twenty-four tracks ending never strand it on the dead row', stranded === 0, stranded + ' of 24');

  // One track that plays among three that cannot, shuffled, repeat all: whatever order is drawn
  // it must come round to that one track again and never call it the end of the queue.
  let lostIt = 0;
  for (let b = 0; b < 12; b++) {
    const lone = boot({ src: SRC, store: new Map([['hive-pocket.links', JSON.stringify([YT,
      { name: 'two', url: 'https://youtu.be/two' }, { name: 'three', url: 'https://youtu.be/three' }])]]) });
    pickMany(lone, 1);
    await settle();
    await press(lone, 'shuffleBtn');
    await press(lone, 'repeatBtn');
    await press(lone, 'playBtn');
    for (let i = 0; i < 3; i++) { await runOut(lone); if (playing(lone).length !== 1) lostIt++; }
  }
  check('one playable track among dead rows keeps coming round, shuffled', lostIt === 0, lostIt + ' of 36');

  // A FILE that will not play is skipped automatically too, and that skip must not land on the
  // dead row either.
  const broke = boot({ src: SRC, store: new Map([['hive-pocket.links', JSON.stringify([YT, OK])]]) });
  pickMany(broke, 2);
  await settle();
  await press(broke, 'playBtn');
  await press(broke, 'nextBtn');
  fire(playing(broke)[0], 'error');
  await rest();
  check('a file that fails skips past the dead row as well', playing(broke).length === 1
    && broke.els('nowTitle').textContent === 'a song', broke.els('nowTitle').textContent + ': ' + note(broke));

  t.report();
})();
