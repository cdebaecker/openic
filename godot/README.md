# Illusion City — Godot 4 port

A native port of 幻影都市 (Illusion City, X68000, MicroCabin 1991) to Godot 4.3+. Unofficial,
non-commercial fan project, made with the rights holder's permission under the terms in
`../PERMISSION.md` (the splash screen they require is `scripts/screens/splash.gd`).

The project contains no game data. The assets are exported from the original disk images by
the tools in `../tools/export` and loaded when the game starts.

## Running

```bash
# once, from the repository root (disk images one level up, see ../README.md):
node tools/export/build.mjs            # all exporters -> godot/gamedata (about 2 minutes; the exporters run in parallel)
node tools/export/build.mjs --reuse    # only re-assemble what is already in ../work/export
node tools/export/build.mjs --zip      # also godot/gamedata.zip, for exported builds
```

Then open `godot/` in Godot 4.3 or later and run it. Exported builds look for `gamedata/` or
`gamedata.zip` next to the executable, then in the user data folder, or take
`-- --data=<folder>` (see `scripts/autoload/game_data.gd`). Without game data the game shows its
importer (`scripts/screens/missing_data.gd`, `scripts/systems/disc_import.gd`): the player picks
the folder with the seven disk images and `tools/openic/import.mjs` builds the data into
`user://gamedata` (under 2 minutes; Node.js on PATH, or `importer/` next to a release).

