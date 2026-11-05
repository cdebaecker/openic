extends "res://scripts/battle/battle_data_effects.gd"
## The ICITY68 battle logic (milestone 6). Spec: docs/battle.md. A function-by-function
## transcription of the verified reference model tools/battle/model.mjs (same names in
## snake_case, same argument order; objects are Dictionaries with snake_case keys). Checked
## against the reference by tools/battle/golden.mjs + scripts/dev/battle_test.gd.
##
##   const BM := preload("res://scripts/battle/battle_model.gd")
##   var data := BM.load_battle_data()                       # IC_TABLE + ICITY68 constants
##   var bs := BM.setup_battle(state, data, {"mode": 1, "actor": 4, "actors": ..., "attr_of": f, ...})
##   var r = await BM.run_battle(state, data, bs, rng, host)  # "victory" | "fled" | "defeat"
##   bs["log"]                                               # what happened (format of model.mjs)
##
## state = GameState, rng = CRand, bs = battle state (new_battle): br (PackedByteArray of the 8
## records, 36 bytes each, fields R), gauge, gauge_max, n_party, order, attrs {record: 32 bytes},
## mode, event, scripted, group, exp, money, poison_party, poison_enemy, last_magic_target,
## cursor, over (null or the result), act (the action, clear_act), mg (message globals), log.
##
## host: an Object; every call is awaited (the battle runs interactively), so every function that
## can reach one is a coroutine and must be awaited:
##   command(bs, idx, attempt) -> {cmd, spell, item, target}   (missing keys: not given)
##   impacts(bs, idx) -> int
##   hook(bs, which)            optional (event battles: "act" / "down" / "after")
##   enemy_slot(bs, idx) -> int optional (event battles)
## Log entries: Dictionaries with the keys of the JS log ("t": "rng" / "turn" / "msg" / "command" /
## "exec" / "impact" / "damage" / "effect" / "death" / "post" / "levelup" / "unmodelled" / "end").
##
## The model is split over four scripts that extend each other (GDScript files stay under 1000
## lines): battle_data_core.gd (records, messages, targets, damage) <- battle_data_setup.gd
## (new_battle, setup_battle) <- battle_data_effects.gd (apply_effect) <- this script (the loop,
## turns, commands, execution, victory). Every function is static and reachable through this one.


## f_6ae4c loop: f_6b094 until a victory, a flight or a defeat (coroutine)
static func run_battle(s: GameState, data: Dictionary, bs: Dictionary, rng: CRand, host: Object) -> Variant:
	var guard := 0
	while bs["over"] == null and guard < 100000:
		guard += 1
		await tick(s, data, bs, rng, host)
	if bs["over"] == "victory":
		await victory(s, data, bs, rng, host)
	finish_battle(s, bs)
	bs["log"].append({"t": "end", "result": bs["over"]})
	return bs["over"]


## f_6abca's end: the party size saved at the start is restored (null: bs.party_count_saved)
static func finish_battle(s: GameState, bs: Dictionary, party_count: Variant = null) -> void:
	if party_count == null:
		party_count = bs.get("party_count_saved")
	if party_count == null:
		return
	s.block[GameState.OFF_PARTY_COUNT] = (int(party_count) >> 8) & 255
	s.block[GameState.OFF_PARTY_COUNT + 1] = int(party_count) & 255


## a battle built with new_battle (records after setup): the same loop, then the end (coroutine)
static func run_records(s: GameState, data: Dictionary, bs: Dictionary, rng: CRand, host: Object,
		party_count: Variant = null) -> Variant:
	var guard := 0
	while bs["over"] == null and guard < 100000:
		guard += 1
		await tick(s, data, bs, rng, host)
	if bs["over"] == "victory":
		await victory(s, data, bs, rng, host)
	finish_battle(s, bs, party_count)
	bs["log"].append({"t": "end", "result": bs["over"]})
	return bs["over"]


## f_6b094: one pass over the 8 records (coroutine)
static func tick(s: GameState, data: Dictionary, bs: Dictionary, rng: CRand, host: Object) -> void:
	var i: int = bs["cursor"]
	while i < 8 and bs["over"] == null:
		bs["cursor"] = i
		await step_record(s, data, bs, rng, host, i)
		bs["cursor"] = i + 1
		i += 1
	if bs["over"] == null:
		bs["cursor"] = 0


