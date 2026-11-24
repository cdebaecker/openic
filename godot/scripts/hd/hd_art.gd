extends RefCounted
## HD art (the "HD anime" upscaling): the game's index images upscaled once on the player's
## machine by Real-ESRGAN's anime model (scripts/hd/esrgan.gd, run by scripts/hd/hd_build.gd in
## a helper process) and drawn instead of the pixels, mixed half and half with them.
##
## Nothing upscaled is shipped: the pictures are made from the player's own game data into
## user://hd. Each is stored at SCALE x its index image as mixes of palette entries, so the
## palette the game sets at the time (maps, fades, flashes, cutscene palettes) applies to it as to
## the pixels: a texel is mix(palette[i], palette[j], t), i the index under it, j and t the mix
## nearest to the upscaled colour in the palette it was baked with, j among the indices of the
## 3x3 pixels around:
##   R = j, G = t * 255, B = 0
##   A = 32 + i + 16 if the index image's mask is set there (0: no HD texel)
## (shaders/hd_art.gdshader decodes it).
##
## The art kinds are keyed by their game data path without extension ("cg9/GROUP00/000000",
## "frame/field", the tileset JSON "data/groups/GROUP01/000003", ...). Images loaded for drawing
## carry their key as the "hd" meta (register), so a blit can name its HD picture.

const SCALE := 2
const DIR := "user://hd"
## Bump when the baked pictures change (format, model, list): the game rebuilds them.
const VERSION := 4

static var _textures := {}
static var _ready_state := -1   # -1 unknown, 0 no, 1 yes
static var _pid := -1           # the helper process building the pictures


## The HD pictures are built and current.
static func built() -> bool:
	if _ready_state < 0:
		var m: Variant = JSON.parse_string(FileAccess.get_file_as_string(DIR.path_join("manifest.json")))
		_ready_state = 1 if m is Dictionary and int(m.get("version", 0)) == VERSION \
			and str(m.get("data", "")) == data_stamp() else 0
	return _ready_state == 1


static func forget() -> void:
	_ready_state = -1
	_textures.clear()
	if not DirAccess.dir_exists_absolute(DIR):
		DirAccess.make_dir_recursive_absolute(DIR)


## Start building the pictures in a helper process (scripts/hd/hd_build.gd): this executable
## again, with a renderer that has a RenderingDevice (the game itself runs the Compatibility one),
## minimized. False if it could not be started.
static func start_build() -> bool:
	if building():
		return true
	var args := PackedStringArray()
	if OS.has_feature("editor"):
		args.append_array(["--path", ProjectSettings.globalize_path("res://")])
	args.append_array(["--rendering-method", "forward_plus", "--window-minimized", "--", "--hd-build"])
	for a in OS.get_cmdline_user_args():
		if a.begins_with("--data="):
			args.append(a)
	var f := FileAccess.open(DIR.path_join("progress.txt"), FileAccess.WRITE)
	if f != null:
		f.store_string("0 1")
		f.close()
	_pid = OS.create_process(OS.get_executable_path(), args)
	return _pid > 0


## A build is running: the one this game started, or one an earlier run started (its process id
## in user://hd/builder.pid).
static func building() -> bool:
	if _pid <= 0:
		var saved := FileAccess.get_file_as_string(DIR.path_join("builder.pid")).strip_edges()
		if saved.is_valid_int():
			_pid = saved.to_int()
	# (a builder writes its progress after every picture: a silent one is gone, its id reused)
	var age := Time.get_unix_time_from_system() - FileAccess.get_modified_time(DIR.path_join("progress.txt"))
	return _pid > 0 and OS.is_process_running(_pid) and age < 120


## The build's state: {"fraction": 0..1} while it runs, {"done": true}, or {"error": reason}.
static func progress() -> Dictionary:
	var text := FileAccess.get_file_as_string(DIR.path_join("progress.txt")).strip_edges()
	if text == "done":
		forget()
		return {"done": true}
	if text.begins_with("error"):
		return {"error": text.trim_prefix("error").strip_edges()}
	var parts := text.split(" ")
	if not building():
		return {"error": "stopped"}
	if parts.size() == 2 and parts[1].to_int() > 0:
		return {"fraction": parts[0].to_float() / parts[1].to_float()}
	return {"fraction": 0.0}


## Identifies the game data the pictures were made from (a new import rebuilds them).
static func data_stamp() -> String:
	return FileAccess.get_file_as_string(GameData.path("manifest.json")).md5_text()


static func register(img: Image, key: String) -> void:
	if img != null:
		img.set_meta("hd", key)


static func key_of(img: Image) -> String:
	return str(img.get_meta("hd", "")) if img != null else ""


static func file_of(key: String) -> String:
	return DIR.path_join(key + ".png")


## Drop the loaded pictures (a new map loads its own).
static func clear_cache() -> void:
	_textures.clear()


## The HD picture of a key, or null when there is none.
static func texture(key: String) -> Texture2D:
	if key == "":
		return null
	if _textures.has(key):
		return _textures[key]
	var tex: Texture2D = null
	var path := file_of(key)
	if FileAccess.file_exists(path):
		var img := Image.load_from_file(path)
		if img != null:
			tex = ImageTexture.create_from_image(img)
	_textures[key] = tex
	return tex


## The X68000 colour of a palette word (GGGGG RRRRR BBBBB I), as the field draws it.
static func x68k_color(w: int) -> Color:
	var i := w & 1
	var g := (((w >> 11) & 31) << 1) | i
	var r := (((w >> 6) & 31) << 1) | i
	var b := (((w >> 1) & 31) << 1) | i
	return Color8(roundi(r * 255.0 / 63.0), roundi(g * 255.0 / 63.0), roundi(b * 255.0 / 63.0))


## A tileset's palette (0GRB entries) as the field's palette words (FieldMap).
static func tileset_words(ts: Dictionary) -> PackedInt32Array:
	var words := PackedInt32Array()
	for c: int in ts.get("palette", []):
		var g := (c >> 8) & 15
		var r := (c >> 4) & 15
		var b := c & 15
		words.append((g * 2) << 11 | (r * 2) << 6 | (b * 2) << 1 | 1)
	return words


## A tileset as the field draws it: tiles 16x8 with doubled lines, one column, as an RGBA8 index
## image (red = index, alpha = mask), the format of the exported .idx.png pictures.
static func tileset_image(ts: Dictionary) -> Image:
	var tiles := Marshalls.base64_to_raw(ts["tilesB64"])
	var mask_bits := Marshalls.base64_to_raw(ts["masksB64"])
	var px := PackedByteArray()
	px.resize(tiles.size() * 4)
	for i in tiles.size():
		px[i * 4] = tiles[i]
		px[i * 4 + 3] = 255 if i < mask_bits.size() and mask_bits[i] else 0
	var img := Image.create_from_data(16, tiles.size() / 16, false, Image.FORMAT_RGBA8, px)
	img.resize(16, img.get_height() * 2, Image.INTERPOLATE_NEAREST)
	return img
