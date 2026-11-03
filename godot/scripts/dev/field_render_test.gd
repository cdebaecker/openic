extends Node
## Development: renders the field as the original drew it for every reference-trace screenshot and
## compares the map window with the screenshot (docs/field.md, "Render test").
## Each page flip of the trace (`flips`, every f_73668 redraw: field ticks and script redraws
## alike) records what the back page was drawn from: view, vr cell changes and every drawn sprite
## record with its CG9 set and frame. A screenshot at frame S shows the last flip recorded by S,
## or, when the flip landed during the frame's scan, the older flip above some row and the newer
## one below it (torn). Colours come from the text palette of frame S (fades included).
## Run: godot --path godot -- --field-render-test=<traces folder> [--diff-dir=<folder>] [--only=a,b]
## With FIELD_RENDER_CANDIDATES set, the renders of both candidate flips are written as well.

signal finished(next: String, args: Dictionary)

const FieldMap := preload("res://scripts/field/field_map.gd")
const FieldLogic := preload("res://scripts/field/field_logic.gd")
const FieldView := preload("res://scripts/field/field_view.gd")
const ScreenImage := preload("res://scripts/field/field_screen_image.gd")
const SpriteSet := preload("res://scripts/field/sprite_set.gd")

var _view: RefCounted = null
var _set_paths := {}      # "fileSize,packedSize,field24,field26" -> cg9 path (without .json)
var _sets := {}           # same key -> SpriteSet
var _frame_mismatch := 0  # recorded frames that are not seq[step - 1] of the port's SpriteSet
var _anim_mismatch := 0   # flips where the port's tile animation remap differs from the original's


func _ready() -> void:
	var dir := ""
	var diff_dir := ""
	var only := PackedStringArray()
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("--field-render-test="):
			dir = arg.trim_prefix("--field-render-test=")
		elif arg.begins_with("--diff-dir="):
			diff_dir = arg.trim_prefix("--diff-dir=")
		elif arg.begins_with("--only="):
			only = arg.trim_prefix("--only=").split(",")
	_view = FieldView.new()
	var names := Array(DirAccess.get_files_at(dir)).filter(func(f: String) -> bool: return f.ends_with(".json"))
	names.sort()
	if not only.is_empty():
		names = names.filter(func(f: String) -> bool: return only.has(f.get_basename()))
	var shots := 0
	var exact := 0
	for name: String in names:
		var r := _check(dir, name.get_basename(), diff_dir)
		shots += r[1]
		exact += r[0]
		print("%-12s %d/%d screenshots: map window identical%s" % [name.get_basename(), r[0], r[1], r[2]])
	print("total %d/%d" % [exact, shots])
	if _frame_mismatch > 0:
		print("sprite frames different from seq[step - 1]: %d" % _frame_mismatch)
	print("tile animation: %s" % ("remaps identical at every flip" if _anim_mismatch == 0
		else "%d flips with a different remap" % _anim_mismatch))
	get_tree().quit()


