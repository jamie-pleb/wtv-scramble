# obs-scramble

The OBS Studio filter half of the wtv-descramble system: an OBS effect filter that
tile-shuffles, flips, and color-inverts a scene's outgoing video according to a shared
**key**, so only a viewer with the matching key (via the companion Tampermonkey userscript)
sees clear video. See the [repo root README](../README.md) for the full picture — what this
pairs with, the master-string workflow, and the round-trip guarantee.

**Most people don't need this folder at all.** The plugin is already built and committed at
[`../dist/plugin/obs-scramble/`](../dist/plugin/obs-scramble/) — grab
[`../dist/`](../dist/) and run its installer instead of anything below. Build from source here
only if you want to audit the code, modify it, or rebuild for a different OBS/compiler version.

## This has actually been built and verified

Everything below — the plugin compiling under MSVC, `install.ps1` installing it, the C
self-tests, and the JS round-trip proof — has been run for real on this machine, not just
written and hoped-for:

- `cmake --build build --config RelWithDebInfo` produces `build/obs-scramble.dll` and
  `build/obs-scramble-dump-perm.exe` with MSVC (Visual Studio 2022 Build Tools).
- `obs-scramble-dump-perm --selftest-master test/master-strings.json` passes **15/15**
  (6 encode/parse-round-trip goldens + 9 rejection cases).
- `node test/roundtrip.mjs` passes **33/33** (pure-JS scramble/descramble proof, including the
  master-string section).
- `.\install.ps1` was run for real and installed the plugin into
  `%ProgramData%\obs-studio\plugins\obs-scramble\`, where OBS Studio picked it up.

If you follow the steps below on a comparable setup, they work.

## Prerequisites

You need **CMake** and **a C compiler**, plus the libobs SDK (headers + something to link
against). There is no single official "OBS plugin SDK" zip for arbitrary compiler versions, so
getting the SDK is the part with choices. Two real paths, both proven:

### (a) Recommended / fast path — what was actually used here

This avoids ever building OBS Studio itself (which otherwise drags in Qt, ffmpeg, CEF, ...).
You only need libobs's **headers**, plus something to link the plugin DLL against.

1. **Install a C/C++ toolchain.**
   - Windows: Visual Studio 2022 Build Tools, "Desktop development with C++" workload (gives
     you `cl.exe`, `link.exe`, `lib.exe`, `dumpbin.exe`, and NMake).
   - Linux/macOS: gcc or clang plus your usual build tools.
2. **Get just the libobs headers** via a sparse, shallow git checkout of obs-studio at the tag
   matching your installed OBS version (check Help → About in OBS for the version):
   ```
   git clone --filter=blob:none --sparse --depth 1 --branch 32.2.2 \
       https://github.com/obsproject/obs-studio.git .obs-sdk/src-headers
   cd .obs-sdk/src-headers
   git sparse-checkout set libobs
   ```
   This pulls down only the `libobs/` subdirectory — a few megabytes, not a full source tree.
3. **Generate an import library from your already-installed `obs.dll`** (Windows only — Linux/
   macOS link against `libobs.so`/`.dylib` directly, no import-lib step needed). From a
   "x64 Native Tools Command Prompt for VS 2022" (or after running `vcvars64.bat`):
   ```
   dumpbin /exports "C:\Program Files\obs-studio\bin\64bit\obs.dll" > obs-exports.txt

   :: turn the dumpbin export table into a .def file CMake/link can consume.
   :: dumpbin's export lines are 4+ whitespace-separated columns ending "name = name";
   :: an awk one-liner pulling column 4 gets every real export name:
   awk "{print \$4}" obs-exports.txt > obs-names.txt
   (echo LIBRARY obs & echo EXPORTS) > obs.def
   type obs-names.txt >> obs.def

   lib /def:obs.def /machine:x64 /out:obs.lib
   ```
   This produces `obs.lib` (the import library) and `obs.exp` next to it. Note: a naive
   column-4 awk also grabs two harmless non-symbol words ("functions", "names") from the
   dumpbin header's summary lines — leaving them in `obs.def` is fine, `lib.exe` just emits
   thunks for them that nothing ever references.
4. **Hit the one real gotcha**: `libobs/obs-config.h` `#include`s a generated `obsconfig.h`
   that a full obs-studio CMake configure normally produces — which you don't have, since you
   skipped that configure. Hand-write a minimal one at
   `.obs-sdk/src-headers/libobs/obsconfig.h` next to `obsconfig.h.in`:
   ```c
   #pragma once

   /* #undef OBS_DATA_PATH */
   /* #undef OBS_PLUGIN_PATH */
   /* #undef OBS_PLUGIN_DESTINATION */

   /* #undef GIO_FOUND */
   /* #undef PULSEAUDIO_FOUND */
   /* #undef XCB_XINPUT_FOUND */
   /* #undef ENABLE_WAYLAND */

   #define OBS_RELEASE_CANDIDATE 0
   #define OBS_BETA 0
   ```
   Leaving every `#cmakedefine` flag undefined is correct on Windows (GIO/PulseAudio/XCB/
   Wayland are Linux-only, and `OBS_*_PATH` only matter to the main obs-studio binary's own
   install-relative path resolution, not to a plugin) — only `OBS_RELEASE_CANDIDATE` and
   `OBS_BETA` need concrete values since other libobs headers compare them numerically.
