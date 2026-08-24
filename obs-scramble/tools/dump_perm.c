/*
 * dump_perm.c
 *
 * Standalone CLI, ZERO OBS/libobs dependencies, for cross-checking the C
 * Mulberry32 + Fisher-Yates permutation port (../src/scramble-permutation.c)
 * against the canonical JS reference (../../SPEC/reference.mjs) and the
 * golden fixture (../../test/perm-1337-9.json). See ../../SPEC/contract.md
 * before touching this or scramble-permutation.c.
 *
 * Build — no OBS SDK, no CMake needed, just a plain C compiler:
 *
 *   g++ -std=c++17 -O2 -o dump_perm tools/dump_perm.c src/scramble-permutation.c
 *     (or a C compiler instead of g++: this file and scramble-permutation.c
 *      are plain C99/C11, so `gcc`/`clang`/`cc` work equally well)
 *
 *   cl.exe /std:c11 /O2 tools\dump_perm.c src\scramble-permutation.c /Fe:dump_perm.exe
 *
 * Or via the project's CMakeLists.txt, which always configures/builds the
 * `obs-scramble-dump-perm` target regardless of whether the OBS SDK is
 * available (see ../CMakeLists.txt):
 *
 *   cmake -S . -B build
 *   cmake --build build --target obs-scramble-dump-perm
 *
 * Usage:
 *   dump_perm [--seed N] [--grid N] [--out path.json]
 *
 *   Defaults: --seed 1337 --grid 9, matching DEFAULT_KEY in
 *   SPEC/reference.mjs. Always prints the perm array as JSON
 *   (`JSON.stringify(perm, null, 2)`-equivalent formatting) to stdout; with
 *   --out, ALSO writes the same JSON to that path so it can be diffed
 *   byte-for-byte against test/perm-1337-9.json, e.g.:
 *
 *   ./dump_perm --seed 1337 --grid 9 --out ../../test/perm-1337-9-cpp.json
 *   diff ../../test/perm-1337-9.json ../../test/perm-1337-9-cpp.json
 *
 *   --dump-perm is accepted as a no-op flag: dumping perm is this tool's
 *   only mode (named per the task spec's "or a '--dump-perm' debug mode").
 *
 *   --selftest-master [path/to/master-strings.json]
 *
 *   Cross-language proof for the master-string port (scramble_encode_
 *   master_string / scramble_parse_master_string in
 *   ../src/scramble-permutation.c): encodes and parses every fixture in the
 *   given JSON file (default ../../test/master-strings.json, i.e. relative
 *   to this tool's usual `obs-scramble/` working directory) and asserts
 *   byte-identical results against the golden `master` string and `key`
 *   object, plus a set of malformed-input rejection checks. Prints a
 *   PASS/FAIL line per check and exits nonzero if anything failed. Ignores
 *   --seed/--grid/--out (does not touch perm dumping in this mode).
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <stdbool.h>
#include <ctype.h>

#include "../src/scramble-permutation.h"

static void write_perm_json(FILE *f, const uint32_t *perm, int64_t n)
{
    int64_t i;
    fprintf(f, "[\n");
    for (i = 0; i < n; i++) {
        fprintf(f, "  %u%s\n", (unsigned)perm[i], (i + 1 < n) ? "," : "");
    }
    fprintf(f, "]\n");
}

/* ------------------------------------------------------------------------
 * --selftest-master: cross-language proof that scramble_encode_master_string
 * / scramble_parse_master_string (src/scramble-permutation.c) byte-for-byte
 * match encodeMasterString/parseMasterString in SPEC/reference.mjs, using
 * the same golden fixtures test/roundtrip.mjs checks against:
 * test/master-strings.json. See SPEC/contract.md "Master string".
 *
 * This is a tiny, purpose-built JSON reader for this ONE fixture file's
 * shape -- not a general JSON parser -- but it locates fields by name
 * (rather than assuming a fixed key order) via brace-matched sub-object
 * extraction, so it tolerates re-ordered/re-formatted fixture JSON as long
 * as the field names and array-of-objects shape stay the same.
 * ------------------------------------------------------------------------ */

