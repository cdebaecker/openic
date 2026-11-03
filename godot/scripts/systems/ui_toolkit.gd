extends RefCounted
## ICITY68's interface toolkit (docs/systems-ui.md section 1), transcribed from
## tools/systems-ui/ui.mjs: UI windows (frames drawn by the field view from the host's window list),
## the UI printer f_7d332, the choice menu f_81f8e, the paged list f_830ce / f_82e60, the blinking
## highlight box f_824ca and the character selection f_7e350.
##
## host (the field screen): layer (DialogueLayer), events (windows, sound()), render(),
## ui_boxes (highlight boxes drawn by the view), scripted_choice() -> int (-2 = none),
## get_tree(), get_local_mouse_position().
##
## Text: every string goes through GameText.interface_bytes first (the glossary rules, applied to
## each printed string as the web build's patcher hooks f_7d332), then is laid out per byte as the
## original does, so field offsets and widths stay those of the templates.

const MessageEngine := preload("res://scripts/events/message_engine.gd")
const DialogueLayer := preload("res://scripts/events/dialogue_layer.gd")

## Window rectangles (x, y, w, h in 8-pixel columns / 16-line rows from (64, 48)).
const RECTS := {
	"money": Rect2i(20, 14, 26, 1), "command": Rect2i(20, 4, 14, 6), "charsel": Rect2i(18, 6, 18, 3),
	"magicHead": Rect2i(18, 4, 22, 5),
	"spellMode": Rect2i(36, 12, 16, 3), "magicList": Rect2i(22, 12, 30, 6), "magicNone": Rect2i(22, 14, 34, 4),
	"itemCmd": Rect2i(20, 4, 30, 2), "itemList": Rect2i(20, 9, 30, 8), "discard": Rect2i(36, 12, 16, 2),
	"confirm": Rect2i(40, 16, 16, 2), "equipHead": Rect2i(18, 3, 40, 7), "equipList": Rect2i(22, 13, 30, 6),
	"statusMenu": Rect2i(20, 6, 16, 3), "personal": Rect2i(20, 4, 26, 14), "skills": Rect2i(20, 4, 30, 10),
	"strength": Rect2i(20, 4, 34, 10), "system": Rect2i(20, 4, 16, 4), "speed": Rect2i(18, 4, 40, 7),
	"switches": Rect2i(20, 4, 26, 6), "bgm": Rect2i(18, 4, 40, 6), "load": Rect2i(20, 4, 24, 5),
	"shopCat": Rect2i(20, 4, 18, 6), "shopList": Rect2i(22, 4, 32, 8), "shopMsg": Rect2i(18, 14, 40, 4),
	"shopQty": Rect2i(40, 11, 18, 4),
	# the slot list (f_66bf4; its rectangle is not in a table: from the system trace)
	"slots": Rect2i(20, 6, 40, 9),
}
const BUZZER := 5
const WIN_KIND := 20          # window "k" of UI windows in the host's list (message windows use 0-9)

var host
var _repeat := {}


func _init(ui_host) -> void:
	host = ui_host


# --- windows -------------------------------------------------------------------------------------

## f_7cb54(rect, 6): a framed window, pushed on the host's window list.
func open(name: String) -> Dictionary:
	var r: Rect2i = RECTS[name]
	var win := {"k": WIN_KIND, "name": name, "x": r.position.x, "y": r.position.y, "w": r.size.x, "h": r.size.y,
		"cx": 0, "cy": 0, "colour": 7}
	host.events.windows.append(win)
	host.layer.clear_rect(MessageEngine.clear_rect(win))   # the text of windows below goes
	host.render()
	return win


## f_7cd4c: close the top window (its text area cleared, its frame gone at the next render).
func close() -> void:
	var ws: Array = host.events.windows
	if ws.is_empty():
		return
	var win: Dictionary = ws.pop_back()
	host.layer.clear_rect(MessageEngine.clear_rect(win))
	_drop_boxes(win)
	host.render()


func close_all() -> void:
	while not host.events.windows.is_empty():
		close()


