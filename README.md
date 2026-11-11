# OpenIC

An unofficial fan port of **幻影都市 / Illusion City** (MicroCabin, 1991, Sharp X68000) to
[Godot 4](https://godotengine.org/), playable in English, French or the original Japanese.

Illusion City is a cyberpunk role-playing game set in a Hong Kong ruined by "the Collapse", a disaster that destroyed the old city in a single night.
OpenIC runs the game on a modern computer, with the original's pictures, maps, music and story, plus a few optional comforts:
quick saves, a faster game speed, and fixes for bugs in the original.

**This repository contains none of the original game.** No pictures, music, maps, script or
program code of the game are included. You need your own copy of the game, and OpenIC builds
everything it needs from it, on your computer.

This is a fan project, not affiliated with or endorsed by the rights holders of Illusion City.
It is non-commercial: it may not be sold or used to make money in any way.

## Getting started

### 1. What you need

- **The seven floppy disk images of the X68000 version of Illusion City**: images of your own
  copy, in DIM, XDF, HDM or D88 format. Put all seven in one folder. File names don't matter:
  OpenIC recognises each disk by its contents. We can't help you find disk images; use your own.
- **Windows 10 or 11, or Linux** (64-bit x86). For macOS, see [Other systems](#other-systems).
- About 130 MB of free space: about 110 MB for OpenIC itself (a 44 MB download), plus about
  20 MB of game data built from your disks.
- **Optional: Roland MT-32 or CM-32L ROMs**, for the game's MT-32 version of the music (see
  [MT-32 music](#mt-32-music)). Without them you get the X68000's own FM music, which is
  complete.

### 2. Download

Open the [latest release](https://github.com/cdebaecker/openic/releases/latest) and download:

- **Windows:** `OpenIC-windows-x86_64.zip`. Unzip it anywhere, for example in `Documents\OpenIC`.
- **Linux:** `OpenIC-linux-x86_64.tar.gz`. Unpack it anywhere (`tar -xzf OpenIC-linux-x86_64.tar.gz`).

### 3. First launch

Start **`OpenIC.exe`** (Windows) or **`OpenIC.x86_64`** (Linux).

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

- Saves are kept in OpenIC's user folder, `saves` in `%APPDATA%\Godot\app_userdata\OpenIC` on
  Windows (paste that path into the File Explorer address bar) or
  `~/.local/share/godot/app_userdata/OpenIC` on Linux. The imported game data and the settings
  are there too.
- **Saves from the original game:** if you played on a real X68000 or an emulator, OpenIC can
  use your saves. In **Options**, choose **Import saves from a disk image…** and pick the disk
  image that holds them (or drop the image onto the window). Game disk 1 and user disks both
  work.

## Options worth knowing

- **Music played on:** the X68000's own FM sound, or the game's Roland MT-32 version when you
  imported it (see [MT-32 music](#mt-32-music)).
- **FM music: Live or Recorded.** Live (the default) synthesizes the music as the X68000's
  sound chip did, with [ymfm](https://github.com/aaronsgiles/ymfm). Recorded plays the music
  rendered during the import.
- **Game speed and Battle speed:** speed up walking and battles. **Tab** fast-forwards while
  held.
- **Fixes:** optional fixes for bugs in the original, all on by default except the enemy action
  choice, which changes the game's balance. The enemy action choice and the item and spell
  effects follow the MSX version of the game, whose code shows the intended values.
- **Smooth movement:** scrolls the map smoothly, unlike the original. Off by default.

## MT-32 music

The X68000 version of Illusion City can also play its music on a Roland MT-32 sound module.
OpenIC can build that version during the import, with [Munt](https://github.com/munt/munt)
emulating the module. Munt needs the module's ROMs, which aren't included: use dumps of your own
MT-32, CM-32L or LAPC-I (a control ROM and a PCM ROM).

1. Put the two ROM files in the folder with your disk images (or in a subfolder of it). Their
   names don't matter.
2. Run the import. The import screen says "MT-32 ROMs: found" before it starts, and the import
   takes about 30 seconds longer. The game data grows to about 85 MB.
3. In **Options**, set **Music played on** to **Roland MT-32**.

The ROMs are only read during the import. To add the MT-32 music after an import without it,
start over with a fresh import (see below), with the ROMs in the folder.

## MSX music

Illusion City also came out on the MSX turbo R, with its own FM arrangements of the music for
the MSX-MUSIC chip. If you have that version too, OpenIC can play its music: during the import
it runs the MSX version's own sound driver on your MSX disks and keeps what the driver sends to
the sound chips, which OpenIC then synthesizes live like the X68000's FM music.

1. Put the MSX disk images (720 KB `.dsk` files) in the folder with your X68000 disk images, or
   in a subfolder of it. Game disk 1 is needed; the songs are spread over game disks 1–8, and a
   song whose disk is missing plays in its X68000 version.
2. Run the import. The import screen says "MSX disks: found" before it starts.
3. In **Options**, set **Music played on** to **FM (MSX turbo R)**.

The MSX music needs the live synthesis included in the releases. The sound effects and short
jingles stay the X68000's.

## Troubleshooting

- **"Some disks are missing from that folder":** the import screen lists which of the seven
  disks it found. Check that all seven images are in the same folder and are complete, in DIM,
  XDF, HDM or D88 format.
- **Starting over with a fresh import:** close OpenIC and delete `gamedata.zip` (and the
  `gamedata` folder, if an older version made one) in OpenIC's user folder (see
  [Saving](#saving)). The next launch runs the import again. Your saves and settings are kept.
- **Upgrading from 0.2 or older:** those versions imported into a `gamedata` folder of about
  190 MB. It still works, but you can delete it to import again into the new 17 MB
  `gamedata.zip`.
- **No music:** check **Music volume** in Options. If live music doesn't play on your
  computer, set **FM music** to **Recorded**.
- **"MT-32 ROMs" isn't shown on the import screen:** OpenIC looks for a file of a control ROM's
  size (32 or 64 KB) and one of a PCM ROM's size (512 KB or 1 MB) in the disk folder or one of
  its subfolders. ROMs split into several files must be joined first.
- **Removing OpenIC:** delete the folder you unpacked it into and OpenIC's user folder (see
  [Saving](#saving)).

## Other systems

The releases are for Windows and Linux. On macOS you can run OpenIC from source (below), with
the native parts built for your Mac or without them (the music then plays from files rendered
during the import, and there is no MT-32 music).

## Running from source

- [Godot 4.4+](https://godotengine.org/download) (tested with 4.7)
- [Node.js 20+](https://nodejs.org/) on PATH: the importer runs the original game in an X68000
  emulator (`src/`) to extract and convert its data (`tools/export/`)

Build the game data from your disks, then open `godot/project.godot` in Godot and run it:

```bash
node tools/openic/import.mjs --disks <folder with the 7 images> --out godot/gamedata --folder
```

To have live music and the MT-32 renderer, build the native parts once (needs CMake and a C++
compiler):

```bash
node tools/native/build.mjs
```

Then add `--mt32-roms <folder with the ROMs>` to the import command for the MT-32 music.

## What is where

| Path | |
|---|---|
| `godot/` | the game (GDScript) |
| `tools/openic/import.mjs` | the importer: identifies the disks, boots the game, runs the exporters |
| `tools/export/` | exporters: pictures, sprites, maps, events, music (the game's own sound driver in the emulator), cutscenes, battle and system tables |
| `src/` | the X68000 emulator the exporters use |
| `text/` | translations: dialogue by message id, interface glossary (keys hashed, restored from your disks), French tables, opening subtitles |
| `tools/openic/package.mjs` | builds a release (game + importer + Node.js) |
| `native/`, `tools/native/build.mjs` | chipsynth, the FM music synthesized live (ymfm), a Godot extension; mt32render, the MT-32 music rendered with Munt for the importer |
| `.github/workflows/release.yml` | a pushed tag `v*` builds the Windows and Linux releases on GitHub Actions and attaches them to that tag's release |

## Licence

OpenIC's code and translations are free software under the GNU General Public License v3.0
(`LICENSE`): you may use, change and share them, and versions you distribute must stay under the
same licence with their source. The licence does not cover Illusion City itself: its pictures,
music, text and program belong to their rights holders and are not part of this repository.

## Credits

Illusion City © 1991 MicroCabin and its current rights holder. All trademarks belong to their
owners. The game font is Unifont JP (SIL OFL 1.1, `godot/fonts/`). Live music: ymfm
(BSD 3-Clause, Aaron Giles) and godot-cpp (MIT). MT-32 music: Munt's libmt32emu (LGPL 2.1 or
later). The releases include Node.js (MIT).
