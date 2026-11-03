extends "res://scripts/battle/battle_data_core.gd"
## Battle model, part 2 (see scripts/battle/battle_model.gd): the battle state (newBattle) and the
## setup of f_6abca (setupBattle: formations f_6d73a / f_6d926, party records f_6d532, gauges).


## Battle state from the records after setup (keys: br, gauge, gauge_max, n_party, order, attrs,
## mode, event, scripted, group, poison_party, poison_enemy, last_magic_target, actors)
static func new_battle(o: Dictionary) -> Dictionary:
	var br := PackedByteArray()
	br.resize(288)
	if o.get("br") != null:
		br = PackedByteArray(o["br"])
	var gauge := []
	for g: Variant in _opt(o, "gauge", [0, 0, 0, 0, 0, 0, 0, 0]):
		gauge.append(int(g))
	var order := []
	for x: Variant in _opt(o, "order", [0, 1, 2, 3, 4, 5, 6, 7, 0, 0, 0]):
		order.append(int(x))
	var bs := {
		"br": br, "gauge": gauge, "gauge_max": _opt(o, "gauge_max", 1), "n_party": _opt(o, "n_party", 0),
		"order": order, "attrs": _opt(o, "attrs", {}), "mode": _opt(o, "mode", 1), "event": _opt(o, "event", 0),
		"scripted": _opt(o, "scripted", 0), "group": _opt(o, "group", 0), "exp": 0, "money": 0,
		"poison_party": _opt(o, "poison_party", 0), "poison_enemy": _opt(o, "poison_enemy", 0),
		"fixes": o.get("fixes", {}),
		"last_magic_target": _opt(o, "last_magic_target", 0), "cursor": 0, "over": null, "act": null,
		"mg": _new_mg(), "log": [], "actors": null,
		"forced": 0, "allowed": 0, "last_target": 0, "cb_armed": false, "rec_actor": {},
		"party_count_saved": null, "attr_of": null, "data_of": null,
	}
	if o.get("actors") != null:
		bs["actors"] = PackedByteArray(o["actors"])
	clear_act(bs)
	return bs


## f_6abca's setup for mode 0 (contact), 1 (builtin 5) and 2 (event battle).
##   o = {mode, actor, scripted, actors (640 bytes), attr_of: Callable(actor) -> 32 bytes or null,
##        data_of: Callable(actor) -> {off, sheet_bytes}, party_actors: [{slot, set, off,
##        sheet_bytes}], poison_party, poison_enemy, last_magic_target}
static func setup_battle(s: GameState, data: Dictionary, o: Dictionary) -> Dictionary:
	var mode: int = o["mode"]
	var bs := new_battle({"mode": mode, "event": 1 if mode == 2 else 0, "scripted": _opt(o, "scripted", 0),
		"group": o["actor"], "actors": o.get("actors"), "fixes": o.get("fixes", {}),
		"poison_party": o.get("poison_party"),
		"poison_enemy": o.get("poison_enemy"), "last_magic_target": o.get("last_magic_target")})
	for k in 8:
		bs["br"][36 * k + R.SPR] = k
	var saved := s.be16(GameState.OFF_PARTY_COUNT)
	var n_party := saved
	bs["party_count_saved"] = saved
	if mode != 2 and s.block[GameState.OFF_PARTY_C + 5] & 1:   # modes 0/1 only (f_6abca)
		n_party = 2
		s.block[GameState.OFF_PARTY_COUNT] = 0
		s.block[GameState.OFF_PARTY_COUNT + 1] = 2
	if mode == 2:
		_form_event(bs, data, o)
	else:
		_form_normal(bs, data, o)
	_party_records(s, bs, data, n_party, o)
	bs["gauge_max"] = 1
	for i in 8:
		if _alive(bs, i) and br_get(bs, i, R.AGI) > bs["gauge_max"]:
			bs["gauge_max"] = br_get(bs, i, R.AGI)
	bs["gauge"] = [0, 0, 0, 0, 0, 0, 0, 0]
	var attr_of: Callable = o["attr_of"]
	for i in range(3, 8):
		if _alive(bs, i):
			bs["attrs"][i] = attr_of.call(bs["rec_actor"].get(i, -1))
	bs["attr_of"] = attr_of             # effect 2 (call for help) builds records during the battle
	bs["data_of"] = o["data_of"]
	return bs