OpenIC (https://github.com/cdebaecker/openic) is the public version: the game, the importer's
tools and the translations, nothing of the original. `node tools/openic/sync.mjs ../openic`
refreshes it from the last commit here (glossary keys hashed, `tools/openic/glossary.mjs`;
project name "OpenIC"); `node tools/openic/package.mjs --godot <editor>` there makes a Windows
release with the importer and Node.js.

Builds (`export_presets.cfg`; Godot 4.3 export templates installed):

```bash
godot --headless --path godot --export-release Linux   build/linux/IllusionCity.x86_64
godot --headless --path godot --export-release Windows build/windows/IllusionCity.exe
godot --headless --path godot --export-release Web     build/web/index.html
```

The builds contain no game data: put `gamedata/` or `gamedata.zip` next to the executable.

The **web** build is deferred until the desktop game is stable: the preset exports and a first
data-loading path exists (a file picker for `gamedata.zip` on the missing-data screen, kept in
the browser's storage), but it is not maintained or tested beyond that for now.

Controls: mouse, cursor keys, Enter/Space (confirm), Esc/right click (cancel), gamepad A/B.
In cutscenes, hold confirm to fast-forward and press cancel to skip. The title menu's Language
entry (or L) switches between English, French and Japanese. "Start from the beginning" first asks how to save: the original's way (save points only) or
quick saves anywhere, where in the field F5 / LB quick saves and F9 / L3 quick loads (whenever
the player has control; one slot, `user://saves/quick/QUICK.DAT`, in the original's save format;
"Continue" on the title also picks it up when it is the newest save). Options can change it later.
All text, the port's own screens included, is drawn with the game font (`fonts/`, 16-dot).

## Layout

| Path | What |
|---|---|
| `scripts/main.gd` | screen flow: splash → title → cutscenes / game |
| `scripts/autoload/game_data.gd` | finds and loads the exported data (PNG, JSON, OGG/WAV) |
| `scripts/autoload/audio.gd` | music with loop points, sound effects (`audio/index.json`); FM music played live from chip logs by the chipsynth GDExtension when built (`native/README.md`), else from the rendered files |
| `scripts/autoload/game_text.gd` | English / French / Japanese text from the translation tables and glossaries |
| `scripts/screens/` | splash (required credit), title menu, cutscene player |
| `scripts/cutscene/` | graphic VRAM model and text layer used by the cutscene player |
| `scripts/field/`, `scripts/events/` | the field (map, movement, drawing) and the event scripts (VM, cutscenes, messages) |
| `scripts/systems/` | game systems model and the command / shop / save interface |
| `scripts/dev/` | autopilot and the tests against the reference models |
| `shaders/x68k_graphic.gdshader` | four 16-colour pages composited as the X68000 video controller does |

## How faithful it is

The port replays and reimplements the original rather than emulating the machine. Where it can,
each part is checked against the original running in the emulator (`../src`, which stays the
reference implementation):

- Asset decoders (`docs/formats/*.md`) are checked against what the game puts in memory/VRAM.
- Cutscenes: the timelines reproduce the original's graphic VRAM word for word on every compared
  frame, and `tools/export/cutscenes/check_godot_model.mjs` checks the player's copy/dissolve
  algorithm (`scripts/cutscene/vram.gd`) against the reference after every step of both
  timelines. `tools/godot/compare_cutscenes.sh` screenshots Godot and the emulator at the middle
  of every scene: in the opening 20 of 25 frames are pixel-identical and the others differ by
  at most 1.4% (scroll writes and animation steps landing one frame apart); in the ending the
  differences are the narration, shown in English.

Field development options: `-- --field-start=A00@142,7` starts on a map with the party at a tile;
`-- --load-block=<file>` starts from a saved 954-byte block (an ISV file, or a block taken from an
emulator state), `-- --service=<n>` then opens builtin 35's service n (1 inn, 2-4 shops); the
title menu has the field (from the first free control of a new game) and a map viewer.

The whole check against the original, from nothing (emulator states, reference traces and their
verification, golden files, every test below and the story route): `GODOT=<godot executable>
tools/godot/test_all.sh` from the repository root (about an hour of recording, then about three
minutes of tests and the route; `--skip-record` reuses what is in `../work`). Summary in
`../work/test_all/summary.txt`.

Testing without a person at the keyboard: `-- --autopilot=<script.json>` plays scripted input
(actions, raw keys, pointer moves and clicks) and takes screenshots (`scripts/dev/autopilot.gd`); `-- --cutscene-shots=f1,f2 --shot-dir=<dir>`
jumps the cutscene player to timeline frames. Run under `xvfb-run` with
`--rendering-driver opengl3 --fixed-fps 60`.

## Status and roadmap

1. **Asset export** — done: pictures, sprite sets (CG9), maps/tilesets/events/tables, music and
   sound effects, cutscene timelines.
2. **Front end** — done: splash, title menu, opening and ending players (English narration
   in the ending; English subtitles for the text the opening draws in its pictures,
   `data/text/opening_subtitles.json`). Options (title > Options, `scripts/screens/options.gd`,
   saved by the `Settings` autoload in `user://settings.cfg`): fullscreen (F11), window size,
   pixel-perfect scaling, music / effects volume, FM music live or recorded, language, smooth
   movement, game and battle
   speed (`Engine.time_scale`; hold Tab / RB to fast-forward), the battle bug fixes, key and
   gamepad bindings, and importing the original's saves from X68000 disk images (XDF, HDM, DIM,
   D88; `scripts/systems/disk_image.gd`, `save_import.gd`; a file dropped on the window works too).
3. **Maps** — done, with known gaps: the field screen draws the frame, the map window (main layer,
   overlay, foreground tiles over the overlay and the sprites) and the party; movement, sliding,
   pushing, followers, mouse/pad input, camera and triggers follow `docs/field.md` and reproduce
   all 526 recorded ticks of the reference traces (`-- --field-test=<traces>`), on A00 and seven
   later maps (BK2, B01, CK2, C00, E3X, AK3, J5X). Rendered states match the original's
   screenshots in all 680 cases (`-- --field-render-test=<traces>`: layer draw modes, masked
   foreground over each sprite, the attribute-bit rule, tile animation; the test compares each
   screenshot with the page flips the trace logs, torn frames included, and checks the tile
   animation remaps against the original's at every flip). The foreground over a sprite is walked
   over the box of the frame's parts (f_74d74 / f_7504c). Direct doors warp
   as in the original; map actors (NPCs) are drawn, moved and animated by their scripts and wander
   (f_76980), map and tile animations run (tile animation: f_742e8 / f_749aa, once per field
   redraw; e.g. the blinking floor lights under the vehicle on AK3), the partial-foreground rule (attribute bits 1/9) is
   applied, script doors warp through the VM.
   The party panel shows the names and LV/HP/MP as the original's (English names drawn over the
   name tiles in English mode).
4. **Events** — playable through the intro: "Start from the beginning" runs IC_MAIN's new-game
   entry from the original's new-game state, then A00's scripts: cutscenes (actors walking,
   camera, map animations), dialogue in the original window with the English table, conversation
   menus, and free control afterwards. The script VM matches the reference model on 443 cases
   (`-- --vm-test`), the message engine reproduces every recorded message (`-- --message-test`).
   Map actors (NPCs) load from the EVT data, animate and are shown/hidden by scripts; talking to
   them and triggers run their scripts; script warps load maps; event pictures (builtin 20, G).
   Shops, inns, saving and the TALK command came with milestone 5, battles (builtin 5) with
   milestone 6; name inserts in messages are filled in.
5. **Systems** — playable, with known gaps. The game systems (`scripts/systems/systems_model.gd`:
   stats, level-ups, effects, items, magic, equipment, shops, inn, checkpoint, save files, settings)
   reproduce the reference model on 10 239 cases (`-- --systems-test=<golden.json>`, from
   `tools/systems/golden.mjs`). The interface (`scripts/systems/ui_*.gd`, docs/systems-ui.md):
   command panel (mouse) and command menu (confirm on the field), money window, MAGIC, ITEM (use,
   swap, drop), EQUIP, TALK (CONSULT.SCN), STATUS (profile, skills, combat), SYSTEM (speed,
   switches, BGM, load), shops and the inn (builtin 35), the save menu (builtin 1) with the slot
   list; the screen builders match the verified reference on 11 552 outputs
   (`-- --ui-test=<golden.json>`, from `tools/systems-ui/golden.mjs`). Text goes through the
   interface glossary as in the web build. Saves are the original's `ISV0-7.DAT` files (954
   bytes) in `user://saves/disk0` (game disk 1) and `user://saves/user` (user disk), so saves
   from the original load as they are; "Continue from save" on the title loads the newest one.
   The movement and message speeds act as in the original (minimum vsyncs per field tick,
   message end delay).
