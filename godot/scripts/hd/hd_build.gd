extends Node
## Builds the HD pictures (scripts/hd/hd_art.gd) in a helper process: the game starts itself with
## --hd-build and --rendering-method forward_plus (scripts/hd/hd_art.gd start_build), minimized,
## and this node bakes every art kind with Real-ESRGAN on the GPU (scripts/hd/esrgan.gd), then
## quits. Progress goes to user://hd/progress.txt ("<done> <total>" in pixels, then "done" or
## "error <reason>"), read by the options screen. A build that stops resumes where it was.

const HdArt := preload("res://scripts/hd/hd_art.gd")
const Esrgan := preload("res://scripts/hd/esrgan.gd")

var _esrgan := Esrgan.new()
var _jobs: Array = []        # {key, size, make: Callable -> [index image, palette, hide unmasked]}
var _total := 0
var _done := 0
var _next := 0


func _ready() -> void:
	DirAccess.make_dir_recursive_absolute(HdArt.DIR)
	_write(HdArt.DIR.path_join("builder.pid"), str(OS.get_process_id()))
	if not _esrgan.setup():
		_progress("error gpu")
		DirAccess.remove_absolute(HdArt.DIR.path_join("builder.pid"))
		get_tree().quit(1)
		return
	# a stamp of what this build makes: files from another version or other game data are redone
	var stamp := {"version": HdArt.VERSION, "data": HdArt.data_stamp()}
	# (a stopped build, or a finished one: its pictures are kept)
	var building: Variant = null
	for f in ["building.json", "manifest.json"]:
		if building == null and FileAccess.file_exists(HdArt.DIR.path_join(f)):
			building = JSON.parse_string(FileAccess.get_file_as_string(HdArt.DIR.path_join(f)))
	var resume: bool = building is Dictionary and int(building.get("version", 0)) == HdArt.VERSION \
		and str(building.get("data", "")) == stamp["data"]
	DirAccess.remove_absolute(HdArt.DIR.path_join("manifest.json"))
	if not resume:
		_clear(HdArt.DIR)   # pictures of another version or other game data
	_write(HdArt.DIR.path_join("building.json"), JSON.stringify(stamp))
	_list_jobs()
	if resume:
		var left: Array = []
		for j in _jobs:
			if FileAccess.file_exists(HdArt.file_of(j["key"])):
				_done += int(j["size"])
			else:
				left.append(j)
		_jobs = left
	_progress("%d %d" % [_done, _total])


## One job a frame, so the window stays responsive.
func _process(_delta: float) -> void:
	if _next >= _jobs.size():
		set_process(false)
		var stamp := {"version": HdArt.VERSION, "data": HdArt.data_stamp()}
		_write(HdArt.DIR.path_join("manifest.json"), JSON.stringify(stamp))
		DirAccess.remove_absolute(HdArt.DIR.path_join("building.json"))
		DirAccess.remove_absolute(HdArt.DIR.path_join("builder.pid"))
		_progress("done")
		get_tree().quit()
		return
	var j: Dictionary = _jobs[_next]
	_next += 1
	var made: Array = j["make"].call()
	if not made.is_empty() and made[0] != null:
		var img: Image
		if made.size() > 3 and made[3]:
			img = _bake_tiles(made[0], made[1])
		else:
			img = _esrgan.bake(made[0], made[1], made[2])
		var path := HdArt.file_of(j["key"])
		DirAccess.make_dir_recursive_absolute(path.get_base_dir())
		img.save_png(path)
	_done += int(j["size"])
	_progress("%d %d" % [_done, _total])


## A sheet of 16x16 tiles, each upscaled on its own as if repeated around itself (MARGIN pixels
## of itself on each side): map tiles mostly repeat (floors, walls), and their neighbours in the
## sheet have nothing to do with them.
const MARGIN := 8


