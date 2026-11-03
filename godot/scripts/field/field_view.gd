extends RefCounted
## Draws the field as ICITY68 does each tick (docs/field.md, "Drawing"): the frame, the map
## window at the view origin, the party's sprites ordered by layer then y, and the map tiles whose
## attribute has the foreground bit drawn again over the sprites.

const ScreenImage := preload("res://scripts/field/field_screen_image.gd")
const SpriteSet := preload("res://scripts/field/sprite_set.gd")

# Party sprite sets (field_chr): Tianren, Meihong, Houmei.
const PARTY_SETS := ["GROUP00/000000", "GROUP00/000002", "GROUP00/000015"]
const WALK_ACTION := 0
# Rows of the command buttons' lamps (f_823be): lamp n at (592, 16 * (row + 3)).
const LAMP_ROWS := [2, 4, 7, 9, 12, 14]

var screen := ScreenImage.new()
var party_sets: Array = []
var window_tiles: Image = null
var window_mask: Image = null
var ui_tiles: Image = null      # ASDF.CHR (docs/systems-ui.md section 2)
var picture: Image = null       # event picture shown (picture mode), or null
var sprite_offsets := {}        # smooth movement: sprite index -> pixel offset (Settings)



func _init() -> void:
	for rel in PARTY_SETS:
		party_sets.append(SpriteSet.load_set(rel))


func _load_window_tiles() -> void:
	var bytes := FileAccess.get_file_as_bytes(GameData.path("frame/window.idx.png"))
	var img := Image.new()
	if bytes.is_empty() or img.load_png_from_buffer(bytes) != OK:
		return
	img.convert(Image.FORMAT_RGBA8)
	window_mask = img.duplicate() as Image
	window_tiles = img
	window_tiles.convert(Image.FORMAT_R8)


## The field as f_73668 draws it: map window, sprites (from the sprite records, by layer then y),
## foreground tiles over them, then the frames of open windows (WIN.DAT tiles, text layer).
func render(map, field, sprites: Array = [], windows: Array = [], frame_tiles: Callable = Callable(),
		panel: Dictionary = {}, boxes: Array = []) -> void:
	var v: Vector2i = field.view
	if picture != null:
		# picture mode (f_798e8): no frame art, no field; the panel tiles stay
		screen.clear_blank()
		screen.draw_picture(picture)
		_draw_panel(panel)
		_draw_windows(windows, frame_tiles, boxes)
		screen.flush()
		return
	screen.clear_to_frame()
	_draw_panel(panel)
	screen.draw_map(map, v.x, v.y)
	var order := []
	for i in sprites.size():
		var s: Dictionary = sprites[i]
		if (int(s["visible"]) & 0x80) and s["set"] != null:
			order.append(i)
	order.sort_custom(func(i: int, j: int) -> bool:
		var a: Dictionary = sprites[i]
		var b: Dictionary = sprites[j]
		return a["layer"] < b["layer"] if a["layer"] != b["layer"] else a["y"] < b["y"])
	# Each sprite is followed by the foreground tiles over it (f_7504c), so a later sprite covers
	# the foreground redrawn for an earlier one.
	for i in order:
		var s: Dictionary = sprites[i]
		var at := screen.pos_of(s["x"], s["y"], v.x, v.y) + (sprite_offsets.get(i, Vector2i.ZERO) as Vector2i)
		screen.draw_sprite(s["set"], s["frame"], at)
		_redraw_foreground(map, field, s, v)
	_draw_windows(windows, frame_tiles, boxes)
	screen.flush()


## Foreground over one sprite (f_7504c from $7523C). The box is the cells of the frame's parts
## (f_74d74: left/right columns, bottom and top rows; 2 x 4 above the anchor for the party). Each
## column is walked up from the box's bottom row, or from the anchor row when the box is above it,
## with a flag that starts at 1 and a row counter that starts at bottom - anchor. A main tile
## without attribute bit 0 (bit 8 on layer 1) sets the flag to 1 and is not redrawn; one with
## bit 1 (9) as well sets it to "this is the first row"; a tile with bit 0 is redrawn when the flag
## is 1 and the counter is not negative (rows between the anchor and a box above it are only
## walked). The redraw is the main tile alone, masked by its own mask (f_8749e), so the sprite
## shows through its clear pixels.
func _redraw_foreground(map, field, s: Dictionary, v: Vector2i) -> void:
	var full: int = 1 << (8 * int(s["layer"]))
	var part: int = 2 << (8 * int(s["layer"]))
	var box: Rect2i = s["set"].cell_box(int(s["frame"]))
	if not box.has_area():
		return
	var below: int = box.end.y - 1          # bottom row relative to the anchor
	var start: int = int(s["y"]) + maxi(below, 0)
	var rows: int = box.size.y - mini(below, 0)
	for tx in range(int(s["x"]) + box.position.x, int(s["x"]) + box.end.x):
		var flag := true
		for k in rows:
			var counter: int = below + k
			var ty: int = start - k
			var at: int = field.attr_at(tx, ty)
			if at & part and at & full:
				flag = k == 0
			if not (at & full):
				flag = true
				continue
			if flag and counter >= 0:
				screen.redraw_tile_masked(map, tx, ty, v.x, v.y)