func _check(dir: String, scenario: String, diff_dir: String) -> Array:
	var t: Dictionary = JSON.parse_string(FileAccess.get_file_as_string(dir.path_join(scenario + ".json")))
	var f0: Dictionary = t["frames"][0]
	var map = FieldMap.load_map(f0["map"])
	if f0.has("cellsB64"):
		map.vr_cells = Marshalls.base64_to_raw(f0["cellsB64"])
	var field = FieldLogic.new(map, f0["party"], Vector2i(f0["view"][0], f0["view"][1]))
	var flips: Array = t.get("flips", [])
	if flips.is_empty():
		push_error("%s: no flips (record the trace again with tools/field/trace.mjs)" % scenario)
		return [0, 0, " no flips"]
	# vr cells as each flip drew them
	var cells: Array[PackedByteArray] = []
	for fl: Dictionary in flips:
		for c in fl.get("cellChanges", []):
			map.vr_cells[int(c[1]) * map.width + int(c[0])] = int(c[2])
		cells.append(map.vr_cells.duplicate())
	# tile animation: start from the recorded tables, tick once per later flip (one f_73668 each), and
	# compare with the remaps the original drew with; the renders use the recorded remaps
	var remaps: Array = []
	var anim_bad := 0
	if f0.has("tileAnimB64"):
		_sync_tile_anim(map, Marshalls.base64_to_raw(f0["tileAnimB64"]))
	var recorded := PackedByteArray()
	for fi in flips.size():
		var fl: Dictionary = flips[fi]
		if fi > 0:   # the tables were read in the redraw of the first flip, after its tick
			map.tick_tiles()
		if fl.has("remapB64"):
			recorded = Marshalls.base64_to_raw(fl["remapB64"])
		if not recorded.is_empty():
			# a map without a sub layer keeps the previous map's sub tileset in the original (not
			# reloaded, still animated, never drawn): compare the sub remap only where it is drawn
			var drawn := 512 if map.info.get("subMap") != null else 256
			if (map.remap[0] + map.remap[1]).slice(0, drawn) != recorded.slice(0, drawn):
				_anim_mismatch += 1
				anim_bad += 1
			remaps.append(recorded if drawn == 512 else recorded.slice(0, 256) + map.remap[1])
		else:
			remaps.append(map.remap[0] + map.remap[1])
	var first_warp := INF
	for w in t["warps"]:
		first_warp = minf(first_warp, w["frame"])
	var ok := 0
	var count := 0
	var torn := 0
	var worst := ""
	var worst_n := 0
	var files := Array(DirAccess.get_files_at(dir.path_join(scenario)))
	files.sort()
	for f: String in files:
		var s := f.trim_prefix("f").get_basename().to_int()
		if s >= first_warp:
			continue
		# The flip is recorded as f_73668 is about to write the page register, which can happen
		# anywhere in a frame: compare with the last two flips recorded by S. A flip during the
		# frame's scan shows a torn picture: the rows above the raster from the older flip, those
		# below from the newer one. The best split row (0 = all newer, 288 = all older) is kept.
		var cand: Array[int] = []
		for i in flips.size():
			if int(flips[i]["frame"]) <= s:
				cand.append(i)
		if cand.is_empty():
			continue
		var palette := _palette(t["frames"][s - int(f0["frame"])].get("textPalette", Array(map.palette_words)))
		var shot := Image.load_from_file(dir.path_join(scenario).path_join(f))
		shot.convert(Image.FORMAT_RGB8)
		var want := shot.get_region(ScreenImage.WINDOW).get_data()
		var renders: Array = []
		for ci in cand.slice(-2):
			map.vr_cells = cells[ci]
			var rm: PackedByteArray = remaps[ci]
			map.remap[0] = rm.slice(0, 256)
			map.remap[1] = rm.slice(256, 512)
			var r := _render_diff(map, field, flips[ci], palette, want)
			renders.append(r)
			if OS.has_environment("FIELD_RENDER_CANDIDATES") and diff_dir != "":
				var ws0 := ScreenImage.WINDOW.size
				Image.create_from_data(ws0.x, ws0.y, false, Image.FORMAT_RGB8, r[1]).save_png(
					diff_dir.path_join("cand_%s_%s_t%d.png" % [scenario, f.get_basename(), ci]))
		var best := _best_split(renders)
		var n: int = best[0]
		count += 1
		if n == 0:
			ok += 1
			if best[2] > 0 and best[2] < ScreenImage.WINDOW.size.y:
				torn += 1
			continue
		if n > worst_n:
			worst_n = n
			worst = "  worst %s: %d pixels" % [f, n]
		if diff_dir != "":
			_save_pair(shot, best[1], diff_dir.path_join("%s_%s" % [scenario, f]))
	if torn > 0:
		worst = " (%d torn: flip during the scan)%s" % [torn, worst]
	if anim_bad:
		worst += "  tile animation differs at %d flips" % anim_bad
	return [ok, count, worst]


## The screenshot's map window (left) and the render (right) side by side.
func _save_pair(shot: Image, rgb: PackedByteArray, path: String) -> void:
	var ws := ScreenImage.WINDOW.size
	var mine := Image.create_from_data(ws.x, ws.y, false, Image.FORMAT_RGB8, rgb)
	var both := Image.create_empty(ws.x * 2, ws.y, false, Image.FORMAT_RGB8)
	both.blit_rect(shot, ScreenImage.WINDOW, Vector2i.ZERO)
	both.blit_rect(mine, Rect2i(Vector2i.ZERO, ws), Vector2i(ws.x, 0))
	both.save_png(path)


