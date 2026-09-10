# Hive Pocket Media Player

A music player with live visuals that runs on your phone. No account, no server, no network
except for YouTube.

**Try it:** open it on a phone, tap the folder button, pick some audio. Then use your browser's
**Install app** or **Add to Home screen**.

## What it does

- **Plays audio from the device**, plus links and YouTube addresses you save.
- **Draws an equalizer and effects** from the player's own audio.
- **Lock-screen controls**, and it works offline.
- **Tap the visuals for full screen.** Tap again to come back.

Every control has a tooltip, and Settings has a **How it works** list.

## Three things worth knowing

**It asks for your music every cold start.** A browser cannot hold on to a folder on a phone. The
alternative is copying your whole library into browser storage, which doubles the space and can
be wiped without warning.

**YouTube is the exception to everything.** It plays in YouTube's own player, so it needs a
connection and gets no equalizer or effects — that audio belongs to another origin and cannot be
read from here. A pasted video or playlist address costs no API key and no quota.

**Storm and lightning flash.** If flashing bothers you, or you are photosensitive, leave those
two effects alone. They are never chosen for you. Pick one and three limits apply that no setting
can raise: the flash never exceeds 0.12 opacity, strikes never land inside 0.8 seconds of each
other, and at most six bolts are alive at once.

## Privacy

Your music never leaves the device. It is not uploaded, copied, or cached by the app. The content
security policy in `index.html` allows exactly one outside host, YouTube's player, and blocks
everything else.

## Tests

    node tests/ambient-smoke.js     the effect picker, and whether a flashing mode strikes
    node tests/resume-smoke.js      a play blocked by the phone, then resumed by a tap
    node tests/visuals-smoke.js     what is on the stage, and the tap that fills the screen
    node tests/youtube-smoke.js     reading an address, and driving someone else's player

All four run under plain Node against `tests/dom-stub.js`, and each one mutates the code under
test and requires its own assertion to fail. The stub explains why these are not browser tests.

## Built from

The equalizer and effects renderers come from [Hive Visuals](https://github.com/cobrahjh), where
they drive a live streaming overlay. They are copied rather than shared: both are pure, and this
app stands alone.

## Licence

Not yet chosen — ask the repository owner before redistributing.