## one combatant: gauge, turn, then the checks that follow every record (coroutine)
static func step_record(s: GameState, data: Dictionary, bs: Dictionary, rng: CRand, host: Object, i: int) -> void:
	if _alive(bs, i):
		var agi := br_get(bs, i, R.AGI)
		var g: int = agi + bs["gauge"][i] + (_draw(bs, rng, agi, "gauge") >> 3)
		if g > 255:
			g = 255
		bs["gauge"][i] = g & 255
		var rest: int = g - bs["gauge_max"]
		if rest >= 0:
			bs["gauge"][i] = rest & 255
			bs["log"].append({"t": "turn", "idx": i})
			if _is_party(bs, i):
				await _party_turn(s, data, bs, rng, host, i)
			else:
				await _enemy_turn(s, data, bs, rng, host, i)
			await _run_hook(bs, host, "act")
			_settle(bs)
			if bs["over"] != null:
				return
	_write_back(s, bs)
	await _defeat_check(s, bs, host)
	if bs["over"] != null:
		return
	await _run_hook(bs, host, "act")
	if not _victory_check(bs):
		bs["over"] = "victory"
	bs["log"].append({"t": "post", "idx": i})


static func _run_hook(bs: Dictionary, host: Object, which: String) -> void:
	if bs["event"] and host != null and host.has_method("hook"):
		await host.hook(bs, which)


## f_6d09a: a record whose flash counter runs out with 0 HP dies (unless CF bit 1)
static func _settle(bs: Dictionary) -> void:
	for i in 8:
		if not _alive(bs, i) or not br_get(bs, i, R.FLASH):
			continue
		br_set(bs, i, R.FLASH, 0)
		if br_get16(bs, i, R.HP) == 0 and not (br_get(bs, i, R.CF) & 2):
			br_set(bs, i, R.F, br_get(bs, i, R.F) & 0x7f)
			bs["log"].append({"t": "death", "idx": i})


## f_6b6fc: party records -> character records (HP, MP)
static func _write_back(s: GameState, bs: Dictionary) -> void:
	for k in int(bs["n_party"]):
		var c := _char_of_slot(s, k)
		_set_cw(s, c, 10, br_get16(bs, k, R.MP))
		_set_cw(s, c, 14, br_get16(bs, k, R.HP))


## f_6b7c0: nobody in slots 0-2 alive and free of paralysis/stone -> game over (coroutine)
static func _defeat_check(s: GameState, bs: Dictionary, host: Object) -> void:
	for k in 3:
		if _alive(bs, k) and not (br_get(bs, k, R.F) & 5):
			return
	await _run_hook(bs, host, "down")
	_msg(bs, M["game_over"])
	if not s.rt.get("checkpoint", 0):
		_msg(bs, M["quick_fail"])   # f_6b87c: no checkpoint to restore
	bs["over"] = "defeat"


## f_6b322: enemies left in the front row? else the back row moves up; none -> 0 (victory)
static func _victory_check(bs: Dictionary) -> int:
	if _count_row(bs, 3, 5, 7):
		return 1
	if not _count_row(bs, 3, 5, 6):
		return 0
	for i in range(3, 8):
		if _alive(bs, i):
			br_set(bs, i, R.ROW, 7)
	return 1


## f_6b3c4: messages, money, experience and level-ups, the item find (coroutine)
static func victory(s: GameState, data: Dictionary, bs: Dictionary, rng: CRand, host: Object) -> void:
	await _run_hook(bs, host, "after")
	var mg: Dictionary = bs["mg"]
	_msg(bs, M["defeated"])
	mg["d9e"] = bs["exp"] & 0xffff
	if bs["exp"] & 0xffff:
		_msg(bs, M["exp"])
	mg["d9e"] = bs["money"] & 0xffff
	if bs["money"] & 0xffff:
		_msg(bs, M["money"])
	var m2: int = (s.be16(GameState.OFF_MONEY) << 16 | s.be16(GameState.OFF_MONEY + 2)) + bs["money"]
	m2 &= 0xffffffff
	s.set_be16(GameState.OFF_MONEY, m2 >> 16)
	s.set_be16(GameState.OFF_MONEY + 2, m2 & 0xffff)
	_gain_exp(s, bs, rng)
	_item_find(s, data, bs, rng)


## f_6b4fa: every living party record gets the experience, then level-ups (f_81b2e)
static func _gain_exp(s: GameState, bs: Dictionary, rng: CRand) -> void:
	var draw := func(n: int) -> int: return _draw(bs, rng, n, "levelUp")
	for k in int(bs["n_party"]):
		if not _alive(bs, k):
			continue
		var slot := br_get(bs, k, R.SPR)
		var c := _party_word(s, slot)
		var e := SYS.add_exp(s, c, bs["exp"])
		while true:
			var need := SYS.exp_needed(s, c)
			if not need or need > e:
				break
			SYS.level_up(s, c, draw)
			bs["log"].append({"t": "levelup", "slot": slot, "char": c, "level": _cb(s, c, 3)})
			bs["mg"]["db6"] = 0
			bs["mg"]["db0"] = br_get(bs, k, R.NAME)
			bs["mg"]["d9e"] = _cb(s, c, 3)
			_msg(bs, M["level_up"])


