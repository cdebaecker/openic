# chipsynth

Plays the game's FM music live instead of from rendered files: a GDExtension with an
`AudioStreamChipLog` stream for Godot (used by `godot/scripts/autoload/audio.gd`).

- **Chip logs.** The audio exporter writes `audio/music/<song>.icl` for each song
  (`tools/export/audio/chiplog.mjs`). A log holds the song's OPM register writes and ADPCM events
  with their sample times, cut into an intro and a loop body like the WAV, and the ADPCM bytes
  the song plays.
- **OPM.** [ymfm](https://github.com/aaronsgiles/ymfm)'s YM2151 runs at 4 MHz, so it outputs
  62500 Hz and Godot resamples it.
- **ADPCM.** The MSM6258 decoder is modelled on the emulator's (`src/adpcm.js`).
- **Output.** A DC blocker is applied as on the WAVs. Levels match the exported files.
- **Fallback.** Without the extension, or with `Audio.live_synth` off, the game plays the
  rendered files.

## Build

```bash
node tools/native/build.mjs
```

The script fetches godot-cpp and ymfm at pinned commits into `native/deps`. It then builds:

- `godot/bin/chipsynth.<platform>.template_release.<arch>` (the extension, loaded through
  `godot/chipsynth.gdextension`);
- `native/build/Release/icl2wav`.

You need CMake and a C++17 compiler. The `.gdextension` lists Windows and Linux x86_64.

## Checking

The emulator's OPM can replay a log:

```bash
node tools/export/audio/chipplay.mjs <song.icl> <song.wav> --dc
```

The game's player can render one:

```bash
icl2wav <song.icl> <out.wav>
```

## Licences

- ymfm: BSD 3-Clause, © Aaron Giles.
- godot-cpp: MIT, © the Godot Engine contributors.
