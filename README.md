# OpenIC

An unofficial fan port of **幻影都市 / Illusion City** (MicroCabin, 1991, Sharp X68000) to
[Godot 4](https://godotengine.org/), playable in English, French or the original Japanese.

Illusion City is a cyberpunk role-playing game set in a Hong Kong ruined by the "Demonfall".
OpenIC runs the game on a modern computer, with the original's pictures, maps, music and story, plus a few optional comforts:
quick saves, a faster game speed, and fixes for bugs in the original.

**This repository contains none of the original game.** No pictures, music, maps, script or
program code of the game are included. You need your own copy of the game, and OpenIC builds
everything it needs from it, on your computer.

This is a fan project, not affiliated with or endorsed by the rights holders of Illusion City.
It is non-commercial: it may not be sold or used to make money in any way.

## Getting started (Windows)

### 1. What you need

- **The seven floppy disk images of the X68000 version of Illusion City**: images of your own
  copy, in DIM, XDF, HDM or D88 format. Put all seven in one folder. File names don't matter:
  OpenIC recognises each disk by its contents. We can't help you find disk images; use your own.
- **Windows 10 or 11** (64-bit). For other systems, see [Other systems](#other-systems) below.
- About 130 MB of free space: about 110 MB for OpenIC itself (a 44 MB download), plus about
  20 MB of game data built from your disks.

### 2. Download

Open the [latest release](https://github.com/cdebaecker/openic/releases/latest), download
`OpenIC-windows-x86_64.zip`, and unzip it anywhere, for example in `Documents\OpenIC`.

### 3. First launch

Start **`OpenIC.exe`**.

- Windows may show "Windows protected your PC", because OpenIC is not signed. Click
  **More info**, then **Run anyway**.
- OpenIC explains that it needs your copy of the game. Press **Enter** (or click) and choose the
  folder with your seven disk images.
- The import takes about a minute and a half. OpenIC reads your disks and converts the game's
  pictures, maps, music and text. It does this only once and keeps the result on your computer.

When it's done, the title menu appears.

### 4. Play

On the title menu:

| | |
|---|---|
| **Continue from save** | load your latest save |
| **Start with the opening** | watch the intro, then start a new game |
| **Start from the beginning** | start a new game, skipping the intro |
| **Options** | display, sound, language, speed, controls, optional fixes |
| **Language** | English, Français or 日本語 (or press **L**) |
| **Ending** | the ending sequence (it spoils the story) |

Before a new game starts, OpenIC asks how you want to save:

- **Original:** save only at the game's save points, as in 1991.
- **Quick saves anywhere:** you can also press **F5** to save and **F9** to load, anywhere in
  the field.

You can change this later in Options.

## Controls

The game is played with the mouse, the keyboard or a gamepad. All controls can be changed in
**Options**.

| Action | Keyboard | Gamepad | Mouse |
|---|---|---|---|
| Move | arrow keys (or numpad 8 / 4 / 6 / 2) | D-pad | hold the left button on the map or on the cross pad; the right button walks on by itself |
| Choose in a menu | arrow keys | D-pad | point |
| Confirm, talk, advance text | Enter | A | left click |
| Cancel, close a menu | Escape | B | right click (in menus) |
| The original's Z / X / Space keys | Z / X / Space | X / Y / Back | |
| Fast forward (hold) | Tab | right shoulder | |
| Quick save / quick load | F5 / F9 | left shoulder / left stick | |
| Fullscreen | F11 | | |

The buttons on the right of the screen (MAGIC, ITEM, EQUIP, TALK, STATUS, SYSTEM) open the
game's menus. **SYSTEM** has the save and load menus.

Escape in the field (with no menu open) returns to the title menu, **without saving**.

## Saving

- Saves are kept in OpenIC's user folder: `%APPDATA%\Godot\app_userdata\OpenIC\saves` (paste
  that path into the File Explorer address bar).
- **Saves from the original game:** if you played on a real X68000 or an emulator, OpenIC can
  use your saves. In **Options**, choose **Import saves from a disk image…** and pick the disk
  image that holds them (or drop the image onto the window). Game disk 1 and user disks both
  work.

## Options worth knowing

- **Music played on:** the X68000's own FM sound, or the game's Roland MT-32 version when it
  is available (it needs MT-32 or CM-32L ROMs and isn't built by the standard import).
- **FM music: Live or Recorded.** Live (the default) synthesizes the music as the X68000's
  sound chip did, with [ymfm](https://github.com/aaronsgiles/ymfm). Recorded plays the music
  rendered during the import.
- **Game speed and Battle speed:** speed up walking and battles. **Tab** fast-forwards while
  held.
- **Fixes:** optional fixes for bugs in the original. The first three are on by default. The
  last one (enemy action choice) changes the game's balance, so it is off.
- **Smooth movement:** scrolls the map smoothly, unlike the original. Off by default.

## Troubleshooting

- **"Some disks are missing from that folder":** the import screen lists which of the seven
  disks it found. Check that all seven images are in the same folder and are complete, in DIM,
  XDF, HDM or D88 format.
- **Starting over with a fresh import:** close OpenIC and delete `gamedata.zip` (and the
  `gamedata` folder, if an older version made one) in `%APPDATA%\Godot\app_userdata\OpenIC`. The
  next launch runs the import again. Your saves and settings are kept.
- **Upgrading from 0.2 or older:** those versions imported into a `gamedata` folder of about
  190 MB. It still works, but you can delete it to import again into the new 17 MB
  `gamedata.zip`.
- **No music:** check **Music volume** in Options. If live music doesn't play on your
  computer, set **FM music** to **Recorded**.
- **Removing OpenIC:** delete the folder you unzipped it into and
  `%APPDATA%\Godot\app_userdata\OpenIC`.

## Other systems

The releases are for Windows only for now. On Linux or macOS you can run OpenIC from source
(below). The music then plays from the files rendered during the import, because the live
synthesizer is only built for Windows so far.

## Running from source

- [Godot 4.4+](https://godotengine.org/download) (tested with 4.7)
- [Node.js 20+](https://nodejs.org/) on PATH: the importer runs the original game in an X68000
  emulator (`src/`) to extract and convert its data (`tools/export/`)

Build the game data from your disks, then open `godot/project.godot` in Godot and run it:

```bash
node tools/openic/import.mjs --disks <folder with the 7 images> --out godot/gamedata --folder
```

To have live music, build the synthesizer once (needs CMake and a C++ compiler):

```bash
node tools/native/build.mjs
```

## What is where

| Path | |
|---|---|
| `godot/` | the game (GDScript) |
| `tools/openic/import.mjs` | the importer: identifies the disks, boots the game, runs the exporters |
| `tools/export/` | exporters: pictures, sprites, maps, events, music (the game's own sound driver in the emulator), cutscenes, battle and system tables |
| `src/` | the X68000 emulator the exporters use |
| `text/` | translations: dialogue by message id, interface glossary (keys hashed, restored from your disks), French tables, opening subtitles |
| `tools/openic/package.mjs` | builds a Windows release (game + importer + Node.js) |
| `native/`, `tools/native/build.mjs` | chipsynth: the FM music synthesized live (ymfm), a Godot extension |
| `.github/workflows/release.yml` | a pushed tag `v*` builds the Windows release on GitHub Actions and attaches it to that tag's release |

## Licence

OpenIC's code and translations are free software under the GNU General Public License v3.0
(`LICENSE`): you may use, change and share them, and versions you distribute must stay under the
same licence with their source. The licence does not cover Illusion City itself: its pictures,
music, text and program belong to their rights holders and are not part of this repository.

## Credits

Illusion City © 1991 MicroCabin and its current rights holder. All trademarks belong to their
owners. The game font is Unifont JP (SIL OFL 1.1, `godot/fonts/`). Live music: ymfm
(BSD 3-Clause, Aaron Giles) and godot-cpp (MIT). The Windows release includes Node.js (MIT).
