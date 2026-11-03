extends RefCounted
## The battle screen as ICITY68 draws it (docs/battle-ui.md section 2), transcribed from
## tools/battle-ui/arena.mjs: the frame (WAKU_OU + WAKUB), the arena = 22 x 14 tiles at (192, 64):
## the background's main layer opaque from its origin, the second layer through its mask, then the
## sprites by layer and y, each part's mask cleared and its colours ORed (a sprite with blink
## bit 0 is drawn without the mask clear: a ghost image); the battle panel and marker tiles.

const W := 768
const H := 512
const ARENA := Rect2i(192, 64, 352, 224)
# f_73d0e directions 0-7 (header byte 29 bits 0-2): the sign of the origin change
const SCROLL_DIRS := [Vector2i(0, -1), Vector2i(1, -1), Vector2i(1, 0), Vector2i(1, 1), Vector2i(0, 1),
	Vector2i(-1, 1), Vector2i(-1, 0), Vector2i(-1, -1)]

var image := Image.create_empty(W, H, false, Image.FORMAT_R8)
var texture := ImageTexture.create_from_image(image)
var frame: Image = null
var bg: Dictionary = {}
var ui_tiles: Image = null
var ui_mask: Image = null
var origin0 := Vector2i.ZERO        # tile origins of the two layers ($A1B72, $A1B76)
var origin1 := Vector2i.ZERO
var sub0 := Vector2i.ZERO           # their sub-step counters ($A1B6A, $A1B6E)
var sub1 := Vector2i.ZERO
var tiles: Image = null             # the battle tileset (R8, 16 tiles per row) and its mask
var tiles_mask: Image = null
var tile_attr := PackedByteArray()  # attribute byte per tile (word 2 t, low byte)
var cells: Array = [{}, {}]         # per layer: Vector2i tile position -> tile
var anim_recs: Array = []           # tile animation: 24 records of 16 bytes ($C500)
var anim_ptr := {}                  # tile -> [record, slot] (f_742e8)
var _bg_image: Image = null         # the composed arena background and the state it shows
var _bg_key := ""


func _init() -> void:
	frame = _load_r8("frame/battle.idx.png")
	if frame == null:
		frame = Image.create_empty(W, H, false, Image.FORMAT_R8)
	var t := _load_rgba("ui/asdf.idx.png")
	if t != null:
		ui_mask = t.duplicate()
		t.convert(Image.FORMAT_R8)
		ui_tiles = t


## The battle background of a map (battle/index.json backgrounds[].maps); false if none.
func load_background(map_id: String) -> bool:
	for b: Dictionary in GameData.json("battle/index.json").get("backgrounds", []):
		if map_id in b.get("maps", []):
			bg = GameData.json("battle/backgrounds/%s.json" % b["name"])
			origin0 = Vector2i.ZERO
			origin1 = Vector2i.ZERO
			sub0 = Vector2i.ZERO
			sub1 = Vector2i.ZERO
			tiles_mask = _load_rgba("battle/backgrounds/%s.tiles.idx.png" % b["name"])
			tiles = _load_r8("battle/backgrounds/%s.tiles.idx.png" % b["name"])
			_init_cells()
			_init_tile_anim()
			_bg_key = ""
			return true
	return false


## The layers' tiles by position (metatile = 2 x 2 tiles TL, TR, BL, BR) and the tile attributes.
func _init_cells() -> void:
	tile_attr = PackedByteArray()
	tile_attr.resize(256)
	var words: Array = bg.get("tileset", {}).get("attrWords", [])
	for t in 256:
		tile_attr[t] = int(words[2 * t]) & 0xff if 2 * t < words.size() else 0
	cells = [{}, {}]
	var mts: Array = bg.get("metatiles", [])
	var layers: Array = bg.get("layers", [])
	for li in mini(2, layers.size()):
		var rows: Array = layers[li]["cells"]
		for my in rows.size():
			for mx in rows[my].size():
				var mt: Array = mts[int(rows[my][mx])]
				for q in 4:
					cells[li][Vector2i(2 * mx + (q & 1), 2 * my + (q >> 1))] = int(mt[q]) & 0xff


