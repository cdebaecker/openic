extends RefCounted
## A battle on the field screen (docs/battle-ui.md, docs/battle.md): the transition, the arena
## (battle_view.gd), the command selector, spell / item lists and target cursor, the message
## window and the animations, around the battle logic (battle_model.gd), which this object hosts:
## command(bs, idx, attempt) asks the player, impacts(bs, idx) plays the action's animation and
## answers how many impact rounds it has. What the logic logs (messages, executions, damage,
## deaths, level-ups) is shown in order each time the logic asks something and at the end.
##
##   var result: String = await BattleScreen.new(field).run(mode, actor)   # victory | fled | defeat
##   mode 0: contact with map actor `actor`, 1: builtin 5 ordinary battle (actor = group), 2: event
##   battle (actor = event group).

const BM := preload("res://scripts/battle/battle_model.gd")
const BD := preload("res://scripts/battle/battle_data.gd")
const BattleView := preload("res://scripts/battle/battle_view.gd")
const SpriteSet := preload("res://scripts/battle/battle_sprite_set.gd")
const BattleAnim := preload("res://scripts/battle/battle_anim.gd")
const UiToolkit := preload("res://scripts/systems/ui_toolkit.gd")
const SYS := preload("res://scripts/systems/systems_model.gd")
const GameState := preload("res://scripts/events/game_state.gd")
const TextCodec := preload("res://scripts/events/text_codec.gd")

const FRAME_RATE := 55.458
# Fixes of bugs of the original (battle_data_core.gd FIXES): the 16-bit damage overflow (the "max
# weapon skill stops hitting" bug), the status expiry lines that never showed, the flight check
# that included the party. The enemy AI weight bug is kept: fixing it changes the balance.
const FIXES := {"damage": true, "status_messages": true, "flight": true}   # defaults; the options choose (Settings)
const SELECTOR := Rect2i(70, 2, 10, 15)
const MESSAGE := Rect2i(16, 17, 40, 7)
# effect sets 0 / 1 (table 12 #4 / #5); set 2 per map comes from battle/effects.json (f_68dac(1, 1))
const EFFECT_SETS := ["GROUP00_000056", "GROUP00_000057"]
# party character id -> battle sprite set (ICITY.FIL table 9 entry c + 1)
const PARTY_SETS := ["GROUP00_000001", "GROUP00_000003", "GROUP00_000007", "GROUP00_000005",
	"GROUP00_000013", "GROUP00_000011", "GROUP00_000014", "GROUP00_000009"]

var field                      # the field screen (field.gd)
var state                      # GameState
var view := BattleView.new()
var data: Dictionary = {}
var bs: Dictionary = {}
var ui: UiToolkit
var sprites: Array = []        # 16: combatant sprites 0-7, effect sprites 8-15
var marker: Array = []         # target marker cells (arena tiles)
var tiles: Array = []          # extra ASDF tiles [tile, Vector2i] (selector pointer)
var _shown := 0                # log entries already presented
var _msg: Dictionary = {}      # message window
var _sel: Dictionary = {}      # selector window
var _lines := 0
var _set_names := {}           # sprite set id -> battle set name
var _frames := 0
var _game_over_clicked := false
# the attack animation in progress (f_6cd3c): it stops at its first impact step (flag bit 2) and goes
# on while the log shows what the impact callback $6BC10 did there ({rec, steps, k, effect, trigger,
# rest: the calls after it, targets, seen: impact entries shown})
var _pending: Dictionary = {}


func _init(field_screen) -> void:
	field = field_screen
	state = field.state
	ui = UiToolkit.new(field)


# --- the battle ------------------------------------------------------------------------------------

func run(mode: int, actor: int) -> String:
	data = BD.load_battle_data()
	if mode == 0:
		await _contact_flash()
	await field.fade(true)
	Audio.stop_music(0.3)
	view.load_background(field.map.id)
	var actors := _actor_bytes()
	bs = BM.setup_battle(state, data, {"mode": mode, "actor": actor, "scripted": 1 if mode >= 1 else 0,
		"actors": actors, "attr_of": _attr_of, "type_of": _type_of, "data_of": _data_of,
		"party_actors": _party_actors(), "fixes": Settings.fixes_enabled()})
	_init_sprites()
	_msg = {"x": MESSAGE.position.x, "y": MESSAGE.position.y, "w": MESSAGE.size.x, "h": MESSAGE.size.y,
		"cx": 0, "cy": 0, "colour": 7}
	_sel = {"x": SELECTOR.position.x, "y": SELECTOR.position.y, "w": SELECTOR.size.x, "h": SELECTOR.size.y,
		"cx": 0, "cy": 0, "colour": 7}
	field.enter_battle(self)
	# event battles: the trigger-block +8 entry also runs once before the battle is shown (f_6abca
	# $6AD06: f_6b8de($A0354)); scripts hide records there (combatantVisible): the last battle's
	# party members, F7X's enemy that comes in later
	await BM._run_hook(bs, self, "act")
	_play_battle_music()
	await field.fade(false)
	# enemies' entrance (action $40), then idle
	for i in range(3, 8):
		_start(i, 0x40, true)
	await _redraws(12)
	if mode <= 1:
		await _say(_template(data["message_names"]["encounter"]))
	if field.auto:
		print("BATTLE start mode %d actor %d on %s" % [mode, actor, field.map.id])
	var result: String = await BM.run_battle(state, data, bs, field.events._rand, self)
	await _flush()
	if field.auto:
		print("BATTLE %s" % result)
		if result == "defeat":
			field.set_meta("defeats", int(field.get_meta("defeats", 0)) + 1)
	if result == "victory" and not field.auto:
		await ui.wait_click()
	elif result == "defeat" and not _game_over_clicked:
		await _game_over_click()
	elif result == "defeat" and not field.auto:
		await ui.wait_click()   # the Quick Load failed line, then back to the title
	_apply_actors()
	await field.fade(true)
	field.layer.clear()
	field.leave_battle()
	if result == "defeat":
		if SYS.restore_checkpoint(state):
			field.request_reload()
		else:
			field.leave_to_title()
	field.restore_music()
	await field.fade(false)
	return result


