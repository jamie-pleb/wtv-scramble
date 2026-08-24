/*
 * scramble-filter.c
 *
 * OBS video filter "scramble_filter": applies flip / color-invert /
 * 9x9 (configurable) block-permutation to its target source, using the
 * exact key format and math defined in ../../SPEC/contract.md.
 *
 * This filter only ever SCRAMBLES (source -> scrambled output); the
 * inverse is applied by a separate browser userscript against the
 * broadcaster's outgoing video. See ../../SPEC/contract.md's
 * "Which array does which renderer use?" section: this shader needs INV
 * (not perm) for its block-permute step. Getting that backwards produces a
 * picture that is STILL SCRAMBLED (just differently), not an obvious
 * crash — so the permutation math here is a byte-for-byte port of
 * scramble-permutation.c, itself a verbatim port of the contract's
 * canonical C++ listing. Do not "simplify" it.
 */

#include "scramble-filter.h"
#include "scramble-permutation.h"

#include <graphics/graphics.h>
#include <util/bmem.h>

#include <stdint.h>
#include <string.h>

#define SCRAMBLE_EFFECT_FILE "scramble.effect"

#define S_SEED          "seed"
#define S_GRID          "grid"
#define S_FLIP_H        "flip_h"
#define S_FLIP_V        "flip_v"
#define S_INVERT        "invert"
#define S_BLOCK_PERMUTE "block_permute"
#define S_MASTER_STRING "master_string"

/* Default key, per SPEC/contract.md:
 *   { seed: 1337, grid: 9, flipH: true, flipV: false, invert: true,
 *     blockPermute: true, version: 1 } */
#define DEFAULT_SEED 1337
#define DEFAULT_GRID 9
#define DEFAULT_FLIP_H true
#define DEFAULT_FLIP_V false
#define DEFAULT_INVERT true
#define DEFAULT_BLOCK_PERMUTE true

/* OBS's obs_properties_add_int() takes `int` (32-bit signed) min/max, so
 * the UI slider/spinbox for `seed` cannot reach the full uint32 range the
 * key format allows (uint32 max is 4294967295, INT32_MAX is 2147483647).
 * Values above INT32_MAX are still fully valid seeds and can be set
 * programmatically (e.g. via obs_data_set_int, or OBS's scripting APIs,
 * which store this as a 64-bit integer) — just not from this properties
 * dialog. See README.md "Known limitations". */
#define SEED_UI_MAX 2147483647

struct scramble_filter_data {
    obs_source_t *context;

    gs_effect_t *effect;
    gs_eparam_t *param_grid;
    gs_eparam_t *param_frame_size;
    gs_eparam_t *param_flip_h;
    gs_eparam_t *param_flip_v;
    gs_eparam_t *param_invert;
    gs_eparam_t *param_block_permute;
    gs_eparam_t *param_inv_tex;
    gs_eparam_t *param_perm_tex;

    /* grid x grid, single-channel GS_R32F LUT textures storing tile
     * indices as floats (see scramble_filter_rebuild_lut()). Both are
     * uploaded for parity with the contract's "both sides should compute
     * both perm and inv for clarity" note, even though this scramble-only
     * shader currently samples only inv_tex for its block-permute step. */
    gs_texture_t *inv_tex;
    gs_texture_t *perm_tex;

    uint32_t seed;
    int grid;
    bool flip_h;
    bool flip_v;
    bool invert;
    bool block_permute;
};

/* ------------------------------------------------------------------ */
/* Properties / settings                                               */
/* ------------------------------------------------------------------ */

static const char *scramble_filter_get_name(void *unused)
{
    UNUSED_PARAMETER(unused);
    return obs_module_text("ScrambleFilter");
}

static void scramble_filter_get_defaults(obs_data_t *settings)
{
    scramble_key_t default_key;
    char default_master[SCRAMBLE_MASTER_STRING_BUF_SIZE];

    obs_data_set_default_int(settings, S_SEED, DEFAULT_SEED);
    obs_data_set_default_int(settings, S_GRID, DEFAULT_GRID);
    obs_data_set_default_bool(settings, S_FLIP_H, DEFAULT_FLIP_H);
    obs_data_set_default_bool(settings, S_FLIP_V, DEFAULT_FLIP_V);
    obs_data_set_default_bool(settings, S_INVERT, DEFAULT_INVERT);
    obs_data_set_default_bool(settings, S_BLOCK_PERMUTE, DEFAULT_BLOCK_PERMUTE);

    /* Default master string, per SPEC/contract.md: "Default key = WTV1-1337-9-HIP".
     * Computed via the same encode function used everywhere else rather
     * than hardcoded, so it can never drift out of sync with DEFAULT_*
     * above. */
    default_key.seed = (uint32_t)DEFAULT_SEED;
    default_key.grid = (int32_t)DEFAULT_GRID;
    default_key.flip_h = DEFAULT_FLIP_H;
    default_key.flip_v = DEFAULT_FLIP_V;
    default_key.invert = DEFAULT_INVERT;
    default_key.block_permute = DEFAULT_BLOCK_PERMUTE;
    default_key.version = SCRAMBLE_CONTRACT_VERSION;

    if (scramble_encode_master_string(&default_key, default_master, sizeof(default_master))) {
        obs_data_set_default_string(settings, S_MASTER_STRING, default_master);
    }
}

