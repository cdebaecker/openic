extends RefCounted
## English party names in the style of the panel's name tiles (ASDF.CHR tiles 0-39): glyphs of
## 8 rows, each row drawn twice (16 pixels), strokes 2 pixels wide, coloured like the kanji / kana
## tiles: mid blue top row, light blue with white inner highlights in the middle, a mid / light
## dither near the bottom, mid blue at the foot; render(text, true) spreads that shading over each
## letter's own height, so lowercase and capitals look alike (the game uses it).
##
##   var img: Image = NameFont.render("Tianren")   # 80 x 16 RGBA, the name centred in the box

const BOX := Vector2i(80, 16)
const MID := Color8(53, 117, 182)      # palette 12 on the field (shade)
const LIGHT := Color8(117, 182, 247)   # palette 13
const WHITE := Color8(247, 247, 247)   # palette 15 (highlight)
const BG := Color8(4, 4, 4)
const SPACE := 4
const GAP := 2        # between letters

const GLYPHS := {
	"T": ["######", "..##..", "..##..", "..##..", "..##..", "..##..", "..##..", "......"],
	"i": ["##", "..", "##", "##", "##", "##", "##", ".."],
	"a": ["......", "......", "#####.", "....##", ".#####", "##..##", ".#####", "......"],
	"m": ["........", "........", "#######.", "##.##.##", "##.##.##", "##.##.##", "##.##.##", "........"],
	"n": ["......", "......", "#####.", "##..##", "##..##", "##..##", "##..##", "......"],
	"r": [".....", ".....", "##.##", "###..", "##...", "##...", "##...", "....."],
	"e": ["......", "......", ".####.", "##..##", "######", "##....", ".#####", "......"],
	"M": ["##....##", "###..###", "########", "##.##.##", "##....##", "##....##", "##....##", "........"],
	"h": ["##....", "##....", "#####.", "##..##", "##..##", "##..##", "##..##", "......"],
	"o": ["......", "......", ".####.", "##..##", "##..##", "##..##", ".####.", "......"],
	"g": ["......", "......", ".#####", "##..##", "##..##", ".#####", "....##", "#####."],
	"H": ["##..##", "##..##", "##..##", "######", "##..##", "##..##", "##..##", "......"],
	"u": ["......", "......", "##..##", "##..##", "##..##", "##..##", ".#####", "......"],
	"s": ["......", "......", ".#####", "##....", ".####.", "....##", "#####.", "......"],
	"t": [".##..", ".##..", "#####", ".##..", ".##..", ".##..", "..###", "....."],
	"S": [".####.", "##..##", "##....", ".####.", "....##", "##..##", ".####.", "......"],
	"I": ["####", ".##.", ".##.", ".##.", ".##.", ".##.", "####", "...."],
	"c": ["......", "......", ".####.", "##..##", "##....", "##..##", ".####.", "......"],
	"K": ["##..##", "##.##.", "####..", "###...", "####..", "##.##.", "##..##", "......"],
	"D": ["#####.", "##..##", "##..##", "##..##", "##..##", "##..##", "#####.", "......"],
	"L": ["##....", "##....", "##....", "##....", "##....", "##....", "######", "......"],
	"k": ["##....", "##....", "##..##", "##.##.", "####..", "##.##.", "##..##", "......"],
	"l": ["##", "##", "##", "##", "##", "##", "##", ".."],
	"y": ["......", "......", "##..##", "##..##", "##..##", ".#####", "....##", "#####."],
	"d": ["....##", "....##", ".#####", "##..##", "##..##", "##..##", ".#####", "......"],
	"A": [".####.", "##..##", "##..##", "######", "##..##", "##..##", "##..##", "......"],
	"N": ["##..##", "###.##", "######", "##.###", "##..##", "##..##", "##..##", "......"],
	"R": ["#####.", "##..##", "##..##", "#####.", "####..", "##.##.", "##..##", "......"],
	"E": ["######", "##....", "##....", "#####.", "##....", "##....", "######", "......"],
	"O": [".####.", "##..##", "##..##", "##..##", "##..##", "##..##", ".####.", "......"],
	"G": [".####.", "##..##", "##....", "##.###", "##..##", "##..##", ".#####", "......"],
	"U": ["##..##", "##..##", "##..##", "##..##", "##..##", "##..##", ".####.", "......"],
	"C": [".####.", "##..##", "##....", "##....", "##....", "##..##", ".####.", "......"],
}


## True when every character of `text` has a glyph (else the caller keeps another rendering).
static func covers(text: String) -> bool:
	for ch in text:
		if ch != " " and not GLYPHS.has(ch):
			return false
	return true


static func _width(text: String) -> int:
	var w := 0
	for ch in text:
		w += SPACE if ch == " " else (GLYPHS[ch][0] as String).length() + GAP
	return maxi(0, w - GAP)


static func render(text: String, relative := false) -> Image:
	var img := Image.create_empty(BOX.x, BOX.y, false, Image.FORMAT_RGBA8)
	img.fill(BG)
	var x := maxi(0, (BOX.x - _width(text)) / 2)
	for ch in text:
		if ch == " ":
			x += SPACE
			continue
		var g: Array = GLYPHS[ch]
		var w := (g[0] as String).length()
		var top := 0
		var bottom := 7
		if relative:   # the shading spread over the letter's own height
			while top < 7 and not (g[top] as String).contains("#"):
				top += 1
			while bottom > top and not (g[bottom] as String).contains("#"):
				bottom -= 1
		for r in 8:
			var row: String = g[r]
			for c in w:
				if row[c] != "#" or x + c >= BOX.x:
					continue
				var inner := c > 0 and row[c - 1] == "#"   # all but a stroke's left edge
				var phase := r if not relative else roundi(float(r - top) * 6.0 / maxf(1.0, bottom - top))
				var col := _colour(phase, x + c, inner)
				img.set_pixel(x + c, 2 * r, col)
				img.set_pixel(x + c, 2 * r + 1, col)
		x += w + GAP
	return img


## The tiles' shading by row: mid blue at the top, light blue in the middle with white inside
## strokes, a mid / light dither below, mid blue at the foot (and the descender).
static func _colour(row: int, x: int, inner: bool) -> Color:
	match row:
		0:
			return MID
		1:
			return MID if inner else LIGHT
		2, 3:
			return WHITE if inner else LIGHT
		4:
			return LIGHT
		5:
			return MID if x & 1 else LIGHT
	return MID