## f_6abca mode 0: f_78546 twice = f_7857e(16, 1, 4, $AAA), f_7857e(16, 1, 2, $00A): the text
## palette all gray / blue (0GRB) for 2 vsyncs, back, then 4 / 2 vsyncs (tools/battle-ui/anim.mjs
## CONTACT_FLASH).
func _contact_flash() -> void:
	for f: Array in [[0xaaa, 4], [0x00a, 2], [0xaaa, 4], [0x00a, 2]]:
		var c: int = f[0]
		field.flash_palette((((c >> 8) & 15) << 12) | (((c >> 4) & 15) << 7) | ((c & 15) << 2) | 1)
		await field.get_tree().create_timer(2 / FRAME_RATE).timeout
		field.flash_palette(-1)
		await field.get_tree().create_timer(int(f[1]) / FRAME_RATE).timeout


## Rendering (the field screen calls it while the battle is shown).
func render() -> void:
	var list: Array = []
	for s: Dictionary in sprites:
		list.append(s)
	var panel: Array = []
	for slot in int(bs.get("n_party", 0)):
		var c: int = SYS.party(state)[slot]
		panel.append({"id": c, "lv": state.block[GameState.OFF_CHARS + 40 * c + 3],
			"hp": BM.br_get16(bs, slot, BM.R.HP), "mp": BM.br_get16(bs, slot, BM.R.MP)})
	view.render(list, panel, marker, tiles)


func palette_words() -> Array:
	return view.palette_words()


# --- host of the logic -----------------------------------------------------------------------------

## A party member's decision: {cmd, spell, item, target}.
func command(b: Dictionary, idx: int, attempt: int) -> Dictionary:
	await _flush()
	if field.auto:
		return _auto_command(b, idx, attempt)
	if attempt > 0:
		field.events.sound(UiToolkit.BUZZER)
	var c: int = SYS.party(state)[idx]
	while true:
		_status_list(b)
		var list: int = BM.command_list(state, b, idx)
		var codes: Array = []
		var labels: Array = []
		var k := list + 1
		while k < data["cmd_codes"].size() and data["cmd_codes"][k] != 0:
			codes.append(int(data["cmd_codes"][k]))
			labels.append(_label(k))
			k += 1
		var pick: int = await _selector(labels)
		if pick < 0:
			continue
		var cmd: int = codes[pick]
		var choice := {"cmd": cmd, "spell": 0, "item": 0, "target": 0}
		if cmd == 4:     # magic
			var sp: int = await _spell_list(c)
			if sp <= 0:
				continue
			choice["spell"] = sp
			var t: int = await _target(b, idx, _spell_side(sp), _spell_all(sp))
			if t < 0:
				continue
			choice["target"] = t
		elif cmd == 5:   # item
			var it: int = await _item_list()
			if it <= 0:
				continue
			choice["item"] = it
			var t: int = await _target(b, idx, 0, false)
			if t < 0:
				continue
			choice["target"] = t
		elif cmd in [1, 7, 8, 10, 11, 13]:   # attacks / specials on an enemy
			var t: int = await _target(b, idx, 1, false)
			if t < 0:
				continue
			choice["target"] = t
		return choice
	return {}


## Development (--story-route): attack the first enemy the attack can reach; with none, or when the
## attack is refused, the costliest offensive spell the member can pay for; else defend.
func _auto_command(b: Dictionary, idx: int, attempt: int) -> Dictionary:
	# the model's own candidate lists: front row (any row in event battles) and every target
	var fl: Array = []
	BM._count_row(b, 3, 5, 7, fl)
	var al: Array = BM._list_alive(b, 3, 5)
	var front: int = fl[0] if not fl.is_empty() else -1
	var any: int = al[0] if not al.is_empty() else -1
	if any < 0:
		return {"cmd": 2, "spell": 0, "item": 0, "target": 0}
	var c: int = SYS.party(state)[idx]
	var max_hp: int = maxi(1, state.le16(GameState.OFF_CHARS + 40 * c + 12)) if c < 8 else 1
	if attempt == 0 and c < 8 and BM.br_get16(b, idx, BM.R.HP) * 5 < 2 * max_hp:
		# below 40 % HP: the strongest healing pill held (items 4, 3, 2, 1: HP +9999 / 300 / 100 / 50)
		for code in [4, 3, 2, 1]:
			if state.item_count(code) > 0:
				return {"cmd": 5, "spell": 0, "item": code, "target": idx}
	if front >= 0 and attempt <= 1:
		return {"cmd": 1, "spell": 0, "item": 0, "target": front}
	var sl: Variant = SYS.spell_list(state, c) if c < 8 else null
	var best := [0, -1]
	if sl != null and attempt < 3:
		var raw: PackedByteArray = data["raw"]
		var mp: int = state.le16(GameState.OFF_CHARS + 40 * c + 10)
		for col: Array in [sl["left"], sl["right"]]:
			for sp: Dictionary in col:
				var r: int = BM._t9(data, int(sp["spell"]))
				var flags: int = raw[r + 7]
				var cost: int = raw[r + 5] if flags & 0x40 else 0
				var usable: bool = flags & 0x20 and flags & 8 and not (int(b.get("event", 0)) and flags & 1)
				if usable and cost <= mp and cost > best[1]:
					best = [int(sp["spell"]), cost]
	if best[0]:
		return {"cmd": 4, "spell": best[0], "item": 0, "target": front if front >= 0 else any}
	return {"cmd": 2, "spell": 0, "item": 0, "target": 0}