6. **Battle** — playable, with known gaps. The battle logic (`scripts/battle/battle_model.gd`,
   spec docs/battle.md) replays the reference model's golden battles identically (325 battles,
   1 017 682 log entries: `-- --battle-test=<golden.json>`); the reference itself reproduces 24 of
   the 26 recorded battles exactly (story, contact, flight, rewards, status effects, magic, items,
   transformation, guests, back row, defeat, and the event battles of groups 0-2 and 4 on B6X,
   C60, C6Y and E3X). The screen
   (`battle_view.gd`, `battle_anim.gd`, spec docs/battle-ui.md) is pixel-exact on the 1 355 recorded
   arena snapshots and reproduces the 255 recorded action animations (`-- --battle-arena-test=`).
   `battle_screen.gd` runs battles on contact with enemies and from builtin 5: commands, spell /
   item lists, target cursor, messages (English), animations, victory and defeat; event battles
   run the map's hooks (+8/+10/+12) and the enemies' scripts (builtins 29, 37, 39). Bugs of the
   original fixed in the game (docs/battle.md): the 16-bit damage overflow ("max weapon skill
   stops hitting"), status expiry lines, the flight check (each can be turned off in the options,
   and the enemy action-choice fix turned on). GAME OVER waits for a click, then the Quick Load
   checkpoint is restored (f_6b87c); builtin 5(99) ends the game and plays the ending. Effect
   set 2 per map, scrolling battle layers, battle tile animation, the contact-battle palette
   flash, the per-tile layer rule (attribute bits 6/7), enemy call for help / split and
   impact-time messages are traced (J20, H51, I52, F60, B6X) and reproduced: the arena test
   covers 1 355 snapshots of seven traces and 255 actions, all exact. Event battles run the map's
   trigger-block +8 entry once before the battle is shown, as the original does: its scripts hide
   records (F7X holds an enemy back, the last battle on J07 leaves Meihong and Lee out); all 30
   recorded battles replay exactly, every event group included (groups 5-8 recorded as the story
   starts them, from the story route's states).
7. **Whole game** — completable unattended. Stability: `-- --sweep-map=ID` runs every map's enter /
   always scripts, all triggers and talk entries unattended; all 150 maps complete without errors.
   Story routes: the recorded A00 -> A10 and A10 -> A02 legs end in the same game state as the
   original's saves. From A02 to the ending, `tools/route/story.txt` (runner
   `scripts/dev/story_route.gd`; `-- --load-block=<a02-after.block> --story-route=@tools/route/story.txt
   --route-out=<dir>`, about 10 minutes headless) plays the whole story to builtin 5(99) and the
   ending (34 story legs), writing the state block at 16 milestones. The same route played in the
   original under the emulator (`tools/route/emu_route.mjs`, battles switched off;
   `tools/route/compare_blocks.py`) reaches the ending with the same steps, and the 17 compared
   milestones agree on story variables, chests, key items, party, money and return point (the
   differences are explained in the route's notes). The route skips wandering battles and so
   levels and equips the party by development shortcuts (`ROUTE CHEAT` lines) before the event
   battles; playing it legitimately is for the playtest. English: every dialogue page, interface
   string and IC_TABLE string the port prints has English, and French (`text/messages_fr.json`,
   `text/glossary_fr.json`, `tools/textbatch.mjs fr-*`; accented letters use the engine's spare
   half-width slots, `text_codec.gd` LATIN). Remaining: a human playtest (balance,
   feel, reachability; Holland's cell on F51 opens only after the map is reloaded once after the
   bluff scene, in the original as in the port, and the route walks there on both layers);
   desktop builds export (web deferred). Music is the X68000's FM version only; the game's
   MIDI (MT-32) mode is not reproduced (`docs/formats/audio.md`).