## f_7cf02: clear the text area, cursor home.
func clear(win: Dictionary) -> void:
	host.layer.clear_rect(MessageEngine.clear_rect(win))
	win["cx"] = 0
	win["cy"] = 0


# --- the UI printer f_7d332 ----------------------------------------------------------------------

## Print bytes at the window cursor ('%' skipped, $0E n colour, $0A new line, $0C clear; wrap
## before a glyph when cx + width > w - 2).
func print_bytes(win: Dictionary, raw: PackedByteArray) -> void:
	var bytes := GameText.interface_bytes(raw)
	var i := 0
	var n := bytes.size()
	while i < n and bytes[i] != 0:
		var c := bytes[i]
		i += 1
		if c == 0x25:
			continue
		var p := 0
		if c == 0x0e:
			p = bytes[i] if i < n else 0
			i += 1
		elif c > 0x1f and c <= 0xfb and _is_lead(c):
			p = bytes[i] if i < n else 0
			i += 1
		var adv := 0
		if c <= 0x1f:
			if c == 0x0a:
				win["cx"] = 0
				win["cy"] += 1
			elif c == 0x0c:
				clear(win)
			elif c == 0x0e:
				win["colour"] = p
		elif c >= 0xfd or c == 0x7f:
			pass
		else:
			var code := (c << 8) | p if p else c
			var width := 1 if c < 0x80 or (c >= 0xa0 and c <= 0xdf) else 2
			if width == 2 and (c == 0x85 or c == 0x86):
				width = 1
			if win["cx"] + width > win["w"] - 2:
				win["cx"] = 0
				win["cy"] += 1
			host.layer.put_pixel_value(MessageEngine.cell_pos(win, win["cx"], win["cy"]), GameText.char_for(code),
				DialogueLayer.pixel_of(win["colour"]))
			adv = 1 if code < 0x100 else (1 if _jis_row(code) > 0x28 and _jis_row(code) <= 0x2b else 2)
		win["cx"] += adv


func print_at(win: Dictionary, cx: int, cy: int, bytes: PackedByteArray) -> void:
	win["cx"] = cx
	win["cy"] = cy
	print_bytes(win, bytes)


## Lines printed back to back from (0, 0), the window widened by 2 (money line, static screens).
func print_lines(win: Dictionary, lines: Array, widen := 0) -> void:
	win["w"] += widen
	win["cx"] = 0
	win["cy"] = 0
	for l: PackedByteArray in lines:
		print_bytes(win, l)
	win["w"] -= widen


static func _is_lead(c: int) -> bool:
	return (c >= 0x81 and c < 0xa0) or (c >= 0xe0 and c < 0xf0)


static func _jis_row(sjis: int) -> int:
	var hi := sjis >> 8
	hi -= 0x71 if hi <= 0x9f else 0xb1
	hi = hi * 2 + 1
	if (sjis & 0xff) >= 0x9f:
		hi += 1
	return hi


static func strlen(b: PackedByteArray) -> int:
	var n := 0
	while n < b.size() and b[n] != 0:
		n += 1
	return n


# --- highlight boxes (f_824ca / f_8266a) ---------------------------------------------------------

func _set_box(win: Dictionary, col: int, row: int, width: int) -> void:
	_drop_boxes(win)
	if width > 0:
		host.ui_boxes.append({"win": win, "x": 64 + 8 * (int(win["x"]) + col), "y": 48 + 16 * (int(win["y"]) + row),
			"w": width, "on": true})


func _drop_boxes(win: Dictionary) -> void:
	var boxes: Array = host.ui_boxes
	for k in range(boxes.size() - 1, -1, -1):
		if boxes[k]["win"] == win:
			boxes.remove_at(k)


## The box blinks: drawn / erased whenever bit 5 of the vsync counter changes.
func _blink(frames: int) -> void:
	var on := ((frames >> 5) & 1) == 0
	var changed := false
	for b: Dictionary in host.ui_boxes:
		if b["on"] != on:
			b["on"] = on
			changed = true
	if changed:
		host.render()


# --- input ---------------------------------------------------------------------------------------