## The action's animation; returns the impact rounds (frames with step flag bit 2, plus one). The
## attack animation plays up to its first impact step; the rest plays while the log is presented
## (the impact callback's messages appear at that step, as in the original: f_6cd3c -> $6BC10).
func impacts(b: Dictionary, idx: int) -> int:
	await _flush()
	var act: Dictionary = b["act"]
	var rounds := 1
	var calls := BattleAnim.presentation(_action_struct(act), _rec_info(b), {"rec": idx,
		"side": "party" if BM.br_get(b, idx, BM.R.SPR) <= 2 else "enemy",
		"char_of": func(r: int) -> int: return SYS.party(state)[r] if r < 3 else -1,
		"cg_attr32": func(r: int) -> int: return int(b["attrs"].get(r, [0])[0]) if b["attrs"].has(r) else 0,
		"trigger": func(r: int, a: int) -> bool: return _has_flag(r, a, 1),
		"effect_anim": func(e: int) -> int: return data["raw"][data["off"][5] + 4 * e + 3]})
	var targets: Array = act["targets"].duplicate()
	for n in calls.size():
		var cl: Dictionary = calls[n]
		match str(cl["op"]):
			"oneshot":
				await _play(int(cl["rec"]), int(cl["action"]))
			"place":
				var s: Dictionary = sprites[int(cl["spr"])]
				s["x"] = BM.br_get(b, int(cl["rec"]), BM.R.X)
				s["y"] = BM.br_get(b, int(cl["rec"]), BM.R.ROW) + int(cl["dy"])
			"attack":
				var r := int(cl["rec"])
				rounds = _count_flag(r, int(cl["action"]), 4) + 1
				if sprites[r]["set"] == null:
					continue
				_start(r, int(cl["action"]), true)
				_pending = {"rec": r, "steps": sprites[r]["set"].steps(int(sprites[r]["seq"])), "k": 0,
					"effect": int(cl["effect"]), "trigger": int(act.get("anim0", 0)), "rest": calls.slice(n + 1),
					"targets": targets, "seen": 0}
				await _pending_steps(true)
				return maxi(rounds, 1)
			"effect_all":
				await _effect_all(cl, targets)
	_reset_positions()
	return maxi(rounds, 1)


## The pending attack animation: steps up to and including the next impact step (or to the end).
func _pending_steps(to_impact: bool) -> void:
	var steps: Array = _pending.get("steps", [])
	var i: int = _pending.get("rec", 0)
	while int(_pending["k"]) < steps.size():
		var st: Dictionary = steps[int(_pending["k"])]
		_pending["k"] = int(_pending["k"]) + 1
		if int(_pending["effect"]) and (int(st["flags"]) & 1):
			_effect_on(i, int(_pending["effect"]), true, int(_pending["trigger"]))
		if int(st["flags"]) & 2:
			field.events.sound(int(sprites[i]["set"].sound(int(sprites[i]["seq"]))))
		await _redraws(1)
		if to_impact and (int(st["flags"]) & 4):
			return


## The rest of the pending animation (to_rest: also the calls after it, then positions reset).
func _finish_pending(to_rest: bool) -> void:
	if _pending.is_empty():
		return
	if int(_pending["k"]) <= _pending["steps"].size() and not _pending.get("done", false):
		await _pending_steps(false)
		_start(int(_pending["rec"]), BM.br_get(bs, int(_pending["rec"]), BM.R.POSE), false)
		_pending["done"] = true
	if not to_rest:
		return
	var p := _pending
	_pending = {}
	for cl: Dictionary in p["rest"]:
		if str(cl["op"]) == "effect_all":
			await _effect_all(cl, p["targets"])
	_reset_positions()


func _effect_all(cl: Dictionary, targets: Array) -> void:
	var e: int = int(cl.get("effect", -1))
	if e > 0:
		for t: int in targets:
			if t >= 0 and t < 8:
				_effect_on(t, e)
		await _redraws(6)


## Event battles (f_6b8de): the map's trigger-block entry +8 (after every action), +10 (after the
## battle), +12 (the party is down), run nested with var 0 = the entry.
func hook(_b: Dictionary, which: Variant) -> void:
	var hdr: Array = field.events.entries.get("header", [])
	var k: int = {"act": 4, "after": 5, "down": 6}.get(str(which), -1)
	if k < 0 or k >= hdr.size() or not int(hdr[k]):
		return
	await _flush()
	await field.events.run_entry(int(hdr[k]), int(hdr[k]))
	_sync_alive()
	field.render()


