extends RefCounted
## Events on the field: the host that the script VM (vm.gd), the cutscene interpreter
## (cutscene.gd) and the message engine (message_engine.gd) call into, and the dispatch of scripts
## (docs/events.md section 5): map load (enter / always), triggers, talking to an actor, the cutscene
## T command (map entry 4). Owns the sprite records, the map-animation slots and the windows.
##
## Not yet ported (later milestones): battles (builtin 5 returns 0 = won), shops / inns (35), the
## save menu (1), event pictures (20, G), scroll layers (11), levels (31) and combatants (29, 37).

const VM := preload("res://scripts/events/vm.gd")
const GameState := preload("res://scripts/events/game_state.gd")
const Programs := preload("res://scripts/events/programs.gd")
const Actors := preload("res://scripts/events/actors.gd")
const Cutscene := preload("res://scripts/events/cutscene.gd")
const MessageEngine := preload("res://scripts/events/message_engine.gd")
const TextCodec := preload("res://scripts/events/text_codec.gd")
const SYS := preload("res://scripts/systems/systems_model.gd")
const CRand := preload("res://scripts/systems/c_rand.gd")

const FRAME_RATE := 55.458
# Window rectangles (columns / rows from (64, 48)): $9C30E, $9C316, $9C31E; menu $9C1A4.
const WINDOWS := [Rect2i(10, 19, 56, 4), Rect2i(18, 9, 40, 2), Rect2i(10, 1, 56, 4)]
const MENU_WINDOW := Vector2i(38, 6)

var screen                    # the field screen (field.gd): render(), map, field, layer, input
var state                     # GameState
var map                       # FieldMap
var field                     # FieldLogic
var trace_builtins := false   # development: -- --trace-builtins prints every host builtin call
var talks := 0                # talk entries run (development: the story route's walk steps)
var prog: Dictionary = {}     # the map's program
var main_prog: Dictionary = {}
var entries: Dictionary = {}
var sprites: Array = []       # 32 sprite records
var windows: Array = []       # open windows: {x, y, w, h, cx, cy, frame: bool}
var menu_highlight := Rect2i()
var engine: MessageEngine
var busy := false             # a script / cutscene is running (the field loop waits)
var kinsoku := true           # message engine: 「」 rules on

# cutscene host fields
var part1 := PackedByteArray()
var count := 0
var n_actors := 3
var party_size := 3
var view: Vector2i:
	get:
		return field.view
	set(v):
		field.view = v
var bounds := Rect2i()
var triggers: Array = []
var pending_trigger := -1
var picture_mode := 0
var resume_pending := false
var wait_vsyncs := 5
var inserts := {}             # $n strings of the next messages ($9EDB6 / $9EDB0 / $9EDA4)

var _cutscene_key := 0        # $9FFE8: the current message comes from a cutscene T
var _talk_window := 0         # $9FFEA
var _msg_bytes := PackedByteArray()
var _resume := -1
var _anim_steps: Array = []   # map-animation program steps {a, b, c, d}
var _anim_slots: Array = []   # 16 slots {col, row, period, countdown, index}
var _next_music := 0
var _vm_stack: Array = []     # VMs suspended in a host builtin (innermost last)
var _rand = CRand.new()       # the C library rand() of the level-ups (f_88e00)


func _init(field_screen, game_state) -> void:
	trace_builtins = "--trace-builtins" in OS.get_cmdline_user_args()
	screen = field_screen
	state = game_state
	engine = MessageEngine.new(self)
	main_prog = Programs.load_scn("IC_MAIN.SCN")
	sprites.resize(32)
	for i in 32:
		sprites[i] = Actors.new_sprite()


