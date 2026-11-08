extends Control
## The field: the party walking on a map, ticked as ICITY68's field loop (docs/field.md), with the
## event scripts, cutscenes and dialogue (docs/events.md, docs/cutscenes-field.md) and drawn as
## the original's screen. Keyboard (cursor keys / numpad, Z X Return Space), gamepad and mouse
## (hold the left button on the map or the cross pad; right button = auto-walk), as in the original.
##
## setup({"new_game": true}) starts a new game (IC_MAIN's entry $10: the intro). The development
## start setup({"map", "party", "view"}) puts the party on a map without running its scripts.

signal finished(next: String, args: Dictionary)
signal clicked

const FieldMap := preload("res://scripts/field/field_map.gd")
const FieldLogic := preload("res://scripts/field/field_logic.gd")
const FieldView := preload("res://scripts/field/field_view.gd")
const GameState := preload("res://scripts/events/game_state.gd")
const FieldEvents := preload("res://scripts/events/field_events.gd")
const Actors := preload("res://scripts/events/actors.gd")
const DialogueLayer := preload("res://scripts/events/dialogue_layer.gd")
const NameFont := preload("res://scripts/field/name_font.gd")
const IndexedShader := preload("res://shaders/indexed.gdshader")
const UiCommands := preload("res://scripts/systems/ui_commands.gd")
const BattleScreen := preload("res://scripts/battle/battle_screen.gd")
const SYSTEMS_MODEL := "res://scripts/systems/systems_model.gd"
const StoryRoute := preload("res://scripts/dev/story_route.gd")

const FRAME_RATE := 55.458
const TICK_FRAMES := 7          # the original's tick is CPU-bound: 6-13 frames while walking
const FADE := 0.25
const BLINK := [5, 5, 5, 1, 0, 0, 0, 1]   # ▼ colour per 8 frames (f_71fca)
# Development start: the party at the first free control of a new game, A00.
const START := {
	"map": "A00",
	"view": Vector2i(72, 42),
	"party": [
		{"x": 82, "y": 54, "facing": 2, "step": 3},
		{"x": 81, "y": 51, "facing": 2, "step": 1, "h": 2},
		{"x": 83, "y": 51, "facing": 2, "step": 1, "h": 2},
	],
}
# Arrival placement after a warp (f_7a100): leader beside the destination trigger by facing,
# members in a line behind.
const BEHIND := [Vector2i(0, 1), Vector2i(-1, 0), Vector2i(0, -1), Vector2i(1, 0)]
# the name tiles' colours (ASDF.CHR with the field palette)
const NAME_COLOUR := Color8(117, 182, 247)
const NAME_SHADE := Color8(53, 117, 182)
const NAME_BG := Color8(4, 4, 4)
const INPUT_ACTIONS := ["ui_up", "ui_down", "ui_left", "ui_right", "btn_z", "btn_x", "btn_return", "btn_space"]

var map = null
var field = null
var layer := DialogueLayer.new()
var state := GameState.new()
var events: FieldEvents
var ui_boxes: Array = []        # interface highlight boxes (scripts/systems/ui_toolkit.gd)
var commands: UiCommands = null
var sweep := false               # development: --sweep-map (auto clicks / answers, no battles)
var auto := false                # development: --story-route (auto clicks / answers / battle commands)
var route_answers: Array = []    # development: --story-route's queued VM menu answers
var route_input := -1            # development: --story-route's input word while it walks the leader
var _auto_menu := ""             # development: the last unqueued auto-answered menu, and its answer
var _auto_pick := 0
var ended := false               # builtin 5(99): the game has ended (the ending replaces the field)
var _view = FieldView.new()
var _rect := TextureRect.new()
var _material := ShaderMaterial.new()
var _highlight := ColorRect.new()
var _clock := 0.0
var _busy := false
var _music_by_source := {}
var _music_tables := {}
var _start := START
var _new_game := false
var _with_events := true
var _timers := {}
var _waiting := false
var _names := Control.new()     # English party names over the panel's name tiles
var _notice := Label.new()      # "Quick saved" and the like, fading out
var _name_list: Array = []
var _name_textures := {}       # name -> texture in the tiles' style (NameFont)
var _smooth := {}               # smooth movement: {view, sprites} before the last tick
var _panel := {"party": [], "mouse": true, "vr": true}
var _lamp := -1
var _left_was := false
var _block_file := ""
var _reload_pending := false
var _music_index := -1
var _battle = null              # the battle shown, or null


func setup(args: Dictionary) -> void:
	_new_game = args.get("new_game", false)
	_block_file = args.get("block", "")
	if args.has("map"):
		_start = args
		_with_events = args.get("events", false)


var _leak_check := OS.get_cmdline_user_args().has("--text-leak-check")   # development
var _drawn_boxes: Array = []   # development: the window frames of the last render, in screen pixels
var _leak_frame := 0


