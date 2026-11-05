extends "res://scripts/battle/battle_data_setup.gd"
## Battle model, part 3 (see scripts/battle/battle_model.gd): effects in battle (f_6cc02 -> f_847b4
## mode 2): applyEffect and the effect handlers of tools/battle/model.mjs.


## the effect's table-5 message and animation replace the action's; the handler works on the targets
static func apply_effect(s: GameState, data: Dictionary, bs: Dictionary, rng: CRand, _host: Object, i: int) -> void:
	var act: Dictionary = bs["act"]
	var e: int = act["effect"]
	if not e:
		return
	var raw: PackedByteArray = data["raw"]
	var r := _t5(data, e)
	if raw[r + 3]:
		act["anim2"] = raw[r + 3]
	act["msg"] = 0
	act["msg_str"] = rd16(raw, r)
	bs["log"].append({"t": "effect", "id": e, "targets": act["targets"].duplicate()})
	if raw[r + 2]:   # passive effects (equipment) do nothing in mode 2
		return
	if e > 111:
		return
	_effects(s, data, bs, rng, i, e)
	act["anim0"] = 1


## f_86048
static func _eff_msg(data: Dictionary, bs: Dictionary, e: int) -> void:
	var o := rd16(data["raw"], _t5(data, e))
	if o:
		_msg(bs, 0, o)


## f_85b86(t, enemyOff, charOff)
static func _stat(s: GameState, bs: Dictionary, t: int, eo: int, co: int) -> int:
	if _is_party(bs, t):
		return 0 if co == 0x40 else _cw(s, _char_of(s, bs, t), co)
	if eo == 0x40:
		return 0
	if eo > 0x1f:
		return _attr16(bs, t, eo - 32)
	return br_get16(bs, t, eo)


## f_85c7e(t, v, recOff, charOff)
static func _set_stat(s: GameState, bs: Dictionary, t: int, v: int, ro: int, co: int) -> void:
	if ro != 0x40:
		br_set16(bs, t, ro, v)
	if _is_party(bs, t) and co != 0x40:
		_set_cw(s, _char_of(s, bs, t), co, v)


## f_845c2(n): HP + n for every target (clamped to 0..max), message per target
static func _heal_hp(s: GameState, data: Dictionary, bs: Dictionary, e: int, n: int) -> void:
	for t: int in bs["act"]["targets"]:
		if t == -1:
			continue
		var mx := _stat(s, bs, t, 0x38, 12)
		var cur := _stat(s, bs, t, 0x16, 14)
		var v := s16(cur + n)
		if v < 0:
			v = 0
		if s16(mx) < v:
			v = mx
		_set_stat(s, bs, t, v, 0x16, 14)
		bs["mg"].merge({"d9e": (v - cur) & 0xffff, "db8": 0, "db2": br_get(bs, t, R.NAME)}, true)
		_eff_msg(data, bs, e)


## f_846ba(n): MP + n
static func _heal_mp(s: GameState, data: Dictionary, bs: Dictionary, e: int, n: int) -> void:
	for t: int in bs["act"]["targets"]:
		if t == -1:
			continue
		var mx := _stat(s, bs, t, 8, 8)
		var cur := _stat(s, bs, t, 0x14, 10)
		var v := s16(cur + n)
		if v < 0:
			v = 0
		if s16(mx) < v:
			v = mx
		_set_stat(s, bs, t, v, 0x14, 10)
		bs["mg"].merge({"d9e": absi(n) & 0xffff, "db8": 0, "db2": br_get(bs, t, R.NAME)}, true)
		_eff_msg(data, bs, e)


## f_860d8(hit): status resistance: name id 4 (the robot) is immune, else a hit check; misses -> -1
static func _resist(_s: GameState, bs: Dictionary, rng: CRand, i: int, hit: int) -> void:
	var tl: Array = bs["act"]["targets"]
	for k in tl.size():
		var t: int = tl[k]
		if t == -1:
			continue
		if br_get(bs, t, R.NAME) != 4 and hit_check(bs, rng, i, t, hit):
			continue
		bs["mg"]["db8"] = 0
		bs["mg"]["db2"] = br_get(bs, t, R.NAME)
		tl[k] = -1
		_msg(bs, M["missed"])