## A map was loaded: program, actors, map animations. party: [{x, y, set}], facing: arrival facing.
func load_map(field_map, field_logic, party: Array, facing: int) -> void:
	map = field_map
	field = field_logic
	prog = Programs.load_map(map.id)
	if prog.is_empty():
		entries = {}
		return
	entries = Programs.entries(prog)
	part1 = prog["part1"]
	count = prog["cutscene_count"]
	n_actors = int(prog["raw"][17]) + 3
	party_size = party.size()
	triggers = map.triggers
	bounds = Rect2i(0, 0, map.width * 2, map.height * 2)
	windows.clear()
	Actors.load_actors(prog, field, sprites, party, facing, func(n: int) -> bool: return state.chest_open(n))
	_load_map_animation()


# --- dispatch --------------------------------------------------------------------------------------

func run_entry(entry: int, r0 := -1, program := {}) -> String:
	if not entry:
		return "done"
	busy = true
	var vm := VM.new(program if not program.is_empty() else prog, state, self, {"main": main_prog, "map": prog})
	var status: String = await vm.run(entry, r0)
	busy = false
	if status.begins_with("error"):
		push_warning("Event script %s at %d: %s" % [prog.get("name", "?"), entry, status])
	return status


## After a map load: enter (+0) then always (+4); after loading a saved game, load (+2) then always.
func on_map_loaded(from_save := false) -> void:
	if entries.is_empty():
		return
	await run_entry(entries["load"] if from_save else entries["enter"])
	await run_entry(entries["always"])


## The leader stepped into trigger i (f_79d4c): the trigger's entry.
func on_trigger(i: int) -> void:
	state.rt["last_trigger"] = i
	state.rt["main_warp"] = 0   # f_79d4c clears the warp request ($A258A) before the trigger's entry
	if i >= 0 and i < entries.get("triggers", []).size():
		await run_entry(entries["triggers"][i]["entry"])


## The leader walked into a talk actor (f_79e68): the last trigger's entry (the talk prologue when
## none is active), then the actor's own entry.
func on_talk(actor: int) -> void:
	talks += 1
	var lt: int = state.rt["last_trigger"]
	var pre: int = entries["triggers"][lt]["entry"] if lt >= 0 and lt < entries["triggers"].size() else entries["talk_pre"]
	await run_entry(pre)
	if actor >= 3 and actor - 3 < entries["actors"].size():
		await run_entry(entries["actors"][actor - 3]["talk"])


# --- VM host -----------------------------------------------------------------------------------------

func builtin(n: int, args: Array[int], vm) -> int:
	if trace_builtins:
		print("SYS %d %s in %s" % [n, str(args), vm.prog.get("name", "?")])
	_vm_stack.append(vm)
	var r: int = await _builtin(n, args, vm)
	_vm_stack.pop_back()
	return r


