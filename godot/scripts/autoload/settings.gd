extends Node
## The port's options (user://settings.cfg): display, volume, language, speed, the fixes of the
## original's bugs (docs/battle.md, "Bugs of the original") and the key / gamepad bindings.
##
## Speed is Engine.time_scale: the field clock, the event waits, the battle redraws and the fades
## all run on scaled time, so one factor speeds up everything the original timed in vsyncs.
## Music and sound effects are not scaled.

signal changed

const PATH := "user://settings.cfg"
const SystemsModel := preload("res://scripts/systems/systems_model.gd")
const SCALES := [1, 2, 3, 4]
const SPEEDS := [1.0, 1.5, 2.0, 3.0]
const FAST_FORWARD := 4.0
## Battle fixes (bs.fixes of the battle model): name -> default
const FIXES := {"damage": true, "status_messages": true, "flight": true, "enemy_ai": false, "effects": true}
## Rebindable actions: [action, English, Japanese, default key, default gamepad button, French]
const ACTIONS := [
	["ui_up", "Up", "上", KEY_UP, JOY_BUTTON_DPAD_UP, "Haut"],
	["ui_down", "Down", "下", KEY_DOWN, JOY_BUTTON_DPAD_DOWN, "Bas"],
	["ui_left", "Left", "左", KEY_LEFT, JOY_BUTTON_DPAD_LEFT, "Gauche"],
	["ui_right", "Right", "右", KEY_RIGHT, JOY_BUTTON_DPAD_RIGHT, "Droite"],
	["confirm", "Confirm (click)", "決定（左クリック）", KEY_ENTER, JOY_BUTTON_A, "Valider (clic)"],
	["cancel", "Cancel (right click)", "取消（右クリック）", KEY_ESCAPE, JOY_BUTTON_B, "Annuler (clic droit)"],
	["btn_z", "Z key", "Ｚキー", KEY_Z, JOY_BUTTON_X, "Touche Z"],
	["btn_x", "X key", "Ｘキー", KEY_X, JOY_BUTTON_Y, "Touche X"],
	["btn_return", "Return key", "リターンキー", KEY_ENTER, JOY_BUTTON_START, "Touche Entrée"],
	["btn_space", "Space key", "スペースキー", KEY_SPACE, JOY_BUTTON_BACK, "Barre d'espace"],
	["fast_forward", "Fast forward (hold)", "早送り（押し続け）", KEY_TAB, JOY_BUTTON_RIGHT_SHOULDER, "Avance rapide (maintenir)"],
	["quick_save", "Quick save", "クイックセーブ", KEY_F5, JOY_BUTTON_LEFT_SHOULDER, "Sauvegarde rapide"],
	["quick_load", "Quick load", "クイックロード", KEY_F9, JOY_BUTTON_LEFT_STICK, "Chargement rapide"],
]
## Extra bindings that stay whatever the user binds (the numeric keypad of the X68000, Space as
## a second confirm, the mouse buttons).
const EXTRA_KEYS := {"ui_up": [KEY_KP_8], "ui_down": [KEY_KP_2], "ui_left": [KEY_KP_4],
	"ui_right": [KEY_KP_6], "confirm": [KEY_SPACE]}
const EXTRA_AXES := {"ui_up": [JOY_AXIS_LEFT_Y, -1.0], "ui_down": [JOY_AXIS_LEFT_Y, 1.0],
	"ui_left": [JOY_AXIS_LEFT_X, -1.0], "ui_right": [JOY_AXIS_LEFT_X, 1.0]}
const EXTRA_MOUSE := {"confirm": MOUSE_BUTTON_LEFT, "cancel": MOUSE_BUTTON_RIGHT}