## Development (-- --text-leak-check): print every frame where text is on screen outside the frames
## of the windows drawn (field windows only: battles and the interface windows are not checked).
func _check_leaks() -> void:
	_leak_frame += 1
	if _battle != null or not ui_boxes.is_empty() or map == null:
		return
	var out := []
	for pos: Vector2i in layer._glyphs:
		if layer._glyphs[pos][1] == 0:
			continue
		var inside := false
		for r: Rect2i in _drawn_boxes:
			if r.has_point(pos):
				inside = true
		if not inside:
			out.append([pos, layer._glyphs[pos][0]])
	if not out.is_empty():
		out.sort()
		var txt := ""
		for o in out.slice(0, 40):
			txt += o[1]
		print("TEXTLEAK f%d map %s busy %s windows %s boxes %s n %d first %s text '%s'" % [_leak_frame, map.id, _busy,
			str(events.windows.map(func(w): return [w["k"], w["x"], w["y"], w["w"], w["h"]])), str(_drawn_boxes), out.size(), str(out[0][0]), txt])


func _ready() -> void:
	if _leak_check:
		get_tree().process_frame.connect(_check_leaks)
	set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	var bg := ColorRect.new()
	bg.color = Color.BLACK
	bg.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	add_child(bg)
	_material.shader = IndexedShader
	_rect.material = _material
	_rect.texture = _view.screen.texture
	_rect.size = Vector2(768, 512)
	_rect.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(_rect)
	_names.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_names.size = Vector2(768, 512)
	_names.draw.connect(_draw_names)
	add_child(_names)
	add_child(layer)
	_highlight.color = Color(0.3, 0.5, 1.0, 0.35)
	_highlight.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_highlight.visible = false
	add_child(_highlight)
	_notice.position = Vector2(0, 12)
	_notice.size = Vector2(768, 24)
	_notice.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_notice.add_theme_constant_override("outline_size", 6)
	_notice.add_theme_color_override("font_outline_color", Color.BLACK)
	_notice.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_notice.modulate.a = 0.0
	add_child(_notice)
	if GameData.exists("audio/index.json"):
		for item in GameData.json("audio/index.json").get("items", []):
			_music_by_source[str(item.get("source", ""))] = item["name"]
	for t in GameData.json("data/ICITY.FIL.json").get("tables", []):
		if int(t["type"]) == 7:
			for e in t["entries"]:
				_music_tables[int(e["index"])] = str(e["file"])
	events = FieldEvents.new(self, state)
	if ResourceLoader.exists(SYSTEMS_MODEL):
		commands = UiCommands.new(self, load(SYSTEMS_MODEL))
		if not commands.available():
			commands = null
	if _new_game:
		# f_7a50e: IC_MAIN's new-game entry, then the field loop loads A00 in new-game mode (no party
		# yet: A00's scripts build it and play the intro).
		var route := _route_arg()
		if route != "":
			auto = true   # development: the intro's clicks and menus are answered too
			Engine.time_scale = 8.0
		_busy = true
		state.block = FileAccess.get_file_as_bytes(GameData.path("events/newgame.block"))
		state.block.resize(GameState.BLOCK_SIZE)
		await events.run_entry(0x10, -1, events.main_prog)
		map = FieldMap.load_map("A00")
		var party := []
		for i in clampi(state.party_count(), 1, 3):
			var o := GameState.OFF_PARTY_POS + 20 * i
			party.append({"x": state.le16(o), "y": state.le16(o + 2), "facing": 0, "h": 1 if i == 0 else 2})
		field = FieldLogic.new(map, party, Vector2i.ZERO)
		_enter_map(0)   # arrival facing $9EEE9 = 0 at a new game
		await events.on_map_loaded()
		await _after_script()
		_busy = false
		# Development: where the new game hands over control (compare with the original: party
		# (82,54) (81,51) (83,51), view (72,42), story progress var 4 = 110).
		var pos := []
		for i in field.n:
			pos.append(Vector2i(field.act[i].x, field.act[i].y))
		print("New game: free control on %s, party %s, view %s, var4 %d" % [map.id, str(pos), str(field.view),
			state.get_var16(4)])
		if route != "":
			await _run_route(route)
		return
	if _block_file != "":
		await _start_from_block(FileAccess.get_file_as_bytes(_block_file))
		for arg in OS.get_cmdline_user_args():
			if arg.begins_with("--story-route="):
				await _run_route(arg.trim_prefix("--story-route="))
				return
			if arg.begins_with("--sweep-map="):
				await _sweep_map(arg.trim_prefix("--sweep-map="))
				get_tree().quit()
				return
			if arg.begins_with("--battle="):
				# Development: a battle right after the start: --battle=MODE,ACTOR (0 = contact with actor)
				var mb := arg.trim_prefix("--battle=").split(",")
				_busy = true
				await battle(mb[0].to_int(), mb[1].to_int())
				await _after_script()
				_busy = false
			if arg.begins_with("--service=") and commands != null:
				# Development: builtin 35's service n (1 inn, 2-4 shops) right after the start
				_busy = true
				await commands.service(arg.trim_prefix("--service=").to_int())
				_busy = false
		return
	# development start
	state.set_be16(GameState.OFF_PARTY_COUNT, 3)
	for i in 3:
		state.set_be16(GameState.OFF_PARTY + 2 * i, i)
	map = FieldMap.load_map(_start["map"])
	field = FieldLogic.new(map, _start["party"], _start["view"])
	_enter_map(int(_start["party"][0].get("facing", 2)))
	if _with_events:
		_busy = true
		await events.on_map_loaded()
		_busy = false


