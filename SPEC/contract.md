# Scramble/Descramble Contract (v1)

This is the single source of truth for `obs-scramble` (the OBS filter) and
`wtv-descramble.user.js` (the Tampermonkey descrambler). Both implementations
MUST match this document and `reference.mjs` exactly. If you change the math
here, you must update `reference.mjs`, re-run `test/roundtrip.mjs`, and
propagate the change to both the C++ plugin and the userscript.

## The key

A small JSON object, shared out-of-band between broadcaster and viewer:

```json
{ "seed": 1337, "grid": 9, "flipH": true, "flipV": false, "invert": true, "blockPermute": true, "version": 1 }
```

| field         | type    | meaning                                              |
|---------------|---------|-------------------------------------------------------|
| `seed`        | uint32  | drives the permutation PRNG                            |
| `grid`        | int     | N×N tiles (default 9 → 81 tiles)                        |
| `flipH`       | bool    | mirror horizontally                                     |
| `flipV`       | bool    | mirror vertically                                       |
| `invert`      | bool    | invert RGB (not alpha)                                  |
| `blockPermute`| bool    | shuffle tiles                                            |
| `version`     | int     | contract version; a mismatch MUST refuse to run and log a clear error, not silently misrender |

A viewer without the matching key sees visibly garbled video. This transforms
only the broadcaster's own outgoing pixels; it does not touch w.tv's access
controls, DRM, or paywalls.

## Master string (compact shareable key encoding)

The human-friendly, copy-paste form of the key. The OBS plugin displays it in
the filter's properties; the viewer pastes it into the userscript's panel and
every setting applies at once. Both sides implement this encoding and MUST
agree byte-for-byte (see `encodeMasterString`/`parseMasterString` in
`reference.mjs`, and the golden fixtures in `test/master-strings.json`).

**Grammar (canonical emit form):**

```
master  = "WTV" version "-" seed "-" grid "-" flags
version = "1"                        (must equal the key's version field)
seed    = decimal uint32, no sign, no separators   (0 .. 4294967295)
grid    = decimal integer >= 1
flags   = "0"  |  one or more of "H" "V" "I" "P"   (emitted in H,V,I,P order)
```

- `H` = flipH, `V` = flipV, `I` = invert, `P` = blockPermute. A flag's
  presence means enabled. `0` (alone) means no ops enabled — emitted instead
  of an empty flags part so the string never ends in a dangling dash.
- Canonical examples: default key → `WTV1-1337-9-HIP`; everything off →
  `WTV1-42-9-0`; everything on → `WTV1-0-16-HVIP`.

**Parse rules (be liberal in what you accept):** trim surrounding
whitespace; match the `WTV` prefix and flag letters case-insensitively;
accept flags in any order; ignore duplicate flags. But fail loudly — do not
guess — on: an unknown flag letter, a version other than this contract's, a
seed outside uint32 range, a grid < 1, or anything that doesn't match the
overall shape. A rejected master string must leave the current settings
untouched and produce a clear, visible error.


32-bit integer state, ported **verbatim** — do not use `Math.random()`,
`rand()`, or any other non-seeded source; the exact bit operations below must
match in every language or the permutations will diverge.

Canonical JS (see `reference.mjs`):

```js
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
```

Canonical C++ port (uint32_t arithmetic wraps mod 2^32 the same way JS's
`>>> 0` coercion does, so this is a literal translation, not a re-derivation):

```cpp
#include <cstdint>

struct Mulberry32 {
  uint32_t a;
  explicit Mulberry32(uint32_t seed) : a(seed) {}
  double next() {
    a = a + 0x6d2b79f5u;
    uint32_t t = a;
    t = (t ^ (t >> 15)) * (t | 1u);
    t ^= (t + (t ^ (t >> 7)) * (t | 61u));
    return static_cast<double>(t ^ (t >> 14)) / 4294967296.0;
  }
};
```

## Permutation

```
n = grid * grid
perm = [0, 1, ..., n-1]
rng = mulberry32(seed)
for i from n-1 down to 1:
    j = floor(rng.next() * (i + 1))     // 0 <= j <= i
    swap(perm[i], perm[j])              // Fisher–Yates
```

`perm[i]` = the scrambled slot that **source tile `i`** is placed into.

`inv` is the inverse mapping: `inv[perm[i]] = i` for all `i`. Both sides
compute **both** arrays for clarity, even though each side's shader only
strictly needs one of them (see next section — this is the part that is easy
to get backwards).

## Which array does which renderer use? (read this carefully)

Neither a GPU pixel shader nor a `<canvas>` `drawImage` loop can "scatter" a
source pixel to an arbitrary destination. Both can only **gather**: for a
given *output* pixel/tile, decide which *input* pixel/tile to sample. That
constraint flips which array each side needs relative to the natural
"source → destination" reading of `perm`.