5. Point CMake at what you just built (see "Build + install" below):
   ```
   -DLIBOBS_INCLUDE_DIR=.obs-sdk/src-headers/libobs -DLIBOBS_LIB=.obs-sdk/obs.lib
   ```
   (On Windows, `LIBOBS_LIB` and the import lib are the same file — `LIBOBS_IMPLIB` only needs
   setting separately if they'd differ.)

### (b) Alternative — build/use a full obs-studio source tree

If you already have obs-studio built from source (or `cmake --install`ed a libobs package),
skip all of the above:

- `find_package(libobs)` is tried automatically — if you've installed libobs somewhere CMake's
  package search sees, no flags are needed at all.
- Otherwise pass `-DLIBOBS_INCLUDE_DIR=<path/to/obs-studio/libobs> -DLIBOBS_LIB=<path/to/obs.lib-or-libobs.so-or-.dylib>`
  pointing at your own build tree, exactly as `CMakeLists.txt`'s own comments document.
- Or pass `-DOBS_SCRAMBLE_FETCH_LIBOBS=ON` to have CMake `FetchContent` and build obs-studio's
  `libobs` target itself (network access required, and this does pull in more than the headers
  route above — it's the "let CMake handle it" option, not the fast one).

## Build + install

```
cmake -S . -B build -DLIBOBS_INCLUDE_DIR=.obs-sdk/src-headers/libobs -DLIBOBS_LIB=.obs-sdk/obs.lib
cmake --build build --config RelWithDebInfo
.\install.ps1
```

(On Linux/macOS, drop `--config RelWithDebInfo` if using a single-config generator, and adapt
`install.ps1`'s steps by hand — it's a thin `Copy-Item` wrapper, see its `.DESCRIPTION`.)

**One known flake worth knowing about, not worrying about:** if this repo lives in a
Dropbox-synced folder, the link step can fail once with `LNK1201` (a transient PDB-write
failure caused by Dropbox briefly locking the file mid-write). It is not a real build error —
just re-run `cmake --build build --config RelWithDebInfo` and it succeeds on retry.

`cmake --build` also always builds `obs-scramble-dump-perm.exe` (see "Verify the math"
below), regardless of whether the libobs SDK was found — that target has zero OBS
dependencies.

## Where it installs, and how to verify it loaded

`install.ps1` copies the freshly-built `build\obs-scramble.dll` and `build\data\` into:

```
%ProgramData%\obs-studio\plugins\obs-scramble\bin\64bit\obs-scramble.dll
%ProgramData%\obs-studio\plugins\obs-scramble\data\
```

This is OBS Studio's per-user, no-admin-rights plugin location (OBS >= 28 scans it
automatically at startup) — it never touches OBS's own Program Files install, so there's
nothing to uninstall beyond deleting that one `obs-scramble\` folder.

To verify it loaded: (re)start OBS Studio, right-click a scene (or source) in the Scenes
panel → **Filters** → **+** under "Effect Filters" → **Scramble** should be listed. Add it,
and you'll see seed/grid/flip/invert/permute fields plus the Master String field described in
the [root README](../README.md#how-it-works).

## Verify the math without OBS

`tools/dump_perm.c` builds to `obs-scramble-dump-perm.exe` (or `-dump-perm` on Linux/macOS) —
a standalone CLI with zero OBS/libobs dependencies, so it always builds even without the SDK.
It exposes the exact same permutation and master-string C code the plugin links against, so
you can cross-check it independently:

```
obs-scramble-dump-perm --seed 1337 --grid 9 --out perm.json      # dump a permutation table
                                                                  # -> diff against test/perm-1337-9.json
obs-scramble-dump-perm --selftest-master test/master-strings.json  # encode/parse goldens + rejections
```

The second form is the one that ran 15/15 above. Pair it with `node test/roundtrip.mjs` (the
pure-JS side of the same proof) when changing anything in `src/scramble-permutation.c` or
`SPEC/reference.mjs` — both must keep agreeing byte-for-byte.
