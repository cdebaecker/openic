extends Control
## Options (the port's own screen, reached from the title): display, volume, language, speed, the
## fixes of the original's bugs and the key / gamepad bindings, saved by Settings.
##
## Up/down choose a row, left/right (or a click) change it; on a binding row confirm waits for a
## key or a gamepad button (right click gives up). Cancel goes back to the title.

signal finished(next: String, args: Dictionary)

const SaveImport := preload("res://scripts/systems/save_import.gd")
const FRAME_COLOR := Color(0.85, 0.65, 0.25)
const HEADER_COLOR := Color(0.85, 0.65, 0.25)
const ROW_H := 16          # the game font's line (GameText.font at 16)
const PANEL_W := 720
const VISIBLE := 28        # rows shown; the list scrolls with the cursor
const FIX_NAMES := {
	"damage": ["Fix: damage overflow (strong hits doing 0)", "修正：ダメージの桁あふれ", "Correctif : débordement des dégâts (coups forts à 0)"],
	"status_messages": ["Fix: status recovery messages", "修正：状態回復のメッセージ", "Correctif : messages de guérison des états"],
	"flight": ["Fix: escape check reading the party", "修正：逃走判定の範囲", "Correctif : test de fuite lisant l'équipe"],
	"enemy_ai": ["Fix: enemy action choice (changes balance)", "修正：敵の行動選択（難易度が変わる）", "Correctif : choix d'action ennemi (change l'équilibre)"],
}

var _rows: Array = []        # [{kind, id, label}]
var _labels: Array[Label] = []
var _values: Array[Label] = []
var _selected := 1
var _top := 0                # first row shown
var _capture := ""           # action waiting for a key / button
var _cursor := ColorRect.new()
var _panel := Panel.new()
var _hint := Label.new()
var _status := ""            # the last import's result


func _ready() -> void:
	set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	var bg := ColorRect.new()
	bg.color = Color.BLACK
	bg.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	add_child(bg)
	_build_rows()
	var style := StyleBoxFlat.new()
	style.bg_color = Color.BLACK
	style.border_color = FRAME_COLOR
	style.set_border_width_all(3)
	style.set_corner_radius_all(2)
	_panel.add_theme_stylebox_override("panel", style)
	_panel.size = Vector2(PANEL_W, mini(_rows.size(), VISIBLE) * ROW_H + 20)
	_panel.position = Vector2((768 - PANEL_W) / 2.0, maxf(4.0, (480 - _panel.size.y) / 2.0))
	add_child(_panel)
	_cursor.color = Color(0.25, 0.45, 0.9, 0.45)
	_cursor.size = Vector2(PANEL_W - 20, ROW_H)
	_cursor.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_panel.add_child(_cursor)
	for i in mini(_rows.size(), VISIBLE):
		var l := _label(Vector2(22, 10 + i * ROW_H), PANEL_W - 250)
		l.mouse_filter = Control.MOUSE_FILTER_PASS
		l.mouse_entered.connect(_hover.bind(i))
		var v := _label(Vector2(PANEL_W - 230, 10 + i * ROW_H), 210)
		v.mouse_filter = Control.MOUSE_FILTER_PASS
		v.mouse_entered.connect(_hover.bind(i))
		_labels.append(l)
		_values.append(v)
	_hint.position = Vector2(0, 490)
	_hint.size = Vector2(768, 18)
	_hint.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_hint.add_theme_color_override("font_color", Color(0.6, 0.6, 0.6))
	add_child(_hint)
	get_window().files_dropped.connect(_on_files_dropped)
	_refresh()


func _label(pos: Vector2, w: float) -> Label:
	var l := Label.new()
	l.position = pos
	l.size = Vector2(w, ROW_H)
	l.clip_text = true
	_panel.add_child(l)
	return l


