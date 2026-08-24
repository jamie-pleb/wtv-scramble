// Proves the core scramble/descramble math in SPEC/reference.mjs is correct
// BEFORE any of it is trusted inside the OBS plugin or the userscript.
//
// Run: node test/roundtrip.mjs

import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  CONTRACT_VERSION,
  buildPermutation,
  invertPermutation,
  scrambleImage,
  descrambleImage,
  makeTileTestImage,
  encodeMasterString,
  parseMasterString,
} from "../SPEC/reference.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_PATH = path.join(__dirname, "perm-1337-9.json");
const MASTER_GOLDEN_PATH = path.join(__dirname, "master-strings.json");

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok  - ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL  - ${name}`);
    console.error(`        ${err.message}`);
  }
}

function imagesEqual(a, b) {
  if (a.width !== b.width || a.height !== b.height) return false;
  if (a.data.length !== b.data.length) return false;
  for (let i = 0; i < a.data.length; i++) {
    if (a.data[i] !== b.data[i]) return false;
  }
  return true;
}

function firstDiff(a, b) {
  for (let i = 0; i < a.data.length; i += 4) {
    if (
      a.data[i] !== b.data[i] ||
      a.data[i + 1] !== b.data[i + 1] ||
      a.data[i + 2] !== b.data[i + 2] ||
      a.data[i + 3] !== b.data[i + 3]
    ) {
      const px = i / 4;
      const x = px % a.width;
      const y = Math.floor(px / a.width);
      return { x, y, a: [...a.data.slice(i, i + 4)], b: [...b.data.slice(i, i + 4)] };
    }
  }
  return null;
}

console.log(`SPEC contract version under test: ${CONTRACT_VERSION}\n`);

// --- 1. Permutation is a real bijection (perm/inv are true inverses) ----

check("buildPermutation(1337, 9) is a bijection on [0,81)", () => {
  const perm = buildPermutation(1337, 9);
  assert.equal(perm.length, 81);
  const seen = new Set(perm);
  assert.equal(seen.size, 81, "perm must contain 81 distinct values");
  for (const v of perm) assert.ok(v >= 0 && v < 81);
});

check("invertPermutation is a true inverse: inv[perm[i]] === i for all i", () => {
  const perm = buildPermutation(1337, 9);
  const inv = invertPermutation(perm);
  for (let i = 0; i < perm.length; i++) {
    assert.equal(inv[perm[i]], i, `inv[perm[${i}]] should be ${i}`);
  }
});

// --- 2. Golden file: cross-language parity anchor for the C++ port ------

check("perm(seed=1337, grid=9) matches committed golden file (or creates it)", () => {
  const perm = buildPermutation(1337, 9);
  if (!existsSync(GOLDEN_PATH)) {
    writeFileSync(GOLDEN_PATH, JSON.stringify(perm, null, 2) + "\n");
    console.log(`        (golden file did not exist; created ${GOLDEN_PATH})`);
    return;
  }
  const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8"));
  assert.deepEqual(perm, golden, "perm(1337,9) must match the committed golden array — the C++ plugin's dumped perm must also match this file");
});

// --- 3. Pixel-exact round trip, grid-divisible resolution, every flag combo --

{
  const grid = 9;
  const tileW = 12;
  const tileH = 8;
  const width = tileW * grid; // 108, evenly divisible
  const height = tileH * grid; // 72, evenly divisible
  const original = makeTileTestImage(width, height, grid);

  const flagCombos = [];
  for (let mask = 0; mask < 16; mask++) {
    flagCombos.push({
      flipH: !!(mask & 1),
      flipV: !!(mask & 2),
      invert: !!(mask & 4),
      blockPermute: !!(mask & 8),
    });
  }

  for (const flags of flagCombos) {
    const key = { seed: 1337, grid, version: CONTRACT_VERSION, ...flags };
    const label = `flipH=${flags.flipH} flipV=${flags.flipV} invert=${flags.invert} blockPermute=${flags.blockPermute}`;
    check(`round trip is pixel-exact (divisible ${width}x${height}, ${label})`, () => {
      const scrambled = scrambleImage(original, key);
      const restored = descrambleImage(scrambled, key);
      if (!imagesEqual(original, restored)) {
        const diff = firstDiff(original, restored);
        throw new Error(
          `mismatch at (${diff.x},${diff.y}): original=${diff.a} restored=${diff.b}`
        );
      }
      if (flags.blockPermute) {
        // sanity: with permutation on, the scrambled frame must actually
        // differ from the original (grid > 1), proving the permute step
        // did something rather than silently no-op'ing.
        assert.ok(!imagesEqual(original, scrambled), "blockPermute=true but scrambled frame equals original — permutation did nothing");
      }
    });
  }
}

// --- 4. Non-divisible resolution: border passes through, tiles still exact --

{
  const grid = 9;
  const width = 100; // 100/9 = 11 remainder 1 -> tileW=11, border strip width 1
  const height = 101; // 101/9 = 11 remainder 2 -> tileH=11, border strip height 2
  const original = makeTileTestImage(width, height, grid);
  const key = { seed: 42, grid, flipH: true, flipV: true, invert: true, blockPermute: true, version: CONTRACT_VERSION };

  check(`round trip is pixel-exact on non-divisible resolution ${width}x${height} (border pass-through)`, () => {
    const scrambled = scrambleImage(original, key);
    const restored = descrambleImage(scrambled, key);
    if (!imagesEqual(original, restored)) {
      const diff = firstDiff(original, restored);
      throw new Error(`mismatch at (${diff.x},${diff.y}): original=${diff.a} restored=${diff.b}`);
    }
  });
}

// --- 5. Multiple seeds / grid sizes, permute-only, to catch seed-specific bugs --

for (const [seed, grid] of [
  [1, 3],
  [7, 5],
  [999999, 9],
  [0, 9],
  [4294967295, 9], // max uint32 seed
]) {
  const tileW = 6;
  const tileH = 6;
  const width = tileW * grid;
  const height = tileH * grid;
  const original = makeTileTestImage(width, height, grid);
  const key = { seed, grid, flipH: false, flipV: false, invert: false, blockPermute: true, version: CONTRACT_VERSION };

  check(`round trip exact for seed=${seed} grid=${grid}`, () => {
    const scrambled = scrambleImage(original, key);
    const restored = descrambleImage(scrambled, key);
    if (!imagesEqual(original, restored)) {
      const diff = firstDiff(original, restored);
      throw new Error(`mismatch at (${diff.x},${diff.y}): original=${diff.a} restored=${diff.b}`);
    }
  });
}

// --- 6. grid=1 edge case (single tile, permutation is a no-op) ----------

check("grid=1 is a safe no-op for blockPermute", () => {
  const width = 20;
  const height = 20;
  const original = makeTileTestImage(width, height, 1);
  const key = { seed: 1337, grid: 1, flipH: false, flipV: false, invert: false, blockPermute: true, version: CONTRACT_VERSION };
  const scrambled = scrambleImage(original, key);
  const restored = descrambleImage(scrambled, key);
  assert.ok(imagesEqual(original, scrambled), "grid=1 blockPermute should be a visual no-op");
  assert.ok(imagesEqual(original, restored));
});

// --- 7. Regression guard for the perm/inv direction bug -----------------
// This directly encodes the worked example from contract.md so a future
// change that swaps perm<->inv in blockPermuteForward/Inverse fails loudly
// with a specific, diagnosable message instead of a generic pixel mismatch.

check("perm/inv direction matches contract.md worked example (grid=2)", () => {
  // Find a seed that reproduces perm = [2,0,3,1] is unnecessary; instead
  // verify the *relationship* the worked example demonstrates directly:
  // scramble's tile s must equal the original content of tile inv[s].
  const grid = 2;
  const tileW = 4;
  const tileH = 4;
  const width = tileW * grid;
  const height = tileH * grid;
  const original = makeTileTestImage(width, height, grid);
  const perm = buildPermutation(2024, grid);
  const inv = invertPermutation(perm);
  const key = { seed: 2024, grid, flipH: false, flipV: false, invert: false, blockPermute: true, version: CONTRACT_VERSION };
  const scrambled = scrambleImage(original, key);

  function tileColorAt(img, tileIndex) {
    const col = tileIndex % grid;
    const row = Math.floor(tileIndex / grid);
    const x = col * tileW;
    const y = row * tileH;
    const off = (y * img.width + x) * 4;
    return [img.data[off], img.data[off + 1], img.data[off + 2]];
  }

  for (let s = 0; s < grid * grid; s++) {
    const gotColor = tileColorAt(scrambled, s);
    const wantColor = tileColorAt(original, inv[s]);
    assert.deepEqual(gotColor, wantColor, `scrambled tile ${s} should show original tile inv[${s}]=${inv[s]}'s color`);
  }
});