func _builtin(n: int, args: Array[int], vm) -> int:
	match n:
		0:  # cutscene(n)
			await Cutscene.new(self).run(args[0] - 1)
			_sync_actors_from_sprites()
			screen.render()
		6:  # message(key, table)
			await _message_by_key(args[0], args[1], vm)
		9:  # gatherParty
			var x2 := 0
			var bytes := PackedByteArray([0x4d, 3])
			for r in [[0, 0, 0, 0], [1, 0, 1, 1], [2, x2, 1, 1]]:
				bytes.append_array([r[0], 0x91, 0, r[1] & 255, (r[1] >> 8) & 255, r[2] & 255, (r[2] >> 8) & 255, 0, 0, r[3]])
			bytes.append_array([0x45, 0x65])
			var cs := Cutscene.new(self)
			await cs.step(bytes, 0)
			_sync_actors_from_sprites()
		15:  # music(track): ICITY.FIL table 7 index
			screen.play_music_index(args[0])
		16:  # sound(n)
			Audio.play_sfx("se_%02d" % args[0])
		24:  # menu(text, text, ..., 0) -> choice + 1 (cancel -> 1)
			var items: Array[PackedByteArray] = []
			for a in args:
				if a == 0:
					break
				items.append(TextCodec.message_at(vm.prog["code"], a))
			var r: int = await _menu(items, state.get_var16(0) - 1)
			return (0 if r < 0 else r) + 1
		25:  # yesNo(text) -> 1 for the first choice
			var r: int = await _menu([TextCodec.message_at(vm.prog["code"], args[0])], 0)
			return 1 if r == 0 else 0
		30:  # random: f_88de0 = the C library rand() % 257 (0..256)
			return _rand.mod(257)
		33:  # party(slot, op, char, b, actor): f_7b698(slot - 1, actor - 1) swaps the actor and sprite
			# records of the party slot and the map actor that played the character
			party_size = state.party_count()
			var slot := args[0] - 1
			var actor := args[4] - 1
			if args[0] >= 2 and args[0] <= 3 and args[1] >= 1 and args[1] <= 2 and actor >= 3 and actor < 32:
				_swap_actors(slot, actor)
			field.n = clampi(party_size, 1, 3)
			screen.render()
		34:  # actorVisible(actor, on)
			Actors.actor_show(field, sprites, args[0], args[1] != 0)
			screen.render()
		35:  # service: 0 closes the window, 1 inn, >= 2 shop mode - 2
			close_windows()
			if args[0] != 0 and screen.commands != null and not screen.sweep:
				await screen.commands.service(args[0])
		1:  # checkpoint (0) / save menu
			if args[0] == 0:
				SYS.checkpoint(state, screen.party_actor_bytes())
			elif screen.commands != null and not screen.sweep:
				close_windows()
				await screen.commands.save_menu(true)
				screen.render()
		19:  # setCharByte (done by the VM): recompute the derived values of all characters
			SYS.recompute_all(state)
		31:  # level(char, lv): 0 = read, else set and level up to lv, full heal
			if args[1] == 0:
				return state.block[GameState.OFF_CHARS + GameState.CHAR_SIZE * args[0] + 3]
			return SYS.set_level(state, args[0], args[1], _rand.fn())
		38:  # text(offset)
			await message(args[0], vm)
		20:  # picture(n): event picture n - 1
			await picture(args[0] - 1)
			picture_mode = 1
		5:  # battle(event, group): 99 the end of the game (the ending); 0 ordinary battle with group - 1;
			# else event battle
			close_windows()
			if screen.sweep:
				print("SWEEP battle ", args)
			elif args[0] == 99:
				# f_7c626 longjmps out of the field loop: no script goes on after the end of the game
				await screen.game_end()
				vm._abort()
				return 0
			else:
				var ordinary: bool = args[0] == 0
				var result: String = await screen.battle(1 if ordinary else 2, (args[1] if ordinary else args[0]) - 1)
				if result == "defeat":
					# GAME OVER (f_6b87c) never returns to the script: the checkpoint is reloaded
					vm._abort()
					return 0
				if not ordinary:
					SYS.full_heal(state)
			screen.render()
		29:  # combatantVisible(n, on) during a battle
			if screen._battle != null:
				screen._battle.combatant_visible(args[0], args[1] != 0)
		37:  # combatantHealth(n) during a battle
			return screen._battle.combatant_health(args[0]) if screen._battle != null else 0
		11:  # scrollLayer(layer, dx, dy, speed, step): the overlay scrolls to origin - (dx, dy), one
			# step (1 -> 2 tiles) per redraw every `speed` vsyncs (f_7c528); the port has one overlay
			var target := Vector2i(-GameState._s16(args[1]), -GameState._s16(args[2]))
			var st: int = 2 if args[4] <= 1 else args[4]
			while map.sub_origin != target:
				var o: Vector2i = map.sub_origin
				o.x += clampi(target.x - o.x, -st, st)
				o.y += clampi(target.y - o.y, -st, st)
				map.sub_origin = o
				screen.render()
				await delay(maxi(1, args[3]))
		13:  # diskCheck(n): the port has no disks to ask for (returns 0); the block's disk word
			# ($9C796, block +2: saved, and copied into the return point by builtin 22) becomes what
			# the original's prompt leaves there (f_7c10c -> f_678ec with the disk of table $9C1F8[n]:
			# the word is that disk - 1, as the emulator shows), unless installed on a hard disk
			if not state.rt.get("hdd", 0) and args[0] >= 1 and args[0] <= 7:
				state.set_be16(2, [0, 1, 2, 3, 3, 4, 5, 6][args[0]])
	return 0


