# Using it

One screen: a header, the stage where everything is drawn, and — unless you hide it — the player
with its queue.

## Three ways to feed it

**The microphone** is the interesting one. Play music out loud from anything — this phone, a
speaker, a laptop, the radio — press **Listen**, and the visuals follow it. It is the only source
that can see audio this app does not own, which is also the answer for YouTube: play it out loud
and press Listen. Nothing heard is recorded or sent anywhere.

Three capture settings are pinned off, because all three defaults are tuned for a phone call and
every one is wrong for music: automatic gain rides the level and flattens exactly the dynamics
the visuals exist to show, noise suppression is trained on speech and treats sustained music as
noise, and echo cancellation subtracts what the speakers are playing — which, when a phone is
listening to a speaker, is the whole signal.

**Music on the phone** — the folder button. See **[Your music folder](Your-music-folder)**.

**Saved links** to audio files, which come back every visit. A link whose host will not send the
right header plays fine and reads as silence, so the stage sits dead with no error anywhere;
that is the host's decision and nothing here can change it.

## Your finger

- **Tap the visuals** for full screen. Tap again to come back.
- **Drag or press** and they paint — bursts follow your finger in the current effect and colours.
  This works with no music at all, which makes it the one thing here that needs nothing but a
  finger.
- **Two fingers** send a pair of lights off wandering, each trailing a long fading tail and
  throwing a different effect wherever it goes. They keep going until you press two fingers
  again, which calls them back.

**Effects → Your finger** picks what a drag draws: lightning and a burst, lightning on its own, a
burst on its own, **ripples**, ripples and a burst, or nothing. Ripples are rings that leave your
finger and widen, three at a time, the way a drop does on water.

**Effects → Your finger throws** picks *which* burst it throws, separately from the music.
Hearts under your finger while fireworks go off on the beat. Leave it on *The same as the beat*
and it does what it always did.

Any of those turns the effects on if they were off, because a finger on the stage is a request to
draw something. A plain tap does not — that is still full screen and nothing else.

## The menu

Eight groups — Music, Look, Equalizer, Effects, Screen, Advanced, Help, About — and a closed
group **says its current value**, so you can tell whether to open one without opening it. It
comes down from the three-bar button that opened it, and **Done** stays at the bottom of the
panel where your thumb already is rather than at the end of a scroll.

## What you can set

A **Look** — Hive, Bonfire, Deep freeze, Night drive, Garden, Ink, Storm — sets the burst effect,
the colours, the equalizer style, the background and the sensitivity in one tap. **Surprise me**,
the dice in the header, rolls all five. It pulses gently until you have pressed it once, because
it changes more of the picture in one tap than anything else here and otherwise looks like every
other icon in the row.

Underneath: seven equalizer styles, six burst effects plus lightning and fairy, five palettes,
fourteen backgrounds, three sensitivities, four burst sizes, performance mode, which parts of the
sound throw a burst, what a finger does, and how much of the player is on screen.

**Equalizer → Height** is how much of the screen the bars are allowed to use — 20% to 100%, and
**half by default**. The bars stand on the floor of the stage and only the ceiling moves. The
bursts, the lightning and the background are untouched by it; they always have the whole stage.

**Advanced** holds the renderers' own knobs — twenty for the equalizer, six for the effects:
bands, gain, gap, caps, mirror, segments, thickness, glow, radius, attack, release and a whole
motion system. Nothing there is part of a Look, in both directions: a Look will not undo what you
change there, and changing it will not drop the Look picker to Custom. Anything you move is
marked, and **Reset the equalizer** / **Reset the effects** put those back on their own.

**Storm and lightning flash the screen.** If flashing bothers you, or you are photosensitive,
leave those alone — they are never chosen for you by Random or Surprise me. Pick one and three
limits apply that no setting can raise: the flash never exceeds 0.12 opacity, strikes never land
inside 0.8 seconds of each other, and at most six bolts are alive at once. All of it is dropped
entirely when the phone asks apps to reduce motion.

## Help, and how the app explains itself

- **Show me around** replays the seven-step tour. It runs once by itself the first time you open
  the app, and after that only when the tour itself is rewritten — not on every release.
- **Feature reminders** put one line on the stage now and then, naming one thing the app can do.
  One a day at most, never the same one twice, never during the tour, gone after eleven seconds,
  and they never swallow a tap — a reminder sitting over the visuals cannot eat the drag it is
  describing. The pool of eleven empties in a fortnight and is then silent for good. Turn them
  off in **Help → Feature reminders**; the only thing that stops being visible is the sentences,
  since everything they name is in **How it works**.
- **How it works** is the long version, kept in the menu rather than written on the stage.

## Start over

**Help → Start over → Reset all settings**, which takes two presses. It puts every setting back
to how it arrived, and that is all it does. It does **not** touch your saved links, your music
folder, the track names it remembered, or a problem report you were part way through writing. The
reminder switch comes back on, but reminders you have already seen stay seen — being walked
through all eleven again is not what "put my settings back" should mean.

## Performance

**Automatic** is the default and it measures rather than guesses. Core count and memory pick only
the starting tier; after that the app watches its own frame times and steps down when it is
stuttering, up only after several good windows. An automatic downgrade is never silent — the menu
carries a live line naming the running tier and the frame rate that decided it.

## When something is wrong

**Settings → Report a problem.** Write what happened and the app assembles everything it can see
about itself. **Nothing is sent from the app** — it hands the text to your mail app, and you press
send there. It carries settings, counters and screen dimensions; never your track names, your
saved addresses, or what is playing.
