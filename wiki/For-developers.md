# For developers

Repo: `cobrahjh/hive-pocket-media-player` · served from GitHub Pages at
**pocket.kinghive.online** · working tree on ROCK at `C:\DevClaude\hive-pocket`.

## Layout

    index.html      one screen, the settings sheet, and all the help text
    pocket.js       the whole app
    pocket.css      styles
    sw.js           service worker; caches the app, version kept in step with pocket.js BY HAND
    manifest.json   PWA manifest, all paths relative so the app is origin- and path-agnostic
    privacy.html    the policy Play requires a public URL for; precached
    eq-render.js    equalizer renderer   \ shared with the stream overlays.
    fx-render.js    effects renderer     / READ-ONLY here: never edited from this repo
    tests/          ten suites and a runner
    wiki/           these pages
    play/           store listing copy, assets, and the TWA notes

## Tests

    node tests/run-all.js        every suite; -v prints every line

`run-all.js` globs `*-smoke.js`, so a new suite is picked up without editing anything. A suite
that crashes is reported as a failure with its output, never skipped.

    advanced-smoke.js    the renderers' own knobs, and setConfig replacing rather than merging
    ambient-smoke.js     the effect picker, and whether a flashing mode strikes
    finger-smoke.js      ripples, and what a finger throws when it is not the beat
    folder-smoke.js      the remembered folder, and the first touch that asks for it back
    resume-smoke.js      a play blocked by the phone, then resumed by a tap
    settings-smoke.js    reset, the equalizer's height, the dice hint, the tutorial revision
    sheet-smoke.js       the sheet's groups, its ids against pocket.js, and the readouts
    tips-smoke.js        the rules that stop feature reminders becoming nagware
    transport-smoke.js   the play button's glyph, and never both at once
    visuals-smoke.js     what is on the stage, and the tap that fills the screen
    wisp-smoke.js        the two-finger toggle, a box change, and a rotation

They run under plain Node against `tests/dom-stub.js` — a hand-written browser, because the Chrome
reachable from an agent session is a hidden tab, and a hidden tab freezes `requestAnimationFrame`
and clamps timers, so a canvas renderer never draws and a green run would mean nothing.

Four rules the suites are built on, each of them paid for:

- **A fake that is a subset of the real thing** does not make a suite weaker in an obvious place,
  it makes it wrong in a confusing one. Five stub gaps in eight releases were every one of them
  found by changing the app, never by reading the stub. The stub now reads `index.html` to learn
  which ids are `<svg>` and which start hidden, requires the renderers' real exported tables from
  the real files, and records `documentElement.style.setProperty` rather than swallowing it.
- **Every suite mutates the code under test** and requires its own assertion to fail. A suite that
  cannot fail is decoration.
- **A new case is run against the historical `pocket.js`** from the tag that had the bug
  (`git show <rev>:pocket.js`). Twice that has revealed a case passing against the broken build
  for the wrong reason.
- **Turn a thing to remember into a thing that stops the build.** `settings-smoke.js` reads every
  `hive-pocket.*` key declaration out of `pocket.js` and fails if one is in neither `RESET_KEYS`
  nor `KEEP_KEYS`; it also pins the tutorial's steps to a digest, so they cannot be rewritten
  without somebody choosing whether that rewrite earns an interruption. `sheet-smoke.js` reads the
  ids `pocket.js` uses and the ids `index.html` has and requires the first to be a subset of the
  second — a markup rebuild is the one change where no code moves and everything can still break.

## Traps that have cost time

**`setConfig` REPLACES rather than merges**, on both renderers. Every key the app owns has to be
in every call or the renderer resets the rest to its own defaults. That is what `withAdv()` is
for: it folds the advanced overrides onto the config the app already built, so one object carries
everything.

**`hidden` is an IDL attribute on `HTMLElement`, not on `SVGElement`.** `svg.hidden = true` makes
a plain JavaScript property and writes no content attribute, so the CSS never matches. Use
`setHidden()`, which writes the attribute with `toggleAttribute`.

**The equalizer's height is its canvas box, not `regionH`.** `eq-render.js` exports
`regionH`/`regionY`, which look like exactly the knob for "make the bars shorter" and are not: a
region pin drops the renderer into its fixed 1920×1080 stream frame and fits that frame to the
source with one uniform scale, so on a tall phone stage it letterboxes the equalizer into a 16:9
band floating in the middle. The renderer measures itself against `canvas.clientHeight` and
nothing else, so Pocket sets a CSS custom property on the canvas — and then calls `eq.resize()`
by hand, because changing a custom property fires no resize event and both renderers re-measure
on window resize alone.

**Everything drawn on the bolt canvas needs three decisions, not one.** It holds bolts, wisps
and — since 1.64.0 — ripples, and each of them answers separately to `clearBolts()` (the layer is
going away), `clearStrikes()` (the finger's own drawing stops) and `reflowBolts()` (the box
changed). The trap is the LOOP's stop condition: it clears the canvas and returns once its lists
are empty, so a new list missing from that check is drawn once and then abandoned — alive in
memory, invisible on screen, with no error anywhere. That is what went wrong when wisps were
added, and `finger-smoke.js` asserts it now rather than trusting anyone to remember.

**A touch `pointerdown` carries no user activation.** A finger gets it on `pointerup` and
`touchend`; `pointerdown` counts only for a mouse. Asking for a permission on the wrong one makes
Chrome resolve `denied` with no prompt shown, which reads in a report as a refusal the person
never made.

**Version bumps are not tutorial bumps.** `TUT_REV` is bumped when a STEP changes, and the
tutorial key holds that revision rather than `VERSION` — which is what used to replay the
seven-step tour for everybody on every release.

## Releasing

Bump `VERSION` in **both** `pocket.js` and `sw.js` — they are separate scripts kept in step by
hand, and a mismatch makes the service worker serve the old build. Bump `TUT_REV` only if the
tour changed, and update the pinned digest in `settings-smoke.js` either way. Run the suites,
commit, push, then verify the live bytes match the working tree. A version string agreeing is not
the same as the file agreeing.

## One rule above the others

**One line from the phone beats three releases of guessing.** Settings → Report a problem carries
every setting and counter the app can see. When a report cannot answer the question, add the
counter that would and ship that first. The folder question, the missing wisps and the
effects-layer-off bug were each settled in one round trip that way, after several rounds of
guessing that were not.