## Builtin 10 from IC_MAIN (f_7b5cc): the host loads the map now; a callMap after it runs the new
## map's dispatcher.
func warp(info: Dictionary, vm) -> void:
	close_windows()
	await screen.warp(info, vm)
	vm.programs["map"] = prog


func on_abort(_vm) -> void:
	pass


## MSG instruction (f_7b452): window 0, all pages, wait; the window stays open.
func message(offset: int, vm) -> void:
	_message_speed()
	var bytes := TextCodec.message_at(vm.prog["code"], offset)
	bytes.append(0)
	var win := _open_window(0)
	var r: int = await engine.show(win, bytes, true, 0, false)
	await wait_click()
	if r >= 0:
		_next_page(win)
		await engine.show(win, bytes, false, r, true)
		await wait_click()


## After a page break and its click: the next page starts in a cleared window.
func _next_page(win: Dictionary) -> void:
	clear(MessageEngine.clear_rect(win, 2))
	win["cx"] = 0
	win["cy"] = 0


## The message end delay: $9CB32 (message speed, block +$39E) x 3 vsyncs.
func _message_speed() -> void:
	engine.end_delay = 3 * (state.be16(0x39e) & 0xff) if state.block.size() > 0x39f else 0


func _message_by_key(key: int, table: int, vm) -> void:
	_message_speed()
	var code: PackedByteArray = vm.prog["code"]
	var offset := -1
	var p := table
	while p + 3 < code.size():
		var k := code.decode_u16(p)
		if k == 0:
			break
		if k == key:
			offset = code.decode_u16(p + 2)
			break
		p += 4
	if offset < 0:
		return
	_msg_bytes = TextCodec.message_at(code, offset)
	_msg_bytes.append(0)
	var win := _open_window(_talk_window if _cutscene_key else 0)
	_resume = await engine.show(win, _msg_bytes, true, 0, false)
	if _cutscene_key:
		resume_pending = _resume >= 0
		return
	await wait_click()
	if _resume >= 0:
		_next_page(win)
		await engine.show(win, _msg_bytes, false, _resume, true)
		await wait_click()
	close_windows()


# --- chests (f_79f7a) -----------------------------------------------------------------------------

## The leader walked into chest actor j: unless its flag bit is set, the actor animates (one
## cutscene step with its current action, direction 1), sound 1, window 1 shows "$1を手に入れた。"
## (or, when the inventory is full, "$1が見つかったが、持てないのであきらめた。") with the item
## name, a click, then the flag bit is set and the actor disappears. Count 1, or 100 for items
## $13-$1C (ammunition).
func chest(j: int) -> void:
	var recs: PackedByteArray = prog.get("actors", PackedByteArray())
	var o := 16 + 8 * (j - 3)
	if j < 3 or o + 8 > recs.size():
		return
	var flag: int = recs[o + 5]
	var code: int = recs.decode_u16(o + 6)
	if state.chest_open(flag):
		return
	busy = true
	var bytes := PackedByteArray([0x4d, 1, j, 0x40, 0, 0, 0, 0, 0, int(sprites[j]["action"]) & 0xff, 1, 0, 0x45, 0x65])
	await Cutscene.new(self).step(bytes, 0)
	_sync_actors_from_sprites()
	sound(1)
	var win := _open_window(1)
	var cls: int = [4, 4, 6, 7][clampi(code >> 8, 0, 3)]
	var count := 100 if cls == 4 and (code & 0xff) > 0x12 and (code & 0xff) <= 0x1c else 1
	var full: int = state.give_item(code, count)
	var ui_screens = screen.commands.screens if screen.commands != null else null
	var name := PackedByteArray()
	var msg := PackedByteArray()
	if ui_screens != null:
		name = ui_screens.item_name(code)
		msg = ui_screens.cstr(0x9c147 if full else 0x9c136)
	var en := GameText.template(GameText.decode(msg))
	if en != "":
		# English: the template with the item's English name ("Got Cure Pill.")
		var text := en.replace("$1", GameText.name_of(GameText.decode(name)))
		msg = TextCodec.from_text(TextCodec.wrap(text, MessageEngine.ENGLISH_WIDTH))
	else:
		inserts[0] = name
	msg.append(0)
	await engine.show(win, msg, true, 0, false)
	await wait_click()
	close_windows()
	state.block[GameState.OFF_CHESTS + (flag >> 3)] |= 1 << (flag & 7)
	Actors.actor_show(field, sprites, j + 1, false)
	busy = false
	screen.render()


