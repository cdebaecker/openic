extends RefCounted
## One map of the field, from the data export (data/index.json -> layer and tileset JSON):
## the main (vr) and overlay (sub) layers of metatiles, their metatile tables, the two tilesets
## as index atlases (16x8 tiles shown with doubled lines: 16x16) and the map palette.
## See docs/formats/data.md, sections 2 and 3.

## How a layer's tile is drawn in the map window (f_747f0): from bits 6 and 7 of the low byte of
## the attribute word of (tile, bank 0) in the layer's own tileset (the bank of the metatile entry
## is ignored here). DRAW_NONE: the layer is not drawn on this tile; DRAW_MASKED: drawn with its
## mask over the layers below; DRAW_OPAQUE: drawn whole, and the layers below are not drawn.
enum { DRAW_NONE, DRAW_MASKED, DRAW_OPAQUE }

const TILE := 16          # displayed tile size (16x8 source pixels, lines doubled)
const TILES_PER_SET := 256

var id := ""
var place_name := ""
var width := 0            # in metatiles (2x2 tiles)
var height := 0
var vr_cells := PackedByteArray()
var sub_cells := PackedByteArray()
var vr_meta := PackedInt32Array()   # 256 metatiles x 4 (TL, TR, BL, BR): tile | bit 8 << 8
var sub_meta := PackedInt32Array()
var sub_size := Vector2i.ZERO        # the overlay layer's own size in metatiles
var sub_origin := Vector2i.ZERO      # scroll of the overlay layer in tiles (builtin 11)
var atlases: Array[Image] = []      # 0 = vr_chr (main layer), 1 = sub_chr (overlay); R8, 16 x 4096
var masks: Array[Image] = []        # LA8, alpha = opaque
var palette_words := PackedInt32Array()   # X68000 text palette words
var attr_words := PackedInt32Array()      # vr_chr attribute words, 2 per tile
var sub_attr_words := PackedInt32Array()  # sub_chr attribute words (the overlay's draw modes)
var triggers: Array = []                  # EVT triggers {x, y, w, h, entry, dest, flags}
var event: Dictionary = {}
var info: Dictionary = {}


static func load_map(map_id: String) -> RefCounted:
	var index: Variant = GameData.json("data/index.json")
	for m in index.get("maps", []):
		if m["id"] == map_id:
			var fm = load("res://scripts/field/field_map.gd").new()
			if fm._load(m):
				return fm
	push_error("FieldMap: no map %s" % map_id)
	return null


static func map_ids() -> PackedStringArray:
	var ids := PackedStringArray()
	for m in GameData.json("data/index.json").get("maps", []):
		if m.get("vrMap") != null and m.get("vrChr") != null:
			ids.append(m["id"])
	ids.sort()
	return ids


func _load(m: Dictionary) -> bool:
	info = m
	id = m["id"]
	place_name = str(m.get("name", "")) if m.get("name") != null else ""
	var vr: Dictionary = GameData.json("data/" + m["vrMap"]["json"])
	var layer: Dictionary = vr["layers"][0]
	width = layer["width"]
	height = layer["height"]
	vr_cells = _cells(layer)
	vr_meta = _metatiles(vr["metatiles"])
	if m.get("subMap") != null:
		var sub: Dictionary = GameData.json("data/" + m["subMap"]["json"])
		sub_cells = _cells(sub["layers"][0])
		sub_size = Vector2i(int(sub["layers"][0]["width"]), int(sub["layers"][0]["height"]))
		sub_meta = _metatiles(sub["metatiles"])
	var vr_chr: Dictionary = GameData.json("data/" + m["vrChr"]["json"])
	_add_tileset(vr_chr)
	var sub_chr: Dictionary = vr_chr
	if m.get("subChr") != null:
		sub_chr = GameData.json("data/" + m["subChr"]["json"])
	_add_tileset(sub_chr)
	sub_attr_words = PackedInt32Array(sub_chr.get("attrWords", []))
	# Tileset palette entries are 0x0GRB (4 bits a gun); the X68000 value of a gun is 2n with the
	# intensity bit set.
	for c: int in vr_chr["palette"]:
		var g := (c >> 8) & 15
		var r := (c >> 4) & 15
		var b := c & 15
		palette_words.append((g * 2) << 11 | (r * 2) << 6 | (b * 2) << 1 | 1)
	attr_words = PackedInt32Array(vr_chr.get("attrWords", []))
	if m.get("event") != null:
		event = GameData.json("data/" + m["event"]["json"])
		triggers = event.get("triggers", [])
	return true


static func _cells(layer: Dictionary) -> PackedByteArray:
	var out := PackedByteArray()
	for row in layer["cells"]:
		out.append_array(PackedByteArray(row))
	return out


static func _metatiles(list: Array) -> PackedInt32Array:
	var out := PackedInt32Array()
	for mt in list:
		for q in mt:
			out.append(int(q["tile"]) | int(q["bank"]) << 8)
	return out


func _add_tileset(ts: Dictionary) -> void:
	var tiles := Marshalls.base64_to_raw(ts["tilesB64"])
	var mask_bits := Marshalls.base64_to_raw(ts["masksB64"])
	var n := tiles.size() / 128
	var img := Image.create_from_data(16, n * 8, false, Image.FORMAT_R8, tiles)
	img.resize(16, n * TILE, Image.INTERPOLATE_NEAREST)
	var la := PackedByteArray()
	la.resize(mask_bits.size() * 2)
	for i in mask_bits.size():
		la[i * 2] = 255
		la[i * 2 + 1] = 255 if mask_bits[i] else 0
	var mask := Image.create_from_data(16, n * 8, false, Image.FORMAT_LA8, la)
	mask.resize(16, n * TILE, Image.INTERPOLATE_NEAREST)
	atlases.append(img)
	masks.append(mask)


## Attribute word of a main-layer metatile entry: attr[tile * 2 + bit 8] (docs/field.md).
func attr_of(entry: int) -> int:
	var i := (entry & 255) * 2 + ((entry >> 8) & 1)
	return attr_words[i] if i < attr_words.size() else 0


static func draw_mode(words: PackedInt32Array, entry: int) -> int:
	if entry < 0:
		return DRAW_NONE
	var i := (entry & 255) * 2
	var a: int = words[i] if i < words.size() else 0
	if a & 0x40:
		return DRAW_NONE
	return DRAW_MASKED if a & 0x80 else DRAW_OPAQUE


## Metatile entry (tile | bank << 8) of a layer at tile coordinates, or -1 outside the map.
## The overlay (sub_cells) has its own size, which can differ from the main layer's.
func tile_at(cells: PackedByteArray, meta: PackedInt32Array, tx: int, ty: int) -> int:
	var w := width
	var h := height
	if cells == sub_cells and sub_size != Vector2i.ZERO:
		w = sub_size.x
		h = sub_size.y
	if tx < 0 or ty < 0 or tx >= w * 2 or ty >= h * 2 or cells.is_empty():
		return -1
	var ci := (ty >> 1) * w + (tx >> 1)
	if ci >= cells.size():
		return -1
	var mi: int = cells[ci] * 4 + (tx & 1) + (ty & 1) * 2
	return meta[mi] if mi < meta.size() else -1