## f_6d73a: the touched actor's enemies in the front row, a type-4 partner in the back row
static func _form_normal(bs: Dictionary, data: Dictionary, o: Dictionary) -> void:
	var a_rec: PackedByteArray = bs["actors"]
	var attr_of: Callable = o["attr_of"]
	var actor: int = o["actor"]
	var size1: int = attr_of.call(actor)[3]
	if size1 == 0:
		size1 = 1
	var partner := 0
	if size1 > 99:
		size1 -= 100
	else:
		# f_6dbac: first active actor 3..31 (not the touched one) of type 4 near the leader
		for i in range(3, 32):
			if not (a_rec[20 * i + 5] & 0x80) or i == actor:
				continue
			# the type table $A1AF2 (f_6dc14): attribute 9 of the actor's FIELD sprite set
			var type := -1
			if o.has("type_of"):
				type = int(o["type_of"].call(i))
			else:
				var a: Variant = attr_of.call(i)
				type = int(a[9]) if a != null else -1
			if type != 4:
				continue
			var dx := s16(_act_le(a_rec, i, 0) - _act_le(a_rec, 0, 0))
			var dy := s16(_act_le(a_rec, i, 2) - _act_le(a_rec, 0, 2))
			if absi(dx) <= 8 and absi(dy) <= 8:
				partner = i
				break
	var size2 := 0
	if partner:
		size2 = attr_of.call(partner)[3]
		if size2 == 0:
			size2 = 1
		if size2 > 99:
			size2 = 0
	# f_6dc70
	var s1 := size1
	var s2 := size2
	if s1 > 100:
		s1 -= 100
		s2 = 0
	var cols1 := 20 / (s1 + 2)
	var cols2 := 20 / (s2 + 2) if s2 else 0
	var raw: PackedByteArray = data["raw"]
	var c2 := cols2 if cols2 else 1
	var e := _tbl(data, 11) + 10 * cols1 - 10 + 2 * c2 - 2
	var g1 := _tbl(data, 12) + 4 * raw[e] - 4
	var g2 := _tbl(data, 12) + 4 * raw[e + 1] - 4
	if not raw[e + 1]:
		cols2 = 0
	var next := _place_group(bs, data, o, 7, size1, actor, 3, [raw[g1], raw[g1 + 1], raw[g1 + 2]])
	if cols2:
		_place_group(bs, data, o, 6, size2, partner, next, [raw[g2], raw[g2 + 1], raw[g2 + 2]])


static func _act_le(a: PackedByteArray, i: int, k: int) -> int:
	return s16(a[20 * i + k] | (a[20 * i + k + 1] << 8))


## f_6dcd2: count = grp[0] records from `first`, x = attr 1 + grp[1] - size/2, then + grp[2] each
static func _place_group(bs: Dictionary, _data: Dictionary, o: Dictionary, row: int, size: int, actor: int,
		first: int, grp: Array) -> int:
	var a: Variant = o["attr_of"].call(actor)
	var d: Dictionary = o["data_of"].call(actor)
	var rec := PackedByteArray()
	rec.resize(36)
	rec[0] = size & 255
	rec[1] = row
	rec[3] = 0x80
	var acts: PackedByteArray = bs["actors"]
	acts[20 * actor + 5] = (acts[20 * actor + 5] & 0x7f) | 0x40
	acts[20 * actor + 7] = 0x30
	bs["actors"] = acts
	rec[4] = acts[20 * actor + 8]
	rec[5] = acts[20 * actor + 9]
	_rec_common(rec, a, d)
	rec[28] = 6
	rec[0] = (int(a[1]) + grp[1] - (rec[0] >> 1)) & 255
	var k := 0
	while k < grp[0]:
		var i := first + k
		if i < 8:
			_put_record(bs, i, rec)
			bs["rec_actor"][i] = actor
		rec[0] = (rec[0] + grp[2]) & 255
		k += 1
	return first + k


## the record fields both formations copy: CG9 offset, sheet, agility, MP 3000, HP, DEF, ATK
static func _rec_common(rec: PackedByteArray, a: Variant, d: Dictionary) -> void:
	var off: int = d["off"]
	rec[6] = off & 255
	rec[7] = (off >> 8) & 255
	for k in 4:
		rec[32 + k] = int(d["sheet_bytes"][k]) & 255
	rec[18] = int(a[2])
	rec[20] = 3000 & 255
	rec[21] = 3000 >> 8
	for k in range(24, 30):
		rec[k - 2] = int(a[k])
	rec[30] = 0


