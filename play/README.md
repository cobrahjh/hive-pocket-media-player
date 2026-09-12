# Putting Hive Pocket on Google Play

A Trusted Web Activity is Google's own supported route for a PWA — it runs the real Chrome engine
with no browser UI, pointed at pocket.kinghive.online. The app is not rebuilt or forked: the APK
is a shell, and every release you push to Pages reaches it without going through review again.

## Read this before spending the $25

**A personal developer account created after 13 November 2023 cannot ship to production until it
has run a closed test with at least 12 testers opted in CONTINUOUSLY for 14 days.** Testers who
opt in, test for a few days and opt out do not count. This is Google's own rule, and it is the
single biggest obstacle between here and a listing — it needs twelve real people with Google
accounts, for a fortnight, before anyone else can install it.

An **organization** account (registered with a D-U-N-S number) is exempt, but needs a registered
legal entity and business verification, and realistically takes weeks.

So the order is: decide which account type, then everything below.

## What only Harold can do

Creating the developer account, paying the $25, and holding the signing key. Do not hand any of
those to anyone, including an assistant.

**Use Play App Signing.** Google holds the release key and you keep an upload key. If the upload
key is lost it can be reset; a lost release key with no Play App Signing means the listing can
never be updated again by anyone.

## Steps

1. **Create the account** at https://play.google.com/console — $25, one-time. Pick personal or
   organization with the 12-tester rule above in mind.

2. **Generate the package** on a machine with Node and a JDK:

   ```
   npm i -g @bubblewrap/cli
   bubblewrap init --manifest https://pocket.kinghive.online/manifest.json
   bubblewrap build
   ```

   Answer `online.kinghive.pocket` for the package id unless you want another. Bubblewrap asks
   for a keystore password: choose it yourself and put it in your password manager.

3. **Upload to a closed test track**, opt in your twelve testers, and wait out the fourteen days.

4. **Digital Asset Links.** After the first upload, Play Console shows the app's SHA-256
   certificate fingerprint under *Setup → App integrity*. Copy `assetlinks.json.template` to
   `.well-known/assetlinks.json` in this repo, paste the fingerprint in, and push. Without it the
   TWA opens with a browser address bar across the top, which is the one visible way a TWA can
   look broken.

   The template is not shipped with a placeholder fingerprint on purpose: a live assetlinks.json
   that is wrong is worse than one that is absent, and a placeholder is exactly the thing that
   gets forgotten.

5. **Store listing** — copy in `listing.md`, already inside the character limits.

6. **App content declarations.** Privacy policy URL is
   https://pocket.kinghive.online/privacy.html. The Data safety form is unusually easy here: no
   data collected, no data shared, no data transmitted off the device. Content rating
   questionnaire, target API level, and ads declaration (there are none) all have to be answered
   before production.

## What Play will check, and where this app stands

| Requirement | State |
|---|---|
| Lighthouse performance 80+ | First contentful paint 104ms, load 136ms, 380KB uncompressed and gzipped by Pages. Comfortable. |
| Service worker with a fetch handler | Yes, `sw.js`. |
| Digital Asset Links verified | Step 4 above; needs the fingerprint first. |
| Manifest: name, short_name, icons 192/512 + maskable, standalone, start_url | All present. |
| HTTPS, enforced | Yes, since the custom domain went on. |
| Privacy policy at a public URL | `privacy.html`. |
| Offline behaviour without 4xx/5xx | Google treats offline failures as crashes. The worker is network-first for code with a cache fallback. |

## The thing to remember about updates

The APK points at the live site, so **shipping a release is still `git push`** — the store copy
does not need re-review for app changes. Only the shell itself (name, icon, package) needs a new
upload. That is the whole reason to use a TWA rather than porting the app.
