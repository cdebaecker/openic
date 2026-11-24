extends RefCounted
## Graphic VRAM of the cutscene programs (IL_OPEN / IL_END), as tools/export/cutscenes/replay.mjs
## models it: four 512x512 pages of 16-colour indices (graphic memory mode 0) and the two source
## buffers the programs copy from (the PIC decode buffer and the GRP buffer, 1024x512 each).
## In memory mode 4 (1024x1024) the four pages are the quadrants of one plane.
##
## Pages are FORMAT_R8 images holding the colour index; copies use Image's native blits, each
## source line written to two page lines as the programs do.
##
## With HD art (enable_hd; scripts/hd/hd_art.gd) every copy is made again at 2x into HD pages
## from the pictures' HD versions (made from their doubled lines), which the graphic shader draws
## where they hold the page's index; fills and pictures without an HD version leave them empty.

const W := 512
const BUF_W := 1024
const BUF_H := 512
const GRP_LINES := 160  # IL_OPEN expands MSG04 only until $E50000

var pages: Array[Image] = []
var textures: Array[ImageTexture] = []
var pic := Image.create_empty(BUF_W, BUF_H, false, Image.FORMAT_R8)
var grp := Image.create_empty(BUF_W, BUF_H, false, Image.FORMAT_R8)
var mode4 := false
## HD art: 2x pages (RGBA8 as stored by scripts/hd/hd_art.gd; alpha 0 = none) and the 2x
## buffers (the doubled lines at 2x: 2048 x 2048)
var hd := false
var hd_pages: Array[Image] = []
var hd_textures: Array[ImageTexture] = []
var hd_pic: Image = null
var hd_grp: Image = null
var _hd_masks := {}

var _dirty := [false, false, false, false]
var _masks := {}


func _init() -> void:
	for p in 4:
		var img := Image.create_empty(W, W, false, Image.FORMAT_R8)
		pages.append(img)
		textures.append(ImageTexture.create_from_image(img))


func enable_hd() -> void:
	hd = true
	for p in 4:
		var img := Image.create_empty(W * 2, W * 2, false, Image.FORMAT_RGBA8)
		hd_pages.append(img)
		hd_textures.append(ImageTexture.create_from_image(img))
	hd_pic = Image.create_empty(BUF_W * 2, BUF_H * 4, false, Image.FORMAT_RGBA8)
	hd_grp = Image.create_empty(BUF_W * 2, BUF_H * 4, false, Image.FORMAT_RGBA8)


## Upload changed pages to their textures (call once per displayed frame).
func flush() -> void:
	for p in 4:
		if _dirty[p]:
			textures[p].update(pages[p])
			if hd:
				hd_textures[p].update(hd_pages[p])
			_dirty[p] = false


func clear_all() -> void:
	for p in 4:
		pages[p].fill(Color8(0, 0, 0))
		if hd:
			hd_pages[p].fill(Color(0, 0, 0, 0))
		_dirty[p] = true


## Index image from the PIC export (index in the red channel) into a source buffer; with HD art
## its HD version (`hd_src`, or null) into the buffer's HD one.
func load_buffer(target: Image, src: Image, lines := BUF_H, hd_target: Image = null, hd_src: Image = null) -> void:
	var idx := src.duplicate() as Image
	idx.convert(Image.FORMAT_R8)
	target.fill(Color8(0, 0, 0))
	var h := mini(lines, idx.get_height())
	var w := mini(idx.get_width(), BUF_W)
	target.blit_rect(idx, Rect2i(0, 0, w, h), Vector2i.ZERO)
	if hd_target != null:
		hd_target.fill(Color(0, 0, 0, 0))
		if hd_src != null:
			hd_target.blit_rect(hd_src, Rect2i(0, 0, w * 2, h * 4), Vector2i.ZERO)


func load_pic(src: Image, hd_src: Image = null) -> void:
	load_buffer(pic, src, BUF_H, hd_pic, hd_src)


