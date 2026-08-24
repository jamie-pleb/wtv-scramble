/*
 * scramble-permutation.c
 *
 * See scramble-permutation.h and ../../SPEC/contract.md before touching
 * this file. This is a verbatim port of the canonical mulberry32 +
 * Fisher-Yates algorithm; do not "simplify" or re-derive it.
 */

#include "scramble-permutation.h"

#include <stddef.h> /* NULL */
#include <string.h> /* memset, strlen */
#include <ctype.h>  /* isspace, isalnum, tolower, toupper */
#include <stdio.h>  /* snprintf, vsnprintf */
#include <stdarg.h> /* va_list */

void scramble_mulberry32_init(scramble_mulberry32_t *rng, uint32_t seed)
{
    rng->a = seed;
}

double scramble_mulberry32_next(scramble_mulberry32_t *rng)
{
    uint32_t t;

    /* Canonical C++ port from SPEC/contract.md:
     *   a = a + 0x6d2b79f5u;
     *   uint32_t t = a;
     *   t = (t ^ (t >> 15)) * (t | 1u);
     *   t ^= (t + (t ^ (t >> 7)) * (t | 61u));
     *   return (double)(t ^ (t >> 14)) / 4294967296.0;
     * uint32_t arithmetic below wraps mod 2^32 exactly like the JS
     * reference's `>>> 0` coercions and Math.imul(). Do not change the
     * order or grouping of these operations. */
    rng->a = rng->a + 0x6d2b79f5u;
    t = rng->a;
    t = (t ^ (t >> 15)) * (t | 1u);
    t ^= (t + (t ^ (t >> 7)) * (t | 61u));

    return (double)(t ^ (t >> 14)) / 4294967296.0;
}

int scramble_build_permutation(uint32_t seed, int grid, uint32_t *out_perm, uint32_t *out_inv)
{
    int64_t n;
    int64_t i;
    int64_t j;
    scramble_mulberry32_t rng;

    if (grid <= 0 || out_perm == NULL) {
        return -1;
    }

    n = (int64_t)grid * (int64_t)grid;

    /* perm = [0, 1, ..., n-1] */
    for (i = 0; i < n; i++) {
        out_perm[i] = (uint32_t)i;
    }

    scramble_mulberry32_init(&rng, seed);

    /* Fisher-Yates, driven by the PRNG above, exactly per contract.md:
     *   for i from n-1 down to 1:
     *       j = floor(rng.next() * (i + 1))
     *       swap(perm[i], perm[j])
     * rng.next() always returns a value in [0, 1) (t ^ (t >> 14) is a
     * uint32_t strictly less than 2^32, divided by 2^32.0), so
     * r * (i + 1) is mathematically in [0, i] and truncation toward zero
     * (equivalent to floor() for non-negative values) always yields
     * 0 <= j <= i. No clamping is needed or added, to stay a literal
     * translation of the spec. */
    for (i = n - 1; i > 0; i--) {
        double r = scramble_mulberry32_next(&rng);
        uint32_t tmp;

        j = (int64_t)(r * (double)(i + 1));

        tmp = out_perm[i];
        out_perm[i] = out_perm[j];
        out_perm[j] = tmp;
    }

    /* inv[perm[i]] = i for all i */
    if (out_inv != NULL) {
        for (i = 0; i < n; i++) {
            out_inv[out_perm[i]] = (uint32_t)i;
        }
    }

    return 0;
}

/* --------------------------------------------------------------------- */
/* Master string: encode/parse. Verbatim port of encodeMasterString() /   */
/* parseMasterString() from SPEC/reference.mjs -- see scramble-           */
/* permutation.h and ../../SPEC/contract.md "Master string" before        */
/* touching this. Do NOT re-derive the grammar; match the JS behavior.    */
/* --------------------------------------------------------------------- */

static void scramble_set_err(char *err_buf, size_t err_buf_size, const char *fmt, ...)
{
    va_list ap;

    if (err_buf == NULL || err_buf_size == 0) {
        return;
    }

    va_start(ap, fmt);
    vsnprintf(err_buf, err_buf_size, fmt, ap);
    va_end(ap);
    /* vsnprintf always NUL-terminates on success (C99); guard anyway in
     * case of a pathological libc that doesn't on truncation. */
    err_buf[err_buf_size - 1] = '\0';
}

