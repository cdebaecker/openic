extends Control
## The X68000 graphic plane as the message engine uses it on the field: glyphs drawn in 8x16 /
## 16x16 cells (docs/cutscenes-field.md, "Glyphs") in front of the text layer, with the field's
## graphic palette. Unset glyph pixels are transparent, so the window's centre tiles show.

# Graphic palette on the field (the same in A00 and A10; set once by the game).
const PALETTE_WORDS := [
	0x0000, 0x0001, 0xffc0, 0xfffe, 0xde6c, 0x4022, 0x0700, 0x003e,
	0x07c0, 0x07fe, 0xf800, 0xf83e, 0xffc0, 0xfffe, 0x0000, 0xfffe,
]
# Colour byte of '&d' colour d ($9D1BC); glyph pixel value = (byte >> 4) + 1.
const COLOURS := [0x01, 0x21, 0x41, 0x61, 0x81, 0xa1, 0xc1, 0xe1, 0x05, 0x25, 0x45, 0x65, 0x85, 0xa5, 0xc5, 0xe5]

var palette := PackedColorArray()
# Vector2i(screen x, y) -> [character, pixel value]
var _glyphs := {}


func _ready() -> void:
	mouse_filter = Control.MOUSE_FILTER_IGNORE
	size = Vector2(768, 512)
	for w: int in PALETTE_WORDS:
		var i := w & 1
		palette.append(Color8(roundi(((((w >> 6) & 31) << 1) | i) * 255.0 / 63.0),
			roundi(((((w >> 11) & 31) << 1) | i) * 255.0 / 63.0), roundi(((((w >> 1) & 31) << 1) | i) * 255.0 / 63.0)))


static func pixel_of(colour: int) -> int:
	return (COLOURS[colour & 15] >> 4) + 1


func put(pos: Vector2i, character: String, colour: int) -> void:
	_glyphs[pos] = [character, pixel_of(colour)]
	queue_redraw()


func put_pixel_value(pos: Vector2i, character: String, pixel: int) -> void:
	_glyphs[pos] = [character, pixel]
	queue_redraw()


## Clear the glyphs whose cell lies in `rect` (screen pixels).
func clear_rect(rect: Rect2i) -> void:
	for pos: Vector2i in _glyphs.keys():
		if rect.has_point(pos):
			_glyphs.erase(pos)
	queue_redraw()


func clear() -> void:
	_glyphs.clear()
	queue_redraw()


func _draw() -> void:
	var font: Font = GameText.font
	var ascent := font.get_ascent(16)
	for pos: Vector2i in _glyphs:
		var g: Array = _glyphs[pos]
		if g[1] == 0:
			continue
		draw_string(font, Vector2(pos.x, pos.y + ascent), g[0], HORIZONTAL_ALIGNMENT_LEFT, -1, 16, palette[g[1] & 15])
