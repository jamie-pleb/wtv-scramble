// ==UserScript==
// @name         w.tv Descrambler
// @namespace    https://github.com/jamie-pleb/wtv-scramble
// @version      1.2.1
// @description  Descrambles a live w.tv video stream in real time, undoing the matching OBS "scramble" filter using a shared key.
// @author       jamie-pleb
// @match        https://w.tv/*
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

  function effectiveGrid() {
    const g = Math.round(Number(KEY.grid));
    return Number.isFinite(g) && g >= 1 ? g : 9;
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
  // Player detection
  // =========================================================================

  // data-testid is far more stable across Nuxt/Vue builds than the hashed
  // class names or even the id, but keep #videoPlayer as a fallback in case
  // a future markup change drops the testid.
  const VIDEO_SELECTOR_PRIMARY = 'video[data-testid="stream-player-video"]';
  const VIDEO_SELECTOR_FALLBACK = '#videoPlayer';

  function findVideo() {
    return document.querySelector(VIDEO_SELECTOR_PRIMARY) || document.querySelector(VIDEO_SELECTOR_FALLBACK);
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
    ctx: null,
    frameCanvas: null, // offscreen scratch canvas holding the ONE per-frame
    frameCtx: null,    // video snapshot, used when blockPermute is on (see renderFrame)
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
    applyStaticCss(canvas); // invert/flip live on the canvas's own CSS, not the per-frame ctx state

    const parent = video.parentElement;
    if (!parent) {
      state.video = null;
      state.videoParentAtAttach = null;
      state.mode = null;
      return;
    }
    // Insert immediately after the video (not necessarily as the parent's
    // last child) so any control elements that come later in DOM order
    // still paint above the overlay per normal stacking rules.
    if (video.nextSibling) parent.insertBefore(canvas, video.nextSibling);
    else parent.appendChild(canvas);

    state.canvas = canvas;
    // CORS / canvas-tainting note: the IVS stream is cross-origin
    // (streams.w.tv / live-video.net vs the w.tv page origin). Drawing it
    // into this canvas taints the canvas for *reads* (getImageData /
    // toDataURL would throw SecurityError). That's expected and fine — this
    // script only ever WRITES via ctx.drawImage for on-screen display, it
    // never reads pixels back. Do NOT set video.crossOrigin (can break IVS's
    // MSE-based playback) and do NOT add getImageData/toDataURL here.
    state.ctx = canvas.getContext('2d', { alpha: false });

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

    startLoop();
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
  // Per-frame descramble
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
  // ONE-SNAPSHOT PIPELINE, AND WHY IT MATTERS:
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

  function renderFrame(video, canvas) {
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

      if (!checkVersionAndWarn()) {
        renderIncompatibleBanner(currentVideo, canvas);
        return;
      }

      renderFrame(currentVideo, canvas);
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
