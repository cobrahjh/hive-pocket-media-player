# Play store listing copy

Within Google's 2026 limits: app name 30 characters, short description 80, full description 4000.
The full description is indexed by Play, so it is written as prose rather than a keyword list.

## App name (30 max)

    Hive Pocket Music Visualizer

28 characters.

## Short description (80 max)

    Turns anything you can hear into light. Your music, or the whole room.

69 characters.

## Full description

    Hive Pocket turns sound into light on your phone.

    Point it at music on your device and it plays, drawing a live equalizer and effects from
    that audio. Or turn on the microphone and it draws whatever it can hear in the room — a
    speaker, a laptop, a record player, a band in the next room. That is the part most
    visualizers cannot do: it does not need to own the music to see it.

    Touch the screen and it answers. Drag a finger and it paints in whatever effect and colours
    are set. Press two fingers and a pair of wisps drift off across the stage, trailing long
    fading tails and throwing bursts wherever they go, until you press two fingers again. Tap
    once for full screen.

    Seven equalizer styles. Eight burst effects including lightning that strikes on the beat.
    Fourteen backgrounds. A Look picker that sets all of it in one tap, and a Surprise me button
    for when you cannot decide.

    It runs entirely on your phone. No account. No sign-up. No server. After it loads it makes
    no network request at all, works with the aeroplane mode on, and your music never leaves
    the device — it is not uploaded, copied or cached anywhere.

    Performance adjusts itself. The app measures its own frame rate and steps the detail up or
    down to suit the phone it is on, rather than asking you to guess, and it tells you what it
    settled on.

    A note on flashing: the storm background and the lightning effect flash the screen. They are
    never chosen for you, the flash is capped well below the usual threshold, and everything is
    dropped entirely when your phone asks apps to reduce motion.

    Free, open source, and licensed under Apache 2.0.

Roughly 1,500 characters, well inside the limit, with room to add later.

## Assets — all in `play/assets/`

- **App icon** 512 × 512: `icon-512.png` at the repo root.
- **Feature graphic** 1024 × 500: `feature-graphic-1024x500.png`. The background is a real frame
  of the stage with music playing, taken at banner aspect and mirrored so the busy bars sit under
  the right half and the wordmark over the quiet half. Everything that must survive cropping sits
  inside a 10% safe area. 24-bit RGB, no alpha, as Play requires.
- **Phone screenshots**, six, 1080 × 1920 — the classic phone size and unambiguously inside Play's
  rule that the long side may be no more than twice the short side. 24-bit RGB. Every one is the
  real app drawing real audio through the microphone or from a loaded file; nothing is a mockup.

      screenshot-01-hive-player.png        playing a track, pause showing, queue populated
      screenshot-02-fullscreen-freeze.png  Deep freeze, full screen, line equalizer and a nova
      screenshot-03-wisps-garden.png       two wisps mid-drift with their tails, hearts, dots eq
      screenshot-04-paint-bonfire.png      Bonfire, a finger painting, wisps still roaming
      screenshot-05-settings-drive.png     the Look picker and settings
      screenshot-06-advanced.png           the Advanced group

  Upload them in that order: the first is what people see on the search card, and it is the
  stage rather than a menu.

**How they were made**, so they can be remade after a visual change: a headless Chromium at
360 × 640 with a device scale of 3, a generated 40-second track fed through Chrome's fake
microphone (`--use-file-for-fake-audio-capture`), and the app's own Look picker driven between
shots. The tutorial is skipped and the queue for shot 1 is six real WAV files picked through the
file input, so no row reads *tap to unlock* — a locked queue in a store screenshot reads as a
paywall.

## The honest bit

Every claim above is one the app can actually keep, and the flashing paragraph is in the listing
rather than buried in the app, because someone photosensitive should find out before installing.
