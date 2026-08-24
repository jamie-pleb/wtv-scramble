/*
 * scramble-permutation.h
 *
 * OBS-independent core: Mulberry32 PRNG + Fisher-Yates permutation builder.
 *
 * This is a *verbatim* C port of the canonical algorithm in
 * ../../SPEC/contract.md (see the "Deterministic PRNG: mulberry32" and
 * "Permutation" sections) and ../../SPEC/reference.mjs (the executable JS
 * ground truth). Do NOT "simplify" or re-derive the math here — copy it
 * exactly. uint32_t arithmetic wraps mod 2^32 the same way JS's `>>> 0`
 * coercion does, so the C++ listing in the contract is a literal
 * translation of the JS, not a re-derivation, and this file is a literal
 * translation of that C++ listing.
 *
 * This header (and its .c) has ZERO OBS/libobs dependencies on purpose, so
 * it can be:
 *   - linked into the real OBS plugin (src/scramble-filter.c), AND
 *   - linked into tools/dump_perm.c, a tiny standalone CLI that prints
 *     buildPermutation(seed, grid) as JSON so it can be diffed against
 *     ../../test/perm-1337-9.json (the golden file dumped from
 *     SPEC/reference.mjs) with zero OBS SDK required. See README.md
 *     "Verification".
 *
 * IMPORTANT — read ../../SPEC/contract.md's "Which array does which
 * renderer use?" section before using the perm/inv arrays this produces.
 * perm[i] is the scrambled slot that source tile i is placed into; inv is
 * its true inverse. The OBS scramble shader needs INV (not perm) for its
 * block-permute step; getting this backwards produces a picture that is
 * STILL SCRAMBLED (just differently) rather than an obvious crash.
 */

#ifndef OBS_SCRAMBLE_PERMUTATION_H
#define OBS_SCRAMBLE_PERMUTATION_H

#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/* The only contract version this build understands. Mirrors
 * CONTRACT_VERSION in SPEC/reference.mjs. */
#define SCRAMBLE_CONTRACT_VERSION 1

/*
 * scramble_key_t
 *
 * C mirror of the JSON "key" object in SPEC/contract.md's "The key" section:
 *   { seed, grid, flipH, flipV, invert, blockPermute, version }
 * Field names are snake_case per C convention but map 1:1.
 */
typedef struct {
    uint32_t seed;
    int32_t grid;
    bool flip_h;
    bool flip_v;
    bool invert;
    bool block_permute;
    int32_t version;
} scramble_key_t;

/* Big enough for any successfully-encoded master string, NUL included:
 * "WTV" + up to 10 version digits + '-' + up to 10 seed digits + '-' +
 * up to 10 grid digits + '-' + up to 4 flag chars ("HVIP") + NUL, rounded
 * up generously. */
#define SCRAMBLE_MASTER_STRING_BUF_SIZE 64

/*
 * Ported *verbatim* from encodeMasterString() in SPEC/reference.mjs — see
 * ../../SPEC/contract.md "Master string" for the grammar. Writes the
 * canonical "WTV<version>-<seed>-<grid>-<flags>" string (NUL-terminated)
 * into buf (which must be at least SCRAMBLE_MASTER_STRING_BUF_SIZE bytes)
 * and returns true on success.
 *
 * Returns false (buf left as an empty string) if key->version !=
 * SCRAMBLE_CONTRACT_VERSION or key->grid < 1 — mirrors the validateKey()
 * checks reference.mjs's encodeMasterString() performs before formatting.
 */
bool scramble_encode_master_string(const scramble_key_t *key, char *buf, size_t buf_size);

/*
 * Ported *verbatim* from parseMasterString() in SPEC/reference.mjs — see
 * ../../SPEC/contract.md "Master string" for the exact liberal-parse /
 * loud-reject rules (trim whitespace; case-insensitive "WTV" prefix and
 * flag letters; any flag order; duplicate flags ignored; but reject an
 * unknown flag letter, a version other than SCRAMBLE_CONTRACT_VERSION, a
 * seed outside uint32 range, a grid < 1, or any shape mismatch).
 *
 * On success, fills *out_key and returns true. On failure, *out_key is left
 * completely untouched (callers can safely parse into a scratch copy and
 * only commit it after success) and returns false; if err_buf is non-NULL,
 * a human-readable diagnostic is written there (truncated to err_buf_size,
 * always NUL-terminated) suitable for `blog(LOG_WARNING, "%s", err_buf)`.
 * err_buf/err_buf_size may be {NULL, 0} to skip the diagnostic.
 */
bool scramble_parse_master_string(const char *str, scramble_key_t *out_key, char *err_buf, size_t err_buf_size);

/* Mulberry32 PRNG state. */
typedef struct {
    uint32_t a;
} scramble_mulberry32_t;

void scramble_mulberry32_init(scramble_mulberry32_t *rng, uint32_t seed);

/* Returns the next pseudo-random double in [0, 1). Ported verbatim from the
 * canonical mulberry32 next() in SPEC/contract.md. */
double scramble_mulberry32_next(scramble_mulberry32_t *rng);

/*
 * Builds the Fisher-Yates permutation for a `grid`x`grid` arrangement of
 * tiles (n = grid*grid), seeded by `seed`, exactly per SPEC/contract.md's
 * "Permutation" section:
 *
 *   n = grid * grid
 *   perm = [0, 1, ..., n-1]
 *   rng = mulberry32(seed)
 *   for i from n-1 down to 1:
 *       j = floor(rng.next() * (i + 1))     // 0 <= j <= i
 *       swap(perm[i], perm[j])              // Fisher-Yates
 *
 *   out_perm[i] = the scrambled slot that source tile i is placed into.
 *   out_inv[out_perm[i]] = i for all i (the true inverse mapping).
 *
 * out_perm must point to storage for grid*grid uint32_t elements.
 * out_inv may be NULL if the caller only needs perm; otherwise it must
 * also point to storage for grid*grid uint32_t elements.
 *
 * Returns 0 on success, -1 if grid <= 0 or out_perm is NULL (guards against
 * the grid <= 0 / divide-by-zero case callers must also guard against when
 * later computing tileW = width / grid, tileH = height / grid).
 */
int scramble_build_permutation(uint32_t seed, int grid, uint32_t *out_perm, uint32_t *out_inv);

#ifdef __cplusplus
}
#endif

#endif /* OBS_SCRAMBLE_PERMUTATION_H */