- **OBS scramble shader** (source video → scrambled output): for output slot
  `s`, sample the ORIGINAL frame at tile **`inv[s]`**.
- **Browser descrambler** (scrambled frame → original picture): for output
  tile `i` (the true, unscrambled position), sample the SCRAMBLED frame at
  slot **`perm[i]`**.

Worked example (`grid=2`, 4 tiles, `perm = [2, 0, 3, 1]`):

- `perm[0]=2`: original tile 0 ends up in scrambled slot 2.
- `perm[1]=0`: original tile 1 ends up in scrambled slot 0.
- `perm[2]=3`: original tile 2 ends up in scrambled slot 3.
- `perm[3]=1`: original tile 3 ends up in scrambled slot 1.
- So `inv = [1, 3, 0, 2]`.

Scramble (gather, uses `inv`): output slot 0 shows `inv[0]=1` → original
tile 1's pixels. Slot 1 shows `inv[1]=3` → tile 3. Slot 2 shows `inv[2]=0` →
tile 0. Slot 3 shows `inv[3]=2` → tile 2. This matches the scatter reading of
`perm` above (tile 1 → slot 0, tile 3 → slot 1, tile 0 → slot 2, tile 2 →
slot 3). ✓

Descramble (gather, uses `perm`): output tile 0 (true position) samples
scrambled slot `perm[0]=2`, which — per the scramble step above — holds
original tile 0's pixels. ✓ Output tile 1 samples slot `perm[1]=0`, which
holds original tile 1's pixels. ✓

**If you swap these two arrays, individual ops will each look "correct" in
isolation but the round trip will silently produce a different — still
tile-shuffled — garbled image instead of the original.** `test/roundtrip.mjs`
exists specifically to catch this class of bug before it reaches OBS or the
browser.

## Tile geometry (exact, no resampling)

```
tileW = floor(width  / grid)
tileH = floor(height / grid)
```

`blockPermute` only operates on the region `[0, tileW*grid) × [0, tileH*grid)`.
Every tile is therefore **exactly** `tileW × tileH`, so tile-to-tile copies
are same-size block copies — no interpolation, no resampling, bit-exact and
trivially invertible. Any remainder border (right strip of width
`width - tileW*grid`, bottom strip of height `height - tileH*grid`; both
strictly less than `grid` pixels — at most 8px wide for the default grid=9)
is passed through **unpermuted**. `flipH`, `flipV`, and `invert` apply to the
**full** frame, border included — only the permutation step has this
divisibility constraint.

Tile index → rect:
```
col = index % grid
row = floor(index / grid)
x = col * tileW
y = row * tileH
w = tileW
h = tileH
```

The OBS shader performs the equivalent computation in normalized UV space
(`col/grid`, `row/grid`) over the same `tileW*grid × tileH*grid` pixel
region; because UV sampling is continuous, its tile boundaries coincide with
the canvas implementation's integer boundaries to sub-pixel precision — not
bit-exact across languages, but visually indistinguishable (this is a
separate, much lower-stakes concern than the perm/inv direction above, which
is a correctness bug, not a precision nuance).

## Canonical pipeline order

- **Scramble (OBS):** flip (H then V, order between them doesn't matter —
  they commute) → invert colors → block-permute (using `inv`, see above).
- **Descramble (browser):** inverse block-permute (using `perm`, see above)
  → invert colors (self-inverse) → flip (self-inverse; same axes).

Applying the inverses in reverse order is what makes this correct in
general: to undo `permute(invert(flip(x)))` you must undo permute first,
then invert, then flip — undoing them in scramble order would not cancel.

`invert` and `flip` are each self-inverse (`invert(invert(x)) = x`,
`flip(flip(x)) = x`), so the browser reuses the exact same invert/flip code
as the OBS side; only `blockPermute` needs a distinct "inverse" variant, and
that distinction is entirely captured by swapping `inv` for `perm`.

## Round-trip guarantee

For any key and any image whose dimensions are ≥ `grid × grid`:
`descramble(scramble(image, key), key)` is **pixel-identical** to `image`
inside the `[0, tileW*grid) × [0, tileH*grid)` region (block-permute is
bit-exact there), and identical everywhere else (flip/invert are exact
full-frame operations; the border strip is untouched by permutation and
round-trips trivially through flip+invert). `test/roundtrip.mjs` asserts
this for multiple seeds, grid sizes, op-combinations, and both
grid-divisible and non-divisible resolutions.

## Versioning

`version: 1` is the only version this contract defines. A descrambler that
receives a key with a different `version` MUST refuse to run and log a
clear, visible error rather than attempt to render — silent misrendering
(a distorted-but-not-obviously-broken picture) is worse than an obvious
failure.
