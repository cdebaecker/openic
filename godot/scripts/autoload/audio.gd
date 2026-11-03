extends Node
## Music and sound effects, named as in audio/index.json of the exported data
## (items: {name, kind, file, loop, loop_start_sec, loop_end_sec}, files relative to audio/).
## Each looping file is intro + one loop body. Sound effects play on a small pool of voices.
## The MT-32 versions of the area music (mt32/index.json, same fields) replace the FM tracks of
## the same name when the device is "mt32"; the jingles and the opening / ending music exist
## only in FM, as in the original.

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
var _mt32 := {}
var device := "fm"


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
	if GameData.exists("mt32/index.json"):
		_read_index("mt32", _mt32)


func _read_index(dir: String, into: Dictionary) -> void:
	var idx: Variant = GameData.json(dir.path_join("index.json"))
	var entries: Array = idx.get("items", []) if idx is Dictionary else []
	for e: Dictionary in entries:
		e["file"] = dir.path_join(e["file"])
		into[e["name"]] = e


## True when the game data has the MT-32 music.
func has_mt32() -> bool:
	_load_index()
	return not _mt32.is_empty()


## "fm" or "mt32"; the playing area music switches at once.
func set_device(d: String) -> void:
	if d == device:
		return
	var old := device
	device = d
	var track := current
	if track != "" and _music.playing and _music_info_for(track, old) != _music_info(track):
		current = ""
		play_music(track)


func _music_info(track: String) -> Dictionary:
	return _music_info_for(track, device)


func _music_info_for(track: String, d: String) -> Dictionary:
	_load_index()
	if d == "mt32" and _mt32.has(track):
		return _mt32[track]
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
	_music.stream = GameData.audio(info["file"], loop_start)
	current = track
	_music.volume_db = -40.0 if fade_in > 0.0 else music_volume_db
	_music.play()
	if fade_in > 0.0:
		create_tween().tween_property(_music, "volume_db", music_volume_db, fade_in)


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