## f_6b63e: 1/16, money won, not an event battle: item 61 / 62 / 63 by the money
static func _item_find(s: GameState, data: Dictionary, bs: Dictionary, rng: CRand) -> void:
	if _draw(bs, rng, 16, "itemFind") != 0 or not bs["money"] or bs["event"]:
		return
	var money: int = bs["money"]
	var code := 0x3d if money <= 299 else (0x3e if money <= 2999 else 0x3f)
	if _give_item(s, code, 1):
		return
	bs["mg"]["db6"] = 0xffff
	bs["mg"]["da4"] = rd16(data["raw"], _t4(data, code))
	_msg(bs, M["found"])


## the animation's impact callback $6BC10, up to host.impacts times; any hit disarms it (coroutine)
static func _impact_rounds(s: GameState, data: Dictionary, bs: Dictionary, rng: CRand, host: Object, i: int) -> void:
	var n := 2
	if host != null and host.has_method("impacts"):
		n = int(await host.impacts(bs, i))
	bs["cb_armed"] = true
	var k := 0
	while k < n and bs["cb_armed"]:
		bs["log"].append({"t": "impact", "idx": i})
		for t: int in bs["act"]["targets"]:
			if hit_check(bs, rng, i, t, bs["act"]["hit"]):
				apply_damage(s, data, bs, t)
		k += 1
	bs["cb_armed"] = false


## f_6b206 (coroutine)
static func _party_turn(s: GameState, data: Dictionary, bs: Dictionary, rng: CRand, host: Object, i: int) -> void:
	await _choose(s, data, bs, rng, host, i)
	await _exec_party(s, data, bs, rng, host, i)


## f_6f888 (coroutine: asks host.command)
static func _choose(s: GameState, data: Dictionary, bs: Dictionary, rng: CRand, host: Object, i: int) -> void:
	clear_act(bs)
	bs["forced"] = 0
	_equip_status(s, bs, i)
	if not _can_act(bs, i):
		return
	if br_get(bs, i, R.F) & 0x45:
		_msg_t(bs, i, M["cant_act"])
		return
	var list := command_list(s, bs, i)
	var forced := (br_get(bs, i, R.CF) & 2) != 0 or br_get(bs, i, R.CONF) != 0
	var attempt := 0
	while true:
		bs["mg"]["db6"] = 0
		bs["mg"]["db0"] = br_get(bs, i, R.NAME)
		_msg(bs, M["turn"])
		var code := 0
		var choice := {}
		if forced:
			bs["forced"] = 1
			code = data["cmd_codes"][list + 1]
		else:
			var ans: Variant = await host.command(bs, i, attempt)
			if ans is Dictionary:
				choice = ans
			code = int(_opt(choice, "cmd", 0))
		bs["log"].append({"t": "command", "idx": i, "code": code, "attempt": attempt})
		if _run_command(s, data, bs, rng, host, i, code, choice):
			return
		if forced:
			bs["act"]["kind"] = 2
			bs["act"]["targets"] = []
			return
		attempt += 1


## f_6f3a2: equipment statuses (character +38 bits 4, 3, 2), then f_6f25a
static func _equip_status(s: GameState, bs: Dictionary, i: int) -> void:
	var b := _cb(s, _char_of(s, bs, i), 38)
	if b & 0x10:
		br_set(bs, i, R.F, br_get(bs, i, R.F) | 4)
	if b & 0x08:
		br_set(bs, i, R.CONF, 2)
	if b & 0x04:
		_msg_t(bs, i, M["judgement"])
		br_set(bs, i, R.CONF, 2)
	_turn_status(s, bs, i, {})


## f_6f25a: poison (damage 4 * $A1B18 / $A1B1A), then the status counters count down
static func _turn_status(s: GameState, bs: Dictionary, i: int, data: Dictionary) -> void:
	if br_get(bs, i, R.F) & 2:
		_msg_t(bs, i, M["poisoned"])
		bs["act"]["dmg"] = s16(4 * (bs["poison_party"] if _is_party(bs, i) else bs["poison_enemy"]))
		apply_damage(s, data, bs, i)
	var ends := {R.SEAL: "unsealed", R.ILLU: "unillusion", R.SLEEP: "awake", R.CONF: "sane", R.CLONE: "unclone"}
	for f: int in COUNTERS:
		if br_get(bs, i, f):
			br_set(bs, i, f, br_get(bs, i, f) - 1)
			if not br_get(bs, i, f) and _fixed(bs, "status_messages"):
				_msg_t(bs, i, M[ends[f]])


## f_6f480: defending ends; asleep -> no action; confused -> message
static func _can_act(bs: Dictionary, i: int) -> int:
	br_set(bs, i, R.F, br_get(bs, i, R.F) & ~0x20)
	if br_get(bs, i, R.SLEEP):
		_msg_t(bs, i, M["asleep"])
		return 0
	if br_get(bs, i, R.CONF):
		_msg_t(bs, i, M["confused"])
	return 1