func _bake_tiles(sheet: Image, palette: PackedColorArray) -> Image:
	var cols := sheet.get_width() / 16
	var n := cols * (sheet.get_height() / 16)
	var per_row := 16
	var cell := 16 + 2 * MARGIN
	var rows := ceili(n / float(per_row))
	var mosaic := Image.create_empty(per_row * cell, rows * cell, false, Image.FORMAT_RGBA8)
	var around := Image.create_empty(48, 48, false, Image.FORMAT_RGBA8)
	for k in n:
		var src := Rect2i((k % cols) * 16, (k / cols) * 16, 16, 16)
		for d in 9:
			around.blit_rect(sheet, src, Vector2i((d % 3) * 16, (d / 3) * 16))
		mosaic.blit_rect(around, Rect2i(16 - MARGIN, 16 - MARGIN, cell, cell),
			Vector2i((k % per_row) * cell, (k / per_row) * cell))
	var hd := _esrgan.bake(mosaic, palette, false)
	var s := HdArt.SCALE
	var out := Image.create_empty(sheet.get_width() * s, sheet.get_height() * s, false, Image.FORMAT_RGBA8)
	for k in n:
		out.blit_rect(hd, Rect2i(((k % per_row) * cell + MARGIN) * s, ((k / per_row) * cell + MARGIN) * s, 16 * s, 16 * s),
			Vector2i((k % cols) * 16 * s, (k / cols) * 16 * s))
	return out


## Delete the pictures under `dir`.
static func _clear(dir: String) -> void:
	var d := DirAccess.open(dir)
	if d == null:
		return
	for f in d.get_files():
		if f.ends_with(".png"):
			d.remove(f)
	for sub in d.get_directories():
		_clear(dir.path_join(sub))


func _progress(text: String) -> void:
	_write(HdArt.DIR.path_join("progress.txt"), text)


func _write(path: String, text: String) -> void:
	var f := FileAccess.open(path, FileAccess.WRITE)
	if f != null:
		f.store_string(text)


## (`size`: the picture's, for the progress; `tiles`: made as separate tiles, about 4x the work)
func _add(key: String, size: Vector2i, make: Callable, tiles := false) -> void:
	var work := size.x * size.y * (4 if tiles else 1)
	_jobs.append({"key": key, "size": work, "make": make})
	_total += work


static func _index_image(rel: String) -> Image:
	var img := Image.new()
	if img.load_png_from_buffer(FileAccess.get_file_as_bytes(GameData.path(rel))) != OK:
		return null
	img.convert(Image.FORMAT_RGBA8)
	return img


static func _png_size(rel: String) -> Vector2i:
	# the IHDR of a PNG: width and height at bytes 16 and 20, big-endian
	var f := FileAccess.open(GameData.path(rel), FileAccess.READ)
	if f == null:
		return Vector2i.ZERO
	f.big_endian = true
	f.seek(16)
	return Vector2i(f.get_32(), f.get_32())


static func _colors(words: Array) -> PackedColorArray:
	var pal := PackedColorArray()
	for w in words:
		pal.append(HdArt.x68k_color(int(w)))
	return pal