var fullscreen := false
var window_scale := 2
var pixel_perfect := false
var music_volume := 80      # 0-100
var sfx_volume := 80
## Music: "fm" = the X68000's own FM + ADPCM, "mt32" = the game's Roland MT-32 version
## (in the game data only when it was rendered with the player's ROMs, tools/export/mt32.mjs)
var music_device := "fm"
## FM music: true = synthesized live from the chip logs (the chipsynth extension), false = the
## rendered files (also what plays without the extension)
var live_synth := true
var smooth_movement := false
## Saving: false = the original's (save points only), true = also quick saves anywhere (F5 / F9);
## chosen when a new game starts, changeable in the options
var quick_saves := true
var game_speed := 1.0
var battle_speed := 1.0
var fixes := FIXES.duplicate()
var keys := {}              # action -> keycode (physical)
var buttons := {}           # action -> joypad button
var in_battle := false:
	set(v):
		in_battle = v
		_apply_speed()

var _fast := false


func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	for a: Array in ACTIONS:
		keys[a[0]] = a[3]
		buttons[a[0]] = a[4]
	if not _testing():
		load_settings()
		sync_fixes()
	apply()


## The field side of the fixes (the battle model gets them per battle): tests keep the original.
func sync_fixes() -> void:
	SystemsModel.fix_effects = bool(fixes.get("effects", false))


func _process(_delta: float) -> void:
	var f := InputMap.has_action("fast_forward") and Input.is_action_pressed("fast_forward")
	if f != _fast:
		_fast = f
		_apply_speed()


func _unhandled_input(event: InputEvent) -> void:
	if event is InputEventKey and event.pressed and not event.echo and event.keycode == KEY_F11:
		fullscreen = not fullscreen
		apply_display()
		save_settings()
		get_viewport().set_input_as_handled()


## Unattended test runs (-- --*-test=...) use the defaults, whatever the player chose.
func _testing() -> bool:
	for a in OS.get_cmdline_user_args():
		if a.begins_with("--") and a.contains("-test"):
			return true
	return false


func fixes_enabled() -> Dictionary:
	var out := {}
	for k: String in fixes:
		if fixes[k]:
			out[k] = true
	return out


func apply() -> void:
	apply_display()
	apply_audio()
	apply_bindings()
	_apply_speed()


func apply_display() -> void:
	if DisplayServer.get_name() == "headless" or OS.has_feature("web"):
		return
	var win := get_tree().root
	win.content_scale_stretch = (Window.CONTENT_SCALE_STRETCH_INTEGER if pixel_perfect
		else Window.CONTENT_SCALE_STRETCH_FRACTIONAL)
	if fullscreen:
		win.mode = Window.MODE_FULLSCREEN
	else:
		if win.mode == Window.MODE_FULLSCREEN:
			win.mode = Window.MODE_WINDOWED
		var size := Vector2i(768, 512) * window_scale
		var screen := DisplayServer.screen_get_usable_rect(win.current_screen)
		if size.x <= screen.size.x and size.y <= screen.size.y and win.size != size:
			win.size = size
			win.position = screen.position + (screen.size - size) / 2


func apply_audio() -> void:
	Audio.set_volumes(_db(music_volume), _db(sfx_volume))
	Audio.set_device(music_device)
	Audio.set_live_synth(live_synth)


func _db(v: int) -> float:
	return -80.0 if v <= 0 else linear_to_db(v / 100.0)


func _apply_speed() -> void:
	var s := game_speed * (battle_speed if in_battle else 1.0)
	if _fast:
		s *= FAST_FORWARD
	Engine.time_scale = s


## Each rebindable action: the user's key and gamepad button, plus the fixed extras.
func apply_bindings() -> void:
	for a: Array in ACTIONS:
		var name: String = a[0]
		if not InputMap.has_action(name):
			InputMap.add_action(name, 0.5)
		InputMap.action_erase_events(name)
		var k := InputEventKey.new()
		k.physical_keycode = int(keys[name])
		InputMap.action_add_event(name, k)
		for extra: int in EXTRA_KEYS.get(name, []):
			if extra != int(keys[name]):
				var e := InputEventKey.new()
				e.physical_keycode = extra
				InputMap.action_add_event(name, e)
		var j := InputEventJoypadButton.new()
		j.button_index = int(buttons[name])
		InputMap.action_add_event(name, j)
		if EXTRA_AXES.has(name):
			var ax := InputEventJoypadMotion.new()
			ax.axis = EXTRA_AXES[name][0]
			ax.axis_value = EXTRA_AXES[name][1]
			InputMap.action_add_event(name, ax)
		if EXTRA_MOUSE.has(name):
			var m := InputEventMouseButton.new()
			m.button_index = EXTRA_MOUSE[name]
			InputMap.action_add_event(name, m)


