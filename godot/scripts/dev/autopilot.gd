extends Node
## Development aid: plays scripted input and takes screenshots, for testing without a person at
## the keyboard. Active only with `-- --autopilot=<script.json>`; run with --fixed-fps 60 so
## frame numbers are deterministic. Script: [{"at": frame, "press": "confirm" | "cancel" |
## "ui_down" | "ui_up", "hold": frames}, {"at": frame, "key": "Enter", "hold": frames} (a raw key, as
## OS.find_keycode_from_string names it), {"at": frame, "move": [x, y]} (pointer, viewport pixels),
## {"at": frame, "click": [x, y], "button": 1 | 2}, {"at": frame, "shot": "path.png"},
## {"at": frame, "quit": true}]

var _events: Array = []
var _frame := 0
var _releases := {}


static func requested() -> String:
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("--autopilot="):
			return arg.trim_prefix("--autopilot=")
	return ""


func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	var text := FileAccess.get_file_as_string(requested())
	var parsed: Variant = JSON.parse_string(text)
	if parsed is Array:
		_events = parsed
	else:
		push_error("Autopilot: cannot read %s" % requested())


func _process(_delta: float) -> void:
	_frame += 1
	for action in _releases.keys():
		if _releases[action] <= _frame:
			_send(action, false)
			_releases.erase(action)
	for e in _events:
		if int(e.get("at", -1)) != _frame:
			continue
		if e.has("press"):
			_send(e["press"], true)
			_releases[e["press"]] = _frame + int(e.get("hold", 2))
		if e.has("key"):
			var k := "key:" + str(e["key"])
			_send(k, true)
			_releases[k] = _frame + int(e.get("hold", 2))
		if e.has("move"):
			get_viewport().warp_mouse(Vector2(e["move"][0], e["move"][1]))
		if e.has("click"):
			var b := "mouse:%d" % int(e.get("button", 1))
			get_viewport().warp_mouse(Vector2(e["click"][0], e["click"][1]))
			_send(b, true)
			_releases[b] = _frame + int(e.get("hold", 2))
		if e.has("shot"):
			var img := get_viewport().get_texture().get_image()
			img.save_png(e["shot"])
			print("Autopilot: frame %d -> %s" % [_frame, e["shot"]])
		if e.get("quit", false):
			get_tree().quit()


func _send(action: String, pressed: bool) -> void:
	if action.begins_with("key:"):
		var kev := InputEventKey.new()
		kev.keycode = OS.find_keycode_from_string(action.trim_prefix("key:"))
		kev.physical_keycode = kev.keycode
		kev.pressed = pressed
		Input.parse_input_event(kev)
		return
	if action.begins_with("mouse:"):
		var mev := InputEventMouseButton.new()
		mev.button_index = action.trim_prefix("mouse:").to_int() as MouseButton
		mev.pressed = pressed
		mev.position = get_viewport().get_mouse_position()
		mev.global_position = mev.position
		Input.parse_input_event(mev)
		return
	var ev := InputEventAction.new()
	ev.action = action
	ev.pressed = pressed
	Input.parse_input_event(ev)