## Event battles (f_6e84e): the script at the EVT actor record +6 ("talk") of the actor slot equal to
## the battle record index (not the actor the record was built from: B6X keeps the AI scripts of its
## records 3-5 in actors 3-5) runs each turn, nested like the hooks (f_6b8de -> f_7b1ea: var 0 =
## the entry), and sets the slot ($A1B14, builtin 39).
func enemy_slot(_b: Dictionary, idx: int) -> int:
	state.rt["enemy_action"] = 0
	var actors: Array = field.events.entries.get("actors", [])
	if idx >= 3 and idx - 3 < actors.size() and int(actors[idx - 3]["talk"]):
		await field.events.run_entry(int(actors[idx - 3]["talk"]), int(actors[idx - 3]["talk"]))
	return int(state.rt.get("enemy_action", 0))


## builtin 29 combatantVisible(n, on): record n - 1 shown (bit 7) or hidden (bits 7, 6 cleared).
func combatant_visible(n: int, on: bool) -> void:
	var i := n - 1
	if i < 0 or i >= 8:
		return
	var f: int = BM.br_get(bs, i, 3)
	BM.br_set(bs, i, 3, (f | 0x80) if on else (f & 0x3f))
	_sync_alive()
	field.render()


## builtin 37 combatantHealth(n): alive -> max(1, HP * 10 / max HP) (tenths), else 0. Max HP: the
## enemy's attribute HP (its starting HP) / the character's maximum.
func combatant_health(n: int) -> int:
	var i := n - 1
	if i < 0 or i >= 8 or not (BM.br_get(bs, i, 3) & 0x80):
		return 0
	var hp: int = BM.br_get16(bs, i, BM.R.HP)
	var mx := 1
	if i < 3:
		mx = state.le16(GameState.OFF_CHARS + 40 * SYS.party(state)[i] + 12)
	else:
		var a: Variant = bs["attrs"].get(i)
		mx = (int(a[24]) | (int(a[25]) << 8)) if a != null else 1
	return maxi(1, hp * 10 / maxi(1, mx))


## f_6b7c0: GAME OVER shown, a click, then f_6b87c fades the music out (f_7583a(1)).
func _game_over_click() -> void:
	_game_over_clicked = true
	if not field.auto:
		await ui.wait_click()
	Audio.stop_music(1.0)


# --- presenting the log ------------------------------------------------------------------------------

func _flush() -> void:
	var log: Array = bs.get("log", [])
	while _shown < log.size():
		var e: Dictionary = log[_shown]
		_shown += 1
		if OS.get_cmdline_user_args().has("--battle-log") and str(e["t"]) != "rng":
			print("LOG: ", JSON.stringify(e).left(160))
		if not _pending.is_empty():
			match str(e["t"]):
				"impact":   # the k-th callback run: the k-th impact step (the last one: the end)
					_pending["seen"] = int(_pending["seen"]) + 1
					if int(_pending["seen"]) > 1:
						await _pending_steps(true)
				"effect":   # f_6cc02 after the animation
					await _finish_pending(false)
				"post", "turn", "exec", "end", "death", "levelup":
					await _finish_pending(true)
		match str(e["t"]):
			"msg":
				if int(e.get("addr", 0)) == int(data["message_names"]["defeated"]) and not int(bs.get("event", 0)):
					Audio.play_music("jingle_02")   # f_6df30(2): the victory jingle (not in event battles)
				if int(e.get("addr", 0)) == int(data["message_names"]["quick_fail"]):
					await _game_over_click()   # f_6b87c runs after the GAME OVER click
				if int(e.get("addr", 0)) == int(data["message_names"]["turn"]):
					await _redraws(8)
					await _clear_messages()     # the turn header opens the window (f_6dee4 open = 1)
				await _say(_log_template(e), e["args"])
			"damage":
				var t: int = e["target"]
				if t >= 0 and t < 8:
					sprites[t]["blink"] = 1
					await _redraws(2)
					sprites[t]["blink"] = 0
			"death", "post":
				_sync_alive()
			"help", "split":
				# effects 2 / 3 (f_6d994, f_85d90 -> f_6d3ea): the new record's sprite at its place, idle
				var r: int = int(e["rec"])
				if r >= 3 and r < 8:
					sprites[r]["set"] = _combatant_set(r)
					_start(r, 6, false)
				_reset_positions()
				await _redraws(2)
			"levelup":
				field.events.sound(20)
	await _finish_pending(true)
	_sync_alive()
	await _redraws(1)


## A message line in the message window (English from the glossary templates when there is one).
func _say(tmpl: PackedByteArray, args: Dictionary = {}) -> void:
	var bytes := _expand(tmpl, args)
	if bytes.is_empty():
		return
	if OS.get_cmdline_user_args().has("--battle-log"):
		print("BATTLE: ", GameText.decode(bytes))
	# a wrapped English line takes several rows: clear first when it would run below the window
	if _lines + bytes.count(0x0a) + 1 > MESSAGE.size.y:
		await _redraws(4)
		await _clear_messages()
	ui.print_at(_msg, 0, _lines, bytes)
	_lines = int(_msg["cy"]) + 1
	await _redraws(maxi(1, (state.be16(0x39e) & 0xff) + 1))


func _clear_messages() -> void:
	field.layer.clear_rect(Rect2i(64 + 8 * MESSAGE.position.x - 16, 48 + 16 * MESSAGE.position.y - 16,
		8 * (MESSAGE.size.x + 4), 16 * (MESSAGE.size.y + 2)))
	_lines = 0


