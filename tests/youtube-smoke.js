/**
 * YouTube smoke — the one source that is not a file and not a media URL.
 *
 * A YouTube address is a web page, not audio. No <audio> element will ever play one, so this is
 * a whole second backend: a player inside someone else's iframe, reached through a script they
 * serve. Three things follow from that and all three are tested here, because all three are easy
 * to get wrong in a way that looks fine until someone uses it.
 *
 *   1. THE ADDRESS IS PARSED, NOT TRUSTED. The id ends up in the src of a frame, so it is matched
 *      against a strict character class. A page on another host that merely mentions a video id
 *      is not a YouTube link.
 *   2. THE TRANSPORT HAS TO ASK WHICH BACKEND IT IS DRIVING. Play, pause, seek, next and previous
 *      all mean something different depending on the answer, and a queue whose Next skipped a
 *      whole playlist would throw away most of what the person added.
 *   3. IT NEEDS A CONNECTION, ALONE IN THIS APP. The script can simply not arrive. When that
 *      happens the app has to say so and give the stage back, not sit on a black rectangle.
 *
 * Runs under tests/dom-stub.js, which explains why it is not a real browser.
 *
 *   node tests/youtube-smoke.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { boot, fire, settle, makeCheck } = require('./dom-stub');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'pocket.js'), 'utf8');
const t = makeCheck();
const check = t.check;

const VIDEO = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const LIST = 'https://www.youtube.com/playlist?list=PLFgquLnL59alW3xmYiWRaoz0oM3H17Lth';

/** Add a link the way the link box does, then play it. */
async function addAndPlay(app, url) {
  app.els('linkInput').value = url;
  fire(app.els('linkAdd'), 'click');
  await settle();
  fire(app.els('playBtn'), 'click');
  await settle();
  await settle();      // the script arrives on one tick, the player is ready on the next
  await settle();
  return app;
}

