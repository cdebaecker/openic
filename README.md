# OpenIC

An unofficial fan port of **幻影都市 / Illusion City** (MicroCabin, 1991, Sharp X68000) to
[Godot 4](https://godotengine.org/), with English and French translations.

**This repository contains none of the original game.** No pictures, music, maps, script or
program code of the game are included. You need your own copy of the game: the seven floppy disk
images of the X68000 version (DIM, XDF, HDM or D88). On first launch the game asks for the folder
that holds them and builds its data from them, on your computer, in about 2 minutes.

This is a fan project, not affiliated with or endorsed by the rights holders of Illusion City.
It is non-commercial: it may not be sold or used to make money in any way.

## Playing

1. Get a release (Windows), or run the project from source (below).
2. Start the game. It shows the importer: press Enter and choose the folder with your seven disk
   images. Each disk is recognised by its contents, whatever the file names.
3. When the import is done the title menu appears. The data is kept in the game's user folder
   (`%APPDATA%/Godot/app_userdata/OpenIC/gamedata` on Windows), so the import
   runs only once.

The title menu's **Language** entry (or the L key) switches between English, French and Japanese.
**Options** has display, sound, speed, controls and optional fixes of the original's bugs.

## Running from source

- [Godot 4.4+](https://godotengine.org/download) (tested with 4.7)
- [Node.js 20+](https://nodejs.org/) on PATH: the importer runs the original game in an X68000
  emulator (`src/`) to extract and convert its data (`tools/export/`)

Open `godot/project.godot` in Godot and run it, or build the data from a terminal:

```bash
node tools/openic/import.mjs --disks <folder with the 7 images> --out godot/gamedata
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

## Licence

OpenIC's code and translations are free software under the GNU General Public License v3.0
(`LICENSE`): you may use, change and share them, and versions you distribute must stay under the
same licence with their source. The licence does not cover Illusion City itself: its pictures,
music, text and program belong to their rights holders and are not part of this repository.

## Credits

Illusion City © 1991 MicroCabin and its current rights holder. All trademarks belong to their
owners. The game font is Unifont JP (SIL OFL 1.1, `godot/fonts/`).