## f_717b6: offset of the member's command list in $8D092 (by character; 2 transformed -> claws)
static func command_list(s: GameState, bs: Dictionary, i: int) -> int:
	var r := 0
	match _char_of(s, bs, i):
		1, 5:
			r = 6
		2:
			r = 17 if br_get(bs, i, R.POSE) == 15 else 11
		4:
			r = 21
		6:
			r = 27
	return r


## f_6fb62: the command handlers; 0 = refused (asked again)
static func _run_command(s: GameState, data: Dictionary, bs: Dictionary, rng: CRand, _host: Object, i: int,
		code: int, ch: Dictionary) -> int:
	clear_act(bs)
	var act: Dictionary = bs["act"]
	var mg: Dictionary = bs["mg"]
	var r := 0
	match code:
		1:
			r = _cmd_attack(s, data, bs, rng, i, ch)
		2:   # f_7019e defend
			act.merge({"anim0": 1, "kind": 3}, true)
			r = 1
		3:   # f_701b8 flee
			act.merge({"targets": _targets_all(bs, i, 3, 8), "msg": M["fled"], "anim0": 1, "kind": 6}, true)
			r = 1
		4:   # f_70212 magic
			if br_get(bs, i, R.SEAL):
				_msg_t(bs, i, M["sealed"])
			else:
				r = _cast_spell(s, data, bs, rng, i, ch)
		5:
			r = _cmd_item(s, data, bs, rng, i, ch)
		6:   # f_706b8 transform
			act.merge({"msg": M["transform"], "anim0": 1, "kind": 2, "emult": 11}, true)
			r = 1
		7:
			act.merge({"anim1": 0x2a, "kind": 2, "emult": 13, "mult": 4, "anim_type": 3}, true)
			bs["allowed"] = 0x40
			mg.merge({"dba": 0xfffe, "dac": 0x8d22c}, true)
			r = _cmd_special(s, data, bs, rng, i, ch)
		8:
			act.merge({"anim1": 0x2b, "kind": 2, "emult": 12, "mult": 8, "effect": 0x47, "anim_type": 2}, true)
			bs["allowed"] = 0x80
			mg.merge({"dba": 0xfffe, "dac": 0x8d22f}, true)
			r = _cmd_special(s, data, bs, rng, i, ch)
		9:
			act.merge({"anim1": 0x19, "kind": 2, "emult": 7, "effect": 0, "anim2": 0, "anim_type": 0}, true)
			mg.merge({"dba": 0xfffe, "dac": 0x8d21a}, true)
			r = _cmd_gun(s, data, bs, rng, i, ch, 4, 10, 0)
		10:
			act.merge({"anim1": 0x1e, "kind": 2, "emult": 9, "mult": 2, "anim_type": 0}, true)
			mg.merge({"dba": 0xfffe, "dac": 0x8d209}, true)
			r = _cmd_gun(s, data, bs, rng, i, ch, 6, 0, 10)
		11:
			act.merge({"anim1": 9, "kind": 2, "emult": 8, "anim2": 0x9d, "anim_type": 0, "anim_sub": 1,
				"mult": 10}, true)
			mg.merge({"dba": 0xfffe, "dac": 0x8d200}, true)
			r = _cmd_gun(s, data, bs, rng, i, ch, 8, 100, 0)
		13:   # f_701fc (薬仙術): f_702d0 alone, no seal check, no cost
			r = _cast_spell(s, data, bs, rng, i, ch, false)
	return r


## f_6fc68: weapon attack
static func _cmd_attack(s: GameState, data: Dictionary, bs: Dictionary, rng: CRand, i: int, ch: Dictionary) -> int:
	var c := _char_of(s, bs, i)
	var w := _cb(s, c, 23)
	if not w:
		return 0
	var raw: PackedByteArray = data["raw"]
	var d := _weapon_data(data, w)
	bs["mg"]["dba"] = 0xffff
	bs["mg"]["dac"] = rd16(raw, _t6(data, w))
	var b5 := _rb(raw, d + 5)
	bs["act"].merge({"anim1": _rb(raw, d + 8), "anim2": _rb(raw, d + 9), "effect": _rb(raw, d),
		"anim_type": 1 if b5 & 0x40 else 0, "anim_sub": 1 if b5 & 0x20 else 0, "element": 0, "anim0": 1,
		"actor": i, "kind": 2, "msg": M["attack_with"], "emult": _rb(raw, d + 4)}, true)
	var cands := _cand_front(bs, rng, i)
	if cands.is_empty():
		return 0
	var type := b5 & 15
	var burst := _rb(raw, d + 6)
	var single := _rb(raw, d + 7)
	bs["allowed"] = (0x80 if burst else 0) | (0x40 if single or not burst else 0)
	var t := _pick_targets(bs, rng, i, cands, ch, br_get(bs, i, R.LAST))
	br_set(bs, i, R.LAST, t & 255)
	var rounds := burst if (t & 0xff) > 0x7f else single
	var ammo := _use_ammo(s, data, bs, type, rounds)
	if not ammo.x:
		_out_of_ammo(data, bs, i)
		return 0
	if ammo.y >= 0:
		var ic := s.le16(ammo.y)
		var e := _rb(raw, _t4(data, ic) + 4)
		if e:
			bs["act"]["effect"] = e
			bs["act"]["anim2"] = _rb(raw, _t4(data, ic) + 7)
	var p: int = _char_rec(c) + 28 + 2 * data["skill_word"][_rb(raw, d + 4) & 7]
	var sk := (s.le16(p) + 1) & 0xffff
	s.set_le16(p, sk)
	bs["act"]["skill"] = sk
	if s16(sk) > 1600:
		sk = 1600
		s.set_le16(p, sk)
	var hit := ((16 * s16(sk) + 15) / 42) & 0xffff
	bs["act"]["hit"] = hit
	if (t & 0xff) > 0x7f:
		if bs["act"]["anim1"] == 0x18:
			bs["act"]["anim1"] = 0x19
		elif bs["act"]["anim1"] == 0x1b:
			bs["act"]["anim1"] = 0x15
	return 1