## f_85fb8(fn): for each target: names, fn(t), effect message
static func _each_target(_s: GameState, data: Dictionary, bs: Dictionary, i: int, e: int, fn: Callable) -> void:
	bs["mg"]["db6"] = 0
	bs["mg"]["db0"] = br_get(bs, i, R.NAME)
	for t: int in bs["act"]["targets"]:
		if t == -1:
			continue
		bs["mg"]["db8"] = 0
		bs["mg"]["db2"] = br_get(bs, t, R.NAME)
		fn.call(t)
		_eff_msg(data, bs, e)


## the targets of the effect (not removed by a resistance check)
static func _each(bs: Dictionary, fn: Callable) -> void:
	for t: int in bs["act"]["targets"]:
		if t != -1:
			fn.call(t)


## f_85f3c(n): damage 2n to every target (f_6bbb0, first target shows the message)
static func _eff_damage(s: GameState, data: Dictionary, bs: Dictionary, i: int, e: int, n: int) -> void:
	bs["act"]["dmg"] = s16(2 * n)
	bs["cb_armed"] = true
	var d: int = bs["act"]["dmg"]
	_each_target(s, data, bs, i, e, func(t: int) -> void:
		bs["act"]["dmg"] = d
		apply_damage(s, data, bs, t))


## a status counter of every remaining target = rng(2) + 4
static func _status_turns(bs: Dictionary, rng: CRand, f: int) -> Callable:
	return func(t: int) -> void: br_set(bs, t, f, _draw(bs, rng, 2, "status") + 4)


## f_8487a / f_85d90: the copy gets x + 4; table 12 group k - 2 {count, x, step} spaces records 3..
## again; then one f_6d09a(-1)
static func _split(data: Dictionary, bs: Dictionary, i: int) -> void:
	for k in range(i, 8):
		if _alive(bs, k):
			continue
		var rec: PackedByteArray = bs["br"].slice(36 * i, 36 * i + 36)
		_put_record(bs, k, rec)
		br_set(bs, k, R.X, br_get(bs, k, R.X) + 4)
		if bs["attrs"].has(i):
			bs["attrs"][k] = bs["attrs"][i]
		else:
			bs["attrs"].erase(k)
		if bs["rec_actor"].has(i):
			bs["rec_actor"][k] = bs["rec_actor"][i]
		var raw: PackedByteArray = data["raw"]
		var g: int = data["off"][12] + 4 * (k - 3)
		var x: int = raw[g + 1]
		for j in mini(raw[g], 5):
			br_set(bs, 3 + j, R.X, x)
			x = (x + raw[g + 2]) & 255
		bs["log"].append({"t": "split", "idx": i, "rec": k})
		_flash_tick(bs)
		return


## one f_6d09a(-1) call: every flash counter - 1; a record whose counter reaches 0 with 0 HP dies
static func _flash_tick(bs: Dictionary) -> void:
	for i in 8:
		if not _alive(bs, i) or not br_get(bs, i, R.FLASH):
			continue
		br_set(bs, i, R.FLASH, br_get(bs, i, R.FLASH) - 1)
		if br_get(bs, i, R.FLASH) == 0 and br_get16(bs, i, R.HP) == 0 and not (br_get(bs, i, R.CF) & 2):
			br_set(bs, i, R.F, br_get(bs, i, R.F) & 0x7f)
			bs["log"].append({"t": "death", "idx": i})


