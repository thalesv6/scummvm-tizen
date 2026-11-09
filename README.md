# ScummVM for Samsung Tizen TVs (unofficial)

[ScummVM](https://www.scummvm.org/) compiled to WebAssembly with its `dists/emscripten` port and
packaged as a Tizen `.wgt` app, with TV remote and gamepad controls and a way to copy your own games to the TV.

**Experimental.** It has only had a few minutes of play on a real TV, where it ran and was playable.
Longer sessions, big games and save data surviving app updates are still untested. Please report what you find,
with a photo of **Manage games → TV info**, which shows your TV's model, its remote keys and whether downloads work.

This project is not affiliated with or endorsed by the ScummVM team. Bugs here belong here, not on their tracker.

## Requirements

A Samsung TV with Tizen 6.5 or newer (2022 models onward). Older TVs have a browser engine too old to
parse the generated `scummvm.js`.

## Install

Download a `.wgt` from [Releases](https://github.com/thalesv6/scummvm-tizen/releases):

- `ScummVM.wgt` includes four freeware games.
- `ScummVM-no-games.wgt` is the same app without them.

Install it with Apps2Samsung, which re-signs the package with your TV's certificate.

## Games

Beneath a Steel Sky (CD), Flight of the Amazon Queen, Lure of the Temptress and Drascula come with `ScummVM.wgt`.

Your own games can be added without rebuilding. On the TV, holding **Play/Pause** (or the **Yellow** key) opens
**Manage games**, which copies a game to the TV. Once copied, it runs without the PC or the USB drive.

- **From a PC:** put each game in a subfolder of `pc-games/` and start the server (Python only, nothing to install):

  ```bash
  python tools/pc-server.py pc-games
  ```

  It prints the PC's address. Enter it once under "PC address", then use "Copy from PC".
  The server has no password: anyone on your network can read and write that folder while it runs,
  so stop it when you finish copying.
- **From a phone:** with the PC server running, "Send from phone" shows a QR code. The page takes a `.zip`
  (it becomes a folder named after the zip) or several files plus a game name. The game lands in the PC's
  `pc-games/` folder; then use "Copy from PC".
- **From a USB drive:** "Copy from USB drive" → browse to the game's folder → "Copy this folder".

To play: **Add Game...** → `/data/tv` → the game's folder. "Games on TV" lists and deletes copied games.

Files are held in memory while a game reads them, so very large games may not fit. How large is untested.

## Controls

The layout follows ScummVM's Android TV port. Back and the gamepad buttons are ScummVM keys, so they can be remapped
under **Global Options → Keymaps**.

### Remote

Everything works with the small Smart Remote, which has no color keys of its own. The app shows this map
the first time it opens, and again under **Manage games → Controls help**.

| Key | Action |
| --- | --- |
| Arrows | Move the cursor (tap = 4 px, hold = glide and accelerate) |
| OK | Left click (hold to drag) |
| Play/Pause | Right click |
| Play/Pause held | Manage games |
| Back | Skip cutscene, close menus (`AC_BACK`) |
| Back held | ScummVM menu (save, load, pause, quit) |
| CH+ / CH− | Skip dialogue line / virtual keyboard |

The cursor's glide speed is set under **Manage games → Cursor speed**.

Remotes with color keys also get Red (ScummVM menu), Green (right click), Yellow (manage games) and
Blue (virtual keyboard). On the small remote they appear through the **123** button.

### Gamepad

| Button | Action |
| --- | --- |
| Left stick and D-pad | Cursor |
| A / B | Left click / right click |
| X / Y | Skip dialogue line / skip cutscene |
| LB / Start | Game menu / ScummVM menu |
| RB held | Slow cursor |
| Select | Virtual keyboard |

### USB mouse and keyboard

The mouse works directly. Typing a letter on the keyboard sends arrows and Enter to the game as normal keys;
pressing Back or a color key on the remote returns to remote mode.

Timing and speed settings are at the top of `tizen/tv.js` (`CURSOR_*`, `*_HOLD_MS`).

## Build

Only Docker is needed.

```bash
docker build -t scummvm-tizen .
```

```bash
docker run --rm -v scummvm-src:/src alpine chown 1000:1000 /src
```

```bash
docker run --rm -v scummvm-src:/src -v "$PWD:/work" scummvm-tizen bash /work/build.sh
```

This writes `ScummVM.wgt` to this folder. Add `-e BUNDLE_FREEWARE_GAMES=false` after `--rm` to build
`ScummVM-no-games.wgt` instead.

The `chown` is only needed once for a new volume. The `scummvm-src` volume keeps the source, Emscripten and the game
zips, so later builds only recompile what changed. Changing `CONFIGURE_ARGS` in `build.sh` recompiles everything.

To bundle a game of your own, create `games/<name>/` here before building. It ends up in `/data/games/<name>`.

Pushing a `v*` tag makes GitHub Actions build both packages and publish them as a pre-release.

### Patches to ScummVM

The build pins one ScummVM commit and applies `patches/*.patch`:

- `emscripten-delay-runs-timers`: keeps audio from stuttering during long in-game delays.
- `emscripten-tv-keymap-defaults`: Back as `AC_BACK` and the gamepad D-pad as the cursor.

## License

GPL-3.0-or-later, the same as ScummVM. See [LICENSE](LICENSE).

- `tizen/qrcode.js` is by Kazuhiko Arase, under the MIT license (see the file header).
- The `Dockerfile` packaging steps are adapted from [dos-ise/openttd-tizen](https://github.com/dos-ise/openttd-tizen),
  a fork of OpenTTD, which is GPL-2.0.
- The freeware games are not covered by this project's license. Each keeps its own license file or readme inside
  its folder in `data/games/`, and those terms forbid charging for the games themselves.

ScummVM is a project of the ScummVM Team. The game names belong to their respective owners.