func _enter_map(facing: int) -> void:
	var pal := PackedColorArray()
	for w in map.palette_words:
		pal.append(_x68k_color(w))
	_material.set_shader_parameter("palette", pal)
	var music: Variant = map.info.get("music")
	if music != null and _music_by_source.has(music["file"]):
		Audio.play_music(_music_by_source[music["file"]])
	var party := []
	var ids := state.party_ids()
	for i in field.n:
		party.append({"x": field.act[i].x, "y": field.act[i].y, "set": ids[i] if i < ids.size() else i})
	events.load_map(map, field, party, facing)
	_timers.clear()
	events.sync_party_sprites(_view.party_sets)
	render()


## Smooth movement (option, Settings.smooth_movement): the view and the sprites drawn between
## their positions before and after the last tick, the original's one-tile steps interpolated.
func _smooth_snapshot() -> void:
	_smooth = {}
	if not Settings.smooth_movement:
		return
	var sp := {}
	for i in events.sprites.size():
		sp[i] = Vector2i(int(events.sprites[i]["x"]), int(events.sprites[i]["y"]))
	_smooth = {"view": field.view, "sprites": sp}


func _smooth_frame() -> void:
	if _smooth.is_empty():
		return
	var tick: int = maxi(TICK_FRAMES, state.be16(0x39a) if state.block.size() > 0x39b else 0)
	_smooth_set(clampf(_clock / tick, 0.0, 1.0))
	render()


func _smooth_set(f: float) -> void:
	_view.screen.shift = Vector2i.ZERO
	_view.sprite_offsets = {}
	if _smooth.is_empty() or _busy or f >= 1.0:
		return
	var dv: Vector2i = field.view - (_smooth["view"] as Vector2i)
	if absi(dv.x) <= 2 and absi(dv.y) <= 2:
		_view.screen.shift = Vector2i((Vector2(dv * 16) * (1.0 - f)).round())
	for i: int in _smooth["sprites"]:
		if i >= events.sprites.size():
			continue
		var cur := Vector2i(int(events.sprites[i]["x"]), int(events.sprites[i]["y"]))
		var d: Vector2i = cur - (_smooth["sprites"][i] as Vector2i)
		if d != Vector2i.ZERO and absi(d.x) <= 2 and absi(d.y) <= 2:
			_view.sprite_offsets[i] = -Vector2i((Vector2(d * 16) * (1.0 - f)).round())


func render() -> void:
	if _busy and not _smooth.is_empty():
		_smooth = {}
		_smooth_set(1.0)
	if _battle != null:
		_battle.render()
		_update_names()
		return
	if map == null:
		return
	if not _busy:
		_panel = _panel_values()   # redrawn when control is back with the player, not during scripts
	_panel["lamp"] = _lamp
	_update_names()
	_view.render(map, field, events.sprites, events.windows, FieldEvents.frame_tiles, _panel, ui_boxes)
	if _leak_check:
		_drawn_boxes = []
		for w in events.windows:
			var r := Rect2i()
			for t: Vector3i in FieldEvents.frame_tiles(w):
				var c := Rect2i(64 + 16 * t.x, 48 + 16 * t.y, 16, 16)
				r = c if r.size == Vector2i.ZERO else r.merge(c)
			_drawn_boxes.append(r)


## English mode: the party panel's names are tiles of ASDF.CHR (kanji / katakana, f_74918), so
## the English names are drawn over them (the name box of each shown slot).
func _update_names() -> void:
	var names: Array = []
	if GameText.translated() and commands != null and commands.screens != null:
		var party: Array = _panel.get("party", [])
		for slot in party.size():
			var id := int(party[slot]["id"])
			if id >= 0 and id <= 7:
				var en := GameText.decode(GameText.interface_bytes(commands.screens.char_name(id)))
				names.append([slot, en.strip_edges().replace("　", "")])
	if names != _name_list:
		_name_list = names
		_names.queue_redraw()


func _draw_names() -> void:
	var font: Font = GameText.font
	for n: Array in _name_list:
		var box := Rect2(80, 64 + 96 * int(n[0]), 80, 16)
		if NameFont.covers(n[1]):
			if not _name_textures.has(n[1]):
				_name_textures[n[1]] = ImageTexture.create_from_image(NameFont.render(n[1], true))
			_names.draw_texture(_name_textures[n[1]], box.position)
			continue
		_names.draw_rect(box, NAME_BG)
		var w := font.get_string_size(n[1], HORIZONTAL_ALIGNMENT_LEFT, -1, 16).x
		var pos := Vector2(box.position.x + floorf((box.size.x - w) / 2.0), box.position.y + font.get_ascent(16))
		_names.draw_string(font, pos + Vector2(1, 1), n[1], HORIZONTAL_ALIGNMENT_LEFT, -1, 16, NAME_SHADE)
		_names.draw_string(font, pos, n[1], HORIZONTAL_ALIGNMENT_LEFT, -1, 16, NAME_COLOUR)


