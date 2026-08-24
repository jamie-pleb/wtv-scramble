# obs-scramble/CMakeLists.txt
#
# Structured in the spirit of the official obs-plugintemplate
# (https://github.com/obsproject/obs-plugintemplate): declares the plugin
# module, locates/fetches the libobs SDK, compiles src/ into a shared
# module, and copies data/ alongside the built binary.
#
# DEVIATIONS from the official template, documented per the task spec
# rather than left silent (see README.md for more):
#   - Uses a plain, single CMakeLists.txt with find_package/manual-path/
#     FetchContent fallbacks instead of the template's buildspec.json +
#     cmake/bootstrap.cmake + CMakePresets.json machinery (which downloads
#     pinned "obs-deps"/Qt prebuilt archives per-platform). That machinery
#     is substantial infrastructure tied to obsproject's own CI hosting and
#     was not reproduced here; this file instead documents three explicit,
#     developer-controllable ways to point CMake at libobs (see below).
#   - cmake_minimum_required is lowered to 3.16 (the template requires
#     3.28+) for broader compatibility, since none of the newer CMake
#     features are used here.
#   - No CMakePresets.json. Configure with plain `cmake -S . -B build ...`
#     flags/cache variables instead (documented below and in README.md).
#
# THIS HAS BEEN BUILT AND INSTALLED FOR REAL on this machine: MSVC (VS 2022
# Build Tools) compiles obs-scramble.dll via `cmake -S . -B build
# -DLIBOBS_INCLUDE_DIR=... -DLIBOBS_LIB=... && cmake --build build --config
# RelWithDebInfo`, and `install.ps1` copies it into OBS's per-user plugin
# directory where OBS loads it. The libobs SDK used was headers-only: a
# sparse/shallow git checkout of obs-studio's libobs/ subdirectory at the
# installed OBS version's tag, plus a hand-generated import library built
# from the installed obs.dll via `dumpbin /exports` -> a parsed .def file ->
# `lib /def:...` -- no full obs-studio source build (and its Qt/ffmpeg/CEF
# dependencies) required. Full step-by-step commands, the one obsconfig.h
# gotcha this technique hits, and the alternative full-source-tree path are
# all in README.md "Prerequisites" -- read that before configuring.

cmake_minimum_required(VERSION 3.16)

