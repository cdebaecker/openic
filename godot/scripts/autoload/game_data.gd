extends Node
## Finds and loads the exported game data (made by tools/export/build.mjs from the original
## disk images). The data is not part of the project: it is looked up at run time, so the
## project source can be shared without any of the game's assets.
##
## Search order for the data folder (the first one with a manifest.json wins):
##   1. command line: -- --data=<folder>
##   2. <folder of the executable>/gamedata, then gamedata.zip next to it
##   3. user://gamedata, then user://gamedata.zip
##   4. res://gamedata (development: the exporter writes there by default)
## A .zip is mounted as a resource pack and read from res://gamedata.

const WavLoader := preload("res://scripts/util/wav_loader.gd")

var root := ""
var manifest: Dictionary = {}

var _json_cache := {}
var _texture_cache := {}
var _audio_cache := {}


func _ready() -> void:
	locate()


func locate() -> bool:
	root = ""
	manifest = {}
	var exe_dir := OS.get_executable_path().get_base_dir()
	var candidates: Array[String] = []
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("--data="):
			candidates.append(arg.trim_prefix("--data="))
	candidates.append(exe_dir.path_join("gamedata"))
	candidates.append(exe_dir.path_join("gamedata.zip"))
	candidates.append("user://gamedata")
	candidates.append("user://gamedata.zip")
	candidates.append("res://gamedata")
	for c in candidates:
		var dir := c
		if c.ends_with(".zip"):
			if not FileAccess.file_exists(c) or not ProjectSettings.load_resource_pack(c, false):
				continue
			dir = "res://gamedata"
		if FileAccess.file_exists(dir.path_join("manifest.json")):
			root = dir
			manifest = _read_json(dir.path_join("manifest.json"))
			print("Game data: ", root)
			return true
	return false


func available() -> bool:
	return root != ""


func path(rel: String) -> String:
	return root.path_join(rel)


func exists(rel: String) -> bool:
	return root != "" and FileAccess.file_exists(path(rel))


func json(rel: String) -> Variant:
	if not _json_cache.has(rel):
		_json_cache[rel] = _read_json(path(rel))
	return _json_cache[rel]


func texture(rel: String) -> Texture2D:
	if _texture_cache.has(rel):
		return _texture_cache[rel]
	var bytes := FileAccess.get_file_as_bytes(path(rel))
	var img := Image.new()
	if bytes.is_empty() or img.load_png_from_buffer(bytes) != OK:
		push_error("GameData: cannot load image %s" % rel)
		return null
	var tex := ImageTexture.create_from_image(img)
	_texture_cache[rel] = tex
	return tex


## Audio from a .wav, .qoa or .ogg file. loop_start/loop_end are in seconds; loop_end <= 0 means
## the end of the file, loop_start < 0 means no loop.
func audio(rel: String, loop_start := -1.0, loop_end := 0.0) -> AudioStream:
	var key := "%s|%f|%f" % [rel, loop_start, loop_end]
	if _audio_cache.has(key):
		return _audio_cache[key]
	var stream: AudioStream = null
	if rel.get_extension().to_lower() == "ogg":
		var ogg := AudioStreamOggVorbis.load_from_file(path(rel))
		if ogg and loop_start >= 0.0:
			ogg.loop = true
			ogg.loop_offset = loop_start
		stream = ogg
	else:
		stream = WavLoader.load_file(path(rel), loop_start, loop_end)
	if stream == null:
		push_error("GameData: cannot load audio %s" % rel)
	_audio_cache[key] = stream
	return stream


func _read_json(file: String) -> Variant:
	var text := FileAccess.get_file_as_string(file)
	if text.is_empty():
		push_error("GameData: missing %s" % file)
		return null
	return JSON.parse_string(text)
