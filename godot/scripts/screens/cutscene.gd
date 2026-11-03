extends Control
## Plays a cutscene timeline exported by tools/export/cutscenes.mjs (cutscenes/<name>.json:
## the opening IL_OPEN or the ending IL_END), reproducing what the original program did frame by
## frame: picture loads and blits into the graphic pages, palette and brightness changes, page
## scrolling, text output and music. See docs/cutscenes.md for the step format.
##
## Hold confirm to fast-forward (the original skips its waits while SHIFT/CTRL is held);
## cancel skips to the end.

signal finished(next: String, args: Dictionary)

const Vram := preload("res://scripts/cutscene/vram.gd")
const TextPlane := preload("res://scripts/cutscene/text_plane.gd")
const GraphicShader := preload("res://shaders/x68k_graphic.gdshader")

const FAST_FORWARD := 8.0
const NARRATION_COL := 13
const NARRATION_ROW := 24
const NARRATION_ROWS := 3
const NARRATION_WIDTH := 46

var cutscene := "opening"
var next_screen := "title"

var _timeline: Dictionary = {}
var _steps: Array = []
var _step := 0
var _frame := 0.0
var _frame_rate := 55.458
var _end_frame := 0

var _vram := Vram.new()
var _crtc := PackedInt32Array()
var _vc := PackedInt32Array([0, 0x06e4, 0])
var _gpal := PackedColorArray()
var _contrast := 15

var _screen := ColorRect.new()
var _material := ShaderMaterial.new()
var _text := TextPlane.new()
var _music_by_source := {}

# Subtitles for text drawn in pictures (text/<name>_subtitles.json: [{from, to, en, fr}]).
var _subtitles: Array = []
var _subtitle := Label.new()

# English narration shown in place of the Japanese one (null when not active).
var _narration: Variant = null

# Development: `-- --cutscene-shots=f1,f2,... --shot-dir=<dir>` jumps to those timeline frames
# and saves the screen as <dir>/<name>_f<frame>.png (to compare with the emulator), then quits.
var _shot_frames: Array[int] = []
var _shot_dir := ""
var _shot_wait := 0
var _shot_path := ""


func setup(args: Dictionary) -> void:
	cutscene = args.get("name", cutscene)
	next_screen = args.get("next", next_screen)


func _ready() -> void:
	set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	var bg := ColorRect.new()
	bg.color = Color.BLACK
	bg.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	add_child(bg)
	_material.shader = GraphicShader
	_screen.material = _material
	add_child(_screen)
	add_child(_text)
	_add_subtitle_label()
	_crtc.resize(48)
	_gpal.resize(16)
	_gpal.fill(Color.BLACK)
	_index_music()
	_inherit_text_palette()

	var data: Variant = GameData.json("cutscenes/%s.json" % cutscene)
	if not data is Dictionary:
		push_error("Cutscene %s: no timeline" % cutscene)
		finished.emit.call_deferred(next_screen, {})
		return
	_timeline = data
	_steps = _timeline.get("steps", [])
	_frame_rate = float(_timeline.get("recorded", {}).get("frameRate", _frame_rate))
	if _steps.is_empty():
		finished.emit.call_deferred(next_screen, {})
		return
	_frame = float(_steps[0]["f"]) - 1.0
	_end_frame = int(_steps[-1]["f"]) + int(_frame_rate)
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("--cutscene-shots="):
			for f in arg.trim_prefix("--cutscene-shots=").split(",", false):
				_shot_frames.append(f.to_int())
		elif arg.begins_with("--shot-dir="):
			_shot_dir = arg.trim_prefix("--shot-dir=")
	_shot_frames.sort()
	if " --story-route=" in " " + " ".join(OS.get_cmdline_user_args()):
		print("Cutscene %s: %d steps, frames %d-%d" % [cutscene, _steps.size(), int(_frame), _end_frame])
	_update_display()


func _process(delta: float) -> void:
	if _steps.is_empty():
		return
	if not _shot_frames.is_empty() or _shot_path != "":
		_process_shots()
		return
	var speed := FAST_FORWARD if Input.is_action_pressed("confirm") else 1.0
	_frame += delta * _frame_rate * speed
	while _step < _steps.size() and float(_steps[_step]["f"]) <= _frame:
		for op in _steps[_step]["do"]:
			_apply(op)
		_step += 1
	_update_display()
	_update_subtitle()
	if _step >= _steps.size() and _frame >= _end_frame:
		_finish()