## Combine the renders of the older and newer candidate flips ([diff, rgb, row diffs] each) at the
## split row with the fewest differing pixels: [diff, rgb, split row].
func _best_split(renders: Array) -> Array:
	var old: Array = renders[0]
	var new: Array = renders[-1]
	var rows := ScreenImage.WINDOW.size.y
	var row_bytes := ScreenImage.WINDOW.size.x * 3
	var below := 0   # differences of the newer render in rows k..
	for y in rows:
		below += new[2][y]
	var above := 0   # differences of the older render in rows ..k-1
	var best_n := below
	var best_k := 0
	for k in range(1, rows + 1):
		above += old[2][k - 1]
		below -= new[2][k - 1]
		# On a tie keep the untorn picture of one flip.
		if above + below < best_n or (above + below == best_n and k == rows):
			best_n = above + below
			best_k = k
	var rgb: PackedByteArray = old[1].slice(0, best_k * row_bytes) + new[1].slice(best_k * row_bytes)
	return [best_n, rgb, best_k]


## Render what flip `fl` drew and count the map-window pixels that differ from `want` (RGB):
## [count, rgb, count per row].
func _render_diff(map, field, fl: Dictionary, palette: PackedByteArray, want: PackedByteArray) -> Array:
	field.view = Vector2i(fl["view"][0], fl["view"][1])
	var sprites := []
	for sp: Dictionary in fl["sprites"]:
		var sprite_set = _sprite_set(sp["set"])
		if sprite_set != null and sprite_set.frame_for(sp["action"], sp["dir"], int(sp["step"]) - 1) != int(sp["frame"]):
			_frame_mismatch += 1
		sprites.append({"x": sp["x"], "y": sp["y"], "layer": sp["layer"], "visible": 0x80, "set": sprite_set,
			"frame": sp["frame"]})
	_view.render(map, field, sprites)
	var idx: PackedByteArray = _view.screen.image.get_region(ScreenImage.WINDOW).get_data()
	var got := PackedByteArray()
	got.resize(idx.size() * 3)
	var n := 0
	var per_row := PackedInt32Array()
	per_row.resize(ScreenImage.WINDOW.size.y)
	for i in idx.size():
		var c: int = idx[i] & 15
		var o: int = i * 3
		got[o] = palette[c * 3]
		got[o + 1] = palette[c * 3 + 1]
		got[o + 2] = palette[c * 3 + 2]
		if got[o] != want[o] or got[o + 1] != want[o + 1] or got[o + 2] != want[o + 2]:
			n += 1
			per_row[i / ScreenImage.WINDOW.size.x] += 1
	return [n, got, per_row]


## Tile animation state from the recorded $C100 / $C300 tables (countdowns and rotated tile lists of
## the map's records), then the remap they give.
func _sync_tile_anim(map, raw: PackedByteArray) -> void:
	for layer in 2:
		for rec: Dictionary in map.tile_anim[layer]:
			var o: int = layer * 0x200 + int(rec["index"]) * 16
			rec["countdown"] = raw[o + 1]
			rec["tiles"] = raw.slice(o + 3, o + 3 + (rec["tiles"] as PackedByteArray).size())
	map.rebuild_remap()


## The CG9 set of a recorded sprite, found by its header fields [fileSize, packedSize, +24, +26].
func _sprite_set(id: Array):
	var key := "%d,%d,%d,%d" % id
	if _sets.has(key):
		return _sets[key]
	if _set_paths.is_empty():
		_index_sets()
	var s = SpriteSet.load_set(_set_paths[key]) if _set_paths.has(key) else null
	if s == null:
		push_error("field render test: no CG9 set with header %s" % key)
	_sets[key] = s
	return s


func _index_sets() -> void:
	var root := GameData.path("cg9")
	for group in DirAccess.get_directories_at(root):
		for f in DirAccess.get_files_at(root.path_join(group)):
			if not f.ends_with(".json"):
				continue
			var rel: String = group.path_join(f.get_basename())
			var d: Variant = GameData.json("cg9/%s.json" % rel)
			if not (d is Dictionary) or not d.has("header"):
				continue
			var h: Dictionary = d["header"]
			_set_paths["%d,%d,%d,%d" % [h["fileSize"], h["packedSize"], h["field24"], h["field26"]]] = rel


## X68000 palette words (GGGGG RRRRR BBBBB I) as RGB bytes.
func _palette(words: Array) -> PackedByteArray:
	var pal := PackedByteArray()
	for w: int in words:
		var i: int = w & 1
		for sh in [6, 11, 1]:   # r, g, b
			pal.append(roundi(((((w >> sh) & 31) << 1) | i) * 255.0 / 63.0))
	return pal
