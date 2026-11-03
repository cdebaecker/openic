extends RefCounted
## Graphic VRAM of the cutscene programs (IL_OPEN / IL_END), as tools/export/cutscenes/replay.mjs
## models it: four 512x512 pages of 16-colour indices (graphic memory mode 0) and the two source
## buffers the programs copy from (the PIC decode buffer and the GRP buffer, 1024x512 each).
## In memory mode 4 (1024x1024) the four pages are the quadrants of one plane.
##
## Pages are FORMAT_R8 images holding the colour index; copies use Image's native blits, each
## source line written to two page lines as the programs do.

const W := 512
const BUF_W := 1024
const BUF_H := 512
const GRP_LINES := 160  # IL_OPEN expands MSG04 only until $E50000

var pages: Array[Image] = []
var textures: Array[ImageTexture] = []
var pic := Image.create_empty(BUF_W, BUF_H, false, Image.FORMAT_R8)
var grp := Image.create_empty(BUF_W, BUF_H, false, Image.FORMAT_R8)
var mode4 := false

var _dirty := [false, false, false, false]
var _masks := {}


func _init() -> void:
	for p in 4:
		var img := Image.create_empty(W, W, false, Image.FORMAT_R8)
		pages.append(img)
		textures.append(ImageTexture.create_from_image(img))


## Upload changed pages to their textures (call once per displayed frame).
func flush() -> void:
	for p in 4:
		if _dirty[p]:
			textures[p].update(pages[p])
			_dirty[p] = false


func clear_all() -> void:
	for p in 4:
		pages[p].fill(Color8(0, 0, 0))
		_dirty[p] = true


## Index image from the PIC export (index in the red channel) into a source buffer.
func load_buffer(target: Image, src: Image, lines := BUF_H) -> void:
	var idx := src.duplicate() as Image
	idx.convert(Image.FORMAT_R8)
	target.fill(Color8(0, 0, 0))
	var h := mini(lines, idx.get_height())
	target.blit_rect(idx, Rect2i(0, 0, mini(idx.get_width(), BUF_W), h), Vector2i.ZERO)


func load_pic(src: Image) -> void:
	load_buffer(pic, src)


func load_grp(src: Image) -> void:
	load_buffer(grp, src, GRP_LINES)


## Copy w x h from the PIC buffer at (sx, sy) to page `page` at (dx, dy), each source line on
## two page lines. dx is the raw 16-bit word from the timeline.
func blit(page: int, dx: int, dy: int, sx: int, sy: int, w: int, h: int, src := "pic") -> void:
	var region := _doubled_region(_source(src), sx, sy, w, h)
	if region == null:
		return
	_place(page, region, null, dx, dy)


## One pass (0, 2, 4 or 6) of the 4-pass dissolve: the same copy, one word in four, with a
## phase that moves one word per source line (5-line cycle).
func wipe(page: int, dx: int, dy: int, sx: int, sy: int, w: int, h: int, pass_no: int, src := "pic") -> void:
	var region := _doubled_region(_source(src), sx, sy, w, h)
	if region == null:
		return
	_place(page, region, _wipe_mask(w, h, pass_no), dx, dy)


## IOCS FILL on a page (page coordinates; in mode 4 the 1024x1024 plane).
func fill(page: int, x1: int, y1: int, x2: int, y2: int, color: int) -> void:
	var r := Rect2i(Vector2i(mini(x1, x2), mini(y1, y2)), Vector2i(absi(x2 - x1) + 1, absi(y2 - y1) + 1))
	if mode4:
		for q in 4:
			var origin := Vector2i((q & 1) * W, (q >> 1) * W)
			var part := r.intersection(Rect2i(origin, Vector2i(W, W)))
			if part.has_area():
				pages[q].fill_rect(Rect2i(part.position - origin, part.size), Color8(color, 0, 0))
				_dirty[q] = true
	else:
		pages[page].fill_rect(r.intersection(Rect2i(0, 0, W, W)), Color8(color, 0, 0))
		_dirty[page] = true


func _source(src: String) -> Image:
	return grp if src == "grp" else pic


func _doubled_region(buf: Image, sx: int, sy: int, w: int, h: int) -> Image:
	var r := Rect2i(sx & 0xffff, sy, w, h).intersection(Rect2i(0, 0, BUF_W, BUF_H))
	if not r.has_area():
		return null
	var region := buf.get_region(r)
	region.resize(region.get_width(), region.get_height() * 2, Image.INTERPOLATE_NEAREST)
	return region


## Pixels the dissolve pass copies, line-doubled like the region (LA8: alpha 255 = copy).
func _wipe_mask(w: int, h: int, pass_no: int) -> Image:
	var key := Vector3i(w, h, pass_no)
	if _masks.has(key):
		return _masks[key]
	var mask := Image.create_empty(w, h * 2, false, Image.FORMAT_LA8)
	var on := Color(1, 1, 1, 1)
	var row_bytes := w * 2
	var n := ((w - 1) >> 2) + 1
	var phase := 0
	for r in h:
		for k in n:
			var o := phase + pass_no + 8 * k
			if o >= row_bytes:
				o -= row_bytes
			var x := o >> 1
			if x < w:
				mask.set_pixel(x, 2 * r, on)
				mask.set_pixel(x, 2 * r + 1, on)
		phase += 2
		if phase == 10:
			phase = 0
	_masks[key] = mask
	return mask


## Put a (line-doubled) region on a page at (dx, dy). The programs compute addresses linearly
## (512 words per line, 16-bit wrap of x), so a part left of x = 0 lands at the end of the line
## above, a part right of x = 511 at the start of the line below, and lines past the bottom of
## a page at the top of the next page.
func _place(page: int, region: Image, mask: Image, dx: int, dy: int) -> void:
	if page < 3 and dy + region.get_height() > W:
		_place(page + 1, region, mask, dx, dy - W)
	if dx >= 0x8000:
		dx -= 0x10000
	var w := region.get_width()
	var h := region.get_height()
	var target := pages[page]
	# [region x range, destination offset]
	var parts := [[0, w, Vector2i(dx, dy)]]
	if dx < 0:
		parts = [[0, -dx, Vector2i(W + dx, dy - 1)], [-dx, w, Vector2i(0, dy)]]
	elif dx + w > W:
		parts = [[0, W - dx, Vector2i(dx, dy)], [W - dx, w, Vector2i(0, dy + 1)]]
	for part in parts:
		var x0: int = part[0]
		var x1: int = part[1]
		if x1 <= x0:
			continue
		var pos: Vector2i = part[2]
		var rect := Rect2i(x0, 0, x1 - x0, h)
		if mask:
			target.blit_rect_mask(region, mask, rect, pos)
		else:
			target.blit_rect(region, rect, pos)
	_dirty[page] = true