func _add_subtitle_label() -> void:
	var path := "text/%s_subtitles.json" % cutscene
	if GameData.exists(path):
		var d: Variant = GameData.json(path)
		if d is Dictionary:
			_subtitles = d.get("lines", [])
	_subtitle.add_theme_color_override("font_outline_color", Color.BLACK)
	_subtitle.add_theme_constant_override("outline_size", 6)
	_subtitle.add_theme_constant_override("line_spacing", -2)
	_subtitle.add_theme_font_override("font", GameText.font)
	_subtitle.add_theme_font_size_override("font_size", 16)
	_subtitle.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_subtitle.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_subtitle.position = Vector2(8, 450)
	_subtitle.size = Vector2(752, 0)
	_subtitle.grow_vertical = Control.GROW_DIRECTION_BEGIN
	_subtitle.visible = false
	add_child(_subtitle)


## The subtitle of the current frame (translations only: the Japanese is in the picture).
func _update_subtitle() -> void:
	var text := ""
	if GameText.translated():
		for l: Dictionary in _subtitles:
			if _frame >= float(l["from"]) and _frame < float(l["to"]):
				text = str(l.get(GameText.language, l["en"]))
				break
	if text != _subtitle.text:
		_subtitle.text = text
		_subtitle.size = Vector2(752, 0)
		_subtitle.position.y = 510 - _subtitle.get_combined_minimum_size().y
	_subtitle.visible = text != ""


func _process_shots() -> void:
	if _shot_path != "":
		_shot_wait -= 1
		if _shot_wait > 0:
			return
		get_viewport().get_texture().get_image().save_png(_shot_path)
		print("Cutscene shot: ", _shot_path)
		_shot_path = ""
		if _shot_frames.is_empty():
			get_tree().quit()
		return
	var target := _shot_frames.pop_front() as int
	while _step < _steps.size() and int(_steps[_step]["f"]) <= target:
		for op in _steps[_step]["do"]:
			_apply(op)
		_step += 1
	_frame = target
	_update_display()
	_update_subtitle()
	_shot_path = _shot_dir.path_join("%s_f%d.png" % [cutscene, target])
	_shot_wait = 2


func _unhandled_input(event: InputEvent) -> void:
	if event.is_action_pressed("cancel"):
		get_viewport().set_input_as_handled()
		Audio.stop_music(0.5)
		_finish()


func _finish() -> void:
	set_process(false)
	set_process_unhandled_input(false)
	finished.emit(next_screen, {})


func _apply(op: Dictionary) -> void:
	match op["op"]:
		"loadPic":
			_vram.load_pic(_index_image(op["file"]))
		"loadGrp":
			_vram.load_grp(_index_image(op["file"]))
		"blit":
			_vram.blit(op["page"], op["dx"], op["dy"], op["sx"], op["sy"], op["w"], op["h"])
		"wipe":
			_vram.wipe(op["page"], op["dx"], op["dy"], op["sx"], op["sy"], op["w"], op["h"], op["pass"], op.get("src", "pic"))
		"fill":
			_vram.fill(op["page"], op["x1"], op["y1"], op["x2"], op["y2"], op["color"])
		"crtc":
			_set_crtc(op["reg"], op["value"])
		"vc":
			_vc[int(op["reg"])] = int(op["value"])
		"iocs":
			if op["name"] == "G_CLR_ON":
				_vram.clear_all()
			elif op["name"] == "CRTMOD":
				_text.clear()  # setting a screen mode clears the text screen
				_narration = null
		"gpal":
			for k in op["set"]:
				_gpal[int(k)] = x68k_color(op["set"][k].hex_to_int())
		"tpal":
			for k in op["set"]:
				_text.palette[int(k)] = x68k_color(op["set"][k].hex_to_int())
			_text.queue_redraw()
		"contrast":
			_contrast = int(op["level"])
		"zmusic":
			_zmusic(op)
		"narration":
			_start_narration(op)
		"text":
			_text_op(op)


func _set_crtc(reg: Variant, value: int) -> void:
	var reg_name := str(reg)
	if not reg_name.begins_with("R"):
		return  # the CRTC operation port (fast clear) is not used by these programs
	var n := reg_name.substr(1).get_slice(" ", 0).to_int()
	_crtc[n] = value
	if n == 20:
		_vram.mode4 = ((value >> 8) & 4) != 0