bool scramble_encode_master_string(const scramble_key_t *key, char *buf, size_t buf_size)
{
    char flags[5]; /* up to "HVIP" + NUL */
    size_t flen = 0;
    int written;

    if (buf != NULL && buf_size > 0) {
        buf[0] = '\0';
    }

    if (buf == NULL || buf_size == 0 || key == NULL) {
        return false;
    }

    /* Mirrors the validateKey() checks reference.mjs's encodeMasterString()
     * performs before formatting (a finite seed is guaranteed here since
     * key->seed is a uint32_t, not a floating point value). */
    if (key->version != SCRAMBLE_CONTRACT_VERSION) {
        return false;
    }
    if (key->grid < 1) {
        return false;
    }

    /* flags = ""; if (flipH) flags += "H"; ... ; if (flags === "") flags = "0"; */
    if (key->flip_h) {
        flags[flen++] = 'H';
    }
    if (key->flip_v) {
        flags[flen++] = 'V';
    }
    if (key->invert) {
        flags[flen++] = 'I';
    }
    if (key->block_permute) {
        flags[flen++] = 'P';
    }
    if (flen == 0) {
        flags[flen++] = '0';
    }
    flags[flen] = '\0';

    /* `${key.version}-${key.seed >>> 0}-${key.grid}-${flags}`; key->seed is
     * already a uint32_t so no extra masking is needed to match `>>> 0`. */
    written = snprintf(buf, buf_size, "WTV%d-%u-%d-%s", (int)key->version, (unsigned)key->seed, (int)key->grid,
                        flags);

    if (written < 0 || (size_t)written >= buf_size) {
        buf[0] = '\0';
        return false;
    }

    return true;
}

/* Scans a run of ASCII decimal digits starting at s[pos] (stopping at `end`
 * or the first non-digit), accumulating the value into a uint64_t with
 * saturating overflow detection (mirrors the fact that the JS reference
 * ultimately range-checks against uint32/positive-integer bounds anyway --
 * an overflowed value can never pass those checks, so saturating instead of
 * wrapping is what makes it reliably fail validation rather than aliasing
 * to some small in-range number). Returns the number of digit characters
 * consumed (0 means "no digits here", which callers treat as a shape
 * mismatch, matching the regex's `\d+` requiring at least one digit). */
static size_t scramble_scan_digits(const char *s, size_t pos, size_t end, uint64_t *out_value, bool *out_overflow)
{
    size_t start = pos;
    uint64_t value = 0;
    bool overflow = false;

    while (pos < end && s[pos] >= '0' && s[pos] <= '9') {
        unsigned digit = (unsigned)(s[pos] - '0');
        if (value > (UINT64_MAX - digit) / 10u) {
            overflow = true;
        } else {
            value = value * 10u + digit;
        }
        pos++;
    }

    *out_value = value;
    *out_overflow = overflow;
    return pos - start;
}

