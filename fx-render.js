/**
 * HiveFX renderer — shared by the overlay (fx.html) and the settings studio (fx-settings.html).
 * ============================================================================================
 * ONE copy, deliberately, for the same reason eq-render.js is one copy: the studio's preview
 * has to be the thing viewers actually see. Two renderers drift the first time an effect is
 * tuned in one of them, and a preview that lies is worse than no preview.
 *
 * Owns: the particle systems, the palettes, beat detection, and the global particle budget.
 * Knows nothing about WebSockets, config storage, or where a trigger came from.
 *
 *   const fx = FxRender.create(canvasElement);
 *   fx.setConfig(cfg);                       // see DEFAULTS
 *   fx.fire('fireworks', { intensity: 1 });  // one burst
 *   fx.pushBands(bandsArray);                // 0-255 per band, drives beat detection
 *   fx.setPlayerUp(bool);                    // false stops beat spawns
 *   fx.start(); fx.stop();
 *
 * ONE SAFETY RULE is load-bearing since words shipped (2026-08-21), and it is the rule the
 * README's old "this service does not own text" paragraph used to buy for free:
 *
 *   VIEWER-SUPPLIED TEXT REACHES A CANVAS AND NEVER AN HTML STRING. ctx.fillText rasterises
 *   glyphs; it cannot execute anything, so a string that ends up on this canvas is data all the
 *   way down. The injection surface only opens if a word is written into innerHTML somewhere —
 *   a "last word sent" readout, a preview list, a tooltip. Do not do that, in any of the three
 *   pages that load this file. What remains after that rule is held is bounded and handled in
 *   sanitiseWordText(): length, combining marks (Zalgo), bidi overrides, and rate.
 *
 * Two performance rules are load-bearing, and both are about OBS rather than a desktop browser:
 *
 *   1. NO per-particle ctx.shadowBlur. It is the obvious way to get glow and it collapses the
 *      framerate once there are hundreds of glowing particles, because each draw re-rasterises
 *      a blur. Glow here is a pre-rendered radial-gradient sprite, cached per colour, composited
 *      with 'lighter'. That is one drawImage per particle instead of one blur per particle.
 *   2. ONE global budget, not a per-effect ceiling. Per-effect caps can all be maxed at once,
 *      which is precisely the moment the overlay needs to stay cheap. Ambient weather gets its
 *      own separate small budget so a firework barrage cannot starve the snow, and vice versa.
 */
