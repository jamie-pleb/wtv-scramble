/*
 * plugin-main.c
 *
 * obs-scramble: an OBS Studio video filter that applies a reversible
 * scramble effect (9x9 block-permutation grid + color invert + flip) to
 * whatever source it is attached to, driven by a small shared "key". A
 * cooperating browser userscript (wtv-descramble.user.js, elsewhere in this
 * repo) applies the inverse transform. See ../../SPEC/contract.md for the
 * full contract this plugin and that userscript must both match.
 */

#include <obs-module.h>

#include "scramble-filter.h"

OBS_DECLARE_MODULE()
OBS_MODULE_USE_DEFAULT_LOCALE("obs-scramble", "en-US")

bool obs_module_load(void)
{
    obs_register_source(&scramble_filter_info);
    blog(LOG_INFO, "[obs-scramble] plugin loaded (scramble_filter registered)");
    return true;
}

void obs_module_unload(void)
{
    blog(LOG_INFO, "[obs-scramble] plugin unloaded");
}