func _update_display() -> void:
	_vram.flush()
	# Visible width from the horizontal timing: 512 dots in the cutscenes, 768 for the staff roll.
	var width := (_crtc[3] - _crtc[2]) * 8
	if width < 256 or width > 768:
		width = 512
	var rect := Rect2(Vector2((768 - width) / 2.0, 0), Vector2(width, 512))
	_screen.position = rect.position
	_screen.size = rect.size
	_text.position = rect.position
	_text.size = rect.size
	_text.scroll = Vector2i(_crtc[10] & 1023, _crtc[11] & 1023)
	_text.visible = (_vc[2] & 0x20) != 0
	_text.modulate = Color(1, 1, 1) * (_contrast / 15.0)

	for p in 4:
		_material.set_shader_parameter("page%d" % p, _vram.textures[p])
	_material.set_shader_parameter("palette", _gpal)
	# Page p scroll is R12+2p (X) / R13+2p (Y); 10 bits for the 1024x1024 plane of mode 4.
	var sx := Vector4(_crtc[12], _crtc[14], _crtc[16], _crtc[18])
	var sy := Vector4(_crtc[13], _crtc[15], _crtc[17], _crtc[19])
	_material.set_shader_parameter("scroll_x", sx)
	_material.set_shader_parameter("scroll_y", sy)
	var pr := _vc[1]
	_material.set_shader_parameter("priority", Vector4(pr & 3, (pr >> 2) & 3, (pr >> 4) & 3, (pr >> 6) & 3))
	var en := _vc[2]
	_material.set_shader_parameter("enabled", Vector4(en & 1, (en >> 1) & 1, (en >> 2) & 1, (en >> 3) & 1))
	_material.set_shader_parameter("mode4", _vram.mode4)
	_material.set_shader_parameter("brightness", _contrast / 15.0)
	_material.set_shader_parameter("backdrop", _text.palette[0])
	_material.set_shader_parameter("view_size", rect.size)


## The opening runs from the title menu (MENU68), whose text palette it keeps: its entry 0 is
## the screen's backdrop. The ending sets its own.
func _inherit_text_palette() -> void:
	if not GameData.exists("cutscenes/title.json"):
		return
	var title: Variant = GameData.json("cutscenes/title.json")
	for step in title.get("steps", []):
		for op in step["do"]:
			if op["op"] == "tpal":
				for k in op["set"]:
					_text.palette[int(k)] = x68k_color(op["set"][k].hex_to_int())


## Index image (palette index in the red channel) of a PIC from the export, e.g. IGRP\CABIN.PIC.
func _index_image(file: String) -> Image:
	var rel := "pic/%s.idx.png" % file.replace("\\", "/").get_basename()
	var bytes := FileAccess.get_file_as_bytes(GameData.path(rel))
	var img := Image.new()
	if bytes.is_empty() or img.load_png_from_buffer(bytes) != OK:
		push_error("Cutscene: missing picture %s" % rel)
		return Image.create_empty(Vram.BUF_W, Vram.BUF_H, false, Image.FORMAT_R8)
	return img


## X68000 palette word (GGGGG RRRRR BBBBB I) -> Color, rounded to 8 bits as src/video.js does.
static func x68k_color(w: int) -> Color:
	var i := w & 1
	var g := (((w >> 11) & 31) << 1) | i
	var r := (((w >> 6) & 31) << 1) | i
	var b := (((w >> 1) & 31) << 1) | i
	return Color8(roundi(r * 255.0 / 63.0), roundi(g * 255.0 / 63.0), roundi(b * 255.0 / 63.0))


# --- music ---------------------------------------------------------------------------------

func _index_music() -> void:
	if not GameData.exists("audio/index.json"):
		return
	var idx: Variant = GameData.json("audio/index.json")
	for item in idx.get("items", []):
		_music_by_source[str(item.get("source", "")).to_upper()] = item["name"]


func _zmusic(op: Dictionary) -> void:
	var fn := int(op["fn"])
	if fn == 0x11 and op.has("music"):
		var track: String = _music_by_source.get(str(op["music"]).replace("\\", "/").to_upper(), "")
		if track != "":
			Audio.current = ""
			Audio.play_music(track)
	elif fn == 0x13 and op.has("adpcm"):
		var sfx: String = _music_by_source.get(str(op["adpcm"]).replace("\\", "/").to_upper(), "")
		if sfx != "":
			Audio.play_sfx(sfx)
	elif fn == 0x0a:
		Audio.stop_music()
	elif fn == 0x1a:
		Audio.stop_music(2.0)