(function (root, factory) {
  'use strict';
  // Same wrapper as fx-bpm.js: the browser gets window.FxRender, and Node can require() it for the
  // pure parts. create() is the only thing that touches a DOM, so requiring this costs nothing.
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FxRender = api;
})(typeof window !== 'undefined' ? window : null, function (global) {
  'use strict';

  const EFFECTS = ['fireworks', 'confetti', 'embers', 'hearts', 'fountain', 'nova'];

  /**
   * The weather, as data rather than as branches.
   *
   * This started as a single `rain` boolean baked into every particle, which was fine for two
   * modes and would have been a growing pile of `if (mode === …)` for seven. A mode is now a row:
   * how fast it travels, how far it wanders, what it is drawn as. Adding one is adding a row.
   *
   *   fall     px/s along y, before the Speed setting. NEGATIVE rises — bubbles and sparks go up,
   *            and a range whose top is <= 0 is what marks a mode as rising.
   *   drift    px/s along x, before Wind is added.
   *   sway     amplitude of the sideways wander, in px/s.
   *   size     multiplier over the Size setting, per particle.
   *   draw     'sprite' (glow dot), 'streak' (a line, for rain), 'ring' (an outline, for bubbles),
   *            'leaf' (a rotating filled ellipse), 'petal' (a teardrop), 'cloud' (a cached multi-puff soft sprite).
   *   twinkle  how much this mode pulses in brightness, scaled by the Twinkle setting.
   *   spin     how hard it tumbles, scaled by the Spin setting. 'leaf' and 'petal' show it.
   *   dscale   what one step of the shared Density slider is worth here. Clouds are enormous next
   *            to a snowflake, so the same 140 that reads as gentle snow reads as a whiteout of
   *            puffs — this keeps one slider meaningful across modes. Absent means 1.
   *   band     [top, bottom] as fractions of the frame height this mode lives in. Fog hugs the
   *            floor and storm clouds hug the ceiling; everything else roams the whole frame.
   *   bolts    this mode also runs the lightning scheduler (see the bolts array in create()).
   *   random   false keeps the mode out of the 'random' roll, in BOTH roll implementations —
   *            here and server.js. A surprise full-screen flash mid-stream is not a surprise
   *            anyone asked for; the flashing modes only ever run when chosen by name.
   */
  const AMBIENT_MODES = {
    snow:      { fall: [30, 90],     drift: [-25, 25], sway: [8, 28],  size: [0.5, 1.4],  draw: 'sprite', twinkle: 0,    spin: 0 },
    rain:      { fall: [700, 1100],  drift: [-40, 40], sway: [0, 0],   size: [0.6, 1.1],  draw: 'streak', twinkle: 0,    spin: 0 },
    stars:     { fall: [1, 9],       drift: [-6, 6],   sway: [0, 3],   size: [0.25, 0.9], draw: 'sprite', twinkle: 0.85, spin: 0 },
    fireflies: { fall: [-18, 18],    drift: [-18, 18], sway: [18, 46], size: [0.3, 0.8],  draw: 'sprite', twinkle: 0.8,  spin: 0 },
    bubbles:   { fall: [-160, -60],  drift: [-18, 18], sway: [10, 30], size: [0.8, 2.2],  draw: 'ring',   twinkle: 0.25, spin: 0 },
    leaves:    { fall: [40, 110],    drift: [-30, 30], sway: [14, 40], size: [1, 2.2],    draw: 'leaf',   twinkle: 0,    spin: 1 },
    petals:    { fall: [22, 65],     drift: [-22, 22], sway: [18, 48], size: [0.9, 1.8],  draw: 'petal',  twinkle: 0,    spin: 1.2, dscale: 0.7 },
    sparks:    { fall: [-200, -80],  drift: [-14, 14], sway: [8, 26],  size: [0.25, 0.7], draw: 'sprite', twinkle: 0.5,  spin: 0 },
    meteors:   { fall: [380, 680],   drift: [260, 520], sway: [0, 0],  size: [0.8, 1.8],  draw: 'streak', twinkle: 0,    spin: 0, dscale: 0.12 },
    clouds:    { fall: [-4, 4],      drift: [6, 26],   sway: [2, 8],   size: [5, 11],     draw: 'cloud',  twinkle: 0,    spin: 0, dscale: 0.08 },
    fog:       { fall: [-2, 2],      drift: [4, 14],   sway: [1, 5],   size: [9, 18],     draw: 'cloud',  twinkle: 0,    spin: 0, dscale: 0.05, band: [0.55, 1] },
    storm:     { fall: [600, 1000],  drift: [-60, 60], sway: [0, 0],   size: [0.6, 1.2],  draw: 'streak', twinkle: 0,    spin: 0, bolts: true, random: false },
    lightning: { fall: [-3, 3],      drift: [5, 18],   sway: [2, 6],   size: [6, 13],     draw: 'cloud',  twinkle: 0,    spin: 0, dscale: 0.05, band: [0, 0.4], bolts: true, random: false },
  };
  // Deliberately a literal and not Object.keys(AMBIENT_MODES): tests/hive-fx-smoke.js reads this
  // line out of the source and compares it with the server's allowlist, because two files drifting
  // apart means the server accepts a mode the overlay silently ignores and nothing logs anything.
  // A separate test asserts this list and the table above agree, so neither can be edited alone.
  const AMBIENTS = ['off', 'snow', 'rain', 'stars', 'fireflies', 'bubbles', 'leaves', 'petals', 'sparks', 'meteors', 'clouds', 'fog', 'storm', 'lightning', 'random'];
  const AMBIENT_MODE_NAMES = Object.keys(AMBIENT_MODES);
  // What 'random' may land on. server.js keeps its own copy of this exclusion (NO_ROLL) because
  // the two roll implementations are deliberately separate files — the smoke test holds them equal.
  const ROLLABLE_AMBIENTS = AMBIENT_MODE_NAMES.filter((n) => AMBIENT_MODES[n].random !== false);
  // Draw kinds that must composite source-over: additive 'lighter' washes an opaque leaf or an
  // overlapping bank of cloud puffs out to bright paper. Keyed on the draw kind, not the mode
  // name, so a future solid mode cannot forget to opt in.
  const SOLID_DRAWS = new Set(['leaf', 'petal', 'cloud']);
  // hasOwnProperty, never a bare lookup: AMBIENT_MODES['__proto__'] is Object.prototype, which is
  // truthy, so a plain `if (AMBIENT_MODES[name])` accepts '__proto__' as a weather mode and then
  // spawns particles off an object with none of the fields it reads. Every field comes back
  // undefined, so the maths goes NaN and the whole field silently stops being drawn.
  const isMode = (name) => Object.prototype.hasOwnProperty.call(AMBIENT_MODES, name);

  /**
   * A rollable weather mode that is not `previous`. Never the same twice running, as with the
   * palettes — and never a flashing mode: storm and lightning are opted out of the pool entirely,
   * because a roll happens without anyone choosing it and a full-screen flash is the one weather
   * that must only ever be chosen.
   */
  function randomAmbientName(previous) {
    const choices = ROLLABLE_AMBIENTS.filter((n) => n !== previous);
    return choices[Math.floor(Math.random() * choices.length)] || ROLLABLE_AMBIENTS[0];
  }

  /**
   * A jagged bolt as a polyline: recursive midpoint displacement, the standard trick. Pure and
   * module-level so the smoke suite can assert its shape in Node — endpoints preserved, every
   * point finite, deviation bounded by `jag` — rather than judging a flash by eye.
   */
  function boltPath(x0, y0, x1, y1, jag, depth) {
    if (depth <= 0) return [[x0, y0], [x1, y1]];
    const mx = (x0 + x1) / 2 + rand(-jag, jag);
    const my = (y0 + y1) / 2 + rand(-jag, jag) * 0.35;
    const a = boltPath(x0, y0, mx, my, jag / 1.9, depth - 1);
    const b = boltPath(mx, my, x1, y1, jag / 1.9, depth - 1);
    return a.concat(b.slice(1));
  }

  // Lightning safety: HARD constants, deliberately not config-reachable — no write path can raise
  // them, the same policy the emoter applies to Twitch's platform ceilings. This renders into
  // other people's streams, so the flash stays dim and strikes can never land back to back.
  const MAX_BOLTS = 6;             // absolute cap on bolts alive at once, like MAX_SHELLS
  const BOLT_MIN_GAP_MS = 800;     // floor between strikes, whatever the strikes/min slider says
  const FLASH_ALPHA_MAX = 0.12;    // ceiling for the whole-frame flash a strike paints

  /**
   * The concrete mode to draw, or null when 'random' is set and nobody has rolled it yet.
   *
   * Unlike a random PALETTE or a random beat effect, weather is persistent: if every page rolled
   * its own, the studio preview would show rain while the OBS source showed fireflies, constantly,
   * and a preview that lies is worse than no preview. So the SERVER rolls once and hands the answer
   * to every client as `ambientRoll`; this only resolves it. A client with no roll — an overlay
   * pinned with `?ambient=random`, or a page open against an older service — rolls its own rather
   * than drawing nothing, because blank is the one outcome that reads as broken.
   */
  function resolveAmbient(name, roll) {
    if (name !== 'random') return isMode(name) ? name : 'off';
    return isMode(roll) ? roll : null;
  }

  /**
   * ─── WORDS ─────────────────────────────────────────────────────────────────────────────────
   *
   * A style is a ROW IN A TABLE, not a branch — the same decision AMBIENT_MODES records above and
   * for the same reason: ten-plus styles written as `if (style === …)` is the pile that `rain:
   * true` grew into. Adding a style is adding a row.
   *
   *   in        how the word arrives — 'pop' (scale up from small on easeOutBack), 'fade', or
   *             'assemble' (particles converge on the glyph fill and mush together; Gather
   *             is tightness, the face is never drawn).
   *   out       how it leaves — 'fade', or 'burst' (the particles blow apart under the same
   *             gravity/drag the bursts use, into the embers the rest of the overlay is made of).
   *   inMs/outMs  entrance and exit in ms. The HOLD between them is the caller's duration.
   *   passes    which cached rasters are drawn, back to front: 'shade' (dark, for depth and for
   *             legibility over a busy scene), 'glow' (blurred, composited 'lighter'), 'face'.
   *             EMPTY for a particle style — its raster is sampled, never drawn.
   *   spin      turns per second about the word's own vertical axis. The width is scaled by
   *             |cos(angle)|, which is the trick confetti and leaves already use twice in this
   *             file and the cheapest convincing suggestion of a flat thing turning in 3D.
   *   depth     how many times the shade raster is stacked along the depth vector. 0 is flat.
   *   particles the style spends the WORD budget (wordCap) instead of drawing a raster.
   *   flicker   the style modulates brightness fast enough to need the lightning flash rules.
   *             None of the four here do; the column exists so the style that eventually does
   *             cannot be added without meeting them.
   *   random    false keeps the style out of a 'random' roll, exactly as storm and lightning are
   *             kept out of the weather roll. A roll happens without anyone choosing it, and a
   *             flashing screen must only ever be chosen by name.
   *   cost      rough per-frame cost in glow-particle equivalents, so "which of these is
   *             expensive" is answerable in the studio without reading this file. A particle
   *             style is 0 here because its cost is the word budget, not a count of drawImages.
   */
  const WORD_STYLES = {
    pop:      { in: 'pop',      out: 'fade',  inMs: 260, outMs: 320, passes: ['shade', 'face'], spin: 0,    depth: 0,  particles: false, flicker: false, cost: 2 },
    neon:     { in: 'pop',      out: 'fade',  inMs: 300, outMs: 380, passes: ['shade', 'glow', 'face'], spin: 0, depth: 0,  particles: false, flicker: false, cost: 3 },
    extrude:  { in: 'pop',      out: 'fade',  inMs: 320, outMs: 340, passes: ['shade', 'face'], spin: 0.35, depth: 10, particles: false, flicker: false, cost: 5 },
    assemble: { in: 'assemble', out: 'burst', inMs: 620, outMs: 900, passes: [],                spin: 0,    depth: 0,  particles: true,  flicker: false, cost: 0 },
  };
  // Deliberately a literal and not Object.keys(WORD_STYLES), exactly as AMBIENTS is: the smoke
  // suite reads this line out of the SOURCE and compares it with the server's allowlist, because
  // two files drifting apart means the server accepts a style the overlay silently ignores and
  // nothing logs anything.
  const WORD_STYLE_LIST = ['pop', 'neon', 'extrude', 'assemble', 'random'];
  const WORD_STYLE_NAMES = Object.keys(WORD_STYLES);
  const ROLLABLE_WORD_STYLES = WORD_STYLE_NAMES.filter((n) => WORD_STYLES[n].random !== false);
  // hasOwnProperty, never a bare lookup — WORD_STYLES['__proto__'] is truthy and every column
  // read off it comes back undefined, which is the silent-NaN failure isMode() documents above.
  const isWordStyle = (name) => Object.prototype.hasOwnProperty.call(WORD_STYLES, name);

  const WORD_POSITIONS = ['top', 'upper', 'center', 'lower', 'bottom', 'custom'];
  const WORD_POSITION_Y = { top: 0.12, upper: 0.28, center: 0.5, lower: 0.72, bottom: 0.88 };

  /**
   * Fonts as an ENUM over faces already installed on the machine — never a free-text family name,
   * because an unknown family falls back silently and looks exactly like a bug, which is the
   * failure class this codebase keeps designing out.
   *
   * Phase 1 ships no font FILE on purpose, and the reason is a real trap: computeAssetBuild() in
   * server.js is `readdirSync(PUBLIC_DIR).filter(/\.(js|html)$/)` — NON-RECURSIVE and JS/HTML
   * only — so dropping a .woff2 into public/ or public/fonts/ would not move ASSET_BUILD and the
   * overlay's self-reload would not fire for it. When a webfont does ship, version the FILENAME
   * (anton-1.woff2) and change the reference in THIS file, which is covered by the build stamp.
   */
  const WORD_FONTS = {
    impact: '"Impact", "Haettenschweiler", "Arial Narrow Bold", sans-serif',
    black: '"Arial Black", "Arial Bold", Gadget, sans-serif',
    sans: 'system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  };
  const WORD_FONT_NAMES = ['impact', 'black', 'sans'];

  // One range per per-style param, the same shape EFFECT_NUMBERS has on the server — and mirrored
  // there as WORD_PARAM_NUMBERS, which the smoke suite holds equal. Every param is looked up here
  // by NAME, so a param added to a style row without a range would be caught rather than silently
  // clamped to a permissive default.
  const WORD_PARAM_RANGES = {
    lift: [0, 0.5], overshoot: [0, 2], shade: [0, 1],
    glow: [0, 3], thickness: [0.2, 3],
    depth: [0, 40], spin: [0, 3], tilt: [0, 1],
    gather: [0, 1], spread: [0, 3], burst: [0, 3],
  };

  // Word safety: HARD constants, deliberately not config-reachable — no write path can raise them,
  // the same policy MAX_BOLTS / BOLT_MIN_GAP_MS / FLASH_ALPHA_MAX get and for the same reason.
  // This renders into other people's streams, and words are the first thing here that anything
  // outside the operator's own hands can put on screen.
  const MAX_WORDS = 3;              // absolute ceiling on words alive at once; words.maxOnScreen sits beneath it
  const WORD_MIN_GAP_MS = 400;      // floor between spawns. /api/say's limiter is the outer wall; this is the inner one
  const MAX_WORD_CHARS = 48;        // TRUNCATE, never refuse — a clipped word reads as a rule, a refused one as a fault
  const MAX_COMBINING_PER_BASE = 2; // Zalgo: 200 diacritics on one base covers the screen from a 201-character string
  const MAX_WORD_PARTICLES = 1500;  // ceiling on wordCap, the particle budget the word styles spend
  const WORD_RASTER_CACHE_MAX = 24; // the glow cache gets away with unbounded growth because colour quantises to 4096
  const MAX_WORD_RASTER_PX = 2048;  // a raster wider than this is shrunk to fit, never allocated

  /**
   * Characters stripped outright, and why each range is here rather than merely truncated:
   *
   *   C0/C1 controls and U+007F   never renderable, and U+0000 terminates strings in half the
   *                               things a word might later be logged into.
   *   U+200B ZWSP, U+200C ZWNJ    invisible padding: a length check passes and nothing shows.
   *   U+200E LRM, U+200F RLM      direction marks.
   *   U+202A–U+202E, U+2066–U+2069, U+061C   the bidi EMBEDDING and OVERRIDE controls. U+202E
   *                               RIGHT-TO-LEFT OVERRIDE is the classic overlay-griefing
   *                               character: it reverses everything after it, so a word renders
   *                               backwards and an operator reading the config cannot see why.
   *   U+2060–U+2064, U+FEFF       word joiners and the BOM, same invisibility argument as ZWSP.
   *
   * U+200D ZERO WIDTH JOINER is deliberately NOT stripped: it is what holds an emoji family or a
   * profession sequence together, and removing it turns one glyph into three unrelated ones.
   */
  const STRIP_RANGES = [
    [0x0000, 0x001f], [0x007f, 0x009f],   // C0 / C1 controls, including U+0000
    [0x061c, 0x061c],                     // ARABIC LETTER MARK
    [0x200b, 0x200c], [0x200e, 0x200f],   // ZWSP, ZWNJ, LRM, RLM  (U+200D ZWJ is NOT here)
    [0x202a, 0x202e],                     // the bidi embeddings and RIGHT-TO-LEFT OVERRIDE
    [0x2060, 0x2064], [0x2066, 0x2069],   // word joiner, invisible operators, the bidi isolates
    [0xfeff, 0xfeff],                     // BOM / zero-width no-break space
  ];
  // A predicate over code points rather than a character class: a regex literal holding raw
  // control characters is unreadable in a diff and unmatchable in a search, and this file gets
  // read a lot more often than it gets written.
  const isStripped = (cp) => STRIP_RANGES.some(([a, b]) => cp >= a && cp <= b);
  const COMBINING_RE = /\p{M}/u;

  /**
   * Split into user-perceived characters, so truncation lands on a grapheme boundary. A clipped
   * surrogate pair is a replacement box and a clipped ZWJ sequence renders as two unrelated
   * glyphs — both look like the renderer is broken rather than like a length rule.
   */
  function graphemesOf(s) {
    if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
      const out = [];
      for (const part of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s)) out.push(part.segment);
      return out;
    }
    // Fallback for an engine without Segmenter: code points, with combining marks glued to the
    // character in front of them. Not a full grapheme algorithm, but it keeps the two cases that
    // matter here — surrogate pairs (for..of iterates code points) and base+mark.
    const out = [];
    for (const ch of s) {
      if (out.length && COMBINING_RE.test(ch)) out[out.length - 1] += ch;
      else out.push(ch);
    }
    return out;
  }

  /**
   * The whole text-safety rule, in one pure function so the smoke suite can assert it in Node
   * rather than by looking at a canvas — and so there is ONE implementation. server.js requires
   * this file for exactly this function: the allowlists are duplicated across the two files on
   * purpose (the smoke test holds them equal), but a SECURITY function with two implementations
   * is a vulnerability waiting on whichever copy someone forgets to edit.
   *
   * Truncates, never refuses. A refused word looks like the service is broken; a clipped one
   * looks like a rule. `/api/say` turns an empty RESULT into a 422, because "nothing left after
   * sanitising" is a caller error rather than a truncation.
   */
  function sanitiseWordText(raw) {
    let s = typeof raw === 'string' ? raw : (raw == null ? '' : String(raw));
    // NFC first: it folds legitimate base+mark pairs into single code points, so the clamp below
    // only ever fires on decoration nobody typed by accident. An é written as e + U+0301 becomes
    // one character and spends none of its base's mark budget.
    try { s = s.normalize('NFC'); } catch { /* an engine without NFC still gets everything else */ }
    const kept = [];
    let marks = 0;
    // ONE pass over code points (for..of is surrogate-aware, so an astral character is one step
    // and can never be halved). Tabs and newlines are C0 and would strip to nothing, joining the
    // words either side into one — they become a space first, then the collapse below tidies runs.
    for (const ch of s.replace(/[\t\r\n\f\v]+/g, ' ')) {
      if (isStripped(ch.codePointAt(0))) continue;
      if (COMBINING_RE.test(ch)) {
        // A mark with nothing in front of it is not decoration, it is a lone mark: it stacks on
        // whatever the renderer decides to hang it from, which is not a decision to leave open.
        if (!kept.length || marks >= MAX_COMBINING_PER_BASE) continue;
        marks++;
        kept.push(ch);
      } else {
        marks = 0;
        kept.push(ch);
      }
    }
    s = kept.join('').replace(/\s+/g, ' ').trim();
    const gs = graphemesOf(s);
    return gs.length > MAX_WORD_CHARS ? gs.slice(0, MAX_WORD_CHARS).join('') : s;
  }

  // Penner, in the two shapes phase 1 needs. Written out rather than pulled from a library: Back
  // and Elastic overshoot, so they cannot be expressed as a cubic-bezier at all, and the whole of
  // GSAP is a lot of dependency to acquire fifteen lines of arithmetic.
  const easeOutBack = (t) => { const c1 = 1.70158, c3 = c1 + 1, u = t - 1; return 1 + c3 * u * u * u + c1 * u * u; };
  const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

  /**
   * Where a word is in its life, given how long it has been on screen. Pure and module-level for
   * the same reason shellPhysics is: a word fading 80ms early looks fine and is still wrong, so
   * the timing is asserted in Node rather than judged by eye.
   *
   * Returns { phase: 'in'|'hold'|'out'|'dead', t: 0..1 within that phase, alpha: 0..1 }.
   */
  function wordPhase(elapsedMs, inMs, holdMs, outMs) {
    if (elapsedMs < inMs) {
      const t = inMs <= 0 ? 1 : elapsedMs / inMs;
      return { phase: 'in', t, alpha: easeOutCubic(clamp(t, 0, 1)) };
    }
    if (elapsedMs < inMs + holdMs) return { phase: 'hold', t: holdMs <= 0 ? 1 : (elapsedMs - inMs) / holdMs, alpha: 1 };
    if (elapsedMs < inMs + holdMs + outMs) {
      const t = outMs <= 0 ? 1 : (elapsedMs - inMs - holdMs) / outMs;
      return { phase: 'out', t, alpha: 1 - easeOutCubic(clamp(t, 0, 1)) };
    }
    return { phase: 'dead', t: 1, alpha: 0 };
  }

  // Panic fade is short on purpose: assemble's own out is 900 ms, which is not a panic.
  const PANIC_OUT_MS = 280;

  /**
   * Falling-edge of words.enabled: fade inflight words out without splicing, and without
   * mutating the WORD_STYLES table row. Pure so Node can assert it with fake word objects.
   */
  function panicFadeInflight(wordList, queued, now) {
    if (!Array.isArray(wordList)) return;
    for (const word of wordList) {
      word.spec = Object.assign({}, word.spec || {}, { out: 'fade' });
      word.outMs = Math.min(Number(word.outMs) || PANIC_OUT_MS, PANIC_OUT_MS);
      const outStart = (Number(word.inMs) || 0) + (Number(word.holdMs) || 0);
      if (now - word.bornAt < outStart) word.bornAt = now - outStart;
    }
    if (queued && queued.length) queued.length = 0;
  }

  /** A rollable style that is not `previous` — same no-repeat rule as the palettes and the weather. */
  function randomWordStyle(previous) {
    const choices = ROLLABLE_WORD_STYLES.filter((n) => n !== previous);
    return choices[Math.floor(Math.random() * choices.length)] || ROLLABLE_WORD_STYLES[0];
  }

  // Same names and same stops as the equalizer's palettes, on purpose: the two overlays sit on
  // the same screen, and "hive" has to mean one thing across both.
  const PALETTES = {
    hive:  [[0, [240, 163, 38]], [0.55, [249, 131, 44]], [1, [251, 106, 65]]],
    fire:  [[0, [254, 222, 74]], [0.5, [250, 140, 45]], [1, [236, 52, 52]]],
    ice:   [[0, [92, 214, 238]], [0.5, [86, 160, 247]], [1, [168, 120, 246]]],
    vapor: [[0, [255, 140, 220]], [0.5, [168, 120, 246]], [1, [92, 214, 238]]],
    mono:  [[0, [235, 235, 235]], [1, [150, 150, 150]]],
  };
  const CUSTOM_SLOTS = ['custom1', 'custom2', 'custom3'];
  const CUSTOM_POSITIONS = [0, 0.5, 1];
  const HEX_RE = /^#[0-9a-fA-F]{6}$/;
  const DEFAULT_CUSTOMS = [
    ['#f0a326', '#f8862b', '#fb6a41'],
    ['#19e6c8', '#4f7dff', '#ff3ea5'],
    ['#33d17a', '#f6d32d', '#e01b24'],
  ];

  const DEFAULTS = {
    opacity: 1,          // whole-overlay alpha, on top of each effect's own
    scale: 1,            // size multiplier for every particle
    particleCap: 1200,   // global budget for BURST particles
    ambientCap: 400,     // separate budget for weather, so bursts cannot starve it
    // The THIRD budget, and a sibling of the two above rather than a field inside `words`: the
    // same argument that gave weather its own ceiling gives particle-formed words theirs. A long
    // word must not be able to spend the firework budget, and listen.html's stage-2 degrade caps
    // these three BY NAME — a budget that is not a named top-level key is one the phone watchdog
    // silently does not protect.
    wordCap: 600,
    ambient: 'off',
    palette: 'random',
    // The weather's own palette; 'auto' follows `palette`. Stored as a concrete value rather
    // than an absent key, because both merges always rebuild the FULL document — "absent" is
    // not a state this config can be in.
    ambientPalette: 'auto',
    customs: DEFAULT_CUSTOMS.map((s) => s.slice()),
    beat: {
      // Mirrors the server's DEFAULT_CONFIG.beat — ON, tempo-synced, louder/faster since
      // 2026-08-23 (intensity 1.2, every 2 beats, 200ms floor).
      enabled: true,
      effect: 'confetti',
      palette: 'auto',     // the beat's own palette; 'auto' follows the main one
      sensitivity: 1.35,   // multiple of the running average that counts as a hit
      minGapMs: 200,       // floor between beat spawns, so a loud passage is not a strobe
      intensity: 1.2,      // bigger beat bursts; alerts still have their own intensity
      syncToBpm: true,     // when on, the gap comes from the song's tempo instead of minGapMs
      everyBeats: 2,       // ...one burst every this many beats. 4 is a bar in common time
      // How the music sizes a burst: 'off' (always the configured size), 'loudness', 'tempo', or
      // 'both'. 'loudness' is the default because it is what the beat path always did.
      dynamics: 'loudness',
    },
    effects: {
      fireworks: {
        shells: 1,        // rockets per fire()
        count: 90,        // particles per burst
        spread: 1,        // burst radius multiplier
        gravity: 260,     // px/s^2
        drag: 0.86,       // per-second velocity retention
        life: 1.5,        // seconds
        glow: 1,
        size: 2.6,
        opacity: 1,
      },
      confetti: {
        count: 180,
        spread: 1,
        gravity: 420,
        drag: 0.94,
        life: 3.2,
        flutter: 1,       // how hard pieces tumble and swing
        size: 7,
        opacity: 1,
        // On: omitted x/y roll in the same band fireworks use (0.15–0.85w, 0.12–0.45h).
        // An explicit axis still wins. Off is centre / 0.35h.
        randomPosition: true,
      },
      embers: {
        count: 70,
        spread: 1,
        gravity: -90,     // negative: embers rise
        drag: 0.9,
        life: 2.4,
        glow: 1,
        size: 2.2,
        opacity: 0.9,
        wander: 1,        // sideways drift as they climb
      },
      hearts: {
        count: 40,
        spread: 1,
        gravity: 280,
        drag: 0.93,
        life: 2.6,
        flutter: 1,
        size: 10,
        opacity: 1,
        randomPosition: true,
      },
      fountain: {
        count: 90,
        spread: 0.55,
        gravity: 520,
        drag: 0.92,
        life: 1.8,
        glow: 0.9,
        size: 2.4,
        opacity: 1,
        wander: 0.4,
      },
      nova: {
        count: 36,
        spread: 1.35,
        gravity: 40,
        drag: 0.82,
        life: 0.7,
        glow: 1.4,
        size: 3.2,
        opacity: 1,
      },
      ambient: {
        density: 140,     // target live particles
        speed: 1,
        wind: 0.25,
        size: 3,
        opacity: 0.55,
        glow: 0.25,
        twinkle: 1,       // scales each mode's own pulse: stars, fireflies, bubbles. 0 is steady
        spin: 1,          // scales the tumble: leaves and petals
        strikes: 8,       // lightning strikes per minute, on average: storm and lightning only
      },
    },
    // Modelled on `effects.<name>` exactly, so PATCH semantics, null-reset, the clamp tables and
    // preset capture all work with no new machinery. `words.styles.<name>: null` resets one style
    // block. `words: null` is deliberately NOT a gesture — nothing in this config nulls a whole
    // top-level block, and inventing it here would be a surprise.
    words: {
      enabled: true,
      style: 'neon',        // one of WORD_STYLES, or 'random'
      font: 'impact',       // an enum over WORD_FONTS, never a family name
      size: 96,             // px at 1080p, before the global `scale`
      position: 'center',   // top | upper | center | lower | bottom | custom
      x: 0.5, y: 0.4,       // used when position === 'custom'; normalised like /api/fire
      durationMs: 2200,     // the HOLD, before the style's own in and out
      palette: 'auto',      // 'auto' follows the main palette — same rule as ambient and beat
      opacity: 1,
      maxOnScreen: 2,       // the config-level control; MAX_WORDS is the hard ceiling above it
      outline: 0,           // letter stroke in px at 96px; 0 skips strokeText
      styles: {
        pop: { lift: 0.06, overshoot: 1, shade: 0.55 },
        neon: { glow: 2, thickness: 1, shade: 0 },
        extrude: { depth: 10, spin: 1, tilt: 0.3 },
        assemble: { gather: 0, spread: 1, burst: 1 },
      },
      // Spawn-meter look. Inert on the canvas — the server owns the door. Kept here so
      // Object.keys(DEFAULTS.words) matches the server and studio adopt() can fill a skew.
      overflow: 'queue',
      sources: {
        studio: { enabled: true, overflow: 'interrupt' },
        deck: { enabled: true, overflow: 'interrupt' },
        api: { enabled: true, overflow: 'queue' },
        alert: { enabled: false, overflow: 'queue' },
        chat: { enabled: false, overflow: 'queue' },
        emoter: { enabled: false, overflow: 'drop' },
        sched: { enabled: false, overflow: 'drop' },
        llm: { enabled: false, overflow: 'drop' },
        song: {
          enabled: true, overflow: 'interrupt',
          style: 'pop', font: 'black', position: 'top', palette: 'auto',
          size: 64, durationMs: 4000, x: 0.5, y: 0.12,
        },
      },
    },
  };

  // Frames stop when the track pauses or the music source unloads. Beats simply stop happening,
  // which is correct and needs no special case — but a stale feed must not keep firing off an
  // average computed from silence, so anything older than this is treated as "no audio".
  const STALE_MS = 1500;
  const MAX_DT = 0.064;   // same 64ms ceiling the equalizer uses: a stalled tab must not jump

  // How long a rocket climbs before it bursts, when nobody asks for a specific time. Tuned for
  // pace rather than realism: a physically-plausible climb takes over a second, which is far too
  // long to wait when the effect is answering an alert already on screen.
  const SHELL_FLIGHT_MS = 650;
  const MAX_SHELLS = 60;

  /**
   * Launch velocity and gravity for a rocket that rises `dist` pixels and reaches its apex — where
   * it bursts — after exactly `flightMs`.
   *
   * The gravity is per-rocket, which is the trick that makes this work: with one shared constant,
   * flight time is a function of height, so every rocket aimed somewhere different bursts at a
   * different moment and none of them can be put on a beat. Solving the other way round — fixing
   * the time and letting each rocket carry the gravity its height implies — keeps the varied
   * heights AND makes the burst schedulable. A taller shell simply climbs faster, which is also
   * what a bigger charge does.
   *
   *   apex time  t = v/g,   rise  d = v^2/(2g)   ⇒   v = 2d/t,  g = 2d/t^2
   */
  function shellPhysics(dist, flightMs) {
    const d = Math.max(40, dist);         // a source shorter than this still gets a visible climb
    const t = Math.max(0.05, flightMs / 1000);
    return { vy: -(2 * d) / t, gravity: (2 * d) / (t * t) };
  }

  // The comfortable range for a climb: shorter than this and it does not read as a rocket at all,
  // longer and the wait outlasts the moment it is answering.
  const FLIGHT_MIN_MS = 450;
  const FLIGHT_MAX_MS = 1400;

  /**
   * A flight time that is a whole number of beats AND still looks like a firework. One beat is
   * usually right; at fast tempos a single beat is too short a climb to read as one, so two or
   * three beats are used instead. The answer is always a whole number of beats, which is what
   * keeps the burst on the grid rather than merely near it.
   */
  const DYNAMICS = ['off', 'loudness', 'tempo', 'both'];

  /**
   * How much a tempo should scale the size of a burst. A slow track gets calmer effects and a fast
   * one busier ones, which is the "or faster" half of the request.
   *
   * Mapped across the detectable range rather than off an absolute number, and bounded at both
   * ends: unbounded scaling would make a drum-and-bass track spend the whole particle budget on
   * one burst and a ballad produce something invisible.
   */
  function tempoIntensity(bpm) {
    if (!bpm) return 1;                       // no tempo known — do not invent a scaling
    const t = clamp((bpm - 60) / 120, 0, 1);  // 60 BPM → 0, 180 BPM → 1
    return 0.6 + t * 1.2;                     // 0.6x .. 1.8x
  }

  /**
   * Combine the music's loudness and tempo into one multiplier for the beat effect's intensity.
   * `bass` is 0-1 for this frame; `bpm` may be null.
   *
   * 'both' takes the LARGER of the two rather than multiplying them: multiplying means a loud
   * moment in a fast track compounds to ~3.6x and every burst slams into the particle cap, which
   * flattens the dynamics it was supposed to create. The maximum keeps the loudest moments loud
   * while leaving the quiet ones somewhere to go.
   */
  function musicIntensity(mode, bass, bpm) {
    const loud = clamp(bass * 2, 0.3, 2);
    const fast = tempoIntensity(bpm);
    if (mode === 'loudness') return loud;
    if (mode === 'tempo') return fast;
    if (mode === 'both') return Math.max(loud, fast);
    return 1;                                  // 'off' — a burst is the size it was configured
  }

  /** Pick an effect for `beat.effect: 'random'`, never the same one twice running. */
  function randomEffectName(previous) {
    const choices = EFFECTS.filter((e) => e !== previous);
    return choices[Math.floor(Math.random() * choices.length)];
  }

  function beatAlignedFlight(period) {
    for (let k = 1; k <= 4; k++) {
      const t = period * k;
      if (t >= FLIGHT_MIN_MS && t <= FLIGHT_MAX_MS) return t;
    }
    // Very slow or very fast tempos have no whole number of beats inside that window. Take the
    // count closest to the default flight — still a whole number of beats, still on the grid.
    return period * Math.max(1, Math.round(SHELL_FLIGHT_MS / period));
  }

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const rand = (a, b) => a + Math.random() * (b - a);
  // Number.isFinite, never `||`: a setting that arrives as a string or a NaN has to fall back to
  // its default, and `0 || d` would quietly discard a deliberate zero — "no twinkle" is a choice.
  const numOr = (v, d) => (Number.isFinite(v) ? v : d);

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

  function hexToRgb(hex) {
    if (!HEX_RE.test(hex)) return null;
    return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
  }

  /**
   * Every palette that can actually be drawn right now: the five presets, plus any custom slot
   * holding three usable colours. A half-filled custom slot is left out rather than silently
   * falling back to hive, which under 'random' would quietly weight the roll towards one preset.
   */
  function usablePaletteNames(customs, library) {
    const names = Object.keys(PALETTES);
    CUSTOM_SLOTS.forEach((slot, i) => {
      const raw = (Array.isArray(customs) && customs[i]) || [];
      if (raw.filter((c) => HEX_RE.test(c)).length >= 2) names.push(slot);
    });
    // The named library: every palette in it is usable by construction (the store validates
    // three colours), so 'random' rolls them too — "all palettes" stays true.
    for (const name of libraryNames(library)) names.push(LIB_PREFIX + name);
    return names;
  }

  // ─── The named palette library ───
  // Arrives on the config as \`library\` ({name: [hex, hex, hex]}), attached by the service at
  // serialise time — it is not a setting and a preset cannot carry it. A palette field pointing
  // at 'lib:<name>' resolves here; a name that is not (or no longer) in the library falls back
  // to hive and says so once, like any unknown palette.
  const LIB_PREFIX = 'lib:';
  const isLibraryName = (name) => typeof name === 'string' && name.startsWith(LIB_PREFIX) && name.length > LIB_PREFIX.length;
  const libraryNames = (library) => (library && typeof library === 'object' ? Object.keys(library) : []);
  function libraryStops(name, library) {
    const key = name.slice(LIB_PREFIX.length);
    if (!library || typeof library !== 'object' || !Object.prototype.hasOwnProperty.call(library, key)) return null;
    const parsed = (Array.isArray(library[key]) ? library[key] : []).slice(0, CUSTOM_POSITIONS.length).map(hexToRgb).filter(Boolean);
    if (parsed.length < 2) return null;
    return parsed.map((c, i) => [CUSTOM_POSITIONS[i] ?? 1, c]);
  }

  /**
   * Pick a palette for 'random', never the same one twice running — the same rule the equalizer's
   * random style follows. Without it a genuine 1-in-8 repeat reads as "the random option is
   * broken", which is a complaint about randomness that no amount of randomness answers.
   */
  function randomPaletteName(previous, customs, library) {
    const pool = usablePaletteNames(customs, library);
    const choices = pool.length > 1 ? pool.filter((n) => n !== previous) : pool;
    return choices[Math.floor(Math.random() * choices.length)];
  }

  // Palette names that have already been complained about, so an unknown one is reported ONCE
  // rather than sixty times a second. A per-frame console.warn is not a diagnostic, it is a
  // second fault: it floods the console the operator needs to read and costs real frame time.
  const warnedPalettes = new Set();
  function warnPalette(name) {
    if (warnedPalettes.has(name)) return;
    warnedPalettes.add(name);
    const known = Object.keys(PALETTES).concat(CUSTOM_SLOTS, ['custom', 'random']).join(', ');
    try {
      console.warn(`FxRender: unknown palette ${JSON.stringify(name)} — falling back to "hive". `
        + `Known palettes: ${known}. A preset or a ?pal= pin is probably carrying a name this `
        + `build does not have.`);
    } catch { /* a console that cannot warn must not take the overlay with it */ }
  }

  // A custom palette needs two usable colours to be a gradient at all; below that fall back to a
  // preset rather than paint a flat smear nobody asked for. Same rule as the equalizer's.
  function stopsFor(name, customs, library) {
    const slot = name === 'custom' ? 0 : CUSTOM_SLOTS.indexOf(name);
    if (slot < 0) {
      // Own-property check, same as isMode(): a bare PALETTES[name] resolves inherited names
      // like 'constructor' to a truthy function, which then gets indexed as a stop table and
      // throws every frame. Fall back, never throw, and say so once.
      if (Object.prototype.hasOwnProperty.call(PALETTES, name)) return PALETTES[name];
      if (isLibraryName(name)) { const lib = libraryStops(name, library); if (lib) return lib; }
      warnPalette(name);
      return PALETTES.hive;
    }
    const raw = (Array.isArray(customs) && customs[slot]) || [];
    const parsed = raw.slice(0, CUSTOM_POSITIONS.length).map(hexToRgb).filter(Boolean);
    if (parsed.length < 2) return PALETTES.hive;
    return parsed.map((c, i) => [CUSTOM_POSITIONS[i] ?? 1, c]);
  }

  /**
   * Pre-rendered glow sprites, cached by quantised colour. Building one is a gradient fill into a
   * tiny offscreen canvas; drawing one is a single composited drawImage. The cache is keyed on
   * colour rounded to 16 levels per channel, so a gradient's worth of particles shares a handful
   * of sprites instead of allocating one each.
   */
  function fillHeart(ctx, size) {
    const s = Math.max(2, size);
    ctx.beginPath();
    ctx.moveTo(0, s * 0.32);
    ctx.bezierCurveTo(s * 0.85, -s * 0.55, s * 1.15, s * 0.28, 0, s);
    ctx.bezierCurveTo(-s * 1.15, s * 0.28, -s * 0.85, -s * 0.55, 0, s * 0.32);
    ctx.closePath();
    ctx.fill();
  }

  function fillPetal(ctx, size) {
    const s = Math.max(1.5, size);
    ctx.beginPath();
    ctx.moveTo(0, -s);
    ctx.quadraticCurveTo(s * 0.85, -s * 0.1, 0, s * 0.55);
    ctx.quadraticCurveTo(-s * 0.85, -s * 0.1, 0, -s);
    ctx.closePath();
    ctx.fill();
  }

  function createSpriteCache() {
    const cache = new Map();
    const SIZE = 64;
    return function spriteFor(rgb) {
      const key = ((rgb[0] >> 4) << 8) | ((rgb[1] >> 4) << 4) | (rgb[2] >> 4);
      let s = cache.get(key);
      if (s) return s;
      const c = document.createElement('canvas');
      c.width = c.height = SIZE;
      const g = c.getContext('2d');
      const grad = g.createRadialGradient(SIZE / 2, SIZE / 2, 0, SIZE / 2, SIZE / 2, SIZE / 2);
      grad.addColorStop(0, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},1)`);
      grad.addColorStop(0.35, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.55)`);
      grad.addColorStop(1, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0)`);
      g.fillStyle = grad;
      g.fillRect(0, 0, SIZE, SIZE);
      cache.set(key, c);
      return c;
    };
  }

  /**
   * Cloud puff sprites: same pattern as the glow cache — quantised-colour key, offscreen canvas,
   * one drawImage per particle, no shadowBlur — but a different SHAPE, so it is a second cache
   * rather than a graft onto spriteFor: five overlapping soft blobs into a wide canvas. Mutating
   * the glow builder instead would change what snow, stars, fireflies and sparks look like.
   */
  function createCloudSpriteCache() {
    const cache = new Map();
    const W = 128, H = 64;
    // Puff centres and radii as fractions: a flat-bottomed heap, denser in the middle.
    const PUFFS = [
      [0.30, 0.62, 0.26], [0.48, 0.46, 0.30], [0.68, 0.58, 0.26],
      [0.42, 0.68, 0.22], [0.60, 0.70, 0.22],
    ];
    return function cloudFor(rgb) {
      const key = ((rgb[0] >> 4) << 8) | ((rgb[1] >> 4) << 4) | (rgb[2] >> 4);
      let s = cache.get(key);
      if (s) return s;
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const g = c.getContext('2d');
      for (const [px, py, pr] of PUFFS) {
        const grad = g.createRadialGradient(W * px, H * py, 0, W * px, H * py, H * pr * 2);
        grad.addColorStop(0, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.5)`);
        grad.addColorStop(0.6, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.22)`);
        grad.addColorStop(1, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0)`);
        g.fillStyle = grad;
        g.fillRect(0, 0, W, H);
      }
      cache.set(key, c);
      return c;
    };
  }

  /**
   * ─── Word rasters ──────────────────────────────────────────────────────────────────────────
   *
   * spriteFor's discipline, applied to text. MDN's canvas advice says "avoid text rendering
   * whenever possible" — that is about laying glyphs out EVERY FRAME, which is exactly what this
   * avoids: a word is measured and drawn into an offscreen canvas ONCE, and every frame after
   * that is a handful of drawImage calls. Movement, scale, rotation and alpha are transforms on
   * an existing raster and cost nothing extra.
   *
   * Three passes come out of one build, because they share the measurement:
   *   face   the lit glyphs, in the palette colour.
   *   shade  the same glyphs, darkened. Stacked along a depth vector it is the extrusion; drawn
   *          once behind the face it is the drop shadow that keeps a word readable over sparks.
   *   glow   the face, blurred, composited 'lighter'. ctx.filter does the blur ONCE here, which
   *          is the whole difference from the per-particle shadowBlur this file bans.
   *
   * If a style does not name a pass, it is not built — a cache entry is keyed on the style, so
   * `pop` never allocates the blurred canvas `neon` needs.
   */
  let filterSupport = null;
  function supportsCanvasFilter() {
    if (filterSupport !== null) return filterSupport;
    try {
      const g = document.createElement('canvas').getContext('2d');
      g.filter = 'blur(2px)';
      filterSupport = g.filter === 'blur(2px)';
    } catch { filterSupport = false; }
    return filterSupport;
  }

  const rgbCss = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;
  const rgbaCss = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
  const darken = (c, k) => [Math.round(c[0] * k), Math.round(c[1] * k), Math.round(c[2] * k)];

  function createWordRasterCache() {
    const cache = new Map();
    let measureCtx = null;
    const measurer = () => {
      if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
      return measureCtx;
    };
    const fontCss = (fontKey, sizePx) => `700 ${Math.round(sizePx)}px `
      + (Object.prototype.hasOwnProperty.call(WORD_FONTS, fontKey) ? WORD_FONTS[fontKey] : WORD_FONTS.impact);

    /**
     * The size that actually fits. A 48-character word at 96px is wider than a 1080p frame, and
     * the raster it would need is wider than anything worth allocating — so this is a memory
     * bound AND the right thing to look at. Shrinks, never grows: asking for 40px gets 40px.
     */
    function fitSize(text, fontKey, sizePx, maxW) {
      const g = measurer();
      let s = Math.max(8, Math.round(sizePx));
      for (let i = 0; i < 12; i++) {
        g.font = fontCss(fontKey, s);
        const wide = g.measureText(text).width;
        if (wide <= maxW && wide <= MAX_WORD_RASTER_PX) return s;
        s = Math.max(8, Math.floor(s * Math.min(maxW / Math.max(1, wide), 0.92)));
        if (s <= 8) return 8;
      }
      return s;
    }

    /**
     * TextMetrics' bounding box, with a fallback for every field. The actualBoundingBox* family
     * has been Baseline since 2020 and CEF 127 has it — but a missing field here would come back
     * undefined, go into the arithmetic, and produce a NaN-sized canvas that draws nothing at
     * all, which is the silent-blank failure this file keeps designing against.
     */
    function inkBox(text, fontKey, sizePx) {
      const g = measurer();
      g.font = fontCss(fontKey, sizePx);
      const m = g.measureText(text);
      const num = (v, d) => (Number.isFinite(v) ? v : d);
      return {
        asc: num(m.actualBoundingBoxAscent, sizePx * 0.8),
        desc: num(m.actualBoundingBoxDescent, sizePx * 0.25),
        left: num(m.actualBoundingBoxLeft, 0),
        right: num(m.actualBoundingBoxRight, num(m.width, sizePx * text.length * 0.6)),
      };
    }

    function blankCanvas(w, h) {
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.min(MAX_WORD_RASTER_PX, Math.ceil(w)));
      c.height = Math.max(1, Math.min(MAX_WORD_RASTER_PX, Math.ceil(h)));
      return c;
    }

    function build(text, fontKey, sizePx, rgb, spec, params, maxW, outlinePx) {
      const size = fitSize(text, fontKey, sizePx, maxW);
      const box = inkBox(text, fontKey, size);
      // Padding has to clear whatever the widest pass paints outside the ink: the blur radius for
      // glow, the depth vector for extrude, the letter stroke. Too little and the glow is
      // guillotined at the canvas edge, which reads as a rectangle of light around the word.
      const glowPx = spec.passes.includes('glow') ? Math.round(size * 0.18 * clamp(numOr(params.glow, 2), 0, 3)) : 0;
      const depthPx = spec.depth ? Math.round(spec.depth * clamp(numOr(params.depth, 10), 0, 40) * 0.12) + 8 : 0;
      const stroke = outlinePx > 0 ? outlinePx : 0;
      const pad = Math.max(6, glowPx * 2, depthPx, stroke * 2);
      const w = box.left + box.right + pad * 2;
      const h = box.asc + box.desc + pad * 2;
      const drawX = pad + box.left;
      const drawY = pad + box.asc;
      // Rec.709: a raw average treats hive orange as mid-grey and would pick a white rim.
      const lum = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
      const outlineCss = lum > 0.4 ? 'rgba(0,0,0,0.92)' : 'rgba(255,255,255,0.92)';

      const paint = (colour, withStroke) => {
        const c = blankCanvas(w, h);
        const g = c.getContext('2d');
        g.font = fontCss(fontKey, size);
        g.textAlign = 'left';
        g.textBaseline = 'alphabetic';
        // 0-width strokeText still paints a fringe — skip the call, do not pass 0.
        if (withStroke && stroke > 0) {
          g.lineJoin = 'round';
          g.miterLimit = 2;
          g.strokeStyle = outlineCss;
          g.lineWidth = stroke;
          g.strokeText(text, drawX, drawY);
        }
        g.fillStyle = rgbCss(colour);
        g.fillText(text, drawX, drawY);
        return c;
      };

      const fill = paint(rgb, false);
      const entry = { w: fill.width, h: fill.height, size, face: null, shade: null, glow: null };
      entry.face = stroke > 0 ? paint(rgb, true) : fill;
      const shadeAmt = clamp(numOr(params.shade, 0), 0, 1);
      if (spec.depth || (spec.passes.includes('shade') && shadeAmt > 0)) {
        entry.shade = paint(darken(rgb, 0.22), false);
      }
      if (spec.passes.includes('glow')) {
        const c = blankCanvas(w, h);
        const g = c.getContext('2d');
        const radius = Math.max(2, glowPx);
        if (supportsCanvasFilter()) {
          g.filter = `blur(${radius}px)`;
          // Fill-only. Blurring the stroked face would smear the dark rim into the halo.
          g.drawImage(fill, 0, 0);
          g.drawImage(fill, 0, 0);
          g.filter = 'none';
        } else {
          // No ctx.filter: a stroke ladder, widest and faintest first. Not as soft, and it is a
          // glow rather than nothing, which is the point — a style that silently draws flat text
          // on one engine and lights up on another is worse than either.
          g.font = fontCss(fontKey, size);
          g.textAlign = 'left';
          g.textBaseline = 'alphabetic';
          g.lineJoin = 'round';
          for (let i = 4; i >= 1; i--) {
            g.strokeStyle = rgbaCss(rgb, 0.16 * (5 - i) / 4);
            g.lineWidth = radius * (i / 2);
            g.strokeText(text, drawX, drawY);
          }
        }
        entry.glow = c;
      }
      return entry;
    }

    return function rasterFor(key, text, fontKey, sizePx, rgb, spec, params, maxW, outlinePx) {
      const hit = cache.get(key);
      // Re-inserting on a hit makes the Map's own insertion order an LRU list, so the eviction
      // below drops the least recently USED entry rather than the oldest one.
      if (hit) { cache.delete(key); cache.set(key, hit); return hit; }
      const entry = build(text, fontKey, sizePx, rgb, spec, params, maxW, outlinePx);
      cache.set(key, entry);
      // BOUNDED, unlike the glow sprite cache. That one gets away with unbounded growth because
      // colour quantises to at most 4096 keys; a word raster keys on arbitrary text and would
      // grow for as long as the stream runs.
      while (cache.size > WORD_RASTER_CACHE_MAX) cache.delete(cache.keys().next().value);
      return entry;
    };
  }

  /**
   * The glyph raster's own lit FILL, as points a particle can aim at.
   *
   * Assemble is only these points — the face is never drawn. Sampling happens ONCE per word.
   * Cell size is a square grid from lit-count / cap, so thinning cannot stretch one axis
   * (scanline every-Nth leaves vertical stripes on a 96px overlay).
   *
   * `willReadFrequently: true` and a SEPARATE canvas: Chromium otherwise silently moves the
   * visible canvas to CPU after getImageData, and that cost lands on the overlay.
   */
  function sampleWordPoints(raster, maxPoints) {
    const w = Math.max(1, Math.round(raster.w));
    const h = Math.max(1, Math.round(raster.h));
    let data;
    try {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(raster.face, 0, 0, w, h);
      data = g.getImageData(0, 0, w, h).data;
    } catch { return { points: [], cell: 2 }; }
    let lit = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 128) lit++;
    if (lit <= 0) return { points: [], cell: 2 };
    const cap = Math.max(1, maxPoints);
    let cell = Math.max(1, Math.ceil(Math.sqrt(lit / cap)));
    let points = [];
    for (;;) {
      points = [];
      const o = Math.floor(cell / 2);
      for (let y = o; y < h; y += cell) {
        for (let x = o; x < w; x += cell) {
          if (data[(y * w + x) * 4 + 3] > 128) points.push([x, y]);
        }
      }
      if (points.length <= cap || cell >= Math.max(w, h)) break;
      cell++;
    }
    return { points, cell };
  }

  // Deep-ish merge for config: per-effect blocks merge key by key, everything else replaces.
  // `effects: { <name>: null }` resets that block to defaults — deletion has to be spelled out,
  // never inferred from an absent key.
  function mergeConfig(base, incoming) {
    const out = Object.assign({}, base, incoming || {});
    out.effects = Object.assign({}, base.effects);
    const inEffects = (incoming && incoming.effects) || {};
    for (const name of Object.keys(inEffects)) {
      if (!Object.prototype.hasOwnProperty.call(DEFAULTS.effects, name)) continue;
      out.effects[name] = inEffects[name] === null
        ? Object.assign({}, DEFAULTS.effects[name])
        : Object.assign({}, base.effects[name] || DEFAULTS.effects[name], inEffects[name]);
    }
    out.beat = Object.assign({}, base.beat, (incoming && incoming.beat) || {});
    // Words merge the same way, one level deeper: the block itself key by key, then each style's
    // params key by key, with `styles: { <name>: null }` resetting one style to its defaults.
    const inWords = (incoming && incoming.words) || {};
    out.words = Object.assign({}, base.words, inWords);
    out.words.styles = Object.assign({}, (base.words && base.words.styles) || DEFAULTS.words.styles);
    const inStyles = inWords.styles || {};
    for (const name of Object.keys(inStyles)) {
      if (!Object.prototype.hasOwnProperty.call(DEFAULTS.words.styles, name)) continue;
      out.words.styles[name] = inStyles[name] === null
        ? Object.assign({}, DEFAULTS.words.styles[name])
        : Object.assign({}, out.words.styles[name] || DEFAULTS.words.styles[name], inStyles[name]);
    }
    return out;
  }

  function create(canvas) {
    const ctx = canvas.getContext('2d');
    const spriteFor = createSpriteCache();
    const cloudFor = createCloudSpriteCache();

    let config = mergeConfig(DEFAULTS, null);
    let parts = [];      // burst particles
    let amb = [];        // ambient weather, budgeted separately
    let shells = [];     // rockets in flight, before they burst
    let bolts = [];      // lightning in progress — an event subsystem like shells, NOT weather
    let lastStrikeAt = 0;
    let lastBoltMode = null; // the effective mode bolts last belonged to, so a switch clears them
    let running = false;
    let raf = null;
    let last = 0;
    let w = 0, h = 0, dpr = 1;
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
      if (!fpsHudOn || w < 8 || h < 8) return;
      const label = measuredFps > 0 ? 'FX ' + Math.round(measuredFps) + ' fps' : 'FX \u2014 fps';
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
      ctx.strokeText(label, 8, h - 8);
      ctx.fillText(label, 8, h - 8);
      ctx.restore();
    }

    // Beat state. The tempo detector is optional at RUNTIME but not in practice: both pages load
    // fx-bpm.js, and tests/hive-fx-smoke.js asserts they do. Tolerating its absence means a
    // missing script tag costs the BPM readout and the sync option rather than the whole overlay.
    const detector = global.FxBpm ? global.FxBpm.create() : null;
    let bandAvg = 0;
    let lastBandsAt = 0;
    let lastBeatAt = 0;
    let playerUp = true;
    let lastPalette = null;      // what 'random' rolled last, so it cannot roll the same twice
    let lastBeatEffect = null;   // the same, for a random beat effect
    // The split palettes roll against their OWN trackers — same reason lastBeatEffect got one:
    // two independently-'random' fields sharing a tracker suppress each other's rolls, so an
    // ambient particle landing on ice would stop the next beat burst rolling ice, for no reason
    // a viewer could see.
    let lastAmbientPalette = null;
    let lastBeatPalette = null;
    let lastAmbientSignature = null;
    let localAmbientRoll = null; // only used when 'random' is set and the server has not rolled

    // ── Words ──
    const wordRasterFor = createWordRasterCache();
    let words = [];          // words on screen, oldest first
    let wordsEnabled = true; // falling edge of enabled fades inflight words instead of splicing
    let wparts = [];         // WORD particles — a separate array on a separate budget, so a long
                             // word cannot starve the fireworks and vice versa
    let lastWordAt = 0;      // enforces WORD_MIN_GAP_MS, the floor no config can raise
    let lastWordStyle = null;// what 'random' rolled last, so it never rolls the same twice
    let lastWordPalette = null;
    // The font-ready gate. A word drawn before the face it asked for has been parsed paints in
    // the fallback and NEVER repaints — a failure that looks fine on the machine you tuned it on
    // and wrong everywhere else. Phase 1's fonts are all locally installed so this resolves
    // immediately, but the gate is the thing that keeps that true when a webfont ships.
    let fontsReady = typeof document === 'undefined' || !document.fonts;
    let queuedWords = [];
    if (!fontsReady) {
      const release = () => {
        if (fontsReady) return;
        fontsReady = true;
        const q = queuedWords; queuedWords = [];
        for (const item of q) say(item.text, item.opts);
      };
      try { document.fonts.ready.then(release); } catch { release(); }
      // ...and a backstop. A fonts.ready that never settles would mean words simply never appear,
      // with nothing anywhere saying why. Late in the wrong face beats silent forever.
      global.setTimeout(release, 1500);
    }

    function resize() {
      dpr = Math.min(global.devicePixelRatio || 1, 2);   // 2 is plenty; 3 costs 2.25x fill for nothing
      const rect = canvas.getBoundingClientRect();
      w = Math.max(1, Math.round(rect.width || canvas.clientWidth || 300));
      h = Math.max(1, Math.round(rect.height || canvas.clientHeight || 150));
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    /**
     * Enforce the global budget before adding `n` particles. Over budget, the particles closest
     * to death go first: dropping a nearly-faded spark is invisible, whereas refusing the new
     * burst is exactly the moment the viewer was looking.
     */
    function makeRoom(n, cap) {
      const over = parts.length + n - cap;
      if (over <= 0) return;
      parts.sort((a, b) => (a.life / a.maxLife) - (b.life / b.maxLife));
      parts.splice(0, Math.min(over, parts.length));
    }

    /**
     * Stops for one spawn. Under 'random' this ROLLS on every call, so where it is called from
     * decides how the randomness reads: bursts call it once per firework (one palette per burst),
     * ambient weather calls it per particle (a mixed, multicoloured fall).
     */
    function paletteStops(override) {
      const name = override || config.palette;
      if (name !== 'random') return stopsFor(name, config.customs, config.library);
      lastPalette = randomPaletteName(lastPalette, config.customs, config.library);
      return stopsFor(lastPalette, config.customs, config.library);
    }

    // 'auto' means "follow the main palette" — resolved at read time, so changing the main
    // palette recolours everything still set to auto without touching either split field.
    function ambientPaletteName() {
      return config.ambientPalette === 'auto' ? config.palette : config.ambientPalette;
    }

    /** Stops for the WEATHER: its own palette field, its own no-repeat tracker. */
    function ambientStops() {
      const name = ambientPaletteName();
      if (name !== 'random') return stopsFor(name, config.customs, config.library);
      lastAmbientPalette = randomPaletteName(lastAmbientPalette, config.customs, config.library);
      return stopsFor(lastAmbientPalette, config.customs, config.library);
    }

    function spawnBurst(kind, cfg, x, y, intensity, stops, jitterX) {
      const cap = config.particleCap;
      // Clamped to the cap, not just floored at 1: makeRoom() only trims EXISTING particles to
      // make room for `n` more, so if a single burst's own count already exceeds the cap (a
      // high count/intensity combination with few or no particles yet in flight — the common
      // case is the very first burst of a scene), makeRoom removes at most `parts.length`
      // (possibly zero) and the burst lands in full, blowing straight through the "one global
      // budget" this file is built around.
      const n = Math.min(Math.max(1, Math.round(cfg.count * intensity)), cap);
      makeRoom(n, cap);
      const paper = kind === 'confetti' || kind === 'hearts';
      const spread = cfg.spread * (paper ? 260 : kind === 'fountain' ? 240 : kind === 'nova' ? 220 : 180) * intensity;
      for (let i = 0; i < n; i++) {
        // Embers from a single point are a bonfire, not a hearth: without this they pile into one
        // bright blob instead of rising across the width of the source.
        const ox = jitterX ? rand(-jitterX, jitterX) : 0;
        let a, speed;
        if (kind === 'fountain') {
          a = -Math.PI / 2 + rand(-0.42, 0.42) * Math.max(0.4, cfg.spread);
          speed = spread * (0.55 + Math.random() * 0.7);
        } else if (kind === 'nova') {
          // A hollow ring of sparks, not a filled ball — that is what makes nova read as a hit
          // rather than as a smaller firework.
          a = Math.random() * Math.PI * 2;
          speed = spread * (0.72 + Math.random() * 0.28);
        } else {
          a = Math.random() * Math.PI * 2;
          // sqrt keeps the burst filled rather than ring-shaped: uniform radius in polar
          // coordinates piles every particle at the rim.
          speed = spread * Math.sqrt(Math.random());
        }
        const t = Math.random();
        parts.push({
          kind,
          x: x + ox, y,
          vx: Math.cos(a) * speed * (kind === 'embers' ? 0.45 : 1),
          vy: kind === 'fountain' ? Math.sin(a) * speed
            : Math.sin(a) * speed * (paper ? 0.7 : 1) - (kind === 'embers' ? rand(30, 120) : 0),
          life: cfg.life * rand(0.7, 1.15),
          maxLife: cfg.life,
          size: cfg.size * config.scale * rand(0.7, 1.3),
          rgb: sample(stops, t),
          rot: Math.random() * Math.PI,
          vrot: rand(-6, 6) * numOr(cfg.flutter, 1),
          phase: Math.random() * Math.PI * 2,
          gravity: cfg.gravity,
          drag: cfg.drag,
          glow: cfg.glow,
          alpha: cfg.opacity,
        });
      }
    }

    function fire(effect, opts) {
      const o = opts || {};
      if (!EFFECTS.includes(effect)) return false;
      const cfg = config.effects[effect] || DEFAULTS.effects[effect];
      const intensity = clamp(Number.isFinite(o.intensity) ? o.intensity : 1, 0.1, 3);
      const stops = paletteStops(o.palette);
      const x = Number.isFinite(o.x) ? o.x * w : null;
      const y = Number.isFinite(o.y) ? o.y * h : null;

      if (effect === 'fireworks') {
        // Rockets are the one collection with no budget of its own — each resolves in well under a
        // second, so it self-limits in practice, but "in practice" is not a bound. Cheap and inert.
        const room = Math.max(0, MAX_SHELLS - shells.length);
        const count = Math.min(room, Math.max(1, Math.round((cfg.shells || 1) * intensity)));
        // A firework is watched for its BURST, not its launch, and the climb takes most of a
        // second — so the flight time is fixed here rather than falling out of whatever height the
        // rocket happened to be aimed at. On the beat path the caller passes one beat (or two, at
        // fast tempos), which is what puts the explosion itself on a beat instead of the launch.
        const flightMs = Number.isFinite(o.flightMs) ? clamp(o.flightMs, 120, 4000) : SHELL_FLIGHT_MS;
        // Extra shells in one salvo are spaced musically when a beat is known, and loosely
        // otherwise. Random stagger on a beat-timed salvo would scatter exactly what was aligned.
        const stagger = Number.isFinite(o.staggerMs) ? o.staggerMs / 1000 : null;
        for (let i = 0; i < count; i++) {
          const startY = h + 8;
          const targetY = y !== null ? y : rand(h * 0.12, h * 0.45);
          const { vy, gravity } = shellPhysics(startY - targetY, flightMs);
          // Re-rolled per shell, so a salvo under 'random' is several different colours rather
          // than one colour repeated. For a fixed palette this returns the same stops each time.
          const shellStops = paletteStops(o.palette);
          shells.push({
            x: x !== null ? x : rand(w * 0.15, w * 0.85),
            y: startY,
            targetY,
            vx: rand(-40, 40),
            vy,
            gravity,
            rgb: sample(shellStops, Math.random()),
            intensity,
            delay: i === 0 ? 0 : (stagger !== null ? stagger * i : rand(0.05, 0.5)),
            stops: shellStops,
          });
        }
        return true;
      }

      // Per axis, same as fireworks: a provided x or y is "here" on that axis only.
      // randomPosition is paper-style (confetti, hearts); embers and fountain keep width jitter.
      const scatter = (effect === 'confetti' || effect === 'hearts') && cfg.randomPosition === true;
      const sx = x !== null ? x
        : (scatter ? rand(w * 0.15, w * 0.85) : w / 2);
      const sy = y !== null ? y
        : (effect === 'embers' || effect === 'fountain' ? h * 0.95
          : scatter ? rand(h * 0.12, h * 0.45)
          : effect === 'nova' ? h * 0.42
          : h * 0.35);
      // Only when the caller did not choose a spot: an explicit x means "here", and spreading it
      // out would ignore what was asked for.
      const jitterX = x !== null ? 0
        : (effect === 'embers' ? w * 0.35
          : effect === 'fountain' ? w * 0.06
          : 0);
      spawnBurst(effect, cfg, sx, sy, intensity, stops, jitterX);
      return true;
    }

    // ─── Words ───────────────────────────────────────────────────────────────────────────────

    /** Stops for a WORD: its own palette field and its own no-repeat tracker, as ambient and beat have. */
    function wordStops(override) {
      const wc = config.words || DEFAULTS.words;
      // 'auto' on an OVERRIDE is the same as 'auto' on the words block: follow the main
      // palette. A song title look stores auto and /api/song sends it on the say frame;
      // treating a truthy "auto" as a named palette warned and painted hive.
      const chosen = override || wc.palette;
      const name = (!chosen || chosen === 'auto') ? config.palette : chosen;
      if (name !== 'random') return stopsFor(name, config.customs, config.library);
      lastWordPalette = randomPaletteName(lastWordPalette, config.customs, config.library);
      return stopsFor(lastWordPalette, config.customs, config.library);
    }

    /** Where the word sits: a named band, or a normalised point when position is 'custom'. */
    function wordAnchor(wc, o) {
      const pos = WORD_POSITIONS.includes(o.position) ? o.position
        : (WORD_POSITIONS.includes(wc.position) ? wc.position : 'center');
      if (pos === 'custom') {
        const nx = Number.isFinite(o.x) ? o.x : wc.x;
        const ny = Number.isFinite(o.y) ? o.y : wc.y;
        return { x: clamp(numOr(nx, 0.5), 0, 1) * w, y: clamp(numOr(ny, 0.4), 0, 1) * h };
      }
      return { x: w / 2, y: WORD_POSITION_Y[pos] * h };
    }

    /**
     * Per-style params, assembled from a FIXED key list rather than by copying the caller's
     * object. Object.assign uses [[Set]], so a JSON payload carrying an own `__proto__` property
     * would run the prototype setter on the target instead of adding a key — the same class of
     * bug the preset store's null-prototype object exists for. Reading only the keys the style
     * declares closes it, and gives every param a clamp on the way through.
     */
    function wordParams(styleName, wc, o) {
      const defaults = DEFAULTS.words.styles[styleName];
      const fromCfg = (wc.styles && Object.prototype.hasOwnProperty.call(wc.styles, styleName)) ? wc.styles[styleName] : null;
      const fromOpt = (o.params && typeof o.params === 'object' && !Array.isArray(o.params)) ? o.params : null;
      const out = {};
      for (const key of Object.keys(defaults)) {
        const range = WORD_PARAM_RANGES[key] || [0, 40];
        const chosen = fromOpt && Number.isFinite(fromOpt[key]) ? fromOpt[key]
          : (fromCfg && Number.isFinite(fromCfg[key]) ? fromCfg[key] : defaults[key]);
        out[key] = clamp(numOr(chosen, defaults[key]), range[0], range[1]);
      }
      return out;
    }

    function makeWordRoom(n, cap) {
      // Evict the oldest particle-style word, not a slice of wparts: assemble has no
      // glyph plate, so splicing particles would leave a live word with nothing to draw.
      while (wparts.length + n > cap) {
        let oldest = -1;
        for (let i = 0; i < words.length; i++) {
          if (words[i].spec && words[i].spec.particles) { oldest = i; break; }
        }
        if (oldest < 0) {
          const over = wparts.length + n - cap;
          if (over > 0) wparts.splice(0, Math.min(over, wparts.length));
          return;
        }
        dropWord(oldest);
      }
    }

    /**
     * Take a word off screen, and its particles with it. Leaving them behind would spend the word
     * budget on a word nobody can see any more, which is precisely the starvation a separate
     * budget exists to prevent.
     */
    function dropWord(i) {
      const dead = words[i];
      if (!dead) return;
      words.splice(i, 1);
      if (!dead.spec.particles || !wparts.length) return;
      let write = 0;
      for (let k = 0; k < wparts.length; k++) if (wparts[k].owner !== dead) wparts[write++] = wparts[k];
      wparts.length = write;
    }

    function spawnWordParticles(word) {
      const cap = clamp(Math.round(numOr(config.wordCap, 600)), 0, MAX_WORD_PARTICLES);
      if (cap <= 0) return;
      // Clamped to the CAP, not to the room left, for the same reason spawnBurst is: a word whose
      // own point count exceeds the budget must not land in full just because the array happened
      // to be empty when it arrived.
      const gather = clamp(numOr(word.params.gather, 0), 0, 1);
      const sampled = sampleWordPoints(word.raster, cap);
      const points = sampled.points;
      if (!points.length) return;
      makeWordRoom(points.length, cap);
      const spread = 60 + 200 * clamp(numOr(word.params.spread, 1), 0, 3);
      const ox = word.x - word.raster.w / 2;
      const oy = word.y - word.raster.h / 2;
      const cell = Math.max(1, sampled.cell);
      // Raster size already includes overlay scale — do not multiply by config.scale again.
      // Gather 0: overlapping source-over dots (drawn diameter ~1.6× cell). Gather 1: fireball.
      const sizeBase = cell * (1.15 - 0.4 * gather);
      const jitter = gather * gather * Math.max(8, (word.raster.size || 96) * 0.1);
      const glowMul = 5.5 * gather * gather;
      for (const point of points) {
        const tx = ox + point[0];
        const ty = oy + point[1];
        const a = Math.random() * Math.PI * 2;
        const r = rand(0.35, 1) * spread;
        wparts.push({
          owner: word,
          // Colour sampled ACROSS the word, so it wears the palette as a gradient the way a burst
          // does, rather than as one flat fill.
          rgb: sample(word.stops, point[0] / Math.max(1, word.raster.w)),
          sx: tx + Math.cos(a) * r, sy: ty + Math.sin(a) * r,
          x: tx + Math.cos(a) * r, y: ty + Math.sin(a) * r,
          tx, ty, vx: 0, vy: 0,
          size: sizeBase * rand(0.88, 1.12),
          jitter,
          glowMul,
          phase: Math.random() * Math.PI * 2,
          alpha: 0,
        });
      }
    }

    /** The exit: every particle leaves along its own radius, with an upward bias, as an ember does. */
    function burstWordParticles(word) {
      word.burst = true;
      const power = 130 * clamp(numOr(word.params.burst, 1), 0, 3);
      for (let i = 0; i < wparts.length; i++) {
        const p = wparts[i];
        if (p.owner !== word) continue;
        const dx = p.x - word.x;
        const dy = p.y - word.y;
        const d = Math.max(1, Math.sqrt(dx * dx + dy * dy));
        p.vx = (dx / d) * power * rand(0.4, 1.4) + rand(-24, 24);
        p.vy = (dy / d) * power * rand(0.4, 1.4) - rand(20, 90);
      }
    }

    /**
     * Put a word on screen. Returns false when it was refused, and the reasons are worth keeping
     * apart: words switched off, nothing left after sanitising, or the hard gap floor.
     *
     * EVERYTHING ABOUT THE LOOK IS BAKED HERE. Style, font, size, colour and position are read
     * once, at spawn, and nothing re-reads the config afterwards — the same rule burst particles
     * follow, with the reason already written down for them: recolouring one mid-flight looks
     * like a glitch. A shuffle rotation landing while a word is on screen lets that word finish
     * in the style it started; only the NEXT one wears the new look.
     */
    function say(text, opts) {
      const o = opts || {};
      const wc = config.words || DEFAULTS.words;
      if (wc.enabled === false) return false;
      const clean = sanitiseWordText(text);
      if (!clean) return false;
      // Queued rather than dropped while the fonts settle: an alert arriving in the first moments
      // after a reload is exactly when a word matters. The queue is bounded by MAX_WORDS, so it
      // can never become a backlog that empties as a burst.
      if (!fontsReady) {
        if (queuedWords.length < MAX_WORDS) queuedWords.push({ text: clean, opts: o });
        return true;
      }
      const now = performance.now();
      // The INNER wall. /api/say's limiter is the outer one and is reconfigurable; this is not,
      // and it is what stops a POST loop — or three services firing at once — being a strobe.
      if (now - lastWordAt < WORD_MIN_GAP_MS) return false;

      let styleName = (isWordStyle(o.style) || o.style === 'random') ? o.style : wc.style;
      if (styleName === 'random') { lastWordStyle = randomWordStyle(lastWordStyle); styleName = lastWordStyle; }
      if (!isWordStyle(styleName)) styleName = 'neon';
      const spec = WORD_STYLES[styleName];
      const params = wordParams(styleName, wc, o);

      const fontKey = Object.prototype.hasOwnProperty.call(WORD_FONTS, o.font) ? o.font
        : (Object.prototype.hasOwnProperty.call(WORD_FONTS, wc.font) ? wc.font : 'impact');
      // `size` is px AT 1080p, so it is scaled by the frame this canvas actually is. That is what
      // keeps the studio preview honest: a 96px word fills the same fraction of a 320px preview
      // as it does of an OBS source, and a preview that lies is worse than no preview.
      const sizeAt1080 = clamp(numOr(Number.isFinite(o.size) ? o.size : wc.size, 96), 12, 400);
      const sizePx = Math.max(8, sizeAt1080 * config.scale * (h / 1080));
      const stops = wordStops(o.palette);
      const rgb = sample(stops, 0.35);
      const anchor = wordAnchor(wc, o);
      const holdMs = clamp(numOr(Number.isFinite(o.durationMs) ? o.durationMs : wc.durationMs, 2200), 200, 15000);
      const opacity = clamp(numOr(Number.isFinite(o.opacity) ? o.opacity : wc.opacity, 1), 0, 1);
      const outline = Math.round(clamp(numOr(Number.isFinite(o.outline) ? o.outline : wc.outline, 0), 0, 8));
      const outlinePx = outline > 0 ? Math.max(1, Math.round(outline * (sizePx / 96))) : 0;

      const key = [styleName, clean, fontKey, Math.round(sizePx), rgb.join(','),
        params.glow || 0, params.depth || 0, params.shade || 0, outlinePx].join('|');
      const raster = wordRasterFor(key, clean, fontKey, sizePx, rgb, spec, params, w * 0.92, outlinePx);

      const cap = clamp(Math.round(numOr(wc.maxOnScreen, 2)), 1, MAX_WORDS);
      // The OLDEST goes when there is no room. Unlike a particle, the newest word is the one
      // nobody has read yet — makeRoom()'s "drop whatever is nearest death" is exactly backwards.
      while (words.length >= cap) dropWord(0);

      const word = {
        text: clean, style: styleName, spec, params, raster, rgb, stops,
        x: anchor.x, y: anchor.y,
        bornAt: now, inMs: spec.inMs, holdMs, outMs: spec.outMs,
        opacity, spin: spec.spin * clamp(numOr(params.spin, 1), 0, 3),
        spinAngle: 0, burst: false,
        phase: wordPhase(0, spec.inMs, holdMs, spec.outMs),
      };
      if (spec.particles) spawnWordParticles(word);
      words.push(word);
      lastWordAt = now;
      return true;
    }

    function stepWords(dt) {
      const now = performance.now();
      for (let i = words.length - 1; i >= 0; i--) {
        const word = words[i];
        const ph = wordPhase(now - word.bornAt, word.inMs, word.holdMs, word.outMs);
        word.phase = ph;
        if (ph.phase === 'dead') { dropWord(i); continue; }
        if (word.spin) word.spinAngle = ((now - word.bornAt) / 1000) * word.spin * Math.PI * 2;
        if (word.spec.out === 'burst' && ph.phase === 'out' && !word.burst) burstWordParticles(word);
      }
      if (!wparts.length) return;
      // Rising and slowing: the embers profile, deliberately, because the whole point of a word
      // that blows apart is that what is left behind is the same fire the overlay is already made of.
      const gravity = -70;
      const drag = 0.9;
      let write = 0;
      for (let i = 0; i < wparts.length; i++) {
        const p = wparts[i];
        const ph = p.owner && p.owner.phase;
        // An orphan — its word was dropped between frames. Not copied forward, so it goes.
        if (!ph || ph.phase === 'dead') continue;
        if (ph.phase === 'in') {
          const k = easeOutCubic(clamp(ph.t, 0, 1));
          p.x = p.sx + (p.tx - p.sx) * k;
          p.y = p.sy + (p.ty - p.sy) * k;
          p.alpha = k;
        } else if (ph.phase === 'hold') {
          p.phase += dt * 3;
          const j = Number.isFinite(p.jitter) ? p.jitter : 1.4;
          p.x = p.tx + Math.cos(p.phase) * j;
          p.y = p.ty + Math.sin(p.phase * 1.3) * j;
          p.alpha = 1;
        } else {
          const keep = Math.pow(drag, dt);
          p.vx *= keep;
          p.vy = p.vy * keep + gravity * dt;
          p.x += p.vx * dt;
          p.y += p.vy * dt;
          p.alpha = 1 - clamp(ph.t, 0, 1);
        }
        wparts[write++] = p;
      }
      wparts.length = write;
    }

    /**
     * Re-apply the current settings to weather that is already on screen.
     *
     * Ambient particles bake colour, mode, size and speed at SPAWN, and they are immortal — going
     * off the bottom repositions them rather than replacing them. So once the field is full,
     * nothing in the ambient settings could change what you were looking at: switching palette,
     * switching Snow to Rain, moving Size or Speed all appeared to do nothing at all. Only turning
     * ambient off and on again would show them, because that is the one path that clears the array.
     *
     * This re-parameterises in place instead of clearing, keeping each particle's position and
     * phase, for two reasons: clearing pops a full screen of weather out of existence, and the
     * studio calls setConfig on every slider movement, so a clear-and-refill would leave the field
     * permanently half-empty while a slider was being dragged.
     */
    /**
     * The mode actually being drawn: 'off', a real weather name, or — under 'random' — whatever
     * the server rolled. Falls back to a roll of this client's own so 'random' is never blank.
     */
    function effectiveAmbient() {
      const resolved = resolveAmbient(config.ambient, config.ambientRoll);
      if (resolved) return resolved;
      if (!localAmbientRoll) localAmbientRoll = randomAmbientName(null);
      return localAmbientRoll;
    }

    /**
     * Give one weather particle the parameters of `mode`, keeping where it is and how far through
     * its wander it is. Used by BOTH the spawn path and the re-parameterise path, so a mode cannot
     * behave differently depending on whether you switched to it or started on it.
     */
    function applyAmbientParams(a, mode, cfg, stops) {
      const spec = isMode(mode) ? AMBIENT_MODES[mode] : AMBIENT_MODES.snow;
      a.draw = spec.draw;
      a.rgb = sample(stops, Math.random());
      a.size = cfg.size * config.scale * rand(spec.size[0], spec.size[1]);
      a.vy = rand(spec.fall[0], spec.fall[1]) * cfg.speed;
      a.vx = rand(spec.drift[0], spec.drift[1]) + cfg.wind * 120;
      a.sway = rand(spec.sway[0], spec.sway[1]);
      a.twinkle = spec.twinkle * clamp(numOr(cfg.twinkle, 1), 0, 1);
      a.twRate = rand(1.6, 4.2);
      a.vrot = spec.spin ? rand(-3, 3) * spec.spin * clamp(numOr(cfg.spin, 1), 0, 3) : 0;
    }

    function reparameteriseAmbient() {
      const mode = effectiveAmbient();
      if (mode === 'off' || !amb.length) return;
      const cfg = config.effects.ambient;
      const spec = isMode(mode) ? AMBIENT_MODES[mode] : AMBIENT_MODES.snow;
      const frameStops = ambientPaletteName() === 'random' ? null : ambientStops();
      for (const a of amb) {
        applyAmbientParams(a, mode, cfg, frameStops || ambientStops());
        // A banded mode owns a slice of the frame, and a particle carried over from a full-frame
        // mode sits outside it. Left there, the next frame's band wrap snaps the whole field to
        // one band edge in a single synchronized pop — the exact glitch the gradual refill in
        // topUpAmbient exists to avoid. Reseed only the out-of-band ones, inside the band.
        if (spec.band && (a.y < h * spec.band[0] || a.y > h * spec.band[1])) {
          a.y = rand(h * spec.band[0], h * spec.band[1]);
        }
      }
    }

    // What the weather is MADE of — only the fields applyAmbientParams actually reads. Any change
    // here has to reach particles already on screen, and that includes the ROLL, so a re-roll
    // morphs the field instead of waiting for a restart. Density, opacity and glow are deliberately
    // absent: they are applied at spawn/draw time every frame anyway, and folding the whole block
    // in (the old JSON.stringify) meant dragging the Opacity slider re-rolled every particle's
    // size and speed per input event — a full-field reshuffle where a fade was asked for.
    function ambientSignature() {
      const cfg = config.effects.ambient;
      return [
        // The RESOLVED palette name, so weather set to 'auto' recolours when the main palette
        // changes, and a change to either field reaches particles already on screen.
        effectiveAmbient(), ambientPaletteName(), config.scale,
        JSON.stringify(config.customs),
        cfg.size, cfg.speed, cfg.wind, cfg.twinkle, cfg.spin,
      ].join('|');
    }

    function topUpAmbient(dt) {
      const mode = effectiveAmbient();
      if (mode === 'off' || !isMode(mode)) { amb.length = 0; return; }
      const cfg = config.effects.ambient;
      const spec = AMBIENT_MODES[mode];
      // A mode whose fastest fall is still upward travels up, so it has to be seeded from the
      // BOTTOM: seeding bubbles above the frame means the first thing they do is leave it.
      const rising = spec.fall[1] <= 0;
      // dscale keeps the one Density slider meaningful across modes: 140 snowflakes are gentle,
      // 140 clouds are a whiteout. The cap still binds the SCALED number.
      const target = Math.min(Math.round(cfg.density * (spec.dscale || 1)), config.ambientCap);
      // Rolled once per FRAME for a fixed palette, and once per PARTICLE under 'random' — weather
      // is a continuous field rather than an event, so one colour per burst would just look like
      // the palette changing at random moments. Per particle gives a genuinely mixed fall.
      const rolling = ambientPaletteName() === 'random';
      const frameStops = rolling ? null : ambientStops();
      // Turning the density DOWN has to take particles away. Without this the field only ever
      // grew, so lowering Density did nothing until something else cleared it — the same class of
      // "the control does nothing" as the colour and mode being baked in at spawn.
      if (amb.length > target) amb.length = target;
      // Refill gradually rather than all at once, or switching ambient on pops a full screen of
      // snow into existence mid-scene.
      let budget = Math.min(target - amb.length, Math.ceil(target * dt * 1.5) + 1);
      while (budget-- > 0 && amb.length < target) {
        const a = {
          x: rand(-40, w + 40),
          // Seed the first fill across more than the visible height so it does not arrive as a
          // curtain — beyond the edge it travels AWAY from, so nothing is seeded already leaving.
          // A banded mode (fog on the floor, storm clouds on the ceiling) seeds inside its band.
          y: spec.band ? rand(h * spec.band[0], h * spec.band[1])
            : rising ? rand(0, h * 1.5) : rand(-h * 0.5, h),
          phase: Math.random() * Math.PI * 2,
          rot: Math.random() * Math.PI * 2,
        };
        applyAmbientParams(a, mode, cfg, rolling ? ambientStops() : frameStops);
        amb.push(a);
      }
    }

    function step(dt) {
      // Rockets: climb, then burst at their target height.
      for (let i = shells.length - 1; i >= 0; i--) {
        const s = shells[i];
        if (s.delay > 0) { s.delay -= dt; continue; }
        s.vy += s.gravity * dt;
        s.x += s.vx * dt;
        s.y += s.vy * dt;
        // Apex is the timed moment — it arrives exactly flightMs after launch by construction, so
        // this is the condition that keeps a burst on its beat. The height test is only a backstop
        // for a resize mid-flight, which would otherwise leave a rocket climbing out of frame.
        if (s.vy >= 0 || s.y <= s.targetY) {
          spawnBurst('fireworks', config.effects.fireworks, s.x, s.y, s.intensity, s.stops);
          shells.splice(i, 1);
        }
      }

      let write = 0;
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        p.life -= dt;
        if (p.life <= 0) continue;
        const keep = Math.pow(p.drag, dt);
        p.vx *= keep;
        p.vy = p.vy * keep + p.gravity * dt;
        if (p.kind === 'confetti' || p.kind === 'hearts') {
          // Paper does not fall straight: swing it sideways and tumble it, or the burst reads as
          // gravel rather than confetti.
          const flutter = numOr(config.effects[p.kind].flutter, 1);
          p.phase += dt * 6 * flutter;
          p.vx += Math.sin(p.phase) * 40 * flutter * dt;
          p.rot += p.vrot * dt;
        } else if (p.kind === 'embers' || p.kind === 'fountain') {
          p.phase += dt * 2;
          const wander = numOr(config.effects[p.kind].wander, 1);
          p.vx += Math.sin(p.phase) * 22 * wander * dt;
        }
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        parts[write++] = p;
      }
      parts.length = write;

      topUpAmbient(dt);
      const ambMode = effectiveAmbient();
      const ambSpec = isMode(ambMode) ? AMBIENT_MODES[ambMode] : null;
      const band = ambSpec && ambSpec.band ? [h * ambSpec.band[0], h * ambSpec.band[1]] : null;
      for (let i = 0; i < amb.length; i++) {
        const a = amb[i];
        a.phase += dt;
        a.y += a.vy * dt;
        a.x += (a.vx + Math.sin(a.phase) * a.sway) * dt;
        if (a.vrot) a.rot += a.vrot * dt;
        // Wrap on both axes and in BOTH directions. The old rule was "fell off the bottom, put it
        // back at the top", which is only true of weather that falls: bubbles and sparks rise, and
        // under that rule they left the frame for good, so the field drained and refilled from the
        // wrong edge — weather that visibly starts and stops instead of continuing.
        // A banded mode wraps within its band instead of the frame, or fog would drift up out of
        // its floor and come back as ceiling.
        // The wrap margin has to clear the particle's own drawn size: a fog puff is hundreds of
        // pixels across, and wrapping its CENTRE at a fixed 24px teleports it while most of it
        // is still visibly on screen. Everything else keeps the cheap constant.
        const my = a.draw === 'cloud' ? a.size * 4 + 24 : 24;
        const mx = a.draw === 'cloud' ? a.size * 8 + 60 : 60;
        if (band) {
          if (a.y > band[1] + my) { a.y = band[0] - my; a.x = rand(-40, w + 40); }
          else if (a.y < band[0] - my) { a.y = band[1] + my; a.x = rand(-40, w + 40); }
        } else if (a.y > h + my) { a.y = -my; a.x = rand(-40, w + 40); }
        else if (a.y < -my) { a.y = h + my; a.x = rand(-40, w + 40); }
        // Sideways is a plain wrap: a strong Wind pushes the whole field one way, and re-seeding
        // those particles at the top would make the wind look like it was also blowing upward.
        if (a.x < -mx) a.x = w + mx;
        else if (a.x > w + mx) a.x = -mx;
      }

      // Lightning. A strike is an EVENT, not weather: it does not fall, wrap, or live in the
      // particle budget, so — like the rockets — it gets its own array and its own aging. The
      // schedule is a per-frame coin flip at the configured average rate, which cannot burst:
      // dt is already clamped (MAX_DT), the gap floor holds whatever the slider says, and a tab
      // that was hidden gets NO catch-up strikes for the time nobody was watching.
      if (ambSpec && ambSpec.bolts) {
        const perMin = clamp(numOr(config.effects.ambient.strikes, 8), 1, 60);
        // Dead-time compensation: the 800ms floor removes schedulable time, so an uncorrected
        // coin flip at the asked-for rate under-delivers by a third at the top of the slider —
        // a control that quietly means less than it says. The hazard rate is corrected so the
        // ACHIEVED average matches the slider; the floor itself is untouched and still absolute.
        // At a throttled frame rate dt undercounts wall time and strikes get rarer — left that
        // way deliberately, because erring under is the safe direction for a flashing effect.
        const perSec = perMin / 60;
        const hazard = perSec / Math.max(0.2, 1 - perSec * (BOLT_MIN_GAP_MS / 1000));
        const now = performance.now();
        if (bolts.length < MAX_BOLTS && now - lastStrikeAt >= BOLT_MIN_GAP_MS
          && Math.random() < dt * hazard) {
          bolts.push(makeBolt());
          lastStrikeAt = now;
        }
      }
      for (let i = bolts.length - 1; i >= 0; i--) {
        bolts[i].life -= dt;
        if (bolts[i].life <= 0) bolts.splice(i, 1);
      }

      // Words age on WALL time rather than on accumulated dt, because a word's duration is a
      // promise to a viewer about how long they get to read it — a throttled tab must not make
      // "two seconds" mean six.
      if (words.length || wparts.length) stepWords(dt);
    }

    /**
     * One strike: a displaced-midpoint trunk from the cloud level down, plus one to three short
     * branches. Tinted mostly white with a cast of the palette — lightning that is fully 'fire'
     * orange reads as a crack in the screen, not as light.
     */
    function makeBolt() {
      const base = sample(ambientStops(), 0.15);
      const rgb = base.map((c) => Math.round(c + (255 - c) * 0.75));
      const x0 = rand(w * 0.12, w * 0.88);
      const y0 = rand(-10, h * 0.12);
      const trunk = boltPath(x0, y0, x0 + rand(-w * 0.06, w * 0.06), rand(h * 0.45, h * 0.85), h * 0.09, 5);
      const branches = [];
      const n = 1 + Math.floor(Math.random() * 3);
      for (let i = 0; i < n; i++) {
        const at = trunk[2 + Math.floor(Math.random() * Math.max(1, trunk.length - 8))];
        branches.push(boltPath(at[0], at[1],
          at[0] + rand(-w * 0.08, w * 0.08), at[1] + rand(h * 0.08, h * 0.2), h * 0.05, 3));
      }
      const life = rand(0.18, 0.3);
      return { trunk, branches, rgb, life, maxLife: life };
    }

    // The two-pass bolt stroke: halo wide and faint, core narrow and bright. strokeStyle is set
    // by the caller once per bolt.
    function strokeBolt(pts, alpha, width) {
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.globalAlpha = alpha * 0.25;
      ctx.lineWidth = width * 4;
      ctx.stroke();
      ctx.globalAlpha = alpha;
      ctx.lineWidth = Math.max(1, width);
      ctx.stroke();
    }

    function draw() {
      ctx.clearRect(0, 0, w, h);
      const overlayAlpha = clamp(config.opacity, 0, 1);
      if (overlayAlpha <= 0) return;

      // Ambient first, underneath everything — it is scenery, not an event.
      const ambCfg = config.effects.ambient;
      if (amb.length) {
        const ambAlpha = overlayAlpha * clamp(ambCfg.opacity, 0, 1);
        // Every particle on screen shares one mode, so the composite is decided once. The solid
        // draw kinds — leaves, and the overlapping cloud banks — wash out to bright paper under
        // additive compositing, which is the opposite of what they are.
        const solid = SOLID_DRAWS.has(amb[0].draw);
        const ambGlow = clamp(numOr(ambCfg.glow, 0.25), 0, 2);
        ctx.globalCompositeOperation = (!solid && ambGlow > 0) ? 'lighter' : 'source-over';
        for (let i = 0; i < amb.length; i++) {
          const a = amb[i];
          // Twinkle is per particle, so the alpha has to be set inside the loop. A mode that does
          // not twinkle pays one assignment of a constant.
          ctx.globalAlpha = a.twinkle > 0
            ? ambAlpha * (1 - a.twinkle * (0.5 + 0.5 * Math.cos(a.phase * a.twRate)))
            : ambAlpha;
          if (a.draw === 'streak') {
            ctx.strokeStyle = `rgb(${a.rgb[0]},${a.rgb[1]},${a.rgb[2]})`;
            ctx.lineWidth = Math.max(1, a.size * 0.4);
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(a.x - a.vx * 0.012, a.y - a.vy * 0.012);
            ctx.stroke();
          } else if (a.draw === 'ring') {
            // An outline, not a disc: a bubble is mostly the thing behind it.
            ctx.strokeStyle = `rgb(${a.rgb[0]},${a.rgb[1]},${a.rgb[2]})`;
            ctx.lineWidth = Math.max(1, a.size * 0.22);
            ctx.beginPath();
            ctx.arc(a.x, a.y, Math.max(1, a.size * 1.6), 0, Math.PI * 2);
            ctx.stroke();
          } else if (a.draw === 'cloud') {
            // One cached wide sprite per puff; softness lives in the sprite's own gradients, so
            // the whole heap is one drawImage — same discipline as the glow dots.
            const s = cloudFor(a.rgb);
            const dw = a.size * 14;
            ctx.drawImage(s, a.x - dw / 2, a.y - dw / 4, dw, dw / 2);
          } else if (a.draw === 'leaf' || a.draw === 'petal') {
            ctx.save();
            ctx.translate(a.x, a.y);
            ctx.rotate(a.rot);
            ctx.fillStyle = `rgb(${a.rgb[0]},${a.rgb[1]},${a.rgb[2]})`;
            if (a.draw === 'petal') {
              ctx.scale(1, Math.max(0.35, Math.abs(Math.cos(a.phase))));
              fillPetal(ctx, a.size);
            } else {
              ctx.beginPath();
              // Scaled by the tumble on one axis, the same trick the confetti uses: edge-on it goes
              // thin, which is the cheapest suggestion of a flat thing turning in the air.
              ctx.ellipse(0, 0, Math.max(1, a.size * 1.7),
                Math.max(0.6, a.size * 0.62 * Math.abs(Math.cos(a.phase))), 0, 0, Math.PI * 2);
              ctx.fill();
            }
            ctx.restore();
          } else {
            const s = spriteFor(a.rgb);
            // Glow SIZES the halo here, as it already did for bursts. Until this line it only chose
            // the composite mode, so every non-zero position on a 0-2 slider drew exactly the same
            // thing — a control that looks live and does nothing. The default 0.25 still comes out
            // at 4x, so no existing look moves.
            const d = a.size * (3.2 + ambGlow * 3.2);
            ctx.drawImage(s, a.x - d / 2, a.y - d / 2, d, d);
          }
        }
      }

      // Lightning, above the weather it belongs to and below the bursts. Two strokes per line —
      // a wide faint pass for the halo and a narrow bright one for the core — which is the
      // no-shadowBlur rule applied to a polyline. The whole-frame flash is clamped to
      // FLASH_ALPHA_MAX no matter what, and the scheduler's gap floor means flashes cannot stack:
      // a bolt is dead long before the next one is allowed to exist.
      if (bolts.length) {
        ctx.globalCompositeOperation = 'lighter';
        ctx.lineJoin = 'round';
        for (const b of bolts) {
          const t = clamp(b.life / b.maxLife, 0, 1);
          const age = b.maxLife - b.life;
          const flash = age < 0.09 ? 1 - age / 0.09 : 0;
          if (flash > 0) {
            ctx.globalAlpha = Math.min(FLASH_ALPHA_MAX, FLASH_ALPHA_MAX * flash) * overlayAlpha;
            ctx.fillStyle = `rgb(${b.rgb[0]},${b.rgb[1]},${b.rgb[2]})`;
            ctx.fillRect(0, 0, w, h);
          }
          ctx.strokeStyle = `rgb(${b.rgb[0]},${b.rgb[1]},${b.rgb[2]})`;
          strokeBolt(b.trunk, overlayAlpha * t, 2.2);
          for (const br of b.branches) strokeBolt(br, overlayAlpha * t * 0.55, 1.3);
        }
      }

      // Bursts. Glowing kinds composite additively so overlapping sparks bloom, which is the
      // whole reason this reads as light rather than as dots.
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        const t = clamp(p.life / p.maxLife, 0, 1);
        const alpha = overlayAlpha * clamp(p.alpha, 0, 1) * (t > 0.75 ? 1 : t / 0.75);
        if (alpha <= 0.01) continue;
        ctx.globalAlpha = alpha;
        if (p.kind === 'confetti' || p.kind === 'hearts') {
          ctx.globalCompositeOperation = 'source-over';
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(p.rot);
          // Scale the width by the tumble so a piece edge-on goes thin — the cheapest possible
          // suggestion of a flat object rotating in 3D.
          ctx.fillStyle = `rgb(${p.rgb[0]},${p.rgb[1]},${p.rgb[2]})`;
          if (p.kind === 'hearts') {
            ctx.scale(Math.max(0.18, Math.abs(Math.cos(p.phase))), 1);
            fillHeart(ctx, p.size);
          } else {
            ctx.fillRect(-p.size / 2, -p.size / 4, p.size * Math.abs(Math.cos(p.phase)), p.size / 2);
          }
          ctx.restore();
        } else {
          ctx.globalCompositeOperation = 'lighter';
          const glow = clamp(p.glow, 0, 2);
          if (glow > 0) {
            // The halo is kept tight on purpose. Spreading the same energy over a wide radius
            // makes every spark a dim smudge — on a stream that reads as dust, not as fire.
            const s = spriteFor(p.rgb);
            const d = p.size * (3 + glow * 3.5);
            ctx.drawImage(s, p.x - d / 2, p.y - d / 2, d, d);
          }
          // A bright, solid core is what carries the colour; the halo only surrounds it.
          ctx.fillStyle = `rgb(${p.rgb[0]},${p.rgb[1]},${p.rgb[2]})`;
          ctx.beginPath();
          ctx.arc(p.x, p.y, Math.max(0.9, p.size * 0.9), 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // Rockets in flight, drawn last so a shell is never hidden behind its own trail.
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < shells.length; i++) {
        const s = shells[i];
        if (s.delay > 0) continue;
        ctx.globalAlpha = overlayAlpha;
        const sp = spriteFor(s.rgb);
        const d = 14 * config.scale;
        ctx.drawImage(sp, s.x - d / 2, s.y - d / 2, d, d);
      }

      // Layer 6: WORDS, above everything, because the whole point of a word is that it is read.
      // A word behind a firework is a word nobody can make out, and this is the one layer whose
      // value is entirely legibility.
      if (words.length || wparts.length) drawWords(overlayAlpha);

      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }

    function drawWords(overlayAlpha) {
      // Word PARTICLES only — assemble never draws the glyph. Gather 0 is source-over dots
      // mushed on the fill. Gather 1 (glowMul > 0) is additive embers. Burst-out is always
      // additive so what is left behind is the same fire as the rest of the overlay.
      if (wparts.length) {
        for (let i = 0; i < wparts.length; i++) {
          const p = wparts[i];
          const alpha = overlayAlpha * clamp(p.owner.opacity, 0, 1) * clamp(p.alpha, 0, 1);
          if (alpha <= 0.01) continue;
          const glowMul = Number.isFinite(p.glowMul) ? p.glowMul : 5.5;
          const ph = p.owner && p.owner.phase;
          const leaving = ph && ph.phase === 'out';
          const tight = glowMul < 2 && !leaving;
          ctx.globalCompositeOperation = tight ? 'source-over' : 'lighter';
          ctx.globalAlpha = alpha;
          if (!tight && glowMul > 0) {
            const s = spriteFor(p.rgb);
            const d = p.size * glowMul;
            ctx.drawImage(s, p.x - d / 2, p.y - d / 2, d, d);
          }
          ctx.fillStyle = rgbCss(p.rgb);
          ctx.beginPath();
          ctx.arc(p.x, p.y, Math.max(0.8, p.size * (tight ? 0.72 : 0.85)), 0, Math.PI * 2);
          ctx.fill();
        }
      }

      for (let i = 0; i < words.length; i++) {
        const word = words[i];
        const ph = word.phase;
        // A particle style declares no passes: its raster is the SAMPLE SOURCE and is never drawn.
        if (!ph || ph.phase === 'dead' || !word.spec.passes.length) continue;
        const r = word.raster;
        const alpha = overlayAlpha * clamp(word.opacity, 0, 1) * ph.alpha;
        if (alpha <= 0.01) continue;
        // The entrance scale. easeOutBack overshoots past 1 and settles back — that overshoot IS
        // the pop, and it is exactly why the easing is a JS function rather than a CSS curve: a
        // cubic-bezier has to be monotonic and cannot overshoot at all.
        const over = clamp(numOr(word.params.overshoot, 1), 0, 2);
        const grow = (ph.phase === 'in' && word.spec.in === 'pop')
          ? 0.72 + 0.28 * (1 + (easeOutBack(clamp(ph.t, 0, 1)) - 1) * over)
          : 1;
        const lift = ph.phase === 'in'
          ? (1 - easeOutCubic(clamp(ph.t, 0, 1))) * clamp(numOr(word.params.lift, 0), 0, 0.5) * r.h
          : 0;
        ctx.save();
        ctx.translate(word.x, word.y + lift);
        // |cos| on the WIDTH alone: edge-on the word goes thin. Confetti and leaves in this file
        // already do exactly this, and the comment there applies word for word here — it is the
        // cheapest possible suggestion of a flat object rotating in 3D. Floored just above zero
        // so a word passing through edge-on does not vanish for a frame.
        const turn = word.spin ? Math.max(0.06, Math.abs(Math.cos(word.spinAngle || 0))) : 1;
        ctx.scale(grow * turn, grow);
        const ox = -r.w / 2;
        const oy = -r.h / 2;
        for (const pass of word.spec.passes) {
          if (pass === 'glow' && r.glow) {
            ctx.globalCompositeOperation = 'lighter';
            ctx.globalAlpha = alpha * clamp(numOr(word.params.glow, 2), 0, 3) * 0.55;
            ctx.drawImage(r.glow, ox, oy);
          } else if (pass === 'shade' && r.shade) {
            ctx.globalCompositeOperation = 'source-over';
            const shadeA = clamp(numOr(word.params.shade, 0.55), 0, 1);
            if (shadeA <= 0 && !word.spec.depth) continue;
            if (word.spec.depth) {
              // The extrusion: one dark raster, stacked along a depth vector, back to front. The
              // stack is drawn from the FAR end so each layer covers the one behind it, and the
              // x-step follows the spin so the solid side swaps as the word turns through
              // edge-on — which is what makes it read as a solid object rather than a shadow.
              const layers = Math.max(1, Math.round(clamp(numOr(word.params.depth, 10), 0, 40)));
              const tilt = clamp(numOr(word.params.tilt, 0.3), 0, 1);
              const unit = r.size * 0.035;
              const stepX = word.spin ? unit * Math.sin(word.spinAngle || 0) : unit;
              const stepY = unit * tilt;
              for (let k = layers; k >= 1; k--) {
                ctx.globalAlpha = alpha * (0.3 + 0.5 * (k / layers));
                ctx.drawImage(r.shade, ox + stepX * k, oy + stepY * k);
              }
            } else {
              // Flat: one dark copy, offset. The cheapest way to keep a word readable over a busy
              // scene, and it pairs with everything.
              ctx.globalAlpha = alpha * shadeA;
              ctx.drawImage(r.shade, ox + r.size * 0.05, oy + r.size * 0.06);
            }
          } else if (pass === 'face') {
            ctx.globalCompositeOperation = 'source-over';
            ctx.globalAlpha = alpha;
            ctx.drawImage(r.face, ox, oy);
          }
        }
        ctx.restore();
      }
    }

    function frame(now) {
      if (!running) return;
      raf = global.requestAnimationFrame(frame);
      const dt = Math.min((now - last) / 1000 || 0, MAX_DT);
      last = now;
      if (dt > 0) step(dt);
      draw();
      notePaint(now);
      paintFpsHud();
    }

    /**
     * Beat detection: bass energy against its own running average. An absolute threshold cannot
     * work here — one track's quiet passage is another's chorus — so the comparison is relative,
     * and the average adapts slowly enough that a genuine kick still stands out from it.
     */
    /**
     * The gap the beat effect actually honours.
     *
     * With `syncToBpm` on, this is the song's own tempo — `everyBeats` beats of it — so the burst
     * spacing follows the music instead of a number hand-set for whatever was playing when it was
     * tuned. It falls back to the manual value whenever no tempo is known (start of a track, a
     * sparse passage, silence), because a fabricated tempo would space the bursts confidently
     * wrong, which is harder to notice than no sync at all.
     */
    function effectiveMinGap(now) {
      const beat = config.beat;
      if (beat.syncToBpm && detector) {
        const reading = detector.get(now);
        if (reading.bpm) return Math.round((60000 / reading.bpm) * (beat.everyBeats || 4));
      }
      return beat.minGapMs;
    }

    function pushBands(bands) {
      if (!Array.isArray(bands) || !bands.length) return;
      const now0 = performance.now();
      lastBandsAt = now0;
      if (detector) detector.push(bands, now0);
      let bass = 0;
      const n = Math.min(4, bands.length);
      // Number.isFinite, not `|| 0`. A truthy non-numeric element survives `|| 0` and turns bass
      // into NaN, which then enters bandAvg — a recursive average that never clears a NaN once one
      // is in it. Every later comparison against it is false, so beat detection dies silently and
      // permanently after a single malformed frame. The same defect in fx-bpm.js froze the tempo
      // reading at whatever it happened to be, with no error anywhere.
      for (let i = 0; i < n; i++) { const v = bands[i]; bass += Number.isFinite(v) ? v : 0; }
      bass /= n * 255;
      bandAvg = bandAvg * 0.94 + bass * 0.06;
      if (!config.beat.enabled || !playerUp) return;
      const now = performance.now();
      if (now - lastBeatAt < effectiveMinGap(now)) return;
      // The floor matters as much as the ratio: near silence, tiny fluctuations beat a tiny
      // average by a wide margin, and the overlay would fire continuously into an empty room.
      if (bass < 0.12 || bass < bandAvg * config.beat.sensitivity) return;
      lastBeatAt = now;

      // The burst follows the music: bigger when it is louder, when it is faster, or both.
      // 'off' keeps every burst the configured size.
      const bpmNow = beatPeriodMs(now) ? 60000 / beatPeriodMs(now) : null;
      const opts = {
        intensity: config.beat.intensity * musicIntensity(config.beat.dynamics, bass, bpmNow),
      };

      // 'random' rolls a different effect each burst, never the same twice running.
      let effect = config.beat.effect;
      if (effect === 'random') {
        lastBeatEffect = randomEffectName(lastBeatEffect);
        effect = lastBeatEffect;
      }
      // The beat's own palette. 'auto' deliberately sets NOTHING, keeping the fallthrough to
      // the main palette — including main 'random' rolling per shell, which naming a palette
      // here would flatten to one roll per burst. An explicit 'random' rolls per burst against
      // the beat's own tracker.
      if (config.beat.palette !== 'auto') {
        let pal = config.beat.palette;
        if (pal === 'random') {
          lastBeatPalette = randomPaletteName(lastBeatPalette, config.customs, config.library);
          pal = lastBeatPalette;
        }
        opts.palette = pal;
      }
      // A firework is not seen when it launches, it is seen when it BURSTS — and the climb takes
      // most of a second. Firing on the beat therefore puts the launch on the beat and the
      // explosion somewhere after it, which is the one thing this whole feature is for. Giving the
      // rocket a flight of a whole number of beats means it leaves on one beat and opens on a
      // later one, so both ends land in time.
      if (effect === 'fireworks') {
        const period = beatPeriodMs(now);
        if (period) {
          opts.flightMs = beatAlignedFlight(period);
          opts.staggerMs = period / 2;   // extra shells on the offbeat, not scattered at random
        }
      }
      fire(effect, opts);
    }

    // The current beat length in ms, or null when no tempo is known.
    function beatPeriodMs(now) {
      if (!detector) return null;
      const reading = detector.get(now);
      return reading.bpm ? 60000 / reading.bpm : null;
    }


    const api = {
      setConfig(next) {
        config = mergeConfig(DEFAULTS, next || {});
        config.opacity = clamp(config.opacity, 0, 1);
        config.scale = clamp(config.scale, 0.2, 4);
        config.particleCap = clamp(Math.round(config.particleCap), 50, 6000);
        config.ambientCap = clamp(Math.round(config.ambientCap), 0, 2000);
        // The third budget, clamped here as the other two are. MAX_WORD_PARTICLES is the ceiling
        // no write path can raise; this is the value inside it.
        config.wordCap = clamp(Math.round(numOr(config.wordCap, 600)), 0, MAX_WORD_PARTICLES);
        if (!AMBIENTS.includes(config.ambient)) config.ambient = 'off';
        if (config.ambient === 'off') amb.length = 0;
        const effMode = effectiveAmbient();
        if (effMode !== lastBoltMode || !(isMode(effMode) && AMBIENT_MODES[effMode].bolts)) bolts.length = 0;
        lastBoltMode = effMode;
        const signature = ambientSignature();
        if (signature !== lastAmbientSignature) {
          lastAmbientSignature = signature;
          reparameteriseAmbient();
        }
        // The server allowlists palette on every write, but a ?pal= pin or a hand-edited config
        // arrives here without passing it. stopsFor() guards itself too; clamping here keeps an
        // unknown name from ever being what getConfig() reports.
        if (config.palette !== 'random' && config.palette !== 'custom'
          && !CUSTOM_SLOTS.includes(config.palette)
          && !Object.prototype.hasOwnProperty.call(PALETTES, config.palette)
          && !isLibraryName(config.palette)) config.palette = 'hive';   // a library name resolves (or falls back) in stopsFor
        // The split palettes take the same names plus 'auto'. Same layer and same reason as the
        // main clamp above — a hand-edited config or an old peer must not park an unknown name.
        const palOk = (v) => v === 'random' || v === 'custom' || CUSTOM_SLOTS.includes(v)
          || Object.prototype.hasOwnProperty.call(PALETTES, v) || isLibraryName(v);
        if (config.ambientPalette !== 'auto' && !palOk(config.ambientPalette)) config.ambientPalette = 'auto';
        if (config.beat.palette !== 'auto' && !palOk(config.beat.palette)) config.beat.palette = 'auto';
        // Words. Same layer and same reason as every clamp around it: the server allowlists on
        // every write, but a hand-edited fx-config.json, a ?query pin or an older peer arrives
        // here without having passed it, and an unknown style name must never be what
        // getConfig() reports. Placed below palOk deliberately — it is used here.
        const wc = config.words;
        if (!isWordStyle(wc.style) && wc.style !== 'random') wc.style = 'neon';
        if (!Object.prototype.hasOwnProperty.call(WORD_FONTS, wc.font)) wc.font = 'impact';
        if (!WORD_POSITIONS.includes(wc.position)) wc.position = 'center';
        if (wc.palette !== 'auto' && !palOk(wc.palette)) wc.palette = 'auto';
        wc.enabled = wc.enabled !== false;
        wc.size = clamp(numOr(wc.size, 96), 12, 400);
        wc.durationMs = clamp(numOr(wc.durationMs, 2200), 200, 15000);
        wc.opacity = clamp(numOr(wc.opacity, 1), 0, 1);
        wc.x = clamp(numOr(wc.x, 0.5), 0, 1);
        wc.y = clamp(numOr(wc.y, 0.4), 0, 1);
        // MAX_WORDS is the hard ceiling; this is the operator's control beneath it. Exactly the
        // MAX_BOLTS / strikes relationship, and for the same reason.
        wc.maxOnScreen = clamp(Math.round(numOr(wc.maxOnScreen, 2)), 1, MAX_WORDS);
        wc.outline = clamp(Math.round(numOr(wc.outline, 0)), 0, 8);
        // A cap lowered while words are on screen takes effect NOW, or the control looks like it
        // does nothing until the next word — the same "this slider is dead" complaint that made
        // the weather re-parameterise in place rather than wait for a respawn.
        while (words.length > wc.maxOnScreen) dropWord(0);
        if (wparts.length > config.wordCap) makeWordRoom(0, config.wordCap);
        const on = wc.enabled !== false;
        if (!on && wordsEnabled) panicFadeInflight(words, queuedWords, performance.now());
        wordsEnabled = on;
        // 'random' is a valid choice here but is never handed to fire() — it is resolved to a
        // real effect per burst.
        if (!EFFECTS.includes(config.beat.effect) && config.beat.effect !== 'random') config.beat.effect = DEFAULTS.beat.effect;
        if (!DYNAMICS.includes(config.beat.dynamics)) config.beat.dynamics = 'loudness';
        config.beat.everyBeats = clamp(Math.round(config.beat.everyBeats) || 4, 1, 16);
        // Boolean effect flags: default-false, so anything other than true is off.
        // Do not copy words.enabled !== false — that is a default-true switch.
        for (const name of Object.keys(DEFAULTS.effects)) {
          const block = config.effects[name];
          const defs = DEFAULTS.effects[name];
          if (!block || typeof block !== 'object') continue;
          for (const key of Object.keys(defs)) {
            if (typeof defs[key] === 'boolean') block[key] = block[key] === true;
          }
        }
      },
      getConfig() { return config; },
      fire,
      // Put a word on screen. Returns false when it was refused — words off, nothing left after
      // sanitising, or the hard gap floor — so a caller can tell "sent" from "swallowed".
      say,
      pushBands,
      setPlayerUp(up) {
        const was = playerUp;
        playerUp = up !== false;
        if (!playerUp) {
          bandAvg = 0;
          // Whatever plays next is a different piece of music. Carrying a dozen seconds of the old
          // track's onsets across the gap would blend two tempos into one confident wrong answer.
          if (was && detector) detector.reset();
        }
      },
      // True while spectrum frames are actually arriving. The studio shows this so "beat mode is
      // on but nothing happens" is diagnosable without opening a console.
      isAudioLive() { return playerUp && (performance.now() - lastBandsAt) < STALE_MS; },
      // { bpm, confidence, onsets } — bpm is null when the tempo is not known, which is a real
      // answer and must be shown as one rather than as a stale number.
      getBpm() {
        return detector ? detector.get(performance.now()) : { bpm: null, confidence: 0, onsets: 0 };
      },
      // What the beat effect is actually waiting, so the studio can show the consequence of the
      // sync setting instead of leaving the operator to compute it.
      getEffectiveGap() { return effectiveMinGap(performance.now()); },
      // The weather actually being drawn — 'random' resolved. The studio shows it and greys out the
      // controls this mode ignores, which it cannot work out from the config alone.
      getAmbientMode() { return effectiveAmbient(); },
      stats() {
        return {
          parts: parts.length, ambient: amb.length, shells: shells.length, bolts: bolts.length,
          words: words.length, wordParts: wparts.length,
        };
      },
      framesDrawn() { return drawn; },
      measuredFps() { return running ? measuredFps : 0; },
      setFpsHud(on) { fpsHudOn = on === true; },
      // What is on screen right now, for the studio's readout. TEXT ONLY, and it must reach the
      // page as textContent — never innerHTML. This is the single accessor most likely to be
      // spliced into a template literal by someone in a hurry, which is why the warning is here
      // rather than only in the file header.
      wordsOnScreen() { return words.map((word) => ({ text: word.text, style: word.style })); },
      clear() {
        parts.length = 0; amb.length = 0; shells.length = 0; bolts.length = 0;
        words.length = 0; wparts.length = 0;
      },
      resize,
      start() {
        if (running) return;
        running = true;
        last = performance.now();
        fpsWinT = 0; fpsWinN = 0;
        raf = global.requestAnimationFrame(frame);
      },
      stop() {
        running = false;
        if (raf) global.cancelAnimationFrame(raf);
        raf = null;
        measuredFps = 0; fpsWinT = 0; fpsWinN = 0;
      },
    };

    resize();
    global.addEventListener('resize', resize);
    return api;
  }

  /**
   * Runtime FPS ceilings on top of a saved look. Each numeric trim is a MIN with the
   * saved value, so a lighter overlay cannot RAISE a budget, and applying a cheaper
   * preset is not undone by an older trim. Not a disk write — the studio Keep button
   * is what commits these onto the document and the applied preset.
   */
  function applyLoadTrim(cfg, trim) {
    if (!cfg || typeof cfg !== 'object') return cfg;
    if (!trim || typeof trim !== 'object' || Array.isArray(trim)) return cfg;
    let out;
    try { out = JSON.parse(JSON.stringify(cfg)); }
    catch { return cfg; }
    const minNum = (obj, key, src) => {
      if (Number.isFinite(src[key]) && Number.isFinite(obj[key])) obj[key] = Math.min(obj[key], src[key]);
    };
    minNum(out, 'particleCap', trim);
    minNum(out, 'ambientCap', trim);
    minNum(out, 'wordCap', trim);
    minNum(out, 'scale', trim);
    if (trim.ambient === 'off') out.ambient = 'off';
    if (trim.effects && typeof trim.effects === 'object' && out.effects) {
      for (const name of Object.keys(trim.effects)) {
        const src = trim.effects[name];
        if (!src || typeof src !== 'object' || Array.isArray(src) || !out.effects[name]) continue;
        for (const k of Object.keys(src)) minNum(out.effects[name], k, src);
      }
    }
    return out;
  }

  return {
    create,
    EFFECTS,
    AMBIENTS,
    AMBIENT_MODES,
    AMBIENT_MODE_NAMES,
    ROLLABLE_AMBIENTS,
    randomAmbientName,
    resolveAmbient,
    boltPath,
    // Words. The tables and the hard constants are exported so the studio can build its controls
    // from them and the smoke suite can assert them, rather than either place keeping a second
    // copy of numbers that are supposed to be unreachable.
    WORD_STYLES,
    WORD_STYLE_LIST,
    WORD_STYLE_NAMES,
    ROLLABLE_WORD_STYLES,
    WORD_POSITIONS,
    WORD_FONTS,
    WORD_FONT_NAMES,
    WORD_PARAM_RANGES,
    MAX_WORDS,
    MAX_WORD_CHARS,
    MAX_WORD_PARTICLES,
    WORD_MIN_GAP_MS,
    MAX_COMBINING_PER_BASE,
    // THE security function, exported deliberately: server.js requires this file to use exactly
    // this implementation, so there is one sanitiser rather than two that can drift.
    sanitiseWordText,
    graphemesOf,
    wordPhase,
    panicFadeInflight,
    PANIC_OUT_MS,
    randomWordStyle,
    PALETTES,
    CUSTOM_SLOTS,
    DEFAULTS,
    mergeConfig,
    // Exported for tests. The timing maths is the part of this file whose correctness is not
    // visible by watching it — a burst landing 80ms late looks fine and is still off the beat —
    // so it is pure, module-level, and asserted in Node rather than judged by eye.
    shellPhysics,
    beatAlignedFlight,
    randomPaletteName,
    usablePaletteNames,
    stopsFor,
    sample,
    isLibraryName,
    libraryNames,
    tempoIntensity,
    musicIntensity,
    randomEffectName,
    DYNAMICS,
    SHELL_FLIGHT_MS,
    applyLoadTrim,
  };
})