# --- message engine host -------------------------------------------------------------------------

func put(win: Dictionary, cx: int, cy: int, code: int, colour: int) -> void:
	if code < 0x20:
		return
	screen.layer.put(MessageEngine.cell_pos(win, cx, cy), GameText.char_for(code), colour)


func clear(rect: Rect2i) -> void:
	screen.layer.clear_rect(rect)


func wait_click(win = null, cx := -1, cy := -1) -> void:
	if win == null:
		win = windows.back() if not windows.is_empty() else null
		if win != null:
			cx = win["cx"]
			cy = win["cy"]
	var pos := MessageEngine.cell_pos(win, cx, cy) if win != null else Vector2i(-100, -100)
	await screen.wait_click(pos)


func delay(vsyncs: int) -> void:
	await screen.get_tree().create_timer(vsyncs / FRAME_RATE).timeout


## $n of a message: the string set for insert n (chests here; battles set them too).
func insert(n: int) -> PackedByteArray:
	return inserts.get(n, PackedByteArray())


func number(_n: int) -> int:
	return state.rt["money_shown"]


# --- windows -----------------------------------------------------------------------------------------

func _open_window(k: int) -> Dictionary:
	for w in windows:
		if w["k"] == k:
			return w
	var r: Rect2i = WINDOWS[clampi(k, 0, 2)]
	var win := {"k": k, "x": r.position.x, "y": r.position.y, "w": r.size.x, "h": r.size.y, "cx": 0, "cy": 0}
	if picture_mode:
		# the picture window ($9C118): frame 72 columns wide, text 50 (the picture on the right)
		win = {"k": k, "x": 4, "y": 8, "w": 50, "frame_w": 72, "h": 10, "cx": 0, "cy": 0}
	windows.append(win)
	screen.render()
	return win


func close_windows() -> void:
	for w in windows:
		screen.layer.clear_rect(MessageEngine.clear_rect(w, 2))
	windows.clear()
	menu_highlight = Rect2i()
	screen.render()


## Frame tiles of a window (f_71ab2): [Vector3i(col, row, cell)] in 16x16 text tiles.
static func frame_tiles(w0: Dictionary) -> Array:
	var win := w0.duplicate()
	win["w"] = w0.get("frame_w", w0["w"])
	var out := {}
	var add := func(c: int, type: int) -> void:
		out[Vector2i(c, win["y"] - 1)] = type
		for r in win["h"]:
			out[Vector2i(c, win["y"] + r)] = 3 + type
		out[Vector2i(c, win["y"] + win["h"])] = 6 + type
	var d4: int = (win["x"] >> 1) + (win["w"] >> 2) - 1
	var d5: int = ((win["x"] + win["w"]) >> 1) - (win["w"] >> 2)
	if win["w"] & 2:
		add.call(d4 + 1, 1)
	add.call(d4, 0)
	add.call(d5, 2)
	for k in win["w"] >> 2:
		add.call(d4, 1)
		add.call(d5, 1)
		d4 -= 1
		d5 += 1
		add.call(d4, 0)
		add.call(d5, 2)
	var list := []
	for p: Vector2i in out:
		list.append(Vector3i(p.x, p.y, out[p]))
	return list