## f_7111c(rounds, type): ammunition item 17 + type -> (ok, slot offset or -1)
static func _use_ammo(s: GameState, _data: Dictionary, _bs: Dictionary, type: int, rounds: int) -> Vector2i:
	if not type:
		return Vector2i(1, -1)
	var p := _find_slot(s, (type + 0x11) & 0xff)
	var have := s.le16(p + 2) if p >= 0 else 0
	var left := s16(have - rounds)
	if left < 0:
		return Vector2i(0, -1)
	if p >= 0:
		s.set_le16(p + 2, left)
	return Vector2i(1, p)


static func _out_of_ammo(data: Dictionary, bs: Dictionary, i: int) -> void:
	var e := _tbl(data, 10) + 16 * br_get(bs, i, R.NAME)
	_msg(bs, 0, rd16(data["raw"], e + 4))


## f_707a0: claws / 光身裂気: target cursor over the front row
static func _cmd_special(_s: GameState, _data: Dictionary, bs: Dictionary, rng: CRand, i: int, ch: Dictionary) -> int:
	bs["act"].merge({"anim0": 1, "actor": i, "msg": M["attack_with"], "anim_sub": 0}, true)
	var cands := _cand_front(bs, rng, i)
	var t := _pick_targets(bs, rng, i, cands, ch, br_get(bs, i, R.LAST))
	br_set(bs, i, R.LAST, t & 255)
	return 1


## f_7097a: the robot's guns (ammunition type, burst rounds, single rounds)
static func _cmd_gun(s: GameState, data: Dictionary, bs: Dictionary, rng: CRand, i: int, ch: Dictionary,
		type: int, burst: int, single: int) -> int:
	bs["act"].merge({"anim0": 1, "actor": i, "msg": M["attack_with"]}, true)
	var cands := _cand_front(bs, rng, i)
	bs["allowed"] = (0x80 if burst else 0) | (0x40 if single or not burst else 0)
	var t := _pick_targets(bs, rng, i, cands, ch, br_get(bs, i, R.LAST))
	br_set(bs, i, R.LAST, t & 255)
	var rounds := burst if t > 0x7f else single
	var ammo := _use_ammo(s, data, bs, type, rounds)
	if not ammo.x:
		_out_of_ammo(data, bs, i)
		return 0
	return 1


## f_702d0: the spell and its targets; with pay, f_70212's cost after it (cmdMagic / castSpell of
## model.mjs)
static func _cast_spell(s: GameState, data: Dictionary, bs: Dictionary, rng: CRand, i: int, ch: Dictionary, pay := true) -> int:
	var sp := int(_opt(ch, "spell", 0))
	if not sp or sp == 0x80:
		return 0
	var raw: PackedByteArray = data["raw"]
	var r := _t9(data, sp)
	var flags := raw[r + 7]
	if not (flags & 0x20) or (bs["event"] and (flags & 1)):
		return 0
	bs["mg"].merge({"db6": 0, "db0": br_get(bs, i, R.NAME), "dba": 0xffff, "dac": rd16(raw, r)}, true)
	bs["act"].merge({"msg": M["cast"], "effect": raw[r + 4], "element": raw[r + 6], "anim2": raw[r + 9],
		"anim_type": 0, "anim0": 1, "anim3": raw[r + 9], "actor": i, "kind": 5}, true)
	bs["act"]["anim_sub"] = 0 if flags & 2 else (2 if flags & 8 else 1)
	bs["act"]["anim1"] = 0x29 if flags & 8 else 0x28
	bs["allowed"] = flags
	var t := _select_targets(s, data, bs, rng, i, ch, flags, bs["last_magic_target"])
	bs["last_magic_target"] = t
	if not pay:
		return 1
	# f_713ac: cost (single: only if flags bit 6, all: cost * 4 only if bit 7), -25 % with +36 bit 7
	var cost := raw[r + 5]
	if t > 0x7f:
		cost = cost * 4 if flags & 0x80 else 0
	elif not (flags & 0x40):
		cost = 0
	if _is_party(bs, i) and (_cb(s, _char_of(s, bs, i), 36) & 0x80):
		cost -= cost >> 2
	# f_7141a: the character's MP pays; written to the battle record and the character
	var c := _char_of(s, bs, i)
	var left := s16(_cw(s, c, 10) - cost)
	if left < 0:
		return 0
	br_set16(bs, i, R.MP, left & 0xffff)
	_set_cw(s, c, 10, left & 0xffff)
	return 1


