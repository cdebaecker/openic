extends Control
## Title menu: MENU68's start menu (docs/cutscenes.md, "MENU68.X"). The original asks for the
## controller and the sound device first; the port has no use for either, so it goes straight to
## the start menu: a framed window on a black screen.
##
## The ending is listed too, so it can be watched before the game itself is ported.

signal finished(next: String, args: Dictionary)

const UiCommands := preload("res://scripts/systems/ui_commands.gd")

# [Japanese, English, action, French]
const ITEMS := [
	["セーブした時点から", "Continue from save", "continue", "Continuer la partie sauvegardée"],
	["オープニングから", "Start with the opening", "opening", "Commencer par l'introduction"],
	["スタート地点から", "Start from the beginning", "new_game", "Commencer au point de départ"],
	["フィールド", "Field (development: after the intro)", "field", "Terrain (développement : après l'intro)"],
	["オプション", "Options", "options", "Options"],
	["言語", "Language", "language", "Langue"],
	["エンディング", "Ending", "ending", "Fin"],
	["マップ", "Map viewer (development)", "map_viewer", "Visionneuse de cartes (développement)"],
]
## Development tools, listed only when running from the editor (not in exported builds)
const DEV_ACTIONS := ["field", "map_viewer"]
## Asked before a new game: the original's saving or quick saves anywhere (Settings.quick_saves)
const MODE_ITEMS := [
	["オリジナル（セーブポイントでのみ）", "Original (save at save points only)", "mode_original",
		"Original (sauvegarde aux points prévus)"],
	["どこでもクイックセーブ（F5／F9）", "Quick saves anywhere (F5 / F9)", "mode_quick",
		"Sauvegarde rapide partout (F5 / F9)"],
	["戻る", "Back", "back", "Retour"],
]
const MODE_HELP := {
	"mode_original": ["1991年のまま：セーブはセーブポイントで", "As in 1991: save at the game's save points",
		"Comme en 1991 : sauvegarde aux points de sauvegarde du jeu"],
	"mode_quick": ["フィールドではいつでもF5でセーブ、F9でロード", "Also F5 saves and F9 loads anywhere in the field",
		"F5 sauvegarde et F9 recharge aussi n'importe où sur le terrain"],
}
const FRAME_COLOR := Color(0.85, 0.65, 0.25)
const ROW_H := 20

var _main: Array = ITEMS.filter(func(it: Array) -> bool: return OS.has_feature("editor") or not it[2] in DEV_ACTIONS)
var _items: Array = _main
var _pending := ""           # "opening" or "new_game": what the save mode question leads to
var _selected := 1
var _rows: Array[Label] = []
var _cursor := ColorRect.new()
var _status := Label.new()
var _panel := Panel.new()


func _ready() -> void:
	set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	var bg := ColorRect.new()
	bg.color = Color.BLACK
	bg.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	add_child(bg)

	var style := StyleBoxFlat.new()
	style.bg_color = Color.BLACK
	style.border_color = FRAME_COLOR
	style.set_border_width_all(3)
	style.set_corner_radius_all(2)
	_panel.add_theme_stylebox_override("panel", style)
	_panel.size = Vector2(380, _main.size() * ROW_H + 28)
	_panel.position = Vector2((768 - _panel.size.x) / 2, 160)
	add_child(_panel)

	_cursor.color = Color(0.25, 0.45, 0.9, 0.45)
	_cursor.size = Vector2(_panel.size.x - 24, ROW_H)
	_cursor.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_panel.add_child(_cursor)
	for i in _main.size():
		var l := Label.new()
		l.position = Vector2(24, 14 + i * ROW_H)
		l.size = Vector2(_panel.size.x - 36, ROW_H)
		l.mouse_filter = Control.MOUSE_FILTER_PASS
		l.mouse_entered.connect(_select.bind(i))
		_panel.add_child(l)
		_rows.append(l)

	_status.position = Vector2(0, 420)
	_status.size = Vector2(768, 24)
	_status.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_status.add_theme_color_override("font_color", Color(0.7, 0.7, 0.7))
	add_child(_status)

	var lang := Label.new()
	lang.position = Vector2(0, 480)
	lang.size = Vector2(760, 20)
	lang.horizontal_alignment = HORIZONTAL_ALIGNMENT_RIGHT
	lang.add_theme_color_override("font_color", Color(0.45, 0.45, 0.45))
	lang.text = "L: English / Français / 日本語"
	add_child(lang)
	_refresh()


func _refresh() -> void:
	for i in _rows.size():
		_rows[i].text = _label(_items[i]) if i < _items.size() else ""
	_cursor.position = Vector2(12, 14 + _selected * ROW_H)
	if _items == MODE_ITEMS:
		var help: Array = MODE_HELP.get(_items[_selected][2], ["", "", ""])
		_status.text = GameText.pick(help[1], help[0], help[2])


func _label(item: Array) -> String:
	var text := GameText.pick(item[1], item[0], item[3])
	if item[2] == "language":   # shows the current language; choosing it switches to the next
		text += GameText.pick(": ", "：", " : ") + GameText.LANGUAGE_NAMES[GameText.language]
	return text


func _next_language() -> void:
	GameText.language = GameText.next_language()
	Settings.save_settings()
	_refresh()


func _select(i: int) -> void:
	if i >= _items.size():
		return
	_selected = i
	_refresh()


func _show_items(items: Array, selected: int) -> void:
	_items = items
	_selected = selected
	_status.text = ""
	_refresh()


func _unhandled_input(event: InputEvent) -> void:
	if event.is_action_pressed("ui_down"):
		_select((_selected + 1) % _items.size())
	elif event.is_action_pressed("ui_up"):
		_select((_selected + _items.size() - 1) % _items.size())
	elif event.is_action_pressed("cancel") and _items == MODE_ITEMS:
		_show_items(_main, 1 if _pending == "opening" else 2)
	elif event is InputEventKey and event.pressed and event.keycode == KEY_L:
		_next_language()
	elif event.is_action_pressed("confirm"):
		if event is InputEventMouseButton and not _panel.get_global_rect().has_point(event.position):
			return
		_choose(_items[_selected][2])
	else:
		return
	get_viewport().set_input_as_handled()


func _choose(action: String) -> void:
	match action:
		"opening", "new_game":
			# both start a new game, as in the original (the opening leads into it): first the
			# saving question
			_pending = action
			_show_items(MODE_ITEMS, 1 if Settings.quick_saves else 0)
		"ending":
			finished.emit("cutscene", {"name": "ending", "next": "title"})
		"options":
			finished.emit("options", {})
		"language":
			_next_language()
		"mode_original", "mode_quick":
			Settings.quick_saves = action == "mode_quick"
			Settings.save_settings()
			if _pending == "opening":
				finished.emit("cutscene", {"name": "opening", "next": "field", "next_args": {"new_game": true}})
			else:
				finished.emit("field", {"new_game": true})
		"back":
			_show_items(_main, 1 if _pending == "opening" else 2)
		"field":
			finished.emit("field", {})
		"map_viewer":
			finished.emit("map_viewer", {"map": "A00", "origin": Vector2i(72, 42)})
		"continue":
			# the newest save (ISV*.DAT in user://saves); SYSTEM > Load in the game chooses any
			var path: String = UiCommands.latest_save()
			if path == "":
				_status.text = "No saved game yet (save with the save points in the game)."
			else:
				finished.emit("field", {"block": path})
