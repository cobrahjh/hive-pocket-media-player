# Privacy

**Your music never leaves the device.** It is not uploaded, copied, or cached by the app.

**The app makes no network request after it loads.** Not analytics, not fonts, not an update
check. The content security policy in `index.html` allows no outside host at all: `connect-src` is
`'self'`, `frame-src` is `'none'`, and `script-src` is `'self'`.

**The microphone is never recorded and never reaches the speakers.** Its audio goes into an
analyser with nothing connected downstream of it — deliberately, and structurally: a microphone
routed to the speakers on a phone, with the speaker centimetres from the mic, is a feedback howl.
There are exactly three `connect()` calls in `pocket.js`, and the microphone's analyser is the
target of one and the source of none.

**Track names live in your browser's own storage**, so the queue can come back without asking for
the folder first. Names only. They never leave the device either, and **Forget the folder** in
Settings removes them.

**A problem report is written by you and sent by you.** The app fills in what it can see about
itself and hands the text to your mail app; you press send there. It carries settings, counters,
screen dimensions and the browser's user-agent string. It does **not** carry the names of your
music, your saved link addresses, or what is playing — only counts. All of it is shown in full in
the sheet before anything can be sent, because a diagnostic block nobody dares read is worse than
none.

**YouTube was removed in 1.18.0**, and it was the last thing here that touched the network.