## f_70002: message, then the candidates by flags and the target word
static func _select_targets(_s: GameState, _data: Dictionary, bs: Dictionary, rng: CRand, i: int, ch: Dictionary,
		flags: int, initial: int) -> int:
	_act_msg(bs)
	var cands: Array
	if flags & 8:
		cands = _targets_all(bs, i, 3, 5, rng)
	elif flags & 2:
		cands = _targets_all(bs, i, 0, 8, rng) if br_get(bs, i, R.CONF) else [i]
	else:
		cands = _list_alive(bs, 0, 3)
	return _pick_targets(bs, rng, i, cands, ch, initial)


## f_70496: item (58-60 only for characters 1 and 2), consumed unless reusable
static func _cmd_item(s: GameState, data: Dictionary, bs: Dictionary, rng: CRand, i: int, ch: Dictionary) -> int:
	var code := int(_opt(ch, "item", -1))
	if code == -1 or code == 0x80:
		return 0
	var raw: PackedByteArray = data["raw"]
	var r := _t4(data, code)
	bs["mg"].merge({"db6": 0, "db0": br_get(bs, i, R.NAME), "dba": 0xffff, "dac": rd16(raw, r)}, true)
	var c := _char_of(s, bs, i)
	if code >= 0x3a and code <= 0x3c:
		if c != 1 and c != 2:
			_msg(bs, M["cant_use"])
			return 0
		bs["act"]["anim1"] = 0x22
	else:
		bs["act"]["anim1"] = 6
	var flags := _rb(raw, r + 5)
	bs["act"].merge({"msg": M["use_item"], "effect": _rb(raw, r + 4), "element": _rb(raw, r + 6), "anim_type": 0,
		"anim_sub": 1, "anim0": 1, "actor": i, "kind": 0}, true)
	bs["allowed"] = flags
	_select_targets(s, data, bs, rng, i, ch, flags, int(_opt(ch, "target", i)))
	if not (flags & 4):
		_take_item(s, code, 1)
	return 1


static func _exec_party(s: GameState, data: Dictionary, bs: Dictionary, rng: CRand, host: Object, i: int) -> void:
	bs["mg"]["db6"] = 0
	bs["mg"]["db0"] = br_get(bs, i, R.NAME)
	bs["log"].append({"t": "exec", "idx": i, "kind": bs["act"]["kind"], "targets": bs["act"]["targets"].duplicate()})
	match bs["act"]["kind"]:
		0, 5:   # f_6ba3e
			await _exec_effect(s, data, bs, rng, host, i)
		2:   # f_6baa4
			await _exec_physical(s, data, bs, rng, host, i)
		3:   # f_6c268 defend
			_act_msg(bs)
			br_set(bs, i, R.F, br_get(bs, i, R.F) | 0x20)
		6:   # f_6c36a
			_exec_flee(s, data, bs, rng, i)


## f_6baa4: physical attack (weapon type 11 = transform) (coroutine)
static func _exec_physical(s: GameState, data: Dictionary, bs: Dictionary, rng: CRand, host: Object, i: int) -> void:
	var act: Dictionary = bs["act"]
	_act_msg(bs)
	if act["emult"] == 11:
		br_set(bs, i, R.POSE, 15)
	if act["targets"].is_empty():
		return
	if not act["hit"]:
		act["hit"] = 0xe6
	_illusion(bs, i)
	act["dmg"] = _attack_base(bs, i, act["mult"])
	if br_get(bs, i, R.CLONE):
		var half: int = s16(act["dmg"]) / 2
		act["dmg"] = s16(act["dmg"] + half)
	if act["skill"]:
		var v: int = _s32((s16(act["skill"]) >> 6) * s16(act["dmg"])) / 8
		act["dmg"] = s16(v)
	await _impact_rounds(s, data, bs, rng, host, i)
	apply_effect(s, data, bs, rng, host, i)