## A key press with the game's repeat (f_7df66): first press, then after 5 ticks every 5, after 8
## repeats every 3.
func _pressed(action: String) -> bool:
	if not Input.is_action_pressed(action):
		_repeat.erase(action)
		return false
	if not _repeat.has(action):
		_repeat[action] = [0, 0]
		return true
	if action == "confirm" or action == "cancel":
		return false      # no repeat (both are also mouse buttons)
	var r: Array = _repeat[action]
	r[0] += 1
	var period := 3 if r[1] >= 8 else 5
	if r[0] >= period:
		r[0] = 0
		r[1] += 1
		return true
	return false


# public input helpers for screens with their own loops (SYSTEM speed / BGM)
func pressed(action: String) -> bool:
	return _pressed(action)


func clicked(button: int) -> bool:
	return _mouse_clicked(button)


func pointer() -> Vector2:
	return _mouse_pos()


func reset_input() -> void:
	_reset_input()


func set_box(win: Dictionary, col: int, row: int, width: int) -> void:
	_set_box(win, col, row, width)
	host.render()


func blink(frames: int) -> void:
	_blink(frames)


func _mouse_pos() -> Vector2:
	return host.get_local_mouse_position()


func _mouse_clicked(button: int) -> bool:
	var down := Input.is_mouse_button_pressed(button)
	var key := "mouse%d" % button
	var was: bool = _repeat.get(key, true)
	_repeat[key] = down
	return down and not was


func _reset_input() -> void:
	_repeat.clear()
	for a in ["ui_up", "ui_down", "ui_left", "ui_right", "confirm", "cancel"]:
		if Input.is_action_pressed(a):
			_repeat[a] = [0, 0]
	_repeat["mouse%d" % MOUSE_BUTTON_LEFT] = Input.is_mouse_button_pressed(MOUSE_BUTTON_LEFT)
	_repeat["mouse%d" % MOUSE_BUTTON_RIGHT] = Input.is_mouse_button_pressed(MOUSE_BUTTON_RIGHT)


# --- f_81f8e: choice menu ------------------------------------------------------------------------

## Print " " + item + "\n" per item (window widened by 2); returns {header, count, width}.
func menu_layout(win: Dictionary, header: int, items: Array) -> Dictionary:
	win["w"] += 2
	win["cx"] = 0
	win["cy"] = 0
	var width := 4
	for k in items.size():
		var it: PackedByteArray = items[k]
		print_bytes(win, PackedByteArray([0x20]))
		print_bytes(win, it)
		print_bytes(win, PackedByteArray([0x0a]))
		if k >= header and strlen(it) > width:
			width = strlen(it)
	win["w"] -= 2
	return {"header": header, "count": items.size() - header, "width": width + 2}


## Run a menu: returns the item index (without the header) or -1. The box of the chosen item stays.
func menu(win: Dictionary, header: int, cursor: int, items: Array) -> int:
	var m := menu_layout(win, header, items)
	var scripted: int = host.scripted_choice()
	if scripted != -2:
		await _settle()
		return clampi(scripted, -1, m["count"] - 1)
	var sel := cursor if cursor < m["count"] else -1
	var frames := 0
	var last_mouse := _mouse_pos()
	_reset_input()
	_set_box(win, 0, header + sel, m["width"] if sel >= 0 else 0)
	while true:
		await host.get_tree().process_frame
		frames += 1
		_blink(frames)
		var prev := sel
		var mp := _mouse_pos()
		if mp != last_mouse:
			last_mouse = mp
			sel = _menu_hit(win, m, mp)
		if _pressed("ui_up"):
			sel = 0 if sel < 0 else posmod(sel - 1, m["count"])
		elif _pressed("ui_down"):
			sel = 0 if sel < 0 else (sel + 1) % m["count"]
		if sel != prev:
			frames = 0
			_set_box(win, 0, header + sel, m["width"] if sel >= 0 else 0)
			host.render()
		var confirmed := _pressed("confirm")
		var clicked := _mouse_clicked(MOUSE_BUTTON_LEFT)
		if (confirmed or clicked) and sel >= 0:
			_show_box(win)
			return sel
		if confirmed and not clicked and sel < 0:
			# keyboard: with nothing selected, confirm selects item 0 (as the cursor keys do)
			sel = 0
			frames = 0
			_set_box(win, 0, header, m["width"])
			host.render()
		if _pressed("cancel") or _mouse_clicked(MOUSE_BUTTON_RIGHT):
			_drop_boxes(win)
			host.render()
			return -1
	return -1