## Party panel values (f_6dfa0, docs/systems-ui.md section 2): for each slot whose sprite is shown,
## LV byte +3, HP word +14, MP word +10 of the character record.
func _panel_values() -> Dictionary:
	var party := []
	var ids := state.party_ids()
	for slot in mini(ids.size(), 3):
		if not (int(events.sprites[slot]["visible"]) & 0x80) or ids[slot] > 7:
			# f_6dfa0 draws only shown members with a character record (ids 0-7; guests such as
			# Holland, id 52, are skipped)
			party.append({"id": 255})
			continue
		var o: int = GameState.OFF_CHARS + GameState.CHAR_SIZE * ids[slot]
		party.append({"id": ids[slot], "lv": state.block[o + 3], "hp": state.le16(o + 14), "mp": state.le16(o + 10)})
	return {"party": party, "mouse": state.be16(GameState.OFF_MOUSE_MODE) != 0, "vr": state.be16(0x3a4) != 0}


## Event picture n (f_798e8): GEP image with its EVTGRH.PLD palette, the field hidden.
func show_picture(n: int) -> void:
	var info: Dictionary = {}
	for p in GameData.json("gep/index.json").get("pictures", []):
		if int(p["n"]) == n:
			info = p
	if info.is_empty():
		return
	var img := Image.new()
	if img.load_png_from_buffer(FileAccess.get_file_as_bytes(GameData.path("gep/" + str(info["idx"])))) != OK:
		return
	img.convert(Image.FORMAT_R8)
	_view.picture = img
	var pal := PackedColorArray()
	for w in info["palette"]:
		pal.append(_x68k_color(str(w).hex_to_int()))
	_material.set_shader_parameter("palette", pal)
	render()


func hide_picture() -> void:
	_view.picture = null
	var pal := PackedColorArray()
	for w in map.palette_words:
		pal.append(_x68k_color(w))
	_material.set_shader_parameter("palette", pal)
	render()


func _process(delta: float) -> void:
	if _busy or map == null:
		return
	_clock += delta * FRAME_RATE
	_smooth_frame()
	# the page flip waits at least $9CB2E (movement speed, block +$39A) vsyncs; the original's
	# tick is CPU-bound above that (TICK_FRAMES)
	var tick: int = maxi(TICK_FRAMES, state.be16(0x39a) if state.block.size() > 0x39b else 0)
	if _clock < tick:
		return
	_clock = fmod(_clock, tick)
	var m: Dictionary = _mouse()
	var left := (int(m["buttons"]) & 1) != 0
	var pressed := left and not _left_was
	_left_was = left
	var button := panel_button(int(m["x"]), int(m["y"]))
	if commands != null and button >= 0:
		if pressed and button < 6:
			await _run_command(button)
		return
	_smooth_snapshot()
	var evs: Array = field.tick(_input_bits(), m)
	state.rt["last_trigger"] = field.last_trigger   # one variable in the original ($9EEEA)
	events.run_map_animation()
	map.tick_tiles()
	var contact := -1
	for i in range(3, events.n_actors):
		var s: Dictionary = events.sprites[i]
		if (int(s["visible"]) & 0x80) and s["set"] != null and (field.act[i].flags & 0x80):
			if Actors.behave(field, s, i, _timers, events._rand.mod) and contact < 0 and _with_events_active():
				contact = i
	events.sync_party_sprites(_view.party_sets)
	_smooth_set(0.0)
	render()
	if contact >= 0:
		# a type-4 actor walked into the party (f_76980: $9EF20 = 3)
		_busy = true
		await battle(0, contact)
		await _after_script()
		_busy = false
		return
	for ev in evs:
		if ev["kind"] == "button" and commands != null and _with_events_active():
			_busy = true
			await commands.command_menu()
			await _after_script()
			_busy = false
			_left_was = true
			return
		if ev["kind"] == "trigger":
			await _on_trigger(ev)
			return
		if ev["kind"] == "actor" and int(ev["state"]) == 3 and _with_events_active():
			# contact with an enemy actor (type 4): f_6abca(0)
			_busy = true
			await battle(0, int(ev["actor"]))
			await _after_script()
			_busy = false
			return
		if ev["kind"] == "actor" and int(ev["state"]) == 2 and _with_events_active():
			_busy = true
			await events.chest(int(ev["actor"]))
			_busy = false
			return
		if ev["kind"] == "talk" and _with_events_active():
			_busy = true
			await events.on_talk(int(ev["actor"]))
			await _after_script()
			_busy = false
			return


## Start from a saved game block (954 bytes, the save file's content): its map, the party's actor
## records (x, y, facing +4), the view; the map's load (+2) and always (+4) scripts.
func _start_from_block(bytes: PackedByteArray) -> void:
	_busy = true
	_with_events = true
	state.block = bytes.slice(0, GameState.BLOCK_SIZE)
	state.block.resize(GameState.BLOCK_SIZE)
	if commands != null:
		# as a load from disk (f_6703e): checkpoint, map id byte 0 = '|', load mode 2
		commands.sys.load_file(state, state.block.duplicate(), {})
	else:
		state.rt["next_map"] = state.map_id()
	await _reload_from_state()
	_busy = false