# --- choice menus (f_81f8e) ----------------------------------------------------------------------

func _menu(items: Array, cursor: int) -> int:
	close_windows()
	var width := 4
	var texts: Array[String] = []
	for b: PackedByteArray in items:
		var t := _display(b)
		texts.append(t)
		width = maxi(width, b.size())
	width += 2
	var win := {"k": 9, "x": MENU_WINDOW.x, "y": MENU_WINDOW.y, "w": 20, "h": items.size(), "cx": 0, "cy": 0}
	windows.append(win)
	for i in texts.size():
		var cx := 1
		for ch in texts[i]:
			screen.layer.put(MessageEngine.cell_pos(win, cx, i), ch, 7)
			cx += 1 if ch.unicode_at(0) < 0x100 else 2
	var sel: int = clampi(cursor, 0, items.size() - 1)
	var result: int = await screen.choose(win, items.size(), width, sel)
	close_windows()
	return result


## Bytes of a menu item -> text: English from the translation table when there is one.
func _display(b: PackedByteArray) -> String:
	var en := GameText.translation_for(TextCodec.message_id(b))
	if en != "":
		return en
	var s := ""
	var i := 0
	while i < b.size():
		if TextCodec.is_lead(b[i]) and i + 1 < b.size():
			s += GameText.char_for((b[i] << 8) | b[i + 1])
			i += 2
		else:
			s += GameText.char_for(b[i])
			i += 1
	return s


# --- cutscene host -------------------------------------------------------------------------------

func frame(vsyncs: int) -> void:
	run_map_animation()
	map.tick_tiles()
	screen.render()
	await screen.get_tree().create_timer(maxi(vsyncs, 1) / FRAME_RATE).timeout


func redraw() -> void:
	screen.render()


## Cutscene T: the map's message dispatcher (the jump-table entry at code offset 4) with
## var 0 = key; builtin 6 shows the first page and returns.
func message_cutscene(key: int, window: int) -> void:
	_cutscene_key = key
	_talk_window = window
	resume_pending = false
	# nested run on a copy of the stack memory of the script that started the cutscene
	if _vm_stack.is_empty():
		await run_entry(4, key)
	else:
		var v = _vm_stack.back().spawn(prog)
		await v.run(4, key)
	_cutscene_key = 0


func clear_window() -> void:
	if not windows.is_empty():
		var w: Dictionary = windows.back()
		screen.layer.clear_rect(MessageEngine.clear_rect(w, 2))
		w["cx"] = 0
		w["cy"] = 0


func continue_message() -> void:
	if windows.is_empty() or _resume < 0:
		return
	_resume = await engine.show(windows.back(), _msg_bytes, true, _resume, true)
	resume_pending = false


func close_picture() -> void:   # f_79a46
	close_windows()
	picture_mode = 0
	screen.hide_picture()


func picture(n: int) -> void:   # f_798e8
	close_windows()
	screen.show_picture(n)


func music_fade_out(_n: int) -> void:
	Audio.stop_music(0.5)
	_next_music = _n



func music_start() -> void:
	screen.play_music_index(_next_music)


func sound(n: int) -> void:
	Audio.play_sfx("se_%02d" % n)


func palette(_set: Dictionary) -> void:
	pass


func restore_palette() -> void:
	pass


# --- map animation (f_74aa4; docs/cutscenes-field.md section 3) ----------------------------------

