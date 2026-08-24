# w.tv Descramble

A scrambled-broadcast + decoder pair for a streamer's **own** [w.tv](https://w.tv) stream —
the software equivalent of the old analog scrambled-cable channels that needed a decoder box.
An OBS filter mangles the streamer's own outgoing video (tile-shuffle, color invert, flip);
only viewers running a matching browser script, holding the matching key, see clear video.
Everyone else just sees noise.

**This does not bypass anything.** It transforms only the broadcaster's own outgoing pixels
before they leave OBS. It does not touch, remove, or interact with w.tv's own access controls,
DRM, or paywalls in any way — it's a picture-scrambling effect layered on top of a stream the
streamer already has the right to publish, not a way to unlock someone else's stream.

## Quick start

Everything you need is ready to use in [`dist/`](dist/) — no build step required. Full
step-by-step instructions live in **[`dist/README.md`](dist/README.md)**; the gist:

- **Streamer:** run `dist/install.bat`, add the Scramble filter to your scene, set a key, copy
  the **Master String** it shows you (e.g. `WTV1-1337-9-HIP`).
- **Viewer:** install `dist/viewer/wtv-descramble.user.js` via Tampermonkey, open the panel on
  the streamer's channel, and paste the Master String they gave you.

## How it works

The OBS filter derives a seeded pseudo-random tile permutation from a shared `seed`, then
applies it to the frame along with an optional color invert and horizontal/vertical flip. The
browser userscript undoes the exact same operations in reverse. Because both sides derive
identical math from one shared seed, the entire shared secret boils down to a single short
copy-pasteable code — the **Master String** (e.g. `WTV1-1337-9-HIP`) — rather than six separate
fields two people have to keep in sync by hand.

## Repo layout

| path | what it is |
|---|---|
| [`dist/`](dist/) | **ready-to-use — start here.** Compiled plugin, userscript, installer, master key preview, its own README |
| [`obs-scramble/`](obs-scramble/) | the OBS filter plugin's C source + CMake build |
| [`userscript/`](userscript/) | the viewer-side descrambler script's source |
| [`SPEC/`](SPEC/) | the contract both sides implement (PRNG, permutation math, pipeline order) |
| [`test/`](test/) | the automated Node round-trip suite (`roundtrip.mjs`) and its golden fixtures |

## Building from source

The source in [`obs-scramble/`](obs-scramble/) is there for transparency and so anyone can
rebuild or audit what's shipped in `dist/` — most people don't need to touch it. It builds
cleanly with CMake + MSVC against a headers-only OBS SDK (no full OBS Studio checkout
required); this has been built, installed, and run end-to-end on Windows, not just
hand-authored. See [`obs-scramble/README.md`](obs-scramble/README.md) for the real steps.

## Verifying the math

`node test/roundtrip.mjs` proves the scramble/descramble round trip pixel-for-pixel across
seeds, grid sizes, and op combinations; [`dist/master-key-preview.html`](dist/master-key-preview.html)
is a zero-install page for trying out or tuning a key visually.

## License

[MIT](LICENSE)