## After a load (save menu, Quick, Continue): the field loop loads the map named by the run-time
## next map in mode 2 (docs/events.md section 5): the party from the actor records at block +$35E,
## the map's load (+2) and always (+4) entries.
func _reload_from_state() -> void:
	_reload_pending = false
	var id: String = state.rt.get("next_map", "")
	if id == "" or FieldMap.map_ids().find(id) < 0:
		id = "A00"
	for i in 3:
		state.block[GameState.OFF_MAP_ID + i] = id.unicode_at(i)
	if map != null:
		await fade(true)
	layer.clear()
	events.close_windows()
	if events.picture_mode:
		events.close_picture()
	map = FieldMap.load_map(id)
	var party := []
	for i in clampi(state.party_count(), 1, 3):
		var o := GameState.OFF_PARTY_POS + 20 * i
		var h: int = state.block[o + 14]
		party.append({"x": GameState._s16(state.le16(o)), "y": GameState._s16(state.le16(o + 2)),
			"facing": state.block[o + 4] & 3, "h": h if h > 0 else (1 if i == 0 else 2)})
	var view := Vector2i(state.be16(GameState.OFF_VIEW), state.be16(GameState.OFF_VIEW + 2))   # BE words
	field = FieldLogic.new(map, party, view)
	state.rt["last_trigger"] = -1
	state.rt["pending_trigger"] = -1
	_enter_map(int(party[0]["facing"]))
	await fade(false)
	await events.on_map_loaded(true)
	await _after_script()


## A battle (battle_screen.gd): mode 0 contact with actor, 1 builtin 5 ordinary (group), 2 event.
func battle(mode: int, actor: int) -> String:
	return await BattleScreen.new(self).run(mode, actor)


## builtin 5(99): the end of the game (f_7c626: fade out, disk 7, longjmp($A065E) out of
## f_66282): ICITY68 exits and LOAD.X runs IL_END.X, the ending; then back to the title.
func game_end() -> void:
	_busy = true
	ended = true
	await fade(true)
	Audio.stop_music(0.5)
	finished.emit("cutscene", {"name": "ending", "next": "title"})


## Back to the title (a defeat without a checkpoint to restore).
func leave_to_title() -> void:
	Audio.stop_music(0.5)
	finished.emit("title", {})


## The battle screen replaces the field (its texture and palette).
func enter_battle(b) -> void:
	_battle = b
	Settings.in_battle = true
	_rect.texture = b.view.texture
	var pal := PackedColorArray()
	for w in b.palette_words():
		pal.append(_x68k_color(int(w)))
	_material.set_shader_parameter("palette", pal)
	render()


## Contact battles (f_78546): every text palette entry set to one X68000 colour word, or the map's
## palette back (word < 0).
func flash_palette(word: int) -> void:
	var pal := PackedColorArray()
	for w in map.palette_words:
		pal.append(_x68k_color(word if word >= 0 else w))
	_material.set_shader_parameter("palette", pal)


func leave_battle() -> void:
	_battle = null
	Settings.in_battle = false
	_rect.texture = _view.screen.texture
	var pal := PackedColorArray()
	for w in map.palette_words:
		pal.append(_x68k_color(w))
	_material.set_shader_parameter("palette", pal)
	render()


## Music by its source file (e.g. GROUP00/000046.DAT).
func play_music_file(file: String) -> void:
	if _music_by_source.has(file):
		Audio.play_music(_music_by_source[file])


## A game was loaded by the save menu: reload when the command / script has ended.
func request_reload() -> void:
	_reload_pending = true


## Quick save / load (the port's own, F5 / F9; Settings.quick_saves): the save file of SYSTEM > Save in
## UiCommands.QUICK_FILE, written and read as a slot is; only while the player has control.
func _can_quick() -> bool:
	return not _busy and not _waiting and map != null and _battle == null and commands != null 		and _with_events_active()


func quick_save() -> void:
	if not _can_quick():
		return
	if not Settings.quick_saves:
		_show_notice("Original saving: use the save points", "オリジナルのセーブ：セーブポイントで",
			"Sauvegarde d'origine : utilisez les points de sauvegarde")
		return
	DirAccess.make_dir_recursive_absolute(UiCommands.QUICK_FILE.get_base_dir())
	var f := FileAccess.open(UiCommands.QUICK_FILE, FileAccess.WRITE)
	if f == null:
		_show_notice("Quick save failed", "クイックセーブできませんでした", "Échec de la sauvegarde rapide")
		return
	f.store_buffer(commands.sys.save_file(state, party_actor_bytes()))
	f.close()
	_show_notice("Quick saved", "クイックセーブしました", "Sauvegarde rapide effectuée")


func quick_load() -> void:
	if not _can_quick():
		return
	if not Settings.quick_saves:
		_show_notice("Original saving: use the save points", "オリジナルのセーブ：セーブポイントで",
			"Sauvegarde d'origine : utilisez les points de sauvegarde")
		return
	if not FileAccess.file_exists(UiCommands.QUICK_FILE):
		_show_notice("No quick save yet", "クイックセーブがありません", "Aucune sauvegarde rapide")
		return
	_busy = true
	commands.sys.load_file(state, FileAccess.get_file_as_bytes(UiCommands.QUICK_FILE), {})
	await _reload_from_state()
	_busy = false
	_show_notice("Quick loaded", "クイックロードしました", "Chargement rapide effectué")


