extends Node
## Music and sound effects, named as in audio/index.json of the exported data
## (items: {name, kind, file, loop, loop_start_sec, loop_end_sec}, files relative to audio/).
## Each looping file is intro + one loop body. Sound effects play on a small pool of voices.
## FM music plays live from its chip log (chip_log in the index: the OPM and ADPCM writes, played
## by the chipsynth GDExtension with ymfm, native/) when the extension is loaded; otherwise, or
## with live_synth off, from the rendered files.

const SFX_VOICES := 4

var current := ""
var music_volume_db := 0.0:
	set(v):
		music_volume_db = v
		_music.volume_db = v

var sfx_volume_db := 0.0

var _music := AudioStreamPlayer.new()
var _sfx: Array[AudioStreamPlayer] = []
var _next_sfx := 0
var _index := {}
var live_synth := true


func _ready() -> void:
	add_child(_music)
	for i in SFX_VOICES:
		var p := AudioStreamPlayer.new()
		add_child(p)
		_sfx.append(p)


## The options screen's volumes (Settings).
func set_volumes(music_db: float, sfx_db: float) -> void:
	music_volume_db = music_db
	sfx_volume_db = sfx_db
	for p in _sfx:
		p.volume_db = sfx_db


func _load_index() -> void:
	if not _index.is_empty() or not GameData.exists("audio/index.json"):
		return
	_read_index("audio", _index)


func _read_index(dir: String, into: Dictionary) -> void:
	var idx: Variant = GameData.json(dir.path_join("index.json"))
	var entries: Array = idx.get("items", []) if idx is Dictionary else []
	for e: Dictionary in entries:
		if e.get("file") != null:
			e["file"] = dir.path_join(e["file"])
		if e.has("chip_log"):
			e["chip_log"] = dir.path_join(e["chip_log"])
		into[e["name"]] = e


## True when the game data has the FM music as rendered files (not only as chip logs).
func has_recorded_music() -> bool:
	_load_index()
	for e: Dictionary in _index.values():
		if e.get("kind") == "music" and e.get("file") != null:
			return true
	return false


## True when the chipsynth extension is loaded (FM music can play live).
func can_synthesize() -> bool:
	return ClassDB.class_exists("AudioStreamChipLog")


## Live or recorded FM music; the playing FM track switches at once.
func set_live_synth(on: bool) -> void:
	if on == live_synth:
		return
	live_synth = on
	var track := current
	if track != "" and _music.playing and _music_info(track).has("chip_log"):
		current = ""
		play_music(track)


func _music_info(track: String) -> Dictionary:
	_load_index()
	return _index.get(track, {})


func track_info(track: String) -> Dictionary:
	_load_index()
	return _index.get(track, {})


func play_music(track: String, fade_in := 0.0) -> void:
	if track == current and _music.playing:
		return
	var info := _music_info(track)
	if info.is_empty():
		push_warning("Audio: unknown track %s" % track)
		return
	var loop_start: float = info.get("loop_start_sec", 0.0) if info.get("loop", false) else -1.0
	var live := _chip_stream(info)
	if live == null and info.get("file") == null:
		push_warning("Audio: %s has only a chip log and the chipsynth extension is not loaded" % track)
		return
	_music.stream = live if live != null else GameData.audio(info["file"], loop_start)
	current = track
	_music.volume_db = -40.0 if fade_in > 0.0 else music_volume_db
	_music.play()
	if fade_in > 0.0:
		create_tween().tween_property(_music, "volume_db", music_volume_db, fade_in)


## The track's chip log as an AudioStreamChipLog, or null (no extension, no log, live_synth off).
func _chip_stream(info: Dictionary) -> AudioStream:
	# live_synth off: the rendered file, when the game data has one (a live-music import has none)
	if (not live_synth and info.get("file") != null) or not info.has("chip_log") or not can_synthesize():
		return null
	var rel: String = info["chip_log"]
	var bytes := FileAccess.get_file_as_bytes(GameData.path(rel))
	if bytes.is_empty():
		return null
	var s: AudioStream = ClassDB.instantiate("AudioStreamChipLog")
	s.set("data", bytes)
	s.set("loop", info.get("loop", false))
	return s if s.call("is_valid") else null


func stop_music(fade_out := 0.0) -> void:
	current = ""
	if fade_out <= 0.0:
		_music.stop()
		return
	var t := create_tween()
	t.tween_property(_music, "volume_db", -40.0, fade_out)
	t.tween_callback(_music.stop)


func play_sfx(track: String) -> void:
	var info := track_info(track)
	if info.is_empty():
		return
	var p := _sfx[_next_sfx]
	_next_sfx = (_next_sfx + 1) % SFX_VOICES
	p.stream = GameData.audio(info["file"])
	p.play()