## f_742e8: the animation records from the tileset, tile rec[3 + j] -> slot 3 + j.
func _init_tile_anim() -> void:
	anim_recs = []
	for k in 24:
		anim_recs.append([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
	for r: Dictionary in bg.get("tileAnimation", []):
		var raw: Array = r["raw"]
		for j in 16:
			anim_recs[int(r["index"])][j] = int(raw[j])
	anim_ptr = {}
	for k in 24:
		var rec: Array = anim_recs[k]
		for j in rec[2]:
			if 3 + j < 16:
				anim_ptr[rec[3 + j]] = [k, 3 + j]


## f_749aa(2), once per battle redraw (tools/battle-ui/arena.mjs tileAnimStep): each record with a
## period counts down; at 0 (or 1 before the decrement) the counter reloads and the frames rotate.
func tile_anim_step() -> void:
	for rec: Array in anim_recs:
		if not rec[0]:
			continue
		if rec[1]:
			rec[1] = (int(rec[1]) - 1) & 255
			if rec[1]:
				continue
		var n := int(rec[2]) - 1
		if n > 0 and n < 128 and 3 + n < 16:
			var first: int = rec[3]
			for j in n:
				rec[3 + j] = rec[4 + j]
			rec[3 + n] = first
		rec[1] = rec[0]


## f_73934 -> f_73d0e for both layers, once per battle redraw before drawing (tools/battle-ui/
## arena.mjs scrollStep): J06 / J20 scroll their second layer down, H5x right, I5x left.
func scroll_step() -> void:
	var layers: Array = bg.get("layers", [])
	if layers.size() > 0:
		var r := _scroll_layer(layers[0], sub0, origin0)
		sub0 = r[0]
		origin0 = r[1]
	if layers.size() > 1:
		var r := _scroll_layer(layers[1], sub1, origin1)
		sub1 = r[0]
		origin1 = r[1]


## One layer: header byte 29 bit 3 auto-scroll, bits 0-2 direction (SCROLL_DIRS), 30 threshold, 31
## step; the sub counters move by the step, each threshold crossed moves the origin by the step;
## auto-scrolling origins wrap with the period (layer size - arena) in tiles. Returns [sub, origin].
static func _scroll_layer(lay: Dictionary, sub: Vector2i, org: Vector2i) -> Array:
	var sc: Dictionary = lay.get("scroll", {})
	var b29 := int(sc.get("b29", 0))
	var thr := int(sc.get("b30", 0))
	var step := int(sc.get("b31", 0))
	var auto := (b29 & 8) != 0
	var dir := b29 & 7 if auto else 0
	if auto:
		sub += SCROLL_DIRS[dir] * step
	var over := 0
	if sub.x < 0 or sub.x >= thr:
		over |= 0xf0
	if sub.y < 0 or sub.y >= thr:
		over |= 0x0f
	var need := 0xff if (dir & 1) else (0xf0 if (dir & 3) == 2 else 0x0f)
	if (need & over) == need:
		if thr == 0:
			return [Vector2i.ZERO, org]
		if 2 * int(lay["width"]) > ARENA.size.x / 16:
			while sub.x < 0:
				org.x -= step
				sub.x += thr
			while sub.x >= thr:
				org.x += step
				sub.x -= thr
		if 2 * int(lay["height"]) > ARENA.size.y / 16:
			while sub.y < 0:
				org.y -= step
				sub.y += thr
			while sub.y >= thr:
				org.y += step
				sub.y -= thr
	var period := Vector2i(2 * int(lay["width"]), 2 * int(lay["height"])) - ARENA.size / 16
	if auto and period.x > 0 and period.y > 0:
		if org.x > period.x:
			org.x -= period.x * ((org.x - 1) / period.x)
		if org.y > period.y:
			org.y -= period.y * ((org.y - 1) / period.y)
		while org.x < 0:
			org.x += period.x
		while org.y < 0:
			org.y += period.y
	return [sub, org]


## The text palette in battle: the background tileset's (X68000 words).
func palette_words() -> Array:
	return bg.get("palette", {}).get("x68k", [])


## sprites: [{set, frame (index into the set's frames), x, y (arena tiles), layer, visible, blink}]
## panel: [{id, lv, hp, mp} per party slot]: names and LV (f_6dff8) with the battle HP / MP
## (f_6e140); marker: [Vector2i arena tile] of the target marker; tiles: [[ASDF tile, pos]] drawn
## opaque (selector pointer).
func render(sprites: Array, panel: Array = [], marker: Array = [], tiles: Array = []) -> void:
	image.blit_rect(frame, Rect2i(0, 0, W, H), Vector2i.ZERO)
	draw_arena(sprites)
	for slot in panel.size():
		var c: Dictionary = panel[slot]
		if int(c.get("id", -1)) >= 0 and int(c.get("id", -1)) <= 7:
			for k in 5:
				_draw_tile(5 * int(c["id"]) + k, Vector2i(80 + 16 * k, 64 + 96 * slot))
			_draw_number(int(c.get("lv", 0)), Vector2i(112, 96 + 96 * slot))
		_draw_number(int(c["hp"]), Vector2i(112, 112 + 96 * slot))
		_draw_number(int(c["mp"]), Vector2i(112, 128 + 96 * slot))
	for t: Array in tiles:
		_draw_tile(int(t[0]), t[1])
	for m: Vector2i in marker:
		_draw_tile_masked(84, Vector2i(64 + 16 * (m.x + 9), 48 + 16 * (m.y - 4)))
		_draw_tile_masked(89, Vector2i(64 + 16 * (m.x + 9), 48 + 16 * (m.y - 3)))
	texture.update(image)


## The arena: background, then the sprites in draw order.
func draw_arena(sprites: Array) -> void:
	_draw_background()
	for s: Dictionary in _draw_order(sprites):
		_draw_frame(s["set"], int(s["frame"]), int(s["x"]), int(s["y"]), (int(s.get("blink", 0)) & 1) != 0)


## An ASDF tile drawn through its mask at screen pos (target marker).
func draw_marker_tile(tile: int, pos: Vector2i) -> void:
	_draw_tile_masked(tile, pos)


func _draw_background() -> void:
	if tiles == null:
		image.fill_rect(ARENA, Color8(0, 0, 0))
		return
	var key := "%s %s %s" % [origin0, origin1, str(anim_recs)]
	if key != _bg_key:
		_bg_key = key
		_compose_background()
	image.blit_rect(_bg_image, Rect2i(Vector2i.ZERO, ARENA.size), ARENA.position)


## f_7450c / f_745ba / f_747f0 / f_74918 (tools/battle-ui/arena.mjs renderBackground): per cell the
## second layer, then the main layer, each tile by its attribute byte: bit 6 not drawn, bit 7
## through its mask, else opaque; remap[tile] (tile animation).
func _compose_background() -> void:
	_bg_image = Image.create_empty(ARENA.size.x, ARENA.size.y, false, Image.FORMAT_R8)
	for ty in ARENA.size.y / 16:
		for tx in ARENA.size.x / 16:
			var dst := Vector2i(16 * tx, 16 * ty)
			for li: int in [1, 0]:
				var org := origin1 if li == 1 else origin0
				var t: int = cells[li].get(Vector2i(tx, ty) + org, -1)
				if t < 0:
					continue
				t = _remap(t)
				var a: int = tile_attr[t]
				if a & 0x40:
					continue
				var src := Rect2i(16 * (t & 15), 16 * (t >> 4), 16, 16)
				if a & 0x80:
					_bg_image.blit_rect_mask(tiles, tiles_mask, src, dst)
				else:
					_bg_image.blit_rect(tiles, src, dst)


func _remap(t: int) -> int:
	var ptr: Array = anim_ptr.get(t, [])
	return int(anim_recs[int(ptr[0])][int(ptr[1])]) if not ptr.is_empty() else t


## f_74c08: visible sprites (+8 bit 7) by layer, then y, ties in record order.
static func _draw_order(sprites: Array) -> Array:
	var order: Array = []
	for k in sprites.size():
		var s: Dictionary = sprites[k]
		if (int(s.get("visible", 0)) & 0x80) and s.get("set") != null:
			order.append([s, k])
	order.sort_custom(func(a: Array, b: Array) -> bool:
		var sa: Dictionary = a[0]
		var sb: Dictionary = b[0]
		if int(sa.get("layer", 0)) != int(sb.get("layer", 0)):
			return int(sa.get("layer", 0)) < int(sb.get("layer", 0))
		if int(sa["y"]) != int(sb["y"]):
			return int(sa["y"]) < int(sb["y"])
		return int(a[1]) < int(b[1]))
	return order.map(func(e: Array) -> Dictionary: return e[0])


## One CG9 frame at arena tile (x, y): part p covers screen (192 + 16 (x + p.x),
## 64 + 16 (y + p.y - p.h + 1)), clipped to the arena; mask cleared then colours ORed, or ORed
## only (ghost).
func _draw_frame(sset, f: int, x: int, y: int, ghost: bool) -> void:
	if sset == null or sset.sheet == null:
		return
	var frames: Array = sset.data.get("frames", [])
	if f < 0 or f >= frames.size():
		return
	var parts: Array = sset.data.get("parts", [])
	for pi: int in frames[f]["parts"]:
		if pi < 0 or pi >= parts.size():
			continue
		var p: Dictionary = parts[pi]
		if p.get("skipped", false):
			continue
		var r: Dictionary = p["sheetRect"]
		var dst := Vector2i(ARENA.position.x + 16 * (x + int(p["x"])),
			ARENA.position.y + 16 * (y + int(p["y"]) - int(p["h"]) + 1))
		var src := Rect2i(int(r["x"]), int(r["y"]), int(r["w"]), int(r["h"]))
		var vis := Rect2i(dst, src.size).intersection(ARENA)
		if vis.size.x <= 0 or vis.size.y <= 0:
			continue
		var clip_src := Rect2i(src.position + (vis.position - dst), vis.size)
		if not ghost:
			image.blit_rect_mask(sset.sheet, sset.mask, clip_src, vis.position)
		else:
			for yy in clip_src.size.y:
				for xx in clip_src.size.x:
					var c := roundi(sset.sheet.get_pixel(clip_src.position.x + xx, clip_src.position.y + yy).r * 255.0)
					if c:
						var d := vis.position + Vector2i(xx, yy)
						var o := roundi(image.get_pixelv(d).r * 255.0)
						image.set_pixelv(d, Color8(o | c, 0, 0))


func _draw_tile(k: int, pos: Vector2i) -> void:
	if ui_tiles != null:
		image.blit_rect(ui_tiles, Rect2i(16 * k, 0, 16, 16), pos)


func _draw_tile_masked(k: int, pos: Vector2i) -> void:
	if ui_tiles != null:
		image.blit_rect_mask(ui_tiles, ui_mask, Rect2i(16 * k, 0, 16, 16), pos)


## f_6e140: 3 digit tiles right-aligned, 50 + d (40 + d for the value 0), blank 0, clamped to 999.
func _draw_number(value: int, pos: Vector2i) -> void:
	value = clampi(value, 0, 999)
	var base := 40 if value == 0 else 50
	var digits := str(value)
	for k in 3:
		var i := k - (3 - digits.length())
		_draw_tile(base + digits.unicode_at(i) - 48 if i >= 0 else 0, pos + Vector2i(16 * k, 0))


static func _load_r8(rel: String) -> Image:
	var img := _load_rgba(rel)
	if img != null:
		img.convert(Image.FORMAT_R8)
	return img


static func _load_rgba(rel: String) -> Image:
	if not GameData.exists(rel):
		return null
	var img := Image.new()
	if img.load_png_from_buffer(FileAccess.get_file_as_bytes(GameData.path(rel))) != OK:
		return null
	img.convert(Image.FORMAT_RGBA8)
	return img