/* ------------------------------------------------------------------ */
/* Master String: two-way sync between seed/grid/flags and the compact  */
/* "WTV1-<seed>-<grid>-<flags>" text field. See SPEC/contract.md        */
/* "Master string" and scramble-permutation.h.                          */
/* ------------------------------------------------------------------ */

static void scramble_filter_key_from_settings(obs_data_t *settings, scramble_key_t *key)
{
    key->seed = (uint32_t)obs_data_get_int(settings, S_SEED);
    key->grid = (int32_t)obs_data_get_int(settings, S_GRID);
    key->flip_h = obs_data_get_bool(settings, S_FLIP_H);
    key->flip_v = obs_data_get_bool(settings, S_FLIP_V);
    key->invert = obs_data_get_bool(settings, S_INVERT);
    key->block_permute = obs_data_get_bool(settings, S_BLOCK_PERMUTE);
    key->version = SCRAMBLE_CONTRACT_VERSION;
}

/* Regenerates the canonical master string from settings' current
 * seed/grid/flag fields and writes it into S_MASTER_STRING -- but only if
 * it actually differs from what's already stored there, both to avoid
 * needless properties-dialog churn and to keep this safe to call from
 * anywhere (including from within scramble_filter_apply_master_to_fields()
 * below) without ping-ponging. Returns true iff the stored string changed,
 * so a modified callback can report "needs UI refresh" accordingly. Leaves
 * the field untouched if the current fields don't form a valid key (e.g.
 * grid temporarily 0 mid-edit) rather than clobbering it with garbage. */
static bool scramble_filter_sync_master_from_fields(obs_data_t *settings)
{
    scramble_key_t key;
    char buf[SCRAMBLE_MASTER_STRING_BUF_SIZE];
    const char *current;

    scramble_filter_key_from_settings(settings, &key);

    if (!scramble_encode_master_string(&key, buf, sizeof(buf))) {
        return false;
    }

    current = obs_data_get_string(settings, S_MASTER_STRING);
    if (current != NULL && strcmp(current, buf) == 0) {
        return false;
    }

    obs_data_set_string(settings, S_MASTER_STRING, buf);
    return true;
}

/* Parses S_MASTER_STRING out of settings; on success, applies its
 * seed/grid/flags back onto the individual fields (only writing the ones
 * that actually changed) and re-canonicalizes the displayed string (so a
 * pasted "wtv1-1337-9-pih" normalizes to "WTV1-1337-9-HIP"). On a parse
 * failure, settings are left COMPLETELY untouched -- never clobber a
 * working config with garbage pasted into the box -- and a clear warning is
 * logged. Returns true iff anything in settings changed. */
static bool scramble_filter_apply_master_to_fields(obs_data_t *settings)
{
    const char *raw = obs_data_get_string(settings, S_MASTER_STRING);
    scramble_key_t key;
    char err[256];
    bool changed = false;

    if (!scramble_parse_master_string(raw, &key, err, sizeof(err))) {
        blog(LOG_WARNING, "[obs-scramble] ignoring invalid master string \"%s\": %s", raw ? raw : "(null)", err);
        return false;
    }

    if ((uint32_t)obs_data_get_int(settings, S_SEED) != key.seed) {
        obs_data_set_int(settings, S_SEED, (long long)key.seed);
        changed = true;
    }
    if ((int32_t)obs_data_get_int(settings, S_GRID) != key.grid) {
        obs_data_set_int(settings, S_GRID, (long long)key.grid);
        changed = true;
    }
    if (obs_data_get_bool(settings, S_FLIP_H) != key.flip_h) {
        obs_data_set_bool(settings, S_FLIP_H, key.flip_h);
        changed = true;
    }
    if (obs_data_get_bool(settings, S_FLIP_V) != key.flip_v) {
        obs_data_set_bool(settings, S_FLIP_V, key.flip_v);
        changed = true;
    }
    if (obs_data_get_bool(settings, S_INVERT) != key.invert) {
        obs_data_set_bool(settings, S_INVERT, key.invert);
        changed = true;
    }
    if (obs_data_get_bool(settings, S_BLOCK_PERMUTE) != key.block_permute) {
        obs_data_set_bool(settings, S_BLOCK_PERMUTE, key.block_permute);
        changed = true;
    }

    if (scramble_filter_sync_master_from_fields(settings)) {
        changed = true;
    }

    return changed;
}

