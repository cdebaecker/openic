extends RefCounted
## The in-game screen as ICITY68 draws it: one 768x512 plane of 16-colour indices (the X68000
## text layer) holding the frame, the map window and the characters, shown through the text
## palette (shaders/indexed.gdshader).

const W := 768
const H := 512
const WINDOW := Rect2i(176, 80, 384, 288)   # map window: 24 x 18 tiles of 16x16
const WINDOW_TILES := Vector2i(24, 18)

var image := Image.create_empty(W, H, false, Image.FORMAT_R8)
var texture := ImageTexture.create_from_image(image)
var frame: Image = null
## Smooth movement (option): pixel offset of the map window's tiles between two ticks; 0 draws
## exactly what the original draws.
var shift := Vector2i.ZERO


func _init() -> void:
	var bytes := FileAccess.get_file_as_bytes(GameData.path("frame/field.idx.png"))
	frame = Image.new()
	if bytes.is_empty() or frame.load_png_from_buffer(bytes) != OK:
		push_error("Field: no frame image (frame/field.idx.png)")
		frame = Image.create_empty(W, H, false, Image.FORMAT_R8)
	frame.convert(Image.FORMAT_R8)


func clear_to_frame() -> void:
	image.blit_rect(frame, Rect2i(0, 0, W, H), Vector2i.ZERO)


## Draw the map window with its top-left tile at (ox, oy), as f_74744 / f_74918 compose it: the
## layers are tested from the top (the main layer, vr_chr; then the overlay, sub_chr), each by its
## own tile's draw mode (FieldMap.draw_mode), down to the first opaque one, and drawn from the
## bottom up: the opaque layer whole, the masked ones over it. Where no layer is opaque the window
## is blank (colour 0) under the masked ones. Bit 8 of a metatile entry selects the attribute
## word, not the tileset (checked against text VRAM at the first free control).
func draw_map(map, ox: int, oy: int) -> void:
	var lo := -1 if shift != Vector2i.ZERO else 0
	var so: Vector2i = map.sub_origin
	for ty in range(lo, WINDOW_TILES.y - lo):
		for tx in range(lo, WINDOW_TILES.x - lo):
			var pos: Vector2i = WINDOW.position + Vector2i(tx, ty) * 16 + shift
			var t: int = map.shown(map.tile_at(map.vr_cells, map.vr_meta, ox + tx, oy + ty), 0)
			var t_mode: int = map.draw_mode(map.attr_words, t)
			if t_mode == map.DRAW_OPAQUE:
				_blit(map.atlases[0], null, Rect2i(0, (t & 255) * map.TILE, map.TILE, map.TILE), pos)
				continue
			var s: int = map.shown(map.tile_at(map.sub_cells, map.sub_meta, ox + tx + so.x, oy + ty + so.y), 1)
			var s_mode: int = map.draw_mode(map.sub_attr_words, s)
			var rect := Rect2i(0, (s & 255) * map.TILE, map.TILE, map.TILE)
			if s_mode == map.DRAW_OPAQUE:
				_blit(map.atlases[1], null, rect, pos)
			else:
				image.fill_rect(Rect2i(pos, Vector2i(map.TILE, map.TILE)).intersection(WINDOW), Color8(0, 0, 0))
				if s_mode == map.DRAW_MASKED:
					_blit(map.atlases[1], map.masks[1], rect, pos)
			if t_mode == map.DRAW_MASKED:
				_blit(map.atlases[0], map.masks[0], Rect2i(0, (t & 255) * map.TILE, map.TILE, map.TILE), pos)


## A blit clipped to the map window (masked when `mask` is given).
func _blit(src: Image, mask: Variant, rect: Rect2i, pos: Vector2i) -> void:
	var dst := Rect2i(pos, rect.size).intersection(WINDOW)
	if not dst.has_area():
		return
	var from := Rect2i(rect.position + dst.position - pos, dst.size)
	if mask == null:
		image.blit_rect(src, from, dst.position)
	else:
		image.blit_rect_mask(src, mask, from, dst.position)


## Draw one frame of a sprite set with its anchor at the top-left of the actor's tile row,
## clipped to the map window. Masked pixels replace the screen (the original clears the mask area
## and ORs the colour planes in, f_8710c).
func draw_sprite(sprites, frame: int, anchor: Vector2i) -> void:
	for part in sprites.parts(frame):
		var src: Rect2i = part["rect"]
		var dst := Rect2i(anchor + part["offset"], src.size).intersection(WINDOW)
		if not dst.has_area():
			continue
		var from := Rect2i(src.position + dst.position - (anchor + part["offset"]), dst.size)
		image.blit_rect_mask(sprites.sheet, sprites.mask, from, dst.position)


## Screen position of map tile (tx, ty) for view origin (vx, vy).
static func tile_pos(tx: int, ty: int, vx: int, vy: int) -> Vector2i:
	return WINDOW.position + Vector2i(tx - vx, ty - vy) * 16


## Screen position of map tile (tx, ty) with the smooth-movement shift.
func pos_of(tx: int, ty: int, vx: int, vy: int) -> Vector2i:
	return tile_pos(tx, ty, vx, vy) + shift


## Draw the main-layer tile at map tile (tx, ty) again, masked by its own mask (f_8749e): the
## foreground redraw over a sprite.
func redraw_tile_masked(map, tx: int, ty: int, vx: int, vy: int) -> void:
	var pos := pos_of(tx, ty, vx, vy)
	var t: int = map.shown(map.tile_at(map.vr_cells, map.vr_meta, tx, ty), 0)
	if t >= 0:
		_blit(map.atlases[0], map.masks[0], Rect2i(0, (t & 255) * 16, 16, 16), pos)


## Draw an opaque 16x16 tile from a sheet of tiles side by side (tile k at x = 16k).
func draw_tile(sheet: Image, k: int, pos: Vector2i) -> void:
	image.blit_rect(sheet, Rect2i(16 * k, 0, 16, 16), pos)


## Event picture mode: everything but the panel tiles is blank (text palette entry 0).
func clear_blank() -> void:
	image.fill(Color8(0, 0, 0))


## An event picture (160x80 stored, lines doubled) at (512, 176).
func draw_picture(pic: Image) -> void:
	var doubled := pic.duplicate() as Image
	doubled.resize(pic.get_width(), pic.get_height() * 2, Image.INTERPOLATE_NEAREST)
	image.blit_rect(doubled, Rect2i(Vector2i.ZERO, doubled.get_size()), Vector2i(512, 176))


## A highlight box (f_824ca): 16 lines from pos, width bytes; planes 0, 2 and 3 of each written
## byte replaced (lines 0-1 and 14-15 $0F $FF.. $F0, lines 2-13 $30 .. $0C), plane 1 kept.
func draw_box(pos: Vector2i, width: int) -> void:
	for y in 16:
		for k in width:
			var byte := -1
			if y < 2 or y >= 14:
				byte = 0x0f if k == 0 else (0xf0 if k == width - 1 else 0xff)
			elif k == 0:
				byte = 0x30
			elif k == width - 1:
				byte = 0x0c
			if byte < 0:
				continue
			for b in 8:
				var px := pos + Vector2i(8 * k + b, y)
				if px.x >= W or px.y >= H:
					continue
				var v := roundi(image.get_pixelv(px).r * 255.0)
				var bit := (byte >> (7 - b)) & 1
				image.set_pixelv(px, Color8((v & 2) | (13 if bit else 0), 0, 0))


func flush() -> void:
	texture.update(image)