/* Reads the whole file at `path` into a malloc'd, NUL-terminated buffer.
 * Returns NULL on any I/O error. Caller must free() the result. */
static char *selftest_read_file(const char *path)
{
    FILE *f;
    long size;
    char *buf;
    size_t nread;

    f = fopen(path, "rb");
    if (f == NULL) {
        fprintf(stderr, "error: could not open %s for reading\n", path);
        return NULL;
    }

    if (fseek(f, 0, SEEK_END) != 0) {
        fclose(f);
        return NULL;
    }
    size = ftell(f);
    if (size < 0) {
        fclose(f);
        return NULL;
    }
    rewind(f);

    buf = (char *)malloc((size_t)size + 1);
    if (buf == NULL) {
        fclose(f);
        return NULL;
    }

    nread = fread(buf, 1, (size_t)size, f);
    fclose(f);
    buf[nread] = '\0';
    return buf;
}

/* Finds the index of the '}' that matches the '{' at s[open_idx], scanning
 * s[0..len). Correctly skips over braces that appear inside JSON string
 * literals (honoring backslash escapes) even though this particular fixture
 * file never puts one there. Returns `len` (an invalid/unmatched sentinel)
 * if no match is found before the end of the buffer. */
static size_t selftest_find_matching_brace(const char *s, size_t open_idx, size_t len)
{
    int depth = 0;
    bool in_str = false;
    size_t i;

    for (i = open_idx; i < len; i++) {
        char c = s[i];
        if (in_str) {
            if (c == '\\') {
                i++; /* skip the escaped character too */
                continue;
            }
            if (c == '"') {
                in_str = false;
            }
            continue;
        }
        if (c == '"') {
            in_str = true;
        } else if (c == '{') {
            depth++;
        } else if (c == '}') {
            depth--;
            if (depth == 0) {
                return i;
            }
        }
    }
    return len;
}

/* Finds `"field_name"` inside the NUL-terminated string `obj`, then returns
 * a pointer just past the ':' that must follow it (skipping whitespace).
 * Returns NULL if the field isn't present. */
static const char *selftest_field_value(const char *obj, const char *field_name)
{
    char needle[64];
    const char *p;
    const char *colon;

    snprintf(needle, sizeof(needle), "\"%s\"", field_name);
    p = strstr(obj, needle);
    if (p == NULL) {
        return NULL;
    }
    colon = strchr(p, ':');
    if (colon == NULL) {
        return NULL;
    }
    colon++;
    while (*colon != '\0' && isspace((unsigned char)*colon)) {
        colon++;
    }
    return colon;
}

static bool selftest_field_uint64(const char *obj, const char *field_name, uint64_t *out)
{
    const char *v = selftest_field_value(obj, field_name);
    char *endptr;

    if (v == NULL) {
        return false;
    }
    *out = strtoull(v, &endptr, 10);
    return endptr != v;
}

static bool selftest_field_int32(const char *obj, const char *field_name, int32_t *out)
{
    const char *v = selftest_field_value(obj, field_name);
    char *endptr;
    long val;

    if (v == NULL) {
        return false;
    }
    val = strtol(v, &endptr, 10);
    if (endptr == v) {
        return false;
    }
    *out = (int32_t)val;
    return true;
}

static bool selftest_field_bool(const char *obj, const char *field_name, bool *out)
{
    const char *v = selftest_field_value(obj, field_name);

    if (v == NULL) {
        return false;
    }
    if (strncmp(v, "true", 4) == 0) {
        *out = true;
        return true;
    }
    if (strncmp(v, "false", 5) == 0) {
        *out = false;
        return true;
    }
    return false;
}

/* Copies the quoted string value of `field_name` (e.g. "master") out of
 * `obj` into out_buf (NUL-terminated, truncated to out_buf_size). No
 * backslash-escape decoding is needed/attempted: master strings are always
 * plain [A-Za-z0-9-] with no characters that would ever need escaping. */