func _show_notice(en: String, ja: String, fr := "") -> void:
	_notice.text = GameText.pick(en, ja, fr)
	_notice.modulate.a = 1.0
	var t := create_tween()
	t.tween_interval(1.2)
	t.tween_property(_notice, "modulate:a", 0.0, 0.5)


## The party's three actor records (block +$35E format: x, y, facing +4, flags +5, h +14, w +15)
## for the checkpoint and save files; other bytes are kept from the block.
func party_actor_bytes() -> PackedByteArray:
	# the block holds the live map id ($9C8B8, set by f_67d0e) and view ($9C8BC, BE words)
	for i in 3:
		state.block[GameState.OFF_MAP_ID + i] = map.id.unicode_at(i)
	state.block[GameState.OFF_MAP_ID + 3] = 0
	state.set_be16(GameState.OFF_VIEW, field.view.x)
	state.set_be16(GameState.OFF_VIEW + 2, field.view.y)
	var b := state.block.slice(GameState.OFF_PARTY_POS, GameState.OFF_PARTY_POS + 60)
	for i in mini(field.n, 3):
		var a = field.act[i]
		var o := 20 * i
		b.encode_s16(o, a.x)
		b.encode_s16(o + 2, a.y)
		b[o + 4] = a.facing & 3
		b[o + 5] = (a.flags & 0xfe) | (a.layer & 1)
		b[o + 14] = a.h
		b[o + 15] = a.w
	return b


## Fade the screen to black (out) or back.
func fade(out: bool) -> void:
	var tween := create_tween()
	tween.tween_property(_rect, "modulate", Color.BLACK if out else Color.WHITE, FADE)
	await tween.finished


## Development: load a map and run its scripts unattended: enter + always, then every trigger
## and every actor's talk entry (auto clicks, first menu item, no battles / shops / save menu),
## printing SWEEP lines (errors are push_warning / SCRIPT ERROR lines in the log).
func _sweep_map(id: String) -> void:
	sweep = true
	Engine.time_scale = 20.0
	_busy = true
	print("SWEEP start ", id)
	var prog: Dictionary = events.Programs.load_map(id)
	var e: Dictionary = events.Programs.entries(prog) if not prog.is_empty() else {}
	var tr: Array = e.get("triggers", [])
	var p := Vector2i(10, 10)
	if not tr.is_empty():
		p = Vector2i(int(tr[0]["x"]), int(tr[0]["y"]) + 2)
	map = FieldMap.load_map(id)
	if map == null:
		print("SWEEP nomap ", id)
		return
	for i in 3:
		state.block[GameState.OFF_MAP_ID + i] = id.unicode_at(i)
	var party := [{"x": p.x, "y": p.y, "facing": 0}, {"x": p.x, "y": p.y + 1, "facing": 0, "h": 2},
		{"x": p.x, "y": p.y + 2, "facing": 0, "h": 2}]
	field = FieldLogic.new(map, party, Vector2i(maxi(0, p.x - 11), maxi(0, p.y - 10)))
	_enter_map(0)
	await events.on_map_loaded(false)
	print("SWEEP entered ", id)
	for i in tr.size():
		state.rt["warp_pending"] = 0
		events.close_windows()
		await events.on_trigger(i)
		print("SWEEP trigger ", id, " ", i)
	var acts: Array = e.get("actors", [])
	for k in mini(acts.size(), events.n_actors - 3):
		# talk entries only for talk actors (types 0 / 2): a chest's word is its item code
		if int(acts[k]["talk"]) and field.act[k + 3].type in [0, 2]:
			state.rt["warp_pending"] = 0
			events.close_windows()
			await events.on_talk(k + 3)
			print("SWEEP talk ", id, " ", k + 3)
	print("SWEEP done ", id)


## A command button of the panel (f_823be lamp on, f_7e16a, lamp off).
func _run_command(n: int) -> void:
	_busy = true
	_lamp = n
	render()
	await commands.run(n)
	_lamp = -1
	_left_was = true
	await _after_script()
	_busy = false
	render()


## Mouse hit test of the command panel (field loop $666EA): mouse x 512..623, y 9..119 ->
## button (y - 8) / 20, or -1.
static func panel_button(mx: int, my: int) -> int:
	return (my - 8) / 20 if mx > 0x1ff and mx <= 0x26f and my > 8 and my <= 0x77 else -1


func _with_events_active() -> bool:
	return _with_events or _new_game


func _on_trigger(ev: Dictionary) -> void:
	_busy = true
	if _with_events_active():
		await events.on_trigger(int(ev["index"]))
		if await _after_script():
			_busy = false
			return
	var dest: Variant = ev.get("warp", ev.get("dest") if not _with_events_active() else null)
	if dest != null and str(dest) != "" and FieldMap.map_ids().find(str(dest)) >= 0:
		await warp_to(str(dest), int(ev.get("dest_trigger", -1)), field.act[0].facing)
	render()
	_busy = false


