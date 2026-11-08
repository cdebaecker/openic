extends RefCounted
## ICITY68's message engine (f_72286 & co.), transcribed from tools/events/message.mjs (verified
## against the original: every glyph cell, wait and clear of the intro and the A10 opening).
## Text is laid out per glyph in a window; waits are awaited on the host. See
## docs/cutscenes-field.md, section 4.
##
## host: put(win, cx, cy, code, colour), clear(rect), await wait_click(win, cx, cy),
##       await delay(vsyncs), insert(n) -> PackedByteArray, number(n) -> int, kinsoku -> bool
##
## English: when a page starts, its Japanese bytes are looked up in the translation table by id
## (as the web build's patcher does at $723B0) and the page is replaced by the English, wrapped
## to ENGLISH_WIDTH columns (or the window's width when it is narrower); the following pages keep
## their own lookup.

const TextCodec := preload("res://scripts/events/text_codec.gd")

const DEFAULT_COLOUR := 7
const ENGLISH_WIDTH := 50

var host
var colour := DEFAULT_COLOUR      # $9EDBE
var indent := 0                   # $9D294
var resume := -1                  # $9ED9A: offset to continue at after ':'
var end_delay := 0                # $9CB32 * 3 vsyncs after a message ending in $00


func _init(message_host) -> void:
	host = message_host


## Screen rectangle cleared by f_7ce72: 16 pixels of margin around the text area.
static func clear_rect(win: Dictionary, extra_w := 0) -> Rect2i:
	var gx: int = 64 + 8 * win["x"]
	var gy: int = 48 + 16 * win["y"]
	return Rect2i(gx - 16, gy - 16, (win["w"] + extra_w + 4) * 8, (win["h"] + 2) * 16)


static func cell_pos(win: Dictionary, cx: int, cy: int) -> Vector2i:
	return Vector2i(64 + 8 * (win["x"] + cx), 48 + 16 * (win["y"] + cy))


## Show a message (f_72286(open, 0, 0, text)) with the English page substitution. Returns the
## offset in `bytes` to continue at after a page break, or -1 at the end of the message.
## With cont, further page breaks wait for a click, clear the window and go on (as the original);
## each page is looked up in the translation table when it starts, as the web build's hook does.
func show(win: Dictionary, bytes: PackedByteArray, open := true, at := 0, cont := false) -> int:
	while true:
		var t := _translate(bytes, at, mini(ENGLISH_WIDTH, int(win["w"])))
		var r: int = await _show(win, t[0], open, 0, false)
		if r < 0:
			return -1
		# map the resume offset back into the original bytes
		at = at + r - t[1] + t[2] if r >= t[1] else at + r
		if not cont:
			return at
		await _wait_click(win)
		host.clear(clear_rect(win, 2))
		win["cx"] = 0
		win["cy"] = 0
		open = false
	return -1


## [bytes to lay out from 0, length of the replaced page in them, its original length]
func _translate(bytes: PackedByteArray, at: int, width := ENGLISH_WIDTH) -> Array:
	var rest := bytes.slice(at)
	var pre := TextCodec.prefix_length(rest)
	var body := rest.slice(pre)
	if body.size() < 2:
		return [rest, rest.size() + 1, rest.size() + 1]
	var page := TextCodec.page_length(body)
	var english := GameText.translation_for(TextCodec.message_id(body.slice(0, TextCodec.message_at(body, 0).size())))
	if english == "":
		return [rest, rest.size() + 1, rest.size() + 1]
	var en := TextCodec.from_text(TextCodec.wrap(english, width))
	var out := rest.slice(0, pre)
	out.append_array(en)
	out.append_array(body.slice(page))
	return [out, pre + en.size(), pre + page]