func _list_jobs() -> void:
	var index: Dictionary = GameData.json("data/index.json")
	# Field: the maps' tilesets in their own palettes; the sprites, frame and panel are drawn in
	# the map's palette, baked in the most common one (entries 8-15, the sprites' and the
	# frame's, are the same in nearly every map; others change through the palette in the game)
	var counts := {}
	var tilesets := {}
	for m in index.get("maps", []):
		for k in ["vrChr", "subChr"]:
			if m.get(k) != null:
				tilesets[str(m[k]["json"])] = true
		if m.get("vrChr") != null and m.get("vrMap") != null:
			var p := str(GameData.json("data/" + m["vrChr"]["json"]).get("palette", []))
			counts[p] = int(counts.get(p, 0)) + 1
	var common := ""
	for p: String in counts:
		if common == "" or counts[p] > counts[common]:
			common = p
	var field_pal := _colors(Array(HdArt.tileset_words({"palette": JSON.parse_string(common)})))
	for rel: String in tilesets:
		var ts: Dictionary = GameData.json("data/" + rel)
		var n := Marshalls.base64_to_raw(ts["tilesB64"]).size() / 128
		_add("data/" + rel.get_basename(), Vector2i(16, n * 16), func() -> Array:
			var t: Dictionary = GameData.json("data/" + rel)
			return [HdArt.tileset_image(t), _colors(Array(HdArt.tileset_words(t))), false, true], true)
	_add("frame/field", _png_size("frame/field.idx.png"), func() -> Array:
		return [_index_image("frame/field.idx.png"), field_pal, false])
	# the window frames and the panel's pieces: tiles side by side, as the map's
	for rel: String in ["frame/window", "ui/asdf"]:
		_add(rel, _png_size(rel + ".idx.png"), func() -> Array:
			return [_index_image(rel + ".idx.png"), field_pal, false, true], true)
	for rel: String in _files("cg9", ".idx.png"):
		_add(rel, _png_size(rel + ".idx.png"), func() -> Array:
			return [_index_image(rel + ".idx.png"), field_pal, true])
	# Battle: the backgrounds' tiles in their own palettes; the frame and the sprites are drawn in
	# the background's palette, baked in the most common one
	counts = {}
	for b in GameData.json("battle/index.json").get("backgrounds", []):
		var rel := "battle/backgrounds/%s" % b["name"]
		var words: Array = GameData.json(rel + ".json").get("palette", {}).get("x68k", [])
		counts[str(words)] = int(counts.get(str(words), 0)) + 1
		_add(rel + ".tiles", _png_size(rel + ".tiles.idx.png"), func() -> Array:
			return [_index_image(rel + ".tiles.idx.png"), _colors(words), false, true], true)
	common = ""
	for p: String in counts:
		if common == "" or counts[p] > counts[common]:
			common = p
	var battle_pal := _colors(JSON.parse_string(common) if common != "" else [])
	_add("frame/battle", _png_size("frame/battle.idx.png"), func() -> Array:
		return [_index_image("frame/battle.idx.png"), battle_pal, false])
	for rel: String in _files("battle/sprites", ".idx.png"):
		_add(rel, _png_size(rel + ".idx.png"), func() -> Array:
			return [_index_image(rel + ".idx.png"), battle_pal, true])
	# Cutscene pictures in their own palettes, lines doubled as the cutscenes copy them
	for rel: String in _files("pic", ".idx.png"):
		var info: Variant = GameData.json(rel + ".json") if GameData.exists(rel + ".json") else {}
		var words: Array = []
		for w in (info as Dictionary).get("palette", []):
			words.append(str(w).hex_to_int())
		var s := _png_size(rel + ".idx.png")
		_add(rel, Vector2i(s.x, s.y * 2), func() -> Array:
			var img := _index_image(rel + ".idx.png")
			if img != null:
				img.resize(img.get_width(), img.get_height() * 2, Image.INTERPOLATE_NEAREST)
			return [img, _colors(words), false])
	# Event pictures in their own palettes, lines doubled as the field shows them
	for p in GameData.json("gep/index.json").get("pictures", []):
		var rel := "gep/" + str(p["idx"]).trim_suffix(".idx.png")
		var words: Array = []
		for w in p["palette"]:
			words.append(str(w).hex_to_int())
		var s := _png_size(rel + ".idx.png")
		_add(rel, Vector2i(s.x, s.y * 2), func() -> Array:
			var img := _index_image(rel + ".idx.png")
			if img != null:
				img.resize(img.get_width(), img.get_height() * 2, Image.INTERPOLATE_NEAREST)
			return [img, _colors(words), false])


## Game data files under `dir` ending in `suffix`, as paths without the suffix.
func _files(dir: String, suffix: String) -> Array:
	var out: Array = []
	var d := DirAccess.open(GameData.path(dir))
	if d == null:
		return out
	for f in d.get_files():
		if f.ends_with(suffix):
			out.append(dir.path_join(f.trim_suffix(suffix)))
	for sub in d.get_directories():
		out.append_array(_files(dir.path_join(sub), suffix))
	return out