static bool selftest_field_string(const char *obj, const char *field_name, char *out_buf, size_t out_buf_size)
{
    const char *v = selftest_field_value(obj, field_name);
    const char *close;
    size_t n;

    if (v == NULL || *v != '"') {
        return false;
    }
    v++;
    close = strchr(v, '"');
    if (close == NULL) {
        return false;
    }
    n = (size_t)(close - v);
    if (n >= out_buf_size) {
        n = out_buf_size - 1;
    }
    memcpy(out_buf, v, n);
    out_buf[n] = '\0';
    return true;
}

/* Parses one fixture object (the "key": {...} sub-object plus the sibling
 * "master" string) into a scramble_key_t + master string buffer. Returns
 * true on success. */
static bool selftest_parse_fixture(const char *obj_str, scramble_key_t *out_key, char *master_buf,
                                    size_t master_buf_size)
{
    const char *key_p;
    const char *key_brace;
    size_t key_open_idx, key_close_idx;
    char *key_str;
    size_t key_len;
    bool ok = true;
    uint64_t seed64;
    int32_t grid32, version32;
    bool flip_h, flip_v, invert, block_permute;

    key_p = strstr(obj_str, "\"key\"");
    if (key_p == NULL) {
        fprintf(stderr, "error: fixture missing \"key\" object\n");
        return false;
    }
    key_brace = strchr(key_p, '{');
    if (key_brace == NULL) {
        fprintf(stderr, "error: fixture \"key\" is not an object\n");
        return false;
    }
    key_open_idx = (size_t)(key_brace - obj_str);
    key_close_idx = selftest_find_matching_brace(obj_str, key_open_idx, strlen(obj_str));
    if (key_close_idx >= strlen(obj_str)) {
        fprintf(stderr, "error: fixture \"key\" object has no matching '}'\n");
        return false;
    }

    key_len = key_close_idx - key_open_idx + 1;
    key_str = (char *)malloc(key_len + 1);
    if (key_str == NULL) {
        return false;
    }
    memcpy(key_str, obj_str + key_open_idx, key_len);
    key_str[key_len] = '\0';

    ok = ok && selftest_field_uint64(key_str, "seed", &seed64);
    ok = ok && selftest_field_int32(key_str, "grid", &grid32);
    ok = ok && selftest_field_bool(key_str, "flipH", &flip_h);
    ok = ok && selftest_field_bool(key_str, "flipV", &flip_v);
    ok = ok && selftest_field_bool(key_str, "invert", &invert);
    ok = ok && selftest_field_bool(key_str, "blockPermute", &block_permute);
    ok = ok && selftest_field_int32(key_str, "version", &version32);

    free(key_str);

    if (!ok) {
        fprintf(stderr, "error: fixture \"key\" object is missing/malformed a field\n");
        return false;
    }

    memset(out_key, 0, sizeof(*out_key));
    out_key->seed = (uint32_t)seed64;
    out_key->grid = grid32;
    out_key->flip_h = flip_h;
    out_key->flip_v = flip_v;
    out_key->invert = invert;
    out_key->block_permute = block_permute;
    out_key->version = version32;

    if (!selftest_field_string(obj_str, "master", master_buf, master_buf_size)) {
        fprintf(stderr, "error: fixture missing/malformed \"master\" string\n");
        return false;
    }

    return true;
}

static bool scramble_key_equal(const scramble_key_t *a, const scramble_key_t *b)
{
    return a->seed == b->seed && a->grid == b->grid && a->flip_h == b->flip_h && a->flip_v == b->flip_v &&
           a->invert == b->invert && a->block_permute == b->block_permute && a->version == b->version;
}

/* Runs the actual "must match SPEC/reference.mjs byte-for-byte" checks
 * (encode(fixture.key) === fixture.master, and parse(fixture.master) ===
 * fixture.key) for every fixture in test/master-strings.json, plus a set of
 * malformed-input rejection checks mirroring test/roundtrip.mjs's "master
 * string parse rejects garbage loudly" check. Prints a PASS/FAIL line per
 * check and returns the number of failures (0 == all good). */