# --- text layer and narration ----------------------------------------------------------------

func _text_op(op: Dictionary) -> void:
	match op["name"]:
		"B_CLR_ST":
			_text.clear()
			_narration = null
		"B_PRINT":
			var at: Array = op.get("at", [0, 0])
			if _narration != null and int(at[1]) >= NARRATION_ROW:
				_narration_progress()
			else:
				_text.put(int(at[0]), int(at[1]), op["text"], int(op.get("color", 3)))
		"B_PUTMES":
			var text: String = op["text"]
			var x := int(op["x"])
			var y := int(op["y"])
			if x == 0 and y >= NARRATION_ROW - 1 and y <= NARRATION_ROW and not text.strip_edges().replace("　", "").is_empty():
				_put_speaker(y, text, int(op.get("color", 3)))
			elif _narration != null and y >= NARRATION_ROW and y < NARRATION_ROW + NARRATION_ROWS:
				return  # the Japanese clearing its rows: the English redraws them
			else:
				_text.put(x, y, text, int(op.get("color", 3)))


## Speaker names are right-aligned in the first 12 cells (6 full-width characters).
func _put_speaker(row: int, text: String, color: int) -> void:
	var speaker := GameText.name_of(text)
	var width := 0
	for ch in speaker:
		width += TextPlane.cell_width(ch)
	_text.put(0, row, " ".repeat(12))
	_text.put(maxi(0, 12 - width), row, speaker, color)


## The ending's narration engine prints the Japanese script two bytes per step; the English is
## revealed in step with it: segment k (between \c clears) of the English follows segment k of
## the Japanese, in proportion to how much of it has been printed.
func _start_narration(op: Dictionary) -> void:
	_narration = null
	var id: String = op.get("id", "")
	if id == "" or not GameText.has_translation(id):
		return
	var english := _segments(GameText.message(id))
	var japanese := _segments(str(op.get("text", "")))
	var lengths: Array[int] = []
	for s in japanese:
		lengths.append(maxi(1, _printed_pairs(s)))
	_narration = {"english": english, "lengths": lengths, "segment": 0, "printed": 0}


func _narration_progress() -> void:
	var n: Dictionary = _narration
	n["printed"] += 1
	var lengths: Array = n["lengths"]
	while n["segment"] < lengths.size() - 1 and n["printed"] > lengths[n["segment"]]:
		n["printed"] -= lengths[n["segment"]]
		n["segment"] += 1
	var seg: int = n["segment"]
	var english: Array = n["english"]
	if seg >= english.size():
		return
	var lines := _wrap(english[seg])
	var total := 0
	for l in lines:
		total += l.length()
	var shown := ceili(total * minf(1.0, float(n["printed"]) / float(lengths[seg])))
	_text.clear_rows(NARRATION_ROW, NARRATION_ROW + NARRATION_ROWS - 1)
	for r in mini(lines.size(), NARRATION_ROWS):
		var line: String = lines[r]
		_text.put(NARRATION_COL, NARRATION_ROW + r, line.left(shown), 3)
		shown -= line.length()
		if shown <= 0:
			break


## Script text split at \c clears, with the engine's other commands removed.
static func _segments(script: String) -> Array:
	var out := []
	for part in script.split("\\c"):
		var s := part
		for cmd in ["\\p", "\\u", "\\w", "\\t", "\\e", "\\1", "\\r"]:
			s = s.replace(cmd, "\n" if cmd == "\\r" else "")
		out.append(s)
	return out


## Number of two-byte steps the engine takes to print a Japanese segment.
static func _printed_pairs(s: String) -> int:
	var half := 0
	var pairs := 0
	for ch in s:
		if ch == "\n":
			continue
		if TextPlane.cell_width(ch) == 1:
			half += 1
		else:
			pairs += 1
	return pairs + ceili(half / 2.0)


static func _wrap(text: String) -> PackedStringArray:
	var lines := PackedStringArray()
	for para in text.split("\n"):
		var line := ""
		for word in para.split(" ", false):
			if line.is_empty():
				line = word
			elif line.length() + 1 + word.length() <= NARRATION_WIDTH:
				line += " " + word
			else:
				lines.append(line)
				line = word
		if not line.is_empty():
			lines.append(line)
	return lines
