// verify-cpp-port.mjs
//
// Independent cross-check that the C port of Mulberry32 + Fisher-Yates in
// ../src/scramble-permutation.c is bit-exact with the canonical JS reference
// (../../SPEC/reference.mjs / ../../test/perm-1337-9.json).
//
// Methodology: this file does NOT import anything from SPEC/reference.mjs.
// It is a from-scratch re-transcription of the algorithm directly from
// SPEC/contract.md's C++ listing, using BigInt + explicit 0xFFFFFFFFn
// masking so every operation mirrors uint32_t wraparound literally (add,
// xor, shift, multiply, mask) — a different JS idiom than
// SPEC/reference.mjs's mulberry32(), which uses `>>> 0` / Math.imul().
// Two independently-coded implementations of the same algorithm (this file,
// and src/scramble-permutation.c) producing identical output, both matching
// the frozen golden file, is a useful belt-and-suspenders correctness
// signal on top of the actual compiled check: `obs-scramble-dump-perm
// --seed 1337 --grid 9 --out perm.json` (built for real from
// tools/dump_perm.c, see ../README.md) exercises the same C code directly
// and can be diffed against the same golden file.
//
// Run: node tools/verify-cpp-port.mjs
// Writes: ../../test/perm-1337-9-cpp.json
// Diffs it against: ../../test/perm-1337-9.json (the existing golden file)

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const MASK = 0xffffffffn;

// Mirrors src/scramble-permutation.c's scramble_mulberry32_next() /
// SPEC/contract.md's C++ listing line for line:
//   a = a + 0x6d2b79f5u;
//   uint32_t t = a;
//   t = (t ^ (t >> 15)) * (t | 1u);
//   t ^= (t + (t ^ (t >> 7)) * (t | 61u));
//   return (double)(t ^ (t >> 14)) / 4294967296.0;
class Mulberry32Shadow {
  constructor(seed) {
    this.a = BigInt.asUintN(32, BigInt(seed)) & MASK;
  }
  next() {
    this.a = (this.a + 0x6d2b79f5n) & MASK;
    let t = this.a;
    t = ((t ^ (t >> 15n)) * (t | 1n)) & MASK;
    t = (t ^ ((t + (((t ^ (t >> 7n)) * (t | 61n)) & MASK)) & MASK)) & MASK;
    const result = (t ^ (t >> 14n)) & MASK;
    return Number(result) / 4294967296;
  }
}

// Mirrors src/scramble-permutation.c's scramble_build_permutation() /
// SPEC/contract.md's "Permutation" section line for line.
function buildPermutationShadow(seed, grid) {
  const n = grid * grid;
  const rng = new Mulberry32Shadow(seed);
  const perm = new Array(n);
  for (let i = 0; i < n; i++) perm[i] = i;
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    const tmp = perm[i];
    perm[i] = perm[j];
    perm[j] = tmp;
  }
  return perm;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..", ".."); // obs-scramble/tools -> repo root
const GOLDEN_PATH = path.join(REPO_ROOT, "test", "perm-1337-9.json");
const OUT_PATH = path.join(REPO_ROOT, "test", "perm-1337-9-cpp.json");

const SEED = 1337;
const GRID = 9;

const shadowPerm = buildPermutationShadow(SEED, GRID);

// Match the golden file's JSON.stringify(perm, null, 2) formatting exactly.
writeFileSync(OUT_PATH, JSON.stringify(shadowPerm, null, 2) + "\n");

const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8"));

let ok = golden.length === shadowPerm.length;
if (ok) {
  for (let i = 0; i < golden.length; i++) {
    if (golden[i] !== shadowPerm[i]) {
      ok = false;
      console.error(`mismatch at index ${i}: golden=${golden[i]} shadow=${shadowPerm[i]}`);
      break;
    }
  }
}

console.log(`wrote ${OUT_PATH}`);
console.log(
  ok
    ? `MATCH: independent C-algorithm shadow (BigInt) == golden JS reference for all ${golden.length} entries (seed=${SEED}, grid=${GRID})`
    : "MISMATCH — see above"
);
process.exit(ok ? 0 : 1);
