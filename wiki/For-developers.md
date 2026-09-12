# For developers

Repo: `cobrahjh/hive-pocket-media-player` · served from GitHub Pages at
**pocket.kinghive.online** · working tree on ROCK at `C:\DevClaude\hive-pocket`.

## Layout

    index.html      one screen, the settings sheet, and all the help text
    pocket.js       the whole app
    pocket.css      styles
    sw.js           service worker; caches the app, version kept in step with pocket.js BY HAND
    manifest.json   PWA manifest, all paths relative so the app is origin- and path-agnostic
    eq-render.js    equalizer renderer   \ shared with the stream overlays.
    fx-render.js    effects renderer     / READ-ONLY here: never edited from this repo
    tests/          six suites and a runner

## Tests

    node tests/run-all.js        every suite; -v prints every line

`run-all.js` globs `*-smoke.js`, so a new suite is picked up without editing anything. A suite
that crashes is reported as a failure with its output, never skipped.

    ambient-smoke.js     the effect picker, and whether a flashing mode strikes
    folder-smoke.js      the remembered folder, and the first touch that asks for it back
    resume-smoke.js      a play blocked by the phone, then resumed by a tap
    transport-smoke.js   the play button's glyph, and never both at once
    visuals-smoke.js     what is on the stage, and the tap that fills the screen
    wisp-smoke.js        the two-finger toggle, a box change, and a rotation

They run under plain Node against `tests/dom-stub.js` — a hand-written browser, because the Chrome
reachable from an agent session is a hidden tab, and a hidden tab freezes `requestAnimationFrame`
and clamps timers, so a canvas renderer never draws and a green run would mean nothing.

Three rules the suites are built on, each of them paid for:

- **A fake that is a subset of the real thing** does not make a suite weaker in an obvious place,
  it makes it wrong in a confusing one. Four stub gaps in six releases were every one of them
  found by changing the app, never by reading the stub. The stub now reads `index.html` to learn
  which ids are `<svg>` and which start hidden, rather than being told.
- **Every suite mutates the code under test** and requires its own assertion to fail. A suite that
  cannot fail is decoration.
- **A new case is run against the historical `pocket.js`** from the tag that had the bug
  (`git show <rev>:pocket.js`). Twice that has revealed a case passing against the broken build
  for the wrong reason.

## Releasing

Bump `VERSION` in **both** `pocket.js` and `sw.js` — they are separate scripts kept in step by
hand, and a mismatch makes the service worker serve the old build. Run the suites, commit, push,
then verify the live bytes match the working tree with `sha256sum`. A version string agreeing is
not the same as the file agreeing.

## One rule above the others

**One line from the phone beats three releases of guessing.** Settings → Report a problem carries
every setting and counter the app can see. When a report cannot answer the question, add the
counter that would and ship that first. The folder question, the missing wisps and the
effects-layer-off bug were each settled in one round trip that way, after several rounds of
guessing that were not.