func _build_rows() -> void:
	_rows = [
		{"kind": "header", "id": "", "label": ["Display", "画面", "Affichage"]},
		{"kind": "opt", "id": "fullscreen", "label": ["Fullscreen (F11)", "フルスクリーン（F11）", "Plein écran (F11)"]},
		{"kind": "opt", "id": "scale", "label": ["Window size", "ウインドウの大きさ", "Taille de la fenêtre"]},
		{"kind": "opt", "id": "pixel", "label": ["Pixel-perfect scaling", "整数倍で拡大", "Agrandissement au pixel près"]},
		{"kind": "header", "id": "", "label": ["Sound", "音", "Son"]},
		{"kind": "opt", "id": "music", "label": ["Music volume", "音楽の音量", "Volume de la musique"]},
		{"kind": "opt", "id": "device", "label": ["Music played on", "音源", "Musique jouée sur"]},
		{"kind": "opt", "id": "synth", "label": ["FM music", "FM音源の演奏", "Musique FM"]},
		{"kind": "opt", "id": "sfx", "label": ["Sound effects volume", "効果音の音量", "Volume des effets sonores"]},
		{"kind": "header", "id": "", "label": ["Game", "ゲーム", "Jeu"]},
		{"kind": "opt", "id": "language", "label": ["Language", "言語", "Langue"]},
		{"kind": "opt", "id": "smooth", "label": ["Smooth movement (not in the original)", "なめらかな移動（オリジナルにはない）", "Déplacement fluide (absent de l'original)"]},
		{"kind": "opt", "id": "quick_saves", "label": ["Quick saves anywhere, F5 / F9 (not in the original)", "どこでもクイックセーブ（オリジナルにはない）", "Sauvegarde rapide partout, F5 / F9 (absente de l'original)"]},
		{"kind": "opt", "id": "speed", "label": ["Game speed", "ゲームの速さ", "Vitesse du jeu"]},
		{"kind": "opt", "id": "battle_speed", "label": ["Battle speed", "戦闘の速さ", "Vitesse des combats"]},
	]
	for k: String in Settings.FIXES:
		_rows.append({"kind": "fix", "id": k, "label": FIX_NAMES.get(k, [k, k])})
	_rows.append({"kind": "header", "id": "", "label": ["Controls (key / gamepad)", "操作（キー／パッド）", "Commandes (touche / manette)"]})
	for a: Array in Settings.ACTIONS:
		_rows.append({"kind": "bind", "id": a[0], "label": [a[1], a[2], a[5] if a.size() > 5 else ""]})
	_rows.append({"kind": "button", "id": "import",
		"label": ["Import saves from a disk image… (or drop it here)", "ディスクイメージからセーブを読み込む…", "Importer des sauvegardes d'une image disque… (ou la déposer ici)"]})
	_rows.append({"kind": "button", "id": "reset", "label": ["Reset controls", "操作を初期設定に戻す", "Réinitialiser les commandes"]})
	_rows.append({"kind": "button", "id": "back", "label": ["Back", "戻る", "Retour"]})


func _t(en: String, ja: String, fr: String) -> String:
	return GameText.pick(en, ja, fr)


func _on_off(v: bool) -> String:
	if GameText.language != "ja":
		return ("On" if v else "Off") if GameText.language == "en" else ("Oui" if v else "Non")
	return "オン" if v else "オフ"


func _value(row: Dictionary) -> String:
	match row["kind"]:
		"fix":
			return _on_off(bool(Settings.fixes[row["id"]]))
		"bind":
			if _capture == row["id"]:
				return _t("Press a key or button…", "キーかボタンを押して…", "Appuyez sur une touche ou un bouton…")
			return "%s / %s" % [Settings.key_name(row["id"]), Settings.button_name(row["id"])]
		"opt":
			return _opt_value(str(row["id"]))
	return ""


