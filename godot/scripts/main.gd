extends Node
## Top-level flow: splash (credit and disclaimer required by the rights holder, see
## PERMISSION.md) -> game data check -> title. Each screen is a node that emits `finished`
## with the name of the next screen.

const SCREENS := {
	"splash": preload("res://scripts/screens/splash.gd"),
	"missing_data": preload("res://scripts/screens/missing_data.gd"),
	"title": preload("res://scripts/screens/title.gd"),
	"options": preload("res://scripts/screens/options.gd"),
	"cutscene": preload("res://scripts/screens/cutscene.gd"),
	"map_viewer": preload("res://scripts/screens/map_viewer.gd"),
	"field": preload("res://scripts/screens/field.gd"),
	"field_test": preload("res://scripts/dev/field_trace_test.gd"),
	"field_render_test": preload("res://scripts/dev/field_render_test.gd"),
	"message_test": preload("res://scripts/dev/message_test.gd"),
	"vm_test": preload("res://scripts/dev/vm_test.gd"),
	"systems_test": preload("res://scripts/dev/systems_test.gd"),
	"battle_test": preload("res://scripts/dev/battle_test.gd"),
	"ui_test": preload("res://scripts/dev/ui_test.gd"),
	"battle_arena_test": preload("res://scripts/dev/battle_arena_test.gd"),
}

const TESTS := {
	"--field-test=": "field_test", "--vm-test=": "vm_test", "--battle-arena-test=": "battle_arena_test",
	"--ui-test=": "ui_test", "--systems-test=": "systems_test", "--battle-test=": "battle_test",
	"--message-test=": "message_test", "--field-render-test=": "field_render_test",
}

var _screen: Node = null


func _ready() -> void:
	var Autopilot := preload("res://scripts/dev/autopilot.gd")
	if Autopilot.requested() != "":
		add_child(Autopilot.new())
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("--field-shot="):
			show_screen("map_viewer")
			return
		if arg.begins_with("--field-start="):
			# Development: start the field on a map with the party at x,y, e.g. A00@142,7
			var spec := arg.trim_prefix("--field-start=")
			var xy := spec.get_slice("@", 1).split(",")
			var p := Vector2i(xy[0].to_int(), xy[1].to_int())
			var party := [{"x": p.x, "y": p.y, "facing": 0}, {"x": p.x, "y": p.y + 1, "facing": 0, "h": 2},
				{"x": p.x, "y": p.y + 2, "facing": 0, "h": 2}]
			show_screen("field", {"map": spec.get_slice("@", 0), "party": party, "view": p - Vector2i(11, 10)})
			return
		if arg.begins_with("--screen="):
			# Development: start on a screen (title, options, ...)
			show_screen(arg.trim_prefix("--screen="))
			return
		if arg == "--new-game":
			# Development: the title's "Start from the beginning"
			show_screen("field", {"new_game": true})
			return
		if arg.begins_with("--load-block="):
			# Development: start from a saved game block (e.g. extracted from an emulator state)
			show_screen("field", {"block": arg.trim_prefix("--load-block=")})
			return
		var test := _test_screen(arg)
		if test != "":
			show_screen(test)
			return
	show_screen("splash")


## The unattended test screens by command-line argument.
func _test_screen(arg: String) -> String:
	for prefix: String in TESTS:
		if arg.begins_with(prefix):
			return TESTS[prefix]
	return ""


func show_screen(screen_name: String, args := {}) -> void:
	if _screen:
		_screen.queue_free()
	if screen_name != "splash" and not GameData.available():
		screen_name = "missing_data"
	var screen: Node = SCREENS[screen_name].new()
	if screen.has_method("setup"):
		screen.setup(args)
	screen.finished.connect(show_screen)
	_screen = screen
	add_child(screen)