func _show(win: Dictionary, bytes: PackedByteArray, open: bool, at: int, cont: bool) -> int:
	if open:
		host.clear(clear_rect(win, 2))
		win["cx"] = 0
		win["cy"] = 0
		colour = DEFAULT_COLOUR
	indent = 0
	var spaces := 2000
	var dash := false
	resume = -1
	var p := at
	while _b(bytes, p) != 0 and resume < 0:
		var force_nl := false
		var c := _b(bytes, p)
		var draw := true
		var kinsoku: bool = host.kinsoku
		if c == 0x23 or c == 0x2a:  # '#n' number, '*n' number right-aligned in 6
			var n := _b(bytes, p + 1) - 0x31
			p += 2
			var v := str(host.number(n))
			if c == 0x2a:
				v = v.lpad(6)
			for ch in v:
				_put(win, ch.unicode_at(0))
			draw = false
		elif c == 0x24:  # '$n' insert a string; '$$' draws '$'
			if _b(bytes, p + 1) == 0x24:
				p += 1
			else:
				var n := _b(bytes, p + 1) - 0x31
				p += 2
				_put_string(win, host.insert(n))
				draw = false
		elif c == 0x26:  # '&d' colour
			colour = _b(bytes, p + 1) - 0x30
			p += 2
			draw = false
		elif c == 0x25:  # '%x' ignored
			p += 2
			draw = false
		elif c == 0x0f:  # wait for a click
			await _wait_click(win)
			p += 1
			draw = false
		elif c == 0x3a:  # ':' page break
			p += 1
			if not cont:
				resume = p
			else:
				await _wait_click(win)
				host.clear(clear_rect(win, 2))
				win["cx"] = 0
				win["cy"] = 0
			draw = false
		elif c == 0x0a:  # line feed (ignored right after an automatic wrap)
			if not (win["cy"] != 0 and win["cx"] == 0):
				await _line_feed(win)
			win["cx"] = indent
			spaces = 0
			p += 1
			draw = false
		elif c == 0x20:
			pass
		elif c == 0x21:  # never advanced by the original (it would loop forever)
			return -1
		else:
			if c == 0x81:
				var t := _b(bytes, p + 1)
				if t == 0x40:  # full-width space
					spaces += 2
				elif t == 0x41 or t == 0x42:  # 、 。 at a line start
					if indent == win["cx"]:
						win["cx"] = win["w"]
						win["cy"] -= 1
				elif t == 0x75:  # 「 sets the indent
					if kinsoku:
						indent = win["cx"] + 2
				elif t == 0x6e or t == 0x76:  # ］ 」 end it
					if kinsoku:
						if win["cx"] == indent:
							win["cx"] = win["w"]
							win["cy"] -= 1
						indent = 0
						var nx := _b(bytes, p + 2)
						if nx != 0 and nx != 0x3a and nx != 0x0a and nx != 0x0d:
							force_nl = true
				elif t == 0x7c:  # － centred titles
					if not dash and indent == 0:
						win["cx"] += 8
						indent = 8
						dash = true
			if indent and not dash and _b(bytes, p) != 0x81 and _b(bytes, p + 1) != 0x40:
				if spaces != 0 and spaces <= indent:
					if spaces == indent:
						win["cx"] = win["cx"] + 2 - spaces
					else:
						win["cx"] = win["cx"] - spaces
				spaces = 2000
		if draw:
			if TextCodec.is_lead(_b(bytes, p)):
				_put(win, (_b(bytes, p) << 8) | _b(bytes, p + 1))
				p += 2
			else:
				_put(win, _b(bytes, p))
				p += 1
		if _b(bytes, p) == 0:
			break
		if win["w"] <= win["cx"] or force_nl:
			win["cy"] += 1
			win["cx"] = indent
			spaces = 0
		if win["cy"] >= win["h"] - 1:
			await _wait_click(win)
			host.clear(clear_rect(win, 2))
			win["cx"] = indent
			win["cy"] = 0
			spaces = 2000
	if _b(bytes, p) == 0:
		resume = -1
		if end_delay:
			await host.delay(end_delay)
	return resume


static func _b(bytes: PackedByteArray, i: int) -> int:
	return bytes[i] if i >= 0 and i < bytes.size() else 0


func _put(win: Dictionary, code: int) -> void:  # f_72b7e
	host.put(win, win["cx"], win["cy"], code, colour)
	win["cx"] += 2 if code > 0xff else 1


func _put_string(win: Dictionary, s: PackedByteArray) -> void:  # f_72b04
	var i := 0
	while i < s.size() and s[i] != 0:
		if TextCodec.is_lead(s[i]) and i + 1 < s.size():
			_put(win, (s[i] << 8) | s[i + 1])
			i += 2
		else:
			_put(win, s[i])
			i += 1


func _line_feed(win: Dictionary) -> void:  # f_7cf28
	win["cy"] += 1
	if win["cy"] > win["h"] - 2:
		win["cy"] -= 1
		await _wait_click(win)
		host.clear(clear_rect(win, 0))
		win["cy"] = 0
	win["cx"] = 0


func _wait_click(win: Dictionary) -> void:  # f_71fca: place the ▼, blink it, wait
	var w2: int = win["w"] + 2
	if win["cy"] != 0:
		if win["cx"] == w2 - 2:
			win["cy"] += 1
		if win["cx"] == 0 or win["cx"] == w2 - 2:
			win["cx"] = w2 - 4
	if w2 - 2 < win["cx"] + 2:
		win["cx"] = 0
		win["cy"] += 1
	await host.wait_click(win, win["cx"], win["cy"])