func _log_template(e: Dictionary) -> PackedByteArray:
	if int(e.get("str", 0)):
		return _ic_string(int(e["str"]))
	return _template(int(e.get("addr", 0)))


func _template(addr: int) -> PackedByteArray:
	return (data["messages"].get(addr, PackedByteArray()) as PackedByteArray).duplicate()


## Placeholders (f_72286): #n number, *n number in 6 columns, $n a string slot, $$ dollar, &d colour,
## %xy skipped. English: the glossary template of the Japanese text with the slots in English.
func _expand(tmpl: PackedByteArray, a: Dictionary) -> PackedByteArray:
	var nums := [int(a.get("d9e", 0)), int(a.get("da0", 0)), int(a.get("da2", 0))]
	var slots: Array = [_slot(a, 0), _slot(a, 1), _slot(a, 2)]
	var en := GameText.template(GameText.decode(_strip_controls(tmpl)))
	if en != "":
		var text := en
		for n in 3:
			text = text.replace("#%d" % (n + 1), str(nums[n])).replace("*%d" % (n + 1), str(nums[n]).lpad(6))
			text = text.replace("$%d" % (n + 1), GameText.name_of(GameText.decode(slots[n])))
		# word-wrapped to the window (its printer breaks at the last column, mid-word)
		return TextCodec.from_text(TextCodec.wrap(text.replace("$$", "$"), MESSAGE.size.x - 2))
	var out := PackedByteArray()
	var p := 0
	while p < tmpl.size() and tmpl[p] != 0:
		var c := tmpl[p]
		if (c == 0x23 or c == 0x2a) and p + 1 < tmpl.size():
			var v := str(nums[clampi(tmpl[p + 1] - 0x31, 0, 2)])
			out.append_array((v if c == 0x23 else v.lpad(6)).to_ascii_buffer())
			p += 2
		elif c == 0x24 and p + 1 < tmpl.size():
			if tmpl[p + 1] == 0x24:
				out.append(0x24)
			else:
				out.append_array(slots[clampi(tmpl[p + 1] - 0x31, 0, 2)])
			p += 2
		elif c == 0x26:
			p += 2
		elif c == 0x25:
			p += 3
		elif c == 0x0a:
			p += 1
		else:
			out.append(c)
			p += 1
	return out


static func _strip_controls(b: PackedByteArray) -> PackedByteArray:
	var out := b.duplicate()
	while not out.is_empty() and (out[out.size() - 1] < 0x20):
		out.remove_at(out.size() - 1)
	return out


## String slot n: table $9EDB6[n] (-1 IC_TABLE string at $9EDA4[n], -2 a C string, 0 the name of
## id $9EDB0[n], t > 0 the name field of table t record id).
func _slot(a: Dictionary, n: int) -> PackedByteArray:
	var tab: int = int(a.get(["db6", "db8", "dba"][n], 0)) & 0xffff
	var id: int = int(a.get(["db0", "db2", "db4"][n], 0))
	var ptr: int = int(a.get(["da4", "da8", "dac"][n], 0))
	if tab == 0xffff:
		return _ic_string(ptr & 0xffff)
	if tab == 0xfffe:
		return _template(ptr)
	if tab == 0:
		return _name(id)
	var raw: PackedByteArray = data["raw"]
	var o: int = data["off"][tab] + id * int(data["table_stride"][tab]) + int(data["table_name_off"][tab])
	return _ic_string(raw.decode_u16(o) if o + 1 < raw.size() else 0)


func _ic_string(o: int) -> PackedByteArray:
	var raw: PackedByteArray = data["raw"]
	var out := PackedByteArray()
	while o > 0 and o < raw.size() and raw[o] != 0:
		out.append(raw[o])
		o += 1
	return out


func _name(id: int) -> PackedByteArray:
	var raw: PackedByteArray = data["raw"]
	var a: int = data["off"][0]
	while a + 4 < raw.size() and raw[a] != 0xff:
		if raw[a] == id:
			return _ic_string(raw.decode_u16(a + 1))
		a += 5
	return PackedByteArray()


## f_6f9ae: "［ステータス］" and the party's status marks.
func _status_list(b: Dictionary) -> void:
	var marks := ["縛", "麻", "毒", "封", "幻", "眠", "乱"]
	for slot in int(b["n_party"]):
		if not (BM.br_get(b, slot, 3) & 0x80):
			continue
		var line := _name(BM.br_get(b, slot, BM.R.NAME))
		line.resize(12)
		for i in line.size():
			if line[i] == 0:
				line[i] = 0x20
		var f: int = BM.br_get(b, slot, 3)
		var on := [f & 0x40, f & 4, f & 2, BM.br_get(b, slot, 11), BM.br_get(b, slot, 12),
			BM.br_get(b, slot, 15), BM.br_get(b, slot, 16)]
		for m in 7:
			line.append_array(GameText.encode_sjis(marks[m] if on[m] else "－"))
		ui.print_at(_msg, 0, _lines, line)
		_lines += 1


# --- command UI ----------------------------------------------------------------------------------

func _label(k: int) -> PackedByteArray:
	# the label of command code index k is entry k - 1 of the menu table $8CF1A
	var menus: Dictionary = GameData.json("battle/screen.json").get("selector", {}).get("menus", {})
	for key: String in menus:
		var m: Dictionary = menus[key]
		var first := int(m["start"])
		var items: Array = m["items"]
		if k - 1 >= first and k - 1 < first + items.size():
			return Marshalls.base64_to_raw(items[k - 1 - first]["bytes"])
	return PackedByteArray()


