// Canonical scramble/descramble reference implementation.
// Ground truth for obs-scramble (C++ port) and wtv-descramble.user.js
// (inlined copy — keep byte-identical, see contract.md). This file has
// zero dependencies and runs in Node or a browser <script type="module">.
//
// See ../SPEC/contract.md for the full spec, and in particular the section
// "Which array does which renderer use?" before touching blockPermute*.

export const CONTRACT_VERSION = 1;

export const DEFAULT_KEY = Object.freeze({
  seed: 1337,
  grid: 9,
  flipH: true,
  flipV: false,
  invert: true,
  blockPermute: true,
  version: CONTRACT_VERSION,
});

export function validateKey(key) {
  if (!key || typeof key !== "object") {
    throw new Error("scramble key must be an object");
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

// --- Master string ------------------------------------------------------
// Compact shareable key encoding: "WTV1-<seed>-<grid>-<flags>", e.g. the
// default key is "WTV1-1337-9-HIP". See contract.md "Master string" for the
// full grammar and parse-tolerance rules. The OBS plugin's C port and the
// userscript's inlined copy must both match these two functions exactly;
// test/master-strings.json holds golden fixtures both are checked against.

export function encodeMasterString(key) {
  validateKey(key);
  let flags = "";
  if (key.flipH) flags += "H";
  if (key.flipV) flags += "V";
  if (key.invert) flags += "I";
  if (key.blockPermute) flags += "P";
  if (flags === "") flags = "0";
  return `WTV${key.version}-${key.seed >>> 0}-${key.grid}-${flags}`;
}

export function parseMasterString(str) {
  if (typeof str !== "string") {
    throw new Error("master string must be a string");
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
  if (flagsRaw !== "" && flagsRaw !== "0") {
    for (const ch of flagsRaw) {
      if (ch === "H") key.flipH = true;
      else if (ch === "V") key.flipV = true;
      else if (ch === "I") key.invert = true;
      else if (ch === "P") key.blockPermute = true;
      else throw new Error(`unknown flag "${ch}" in master string (valid: H, V, I, P, or 0 for none)`);
    }
  }
  return key;
}

// --- PRNG -------------------------------------------------------------

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= (t + Math.imul(t ^ (t >>> 7), t | 61)) >>> 0;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- Permutation --------------------------------------------------------

// perm[i] = the scrambled slot that source tile i is placed into.
export function buildPermutation(seed, grid) {
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

// inv[perm[i]] = i
export function invertPermutation(perm) {
  const inv = new Array(perm.length);
  for (let i = 0; i < perm.length; i++) inv[perm[i]] = i;
  return inv;
}

// --- Tile geometry --------------------------------------------------------

export function tileSize(width, height, grid) {
  return { tileW: Math.floor(width / grid), tileH: Math.floor(height / grid) };
}

export function tileRect(index, grid, tileW, tileH) {
  const col = index % grid;
  const row = Math.floor(index / grid);
  return { x: col * tileW, y: row * tileH, w: tileW, h: tileH };
}

// --- Pixel buffer helpers ---------------------------------------------
// image: { width, height, data: Uint8ClampedArray of length width*height*4 (RGBA) }

export function cloneImage(image) {
  return { width: image.width, height: image.height, data: Uint8ClampedArray.from(image.data) };
}

export function blankImage(width, height) {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

function copyRect(srcImg, srcRect, dstImg, dstRect) {
  const sw = srcImg.width;
  const dw = dstImg.width;
  const sd = srcImg.data;
  const dd = dstImg.data;
  for (let row = 0; row < srcRect.h; row++) {
    const sy = srcRect.y + row;
    const dy = dstRect.y + row;
    const sOff = (sy * sw + srcRect.x) * 4;
    const dOff = (dy * dw + dstRect.x) * 4;
    dd.set(sd.subarray(sOff, sOff + srcRect.w * 4), dOff);
  }
}

export function flipHorizontal(image) {
  const { width, height, data } = image;
  const out = new Uint8ClampedArray(data.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sx = width - 1 - x;
      const sOff = (y * width + sx) * 4;
      const dOff = (y * width + x) * 4;
      out[dOff] = data[sOff];
      out[dOff + 1] = data[sOff + 1];
      out[dOff + 2] = data[sOff + 2];
      out[dOff + 3] = data[sOff + 3];
    }
  }
  return { width, height, data: out };
}

export function flipVertical(image) {
  const { width, height, data } = image;
  const out = new Uint8ClampedArray(data.length);
  const rowBytes = width * 4;
  for (let y = 0; y < height; y++) {
    const sy = height - 1 - y;
    out.set(data.subarray(sy * rowBytes, sy * rowBytes + rowBytes), y * rowBytes);
  }
  return { width, height, data: out };
}

export function invertColors(image) {
  const { width, height, data } = image;
  const out = new Uint8ClampedArray(data.length);
  for (let i = 0; i < data.length; i += 4) {
    out[i] = 255 - data[i];
    out[i + 1] = 255 - data[i + 1];
    out[i + 2] = 255 - data[i + 2];
    out[i + 3] = data[i + 3];
  }
  return { width, height, data: out };
}

// Scramble direction: output slot s <- source tile inv[s]. See contract.md.
export function blockPermuteForward(image, seed, grid) {
  const perm = buildPermutation(seed, grid);
  const inv = invertPermutation(perm);
  const { tileW, tileH } = tileSize(image.width, image.height, grid);
  const out = cloneImage(image); // remainder border passes through untouched
  const n = grid * grid;
  for (let s = 0; s < n; s++) {
    const destRect = tileRect(s, grid, tileW, tileH);
    const srcIdx = inv[s];
    const srcRect = tileRect(srcIdx, grid, tileW, tileH);
    copyRect(image, srcRect, out, destRect);
  }
  return out;
}

// Descramble direction: output tile i <- scrambled slot perm[i]. See contract.md.
export function blockPermuteInverse(image, seed, grid) {
  const perm = buildPermutation(seed, grid);
  const { tileW, tileH } = tileSize(image.width, image.height, grid);
  const out = cloneImage(image); // remainder border passes through untouched
  const n = grid * grid;
  for (let i = 0; i < n; i++) {
    const destRect = tileRect(i, grid, tileW, tileH);
    const srcSlot = perm[i];
    const srcRect = tileRect(srcSlot, grid, tileW, tileH);
    copyRect(image, srcRect, out, destRect);
  }
  return out;
}

// --- High-level pipeline ---------------------------------------------

export function scrambleImage(image, key) {
  validateKey(key);
  let buf = cloneImage(image);
  if (key.flipH) buf = flipHorizontal(buf);
  if (key.flipV) buf = flipVertical(buf);
  if (key.invert) buf = invertColors(buf);
  if (key.blockPermute) buf = blockPermuteForward(buf, key.seed, key.grid);
  return buf;
}

export function descrambleImage(image, key) {
  validateKey(key);
  let buf = cloneImage(image);
  if (key.blockPermute) buf = blockPermuteInverse(buf, key.seed, key.grid);
  if (key.invert) buf = invertColors(buf);
  if (key.flipH) buf = flipHorizontal(buf);
  if (key.flipV) buf = flipVertical(buf);
  return buf;
}

// --- Test helper: deterministic synthetic image ------------------------
// Each grid tile gets a distinct solid color derived from its index, so a
// permutation bug (tiles swapped, or perm/inv direction flipped) is
// trivially visible/assertable rather than hiding inside a photo.

export function makeTileTestImage(width, height, grid) {
  const img = blankImage(width, height);
  const { tileW, tileH } = tileSize(width, height, grid);
  const n = grid * grid;
  for (let idx = 0; idx < n; idx++) {
    const r = (idx * 37) % 256;
    const g = (idx * 59) % 256;
    const b = (idx * 83) % 256;
    const rect = tileRect(idx, grid, tileW, tileH);
    for (let y = rect.y; y < rect.y + rect.h; y++) {
      for (let x = rect.x; x < rect.x + rect.w; x++) {
        const off = (y * width + x) * 4;
        img.data[off] = r;
        img.data[off + 1] = g;
        img.data[off + 2] = b;
        img.data[off + 3] = 255;
      }
    }
  }
  // border remainder (if any) gets a marker color distinct from any tile
  const usedW = tileW * grid;
  const usedH = tileH * grid;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (x >= usedW || y >= usedH) {
        const off = (y * width + x) * 4;
        img.data[off] = 10;
        img.data[off + 1] = 200;
        img.data[off + 2] = 10;
        img.data[off + 3] = 255;
      }
    }
  }
  return img;
}
