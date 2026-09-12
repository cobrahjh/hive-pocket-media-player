# Install it

Open **https://pocket.kinghive.online** on the phone.

## Put it on the home screen

Use the **browser's own menu** — the three dots in Chrome, the share button in Safari — and
choose **Install app** or **Add to Home screen**.

Settings also grows an **Add to home screen** button, but only once Chrome has decided the site
qualifies, which can take a visit or two. When that button is not there, Settings shows the manual
instructions instead. iOS never offers the button at all; the share menu is the route there.

## What installing actually buys you

The browser bars go away, which leaves more room for the visuals. That is the whole of it.

It does **not** stop the app asking for your music folder after a cold start. Chrome documents
that an installed app keeps file permission without asking again; measured on a real Android
phone — installed, storage persisted, Chrome 152 — it asks anyway. See
**[Your music folder](Your-music-folder)**.

## If you installed from the old address

The app used to live at `cobrahjh.github.io/hive-pocket-media-player`. That address now redirects
here, but **an install from it has to be replaced**:

1. Install again from **https://pocket.kinghive.online**.
2. Pick your music folder once.
3. Long-press the old icon and delete it.

A browser keeps storage per origin, so the old install's remembered folder, saved track names and
settings stay behind on the old address and do not travel. Tapping the old icon now lands outside
that install's own scope, so it opens a browser tab rather than the app.

## It works offline

Once loaded, the app needs no network for anything. The service worker keeps the code, and the
music was always on your phone.
