extends Control
## Development map viewer: the in-game screen with any map in the window. Cursor keys scroll
## (hold Shift for 8 tiles), Page Up / Page Down change map, cancel returns to the title.
## `-- --field-shot=<map>@<x>,<y>:<file.png>` renders one view, saves it and quits.

signal finished(next: String, args: Dictionary)

const FieldMap := preload("res://scripts/field/field_map.gd")
const ScreenImage := preload("res://scripts/field/field_screen_image.gd")
const IndexedShader := preload("res://shaders/indexed.gdshader")

var _screen := ScreenImage.new()
var _view := TextureRect.new()
var _material := ShaderMaterial.new()
var _label := Label.new()
var _ids := PackedStringArray()
var _map = null
var _origin := Vector2i.ZERO
var _shot := ""
var _shot_frames := 0


func setup(args: Dictionary) -> void:
	_origin = args.get("origin", _origin)
	if args.has("map"):
		_load(args["map"])


func _ready() -> void:
	set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	_material.shader = IndexedShader
	_view.material = _material
	_view.texture = _screen.texture
	_view.texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST
	_view.size = Vector2(ScreenImage.W, ScreenImage.H)
	add_child(_view)
	_label.position = Vector2(8, 492)
	add_child(_label)
	_ids = FieldMap.map_ids()
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("--field-shot="):
			var spec := arg.trim_prefix("--field-shot=")
			var at := spec.get_slice(":", 0)
			_shot = spec.substr(at.length() + 1)
			var xy := at.get_slice("@", 1).split(",")
			_origin = Vector2i(xy[0].to_int(), xy[1].to_int())
			_load(at.get_slice("@", 0))
	if _map == null:
		_load(_ids[0] if not _ids.is_empty() else "")
	_redraw()


func _load(map_id: String) -> void:
	var m = FieldMap.load_map(map_id)
	if m == null:
		return
	_map = m
	var pal := PackedColorArray()
	for w in _map.palette_words:
		pal.append(x68k_color(w))
	_material.set_shader_parameter("palette", pal)


func _redraw() -> void:
	if _map == null:
		return
	_screen.clear_to_frame()
	_screen.draw_map(_map, _origin.x, _origin.y)
	_screen.flush()
	_label.text = "%s %s  origin %d,%d  (%dx%d tiles)  PgUp/PgDn: map" % [
		_map.id, _map.place_name, _origin.x, _origin.y, _map.width * 2, _map.height * 2]


func _process(_delta: float) -> void:
	if _shot != "":
		# Wait until the view has been drawn to the screen, then save it.
		_shot_frames += 1
		if _shot_frames > 3:
			get_viewport().get_texture().get_image().save_png(_shot)
			print("Field shot: ", _shot)
			get_tree().quit()


func _unhandled_input(event: InputEvent) -> void:
	if not event.is_pressed():
		return
	var step := 8 if Input.is_key_pressed(KEY_SHIFT) else 1
	if event.is_action_pressed("ui_left"):
		_origin.x -= step
	elif event.is_action_pressed("ui_right"):
		_origin.x += step
	elif event.is_action_pressed("ui_up"):
		_origin.y -= step
	elif event.is_action_pressed("ui_down"):
		_origin.y += step
	elif event is InputEventKey and event.keycode in [KEY_PAGEUP, KEY_PAGEDOWN]:
		var i := _ids.find(_map.id) + (1 if event.keycode == KEY_PAGEDOWN else -1)
		_load(_ids[posmod(i, _ids.size())])
		_origin = Vector2i.ZERO
	elif event.is_action_pressed("cancel"):
		finished.emit("title", {})
		return
	else:
		return
	get_viewport().set_input_as_handled()
	_redraw()


## X68000 palette word (GGGGG RRRRR BBBBB I) -> Color, rounded as src/video.js does.
static func x68k_color(w: int) -> Color:
	var i := w & 1
	var g := (((w >> 11) & 31) << 1) | i
	var r := (((w >> 6) & 31) << 1) | i
	var b := (((w >> 1) & 31) << 1) | i
	return Color8(roundi(r * 255.0 / 63.0), roundi(g * 255.0 / 63.0), roundi(b * 255.0 / 63.0))
