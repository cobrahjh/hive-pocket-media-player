# Your music folder

## What the app remembers, and what it cannot

The **folder is remembered.** Your track names come back the instant you open the app, as a queue
marked *tap to unlock*. Names only — never a path, never the audio.

The **permission is not.** Android will not carry a file grant across a cold start, whatever
Chrome's documentation says about installed apps. That is settled: measured on a real phone,
installed, with storage persisted, on Chrome 152 — the browser reported the permission as
`prompt` on every load.

So one tap after a cold start is the floor, not a bug being chased.

## Where that tap happens

**Wherever you touch first.** The app arms itself on load, and the first thing you touch —
whatever it was for — asks for the folder back, and the music returns. There is no button to
find. Pressing any track in the locked queue does it too, which is the same tap you were already
making.

If Chrome offers **Allow on every visit**, taking it may stop the asking. Some phones ask every
time regardless; that is the browser's decision and nothing in this app can override it.

## What Android's prompt says, and what it means

Android's wording is *"allow this site to view and copy files"*, which sounds like an upload. It
is not. It is the operating system's phrasing for opening a folder. Nothing is copied anywhere,
and this app has no way to send anything — it makes no network request at all after it loads. The
app says so on screen before the prompt appears, because meeting that sentence cold when all you
did was press play is a fair thing to be alarmed by.

## If it says the folder was denied

Tap any track to ask again, or use the folder button in Settings. Choosing the folder again is the
last resort, not the first move.

Before 1.50.0 the app could report a denial you never made: it asked on the first `pointerdown`,
and a touch `pointerdown` carries no user activation, so Chrome answered "denied" without showing
anything. It now asks only on an event that carries a gesture, and checks with the browser first.

## Limits

500 tracks, three folders deep. A music folder is exactly the kind of thing that turns out to have
a backup of itself inside it. Past those limits the rest is not loaded, and the app says how many
it took rather than pretending that was all of them.

A file that fails is skipped — bounded at five failures in a row, so a folder of broken files
stops rather than racing to the end. A track that ends in under half a second counts as a failure
too, because a zero-byte file "plays" and ends instantly rather than raising an error. The cost:
five real sub-half-second tracks in a row will also stop the queue, with a sentence saying so.