## f_6d926 / f_6d994: event group: each entry {set, x, row, pose} takes the first actor of that set
static func _form_event(bs: Dictionary, data: Dictionary, o: Dictionary) -> void:
	var groups: Array = data["event_groups"]
	var g: int = o["actor"]
	var entries: Array = groups[g] if g >= 0 and g < groups.size() else []
	for e: PackedByteArray in entries:
		_event_record(bs, [e[0], e[1], e[2], e[3]], o["attr_of"], o["data_of"])


## f_6d994(entry {set, x, row, pose}): a record with the data of the first actor (3..) of that sprite
## set (+4 = 4, MP 3000, the rest from its attributes) in the first free record 3..7; returns its
## index, or -1: no such actor (the original reads past the actor table) / no free record (the
## original writes past the records).
static func _event_record(bs: Dictionary, e: Array, attr_of: Variant, data_of: Variant) -> int:
	var acts: Variant = bs["actors"]
	if acts == null or not (attr_of is Callable):
		return -1
	var rec := PackedByteArray()
	rec.resize(36)
	rec[3] = 0x80
	rec[0] = int(e[1]) & 255
	rec[1] = int(e[2]) & 255
	rec[28] = int(e[3]) & 255
	rec[4] = 4
	rec[5] = int(e[0]) & 255
	var ai := 3
	while ai < 32 and acts[20 * ai + 9] != int(e[0]):
		ai += 1
	var a: Variant = attr_of.call(ai)
	if a == null:
		return -1
	_rec_common(rec, a, data_of.call(ai))
	var i := 3
	while i < 8 and _alive(bs, i):
		i += 1
	if i >= 8:
		return -1
	_put_record(bs, i, rec)
	bs["rec_actor"][i] = ai
	bs["attrs"][i] = a
	return i


## f_6d4a0 + f_6d532: party slot records (positions $8CCF0 / $8CCF6), list order $A1ADA
static func _party_records(s: GameState, bs: Dictionary, data: Dictionary, n_party: int, o: Dictionary) -> void:
	bs["n_party"] = n_party
	var order := [1, 0, 2, 3, 4, 5, 6, 7]
	var pos: PackedByteArray = data["party_pos2"] if n_party == 2 else data["party_pos3"]
	for slot in n_party:
		var c := _char_of_slot(s, slot)
		var pa: Dictionary = o["party_actors"][slot]
		var rec: PackedByteArray = bs["br"].slice(36 * slot, 36 * slot + 36)
		rec[3] = 0x80
		rec[0] = _rb(pos, 2 * slot)
		rec[1] = _rb(pos, 2 * slot + 1)
		rec[4] = int(pa["slot"]) & 255
		rec[5] = int(pa["set"]) & 255
		rec[6] = int(pa["off"]) & 255
		rec[7] = (int(pa["off"]) >> 8) & 255
		for k in 4:
			rec[32 + k] = int(pa["sheet_bytes"][k]) & 255
		rec[R.CF] = _cb(s, c, 4) & 0x7f
		var agi := _cb(s, c, 6) + s8(_cb(s, c, 7))
		if agi > 255:
			agi = 255
		if agi <= 0:
			agi = 1
		rec[R.AGI] = agi
		_put16(rec, R.MP, _cw(s, c, 10))
		_put16(rec, R.HP, _cw(s, c, 14))
		_put16(rec, R.DEF, _cw(s, c, 17) + _cb(s, c, 16))
		var atk := _cw(s, c, 20)
		if not (rec[R.CF] & 0x20):
			atk += _cb(s, c, 19)
		_put16(rec, R.ATK, atk)
		rec[R.POSE] = 6
		rec[R.HITMOD] = _cb(s, c, 5)
		if rec[R.HP] == 0 and rec[R.HP + 1] == 0:
			rec[3] &= 0x7f
		var br: PackedByteArray = bs["br"]
		for j in 36:
			br[36 * slot + j] = rec[j]
		bs["br"] = br
	order.append(int(_opt(o, "size1_word", 0)))
	order.append(int(_opt(o, "size2_word", 0)))
	order.append(int(_opt(o, "cols2_word", 0)))
	bs["order"] = order