## f_6c50c: illusion: hit chance - 1/4
static func _illusion(bs: Dictionary, i: int) -> void:
	if br_get(bs, i, R.ILLU):
		var hit: int = bs["act"]["hit"]
		var q := s16(hit) / 4
		bs["act"]["hit"] = (hit - q) & 0xffff


## f_6ba3e: items and magic: impact callback with 0 damage (its hit checks still draw), effect
static func _exec_effect(s: GameState, data: Dictionary, bs: Dictionary, rng: CRand, host: Object, i: int) -> void:
	if bs["act"]["targets"].is_empty():
		return
	_act_msg(bs)
	bs["act"]["dmg"] = 0
	await _impact_rounds(s, data, bs, rng, host, i)
	apply_effect(s, data, bs, rng, host, i)


## f_6c36a / f_6c3bc: flight: impossible in builtin-5 battles; else every hit check (230) must succeed
static func _exec_flee(_s: GameState, _data: Dictionary, bs: Dictionary, rng: CRand, i: int) -> void:
	if bs["scripted"]:
		_msg(bs, M["flee_fail"])
		return
	if _fixed(bs, "flight"):
		bs["act"]["targets"] = bs["act"]["targets"].filter(func(t: int) -> bool: return t >= 3 and t <= 7 and _alive(bs, t))
	for t: int in bs["act"]["targets"]:
		if not hit_check(bs, rng, i, t, 0xe6):
			_msg(bs, M["flee_fail"])
			return
	_act_msg(bs)
	bs["over"] = "fled"


## (coroutine)
static func _enemy_turn(s: GameState, data: Dictionary, bs: Dictionary, rng: CRand, host: Object, i: int) -> void:
	if bs["event"]:
		await _enemy_script(s, data, bs, rng, host, i)
	else:
		_enemy_ai(s, data, bs, rng, host, i)
	await _exec_enemy(s, data, bs, rng, host, i)


## f_6e8e6: normal AI
static func _enemy_ai(s: GameState, data: Dictionary, bs: Dictionary, rng: CRand, _host: Object, i: int) -> void:
	clear_act(bs)
	br_set(bs, i, R.F, br_get(bs, i, R.F) & ~0x10)   # reappears (hidden by effect 5)
	clear_act(bs)
	br_set(bs, i, R.F, br_get(bs, i, R.F) & ~0x20)   # f_6eada: defending ends
	bs["act"]["msg"] = M["enemy_attack"]
	if br_get(bs, i, R.ROW) <= 6:
		return
	_turn_status(s, bs, i, data)
	if not _can_act(bs, i):
		return
	if br_get(bs, i, R.F) & 5:
		_msg_t(bs, i, M["cant_move"])
		return
	var ca := choose_action(bs, rng, i)
	var slot: int = ca["slot"]
	var action: int = ca["action"]
	if br_get(bs, i, R.NAME) == 0x25:
		action = 0x33
	_prepare_enemy_action(s, data, bs, rng, i, slot, action)
	_battle_line(data, bs, i, slot)


## f_6e84e: event battles: the actor's script picks the slot (coroutine: host.enemy_slot)
static func _enemy_script(s: GameState, data: Dictionary, bs: Dictionary, rng: CRand, host: Object, i: int) -> void:
	clear_act(bs)
	br_set(bs, i, R.F, br_get(bs, i, R.F) & ~0x20)
	bs["act"]["msg"] = M["enemy_attack"]
	var slot := 0
	if host != null and host.has_method("enemy_slot"):
		slot = int(await host.enemy_slot(bs, i))
	var action := _attr(bs, i, 8 + 2 * slot)
	_prepare_enemy_action(s, data, bs, rng, i, slot, action)
	_battle_line(data, bs, i, slot)


## f_6ebaa: 16 rounds over the 6 (action, weight) pairs (slot 5 first); fallback slot 0
static func choose_action(bs: Dictionary, rng: CRand, i: int) -> Dictionary:
	var sum := 0
	var fix := _fixed(bs, "enemy_ai")
	for k in 6:
		var w := _attr(bs, i, 9 + 2 * k)
		if fix:
			sum += (w - 1) % 10 + 1 if w else 0   # the MSX version's sum (docs/msx.md)
			continue
		var x := w if w > 10 else (w - 10 * ((w + 32768) / 10 + 1) + 65536)
		sum = (sum + x) & 0xffff
	if fix and not sum:
		return {"slot": 0, "action": _attr(bs, i, 8)}
	for _round in 16:
		for k in range(5, -1, -1):
			if _weight_hit(bs, rng, i, _attr(bs, i, 9 + 2 * k), sum):
				return {"slot": k, "action": _attr(bs, i, 8 + 2 * k)}
	return {"slot": 0, "action": _attr(bs, i, 8)}


## f_6ed0a
static func _weight_hit(bs: Dictionary, rng: CRand, i: int, w: int, sum: int) -> int:
	if not w:
		return 0
	if w > 19:
		w = 30 - w if (s16(_attr16(bs, i, 24)) >> 2) > br_get16(bs, i, R.HP) else w - 20
	return 1 if w > _draw(bs, rng, s16(sum) & 0xffff, "ai") else 0