project(obs-scramble VERSION 1.0.0 LANGUAGES C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
    set(CMAKE_BUILD_TYPE "RelWithDebInfo" CACHE STRING "Build type" FORCE)
endif()

# ---------------------------------------------------------------------------
# Shared, OBS-independent permutation core (src/scramble-permutation.[ch]).
#
# Used by BOTH the OBS plugin module below and the standalone
# obs-scramble-dump-perm CLI tool. Has zero OBS/libobs dependencies so it
# (and the CLI) can always be configured and built in this repo, even when
# the OBS SDK is not available -- see tools/dump_perm.c and README.md
# "Verification".
# ---------------------------------------------------------------------------
add_library(scramble-permutation STATIC
    src/scramble-permutation.c
    src/scramble-permutation.h
)
target_include_directories(scramble-permutation PUBLIC src)

# ---------------------------------------------------------------------------
# Standalone permutation cross-check CLI. No OBS SDK required. Always built
# so `cmake --build` has something to succeed at even without the SDK.
# ---------------------------------------------------------------------------
option(OBS_SCRAMBLE_BUILD_DUMP_TOOL "Build the standalone dump_perm CLI (no OBS SDK needed)" ON)
if(OBS_SCRAMBLE_BUILD_DUMP_TOOL)
    add_executable(obs-scramble-dump-perm tools/dump_perm.c)
    target_link_libraries(obs-scramble-dump-perm PRIVATE scramble-permutation)
endif()

# ---------------------------------------------------------------------------
# Locate libobs (the OBS Studio plugin SDK), in order of preference:
#
#   1. find_package(libobs) -- works if libobs was `cmake --install`ed from
#      an obs-studio build tree, or provided by a package manager (Linux
#      distro packages, vcpkg, etc.) that exports a libobs CMake package.
#
#   2. A manually-specified SDK location:
#         cmake -S . -B build -DLIBOBS_INCLUDE_DIR=<path/to/obs-studio/libobs> \
#                              -DLIBOBS_LIB=<path/to/obs.lib-or-libobs.so-or-.dylib> \
#                              [-DLIBOBS_IMPLIB=<path/to/obs.lib>]   (Windows only,
#                                if the import lib differs from LIBOBS_LIB)
#      This is the simplest path for a developer who already has OBS
#      Studio's source checked out and built locally, and is the path most
#      third-party OBS plugins historically document.
#
#   3. Opt-in FetchContent of the obs-studio source tree at a pinned tag,
#      building just the libobs target from it -- OFF by default so
#      `cmake` never reaches out to the network unasked:
#         cmake -S . -B build -DOBS_SCRAMBLE_FETCH_LIBOBS=ON
#
# If none of these resolve, configuration does NOT hard-fail: the
# scramble-permutation static lib and obs-scramble-dump-perm CLI above still
# configure and build (they need none of this), and a clear CMake WARNING
# is emitted explaining how to point CMake at a real SDK. See README.md.
# ---------------------------------------------------------------------------

set(obs-scramble_FOUND_LIBOBS FALSE)

find_package(libobs QUIET)
if(TARGET libobs)
    set(obs-scramble_FOUND_LIBOBS TRUE)
    message(STATUS "obs-scramble: found libobs via find_package(libobs)")
endif()

if(NOT obs-scramble_FOUND_LIBOBS AND DEFINED LIBOBS_INCLUDE_DIR AND DEFINED LIBOBS_LIB)
    add_library(libobs-manual SHARED IMPORTED)
    set_target_properties(libobs-manual PROPERTIES
        IMPORTED_LOCATION "${LIBOBS_LIB}"
        INTERFACE_INCLUDE_DIRECTORIES "${LIBOBS_INCLUDE_DIR}"
    )
    if(WIN32 AND DEFINED LIBOBS_IMPLIB)
        set_target_properties(libobs-manual PROPERTIES IMPORTED_IMPLIB "${LIBOBS_IMPLIB}")
    endif()
    add_library(libobs ALIAS libobs-manual)
    set(obs-scramble_FOUND_LIBOBS TRUE)
    message(STATUS "obs-scramble: using manually-specified libobs at ${LIBOBS_LIB}")
endif()

option(OBS_SCRAMBLE_FETCH_LIBOBS "Fetch obs-studio source via CMake FetchContent to obtain libobs if not found locally (requires network access)" OFF)

if(NOT obs-scramble_FOUND_LIBOBS AND OBS_SCRAMBLE_FETCH_LIBOBS)
    include(FetchContent)
    set(OBS_SCRAMBLE_OBS_STUDIO_TAG "30.2.3" CACHE STRING "obs-studio git tag to fetch for libobs headers/build")
    message(STATUS "obs-scramble: fetching obs-studio@${OBS_SCRAMBLE_OBS_STUDIO_TAG} for libobs (this can take a while and requires network access)")
    FetchContent_Declare(
        obs-studio
        GIT_REPOSITORY https://github.com/obsproject/obs-studio.git
        GIT_TAG        ${OBS_SCRAMBLE_OBS_STUDIO_TAG}
        GIT_SHALLOW    TRUE
    )
    FetchContent_MakeAvailable(obs-studio)
    if(TARGET libobs)
        set(obs-scramble_FOUND_LIBOBS TRUE)
        message(STATUS "obs-scramble: built libobs from fetched obs-studio source")
    endif()
endif()

if(NOT obs-scramble_FOUND_LIBOBS)
    message(WARNING
        "obs-scramble: could not locate the OBS Studio plugin SDK (libobs). "
        "The obs-scramble PLUGIN target will NOT be configured this run. "
        "obs-scramble-dump-perm (the permutation cross-check CLI) and the "
        "scramble-permutation static library still will be -- they need no "
        "OBS SDK. To also build the actual plugin, either:\n"
        "  (a) install/build obs-studio and re-run CMake so "
        "find_package(libobs) succeeds, or\n"
        "  (b) pass -DLIBOBS_INCLUDE_DIR=<path> -DLIBOBS_LIB=<path to obs.lib "
        "/ libobs.so / libobs.dylib>, or\n"
        "  (c) pass -DOBS_SCRAMBLE_FETCH_LIBOBS=ON to fetch obs-studio source "
        "via CMake FetchContent (network access required).\n"
        "See README.md 'Build system notes' for details."
    )
else()
    add_library(obs-scramble MODULE
        src/plugin-main.c
        src/scramble-filter.c
        src/scramble-filter.h
    )
    target_link_libraries(obs-scramble PRIVATE libobs scramble-permutation)
    target_include_directories(obs-scramble PRIVATE src)
    set_target_properties(obs-scramble PROPERTIES PREFIX "")

    # Copy data/ (the .effect shader + locale) alongside the built module so
    # obs_module_file()/OBS_MODULE_USE_DEFAULT_LOCALE() can find them
    # relative to the built binary during local development.
    add_custom_command(TARGET obs-scramble POST_BUILD
        COMMAND ${CMAKE_COMMAND} -E copy_directory
                "${CMAKE_CURRENT_SOURCE_DIR}/data"
                "$<TARGET_FILE_DIR:obs-scramble>/data"
        COMMENT "obs-scramble: copying data/ next to built module"
    )

    # Install into the modern per-plugin "plugins/<name>/{bin/64bit,data}"
    # layout OBS Studio >= 28 supports for user-local (no-admin) plugin
    # installs. See README.md for exact per-OS destination paths.
    if(WIN32)
        # MODULE library targets (unlike SHARED) always install under the
        # LIBRARY component, even on Windows -- CMake errors ("no LIBRARY
        # DESTINATION for module target") if RUNTIME DESTINATION is used
        # here instead. Confirmed by actually running this configure step.
        install(TARGETS obs-scramble LIBRARY DESTINATION "${PROJECT_NAME}/bin/64bit")
        install(DIRECTORY data/ DESTINATION "${PROJECT_NAME}/data")
    elseif(APPLE)
        install(TARGETS obs-scramble LIBRARY DESTINATION "${PROJECT_NAME}/bin")
        install(DIRECTORY data/ DESTINATION "${PROJECT_NAME}/data")
        message(STATUS "obs-scramble: on macOS, OBS ultimately expects a "
                        "<name>.plugin bundle -- see README.md for the "
                        "manual bundle-layout steps this CMakeLists.txt "
                        "does not automate.")
    else()
        install(TARGETS obs-scramble LIBRARY DESTINATION "${PROJECT_NAME}/bin/64bit")
        install(DIRECTORY data/ DESTINATION "${PROJECT_NAME}/data")
    endif()
endif()