func reset_bindings() -> void:
	for a: Array in ACTIONS:
		keys[a[0]] = a[3]
		buttons[a[0]] = a[4]
	apply_bindings()


func key_name(action: String) -> String:
	return OS.get_keycode_string(int(keys.get(action, 0)))


func button_name(action: String) -> String:
	var names := {JOY_BUTTON_A: "A", JOY_BUTTON_B: "B", JOY_BUTTON_X: "X", JOY_BUTTON_Y: "Y",
		JOY_BUTTON_BACK: "Back", JOY_BUTTON_START: "Start", JOY_BUTTON_LEFT_SHOULDER: "LB",
		JOY_BUTTON_RIGHT_SHOULDER: "RB", JOY_BUTTON_DPAD_UP: "D-pad up", JOY_BUTTON_DPAD_DOWN: "D-pad down",
		JOY_BUTTON_DPAD_LEFT: "D-pad left", JOY_BUTTON_DPAD_RIGHT: "D-pad right",
		JOY_BUTTON_LEFT_STICK: "L3", JOY_BUTTON_RIGHT_STICK: "R3", JOY_BUTTON_GUIDE: "Guide"}
	var b := int(buttons.get(action, -1))
	return names.get(b, "Button %d" % b)


func load_settings() -> void:
	var cf := ConfigFile.new()
	if cf.load(PATH) != OK:
		return
	fullscreen = bool(cf.get_value("display", "fullscreen", fullscreen))
	window_scale = clampi(int(cf.get_value("display", "scale", window_scale)), 1, 4)
	pixel_perfect = bool(cf.get_value("display", "pixel_perfect", pixel_perfect))
	music_volume = clampi(int(cf.get_value("audio", "music", music_volume)), 0, 100)
	sfx_volume = clampi(int(cf.get_value("audio", "sfx", sfx_volume)), 0, 100)
	var lang := str(cf.get_value("game", "language", GameText.language))
	if lang in GameText.LANGUAGES:
		GameText.language = lang
	smooth_movement = bool(cf.get_value("game", "smooth_movement", smooth_movement))
	quick_saves = bool(cf.get_value("game", "quick_saves", quick_saves))
	var dev := str(cf.get_value("audio", "device", music_device))
	music_device = dev if dev in ["fm", "msx", "mt32"] else "fm"
	live_synth = bool(cf.get_value("audio", "live_synth", live_synth))
	game_speed = float(cf.get_value("game", "speed", game_speed))
	battle_speed = float(cf.get_value("game", "battle_speed", battle_speed))
	for k: String in FIXES:
		fixes[k] = bool(cf.get_value("fixes", k, fixes[k]))
	for a: Array in ACTIONS:
		keys[a[0]] = int(cf.get_value("keys", a[0], keys[a[0]]))
		buttons[a[0]] = int(cf.get_value("buttons", a[0], buttons[a[0]]))


func save_settings() -> void:
	var cf := ConfigFile.new()
	cf.set_value("display", "fullscreen", fullscreen)
	cf.set_value("display", "scale", window_scale)
	cf.set_value("display", "pixel_perfect", pixel_perfect)
	cf.set_value("audio", "music", music_volume)
	cf.set_value("audio", "sfx", sfx_volume)
	cf.set_value("game", "language", GameText.language)
	cf.set_value("game", "smooth_movement", smooth_movement)
	cf.set_value("game", "quick_saves", quick_saves)
	cf.set_value("audio", "device", music_device)
	cf.set_value("audio", "live_synth", live_synth)
	cf.set_value("game", "speed", game_speed)
	cf.set_value("game", "battle_speed", battle_speed)
	for k: String in fixes:
		cf.set_value("fixes", k, fixes[k])
	for a: Array in ACTIONS:
		cf.set_value("keys", a[0], keys[a[0]])
		cf.set_value("buttons", a[0], buttons[a[0]])
	cf.save(PATH)
	changed.emit()