func load_grp(src: Image, hd_src: Image = null) -> void:
	load_buffer(grp, src, GRP_LINES, hd_grp, hd_src)


## Copy w x h from the PIC buffer at (sx, sy) to page `page` at (dx, dy), each source line on
## two page lines. dx is the raw 16-bit word from the timeline.
func blit(page: int, dx: int, dy: int, sx: int, sy: int, w: int, h: int, src := "pic") -> void:
	var region := _doubled_region(_source(src), sx, sy, w, h)
	if region == null:
		return
	_place(page, region, null, dx, dy, _hd_region(src, sx, sy, w, h))


## One pass (0, 2, 4 or 6) of the 4-pass dissolve: the same copy, one word in four, with a
## phase that moves one word per source line (5-line cycle).
func wipe(page: int, dx: int, dy: int, sx: int, sy: int, w: int, h: int, pass_no: int, src := "pic") -> void:
	var region := _doubled_region(_source(src), sx, sy, w, h)
	if region == null:
		return
	var mask := _wipe_mask(w, h, pass_no)
	_place(page, region, mask, dx, dy, _hd_region(src, sx, sy, w, h), _hd_mask(mask))


## IOCS FILL on a page (page coordinates; in mode 4 the 1024x1024 plane).
func fill(page: int, x1: int, y1: int, x2: int, y2: int, color: int) -> void:
	var r := Rect2i(Vector2i(mini(x1, x2), mini(y1, y2)), Vector2i(absi(x2 - x1) + 1, absi(y2 - y1) + 1))
	if mode4:
		for q in 4:
			var origin := Vector2i((q & 1) * W, (q >> 1) * W)
			var part := r.intersection(Rect2i(origin, Vector2i(W, W)))
			if part.has_area():
				pages[q].fill_rect(Rect2i(part.position - origin, part.size), Color8(color, 0, 0))
				if hd:
					hd_pages[q].fill_rect(Rect2i((part.position - origin) * 2, part.size * 2), Color(0, 0, 0, 0))
				_dirty[q] = true
	else:
		var part := r.intersection(Rect2i(0, 0, W, W))
		pages[page].fill_rect(part, Color8(color, 0, 0))
		if hd:
			hd_pages[page].fill_rect(Rect2i(part.position * 2, part.size * 2), Color(0, 0, 0, 0))
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


## The HD version of _doubled_region (2x), or null without HD art.
func _hd_region(src: String, sx: int, sy: int, w: int, h: int) -> Image:
	if not hd:
		return null
	var r := Rect2i(sx & 0xffff, sy, w, h).intersection(Rect2i(0, 0, BUF_W, BUF_H))
	if not r.has_area():
		return null
	var buf := hd_grp if src == "grp" else hd_pic
	return buf.get_region(Rect2i(r.position.x * 2, r.position.y * 4, r.size.x * 2, r.size.y * 4))


func _hd_mask(mask: Image) -> Image:
	if not hd:
		return null
	if not _hd_masks.has(mask):
		var m := mask.duplicate() as Image
		m.resize(mask.get_width() * 2, mask.get_height() * 2, Image.INTERPOLATE_NEAREST)
		_hd_masks[mask] = m
	return _hd_masks[mask]


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
func _place(page: int, region: Image, mask: Image, dx: int, dy: int, hd_region: Image = null,
		hd_mask: Image = null) -> void:
	if page < 3 and dy + region.get_height() > W:
		_place(page + 1, region, mask, dx, dy - W, hd_region, hd_mask)
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
		if hd_region != null:
			var hd_rect := Rect2i(rect.position * 2, rect.size * 2)
			if hd_mask != null:
				hd_pages[page].blit_rect_mask(hd_region, hd_mask, hd_rect, pos * 2)
			else:
				hd_pages[page].blit_rect(hd_region, hd_rect, pos * 2)
		elif hd:
			# no HD picture: the page shows its index there
			hd_pages[page].fill_rect(Rect2i(pos * 2, rect.size * 2), Color(0, 0, 0, 0))
	_dirty[page] = true