bool scramble_parse_master_string(const char *str, scramble_key_t *out_key, char *err_buf, size_t err_buf_size)
{
    size_t len, start, end, pos;
    size_t ndigits;
    uint64_t version_val, seed_val, grid_val;
    bool version_of, seed_of, grid_of;
    size_t flags_start, flags_len, i;
    scramble_key_t tmp;

    if (err_buf != NULL && err_buf_size > 0) {
        err_buf[0] = '\0';
    }

    if (str == NULL || out_key == NULL) {
        scramble_set_err(err_buf, err_buf_size, "master string must be a non-null string");
        return false;
    }

    len = strlen(str);

    /* str.trim() -- ASCII whitespace is all this grammar's alphabet needs. */
    start = 0;
    while (start < len && isspace((unsigned char)str[start])) {
        start++;
    }
    end = len;
    while (end > start && isspace((unsigned char)str[end - 1])) {
        end--;
    }

    /* Case-insensitive "WTV" prefix. */
    if (end - start < 3 || tolower((unsigned char)str[start]) != 'w' || tolower((unsigned char)str[start + 1]) != 't' ||
        tolower((unsigned char)str[start + 2]) != 'v') {
        scramble_set_err(err_buf, err_buf_size,
                          "not a valid master string (expected WTV1-<seed>-<grid>-<flags>): \"%.*s\"",
                          (int)(end - start), str + start);
        return false;
    }
    pos = start + 3;

    /* version = (\d+) */
    ndigits = scramble_scan_digits(str, pos, end, &version_val, &version_of);
    if (ndigits == 0) {
        scramble_set_err(err_buf, err_buf_size,
                          "not a valid master string (expected WTV1-<seed>-<grid>-<flags>): \"%.*s\"",
                          (int)(end - start), str + start);
        return false;
    }
    pos += ndigits;

    if (pos >= end || str[pos] != '-') {
        scramble_set_err(err_buf, err_buf_size,
                          "not a valid master string (expected WTV1-<seed>-<grid>-<flags>): \"%.*s\"",
                          (int)(end - start), str + start);
        return false;
    }
    pos++;

    /* seed = (\d+) */
    ndigits = scramble_scan_digits(str, pos, end, &seed_val, &seed_of);
    if (ndigits == 0) {
        scramble_set_err(err_buf, err_buf_size,
                          "not a valid master string (expected WTV1-<seed>-<grid>-<flags>): \"%.*s\"",
                          (int)(end - start), str + start);
        return false;
    }
    pos += ndigits;

    if (pos >= end || str[pos] != '-') {
        scramble_set_err(err_buf, err_buf_size,
                          "not a valid master string (expected WTV1-<seed>-<grid>-<flags>): \"%.*s\"",
                          (int)(end - start), str + start);
        return false;
    }
    pos++;

    /* grid = (\d+) */
    ndigits = scramble_scan_digits(str, pos, end, &grid_val, &grid_of);
    if (ndigits == 0) {
        scramble_set_err(err_buf, err_buf_size,
                          "not a valid master string (expected WTV1-<seed>-<grid>-<flags>): \"%.*s\"",
                          (int)(end - start), str + start);
        return false;
    }
    pos += ndigits;

    if (pos >= end || str[pos] != '-') {
        scramble_set_err(err_buf, err_buf_size,
                          "not a valid master string (expected WTV1-<seed>-<grid>-<flags>): \"%.*s\"",
                          (int)(end - start), str + start);
        return false;
    }
    pos++;

    /* flags = ([A-Za-z0-9]*) -- must consume the rest of the (trimmed)
     * string exactly; anything left over (a stray '-', punctuation, etc.)
     * is a shape mismatch, matching the regex's trailing `$` anchor. */
    flags_start = pos;
    while (pos < end && isalnum((unsigned char)str[pos])) {
        pos++;
    }
    flags_len = pos - flags_start;

    if (pos != end) {
        scramble_set_err(err_buf, err_buf_size,
                          "not a valid master string (expected WTV1-<seed>-<grid>-<flags>): \"%.*s\"",
                          (int)(end - start), str + start);
        return false;
    }

    /* --- semantic validation, mirrors parseMasterString() in reference.mjs --- */

    if (version_of || version_val != (uint64_t)SCRAMBLE_CONTRACT_VERSION) {
        scramble_set_err(err_buf, err_buf_size, "master string version %llu unsupported (this build expects %d)",
                          (unsigned long long)version_val, SCRAMBLE_CONTRACT_VERSION);
        return false;
    }

    if (seed_of || seed_val > 4294967295ULL) {
        scramble_set_err(err_buf, err_buf_size, "master string seed out of uint32 range: %llu",
                          (unsigned long long)seed_val);
        return false;
    }

    /* grid must be >= 1 (no explicit upper bound in the contract, but this
     * struct stores grid in an int32_t like the rest of this codebase's C
     * side -- e.g. scramble-filter.c's `int grid` -- so a value that
     * couldn't fit there is rejected here as a shape mismatch too, rather
     * than silently truncating/wrapping it). */
    if (grid_of || grid_val < 1 || grid_val > (uint64_t)INT32_MAX) {
        scramble_set_err(err_buf, err_buf_size, "master string grid must be >= 1: %llu",
                          (unsigned long long)grid_val);
        return false;
    }

    memset(&tmp, 0, sizeof(tmp));
    tmp.version = (int32_t)version_val;
    tmp.seed = (uint32_t)seed_val;
    tmp.grid = (int32_t)grid_val;
    tmp.flip_h = false;
    tmp.flip_v = false;
    tmp.invert = false;
    tmp.block_permute = false;

    /* if (flagsRaw !== "" && flagsRaw !== "0") { for (ch of flagsRaw) ... } */
    if (!(flags_len == 0 || (flags_len == 1 && str[flags_start] == '0'))) {
        for (i = flags_start; i < flags_start + flags_len; i++) {
            char c = (char)toupper((unsigned char)str[i]);

            if (c == 'H') {
                tmp.flip_h = true;
            } else if (c == 'V') {
                tmp.flip_v = true;
            } else if (c == 'I') {
                tmp.invert = true;
            } else if (c == 'P') {
                tmp.block_permute = true;
            } else {
                scramble_set_err(err_buf, err_buf_size,
                                  "unknown flag \"%c\" in master string (valid: H, V, I, P, or 0 for none)", str[i]);
                return false;
            }
        }
    }

    *out_key = tmp;
    return true;
}
