# w.tv Descramble

A scrambled-broadcast + decoder pair for a streamer's **own** [w.tv](https://w.tv) stream —
the software equivalent of the old analog scrambled-cable channels that needed a decoder box.
The streamer mangles their own outgoing video with an OBS filter (tile-shuffle, flip, color
invert); only viewers running a matching browser script, with the matching "key", see clear
video. Everyone else just sees noise.

**This does not bypass anything.** It only transforms the streamer's own pixels before they
leave OBS. It does not touch, remove, or interact with w.tv's own access controls, DRM, or
paywalls in any way — it's a picture-scrambling effect layered on top of a stream the streamer
already has the right to publish, not a way to unlock someone else's stream.

Both halves are driven by one shared secret: the **key**. Get the same key into both sides and
the picture resolves; get it wrong (or leave it out) and you see scrambled/garbled video —
that's the intended, working state, not a bug.

## What's in this folder

| path | what it is |
|---|---|
| `plugin/obs-scramble/` | the compiled OBS Studio filter plugin (scrambles the stream) |
| `viewer/wtv-descramble.user.js` | the Tampermonkey userscript (descrambles it in a browser) |
| `master-key-preview.html` | a standalone page to preview/tune a key offline, no install needed |
| `perf-bench.html` | a standalone benchmark for diagnosing descrambler performance in your browser |
| `install.ps1` / `install.bat` | installer for the OBS plugin (Windows) |
| `README.md` | this file |

You need the **streamer** steps if you're the one going live. You need the **viewer** steps if
you're watching someone else's scrambled stream and they gave you a key.

---

## Streamer quick-start (OBS)

### 1. Install the plugin