/* obs_property_modified_t callback for S_SEED/S_GRID/S_FLIP_H/S_FLIP_V/
 * S_INVERT/S_BLOCK_PERMUTE: whenever one of those changes in the properties
 * dialog, regenerate the Master String field to match. */
static bool scramble_filter_field_modified(obs_properties_t *props, obs_property_t *property, obs_data_t *settings)
{
    UNUSED_PARAMETER(props);
    UNUSED_PARAMETER(property);
    return scramble_filter_sync_master_from_fields(settings);
}

/* obs_property_modified_t callback for S_MASTER_STRING: whenever the user
 * finishes editing (pastes a key and tabs/clicks away -- OBS text
 * properties fire their modified callback on editingFinished, not on every
 * keystroke), parse it and, if valid, apply it to the other fields. */
static bool scramble_filter_master_modified(obs_properties_t *props, obs_property_t *property, obs_data_t *settings)
{
    UNUSED_PARAMETER(props);
    UNUSED_PARAMETER(property);
    return scramble_filter_apply_master_to_fields(settings);
}

static obs_properties_t *scramble_filter_get_properties(void *data)
{
    obs_properties_t *props;
    obs_property_t *p;

    UNUSED_PARAMETER(data);

    props = obs_properties_create();

    p = obs_properties_add_int(props, S_SEED, obs_module_text("Seed"), 0, SEED_UI_MAX, 1);
    obs_property_set_modified_callback(p, scramble_filter_field_modified);

    p = obs_properties_add_int(props, S_GRID, obs_module_text("GridSize"), 1, 64, 1);
    obs_property_set_modified_callback(p, scramble_filter_field_modified);

    p = obs_properties_add_bool(props, S_FLIP_H, obs_module_text("FlipHorizontal"));
    obs_property_set_modified_callback(p, scramble_filter_field_modified);

    p = obs_properties_add_bool(props, S_FLIP_V, obs_module_text("FlipVertical"));
    obs_property_set_modified_callback(p, scramble_filter_field_modified);

    p = obs_properties_add_bool(props, S_INVERT, obs_module_text("InvertColors"));
    obs_property_set_modified_callback(p, scramble_filter_field_modified);

    p = obs_properties_add_bool(props, S_BLOCK_PERMUTE, obs_module_text("BlockPermute"));
    obs_property_set_modified_callback(p, scramble_filter_field_modified);

    /* Two-way: editing any field above regenerates this; pasting a valid
     * key here applies it to all the fields above. See SPEC/contract.md
     * "Master string". */
    p = obs_properties_add_text(props, S_MASTER_STRING, obs_module_text("MasterString"), OBS_TEXT_DEFAULT);
    obs_property_set_modified_callback(p, scramble_filter_master_modified);

    return props;
}

/* ------------------------------------------------------------------ */
/* Permutation LUT upload                                              */
/* ------------------------------------------------------------------ */

/* (Re)allocates *tex if needed and uploads `data` (grid*grid floats) into
 * it, preferring gs_texture_create()+gs_texture_set_image() over packing
 * values into uniform arrays (simpler and more robust across OBS's
 * effect-file dialect than large uniform arrays). Must be called between
 * obs_enter_graphics()/obs_leave_graphics(). */
static void scramble_filter_upload_lut(gs_texture_t **tex, int grid, const float *data)
{
    bool need_create = true;

    if (*tex != NULL) {
        if (gs_texture_get_width(*tex) == (uint32_t)grid && gs_texture_get_height(*tex) == (uint32_t)grid) {
            need_create = false;
        } else {
            gs_texture_destroy(*tex);
            *tex = NULL;
        }
    }

    if (need_create) {
        *tex = gs_texture_create((uint32_t)grid, (uint32_t)grid, GS_R32F, 1, NULL, GS_DYNAMIC);
    }

    if (*tex != NULL) {
        gs_texture_set_image(*tex, (const uint8_t *)data, (uint32_t)grid * (uint32_t)sizeof(float), false);
    }
}