## f_81d00: labels at (0, 3k) of the selector window, pointer tile 74 at (592, 80 + 48k).
func _selector(labels: Array) -> int:
	field.layer.clear_rect(Rect2i(64 + 8 * SELECTOR.position.x - 16, 48 + 16 * SELECTOR.position.y - 16,
		8 * (SELECTOR.size.x + 4), 16 * (SELECTOR.size.y + 2)))
	for k in labels.size():
		ui.print_at(_sel, 0, 3 * k, labels[k])
	var sel := 0
	ui.reset_input()
	var last := ui.pointer()
	while true:
		tiles = [[74, Vector2i(592, 80 + 48 * sel)]]
		await _frame()
		var p := ui.pointer()
		if p != last:
			last = p
			var mx := int(p.x) - 64
			var my := int(p.y) / 2 - 24
			if mx >= 8 * SELECTOR.position.x - 40 and mx < 8 * SELECTOR.position.x - 40 + 128:
				for k in labels.size():
					var y0 := 8 * SELECTOR.position.y + 24 * k - 4
					if my >= y0 and my < y0 + 24:
						sel = k
		if ui.pressed("ui_up"):
			sel = posmod(sel - 1, labels.size())
		elif ui.pressed("ui_down"):
			sel = (sel + 1) % labels.size()
		elif ui.pressed("confirm") or ui.clicked(MOUSE_BUTTON_LEFT):
			break
	tiles = []
	field.layer.clear_rect(Rect2i(64 + 8 * SELECTOR.position.x - 16, 48 + 16 * SELECTOR.position.y - 16,
		8 * (SELECTOR.size.x + 4), 16 * (SELECTOR.size.y + 2)))
	return sel


## Spells in the message window: 3 columns x 5 rows; colour 7 = usable in battle.
func _spell_list(c: int) -> int:
	var sl: Variant = SYS.spell_list(state, c)
	if sl == null:
		field.events.sound(UiToolkit.BUZZER)
		return 0
	var entries: Array = []
	var ids: Array = []
	for col: Array in [sl["left"], sl["right"]]:
		for sp: Dictionary in col:
			var e := PackedByteArray([0x0e, 7])
			if field.commands != null:
				e.append_array(field.commands.screens.spell_name(int(sp["spell"])))
			entries.append(e)
			ids.append(int(sp["spell"]))
	if entries.is_empty():
		return 0
	await _clear_messages()
	var r: Dictionary = await ui.run_list(_msg, 0, -1, 0, 3, 5, entries)
	await _clear_messages()
	var k: int = r["index"]
	return ids[k] if k >= 0 and k < ids.size() else 0


## Items in the message window: 1 column x 7 rows.
func _item_list() -> int:
	if field.commands == null:
		return 0
	var e: Array = field.commands.screens.item_entries(3)
	await _clear_messages()
	var r: Dictionary = await ui.run_list(_msg, 0, -1, 0, 1, 7, e[0])
	await _clear_messages()
	var k: int = r["index"]
	if k < 0:
		return 0
	return int(e[1][k]["code"])


func _spell_flags(sp: int) -> int:
	return data["raw"][data["off"][9] + 10 * sp + 7]


func _spell_side(sp: int) -> int:
	return 0 if _spell_flags(sp) & 8 == 0 else 1


func _spell_all(sp: int) -> bool:
	return (_spell_flags(sp) & 0x80) != 0


## f_70a96: side 1 = the enemies in the front row, 0 = the party. Keys left/right cycle, up = all
## (when allowed), confirm; mouse: the combatant's box. Returns the target word or -1.
func _target(b: Dictionary, _idx: int, side: int, all_ok: bool) -> int:
	var cands: Array = []
	if side == 1:
		for i in range(3, 8):
			if (BM.br_get(b, i, 3) & 0x80) and not (BM.br_get(b, i, 3) & 0x10) and BM.br_get(b, i, BM.R.ROW) == 7:
				cands.append(i)
	else:
		for i in int(b["n_party"]):
			if BM.br_get(b, i, 3) & 0x80:
				cands.append(i)
	if cands.is_empty():
		return -1
	var k := 0
	var all := false
	var frames := 0
	ui.reset_input()
	var last := ui.pointer()
	var result := -1
	while true:
		marker = []
		if (frames / 10) % 2 == 0:
			for i: int in (cands if all else [cands[k]]):
				marker.append(Vector2i(BM.br_get(b, i, BM.R.X), BM.br_get(b, i, BM.R.ROW)))
		await _frame()
		frames += 1
		var p := ui.pointer()
		if p != last:
			last = p
			for j in cands.size():
				var x0: int = 192 + 16 * BM.br_get(b, cands[j], BM.R.X)
				var y0: int = 16 * BM.br_get(b, cands[j], BM.R.ROW) - 16
				if p.x >= x0 and p.x < x0 + 48 and p.y >= y0 and p.y < y0 + 96:
					k = j
					all = false
		if ui.pressed("ui_left"):
			k = posmod(k - 1, cands.size())
			all = false
		elif ui.pressed("ui_right"):
			k = (k + 1) % cands.size()
			all = false
		elif ui.pressed("ui_up") and all_ok:
			all = true
		elif ui.pressed("ui_down"):
			all = false
		elif ui.pressed("confirm") or ui.clicked(MOUSE_BUTTON_LEFT):
			result = (0x80 | cands[k]) if all else cands[k]
			break
		elif ui.pressed("cancel") or ui.clicked(MOUSE_BUTTON_RIGHT):
			break
	marker = []
	return result