(async function run() {
  console.log('\nyoutube\n');

  const app = boot({});
  const parse = app.pocket.parseYouTube;

  // ── 1. what counts as a YouTube address ──────────────────────────────────────────────────
  const cases = [
    ['a watch link', VIDEO, 'video', 'dQw4w9WgXcQ'],
    ['a short youtu.be link', 'https://youtu.be/dQw4w9WgXcQ', 'video', 'dQw4w9WgXcQ'],
    ['a Shorts link', 'https://www.youtube.com/shorts/dQw4w9WgXcQ', 'video', 'dQw4w9WgXcQ'],
    ['a phone link', 'https://m.youtube.com/watch?v=dQw4w9WgXcQ', 'video', 'dQw4w9WgXcQ'],
    ['a YouTube Music link', 'https://music.youtube.com/watch?v=dQw4w9WgXcQ', 'video', 'dQw4w9WgXcQ'],
    ['a playlist link', LIST, 'playlist', 'PLFgquLnL59alW3xmYiWRaoz0oM3H17Lth'],
  ];
  for (const [name, url, kind, id] of cases) {
    const got = parse(url);
    check(name + ' is read correctly', !!got && got.kind === kind && got.id === id,
      JSON.stringify(got));
  }
  // A video opened from inside a playlist carries both. The playlist is what was copied.
  const both = parse('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLFgquLnL59alW3xmYiWRaoz0oM3H17Lth');
  check('a video inside a playlist is taken as the playlist',
    !!both && both.kind === 'playlist', JSON.stringify(both));

  const rejects = [
    ['another host that names a video', 'https://example.com/watch?v=dQw4w9WgXcQ'],
    ['a lookalike hostname', 'https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ'],
    ['an id of the wrong length', 'https://www.youtube.com/watch?v=short'],
    ['an id with characters no id has', 'https://www.youtube.com/watch?v=abc<script>x'],
    ['the YouTube home page', 'https://www.youtube.com/'],
    ['a plain audio file', 'https://example.com/track.mp3'],
    ['not a link at all', 'not a link'],
  ];
  for (const [name, url] of rejects) check(name + ' is refused', parse(url) === null, url);

  // ── 2. adding one ────────────────────────────────────────────────────────────────────────
  app.els('linkInput').value = VIDEO;
  fire(app.els('linkAdd'), 'click');
  await settle();
  const row = app.pocket.queue[0];
  check('a YouTube link joins the queue', !!row && row.yt && row.yt.kind === 'video');
  check('and is named as one, with the id so two of them differ',
    row.name === 'YouTube video dQw4w9WgXcQ', row.name);
  check('and is saved like any other link', app.pocket.links.length === 1);

  // ── 3. playing one takes the stage ───────────────────────────────────────────────────────
  fire(app.els('playBtn'), 'click');
  await settle(); await settle(); await settle();
  check('the app knows YouTube has the sound', app.pocket.youtube === true);
  check("YouTube's player is on the stage", app.els('ytStage').hidden === false);
  check('the equalizer is not drawn over it', app.els('eqCanvas').hidden === true);
  check('nor are the effects', app.els('fxCanvas').hidden === true);
  check('and the app says why', /another site/.test(app.els('nowSub').textContent),
    app.els('nowSub').textContent);
  check('the script was fetched once', app.yt.scripts === 1, String(app.yt.scripts));
  check('the right video was loaded',
    app.yt.loaded.length === 1 && app.yt.loaded[0].id === 'dQw4w9WgXcQ',
    JSON.stringify(app.yt.loaded));
  check('the row takes the real title once the player has it',
    app.pocket.queue[0].name === 'A Song From YouTube', app.pocket.queue[0].name);

  // ── 4. the transport drives the player, not the audio element ────────────────────────────
  fire(app.els('playBtn'), 'click');
  await settle();
  check('pause reaches the player', app.yt.calls.includes('pause'), app.yt.calls.join(','));
  fire(app.els('playBtn'), 'click');
  await settle();
  check('play reaches the player', app.yt.calls.includes('play'), app.yt.calls.join(','));

  app.els('seek').value = '90';
  fire(app.els('seek'), 'input');
  check('seeking reaches the player', app.yt.calls.includes('seek:90'), app.yt.calls.join(','));

  // ── 5. Next inside a playlist means the next video, not the next queue row ───────────────
  const pl = boot({});
  await addAndPlay(pl, LIST);
  check('a playlist is loaded as a playlist',
    pl.yt.loaded.length === 1 && pl.yt.loaded[0].kind === 'playlist',
    JSON.stringify(pl.yt.loaded));
  const wasCurrent = pl.pocket.current;
  fire(pl.els('nextBtn'), 'click');
  await settle();
  check('Next advances inside the playlist', pl.yt.calls.includes('next'), pl.yt.calls.join(','));
  check('and does not leave the row', pl.pocket.current === wasCurrent,
    wasCurrent + ' -> ' + pl.pocket.current);
  fire(pl.els('prevBtn'), 'click');
  await settle();
  check('Previous goes back inside it too', pl.yt.calls.includes('previous'), pl.yt.calls.join(','));

  // ── 6. no connection ─────────────────────────────────────────────────────────────────────
  const off = boot({ youtube: 'blocked' });
  await addAndPlay(off, VIDEO);
  check('a blocked script is reported', /could not be reached/.test(off.els('nowSub').textContent),
    off.els('nowSub').textContent);
  check('and the stage is handed back', off.els('ytStage').hidden === true);
  check('and no player was built', off.yt.players === 0, String(off.yt.players));

  // ── 7. going back to a file on the phone ─────────────────────────────────────────────────
  const mix = boot({});
  await addAndPlay(mix, VIDEO);
  check('YouTube has the stage', mix.els('ytStage').hidden === false);
  const p = mix.els('filePick');
  p.files = [{ name: 'tone.wav', type: 'audio/wav' }];
  fire(p, 'change');
  await settle();
  fire(mix.els('playBtn'), 'click');
  await settle();
  check('a file takes the stage back', mix.els('ytStage').hidden === true);
  check('and the app knows YouTube let go', mix.pocket.youtube === false);
  check('and the player was stopped, not left running',
    mix.yt.calls.includes('stop'), mix.yt.calls.join(','));

  // ── 8. this suite must be able to fail ───────────────────────────────────────────────────
  // Cut the host check out of the parser. Every "is refused" case above should collapse, which
  // is what proves they were testing the parser and not the shape of the test.
  const brokenSrc = SRC.replace('if (!YT_HOSTS.includes(p.hostname)) return null;', '');
  check('the mutation applied', brokenSrc !== SRC);
  const broken = boot({ src: brokenSrc });
  check('without the host check a lookalike host gets through',
    broken.pocket.parseYouTube('https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ') !== null,
    'the host check was not what made that case pass');

  t.report();
})();