/* Rebuilds perm/inv for the current seed+grid (using the exact
 * Mulberry32/Fisher-Yates code in scramble-permutation.c — do not
 * reimplement that differently here) and re-uploads both LUT textures.
 * Guards against grid <= 0. */
static void scramble_filter_rebuild_lut(struct scramble_filter_data *filter)
{
    int grid = filter->grid;
    int64_t n;
    int64_t i;
    uint32_t *perm_u32 = NULL;
    uint32_t *inv_u32 = NULL;
    float *perm_f = NULL;
    float *inv_f = NULL;

    if (grid <= 0) {
        blog(LOG_WARNING,
             "[obs-scramble] grid must be a positive integer, got %d; "
             "filter will pass video through unmodified until fixed",
             grid);
        obs_enter_graphics();
        if (filter->inv_tex) {
            gs_texture_destroy(filter->inv_tex);
            filter->inv_tex = NULL;
        }
        if (filter->perm_tex) {
            gs_texture_destroy(filter->perm_tex);
            filter->perm_tex = NULL;
        }
        obs_leave_graphics();
        return;
    }

    n = (int64_t)grid * (int64_t)grid;

    perm_u32 = bmalloc((size_t)n * sizeof(uint32_t));
    inv_u32 = bmalloc((size_t)n * sizeof(uint32_t));

    if (scramble_build_permutation(filter->seed, grid, perm_u32, inv_u32) != 0) {
        blog(LOG_WARNING, "[obs-scramble] scramble_build_permutation failed (seed=%u grid=%d)", filter->seed, grid);
        bfree(perm_u32);
        bfree(inv_u32);
        return;
    }

    perm_f = bmalloc((size_t)n * sizeof(float));
    inv_f = bmalloc((size_t)n * sizeof(float));
    for (i = 0; i < n; i++) {
        perm_f[i] = (float)perm_u32[i];
        inv_f[i] = (float)inv_u32[i];
    }

    obs_enter_graphics();
    scramble_filter_upload_lut(&filter->perm_tex, grid, perm_f);
    scramble_filter_upload_lut(&filter->inv_tex, grid, inv_f);
    obs_leave_graphics();

    bfree(perm_u32);
    bfree(inv_u32);
    bfree(perm_f);
    bfree(inv_f);
}

static void scramble_filter_update(void *data, obs_data_t *settings)
{
    struct scramble_filter_data *filter = data;

    /* obs_data ints are stored as int64; seed is conceptually uint32 (see
     * SEED_UI_MAX above for the properties-dialog range limitation). */
    filter->seed = (uint32_t)obs_data_get_int(settings, S_SEED);
    filter->grid = (int)obs_data_get_int(settings, S_GRID);
    filter->flip_h = obs_data_get_bool(settings, S_FLIP_H);
    filter->flip_v = obs_data_get_bool(settings, S_FLIP_V);
    filter->invert = obs_data_get_bool(settings, S_INVERT);
    filter->block_permute = obs_data_get_bool(settings, S_BLOCK_PERMUTE);

    /* Keep the Master String field in sync even when settings changed via
     * a path other than the properties dialog's own modified callbacks
     * (initial filter creation/load from disk, scripting API, filter
     * copy/paste, etc.) -- those never fire obs_property_modified_t
     * callbacks, which only run for live edits inside an open properties
     * dialog. */
    scramble_filter_sync_master_from_fields(settings);

    scramble_filter_rebuild_lut(filter);
}

/* ------------------------------------------------------------------ */
/* Lifecycle                                                            */
/* ------------------------------------------------------------------ */

static void *scramble_filter_create(obs_data_t *settings, obs_source_t *context)
{
    struct scramble_filter_data *filter = bzalloc(sizeof(struct scramble_filter_data));
    char *effect_path;

    filter->context = context;

    effect_path = obs_module_file(SCRAMBLE_EFFECT_FILE);

    obs_enter_graphics();
    filter->effect = effect_path ? gs_effect_create_from_file(effect_path, NULL) : NULL;
    obs_leave_graphics();

    bfree(effect_path);

    if (!filter->effect) {
        blog(LOG_ERROR, "[obs-scramble] failed to load " SCRAMBLE_EFFECT_FILE " (check data/ install path)");
        bfree(filter);
        return NULL;
    }

    filter->param_grid = gs_effect_get_param_by_name(filter->effect, "grid");
    filter->param_frame_size = gs_effect_get_param_by_name(filter->effect, "frame_size");
    filter->param_flip_h = gs_effect_get_param_by_name(filter->effect, "flip_h");
    filter->param_flip_v = gs_effect_get_param_by_name(filter->effect, "flip_v");
    filter->param_invert = gs_effect_get_param_by_name(filter->effect, "do_invert");
    filter->param_block_permute = gs_effect_get_param_by_name(filter->effect, "block_permute");
    filter->param_inv_tex = gs_effect_get_param_by_name(filter->effect, "inv_tex");
    filter->param_perm_tex = gs_effect_get_param_by_name(filter->effect, "perm_tex");

    scramble_filter_update(filter, settings);

    return filter;
}