// --- 8. Master string: encode/parse per contract.md "Master string" -----

check('encodeMasterString(default key) === "WTV1-1337-9-HIP"', () => {
  const key = { seed: 1337, grid: 9, flipH: true, flipV: false, invert: true, blockPermute: true, version: CONTRACT_VERSION };
  assert.equal(encodeMasterString(key), "WTV1-1337-9-HIP");
});

check("master string encode->parse round-trips every flag combo", () => {
  for (let mask = 0; mask < 16; mask++) {
    const key = {
      seed: 1000 + mask,
      grid: 3 + (mask % 5),
      flipH: !!(mask & 1),
      flipV: !!(mask & 2),
      invert: !!(mask & 4),
      blockPermute: !!(mask & 8),
      version: CONTRACT_VERSION,
    };
    const parsed = parseMasterString(encodeMasterString(key));
    assert.deepEqual(parsed, key, `round trip failed for mask ${mask}: ${encodeMasterString(key)}`);
  }
});

check("master string parse is tolerant: case, whitespace, flag order, duplicate flags", () => {
  const want = { seed: 1337, grid: 9, flipH: true, flipV: false, invert: true, blockPermute: true, version: CONTRACT_VERSION };
  assert.deepEqual(parseMasterString("wtv1-1337-9-hip"), want);
  assert.deepEqual(parseMasterString("  WTV1-1337-9-HIP  \n"), want);
  assert.deepEqual(parseMasterString("WTV1-1337-9-PIH"), want);
  assert.deepEqual(parseMasterString("WTV1-1337-9-HHIIPP"), want);
});