func _menu_hit(win: Dictionary, m: Dictionary, p: Vector2) -> int:
	var x0: int = 64 + 8 * int(win["x"])
	var y0: int = 48 + 16 * (int(win["y"]) + int(m["header"]))
	if p.x < x0 or p.x >= x0 + 8 * int(m["width"]) or p.y < y0:
		return -1
	var i := int((p.y - y0) / 16)
	return i if i < m["count"] else -1


func _show_box(win: Dictionary) -> void:
	for b: Dictionary in host.ui_boxes:
		if b["win"] == win:
			b["on"] = true
	host.render()


func _settle() -> void:
	for i in 20:
		await host.get_tree().process_frame


# --- f_830ce / f_82e60: paged list ---------------------------------------------------------------

func list_geometry(header: int, items: Array, cols: int) -> Dictionary:
	var width := 4
	for k in range(header, items.size()):
		width = maxi(width, strlen(items[k]))
	return {"header": header, "cols": cols, "width": width + 2,
		"total_rows": ceili(float(items.size() - header) / cols)}


## f_82e60: clear, header rows, the visible entries, ▲▼ when the list is longer than the window.
func list_draw(win: Dictionary, g: Dictionary, top: int, rows: int, items: Array) -> void:
	clear(win)
	win["w"] += 2
	for k in g["header"]:
		print_bytes(win, PackedByteArray([0x20]))
		print_bytes(win, items[k])
		print_bytes(win, PackedByteArray([0x0a]))
	for n in int(g["cols"]) * rows:
		var idx: int = g["header"] + top * int(g["cols"]) + n
		win["cx"] = 1 + (n % int(g["cols"])) * int(g["width"])
		win["cy"] = int(g["header"]) + n / int(g["cols"])
		if idx < items.size():
			print_bytes(win, items[idx])
	win["colour"] = 7
	if rows < g["total_rows"]:
		print_at(win, int(win["w"]) - 4, 0, PackedByteArray([0x81, 0xa3]))
		print_at(win, int(win["w"]) - 4, rows - 1, PackedByteArray([0x81, 0xa5]))
	win["w"] -= 2


