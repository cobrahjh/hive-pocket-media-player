# Hive Pocket Media Player

*…because you're as awesome as the music!*

A music player with live visuals that runs entirely on your phone.

**https://pocket.kinghive.online**

No account, no server, no network at all after the first load. Open it, tap the folder button,
pick some audio.

## Put it on your home screen

Open the page above on the phone, then use the **browser's own menu** — the three dots in
Chrome, the share button in Safari — and choose **Install app** or **Add to Home screen**.
Settings also grows an **Add to home screen** button, but only once Chrome has decided the site
qualifies, which can take a visit or two; the menu route always works.

Installing buys you the browser bars going away, and nothing else. It does **not** stop the app
asking for your music folder after a cold start — Chrome documents that it should, and on a real
Android phone it asks anyway.

**If you installed it from the old `cobrahjh.github.io` address**, install it again from this one
and delete the old icon by long-pressing it. A browser keeps storage per origin, so the old
install's remembered folder, track names and settings do not come with it: pick the folder once
and you are back. Tapping the old icon now redirects here, which lands outside that install's own
scope and opens a browser tab instead of the app.

## What it does

- **Plays audio from the device**, plus direct links to audio files that you save.
- **Draws an equalizer and effects** from the audio it is playing — or, with the microphone,
  from whatever it can hear in the room, including music from another app entirely.
- **Answers your finger.** Drag or press on the visuals and they paint — lightning, a burst,
  ripples, or a combination, and the finger can throw a different effect from the one the music
  is throwing. Two fingers send a pair of wisps wandering off; two fingers again sends them away.
  (The app calls them *lights* — the code and this README call them wisps, and they are the same
  thing.)
- **Tap the visuals for full screen.** Tap again to come back.
- **Lock-screen controls**, and it works offline.

## Finding your way around it

Every control has a tooltip, and the settings sheet is eight groups — Music, Look, Equalizer,
Effects, Screen, Advanced, Help, About — each of which says its current value while closed, so
you can tell whether to open one without opening it.

- **Show me around** replays the seven-step tour. It runs once by itself on a first visit, and
  again only when the tour itself is rewritten — not on every release.
- **Feature reminders** put one line on the stage now and then, naming one thing the app can do.
  One a day at most, never the same one twice, and the pool of eleven runs out in a fortnight and
  is then silent for good. Off in Help → Feature reminders; everything a reminder names is also
  in **How it works**.
- **Reset all settings** — Help → Start over. Two presses. It puts every setting back to how it
  arrived and touches nothing else: your saved links, your music folder, its remembered track
  names and a half-written problem report all stay.

## Three things worth knowing

**It needs one tap after a cold start.** The folder itself is remembered — your track names come
back instantly as a locked queue — but Android will not carry the file *permission* across a
cold start, whatever Chrome's documentation says about installed apps. So the first thing you
touch, whatever it was for, asks for the folder back and the music returns. There is no button
to find.

**The microphone is the interesting one.** Everything else here can only see audio this app
owns. Play anything out loud — a phone, a speaker, a laptop, the radio — press Listen, and the
visuals follow it. Three capture flags are pinned off, because all three defaults are tuned for
a phone call and every one of them is wrong for music. Nothing heard is recorded or sent.

**Storm and lightning flash.** If flashing bothers you, or you are photosensitive, leave those
alone. They are never chosen for you. Pick one and three limits apply that no setting can raise:
the flash never exceeds 0.12 opacity, strikes never land inside 0.8 seconds of each other, and
at most six bolts are alive at once. Everything is dropped entirely when the phone asks apps to
reduce motion.

## Privacy

Your music never leaves the device. It is not uploaded, copied, or cached by the app. The
content security policy in `index.html` allows no outside host at all — `frame-src` is `'none'`
and `connect-src` is `'self'` — and the app makes no network request after it loads. Reporting a
problem hands the text to your own mail app; nothing is sent from here.

YouTube was removed in 1.18.0. It was the only thing that reached the network, and the only
source the equalizer and effects could not read — an iframe from another origin, so it played to
a dead stage. Play it out loud and press Listen instead. Links saved before are kept, and say so
when pressed rather than failing silently.

## Tests

    node tests/run-all.js        every suite; -v prints every line

It globs `*-smoke.js`, so a new suite is picked up without editing anything:

    advanced-smoke.js    the renderers' own knobs, and setConfig replacing rather than merging
    ambient-smoke.js     the effect picker, and whether a flashing mode strikes
    finger-smoke.js      ripples, and what a finger throws when it is not the beat
    folder-smoke.js      the remembered folder, and the first touch that asks for it back
    resume-smoke.js      a play blocked by the phone, then resumed by a tap
    settings-smoke.js    reset, the equalizer's height, the dice hint, the tutorial revision
    sheet-smoke.js       the settings sheet's groups, ids and readouts
    tips-smoke.js        the rules that stop feature reminders becoming nagware
    transport-smoke.js   the play button's glyph, and never both at once
    visuals-smoke.js     what is on the stage, and the tap that fills the screen
    wisp-smoke.js        the two-finger toggle, a box change, and a rotation

All of them run under plain Node against `tests/dom-stub.js`, and each one mutates the code under
test and requires its own assertion to fail. Three rules the suites are built on:

- **A fake that is a subset of the real thing** does not make a suite weaker in an obvious place,
  it makes it wrong in a confusing one. The stub reads `index.html` for which ids are `<svg>` and
  which start hidden, rather than being told.
- **A case that cannot be shown to fail against the build it was written for is decoration.**
  New cases are run against the historical `pocket.js` from the tag that had the bug.
- **A decision nobody can forget to make.** Two of these suites turn a thing to remember into a
  thing that stops the build: every storage key must be in `RESET_KEYS` or `KEEP_KEYS`, and the
  tutorial's steps are pinned to a digest so they cannot be rewritten without someone choosing
  whether that rewrite deserves to interrupt everyone again.

The stub's own header explains why these are not browser tests.

## Built from

The equalizer and effects renderers come from [Hive Visuals](https://github.com/cobrahjh), where
they drive a live streaming overlay. They are copied rather than shared, and are never edited
from here: both are pure, and this app stands alone.

## Licence

**Apache License 2.0** — see [LICENSE](LICENSE). Copyright 2026 Harold J. Harding.

Use it, change it, ship it, sell it. Keep the notice, say what you changed, and do not use the
author's name or the Hive marks to endorse your version. Contributors grant a patent licence with
their contribution, which is the practical difference from MIT.

`eq-render.js` and `fx-render.js` come from the author's own Hive Visuals and are covered by the
same licence here.