static int selftest_run_master(const char *fixtures_path)
{
    char *content;
    size_t len;
    size_t array_start;
    size_t i;
    int total = 0;
    int failures = 0;

    /* Malformed master strings that must be rejected -- mirrors
     * test/roundtrip.mjs's "master string parse rejects garbage loudly". */
    static const char *bad_inputs[] = {
        "WTV2-1337-9-HIP",       /* wrong version */
        "WTV1-1337-9-X",         /* unknown flag */
        "WTV1-1337-9-H0P",       /* 0 mixed with letters */
        "WTV1--9-HIP",           /* missing seed */
        "WTV1-1337-0-HIP",       /* grid < 1 */
        "WTV1-4294967296-9-HIP", /* seed > uint32 */
        "WTV1-1337-9-HIP-extra", /* trailing junk */
        "hello",                 /* not even close */
        "",                      /* empty */
    };

    content = selftest_read_file(fixtures_path);
    if (content == NULL) {
        return 1;
    }
    len = strlen(content);

    {
        const char *bracket = strchr(content, '[');
        if (bracket == NULL) {
            fprintf(stderr, "error: %s does not contain a top-level JSON array\n", fixtures_path);
            free(content);
            return 1;
        }
        array_start = (size_t)(bracket - content);
    }

    printf("--selftest-master: reading fixtures from %s\n", fixtures_path);

    i = array_start + 1;
    while (i < len) {
        while (i < len && (isspace((unsigned char)content[i]) || content[i] == ',')) {
            i++;
        }
        if (i >= len || content[i] == ']') {
            break;
        }
        if (content[i] != '{') {
            fprintf(stderr, "error: expected '{' or ']' in fixtures array at offset %zu\n", i);
            failures++;
            break;
        }

        {
            size_t close_idx = selftest_find_matching_brace(content, i, len);
            size_t obj_len;
            char *obj_str;
            scramble_key_t fixture_key;
            char fixture_master[256];

            if (close_idx >= len) {
                fprintf(stderr, "error: unterminated fixture object at offset %zu\n", i);
                failures++;
                break;
            }

            obj_len = close_idx - i + 1;
            obj_str = (char *)malloc(obj_len + 1);
            if (obj_str == NULL) {
                fprintf(stderr, "error: out of memory\n");
                free(content);
                return 1;
            }
            memcpy(obj_str, content + i, obj_len);
            obj_str[obj_len] = '\0';

            total++;
            if (!selftest_parse_fixture(obj_str, &fixture_key, fixture_master, sizeof(fixture_master))) {
                fprintf(stderr, "FAIL  fixture #%d: could not parse fixture JSON\n", total);
                failures++;
            } else {
                char encoded[SCRAMBLE_MASTER_STRING_BUF_SIZE];
                bool encode_ok = scramble_encode_master_string(&fixture_key, encoded, sizeof(encoded));
                bool this_ok = true;

                if (!encode_ok) {
                    fprintf(stderr, "FAIL  fixture #%d (%s): scramble_encode_master_string() failed\n", total,
                            fixture_master);
                    this_ok = false;
                } else if (strcmp(encoded, fixture_master) != 0) {
                    fprintf(stderr,
                            "FAIL  fixture #%d: encode mismatch: C produced \"%s\", golden expects \"%s\"\n", total,
                            encoded, fixture_master);
                    this_ok = false;
                }

                {
                    scramble_key_t parsed;
                    char err[256];
                    bool parse_ok = scramble_parse_master_string(fixture_master, &parsed, err, sizeof(err));

                    if (!parse_ok) {
                        fprintf(stderr, "FAIL  fixture #%d (%s): scramble_parse_master_string() failed: %s\n", total,
                                fixture_master, err);
                        this_ok = false;
                    } else if (!scramble_key_equal(&parsed, &fixture_key)) {
                        fprintf(stderr,
                                "FAIL  fixture #%d (%s): parsed key does not match golden key "
                                "(seed=%u grid=%d H=%d V=%d I=%d P=%d ver=%d)\n",
                                total, fixture_master, (unsigned)parsed.seed, parsed.grid, parsed.flip_h,
                                parsed.flip_v, parsed.invert, parsed.block_permute, parsed.version);
                        this_ok = false;
                    }
                }

                if (this_ok) {
                    printf("PASS  fixture #%d: %s (encode + parse round-trip match golden)\n", total, fixture_master);
                } else {
                    failures++;
                }
            }

            free(obj_str);
            i = close_idx + 1;
        }
    }

    if (total == 0) {
        fprintf(stderr, "error: no fixtures found in %s\n", fixtures_path);
        failures++;
    }

    /* Loud-reject checks: every entry in bad_inputs[] must fail to parse. */
    for (i = 0; i < sizeof(bad_inputs) / sizeof(bad_inputs[0]); i++) {
        scramble_key_t discard;
        char err[256];
        bool parse_ok = scramble_parse_master_string(bad_inputs[i], &discard, err, sizeof(err));

        total++;
        if (parse_ok) {
            fprintf(stderr, "FAIL  garbage-rejection #%zu: \"%s\" should have been rejected but parsed successfully\n",
                    i, bad_inputs[i]);
            failures++;
        } else {
            printf("PASS  garbage-rejection #%zu: \"%s\" correctly rejected (%s)\n", i, bad_inputs[i], err);
        }
    }

    free(content);

    printf("\n--selftest-master: %d/%d checks passed\n", total - failures, total);
    return failures > 0 ? 1 : 0;
}

