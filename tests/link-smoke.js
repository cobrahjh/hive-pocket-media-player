/**
 * Link smoke — a saved link on a host that will not grant CORS has to make SOUND.
 *
 * Until 1.70.0 it did not, and nothing said so. The app asks for CORS so the visuals can read the
 * audio; a host that refuses fails the load, and the app retried without asking. That retry
 * played — timer running, pause bars showing, a note on screen saying "Playing, but no visuals" —
 * through the one audio element the app had, which was wired into Web Audio. Web Audio hands back
 * zeroes for media it has no permission to read, so the speakers got nothing. Measured in Chrome
 * by the review that found it: peak at the destination 0, against about 200 for the same file
 * from a host that sends Access-Control-Allow-Origin.
 *
 * WHAT THIS CAN AND CANNOT PROVE. There is no sound in this folder: the browser is
 * tests/dom-stub.js. What silenced the link was one specific thing — the element playing it had
 * been passed to createMediaElementSource — and that IS visible here, because the stub records
 * every element the app routes. So the claim under test is "the element playing a refused link
 * was never put through Web Audio", which is the cause, not the symptom. That the speakers then
 * carry it is a browser fact checked by hand in a real Chrome, not by this file.
 *
 * It mutates itself, like resume-smoke: the last case cuts the guard out and requires the
 * central check to FAIL. To run every case against another build of the app:
 *
 *   node tests/link-smoke.js
 *   POCKET_SRC=path\to\old\pocket.js node tests/link-smoke.js     (must fail on 1.69.0)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { boot, fire, pick, settle, makeCheck } = require('./dom-stub');

const SRC = fs.readFileSync(process.env.POCKET_SRC || path.join(__dirname, '..', 'pocket.js'), 'utf8');
const t = makeCheck();
const check = t.check;

const QUIET = 'https://nocors.example/quiet.mp3';
const OPEN = 'https://open.example/loud.mp3';
const saved = (url) => new Map([['hive-pocket.links', JSON.stringify([{ name: 'a song', url }])]]);
// The refusal, the retry and the two promises behind them are four turns of the loop.
const rest = async () => { for (let i = 0; i < 6; i++) await settle(); };
const playing = (app) => app.medias.filter((m) => !m.paused);
const press = async (app, id) => { fire(app.els(id), 'click'); await rest(); };

(async function run() {
  console.log('\na link whose host refuses CORS\n');

  // ── 1. it is the first thing played ──────────────────────────────────────────────────────
  const first = boot({ src: SRC, store: saved(QUIET), noCorsHosts: ['nocors.example'] });
  await press(first, 'playBtn');
  let now = playing(first);
  check('the refused link is playing', now.length === 1 && now[0].src === QUIET,
    now.length + ' playing, src=' + (now[0] && now[0].src));
  check('it is playing WITHOUT a CORS request', !!now[0] && now[0].crossOrigin !== 'anonymous');
  check('THE ELEMENT PLAYING IT WAS NEVER PUT THROUGH WEB AUDIO',
    !!now[0] && first.routed.indexOf(now[0]) < 0,
    'routed ' + first.routed.length + ' element(s), including the one playing the link - '
    + 'Web Audio outputs zeroes for it, which is silence with the timer running');
  const firstNote = first.els('nowSub').textContent;
  check('the note says there are no visuals', /no visuals/.test(firstNote), firstNote);
  check('the note does not ask for a tap that is not needed', !/Tap play/.test(firstNote), firstNote);

  await press(first, 'playBtn');
  check('pause stops it', playing(first).length === 0, playing(first).length + ' still playing');
  await press(first, 'playBtn');
  now = playing(first);
  check('play brings the same element back, still outside the graph',
    now.length === 1 && now[0].src === QUIET && first.routed.indexOf(now[0]) < 0);

  // ── 2. it comes after a file, when the graph already exists ──────────────────────────────
  // The ordinary case on a phone: music from the device first, then the link. The graph is
  // built and bound to the first element by then, so this is where "one element" was fatal.
  const after = boot({ src: SRC, store: saved(QUIET), noCorsHosts: ['nocors.example'] });
  pick(after);
  await settle();
  await press(after, 'playBtn');
  check('the file builds the graph', after.pocket.graphReady === true && after.routed.length === 1,
    'graphReady=' + after.pocket.graphReady + ' routed=' + after.routed.length);
  check('a file says where it came from', after.els('nowSub').textContent === 'From this device',
    after.els('nowSub').textContent);
  const fileEl = playing(after)[0];

  await press(after, 'nextBtn');
  now = playing(after);
  check('then the link plays, and only the link', now.length === 1 && now[0].src === QUIET,
    now.length + ' playing: ' + now.map((m) => m.src).join(', '));
  check('on an element that is not the routed one', !!now[0] && after.routed.indexOf(now[0]) < 0);
  check('and the file is no longer loaded', !!fileEl && fileEl.paused === true);
  check('with the no-visuals note', /no visuals/.test(after.els('nowSub').textContent),
    after.els('nowSub').textContent);

  await press(after, 'prevBtn');
  now = playing(after);
  check('back to the file: one element playing, the routed one',
    now.length === 1 && now[0] === fileEl && after.routed.indexOf(now[0]) >= 0,
    now.length + ' playing');
  check('and the note goes back with it', after.els('nowSub').textContent === 'From this device',
    after.els('nowSub').textContent);
  check('the graph was built once, for one element', after.routed.length === 1, String(after.routed.length));

  // ── 3. a host that DOES grant CORS keeps its visuals ─────────────────────────────────────
  // The fix must not be "never route a link": that would be sound for everyone and visuals for
  // nobody, when most hosts that serve audio files allow the read.
  const open = boot({ src: SRC, store: saved(OPEN), noCorsHosts: ['nocors.example'] });
  await press(open, 'playBtn');
  now = playing(open);
  check('an allowed link plays', now.length === 1 && now[0].src === OPEN);
  check('with the CORS request', !!now[0] && now[0].crossOrigin === 'anonymous');
  check('through the graph, so the visuals can read it',
    open.pocket.graphReady === true && open.routed.indexOf(now[0]) >= 0);
  check('on the one element - no second one is made for it', open.medias.length === 1,
    String(open.medias.length));
  check('and a link is not "From this device"', open.els('nowSub').textContent === 'From a saved link',
    open.els('nowSub').textContent);

  // ── 4. the phone refuses the retry, because no tap asked for it ──────────────────────────
  const shy = boot({ src: SRC, store: saved(QUIET), noCorsHosts: ['nocors.example'], blockPlainPlay: true });
  await press(shy, 'playBtn');
  check('a refused retry says tap play', /Tap play to start/.test(shy.els('nowSub').textContent),
    shy.els('nowSub').textContent);
  check('and nothing is playing yet', playing(shy).length === 0);
  await press(shy, 'playBtn');
  now = playing(shy);
  check('the tap plays the link outside the graph',
    now.length === 1 && now[0].src === QUIET && shy.routed.indexOf(now[0]) < 0,
    now.length + ' playing, routed=' + shy.routed.length);
  check('and the tap puts the right note back', /no visuals/.test(shy.els('nowSub').textContent),
    shy.els('nowSub').textContent);

  // ── 5. a link that will not play at all says THAT, and stops ─────────────────────────────
  // Refused with CORS, retried without, refused again. Two things can go wrong and both did or
  // could: a third attempt (a loop), or the last rejection writing "tap play" over the reason.
  const dead = boot({ src: SRC, store: saved('https://gone.example/x.mp3'), deadHosts: ['gone.example'] });
  await press(dead, 'playBtn');
  check('a dead link plays nothing', playing(dead).length === 0);
  check('it is tried twice and no more - with CORS, then without', dead.playCalls() === 2,
    String(dead.playCalls()));
  check('and the note says the link would not play', /That link would not play/.test(dead.els('nowSub').textContent),
    dead.els('nowSub').textContent);

  // ── 6. this suite must be able to fail ───────────────────────────────────────────────────
  // Hand the plain element to the graph again and require case 1's central check to collapse.
  if (!process.env.POCKET_SRC) {
    const brokenSrc = SRC.replace('(audio === plainAudio ? ensureCtx() : ensureGraph(audio))',
                                  'ensureGraph(audio)');
    check('the mutation applied', brokenSrc !== SRC,
      'the guard this suite mutates has been reworded in pocket.js - update the string, do not '
      + 'delete the case, or the check above stops proving anything');
    const broken = boot({ src: brokenSrc, store: saved(QUIET), noCorsHosts: ['nocors.example'] });
    await press(broken, 'playBtn');
    now = playing(broken);
    check('without the guard the link is routed again', !!now[0] && broken.routed.indexOf(now[0]) >= 0,
      'the mutated build still kept the link out of the graph, so case 1 proves nothing');
  }

  t.report();
})();
