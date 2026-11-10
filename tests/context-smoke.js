/**
 * Context smoke — when the audio context stops on its own, the app must not play on in silence.
 *
 * A file reaches the speakers through the Web Audio context. The <audio> element does not know
 * that: stop the context and the element carries on, timer moving, pause bars up, nothing to
 * hear. A browser may stop a context without being asked (a call, a headset, the background),
 * and until 1.72.0 this app neither noticed nor asked for it back.
 *
 * WHAT THIS CAN AND CANNOT PROVE. Whether a given phone ever does this is not known - it was
 * inferred from the code, never caught on a device. What is tested here is the app's half: told
 * that the context stopped, does it ask for it back; and if it does not come back, does it stop
 * the clock and say so, rather than pretend. The browser is tests/dom-stub.js, where
 * app.ctxSet(state) is the browser stopping the context and app.ctxResume is what asking does.
 * The app's own count of these events is in the problem report, which is how a real phone gets
 * to answer the first question.
 *
 *   node tests/context-smoke.js
 *   POCKET_SRC=path\to\old\pocket.js node tests/context-smoke.js     (must fail on 1.71.0)
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
const diag = (app) => (String(app.pocket.diagnostics()).split('\n').find((l) => /^audio context:/.test(l)) || '(no line)');
/** Wait for something to become true, for at most a second. Not a fixed sleep: it returns as
 *  soon as the thing happens and reports honestly when it never does. */
async function until(fn) {
  const end = Date.now() + 1000;
  while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 5)); }
  return fn();
}
/** Long enough for a 20 ms deadline to have fired several times over, had it been going to. */
const pastTheDeadline = () => new Promise((r) => setTimeout(r, 150));

async function started(opts) {
  const app = boot(Object.assign({ src: SRC, shortGrace: true }, opts || {}));
  pick(app);
  await settle();
  await press(app, 'playBtn');
  return app;
}