## Frames of the open windows in stack order, each followed by its menu highlight boxes (shown in
## the blink's "on" phase), so a later window covers the boxes of the ones below.
func _draw_windows(windows: Array, frame_tiles: Callable, boxes: Array = []) -> void:
	if windows.is_empty() or not frame_tiles.is_valid():
		return
	if window_tiles == null:
		_load_window_tiles()
	if window_tiles == null:
		return
	for w in windows:
		for t: Vector3i in frame_tiles.call(w):
			var pos := Vector2i(64 + 16 * t.x, 48 + 16 * t.y)
			screen.image.blit_rect_mask(window_tiles, window_mask, Rect2i(16 * t.z, 0, 16, 16), pos)
		for b: Dictionary in boxes:
			if b["win"] == w and b.get("on", true):
				screen.draw_box(Vector2i(b["x"], b["y"]), b["w"])


## The party panel and indicators (docs/systems-ui.md section 2), ASDF.CHR tiles drawn opaque:
## panel = {"party": [{"id", "lv", "hp", "mp"} per slot], "mouse": bool, "vr": bool}.
func _draw_panel(panel: Dictionary) -> void:
	if panel.is_empty():
		return
	if ui_tiles == null:
		var bytes := FileAccess.get_file_as_bytes(GameData.path("ui/asdf.idx.png"))
		var img := Image.new()
		if bytes.is_empty() or img.load_png_from_buffer(bytes) != OK:
			return
		img.convert(Image.FORMAT_R8)
		ui_tiles = img
	var party: Array = panel.get("party", [])
	for slot in party.size():
		var c: Dictionary = party[slot]
		if int(c["id"]) > 7:
			continue
		for k in 5:   # name: tiles 5c .. 5c+4
			screen.draw_tile(ui_tiles, 5 * int(c["id"]) + k, Vector2i(80 + 16 * k, 64 + 96 * slot))
		var row := 0
		for key in ["lv", "hp", "mp"]:
			_draw_number(int(c[key]), Vector2i(112, 96 + 16 * row + 96 * slot))
			row += 1
	# input indicator: MOUSE 60-62 / keyboard 65-67
	for k in 3:
		screen.draw_tile(ui_tiles, (60 if panel.get("mouse", true) else 65) + k, Vector2i(272 + 16 * k, 400))
	# VR switch: on 70,71 / 75,76, off 72,73 / 77,78
	var vr: int = 70 if panel.get("vr", true) else 72
	for k in 2:
		screen.draw_tile(ui_tiles, vr + k, Vector2i(384 + 16 * k, 400))
		screen.draw_tile(ui_tiles, vr + 5 + k, Vector2i(384 + 16 * k, 416))
	# command lamps: lit 63 + (n & 1), unlit 68 + (n & 1)
	var lit: int = panel.get("lamp", -1)
	for n in 6:
		screen.draw_tile(ui_tiles, (63 if n == lit else 68) + (n & 1), Vector2i(592, 16 * (LAMP_ROWS[n] + 3)))
	# cross pad released: up 85, left 86, down 87, right 88
	screen.draw_tile(ui_tiles, 85, Vector2i(624, 320))
	screen.draw_tile(ui_tiles, 87, Vector2i(624, 416))
	screen.draw_tile(ui_tiles, 86, Vector2i(576, 368))
	screen.draw_tile(ui_tiles, 88, Vector2i(672, 368))


## A panel number (f_6e1c6): 3 tiles right-aligned, clamped to 999; digits 50+d, or 40+d for the
## value 0; leading positions blank (tile 0).
func _draw_number(value: int, pos: Vector2i) -> void:
	value = clampi(value, 0, 999)
	var base := 40 if value == 0 else 50
	var digits := str(value)
	for k in 3:
		var i := k - (3 - digits.length())
		var t := base + digits.unicode_at(i) - 48 if i >= 0 else 0
		screen.draw_tile(ui_tiles, t, pos + Vector2i(16 * k, 0))