# --- sprites and animation -------------------------------------------------------------------------

func _init_sprites() -> void:
	sprites.clear()
	for i in 16:
		sprites.append({"set": null, "frame": 0, "x": 0, "y": 0, "layer": 0, "visible": 0, "blink": 0,
			"seq": -1, "step": 0, "once": false})
	for i in 8:
		if not (BM.br_get(bs, i, 3) & 0x80):
			continue
		var s: Dictionary = sprites[i]
		s["set"] = _combatant_set(i)
		s["visible"] = 0x80
		_start(i, BM.br_get(bs, i, BM.R.POSE), false)
	_reset_positions()


func _combatant_set(i: int):
	if i < 3:
		var c: int = SYS.party(state)[i]
		return SpriteSet.load_set(PARTY_SETS[c]) if c >= 0 and c < 8 else null
	return SpriteSet.load_set(_battle_set_name(BM.br_get(bs, i, BM.R.NAME)))


## Sprite set id -> battle sprite set (f_6858e(4): ICITY.FIL + 3229 byte 1 -> table 9; battledata).
func _battle_set_name(id: int) -> String:
	if _set_names.is_empty():
		var m: Dictionary = GameData.json("data/battle.json").get("battleSets", {})
		for k: String in m:
			_set_names[k.to_int()] = str(m[k])
	return _set_names.get(id, "")


func _reset_positions() -> void:
	for i in 8:
		var s: Dictionary = sprites[i]
		s["x"] = BM.br_get(bs, i, BM.R.X)
		s["y"] = BM.br_get(bs, i, BM.R.ROW)
		var e: Dictionary = sprites[i + 8]
		e["visible"] = 0
	_sync_alive()


func _sync_alive() -> void:
	for i in 8:
		var s: Dictionary = sprites[i]
		var alive: bool = (BM.br_get(bs, i, 3) & 0x80) != 0
		if i < 3 and not alive and s["set"] != null:
			_start(i, 1, false)          # KO pose
			s["visible"] = 0x80
		else:
			s["visible"] = 0x80 if alive and s["set"] != null else 0


func _start(i: int, action: int, once: bool) -> void:
	var s: Dictionary = sprites[i]
	if s["set"] == null:
		return
	var seq: int = s["set"].sequence_of(action)
	if seq < 0:
		seq = s["set"].sequence_of(6)
	s["seq"] = seq
	s["step"] = 0
	s["once"] = once
	var steps: Array = s["set"].steps(seq)
	if not steps.is_empty():
		s["frame"] = int(steps[0]["frame"])


## One battle redraw: the background layers scroll (f_73934), every sprite one step (one-shots
## return to their idle pose at the end).
func _advance() -> void:
	view.tile_anim_step()
	view.scroll_step()
	for i in sprites.size():
		var s: Dictionary = sprites[i]
		if s["set"] == null or int(s["seq"]) < 0 or not (int(s["visible"]) & 0x80):
			continue
		var steps: Array = s["set"].steps(int(s["seq"]))
		if steps.is_empty():
			continue
		var n: int = int(s["step"]) + 1
		if n >= steps.size():
			if s["once"]:
				if i >= 8:
					s["visible"] = 0
					continue
				_start(i, BM.br_get(bs, i, BM.R.POSE), false)
				continue
			n = 0
		s["step"] = n
		s["frame"] = int(steps[n]["frame"])


## One frame of an input loop: input is read every frame, the arena animates every $9CB30 vsyncs.
func _frame() -> void:
	_frames += 1
	if _frames >= maxi(1, state.be16(0x39c) & 0xff):
		_frames = 0
		_advance()
	field.render()
	await field.get_tree().process_frame


func _redraws(n: int) -> void:
	var vs := maxi(1, state.be16(0x39c) & 0xff)
	for k in n:
		_advance()
		field.render()
		await field.get_tree().create_timer(vs / FRAME_RATE).timeout


## Play an action once on record i (and the effect sprite at its impact frame; trigger $A1AC6 picks
## the effect set, f_6ce6c).
func _play(i: int, action: int, effect := 0, trigger := 1) -> void:
	if sprites[i]["set"] == null:
		return
	_start(i, action, true)
	var steps: Array = sprites[i]["set"].steps(int(sprites[i]["seq"]))
	for k in steps.size():
		if effect and (int(steps[k]["flags"]) & 1):
			_effect_on(i, effect, true, trigger)
		if int(steps[k]["flags"]) & 2:
			field.events.sound(int(sprites[i]["set"].sound(int(sprites[i]["seq"]))))
		await _redraws(1)
	_start(i, BM.br_get(bs, i, BM.R.POSE), false)


## The effect sprite (slot 8 + rec) plays `effect` once at the record (or where it was placed).
## f_6ce6c: trigger 2 (enemy actions) -> the map's set 2; else effect <= $9F set 0, > $9F set 1.
## The effects of f_6cc02 (f_6e676) run after it set the trigger to 1: sets 0 / 1.
func _effect_on(rec: int, effect: int, placed := false, trigger := 1) -> void:
	var e: Dictionary = sprites[8 + rec]
	var set_name := _effect_set(0 if effect <= 0x9f else 1)
	if trigger == 2:
		set_name = _effect_set(2)
		if set_name == "":
			return   # no set 2 on this map: the original shows whatever slot 20 holds
	e["set"] = SpriteSet.load_set(set_name)
	if not placed:
		e["x"] = BM.br_get(bs, rec, BM.R.X)
		e["y"] = BM.br_get(bs, rec, BM.R.ROW) - 1
	e["visible"] = 0x80
	e["layer"] = 1
	_start(8 + rec, effect, true)


