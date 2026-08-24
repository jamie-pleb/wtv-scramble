// ==UserScript==
// @name         w.tv Descrambler
// @namespace    https://github.com/jamie-pleb/wtv-scramble
// @version      1.4.0
// @description  Descrambles a live w.tv or Kick.com video stream in real time, undoing the matching OBS "scramble" filter using a shared key.
// @author       jamie-pleb
// @match        https://w.tv/*
// @match        https://kick.com/*
// @run-at       document-idle
// @grant        none
// @homepageURL  https://github.com/jamie-pleb/wtv-scramble
// @supportURL   https://github.com/jamie-pleb/wtv-scramble/issues
// @updateURL    https://raw.githubusercontent.com/jamie-pleb/wtv-scramble/main/dist/viewer/wtv-descramble.user.js
// @downloadURL  https://raw.githubusercontent.com/jamie-pleb/wtv-scramble/main/dist/viewer/wtv-descramble.user.js
// ==/UserScript==

(function () {
  'use strict';

  // =========================================================================
  // Contract version this script implements. A key whose `version` field
  // does not match this MUST refuse to descramble (see SPEC/contract.md,
  // "Versioning") rather than silently misrender.
  // =========================================================================
  const CONTRACT_VERSION = 1;

  // =========================================================================
  // THE KEY — edit here for a quick static override, or use the on-page
  // control panel (bottom-right, collapsible) to change it live. Defaults
  // MUST match SPEC/contract.md's DEFAULT_KEY / reference.mjs's DEFAULT_KEY.
  // =========================================================================
  const DEFAULT_KEY = Object.freeze({
    seed: 1337,
    grid: 9,
    flipH: true,
    flipV: false,
    invert: true,
    blockPermute: true,
    version: CONTRACT_VERSION,
  });

  const STORAGE_KEY_KEY = 'wtv-descramble:key:v1';
  const STORAGE_KEY_PANEL_COLLAPSED = 'wtv-descramble:panel-collapsed:v1';
  const STORAGE_KEY_ENABLED = 'wtv-descramble:enabled:v1';
  const STORAGE_KEY_ADVANCED_COLLAPSED = 'wtv-descramble:advanced-collapsed:v1';

  function loadStoredKey() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (e) {
      return null; // corrupt/foreign localStorage value — ignore, use defaults
    }
  }

  function persistKey() {
    try {
      localStorage.setItem(STORAGE_KEY_KEY, JSON.stringify(KEY));
    } catch (e) {
      /* storage unavailable/full — non-fatal, just don't persist */
    }
  }

  // The live, mutable key. Stored overrides (from a previous session's panel
  // edits) win over DEFAULT_KEY so a viewer's settings survive reloads and
  // SPA navigations. Different broadcasters may use different keys, which is
  // exactly why this is editable at runtime rather than a hard constant.
  const KEY = Object.assign({}, DEFAULT_KEY, loadStoredKey() || {});

  // Master ON/OFF switch for the whole overlay (panel toggle — see
  // "Control panel" section below). Defaults to ON so existing installs
  // behave exactly as before unless a viewer explicitly flips it off.
  function loadStoredEnabled() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_ENABLED);
      return raw !== '0'; // default ON unless explicitly stored as off
    } catch (e) {
      return true;
    }
  }
  function persistEnabled() {
    try {
      localStorage.setItem(STORAGE_KEY_ENABLED, enabled ? '1' : '0');
    } catch (e) {
      /* storage unavailable/full — non-fatal, just don't persist */
    }
  }
  let enabled = loadStoredEnabled();

  // =========================================================================
  // Performance mode (P3) & Debug stats (P4) toggles — independent of KEY,
  // persisted the same way as `enabled` above. Both default OFF so existing
  // installs get the new WebGL renderer's default behavior (uncapped
  // resolution, no overlay) unless a viewer opts in via the Advanced panel.
  // =========================================================================
  const STORAGE_KEY_PERFMODE = 'wtv-descramble:perfmode:v1';
  const STORAGE_KEY_DEBUG = 'wtv-descramble:debug:v1';

  function loadStoredBool(key) {
    try {
      return localStorage.getItem(key) === '1';
    } catch (e) {
      return false;
    }
  }
  function persistBool(key, value) {
    try {
      localStorage.setItem(key, value ? '1' : '0');
    } catch (e) {
      /* storage unavailable/full — non-fatal, just don't persist */
    }
  }

  let perfMode = loadStoredBool(STORAGE_KEY_PERFMODE);
  let debugStats = loadStoredBool(STORAGE_KEY_DEBUG);

  // =========================================================================
  // Renderer policy (P5) — "auto" (default) | "webgl" | "2d". Persisted like
  // the toggles above. LOCKED DECISION (see dist/perf-bench.html A/B/C
  // results): on HEALTHY hardware the 2D canvas backend beats WebGL in
  // submission cost on both Chrome and Firefox, so "auto" starts every
  // fresh attach() on 2D rather than WebGL-first — WebGL is reserved as the
  // escalation path for the (rarer) machines where the 2D backend has
  // silently fallen to software rendering (see updateSkipEngagement's
  // auto-escalation branch, "Performance mode (P3)" section below). "webgl"
  // and "2d" force that renderer (still laddering to 2D on WebGL failure in
  // the "webgl" case) for diagnosing which one is actually the problem.
  // =========================================================================
  const STORAGE_KEY_RENDERER = 'wtv-descramble:renderer:v1';

  function loadStoredRenderer() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_RENDERER);
      return raw === 'webgl' || raw === '2d' ? raw : 'auto';
    } catch (e) {
      return 'auto';
    }
  }
  function persistRenderer(value) {
    try {
      localStorage.setItem(STORAGE_KEY_RENDERER, value);
    } catch (e) {
      /* storage unavailable/full — non-fatal, just don't persist */
    }
  }

  let rendererPref = loadStoredRenderer();

  // Session-sticky companion to state.autoEscalated: set the first time a
  // WebGL attempt genuinely FAILS (setup, first-frame upload, or an
  // unrestored context loss). Without it, "auto" mode with autoEscalated set
  // would rebuild and re-fail the full WebGL pipeline on every SPA
  // navigation for the rest of the session. Deliberately NOT consulted when
  // the user forces "webgl" via the dropdown — an explicit choice is the
  // escape hatch for retrying after e.g. a driver hiccup.
  let webglFailedThisSession = false;

  // =========================================================================
  // Ported reference math — keep in sync with SPEC/reference.mjs — see
  // SPEC/contract.md for the full spec, and read the "Which array does each
  // renderer use?" section before touching anything below.
  //
  // This is a byte-for-byte port of mulberry32 + Fisher-Yates. Do NOT
  // "simplify" or re-derive it. An earlier draft of this system had `perm`
  // and `inv` swapped between the OBS scramble shader and this browser
  // descrambler; that bug was only caught by hand-deriving a worked example
  // before writing code, because getting it backwards does NOT crash — it
  // produces a picture that is STILL SCRAMBLED, just differently. To
  // re-verify this port: buildPermutation(1337, 9) below must equal
  // test/perm-1337-9.json byte-for-byte (checked before this file shipped).
  // =========================================================================

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function next() {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= (t + Math.imul(t ^ (t >>> 7), t | 61)) >>> 0;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // perm[i] = the scrambled slot that source tile i is placed into.
  function buildPermutation(seed, grid) {
    const n = grid * grid;
    const rng = mulberry32(seed);
    const perm = new Array(n);
    for (let i = 0; i < n; i++) perm[i] = i;
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = perm[i];
      perm[i] = perm[j];
      perm[j] = tmp;
    }
    return perm;
  }

  // inv[perm[i]] = i for all i.
  function invertPermutation(perm) {
    const inv = new Array(perm.length);
    for (let i = 0; i < perm.length; i++) inv[perm[i]] = i;
    return inv;
  }

  function tileSize(width, height, grid) {
    return { tileW: Math.floor(width / grid), tileH: Math.floor(height / grid) };
  }

  function tileRect(index, grid, tileW, tileH) {
    const col = index % grid;
    const row = Math.floor(index / grid);
    return { x: col * tileW, y: row * tileH, w: tileW, h: tileH };
  }

  // Browser descrambler direction (contract.md "Which array does each
  // renderer use?"): for OUTPUT tile i (true position), sample the
  // SCRAMBLED frame at slot PERM[i]. NOT inv — inv is what the OBS
  // *scramble* shader uses on the other side of this contract.
  //
  // perm/inv depend only on (seed, grid), never on frame size, so they're
  // cached independently of canvas/video dimensions.
  let permCache = null; // { seed, grid, perm, inv }
  function getPermutation(seed, grid) {
    if (permCache && permCache.seed === seed && permCache.grid === grid) {
      return permCache;
    }
    const perm = buildPermutation(seed >>> 0, grid);
    const inv = invertPermutation(perm); // computed for symmetry/clarity per contract.md, unused here
    permCache = { seed, grid, perm, inv };
    return permCache;
  }

  // Per-tile destination/source rects depend on (grid, width, height); cache
  // them so the render loop doesn't recompute 81 rects (or reallocate
  // arrays) every single frame. Also caches the two unpermuted border-strip
  // rects (contract.md "Tile geometry") since they depend on the same
  // (grid, width, height) triple and are otherwise cheap-but-repeated
  // per-frame arithmetic.
  let geometryCache = null; // { grid, width, height, tileW, tileH, rects, gridW, gridH, borderRightW, borderBottomH }
  function getGeometry(grid, width, height) {
    if (
      geometryCache &&
      geometryCache.grid === grid &&
      geometryCache.width === width &&
      geometryCache.height === height
    ) {
      return geometryCache;
    }
    const { tileW, tileH } = tileSize(width, height, grid);
    const n = grid * grid;
    const rects = new Array(n);
    for (let i = 0; i < n; i++) rects[i] = tileRect(i, grid, tileW, tileH);
    // gridW/gridH = the permuted region's extent; border strips fill the
    // L-shaped remainder outside it (each strictly < grid px, per
    // contract.md), always strictly < grid px so at most one is ever needed
    // per axis. Right strip runs the FULL height (including the
    // bottom-right corner); bottom strip only spans the grid width, so the
    // two strips cover the remainder exactly once each, no overlap/gap.
    const gridW = tileW * grid;
    const gridH = tileH * grid;
    geometryCache = {
      grid,
      width,
      height,
      tileW,
      tileH,
      rects,
      gridW,
      gridH,
      borderRightW: width - gridW,
      borderBottomH: height - gridH,
    };
    return geometryCache;
  }

  // Upper clamp rationale: the WebGL perm-lookup encoding (index = R + G*256
  // across two UNSIGNED_BYTE channels) is exact only up to grid*grid = 65536,
  // i.e. grid 256. Clamping here (rather than only in the GL path) keeps the
  // two renderers behaving identically for any input, and costs nothing real:
  // the OBS filter's own grid property is capped at 64, so no legitimately
  // produced key can ever exceed this.
  const MAX_GRID = 256;
  function effectiveGrid() {
    const g = Math.round(Number(KEY.grid));
    if (!Number.isFinite(g) || g < 1) return 9;
    return Math.min(g, MAX_GRID);
  }

  function keyIsCompatible() {
    return KEY.version === CONTRACT_VERSION;
  }

  let versionWarned = false;
  function checkVersionAndWarn() {
    const ok = keyIsCompatible();
    if (!ok && !versionWarned) {
      versionWarned = true;
      console.error(
        `[wtv-descramble] Key version mismatch: key.version=${JSON.stringify(
          KEY.version
        )}, this script supports version ${CONTRACT_VERSION}. Refusing to descramble ` +
          `(showing the raw scrambled feed with a warning banner instead of guessing).`
      );
    }
    if (ok) versionWarned = false; // allow a fresh log if it goes bad again later
    return ok;
  }

  // =========================================================================
  // Master string (compact shareable key encoding) — ported VERBATIM from
  // SPEC/reference.mjs's encodeMasterString/parseMasterString/validateKey.
  // See SPEC/contract.md, "Master string (compact shareable key encoding)"
  // for the full grammar and parse-tolerance rules, and
  // test/master-strings.json for the golden fixtures this must match
  // byte-for-byte. Do NOT re-derive this — any divergence from reference.mjs
  // here is a bug.
  // =========================================================================

  function validateKey(key) {
    if (!key || typeof key !== 'object') {
      throw new Error('scramble key must be an object');
    }
    if (key.version !== CONTRACT_VERSION) {
      throw new Error(
        `scramble key version mismatch: got ${key.version}, this build expects ${CONTRACT_VERSION}. Refusing to run rather than misrender.`
      );
    }
    if (!Number.isInteger(key.grid) || key.grid < 1) {
      throw new Error(`scramble key.grid must be a positive integer, got ${key.grid}`);
    }
    if (!Number.isFinite(key.seed)) {
      throw new Error(`scramble key.seed must be a finite number, got ${key.seed}`);
    }
    return key;
  }

  function encodeMasterString(key) {
    validateKey(key);
    let flags = '';
    if (key.flipH) flags += 'H';
    if (key.flipV) flags += 'V';
    if (key.invert) flags += 'I';
    if (key.blockPermute) flags += 'P';
    if (flags === '') flags = '0';
    return `WTV${key.version}-${key.seed >>> 0}-${key.grid}-${flags}`;
  }

  function parseMasterString(str) {
    if (typeof str !== 'string') {
      throw new Error('master string must be a string');
    }
    const m = /^WTV(\d+)-(\d+)-(\d+)-([A-Za-z0-9]*)$/i.exec(str.trim());
    if (!m) {
      throw new Error(`not a valid master string (expected WTV1-<seed>-<grid>-<flags>): "${str.trim()}"`);
    }
    const version = parseInt(m[1], 10);
    if (version !== CONTRACT_VERSION) {
      throw new Error(`master string version ${version} unsupported (this build expects ${CONTRACT_VERSION})`);
    }
    const seed = Number(m[2]);
    if (!Number.isInteger(seed) || seed < 0 || seed > 4294967295) {
      throw new Error(`master string seed out of uint32 range: ${m[2]}`);
    }
    const grid = parseInt(m[3], 10);
    if (!Number.isInteger(grid) || grid < 1) {
      throw new Error(`master string grid must be >= 1: ${m[3]}`);
    }
    const key = { seed, grid, flipH: false, flipV: false, invert: false, blockPermute: false, version };
    const flagsRaw = m[4].toUpperCase();
    if (flagsRaw !== '' && flagsRaw !== '0') {
      for (const ch of flagsRaw) {
        if (ch === 'H') key.flipH = true;
        else if (ch === 'V') key.flipV = true;
        else if (ch === 'I') key.invert = true;
        else if (ch === 'P') key.blockPermute = true;
        else throw new Error(`unknown flag "${ch}" in master string (valid: H, V, I, P, or 0 for none)`);
      }
    }
    return key;
  }

  // =========================================================================
  // Player detection — per-site selector profiles. Each supported site
  // (see @match above) gets its own primary/fallback CSS selector pair,
  // verified against that site's live DOM before shipping (see the comment
  // on each profile). The active profile is picked once from
  // location.hostname at load time and reused for the page's whole
  // lifetime — a site's own client-side navigation never changes its own
  // hostname, so there's nothing to recompute later.
  // =========================================================================

  const SITE_PROFILES = [
    {
      id: 'wtv',
      hostTest: (h) => h === 'w.tv' || h.endsWith('.w.tv'),
      // data-testid is far more stable across Nuxt/Vue builds than the
      // hashed class names or even the id, but keep #videoPlayer as a
      // fallback in case a future markup change drops the testid.
      primarySelector: 'video[data-testid="stream-player-video"]',
      fallbackSelector: '#videoPlayer',
    },
    {
      id: 'kick',
      hostTest: (h) => h === 'kick.com' || h.endsWith('.kick.com'),
      // Verified against a live channel (kick.com/sliker): the real player
      // is <video id="video-player">, nested under #injected-channel-player,
      // inside a position:relative div — the same layout precondition the
      // overlay-positioning code below assumes.
      //
      // Kick's page ALSO always contains a second, unrelated <video> with no
      // id, permanently 0x0/hidden, living inside a <video-player> custom
      // element, whose currentSrc is a static "black_2s.mp4" ad-warmup clip
      // — not the stream. The id selector can't accidentally match it (it
      // has no id), and the fallback below is deliberately scoped to
      // #injected-channel-player rather than any bare "video-player video"
      // selector, which WOULD match that ad placeholder instead.
      primarySelector: 'video#video-player',
      fallbackSelector: '#injected-channel-player video',
    },
  ];

  const activeSiteProfile = SITE_PROFILES.find((p) => p.hostTest(location.hostname)) || null;

  function findVideo() {
    if (!activeSiteProfile) return null; // shouldn't happen given @match above, but degrade safely rather than throw
    return (
      document.querySelector(activeSiteProfile.primarySelector) ||
      (activeSiteProfile.fallbackSelector ? document.querySelector(activeSiteProfile.fallbackSelector) : null)
    );
  }

  // =========================================================================
  // Overlay state — one video/canvas pair at a time. w.tv is a Nuxt SPA and
  // can destroy/recreate the player (including the <video> element) on
  // client-side navigation, so everything here is torn down and rebuilt
  // rather than assumed to live for the page's whole lifetime.
  // =========================================================================
  const state = {
    video: null,
    videoParentAtAttach: null, // detects Vue reparenting the SAME video node (see scanForVideo)
    mode: null, // 'css' (no canvas, cheapest) or 'canvas' (block-permute or bad key version)
    canvas: null,
    ctx: null, // 2D context — set only when renderer === '2d'
    renderer: null, // 'webgl' | '2d' | null (null when mode !== 'canvas') — see attach()
    rendererFallbackReason: null, // why we're on 2D instead of WebGL, or null if renderer === 'webgl'
    frameCanvas: null, // offscreen scratch canvas holding the ONE per-frame
    frameCtx: null,    // video snapshot, used when blockPermute is on (see renderFrame2D)
    // --- WebGL renderer state (P1) — all null/false when renderer !== 'webgl'.
    // See "WebGL renderer (P1)" section below for setup/teardown.
    gl: null,
    glCanvasRef: null, // the canvas the context-loss listeners are attached to
    glProgram: null,
    glVertexBuffer: null,
    glVideoTexture: null,
    glPermTexture: null,
    glUniforms: null,
    glLoseContextExt: null,
    glPermCacheSeed: null, // (seed, grid) the perm texture was last built for — compared
    glPermCacheGrid: null, // numerically per-frame so the check itself never allocates
    glFirstUploadDone: false, // guards the try/catch CORS/taint check to the first frame only
    glContextLost: false,
    // --- Debug overlay (P4) — null unless debugStats is on AND a video is attached.
    debug: null,
    frameCallbackId: null,
    frameCallbackKind: null, // 'rvfc' | 'raf' — which API frameCallbackId belongs to
    resizeObserver: null,
    revealed: false, // has the canvas swapped in over the raw <video> yet?
    // Fullscreen reparenting (see handleFullscreenChange): the canvas overlay
    // is normally a DOM sibling of the video, but the browser's fullscreen
    // "top layer" only promotes document.fullscreenElement and its
    // descendants — a sibling canvas would be left behind, invisible, unless
    // moved inside it for the duration of fullscreen.
    reparented: false,
    originalParent: null,
    originalNextSibling: null,
    usingFixedPosition: false,
    // Session-level (NOT persisted, NOT reset by teardown/attach — a fresh
    // page load is the only thing that clears it): has "auto" renderer
    // policy already escalated from 2D to WebGL once this session, because
    // 2D hit sustained overload? See updateSkipEngagement's auto-escalation
    // branch in the "Performance mode (P3)" section below.
    autoEscalated: false,
  };

  function stopLoop() {
    if (state.frameCallbackId == null) return;
    if (state.frameCallbackKind === 'rvfc' && state.video && typeof state.video.cancelVideoFrameCallback === 'function') {
      state.video.cancelVideoFrameCallback(state.frameCallbackId);
    } else if (state.frameCallbackKind === 'raf') {
      cancelAnimationFrame(state.frameCallbackId);
    }
    state.frameCallbackId = null;
    state.frameCallbackKind = null;
  }

  function teardown() {
    stopLoop();
    releaseGLResources(); // no-op if renderer !== 'webgl' — see "WebGL renderer (P1)" below
    removeDebugOverlay(); // no-op if debug overlay isn't up — see "Debug overlay (P4)" below
    resetPerfState(); // clear the P3 rolling render-cost window / frame-skip state
    if (state.resizeObserver) {
      state.resizeObserver.disconnect();
      state.resizeObserver = null;
    }
    if (state.reparented && state.originalParent && state.originalParent.isConnected && state.canvas) {
      // Put the canvas back where it came from before removing it, so a
      // torn-down-mid-fullscreen overlay doesn't leave the fullscreen
      // element holding a stale reference to a detached node.
      state.originalParent.appendChild(state.canvas);
    }
    if (state.canvas && state.canvas.parentNode) {
      state.canvas.parentNode.removeChild(state.canvas);
    }
    if (state.video) {
      // Undo the visual hide/CSS transform in case this exact element
      // somehow survives (defensive; normally we only ever teardown a
      // disconnected video, or one about to be re-attached fresh).
      state.video.style.opacity = '';
      state.video.style.transition = '';
      state.video.style.filter = '';
      state.video.style.transform = '';
    }
    state.video = null;
    state.videoParentAtAttach = null;
    state.mode = null;
    state.canvas = null;
    state.ctx = null;
    state.renderer = null;
    state.rendererFallbackReason = null;
    state.revealed = false;
    state.reparented = false;
    state.originalParent = null;
    state.originalNextSibling = null;
    state.usingFixedPosition = false;
    // frameCanvas/frameCtx deliberately kept — harmless to reuse across
    // videos, it's just a scratch buffer resized on demand.
  }

  // Cheapest possible mode that still honors the current key: skip the
  // canvas/render-loop entirely when there's no tile permutation to do,
  // since invert+flip alone are pure CSS with zero per-frame JavaScript. A
  // version-incompatible key always needs 'canvas' so the warning banner
  // (which requires drawing) has somewhere to render.
  function computeMode() {
    return KEY.blockPermute || !keyIsCompatible() ? 'canvas' : 'css';
  }

  // Applies invert/flip as CSS filter+transform (GPU-composited, no
  // per-frame JS) to whichever element is currently the visible surface:
  // the raw <video> in 'css' mode, or the overlay <canvas> in 'canvas' mode
  // (where only the block-permute tile copy still needs the 2D context).
  function applyStaticCss(el) {
    el.style.filter = KEY.invert ? 'invert(1)' : '';
    const sx = KEY.flipH ? -1 : 1;
    const sy = KEY.flipV ? -1 : 1;
    el.style.transform = sx === 1 && sy === 1 ? '' : `scale(${sx}, ${sy})`;
  }

  // Called after any control-panel edit to KEY. Switches the DOM structure
  // between 'css' and 'canvas' mode if the change affects which one is
  // needed (e.g. toggling Block Permute); otherwise just re-applies the CSS
  // in place. Cheap and safe to call unconditionally on every key edit.
  function applyKeyChange() {
    if (!state.video) return;
    const desired = computeMode();
    if (desired !== state.mode) {
      const video = state.video;
      attach(video); // full rebuild for the new mode
      return;
    }
    if (state.mode === 'css') applyStaticCss(state.video);
    else if (state.mode === 'canvas' && state.canvas) applyStaticCss(state.canvas);
  }

  function attach(video) {
    // Capture BEFORE teardown(): when rebuilding around the SAME video that
    // was already descrambling on-screen (auto-escalation, renderer dropdown
    // switch, SPA reparent), teardown() clears the video's opacity, which
    // would flash the raw SCRAMBLED frames until the fresh renderer's first
    // revealOnce(). We re-hide it below for that case — a beat of black is
    // acceptable; a scrambled leak defeats the whole point.
    const wasRevealedSameVideo = state.revealed && state.video === video;
    teardown();
    state.video = video;
    state.videoParentAtAttach = video.parentElement;
    video.style.transition = 'none'; // avoid a page-wide `* { transition }` rule causing a slow fade

    const mode = computeMode();
    state.mode = mode;

    if (mode === 'css') {
      // Cheapest path: no canvas, no render loop at all. Invert/flip are
      // pure CSS on the live video, composited by the GPU for free — there
      // is nothing for JavaScript to do on a per-frame basis.
      applyStaticCss(video);
      return;
    }

    const parent = video.parentElement;
    if (!parent) {
      state.video = null;
      state.videoParentAtAttach = null;
      state.mode = null;
      return;
    }

    // CORS / canvas-tainting note: the IVS stream is cross-origin
    // (streams.w.tv / live-video.net vs the w.tv page origin). Drawing it
    // into either renderer's canvas taints it for *reads* (getImageData /
    // toDataURL, or a WebGL readPixels, would throw/fail). That's expected
    // and fine — this script only ever WRITES (2D drawImage, or a WebGL
    // texImage2D + draw) for on-screen display, it never reads pixels back.
    // Do NOT set video.crossOrigin (can break IVS's MSE-based playback) and
    // do NOT add getImageData/toDataURL/readPixels here.

    // --- Renderer selection (P1 ladder + P5 policy): WHETHER we attempt
    // WebGL at all is governed by rendererPref (see STORAGE_KEY_RENDERER
    // above) — "webgl" and "auto"-already-escalated-this-session both try
    // WebGL first; "2d" skips the attempt entirely; "auto" not yet escalated
    // starts on 2D (the LOCKED DECISION) without ever creating a WebGL
    // context, so a machine that never needs the rescue never pays for it.
    // WHEN WebGL IS attempted, the P1 fallback ladder below is unchanged:
    // setup happens on a throwaway canvas BEFORE insertion into the DOM; if
    // it fails for any reason we discard that canvas and build a fresh one
    // for the 2D context instead of reusing it, because a canvas element's
    // context type (webgl vs 2d) is locked in permanently by whichever
    // getContext() call succeeds on it first — you cannot get a '2d' context
    // from a canvas that already handed out a 'webgl' one, even if that
    // WebGL setup subsequently failed. See "WebGL renderer (P1)" below for
    // setupGLPipeline/tryCreateWebglContext and the full fallback ladder (no
    // context / compile-link failure / first-frame upload failure / context
    // loss without restore / incompatible key needing the 2D-only banner).
    let canvas = createOverlayCanvasElement();
    if (rendererPref === '2d') {
      state.rendererFallbackReason = 'renderer preference: 2d';
      state.ctx = canvas.getContext('2d', { alpha: false });
      state.renderer = '2d';
    } else if (
      rendererPref === 'webgl' ||
      (rendererPref === 'auto' && state.autoEscalated && !webglFailedThisSession)
    ) {
      const gl = tryCreateWebglContext(canvas);
      if (gl && setupGLPipeline(gl, canvas)) {
        state.renderer = 'webgl';
        state.rendererFallbackReason = null;
        canvas.addEventListener('webglcontextlost', onGLContextLost, false);
        canvas.addEventListener('webglcontextrestored', onGLContextRestored, false);
      } else {
        webglFailedThisSession = true; // don't re-fail this every SPA re-attach in auto mode
        state.rendererFallbackReason = gl ? 'shader compile/link failed' : 'WebGL unavailable';
        canvas = createOverlayCanvasElement(); // fresh element — see note above
        state.ctx = canvas.getContext('2d', { alpha: false });
        state.renderer = '2d';
      }
    } else if (rendererPref === 'auto' && state.autoEscalated && webglFailedThisSession) {
      state.rendererFallbackReason = 'auto: escalated but WebGL failed earlier this session — staying on 2D';
      state.ctx = canvas.getContext('2d', { alpha: false });
      state.renderer = '2d';
    } else {
      // "auto", not yet escalated this session: 2D-first by design.
      state.rendererFallbackReason = 'auto: 2D-first, escalates under sustained load';
      state.ctx = canvas.getContext('2d', { alpha: false });
      state.renderer = '2d';
    }
    applyStaticCss(canvas); // invert/flip live on the canvas's own CSS, not the per-frame draw, in BOTH renderer modes

    // Anti-flash (see wasRevealedSameVideo above): keep the still-scrambled
    // video hidden through this rebuild; revealOnce() will re-assert both
    // opacities once the new renderer lands its first real frame.
    if (wasRevealedSameVideo) video.style.opacity = '0';

    // Insert immediately after the video (not necessarily as the parent's
    // last child) so any control elements that come later in DOM order
    // still paint above the overlay per normal stacking rules.
    if (video.nextSibling) parent.insertBefore(canvas, video.nextSibling);
    else parent.appendChild(canvas);

    state.canvas = canvas;

    syncCanvasLayout();

    if (window.ResizeObserver) {
      state.resizeObserver = new ResizeObserver(syncCanvasLayout);
      state.resizeObserver.observe(video);
      if (parent !== video) state.resizeObserver.observe(parent);
    }

    // If the SPA recreated the <video> while the page was ALREADY in
    // fullscreen, no fullscreenchange event fires (fullscreenElement itself
    // didn't change), so without this the fresh canvas would sit outside the
    // fullscreen top layer and never be visible — a blank player until the
    // user exits and re-enters fullscreen. Outside fullscreen this is a
    // no-op beyond a harmless extra layout sync.
    handleFullscreenChange();

    if (debugStats) createDebugOverlay(); // P4 — restores the overlay across SPA re-attaches when the toggle is on

    startLoop();
  }

  // Builds the (not-yet-inserted, not-yet-context-bound) overlay <canvas>
  // element shared by both renderer setup paths in attach() above.
  function createOverlayCanvasElement() {
    const canvas = document.createElement('canvas');
    canvas.setAttribute('data-wtv-descramble-overlay', '1');
    Object.assign(canvas.style, {
      position: 'absolute',
      left: '0px',
      top: '0px',
      width: '0px',
      height: '0px',
      zIndex: '2',
      pointerEvents: 'none', // clicks must pass through to the video/controls beneath
      display: 'block',
      opacity: '0', // stay invisible until we've actually drawn a real frame (avoid blanking the poster)
      transition: 'none',
    });
    return canvas;
  }

  // Position/size the overlay to match the video's own box exactly. The
  // canvas is inserted as the video's next sibling inside the video's own
  // parent, so both share the same offsetParent — comparing offsetLeft/Top/
  // Width/Height directly needs no getBoundingClientRect/scroll math (per
  // the real DOM: the parent is `position:relative`, the video is
  // `position:static`, so this absolute overlay lines up with inset-style
  // math automatically; we still do it explicitly here so it also holds up
  // if that parent ever stops filling the video's own box exactly).
  function syncCanvasLayout() {
    const video = state.video;
    const canvas = state.canvas;
    if (!video || !canvas) return;

    if (state.usingFixedPosition) {
      // The canvas has been reparented into document.fullscreenElement
      // (see handleFullscreenChange), so it no longer shares the video's
      // offsetParent — offsetLeft/Top math doesn't apply here. Use the
      // video's viewport rect directly instead.
      const rect = video.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        canvas.style.position = 'fixed';
        canvas.style.left = rect.left + 'px';
        canvas.style.top = rect.top + 'px';
        canvas.style.width = rect.width + 'px';
        canvas.style.height = rect.height + 'px';
      }
      syncWebglBackingSize();
      return;
    }

    canvas.style.position = 'absolute';
    const w = video.offsetWidth;
    const h = video.offsetHeight;
    if (w > 0 && h > 0) {
      canvas.style.left = video.offsetLeft + 'px';
      canvas.style.top = video.offsetTop + 'px';
      canvas.style.width = w + 'px';
      canvas.style.height = h + 'px';
    }
    syncWebglBackingSize();
  }

  // P2 — ABR-proof sizing (WebGL renderer only): the canvas BACKING size
  // tracks the video's DISPLAY box (called only from layout-driven events —
  // ResizeObserver, window resize, fullscreen toggles, all of which funnel
  // through syncCanvasLayout above) times devicePixelRatio, capped at
  // 1920x1080 normally or 1280x720 in Performance mode (P3). Deliberately
  // NOT derived from video.videoWidth/videoHeight, which the render loop
  // touches every frame — that's what makes an IVS adaptive-bitrate
  // rendition switch (videoWidth/videoHeight changing mid-stream) cause
  // zero backing-buffer reallocation here, unlike the 2D fallback below
  // (renderFrame2D still calls ensureBackingSize(canvas, video.videoWidth,
  // video.videoHeight) every frame, unchanged from v1.2.1 — that's the
  // hitch this function exists to avoid in the primary WebGL path).
  function syncWebglBackingSize() {
    if (state.renderer !== 'webgl' || !state.gl || !state.video || !state.canvas) return;
    const rect = state.video.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const capW = perfMode ? 1280 : 1920;
    const capH = perfMode ? 720 : 1080;
    const w = Math.max(1, Math.min(Math.round((rect.width || 1) * dpr), capW));
    const h = Math.max(1, Math.min(Math.round((rect.height || 1) * dpr), capH));
    if (state.canvas.width !== w || state.canvas.height !== h) {
      state.canvas.width = w;
      state.canvas.height = h;
      state.gl.viewport(0, 0, w, h);
    }
  }

  // The browser's fullscreen "top layer" only promotes
  // document.fullscreenElement and its descendants above everything else.
  // The overlay canvas normally lives as a plain sibling of <video>, so if
  // w.tv fullscreens the <video> element directly (rather than a wrapper
  // that already contains the canvas), the canvas would be left behind,
  // invisible, showing only the raw scrambled frame beneath it. Detect that
  // and temporarily move the canvas inside the fullscreen element, restoring
  // its original position on exit.
  function handleFullscreenChange() {
    const canvas = state.canvas;
    const video = state.video;
    if (!canvas || !video) return;
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement || null;

    if (fsEl && !fsEl.contains(canvas)) {
      if (!state.reparented) {
        state.originalParent = canvas.parentNode;
        state.originalNextSibling = canvas.nextSibling;
        state.reparented = true;
      }
      fsEl.appendChild(canvas);
      state.usingFixedPosition = true;
    } else if (!fsEl && state.reparented) {
      if (state.originalParent && state.originalParent.isConnected) {
        if (state.originalNextSibling && state.originalNextSibling.parentNode === state.originalParent) {
          state.originalParent.insertBefore(canvas, state.originalNextSibling);
        } else {
          state.originalParent.appendChild(canvas);
        }
      }
      state.reparented = false;
      state.originalParent = null;
      state.originalNextSibling = null;
      state.usingFixedPosition = false;
    }
    syncCanvasLayout();
  }

  function ensureBackingSize(cv, w, h) {
    if (cv.width !== w || cv.height !== h) {
      cv.width = w;
      cv.height = h;
    }
  }

  function ensureFrameCanvas(w, h) {
    if (!state.frameCanvas) {
      state.frameCanvas = document.createElement('canvas');
      state.frameCtx = state.frameCanvas.getContext('2d', { alpha: false });
    }
    ensureBackingSize(state.frameCanvas, w, h);
  }

  function revealOnce() {
    if (state.revealed) return;
    state.revealed = true;
    state.canvas.style.opacity = '1';
    // Visually hide the raw scrambled video — opacity, NOT display:none,
    // since display:none can pause playback/decoding in some browsers. The
    // video stays fully "live" as the frame source and its audio keeps
    // playing normally; only its own box becomes invisible.
    state.video.style.opacity = '0';
  }

  // =========================================================================
  // Per-frame descramble — RENDERER ARCHITECTURE (v1.3.0, P1-P4) AND THE
  // FALLBACK LADDER
  //
  // Two renderer implementations share the exact same descramble contract
  // (perm-not-inv gather, tile geometry, border pass-through — see
  // contract.md) and the exact same division of labor: block-permute is the
  // only per-frame work either renderer does; invert/flip are ALWAYS pure
  // CSS (filter/transform) applied to the visible canvas via applyStaticCss,
  // in both modes, never touched by shader or 2D-context code.
  //
  //   - renderFrameGL (primary): see the "WebGL renderer (P1)" section
  //     below, right after this one. Does the tile permutation as a single
  //     fragment-shader gather against a lookup texture, drawn once per
  //     frame (one texImage2D + one drawArrays). Its canvas backing size is
  //     decoupled from video.videoWidth/videoHeight (P2/syncWebglBackingSize)
  //     so an IVS adaptive-bitrate rendition switch mid-stream reallocates
  //     nothing on our side — that decoupling, plus moving the permutation
  //     off the main thread onto the GPU, is what P1+P2 exist to fix (see
  //     the field-situation note in the project's release notes: Firefox
  //     software-backing an offscreen 2D snapshot canvas, plus ABR-driven
  //     canvas-backing reallocation, were the two remaining causes of
  //     frametime lag/freezes after v1.2.1's single-video-read fix below).
  //   - renderFrame2D (this function, unchanged from v1.2.1 below): the
  //     automatic fallback, selected at attach() time when WebGL is
  //     unavailable, or falls back to mid-session on: shader compile/link
  //     failure, first-frame texture-upload failure (CORS/taint — verified
  //     at runtime, see uploadVideoFrame), or a lost WebGL context that
  //     fails to restore (see onGLContextRestored). It keeps its v1.2.1
  //     videoWidth-tracked canvas-backing behavior unchanged — no attempt is
  //     made to also decouple this path's sizing, per the spec for this
  //     release.
  //
  // Pipeline order (see contract.md "Canonical pipeline order"): inverse
  // block-permute -> invert colors -> flip. Invert and flip cost no
  // per-frame JavaScript at all: they're applied as CSS filter/transform
  // directly on the canvas element (see applyStaticCss), which the GPU
  // compositor handles independently of the draw loop below. That leaves
  // exactly one job for this function to do per frame: the block-permute
  // tile copy (only when blockPermute is on), which genuinely does need the
  // 2D context because it rearranges pixel *position*, not color.
  //
  // ONE-SNAPSHOT PIPELINE, AND WHY IT MATTERS (renderFrame2D only):
  //
  // An earlier version of this function used the <video> element directly as
  // the drawImage SOURCE for every single tile — 1 full-frame base copy + up
  // to grid*grid tile copies, i.e. 82 video-element reads per frame at the
  // default grid=9. Chrome decodes/color-converts a video frame once per
  // task and reuses that cached conversion across repeated
  // drawImage(video, ...) calls within the same task, so those extra reads
  // are nearly free there. Firefox does NOT cache this: it re-pays the
  // video->canvas conversion on every single drawImage(video, ...) call, so
  // cost scales with grid^2 against the most expensive possible source type.
  // At grid=9 on real hardware that saturates the main thread badly enough
  // to visibly tank frame rate and let audio/video sync drift — Chrome saw
  // none of this.
  //
  // Fix: read the <video> element exactly ONCE per frame, into a small
  // reused offscreen "frame canvas" (state.frameCanvas/state.frameCtx).
  // Every other draw this frame — the border strips and all grid*grid tile
  // copies — sources from that already-decoded canvas instead, which is
  // cheap to re-sample in every browser (canvas-to-canvas drawImage is not
  // the operation that was expensive). Tiles and strips are also drawn
  // straight onto the VISIBLE canvas now; there is no second full-frame
  // "work" canvas and no final full-frame blit stage anymore. Every pixel of
  // the visible canvas still gets written exactly once per frame — the tile
  // loop covers the in-grid region, the two border strips cover the
  // L-shaped remainder — and since a <canvas> only presents its accumulated
  // draws to the compositor once its owning task finishes (not after each
  // individual drawImage call), drawing tiles/strips directly onto the
  // visible canvas cannot tear mid-frame.
  //   1. Snapshot: frameCtx.drawImage(video, ...) — the ONLY video read.
  //   2. Border strips (only drawn when the resolution doesn't divide
  //      evenly by grid): up to two thin unpermuted copies from the
  //      snapshot straight onto the visible canvas.
  //   3. Tile pass: grid*grid copies from the snapshot to the visible
  //      canvas — output tile i <- snapshot tile PERM[i] (see contract.md).
  // When blockPermute is off, or grid is too fine for this resolution
  // (tileW/tileH would be 0), there is nothing to rearrange, so a single
  // ctx.drawImage(video, ...) straight onto the visible canvas is already
  // both correct and minimal (one read, no snapshot needed).
  // =========================================================================

  function renderFrame2D(video, canvas) {
    const ctx = state.ctx;
    const vw = video.videoWidth;
    const vh = video.videoHeight;

    ensureBackingSize(canvas, vw, vh);

    const grid = effectiveGrid();

    if (KEY.blockPermute) {
      // getGeometry caches per (grid, vw, vh) — its tileW/tileH replace a
      // separate tileSize() call here so the steady-state frame path does
      // zero allocations, per the pipeline note above.
      const geom = getGeometry(grid, vw, vh);
      if (geom.tileW > 0 && geom.tileH > 0) {
        ensureFrameCanvas(vw, vh);
        const frameCanvas = state.frameCanvas;
        const frameCtx = state.frameCtx;

        // The ONLY video-element read this frame — see the pipeline note
        // above for why this must stay singular.
        frameCtx.drawImage(video, 0, 0, vw, vh);

        const { perm } = getPermutation(KEY.seed >>> 0, grid);

        // Unpermuted remainder border (contract.md "Tile geometry"): a
        // right strip and a bottom strip, each strictly < grid px, together
        // covering exactly the L-shaped area the tile loop below does not
        // touch. Drawn from the snapshot, straight onto the visible canvas;
        // skipped entirely when the resolution divides evenly by grid.
        if (geom.borderRightW > 0) {
          ctx.drawImage(
            frameCanvas,
            geom.gridW, 0, geom.borderRightW, vh,
            geom.gridW, 0, geom.borderRightW, vh
          );
        }
        if (geom.borderBottomH > 0) {
          ctx.drawImage(
            frameCanvas,
            0, geom.gridH, geom.gridW, geom.borderBottomH,
            0, geom.gridH, geom.gridW, geom.borderBottomH
          );
        }

        // Descramble direction: output tile i <- snapshot tile perm[i].
        // (NOT inv — see the big warning above / SPEC/contract.md.)
        for (let i = 0; i < geom.rects.length; i++) {
          const dest = geom.rects[i];
          const src = geom.rects[perm[i]];
          ctx.drawImage(frameCanvas, src.x, src.y, src.w, src.h, dest.x, dest.y, dest.w, dest.h);
        }

        revealOnce();
        return;
      }
      // else: grid finer than the video resolution allows (tileW/tileH would
      // be 0) — skip permutation rather than issuing zero-size drawImage
      // calls, which throw. Falls through to the single-read raw draw below.
    }

    // blockPermute off, or the tileW/tileH === 0 fallback above: nothing to
    // rearrange, so one direct video read straight onto the visible canvas
    // is already correct and minimal.
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    revealOnce();
  }

  function renderIncompatibleBanner(video, canvas) {
    const ctx = state.ctx;
    ensureBackingSize(canvas, video.videoWidth, video.videoHeight);

    // Show the raw (still scrambled) frame rather than guessing at a
    // transform for a key version we don't understand — clear any CSS
    // invert/flip left over on the canvas itself so this is truly raw.
    canvas.style.filter = '';
    canvas.style.transform = '';
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const bannerH = Math.max(24, Math.round(canvas.height * 0.06));
    ctx.fillStyle = 'rgba(176, 0, 0, 0.88)';
    ctx.fillRect(0, 0, canvas.width, bannerH);
    ctx.fillStyle = '#ffffff';
    ctx.font = `${Math.max(11, Math.round(bannerH * 0.45))}px system-ui, sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillText(
      `wtv-descramble: key version ${KEY.version} unsupported (this script needs ${CONTRACT_VERSION})`,
      canvas.width / 2,
      bannerH / 2
    );

    revealOnce();
  }

  // =========================================================================
  // WebGL renderer (P1) — primary path, automatic 2D fallback per the ladder
  // documented at the top of the "Per-frame descramble" section above.
  //
  // LOCKED DIVISION OF LABOR: this shader does ONLY the tile permutation.
  // Invert/flip are pure CSS on the visible canvas via applyStaticCss, in
  // BOTH renderer modes — mirrors the 2D path exactly, keeps the fallback
  // visually identical, and keeps this shader's surface minimal.
  //
  // GATHER DIRECTION (contract.md "Which array does each renderer use?"):
  // for OUTPUT tile i (image-space row=floor(i/grid), col=i%grid, exactly
  // tileRect()'s convention), sample the SCRAMBLED video texture at slot
  // PERM[i] — NOT inv. Getting this backwards does not crash, it silently
  // renders a differently-scrambled picture (see the JS-side warning above
  // getPermutation). The fragment shader below implements exactly this:
  // tile index i = floor(uv * grid) of the OUTPUT uv, p = perm[i] from the
  // lookup texture, sample the video texture at tile p offset by the same
  // intra-tile fraction. Pixels outside the permuted region (the < grid-px
  // remainder border, see contract.md "Tile geometry") pass through
  // unpermuted, exactly like renderFrame2D and the OBS scramble shader.
  //
  // PERM LOOKUP TEXTURE: a grid x grid texture, NEAREST filtering, no mips,
  // index encoded across the R and G bytes (index = R + G*256, each /255 on
  // upload, decoded back in-shader) so WebGL1 suffices — no float textures,
  // no WebGL2 requirement. Rebuilt only when (seed, grid) changes (see
  // uploadPermTexture / state.glPermCacheSeed+Grid), reusing the same JS-side
  // getPermutation()/buildPermutation() the 2D path uses, so the perm array
  // itself is computed in exactly one place regardless of renderer.
  //
  // ORIENTATION: gl.pixelStorei(UNPACK_FLIP_Y_WEBGL, true) is set once for
  // BOTH textures (video and perm) in setupGLPipeline, so both share one
  // consistent convention: texture v=1 (WebGL's "top") holds row 0 of the
  // JS-side data (image-space top, matching tileRect's row-0-is-top
  // convention) for both textures alike. The fragment shader therefore
  // converts screen-space vUv (v=1 at screen top, standard WebGL clip-space
  // convention with our fullscreen-triangle vertex shader) to one shared
  // "image space" (x right, y DOWN, y=0 at top — i.e. tileRect's own
  // convention) via `uvImg = vec2(vUv.x, 1.0 - vUv.y)`, does ALL tile/perm
  // math in that image space, and only converts back to a texture-sampling
  // v (`1.0 - y`) at the point of each texture2D() call — one shared
  // helper-shaped conversion applied identically to both textures, so a mistake
  // here would show up as either a global vertical mirror (easy to spot) or
  // a scrambled-looking permutation (caught by the worked example in
  // contract.md: grid=2, perm=[2,0,3,1] => output tile 0 (row0,col0) must
  // sample scrambled tile 2 (row1,col0) — hand-verified against this exact
  // shader's math before shipping).
  //
  // SEAM RULE: because the render target size is decoupled from the video
  // size (P2), LINEAR sampling near an output-tile boundary could bleed
  // pixels from the NEIGHBORING SOURCE TILE of the scrambled frame (visible
  // wrong-colored seams). Fixed by clamping the sampled uv within each
  // source tile to [tileMin + halfTexel, tileMax - halfTexel], in VIDEO
  // texture (image) space, using uHalfTexel = 0.5 / videoWidth|Height.
  //
  // BORDER MATH is in SOURCE (video) texture space, per the spec for this
  // release: uUsedFrac = (floor(videoW/grid)*grid / videoW, same for H) is
  // recomputed from video.videoWidth/videoHeight every frame (cheap scalar
  // math, not a reallocation) and handles both the non-divisible-resolution
  // border AND the "grid finer than this resolution" case uniformly: when
  // tileW or tileH floors to 0, uUsedFrac's corresponding component is 0,
  // so the border check (uv >= 0) is always true and the ENTIRE frame
  // becomes pass-through — the same "skip permutation, one raw draw" result
  // renderFrame2D reaches via its explicit `geom.tileW > 0 && geom.tileH >
  // 0` guard, just falling out of the same shader branch instead of a
  // separate code path.
  //
  // NO PER-FRAME ALLOCATIONS: renderFrameGL below allocates nothing itself;
  // uploadPermTexture allocates a Uint8Array only on the (seed, grid)
  // change that invalidates state.glPermCacheSeed/Grid, not per frame.
  // =========================================================================

  const GL_VERTEX_SRC = [
    'attribute vec2 aPos;',
    'varying vec2 vUv;',
    'void main() {',
    '  vUv = aPos * 0.5 + 0.5;', // NDC [-1,1] -> [0,1]; vUv.y=1 at screen top (see orientation note above)
    '  gl_Position = vec4(aPos, 0.0, 1.0);',
    '}',
  ].join('\n');

  const GL_FRAGMENT_SRC = [
    '#ifdef GL_FRAGMENT_PRECISION_HIGH',
    'precision highp float;',
    '#else',
    'precision mediump float;',
    '#endif',
    'varying vec2 vUv;',
    'uniform sampler2D uVideo;',
    'uniform sampler2D uPerm;',
    'uniform float uGrid;',
    'uniform vec2 uUsedFrac;',   // (usedW/videoW, usedH/videoH) - extent of the permuted region, image space
    'uniform vec2 uHalfTexel;',  // half a VIDEO texel, in video-texture-space fractions (seam clamp)
    'void main() {',
    '  vec2 uvImg = vec2(vUv.x, 1.0 - vUv.y);', // screen space -> image space (y=0 top, matches tileRect)
    '  vec3 color;',
    '  if (uvImg.x >= uUsedFrac.x || uvImg.y >= uUsedFrac.y) {',
    '    vec2 vTex = vec2(uvImg.x, 1.0 - uvImg.y);', // border remainder: pass through unpermuted
    '    color = texture2D(uVideo, vTex).rgb;',
    '  } else {',
    '    vec2 gridPos = uvImg / uUsedFrac * uGrid;', // in [0, grid) within the permuted region
    '    float col = floor(gridPos.x);',
    '    float row = floor(gridPos.y);',
    '    vec2 frac = gridPos - vec2(col, row);', // intra-tile fraction, [0,1)
    '    vec2 permUv = (vec2(col, row) + 0.5) / uGrid;',
    '    vec2 permTexUv = vec2(permUv.x, 1.0 - permUv.y);',
    '    vec4 permTexel = texture2D(uPerm, permTexUv);',
    // Decode index = R + G*256 (each channel /255 on upload); +0.5 before
    // floor guards against float roundoff landing just under an integer.
    '    float idx = floor(permTexel.r * 255.0 + 0.5) + floor(permTexel.g * 255.0 + 0.5) * 256.0;',
    '    float pCol = mod(idx, uGrid);',
    '    float pRow = floor(idx / uGrid);',
    // Descramble gather: output tile (col,row) <- scrambled tile (pCol,pRow)
    // — i.e. perm[i], NOT inv[i]. See the big comment above this shader.
    '    vec2 tileMinImg = vec2(pCol, pRow) * uUsedFrac / uGrid;',
    '    vec2 tileMaxImg = (vec2(pCol, pRow) + 1.0) * uUsedFrac / uGrid;',
    '    vec2 srcImg = tileMinImg + frac * (tileMaxImg - tileMinImg);',
    // Seam rule: clamp inside the source tile by half a video texel so
    // LINEAR sampling never bleeds into the neighboring source tile of the
    // scrambled frame (see the SEAM RULE comment above this shader).
    '    srcImg.x = clamp(srcImg.x, tileMinImg.x + uHalfTexel.x, tileMaxImg.x - uHalfTexel.x);',
    '    srcImg.y = clamp(srcImg.y, tileMinImg.y + uHalfTexel.y, tileMaxImg.y - uHalfTexel.y);',
    '    vec2 srcTex = vec2(srcImg.x, 1.0 - srcImg.y);',
    '    color = texture2D(uVideo, srcTex).rgb;',
    '  }',
    '  gl_FragColor = vec4(color, 1.0);',
    '}',
  ].join('\n');

  function compileShader(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error('shader compile failed: ' + log);
    }
    return sh;
  }

  function linkGLProgram(gl, vsSrc, fsSrc) {
    const vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc);
    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    // Shaders are flagged for delete-on-detach; the program keeps them
    // alive until deleteProgram, so this doesn't affect linking/use.
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error('program link failed: ' + log);
    }
    return program;
  }

  function tryCreateWebglContext(canvas) {
    const opts = { alpha: false, antialias: false, preserveDrawingBuffer: false };
    try {
      return canvas.getContext('webgl', opts) || canvas.getContext('experimental-webgl', opts);
    } catch (e) {
      return null;
    }
  }

  // Builds (or, after a context-loss restore, rebuilds) the whole GL
  // pipeline on an already-obtained context: program, fullscreen-triangle
  // buffer, both textures, uniform locations. Returns false (and leaves no
  // partially-built state referenced by `state`) on any compile/link
  // failure, which the caller treats as "fall back to 2D".
  function setupGLPipeline(gl, canvas) {
    try {
      const program = linkGLProgram(gl, GL_VERTEX_SRC, GL_FRAGMENT_SRC);
      gl.useProgram(program);

      const vertexBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
      // Fullscreen triangle (covers clip space with one triangle instead of
      // two, no diagonal seam to worry about): (-1,-1), (3,-1), (-1,3).
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      const aPos = gl.getAttribLocation(program, 'aPos');
      gl.enableVertexAttribArray(aPos);
      gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

      const videoTexture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, videoTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

      const permTexture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, permTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

      // Both textures flipped identically — see the ORIENTATION note above.
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      gl.clearColor(0, 0, 0, 1);

      state.gl = gl;
      state.glCanvasRef = canvas;
      state.glProgram = program;
      state.glVertexBuffer = vertexBuffer;
      state.glVideoTexture = videoTexture;
      state.glPermTexture = permTexture;
      state.glUniforms = {
        uVideo: gl.getUniformLocation(program, 'uVideo'),
        uPerm: gl.getUniformLocation(program, 'uPerm'),
        uGrid: gl.getUniformLocation(program, 'uGrid'),
        uUsedFrac: gl.getUniformLocation(program, 'uUsedFrac'),
        uHalfTexel: gl.getUniformLocation(program, 'uHalfTexel'),
      };
      gl.uniform1i(state.glUniforms.uVideo, 0); // texture unit 0
      gl.uniform1i(state.glUniforms.uPerm, 1);  // texture unit 1
      state.glLoseContextExt = gl.getExtension('WEBGL_lose_context');
      state.glPermCacheSeed = null; // force a perm-texture (re)upload on the next render
      state.glPermCacheGrid = null;
      state.glFirstUploadDone = false; // re-verify the CORS/taint upload check after any rebuild
      state.glContextLost = false;
      return true;
    } catch (e) {
      console.warn('[wtv-descramble] WebGL setup failed, falling back to 2D canvas: ' + (e && e.message));
      return false;
    }
  }

  // Releases every GL resource this script owns and detaches the
  // context-loss listeners. Safe to call when renderer !== 'webgl' (no-op).
  // Called from teardown() and from switchToCanvas2D() (before replacing
  // the canvas element for the 2D fallback).
  function releaseGLResources() {
    const gl = state.gl;
    if (state.glCanvasRef) {
      state.glCanvasRef.removeEventListener('webglcontextlost', onGLContextLost, false);
      state.glCanvasRef.removeEventListener('webglcontextrestored', onGLContextRestored, false);
    }
    if (gl) {
      try {
        if (state.glProgram) gl.deleteProgram(state.glProgram);
        if (state.glVideoTexture) gl.deleteTexture(state.glVideoTexture);
        if (state.glPermTexture) gl.deleteTexture(state.glPermTexture);
        if (state.glVertexBuffer) gl.deleteBuffer(state.glVertexBuffer);
      } catch (e) {
        /* context may already be lost/gone — deletes on a lost context are no-ops anyway */
      }
      if (state.glLoseContextExt) {
        try {
          state.glLoseContextExt.loseContext();
        } catch (e) {}
      }
    }
    state.gl = null;
    state.glCanvasRef = null;
    state.glProgram = null;
    state.glVertexBuffer = null;
    state.glVideoTexture = null;
    state.glPermTexture = null;
    state.glUniforms = null;
    state.glLoseContextExt = null;
    state.glPermCacheSeed = null;
    state.glPermCacheGrid = null;
    state.glFirstUploadDone = false;
    state.glContextLost = false;
  }

  // Context loss: preventDefault so the browser gives us a chance to
  // restore instead of permanently killing the context, then just stop
  // rendering (the rVFC/rAF loop keeps scheduling — see frame() below —
  // it just skips the GL draw call) until webglcontextrestored fires.
  function onGLContextLost(e) {
    e.preventDefault();
    state.glContextLost = true;
    console.warn('[wtv-descramble] WebGL context lost; pausing WebGL rendering until restored');
  }

  // Context restored: rebuild every GL resource on the (same) context. If
  // that rebuild itself fails, fall back to 2D for the rest of the session.
  function onGLContextRestored() {
    console.warn('[wtv-descramble] WebGL context restored; rebuilding GL state');
    const gl = state.gl;
    const canvas = state.canvas;
    if (!gl || !canvas || !setupGLPipeline(gl, canvas)) {
      webglFailedThisSession = true;
      switchToCanvas2D('WebGL context restore failed');
      return;
    }
    syncWebglBackingSize(); // re-establish the viewport now that resources exist again
  }

  // Mid-session permanent fallback to the 2D renderer (first-frame upload
  // failure, context-loss restore failure, or an incompatible key needing
  // the 2D-only banner). Replaces the canvas element entirely rather than
  // reusing it, because a canvas's context type (webgl vs 2d) is locked in
  // permanently by whichever getContext() call succeeds on it first — see
  // the comment in attach() for the same reasoning on first setup.
  function switchToCanvas2D(reason) {
    if (state.renderer === '2d' || !state.canvas) return;
    console.warn('[wtv-descramble] Falling back to 2D canvas renderer: ' + reason);
    const oldCanvas = state.canvas;
    releaseGLResources();
    const newCanvas = createOverlayCanvasElement();
    newCanvas.style.cssText = oldCanvas.style.cssText;
    newCanvas.style.opacity = '0'; // re-reveal via revealOnce() once a real frame lands, avoid a stale-frame flash
    if (oldCanvas.parentNode) {
      oldCanvas.parentNode.replaceChild(newCanvas, oldCanvas);
    }
    state.canvas = newCanvas;
    state.ctx = newCanvas.getContext('2d', { alpha: false });
    state.renderer = '2d';
    state.rendererFallbackReason = reason;
    state.revealed = false;
    resetPerfState(); // P3 render-cost stats from the old renderer aren't meaningful for the new one
    syncCanvasLayout();
  }

  // Wraps the FIRST per-session texImage2D upload in try/catch + a
  // gl.getError() check (w.tv plays via MSE — an IVS wasm worker appending
  // to SourceBuffers — so the video element SHOULD be clean for
  // texImage2D despite the media being fetched cross-origin, but this
  // verifies that at runtime rather than assuming it). On SecurityError or
  // any GL error, permanently falls back to 2D for the session. Every
  // upload after the first verified-good one skips the try/catch — it's
  // pure per-frame overhead once we already know uploads are safe.
  function uploadVideoFrame(gl, video) {
    gl.bindTexture(gl.TEXTURE_2D, state.glVideoTexture);
    if (!state.glFirstUploadDone) {
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
        const err = gl.getError();
        if (err !== gl.NO_ERROR) {
          throw new Error('gl.getError() = ' + err);
        }
        state.glFirstUploadDone = true;
      } catch (e) {
        webglFailedThisSession = true;
        switchToCanvas2D('first WebGL texture upload failed (' + ((e && (e.name || e.message)) || e) + ')');
        return false;
      }
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
    }
    return true;
  }

  // Rebuilds the grid x grid perm lookup texture — see the PERM LOOKUP
  // TEXTURE note above. Only called when state.glPermCacheSeed/Grid no
  // longer matches (seed, grid); the resulting Uint8Array allocation is therefore
  // NOT a per-frame cost.
  function uploadPermTexture(gl, seed, grid) {
    const { perm } = getPermutation(seed, grid); // same JS perm array the 2D path uses — see contract.md
    const n = grid * grid;
    const data = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
      const idx = perm[i];
      data[i * 4] = idx & 0xff;         // R = low byte
      data[i * 4 + 1] = (idx >> 8) & 0xff; // G = high byte (index = R + G*256)
      data[i * 4 + 2] = 0;
      data[i * 4 + 3] = 255;
    }
    gl.bindTexture(gl.TEXTURE_2D, state.glPermTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, grid, grid, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  }

  function renderFrameGL(video, canvas) {
    const gl = state.gl;
    if (!gl) return;

    if (!uploadVideoFrame(gl, video)) return; // switched to 2D — this callback's render is skipped, next one uses it

    const grid = effectiveGrid();
    const vw = video.videoWidth;
    const vh = video.videoHeight;

    // Compared as two numeric fields rather than a composite string key so
    // this check allocates nothing in the steady-state (no-change) case.
    const seed = KEY.seed >>> 0;
    if (state.glPermCacheSeed !== seed || state.glPermCacheGrid !== grid) {
      uploadPermTexture(gl, seed, grid);
      state.glPermCacheSeed = seed;
      state.glPermCacheGrid = grid;
    }

    // Border/seam math in SOURCE (video) texture space — see the BORDER
    // MATH note above (this also transparently covers the "grid finer than
    // this resolution" case via usedFrac collapsing to 0).
    const tileW = Math.floor(vw / grid);
    const tileH = Math.floor(vh / grid);
    const usedFracX = tileW > 0 ? (tileW * grid) / vw : 0;
    const usedFracY = tileH > 0 ? (tileH * grid) / vh : 0;

    gl.useProgram(state.glProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, state.glVideoTexture);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, state.glPermTexture);

    gl.uniform1f(state.glUniforms.uGrid, grid);
    gl.uniform2f(state.glUniforms.uUsedFrac, usedFracX, usedFracY);
    gl.uniform2f(state.glUniforms.uHalfTexel, 0.5 / vw, 0.5 / vh);

    gl.drawArrays(gl.TRIANGLES, 0, 3);

    revealOnce();
  }

  // =========================================================================
  // Performance mode (P3): automatic frame-skip with hysteresis, on top of
  // the manual resolution cap already applied in syncWebglBackingSize (P2).
  //
  // A fixed-size rolling window of the last PERF_WINDOW render costs (both
  // renderers — recordRenderCost is called from frame() regardless of which
  // one ran) feeds a p95/avg computed via a preallocated scratch array (no
  // per-frame allocation: Float32Array#set/#sort both operate in place).
  // Hysteresis comes from using two different thresholds (engage above
  // 12ms, disengage below 6ms) rather than one, so a render cost hovering
  // around a single number can't flap the mode on/off every window.
  //
  // This ring buffer is baseline, always-on cost — P3 needs it regardless
  // of whether Debug stats (P4) is on — but it's O(1) per frame (a
  // performance.now() call plus one array write) and allocation-free in
  // steady state, so that's an acceptable fixed cost per the spec for this
  // release.
  //
  // P5 AUTO-ESCALATION: this same "p95 > 12ms sustained" engagement point is
  // also where the "auto" renderer policy escalates from 2D to WebGL — see
  // updateSkipEngagement below. When rendererPref is "auto", the current
  // renderer is still '2d', and this session hasn't escalated yet, hitting
  // this threshold means attach(state.video) (which will now pick WebGL —
  // see the P5 policy note in attach() above) INSTEAD of engaging
  // frame-skip. state.autoEscalated is set to true synchronously before
  // that re-attach, so this can fire at most once per page session; if
  // overload recurs afterward (now running WebGL, or in a forced
  // "webgl"/"2d" mode where this branch never applies), frame-skip engages
  // exactly as it always has. teardown() (called from inside attach())
  // calls resetPerfState(), so the freshly-attached renderer gets a clean
  // cost window rather than inheriting the old renderer's numbers.
  // =========================================================================
  const PERF_WINDOW = 60;
  const perfWindow = new Float32Array(PERF_WINDOW);
  const perfScratch = new Float32Array(PERF_WINDOW);
  let perfWindowIndex = 0;
  let perfWindowFilled = 0;
  let skipEngaged = false;
  let skipFrameToggle = false;

  function resetPerfState() {
    perfWindowIndex = 0;
    perfWindowFilled = 0;
    skipEngaged = false;
    skipFrameToggle = false;
  }

  function recordRenderCost(ms) {
    perfWindow[perfWindowIndex] = ms;
    perfWindowIndex = (perfWindowIndex + 1) % PERF_WINDOW;
    if (perfWindowFilled < PERF_WINDOW) perfWindowFilled++;
  }

  // Only meaningful once the window is fully populated (perfWindowFilled
  // === PERF_WINDOW) — callers check that before using the result.
  function computeRenderCostStats() {
    perfScratch.set(perfWindow); // in-place copy, no allocation
    perfScratch.sort();          // TypedArray#sort is numeric by default, in place, no allocation
    let sum = 0;
    for (let i = 0; i < PERF_WINDOW; i++) sum += perfScratch[i];
    const avg = sum / PERF_WINDOW;
    const p95 = perfScratch[Math.floor(PERF_WINDOW * 0.95)];
    return { avg, p95 };
  }

  function updateSkipEngagement() {
    const { p95 } = computeRenderCostStats();
    if (!skipEngaged && p95 > 12) {
      // P5 auto-escalation takes priority over frame-skip at this exact
      // trigger point — see the AUTO-ESCALATION note above. state.video is
      // always set here (frame() only reaches this call with a live
      // video/canvas pair), but the check is kept for defensiveness; the
      // state.autoEscalated write happens BEFORE attach() is called, so a
      // second call into this function (there isn't one — it's re-entrant
      // only in the sense that attach()->teardown()->resetPerfState() zeros
      // perfWindowFilled, which gates the NEXT call to this function from
      // even happening until a fresh window fills on the new renderer)
      // cannot re-trigger the same escalation.
      if (rendererPref === 'auto' && state.renderer === '2d' && !state.autoEscalated && !webglFailedThisSession && state.video) {
        state.autoEscalated = true;
        console.info(
          '[wtv-descramble] auto renderer: escalating 2D -> WebGL, p95 render cost ' +
            p95.toFixed(2) + 'ms > 12ms sustained on 2D'
        );
        attach(state.video); // re-attach picks WebGL now that autoEscalated is set (see attach()'s P5 policy note)
        return;
      }
      skipEngaged = true;
      skipFrameToggle = false;
      console.info('[wtv-descramble] frame-skip engaged: p95 render cost ' + p95.toFixed(2) + 'ms > 12ms');
    } else if (skipEngaged && p95 < 6) {
      skipEngaged = false;
      console.info('[wtv-descramble] frame-skip disengaged: p95 render cost ' + p95.toFixed(2) + 'ms < 6ms');
    }
  }

  // =========================================================================
  // Debug instrumentation (P4): opt-in stats overlay + console logging.
  // Every bit of this section's per-callback work lives behind the single
  // `if (debugStats)` check in frame() below — when the toggle is off, none
  // of debugOnCallback/refreshDebugOverlay ever runs, so there is zero
  // added work in the render callback beyond that one boolean read.
  // =========================================================================

  function createDebugOverlay() {
    if (state.debug) return;
    const el = document.createElement('div');
    el.id = 'wtv-descramble-debug';
    Object.assign(el.style, {
      position: 'fixed',
      top: '8px',
      left: '8px',
      zIndex: '2147483647',
      background: 'rgba(0,0,0,0.75)',
      color: '#7CFC9A',
      font: '11px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace',
      padding: '6px 9px',
      borderRadius: '4px',
      whiteSpace: 'pre',
      pointerEvents: 'none',
    });
    document.body.appendChild(el);
    state.debug = {
      el: el,
      lastCallbackTime: null,
      gapSum: 0,
      gapCount: 0,
      resSwitches: 0,
      longGaps: 0,
      lastW: null,
      lastH: null,
      lastOverlayUpdate: 0,
    };
  }

  function removeDebugOverlay() {
    if (state.debug && state.debug.el && state.debug.el.parentNode) {
      state.debug.el.parentNode.removeChild(state.debug.el);
    }
    state.debug = null;
  }

  function fmtStat(n) {
    return Number.isFinite(n) ? n.toFixed(2) : 'n/a';
  }

  // Called once per rVFC/rAF callback, only when debugStats is on. Tracks
  // inter-callback gaps (and logs the ones that confirm/kill the
  // ABR-freeze theory: a >250ms gap), tracks resolution switches (and logs
  // each one with a timestamp), and throttles the actual overlay DOM update
  // to at most 2x/second regardless of callback rate.
  function debugOnCallback(video, now) {
    const d = state.debug;
    if (!d) return;

    if (d.lastCallbackTime != null) {
      const gap = now - d.lastCallbackTime;
      d.gapCount++;
      d.gapSum += gap;
      if (gap > 250) {
        d.longGaps++;
        console.info('[wtv-descramble] long rVFC/rAF gap: ' + gap.toFixed(1) + 'ms');
      }
    }
    d.lastCallbackTime = now;

    const w = video.videoWidth;
    const h = video.videoHeight;
    if (d.lastW != null && (w !== d.lastW || h !== d.lastH)) {
      d.resSwitches++;
      console.info(
        '[wtv-descramble] resolution switch @ ' + new Date().toISOString() + ': ' +
          d.lastW + 'x' + d.lastH + ' -> ' + w + 'x' + h
      );
    }
    d.lastW = w;
    d.lastH = h;

    if (now - d.lastOverlayUpdate >= 500) {
      d.lastOverlayUpdate = now;
      refreshDebugOverlay(video);
    }
  }

  // P5 — the two routine "why 2D, not a real failure" reasons attach() sets
  // (see its P5 policy note) are already fully conveyed by the (auto)/
  // (forced) tag rendererModeLabel() below adds, so they're skipped here to
  // avoid a redundant line; a GENUINE fallback reason (shader compile
  // failure, WebGL unavailable, a failed texture upload, a failed context
  // restore — the pre-existing P1 ladder reasons) still prints as before.
  const RENDERER_POLICY_REASONS = new Set([
    'renderer preference: 2d',
    'auto: 2D-first, escalates under sustained load',
  ]);

  function rendererModeLabel() {
    if (rendererPref === 'webgl' || rendererPref === '2d') return 'forced';
    return state.autoEscalated ? 'auto, escalated' : 'auto';
  }

  function refreshDebugOverlay(video) {
    const d = state.debug;
    if (!d || !d.el) return;

    const stats = perfWindowFilled >= PERF_WINDOW ? computeRenderCostStats() : { avg: NaN, p95: NaN };
    const gapAvg = d.gapCount > 0 ? d.gapSum / d.gapCount : NaN;
    let quality = null;
    try {
      if (typeof video.getVideoPlaybackQuality === 'function') quality = video.getVideoPlaybackQuality();
    } catch (e) {}

    const showFallbackReason =
      state.rendererFallbackReason && !RENDERER_POLICY_REASONS.has(state.rendererFallbackReason);
    const rendererLine =
      'renderer: ' + state.renderer + ' (' + rendererModeLabel() + ')' +
      (showFallbackReason ? ' (fallback: ' + state.rendererFallbackReason + ')' : '');

    const lines = [
      'wtv-descramble debug',
      rendererLine,
      'render ms: avg ' + fmtStat(stats.avg) + ' / p95 ' + fmtStat(stats.p95),
      'rVFC/rAF gap avg: ' + fmtStat(gapAvg) + 'ms',
      quality
        ? 'dropped/total frames: ' + quality.droppedVideoFrames + '/' + quality.totalVideoFrames
        : 'dropped/total frames: n/a',
      'video: ' + video.videoWidth + 'x' + video.videoHeight,
      'canvas backing: ' + (state.canvas ? state.canvas.width + 'x' + state.canvas.height : 'n/a'),
      'resolution switches: ' + d.resSwitches,
      'long gaps (>250ms): ' + d.longGaps,
      'frame-skip: ' + (skipEngaged ? 'ENGAGED (every other frame)' : 'off'),
      'perf mode: ' + (perfMode ? 'on' : 'off'),
    ];
    d.el.textContent = lines.join('\n');
  }

  // Prefer requestVideoFrameCallback (rVFC) over requestAnimationFrame: rVFC
  // fires once per actual newly-decoded video frame (~the stream's real
  // frame rate, typically 30-60fps), while rAF fires once per *display*
  // refresh (120/144/240Hz on modern monitors) — on a high-refresh-rate
  // screen, plain rAF would redraw 2-4x more often than the video actually
  // has new pixels to show. Falls back to rAF on browsers without rVFC.
  function scheduleNextFrame(video, frame) {
    if (typeof video.requestVideoFrameCallback === 'function') {
      state.frameCallbackKind = 'rvfc';
      state.frameCallbackId = video.requestVideoFrameCallback(frame);
    } else {
      state.frameCallbackKind = 'raf';
      state.frameCallbackId = requestAnimationFrame(frame);
    }
  }

  function startLoop() {
    const video = state.video;
    if (!video) return;

    function frame() {
      // Re-fetch state.video each tick rather than closing over the outer
      // `video` — attach()/teardown() may have swapped it out from under an
      // in-flight callback.
      const currentVideo = state.video;
      const canvas = state.canvas;
      if (!currentVideo || !canvas) return;
      scheduleNextFrame(currentVideo, frame);

      if (!currentVideo.isConnected) {
        // SPA navigation tore down the player. Stop drawing stale frames and
        // let the observers below find/attach the replacement.
        teardown();
        scanForVideo();
        return;
      }

      if (currentVideo.readyState < 2 || !currentVideo.videoWidth || !currentVideo.videoHeight) {
        return; // no decoded frame available yet — wait, don't force play()
      }

      // P4 — single boolean check gates ALL debug sampling/logging/overlay
      // work; zero added cost in this callback when debugStats is off.
      if (debugStats) {
        debugOnCallback(currentVideo, performance.now());
      }

      if (!checkVersionAndWarn()) {
        // renderIncompatibleBanner needs a 2D context, which a WebGL-bound
        // canvas can never provide (see switchToCanvas2D) — a bad key
        // version is rare/edge-case enough that paying a one-time fallback
        // here rather than adding GL-shader text rendering is the right
        // trade per the locked "minimal shader surface" design decision.
        if (state.renderer === 'webgl') {
          switchToCanvas2D('key version incompatible (banner needs a 2D canvas)');
        }
        if (state.ctx) renderIncompatibleBanner(state.video, state.canvas);
        return;
      }

      // P3 — once engaged, render every OTHER callback; still reschedule
      // every callback above so the loop's own cadence never changes, only
      // the render work is skipped.
      if (skipEngaged) {
        skipFrameToggle = !skipFrameToggle;
        if (skipFrameToggle) return;
      }

      if (state.renderer === 'webgl' && state.glContextLost) {
        return; // GL unusable until webglcontextrestored fires — see onGLContextLost
      }

      const t0 = performance.now();
      if (state.renderer === 'webgl') {
        renderFrameGL(currentVideo, state.canvas);
      } else {
        renderFrame2D(currentVideo, state.canvas);
      }
      recordRenderCost(performance.now() - t0);
      // updateSkipEngagement() may itself call attach() (P5 auto-escalation
      // — see its comment) from right here, inside this callback. That's
      // safe specifically because this is the LAST statement in frame(): by
      // the time attach()->teardown() cancels the callback scheduleNextFrame
      // registered at the top of this same invocation and starts a fresh
      // loop, there is nothing left in this stack frame to run afterward —
      // same reasoning as the disconnected-video teardown()+scanForVideo()
      // case above.
      if (perfWindowFilled >= PERF_WINDOW) updateSkipEngagement();
    }
    scheduleNextFrame(video, frame);
  }

  // =========================================================================
  // SPA navigation / player (re)detection
  //
  // w.tv is a Nuxt.js SPA: route changes happen via the History API without
  // a full page reload, and the player component (<video> included) can be
  // destroyed and recreated. We detect a new/changed video via a
  // MutationObserver on <html>/<body> PLUS hooks on
  // history.pushState/replaceState and a popstate listener, all coalesced
  // through one small debounce timer so a burst of DOM mutations only
  // triggers one rescan.
  // =========================================================================

  function scanForVideo() {
    // The control panel itself must stay visible/reachable regardless of the
    // enabled state — it's the only way to turn descrambling back on.
    ensureControlPanel();

    if (!enabled) {
      // OFF: release the video completely (no leftover hidden opacity, no
      // leftover rAF/rVFC loop, no leftover canvas) and stop scanning/
      // attaching until re-enabled. teardown() restores the raw <video>'s
      // opacity/filter/transform, so native player controls behave normally.
      if (state.video) teardown();
      return;
    }

    const video = findVideo();
    if (!video) {
      if (state.video) teardown();
      return;
    }
    // Covers two distinct SPA cases: (a) a genuinely different <video>
    // element (new/changed or the old one detached), and (b) the SAME
    // <video> node silently moved to a new parent (e.g. a theater-mode
    // layout toggle) — neither `video !== state.video` nor
    // `!video.isConnected` catches (b), since the node itself is unchanged
    // and still connected, just relocated; without this the overlay canvas
    // would be left behind in the old, now-wrong location.
    const parentChanged = video === state.video && video.parentElement !== state.videoParentAtAttach;
    if (video !== state.video || !video.isConnected || parentChanged) {
      attach(video);
    }
  }

  // Central place to flip the master ON/OFF switch: persists the choice and
  // immediately re-syncs reality to it (teardown when going OFF, re-scan/
  // re-attach when going back ON) via the same scanForVideo() codepath the
  // MutationObserver/history hooks use.
  function setEnabled(next) {
    enabled = next;
    persistEnabled();
    scanForVideo();
  }

  // P3 — re-syncs the WebGL backing size (if attached) so the resolution
  // cap takes effect immediately rather than waiting for the next
  // layout-driven event.
  function setPerfMode(next) {
    perfMode = next;
    persistBool(STORAGE_KEY_PERFMODE, next);
    syncCanvasLayout();
  }

  // P5 — re-attaches immediately so a manually forced "webgl"/"2d" choice
  // (or a switch back to "auto") takes effect on the live video right away
  // instead of waiting for the next SPA navigation/rescan. Deliberately does
  // NOT touch state.autoEscalated — that flag tracks this session's actual
  // overload history, independent of which policy is currently selected.
  function setRendererPref(next) {
    rendererPref = next;
    persistRenderer(next);
    if (state.video) attach(state.video);
  }

  // P4 — creates/destroys the overlay immediately when toggled mid-session;
  // attach()/teardown() also create/destroy it across SPA re-attaches so it
  // survives navigation while the toggle stays on.
  function setDebugStats(next) {
    debugStats = next;
    persistBool(STORAGE_KEY_DEBUG, next);
    if (next) {
      if (state.video && state.canvas) createDebugOverlay();
    } else {
      removeDebugOverlay();
    }
  }

  let scanTimer = null;
  function scheduleScan() {
    if (scanTimer != null) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scanForVideo();
    }, 50);
  }

  function installNavigationHooks() {
    const observer = new MutationObserver(scheduleScan);
    observer.observe(document.documentElement, { childList: true, subtree: true });

    const wrapHistoryMethod = (methodName) => {
      const original = history[methodName];
      history[methodName] = function (...args) {
        const ret = original.apply(this, args);
        scheduleScan();
        return ret;
      };
    };
    wrapHistoryMethod('pushState');
    wrapHistoryMethod('replaceState');
    window.addEventListener('popstate', scheduleScan);
    window.addEventListener('hashchange', scheduleScan);

    window.addEventListener('resize', syncCanvasLayout);
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    // Safari < 16.4 fires the prefixed event instead of the standard one.
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
  }

  // =========================================================================
  // Control panel — small, fixed-position, collapsible, built with inline
  // styles only (no injected <style> block / no GM_addStyle) so it can't
  // collide with the host page's CSS. Edits write straight into the mutable
  // KEY object the render loop reads every frame, and persist to
  // localStorage so they survive reloads/navigations.
  // =========================================================================

  function ensureControlPanel() {
    if (document.getElementById('wtv-descramble-panel')) return;
    buildControlPanel();
  }

  function buildControlPanel() {
    const panel = document.createElement('div');
    panel.id = 'wtv-descramble-panel';
    Object.assign(panel.style, {
      position: 'fixed',
      bottom: '12px',
      right: '12px',
      zIndex: '2147483647',
      background: 'rgba(18,18,22,0.92)',
      color: '#eaeaea',
      font: '12px/1.4 system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
      borderRadius: '8px',
      boxShadow: '0 2px 12px rgba(0,0,0,0.55)',
      width: '260px',
      userSelect: 'none',
      overflow: 'hidden',
    });

    const header = document.createElement('div');
    Object.assign(header.style, {
      padding: '7px 10px',
      cursor: 'pointer',
      fontWeight: '600',
      borderBottom: '1px solid rgba(255,255,255,0.15)',
      display: 'flex',
      justifyContent: 'space-between',
    });

    const body = document.createElement('div');
    Object.assign(body.style, {
      padding: '8px 10px',
      display: 'flex',
      flexDirection: 'column',
      gap: '6px',
    });

    let collapsed = localStorage.getItem(STORAGE_KEY_PANEL_COLLAPSED) === '1';
    function applyCollapsed() {
      body.style.display = collapsed ? 'none' : 'flex';
      header.textContent = '';
      const title = document.createElement('span');
      title.textContent = 'wtv-descramble';
      const caret = document.createElement('span');
      caret.textContent = collapsed ? '▸' : '▾';
      header.appendChild(title);
      header.appendChild(caret);
    }
    applyCollapsed();
    header.addEventListener('click', () => {
      collapsed = !collapsed;
      try {
        localStorage.setItem(STORAGE_KEY_PANEL_COLLAPSED, collapsed ? '1' : '0');
      } catch (e) {}
      applyCollapsed();
    });

    function row(labelText, inputEl) {
      const r = document.createElement('label');
      Object.assign(r.style, {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '8px',
        cursor: 'pointer',
      });
      const span = document.createElement('span');
      span.textContent = labelText;
      r.appendChild(span);
      r.appendChild(inputEl);
      return r;
    }

    // -----------------------------------------------------------------
    // 1. Master ON/OFF toggle — first thing in the panel body, prominent
    //    (bold label + colored background) and persisted. Turning it off
    //    tears down the overlay entirely (see setEnabled/scanForVideo)
    //    while leaving this panel itself visible so it can be flipped back.
    // -----------------------------------------------------------------
    const enabledRow = document.createElement('div');
    Object.assign(enabledRow.style, {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '8px',
      padding: '6px 8px',
      borderRadius: '5px',
      cursor: 'pointer',
    });
    const enabledLabel = document.createElement('span');
    Object.assign(enabledLabel.style, { fontWeight: '700', fontSize: '13px' });
    const enabledCb = document.createElement('input');
    enabledCb.type = 'checkbox';
    Object.assign(enabledCb.style, { width: '32px', height: '18px', cursor: 'pointer' });

    function applyEnabledUi() {
      enabledCb.checked = enabled;
      enabledLabel.textContent = enabled ? 'Descrambler: ON' : 'Descrambler: OFF';
      enabledRow.style.background = enabled ? 'rgba(46,160,67,0.28)' : 'rgba(180,40,40,0.28)';
      enabledLabel.style.color = enabled ? '#8CFCA6' : '#FF9A9A';
    }
    applyEnabledUi();
    enabledCb.addEventListener('click', (e) => e.stopPropagation());
    enabledCb.addEventListener('change', () => {
      setEnabled(enabledCb.checked);
      applyEnabledUi();
    });
    enabledRow.addEventListener('click', (e) => {
      if (e.target === enabledCb) return; // avoid double-toggling
      setEnabled(!enabled);
      applyEnabledUi();
    });

    enabledRow.appendChild(enabledLabel);
    enabledRow.appendChild(enabledCb);

    // -----------------------------------------------------------------
    // 2. Master string field — parseMasterString/encodeMasterString are
    //    ported verbatim above from SPEC/reference.mjs (see contract.md).
    //    Applying a valid string sets seed/grid/all four flags at once;
    //    an invalid one is rejected loudly and KEY is left untouched.
    // -----------------------------------------------------------------
    const masterLabel = document.createElement('div');
    masterLabel.textContent = 'Master string';
    Object.assign(masterLabel.style, { fontWeight: '600', marginTop: '2px' });

    const masterRow = document.createElement('div');
    Object.assign(masterRow.style, { display: 'flex', gap: '4px' });

    const masterInput = document.createElement('input');
    masterInput.type = 'text';
    masterInput.spellcheck = false;
    masterInput.autocomplete = 'off';
    masterInput.placeholder = 'WTV1-1337-9-HIP';
    Object.assign(masterInput.style, {
      flex: '1',
      minWidth: '0',
      font: '12px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace',
      padding: '3px 5px',
      boxSizing: 'border-box',
    });

    const applyBtn = document.createElement('button');
    applyBtn.type = 'button';
    applyBtn.textContent = 'Apply';
    Object.assign(applyBtn.style, {
      cursor: 'pointer',
      background: '#2b6fd6',
      color: '#fff',
      border: '1px solid rgba(255,255,255,0.2)',
      borderRadius: '4px',
      padding: '3px 8px',
      flex: '0 0 auto',
    });

    const masterFeedback = document.createElement('div');
    Object.assign(masterFeedback.style, { fontSize: '11px', minHeight: '13px' });

    const currentRow = document.createElement('div');
    Object.assign(currentRow.style, { display: 'flex', gap: '4px', alignItems: 'center' });
    const currentLabel = document.createElement('span');
    currentLabel.textContent = 'Current:';
    Object.assign(currentLabel.style, { opacity: '0.7', flex: '0 0 auto', fontSize: '11px' });
    const currentDisplay = document.createElement('input');
    currentDisplay.type = 'text';
    currentDisplay.readOnly = true;
    Object.assign(currentDisplay.style, {
      flex: '1',
      minWidth: '0',
      font: '11px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace',
      padding: '3px 5px',
      boxSizing: 'border-box',
      background: 'rgba(255,255,255,0.06)',
      color: '#cfe8ff',
      border: '1px solid rgba(255,255,255,0.15)',
      borderRadius: '3px',
    });
    currentDisplay.addEventListener('focus', () => currentDisplay.select());
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.textContent = 'Copy';
    Object.assign(copyBtn.style, {
      cursor: 'pointer',
      background: '#333',
      color: '#eee',
      border: '1px solid rgba(255,255,255,0.2)',
      borderRadius: '4px',
      padding: '3px 8px',
      flex: '0 0 auto',
    });

    let copyFeedbackTimer = null;
    function showCopyFeedback(ok) {
      copyBtn.textContent = ok ? 'Copied!' : 'Copy failed';
      if (copyFeedbackTimer) clearTimeout(copyFeedbackTimer);
      copyFeedbackTimer = setTimeout(() => {
        copyBtn.textContent = 'Copy';
      }, 1500);
    }
    copyBtn.addEventListener('click', () => {
      currentDisplay.select();
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(currentDisplay.value).then(
          () => showCopyFeedback(true),
          () => {
            let ok = false;
            try {
              ok = document.execCommand('copy');
            } catch (e) {}
            showCopyFeedback(ok);
          }
        );
        return;
      }
      let ok = false;
      try {
        ok = document.execCommand('copy');
      } catch (e) {}
      showCopyFeedback(ok);
    });

    // Read-only mirror of KEY, always kept in sync (master-string apply,
    // advanced-control edits, and reset all refresh this) so a viewer can
    // confirm exactly what's currently active/what they just applied.
    function refreshMasterStringDisplay() {
      let str;
      try {
        str = encodeMasterString(KEY);
      } catch (e) {
        str = `(unavailable: ${e.message})`;
      }
      currentDisplay.value = str;
    }

    let masterFeedbackTimer = null;
    function showMasterFeedback(text, isError) {
      masterFeedback.textContent = text;
      masterFeedback.style.color = isError ? '#ff8080' : '#7CFC9A';
      if (masterFeedbackTimer) clearTimeout(masterFeedbackTimer);
      if (!isError) {
        masterFeedbackTimer = setTimeout(() => {
          masterFeedback.textContent = '';
        }, 2500);
      }
    }

    function applyMasterStringInput() {
      let parsed;
      try {
        parsed = parseMasterString(masterInput.value);
      } catch (e) {
        showMasterFeedback(e.message, true);
        return; // KEY left untouched, per contract.md parse rules
      }
      KEY.seed = parsed.seed;
      KEY.grid = parsed.grid;
      KEY.flipH = parsed.flipH;
      KEY.flipV = parsed.flipV;
      KEY.invert = parsed.invert;
      KEY.blockPermute = parsed.blockPermute;
      KEY.version = parsed.version;
      persistKey();
      refreshAdvancedFromKey();
      refreshMasterStringDisplay();
      applyKeyChange();
      showMasterFeedback('Applied', false);
    }
    applyBtn.addEventListener('click', applyMasterStringInput);
    masterInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        applyMasterStringInput();
      }
    });

    masterRow.appendChild(masterInput);
    masterRow.appendChild(applyBtn);
    currentRow.appendChild(currentLabel);
    currentRow.appendChild(currentDisplay);
    currentRow.appendChild(copyBtn);

    // -----------------------------------------------------------------
    // 3. Advanced section — every per-setting control, collapsed by
    //    default. Fully functional; each edit also persists, re-applies,
    //    and refreshes the master-string display above to match.
    // -----------------------------------------------------------------
    const advancedHeader = document.createElement('div');
    Object.assign(advancedHeader.style, {
      cursor: 'pointer',
      fontWeight: '600',
      marginTop: '4px',
      paddingTop: '6px',
      borderTop: '1px solid rgba(255,255,255,0.12)',
      display: 'flex',
      justifyContent: 'space-between',
    });
    const advancedBody = document.createElement('div');
    Object.assign(advancedBody.style, { flexDirection: 'column', gap: '6px', marginTop: '4px' });

    let advancedCollapsed = localStorage.getItem(STORAGE_KEY_ADVANCED_COLLAPSED) !== '0'; // collapsed by default
    function applyAdvancedCollapsed() {
      advancedBody.style.display = advancedCollapsed ? 'none' : 'flex';
      advancedHeader.textContent = '';
      const t = document.createElement('span');
      t.textContent = 'Advanced';
      const c = document.createElement('span');
      c.textContent = advancedCollapsed ? '▸' : '▾';
      advancedHeader.appendChild(t);
      advancedHeader.appendChild(c);
    }
    applyAdvancedCollapsed();
    advancedHeader.addEventListener('click', () => {
      advancedCollapsed = !advancedCollapsed;
      try {
        localStorage.setItem(STORAGE_KEY_ADVANCED_COLLAPSED, advancedCollapsed ? '1' : '0');
      } catch (e) {}
      applyAdvancedCollapsed();
    });

    const seedInput = document.createElement('input');
    seedInput.type = 'number';
    seedInput.step = '1';
    seedInput.value = String(KEY.seed);
    Object.assign(seedInput.style, { width: '92px' });
    seedInput.addEventListener('change', () => {
      const v = Number(seedInput.value);
      KEY.seed = Number.isFinite(v) ? v >>> 0 : KEY.seed;
      seedInput.value = String(KEY.seed);
      persistKey();
      refreshMasterStringDisplay();
      applyKeyChange();
    });

    const gridInput = document.createElement('input');
    gridInput.type = 'number';
    gridInput.min = '1';
    gridInput.max = String(MAX_GRID); // matches effectiveGrid()'s clamp (WebGL index-encoding limit)
    gridInput.step = '1';
    gridInput.value = String(KEY.grid);
    Object.assign(gridInput.style, { width: '92px' });
    gridInput.addEventListener('change', () => {
      const v = Math.round(Number(gridInput.value));
      KEY.grid = Number.isInteger(v) && v >= 1 ? v : KEY.grid;
      gridInput.value = String(KEY.grid);
      persistKey();
      refreshMasterStringDisplay();
      applyKeyChange();
    });

    function checkbox(field) {
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!KEY[field];
      cb.addEventListener('change', () => {
        KEY[field] = cb.checked;
        persistKey();
        refreshMasterStringDisplay();
        applyKeyChange();
      });
      return cb;
    }

    const flipHCb = checkbox('flipH');
    const flipVCb = checkbox('flipV');
    const invertCb = checkbox('invert');
    const permuteCb = checkbox('blockPermute');

    // -----------------------------------------------------------------
    // P3/P4/P5 — independent of KEY (not part of the scramble contract, not
    // touched by "Reset to default key"), so these use their own
    // localStorage keys/setters (setRendererPref/setPerfMode/setDebugStats)
    // rather than the `checkbox(field)` helper above.
    // -----------------------------------------------------------------
    const rendererSelect = document.createElement('select');
    Object.assign(rendererSelect.style, { cursor: 'pointer' });
    [
      ['auto', 'Auto'],
      ['webgl', 'WebGL'],
      ['2d', '2D'],
    ].forEach(([value, label]) => {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      rendererSelect.appendChild(opt);
    });
    rendererSelect.value = rendererPref;
    rendererSelect.addEventListener('change', () => setRendererPref(rendererSelect.value));

    const perfModeCb = document.createElement('input');
    perfModeCb.type = 'checkbox';
    perfModeCb.checked = perfMode;
    perfModeCb.addEventListener('change', () => setPerfMode(perfModeCb.checked));

    const debugStatsCb = document.createElement('input');
    debugStatsCb.type = 'checkbox';
    debugStatsCb.checked = debugStats;
    debugStatsCb.addEventListener('change', () => setDebugStats(debugStatsCb.checked));

    const versionLine = document.createElement('div');
    Object.assign(versionLine.style, { fontSize: '11px', opacity: '0.7', marginTop: '2px' });
    versionLine.textContent = `key.version ${KEY.version} · script v${CONTRACT_VERSION}`;

    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.textContent = 'Reset to default key';
    Object.assign(resetBtn.style, {
      marginTop: '4px',
      cursor: 'pointer',
      background: '#333',
      color: '#eee',
      border: '1px solid rgba(255,255,255,0.2)',
      borderRadius: '4px',
      padding: '4px 6px',
    });

    // Shared by both "Reset to default key" and a successful master-string
    // apply: pushes KEY's current values back into every advanced input so
    // they never drift out of sync with whichever path last changed KEY.
    function refreshAdvancedFromKey() {
      seedInput.value = String(KEY.seed);
      gridInput.value = String(KEY.grid);
      flipHCb.checked = KEY.flipH;
      flipVCb.checked = KEY.flipV;
      invertCb.checked = KEY.invert;
      permuteCb.checked = KEY.blockPermute;
      versionLine.textContent = `key.version ${KEY.version} · script v${CONTRACT_VERSION}`;
    }

    resetBtn.addEventListener('click', () => {
      Object.assign(KEY, DEFAULT_KEY);
      refreshAdvancedFromKey();
      refreshMasterStringDisplay();
      try {
        masterInput.value = encodeMasterString(KEY);
      } catch (e) {}
      persistKey();
      applyKeyChange();
    });

    advancedBody.appendChild(row('Seed', seedInput));
    advancedBody.appendChild(row('Grid', gridInput));
    advancedBody.appendChild(row('Flip H', flipHCb));
    advancedBody.appendChild(row('Flip V', flipVCb));
    advancedBody.appendChild(row('Invert', invertCb));
    advancedBody.appendChild(row('Block permute', permuteCb));
    advancedBody.appendChild(row('Renderer', rendererSelect));
    advancedBody.appendChild(row('Performance mode', perfModeCb));
    advancedBody.appendChild(row('Debug stats', debugStatsCb));
    advancedBody.appendChild(versionLine);
    advancedBody.appendChild(resetBtn);

    // Initial sync: pre-fill the editable master-string field and the
    // read-only "Current" mirror with whatever KEY resolved to at load.
    try {
      masterInput.value = encodeMasterString(KEY);
    } catch (e) {
      masterInput.value = '';
    }
    refreshMasterStringDisplay();

    body.appendChild(enabledRow);
    body.appendChild(masterLabel);
    body.appendChild(masterRow);
    body.appendChild(masterFeedback);
    body.appendChild(currentRow);
    body.appendChild(advancedHeader);
    body.appendChild(advancedBody);

    panel.appendChild(header);
    panel.appendChild(body);
    document.body.appendChild(panel);
  }

  // =========================================================================
  // Boot
  // =========================================================================

  function init() {
    installNavigationHooks();
    ensureControlPanel();
    scanForVideo();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