static func _effects(s: GameState, data: Dictionary, bs: Dictionary, rng: CRand, i: int, e: int) -> void:
	var is_p := _is_party(bs, i)
	match e:
		2:   # f_84834: call for help: row - 1, then f_6d994({attribute 7, x + 3, 7, 6})
			br_set(bs, i, R.ROW, br_get(bs, i, R.ROW) - 1)
			var set_id := _attr(bs, i, 7)
			var rec := _event_record(bs, [set_id, br_get(bs, i, R.X) + 3, 7, 6], bs["attr_of"], bs["data_of"])
			bs["log"].append({"t": "help", "idx": i, "rec": rec, "set": set_id})
		3:   # f_8487a: split: the caster is copied into the first free record after it (f_85d90)
			_split(data, bs, i)
		5:   # hide
			br_set(bs, i, R.POSE, 0x71)
			br_set(bs, i, R.F, br_get(bs, i, R.F) | 0x10)
		6:   # defend
			br_set(bs, i, R.POSE, 0)
			br_set(bs, i, R.F, br_get(bs, i, R.F) | 0x20)
		10:   # stone pose
			br_set(bs, i, R.POSE, 5)
		7, 8:   # attack / defence - 1/4 (min 1) after resistance 25
			_resist(s, bs, rng, i, 0x19)
			var f := R.ATK if e == 7 else R.DEF
			_each(bs, func(t: int) -> void:
				if e == 7 and (br_get(bs, t, R.CF) & 0x20):
					return
				var v := br_get16(bs, t, f)
				var n := s16(v - s16(v) / 4)
				br_set16(bs, t, f, n)
				if s16(br_get16(bs, t, f)) <= 0:
					br_set16(bs, t, f, 1))
		9, 103:
			_resist(s, bs, rng, i, 0x19 if e == 9 else 0x66)
			_each_target(s, data, bs, i, e, func(t: int) -> void:
				br_set(bs, t, R.AGI, br_get(bs, t, R.AGI) - (br_get(bs, t, R.AGI) >> 2)))
		18, 19, 20, 21, 66:
			_heal_hp(s, data, bs, e, {18: 50, 19: 100, 20: 300, 21: 9999, 66: 50}[e])
		22, 23, 24, 25:
			_heal_mp(s, data, bs, e, {22: 100, 23: 200, 24: 999, 25: 20 if _fixed(bs, "effects") else 16}[e])
		26:
			_each(bs, func(t: int) -> void: br_set(bs, t, R.SLEEP, 0))
		27:
			_each(bs, func(t: int) -> void: br_set(bs, t, R.F, br_get(bs, t, R.F) & 0xfb))
		28:
			_each(bs, func(t: int) -> void: br_set(bs, t, R.F, br_get(bs, t, R.F) & 0xfd))
		29:
			_each(bs, func(t: int) -> void: br_set(bs, t, R.CONF, 0))
		30:
			_heal_hp(s, data, bs, e, 9999)
			_heal_mp(s, data, bs, e, 999 if _fixed(bs, "effects") else 16)
			for x in [26, 27, 28, 29]:
				_effects(s, data, bs, rng, i, x)
		36:
			_each(bs, func(t: int) -> void:
				if br_get(bs, t, R.CF) & 0x20:
					return
				var p := _stat(s, bs, t, 0x3c, 0x13) & 0xff
				br_set16(bs, t, R.ATK, br_get16(bs, t, R.ATK) + (p >> 2)))
		37:
			_each(bs, func(t: int) -> void:
				var p := _stat(s, bs, t, 0x3a, 0x10) & 0xff
				br_set16(bs, t, R.DEF, br_get16(bs, t, R.DEF) + (p >> 3)))
		38:
			_each(bs, func(t: int) -> void:
				if _fixed(bs, "effects"):   # + 50, at most 127 (the MSX)
					br_set(bs, t, R.HITMOD, mini(127, s8(br_get(bs, t, R.HITMOD)) + 50) & 255)
					return
				var d := mini((s8(br_get(bs, t, R.HITMOD)) & 0xff) + 50, 255)
				br_set(bs, t, R.HITMOD, br_get(bs, t, R.HITMOD) + d))
		40, 41:
			_eff_damage(s, data, bs, i, e, 200 if e == 40 else 300)
		42, 43, 44:
			var nb: int = {42: 2, 43: 4, 44: 8}[e]
			_each(bs, func(t: int) -> void: br_set(bs, t, R.PBAR, nb))
		45, 46, 47:
			var nb: int = {45: 2, 46: 4, 47: 8}[e]
			_each(bs, func(t: int) -> void: br_set(bs, t, R.MBAR, nb))
		67:
			s.block[0x3b8] = 0
			s.block[0x3b9] = 200
		70:
			bs["act"]["targets"] = [br_get(bs, i, R.SPR)]
			_heal_mp(s, data, bs, e, -5)
		71:
			var d := _stat(s, bs, i, 0x38, 12) / 8
			_take_party(s, bs, i, d)
		86:
			bs["act"]["targets"] = _targets_all(bs, i, 0, 8, rng)
			_resist(s, bs, rng, i, 0x66)
			_eff_damage(s, data, bs, i, e, 150)
		87, 88, 89:
			_resist(s, bs, rng, i, 0xfd)
			_eff_damage(s, data, bs, i, e, {87: 80, 88: 160, 89: 240}[e])
		91:   # charge
			var c := mini(br_get(bs, i, R.CHARGE) + 1, 2)
			br_set(bs, i, R.CHARGE, c)
			bs["mg"].merge({"d9e": c, "db8": 0, "db2": br_get(bs, i, R.NAME)}, true)
			_eff_msg(data, bs, e)
		92:   # release: power * (charge + 1)
			var p := _stat(s, bs, i, 0x38, 0x13) & 0xff
			var p2 := p * 4 if br_get(bs, i, R.SPR) == 0 else p + p / 2
			var n := _s32((p2 & 0xffff) * (br_get(bs, i, R.CHARGE) + 1))
			br_set(bs, i, R.CHARGE, 0)
			_eff_damage(s, data, bs, i, e, n)
		95:
			_resist(s, bs, rng, i, 0x4c if is_p else 0x19)
			_each(bs, _status_turns(bs, rng, R.SEAL))
		97:
			_resist(s, bs, rng, i, 0x19)
			var v := s16(br_get16(bs, i, R.ATK))
			var n := (v / 2) & 0xffff
			if is_p:
				bs["poison_enemy"] = n >> 1
			else:
				bs["poison_party"] = n >> 1
			_each_target(s, data, bs, i, e, func(t: int) -> void: br_set(bs, t, R.F, br_get(bs, t, R.F) | 2))
		98:
			_resist(s, bs, rng, i, 0x19)
			_each_target(s, data, bs, i, e, func(t: int) -> void: br_set(bs, t, R.F, br_get(bs, t, R.F) | 4))
		99:
			_resist(s, bs, rng, i, 0x19)
			_each_target(s, data, bs, i, e, func(t: int) -> void:
				br_set(bs, t, R.F, br_get(bs, t, R.F) | 1)
				br_set16(bs, t, R.HP, 1))
		100, 101, 102:
			_resist(s, bs, rng, i, 0x19 if e == 102 else 0x66)
			var f: int = {100: R.SLEEP, 101: R.ILLU, 102: R.CONF}[e]
			_each_target(s, data, bs, i, e, _status_turns(bs, rng, f))
		104:   # clone (the copy sprite is presentation)
			br_set(bs, i, R.CLONE, 4)
		106, 107, 108, 109, 110, 111:   # f_85e32(n): weapon-like damage
			if e != 106:   # handlers $85ADC..: f_860d8($FD) first
				_resist(s, bs, rng, i, 0xfd)
			var d := _attack_base(bs, i, WEAPON_LIKE[e])
			var d3 := s16(d) >> 3
			var b37 := _cb(s, _party_word(s, br_get(bs, i, R.SPR)), 37)
			if b37 & 1:
				d = s16(d + _s32(d3 * 3))
			if b37 & 2:
				d = s16(d + 2 * d3)
			if b37 & 4:
				d = s16(d + d3)
			_eff_damage(s, data, bs, i, e, d)
		# 0, 1, 4, 11-17, 31-35, 39, 48, 68, 69, 72, 79, 85, 90, 93, 94, 96, 105: nothing in battle