func _opt_value(id: String) -> String:
	match id:
		"fullscreen":
			return _on_off(Settings.fullscreen)
		"scale":
			return "%d × (%d × %d)" % [Settings.window_scale, 768 * Settings.window_scale,
				512 * Settings.window_scale]
		"pixel":
			return _on_off(Settings.pixel_perfect)
		"music":
			return "%d %%" % Settings.music_volume
		"device":
			if Settings.music_device == "mt32" and Audio.has_mt32():
				return "Roland MT-32"
			if not Audio.has_mt32():
				return _t("FM (no MT-32 data)", "FM音源（MT-32なし）", "FM (pas de données MT-32)")
			return _t("FM (X68000)", "FM音源（X68000）", "FM (X68000)")
		"synth":
			if not Audio.can_synthesize():
				return _t("Recorded (no synthesizer)", "録音（シンセなし）", "Enregistrée (pas de synthétiseur)")
			if Settings.live_synth:
				return _t("Live (ymfm)", "リアルタイム（ymfm）", "En direct (ymfm)")
			return _t("Recorded", "録音", "Enregistrée")
		"sfx":
			return "%d %%" % Settings.sfx_volume
		"language":
			return GameText.LANGUAGE_NAMES[GameText.language]
		"smooth":
			return _on_off(Settings.smooth_movement)
		"quick_saves":
			return _on_off(Settings.quick_saves)
		"speed":
			return "× %s" % str(Settings.game_speed)
		"battle_speed":
			return "× %s" % str(Settings.battle_speed)
	return ""


func _refresh() -> void:
	_top = clampi(_top, maxi(0, _selected - _labels.size() + 1), _selected)
	if _selected <= 1:
		_top = 0   # the first header stays in view
	for i in _labels.size():
		var r := _top + i
		var header: bool = r < _rows.size() and _rows[r]["kind"] == "header"
		_labels[i].text = GameText.pick_list(_rows[r]["label"]) if r < _rows.size() else ""
		_values[i].text = _value(_rows[r]) if r < _rows.size() else ""
		_labels[i].position.x = 12 if header else 22
		if header:
			_labels[i].add_theme_color_override("font_color", HEADER_COLOR)
		else:
			_labels[i].remove_theme_color_override("font_color")
	_cursor.position = Vector2(10, 10 + (_selected - _top) * ROW_H)
	if _status != "":
		_hint.text = _status
	elif _capture != "":
		_hint.text = _t("Press the new key or gamepad button (right click: keep the old one)",
			"新しいキーかボタンを押してください（右クリック：変更しない）",
			"Appuyez sur la nouvelle touche ou le bouton (clic droit : garder l'ancien)")
	else:
		_hint.text = _t("Up/Down: choose   Left/Right or click: change   Cancel: back to the title",
			"上下：選択　左右・クリック：変更　取消：タイトルへ",
			"Haut/Bas : choisir   Gauche/Droite ou clic : changer   Annuler : retour au titre")


func _hover(i: int) -> void:
	i += _top
	if _capture == "" and i < _rows.size() and _rows[i]["kind"] != "header":
		_selected = i
		_refresh()


## Saves of the original: ISV0-7.DAT from a floppy image of the game disk or a user disk.
func _pick_disk() -> void:
	var dlg := FileDialog.new()
	dlg.file_mode = FileDialog.FILE_MODE_OPEN_FILE
	dlg.access = FileDialog.ACCESS_FILESYSTEM
	dlg.use_native_dialog = true
	dlg.filters = PackedStringArray(["*.xdf, *.hdm, *.dim, *.d88, *.dat ; X68000 disk images, ISVn.DAT"])
	dlg.title = "Import saves"
	dlg.file_selected.connect(_import)
	dlg.canceled.connect(dlg.queue_free)
	dlg.file_selected.connect(func(_p: String) -> void: dlg.queue_free())
	add_child(dlg)
	dlg.popup_centered_ratio(0.6)


func _on_files_dropped(paths: PackedStringArray) -> void:
	for p in paths:
		_import(p)


func _import(path: String) -> void:
	var r: Dictionary = SaveImport.import_file(path)
	_status = str(r["message"])
	_refresh()