check('master string "0" flags and empty flags both mean all ops off', () => {
  const want = { seed: 42, grid: 9, flipH: false, flipV: false, invert: false, blockPermute: false, version: CONTRACT_VERSION };
  assert.deepEqual(parseMasterString("WTV1-42-9-0"), want);
  assert.deepEqual(parseMasterString("WTV1-42-9-"), want);
  const allOff = { ...want };
  assert.equal(encodeMasterString(allOff), "WTV1-42-9-0", "canonical emit for no flags is 0, not empty");
});

check("master string parse rejects garbage loudly", () => {
  const bad = [
    "WTV2-1337-9-HIP", // wrong version
    "WTV1-1337-9-X", // unknown flag
    "WTV1-1337-9-H0P", // 0 mixed with letters
    "WTV1--9-HIP", // missing seed
    "WTV1-1337-0-HIP", // grid < 1
    "WTV1-4294967296-9-HIP", // seed > uint32
    "WTV1-1337-9-HIP-extra", // trailing junk
    "hello", // not even close
    "", // empty
  ];
  for (const s of bad) {
    assert.throws(() => parseMasterString(s), undefined, `should have rejected: "${s}"`);
  }
});

check("master string goldens match committed fixture file (or creates it)", () => {
  const fixtures = [
    { seed: 1337, grid: 9, flipH: true, flipV: false, invert: true, blockPermute: true },
    { seed: 42, grid: 9, flipH: false, flipV: false, invert: false, blockPermute: false },
    { seed: 0, grid: 16, flipH: true, flipV: true, invert: true, blockPermute: true },
    { seed: 4294967295, grid: 1, flipH: false, flipV: true, invert: false, blockPermute: false },
    { seed: 7, grid: 5, flipH: false, flipV: false, invert: true, blockPermute: false },
    { seed: 123456789, grid: 12, flipH: true, flipV: false, invert: false, blockPermute: true },
  ].map((k) => {
    const key = { ...k, version: CONTRACT_VERSION };
    return { key, master: encodeMasterString(key) };
  });
  if (!existsSync(MASTER_GOLDEN_PATH)) {
    writeFileSync(MASTER_GOLDEN_PATH, JSON.stringify(fixtures, null, 2) + "\n");
    console.log(`        (golden file did not exist; created ${MASTER_GOLDEN_PATH})`);
    return;
  }
  const golden = JSON.parse(readFileSync(MASTER_GOLDEN_PATH, "utf8"));
  assert.deepEqual(fixtures, golden, "master string encodes must match the committed goldens — the C port must also match this file");
  for (const f of golden) {
    assert.deepEqual(parseMasterString(f.master), f.key, `parse(${f.master}) must recover the golden key`);
  }
});

console.log("");
if (failures > 0) {
  console.error(`${failures} check(s) FAILED.`);
  process.exit(1);
} else {
  console.log("All round-trip checks passed.");
  process.exit(0);
}