int main(int argc, char **argv)
{
    uint32_t seed = 1337;
    int grid = 9;
    const char *out_path = NULL;
    const char *selftest_master_path = NULL;
    bool do_selftest_master = false;
    int i;
    int64_t n;
    uint32_t *perm;
    uint32_t *inv;
    int rc;

    for (i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--seed") == 0 && i + 1 < argc) {
            seed = (uint32_t)strtoul(argv[++i], NULL, 10);
        } else if (strcmp(argv[i], "--grid") == 0 && i + 1 < argc) {
            grid = atoi(argv[++i]);
        } else if (strcmp(argv[i], "--out") == 0 && i + 1 < argc) {
            out_path = argv[++i];
        } else if (strcmp(argv[i], "--dump-perm") == 0) {
            /* default (and only) mode; accepted as a no-op for spec parity */
        } else if (strcmp(argv[i], "--selftest-master") == 0) {
            do_selftest_master = true;
            /* optional positional path argument right after the flag */
            if (i + 1 < argc && strncmp(argv[i + 1], "--", 2) != 0) {
                selftest_master_path = argv[++i];
            }
        } else if (strcmp(argv[i], "--help") == 0 || strcmp(argv[i], "-h") == 0) {
            fprintf(stderr,
                    "usage: %s [--seed N] [--grid N] [--out path.json]\n"
                    "       %s --selftest-master [path/to/master-strings.json]\n",
                    argv[0], argv[0]);
            return 0;
        } else {
            fprintf(stderr, "unrecognized argument: %s (see --help)\n", argv[i]);
            return 2;
        }
    }

    if (do_selftest_master) {
        return selftest_run_master(selftest_master_path != NULL ? selftest_master_path
                                                                  : "../../test/master-strings.json");
    }

    if (grid <= 0) {
        fprintf(stderr, "error: --grid must be a positive integer, got %d\n", grid);
        return 1;
    }

    n = (int64_t)grid * (int64_t)grid;

    perm = (uint32_t *)malloc((size_t)n * sizeof(uint32_t));
    inv = (uint32_t *)malloc((size_t)n * sizeof(uint32_t));
    if (perm == NULL || inv == NULL) {
        fprintf(stderr, "error: out of memory for grid=%d (n=%lld)\n", grid, (long long)n);
        free(perm);
        free(inv);
        return 1;
    }

    rc = scramble_build_permutation(seed, grid, perm, inv);
    if (rc != 0) {
        fprintf(stderr, "error: scramble_build_permutation failed (seed=%u grid=%d)\n", seed, grid);
        free(perm);
        free(inv);
        return 1;
    }

    write_perm_json(stdout, perm, n);

    if (out_path != NULL) {
        FILE *f = fopen(out_path, "wb");
        if (f == NULL) {
            fprintf(stderr, "error: could not open %s for writing\n", out_path);
            free(perm);
            free(inv);
            return 1;
        }
        write_perm_json(f, perm, n);
        fclose(f);
        fprintf(stderr, "wrote %s\n", out_path);
    }

    free(perm);
    free(inv);
    return 0;
}
