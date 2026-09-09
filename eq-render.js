/**
 * EQ renderer — shared by the overlay (eq.html) and the settings studio (eq-settings.html).
 * =========================================================================================
 * ONE copy, deliberately. Both pages draw the same seven styles from the same 24 numbers,
 * and two byte-identical renderers would drift the first time a style was tweaked in one
 * of them — the studio would then be previewing something the overlay does not draw, which
 * is worse than no preview at all.
 *
 * Owns: palettes, level chasing (attack/release), peak caps, staleness decay, and the
 * seven style painters. Knows nothing about WebSockets or config storage.
 *
 *   const eq = EqRender.create(canvasElement);
 *   eq.setConfig(cfg);      // see DEFAULTS; per-style overrides live in cfg.styles[style]
 *   eq.push(bandsArray);    // a frame, 0-255 per band
 *   eq.setPlayerUp(bool);   // false decays the picture if capture is also down
 *   eq.setCaptureUp(bool);  // capture feed; push() also sets this true
 *   eq.start(); eq.stop();
 */
(function (global) {
  'use strict';

  const STYLES = ['bars', 'led', 'blocks', 'wave', 'line', 'dots', 'radial'];

  // Stops are [position, [r,g,b]] so segments and dots can SAMPLE a colour at a height,
  // not just fill from a gradient. A canvas gradient cannot be read back.
  const PALETTES = {
    hive:  [[0, [240, 163, 38]], [0.55, [249, 131, 44]], [1, [251, 106, 65]]],
    fire:  [[0, [254, 222, 74]], [0.5, [250, 140, 45]], [1, [236, 52, 52]]],
    ice:   [[0, [92, 214, 238]], [0.5, [86, 160, 247]], [1, [168, 120, 246]]],
    vapor: [[0, [255, 140, 220]], [0.5, [168, 120, 246]], [1, [92, 214, 238]]],
    mono:  [[0, [235, 235, 235]], [1, [150, 150, 150]]],
  };

  // Positions are fixed so a custom palette is three colours, not a curve-editing
  // exercise: low, middle, top of the bar.
  const CUSTOM_POSITIONS = [0, 0.5, 1];
  // How a column takes the palette. 'gradient' is the ramp up it (low at the foot, top at the
  // peak); 'solid' is one colour per column, picked by how high it is - the mapping dots and
  // radial already use. Only the column styles have a ramp to swap, so the studio hides the
  // switch elsewhere (Harold, 2026-09-04).
  const FILLS = ['gradient', 'solid'];
  const FILL_STYLES = ['bars', 'led', 'blocks', 'wave'];
  const HEX_RE = /^#[0-9a-fA-F]{6}$/;

  // Three editable slots, GLOBAL rather than per-style — they are a palette library that
  // any style can point at. They used to be one slot saved per style, which meant tuning
  // a custom palette on bars and then clicking led showed the preset again: indisting-
  // uishable from "it did not save".
  // spin turns continuously; the rest oscillate around the resting position, so they stay
  // usable on a wide source where a full rotation would swing the bars out of frame.
  const MOTIONS = ['none', 'spin', 'rock', 'sway', 'bob', 'pulse'];

  const CUSTOM_SLOTS = ['custom1', 'custom2', 'custom3'];
  const DEFAULT_CUSTOMS = [
    ['#f0a326', '#f8862b', '#fb6a41'],   // warm, close to hive
    ['#19e6c8', '#4f7dff', '#ff3ea5'],   // teal to magenta
    ['#33d17a', '#f6d32d', '#e01b24'],   // green to red, the old VU meter
  ];

  const DEFAULTS = {
    style: 'bars',
    bands: 24,
    palette: 'hive',
    fill: 'gradient',   // the ramp up each column; 'solid' = one colour by level (see FILLS)
    customs: DEFAULT_CUSTOMS.map((slot) => slot.slice()),
    opacity: 1,
    gain: 1,          // mirrors the server's EQ_NUMBERS default (the 2026-08-19 lift to 1.3
                      // was rolled back the same day)
    gap: 0.18,        // share of each slot left empty, column styles
    caps: true,       // peak-hold markers
    mirror: false,    // reflect downward, column styles
    mirrorOpacity: 0.35,   // how solid the reflection is, relative to the bar
    floor: false,     // dim stub under a silent band
    segments: 14,     // led / blocks
    thickness: 3,     // line / dots
    glow: 0.35,       // line / dots / radial
    radius: 0.34,     // radial inner radius, share of the smaller side
    // Motion is a transform around the centre applied before the style paints, so all
    // seven get it from one implementation and none of them know it happened.
    // Mirrors the server's EQ_DEFAULTS — pulse + motionBeat since 2026-08-19: the default
    // look throbs on the kick instead of standing still. Rate stays at the original 0.25
    // (the same-day lift to 0.5 was rolled back on review).
    motion: 'pulse',
    motionRate: 0.25,   // repeats per second (turns per second for spin)
    motionDepth: 0.3,   // how far the oscillating motions travel; spin ignores it
    motionBeat: true,   // drive the swing from the music instead of the clock
    motionPunch: 1,     // beat-drive emphasis — scales the KICK response only, never the
                        // resting size, so it is not a loudness knob (see beatFloor below)
    spin: 0,            // legacy: radial-only degrees per second, kept so a saved config
                        // or an old ?spin= URL still turns. Maps onto motion 'spin'.
    attack: 0.55,
    release: 0.12,
    // WHERE THE EQUALIZER SITS. Two layers, and the distinction is the whole design.
    //
    // frame* is the rectangle it occupies in the 1920x1080 STREAM FRAME. It describes the
    // LOOK, not the source, so it is safe to save and safe to put in a preset: the same
    // numbers mean the same thing to every source that reads them. 0 width or height means
    // "unset" — fill whatever source I am — which is what every existing config says, so
    // nothing changes for anyone until it is set. That is still literally true after the
    // 2026-08-28 fixed-space change: an unset, unpinned config takes the source as its own
    // logical space and is the same code it always was (see resize()).
    //
    // region* is the same thing expressed as fractions of the LOGICAL SPACE (1920x1080), and
    // it is a per-source pin: it is what ?box= writes, and it wins outright. Null means "not
    // pinned". It used to mean fractions of the live canvas; on a 16:9 source those are the
    // same number, and on any other source the difference was the stretch — see resize().
    //
    // The reason frame* can be saved without a footgun is that the renderer resolves it per
    // source rather than applying it blindly — see resize().
    frameX: 0,
    frameY: 0,
    frameW: 0,
    frameH: 0,
    regionX: null,
    regionY: null,
    regionW: null,
    regionH: null,
  };

  // The frame every saved rectangle is written in, whatever the source's real size is.
  const REF_W = 1920, REF_H = 1080;
  // How close two aspect ratios have to be to count as "the same shape". Generous enough to
  // survive OBS rounding a source to whole pixels, tight enough that 900x220 (4.09) and 16:9
  // (1.78) are never confused.
  const ASPECT_TOL = 0.04;

  // Frames stop when the track pauses, the scene changes, or OBS unloads the player.
  // Bars fall away instead of freezing: a frozen equalizer reads as broken, an empty
  // one reads as silence.
  const STALE_MS = 1500;
  const CAP_GRAVITY = 0.0016;
  const CAP_HANG_MS = 260;

  // ── Frame rate cap ────────────────────────────────────────────────────────────────────
  // THE OPTION SET, IN ONE PLACE. eq.html's ?fps= pin, the studio's picker, listen.html's
  // control cluster and the tests all read this list, so there is one set of legal values
  // rather than four copies that drift the first time one of them gains an option.
  //
  //   0  match display — every rAF tick draws. THE DEFAULT, everywhere, deliberately: an
  //      overlay that nobody has asked to cap must behave exactly as it did before this
  //      existed, and that includes the one OBS is pointed at.
  //   60 / 30 the two rates that are actually useful here: 60 to stop a 120/144 Hz desktop
  //      spending three frames to show what OBS will sample twice, 30 to halve a phone's
  //      GPU work. 24 was considered and left out — 60/24 is not an integer cadence, so it
  //      lands as judder on the display this is most often on, and nothing here is trying
  //      to look cinematic.
  const FPS_OPTIONS = [0, 60, 30];
  const FPS_LABELS = { 0: 'Match display', 60: '60 fps', 30: '30 fps' };
  // The float gap between a 60 Hz tick (16.6667ms) and a 60 fps budget. Without this
  // slack a 60 cap on a 60 Hz display misses every single tick by a thousandth of a
  // millisecond and measures 30 — the failure is total, and it looks like the cap simply
  // being wrong rather than like an epsilon.
  const FPS_EPS = 0.5;
  // Attack/release below are per-FRAME fractions and were tuned against this rate.
  const FPS_REF_MS = 1000 / 60;

  // Anything not in the list reads as "no cap": a typo'd ?fps= pin must fall back to the
  // behaviour the page had before it was typed, not to a rate nobody chose.
  function normaliseFps(v) {
    const n = typeof v === 'string' ? parseInt(v, 10) : v;
    if (!Number.isFinite(n)) return 0;
    return FPS_OPTIONS.indexOf(n) > 0 ? n : 0;
  }

  // NaN has to be caught explicitly: both comparisons are false for it, so a bare min/max
  // clamp passes it straight through, and a non-finite level would then poison that band
  // forever (`level += (NaN - level) * k` never recovers, and the cap's `level >= cap`
  // reset is false for NaN too).
  //
  // Honest scope: this was raised in review as a live bug and it is NOT one — `frame()`
  // reads `target[i] || 0`, and NaN is falsy, so the poisoning is already neutralised one
  // layer down. This is the second of two guards, kept because it is one comparison and
  // the failure it prevents is a frozen bar in a renderer that promises never to freeze.
  // The test pins the PAIR: it goes red only when both this and the `|| 0` are removed.
  function clamp(v, lo, hi) {
    if (!Number.isFinite(v)) return lo;
    return v < lo ? lo : v > hi ? hi : v;
  }

  function sample(stops, t) {
    const x = clamp(t, 0, 1);
    for (let i = 1; i < stops.length; i++) {
      if (x > stops[i][0] && i < stops.length - 1) continue;
      const [p0, c0] = stops[i - 1];
      const [p1, c1] = stops[i];
      const k = p1 === p0 ? 0 : (x - p0) / (p1 - p0);
      return [
        Math.round(c0[0] + (c1[0] - c0[0]) * k),
        Math.round(c0[1] + (c1[1] - c0[1]) * k),
        Math.round(c0[2] + (c1[2] - c0[2]) * k),
      ];
    }
    return stops[0][1];
  }

  const rgb = (c, a) => (a === undefined ? `rgb(${c[0]},${c[1]},${c[2]})` : `rgba(${c[0]},${c[1]},${c[2]},${a})`);

  function hexToRgb(hex) {
    if (!HEX_RE.test(hex)) return null;
    return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
  }

  // Which of the three slots a palette name refers to, or -1 for a preset. 'custom' with
  // no number is the single-slot name this shipped with, and still means slot one.
  function customSlot(palette) {
    if (palette === 'custom') return 0;
    const i = CUSTOM_SLOTS.indexOf(palette);
    return i;
  }

  // A custom palette needs at least two usable colours to be a gradient at all; below
  // that, fall back rather than draw a single flat smear the user did not ask for.
  // hasOwnProperty, not a bare lookup: `PALETTES['toString']` inherits a truthy FUNCTION
  // from Object.prototype, so `?pal=toString` on an overlay URL passed the guard, came
  // back here as the palette, and threw when the gradient tried to iterate it — a blank
  // OBS source that never even opened its WebSocket.
  const knownPalette = (name) => Object.prototype.hasOwnProperty.call(PALETTES, name);

  // ─── The named palette library ───
  // Arrives on the config as \`library\` ({name: [hex, hex, hex]}), attached by the service at
  // serialise time — not a setting, so no preset can carry it. A palette of 'lib:<name>'
  // resolves here; a name that is not (or no longer) there falls back to the default palette.
  const LIB_PREFIX = 'lib:';
  const isLibraryName = (name) => typeof name === 'string' && name.startsWith(LIB_PREFIX) && name.length > LIB_PREFIX.length;
  const libraryNames = (library) => (library && typeof library === 'object' ? Object.keys(library) : []);
  function libraryStops(name, library) {
    const key = name.slice(LIB_PREFIX.length);
    if (!library || typeof library !== 'object' || !Object.prototype.hasOwnProperty.call(library, key)) return null;
    const parsed = (Array.isArray(library[key]) ? library[key] : []).slice(0, CUSTOM_POSITIONS.length).map(hexToRgb).filter(Boolean);
    if (parsed.length < 2) return null;
    const positions = parsed.length === 2 ? [0, 1] : CUSTOM_POSITIONS;
    return parsed.map((c, i) => [positions[i], c]);
  }

  function stopsFor(config) {
    if (isLibraryName(config.palette)) return libraryStops(config.palette, config.library) || PALETTES[DEFAULTS.palette];
    const slot = customSlot(config.palette);
    if (slot < 0) return knownPalette(config.palette) ? PALETTES[config.palette] : PALETTES.hive;
    const customs = Array.isArray(config.customs) ? config.customs : null;
    // `config.custom` is the pre-slots shape; honoured so an old saved config and an old
    // query param both keep working.
    const raw = (customs && customs[slot]) || (slot === 0 && Array.isArray(config.custom) ? config.custom : null);
    const parsed = (Array.isArray(raw) ? raw : [])
      .slice(0, CUSTOM_POSITIONS.length)
      .map(hexToRgb)
      .filter(Boolean);
    if (parsed.length < 2) return PALETTES[DEFAULTS.palette];
    // Two colours span 0..1; three sit at 0, 0.5, 1.
    const positions = parsed.length === 2 ? [0, 1] : CUSTOM_POSITIONS;
    return parsed.map((c, i) => [positions[i], c]);
  }

  function lighten(c, k) {
    return [
      Math.round(c[0] + (255 - c[0]) * k),
      Math.round(c[1] + (255 - c[1]) * k),
      Math.round(c[2] + (255 - c[2]) * k),
    ];
  }

  function create(canvas) {
    const ctx = canvas.getContext('2d');

    let cfg = Object.assign({}, DEFAULTS);
    let stops = PALETTES.hive;
    let capColor = rgb(lighten(PALETTES.hive[PALETTES.hive.length - 1][1], 0.35));

    let levels = [];
    let caps = [];
    let capVel = [];
    let capHang = [];
    let target = [];

    // The drawing region, in LOGICAL units — see resize(). Not CSS pixels: one logical unit
    // is `fitScale` CSS pixels, and on the 1920x1080 sources this overlay actually runs in,
    // fitScale is 1 and the two are the same number.
    let cssW = 0, cssH = 0;
    // Offset of the drawing region within the logical space, in logical units. Zero unless
    // a frame rectangle or a region pin is set.
    let regionX = 0, regionY = 0;
    // Logical unit -> CSS pixel, and the letterbox margins that centre the logical space in
    // a source whose aspect ratio is not the logical space's. Both are read by metrics().
    let fitScale = 1, padX = 0, padY = 0;
    let spaceW = REF_W, spaceH = REF_H;
    let gradient = null;
    let lastFrame = 0;
    let lastTick = 0;
    // In turns, advanced by elapsed time rather than by frame count so the rate is the
    // same whether the source renders at 30 or 60 fps.
    let motionPhase = 0;
    // 0..1 from the bottom of the spectrum, for beat-driven movement. Taken from the
    // already-chased `levels`, so it inherits the attack/release the user tuned and needs
    // no second smoother of its own.
    let beatEnergy = 0;
    // The sustained part of the bass. Measured 2026-08-19 on real-shaped music (a bass
    // line under the kicks): the raw bottom-quartile level sat at 0.76–0.88, so driving
    // motion from the ABSOLUTE level produced a 0.88% size wobble — invisible, and the
    // picture rode permanently ~6% large. The documented intent ("punches on the kick and
    // settles back in the gaps") needs the motion to follow what CHANGES, so a slow floor
    // tracks the sustain (rises over ~2s, falls over ~0.6s — a 120ms kick cannot lift it)
    // and the drive is the level ABOVE that floor, scaled by motionPunch.
    let beatFloor = 0;
    let playerUp = true;
    // Capture (public/audio-source.js) is the other source. Tracked separately so
    // "is ANY source live" is not "is the OBS player live".
    let captureUp = false;
    let raf = 0;

    // ── The cap ───────────────────────────────────────────────────────────────────────
    // An accumulator against rAF's own clock, NOT a setTimeout. rAF is the only clock in
    // phase with the compositor; a timer running beside it gives the picture two rhythms
    // to beat between, which reads as stutter at a rate the operator did not ask for.
    // Skipping ticks against a budget keeps the one clock and simply declines some of it.
    //
    // `drawn` is a counter, not a debug afterthought: the only honest way to prove a 30
    // cap is 30 is to count painted frames over a known interval, and a test cannot count
    // what the renderer does not admit to.
    let fpsCap = 0;        // 0 = uncapped, the default — every tick draws
    let fpsBudget = 0;
    let fpsPrev = 0;
    let drawn = 0;
    let fpsHudOn = false;
    let fpsWinT = 0;
    let fpsWinN = 0;
    let measuredFps = 0;

    function notePaint(t) {
      drawn++;
      if (!fpsWinT) fpsWinT = t;
      fpsWinN++;
      const span = t - fpsWinT;
      if (span >= 1000) {
        measuredFps = fpsWinN * 1000 / span;
        fpsWinT = t;
        fpsWinN = 0;
      }
    }

    function paintFpsHud() {
      if (!fpsHudOn || cssW < 8 || cssH < 8) return;
      const label = measuredFps > 0 ? 'EQ ' + Math.round(measuredFps) + ' fps' : 'EQ \u2014 fps';
      ctx.save();
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      ctx.font = 'bold 13px ui-monospace, Consolas, monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      ctx.lineJoin = 'round';
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(0,0,0,0.75)';
      ctx.fillStyle = '#ececec';
      ctx.strokeText(label, 8, cssH - 8);
      ctx.fillText(label, 8, cssH - 8);
      ctx.restore();
    }

    function fpsGate(t) {
      if (!fpsCap) { fpsPrev = t; return false; }
      const interval = 1000 / fpsCap;
      // A first capped tick has no previous to measure from; crediting one interval draws
      // it immediately rather than swallowing a frame at every start().
      fpsBudget += fpsPrev ? (t - fpsPrev) : interval;
      fpsPrev = t;
      if (fpsBudget + FPS_EPS < interval) return true;
      fpsBudget -= interval;
      // Clamped both ways: below zero the epsilon would otherwise accumulate into a slow
      // drift, and above one interval a backgrounded tab (rAF stops; the wall clock does
      // not) would come back owed a burst of frames it must not be allowed to pay.
      if (fpsBudget < 0) fpsBudget = 0;
      else if (fpsBudget > interval) fpsBudget = interval;
      return false;
    }

    function resize() {
      const dpr = (global.devicePixelRatio || 1);
      // 1920x1080, not 900x220, when a canvas has neither a client box nor a width: the
      // fallback should be the space everything else in here is authored in. The old
      // 900x220 pair was the last trace in this file of a "~4:1 source" that was measured
      // on 2026-08-28 and found not to exist — all three EQ browser sources in the stonepc
      // scene collection are 1920x1080.
      const fullW = canvas.clientWidth || canvas.width || REF_W;
      const fullH = canvas.clientHeight || canvas.height || REF_H;
      canvas.width = Math.round(fullW * dpr);
      canvas.height = Math.round(fullH * dpr);

      // ── THE LOGICAL SPACE ────────────────────────────────────────────────────────────
      // Everything this renderer draws is measured in a FIXED space — 1920x1080, the stream
      // frame — which is then mapped onto whatever the source really is by ONE uniform
      // scale, centred. Not two.
      //
      // It used to be two. `cssW = fullW * rw` and `cssH = fullH * rh` scaled the horizontal
      // and vertical by unrelated factors, so the picture took the aspect ratio of whichever
      // element it happened to be in, multiplied by the skew between the rectangle's own
      // proportions and 16:9. A 900x220 rectangle previewed in the studio's 412x260 box came
      // out at roughly 12.5:1 while the overlay drew it at 4.09:1 — the same saved numbers,
      // two different pictures, which is the whole reason a preview stops being worth having.
      //
      // With one uniform `fitScale` the preview is a scaled photograph of the overlay and
      // nothing else. The cost is that a PLACED look on a source which is not 16:9 letterboxes
      // rather than stretches — and that cost is zero on every surface that exists today: all
      // three EQ browser sources in the stonepc scene collection are 1920x1080, listen.html's
      // #stage is aspect-ratio:16/9, and the studio preview was moved to 16:9 (capped at
      // 960x540, exactly half) in the same change. A config with nothing placed does not enter
      // the fixed space at all — see the first branch below.
      //
      // cssW/cssH remain what every style measures itself against — bar slots, mirror
      // midpoint, radial radius, the lot — so no painter below needs to know any of this
      // happened. They are now logical units rather than CSS pixels; on a 1920x1080 source
      // fitScale is 1 and they are numerically identical to what they always were.
      let rx = 0, ry = 0, rw = 1, rh = 1;
      spaceW = REF_W; spaceH = REF_H;

      // The saved rectangle is in stream-frame pixels, and the same saved value has to be
      // right for two different kinds of source, so each source still decides for itself:
      //
      //   - a source OBS has already sized to that rectangle IS the rectangle. The placing
      //     has been done, by OBS; doing it again would inset the bars inside their own box.
      //     So the logical space becomes the rectangle and fills the source exactly.
      //   - a source of a DIFFERENT shape gets the whole 1920x1080 frame, with the rectangle
      //     drawn inside it as a fraction of that frame — never as a fraction of the source.
      //
      // Same shape means same aspect ratio, a comparison that needs no knowledge of the
      // stream canvas size, which is exactly why it is the test: a Browser Source cannot know
      // how big the stream is. 900x220 inside a 900x220 source matches; inside 1920x1080 it
      // does not; inside 2560x1440 it does not either, and lands proportionally.
      const frac = (v) => (Number.isFinite(v) ? clamp(v, 0, 1) : null);
      const fw = Number(cfg && cfg.frameW) || 0;
      const fh = Number(cfg && cfg.frameH) || 0;
      const framed = fw > 0 && fh > 0 && fullW > 0 && fullH > 0;
      if (framed) {
        const sameShape = Math.abs(Math.log((fw / fh) / (fullW / fullH))) < ASPECT_TOL;
        if (sameShape) {
          spaceW = fw; spaceH = fh;
        } else {
          rw = fw / REF_W;
          rh = fh / REF_H;
          rx = (Number(cfg.frameX) || 0) / REF_W;
          ry = (Number(cfg.frameY) || 0) / REF_H;
        }
      }

      // An explicit region is a PER-SOURCE pin (?box=) and beats the saved rectangle outright,
      // the same way every other pin on this overlay does. Fractions OF THE LOGICAL SPACE now,
      // not of the canvas — the same numbers on a 16:9 source, and the difference is precisely
      // the bug this change removes.
      if (frac(cfg && cfg.regionW) !== null) rw = frac(cfg.regionW);
      if (frac(cfg && cfg.regionH) !== null) rh = frac(cfg.regionH);
      if (frac(cfg && cfg.regionX) !== null) rx = frac(cfg.regionX);
      if (frac(cfg && cfg.regionY) !== null) ry = frac(cfg.regionY);

      rw = Math.max(0.01, rw);
      rh = Math.max(0.01, rh);
      // Clamped so a region can be pushed to an edge but never entirely outside the logical
      // space, which would be an equalizer that is running and invisible — the hardest kind
      // of "broken".
      rx = Math.max(0, Math.min(rx, 1 - rw));
      ry = Math.max(0, Math.min(ry, 1 - rh));

      // NOTHING HAS BEEN PLACED — no saved rectangle, and either no region pin or one that
      // covers the whole space, which is the same statement. Then there is no rectangle whose
      // shape could be distorted, and the only sensible reading of the config is "fill
      // whatever source I am": the logical space is the source, fitScale is exactly 1, and
      // this is byte for byte the code it was before the fixed space existed.
      //
      // Deliberately NOT folded into the fixed space. Letterboxing a 1920x1080 frame into a
      // source of some other shape would be a visible change to every overlay that has never
      // opened the Placement panel, in exchange for nothing: with nothing placed there is no
      // placement to get wrong, and on the 16:9 sources this actually runs on the two
      // readings are the same picture anyway. tests/eq-region-smoke.js asserts it four times,
      // including "an explicit full region is identical to no region at all" — which is why
      // the test is on the RESOLVED rectangle after the pins, not on whether a pin was given.
      if (!framed && rw === 1 && rh === 1 && rx === 0 && ry === 0) {
        spaceW = fullW; spaceH = fullH;
      }

      // ONE scale for both axes, and the letterbox margins that centre what it produces.
      fitScale = Math.min(fullW / spaceW, fullH / spaceH);
      padX = (fullW - spaceW * fitScale) / 2;
      padY = (fullH - spaceH * fitScale) / 2;

      cssW = spaceW * rw;
      cssH = spaceH * rh;
      regionX = spaceW * rx;
      regionY = spaceH * ry;

      // The translate is rounded to whole DEVICE pixels — the region's origin landing on a
      // half pixel is a resampled seam down the left edge of the bars at exactly the sizes
      // a letterboxed fit produces.
      const s = fitScale * dpr;
      ctx.setTransform(s, 0, 0, s,
        Math.round((padX + regionX * fitScale) * dpr),
        Math.round((padY + regionY * fitScale) * dpr));

      // The per-frame clear only covers the region, so anything drawn outside it by a PREVIOUS
      // region — or into a letterbox band that has just narrowed — would stay on the canvas
      // forever. Clear the whole surface whenever the geometry changes; identity transform
      // because neither the fit scale nor the region translate must apply to this.
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.restore();

      gradient = null;
    }

    function sizeArrays(n) {
      if (levels.length === n) return;
      levels = new Array(n).fill(0);
      caps = new Array(n).fill(0);
      capVel = new Array(n).fill(0);
      capHang = new Array(n).fill(0);
      target = new Array(n).fill(0);
    }

    // Merge base config with the saved settings for the ACTIVE style, so switching to
    // led and back does not lose the tuning that bars had.
    function setConfig(next) {
      const base = Object.assign({}, DEFAULTS);
      for (const key of Object.keys(DEFAULTS)) {
        if (next && Object.prototype.hasOwnProperty.call(next, key)) base[key] = next[key];
      }
      // The library rides on the config but is not a DEFAULTS key (deliberately: the per-style
      // loop below must never adopt a per-style library). Carry it across by hand.
      if (next && next.library && typeof next.library === 'object') base.library = next.library;
      const perStyle = next && next.styles && Object.prototype.hasOwnProperty.call(next.styles, base.style)
        ? next.styles[base.style] : null;
      if (perStyle) {
        for (const key of Object.keys(DEFAULTS)) {
          // customs is the shared palette library, not a per-style value — a style picks
          // WHICH slot it uses, never what is in it.
          if (key === 'style' || key === 'bands' || key === 'customs') continue;
          if (Object.prototype.hasOwnProperty.call(perStyle, key)) base[key] = perStyle[key];
        }
      }
      if (MOTIONS.indexOf(base.motion) < 0) base.motion = DEFAULTS.motion;
      if (FILLS.indexOf(base.fill) < 0) base.fill = DEFAULTS.fill;
      // Legacy: a config or URL that predates the motion picker carries `spin` in degrees
      // per second. Honour it, but never override an explicit motion. "Explicit" means the
      // CALLER named one (top level or for the active style) — not that the merge filled it
      // from DEFAULTS. That distinction was invisible while the default motion was 'none';
      // the moment the default became 'pulse' (2026-08-19), testing the merged value would
      // have silently un-spun every pre-picker config that carried only `spin`.
      const motionChosen = (next && Object.prototype.hasOwnProperty.call(next, 'motion'))
        || (perStyle && Object.prototype.hasOwnProperty.call(perStyle, 'motion'));
      if ((base.motion === 'none' || !motionChosen) && Number.isFinite(base.spin) && base.spin !== 0) {
        base.motion = 'spin';
        base.motionRate = base.spin / 360;
      }
      if (STYLES.indexOf(base.style) < 0) base.style = DEFAULTS.style;
      if (customSlot(base.palette) < 0 && !knownPalette(base.palette) && !isLibraryName(base.palette)) base.palette = DEFAULTS.palette;
      const regionMoved = !cfg
        || cfg.regionX !== base.regionX || cfg.regionY !== base.regionY
        || cfg.regionW !== base.regionW || cfg.regionH !== base.regionH
        || cfg.frameX !== base.frameX || cfg.frameY !== base.frameY
        || cfg.frameW !== base.frameW || cfg.frameH !== base.frameH;

      cfg = base;
      stops = stopsFor(cfg);
      capColor = rgb(lighten(stops[stops.length - 1][1], 0.35));
      gradient = null;

      // cssW/cssH are derived from the region now, so a region arriving in a config has to be
      // re-measured — otherwise it would take a window resize to notice, which on an OBS
      // Browser Source never happens.
      if (regionMoved) resize();
    }

    function push(bands) {
      if (!bands || !bands.length) return;
      // A frame arriving is a live feed. Standalone overlays get `{player:false}` on
      // connect because there is no obs.html; without this they zero every band on
      // the next paint even though data just landed.
      captureUp = true;
      sizeArrays(bands.length);
      for (let i = 0; i < bands.length; i++) {
        // Byte magnitudes are already a dB window mapped to 0-255, so this stays close
        // to linear; a big lift here double-counts the log and pegs everything.
        target[i] = clamp(Math.pow(clamp(bands[i], 0, 255) / 255, 1.15) * cfg.gain, 0, 1);
      }
      lastFrame = now();
    }

    function now() { return global.performance ? global.performance.now() : 0; }

    function barGradient(height) {
      if (gradient) return gradient;
      const g = ctx.createLinearGradient(0, height, 0, 0);
      for (const [p, c] of stops) g.addColorStop(p, rgb(c));
      gradient = g;
      return g;
    }

    // Every alpha in the renderer goes through here, so the transparency setting scales
    // the whole picture instead of being fought by a painter that resets to 1.
    function setAlpha(a) { ctx.globalAlpha = cfg.opacity * a; }

    // One transform around the centre, applied before the style paints. Every style gets
    // motion from this and none of them know about it — which is the only reason "apply
    // it to all" did not mean seven separate implementations.
    function applyMotion() {
      if (cfg.motion === 'none') return false;
      const turn = motionPhase * Math.PI * 2;
      // Normally a clock: -1..1, an even swing either side of rest. With motionBeat the
      // music drives it instead — 0..1 from the bass, so the movement punches outward on
      // the kick and settles back in the gaps rather than keeping its own time.
      const swing = cfg.motionBeat ? beatEnergy : Math.sin(turn);
      const depth = clamp(cfg.motionDepth, 0, 1);
      const cx = cssW / 2;
      const cy = cssH / 2;
      ctx.save();
      ctx.translate(cx, cy);
      switch (cfg.motion) {
        case 'spin':  ctx.rotate(turn); break;
        // Capped at 30 degrees: past that a wide source swings its own corners offscreen.
        case 'rock':  ctx.rotate(swing * depth * (Math.PI / 6)); break;
        case 'sway':  ctx.translate(swing * depth * cssW * 0.15, 0); break;
        case 'bob':   ctx.translate(0, swing * depth * cssH * 0.15); break;
        case 'pulse': { const s = 1 + swing * depth * 0.25; ctx.scale(s, s); break; }
      }
      ctx.translate(-cx, -cy);
      return true;
    }

    function roundedBar(x, y, w, h, r) {
      const rr = Math.min(r, h / 2, w / 2);
      ctx.beginPath();
      ctx.moveTo(x, y + h);
      ctx.lineTo(x, y + rr);
      ctx.quadraticCurveTo(x, y, x + rr, y);
      ctx.lineTo(x + w - rr, y);
      ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
      ctx.lineTo(x + w, y + h);
      ctx.closePath();
      ctx.fill();
    }

    // ── Style painters ──
    // Each receives a geometry object so none of them recompute the layout.

    function paintBars(g) {
      const grad = barGradient(g.maxH);
      for (let i = 0; i < g.n; i++) {
        const h = levels[i] * g.maxH;
        const x = g.slotX(i);
        if (h >= 1) {
          ctx.fillStyle = cfg.fill === 'solid' ? rgb(sample(stops, levels[i])) : grad;
          roundedBar(x, g.base - h, g.barW, h, Math.min(g.barW / 2, 3));
          if (cfg.mirror) {
            setAlpha(cfg.mirrorOpacity);
            roundedBar(x, g.base, g.barW, h, Math.min(g.barW / 2, 3));
            setAlpha(1);
          }
        } else if (cfg.floor) {
          ctx.fillStyle = 'rgba(255,255,255,0.10)';
          ctx.fillRect(x, g.base - 1, g.barW, 1);
        }
      }
    }

    function paintLed(g) {
      const segs = Math.max(3, Math.round(cfg.segments));
      const segH = g.maxH / segs;
      const litH = Math.max(1, segH * 0.68);
      for (let i = 0; i < g.n; i++) {
        const x = g.slotX(i);
        const lit = Math.round(levels[i] * segs);
        for (let s = 0; s < segs; s++) {
          const t = s / (segs - 1);
          const on = s < lit;
          if (!on && !cfg.floor) continue;
          ctx.fillStyle = on ? rgb(sample(stops, cfg.fill === 'solid' ? levels[i] : t)) : 'rgba(255,255,255,0.06)';
          const y = g.base - (s + 1) * segH;
          ctx.fillRect(x, y, g.barW, litH);
          // The reflection was drawn at full brightness here while bars and blocks dimmed
          // theirs — so "mirror" meant two different things depending on the style.
          if (cfg.mirror) {
            setAlpha(cfg.mirrorOpacity);
            ctx.fillRect(x, g.base + s * segH + (segH - litH), g.barW, litH);
            setAlpha(1);
          }
        }
        // The peak rides as one bright segment, not a hairline — it has to read as an
        // LED at the sizes an overlay actually gets used at.
        if (cfg.caps && caps[i] > 0.01) {
          const s = Math.min(segs - 1, Math.round(caps[i] * segs));
          ctx.fillStyle = capColor;
          ctx.fillRect(x, g.base - (s + 1) * segH, g.barW, litH);
        }
      }
    }

    // A skyline: contiguous columns, quantised heights, no gaps. Deliberately ignores
    // cfg.gap — with gaps it was indistinguishable from bars, and a style that looks
    // like another style is not a style.
    function paintBlocks(g) {
      const steps = Math.max(3, Math.round(cfg.segments));
      const grad = barGradient(g.maxH);
      const w = Math.ceil(g.slot) + 1;   // overlap by a pixel so no seam shows through
      for (let i = 0; i < g.n; i++) {
        const h = (Math.round(levels[i] * steps) / steps) * g.maxH;
        const x = i * g.slot;
        if (h >= 1) {
          ctx.fillStyle = cfg.fill === 'solid' ? rgb(sample(stops, levels[i])) : grad;
          ctx.fillRect(x, g.base - h, w, h);
          if (cfg.mirror) {
            setAlpha(cfg.mirrorOpacity);
            ctx.fillRect(x, g.base, w, h);
            setAlpha(1);
          }
        } else if (cfg.floor) {
          ctx.fillStyle = 'rgba(255,255,255,0.10)';
          ctx.fillRect(x, g.base - 2, w, 2);
        }
        // Caps drawn here rather than in the shared pass, because this style lays its
        // columns out contiguously and the shared pass assumes gapped slots.
        if (cfg.caps && caps[i] > 0.01) {
          ctx.fillStyle = capColor;
          ctx.fillRect(x, Math.max(0, g.base - caps[i] * g.maxH - 2), w, 2);
        }
      }
    }

    function spectrumPath(g) {
      ctx.beginPath();
      const step = cssW / (g.n - 1 || 1);
      ctx.moveTo(0, g.base - levels[0] * g.maxH);
      for (let i = 1; i < g.n; i++) {
        const x0 = (i - 1) * step, y0 = g.base - levels[i - 1] * g.maxH;
        const x1 = i * step, y1 = g.base - levels[i] * g.maxH;
        const mx = (x0 + x1) / 2;
        ctx.bezierCurveTo(mx, y0, mx, y1, x1, y1);
      }
    }

    function paintWave(g) {
      if (g.n < 2) return;
      spectrumPath(g);
      ctx.lineTo(cssW, g.base);
      ctx.lineTo(0, g.base);
      ctx.closePath();
      // A wave is one closed shape, so 'solid' is one flat colour: the palette's middle, the same
      // pick the line style makes.
      ctx.fillStyle = cfg.fill === 'solid' ? rgb(sample(stops, 0.5)) : barGradient(g.maxH);
      setAlpha(0.85);
      ctx.fill();
      setAlpha(1);
      spectrumPath(g);
      ctx.strokeStyle = capColor;
      ctx.lineWidth = Math.max(1, cfg.thickness * 0.6);
      ctx.stroke();
    }

    function paintLine(g) {
      if (g.n < 2) return;
      spectrumPath(g);
      ctx.strokeStyle = rgb(sample(stops, 0.5));
      ctx.lineWidth = Math.max(1, cfg.thickness);
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      if (cfg.glow > 0) {
        ctx.shadowColor = rgb(sample(stops, 1), cfg.glow);
        ctx.shadowBlur = 8 + cfg.glow * 18;
      }
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    function paintDots(g) {
      const r = Math.max(1.5, cfg.thickness);
      for (let i = 0; i < g.n; i++) {
        const x = g.slotX(i) + g.barW / 2;
        const y = g.base - levels[i] * g.maxH;
        // Trail: a few ghosts down the column so a dot reads as having travelled.
        if (cfg.glow > 0) {
          for (let t = 1; t <= 3; t++) {
            const ty = y + t * r * 2.4;
            if (ty > g.base) break;
            ctx.fillStyle = rgb(sample(stops, levels[i]), cfg.glow * (0.4 / t));
            ctx.beginPath();
            ctx.arc(x, ty, r * (1 - t * 0.18), 0, Math.PI * 2);
            ctx.fill();
          }
        }
        ctx.fillStyle = rgb(sample(stops, levels[i]));
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
        if (cfg.caps && caps[i] > 0.01) {
          ctx.fillStyle = capColor;
          ctx.beginPath();
          ctx.arc(x, g.base - caps[i] * g.maxH, Math.max(1, r * 0.45), 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    function paintRadial(g) {
      const cx = cssW / 2, cy = cssH / 2;
      const inner = Math.min(cssW, cssH) * clamp(cfg.radius, 0.05, 0.9) / 2;
      const outer = Math.min(cssW, cssH) / 2;
      const span = outer - inner;
      const step = (Math.PI * 2) / g.n;
      const w = Math.max(1, step * inner * (1 - cfg.gap));
      for (let i = 0; i < g.n; i++) {
        const a = i * step - Math.PI / 2;
        const len = levels[i] * span;
        if (len < 1) continue;
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(a);
        ctx.fillStyle = rgb(sample(stops, levels[i]));
        ctx.fillRect(-w / 2, -(inner + len), w, len);
        if (cfg.caps && caps[i] > 0.01) {
          ctx.fillStyle = capColor;
          ctx.fillRect(-w / 2, -(inner + caps[i] * span) - 2, w, 2);
        }
        ctx.restore();
      }
    }

    const PAINTERS = {
      bars: paintBars, led: paintLed, blocks: paintBlocks,
      wave: paintWave, line: paintLine, dots: paintDots, radial: paintRadial,
    };

    function frame(t) {
      // The reschedule is duplicated here rather than hoisted, because the one at the
      // bottom of this function is the ONLY thing keeping the loop alive — an early
      // return past it stops the overlay permanently, and it would stop it silently.
      if (fpsGate(t)) { if (raf) raf = global.requestAnimationFrame(frame); return; }
      notePaint(t);
      // lastTick is NOT touched by a skipped tick, so dt here is the real elapsed time
      // since the last PAINTED frame. Everything below is driven from dt, which is what
      // makes the picture a function of the clock rather than of the frame count.
      const dt = Math.min(64, t - lastTick);
      lastTick = t;

      // Wrapped at one turn, so a source left running for days cannot drift into the
      // range where a float stops resolving the per-frame increment.
      if (cfg.motion !== 'none') {
        motionPhase = (motionPhase + cfg.motionRate * (dt / 1000)) % 1;
      }

      const stale = (!playerUp && !captureUp) || (t - lastFrame) > STALE_MS;
      if (stale) for (let i = 0; i < target.length; i++) target[i] = 0;

      ctx.clearRect(0, 0, cssW, cssH);
      // Set once per frame so the styles that never touch alpha still honour the
      // transparency setting.
      setAlpha(1);

      const n = levels.length;
      if (n > 0 && cssW > 0 && cssH > 0) {
        // Attack and release are per-FRAME fractions, and they were tuned at 60 fps — so
        // applied unchanged at any other rate they chase at the wrong SPEED. That is not a
        // subtlety the cap could ignore: at 30 fps every bar would have taken twice as long
        // to reach the same height, and because beatEnergy below is read off these very
        // levels, the beat drive would have gone soft at exactly the setting a phone picks.
        // (It also means a 144 Hz desktop has always chased ~2.4x too fast — same defect,
        // opposite direction, present before this change and fixed by the same line.)
        //
        // `1-(1-a)^(dt/16.667)` is the same fraction expressed as a rate: it is EXACTLY `a`
        // when dt is one 60 fps frame, so the tuned look at 60 is untouched, and it holds
        // that look at 30, at 144, and across a dropped frame.
        const ticks = dt / FPS_REF_MS;
        const kAttack = 1 - Math.pow(1 - clamp(cfg.attack, 0, 1), ticks);
        const kRelease = 1 - Math.pow(1 - clamp(cfg.release, 0, 1), ticks);
        for (let i = 0; i < n; i++) {
          const want = target[i] || 0;
          levels[i] += (want - levels[i]) * (want > levels[i] ? kAttack : kRelease);
          if (levels[i] < 0.0015) levels[i] = 0;

          if (levels[i] >= caps[i]) { caps[i] = levels[i]; capVel[i] = 0; capHang[i] = CAP_HANG_MS; }
          else if (capHang[i] > 0) { capHang[i] -= dt; }
          else { capVel[i] += CAP_GRAVITY * dt; caps[i] = Math.max(levels[i], caps[i] - capVel[i] * dt); }
        }

        const radial = cfg.style === 'radial';
        const base = radial ? cssH : (cfg.mirror ? cssH / 2 : cssH);
        const maxH = radial ? cssH : (cfg.mirror ? cssH / 2 : cssH);
        const slot = cssW / n;
        const barW = Math.max(1, slot * (1 - cfg.gap));
        // The kick lives at the bottom of the spectrum; averaging the whole range would
        // track overall loudness and barely move between a verse and a drop.
        if (cfg.motionBeat) {
          const lows = Math.max(1, Math.round(n * 0.25));
          let sum = 0;
          for (let i = 0; i < lows; i++) sum += levels[i];
          const raw = clamp(sum / lows, 0, 1);
          const k = dt / 1000;
          if (raw > beatFloor) beatFloor += (raw - beatFloor) * Math.min(1, k / 2.0);
          else beatFloor += (raw - beatFloor) * Math.min(1, k / 0.6);
          const punch = Number.isFinite(cfg.motionPunch) ? cfg.motionPunch : 1;
          // ×6 maps a typical kick residual (~0.12 over the floor) to a visible swing at
          // punch 1; punch scales from there and the clamp keeps every motion inside the
          // caps it already promised (rock's 30°, pulse's depth ceiling).
          beatEnergy = clamp((raw - beatFloor) * 6 * punch, 0, 1);
        }

        const g = { n, base, maxH, slot, barW, slotX: (i) => i * slot + (slot - barW) / 2 };

        // Motion wraps the painting only — the level chasing above is arithmetic and must
        // not be inside a transform.
        const moved = applyMotion();
        // try/finally, not try/catch: a painter that throws must not escape the animation
        // frame, because the reschedule at the bottom would never run and the overlay
        // would freeze permanently — and an unbalanced save() would leave the transform
        // applied to every later frame. The error still surfaces in the console.
        try {
          (PAINTERS[cfg.style] || paintBars)(g);

          // Bars is the only style using the shared cap pass; every other style either
          // draws a cap shaped to its own geometry or has no meaningful cap at all.
          if (cfg.caps && cfg.style === 'bars') {
            ctx.fillStyle = capColor;
            for (let i = 0; i < n; i++) {
              if (caps[i] <= 0.01) continue;
              ctx.fillRect(g.slotX(i), Math.max(0, base - caps[i] * maxH - 2), barW, 2);
            }
          }
        } finally {
          // Caps are part of the picture, so the restore comes after them — and it runs
          // even if a painter threw, or the canvas keeps the transform for good.
          if (moved) ctx.restore();
        }
      }

      paintFpsHud();
      if (raf) raf = global.requestAnimationFrame(frame);
    }

    function start() {
      if (raf) return;
      lastTick = now();
      // A restart is a fresh budget. Carrying the old one over means the first tick after
      // a hide/show is decided by how long the page was hidden, which is not a rate.
      fpsBudget = 0; fpsPrev = 0;
      fpsWinT = 0; fpsWinN = 0;
      raf = global.requestAnimationFrame(frame);
    }
    function stop() {
      if (raf) { global.cancelAnimationFrame(raf); raf = 0; }
      measuredFps = 0; fpsWinT = 0; fpsWinN = 0;
    }

    // The cap is per SURFACE, so it is set through the renderer and never travels in the
    // saved config: the OBS overlay wanting 60 and the phone wanting 30 is the normal case,
    // and a config broadcast would make one of them wrong every time the other was set.
    function setFps(v) {
      const next = normaliseFps(v);
      if (next === fpsCap) return;
      fpsCap = next;
      fpsBudget = 0; fpsPrev = 0;
      fpsWinT = 0; fpsWinN = 0;
    }

    resize();
    if (global.addEventListener) global.addEventListener('resize', resize);

    return {
      setConfig, push, start, stop, resize, setFps,
      setPlayerUp: (up) => { playerUp = up !== false; },
      setCaptureUp: (up) => { captureUp = up === true; },
      config: () => cfg,
      levels: () => levels,
      // The cap in force, and the count of frames actually painted. framesDrawn is what
      // makes the cap TESTABLE: two readings and a wall-clock interval give a measured
      // rate, which is the only claim worth making about a frame limiter.
      fps: () => fpsCap,
      framesDrawn: () => drawn,
      // Painted frames over the last completed second, not the cap. 0 until one second
      // of paints has been seen. This is what a HUD must show — fps() is the limiter.
      measuredFps: () => (raf ? measuredFps : 0),
      setFpsHud: (on) => { fpsHudOn = on === true; },
      // Debug surface, same spirit as levels(): what the beat drive is actually doing —
      // the raw bass, the sustain floor under it, and the swing the transform receives.
      motion: () => ({ energy: beatEnergy, floor: beatFloor, phase: motionPhase }),
      // The resolved coordinate space. Exported for the same reason framesDrawn() is: the
      // only honest way to prove "the preview is a true scaled preview of the overlay" is
      // to read the two surfaces' geometry back and compare them, and a test cannot compare
      // what the renderer will not admit to. `fit` is the single uniform logical-unit-to-CSS
      // -pixel scale; two surfaces agree when every field below except `fit`, `padX` and
      // `padY` matches, and those three differ by exactly the size ratio.
      metrics: () => ({
        spaceW, spaceH,                     // the logical space, in logical units
        regionW: cssW, regionH: cssH,       // the drawing region within it
        regionX, regionY,
        fit: fitScale, padX, padY,          // how that space lands on this canvas
        cssW: cssW * fitScale, cssH: cssH * fitScale,   // region size in real CSS pixels
      }),
    };
  }

  // sample/stopsFor/hexToRgb are exported so the settings studio can seed and preview a
  // custom palette with the SAME maths the renderer uses. Re-deriving them in the page
  // is how a preview starts disagreeing with the overlay.
  function applyLoadTrim(cfg, trim) {
    if (!cfg || typeof cfg !== 'object') return cfg;
    if (!trim || typeof trim !== 'object' || Array.isArray(trim)) return cfg;
    let out;
    try { out = JSON.parse(JSON.stringify(cfg)); }
    catch { return cfg; }
    const minNum = (key) => {
      if (Number.isFinite(trim[key]) && Number.isFinite(out[key])) out[key] = Math.min(out[key], trim[key]);
    };
    minNum('glow');
    minNum('bands');
    minNum('segments');
    if (trim.mirror === false) out.mirror = false;
    if (trim.caps === false) out.caps = false;
    if (trim.motion === 'none') out.motion = 'none';
    // setConfig lays styles[active] on top of the base. Ceiling every per-style
    // block too, or a radial look with its own glow/motion/caps never cheapens.
    if (out.styles && typeof out.styles === 'object') {
      for (const name of Object.keys(out.styles)) {
        const block = out.styles[name];
        if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
        if (Number.isFinite(trim.glow) && Number.isFinite(block.glow)) block.glow = Math.min(block.glow, trim.glow);
        if (Number.isFinite(trim.segments) && Number.isFinite(block.segments)) {
          block.segments = Math.min(block.segments, trim.segments);
        }
        if (trim.mirror === false) block.mirror = false;
        if (trim.caps === false) block.caps = false;
        if (trim.motion === 'none') block.motion = 'none';
      }
    }
    return out;
  }

  global.EqRender = {
    create, STYLES, PALETTES, DEFAULTS, sample, stopsFor, hexToRgb,
    CUSTOM_POSITIONS, CUSTOM_SLOTS, DEFAULT_CUSTOMS, customSlot, MOTIONS,
    isLibraryName, libraryNames, FILLS, FILL_STYLES,
    // The cap's vocabulary, exported for the same reason the style tables are: the pages
    // build their pickers from these and the tests assert them, so the legal values live
    // in one place instead of being retyped on every surface.
    FPS_OPTIONS, FPS_LABELS, normaliseFps,
    applyLoadTrim,
  };
  if (typeof module === 'object' && module.exports) module.exports = global.EqRender;
})(typeof window !== 'undefined' ? window : globalThis);