func _load_map_animation() -> void:
	_anim_steps.clear()
	_anim_slots.clear()
	var vr: Dictionary = GameData.json("data/" + map.info["vrMap"]["json"])
	var raw := Marshalls.base64_to_raw(vr["extraB64"]) if vr.get("extraB64") != null else PackedByteArray()
	if raw.size() < 0x100:
		return
	for i in 21:
		var o := i * 6
		_anim_steps.append({"a": GameState._s16(raw.decode_u16(o)), "b": raw.decode_u16(o + 2),
			"c": raw[o + 4], "d": raw[o + 5]})
	for k in 16:
		var o := 0x80 + 8 * k
		_anim_slots.append({"col": raw.decode_u16(o), "row": raw.decode_u16(o + 2), "period": raw[o + 4],
			"countdown": raw[o + 5], "index": raw.decode_u16(o + 6)})


## Cutscene A: code $E0 + k starts slot k with period = countdown = value.
func map_anim(_slot: int, code: int, value: int) -> void:
	if (code & 0xe0) == 0xe0 and (code & 0x1f) < _anim_slots.size():
		var s: Dictionary = _anim_slots[code & 0x1f]
		s["period"] = value
		s["countdown"] = value


func map_anim_done(_slot: int, code: int, _pass: int) -> bool:
	var k := code & 0x1f
	if k >= _anim_slots.size():
		return true
	var s: Dictionary = _anim_slots[k]
	if s["period"] == 0:
		return true
	var st: Dictionary = _anim_steps[int(s["index"]) % _anim_steps.size()]
	return st["a"] < 0 and (st["a"] & 1) == 1


## One redraw's worth of the map-animation programs.
func run_map_animation() -> void:
	for s: Dictionary in _anim_slots:
		if s["period"] == 0:
			continue
		if s["countdown"] > 0:
			s["countdown"] -= 1
			if s["countdown"] > 0:
				continue
		for guard in 22:
			var st: Dictionary = _anim_steps[int(s["index"]) % _anim_steps.size()]
			if st["a"] >= 0:
				for c in st["c"]:
					for r in st["d"]:
						var sx: int = st["a"] + c
						var sy: int = st["b"] + r
						var dx: int = s["col"] + c
						var dy: int = s["row"] + r
						if sx < map.width and sy < map.height and dx < map.width and dy < map.height:
							map.vr_cells[dy * map.width + dx] = map.vr_cells[sy * map.width + sx]
				s["index"] = int(s["index"]) + 1
				s["countdown"] = s["period"]
				break
			s["index"] = st["b"]
			if st["a"] & 1:
				s["period"] = 0
				s["countdown"] = 0
				break


# --- sprites <-> actors --------------------------------------------------------------------------

func _swap_actors(i: int, j: int) -> void:
	var a = field.act[i]
	var b = field.act[j]
	for k in ["x", "y", "facing", "flags", "w", "h", "layer", "visible", "dir", "type", "step"]:
		var t = a.get(k)
		a.set(k, b.get(k))
		b.set(k, t)
	var t2: Dictionary = sprites[i]
	sprites[i] = sprites[j]
	sprites[j] = t2
	a.flags |= 0x80
	a.h = 2 if i > 0 else 1

## After a cutscene the actor records follow the sprites (done by Cutscene.run); outside cutscenes
## the party sprites follow the walking logic.
func _sync_actors_from_sprites() -> void:
	for i in 32:
		field.act[i].visible = sprites[i]["visible"]


func sync_party_sprites(party_sets: Array) -> void:
	for i in mini(field.n, 3):
		var a = field.act[i]
		var s: Dictionary = sprites[i]
		s["x"] = a.x
		s["y"] = a.y
		s["dir"] = a.dir
		s["layer"] = a.layer
		if s["set"] == null and i < party_sets.size():
			s["set"] = party_sets[i]
		if s["set"] != null:
			s["frame"] = s["set"].frame_for(0, a.dir, a.step - 1)