func _move(d: int) -> void:
	var i := _selected
	for n in _rows.size():
		i = (i + d + _rows.size()) % _rows.size()
		if _rows[i]["kind"] != "header":
			break
	_selected = i
	_refresh()


func _input(event: InputEvent) -> void:
	if _capture == "":
		return
	get_viewport().set_input_as_handled()
	if event is InputEventMouseButton and event.pressed and event.button_index == MOUSE_BUTTON_RIGHT:
		_capture = ""
	elif event is InputEventKey and event.pressed and not event.echo:
		var code: int = event.physical_keycode if event.physical_keycode else event.keycode
		Settings.keys[_capture] = code
		_capture = ""
	elif event is InputEventJoypadButton and event.pressed:
		Settings.buttons[_capture] = event.button_index
		_capture = ""
	else:
		return
	Settings.apply_bindings()
	Settings.save_settings()
	_refresh()


func _unhandled_input(event: InputEvent) -> void:
	if event.is_pressed() and not event.is_echo():
		_status = ""
	if event.is_action_pressed("ui_down") or (event is InputEventMouseButton and event.pressed
			and event.button_index == MOUSE_BUTTON_WHEEL_DOWN):
		_move(1)
	elif event.is_action_pressed("ui_up") or (event is InputEventMouseButton and event.pressed
			and event.button_index == MOUSE_BUTTON_WHEEL_UP):
		_move(-1)
	elif event.is_action_pressed("ui_right"):
		_change(1)
	elif event.is_action_pressed("ui_left"):
		_change(-1)
	elif event.is_action_pressed("cancel"):
		finished.emit("title", {})
	elif event.is_action_pressed("confirm"):
		if event is InputEventMouseButton and not _panel.get_global_rect().has_point(event.position):
			return
		_activate()
	else:
		return
	get_viewport().set_input_as_handled()


func _activate() -> void:
	var row: Dictionary = _rows[_selected]
	match row["kind"]:
		"bind":
			_capture = row["id"]
			_refresh()
		"button":
			if row["id"] == "back":
				finished.emit("title", {})
			elif row["id"] == "import":
				_pick_disk()
			else:
				Settings.reset_bindings()
				Settings.save_settings()
				_refresh()
		_:
			_change(1)


func _cycle(list: Array, v: Variant, d: int) -> Variant:
	var i := list.find(v)
	return list[(maxi(i, 0) + d + list.size()) % list.size()]


func _change(d: int) -> void:
	var row: Dictionary = _rows[_selected]
	if row["kind"] == "fix":
		Settings.fixes[row["id"]] = not bool(Settings.fixes[row["id"]])
	elif row["kind"] == "opt":
		_change_opt(str(row["id"]), d)
	else:
		return
	Settings.apply()
	Settings.save_settings()
	_refresh()


func _change_opt(id: String, d: int) -> void:
	match id:
		"fullscreen":
			Settings.fullscreen = not Settings.fullscreen
		"scale":
			Settings.window_scale = int(_cycle(Settings.SCALES, Settings.window_scale, d))
		"pixel":
			Settings.pixel_perfect = not Settings.pixel_perfect
		"music":
			Settings.music_volume = clampi(Settings.music_volume + 10 * d, 0, 100)
		"device":
			if Audio.has_mt32():
				Settings.music_device = "fm" if Settings.music_device == "mt32" else "mt32"
		"synth":
			if Audio.can_synthesize():
				Settings.live_synth = not Settings.live_synth
		"sfx":
			Settings.sfx_volume = clampi(Settings.sfx_volume + 10 * d, 0, 100)
			Audio.play_sfx("se_01")
		"language":
			GameText.language = GameText.next_language()
		"smooth":
			Settings.smooth_movement = not Settings.smooth_movement
		"quick_saves":
			Settings.quick_saves = not Settings.quick_saves
		"speed":
			Settings.game_speed = float(_cycle(Settings.SPEEDS, Settings.game_speed, d))
		"battle_speed":
			Settings.battle_speed = float(_cycle(Settings.SPEEDS, Settings.battle_speed, d))
