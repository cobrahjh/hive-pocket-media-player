/* Copyright 2026 Harold J. Harding
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/* pocket.js — Hive Pocket Media Player, v1.
 *
 * Everything here runs on the device. There is no fetch to any service, no socket, no account.
 * The only inputs are files the person picked and the audio they produce.
 *
 * THE SHAPE OF IT
 *   <audio> element  ->  MediaElementSource  ->  AnalyserNode  ->  destination
 *                                                    |
 *                              getByteFrequencyData -+-> band buckets -> eq.push() / fx.pushBands()
 *
 * The analyser MUST also be wired through to destination. createMediaElementSource takes the
 * element's output exclusively: connect it to an analyser and forget the destination, and
 * playback goes silent with no error at all.
 */
(() => {
  'use strict';

  // THE version. It is shown on screen and it names the service worker's cache, so a build
  // and the files it cached can never disagree about which build they are. Bump this ONE
  // line for a release; sw.js reads the same string.
  const VERSION = '1.56.0-beta';

  const $ = (id) => document.getElementById(id);
  // A control's tooltip and the text a screen reader announces are the same sentence, set in
  // the same call. Two places to write it is two places for them to drift apart.
  function label(id, text) {
    $(id).setAttribute('aria-label', text);
    $(id).setAttribute('title', text);
  }
  const fmt = (s) => {
    if (!isFinite(s) || s < 0) s = 0;
    const m = Math.floor(s / 60);
    const r = Math.floor(s % 60);
    return m + ':' + (r < 10 ? '0' : '') + r;
  };

  // ── Saved links ──────────────────────────────────────────────────────────────────────
  // The ONLY thing this app can remember between sessions. A picked file cannot be kept — the
  // browser hands over the bytes and nothing durable — but a link is a string, so it survives.
  const LINKS_KEY = 'hive-pocket.links';

  function readLinks() {
    try {
      const raw = JSON.parse(localStorage.getItem(LINKS_KEY) || '[]');
      if (!Array.isArray(raw)) return [];
      // Rebuilt from an allowlist rather than trusted: this comes back from storage a person or
      // another script could have edited, and a bad `url` here becomes a <audio src>.
      return raw
        .map((x) => (x && typeof x === 'object' ? { name: String(x.name || '').slice(0, 200), url: String(x.url || '') } : null))
        .filter((x) => x && safeUrl(x.url));
    } catch (e) { return []; }
  }
  function writeLinks(list) {
    try { localStorage.setItem(LINKS_KEY, JSON.stringify(list.slice(0, 200))); } catch (e) { /* private mode, full disk */ }
  }
  // https only, and only ever handed to a media element. Rejecting everything else keeps
  // javascript:, data: and file: out of an attribute that would honour them.
  function safeUrl(u) {
    try {
      // NO BASE. With one, 'not a link' resolves to a path on this origin and sails through as
      // http — which is how a typed sentence became a saved track. An absolute URL or nothing.
      const p = new URL(u);
      if (p.protocol !== 'https:' && p.protocol !== 'http:') return false;
      if (!p.hostname) return false;
      // An http link on an https page is refused by the browser as mixed content, and the
      // content policy in index.html refuses it too. Both are silent. Rule it out HERE so the
      // person is told when they paste it, not left with a track that never starts.
      if (location.protocol === 'https:' && p.protocol === 'http:') return false;
      return true;
    } catch (e) { return false; }
  }
  // Why a link was rejected, in the words of the thing that rejected it.
  function whyBad(u) {
    try {
      const p = new URL(u);
      if (location.protocol === 'https:' && p.protocol === 'http:') {
        return 'That link is http. This app is served over https, and browsers refuse to play '
             + 'insecure media on a secure page. Try the https:// version of it.';
      }
      return 'That is not a web link. It needs to start with https://';
    } catch (e) { return 'That is not a web link. It needs to start with https://'; }
  }
  // YOUTUBE WAS REMOVED IN 1.18.0, at Harold's word. It was the only thing here that reached
  // the network, the only thing that needed a connection, and the only thing the equalizer and
  // the effects could not see — an iframe from another origin whose audio Web Audio is not
  // allowed to read, so a YouTube track played to a dead stage. An app that is now a visualizer
  // first has no use for a source it cannot visualise. What went with it: the player, the
  // playlist handling that made Next mean "next video", the progress poll, the id parser, and
  // the network permissions in the page's content policy. Direct links to audio FILES are
  // untouched and still work — that path was never YouTube's.
  //
  // A saved YouTube link is not deleted, and not silently dropped either: it stays in the queue
  // and says what happened when you press it. Deleting someone's saved links to tidy up after a
  // decision they did not make is worse than an honest row that explains itself.
  const YT_HOSTS = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com',
                    'youtu.be', 'www.youtube-nocookie.com', 'youtube-nocookie.com'];
  // The ONLY thing left that knows what a YouTube address looks like, and it is a refusal, not a
  // parser: no id is extracted, nothing is fetched, and nothing reaches a frame.
  function isDeadLink(u) {
    try { return YT_HOSTS.includes(new URL(u).hostname); } catch (e) { return false; }
  }

  function linkRow(l) {
    return { name: l.name, url: l.url, link: true, dead: isDeadLink(l.url) };
  }

  function nameFromUrl(u) {
    if (isDeadLink(u)) return 'YouTube link (no longer plays here)';
    try {
      const last = decodeURIComponent(new URL(u).pathname.split('/').filter(Boolean).pop() || '');
      return (last.replace(/\.[^.]+$/, '') || new URL(u).hostname).slice(0, 200);
    } catch (e) { return u.slice(0, 60); }
  }

  // ── State ────────────────────────────────────────────────────────────────────────────
  let queue = [];          // { name, url, file?, link? }
  let current = -1;
  let audio = null;
  // What is on the stage. ONE stored value, not two booleans and not a second copy behind the
  // transport's effects button — that button writes here too, so the menu and the button can
  // never disagree about what you are looking at.
  const VISUALS_KEY = 'hive-pocket.visuals';
  const VISUALS = ['both', 'fx', 'eq'];
  let visuals = 'both';
  const fxShown = () => visuals !== 'eq';
  const eqShown = () => visuals !== 'fx';
  let shuffleOn = false;
  let repeatMode = 'off';        // 'off' | 'all' | 'one'
  // A shuffled ORDER, not a random pick each time: every track once before any repeats, which is
  // what people mean by shuffle. Rebuilt when the queue changes or shuffle is switched on.
  let order = null, orderPos = -1;

  function readVisuals() {
    try { const v = localStorage.getItem(VISUALS_KEY); return VISUALS.includes(v) ? v : 'both'; }
    catch (e) { return 'both'; }
  }

  const MODES_KEY = 'hive-pocket.modes';
  const AMBIENT_KEY = 'hive-pocket.ambient';
  // All thirteen the renderer knows. Storm and lightning flash, so they are last in the list,
  // labelled as flashing, and never a default — but they ARE offered, which is the renderer's
  // own policy: it keeps them out of the random roll because nobody chose them there, and
  // allows them "when chosen by name". Its safety caps are hard constants no setting reaches:
  // the whole-frame flash is capped at 0.12 alpha, strikes cannot land inside 800ms of each
  // other, and at most six bolts live at once.
  const AMBIENTS = ['off', 'stars', 'snow', 'rain', 'fireflies', 'bubbles', 'leaves', 'petals',
                    'sparks', 'meteors', 'clouds', 'fog', 'storm', 'lightning'];
  function readAmbient() {
    try { const v = localStorage.getItem(AMBIENT_KEY); return AMBIENTS.includes(v) ? v : 'stars'; }
    catch (e) { return 'stars'; }
  }
  function writeAmbient(v) { try { localStorage.setItem(AMBIENT_KEY, v); } catch (e) {} }

  // What a beat spawns. The renderer has had all six of these since long before this app
  // existed; Pocket simply never asked for any of them and took the default, so the only thing
  // anyone could change here was the weather. 'random' rolls a different one each burst.
  const BEAT_KEY = 'hive-pocket.beat';
  // 'lightning' is Pocket's, not the renderer's: fire() knows six effects and lightning is not
  // one of them, so choosing it switches the renderer's own beat detector OFF and Pocket drives
  // all three ranges itself with strikes. Everything else here is handed straight to fire().
  const BEAT_EFFECTS = ['fireworks', 'confetti', 'embers', 'hearts', 'fountain', 'nova',
                        'lightning', 'fairy', 'random'];
  // What 'random' and Surprise me are allowed to land on. Lightning is out of both for the same
  // reason storm and lightning are out of the ambient roll: it flashes the screen, and the rule
  // in this codebase is that flashing happens when someone picks it by name and never when dice
  // pick it for them. Nobody consented to a strobe by pressing a button labelled Surprise me.
  // Fairy stays IN the roll where lightning stays out: lightning flashes the whole screen and
  // that is the thing nobody consents to by pressing a dice button. A fairy is a moving point of
  // light the size of a fingertip, and the bursts it throws are the same six anyone can already
  // roll — nothing about it is a strobe.
  const ROLLABLE_EFFECTS = BEAT_EFFECTS.filter((e) => e !== 'random' && e !== 'lightning');
  function readBeatEffect() {
    try { const v = localStorage.getItem(BEAT_KEY); return BEAT_EFFECTS.includes(v) ? v : 'fireworks'; }
    catch (e) { return 'fireworks'; }
  }
  function writeBeatEffect(v) { try { localStorage.setItem(BEAT_KEY, v); } catch (e) {} }

  // How much a moment has to beat the running average to count as a hit. The renderer defaults
  // to 1.35, which is right for a clean file and wrong for a room: measured on Harold's phone
  // with music playing out loud, the bass was four times over the loudness floor (0.57 against
  // 0.12) and the biggest rise still only reached 1.1. Reverb smears the transients a file
  // delivers intact, so the average sits close under every peak and 1.35 is never cleared.
  // Hence a setting, and a default suited to a microphone rather than to a file.
  //
  // WHAT GOES AWAY AS THIS GETS EASIER: a burst stops meaning "a distinct beat". At 'easy' a
  // sustained loud passage can keep it firing, because 6% over the average is a low bar. The
  // rate is still bounded — the 0.12 floor rejects a quiet room outright, and the renderer's
  // own tempo sync allows one burst every two detected beats — but the bursts stop being
  // evidence that anything was actually hit.
  const SENS_KEY = 'hive-pocket.sens';
  const SENS = { easy: 1.06, room: 1.15, strict: 1.35 };
  function readSens() {
    try { const v = localStorage.getItem(SENS_KEY); return SENS[v] ? v : 'easy'; }
    catch (e) { return 'easy'; }
  }
  function writeSens(v) { try { localStorage.setItem(SENS_KEY, v); } catch (e) {} }

  // Colour. The renderer has carried five palettes the whole time and this app never asked for
  // one, so every build until now was orange. 'auto' on the ambient layer means it follows the
  // main palette, so one choice colours both the weather and the bursts.
  const PAL_KEY = 'hive-pocket.palette';
  const PALETTES = ['hive', 'fire', 'ice', 'vapor', 'mono', 'random'];
  function readPalette() {
    try { const v = localStorage.getItem(PAL_KEY); return PALETTES.includes(v) ? v : 'hive'; }
    catch (e) { return 'hive'; }
  }
  function writePalette(v) { try { localStorage.setItem(PAL_KEY, v); } catch (e) {} }

  // The equalizer's own styles. It has carried seven since long before this app, and Pocket
  // never called its setConfig at all — so every build until now drew bars, in orange, whatever
  // the effects were doing. Same shape of miss as the palettes and the beat effects.
  const EQ_KEY = 'hive-pocket.eqstyle';
  const EQ_SHAPES = ['bars', 'led', 'blocks', 'wave', 'line', 'dots', 'radial'];
  const EQ_STYLES = EQ_SHAPES.concat('random');
  function readEqStyle() {
    try { const v = localStorage.getItem(EQ_KEY); return EQ_STYLES.includes(v) ? v : 'bars'; }
    catch (e) { return 'bars'; }
  }
  function writeEqStyle(v) { try { localStorage.setItem(EQ_KEY, v); } catch (e) {} }

  const CONCRETE = ['hive', 'fire', 'ice', 'vapor', 'mono'];
  const pick = (list) => list[Math.floor(Math.random() * list.length)];

  // The equalizer cannot roll the way the effects do. An effect rolls per burst, which is a new
  // thing every second or so; a style that rolled per frame would be a strobe of seven layouts
  // and unreadable. So random means "pick one for me", rolled once when something is applied and
  // then REMEMBERED here — a resolver that rolled on every call would mean simply reading what
  // the equalizer is currently drawing changed it, which is not a thing a read should do.
  let eqShapeNow = null, eqPaletteNow = null;
  function rollEq() {
    const st = readEqStyle(), pl = readPalette();
    eqShapeNow = st === 'random' ? pick(EQ_SHAPES) : st;
    // The equalizer does not know 'random' and quietly falls back to orange when handed a name it
    // does not recognise, so it is resolved to a real one here rather than left to fail silently.
    eqPaletteNow = pl === 'random' ? pick(CONCRETE) : pl;
  }

  // Roll everything. Deliberately NOT a look: a look is a state you can come back to, and this is
  // an action whose result is whatever it landed on, so the picker reports Custom (or a real look,
  // if the dice happen to agree) rather than sitting on a name that describes nothing.
  //
  // Storm and lightning are excluded on purpose. They flash the screen, and the renderer's own
  // policy is that flashing is allowed when chosen by name and never when rolled — nobody
  // consented to it by pressing a button labelled Surprise me. Same reasoning, one layer up.
  const SAFE_AMBIENTS = AMBIENTS.filter((a) => a !== 'storm' && a !== 'lightning');
  function surprise() {
    writeEqStyle(pick(EQ_SHAPES));
    writeBeatEffect(pick(ROLLABLE_EFFECTS));
    writePalette(pick(CONCRETE));
    writeAmbient(pick(SAFE_AMBIENTS));
    writeSens(pick(Object.keys(SENS)));
    applyRenderers();
    paintSheet();
  }

  // Looks. Four dropdowns is where good combinations go to die: the pleasure here is in
  // pairings, and nobody finds a pairing by working through a settings list. Each of these sets
  // all four at once. The dropdowns stay underneath for anyone who wants them, and the moment
  // one of them is moved the picker says Custom rather than keeping a name that is no longer true.
  const LOOKS = {
    // Deliberately the app's shipped defaults, so a fresh install reads as Hive rather than
    // as Custom — "you have not chosen anything" is a poor first thing to say.
    hive:    { eq: 'bars', effect: 'fireworks', palette: 'hive',  ambient: 'stars',    sens: 'easy' },
    bonfire: { eq: 'blocks', effect: 'embers',    palette: 'fire',  ambient: 'sparks',   sens: 'easy' },
    freeze:  { eq: 'line', effect: 'nova',      palette: 'ice',   ambient: 'snow',     sens: 'easy' },
    drive:   { eq: 'wave', effect: 'confetti',  palette: 'vapor', ambient: 'meteors',  sens: 'easy' },
    garden:  { eq: 'dots', effect: 'hearts',    palette: 'vapor', ambient: 'petals',   sens: 'easy' },
    ink:     { eq: 'led', effect: 'fountain',  palette: 'mono',  ambient: 'fog',      sens: 'room' },
    storm:   { eq: 'radial', effect: 'fireworks', palette: 'ice',   ambient: 'storm',    sens: 'room' },
  };

  function currentLook() {
    const now = { eq: readEqStyle(), effect: readBeatEffect(), palette: readPalette(), ambient: readAmbient(), sens: readSens() };
    for (const [name, l] of Object.entries(LOOKS)) {
      if (l.eq === now.eq && l.effect === now.effect && l.palette === now.palette
          && l.ambient === now.ambient && l.sens === now.sens) return name;
    }
    return 'custom';
  }

  function applyLook(name) {
    const l = LOOKS[name];
    if (!l) return;                       // 'custom' is a readout, never a thing to apply
    writeEqStyle(l.eq); writeBeatEffect(l.effect); writePalette(l.palette);
    writeAmbient(l.ambient); writeSens(l.sens);
    applyRenderers();
    paintSheet();
  }

  // How hard it works. Every number here is a lever the renderers already had: the effects take
  // a budget for burst particles and a separate one for the weather, and the equalizer takes a
  // frame cap per surface — its own comment says "the phone wanting 30 is the normal case".
  //
  // WHAT STOPS BEING VISIBLE AS THIS COMES DOWN, since it is a threshold and thresholds hide
  // things: bursts throw fewer pieces and the background carries fewer, so both thin out rather
  // than disappear; and at Saver the equalizer redraws at 24 a second, which is visibly less
  // fluid on a fast track. Nothing is removed and no effect becomes unavailable.
  //
  // The saving is NOT measured. Full was measured at about 12% of a battery an hour on Harold's
  // phone, screen and all; what these save against that is unknown until someone runs them.
  const QUAL_KEY = 'hive-pocket.quality';
  const QUALITY = {
    full:     { fps: 60, parts: 1200, amb: 400 },
    balanced: { fps: 40, parts: 700,  amb: 250 },
    saver:    { fps: 24, parts: 300,  amb: 120 },
  };
  // ── Automatic performance ────────────────────────────────────────────────────────────
  // The three fixed settings assume the person knows which one their phone deserves, and nobody
  // does — least of all before they have watched it stutter. A cheap Android and a flagship run
  // the same code here, and the flagship is not the one that needs help.
  //
  // So Auto, and it is a real measurement rather than a guess dressed up as one. The device
  // signals only pick a STARTING tier; after that the app watches its own frame times and moves.
  //
  // WHAT STOPS BEING VISIBLE, because this is exactly the kind of change that has to say so:
  // when Auto steps down, bursts throw fewer pieces and the background carries fewer, and at
  // Saver the equalizer redraws 24 times a second instead of 60. Nothing is removed and no
  // effect becomes unavailable. And it is never silent — the menu says which tier is running
  // right now and the frame rate it measured, so "Auto" can never mean "Full, probably".
  const TIERS = ['saver', 'balanced', 'full'];

  // A judgement every ~90 frames, about a second and a half.
  const AUTO_WINDOW = 90;
  const BAD_MS = 24;     // median frame worse than this is under ~42 a second: step down
  const GOOD_MS = 19;    // better than this is over ~53 a second: a candidate for stepping up
  const DOWN_HOLD_MS = 2000;    // down quickly — the person is watching it stutter NOW
  const UP_HOLD_MS = 10000;     // up slowly, and only after four good windows running
  const UP_STREAK = 4;

  let autoTier = null, autoFps = 0, autoFrames = [], autoLastAt = 0;
  let autoChangedAt = 0, autoGoodRun = 0;

  // The starting guess, from what the browser will admit about the hardware. Every one of these
  // is missing on some browser, so each has a fallback and none of them is trusted alone.
  function seedTier() {
    let cores = 0, mem = 0;
    try { cores = navigator.hardwareConcurrency || 0; } catch (e) {}
    try { mem = navigator.deviceMemory || 0; } catch (e) {}   // Chrome/Android only
    // Neither is available: start in the middle rather than assume a fast phone. Being wrong
    // downward costs some particles; being wrong upward costs a stuttering first impression.
    if (!cores && !mem) return 'balanced';
    if ((cores && cores <= 4) || (mem && mem <= 2)) return 'saver';
    if ((cores && cores <= 6) || (mem && mem <= 4)) return 'balanced';
    return 'full';
  }

  const TIER_NAME = { full: 'Full', balanced: 'Balanced', saver: 'Battery saver' };

  // The whole promise of Auto rests on this line: it says which tier is running and the frame
  // rate that decided it, so the setting can be checked rather than believed.
  function paintAuto() {
    const el = $('autoNote');
    if (!el) return;
    if (readQualitySetting() !== 'auto') {
      el.textContent = 'Fixed at ' + TIER_NAME[readQuality()] + '. Nothing adjusts it.';
      return;
    }
    const tier = TIER_NAME[readQuality()];
    el.textContent = autoFps
      ? 'Running ' + tier + ' — measured ' + autoFps + ' frames a second.'
      : 'Starting at ' + tier + '. It will measure and adjust once something is drawing.';
  }

  function autoNow() {
    if (!autoTier) autoTier = seedTier();
    return autoTier;
  }

  // Called once per pumped frame. Cheap on purpose: a push and, once a window, one sort.
  function autoSample(now) {
    if (readQualitySetting() !== 'auto') { autoLastAt = now; return; }
    if (autoLastAt) {
      const dt = now - autoLastAt;
      // A tab coming back from the background reports one enormous frame. That is not the phone
      // being slow, and treating it as a vote would drop everyone to Saver on every unlock.
      if (dt > 0 && dt < 400) autoFrames.push(dt);
    }
    autoLastAt = now;
    if (autoFrames.length < AUTO_WINDOW) return;
    const sorted = autoFrames.slice().sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    autoFrames.length = 0;
    autoFps = median > 0 ? Math.round(1000 / median) : 0;
    const at = TIERS.indexOf(autoNow());
    if (median > BAD_MS) {
      autoGoodRun = 0;
      if (at > 0 && now - autoChangedAt > DOWN_HOLD_MS) {
        autoTier = TIERS[at - 1];
        autoChangedAt = now;
        applyRenderers();
        paintAuto();
      }
      return;
    }
    if (median < GOOD_MS) {
      autoGoodRun++;
      if (autoGoodRun >= UP_STREAK && at < TIERS.length - 1 && now - autoChangedAt > UP_HOLD_MS) {
        autoTier = TIERS[at + 1];
        autoChangedAt = now;
        autoGoodRun = 0;
        applyRenderers();
        paintAuto();
      }
      return;
    }
    autoGoodRun = 0;      // in between: hold, and do not creep up on a single lucky window
  }

  // What the person CHOSE, which may be 'auto'.
  function readQualitySetting() {
    try { const v = localStorage.getItem(QUAL_KEY); return (v === 'auto' || QUALITY[v]) ? v : 'auto'; }
    catch (e) { return 'auto'; }
  }
  // What is actually RUNNING. Everything that needs caps asks this one.
  function readQuality() {
    const v = readQualitySetting();
    return v === 'auto' ? autoNow() : v;
  }
  function writeQuality(v) { try { localStorage.setItem(QUAL_KEY, v); } catch (e) {} }

  // How big a burst is. beat.intensity already scaled every burst; it was simply never offered.
  // At Huge with Performance on Battery saver the particle budget clips the result — the cap is
  // the cap, and it is doing its job rather than failing.
  const PUNCH_KEY = 'hive-pocket.punch';
  const PUNCH = { subtle: 0.8, normal: 1.2, bold: 1.8, huge: 2.6 };
  function readPunch() {
    try { const v = localStorage.getItem(PUNCH_KEY); return PUNCH[v] ? v : 'normal'; }
    catch (e) { return 'normal'; }
  }
  function writePunch(v) { try { localStorage.setItem(PUNCH_KEY, v); } catch (e) {} }

  // ── What drives the visuals ──────────────────────────────────────────────────────────
  // Until now: the lowest FOUR of sixty-four bands, and nothing else. The renderer's own beat
  // detector averages bands 0-3 and fires on those alone, which means a track can have a hi-hat
  // pattern, a vocal line and a guitar and the screen answers none of it — every burst on this
  // app has been a kick drum. Bands 4-63 were read every frame, handed to the equalizer, drawn
  // as bars, and then thrown away.
  //
  // fx-render.js is shared with the stream overlays and is not edited from here, so this does
  // not touch its detector. Pocket runs two more of its own, on ranges the bass detector never
  // looks at, and calls the renderer's public fire() when one trips. Three sources, three
  // heights on screen, so which part of the music spoke is something you can see and not just
  // infer.
  //
  // WHAT THIS ADDS RATHER THAN HIDES, and the cost: nothing is suppressed, but bursts get more
  // frequent, and on Battery saver the 300-particle budget is reached sooner — so at Full
  // spectrum plus Saver the bursts each carry fewer pieces. That is the cap working, not the
  // setting failing. Set this back to Bass only for exactly the app 1.17 was.
  const DRIVE_KEY = 'hive-pocket.drive';
  const DRIVE = {
    bass: { mid: false, high: false },
    mid:  { mid: true,  high: false },
    // Added after Harold reported mids too chatty on real music: highs are the cheap, sparkly
    // half and mids the busy one, so "everything except the busy one" has to be reachable
    // without giving up the sparkle. A tuning change alone would have made that MY judgement
    // of how much is too much, permanently, for him.
    high: { mid: false, high: true },
    full: { mid: true,  high: true },
  };
  function readDrive() {
    try { const v = localStorage.getItem(DRIVE_KEY); return DRIVE[v] ? v : 'full'; }
    catch (e) { return 'full'; }
  }
  function writeDrive(v) { try { localStorage.setItem(DRIVE_KEY, v); } catch (e) {} }

  // The two ranges, in band numbers out of 64. Mids are where a voice, a snare and a guitar
  // body live; highs are hats and cymbals. Both deliberately start above band 4 so they can
  // never re-detect the same kick the renderer is already firing on.
  const MID_LO = 10, MID_HI = 30;
  const HIGH_LO = 42, HIGH_HI = 63;
  // Floors far below the bass detector's 0.12. That number is right for band 0-3, where the
  // energy in most music is, and would reject a cymbal outright: a hi-hat that is plainly
  // audible sits around 0.05 of full scale. The RISE over the running average is what actually
  // decides a hit here — the floor only keeps a silent room from firing.
  const MID_FLOOR = 0.055, HIGH_FLOOR = 0.04;
  const MID_GAP = 420, HIGH_GAP = 150;   // ms; highs are allowed to be quicker, they are smaller
  // A RATIO ALONE IS NOT ENOUGH UP HERE, which the first build of this got wrong and a test
  // caught: mids fired 29 times in eight seconds — the minimum gap, and nothing else, was
  // limiting the rate, which means the detector was not discriminating at all. Mids and highs
  // have far less dynamic range than a kick drum, so their running average sits close under the
  // sustain and a 6% rise is cleared by nearly every frame. An ABSOLUTE rise over the average,
  // in units of full scale, plus a firmer ratio than the bass detector's, is what separates a
  // hit from a loud passage.
  //
  // TUNED AGAINST A MEASURED SIGNAL, not by eye: a generated 8-second loop of 2 kicks, 1 snare
  // and 4 hi-hats a second, played into the microphone. The first attempt was tuned against a
  // BAD signal — hard envelope cut-offs made every note a broadband click, so all three
  // detectors were correctly firing on clicks the music was not supposed to have. With smooth
  // envelopes: mids land about 2.5 a second, highs about 4.9 against 4 hats a second. Mids run
  // over because every percussive attack genuinely puts energy in the mid range; that is real,
  // not a defect, and Bass only turns it off.
  const MID_RISE = 0.030, HIGH_RISE = 0.016;
  const MID_STRICT = 1.70, HIGH_STRICT = 1.80;
  //
  // A LOUDNESS TEST IS THE WRONG TEST FOR MIDS, which is what Harold reported after 1.19 and
  // what the numbers had already been hinting: raising the strictness from 1.22 to 2.0 barely
  // moved the rate (27 fires to 20), so loudness was never the thing letting them through.
  // The reason is physical. Every percussive attack is broadband — a kick drum and a hi-hat
  // both dump energy across the mid range on their transient — so a detector that asks only
  // "are mids loud right now" answers yes on every drum hit in the track, and a burst that
  // fires on every drum hit is not a mid detector at all, it is a second bass detector.
  //
  // So mids now have to be proportionally DOMINANT, not merely loud: their share of the whole
  // frame's energy has to beat its own running average. A kick raises mids and everything else
  // together and the share barely moves; a vocal or a guitar line raises mids while the rest
  // stays put, and the share jumps. Highs keep the loudness test — a cymbal genuinely is a
  // burst of high energy and has no equivalent confusion to resolve.
  //
  // WHAT STOPS BEING VISIBLE: mids no longer answer drum hits at all, so on a track that is
  // mostly percussion the mid layer goes quiet. That is the point, but it means "nothing is
  // firing mid-screen" is now a real and correct state rather than a fault to chase.
  const MID_SHARE_STRICT = 1.22;
  let midAvg = 0, highAvg = 0, lastMidAt = 0, lastHighAt = 0;
  let midShareAvg = 0;

  // Pocket's OWN bass detector, and the only reason it exists: the renderer's detector can fire
  // six effects and lightning is not one of them, so when lightning is chosen the renderer's beat
  // is switched off and this replaces it. Deliberately the renderer's own numbers — bands 0-3,
  // the 0.12 floor, the sensitivity straight from the setting — so choosing lightning changes
  // WHAT is drawn on the beat and not WHEN.
  // The effects Pocket draws itself, which are exactly the ones the renderer's beat detector
  // cannot fire — so for these its beat is switched off and this bass detector replaces it.
  const POCKET_DRIVEN = ['lightning', 'fairy'];
  const BASS_FLOOR = 0.12, BASS_GAP = 200;
  let bassAvg = 0, lastBassAt = 0;

  // Number.isFinite and not `|| 0`, for the same reason the renderer says so in pushBands: one
  // malformed element turns the average into a NaN that never clears, and every later comparison
  // against it is false, so detection dies silently and permanently.
  function bandEnergy(bands, lo, hi) {
    let sum = 0, n = 0;
    for (let i = lo; i <= hi && i < bands.length; i++) {
      const v = bands[i];
      sum += Number.isFinite(v) ? v : 0;
      n++;
    }
    return n ? sum / (n * 255) : 0;
  }

  function driveExtras(bands) {
    if (!Array.isArray(bands) || !bands.length) return;
    if (!fx || !fxShown()) return;
    const now = performance.now();
    const sens = SENS[readSens()];
    const punch = PUNCH[readPunch()];
    const pal = readPalette();

    // The bass half, on only while lightning is the chosen burst. The average is kept either way
    // so switching to lightning mid-track does not start from zero and strike on the first frame.
    const b = bandEnergy(bands, 0, 3);
    const bWas = bassAvg;
    bassAvg = bassAvg * 0.94 + b * 0.06;
    if (POCKET_DRIVEN.includes(readBeatEffect()) && now - lastBassAt >= BASS_GAP
        && b >= BASS_FLOOR && b >= bWas * sens) {
      lastBassAt = now;
      // Where the renderer puts a beat burst: middle of the stage, a little above centre.
      fireOne(0.3 + Math.random() * 0.4, 0.42 + Math.random() * 0.22,
              PUNCH[readPunch()], readPalette());
    }

    const d = DRIVE[readDrive()];
    if (!d || (!d.mid && !d.high)) return;

    // The averages are kept whatever the setting says, so switching from Bass only to Full
    // spectrum does not start from zero and dump a burst on the first frame.
    const m = bandEnergy(bands, MID_LO, MID_HI);
    const hi = bandEnergy(bands, HIGH_LO, HIGH_HI);
    const mWas = midAvg, hWas = highAvg;
    midAvg = midAvg * 0.94 + m * 0.06;
    highAvg = highAvg * 0.94 + hi * 0.06;

    // Mids as a fraction of the whole frame. `b` is the bass energy read above, so the whole
    // span is measured once rather than twice.
    const whole = bandEnergy(bands, 0, bands.length - 1);
    const share = whole > 0 ? m / whole : 0;
    const sWas = midShareAvg;
    midShareAvg = midShareAvg * 0.94 + share * 0.06;

    if (d.mid && now - lastMidAt >= MID_GAP && m >= MID_FLOOR
        && m >= mWas * sens * MID_STRICT && m - mWas >= MID_RISE
        && share >= sWas * MID_SHARE_STRICT) {
      lastMidAt = now;
      // Mid height, and never dead centre: the bass burst lands there, and two bursts stacked on
      // the same point read as one louder burst rather than as two different instruments.
      fireOne(0.15 + Math.random() * 0.7, 0.34 + Math.random() * 0.26, punch * 0.65, pal);
    }
    if (d.high && now - lastHighAt >= HIGH_GAP && hi >= HIGH_FLOOR
        && hi >= hWas * sens * HIGH_STRICT && hi - hWas >= HIGH_RISE) {
      lastHighAt = now;
      fireOne(0.1 + Math.random() * 0.8, 0.06 + Math.random() * 0.24, punch * 0.4, pal);
    }
  }

  // One burst at a point. fire() knows the six real effects only; 'random' is a Pocket-level
  // idea and is resolved per burst here, which is what makes Random actually vary.
  const FAIRY_EFFECTS = ['fireworks', 'confetti', 'embers', 'hearts', 'fountain', 'nova'];

  function fireOne(x, y, intensity, palette) {
    if (!fx) return;
    let effect = readBeatEffect();
    if (effect === 'random') effect = pick(ROLLABLE_EFFECTS);
    // strike() keeps its own gap, so calling it from two places in the same frame — a finger and
    // a detector — costs one bolt, not two.
    if (effect === 'lightning') { strike(x, y); return; }
    if (effect === 'fairy') { spawnFairy(x, y, intensity, palette); return; }
    fx.fire(effect, { x, y, intensity, palette });
  }

  // ── What a finger does ───────────────────────────────────────────────────────────────
  // 'both' by default: the bolt strikes down to where the finger is and the burst lands where it
  // hits, which reads as cause and effect. 'off' still swallows the drag — a drag has never
  // toggled full screen and should not start now — it simply draws nothing.
  const TOUCH_KEY = 'hive-pocket.touch';
  const TOUCH_MODES = ['both', 'lightning', 'effect', 'off'];
  function readTouch() {
    try { const v = localStorage.getItem(TOUCH_KEY); return TOUCH_MODES.includes(v) ? v : 'both'; }
    catch (e) { return 'both'; }
  }
  function writeTouch(v) { try { localStorage.setItem(TOUCH_KEY, v); } catch (e) {} }

  // FOUNTAIN, retuned. Its defaults make it the weakest of the six and the numbers say why, read
  // against its siblings: spread 0.55 is the narrowest of them all (every other effect is 1 or
  // more), gravity 520 the heaviest (confetti 420, hearts 280, fireworks 260), size 2.4 among the
  // smallest and glow 0.9 below fireworks. Narrow, heavy, small and dim: the particles leave the
  // nozzle and are pulled straight back before they can read as anything.
  //
  // The point is to keep it a FOUNTAIN and not turn it into fireworks. It stays the narrowest
  // effect and the second-heaviest, because rising in a column and falling back is the whole
  // idea; it just gets the room to do it. Wider by half, a third less gravity, half again the
  // life to see the arc, half again the particles because a jet should look continuous, and
  // enough size and glow to be visible on a phone in a lit room.
  //
  // Applied from here rather than by editing the renderer: fx-render.js is shared with the stream
  // overlays, and this is Pocket's opinion about one effect, not a fix to the renderer. The merge
  // is per named effect, so the other five keep their own defaults untouched.
  const FOUNTAIN = {
    count: 140,      // was 90 — a jet should look continuous
    spread: 0.85,    // was 0.55 — still the narrowest of the six
    gravity: 360,    // was 520 — still the second heaviest, so it still falls back
    life: 2.6,       // was 1.8 — long enough to watch the arc up and down
    size: 3.0,       // was 2.4
    glow: 1.15,      // was 0.9
    wander: 0.6,     // was 0.4 — a little life across the plume
  };

  // The player has three sizes, not two. Hidden and full were the only choices and the gap
  // between them was the whole problem: hiding it takes away the play button, so anyone who
  // actually wanted to PLAY something had to keep the queue, the scrubber and a two-line title
  // on screen to get it — half the phone spent on a list you are not reading while watching
  // visuals you are.
  //
  // Minimized keeps everything you touch and drops everything you only read: the transport row
  // and the track name stay, the queue and the scrubber and the subtitle go. One tap on the
  // player itself, because a size you change often does not belong three taps into a menu.
  const PLAYER_KEY = 'hive-pocket.player';
  const PLAYER_SIZES = ['full', 'mini', 'hidden'];
  const HIDE_KEY = 'hive-pocket.hideplayer';      // the old boolean, read once and carried over

  function readPlayer() {
    try {
      const v = localStorage.getItem(PLAYER_KEY);
      if (PLAYER_SIZES.includes(v)) return v;
      // Someone upgrading from a build that only had the switch keeps what they chose.
      return localStorage.getItem(HIDE_KEY) === '1' ? 'hidden' : 'full';
    } catch (e) { return 'full'; }
  }
  function writePlayer(v) {
    try { localStorage.setItem(PLAYER_KEY, PLAYER_SIZES.includes(v) ? v : 'full'); } catch (e) {}
  }
  // Kept because several places ask this exact question — the stage hint, the diagnostics — and
  // they mean "is the transport gone", which is still one state and not three.
  function readHidePlayer() { return readPlayer() === 'hidden'; }

  // The parts that ARE the player. The stage, the menu button and the version chip are not in
  // this list on purpose: hiding the menu would strand you with no way back.
  const PLAYER_PARTS = ['#linkBtn', '#pickBtn', '#linkRow', '.now', '.controls', '.queue-wrap'];

  function applyPlayer() {
    const size = readPlayer();
    const off = size === 'hidden';
    for (const sel of PLAYER_PARTS) {
      const el = document.querySelector(sel);
      if (!el) continue;
      // The link row has its own hidden state and must not be forced open when the player
      // comes back — it is a disclosure, closed by default.
      if (sel === '#linkRow') { if (off) setHidden(el, true); continue; }
      setHidden(el, off);
    }
    // One class, because what minimized hides is a LAYOUT question and belongs in the stylesheet
    // rather than in six more querySelector lines here.
    document.body.classList.toggle('player-mini', size === 'mini');
    const b = $('miniBtn');
    if (b) {
      b.setAttribute('aria-pressed', size === 'mini' ? 'true' : 'false');
      label('miniBtn', size === 'mini' ? 'Show the whole player' : 'Minimize the player');
      b.title = size === 'mini' ? 'Show the queue and the scrubber again' : 'Keep the controls, hide the queue and scrubber';
    }
    // Resizing the player resizes the stage. A renderer that missed it draws into the old box.
    if (eq && eqShown()) eq.resize();
    if (fx && fxShown()) fx.resize();
    reflowBolts();
    // Nothing on screen could stop a playing track once the transport is gone, so it stops here
    // rather than playing on out of reach. The lock screen would still have held controls, but
    // "I hid the player and the music kept going" is not a thing to leave to chance.
    if (off) {
      if (audio && !audio.paused) { try { audio.pause(); } catch (e) {} }
      paintPlay();
    }
    paintStageHint();
  }

  // One place decides what the empty stage says, because three different states can leave it
  // empty and each needs a different sentence.
  function paintStageHint() {
    const el = $('stageHint');
    if (!el) return;
    if (promptWarning) return;      // a system dialog is up; nothing routine outranks that
    if (micLive || current >= 0) { setHidden(el, true); return; }
    setHidden(el, false);
    if (readHidePlayer()) {
      el.textContent = 'Turn on the microphone in the menu — or just drag a finger across here.';
      return;
    }
    // ASKING FOR MUSIC THAT IS ALREADY THERE. This line said "Pick some music and press play"
    // with a hundred and sixty-nine tracks listed directly below it, because it only ever knew
    // two states — something playing, or nothing at all — and a folder that is remembered but
    // locked is a third. It reads as the app having lost the music and wanting it chosen again,
    // which is what Harold saw as "always asking".
    //
    // The permission prompt itself cannot be avoided: Android will not carry a file grant across
    // a cold start, whatever this app does. What can be avoided is the app ASKING, when all it
    // needs is the press the person was about to make anyway.
    const pending = queue.filter((t) => t.pending).length;
    if (pending) {
      el.textContent = 'Your music is still here — ' + pending
        + (pending === 1 ? ' track' : ' tracks') + '. Press play and it comes straight back.';
      return;
    }
    if (queue.length) {
      el.textContent = 'Press play, or pick a track from the list — the visuals follow the sound. '
        + 'Tap for full screen, drag to paint.';
      return;
    }
    el.textContent = 'Pick some music and press play — the visuals follow the sound. '
      + 'Tap for full screen, drag to paint.';
  }

  // ONE place that talks to BOTH renderers, because each one's setConfig REPLACES its config:
  // they merge what you pass over their defaults, so a call carrying only `ambient` silently
  // resets the burst effect, and a call carrying only `style` silently resets the equalizer's
  // colour. Every setting this app owns goes in every call, to both.

  // ── Advanced: the rest of the renderers' knobs ───────────────────────────────────────────
  // THE PATTERN THAT KEEPS RECURRING, for the sixth time. Pocket sent the equalizer exactly two
  // keys — style and palette — and the renderer has twenty-odd more, every one of them already
  // implemented, tested and unreachable from this app. Same story as the six beat effects, the
  // sensitivity, the five palettes, the whole eq config, and bands 4-63.
  //
  // EVERY CONTROL IS BUILT FROM THE RENDERER'S OWN TABLES, never from a list retyped here: the
  // ranges come from EqRender.DEFAULTS and FxRender.DEFAULTS, the motions from EqRender.MOTIONS,
  // the fills from EqRender.FILLS. A knob whose default moves in the renderer moves here with no
  // edit, and a knob that is removed there stops being offered rather than silently doing
  // nothing. The cost is that this file cannot describe a knob the renderer does not export.
  //
  // WHY IT IS COLLAPSED AND LAST. The app is one screen and a few taps; twenty-five sliders is
  // the opposite of that. Nothing here is needed to use the app, nothing here is in any Look,
  // and the defaults are exactly what every previous version drew — open the group and nothing
  // has changed until you move something.
  const ADV_KEY = 'hive-pocket.advanced';

  // `k` is a path: 'gain', or 'beat.minGapMs'. `fine` marks a control whose effect only shows in
  // some styles, which is said in the label rather than by hiding the row — a control that
  // vanishes is a control someone goes looking for.
  const ADV_EQ = [
    { k: 'bands',         t: 'range',  min: 8,   max: 64,  step: 1,    lab: 'Bands' },
    { k: 'gain',          t: 'range',  min: 0.4, max: 2.5, step: 0.05, lab: 'Gain' },
    { k: 'opacity',       t: 'range',  min: 0.1, max: 1,   step: 0.05, lab: 'Opacity' },
    { k: 'fill',          t: 'pick',   opts: () => EqRender.FILLS, lab: 'Fill' },
    { k: 'gap',           t: 'range',  min: 0,   max: 0.6, step: 0.02, lab: 'Gap between bars' },
    { k: 'caps',          t: 'switch', lab: 'Peak markers' },
    { k: 'floor',         t: 'switch', lab: 'Stub under a silent band' },
    { k: 'mirror',        t: 'switch', lab: 'Mirror downward' },
    { k: 'mirrorOpacity', t: 'range',  min: 0.05, max: 1, step: 0.05, lab: 'Mirror strength' },
    { k: 'segments',      t: 'range',  min: 3,   max: 32,  step: 1,    lab: 'Segments — LED and Blocks' },
    { k: 'thickness',     t: 'range',  min: 1,   max: 12,  step: 0.5,  lab: 'Thickness — Line and Dots' },
    { k: 'glow',          t: 'range',  min: 0,   max: 1,   step: 0.05, lab: 'Glow — Line, Dots, Radial' },
    { k: 'radius',        t: 'range',  min: 0.05, max: 0.8, step: 0.02, lab: 'Inner radius — Radial' },
    { k: 'attack',        t: 'range',  min: 0.05, max: 1,  step: 0.05, lab: 'Attack — how fast a bar rises' },
    { k: 'release',       t: 'range',  min: 0.02, max: 1,  step: 0.02, lab: 'Release — how fast it falls' },
    { k: 'motion',        t: 'pick',   opts: () => EqRender.MOTIONS, lab: 'Motion' },
    { k: 'motionRate',    t: 'range',  min: 0.05, max: 2,  step: 0.05, lab: 'Motion rate' },
    { k: 'motionDepth',   t: 'range',  min: 0,   max: 1,   step: 0.05, lab: 'Motion depth' },
    { k: 'motionBeat',    t: 'switch', lab: 'Motion follows the beat' },
    { k: 'motionPunch',   t: 'range',  min: 0,   max: 3,   step: 0.1,  lab: 'Motion punch' },
  ];

  const ADV_FX = [
    { k: 'opacity',          t: 'range',  min: 0.1, max: 1,  step: 0.05, lab: 'Opacity' },
    { k: 'scale',            t: 'range',  min: 0.3, max: 2.5, step: 0.05, lab: 'Particle size' },
    { k: 'beat.minGapMs',    t: 'range',  min: 60,  max: 1200, step: 20, lab: 'Shortest gap between bursts (ms)' },
    { k: 'beat.syncToBpm',   t: 'switch', lab: 'Follow the song tempo' },
    { k: 'beat.everyBeats',  t: 'range',  min: 1,   max: 8,  step: 1,    lab: 'One burst every N beats' },
    { k: 'beat.dynamics',    t: 'pick',   opts: () => ['off', 'loudness', 'tempo', 'both'], lab: 'What sizes a burst' },
  ];

  function readAdv() {
    try { const v = JSON.parse(localStorage.getItem(ADV_KEY) || '{}'); return (v && typeof v === 'object') ? v : {}; }
    catch (e) { return {}; }
  }
  function writeAdv(v) {
    try { localStorage.setItem(ADV_KEY, JSON.stringify(v)); } catch (e) { /* private mode */ }
  }
  const advDefaults = (which) => {
    try { return which === 'eq' ? EqRender.DEFAULTS : FxRender.DEFAULTS; } catch (e) { return {}; }
  };
  function dig(obj, path) {
    return String(path).split('.').reduce((o, k) => (o === null || o === undefined ? o : o[k]), obj);
  }
  function plant(obj, path, val) {
    const parts = String(path).split('.');
    let o = obj;
    for (let i = 0; i < parts.length - 1; i++) { if (typeof o[parts[i]] !== 'object' || !o[parts[i]]) o[parts[i]] = {}; o = o[parts[i]]; }
    o[parts[parts.length - 1]] = val;
    return obj;
  }
  /** The saved value if there is one, otherwise the renderer's own default. */
  function advValue(which, path) {
    const saved = dig(readAdv()[which] || {}, path);
    return saved === undefined ? dig(advDefaults(which), path) : saved;
  }
  function setAdv(which, path, val) {
    const all = readAdv();
    all[which] = plant(all[which] || {}, path, val);
    writeAdv(all);
    applyRenderers();
    paintAdvRow(which, path);
  }
  function resetAdv(which) {
    const all = readAdv();
    delete all[which];
    writeAdv(all);
    applyRenderers();
    buildAdvanced();
  }
  /** Fold the saved overrides onto a config the app has already built. */
  function withAdv(which, base) {
    const over = readAdv()[which] || {};
    const specs = which === 'eq' ? ADV_EQ : ADV_FX;
    for (const spec of specs) {
      const v = dig(over, spec.k);
      if (v !== undefined) plant(base, spec.k, v);
    }
    return base;
  }


  // ── Advanced: drawing the controls ───────────────────────────────────────────────────────
  // Built rather than written out, because twenty-six hand-written rows in index.html is
  // twenty-six chances for a label and a key to drift apart, and the tables above already hold
  // every fact a row needs.
  function advRowId(which, path) { return 'adv-' + which + '-' + String(path).replace(/\./g, '-'); }

  function paintAdvRow(which, path) {
    const row = document.getElementById(advRowId(which, path));
    if (!row) return;
    const val = advValue(which, path);
    const out = row.querySelector('.adv-val');
    if (out && !row.classList.contains('wide')) {
      out.textContent = (typeof val === 'boolean') ? (val ? 'on' : 'off') : String(val);
    }
    const dflt = dig(advDefaults(which), path);
    // A moved knob is marked, because "what have I changed" is the question someone opening this
    // group after a week actually has, and reading twenty-six values against a default they
    // cannot see is not an answer.
    row.classList.toggle('moved', String(val) !== String(dflt));
  }

  function buildAdvanced() {
    for (const [which, specs, host] of [['eq', ADV_EQ, 'advEq'], ['fx', ADV_FX, 'advFx']]) {
      const box = $(host);
      if (!box) continue;
      box.textContent = '';
      for (const spec of specs) {
        const val = advValue(which, spec.k);
        const row = document.createElement('div');
        // A pick shows its own value in the control, so it does not get a readout column — a
        // word like "gradient" does not fit a column sized for "0.35" and spilled past the edge.
        row.className = 'adv-row' + (spec.t === 'pick' ? ' wide' : '');
        row.id = advRowId(which, spec.k);

        const lab = document.createElement('label');
        lab.className = 'adv-lab';
        lab.textContent = spec.lab;
        lab.setAttribute('for', advRowId(which, spec.k) + '-in');

        const out = document.createElement('span');
        out.className = 'adv-val';

        let input;
        if (spec.t === 'switch') {
          input = document.createElement('input');
          input.type = 'checkbox';
          input.checked = val === true;
          input.addEventListener('change', () => setAdv(which, spec.k, input.checked));
        } else if (spec.t === 'pick') {
          input = document.createElement('select');
          let opts = [];
          try { opts = spec.opts() || []; } catch (e) { opts = []; }
          for (const o of opts) {
            const el = document.createElement('option');
            el.value = o;
            el.textContent = String(o).charAt(0).toUpperCase() + String(o).slice(1);
            input.appendChild(el);
          }
          input.value = String(val);
          input.addEventListener('change', () => setAdv(which, spec.k, input.value));
        } else {
          input = document.createElement('input');
          input.type = 'range';
          input.min = spec.min; input.max = spec.max; input.step = spec.step;
          input.value = Number(val);
          // 'input' rather than 'change': a slider you cannot see the effect of while dragging is
          // a slider you set by trial and error. applyRenderers() is cheap - it hands the
          // renderers a config, it does not rebuild anything.
          input.addEventListener('input', () => setAdv(which, spec.k, Number(input.value)));
        }
        input.id = advRowId(which, spec.k) + '-in';
        input.className = 'adv-in';

        row.appendChild(lab);
        row.appendChild(input);
        row.appendChild(out);
        box.appendChild(row);
        paintAdvRow(which, spec.k);
      }
    }
  }

  function applyRenderers() {
    rollEq();
    const q = QUALITY[readQuality()];
    if (eq) {
      // withAdv LAST, because setConfig REPLACES rather than merges — every key the app owns
      // has to be in this one object or the renderer resets it to its own default.
      eq.setConfig(withAdv('eq', { style: eqShapeNow, palette: eqPaletteNow }));
      // Per SURFACE, deliberately not part of the saved config — the renderer keeps frame rate
      // out of setConfig for exactly this reason, so it is set separately every time.
      if (eq.setFps) eq.setFps(q.fps);
    }
    if (!fx) return;
    fx.setConfig(withAdv('fx', {
      ambient: readAmbient(),
      palette: readPalette(),
      particleCap: q.parts,
      ambientCap: q.amb,
      effects: { fountain: FOUNTAIN },
      beat: {
        // 'lightning' is not one of the renderer's six and it would fall back silently to a
        // default, so it is never sent: the renderer's beat is switched OFF instead and Pocket's
        // own bass detector drives the strikes. Anything else goes straight through.
        enabled: readBeatEffect() !== 'lightning' && readBeatEffect() !== 'fairy',
        effect: (readBeatEffect() === 'lightning' || readBeatEffect() === 'fairy')
          ? 'fireworks' : readBeatEffect(),
        sensitivity: SENS[readSens()],
        intensity: PUNCH[readPunch()],
      },
    }));
  }
  function readModes() {
    try {
      const m = JSON.parse(localStorage.getItem(MODES_KEY) || '{}');
      shuffleOn = m.shuffle === true;
      repeatMode = (m.repeat === 'all' || m.repeat === 'one') ? m.repeat : 'off';
    } catch (e) { /* private mode */ }
  }
  function writeModes() {
    try { localStorage.setItem(MODES_KEY, JSON.stringify({ shuffle: shuffleOn, repeat: repeatMode })); }
    catch (e) { /* private mode */ }
  }
  function buildOrder() {
    order = queue.map((_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    orderPos = order.indexOf(current);
  }

  // ── Audio graph, built once on the first real play ───────────────────────────────────
  // Once, because createMediaElementSource can only be called once per element and throws on a
  // second call — and because an AudioContext started before a user gesture is born suspended.
  let ctx = null, analyser = null, srcNode = null, freq = null;

  // The context, the element analyser and the shared band buffer. Split out of ensureGraph
  // because the microphone can now be the first thing this app ever opens: there may be no
  // track, no <audio> element and no play yet, and the graph still has to exist.
  function ensureCtx() {
    if (ctx) return true;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;                         // no Web Audio: still plays, just no visuals
    ctx = new AC();
    analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;                       // 512 bins, plenty for 64 bands
    analyser.smoothingTimeConstant = 0.75;
    freq = new Uint8Array(analyser.frequencyBinCount);
    return true;
  }

  function ensureGraph(el) {
    if (!ensureCtx()) return false;
    if (!srcNode) {
      srcNode = ctx.createMediaElementSource(el);
      srcNode.connect(analyser);
      analyser.connect(ctx.destination);           // ← the line whose absence is silence
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return true;
  }

  // ── The microphone ──────────────────────────────────────────────────────
  // Why this exists: everything else in this app can only see audio it owns. A file it plays,
  // yes; a link from a host that will not grant permission, no — those come back as silence and
  // the visuals sit dead. The microphone is the one source that can see
  // ANY sound in the room, including music playing from another app entirely.
  //
  // ITS ANALYSER IS NEVER CONNECTED TO destination. The element path must be
  // (analyser -> destination is how the file reaches the speakers), and sending a microphone
  // down that same line on a phone — speaker centimetres from the mic — is a feedback howl.
  // Two analysers rather than one, so that line can never be shared by accident.
  const MIC_KEY = 'hive-pocket.mic';
  let micAnalyser = null, micSrc = null, micStream = null, micLive = false, micArmed = false;

  function readMicAuto() {
    try { return JSON.parse(localStorage.getItem(MIC_KEY) || '{}').auto === true; }
    catch (e) { return false; }
  }
  function writeMicAuto(on) {
    try { localStorage.setItem(MIC_KEY, JSON.stringify({ auto: on === true })); }
    catch (e) { /* private mode */ }
  }

  function micNote(msg) { const el = $('micNote'); if (el) el.textContent = msg; }

  // Keeping the screen awake. Measured before this shipped rather than after: a live microphone,
  // both canvases and a bright screen cost 3% of Harold's battery in 15 minutes — about 12% an
  // hour, which is ordinary screen-on territory and cheap enough that the density caps do not
  // need turning down to afford it.
  //
  // It follows the MICROPHONE, not full screen. A phone propped against something is listening
  // whether or not the stage fills the screen, and that is the case where sleeping ruins it.
  // Full screen stays a deliberate tap and does not imply this.
  let wakeLock = null;

  async function keepAwake(on) {
    if (!on) {
      const held = wakeLock; wakeLock = null;
      if (held) { try { await held.release(); } catch (e) { /* already gone */ } }
      return;
    }
    if (wakeLock || !navigator.wakeLock || document.visibilityState !== 'visible') return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      // The browser drops it on its own when the page is hidden, and does not tell this code
      // beforehand. Clearing the handle here keeps the re-acquire below from thinking it still
      // holds one it does not.
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch (e) {
      wakeLock = null;                 // refused, or no support: the app works, the screen sleeps
    }
  }

  // A wake lock is released whenever the page goes to the background, and is NOT restored when
  // it comes back. Without this, switching apps once and returning leaves the screen sleeping
  // again with the microphone still open, which reads as the feature having quietly broken.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && micLive) keepAwake(true);
  });

  function micPaint() {
    const b = $('micBtn');
    if (b) {
      b.textContent = micLive ? 'Stop listening' : 'Listen with the microphone';
      b.setAttribute('aria-pressed', micLive ? 'true' : 'false');
    }
    const c = $('micAuto');
    if (c) c.checked = readMicAuto();
    // Say it on the main screen too. A microphone that is open and unmentioned is the kind of
    // thing that should never be a surprise, and with no track loaded there is nothing else here.
    if (current < 0) {
      $('nowTitle').textContent = micLive ? 'Listening' : 'Nothing loaded';
      $('nowSub').textContent = micLive
        ? 'The visuals follow whatever this phone can hear.'
        : 'Tap the folder button to choose music from this phone';
    }
    paintStageHint();
  }

  async function micStart(fromGesture) {
    if (micLive) return true;
    // isSecureContext, not a protocol string. The browser is the authority on what counts —
    // it trusts 127.0.0.1 and localhost as well as https, and a hand-rolled check got that
    // wrong and refused to open on a local test server.
    if (!window.isSecureContext) {
      micNote('A microphone needs a secure address. This page is not on one.');
      return false;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      micNote('This browser will not open a microphone.');
      return false;
    }
    if (!ensureCtx()) { micNote('This browser has no Web Audio, so there is nothing to draw.'); return false; }
    try {
      // All three off, deliberately. They default ON because the default caller is a phone call,
      // and every one of them is wrong here: autoGainControl rides the level and flattens exactly
      // the dynamics the visuals exist to show, noiseSuppression is trained on speech and treats
      // sustained music as noise, and echoCancellation subtracts what the speakers are playing —
      // which, when the phone is listening to a speaker, is the whole signal.
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        video: false,
      });
    } catch (e) {
      micStream = null;
      const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
      micNote(denied
        ? 'The microphone was refused. Allow it for this site and try again.'
        : 'No microphone opened: ' + ((e && e.name) || 'unknown error') + '.');
      micPaint();
      return false;
    }
    if (!micAnalyser) {
      micAnalyser = ctx.createAnalyser();
      micAnalyser.fftSize = 1024;
      micAnalyser.smoothingTimeConstant = 0.75;
    }
    micSrc = ctx.createMediaStreamSource(micStream);
    micSrc.connect(micAnalyser);          // and NOWHERE else. See the note above.
    micLive = true;
    // Listening to the room while this app plays its own file would draw both at once, one of
    // them through a speaker. Pause rather than tear down, so play still resumes where it was.
    if (audio && !audio.paused) { try { audio.pause(); } catch (e) {} }
    paintPlay();
    initVisuals();
    startPump();
    // A context created without a gesture is born suspended, and resume() may be refused until
    // the page is touched. Say so rather than drawing a flat line and looking broken.
    if (ctx.state === 'suspended') {
      try { await ctx.resume(); } catch (e) { /* refused */ }
    }
    await keepAwake(true);
    const awake = wakeLock ? ' The screen will stay awake.' : '';
    if (ctx.state === 'suspended') {
      micNote('Listening — tap the screen once to let the phone start drawing.' + awake);
      armResume();
    } else {
      micNote((fromGesture === false
        ? 'Listening. Started by itself, because you asked it to.'
        : 'Listening.') + awake);
    }
    micPaint();
    return true;
  }

  // One tap, once, anywhere. Only armed when a context is stuck suspended.
  function armResume() {
    if (micArmed) return;
    micArmed = true;
    const go = () => {
      document.removeEventListener('pointerdown', go, true);
      micArmed = false;
      if (!ctx) return;
      ctx.resume().then(() => { if (micLive) micNote('Listening.'); }).catch(() => {});
    };
    document.addEventListener('pointerdown', go, true);
  }

  function micStop() {
    if (!micLive) return;
    micLive = false;
    try { if (micSrc) micSrc.disconnect(); } catch (e) {}
    micSrc = null;
    // Stop the TRACKS, not just the node: the phone keeps its recording indicator lit and holds
    // the device open until every track is stopped.
    if (micStream) {
      try { micStream.getTracks().forEach((t) => t.stop()); } catch (e) {}
      micStream = null;
    }
    if (current < 0) stopPump();
    keepAwake(false);
    micNote('Not listening.');
    micPaint();
    // The transport shows listening as a running state now, so it has to be told when listening
    // ends. Without this the pause bars stayed on a stopped app — a stale icon introduced by the
    // very change meant to stop the icon being wrong, and caught one test later.
    paintPlay();
    paintStageHint();
  }

  // ── Bands ────────────────────────────────────────────────────────────────────────────
  // The renderers take 0-255 per band. Buckets are logarithmic because hearing is: a linear
  // split puts almost every bar in a range where music has nothing to say.
  const BANDS = 64;
  const edges = (() => {
    const out = [];
    for (let i = 0; i <= BANDS; i++) out.push(Math.pow(i / BANDS, 2.2));
    return out;
  })();

  function readBands() {
    // The microphone wins while it is open: it is the source the person deliberately chose, and
    // the element analyser may still be holding the last frame of a paused track.
    const an = micLive && micAnalyser ? micAnalyser : analyser;
    if (!an || !freq) return null;
    an.getByteFrequencyData(freq);
    const n = freq.length;
    const bands = new Array(BANDS);
    for (let i = 0; i < BANDS; i++) {
      const lo = Math.min(n - 1, Math.floor(edges[i] * n));
      const hi = Math.max(lo + 1, Math.min(n, Math.floor(edges[i + 1] * n)));
      let peak = 0;
      for (let j = lo; j < hi; j++) if (freq[j] > peak) peak = freq[j];
      bands[i] = peak;
    }
    return bands;
  }

  // ── Renderers ────────────────────────────────────────────────────────────────────────
  let eq = null, fx = null, pumping = false;

  function initVisuals() {
    if (eq) return;
    eq = EqRender.create($('eqCanvas'));
    fx = FxRender.create($('fxCanvas'));
    // The equalizer needs no configuration — its defaults draw as soon as bands arrive.
    // The effects DO need one thing said. Out of the box ambient is off and the only thing
    // that draws is a burst on a detected beat, so a quiet passage, or anything without
    // percussion, leaves the stage empty and looks broken. A calm always-on weather layer
    // means there is something to see from the first second, and the beat bursts land on top.
    // Stars by default, never storm or lightning: those flash, so they are only ever on
    // because someone picked them in Settings.
    applyRenderers();
    eq.start();
    fx.start();
    applyVisuals(visuals);   // the canvases exist now, so the stored choice can take effect
  }

  // `hidden` and not opacity: an invisible canvas is still a canvas being painted every frame,
  // and this runs on a phone battery. The pump below stops feeding whichever one is off, and a
  // renderer re-measures on the way back because it was sized to a box of zero while away.
  // One place decides what is on the stage, so the menu and the transport's effects button can
  // never disagree about what you are looking at.
  function paintStage() {
    setHidden($('eqCanvas'), !eqShown());
    setHidden($('fxCanvas'), !fxShown());
    // The bolt layer belongs to the effects half and hides with it. Hidden, not transparent: a
    // canvas nobody can see is still a canvas, and this one stops its own loop when it empties.
    setHidden($('boltCanvas'), !fxShown());
    if ($('boltCanvas').hidden) clearBolts();
    {
      if (eq && eqShown()) eq.resize();
      if (fx && fxShown()) fx.resize();
      reflowBolts();
    }
  }

  function applyVisuals(v) {
    visuals = VISUALS.includes(v) ? v : 'both';
    try { localStorage.setItem(VISUALS_KEY, visuals); } catch (e) { /* private mode */ }
    paintStage();
    $('visualsSel').value = visuals;
    const on = fxShown();
    $('fxBtn').setAttribute('aria-pressed', on ? 'true' : 'false');
    label('fxBtn', on ? 'Effects on' : 'Effects off');
  }

  // ── Full screen ──────────────────────────────────────────────────────────────────────
  // Native full screen is what a phone should get: it takes the browser's own bars away too.
  // It can also be absent, or refused when the tap does not look like a gesture to the browser,
  // and it gives no useful error when it is. So the class goes on FIRST and unconditionally —
  // that alone covers the screen — and the native request is a best-effort improvement on top.
  // The tap always does something visible, which is the whole contract of a tap.
  let covered = false;
  let tipTimer = 0;

  function nativeOn() {
    const el = $('stageWrap');
    const req = el.requestFullscreen || el.webkitRequestFullscreen;
    if (!req) return;
    try { Promise.resolve(req.call(el)).catch(() => {}); } catch (e) { /* refused */ }
  }
  function nativeOff() {
    const off = document.exitFullscreen || document.webkitExitFullscreen;
    if (!off || !(document.fullscreenElement || document.webkitFullscreenElement)) return;
    try { Promise.resolve(off.call(document)).catch(() => {}); } catch (e) { /* already out */ }
  }

  function setCover(on) {
    covered = on === true;
    // The WRAPPER, not the stage, so anything sitting beside the canvases comes along with it.
    $('stageWrap').classList.toggle('cover', covered);
    $('stage').setAttribute('aria-pressed', covered ? 'true' : 'false');
    label('stage', covered ? 'Tap to leave full screen' : 'Tap for full screen');
    // The way back has to be discoverable. It is the same tap, which is not obvious, so say so
    // once and then get out of the way of the thing the person went full screen to look at.
    clearTimeout(tipTimer);
    setHidden($('coverTip'), !covered);
    $('coverTip').style.opacity = '';
    if (covered) tipTimer = setTimeout(() => { $('coverTip').style.opacity = '0'; }, 2600);
    if (covered) nativeOn(); else nativeOff();
    // The stage just changed size by a lot. A renderer that missed it draws into the old box.
    if (eq && eqShown()) eq.resize();
    if (fx && fxShown()) fx.resize();
    reflowBolts();                      // bolts were built for the old box; wisps are rescaled
  }

  function pump() {
    if (!pumping) return;
    autoSample(performance.now());
    const b = readBands();
    if (b) {
      if (eq && eqShown()) eq.push(b);
      if (fx && fxShown()) fx.pushBands(b);
      // The renderer's detector has just seen bands 0-3. This looks at the rest of them.
      driveExtras(b);
    }
    requestAnimationFrame(pump);
  }
  function startPump() { if (!pumping) { pumping = true; requestAnimationFrame(pump); } }
  function stopPump() { pumping = false; }

  // ── The queue ────────────────────────────────────────────────────────────────────────
  function renderQueue() {
    const ul = $('queue');
    ul.textContent = '';
    $('queueCount').textContent = queue.length ? queue.length + (queue.length === 1 ? ' track' : ' tracks') : '';
    queue.forEach((t, i) => {
      const li = document.createElement('li');
      // 'locked' is a look, not a disabled state: the row is fully pressable and pressing it is
      // what unlocks it. Greying out the only way forward would be the opposite of the point.
      li.className = 'row' + (i === current ? ' on' : '') + (t.pending ? ' locked' : '');
      const num = document.createElement('span');
      num.className = 'num mono';
      num.textContent = String(i + 1).padStart(2, '0');
      const nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = t.name;
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'rowdel';
      del.setAttribute('aria-label', 'Remove ' + t.name);
      del.setAttribute('title', 'Remove ' + t.name);
      del.textContent = '\u00d7';
      // stopPropagation, or removing a row also starts playing whatever slid into its place.
      del.addEventListener('click', (ev) => { ev.stopPropagation(); removeAt(i); });
      li.append(num, nm, del);
      li.addEventListener('click', () => play(i));
      ul.appendChild(li);
    });
  }

  function removeAt(i) {
    const t = queue[i];
    if (!t) return;
    // A picked file's blob URL is memory held for the life of the page. Let it go.
    if (!t.link) { try { URL.revokeObjectURL(t.url); } catch (e) {} }
    // A saved link removed from the queue is removed from storage too — the queue IS the
    // library for links, and leaving it saved would resurrect it on the next start.
    if (t.link) writeLinks(readLinks().filter((l) => l.url !== t.url));

    const wasCurrent = i === current;
    queue.splice(i, 1);
    if (i < current) current--;
    else if (wasCurrent) {
      // Do not silently jump to another song. Stop, and leave the next press to the person.
      teardown();
      current = -1;
      $('nowTitle').textContent = 'Nothing loaded';
      $('nowSub').textContent = 'Removed. Pick a track to start again.';
      paintPlay();
    }
    if (shuffleOn) buildOrder();
    renderQueue();
    paintLib();
  }

  // ── Playback ─────────────────────────────────────────────────────────────────────────
  const TAP_NOTE = 'Tap play to start — the phone needs a tap before it makes sound.';
  const MAX_FAIL_RUN = 5;      // consecutive unplayable tracks before it stops skipping
  // A FILE CAN FAIL WITHOUT FIRING 'error'. A zero-byte or truncated track is decoded as a
  // zero-length one: it "plays", ends immediately, and the ended handler calls next() — so the
  // queue sprints through the whole folder and the error path, which has the bound on it, is
  // never reached at all. Caught by a test whose fake files were 8 bytes: eleven tracks in
  // 680ms and still accelerating.
  //
  // WHAT THIS COSTS, since it is a threshold: five REAL tracks under half a second each, in a
  // row, will also stop the queue. That is a stinger or a sound-effect folder, and it stops with
  // a sentence saying what happened and plays again the moment play is pressed — as against the
  // alternative, which is grinding through several hundred files in a few seconds.
  const MIN_REAL_PLAY_MS = 500;
  let failRun = 0, playStartedAt = 0;
  function teardown() {
    if (!audio) return;
    try { audio.pause(); } catch (e) { /* already gone */ }
    // NOT removeChild + new element: a second createMediaElementSource on a NEW element would
    // be fine, but the old node would keep the graph alive. One element for the app's life.
    audio.removeAttribute('src');
    audio.load();
  }

  function ensureAudio() {
    if (audio) return audio;
    audio = document.createElement('audio');
    audio.preload = 'metadata';
    $('audioHost').appendChild(audio);
    audio.addEventListener('timeupdate', paintTime);
    audio.addEventListener('durationchange', paintTime);
    // NOT a place to clear failRun: this fires for a track that is about to end instantly too,
    // which would reset the count on exactly the case the count exists for.
    audio.addEventListener('play', () => { playStartedAt = performance.now(); paintPlay(); startPump(); });
    audio.addEventListener('pause', () => { paintPlay(); });
    audio.addEventListener('ended', () => {
      const lasted = playStartedAt ? performance.now() - playStartedAt : 0;
      if (lasted >= MIN_REAL_PLAY_MS) { failRun = 0; next(true); return; }
      failRun++;
      if (failRun >= MAX_FAIL_RUN) {
        failRun = 0;
        $('nowSub').textContent = 'Five tracks in a row ended the moment they started, so it '
          + 'stopped here. They may be empty or cut short. Press play to carry on anyway.';
        paintPlay();
        return;
      }
      next(true);
    });
    audio.addEventListener('error', () => {
      const t = queue[current];
      // A link that refused the CORS request: drop the request and take the audio without
      // visuals, rather than skipping a track that would have played perfectly well.
      if (t && t.link && audio.corsTried) {
        $('nowSub').textContent = 'Playing without visuals — that host does not allow this page to read its audio.';
        play(current, { noCors: true });
        return;
      }
      // A BOUND ON SKIPPING, and lazy loading is what made it matter. One unplayable file has
      // always skipped to the next, which is right; a whole folder of them sprinted silently
      // through every track in the queue, and now each of those skips also reads a file off the
      // disk. A test with 169 undecodable files went through nine in 600ms and was not slowing
      // down. So: after five in a row it stops and says so, rather than working through a
      // hundred and sixty-nine failures on the person's behalf.
      failRun++;
      if (failRun >= MAX_FAIL_RUN) {
        failRun = 0;
        $('nowSub').textContent = 'Five tracks in a row would not play, so it stopped here rather '
          + 'than working through the rest. The files may be a format this phone cannot read.';
        paintPlay();
        return;
      }
      $('nowSub').textContent = t && t.link
        ? 'That link would not play. It has to point straight at an audio file.'
        : 'That file would not play — skipping.';
      if (!t || !t.link) next();
    });
    return audio;
  }

  function play(i, opts) {
    const t = queue[i];
    if (!t) return;
    // A track listed from the folder but not yet read off the disk. One file, now.
    if (!t.file && t.handle) {
      busy(true, 'Opening ' + t.name + '…');
      fillFile(t).then((ok) => {
        busy(false);
        if (ok) play(i, opts);
        else {
          $('nowSub').textContent = 'That file is no longer where it was. Choose the folder again '
            + 'to pick up what changed.';
        }
      });
      return;
    }
    // A track whose folder is remembered but not yet unlocked. Pressing it asks for the folder
    // and then plays — one gesture, where the person was already reaching.
    if (t.pending) {
      busy(true, 'Reconnecting…');
      reconnectFolder().then(() => {
        busy(false);
        const again = queue.findIndex((x) => x.name === t.name && (x.file || x.handle));
        if (again >= 0) play(again, opts);
      });
      return;
    }
    // A link saved back when this app had a YouTube player. It is kept rather than deleted, and
    // says so rather than failing as a silent dead track — a row that does nothing and explains
    // nothing is the worst of the three options.
    if (t.dead) {
      current = i;
      $('nowTitle').textContent = t.name;
      $('nowSub').textContent = 'YouTube was removed from this app. This saved link cannot play; '
        + 'remove it from the queue, or play the sound out loud and press Listen.';
      renderQueue(); paintPlay();
      return;
    }
    const el = ensureAudio();
    teardown();
    current = i;
    // CROSS-ORIGIN AUDIO AND THE ANALYSER. A media element loaded from another origin without
    // CORS permission is opaque: it plays, but Web Audio refuses to let this page read it and
    // every band comes back zero, so the visuals sit dead with no error anywhere. Asking for
    // CORS is the only way to get them — and asking fails outright on a host that does not
    // grant it, which is why the error handler below retries once WITHOUT it. Sound first,
    // visuals if the host allows them.
    if (t.link && !(opts && opts.noCors)) el.crossOrigin = 'anonymous';
    else el.removeAttribute('crossorigin');
    el.corsTried = !!(t.link && !(opts && opts.noCors));
    el.src = t.url;
    $('nowTitle').textContent = t.name;
    $('nowSub').textContent = 'From this device';
    setHidden($('stageHint'), true);
    renderQueue();
    // The graph is built on a real gesture-driven play, which is when a phone will allow it.
    // Two-argument form, deliberately: with a trailing .catch, a throw inside started() would
    // land here and write "tap play to start" over music that was already playing — the app
    // blaming the phone for its own fault. This branch is now reachable only by a real refusal.
    el.play().then(started, () => {
      $('nowSub').textContent = TAP_NOTE;
      paintPlay();
    });
    paintPlay();
  }

  // Playback ACTUALLY began. Only now can the graph be built: a phone refuses the first
  // attempt, so this has to run on whichever attempt wins — the automatic one, or the tap
  // that follows it. Hanging it on play() alone left a blocked first track playing with a
  // dead stage for the rest of the session, because the resume path never built the graph.
  function started() {
    // THE VISUALS GET THEIR OWN try, and this is not defensive noise — it is a bug that was
    // caught by chasing a test failure and would have looked identical on a real phone.
    //
    // toggle() calls this through `.then(started).catch(() => {})`. An empty catch on a promise
    // whose handler does real work does not guard the play() call, it swallows EVERYTHING the
    // handler throws. So when initVisuals() threw, the graph was built, the sound played, and
    // then this function stopped dead: the stale "tap play" prompt was never cleared, the media
    // session was never set, and nothing anywhere said why. Sound with no visuals and a lying
    // subtitle, in silence — the exact shape of failure this app keeps having to design against.
    //
    // Splitting it means a renderer that cannot start costs the renderer and nothing else, and
    // SAYS SO on the stage rather than leaving a wrong message standing.
    let visualsFailed = null;
    try {
      if (audio && ensureGraph(audio)) { initVisuals(); startPump(); }
    } catch (e) {
      visualsFailed = e;
    }
    // The tap happened. Leave any other note alone — a link playing without visuals has its
    // own, and that one is still true.
    if ($('nowSub').textContent === TAP_NOTE) $('nowSub').textContent = 'From this device';
    if (visualsFailed) {
      $('nowSub').textContent = 'Playing, but the visuals could not start on this phone. '
        + 'The sound is fine; the equalizer and effects are not running.';
    }
    paintMediaSession();
  }

  function toggle() {
    // Matches the icon exactly: whatever the pause bars are showing for is what stops.
    if (micLive && !(audio && !audio.paused)) { micStop(); return; }
    if (!audio || current < 0) { if (queue.length) play(0); return; }
    // .then(started, onRefused) and NOT .then(started).catch(onRefused). The two read the same
    // and are not: a trailing .catch also catches whatever `started` throws, so a renderer that
    // failed came back looking exactly like a phone refusing to play. The two-argument form
    // handles the refusal ONLY, and leaves a real fault in started() to surface as an unhandled
    // rejection instead of vanishing. See the note in started().
    if (audio.paused) audio.play().then(started, () => {});
    else audio.pause();
  }
  // fromEnd: a track that ran out, as opposed to the button. Only the former stops at the end
  // of the queue — pressing Next at the last track wrapping is what people expect.
  function next(fromEnd) {
    if (!queue.length) return;
    if (fromEnd && repeatMode === 'one') { play(current); return; }
    if (shuffleOn) {
      if (!order || order.length !== queue.length) buildOrder();
      orderPos++;
      if (orderPos >= order.length) {
        if (fromEnd && repeatMode === 'off') { stopHere(); return; }
        buildOrder(); orderPos = 0;
      }
      play(order[orderPos]);
      return;
    }
    const n = current + 1;
    if (n >= queue.length) {
      if (fromEnd && repeatMode === 'off') { stopHere(); return; }
      play(0); return;
    }
    play(n);
  }
  // The queue ran out and nothing says to carry on. Stop where it is rather than looping
  // silently back to the top, which is how a player ends up playing all night.
  function stopHere() {
    if (audio) audio.pause();
    $('nowSub').textContent = 'End of the queue.';
    paintPlay();
  }
  function prev() {
    if (!queue.length) return;
    if (audio && audio.currentTime > 3) { audio.currentTime = 0; return; }
    play(current <= 0 ? queue.length - 1 : current - 1);
  }

  // ── Painting ─────────────────────────────────────────────────────────────────────────
  function paintPlay() {
    const playing = !!audio && !audio.paused;
    // LISTENING IS PLAYING, as far as this button is concerned. With "start listening when the
    // app opens" on, the app comes up drawing the room and the transport showed a play triangle
    // — the icon for "nothing is happening" — from the start and for as long as you left it.
    // Harold reported it twice; my first two attempts read it as a wrong label and as a stopped
    // pump, and both were something else that also needed fixing.
    //
    // The button now means what its icon has always meant: the app is producing something, press
    // to stop. A file playing pauses the file; the microphone open with no file stops listening.
    // Two sources, one button, and the existing pause icon rather than a new control or a
    // sentence bolted onto the label.
    const running = playing || micLive;
    setHidden($('playIcon'), running);
    setHidden($('pauseIcon'), !running);
    // 'Play' and 'Pause', unchanged since the first version. 1.32.0 replaced the idle label with
    // a sentence about the microphone, on the theory that "Play" implies the app is doing
    // nothing while it listens. Harold's answer was "buttons wrong, use existing logic" and he
    // is right: this button has exactly one job, the label is what a screen reader announces on
    // every focus, and a paragraph is not a button label. What the microphone is doing is said
    // by the title above, which says "Listening", and by the microphone's own button.
    label('playBtn', playing ? 'Pause' : (micLive ? 'Stop listening' : 'Play'));
    // The lock screen follows the FILE only. A phone showing "playing" for a microphone with no
    // track behind it gives the notification nothing to name and its buttons nothing to do.
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
    // THE MICROPHONE IS A REASON TO KEEP PUMPING, and leaving it out of this line was a freeze.
    // paintPlay() runs from a dozen places — every transport press, every pause event, hiding the
    // player — and each of them stopped the loop that feeds the renderers whenever no FILE was
    // playing. With the microphone open that is the normal state, so the visuals died while the
    // mic stayed on and the bands kept arriving with nobody reading them.
    //
    // Measured: hide the player while listening and the particle count went 300 -> 300 -> 0 over
    // three seconds, with micLive still true and band 0 still moving between 240 and 231. The
    // equalizer stops, the effects drain, and nothing on screen says why.
    if (!playing && !micLive) stopPump(); else startPump();
  }

  function paintTime() {
    if (!audio) return;
    const d = isFinite(audio.duration) ? audio.duration : 0;
    $('tNow').textContent = fmt(audio.currentTime);
    $('tEnd').textContent = fmt(d);
    const s = $('seek');
    if (document.activeElement !== s) { s.max = String(d || 0); s.value = String(audio.currentTime || 0); }
  }

  function paintMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const t = queue[current];
    try {
      navigator.mediaSession.metadata = t ? new MediaMetadata({
        title: t.name, artist: 'On this device', album: 'Hive Pocket',
        artwork: [{ src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
                  { src: 'icon-512.png', sizes: '512x512', type: 'image/png' }],
      }) : null;
    } catch (e) { /* older browser; the transport handlers below still work */ }
  }

  // ── Picking music ────────────────────────────────────────────────────────────────────
  // Plain <input type=file>. The folder-handle API that would let this be remembered is
  // desktop-only; see the note in index.html for why v1 does not copy the audio into storage
  // to fake it.
  function readyNote(n) {
    // The subtitle still read "Tap the folder button to choose music from this phone" with the
    // music already listed underneath it — an instruction to do the thing that had just been
    // done. It only ever changed on play, and until a folder could fill the queue in one tap
    // nothing made that obvious.
    if (current >= 0) return;
    $('nowTitle').textContent = 'Ready';
    $('nowSub').textContent = n + (n === 1 ? ' track' : ' tracks') + ' — press play, or pick one '
      + 'from the list.';
  }

  function adopt(files) {
    failRun = 0;
    const picked = [...files].filter((f) => /^audio\//.test(f.type) || /\.(mp3|m4a|aac|ogg|opus|wav|flac)$/i.test(f.name));
    if (!picked.length) { $('libNote').textContent = 'No playable audio in that selection'; return; }
    // Revoke the old blob URLs before dropping them, or the files stay in memory for the life
    // of the page — which on a phone, with a big library, is the difference between working and
    // being killed by the system.
    queue.forEach((t) => { try { URL.revokeObjectURL(t.url); } catch (e) {} });
    queue = picked
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
      .map((f) => ({ name: f.name.replace(/\.[^.]+$/, ''), url: URL.createObjectURL(f), file: f }));
    current = -1;
    // Saved links are kept: picking files replaces the FILES, not the library.
    queue = queue.concat(readLinks().map(linkRow));
    if (shuffleOn) buildOrder();
    renderQueue();
    paintLib();
    paintFolder();
    paintStageHint();
    readyNote(picked.length);
  }

  // ── Remembering a folder ─────────────────────────────────────────────────────────────
  // For every version until now this app asked for your music on every cold start, and said so
  // in About: "a phone will not let a web app remember a folder." That stopped being true in
  // January 2025, when Chrome shipped the File System Access API on Android in M132 — pickers
  // included. The claim was simply never revisited.
  //
  // A directory handle is serializable, so it goes in IndexedDB — localStorage holds strings and
  // a handle is not one. On the next visit the handle is still there and the PERMISSION may or
  // may not be: queryPermission() says which. Granted means the folder can be read with no tap
  // at all; 'prompt' means the browser wants a gesture first, and no amount of wanting changes
  // that — a page cannot silently regain access to someone's files, which is the correct rule.
  // So that case gets a button rather than a broken promise.
  //
  // The plain file picker stays for everyone else. Firefox and Safari have none of this, and a
  // feature that improves Chrome must not take the app away from anything else.
  const DB_NAME = 'hive-pocket';
  const DB_STORE = 'handles';
  const DB_KEY = 'musicFolder';
  // The track names, in localStorage, beside the handle in IndexedDB. Harold's own report
  // settled what this is for: installed, storage persisted, and queryPermission STILL said
  // 'prompt' on load — so on Android the grant does not survive a cold start however the app is
  // installed, and one tap is the floor rather than a bug to chase. What can be fixed is what
  // that tap feels like. Before this, reopening showed an empty app and a button: the 169 tracks
  // that were there yesterday were simply gone, which reads as lost rather than as locked.
  // The names cost nothing, come back instantly, and make the queue look like itself.
  //
  // NAMES ONLY. Never a path, never a URL, never anything that could rebuild where the music
  // lives — those are the user's and stay in the handle the browser guards.
  const NAMES_KEY = 'hive-pocket.foldernames';
  const NAMES_MAX = 500;

  function readNames() {
    try {
      const v = JSON.parse(localStorage.getItem(NAMES_KEY) || '[]');
      return Array.isArray(v) ? v.filter((n) => typeof n === 'string').slice(0, NAMES_MAX) : [];
    } catch (e) { return []; }
  }
  function writeNames(list) {
    try { localStorage.setItem(NAMES_KEY, JSON.stringify(list.slice(0, NAMES_MAX))); } catch (e) {}
  }

  // A folder can be enormous, and a phone reading ten thousand entries is a phone that has
  // stopped responding. WHAT STOPS BEING VISIBLE: past these limits the rest of the folder is
  // not loaded, and the app says how many it took rather than pretending that was all of them.
  const FOLDER_MAX_FILES = 500;
  const FOLDER_MAX_DEPTH = 3;

  // `el.hidden = x` IS NOT A WAY TO HIDE AN SVG, and that is the whole of "the play button never
  // shows pause". `hidden` is an IDL attribute defined on HTMLElement; SVGElement does not have
  // it — measured, not assumed: `'hidden' in SVGElement.prototype` is false in Chrome. So on an
  // <svg>, `.hidden = true` quietly creates a plain JavaScript property, the hidden CONTENT
  // attribute is never written, and the [hidden] rule in the stylesheet never matches.
  //
  // The transport's two glyphs are <svg>. playIcon has no hidden attribute in the markup and
  // pauseIcon has one, so every paintPlay() since they were added has set a property nothing
  // reads, and the pair has been frozen at its markup defaults: the triangle always drawn, the
  // bars never. Harold reported it as "buttons wrong" across 1.34.0, 1.36.0 and again now; the
  // label fix and the listening-is-playing fix were both right and both invisible, because the
  // thing they were driving was not connected to anything.
  //
  // AND A CORRECT FIX IS WHAT MADE IT LOOK DEAD. An earlier release found both glyphs drawing at
  // once and added `[hidden] { display: none !important }` so the attribute would beat the
  // `.ctl svg` display rule. That was right, and it turned "both showing" into "one showing,
  // forever" — which reads as a button that does not respond rather than as a bug.
  //
  // toggleAttribute writes the content attribute, which is what CSS reads, on every Element.
  // Used for every hide in this file rather than only on the two glyphs: the next SVG someone
  // hides should not have to rediscover this.
  function setHidden(el, on) {
    if (!el) return;
    if (el.toggleAttribute) el.toggleAttribute('hidden', !!on);
    else if (on) el.setAttribute('hidden', ''); else el.removeAttribute('hidden');
  }
  const isHidden = (el) => !!(el && el.hasAttribute && el.hasAttribute('hidden'));

  const canRemember = () => typeof window.showDirectoryPicker === 'function';

  function idb() {
    return new Promise((resolve, reject) => {
      let req;
      try { req = indexedDB.open(DB_NAME, 1); } catch (e) { reject(e); return; }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  function idbPut(key, val) {
    return idb().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).put(val, key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    }));
  }
  function idbGet(key) {
    return idb().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readonly');
      const r = tx.objectStore(DB_STORE).get(key);
      r.onsuccess = () => resolve(r.result || null);
      r.onerror = () => reject(r.error);
    }));
  }
  function idbDel(key) {
    return idb().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).delete(key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    }));
  }

  let folderHandle = null;
  // THE FACTS A REPORT NEEDS about a folder that will not stay connected, and the reason they
  // are recorded rather than asked for on demand: what matters is what the browser said ON
  // LOAD, before anything was tapped, and by the time anyone opens the menu to report it that
  // moment is gone. Chrome documents that an installed app keeps file permission without
  // asking again; Harold's does not, and nothing in this app could say whether the handle came
  // back, what the browser answered, or whether it even considers itself installed.
  let folderFound = null;      // was a handle in storage at all
  let folderStateAtLoad = null;
  let folderStateAfterAsk = null;

  async function handleState(h) {
    if (!h || !h.queryPermission) return 'unsupported';
    try { return await h.queryPermission({ mode: 'read' }); } catch (e) { return 'prompt'; }
  }

  // Depth-first with both caps enforced, because a music folder is exactly the kind of thing
  // that turns out to have a backup of itself inside it.
  async function readFolder(dir, depth, out) {
    if (depth > FOLDER_MAX_DEPTH || out.length >= FOLDER_MAX_FILES) return out;
    const dirs = [];
    for await (const [name, entry] of dir.entries()) {
      if (out.length >= FOLDER_MAX_FILES) break;
      if (entry.kind === 'file') {
        if (/\.(mp3|m4a|aac|ogg|opus|wav|flac)$/i.test(name)) out.push(entry);
      } else if (entry.kind === 'directory') {
        dirs.push(entry);
      }
    }
    for (const d of dirs) {
      if (out.length >= FOLDER_MAX_FILES) break;
      await readFolder(d, depth + 1, out);
    }
    return out;
  }

  // THE FIVE SECONDS Harold watched after granting access were this function calling getFile()
  // on every handle before showing anything. 169 round trips to the file system, all of them to
  // build blob URLs for tracks nobody had asked to play yet, and none of them needed until one
  // is pressed. Now the queue is built from the HANDLES — which the listing already has — and a
  // file is fetched at the moment it is played. The folder appears as soon as it is listed.
  //
  // What is left is the listing itself, which cannot be skipped and is not instant on a big
  // folder, so it says what it is doing while it does it. Dead air that a person cannot tell
  // from a hang is the thing to avoid, not the time itself.
  async function loadFolder(h) {
    busy(true, 'Looking through ' + (h.name || 'the folder') + '…');
    let handles;
    try { handles = await readFolder(h, 1, []); }
    catch (e) { busy(false); folderNote('That folder could not be read.', true); return; }
    if (!handles.length) { busy(false); folderNote('No playable audio in that folder.', true); return; }
    busy(true, 'Found ' + handles.length + ' tracks…');
    adoptHandles(handles);
    writeNames(handles.map((fh) => fh.name.replace(/\.[^.]+$/, '')));
    busy(false);
    const capped = handles.length >= FOLDER_MAX_FILES;
    folderNote(handles.length + ' from ' + (h.name || 'your folder')
      + (capped ? ' — the first ' + FOLDER_MAX_FILES + ', which is this app\'s limit.' : '.'));
    paintFolder();
  }

  // The same shape adopt() produces, minus the one expensive part. `url` is filled in on play.
  function adoptHandles(handles) {
    failRun = 0;                    // a new folder is a fresh start, whatever the last one did
    readyNote(handles.length);
    queue.forEach((t) => { if (t.url && !t.link) { try { URL.revokeObjectURL(t.url); } catch (e) {} } });
    queue = handles
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
      .map((fh) => ({ name: fh.name.replace(/\.[^.]+$/, ''), handle: fh }))
      .concat(readLinks().map(linkRow));
    current = -1;
    if (shuffleOn) buildOrder();
    renderQueue();
    paintLib();
    paintFolder();
    paintStageHint();
  }

  // One track, fetched the moment it is wanted. Returns false when the file has gone since the
  // folder was listed, which is a thing that happens and must not look like the app breaking.
  async function fillFile(t) {
    if (t.file || !t.handle) return !!t.file;
    try {
      const f = await t.handle.getFile();
      t.file = f;
      t.url = URL.createObjectURL(f);
      return true;
    } catch (e) { return false; }
  }

  // The busy state, in the one place on screen that is always visible whatever the player size.
  function busy(on, msg) {
    const bar = $('busyBar');
    if (!bar) return;
    setHidden(bar, !on);
    if (on) $('busyText').textContent = msg || 'Working…';
  }

  function folderNote(msg, bad) {
    const el = $('folderNote');
    if (!el) return;
    el.textContent = msg || '';
    setHidden(el, !msg);
    el.classList.toggle('bad', !!bad);
  }

  const installed = () => {
    try { return matchMedia('(display-mode: standalone)').matches === true; } catch (e) { return false; }
  };

  // Durable storage, asked for once. This does NOT keep the permission — that is Chrome's own
  // decision, below — it keeps the stored HANDLE from being evicted when the phone is short of
  // space, which would lose the folder in a way no prompt would explain.
  let storagePersisted = null;      // null until asked: 'unknown' is an honest diagnostic

  async function askPersist() {
    try {
      if (!navigator.storage || !navigator.storage.persist) return;
      if (await navigator.storage.persisted()) { storagePersisted = true; return; }
      storagePersisted = await navigator.storage.persist();
    } catch (e) { /* not supported, or refused; neither is worth a message */ }
  }

  async function pickFolder() {
    if (!canRemember()) { $('filePick').click(); return; }
    let h;
    try { h = await window.showDirectoryPicker({ id: 'hive-pocket-music', mode: 'read' }); }
    catch (e) { return; }                    // they cancelled, which is not an error
    folderHandle = h;
    // NOT a silent catch. Remembering can fail for real reasons — private browsing, a storage
    // quota, a browser with the picker but no usable IndexedDB — and the whole feature is the
    // promise that this folder comes back. A promise that quietly did not happen is worse than
    // one never made, and this is the same swallowed-exception shape that cost a release in
    // 1.21.0. The music still loads either way; only the remembering is reported lost.
    let remembered = true;
    try { await idbPut(DB_KEY, h); } catch (e) { remembered = false; }
    if (remembered) askPersist();
    await loadFolder(h);
    if (!remembered) {
      folderHandle = null;
      paintFolder();
      folderNote('Playing, but this browser would not let the app remember the folder — you will '
               + 'have to choose it again next time.', true);
    }
  }

  // Called on load. Reads with no tap when permission survived, and otherwise offers the button
  // rather than firing a request that the browser will refuse without a gesture.
  async function resumeFolder() {
    if (!canRemember()) return;
    let h = null;
    try { h = await idbGet(DB_KEY); } catch (e) { folderFound = 'error'; return; }
    folderFound = !!h;
    if (!h) return;
    folderHandle = h;
    const state = await handleState(h);
    folderStateAtLoad = state;
    paintFolder();
    if (state === 'granted') { await loadFolder(h); return; }
    // Locked, not lost. The names come back now and the files come back on the first touch.
    showPending();
    armAutoReconnect();
    if (state === 'denied') { folderNote('Your music folder is remembered, but this browser is '
      + 'blocking it. Choose it again to reconnect.', true); return; }
    // WHY THIS SENTENCE EXISTS. Harold reconnected and then had to reconnect again — correctly,
    // because Chrome's permission prompt has three answers and the default one is for this visit
    // only. The app knew a tap was needed and said so, and said nothing about the choice inside
    // that tap, which is the whole difference between one tap now and one tap forever. Naming
    // the button in the browser's own prompt is not clutter; it is the instruction.
    // WORDED FOR WHAT IS TRUE rather than for what Chrome documents. Chrome's own guidance says
    // an installed app keeps file permission without asking again; on Harold's phone it asks
    // every time anyway. Promising "it stops asking" to someone it keeps asking is worse than
    // saying nothing, so the promise is gone and the option is named as something to try.
    folderNote('Your music folder is remembered — one tap brings it back. If Chrome offers '
             + '"Allow on every visit", taking it may stop the asking; some phones ask every '
             + 'time regardless, and that is the browser rather than this app.');
  }

  // AS CLOSE TO AUTOMATIC AS THE PLATFORM ALLOWS. Android will not carry a file grant across a
  // cold start — Harold's own report proved that — and requestPermission() needs a gesture, so a
  // page can never reach the folder on its own. What it CAN do is stop making the gesture a
  // separate errand: the FIRST touch anywhere in the app, whatever it was for, is enough
  // activation, so the folder comes back on the first thing the person does rather than on a
  // button they have to find and understand first.
  //
  // Once per load, only while a folder is actually waiting, and it never swallows the touch —
  // the tap does its own job as well. The permission sheet is Chrome's and still appears; what
  // is gone is having to ask for it deliberately.
  let autoTried = false;
  let autoArmed = false;
  // THE FIRST TOUCH ON A PHONE DOES NOT COUNT, and that was the whole of "denied". This listened
  // on pointerdown because it arrives first and a drag never becomes a click. On a mouse that is
  // fine; on a touch screen a pointerdown carries NO user activation — the browser hands
  // activation out on pointerup and touchend for a finger, on pointerdown only for a mouse — so
  // the very first touch on Harold's phone called requestPermission() at a moment the browser
  // was not allowed to show a sheet. Chrome does not throw for that; it resolves 'denied' and
  // shows nothing. The app recorded "denied", told him the browser was blocking the folder, and
  // told him to choose it again. He had denied nothing. He had never been asked.
  //
  // So the trap now listens on the events that carry activation for a finger as well as a mouse,
  // and — the part that makes it honest — ASKS THE BROWSER WHETHER IT HAS ACTIVATION before
  // spending the one attempt. navigator.userActivation.isActive is exactly that question. With
  // no activation it records that it did not ask, stays armed, and the next qualifying event
  // tries again; a 'denied' in the report now means a person or a policy said no.
  //
  // WHAT STOPS BEING VISIBLE: on a browser without navigator.userActivation the check is skipped
  // and the old behaviour stands. That is every current Chrome, Edge, Safari and Firefox
  // answering yes, so in practice nothing.
  function hasGesture() {
    try {
      const ua = navigator.userActivation;
      if (ua && typeof ua.isActive === 'boolean') return ua.isActive;
    } catch (e) {}
    return true;
  }
  function armAutoReconnect() {
    if (autoTried || autoArmed) return;
    autoArmed = true;
    const go = (ev) => {
      if (autoTried) return;
      if (!folderHandle) return;
      if (queue.some((t) => t.file || t.handle)) return;   // already loaded; nothing to do
      // A mouse has activation from pointerdown; a finger only from pointerup. Waiting for the
      // right one costs a mouse nothing and is the difference between asking and pretending.
      if (ev && ev.type === 'pointerdown' && ev.pointerType && ev.pointerType !== 'mouse') return;
      if (!hasGesture()) { folderStateAfterAsk = 'not asked (no gesture on ' + (ev ? ev.type : '?') + ')'; return; }
      autoTried = true;
      reconnectFolder();
    };
    for (const t of ['pointerdown', 'pointerup', 'keydown']) {
      document.addEventListener(t, go, { capture: true });
    }
  }

  // SAY WHAT ANDROID IS ABOUT TO SAY, before it says it. Harold pressed PLAY and got a system
  // sheet asking to "allow to copy and view the files" — the operating system's words for
  // opening a folder, and alarming ones to meet with no warning when all you did was press play
  // on your own music. The app knew the prompt was coming and said "Reconnecting…", which
  // explains nothing about a dialog that sounds like it is about to take something.
  //
  // On the stage rather than in the now-playing line, because the now-playing line is hidden in
  // the minimized player and this has to be readable at every size.
  // A LATCH, not just an assignment. The first cut wrote the warning and something else
  // repainted the hint within a few hundred milliseconds — the hint is written from half a dozen
  // places and any of them wins by arriving later. Hunting the caller would fix this instance;
  // the latch fixes the class, because a warning about a dialog that is ON SCREEN RIGHT NOW must
  // outlive every routine repaint by definition. paintStageHint() returns early while it is set.
  let promptWarning = false;

  // A LATCH THAT CANNOT STICK. It outranks every routine repaint, which is the point, and that
  // is exactly why it needs a way out that does not depend on the permission answering: a
  // requestPermission() that never settles — a dialog dismissed by the system, a tab backgrounded
  // mid-prompt — would otherwise freeze the stage hint on a warning about a dialog that is no
  // longer there, for the life of the page. Twelve seconds is far longer than any real answer
  // takes and far shorter than anyone would stare at a stale line.
  let promptTimer = 0;

  function sayPromptComing() {
    const el = $('stageHint');
    if (!el) return;
    promptWarning = true;
    clearTimeout(promptTimer);
    promptTimer = setTimeout(() => { promptWarning = false; paintStageHint(); }, 12000);
    setHidden(el, false);
    el.textContent = 'Android is about to ask to "copy and view files". That is its wording for '
      + 'opening your music folder — nothing is copied anywhere, and this app has no way to send '
      + 'anything. Allow it and your music comes straight back.';
  }

  async function reconnectFolder() {
    if (!folderHandle) return;
    // The same check on the deliberate path, so a call that arrives with no gesture — a promise
    // chain that awaited something first, a synthetic click — records what it is instead of a
    // denial nobody made. It does not show the Android warning either: there is no sheet coming.
    if (!hasGesture()) {
      folderStateAfterAsk = 'not asked (no gesture)';
      folderNote('Tap any track, or the folder button, to bring the music back.');
      return;
    }
    sayPromptComing();
    let ok = 'denied';
    try { ok = await folderHandle.requestPermission({ mode: 'read' }); }
    catch (e) { ok = 'error: ' + (e && e.name ? e.name : 'unknown'); }
    folderStateAfterAsk = ok;
    promptWarning = false;          // answered: the hint goes back to whatever it should say
    clearTimeout(promptTimer);
    paintStageHint();
    if (ok === 'granted') askPersist();
    // Asking again is allowed and is the ordinary way back from a mis-tap on the sheet; choosing
    // the folder again is the last resort, not the first instruction.
    if (ok !== 'granted') { folderNote('The folder was not allowed. Tap any track to ask again, '
      + 'or choose the folder again from the folder button.', true); return; }
    await loadFolder(folderHandle);
  }

  // The queue as it looks before the tap: every track by name, none of them playable yet, and
  // pressing any of them IS the tap — so the reconnect is something you do by reaching for the
  // music rather than a chore standing in front of it.
  function showPending() {
    const names = readNames();
    if (!names.length) return;
    if (queue.some((t) => t.file || t.handle)) return;   // a real folder is loaded; leave it alone
    queue = names.map((n) => ({ name: n, pending: true }))
      .concat(readLinks().map(linkRow));
    current = -1;
    if (shuffleOn) buildOrder();
    renderQueue();
    paintLib();
    paintFolder();
    paintStageHint();
  }

  async function forgetFolder() {
    folderHandle = null;
    writeNames([]);
    queue = queue.filter((t) => !t.pending);
    renderQueue();
    try { await idbDel(DB_KEY); } catch (e) {}
    folderNote('Forgotten. The app will ask for music again next time.');
    paintFolder();
  }

  // Chrome hands this over once, and only when the app is installable. It is kept rather than
  // acted on, because an install prompt fired at someone who did not ask for it is the thing
  // everyone hates about web apps.
  let installEvent = null;

  function paintInstall() {
    const row = $('installRow');
    if (!row) return;
    // The button needs Chrome to have handed over a beforeinstallprompt, which it does once it
    // has decided the site qualifies — a visit or two, sometimes — and which iOS never does at
    // all. So the button was missing exactly when someone was most likely to be hunting for it,
    // and the app said nothing. THE INSTRUCTIONS SHOW WHENEVER THE BUTTON CANNOT: not installed,
    // no prompt in hand. Installed, both are pointless and both go.
    const can = !!installEvent;
    const already = installed();
    setHidden(row, already || !can);
    setHidden($('installHow'), already || can);
  }

  async function doInstall() {
    if (!installEvent) return;
    const ev = installEvent;
    installEvent = null;
    paintInstall();
    try { ev.prompt(); await ev.userChoice; } catch (e) {}
  }

  function paintFolder() {
    const grp = $('folderGrp');
    if (grp) setHidden(grp, !canRemember());
    const rec = $('folderReconnect');
    if (rec) setHidden(rec, !folderHandle);
    const forget = $('folderForget');
    if (forget) forget.disabled = !folderHandle;
    const name = $('folderName');
    if (name) {
      name.textContent = folderHandle
        ? 'Remembered: ' + (folderHandle.name || 'a folder')
        : 'No folder remembered yet.';
    }
    // The same offer on the stage, where someone who never opens the menu will see it.
    const bar = $('reconnectBar');
    if (bar) setHidden(bar, !(folderHandle && !queue.some((t) => t.file || t.handle)));
    document.body.classList.toggle('has-pending', queue.some((t) => t.pending));
  }

  function saveNote(msg, bad) {
    const el = $('linkNote');
    el.textContent = msg || '';
    setHidden(el, !msg);
    el.classList.toggle('bad', !!bad);
  }

  function addLink(raw) {
    const u = String(raw || '').trim();
    if (!u) return;
    if (!safeUrl(u)) { saveNote(whyBad(u), true); return; }
    // Refused at the door rather than saved as a row that cannot play. The microphone is a real
    // answer here and not a consolation: it is how this app visualises anything it cannot read.
    if (isDeadLink(u)) {
      saveNote('YouTube was removed from this app — its sound comes from another site and the '
             + 'equalizer and effects could never see it. Play it in the YouTube app out loud '
             + 'and press Listen, and the visuals follow it properly.', true);
      return;
    }
    const links = readLinks();
    if (links.some((l) => l.url === u)) { saveNote('That link is already saved.'); return; }
    const entry = { name: nameFromUrl(u), url: u };
    links.push(entry);
    writeLinks(links);
    queue.push(linkRow(entry));
    renderQueue();
    $('linkInput').value = '';
    saveNote('Saved. It will still be here next time you open the app.');
    paintLib();
  }

  function paintLib() {
    const files = queue.filter((t) => !t.link).length;
    const links = queue.filter((t) => t.link).length;
    const bits = [];
    if (files) bits.push(files + ' from this device');
    if (links) bits.push(links + ' saved link' + (links === 1 ? '' : 's'));
    // Empty, not "No music picked yet". This app does not need music — the microphone and a
    // finger both work with an empty queue — so a line announcing an absence described a
    // problem the person did not have, in the one place on screen that is always visible.
    // An empty slot says nothing, which is correct, and the version chip beside it stays.
    $('libNote').textContent = bits.length ? bits.join(' · ') : '';
  }

  // ── Settings sheet ───────────────────────────────────────────────────────────────────
  // The OS asking for reduced motion is a real signal, but it is a DEFAULT and picking storm by
  // name is a decision. A default does not get to overrule a decision that came after it, so this
  // says so rather than silently forcing the picker back to stars — which would look like the
  // setting was broken. The default is already a non-flashing mode; nothing here needs vetoing.
  function reducedMotion() {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches === true; }
    catch (e) { return false; }
  }

  function paintLook() { const el = $('lookSel'); if (el) el.value = currentLook(); }

  function paintSheet() {
    $('ambientSel').value = readAmbient();
    $('beatSel').value = readBeatEffect();
    $('sensSel').value = readSens();
    $('punchSel').value = readPunch();
    $('playerSel').value = readPlayer();
    $('driveSel').value = readDrive();
    $('touchSel').value = readTouch();
    $('qualSel').value = readQualitySetting();
    paintAuto();
    $('reportText').value = readReport();
    paintDiag();
    reportSaid('');
    $('palSel').value = readPalette();
    $('eqSel').value = readEqStyle();
    paintLook();
    $('visualsSel').value = visuals;
    setHidden($('motionNote'), !reducedMotion());
    const n = readLinks().length;
    $('linkCount').textContent = n ? (n + ' saved. They come back every time you open the app.') : 'None saved.';
    $('forgetLinks').disabled = !n;
    $('aboutVer').textContent = 'beta ' + VERSION.replace(/-beta$/, '');
    buildAdvanced();
  }
  function openSheet() {
    paintSheet();
    if (!$('tut').hidden) requestAnimationFrame(tutPlace);
    setHidden($('sheetBack'), false); setHidden($('sheet'), false);
    $('menuBtn').setAttribute('aria-expanded', 'true');
    $('sheetClose').focus();
  }
  function closeSheet() {
    setHidden($('sheetBack'), true); setHidden($('sheet'), true);
    if (!$('tut').hidden) requestAnimationFrame(tutPlace);
    $('menuBtn').setAttribute('aria-expanded', 'false');
    $('menuBtn').focus();
  }

  // ── Reporting a problem ──────────────────────────────────────────────────────────────
  // A visualizer with no server still has to be able to say when it is broken, and the person
  // saying so is usually not the person who can read a console. So the app assembles the report
  // itself: what they typed, plus the state that actually explains a bug on a phone.
  //
  // NOTHING IS SENT FROM HERE. mailto: hands the text to whatever mail app the phone uses and
  // that app sends it, after the person presses send in it — so the app keeps the property it
  // gained when YouTube went: it never opens a connection itself. Copy is the fallback for a
  // phone with no mail app configured, which is common enough to need a real answer rather than
  // a button that silently does nothing.
  //
  // WHAT IS DELIBERATELY NOT IN A REPORT: the names of their music, their saved link addresses,
  // and what is playing. A bug report is not a reason to hand over a library, and a diagnostic
  // block nobody dares read is worse than none. It is shown in full, in the sheet, before it can
  // be sent.
  const REPORT_KEY = 'hive-pocket.report';

  // Split so the address is not a literal string in the served file. This stops a crawler that
  // only reads source; it does NOT stop one that runs the page, and it is not claimed to.
  const REPORT_TO = ['hjharding', '@', 'gmail', '.', 'com'].join('');

  function readReport() {
    try { return localStorage.getItem(REPORT_KEY) || ''; } catch (e) { return ''; }
  }
  function writeReport(v) { try { localStorage.setItem(REPORT_KEY, v); } catch (e) {} }

  function diagnostics() {
    const L = [];
    const add = (k, v) => L.push(k + ': ' + v);
    add('app', VERSION);
    try { add('page', location.href.split('?')[0]); } catch (e) {}
    add('when', new Date().toISOString());
    L.push('');
    add('look', currentLook());
    add('bursts', readBeatEffect());
    add('reacts to', readDrive());
    add('finger', readTouch());
    add('background', readAmbient());
    add('colours', readPalette() + (readPalette() === 'random' ? ' (rolled ' + eqPaletteNow + ')' : ''));
    add('equalizer', readEqStyle() + (readEqStyle() === 'random' ? ' (rolled ' + eqShapeNow + ')' : ''));
    add('sensitivity', readSens());
    add('size', readPunch());
    add('performance', readQualitySetting()
      + (readQualitySetting() === 'auto'
         ? ' (running ' + readQuality() + ', measured ' + (autoFps || '?') + ' fps, seed '
           + seedTier() + ')' : ''));
    try { add('cores', navigator.hardwareConcurrency || 'unknown'); } catch (e) {}
    try { add('memory', (navigator.deviceMemory || 'unknown') + ' GB'); } catch (e) {}
    // Only what has been MOVED, never all twenty-six: a report listing defaults is a report
    // nobody reads to the end, and the whole question is what is not standard.
    const advAll = readAdv();
    const moved = [];
    for (const [which, specs] of [['eq', ADV_EQ], ['fx', ADV_FX]]) {
      for (const spec of specs) {
        const v = dig(advAll[which] || {}, spec.k);
        if (v !== undefined && String(v) !== String(dig(advDefaults(which), spec.k))) {
          moved.push(which + '.' + spec.k + '=' + v);
        }
      }
    }
    add('advanced', moved.length ? moved.join(', ') : 'all default');
    add('on the stage', visuals);
    add('player', readPlayer());
    L.push('');
    add('listening', micLive);
    add('listen on open', readMicAuto());
    // Named for what it is. It reported `false` on a healthy app that was listening to the room
    // and drawing at 60 frames a second, because this graph is the FILE path and the microphone
    // has its own — so the one line in a bug report that looked like a smoking gun was not one.
    // A diagnostic that reads as a fault when nothing is wrong costs more than a missing line.
    add('file audio graph', !!(ctx && analyser && srcNode)
      ? 'built' : (micLive ? 'not built (microphone in use, which has its own)' : 'not built'));
    add('screen awake', !!wakeLock);
    add('queue length', queue.length);          // a count, never the contents
    add('saved links', readLinks().length);     // likewise
    add('can remember a folder', canRemember());
    add('folder remembered', !!folderHandle);   // whether, never which
    add('folder handle in storage', folderFound === null ? 'not looked' : folderFound);
    add('folder permission on load', folderStateAtLoad || 'not checked');
    add('folder permission after asking', folderStateAfterAsk || 'not asked');
    // A value tracked when it is learned rather than fetched here: diagnostics() is called from
    // a keystroke handler and must stay synchronous, and a promise resolving into a block that
    // has already been rendered is how a diagnostic starts lying.
    add('storage persisted', storagePersisted === null ? 'unknown' : storagePersisted);
    add('installed as an app', installed());
    try {
      const s = fx && fx.stats ? fx.stats() : null;
      if (s) add('drawing', 'parts ' + s.parts + ', background ' + s.ambient + ', bolts ' + fbolts.length);
    } catch (e) {}
    // The whole life of the wisp layer on one line, which is the only honest way to answer
    // "no wisps" from a phone nobody here can touch.
    add('wisps', 'out ' + fairies.filter((f) => f.roam).length + ' of ' + fairies.length
      + ', gestures ' + wispLog.gestures + ', sent ' + wispLog.spawned
      + ', dismissed ' + wispLog.dismissed
      + (wispLog.refused ? ', REFUSED: ' + wispLog.refused : '')
      + ', effects turned on by a finger ' + wispLog.turnedOn
      + ', reflows ' + wispLog.reflows + ', tails dropped ' + wispLog.tailDrops);
    add('wisp box', boltW + 'x' + boltH + ' bitmap ' + (boltCv ? boltCv.width + 'x' + boltCv.height : 'none')
      + ', canvas ' + (boltCv ? (boltCv.hidden ? 'hidden' : 'shown') : 'not found')
      + ', loop ' + (boltRaf ? 'running' : 'stopped'));
    add('wisp tails', JSON.stringify(fairies.map((f) => f.trail.length / 2)));
    L.push('');
    try { add('screen', innerWidth + 'x' + innerHeight + ' @' + (devicePixelRatio || 1)); } catch (e) {}
    add('reduced motion', reducedMotion());
    try { add('online', navigator.onLine); } catch (e) {}
    try { add('installed', matchMedia('(display-mode: standalone)').matches); } catch (e) {}
    try { add('secure context', window.isSecureContext === true); } catch (e) {}
    try {
      add('service worker', 'serviceWorker' in navigator
        ? (navigator.serviceWorker.controller ? 'controlling' : 'registered, not controlling')
        : 'unsupported');
    } catch (e) {}
    try { add('browser', navigator.userAgent); } catch (e) {}
    return L.join('\n');
  }

  function reportBody() {
    const said = ($('reportText').value || '').trim();
    return (said || '(nothing written)') + '\n\n--- what the app can see ---\n' + diagnostics();
  }
  function reportSaid(msg, bad) {
    const el = $('reportSaid');
    el.textContent = msg || '';
    setHidden(el, !msg);
    el.classList.toggle('bad', !!bad);
  }
  function paintDiag() { const el = $('reportDiag'); if (el) el.textContent = diagnostics(); }

  // A mailto: URL is a URL, and some phones and mail apps quietly truncate or refuse a long one
  // — quietly being the problem, since a report that arrives with its last paragraph missing
  // looks like the person wrote less than they did. So the app trims it ITSELF and says so.
  //
  // WHAT STOPS BEING VISIBLE, since this is a threshold: past this length the email carries the
  // first part of what was typed and a line saying it was cut. Nothing is lost silently, and
  // Copy has no limit at all — which is what the message points at.
  const MAILTO_MAX = 1800;
  const TRIM_NOTE = '\n\n[...cut here to fit an email link. Use "Copy instead" in the app for '
                  + 'the whole thing.]';

  function sendReport() {
    const subject = 'Hive Pocket ' + VERSION + ' — report';
    const build = (body) => 'mailto:' + REPORT_TO
      + '?subject=' + encodeURIComponent(subject)
      + '&body=' + encodeURIComponent(body);
    let body = reportBody();
    let trimmed = false;
    if (build(body).length > MAILTO_MAX) {
      // The DIAGNOSTICS are kept whole and the typed text is what gives ground: the diagnostics
      // are the part that cannot be typed out again from memory.
      const parts = body.split('\n\n--- what the app can see ---\n');
      const tail = '\n\n--- what the app can see ---\n' + (parts[1] || '');
      const room = Math.max(120, MAILTO_MAX - build(tail).length - TRIM_NOTE.length - 40);
      body = (parts[0] || '').slice(0, room) + TRIM_NOTE + tail;
      trimmed = true;
    }
    // A phone with no mail app does nothing visible here and gives no error, so say what should
    // have happened rather than leaving a button that looks broken.
    try { location.href = build(body); } catch (e) {}
    reportSaid('Your mail app should be opening with all of this in it. Nothing has been sent '
             + 'yet — you press send there. If nothing opened, use Copy instead.'
             + (trimmed ? ' What you wrote was long, so the email carries the start of it and '
                        + 'says where it was cut — Copy has no limit.' : ''),
             trimmed);
  }

  async function copyReport() {
    const text = reportBody();
    try {
      await navigator.clipboard.writeText(text);
      reportSaid('Copied. Paste it wherever you like — nothing left this phone on its own.');
      return;
    } catch (e) { /* denied, or no clipboard on this browser */ }
    // The documented fallback, not a silent failure: select it so one long-press copies it.
    try {
      const el = $('reportDiag');
      $('diagGrp').open = true;
      el.textContent = text;
      const r = document.createRange();
      r.selectNodeContents(el);
      const s = window.getSelection();
      s.removeAllRanges();
      s.addRange(r);
      reportSaid('This phone would not let the app use the clipboard, so the whole report is '
               + 'selected below instead — copy it from there.', true);
    } catch (e2) {
      reportSaid('This phone would not let the app copy. Open the details below and copy the '
               + 'text by hand.', true);
    }
  }

  // ── The tutorial ─────────────────────────────────────────────────────────────────────
  // This app opens on a black rectangle and two rows of unlabelled icons, and the two things
  // that make it worth having — the microphone, and touching the stage — are invisible until
  // someone tells you. Every earlier attempt to fix that by writing more on the stage made the
  // stage worse. So: seven steps, once, pointing at the real controls.
  //
  // A RING AROUND THE ACTUAL BUTTON rather than a picture of one. A screenshot of the app inside
  // the app is unreadable at this size, and a ring needs no translating. The position is measured
  // from the element every step and again on resize or rotation, so it cannot drift.
  //
  // The card moves to whichever half of the screen the ring is NOT in, which is the whole reason
  // the position is computed rather than written down.
  const TUT_KEY = 'hive-pocket.tutorial';
  const TUT = [
    { title: 'This is a visualizer',
      body: 'It draws whatever it can hear. Music on this phone is one way to feed it, and not '
          + 'the only one — it works with no music at all. Seven quick steps.' },
    { at: '#stage', title: 'The stage',
      body: 'Everything is drawn here. Tap it for full screen, and tap again to come back. '
          + 'Drag a finger across it and it paints — that works right now, with silence. Two '
          + 'fingers send a pair of wisps wandering off; two fingers again sends them away.' },
    { at: '#micBtn', title: 'Listen to the room', menu: true,
      body: 'The microphone is the big one. Play music out loud from anything — this phone, a '
          + 'speaker, a laptop, the radio — press this, and the visuals follow it. It is the only '
          + 'way to see sound this app cannot read, and nothing you hear is recorded or sent.' },
    { at: '#pickBtn', title: 'Or your own files',
      body: 'Choose music from this phone. The folder is remembered — your tracks are listed '
          + 'again the moment you open the app. Android will not carry the PERMISSION across a '
          + 'cold start, so the first thing you touch asks for it back and the music returns.' },
    { at: '#menuBtn', title: 'Looks',
      body: 'Settings opens here. Start with Look at the top — one tap sets the bursts, the '
          + 'colours, the equalizer and the background together. The dropdowns underneath are '
          + 'there when you want to take one apart.' },
    { at: '#rollBtn', title: 'Surprise me',
      body: 'Rolls all of it at once. It is the fastest way to find a combination worth keeping, '
          + 'and it never picks the two that flash the screen — those you choose by name.' },
    { title: 'That is everything',
      body: 'The menu has How it works if you want more, and Report a problem when something '
          + 'is wrong. Show me around brings this back any time.' },
  ];

  let tutAt = -1;

  function tutSeen() {
    try { return localStorage.getItem(TUT_KEY) === VERSION; } catch (e) { return true; }
  }
  // Stamped with the VERSION, not a bare 'true': a rewritten tutorial should be able to run
  // again for someone who saw an older one, without a second key to keep in step.
  function tutMarkSeen() { try { localStorage.setItem(TUT_KEY, VERSION); } catch (e) {} }

  function tutPlace() {
    const step = TUT[tutAt];
    const ring = $('tutRing'), wrap = $('tut');
    // THE SHEET OWNS THE BOTTOM OF THE SCREEN, always, and its Done button is the last thing in
    // it. A card resting at the bottom sits exactly on top of that, so with the menu open the
    // menu could not be closed. Caught by clicking Done in a test rather than by looking at it.
    const sheetUp = !$('sheet').hidden;
    if (!step || !step.at) {
      setHidden(ring, true);
      wrap.classList.add('plain');
      wrap.classList.toggle('top', sheetUp);
      return;
    }
    const el = document.querySelector(step.at);
    const r = el && el.getBoundingClientRect();
    // A target that is not on screen gets the plain card rather than a ring floating over
    // nothing. THE SECOND HALF OF THIS TEST IS THE ONE THAT MATTERED: a control inside the
    // scrolled settings sheet has a perfectly good width and height while sitting hundreds of
    // pixels above the viewport, so the ring was drawn off-screen and the card said "press
    // this" with nothing highlighted anywhere. Caught by screenshotting every step rather than
    // by asserting a ring existed — it did exist, just not where anyone could see it.
    const onScreen = r && r.width && r.height
      && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
    if (!onScreen) {
      setHidden(ring, true);
      wrap.classList.add('plain');
      wrap.classList.toggle('top', sheetUp);
      return;
    }
    wrap.classList.remove('plain');
    setHidden(ring, false);
    const pad = 6;
    ring.style.top = (r.top - pad) + 'px';
    ring.style.left = (r.left - pad) + 'px';
    ring.style.width = (r.width + pad * 2) + 'px';
    ring.style.height = (r.height + pad * 2) + 'px';
    // Card to the opposite half, so it never sits on the thing it is pointing at — unless the
    // sheet is open, in which case the bottom is spoken for whatever the ring is doing.
    const mid = (r.top + r.height / 2) / Math.max(1, innerHeight);
    wrap.classList.toggle('top', sheetUp || mid > 0.55);
  }

  function tutShow(i) {
    tutAt = Math.max(0, Math.min(TUT.length - 1, i));
    const step = TUT[tutAt];
    // A step about something in the menu opens the menu, so the ring has something to sit on.
    if (step.menu) { if ($('sheet').hidden) openSheet(); }
    else if (!$('sheet').hidden) closeSheet();
    // ...and scrolls to it, because opening the sheet is not the same as showing the control.
    if (step.menu && step.at) {
      const t = document.querySelector(step.at);
      if (t && t.scrollIntoView) {
        try { t.scrollIntoView({ block: 'center', behavior: 'auto' }); } catch (e) { t.scrollIntoView(); }
      }
    }
    $('tutStep').textContent = (tutAt + 1) + ' of ' + TUT.length;
    $('tutTitle').textContent = step.title;
    $('tutBody').textContent = step.body;
    setHidden($('tutBack'), tutAt === 0);
    $('tutNext').textContent = tutAt === TUT.length - 1 ? 'Done' : 'Next';
    setHidden($('tut'), false);
    tutPlace();
    // Measured again after layout: scrollIntoView moves things, and the first measurement is
    // taken before the browser has applied it.
    requestAnimationFrame(() => { if (!$('tut').hidden && tutAt >= 0) tutPlace(); });
    $('tutNext').focus();
  }

  function tutStart() { tutShow(0); }
  function tutEnd() {
    setHidden($('tut'), true);
    setHidden($('tutRing'), true);
    tutAt = -1;
    tutMarkSeen();
    if (!$('sheet').hidden) closeSheet();
  }

  // ── Wiring ───────────────────────────────────────────────────────────────────────────
  $('menuBtn').addEventListener('click', () => ($('sheet').hidden ? openSheet() : closeSheet()));
  $('sheetClose').addEventListener('click', closeSheet);
  $('sheetBack').addEventListener('click', closeSheet);
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && !$('sheet').hidden) closeSheet(); });
  $('ambientSel').addEventListener('change', () => {
    const v = AMBIENTS.includes($('ambientSel').value) ? $('ambientSel').value : 'stars';
    writeAmbient(v);
    paintLook();
    // Live: the renderer takes a new config without restarting, so the change is visible while
    // the sheet is still open rather than on the next track.
    applyRenderers();
  });
  $('forgetLinks').addEventListener('click', () => {
    writeLinks([]);
    // Take them out of the queue too — the queue IS the library for links, and leaving them
    // playing after "forget all" would make the button look like it did nothing.
    queue = queue.filter((t) => !t.link);
    if (current >= queue.length) { teardown(); current = -1; paintPlay(); }
    renderQueue(); paintLib(); paintSheet();
  });

  $('lookSel').addEventListener('change', () => applyLook($('lookSel').value));
  $('surpriseBtn').addEventListener('click', surprise);
  // The same action from the header. It flashes what it landed on, because a roll that changes
  // the picture with no word for what it did leaves you unable to ask for it again.
  $('rollBtn').addEventListener('click', () => { surprise(); sayRoll(); });

  // Names what was just rolled, on the stage, briefly. Uses the existing hint element rather than
  // adding a second overlay: it is already the one thing on the stage that speaks.
  let rollTimer = 0;
  function sayRoll() {
    const el = $('stageHint');
    if (!el) return;
    setHidden(el, false);
    el.textContent = readBeatEffect() + ' · ' + readPalette() + ' · ' + readEqStyle()
      + (readAmbient() === 'off' ? '' : ' · ' + readAmbient());
    clearTimeout(rollTimer);
    rollTimer = setTimeout(paintStageHint, 1800);
  }
  $('eqSel').addEventListener('change', () => {
    writeEqStyle(EQ_STYLES.includes($('eqSel').value) ? $('eqSel').value : 'bars');
    applyRenderers(); paintLook();
  });
  $('palSel').addEventListener('change', () => {
    writePalette(PALETTES.includes($('palSel').value) ? $('palSel').value : 'hive');
    applyRenderers(); paintLook();
  });

  $('punchSel').addEventListener('change', () => {
    writePunch(PUNCH[$('punchSel').value] ? $('punchSel').value : 'normal');
    applyRenderers();
  });

  $('qualSel').addEventListener('change', () => {
    const v = $('qualSel').value;
    writeQuality(v === 'auto' || QUALITY[v] ? v : 'auto');
    // Leaving Auto for a fixed tier, or arriving at it, resets the measurement: the numbers
    // gathered under the old setting describe a different app.
    autoFrames.length = 0; autoGoodRun = 0; autoChangedAt = 0;
    if (v === 'auto') autoTier = seedTier();
    applyRenderers();
    paintAuto();
  });

  $('driveSel').addEventListener('change', () => {
    writeDrive(DRIVE[$('driveSel').value] ? $('driveSel').value : 'full');
    // No applyRenderers(): this is Pocket's own detector, not renderer config. The next frame
    // out of pump() already reads the new value.
  });

  $('reportText').addEventListener('input', () => {
    writeReport($('reportText').value);
    // The block is a live picture of the app, not a snapshot from when the sheet opened: a
    // person describing a bug usually changes something while describing it.
    paintDiag();
  });
  $('tutNext').addEventListener('click', () => {
    if (tutAt >= TUT.length - 1) { tutEnd(); return; }
    tutShow(tutAt + 1);
  });
  $('tutBack').addEventListener('click', () => tutShow(tutAt - 1));
  $('tutSkip').addEventListener('click', tutEnd);
  $('tutAgain').addEventListener('click', () => { closeSheet(); tutStart(); });
  // A rotation or a keyboard appearing moves every target. Measured again rather than trusted.
  for (const ev of ['resize', 'orientationchange']) {
    window.addEventListener(ev, () => { if (!$('tut').hidden) tutPlace(); });
  }
  document.addEventListener('keydown', (ev) => {
    if ($('tut').hidden) return;
    if (ev.key === 'Escape') { ev.preventDefault(); tutEnd(); }
    else if (ev.key === 'ArrowRight') { ev.preventDefault(); if (tutAt < TUT.length - 1) tutShow(tutAt + 1); }
    else if (ev.key === 'ArrowLeft') { ev.preventDefault(); if (tutAt > 0) tutShow(tutAt - 1); }
  });

  window.addEventListener('beforeinstallprompt', (ev) => {
    ev.preventDefault();          // ours to offer, at a moment that makes sense
    installEvent = ev;
    paintInstall();
  });
  window.addEventListener('appinstalled', () => { installEvent = null; paintInstall(); });
  $('installBtn').addEventListener('click', doInstall);

  $('folderPick').addEventListener('click', () => { closeSheet(); pickFolder(); });
  $('folderReconnect').addEventListener('click', () => { closeSheet(); reconnectFolder(); });
  $('folderForget').addEventListener('click', forgetFolder);
  $('reconnectBtn').addEventListener('click', reconnectFolder);

  $('reportSend').addEventListener('click', sendReport);
  $('reportCopy').addEventListener('click', copyReport);
  $('reportGrp').addEventListener('toggle', () => { if ($('reportGrp').open) paintDiag(); });

  $('touchSel').addEventListener('change', () => {
    const v = TOUCH_MODES.includes($('touchSel').value) ? $('touchSel').value : 'both';
    writeTouch(v);
    // A bolt still in the air when lightning is switched off would outlive the setting by a
    // fifth of a second and look like the switch failed. Wisps are untouched by it: this setting
    // is about what a FINGER does, and clearing them here took out ones the music had thrown.
    if (v === 'effect' || v === 'off') clearStrikes();
  });

  $('playerSel').addEventListener('change', () => {
    writePlayer($('playerSel').value);
    applyPlayer();
    paintStageHint();
  });
  // The one-tap version, on the player. Never reaches 'hidden': taking the transport away is a
  // decision, and a decision does not belong on a control you press without looking.
  $('miniBtn').addEventListener('click', () => {
    writePlayer(readPlayer() === 'mini' ? 'full' : 'mini');
    applyPlayer();
  });

  $('sensSel').addEventListener('change', () => {
    writeSens(SENS[$('sensSel').value] ? $('sensSel').value : 'easy');
    applyRenderers(); paintLook();
  });

  $('beatSel').addEventListener('change', () => {
    const v = BEAT_EFFECTS.includes($('beatSel').value) ? $('beatSel').value : 'fireworks';
    writeBeatEffect(v);
    applyRenderers(); paintLook();
  });

  $('micBtn').addEventListener('click', () => { if (micLive) micStop(); else micStart(true); });
  $('micAuto').addEventListener('change', () => {
    writeMicAuto($('micAuto').checked);
    // Ticking it is also a decision to listen NOW — otherwise the setting appears to do nothing
    // until the next cold start, which reads as broken.
    if ($('micAuto').checked && !micLive) micStart(true);
  });

  // A folder where the browser allows one, the old multi-file picker where it does not.
  $('pickBtn').addEventListener('click', () => {
    if (canRemember()) pickFolder(); else $('filePick').click();
  });
  $('linkBtn').addEventListener('click', () => {
    const row = $('linkRow');
    setHidden(row, !isHidden(row));      // the attribute is what CSS reads
    $('linkBtn').setAttribute('aria-expanded', row.hidden ? 'false' : 'true');
    if (!row.hidden) $('linkInput').focus();
  });
  $('linkAdd').addEventListener('click', () => addLink($('linkInput').value));
  $('linkInput').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); addLink($('linkInput').value); } });
  $('filePick').addEventListener('change', (e) => adopt(e.target.files));
  $('playBtn').addEventListener('click', toggle);
  $('nextBtn').addEventListener('click', () => next(false));
  $('prevBtn').addEventListener('click', prev);
  $('seek').addEventListener('input', () => {
    const v = Number($('seek').value);
    if (audio) audio.currentTime = v;
  });
  function paintModes() {
    const s = $('shuffleBtn');
    s.setAttribute('aria-pressed', shuffleOn ? 'true' : 'false');
    label('shuffleBtn', shuffleOn ? 'Shuffle on' : 'Shuffle off');
    const r = $('repeatBtn');
    r.setAttribute('aria-pressed', repeatMode !== 'off' ? 'true' : 'false');
    label('repeatBtn',
      repeatMode === 'one' ? 'Repeat one track' : repeatMode === 'all' ? 'Repeat the queue' : 'Repeat off');
    setHidden($('repeatOne'), repeatMode !== 'one');
  }
  $('shuffleBtn').addEventListener('click', () => {
    shuffleOn = !shuffleOn;
    if (shuffleOn) buildOrder(); else { order = null; orderPos = -1; }
    writeModes(); paintModes();
  });
  $('repeatBtn').addEventListener('click', () => {
    repeatMode = repeatMode === 'off' ? 'all' : repeatMode === 'all' ? 'one' : 'off';
    writeModes(); paintModes();
  });

  // Effects off means the equalizer alone; effects on means both. Turning them on from
  // "equalizer only" cannot land on "effects only", because that would take away the thing
  // that was on screen a moment ago.
  // ── Finger lightning ─────────────────────────────────────────────────────────────────
  // The renderer HAS lightning, but only as weather: bolts are scheduled internally by the storm
  // and lightning ambient modes, they pick their own x, and there is no public way to ask for one
  // at a point. fx-render.js renders into other people's streams and is not edited from here.
  //
  // So the bolt is drawn by Pocket, on its own canvas over the effects, using the renderer's own
  // exported geometry (boltPath) and palette sampling (stopsFor/sample) — the same shape and the
  // same colour maths, not a second implementation that will drift away from the house look.
  //
  // FLASHING, said plainly: this draws a bolt and a dim whole-frame flash. The renderer's hard
  // ceilings are copied down and made stricter here, and nothing in Settings can raise them.
  const BOLT_GAP = 110;         // ms between strikes along a drag
  const BOLT_FLASH_GAP = 420;   // ms between whole-frame flashes — four times the strike gap, so
                                // flashes can never stack however fast a finger moves
  const BOLT_FLASH_MAX = 0.10;  // dimmer than the renderer's own 0.12 ceiling
  const MAX_FINGER_BOLTS = 5;
  let boltCv = null, boltCtx = null, boltDpr = 1, boltW = 0, boltH = 0;
  // COUNTERS, NOT GUESSES. "No wisps" has at least five causes that look identical on a screen —
  // the gesture never reached the app, it reached it and was refused because the effects layer
  // is off, it spawned and the toggle cleared it, it spawned and a reflow cleared it, or it
  // spawned and is drawing with no tail. Three releases were spent guessing at the folder
  // question before one line from the phone settled it; this is that line, for this question.
  const wispLog = { gestures: 0, refused: '', spawned: 0, dismissed: 0, reflows: 0, tailDrops: 0,
                    turnedOn: 0 };
  let fbolts = [], boltRaf = 0, boltLast = 0, lastBoltAt = 0, lastFlashAt = 0;

  const rand = (a, b) => a + Math.random() * (b - a);

  function boltReady() {
    if (!boltCv) { boltCv = $('boltCanvas'); if (!boltCv) return false; }
    if (!boltCtx) { try { boltCtx = boltCv.getContext('2d'); } catch (e) { return false; } }
    return !!boltCtx;
  }

  // Same sizing rule the renderers use: cap the pixel ratio at 2, because 3 costs 2.25x the fill
  // for nothing anyone can see on a phone.
  function sizeBolt() {
    if (!boltReady()) return;
    boltDpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = boltCv.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width || boltCv.clientWidth || 300));
    const h = Math.max(1, Math.round(r.height || boltCv.clientHeight || 150));
    if (w !== boltW || h !== boltH || boltCv.width !== Math.round(w * boltDpr)) {
      boltW = w; boltH = h;
      boltCv.width = Math.round(w * boltDpr);
      boltCv.height = Math.round(h * boltDpr);
    }
  }

  // Mostly white with a cast of the palette, washed the same 75% of the way to white that the
  // renderer's own makeBolt() uses — a bolt that is fully 'fire' orange reads as a crack in the
  // screen rather than as light.
  function boltRgb() {
    try {
      const p = readPalette();
      const name = p === 'random' ? pick(CONCRETE) : p;
      const base = FxRender.sample(FxRender.stopsFor(name, null, null), 0.15);
      return base.map((c) => Math.round(c + (255 - c) * 0.75));
    } catch (e) { return [235, 240, 255]; }
  }

  function strike(nx, ny) {
    if (!boltReady()) return;
    const now = performance.now();
    if (now - lastBoltAt < BOLT_GAP) return;
    lastBoltAt = now;
    sizeBolt();
    const w = boltW, h = boltH;
    if (!w || !h) return;
    const tx = nx * w, ty = ny * h;
    // The trunk ENDS at the finger. Weather lightning ends wherever it likes; this one is being
    // aimed, and a bolt that stops short of the point you are touching does not read as aimed.
    const x0 = tx + rand(-w * 0.12, w * 0.12);
    const trunk = FxRender.boltPath(x0, rand(-12, h * 0.05), tx, ty, h * 0.07, 5);
    const branches = [];
    const n = 1 + Math.floor(Math.random() * 3);
    for (let i = 0; i < n; i++) {
      const at = trunk[2 + Math.floor(Math.random() * Math.max(1, trunk.length - 8))];
      if (!at) continue;
      branches.push(FxRender.boltPath(at[0], at[1],
        at[0] + rand(-w * 0.09, w * 0.09), at[1] + rand(h * 0.05, h * 0.16), h * 0.04, 3));
    }
    const life = rand(0.16, 0.26);
    // The flash is opted into per strike, not per bolt drawn, so a fast drag gets bolts at 110ms
    // and flashes at 420ms rather than one flash per bolt.
    let flash = false;
    if (now - lastFlashAt >= BOLT_FLASH_GAP && !reducedMotion()) { flash = true; lastFlashAt = now; }
    fbolts.push({ trunk, branches, rgb: boltRgb(), life, maxLife: life, tx, ty, flash });
    // Oldest first: a bolt that has been on screen longest is the one closest to gone anyway.
    while (fbolts.length > MAX_FINGER_BOLTS) fbolts.shift();
    if (!boltRaf) { boltLast = now; boltRaf = requestAnimationFrame(boltLoop); }
  }

  // Two strokes per polyline — wide and faint for the halo, narrow and bright for the core.
  // That is the renderer's no-shadowBlur rule; shadowBlur on a path this long is the one thing
  // that would actually cost frames here.
  function strokeBolt(pts, alpha, width) {
    if (!pts || pts.length < 2) return;
    boltCtx.beginPath();
    boltCtx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) boltCtx.lineTo(pts[i][0], pts[i][1]);
    boltCtx.globalAlpha = alpha * 0.35;
    boltCtx.lineWidth = width * 3.2;
    boltCtx.stroke();
    boltCtx.globalAlpha = alpha;
    boltCtx.lineWidth = width;
    boltCtx.stroke();
  }

  // Runs ONLY while a bolt is alive. An idle stage costs nothing — no timer, no rAF, no canvas
  // being cleared sixty times a second for an effect nobody triggered.
  function boltLoop() {
    boltRaf = 0;
    if (!boltCtx) return;
    const now = performance.now();
    const dt = Math.min(0.05, (now - boltLast) / 1000);
    boltLast = now;
    for (let i = fbolts.length - 1; i >= 0; i--) {
      fbolts[i].life -= dt;
      if (fbolts[i].life <= 0) fbolts.splice(i, 1);
    }
    stepFairies(dt, now);
    boltCtx.setTransform(boltDpr, 0, 0, boltDpr, 0, 0);
    boltCtx.clearRect(0, 0, boltW, boltH);
    // Cleared and stopped when BOTH are empty. Checking only the bolts left a live fairy with
    // no loop to move it — the first thing that went wrong when this was added.
    if (!fbolts.length && !fairies.length) return;
    boltCtx.globalCompositeOperation = 'lighter';
    boltCtx.lineJoin = 'round';
    boltCtx.lineCap = 'round';
    for (const b of fbolts) {
      const t = Math.max(0, Math.min(1, b.life / b.maxLife));
      const age = b.maxLife - b.life;
      const f = b.flash && age < 0.07 ? 1 - age / 0.07 : 0;
      if (f > 0) {
        boltCtx.globalAlpha = BOLT_FLASH_MAX * f;
        boltCtx.fillStyle = 'rgb(' + b.rgb[0] + ',' + b.rgb[1] + ',' + b.rgb[2] + ')';
        boltCtx.fillRect(0, 0, boltW, boltH);
      }
      boltCtx.strokeStyle = 'rgb(' + b.rgb[0] + ',' + b.rgb[1] + ',' + b.rgb[2] + ')';
      strokeBolt(b.trunk, t, 2.2);
      for (const br of b.branches) strokeBolt(br, t * 0.55, 1.3);
      // The strike point. A bolt that lands on nothing looks like it passed through the screen;
      // a bright spot where the finger is says it arrived.
      const r = Math.max(6, boltH * 0.045) * (0.6 + t * 0.4);
      try {
        const g = boltCtx.createRadialGradient(b.tx, b.ty, 0, b.tx, b.ty, r);
        g.addColorStop(0, 'rgba(' + b.rgb[0] + ',' + b.rgb[1] + ',' + b.rgb[2] + ',' + (0.9 * t) + ')');
        g.addColorStop(1, 'rgba(' + b.rgb[0] + ',' + b.rgb[1] + ',' + b.rgb[2] + ',0)');
        boltCtx.globalAlpha = 1;
        boltCtx.fillStyle = g;
        boltCtx.beginPath();
        boltCtx.arc(b.tx, b.ty, r, 0, Math.PI * 2);
        boltCtx.fill();
      } catch (e) {}
    }
    drawFairies();
    boltRaf = requestAnimationFrame(boltLoop);
  }

  // ── Fairies ──────────────────────────────────────────────────────────────────────────
  // A point of light that darts across the stage and throws a DIFFERENT one of the six effects
  // every time it flashes. The fairy is drawn here, on the same canvas as the bolts and in the
  // same loop; the bursts are the renderer's own fire(), so a fairy costs one small object and
  // whatever the effects were going to cost anyway.
  //
  // The reason it is Pocket's and not the renderer's is the reason lightning was: fire() knows
  // six effects, this is not one of them, and a name it does not recognise falls back silently.
  //
  // It picks a NEW effect per flash rather than one per fairy. One per fairy would read as a
  // fairy that throws confetti, which is just confetti on a moving origin; the point is that you
  // cannot tell what the next one will be.
  const FAIRY_LIFE = [1.7, 2.6];        // seconds, when a beat throws one
  // A SUMMONED WISP DOES NOT EXPIRE. Thirty seconds was the previous answer and it was the
  // wrong shape of answer: the person who sent it out has no idea when the clock started, so it
  // vanished mid-drift for no reason they could see. Now it goes until the same gesture that
  // started it stops it — a state you hold, not a timer you wait out. The cost is that the only
  // way to end it is that second double-press: nothing else clears a roaming wisp, so a phone
  // left on a table keeps drawing one until it is told not to.
  const FAIRY_GAP = 170;            // ms between one fairy's own bursts, when it is alone
  // Two. Eight was a swarm, and a swarm is the opposite of a wisp — the whole character of the
  // thing is one light you can follow with your eye. It also restores the fire rate: the gap
  // scales with the crowd, so two of them flash half as often as one, rather than an eighth.
  //
  // WITH BOTH SLOTS HELD BY WISPS YOU SENT OUT, the music adds none of its own — the eviction
  // rule drops the beat-thrown one rather than yours, and at two slots that means all of them.
  // Deliberate beats automatic, which is the right way round, but now that a summoned wisp never
  // expires it also means Fairy-on-the-beat stays quiet until you double-press again to send
  // them away. That is the price of the toggle, and it is stated in the tutorial text.
  const MAX_FAIRIES = 2;
  // A WISP IS MOSTLY TAIL. Sixteen points at sixty frames a second is a quarter-second smear
  // that reads as a dot with a smudge; eighty was over a second; this is about three and a half,
  // which at a wisp's drift is more than a screen's width of path behind it. Long enough that
  // the tail curves back over itself and the shape of where it has been is the thing you watch.
  const FAIRY_TRAIL = 210;
  // Drawn in BANDS, not one stroke per point, and this is what makes the length affordable. Two
  // hundred and ten segments times two wisps is 420 stroke calls a frame, 25,000 a second, on a
  // phone. Bands of about thirteen points each are 32 calls a frame for the same picture.
  //
  // SIXTEEN RATHER THAN TEN because the fade is what these bands are now for. At ten, the last
  // step down was a tenth of the brightness dropping at once and the tail ended on a visible
  // edge; sixteen makes each step a sixteenth, which at this width is below what the eye picks
  // out as a boundary. The extra twelve stroke calls a frame are the whole cost.
  const FAIRY_BANDS = 16;
  const FAIRY_SPEED = [0.26, 0.46]; // fraction of the stage's diagonal per second
  let fairies = [];

  // `roam` is the difference between the two ways a fairy arrives. On the beat it is a burst
  // that happens to move — it appears, crosses a little of the stage and is gone, which is what
  // a burst should do. Summoned by two fingers it is a THING YOU STARTED, and a thing you
  // started that is gone in two seconds did not start anything. So it lives about three times as
  // long and travels slower, which reads as wandering rather than as being flung.
  function spawnFairy(nx, ny, intensity, palette, roam) {
    if (!boltReady()) return;
    sizeBolt();
    if (!boltW || !boltH) return;
    const now = performance.now();
    const diag = Math.hypot(boltW, boltH);
    fairies.push({
      x: (typeof nx === 'number' ? nx : rand(0.15, 0.85)) * boltW,
      y: (typeof ny === 'number' ? ny : rand(0.2, 0.8)) * boltH,
      a: rand(0, Math.PI * 2),
      sp: rand(FAIRY_SPEED[0], FAIRY_SPEED[1]) * diag * (roam ? 0.72 : 1),
      // Two wander terms at different rates, so the path curves without ever repeating a shape.
      // Slower, wider wander than a spark's. Fast wobble at this tail length knots the trail
      // into a scribble; a wisp has to draw one long readable curve.
      w1: rand(0.55, 1.15), w2: rand(1.4, 2.3), amp: rand(1.0, 1.8),
      t: rand(0, 10),
      // 1 is a placeholder for a roamer, never counted down — see stepFairies. It is not zero
      // because the tail's brightness reads `life` directly and zero would draw nothing.
      life: roam ? 1 : rand(FAIRY_LIFE[0], FAIRY_LIFE[1]),
      maxLife: 0, trail: [], lastFire: now - FAIRY_GAP,
      rgb: boltRgb(),
      intensity: intensity || 1,
      palette: palette || readPalette(),
    });
    const f = fairies[fairies.length - 1];
    f.roam = !!roam;
    if (roam) wispLog.spawned++;
    f.maxLife = f.life;
    // OVER THE CAP, A BEAT-THROWN ONE GOES FIRST. A fairy someone deliberately sent out with two
    // fingers should not be evicted by one the music threw a moment later — against a wisp
    // that never expires, the automatic ones would otherwise clear the deliberate ones off the
    // screen within a bar. Only if every one alive is deliberate does the oldest give way.
    while (fairies.length > MAX_FAIRIES) {
      let i = fairies.findIndex((x) => !x.roam);
      if (i < 0) i = 0;
      fairies.splice(i, 1);
    }
    if (!boltRaf) { boltLast = now; boltRaf = requestAnimationFrame(boltLoop); }
  }

  function stepFairies(dt, now) {
    for (let i = fairies.length - 1; i >= 0; i--) {
      const f = fairies[i];
      // A roamer's life is never spent. Everything else about it ages normally — it wanders,
      // wraps and fires exactly as a beat-thrown one does; it simply has no end of its own.
      if (!f.roam) {
        f.life -= dt;
        if (f.life <= 0) { fairies.splice(i, 1); continue; }
      }
      f.t += dt;
      f.a += (Math.sin(f.t * f.w1) + Math.sin(f.t * f.w2) * 0.6) * f.amp * dt;
      f.x += Math.cos(f.a) * f.sp * dt;
      f.y += Math.sin(f.a) * f.sp * dt;
      // WRAP RATHER THAN BOUNCE, at Harold's word. The original reasoning was that a light
      // reappearing on the far side reads as two lights rather than as one thing moving — true
      // of a dot, and no longer true once it drags three seconds of tail: the tail follows it
      // through the wrap and out the other side, which is what tells you it is the same wisp.
      // Bouncing also made every edge a hard corner in a path whose whole appeal is the curve.
      //
      // THE TRAIL HAS TO BREAK WITH IT. Without the break the next segment joins the old edge to
      // the new one and draws a line straight back across the screen — the classic wrap artifact,
      // and at this tail length it would be the most visible thing on the stage.
      const pad = 4;
      let jumped = false;
      if (f.x < -pad) { f.x += boltW + pad * 2; jumped = true; }
      else if (f.x > boltW + pad) { f.x -= boltW + pad * 2; jumped = true; }
      if (f.y < -pad) { f.y += boltH + pad * 2; jumped = true; }
      else if (f.y > boltH + pad) { f.y -= boltH + pad * 2; jumped = true; }
      if (jumped) f.trail.push(NaN, NaN);      // a break the renderer lifts the pen at
      f.trail.push(f.x, f.y);
      if (f.trail.length > FAIRY_TRAIL * 2) f.trail.splice(0, f.trail.length - FAIRY_TRAIL * 2);
      // THE GAP WIDENS WITH THE CROWD, and this is the number that makes an open-ended wisp
      // survivable. One fairy firing every 170ms is about six bursts a second, which is the
      // rate the effect was tuned at. Eight of them at that rate is forty-seven a second: the
      // particle budget is gone inside a second, every burst is clipped to nothing, and a phone
      // spends its battery drawing a smear. Scaling the gap by how many are alive holds the
      // TOTAL at roughly six a second however many are out.
      //
      // WHAT THAT COSTS, since it is a threshold: an individual fairy visibly flashes less often
      // when it has company. Two are each half as busy as one alone. That is the trade for
      // several of them coexisting at all, and the alternative is not more fairies, it is a
      // budget spent before any of them is drawn.
      const gap = FAIRY_GAP * Math.max(1, fairies.length);
      if (fx && fxShown() && now - f.lastFire >= gap) {
        f.lastFire = now;
        fx.fire(pick(FAIRY_EFFECTS), {
          x: f.x / boltW, y: f.y / boltH,
          // Small on purpose. A fairy throwing full-size bursts several times a second is not a
          // fairy, it is the effects running at four times the usual rate.
          intensity: f.intensity * 0.42,
          palette: f.palette,
        });
      }
    }
  }

  function drawFairies() {
    for (const f of fairies) {
      // A roamer draws at full brightness always — it has no remaining life to read. For a
      // beat-thrown one, only its last second takes the whole thing down.
      const t = f.roam ? 1 : Math.min(1, Math.max(0, f.life));
      const n = f.trail.length / 2;
      // Segments rather than dots. A line of circles is a dotted line at any spacing; joined
      // segments with a tapering width are a tail, and round caps hide the joins.
      boltCtx.strokeStyle = 'rgb(' + f.rgb[0] + ',' + f.rgb[1] + ',' + f.rgb[2] + ')';
      const per = Math.max(2, Math.ceil(n / FAIRY_BANDS));
      for (let b = 0; b < FAIRY_BANDS; b++) {
        const lo = b * per;
        // +1 so consecutive bands share a point; without the overlap there is a visible gap at
        // every band boundary and the tail reads as a dashed line.
        const hi = Math.min(n, lo + per + 1);
        if (hi - lo < 2) continue;
        // FADES TO NOTHING RATHER THAN STOPPING. `b + 1` over the count made the oldest band
        // a tenth-bright and then simply absent on the next frame — a tail with a cut end, which
        // is the thing that read as wrong. Dividing by count-1 puts the oldest band at exactly
        // zero, so the last visible thing on the tail is a segment fading out rather than one
        // being switched off.
        const k = (FAIRY_BANDS > 1) ? b / (FAIRY_BANDS - 1) : 1;   // 0 oldest, 1 newest
        // A gentle curve, not squared. Squared alpha put 90% of a long tail below 0.05 opacity:
        // the trail was long in memory and short on screen, which is the same as not being long.
        // 1.25 keeps it visible most of the way back while still spending its last few bands
        // getting to zero. The width tapers faster, so it thins to a thread while staying lit.
        boltCtx.globalAlpha = 0.66 * Math.pow(k, 1.25) * t;
        boltCtx.lineWidth = Math.max(0.3, 3.2 * k * k + 0.3);
        // The pen lifts at a NaN and comes back down on the next real point, so a wrap leaves a
        // clean end and a clean start rather than a chord across the whole screen.
        boltCtx.beginPath();
        let penDown = false;
        for (let i = lo; i < hi; i++) {
          const px = f.trail[i * 2], py = f.trail[i * 2 + 1];
          if (!isFinite(px) || !isFinite(py)) { penDown = false; continue; }
          if (penDown) boltCtx.lineTo(px, py);
          else { boltCtx.moveTo(px, py); penDown = true; }
        }
        boltCtx.stroke();
      }
      const core = Math.max(3, boltH * 0.008);
      try {
        const g = boltCtx.createRadialGradient(f.x, f.y, 0, f.x, f.y, core * 3.2);
        g.addColorStop(0, 'rgba(255,255,255,' + (0.9 * t) + ')');
        g.addColorStop(0.35, 'rgba(' + f.rgb[0] + ',' + f.rgb[1] + ',' + f.rgb[2] + ',' + (0.6 * t) + ')');
        g.addColorStop(1, 'rgba(' + f.rgb[0] + ',' + f.rgb[1] + ',' + f.rgb[2] + ',0)');
        boltCtx.globalAlpha = 1;
        boltCtx.fillStyle = g;
        boltCtx.beginPath();
        boltCtx.arc(f.x, f.y, core * 3.2, 0, Math.PI * 2);
        boltCtx.fill();
      } catch (e) {}
    }
  }

  // Everything on the bolt layer, gone. Only for when the layer itself is going away — effects
  // switched off, or the canvas hidden — because it takes the wisps with it.
  function clearBolts() {
    fbolts.length = 0;
    fairies.length = 0;
    dropBolts();
  }

  // Bolts only. Lightning switched off has to stop lightning; it has nothing to say about a wisp,
  // which is a burst effect and not a bolt. Using clearBolts() here wiped both.
  function clearStrikes() {
    fbolts.length = 0;
    if (!fairies.length) dropBolts();
  }

  function dropBolts() {
    if (boltRaf) { cancelAnimationFrame(boltRaf); boltRaf = 0; }
    if (boltCtx && boltW && boltH) {
      boltCtx.setTransform(boltDpr, 0, 0, boltDpr, 0, 0);
      boltCtx.clearRect(0, 0, boltW, boltH);
    }
  }

  // A rotation, a player resize or a jump into full screen changes the box everything on this
  // layer was built in. A BOLT IS DROPPED: it is a fixed path from a fixed point, and redrawing
  // it against coordinates it was never built in is worse than losing a fifth of a second of it.
  //
  // A WISP IS NOT. It is a position and a trail, both of which scale, and it is the thing the
  // person is watching — a summoned one is deliberately open-ended now, so throwing it away on a
  // full-screen tap made the tap look like it had cancelled them. Harold hit exactly that. So
  // the positions are scaled into the new box and the wisp carries on.
  //
  // THE TRAIL BREAKS AT THE SEAM. Scaling is not a conformal map of the path it drew — a stage
  // that gets four times taller and no wider stretches every old segment — so the honest thing
  // is a pen lift: what came before stays where it was drawn, proportionally, and the new box's
  // path starts clean. Without the lift the joint segment is the one wrong-looking line on screen.
  function reflowBolts() {
    fbolts.length = 0;
    // A hidden canvas measures 0x0 and sizeBolt() falls back to 300x150, which would become the
    // box every surviving wisp is scaled against. Nothing to reflow into, so nothing is measured.
    if (!boltReady() || boltCv.hidden) { if (!fairies.length) dropBolts(); return; }
    const ow = boltW, oh = boltH;
    sizeBolt();
    if (!fairies.length) { dropBolts(); return; }
    if (ow > 0 && oh > 0 && boltW > 0 && boltH > 0 && (ow !== boltW || oh !== boltH)) {
      const sx = boltW / ow, sy = boltH / oh;
      // A ROTATION IS NOT A RESIZE. When the two axes scale by nearly the same amount — the stage
      // growing as the browser chrome goes away — scaling the trail keeps the curve the person
      // was watching. When they scale differently by a lot, scaling it is a lie: a rotation
      // multiplies x by 2.2 and y by 0.45, and three seconds of curve comes out as a flat streak
      // across the whole screen, which is more distracting than no tail at all.
      //
      // SO THE TAIL IS DROPPED PAST THAT POINT and redraws itself over the next few seconds. What
      // is lost, stated: rotate the phone and the wisp keeps going but its history is gone, so
      // for about three seconds it is a shorter wisp than it was.
      const keepTrail = (sx / sy) > 0.7 && (sx / sy) < 1.43;
      if (!keepTrail && fairies.length) wispLog.tailDrops++;
      for (const fa of fairies) {
        fa.x *= sx; fa.y *= sy;
        if (!keepTrail) { fa.trail.length = 0; }
        else for (let i = 0; i < fa.trail.length; i += 2) {
          fa.trail[i] *= sx; fa.trail[i + 1] *= sy;
        }
        fa.trail.push(NaN, NaN);
        // Speed is a fraction of the diagonal and the diagonal just changed. Without this a wisp
        // that was drifting across a 162px stage crawls across a 732px one.
        const os = Math.hypot(ow, oh), ns = Math.hypot(boltW, boltH);
        if (os > 0) fa.sp *= ns / os;
      }
    }
    if (boltCtx && boltW && boltH) {
      boltCtx.setTransform(boltDpr, 0, 0, boltDpr, 0, 0);
      boltCtx.clearRect(0, 0, boltW, boltH);
    }
    // The loop stops itself when both lists empty, so a surviving wisp needs it started again
    // if a previous clear had already parked it.
    if (!boltRaf) { boltLast = performance.now(); boltRaf = requestAnimationFrame(boltLoop); }
  }

  // BOTH RENDERERS LISTEN FOR THEIR OWN RESIZE. `fx-render.js` and `eq-render.js` each register
  // window.addEventListener('resize', resize) when they start, so the bars and the bursts
  // re-measure themselves on a rotation or a viewport change no matter who caused it. THE BOLT
  // LAYER NEVER DID, and that asymmetry is the whole bug: everything on the stage adjusted except
  // the one canvas Pocket owns, so only the wisps broke and everything around them looked fine.
  //
  // It never showed in the container because setCover() reflows by hand and a headless viewport
  // does not move afterwards. A PHONE MOVES AFTERWARDS. requestFullscreen() is asynchronous and
  // best-effort: the tap applies the CSS cover and reflows against that box, and then, a frame or
  // more later, the browser chrome actually goes away and the viewport grows again. The canvas
  // bitmap stayed at the size measured before that second change and the browser stretched it —
  // 824x1830 pixels of wisp squeezed into a 915x412 box after a rotation, which is a smear in the
  // wrong place rather than a light. Measured, at 1.45.0, exactly those numbers.
  //
  // COALESCED TO ONE CALL A FRAME. A rotation fires a burst of resize events, and each reflow
  // pushes a pen-lift into every trail; a dozen of them in a row would shred the tail into dashes.
  // The scaling itself is exact and repeating it costs nothing, so it is only the breaks that
  // need this.
  let reflowRaf = 0;
  function reflowSoon() {
    wispLog.reflows++;
    if (reflowRaf) return;
    reflowRaf = requestAnimationFrame(() => { reflowRaf = 0; reflowBolts(); });
  }
  for (const ev of ['resize', 'orientationchange']) window.addEventListener(ev, reflowSoon);
  // Entering native full screen resizes the stage without firing anything setCover() sees, and
  // leaving it does the same on the way back. The existing fullscreenchange handler only deals
  // with the CLASS; this deals with the box.
  for (const ev of ['fullscreenchange', 'webkitfullscreenchange']) {
    document.addEventListener(ev, reflowSoon);
  }

  // ── Painting with a finger ────────────────────────────────────────────────
  // Touch the visuals and they answer. The whole app has been a thing you watch; this is the one
  // place it is a thing you touch, and on a phone that is most of what "interactive" means.
  //
  // THE GESTURE HAD TO SHARE WITH FULL SCREEN, which was already a tap on this same surface.
  // Rather than move full screen or make it a double-tap — retraining a gesture that works — the
  // two are told apart the way a phone usually tells them apart: a clean quick tap is still full
  // screen, and anything that MOVES or is HELD is painting. Held counts as well as moved, because
  // "touch the screen" to most people means press, not swipe, and a press that did nothing would
  // read as the feature being broken.
  const PAINT_MOVE = 10;     // px before a tap becomes a drag
  const PAINT_HOLD = 200;    // ms before a press becomes a paint
  const PAINT_GAP = 80;      // ms between bursts along a drag, so one swipe is not one flood
  let painting = false, pressX = 0, pressY = 0, lastPaint = 0, holdTimer = 0, pressed = false;

  // A FINGER ON THE STAGE IS A REQUEST FOR THE EFFECTS, and the app used to refuse it silently
  // when they were off. Harold's phone at 1.48.0: "On the stage: equalizer only", three
  // two-finger gestures, every one REFUSED, nothing on screen to say why. It read as "no wisps".
  //
  // The renderers already start themselves here — a finger on a cold app had nothing to draw on
  // and the gesture did nothing at all, the exact first thing anyone would try, so painting
  // starts them itself (1.19.0). Effects being OFF is the same dead gesture one setting further
  // along, and it gets the same answer: the effects come on, visibly, the star in the header
  // flips, and the gesture proceeds. A setting that a one-tap star already toggles is not a
  // decision the app has to protect from a finger.
  //
  // WHAT THAT COSTS, since it changes a setting: "equalizer only" no longer survives a drag,
  // a hold or two fingers on the stage — someone who chose bars alone and brushes the stage gets
  // the effects back and has to tap the star again. A clean tap does NOT do this; it still only
  // toggles full screen. The gestures that turn the effects on are exactly the ones whose only
  // meaning is "draw something here", which is the point.
  function wantEffects() {
    if (!fx) initVisuals();
    if (!fxShown()) {
      applyVisuals('both');
      wispLog.turnedOn++;
    }
    return !!fx && fxShown();
  }

  function paintAt(ev) {
    const mode = readTouch();
    if (mode === 'off') return;         // the drag is still swallowed; it just draws nothing
    if (!wantEffects()) return;
    const r = $('stage').getBoundingClientRect();
    if (!r.width || !r.height) return;
    const x = (ev.clientX - r.left) / r.width;
    const y = (ev.clientY - r.top) / r.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return;
    // The bolt keeps its own clock, deliberately: it is a slower, heavier thing than a burst and
    // one per burst would be a strobe. strike() enforces it, so calling this every move is safe.
    if (mode === 'both' || mode === 'lightning') strike(x, y);
    if (mode === 'both' || mode === 'effect') {
      const now = performance.now();
      if (now - lastPaint < PAINT_GAP) return;
      lastPaint = now;
      // x and y are 0-1 of the stage, which is what fire() expects — it multiplies by its own
      // canvas size, so this stays correct in full screen and after a rotation without conversion.
      fireOne(x, y, PUNCH[readPunch()], readPalette());
    }
  }

  // TWO FINGERS SEND FAIRIES OUT. One finger paints where it is; two says "off you go" and the
  // lights leave and roam on their own. It is the one gesture a phone has that a mouse does not,
  // and it costs nothing to give it a meaning.
  //
  // It takes over from painting entirely while both are down, and the second finger CANCELS the
  // stroke the first was making — otherwise a two-finger gesture leaves a smear of bursts behind
  // it from whichever finger landed first.
  const down = new Map();          // pointerId -> {x, y}
  let twoFingerDone = false;       // one launch per gesture, cleared when the fingers lift

  // ONCE PER GESTURE, not a stream while the fingers are down. The first cut fired every 320ms
  // for as long as they were held, which made two fingers a second way of PAINTING — the thing
  // one finger already does. Harold's correction was "start the fairy moving around on screen",
  // and the word is start: you touch, they leave, and what happens next is theirs.
  // AND THE SAME GESTURE SENDS THEM AWAY. Once a summoned wisp stopped expiring there had to be
  // an off, and a second control for it would have been a setting nobody would find. So the
  // gesture toggles: two fingers with none out sends two, two fingers with any out clears every
  // one you sent. It clears ONLY yours — a fairy the music threw is on its own two-second clock
  // and is not something you asked for, so it is not yours to dismiss.
  function twoFingerFairies() {
    if (twoFingerDone) return;
    wispLog.gestures++;
    if (!wantEffects()) { wispLog.refused = 'no renderer'; return; }
    const r = $('stage').getBoundingClientRect();
    if (!r.width || !r.height) { wispLog.refused = 'the stage measured 0'; return; }
    wispLog.refused = '';
    twoFingerDone = true;
    if (fairies.some((f) => f.roam)) {
      for (let i = fairies.length - 1; i >= 0; i--) if (fairies[i].roam) fairies.splice(i, 1);
      wispLog.dismissed++;
      return;
    }
    // One from each finger, so the pair of them is visible in what leaves.
    for (const pt of down.values()) {
      const x = (pt.x - r.left) / r.width, y = (pt.y - r.top) / r.height;
      if (x < 0 || x > 1 || y < 0 || y > 1) continue;
      spawnFairy(x, y, PUNCH[readPunch()], readPalette(), true);
    }
  }

  $('stage').addEventListener('pointerdown', (ev) => {
    down.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (down.size >= 2) {
      // The first finger's stroke is abandoned rather than finished: this is one gesture now.
      pressed = false; painting = true;      // painting stays true so the click cannot toggle
      clearTimeout(holdTimer);
      twoFingerFairies();
      return;
    }
    pressed = true; painting = false;
    pressX = ev.clientX; pressY = ev.clientY;
    clearTimeout(holdTimer);
    holdTimer = setTimeout(() => { if (pressed) { painting = true; paintAt(ev); } }, PAINT_HOLD);
  });
  $('stage').addEventListener('pointermove', (ev) => {
    if (down.has(ev.pointerId)) { const p = down.get(ev.pointerId); p.x = ev.clientX; p.y = ev.clientY; }
    // Moving with two fingers down does nothing further: they have already gone.
    if (down.size >= 2) return;
    if (!pressed) return;
    if (!painting && Math.hypot(ev.clientX - pressX, ev.clientY - pressY) < PAINT_MOVE) return;
    painting = true;
    paintAt(ev);
  });
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) {
    $('stage').addEventListener(ev, (e) => {
      down.delete(e.pointerId);
      // Armed again only when every finger is off, so one two-finger gesture is one launch
      // however the fingers happen to lift.
      if (!down.size) twoFingerDone = false;
      pressed = false;
      clearTimeout(holdTimer);
      // `painting` is deliberately NOT cleared here — the click handler clears it, and clearing
      // it early is how a two-finger gesture ends up toggling full screen on the way out.
    });
  }
  // The click still owns full screen, so a keyboard Enter or Space on this button keeps working —
  // those produce a click with no pointer sequence, so `painting` is false and they toggle.
  $('stage').addEventListener('click', () => {
    if (painting) { painting = false; return; }
    setCover(!covered);
  });
  // Android's back gesture and Escape both leave native full screen without telling this code.
  // Without this the class would stay on and the stage would sit over the whole page with no
  // browser chrome to explain it.
  for (const ev of ['fullscreenchange', 'webkitfullscreenchange']) {
    document.addEventListener(ev, () => {
      const native = !!(document.fullscreenElement || document.webkitFullscreenElement);
      if (!native && covered) setCover(false);
    });
  }

  for (const [id, which] of [['advEqReset', 'eq'], ['advFxReset', 'fx']]) {
    const b = $(id);
    if (b) b.addEventListener('click', () => resetAdv(which));
  }

  $('fxBtn').addEventListener('click', () => applyVisuals(fxShown() ? 'eq' : 'both'));
  $('visualsSel').addEventListener('change', () => applyVisuals($('visualsSel').value));

  if ('mediaSession' in navigator) {
    const set = (a, fn) => { try { navigator.mediaSession.setActionHandler(a, fn); } catch (e) {} };
    set('play', () => { if (audio && audio.paused) toggle(); });
    set('pause', () => { if (audio && !audio.paused) toggle(); });
    set('previoustrack', prev);
    set('nexttrack', () => next(false));
  }

  // Offline is the point of this app, so it caches itself — unlike the ROCK-served one, which
  // has a server that can outrun a cache. Registered only on a secure origin, which is also the
  // only place it is allowed.
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('[pocket] no worker: ' + err.message));
  }

  // Paint the version chip. Text, never innerHTML — it ends up beside the app name.
  { const v = $('ver'); if (v) v.textContent = 'beta ' + VERSION.replace(/-beta$/, ''); }

  // Saved links come back on their own; picked files cannot, and the note says which is which.
  readModes();
  micPaint();
  micNote('Not listening.');
  applyPlayer();
  // Remembered microphone, reopened without a tap. This works — and ONLY works — because
  // getUserMedia needs no gesture once permission has been granted for this origin. It is a
  // promise that could not be kept for system audio, which is refused without a fresh tap
  // every time, so nothing here offers that.
  if (readMicAuto()) {
    setTimeout(() => { micStart(false); }, 0);
  }
  applyVisuals(readVisuals());
  queue = readLinks().map(linkRow);
  if (shuffleOn) buildOrder();
  renderQueue();
  paintLib();
  paintModes();

  // First run, once. A frame late on purpose: the ring is measured from real elements, and on a
  // cold load their boxes are not final until layout has settled — measuring too early puts the
  // ring in the wrong place on exactly the load that matters most.
  //
  // Not shown when the microphone is about to open itself: that path asks for a permission, and
  // a permission prompt landing under a tutorial card is the worst first second this app could
  // offer. Those people get it from Show me around instead.
  // Before resumeFolder even runs: the names are local and instant, and an app that opens with
  // its queue already on screen never has the empty moment that reads as "it lost my music".
  showPending();
  paintFolder();
  paintInstall();
  try {
    if (navigator.storage && navigator.storage.persisted) {
      navigator.storage.persisted().then((v) => { storagePersisted = v; });
    }
  } catch (e) {}
  resumeFolder();

  if (!tutSeen() && !readMicAuto()) {
    requestAnimationFrame(() => setTimeout(tutStart, 180));
  } else if (!tutSeen()) {
    tutMarkSeen();
  }

  window.__pocket = {
    version: VERSION,
    get links() { return readLinks(); },
    get modes() { return { shuffle: shuffleOn, repeat: repeatMode }; },
    get ambient() { return readAmbient(); },
    get palette() { return readPalette(); },
    get eqStyle() { return readEqStyle(); },
    get eqShape() { return eqShapeNow; },
    surprise,
    get look() { return currentLook(); },
    get beatEffect() { return readBeatEffect(); },
    get beatSens() { return { name: readSens(), value: SENS[readSens()] }; },
    get punch() { return { name: readPunch(), value: PUNCH[readPunch()] }; },
    get playerHidden() { return readHidePlayer(); },
    get playerSize() { return readPlayer(); },
    get failRun() { return failRun; },
    get quality() {
      return { chosen: readQualitySetting(), running: readQuality(),
               caps: QUALITY[readQuality()], fps: autoFps, seed: seedTier() };
    },
    get drive() { return { name: readDrive(), on: DRIVE[readDrive()] }; },
    get driveAvg() { return { mid: midAvg, high: highAvg }; },
    get touch() { return readTouch(); },
    diagnostics,
    reportBody,
    get tutorialStep() { return tutAt; },
    get tutorialSteps() { return TUT.length; },
    get tutorialSeen() { return tutSeen(); },
    get canRemember() { return canRemember(); },
    get folderRemembered() { return !!folderHandle; },
    get folderDiag() {
      return { found: folderFound, onLoad: folderStateAtLoad, afterAsk: folderStateAfterAsk };
    },
    get installed() { return installed(); },
    get canInstall() { return !!installEvent; },
    pickFolder, reconnectFolder, forgetFolder, resumeFolder,
    tutStart, tutEnd,
    get bolts() { return fbolts.length; },
    get fairies() { return fairies.length; },
    get fairyRoamCount() { return fairies.filter((f) => f.roam).length; },
    get fairyTrail() { return fairies.map((f) => f.trail.length / 2); },
    get fairyTrailRaw() { return fairies.map((f) => f.trail.slice()); },
    // The box the wisps live in AND the bitmap that box is drawn into. They are different
    // numbers and the difference is the whole of the 1.46.0 bug: the box followed the screen and
    // the bitmap did not, so everything drawn was stretched into the wrong shape. A suite that
    // read only one of them would have called that build correct.
    get boltBox() {
      return { w: boltW, h: boltH,
               bw: boltCv ? boltCv.width : 0, bh: boltCv ? boltCv.height : 0, dpr: boltDpr };
    },
    get advanced() { return readAdv(); },
    advValue,
    setAdv,
    resetAdv,
    get wispLog() { return Object.assign({}, wispLog); },
    get fairyInBounds() {
      return fairies.every((f) => f.x >= -8 && f.x <= boltW + 8 && f.y >= -8 && f.y <= boltH + 8);
    },
    get promptWarning() { return promptWarning; },
    spawnFairy,
    strike,
    addLink,
    removeAt,
    get queue() { return queue; },
    get current() { return current; },
    get bands() { return readBands(); },
    get graphReady() { return !!(ctx && analyser && srcNode); },
    get micLive() { return micLive; },
    get micAuto() { return readMicAuto(); },
    get awake() { return !!wakeLock; },
    // Reports only that the microphone has an analyser of its own. The guarantee that it never
    // reaches the speakers is STRUCTURAL — nothing is ever connected downstream of it — and no
    // getter can prove that from here; read the three connect() calls in this file instead.
    get micIsolated() { return !!(micAnalyser && micAnalyser !== analyser); },
    micStart, micStop,
    get visuals() { return visuals; },
    get covered() { return covered; },
    isDeadLink,
    // Read-only counts from the effects renderer. Storm and lightning draw bolts as an event
    // subsystem separate from the weather particles, so 'is lightning actually striking' cannot
    // be answered from the config — only from here.
    get fxStats() { return fx ? fx.stats() : null; },
    get fxAmbient() { return fx ? fx.getAmbientMode() : null; },
    // What the effects renderer is actually holding. The particle count cannot answer "did that
    // setting arrive" once the budget is saturated — every size looks like 1200 — so the config
    // itself is the only honest check.
    get fxConfig() {
      if (!fx || !fx.getConfig) return null;
      const c = fx.getConfig();
      return { intensity: c.beat.intensity, effect: c.beat.effect, beatOn: c.beat.enabled,
               fountain: c.effects.fountain, hearts: c.effects.hearts,
               particleCap: c.particleCap };
    },
  };
})();