## Run a list: returns {"index": top*cols + row*cols + col or -1, "top": top}. page_scroll: the
## arrows scroll a page ($9CF0E = 2, shops).
func run_list(win: Dictionary, header: int, cursor: int, top: int, cols: int, rows: int, items: Array,
		page_scroll := false) -> Dictionary:
	var g := list_geometry(header, items, cols)
	var total: int = g["total_rows"]
	var max_top := maxi(0, total - rows)
	top = clampi(top, 0, max_top)
	list_draw(win, g, top, rows, items)
	var scripted: int = host.scripted_choice()
	if scripted != -2:
		await _settle()
		return {"index": scripted, "top": 0}
	var sel := cursor - top * cols if cursor >= 0 else -1    # visible cell: row * cols + col
	var frames := 0
	var last_mouse := _mouse_pos()
	_reset_input()
	_place_list_box(win, g, sel)
	while true:
		await host.get_tree().process_frame
		frames += 1
		_blink(frames)
		var prev := sel
		var prev_top := top
		var arrow := 0
		var mp := _mouse_pos()
		if mp != last_mouse:
			last_mouse = mp
			sel = _list_hit(win, g, rows, mp)
			arrow = _arrow_hit(win, rows, mp) if rows < total else 0
			if arrow != 0:
				_set_box(win, int(win["w"]) - 3, 0 if arrow < 0 else rows - 1, 4)
				host.render()
				prev = -99
		var step := rows if page_scroll else 1
		var confirmed := _pressed("confirm")
		var clicked := _mouse_clicked(MOUSE_BUTTON_LEFT)
		if confirmed and not clicked and sel < 0:
			sel = 0        # keyboard: confirm with nothing selected selects the first cell
			confirmed = false
		if clicked:
			var a := _arrow_hit(win, rows, mp) if rows < total else 0
			if a != 0:
				top = clampi(top + a * step, 0, max_top)
			elif sel >= 0 and top * cols + sel < items.size() - header:
				_show_box(win)
				return {"index": top * cols + sel, "top": top}
		if _pressed("cancel") or _mouse_clicked(MOUSE_BUTTON_RIGHT):
			_drop_boxes(win)
			host.render()
			return {"index": -1, "top": top}
		var r := sel / cols if sel >= 0 else -1
		var c := sel % cols if sel >= 0 else 0
		if _pressed("ui_up"):
			if sel < 0:
				r = 0
			elif r > 0:
				r -= 1
			elif top > 0:
				top -= 1
		elif _pressed("ui_down"):
			if sel < 0:
				r = 0
			elif r < rows - 1 and (top + r + 1) < total:
				r += 1
			elif top < max_top:
				top += 1
		elif _pressed("ui_left"):
			if sel < 0:
				r = 0
			elif c > 0:
				c -= 1
			elif top > 0:
				top = maxi(0, top - rows)
		elif _pressed("ui_right"):
			if sel < 0:
				r = 0
			elif c < cols - 1:
				c += 1
			elif top < max_top:
				top = mini(max_top, top + rows)
		if r >= 0:
			sel = r * cols + c
		if confirmed and not clicked and sel >= 0 and top * cols + sel < items.size() - header:
			_show_box(win)
			return {"index": top * cols + sel, "top": top}
		if top != prev_top:
			list_draw(win, g, top, rows, items)
		if sel != prev or top != prev_top:
			frames = 0
			_place_list_box(win, g, sel)
	return {"index": -1, "top": top}


func _place_list_box(win: Dictionary, g: Dictionary, sel: int) -> void:
	var cols: int = g["cols"]
	if sel >= 0:
		_set_box(win, (sel % cols) * int(g["width"]), int(g["header"]) + sel / cols, int(g["width"]) - 1)
	else:
		_set_box(win, 0, 0, 0)
	host.render()


func _list_hit(win: Dictionary, g: Dictionary, rows: int, p: Vector2) -> int:
	for c in int(g["cols"]):
		for r in rows:
			var x0: int = 64 + 8 * int(win["x"]) + 8 * c * int(g["width"])
			var y0: int = 48 + 16 * (int(win["y"]) + r + int(g["header"]))
			if p.x >= x0 and p.x < x0 + 8 * int(g["width"]) and p.y >= y0 and p.y < y0 + 16:
				return r * int(g["cols"]) + c
	return -1


## -1 = the ▲ box (row 0), 1 = the ▼ box (row rows - 1), 0 = neither.
func _arrow_hit(win: Dictionary, rows: int, p: Vector2) -> int:
	var x0: int = 64 + 8 * (int(win["x"]) + int(win["w"]) - 3)
	if p.x < x0 or p.x >= x0 + 32:
		return 0
	var row := int((p.y - 48 - 16 * int(win["y"])) / 16)
	return -1 if row == 0 else (1 if row == rows - 1 else 0)


# --- f_7e350: character selection ----------------------------------------------------------------

## items: the screen builder's entries (charsel_items); accepted: per party slot (colour 7 and
## $9C9AC[slot] = 0). Returns the party slot, or -1 (cancel, or a refused member: buzzer).
func charsel(items: Array, accepted: Array) -> int:
	var win := open("charsel")
	var k: int = await menu(win, 0, 0, items)
	close()
	if k < 0:
		return -1
	if k >= accepted.size() or not accepted[k]:
		host.events.sound(BUZZER)
		return -1
	return k


## Wait for a click / key (f_8246e).
func wait_click() -> void:
	if host.scripted_choice_pending():
		await _settle()
		return
	_reset_input()
	while true:
		await host.get_tree().process_frame
		if _pressed("confirm") or _pressed("cancel") or _mouse_clicked(MOUSE_BUTTON_LEFT) \
				or _mouse_clicked(MOUSE_BUTTON_RIGHT):
			return