static void scramble_filter_destroy(void *data)
{
    struct scramble_filter_data *filter = data;

    obs_enter_graphics();
    if (filter->inv_tex)
        gs_texture_destroy(filter->inv_tex);
    if (filter->perm_tex)
        gs_texture_destroy(filter->perm_tex);
    if (filter->effect)
        gs_effect_destroy(filter->effect);
    obs_leave_graphics();

    bfree(filter);
}

static void scramble_filter_video_tick(void *data, float seconds)
{
    /* No time-based state to advance (the permutation is fully determined
     * by seed+grid, recomputed only on settings update). Present because
     * this filter provides video_render and the properties spec calls for
     * a video_tick callback; kept as a documented no-op hook for future
     * per-frame bookkeeping (e.g. an animated/rotating seed). */
    UNUSED_PARAMETER(data);
    UNUSED_PARAMETER(seconds);
}

/* ------------------------------------------------------------------ */
/* Rendering                                                            */
/* ------------------------------------------------------------------ */

static uint32_t scramble_filter_get_width(void *data)
{
    struct scramble_filter_data *filter = data;
    obs_source_t *target = obs_filter_get_target(filter->context);
    return target ? obs_source_get_base_width(target) : 0;
}

static uint32_t scramble_filter_get_height(void *data)
{
    struct scramble_filter_data *filter = data;
    obs_source_t *target = obs_filter_get_target(filter->context);
    return target ? obs_source_get_base_height(target) : 0;
}

static void scramble_filter_video_render(void *data, gs_effect_t *effect_param)
{
    struct scramble_filter_data *filter = data;
    uint32_t width;
    uint32_t height;
    struct vec2 frame_size;

    UNUSED_PARAMETER(effect_param);

    /* Guard against grid <= 0 / divide-by-zero: pass video through
     * unmodified rather than rendering garbage or crashing. */
    if (filter->grid <= 0 || !filter->effect) {
        obs_source_skip_video_filter(filter->context);
        return;
    }

    if (filter->block_permute && (!filter->inv_tex || !filter->perm_tex)) {
        /* LUT upload failed (e.g. allocation failure); fail safe instead
         * of sampling a null texture in the shader. */
        obs_source_skip_video_filter(filter->context);
        return;
    }

    width = scramble_filter_get_width(filter);
    height = scramble_filter_get_height(filter);
    if (width == 0 || height == 0) {
        obs_source_skip_video_filter(filter->context);
        return;
    }

    if (!obs_source_process_filter_begin(filter->context, GS_RGBA, OBS_ALLOW_DIRECT_RENDERING))
        return;

    vec2_set(&frame_size, (float)width, (float)height);

    gs_effect_set_int(filter->param_grid, filter->grid);
    gs_effect_set_vec2(filter->param_frame_size, &frame_size);
    gs_effect_set_bool(filter->param_flip_h, filter->flip_h);
    gs_effect_set_bool(filter->param_flip_v, filter->flip_v);
    gs_effect_set_bool(filter->param_invert, filter->invert);
    gs_effect_set_bool(filter->param_block_permute, filter->block_permute);
    if (filter->inv_tex)
        gs_effect_set_texture(filter->param_inv_tex, filter->inv_tex);
    if (filter->perm_tex)
        gs_effect_set_texture(filter->param_perm_tex, filter->perm_tex);

    obs_source_process_filter_end(filter->context, filter->effect, width, height);
}

/* ------------------------------------------------------------------ */
/* Registration                                                        */
/* ------------------------------------------------------------------ */

struct obs_source_info scramble_filter_info = {
    .id = "scramble_filter",
    .type = OBS_SOURCE_TYPE_FILTER,
    .output_flags = OBS_SOURCE_VIDEO,
    .get_name = scramble_filter_get_name,
    .create = scramble_filter_create,
    .destroy = scramble_filter_destroy,
    .update = scramble_filter_update,
    .get_defaults = scramble_filter_get_defaults,
    .get_properties = scramble_filter_get_properties,
    .video_render = scramble_filter_video_render,
    .video_tick = scramble_filter_video_tick,
    .get_width = scramble_filter_get_width,
    .get_height = scramble_filter_get_height,
};