Easiest way: double-click **`install.bat`**. It copies `plugin\obs-scramble\` into OBS's
per-user plugin folder — no admin rights needed, and it never touches OBS's own Program
Files install. It also tells you whether OBS is currently running and needs a restart.

Prefer to run `install.ps1` directly in PowerShell instead? Windows' default execution
policy blocks unsigned scripts, so run it with:
```
powershell -ExecutionPolicy Bypass -File install.ps1
```
(`install.bat` already does this for you — that's the difference between the two.)

Prefer to do it by hand? Copy the whole `plugin\obs-scramble` folder into:

```
%ProgramData%\obs-studio\plugins\
```

so you end up with `%ProgramData%\obs-studio\plugins\obs-scramble\bin\64bit\obs-scramble.dll`
and a sibling `data\` folder. Then (re)start OBS.

### 2. Add the filter to your SCENE

Right-click your **scene** (in the Scenes panel) — not just one source — and choose
**Filters**, then under "Effect Filters" click **+** and pick **Scramble**.

Scene-level is the recommended spot, not a single source: if you only scramble one source,
any black letterbox padding around it (bars OBS adds when a source doesn't fill the canvas)
stays untouched. Since `invert` flips colors, an unscrambled black bar next to a scrambled
picture would show up as a plain white bar for viewers — a visible tell and a wasted color
channel. Filtering the whole scene scrambles that padding along with everything else.

### 3. Set your key, then copy the Master String

The filter's properties show individual fields (seed, grid size, flip horizontal, flip
vertical, invert colors, block permute) **and** a single-line **Master String** field that
always reflects them, e.g. the default key's string is:

```
WTV1-1337-9-HIP
```

Change any field and the Master String updates to match; paste a different Master String in
and every field updates to match it instead — either direction works, use whichever is easier.

Once you're happy with your key, **copy the Master String** and send it to your viewers
out-of-band (Discord, a paid tier, a DM — anywhere except the stream itself, since that's the
one channel it's meant to be protecting).

Go live normally. Your OBS preview and the outgoing stream will look like scrambled noise —
that's correct; it's what everyone without your key sees.

---

## Viewer quick-start (browser)

### 1. Install Tampermonkey

Get the [Tampermonkey](https://www.tampermonkey.net/) extension for your browser (Chrome,
Firefox, Edge, Safari, and Brave are all supported).

### 2. Install the userscript

Open Tampermonkey's dashboard → **Utilities** tab → **Import from file** → select
`viewer\wtv-descramble.user.js` from this folder. (Or open that file, copy its contents, and
paste them into a new Tampermonkey script.)

### 3. Open the channel and paste the key

Visit the streamer's w.tv channel. A small panel appears in a corner of the page. Open it and
paste the **Master String** the streamer gave you (e.g. `WTV1-1337-9-HIP`) into the Master
String field, then apply it. You'll get a clear green confirmation if it parsed and applied,
or a red error if it didn't — a bad paste never silently does the wrong thing, it just tells
you and leaves your previous key alone.

With a matching key the picture resolves to normal within a frame or two. With no key, or a
key that doesn't match the streamer's, you'll keep seeing scrambled video (expected) unless
the streamer's key uses a contract `version` your script doesn't support, in which case you'll
see a clear red banner instead of a guessed picture.

### The ON/OFF toggle

The panel has one big ON/OFF toggle at the top:

- **ON** — the descrambler is active: it attaches to the video and un-scrambles it live.
- **OFF** — a full teardown: the descrambler detaches completely, the video plays with its
  native player controls and volume behaving normally, and a stream that was never scrambled
  in the first place looks completely normal too.

Flip it OFF when you're watching a normal (non-scrambled) w.tv stream, and back ON when you're
watching a scrambled one. Your setting is remembered between visits.

### Advanced section

Everything below the toggle and the Master String field lives inside a collapsed
**Advanced ▸** section: the individual seed / grid / flip-H / flip-V / invert / block-permute
controls, a reset-to-default-key button, and a read-only display of the current key's canonical
Master String. Most people never need to open it — the Master String field on its own is
enough — but it's there if you want to hand-tune one field at a time.

---

## The master string, in one line

```
WTV<version>-<seed>-<grid>-<flags>
```

`version` is always `1` right now. `seed` is a whole number (0 to 4294967295). `grid` is the
N×N tile count (9 means a 9×9 = 81-tile grid). `flags` is some subset of `H` (flip
horizontal), `V` (flip vertical), `I` (invert colors), `P` (shuffle tiles), always written in
that `H, V, I, P` order — or the single character `0` if none of them are on. The default key
is `WTV1-1337-9-HIP`.

## Preview/tune a key offline

Double-click **`master-key-preview.html`** — no server, no install, no internet connection needed. It
draws a sample test image, scrambles it with whatever key/master string you enter, and shows
you Original / Scrambled / Descrambled side by side, so you can sanity-check a key (or just see
what the effect looks like) before ever touching OBS. You can also load your own picture with
its file picker.

---

## Troubleshooting

- **"obs-scramble.dll not found" from the installer** — you have an incomplete copy of this
  folder; the `plugin\obs-scramble\` subfolder needs to travel together with `install.ps1`.
  Get the whole `dist` folder again rather than just the script.
- **Installer says it can't copy the files** — OBS is probably running and has the plugin DLL
  locked. Fully close OBS (check the system tray too) and run the installer again.
- **Viewer gets choppy video / audio skips with Block Permute on** — update the userscript
  (v1.2.1 fixed a severe Firefox-specific slowdown at higher grid sizes). Still laggy?
  Double-click `perf-bench.html` — it measures the descrambler's per-frame cost in your exact
  browser and prints the numbers, which is exactly what to share when reporting the problem.
- **Viewer sees a red banner instead of scrambled or clear video** — the key's contract
  `version` doesn't match what the script expects. Double-check the Master String you were
  given rather than hand-editing it.
- **Viewer pastes a Master String and nothing changes, with a red error** — it wasn't a valid
  Master String (typo, missing dash, stray character). Copy it again straight from the OBS
  filter rather than retyping it by hand.
- **Streamer's OBS preview looks scrambled too** — that's expected; OBS only ever shows the
  scrambled output, never a descrambled preview. Open the channel in a browser with the
  userscript installed (and the ON/OFF toggle set to ON) to see what viewers actually see.