## f_6e9ec: action <= 40: a spell (refused when sealed), else a special action (table 8)
static func _prepare_enemy_action(_s: GameState, data: Dictionary, bs: Dictionary, rng: CRand, i: int, slot: int,
		action: int) -> void:
	bs["act"]["anim0"] = 2
	bs["act"]["anim1"] = (slot + 0x50) & 255
	bs["act"]["anim2"] = (slot + 0xc0) & 255
	if action > 40:
		_enemy_special(data, bs, rng, i, action)
		bs["act"]["kind"] = 4
		if action == 74:
			bs["act"]["msg"] = M["defend"]
	elif br_get(bs, i, R.SEAL):
		_msg_t(bs, i, M["sealed"])
	else:
		_enemy_spell(data, bs, rng, i, action)
		bs["act"]["kind"] = 5


## f_6ee78: table 8 record {effect, flags, multiplier, -}
static func _enemy_special(data: Dictionary, bs: Dictionary, rng: CRand, i: int, action: int) -> void:
	var raw: PackedByteArray = data["raw"]
	var r := _t8(data, action)
	var flags := raw[r + 1]
	var act: Dictionary = bs["act"]
	act["element"] = _attr(bs, i, 4)
	act["actor"] = br_get16(bs, i, R.DATA)
	if flags & 0x40:
		act["emult"] = raw[r + 2]
		act["element"] = 0
	act["kind"] = 4
	act["effect"] = raw[r]
	if flags & 8:
		act["targets"] = _targets_all(bs, i, 3, 5, rng) if flags & 0x80 else [i]
	elif not (flags & 0x80):
		act["targets"] = _target_one(bs, rng, i, 0, 3)
	else:
		if bs["event"]:
			act["emult"] = (act["emult"] + 3) & 255
		act["targets"] = _targets_all(bs, i, 0, 3, rng)
	act["anim_type"] = (2 if flags & 0x80 else 1) if flags & 4 else (3 if flags & 1 else 0)
	act["anim_sub"] = 1 if flags & 2 else 0


## f_6ed82: enemy spell (table 9): flags 3 = the party (7 all / one), else own side (7 all / self)
static func _enemy_spell(data: Dictionary, bs: Dictionary, rng: CRand, i: int, sp: int) -> void:
	var raw: PackedByteArray = data["raw"]
	var r := _t9(data, sp)
	var flags := raw[r + 7]
	var act: Dictionary = bs["act"]
	act["actor"] = i
	act["effect"] = raw[r + 4]
	act["element"] = raw[r + 6]
	bs["mg"]["dba"] = 0xffff
	bs["mg"]["dac"] = rd16(raw, r)
	act.merge({"msg": M["cast"], "anim_type": 0, "anim_sub": 0, "anim3": raw[r + 9], "emult": 0}, true)
	if flags & 8:
		act["targets"] = _targets_all(bs, i, 0, 3, rng) if flags & 0x80 else _target_one(bs, rng, i, 0, 3)
	else:
		act["targets"] = _targets_all(bs, i, 3, 5, rng) if flags & 0x80 else [i]


## f_6ec70: the enemy's line for this slot (table 0 action list) replaces the message
static func _battle_line(data: Dictionary, bs: Dictionary, i: int, slot: int) -> void:
	var e := _name_entry(data, br_get(bs, i, R.NAME))
	if e < 0:
		return
	var raw: PackedByteArray = data["raw"]
	bs["mg"]["db6"] = 0xffff
	bs["mg"]["da4"] = rd16(raw, e + 1)
	var p := rd16(raw, e + 3)
	if not p:
		return
	while p < raw.size() and raw[p] != 0x80:
		if raw[p] == slot:
			bs["act"]["msg"] = 0
			bs["act"]["msg_str"] = rd16(raw, p + 1)
			return
		p += 3


## f_6b98c: physical (multiplier) or effect-only actions (coroutine)
static func _exec_enemy(s: GameState, data: Dictionary, bs: Dictionary, rng: CRand, host: Object, i: int) -> void:
	var act: Dictionary = bs["act"]
	bs["log"].append({"t": "exec", "idx": i, "kind": act["kind"], "targets": act["targets"].duplicate()})
	if act["targets"].is_empty():
		return
	if act["emult"]:
		_act_msg(bs)
		act["hit"] = 0xb3
		_illusion(bs, i)
		act["dmg"] = _attack_base(bs, i, act["emult"])
	elif act["effect"]:
		act["dmg"] = 0
		_act_msg(bs)
	else:
		return
	await _impact_rounds(s, data, bs, rng, host, i)
	act["anim2"] = act["anim3"]
	apply_effect(s, data, bs, rng, host, i)