(async function run() {
  console.log('\nthe audio context stops on its own\n');

  // ── 1. it stops, and comes back when asked ───────────────────────────────────────────────
  const back = await started();
  check('the file is playing through the graph', playing(back).length === 1 && back.pocket.graphReady === true);
  const asked = back.ctxs[0].resumes;
  back.ctxSet('suspended');
  await rest();
  check('THE APP ASKS FOR THE CONTEXT BACK', back.ctxs[0].resumes > asked,
    'resume() calls: ' + asked + ' before, ' + back.ctxs[0].resumes + ' after');
  await pastTheDeadline();
  check('it came back, so the music was never stopped', playing(back).length === 1 && back.ctxs[0].state === 'running');
  check('and nothing was said about it', note(back) === 'From this device', note(back));
  check('the report counts it', /stopped 1, came back 1, gave up 0/.test(diag(back)), diag(back));

  // ── 2. the state Safari uses, which the old code never woke at all ───────────────────────
  const odd = await started();
  const asked2 = odd.ctxs[0].resumes;
  odd.ctxSet('interrupted');
  await rest();
  check('"interrupted" is asked back too, not only "suspended"', odd.ctxs[0].resumes > asked2);

  // ── 3. it stops and will NOT come back ───────────────────────────────────────────────────
  const gone = await started({ ctxResume: 'refuse' });
  gone.ctxSet('suspended');
  const stopped = await until(() => playing(gone).length === 0);
  check('A CONTEXT THAT STAYS DOWN PAUSES THE TRACK', stopped === true,
    'still "playing" into a stopped context: the timer runs and there is no sound');
  check('and says why', /Sound was interrupted/.test(note(gone)), note(gone));
  check('the report counts the give-up', /stopped 1, came back 0, gave up 1/.test(diag(gone)), diag(gone));

  // The tap that follows is the thing a browser accepts.
  gone.ctxResume = 'ok';
  await press(gone, 'playBtn');
  check('play brings the sound back', playing(gone).length === 1 && gone.ctxs[0].state === 'running',
    playing(gone).length + ' playing, context ' + gone.ctxs[0].state);
  check('and takes the notice down', note(gone) === 'From this device', note(gone));
  await pastTheDeadline();
  check('and it stays playing', playing(gone).length === 1);

  // ── 4. the tap is refused as well ────────────────────────────────────────────────────────
  // Nothing changes state when a resume is refused, so no event arrives. Without a deadline of
  // its own this play would run on in silence, which is the original fault by another door.
  const stuck = await started({ ctxResume: 'refuse' });
  stuck.ctxSet('suspended');
  await until(() => playing(stuck).length === 0);
  fire(stuck.els('playBtn'), 'click');
  await settle();
  check('the tap does start it', playing(stuck).length === 1);
  const again = await until(() => playing(stuck).length === 0);
  check('a refused tap does not leave it playing in silence', again === true);
  check('and the notice is back', /Sound was interrupted/.test(note(stuck)), note(stuck));

  // ── 5. a resume() that never answers ─────────────────────────────────────────────────────
  const hung = await started({ ctxResume: 'hang' });
  hung.ctxSet('suspended');
  check('a resume that never settles is still given up on', (await until(() => playing(hung).length === 0)) === true);

  // A context flapping between two stopped states must not push the deadline back each time.
  const flap = await started({ ctxResume: 'refuse' });
  flap.ctxSet('suspended');
  const flapping = setInterval(() => flap.ctxSet(flap.ctxs[0].state === 'suspended' ? 'interrupted' : 'suspended'), 5);
  const flapStopped = await until(() => playing(flap).length === 0);
  clearInterval(flapping);
  check('A FLAPPING CONTEXT DOES NOT POSTPONE THE PAUSE FOR EVER', flapStopped === true,
    'every state change restarted the deadline, so it never arrived');
  check('and it is counted as one stop, not dozens', /stopped 1, /.test(diag(flap)), diag(flap));

  // The browser resumes the element BY ITSELF into a context that is still down: a play
  // event and nothing else - no tap, no started(), no change of state.
  const self = await started({ ctxResume: 'refuse' });
  await press(self, 'playBtn');                       // paused by hand
  self.ctxs[0].state = 'suspended';                  // goes down quietly while paused
  self.medias[0].paused = false;
  fire(self.medias[0], 'play');
  check('a track the BROWSER resumed into a stopped context is caught too',
    (await until(() => playing(self).length === 0)) === true && /Sound was interrupted/.test(note(self)), note(self));

  // A closed context is never coming back, so there is nothing to wait for.
  const shut = boot({ src: SRC, ctxResume: 'refuse' });   // real timers: no grace to hide behind
  pick(shut);
  await settle();
  await press(shut, 'playBtn');
  shut.ctxSet('closed');
  await rest();
  check('a closed context stops the track at once and says to reopen', playing(shut).length === 0
    && /cannot be restarted/.test(note(shut)), note(shut));
  await press(shut, 'playBtn');
  check('and play does not pretend otherwise', playing(shut).length === 0 && /cannot be restarted/.test(note(shut)),
    playing(shut).length + ' playing, ' + note(shut));

  // The same, on a phone whose visuals cannot start EITHER, the first time anything plays.
  // started() writes "the visuals would not start... The sound is fine" - and until 1.76.0 wrote
  // it AFTER the context check had paused the track and said why: a paused track under a note
  // saying the sound is fine. Two faults at once, so rare; the visuals only fail to start once,
  // which is why the context here is closed from the beginning and not closed later.
  const both = boot({ src: SRC, ctxResume: 'refuse', ctxState: 'closed', brokenRenderer: true });
  pick(both);
  await settle();
  await press(both, 'playBtn');
  check('ON A CLOSED CONTEXT THE REASON IT STOPPED IS NOT WRITTEN OVER', playing(both).length === 0
    && /cannot be restarted/.test(note(both)), playing(both).length + ' playing, ' + note(both));

  // ── 6. the deadline is a deadline, not an instant stop ───────────────────────────────────
  // Real timers here. A headset switch takes a second or two, and the music must survive it.
  const patient = boot({ src: SRC, ctxResume: 'hang' });
  pick(patient);
  await settle();
  await press(patient, 'playBtn');
  patient.ctxSet('suspended');
  await pastTheDeadline();
  check('the track is NOT paused the moment the context drops', playing(patient).length === 1);
  patient.ctxs[0].state = 'running';
  fire(patient.ctxs[0], 'statechange');
  await rest();
  check('and coming back inside the grace costs nothing', playing(patient).length === 1
    && note(patient) === 'From this device', note(patient));
  // Stop it so its timer cannot outlive the suite.
  await press(patient, 'playBtn');

  // And HOW LONG, measured once on a real clock. Under two seconds and a headset switch pauses
  // the music; much over three and the silence is long enough to be the bug again.
  const timed = boot({ src: SRC, ctxResume: 'hang' });
  pick(timed);
  await settle();
  await press(timed, 'playBtn');
  const t0 = Date.now();
  timed.ctxSet('suspended');
  let took = -1;
  while (Date.now() - t0 < 5000) { if (playing(timed).length === 0) { took = Date.now() - t0; break; } await new Promise((r) => setTimeout(r, 20)); }
  check('the grace is between two and three and a half seconds', took >= 2000 && took <= 3500, took + ' ms');

  // ── 7. what must never be paused for the context's sake ──────────────────────────────────
  // A link without CORS plays on the element outside the graph. The context is nothing to it.
  const plain = boot({ src: SRC, shortGrace: true, ctxResume: 'refuse', noCorsHosts: ['nocors.example'],
    store: new Map([['hive-pocket.links', JSON.stringify([{ name: 'a song', url: 'https://nocors.example/q.mp3' }])]]) });
  await press(plain, 'playBtn');
  check('a no-CORS link is playing, with a context in existence', playing(plain).length === 1 && plain.ctxs.length === 1,
    playing(plain).length + ' playing, ' + plain.ctxs.length + ' context(s)');
  plain.ctxSet('suspended');
  await pastTheDeadline();
  check('IT IS LEFT ALONE - its sound does not go through the context', playing(plain).length === 1
    && /no visuals/.test(note(plain)), note(plain));

  // A track the person paused is not "interrupted", whatever the context does afterwards.
  const quiet = await started({ ctxResume: 'refuse' });
  await press(quiet, 'playBtn');
  quiet.ctxSet('suspended');
  await pastTheDeadline();
  check('a track paused by hand gets no interruption notice', !/interrupted/.test(note(quiet)), note(quiet));

  // ── 8. coming back to the app ────────────────────────────────────────────────────────────
  // The context can be left down with no event at all. Returning is when that gets noticed.
  const away = await started({ ctxResume: 'refuse' });
  away.ctxs[0].state = 'suspended';          // silently: no statechange
  away.doc.visibilityState = 'visible';      // the stub's document does not carry one
  away.doc_fire('visibilitychange');
  check('returning to the app notices a context left down',
    (await until(() => playing(away).length === 0)) === true && /Sound was interrupted/.test(note(away)), note(away));

  // ── 9. a track that "is playing" and is not, with a context that says it is fine ─────────
  // From the phone, on 1.77.0: the app is opened again, the button already shows pause, there
  // is no sound and the time is not moving. Nothing above catches that - every case so far has
  // a context that ADMITS it stopped. Here it says 'running' throughout.
  const line = (app, key) => (String(app.pocket.diagnostics()).split('\n').find((l) => l.indexOf(key + ':') === 0) || '(no line: ' + key + ')');
  const comeBack = (app) => { app.doc.visibilityState = 'visible'; app.doc_fire('visibilitychange'); };

  const stuck2 = await started();
  check('the report describes the element while it plays', /^audio element: routed, paused false/.test(line(stuck2, 'audio element'))
    && line(stuck2, 'play calls') === 'play calls: asked 1, started 1, refused 0, last started'
    && line(stuck2, 'play button says') === 'play button says: Pause',
    [line(stuck2, 'audio element'), line(stuck2, 'play calls'), line(stuck2, 'play button says')].join(' | '));
  comeBack(stuck2);                                   // and its clock never moves
  check('A TRACK THAT HAS NOT MOVED SINCE THE APP CAME BACK IS PAUSED', (await until(() => playing(stuck2).length === 0)) === true,
    'still "playing": pause bars, no sound, the time standing still');
  check('and says why', /Sound was interrupted/.test(note(stuck2)), note(stuck2));
  check('the button offers Play', stuck2.els('playBtn').getAttribute('aria-label') === 'Play');
  check('it is counted as a stuck track, not as a context that stopped',
    line(stuck2, 'stuck tracks paused on return') === 'stuck tracks paused on return: 1' && /stopped 0, came back 0, gave up 0/.test(diag(stuck2)),
    line(stuck2, 'stuck tracks paused on return') + ' | ' + diag(stuck2));
  check('THE REPORT KEEPS WHAT THE APP CAME BACK TO, from before it was paused',
    /^return to the app 1: \(shown\) .*context running; routed, paused false/.test(line(stuck2, 'return to the app 1')) && /then element \+0\.00s/.test(line(stuck2, 'return to the app 1')),
    line(stuck2, 'return to the app 1'));
  await press(stuck2, 'playBtn');
  check('play carries on and takes the notice down', playing(stuck2).length === 1 && note(stuck2) === 'From this device', note(stuck2));

  // The same return, to a track that IS playing. Its clock moves; it is left alone.
  const fine = await started();
  comeBack(fine);
  fine.medias[0].currentTime += 1.2;
  await pastTheDeadline();
  check('A TRACK THAT IS MOVING IS NOT TOUCHED', playing(fine).length === 1 && note(fine) === 'From this device'
    && line(fine, 'stuck tracks paused on return') === 'stuck tracks paused on return: 0', note(fine));
  check('and the report says how far it moved', /then element \+1\.20s/.test(line(fine, 'return to the app 1')), line(fine, 'return to the app 1'));

  // WHAT THE CHECK MUST LEAVE ALONE. Each of these was paused by the first version of it.
  // The person drags the seek bar BACK: the clock moved, the wrong way, and that is not a fault.
  const back2 = await started();
  back2.medias[0].currentTime = 20;
  comeBack(back2);
  back2.medias[0].currentTime = 3;
  await pastTheDeadline();
  check('a clock that moved BACKWARDS is the person seeking, not a stuck track', playing(back2).length === 1
    && note(back2) === 'From this device', note(back2));

  // A link that ran out of data is buffering. Slow is not interrupted.
  const slow = await started();
  comeBack(slow);
  slow.medias[0].readyState = 2;
  await pastTheDeadline();
  check('a track that is buffering is not called interrupted', playing(slow).length === 1 && note(slow) === 'From this device', note(slow));
  check('and the report says it was short of data', /ready 2/.test(line(slow, 'return to the app 1')), line(slow, 'return to the app 1'));

  // A context that ADMITS it is down has its own, longer grace (case 6). This check is shorter,
  // and must not undercut it: real timers, and 1.7 s is past this one and inside that one.
  const grace = boot({ src: SRC, ctxResume: 'hang' });
  pick(grace);
  await settle();
  await press(grace, 'playBtn');
  grace.ctxs[0].state = 'suspended';
  comeBack(grace);
  await new Promise((r) => setTimeout(r, 1700));
  check('THE CONTEXT WATCH KEEPS ITS FULL GRACE - the shorter check stands aside', playing(grace).length === 1,
    'paused at a second and a half, when the grace for a headset switch is two and a half');
  check('and the report says who was left to deal with it', /left to the context watch/.test(line(grace, 'return to the app 1')),
    line(grace, 'return to the app 1'));
  await press(grace, 'playBtn');                      // stop it, so no timer outlives the suite

  // One return, two events. It is one line in the report, named for both.
  const twice = await started();
  twice.doc_fire('resume');
  comeBack(twice);
  twice.medias[0].currentTime += 2;
  await pastTheDeadline();
  const twiceLines = String(twice.pocket.diagnostics()).split('\n').filter((l) => /^return to the app \d/.test(l));
  check('a return that arrives as two events is ONE return', twiceLines.length === 1 && /\(thawed\+shown\)/.test(twiceLines[0])
    && /then element \+2\.00s/.test(twiceLines[0]), twiceLines.join(' || '));

  // Paused by hand inside the wait: that is not an interruption.
  const hand = await started();
  comeBack(hand);
  await press(hand, 'playBtn');
  await pastTheDeadline();
  check('a track paused by hand inside the wait gets no notice', !/interrupted/.test(note(hand)), note(hand));

  // The plain element is outside the graph, so the context watch leaves it alone (case 7). A
  // stuck clock is a stuck clock on either element.
  const plain2 = boot({ src: SRC, shortGrace: true, noCorsHosts: ['nocors.example'],
    store: new Map([['hive-pocket.links', JSON.stringify([{ name: 'a song', url: 'https://nocors.example/q.mp3' }])]]) });
  await press(plain2, 'playBtn');
  check('a no-CORS link is playing on the plain element', playing(plain2).length === 1 && /^audio element: plain/.test(line(plain2, 'audio element')),
    line(plain2, 'audio element'));
  comeBack(plain2);
  check('a stuck link outside the graph is paused too', (await until(() => playing(plain2).length === 0)) === true
    && /Sound was interrupted/.test(note(plain2)), note(plain2));

  // Coming back with nothing loaded must not throw, and is still written down.
  const empty = boot({ src: SRC, shortGrace: true });
  check('before anything, the report says so', line(empty, 'audio element') === 'audio element: no element'
    && line(empty, 'return to the app') === 'return to the app: never left'
    && line(empty, 'play calls') === 'play calls: asked 0, started 0, refused 0, last none',
    [line(empty, 'audio element'), line(empty, 'return to the app'), line(empty, 'play calls')].join(' | '));
  let threw = null;
  try { comeBack(empty); } catch (e) { threw = e; }
  check('coming back with nothing loaded does not throw', threw === null && /context none; no element/.test(line(empty, 'return to the app 1')),
    String(threw) + ' | ' + line(empty, 'return to the app 1'));

  // THE LAST THREE RETURNS ARE KEPT. Copying the report means leaving the app, and coming back
  // from that must not be the only return the report remembers.
  const many = await started();
  for (let i = 0; i < 5; i++) {
    comeBack(many);
    many.medias[0].currentTime += 2;
    await new Promise((r) => setTimeout(r, 2100));   // far enough apart to be separate returns
  }
  const kept = String(many.pocket.diagnostics()).split('\n').filter((l) => /^return to the app \d/.test(l));
  check('three returns are kept, no more and no fewer', kept.length === 3, kept.length + ' kept');

  // A refused play() is counted, which is how a play that never started shows in the report.
  const refused = boot({ src: SRC, shortGrace: true, blockFirstPlay: true });
  pick(refused);
  await settle();
  await press(refused, 'playBtn');
  check('a refused play is counted as refused', /asked 1, started 0, refused 1, last refused/.test(line(refused, 'play calls')),
    line(refused, 'play calls'));

  t.report();
})();
