# Hive Pocket Media Player

A music player with live visuals that runs **entirely on your phone**.

Pick music that is already on the device and it plays, with an equalizer and an effects layer
drawn from that audio. No account, no sign-in, no server, and no network at all after the first
load. Install it to the home screen and it works in aeroplane mode.

## Try it

Open the link on a phone, tap the folder button, choose some audio files, tap a track.
Then use your browser's **Install app** / **Add to Home screen**.

## What it does

- Plays audio files from the device.
- Draws a **equalizer** and an **effects layer**, both fed by the player's own audio through a
  Web Audio analyser. Nothing else is capturing anything.
- **Lock-screen controls** — title, artwork, play/pause, next and previous.
- **Works offline.** The app caches itself on first load.

## What it deliberately does not do, in version 1

Google Drive, YouTube, Twitch, chat, and anything that talks to a server. Version 1 exists to
prove the player and the visuals.

## The one thing that surprises people

**It asks for your music every time it starts cold.** That is not an oversight.

The browser API that can remember a folder is desktop-only. On a phone, picking files hands the
page plain files and no lasting handle, so the only way to "remember" a library is to copy every
track into browser storage — which doubles the space your music takes and can be silently evicted
when the phone is short of room. Losing a library without being told is worse than a tap, so
version 1 takes the tap.

## Privacy

Your music never leaves the device. It is not uploaded, not copied, and not cached by the app.
The app makes no network requests of its own once loaded — the content security policy in
`index.html` blocks anything else from trying.

## Flashing effects

Two background effects flash the screen: **storm** and **lightning**. They are in the picker
because they are worth having, and they are never chosen for you — the app falls back to stars,
and neither is ever picked at random. If flashing bothers you, or you are photosensitive, leave
those two alone.

Choose one and three limits apply that no setting can raise: the whole-frame flash never exceeds
0.12 opacity, two strikes can never land inside 0.8 seconds of each other, and at most six bolts
are alive at once.

## Tests

    node tests/ambient-smoke.js     the picker, and whether a flashing mode actually strikes
    node tests/resume-smoke.js      a play blocked by the phone, then resumed by a tap

Both run under plain Node against stub DOM objects, and both mutate the code under test to prove
their own assertions can fail.

## Built from

The equalizer and effects renderers come from [Hive Visuals](https://github.com/cobrahjh), where
they drive a live streaming overlay. They are copied here rather than shared: both are pure
(arrays in, canvas out), and this app is meant to stand alone.

## Licence

Not yet chosen — see the repository owner before redistributing.