## Effect set n (battle/effects.json, tools/export/battle.mjs exportEffects): 0 / 1 shared, 2 the
## current map's ("" when the map has none).
func _effect_set(n: int) -> String:
	var m: Dictionary = GameData.json("battle/effects.json") if GameData.exists("battle/effects.json") else {}
	if n == 2:
		return str(m.get("maps", {}).get(field.map.id, {}).get("set", ""))
	return str(m.get("sets", {}).get(str(n), EFFECT_SETS[n]))


func _has_flag(rec: int, action: int, bit: int) -> bool:
	return _count_flag(rec, action, bit) > 0


func _count_flag(rec: int, action: int, bit: int) -> int:
	var sset = sprites[rec]["set"] if rec >= 0 and rec < 8 else null
	if sset == null:
		return 0
	var n := 0
	for st: Dictionary in sset.steps(sset.sequence_of(action)):
		if int(st["flags"]) & bit:
			n += 1
	return n


## The action struct ($A1A9A) bytes the presentation reads, from the logic's action.
func _action_struct(act: Dictionary) -> Dictionary:
	var targets: Array = act["targets"].filter(func(t: int) -> bool: return t >= 0)
	return {"count": targets.size(), "targets": targets, "trigger": int(act.get("anim0", 0)),
		"type": int(act.get("kind", 0)), "pose": int(act.get("emult", 0)), "b47": int(act.get("effect", 0)),
		"action": int(act.get("anim1", 0)), "effect": int(act.get("anim2", 0)), "b50": int(act.get("anim3", 0)),
		"b51": int(act.get("element", 0)), "lunge": int(act.get("anim_type", 0)), "place": int(act.get("anim_sub", 0))}


func _rec_info(b: Dictionary) -> Array:
	var out: Array = []
	for i in 8:
		out.append({"spr": BM.br_get(b, i, BM.R.SPR), "idle": BM.br_get(b, i, BM.R.POSE)})
	return out


# --- setup data from the field ---------------------------------------------------------------------

## The 32 actor records ($9F722, 20 bytes) from the field: x, y, facing, flags, slot, set id.
func _actor_bytes() -> PackedByteArray:
	var b := PackedByteArray()
	b.resize(640)
	for i in 32:
		var a = field.field.act[i]
		var o := 20 * i
		b.encode_s16(o, a.x)
		b.encode_s16(o + 2, a.y)
		b[o + 4] = a.facing & 3
		b[o + 5] = a.flags & 0xff
		b[o + 8] = i
		b[o + 9] = int(field.events.sprites[i].get("set_id", 0xff)) & 0xff
		b[o + 14] = a.h
		b[o + 15] = a.w
	return b


## Enemy attributes: the 32 CG9 attribute bytes of the actor's battle sprite set (the battle
## loads those, f_6858e(4); they hold the enemy's stats).
func _attr_of(actor: int) -> Variant:
	if actor < 0 or actor >= 32:
		return null
	var id: int = int(field.events.sprites[actor].get("set_id", 0xff))
	var bset = SpriteSet.load_set(_battle_set_name(id)) if id != 0xff else null
	var a: Array = bset.data.get("attributes", []) if bset != null else []
	if a.is_empty():
		var fset = field.events.sprites[actor].get("set")
		a = fset.data.get("attributes", []) if fset != null else []
	if a.is_empty():
		return null
	var out := PackedByteArray()
	for k in 32:
		out.append(int(a[k]) if k < a.size() else 0)
	return out


## Actor type (f_6dc14): attribute 9 of the actor's field sprite set.
func _type_of(actor: int) -> int:
	if actor < 0 or actor >= 32:
		return -1
	var fset = field.events.sprites[actor].get("set")
	var a: Array = fset.data.get("attributes", []) if fset != null else []
	return int(a[9]) if a.size() > 9 else -1


func _data_of(actor: int) -> Dictionary:
	return {"off": actor, "sheet_bytes": PackedByteArray([0, 0, 0, 0])}


func _party_actors() -> Array:
	var out: Array = []
	for slot in 3:
		out.append({"slot": slot, "set": SYS.party(state)[slot], "off": slot, "sheet_bytes": PackedByteArray([0, 0, 0, 0])})
	return out


## After the battle: the actors that fought leave the map (flags written by the formation).
func _apply_actors() -> void:
	var b: PackedByteArray = bs.get("actors", PackedByteArray())
	for i in range(3, 32):
		if 20 * i + 5 < b.size() and not (b[20 * i + 5] & 0x80) and (field.field.act[i].flags & 0x80):
			field.field.act[i].flags = b[20 * i + 5]
			field.events.sprites[i]["visible"] = 0


func _play_battle_music() -> void:
	var m: Dictionary = GameData.json("battle/music.json") if GameData.exists("battle/music.json") else {}
	var per_map: Dictionary = m.get("battleMusic", {})
	if per_map.has(field.map.id):
		field.play_music_file(str(per_map[field.map.id].get("file", "")))