## A script requested a warp (builtin 10 from a map script): load the map now. True if it did.
func _after_script() -> bool:
	if _reload_pending:
		await _reload_from_state()
		return true
	if not state.rt["warp_pending"]:
		render()
		var main_warp: bool = state.rt.get("main_warp", 0) != 0
		state.rt["main_warp"] = 0
		return main_warp
	state.rt["warp_pending"] = 0
	await warp_to(state.rt["next_map"], state.rt["pending_trigger"], state.rt["facing"])
	return true


## Builtin 10 from IC_MAIN (f_7b5cc): the map is loaded now (f_67d0e, f_73090) without its enter /
## always entries; the warp request ($A258A) stays set, so a trigger that ran it takes no direct door,
## but nothing is left to load after the script.
func warp(info: Dictionary, _vm) -> void:
	await warp_to(info["map"], int(info["trigger"]), int(info["facing"]), false)
	state.rt["warp_pending"] = 0
	state.rt["main_warp"] = 1


func _exit_tree() -> void:
	Settings.in_battle = false


func _unhandled_input(event: InputEvent) -> void:
	if _waiting and (event.is_action_pressed("confirm") or event.is_action_pressed("cancel")):
		get_viewport().set_input_as_handled()
		clicked.emit()
		return
	if event.is_action_pressed("quick_save") or event.is_action_pressed("quick_load"):
		get_viewport().set_input_as_handled()
		if event.is_action_pressed("quick_save"):
			quick_save()
		else:
			quick_load()
		return
	if not _busy and event is InputEventKey and event.pressed and event.keycode == KEY_ESCAPE:
		get_viewport().set_input_as_handled()
		Audio.stop_music(0.5)
		finished.emit("title", {})


# --- input ---------------------------------------------------------------------------------------

## The input word as f_8822e builds it: 1 up, 2 down, 4 left, 8 right, $10 Z, $20 X,
## $40 Return, $80 Space (actions bound in the options, Settings; the numeric keypad's 8/2/4/6
## always count). Numpad 1/3/7/9 are not read; diagonals need two keys.
func _input_bits() -> int:
	if route_input >= 0:
		return route_input   # development: the story route walking the leader
	var b := 0
	var k := 1
	for action in INPUT_ACTIONS:
		if Input.is_action_pressed(action):
			b |= k
		k <<= 1
	return b


## The mouse in the game's coordinates (f_88ed2): x = screen x - 64, y = screen y / 2 - 24.
func _mouse() -> Variant:
	var p := get_local_mouse_position()
	var buttons := 0
	if Input.is_mouse_button_pressed(MOUSE_BUTTON_LEFT):
		buttons |= 1
	if Input.is_mouse_button_pressed(MOUSE_BUTTON_RIGHT):
		buttons |= 2
	return {"buttons": buttons, "x": int(p.x) - 64, "y": int(p.y) / 2 - 24}


# --- event host services -------------------------------------------------------------------------

## Wait for a click with the blinking ▼ at `pos` (f_71fca).
func wait_click(pos: Vector2i) -> void:
	render()
	if sweep or auto:
		for i in 6:
			await get_tree().process_frame
		return
	_waiting = true
	var frames := 0
	var done := [false]
	var on_click := func() -> void: done[0] = true
	clicked.connect(on_click)
	while not done[0]:
		layer.put_pixel_value(pos, "▼", DialogueLayer.pixel_of(BLINK[(frames >> 3) & 7]))
		await get_tree().process_frame
		frames += 1
	clicked.disconnect(on_click)
	_waiting = false
	layer.clear_rect(Rect2i(pos, Vector2i(16, 16)))


## Choice menu (f_81f8e): returns the item index, or -1 (cancel).
## Development: -- --menu-choices=1,2,0 answers the menus in order (for unattended tests).
func choose(win: Dictionary, n: int, width: int, sel: int) -> int:
	render()
	var pick := scripted_choice()
	if sweep or auto:
		if not route_answers.is_empty():
			pick = route_answers.pop_front()
			_auto_menu = ""
		else:
			# unqueued: the first item, and the next item each time the same menu comes back (topic
			# menus that refuse "end conversation" until every topic was asked)
			var key := "%d/%d/%d/%d" % [int(win.get("x", 0)), int(win.get("y", 0)), n, width]
			_auto_pick = (_auto_pick + 1) % n if key == _auto_menu else 0
			_auto_menu = key
			pick = _auto_pick
		if auto:
			print("ROUTE menu %d items at %d,%d -> %d" % [n, int(win.get("x", 0)), int(win.get("y", 0)), pick])
	if pick != -2:
		for i in 30:
			await get_tree().process_frame
		return clampi(pick, 0, n - 1)
	var x0: int = 64 + 8 * int(win["x"])
	var y0: int = 48 + 16 * int(win["y"])
	_highlight.size = Vector2(8 * width, 16)
	_highlight.visible = true
	var result := -2
	var last_mouse := get_local_mouse_position()
	while result == -2:
		_highlight.position = Vector2(x0, y0 + 16 * sel)
		await get_tree().process_frame
		var m := get_local_mouse_position()
		if m != last_mouse:
			last_mouse = m
			var row := int((m.y - y0) / 16)
			if m.x >= x0 and m.x < x0 + 8 * width and row >= 0 and row < n:
				sel = row
		if Input.is_action_just_pressed("ui_up"):
			sel = posmod(sel - 1, n)
		elif Input.is_action_just_pressed("ui_down"):
			sel = (sel + 1) % n
		elif Input.is_action_just_pressed("confirm"):
			result = sel
		elif Input.is_action_just_pressed("cancel"):
			result = -1
	_highlight.visible = false
	return result


