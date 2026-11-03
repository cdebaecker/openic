extends Control
## The X68000 text layer as the cutscenes use it: a 1024x1024 plane of 8x16 cells (128 x 64),
## scrolled by CRTC R10/R11, drawn over the graphic plane with the text palette. Full-width
## (Japanese) characters take two cells.

const CELL := Vector2i(8, 16)
const COLS := 128
const ROWS := 64

var palette := PackedColorArray()
var scroll := Vector2i.ZERO
var font: Font
var font_size := 16

# row -> {col: [char, color]}
var _cells := {}


func _ready() -> void:
	clip_contents = true
	mouse_filter = Control.MOUSE_FILTER_IGNORE
	font = GameText.font
	palette.resize(16)
	palette.fill(Color.WHITE)


func clear() -> void:
	_cells.clear()
	queue_redraw()


func clear_rows(from_row: int, to_row: int) -> void:
	for r in range(from_row, to_row + 1):
		_cells.erase(posmod(r, ROWS))
	queue_redraw()


static func cell_width(ch: String) -> int:
	var c := ch.unicode_at(0)
	# Half-width: ASCII and half-width katakana; everything else takes two cells.
	return 1 if c < 0x100 or (c >= 0xff61 and c <= 0xff9f) else 2


## Print at (col, row); returns the column after the text.
func put(col: int, row: int, text: String, color := 3) -> int:
	var line: Dictionary = _cells.get_or_add(posmod(row, ROWS), {})
	for i in text.length():
		var ch := text[i]
		var w := cell_width(ch)
		if col >= 0 and col < COLS:
			if ch == " " or ch == "　":
				line.erase(col)
			else:
				line[col] = [ch, color]
			if w == 2:
				line.erase(col + 1)
		col += w
	queue_redraw()
	return col


func _draw() -> void:
	var ascent := font.get_ascent(font_size)
	for row in _cells:
		var y := posmod(row * CELL.y - scroll.y, ROWS * CELL.y)
		if y >= size.y:
			continue
		var line: Dictionary = _cells[row]
		for col in line:
			var x := posmod(col * CELL.x - scroll.x, COLS * CELL.x)
			if x >= size.x:
				continue
			var cell: Array = line[col]
			var ch: String = cell[0]
			var w := cell_width(ch) * CELL.x
			var text_w := font.get_string_size(ch, HORIZONTAL_ALIGNMENT_LEFT, -1, font_size).x
			var pos := Vector2(x + roundi((w - text_w) / 2.0), y + ascent)
			draw_string(font, pos, ch, HORIZONTAL_ALIGNMENT_LEFT, -1, font_size, palette[cell[1] & 15])