## Development: the next answer of -- --menu-choices=1,2,0 (unattended tests), or -2.
func scripted_choice() -> int:
	if auto:
		return -1   # --story-route: interface menus are cancelled (VM menus answer 0 in choose())
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("--menu-choices="):
			var queue: PackedStringArray = get_meta("menu_queue", arg.trim_prefix("--menu-choices=").split(",", false))
			if not queue.is_empty():
				var pick := queue[0].to_int()
				queue.remove_at(0)
				set_meta("menu_queue", queue)
				return pick
	return -2


func scripted_choice_pending() -> bool:
	if auto:
		return true
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("--menu-choices="):
			return true
	return false


## Music by ICITY.FIL table 7 index (builtin 15, cutscene B).
func play_music_index(i: int, remember := true) -> void:
	if remember:
		_music_index = i
	var file: String = _music_tables.get(i, "")
	if _music_by_source.has(file):
		Audio.play_music(_music_by_source[file])


## The field's music again after the BGM menu ($A06EC).
func restore_music() -> void:
	if _music_index >= 0:
		play_music_index(_music_index)
	else:
		Audio.stop_music(0.5)


# --- warps ---------------------------------------------------------------------------------------

func warp_to(dest: String, dest_trigger: int, facing: int, scripts := true) -> void:
	var from: String = map.id if map != null else ""
	var arrival: Vector2i = field.arrival if field != null else Vector2i.ZERO
	var tween := create_tween()
	tween.tween_property(_rect, "modulate", Color.BLACK, FADE)
	await tween.finished
	layer.clear()
	var m = FieldMap.load_map(dest)
	if m == null:
		_rect.modulate = Color.WHITE
		return
	map = m
	if field == null:
		var party := []
		for i in maxi(state.party_count(), 1):
			party.append({"x": 0, "y": 0, "facing": facing, "h": 1 if i == 0 else 2})
		field = FieldLogic.new(m, party, Vector2i.ZERO)
	field.set_map(m)
	# Without the VM's arguments (direct doors in development mode): the trigger leading back.
	if dest_trigger < 0 or dest_trigger >= m.triggers.size():
		dest_trigger = 0
		for i in m.triggers.size():
			if str(m.triggers[i].get("dest", "")) == from:
				dest_trigger = i
				break
	_place(dest_trigger, facing & 3, arrival)
	field.last_trigger = dest_trigger
	state.rt["last_trigger"] = dest_trigger
	field.pending = -1
	field.view = Vector2i.ZERO
	field.camera(1)
	_enter_map(facing & 3)
	tween = create_tween()
	tween.tween_property(_rect, "modulate", Color.WHITE, FADE)
	await tween.finished
	if _with_events_active() and scripts:
		await events.on_map_loaded()
		render()
		if _reload_pending:
			await _reload_from_state()
		elif state.rt["warp_pending"]:
			# the enter / always entry warped: the field loop loads that map next (f_663ca)
			state.rt["warp_pending"] = 0
			await warp_to(state.rt["next_map"], state.rt["pending_trigger"], state.rt["facing"])


func _place(ti: int, f: int, arrival: Vector2i) -> void:
	if map.triggers.is_empty():
		return
	var t: Dictionary = map.triggers[ti]
	var tx: int = t["x"]
	var ty: int = t["y"]
	var tw: int = t["w"]
	var th: int = t["h"]
	var ox := clampi(arrival.x, 0, maxi(tw - 1, 0))
	var oy := clampi(arrival.y, 0, maxi(th - 1, 0))
	var lead: Vector2i = [Vector2i(tx + ox, ty - 1), Vector2i(tx + tw + 1, ty + oy),
		Vector2i(tx + ox, ty + th + 1), Vector2i(tx - 2, ty + oy)][f]
	for k in field.n:
		var a = field.act[k]
		var p: Vector2i = lead + BEHIND[f] * k
		a.x = p.x
		a.y = p.y
		a.facing = f
		a.dir = f
		a.layer = 0


static func _x68k_color(w: int) -> Color:
	var i := w & 1
	var g := (((w >> 11) & 31) << 1) | i
	var r := (((w >> 6) & 31) << 1) | i
	var b := (((w >> 1) & 31) << 1) | i
	return Color8(roundi(r * 255.0 / 63.0), roundi(g * 255.0 / 63.0), roundi(b * 255.0 / 63.0))


## Development: the -- --story-route=<steps> argument ("" without one).
func _route_arg() -> String:
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("--story-route="):
			return arg.trim_prefix("--story-route=")
	return ""


## Development: follow a story route (scripts/dev/story_route.gd), then quit.
func _run_route(spec: String) -> void:
	await StoryRoute.new(self).run(StoryRoute.parse(spec))
	if ended:   # let the ending cutscene play for a while (the field is gone by then)
		get_tree().create_timer(20.0, true, false, true).timeout.connect(get_tree().quit)
	else:
		get_tree().quit()
