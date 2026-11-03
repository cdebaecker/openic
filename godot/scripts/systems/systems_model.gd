extends RefCounted
## The ICITY68 game systems (milestone 5): character records and derived stats, level-up,
## effects, field use of items and spells, inventory, equipment, shops, inn, checkpoint,
## save/load, settings. Spec: docs/systems.md. A function-by-function transcription of the
## verified reference model tools/systems/model.mjs (same names in snake_case, same argument
## order, same return values; object results are Dictionaries with snake_case keys). Checked
## against the reference by tools/systems/golden.mjs + scripts/dev/systems_test.gd.
##
## Every function is static and works on a GameState (scripts/events/game_state.gd): `block` =
## the 954-byte block $9C794 (the save file), `rt` = run-time values (snake_case keys: targets,
## next_map, pending_trigger, last_trigger, facing, warp_longjmp, hdd, drives, disk_word,
## checkpoint, load_mode; the checkpoint copy of the block is rt["backup"]).
##
##   const SYS := preload("res://scripts/systems/systems_model.gd")
##   SYS.use_item(state, slot, code, [target_slot, ..., -1])     # ITEM > use
##   SYS.cast_spell(state, char, spell, {"mode": m, "targets": [...]})   # MAGIC
##   SYS.equip(state, party_slot, row, item_index)              # EQUIP
##   SYS.shop_buy(state, code, qty_index, true)                 # builtin 35 mode >= 2
##   SYS.level_up(state, c, CRand.new().fn())                   # rng(n) = f_88e00
##
## Tables: GameData.json("data/systems.json") (named fields) and data/IC_TABLE.json (the raw
## bytes of IC_TABLE.COM up to the string pool: the stat recompute reads records by raw offset).

const GameState := preload("res://scripts/events/game_state.gd")
const CRand := preload("res://scripts/systems/c_rand.gd")
const SystemsTables := preload("res://scripts/systems/systems_tables.gd")

# ---- character records ($9C9B2 + 40*c, block +$21E) ------------------------------------------
const C_EXP := 0        # 24-bit LE experience (+0..+2)
const C_LEVEL := 3      # level (99 = max)
const C_FLAGS := 4      # derived: bit 5 firearm equipped, bits 4 / 2 equipment flags
const C_HIT := 5        # derived: hit-rate modifier (signed)
const C_AGI := 6        # base agility
const C_AGI_EQ := 7     # derived: agility from equipment (signed)
const C_MAXMP := 8
const C_MP := 10
const C_MAXHP := 12
const C_HP := 14
const C_VIT := 16       # base defence
const C_DEF := 17       # derived LE word: armour defence
const C_POW := 19       # base attack
const C_ATK := 20       # derived LE word: weapon attack
const C_MASK := 22      # weapon types the character can equip
const C_WEAPON := 23
const C_ARMOUR := 24
const C_ACC := 25       # 3 accessory indices +25..+27
const C_SKILL := 28     # 4 LE words
const C_FX36 := 36
const C_FX37 := 37
const C_FX38 := 38

const QUANTITIES := [1, 10, 100, 1000, 9999]   # $9CFAE
const SPEED := {"message": 0x39e, "move": 0x39a, "battle": 0x39c}
const SWITCH := {"vr": 0x3a4, "mouse": 0x3a6, "auto_avoid": 0x3a0, "talk": 0x3a2}
const HEAL_HP := {18: 50, 19: 100, 20: 300, 21: 9999}    # f_845c2(n)
const HEAL_MP := {22: 100, 23: 200, 24: 999, 25: 16}     # f_846ba(n)
const KEY_CODES := [0x201, 0x238, 0x317, 0x331]
const COL1 := [0x0d, 0x0c, 0x0b, 0x0a, 0x02, 0x03, 0x14, 0x15, 0x18, 0x19, 0x1a]
const COL2 := [0x01, 0x0f, 0x10, 0x04, 0x05, 0x07, 0x08, 0x06, 0x12, 0x11]
const NO_LIMIT := 1 << 62

static var _tables := {}


# ---- tables ------------------------------------------------------------------------------------

static func tables() -> Dictionary:
	if _tables.is_empty():
		var gd: Node = Engine.get_main_loop().root.get_node("/root/GameData")
		_tables = load_tables(gd.json("data/systems.json"), gd.json("data/IC_TABLE.json"))
	return _tables


static func set_tables(t: Dictionary) -> void:
	_tables = t


## systems.json (tools/export/systems.mjs) + IC_TABLE.json (tools/export/data.mjs) -> tables
static func load_tables(sj: Dictionary, ict: Dictionary) -> Dictionary:
	return SystemsTables.build(sj, ict)


static func _raw(i: int) -> int:
	var raw: PackedByteArray = tables()["raw"]
	return raw[i] if i >= 0 and i < raw.size() else 0   # past the file: 0 (JS reads undefined)


## tables.mjs codeClass: item / weapon / armour / other by the code's high byte
static func code_class(code: int) -> String:
	var h := (code >> 8) & 0xff
	return "item" if h <= 1 else "weapon" if h == 2 else "armour" if h == 3 else "other"


## tables.mjs itemPrice (f_84296: $9DC18)
static func item_price(code: int) -> int:
	var tb := tables()
	var i := code & 0xff
	var list: Array
	match code_class(code):
		"item":
			list = tb["items"]
		"weapon":
			list = tb["weapons"]
		"armour":
			list = tb["armour"]
		_:
			return 0
	return int(list[i]["price"]) if i < list.size() else 0


# ---- helpers -----------------------------------------------------------------------------------

static func _s8(v: int) -> int:
	v &= 0xff
	return v - 0x100 if v & 0x80 else v


static func _s16(v: int) -> int:
	v &= 0xffff
	return v - 0x10000 if v & 0x8000 else v


static func _s32(v: int) -> int:
	v &= 0xffffffff
	return v - 0x100000000 if v & 0x80000000 else v


static func char_off(c: int) -> int:
	return GameState.OFF_CHARS + GameState.CHAR_SIZE * c


static func cget(s: GameState, c: int, f: int) -> int:
	return s.block[char_off(c) + f]


static func cset(s: GameState, c: int, f: int, v: int) -> void:
	s.block[char_off(c) + f] = v & 255


static func cget16(s: GameState, c: int, f: int) -> int:
	return s.le16(char_off(c) + f)


static func cset16(s: GameState, c: int, f: int, v: int) -> void:
	s.set_le16(char_off(c) + f, v)


## exp() of model.mjs (renamed: exp is a GDScript built-in)
static func char_exp(s: GameState, c: int) -> int:
	var o := char_off(c)
	return s.block[o] | (s.block[o + 1] << 8) | (s.block[o + 2] << 16)


static func _set_exp(s: GameState, c: int, v: int) -> void:
	var o := char_off(c)
	s.block[o] = v & 255
	s.block[o + 1] = (v >> 8) & 255
	s.block[o + 2] = (v >> 16) & 255


## all three party words (not limited by the party size)
static func party(s: GameState) -> Array[int]:
	var out: Array[int] = []
	for k in 3:
		out.append(s.be16(GameState.OFF_PARTY + 2 * k))
	return out


## Readable view of a character (for UIs and debugging).
static func char_info(s: GameState, c: int) -> Dictionary:
	return {
		"exp": char_exp(s, c), "level": cget(s, c, C_LEVEL), "hp": cget16(s, c, C_HP), "max_hp": cget16(s, c, C_MAXHP),
		"mp": cget16(s, c, C_MP), "max_mp": cget16(s, c, C_MAXMP), "power": cget(s, c, C_POW),
		"attack": cget16(s, c, C_ATK), "vitality": cget(s, c, C_VIT), "defence": cget16(s, c, C_DEF),
		"agility": cget(s, c, C_AGI), "agility_eq": _s8(cget(s, c, C_AGI_EQ)), "hit": _s8(cget(s, c, C_HIT)),
		"flags": cget(s, c, C_FLAGS), "fx": [cget(s, c, C_FX36), cget(s, c, C_FX37), cget(s, c, C_FX38)],
		"mask": cget(s, c, C_MASK), "weapon": cget(s, c, C_WEAPON), "armour": cget(s, c, C_ARMOUR),
		"accessories": [cget(s, c, 25), cget(s, c, 26), cget(s, c, 27)],
		"skill": [cget16(s, c, 28), cget16(s, c, 30), cget16(s, c, 32), cget16(s, c, 34)],
		"next": exp_needed(s, c),
	}


# ---- derived stats: f_81850 (one party slot) / f_72e24 (all eight characters) ----------------

static func recompute_char(s: GameState, c: int) -> void:
	var tb := tables()
	var o := char_off(c)
	var b := s.block
	s.set_le16(o + C_ATK, 0)
	s.set_le16(o + C_DEF, 0)
	for f in [5, 7, 4, 36, 37, 38]:
		b[o + f] = 0
	var w := b[o + C_WEAPON]
	if w:
		# weapon data record (table 1) through the weapon's offset (raw reads, as the routine does)
		var t6: int = tb["offsets"][6] + 8 * w
		var d := _raw(t6 + 6) | (_raw(t6 + 7) << 8)
		s.set_le16(o + C_ATK, _raw(d + 2) | (_raw(d + 3) << 8))
		s.rt["targets"] = [0]
		if _raw(d + 5) & 0x80:
			b[o + 4] = (b[o + 4] & 0xdf) | 0x20
		effect(s, _raw(d), 1, {"rec": c})
	for k in 4:
		var a := b[o + C_ARMOUR + k]
		if not a:
			continue
		var r := _armour_raw(a)
		s.set_le16(o + C_DEF, s.le16(o + C_DEF) + r.x)
		effect(s, r.y, 1, {"rec": c})


## armour record by index straight from the raw table: (defence, effect, category)
static func _armour_raw(i: int) -> Vector3i:
	var a: int = tables()["offsets"][7] + 8 * i
	return Vector3i(_raw(a + 4) | (_raw(a + 5) << 8), _raw(a + 6), _raw(a + 7))


static func recompute_all(s: GameState) -> void:
	for c in 8:
		recompute_char(s, c)


static func recompute_slot(s: GameState, slot: int) -> void:
	recompute_char(s, party(s)[slot])


# ---- effects: f_847b4(?, record, effect, mode) -------------------------------------------------
## mode 1 = equipment (passive effects only), 2 = action. opts: rec (character, mode 1), targets
## (party slots, mode 2; default rt["targets"]).
static func effect(s: GameState, id: int, mode: int, opts := {}) -> Dictionary:
	var tb := tables()
	if not id or id > 0x6f:
		return {"skipped": true}
	var passive: int = tb["effects_passive"][id] if id < tb["effects_passive"].size() else 0
	if (mode != 1) if passive else (mode != 2):
		return {"skipped": true}
	if mode == 1:
		_passive_effect(s, int(opts["rec"]) if opts.get("rec") != null else 0, id)
		return {"passive": true}
	var targets: Array = opts.get("targets") if opts.get("targets") != null else s.rt.get("targets", [])
	if targets == null:
		targets = []
	var pt := party(s)
	if HEAL_HP.has(id):
		for t: int in targets:
			_heal(s, pt[t], C_HP, C_MAXHP, HEAL_HP[id])
		return {"heal": "hp"}
	if HEAL_MP.has(id):
		for t: int in targets:
			_heal(s, pt[t], C_MP, C_MAXMP, HEAL_MP[id])
		return {"heal": "mp"}
	match id:
		30:   # f_84d5a: + status cures (battle)
			for t: int in targets:
				_heal(s, pt[t], C_HP, C_MAXHP, 9999)
			for t: int in targets:
				_heal(s, pt[t], C_MP, C_MAXMP, 16)
			return {"heal": "full", "battle_only": true}
		31:
			return {"none": true}
		67:   # f_853ca: $9CB4C = 200 (encounter repel steps)
			s.set_be16(0x3b8, 200)
			return {"repel": 200}
		90:
			return _return_spell(s)
	return {"battle_only": true}


## f_845a2(max, cur, add): clamp to [0, max] on signed words
static func _heal(s: GameState, c: int, f_cur: int, f_max: int, add: int) -> void:
	var mx := _s16(cget16(s, c, f_max))
	var cur := cget16(s, c, f_cur)
	var v := _s16(cur + add)
	if v < 0:
		v = 0
	if mx < v:
		v = mx
	cset16(s, c, f_cur, v)


static func _add8(s: GameState, o: int, v: int) -> void:
	s.block[o] = (s.block[o] + v) & 255


static func _or8(s: GameState, o: int, m: int) -> void:
	s.block[o] = s.block[o] | m


static func _atk(s: GameState, o: int, v: int) -> void:
	if not (s.block[o + 4] & 0x20):
		s.set_le16(o + C_ATK, s.le16(o + C_ATK) + v)


## passive (equipment) effects, applied to the character record
static func _passive_effect(s: GameState, c: int, id: int) -> void:
	var o := char_off(c)
	match id:
		49: _add8(s, o + 5, 0x20)
		50: _add8(s, o + 5, 0x40)
		51: _add8(s, o + 5, 0xe0)
		52: _add8(s, o + 7, 10)
		53: _add8(s, o + 7, 20)
		54: _add8(s, o + 7, -10)
		55: _add8(s, o + 7, -20)
		56: _atk(s, o, 20)
		57: _atk(s, o, 40)
		58: _atk(s, o, 80)
		59: _or8(s, o + 37, 4)
		60: _or8(s, o + 37, 2)
		61: _or8(s, o + 37, 1)
		62: _or8(s, o + 37, 0x80)
		63: _or8(s, o + 37, 0x40)
		64: _or8(s, o + 37, 0x20)
		65: _or8(s, o + 37, 0x10)
		73: _or8(s, o + 36, 0x40)
		74: _or8(s, o + 36, 0x20)
		75: _or8(s, o + 36, 0x10)
		76: _or8(s, o + 38, 0x10)
		77: _or8(s, o + 4, 0x10)
		78: _or8(s, o + 38, 4)
		80:
			_atk(s, o, 40)
			_add8(s, o + 7, -10)
		81:
			_or8(s, o + 36, 0x20)
			_add8(s, o + 7, 10)
		82: _or8(s, o + 36, 8)
		83:
			_or8(s, o + 36, 0x80)
			_add8(s, o + 5, 0x20)
		84:
			_or8(s, o + 38, 8)
			_or8(s, o + 4, 4)


static func _bytes_to_id(b: PackedByteArray, at: int, n: int) -> String:
	var id := ""
	for k in n:
		if b[at + k] == 0:
			break
		id += char(b[at + k])
	return id


## f_85602: the return spell: warp to the return point of builtin 22 ($9CB3C, block +$3A8)
static func _return_spell(s: GameState) -> Dictionary:
	var rt := s.rt
	rt["next_map"] = _bytes_to_id(s.block, 0x3a8, 3)
	var disk := s.be16(0x3b6)
	s.set_be16(0x002, disk)
	s.set_be16(0x000, disk if rt.get("hdd", 0) else (7 if rt.get("drives", 0) == 4 else 0))
	rt["pending_trigger"] = _s16(s.be16(0x3ac) - 1)
	rt["facing"] = s.be16(0x3ae)
	rt["warp_longjmp"] = 1
	return {"warp": rt["next_map"]}


# ---- level and experience ----------------------------------------------------------------------

## f_81a52(c): total experience needed for the next level; 0 at level 99
static func exp_needed(s: GameState, c: int) -> int:
	var curve: PackedInt32Array = tables()["exp_curve"][c]
	var lv := cget(s, c, C_LEVEL)
	if lv == 99:
		return 0
	var sum := 0
	for k in range(1, lv + 1):
		var kk := mini(k, 40)
		sum = (sum + curve[kk >> 2] * kk * kk) & 0xffffffff
	return sum


## f_81b68 + f_81b90: level +1 and stat growth (table 3), 5 rng draws in this order
static func level_up(s: GameState, c: int, rng: Callable) -> void:
	var g: PackedInt32Array = tables()["growth"][c]
	var o := char_off(c)
	var b := s.block
	b[o + C_LEVEL] = (b[o + C_LEVEL] + 1) & 255
	var r: int = rng.call((g[3] + 5) >> 2)
	s.set_le16(o + C_MAXHP, s.le16(o + C_MAXHP) + g[3] + r + 5)
	if g[4]:
		r = rng.call(g[4] >> 2)
		s.set_le16(o + C_MAXMP, s.le16(o + C_MAXMP) + g[4] + r)
	r = rng.call(g[1] >> 2)
	b[o + C_POW] = mini(255, b[o + C_POW] + g[1] + r)
	r = rng.call(g[2] >> 2)
	b[o + C_VIT] = mini(255, b[o + C_VIT] + g[2] + r)
	r = rng.call(g[0] >> 2)
	b[o + C_AGI] = mini(255, b[o + C_AGI] + g[0] + r)


## f_759c2: 24-bit add to the experience (returns the new value)
static func add_exp(s: GameState, c: int, n: int) -> int:
	var v := (char_exp(s, c) + (n & 0xffffff)) & 0xffffff
	_set_exp(s, c, v)
	return v


## after a battle: experience += n, then level up while the next threshold is reached
static func gain_exp(s: GameState, c: int, n: int, rng: Callable) -> int:
	var e := add_exp(s, c, n)
	var ups := 0
	while true:
		var need := exp_needed(s, c)
		if not need or need > e:
			break
		level_up(s, c, rng)
		ups += 1
	return ups


## builtin 31 (f_7c2ee) with lv != 0. Returns lv.
static func set_level(s: GameState, c: int, lv: int, rng: Callable) -> int:
	var o := char_off(c)
	var old := s.block[o + C_LEVEL]
	s.block[o + C_LEVEL] = (lv - 1) & 255
	var target := _s32(exp_needed(s, c))
	s.block[o] = 0
	s.block[o + 1] = 0
	s.block[o + 2] = 0
	add_exp(s, c, target)
	s.block[o + C_LEVEL] = old
	while true:
		var need := _s32(exp_needed(s, c))
		if not need or need > target:
			break
		level_up(s, c, rng)
	full_heal(s)
	return lv


# ---- inn / full heal: f_7beb0 ------------------------------------------------------------------

static func full_heal(s: GameState) -> void:
	for c in 8:
		cset16(s, c, C_HP, cget16(s, c, C_MAXHP))
		cset16(s, c, C_MP, cget16(s, c, C_MAXMP))


## builtin 35(1): the script charges the price with builtin 26
static func rest(s: GameState) -> void:
	full_heal(s)


# ---- inventory: 48 slots {LE code, LE count} at block +$144 (0-39 items, 40-47 key items) -----

static func _slot(i: int) -> int:
	return GameState.OFF_ITEMS + 4 * i


static func slot_code(s: GameState, i: int) -> int:
	return s.le16(_slot(i))


static func slot_count(s: GameState, i: int) -> int:
	return s.le16(_slot(i) + 2)


## f_7ea3c: cannot be dropped / sold
static func is_key_item(code: int) -> bool:
	return ((code & 0xff00) == 0 and (code & 0xffff) > 0x3f) or KEY_CODES.has(code & 0xffff)


## f_80c6a(code, delta): 0 = done, 1 = no free slot, 2 = count would leave 0..9999
static func inv_add(s: GameState, code: int, delta: int) -> int:
	code &= 0xffff
	delta = _s16(delta)
	if (code & 0xff) == 0:
		return 0
	var i := 0
	while i <= 47:
		if slot_code(s, i) == code:
			break
		i += 1
	if i <= 47:
		var n := _s16(slot_count(s, i)) + delta
		if n < 0 or n > 9999:
			return 2
		s.set_le16(_slot(i) + 2, _s16(slot_count(s, i)) + delta)
	else:
		var key := code != 0x201 and is_key_item(code)
		var lo := 40 if key else 0
		var hi := 48 if key else 40
		i = lo
		while i < hi:
			if (slot_code(s, i) & 0xff) == 0 or slot_count(s, i) == 0:
				break
			i += 1
		if i >= hi:
			return 1
		if delta > 0:
			s.set_le16(_slot(i), code)
			s.set_le16(_slot(i) + 2, delta)
	if slot_count(s, i) == 0:
		s.set_le16(_slot(i), 0)
	return 0


## f_84534(delta): 1 = would be negative (nothing changed); capped at 9 999 999
static func add_money(s: GameState, delta: int) -> int:
	var m := _s32(s.money())
	if _s32(m + delta) < 0:
		return 1
	var v := (m + delta) & 0xffffffff
	if v > 9999999:
		v = 9999999
	s.set_money(v)
	return 0


## f_7ea98(mode): frees slots whose count is 0; rows {slot, code, count, enabled}. mode 0 use,
## 1 sort, 2 drop/sell, 3 all.
static func item_list(s: GameState, mode: int) -> Array:
	var items: Array = tables()["items"]
	var rows := []
	for i in 48:
		if slot_count(s, i) == 0:
			s.set_le16(_slot(i), 0)
		var code := slot_code(s, i)
		var en := false
		if mode == 0:
			en = (code >> 8) <= 1 and (code & 0xff) < items.size() and items[code & 0xff]["field"]
		elif mode == 1:
			en = i <= 39
		elif mode == 2:
			en = not is_key_item(code)
		rows.append({"slot": i, "code": code, "count": slot_count(s, i), "enabled": en})
	return rows


## ITEM > sort: swap two slots (both 0-39)
static func swap_slots(s: GameState, a: int, b: int) -> bool:
	if a < 0 or a > 39 or b < 0 or b > 39:
		return false
	var ca := slot_code(s, a)
	var na := slot_count(s, a)
	var cb := slot_code(s, b)
	var nb := slot_count(s, b)
	s.set_le16(_slot(a), cb)
	s.set_le16(_slot(a) + 2, nb)
	s.set_le16(_slot(b), ca)
	s.set_le16(_slot(b) + 2, na)
	return true


## ITEM > drop: what 0 = one, 1 = all
static func drop_item(s: GameState, slot: int, what: int) -> bool:
	var code := slot_code(s, slot)
	if not (code & 0xff) or is_key_item(code):
		return false
	if what == 0:
		return inv_add(s, code, -1) == 0
	if what == 1:
		return inv_add(s, code, -slot_count(s, slot)) == 0
	return false


# ---- ITEM > use: f_8148c(slot, code) -----------------------------------------------------------
## choices = the character window's answers (party slot, -1 = cancel).
## Returns {used, applied: [{slot, char}], refused, end: cancel | empty | once | not-usable}.
static func use_item(s: GameState, slot: int, code: int, choices := []) -> Dictionary:
	var items: Array = tables()["items"]
	var idx := code & 0xff
	var it: Dictionary = items[idx] if idx < items.size() else {}
	if (code >> 8) > 1 or it.is_empty() or not it["field"]:
		return {"used": 0, "applied": [], "refused": 0, "end": "not-usable"}
	var q := choices.duplicate()
	var used := 0
	var refused := 0
	var end := ""
	var applied := []
	var hp := (code >= 1 and code <= 4) or (code >= 50 and code <= 53)
	var mp := code >= 5 and code <= 7
	if hp or mp:
		var f_cur := C_HP if hp else C_MP
		var f_max := C_MAXHP if hp else C_MAXMP
		while true:
			var t: int = q.pop_front() if q.size() else -1
			if t == -1:
				end = "cancel"
				break
			var c := party(s)[t]
			if cget16(s, c, f_cur) < cget16(s, c, f_max):
				s.rt["targets"] = [t]
				effect(s, it["effect"], 2, {"targets": [t]})
				used += 1
				applied.append({"slot": t, "char": c})
			else:
				refused += 1
			if not it["reusable"] and used >= slot_count(s, slot):
				end = "empty"
				break
	else:
		effect(s, it["effect"], 2, {})
		used = 1
		end = "once"
	if not it["reusable"] and used:
		inv_add(s, code, -used)
	return {"used": used, "applied": applied, "refused": refused, "end": end}


# ---- MAGIC: f_80e9a(char, spell) ---------------------------------------------------------------
## opts: mode (0 one, 1 all, -1 cancel; asked only when the spell allows both), targets.
## Returns {mode, casts, result: cancel | no-mp | empty | full | no-return | warp | done}.
static func cast_spell(s: GameState, caster: int, spell: int, opts := {}) -> Dictionary:
	var sp: Dictionary = tables()["spells"][spell]
	var cost: int = 0 if caster == 6 else sp["cost"]
	var mode: int
	if sp["single"] and sp["all"]:
		mode = int(opts["mode"]) if opts.get("mode") != null else -1
	else:
		mode = 0 if sp["single"] else 1 if sp["all"] else 2
	if mode == 0:
		var tg: Array = opts["targets"] if opts.get("targets") != null else []
		return _cast_one(s, caster, sp, cost, tg.duplicate())
	if mode == 1:
		return _cast_all(s, caster, spell, sp, cost)
	if mode == 2:
		if cget16(s, caster, C_MP) < cost:
			return {"mode": mode, "casts": 0, "result": "no-mp"}
		s.rt["targets"] = []
		effect(s, sp["effect"], 2, {"targets": []})
		_pay(s, caster, cost)
		return {"mode": mode, "casts": 1, "result": "done"}
	return {"mode": mode, "casts": 0, "result": "cancel"}


static func _pay(s: GameState, caster: int, n: int) -> void:
	cset16(s, caster, C_MP, (cget16(s, caster, C_MP) - n) & 0xffff)


static func _cast_one(s: GameState, caster: int, sp: Dictionary, cost: int, q: Array) -> Dictionary:
	var casts := 0
	while true:
		if cget16(s, caster, C_MP) < cost or not sp["single"]:
			return {"mode": 0, "casts": casts, "result": "no-mp"}
		var t: int = q.pop_front() if q.size() else -1
		if t == -1:
			return {"mode": 0, "casts": casts, "result": "cancel"}
		var c := party(s)[t]
		if cget16(s, c, C_HP) < cget16(s, c, C_MAXHP):
			s.rt["targets"] = [t]
			effect(s, sp["effect"], 2, {"targets": [t]})
			_pay(s, caster, cost)
			casts += 1
		if cget16(s, caster, C_MP) < cost:
			return {"mode": 0, "casts": casts, "result": "empty"}
	return {}


static func _cast_all(s: GameState, caster: int, spell: int, sp: Dictionary, cost: int) -> Dictionary:
	var c4 := cost * 4
	if cget16(s, caster, C_MP) < c4 or not sp["all"]:
		return {"mode": 1, "casts": 0, "result": "no-mp"}
	if spell == 1:
		if not s.be16(0x3ac):
			return {"mode": 1, "casts": 0, "result": "no-return"}
		_pay(s, caster, c4)
		s.rt["targets"] = []
		effect(s, sp["effect"], 2, {"targets": []})
		return {"mode": 1, "casts": 1, "result": "warp"}
	var any := false
	for c in party(s):
		if cget16(s, c, C_HP) < cget16(s, c, C_MAXHP):
			any = true
	if not any:
		return {"mode": 1, "casts": 0, "result": "full"}
	s.rt["targets"] = [0, 1, 2]
	effect(s, sp["effect"], 2, {"targets": [0, 1, 2]})
	_pay(s, caster, c4)
	return {"mode": 1, "casts": 1, "result": "done"}


## f_7e488: the spells a character knows, in menu order: {list, left, right} or null
static func spell_list(s: GameState, c: int) -> Variant:
	var tb := tables()
	var list := -1
	match c:
		0: list = 3 + s.be16(GameState.OFF_CUR_CHAR)
		3: list = 0
		6: list = 1
		7: list = 2
	if list < 0:
		return null
	var known: PackedInt32Array = tb["spell_lists"][list] if list < tb["spell_lists"].size() else PackedInt32Array()
	var cols := []
	for order: Array in [COL1, COL2]:
		var col := []
		for id: int in order:
			if known.has(id):
				var sp: Dictionary = tb["spells"][id]
				col.append({"spell": id, "name": sp["name"], "cost": sp["cost"], "field": sp["field"]})
		cols.append(col)
	return {"list": list, "left": cols[0], "right": cols[1]}


# ---- EQUIP: f_7f596(slot) ----------------------------------------------------------------------

## f_7f138: inventory items for row 0 weapon / 1 body armour / 2-4 accessories
static func equip_candidates(s: GameState, c: int, row: int) -> Array:
	var weapons: Array = tables()["weapons"]
	var kind := 2 if row == 0 else 3 if row == 1 else 4
	var out := []
	for i in 48:
		var code := slot_code(s, i)
		if not (code & 0xff) or not slot_count(s, i) or (code >> 8) != (3 if kind == 4 else kind):
			continue
		var idx := code & 0xff
		if kind == 2:
			var d: int = weapons[idx]["data_offset"] if idx < weapons.size() else 0
			var t := _raw(d + 4)
			if not (cget(s, c, C_MASK) & (1 << (t & 31))):   # JS shift count is mod 32
				continue
		if kind == 3:
			if c == 5:
				continue
			var cat := _armour_raw(idx).z
			if cat != 0 and not (cat == 5 and c == 3):
				continue
		if kind == 4:
			var cat := _armour_raw(idx).z
			if cat > 4 or cat < 1:
				continue
		out.append({"slot": i, "code": code, "index": idx, "count": slot_count(s, i)})
	return out


## item_index = the candidate's table index (-1 / null = cancelled).
## Returns equipped | full | clash | none | refused.
static func equip(s: GameState, pslot: int, row: int, item_index: Variant) -> String:
	var c := party(s)[pslot]
	if c == 4 or c == 6 or c > 7:
		return "refused"
	if item_index == null or int(item_index) == -1:
		return "none"
	var idx := int(item_index)
	var o := char_off(c)
	if row == 0:
		if not idx:
			return "none"
		if inv_add(s, 0x200 + idx, -1):
			return "none"
		return _equip_swap(s, pslot, 0x200, o + C_WEAPON, idx)
	if row == 1:
		if c == 5:
			return "refused"
		inv_add(s, 0x300 + idx, -1)
		return _equip_swap(s, pslot, 0x300, o + C_ARMOUR, idx)
	if row >= 2 and row <= 4:
		if idx:
			var cat := _armour_raw(idx).z
			for k in 3:
				if k == row - 2:
					continue
				if _armour_raw(s.block[o + C_ACC + k]).z == cat:
					return "clash"
		inv_add(s, 0x300 + idx, -1)
		return _equip_swap(s, pslot, 0x300, o + C_WEAPON + row, idx)
	return "none"


static func _equip_swap(s: GameState, pslot: int, base: int, at: int, idx: int) -> String:
	if inv_add(s, base + s.block[at], 1) == 0:
		s.block[at] = idx
		recompute_slot(s, pslot)
		return "equipped"
	inv_add(s, base + idx, 1)
	return "full"


# ---- shops: f_8393a(shop) / f_83b06(category) --------------------------------------------------

## Row the buy list opens on (rows: [{level}, ...])
static func shop_start_row(rows: Array, hero_level: int) -> int:
	var r := 0
	if rows.size():
		while true:
			if r >= rows.size() or int(rows[r]["level"]) > hero_level:
				break
			r += 1
			if r < rows.size() and int(rows[r]["level"]) == int(rows[r - 1]["level"]):
				r -= 1
				break
			if r >= rows.size():
				break
	return r - 1 if r else 0


## Returns bought | full | money | cancel
static func shop_buy(s: GameState, code: int, qi: int, confirm := true) -> String:
	if qi < 0 or not (code & 0xff):
		return "cancel"
	var qty: int = QUANTITIES[qi]
	var total := (item_price(code) * qty) & 0xffffffff
	if qi == 3:
		total = (total - (_s32(total) >> 3)) & 0xffffffff
	if not confirm:
		return "cancel"
	if inv_add(s, code, qty):
		return "full"
	if add_money(s, -total):
		inv_add(s, code, -qty)
		return "money"
	return "bought"


## Returns sold | refused | cancel
static func shop_sell(s: GameState, slot: int, qi: int, confirm := true) -> String:
	var code := slot_code(s, slot)
	var count := slot_count(s, slot)
	if not (code & 0xff) or is_key_item(code) or qi < 0:
		return "cancel"
	var qty: int = QUANTITIES[qi]
	if count < qty:
		qty = count
	var total := (((item_price(code) * qty) & 0xffffffff) * 3) / 4
	if total == 0 or code == 0x201:
		return "refused"
	if not confirm:
		return "cancel"
	inv_add(s, code, -qty)
	add_money(s, total)
	return "sold"


static func shop_total(code: int, qi: int, sell := false, count := NO_LIMIT) -> int:
	var p := item_price(code)
	if sell:
		var q := mini(QUANTITIES[qi], count)
		return floori(p * q * 3 / 4.0)
	var t: int = p * QUANTITIES[qi]
	if qi == 3:
		t -= floori(t / 8.0)
	return t


# ---- checkpoint, save, load (f_672c4, f_671d4, f_6703e, f_67348) -------------------------------

static func _set_actors(s: GameState, actors: PackedByteArray) -> void:
	for k in mini(60, actors.size()):
		s.block[GameState.OFF_PARTY_POS + k] = actors[k]


## the block as saved: on a hard-disk install the disk words are rewritten for the copy
static func _disk_copy(s: GameState) -> PackedByteArray:
	var w0 := s.be16(0)
	var w2 := s.be16(2)
	if s.rt.get("hdd", 0):
		s.set_be16(2, int(s.rt.get("disk_word", 0)))
		s.set_be16(0, 0)
	var copy := s.block.duplicate()
	s.set_be16(0, w0)
	s.set_be16(2, w2)
	return copy


## builtin 1(0) and the save menu's Quick (save side): the retry point (rt["backup"])
static func checkpoint(s: GameState, actors: Variant) -> void:
	if actors != null:
		_set_actors(s, actors)
	s.rt["checkpoint"] = 1
	s.rt["backup"] = _disk_copy(s)


## ISV<n>.DAT contents; the save also checkpoints
static func save_file(s: GameState, actors: Variant) -> PackedByteArray:
	if actors != null:
		_set_actors(s, actors)
	var file := _disk_copy(s)
	checkpoint(s, null)
	return file


## Loading a slot (opts.user_disk). Returns the party's 60 actor bytes.
static func load_file(s: GameState, bytes: PackedByteArray, opts := {}) -> PackedByteArray:
	var mouse := s.be16(GameState.OFF_MOUSE_MODE)
	for k in mini(bytes.size(), GameState.BLOCK_SIZE):
		s.block[k] = bytes[k]
	s.set_be16(GameState.OFF_MOUSE_MODE, mouse)
	s.set_be16(0, s.be16(2) if s.rt.get("hdd", 0) else (7 if opts.get("user_disk", false) else 0))
	s.rt["facing"] = s.block[GameState.OFF_PARTY_POS + 4]
	s.rt["next_map"] = s.map_id()
	var actors := s.block.slice(GameState.OFF_PARTY_POS, GameState.OFF_PARTY_POS + 60)
	checkpoint(s, actors)
	s.block[GameState.OFF_MAP_ID] = 0x7c
	s.rt["load_mode"] = 2
	return actors


## The save menu's Quick (load side) and the retry after a defeat (opts.drives)
static func restore_checkpoint(s: GameState, opts := {}) -> bool:
	var backup: Variant = s.rt.get("backup")
	if not s.rt.get("checkpoint", 0) or backup == null:
		return false
	var mouse := s.be16(GameState.OFF_MOUSE_MODE)
	var bk: PackedByteArray = backup
	for k in mini(bk.size(), GameState.BLOCK_SIZE):
		s.block[k] = bk[k]
	s.set_be16(GameState.OFF_MOUSE_MODE, mouse)
	s.set_be16(0, s.be16(2) if s.rt.get("hdd", 0) else (7 if opts.get("drives", 0) == 4 else 0))
	s.rt["next_map"] = s.map_id()
	s.block[GameState.OFF_MAP_ID] = 0x7c
	s.rt["pending_trigger"] = -1
	s.rt["last_trigger"] = -1
	s.rt["load_mode"] = 1
	return true


## What the slot list shows for a file (f_66bf4): {level, map, place}
static func slot_summary(bytes: PackedByteArray) -> Dictionary:
	var places: Array = tables()["places"]
	var id := char(bytes[0x124]) + char(bytes[0x125]) + char(bytes[0x126])
	var place: Variant = null
	for p: Dictionary in places:
		if p["id"] == id:
			place = p["name"]
			break
	if place == null and bytes[0x124] > 0x40:
		for p: Dictionary in places:
			if p["id"] == id.substr(0, 2) + "0":
				place = p["name"]
				break
	return {"level": bytes[0x221], "map": id, "place": place}


# ---- SYSTEM menu settings (block +$39A..) ------------------------------------------------------

## which: message / move / battle; dir > 0 up, else down (wraps 0..8)
static func step_speed(s: GameState, which: String, dir: int) -> int:
	var o: int = SPEED[which]
	var v := s.be16(o)
	v = (v + 1) % 9 if dir > 0 else (v - 1 if v else 8)
	s.set_be16(o, v)
	return v


## a click on the scale: the column, clamped to <= 8 (signed)
static func set_speed(s: GameState, which: String, v: int) -> int:
	v = _s16(v)
	if v > 8:
		v = 8
	s.set_be16(SPEED[which], v)
	return v


## which: vr / mouse / auto_avoid / talk
static func toggle_switch(s: GameState, which: String, mouse_available := true) -> int:
	if which == "mouse" and not mouse_available:
		return s.be16(SWITCH["mouse"])
	var o: int = SWITCH[which]
	s.set_be16(o, s.be16(o) ^ 1)
	return s.be16(o)


# ---- new game: f_72d5e -------------------------------------------------------------------------

static func new_game_systems(s: GameState) -> void:
	var tb := tables()
	var chars: Array = tb["initial_chars"]
	for c in chars.size():
		var r: PackedByteArray = chars[c]
		for k in r.size():
			s.block[char_off(c) + k] = r[k]
	for k in 0xc0:
		s.block[GameState.OFF_ITEMS + k] = 0
	for x: Vector2i in tb["initial_items"]:
		s.give_item(x.x, x.y)
	recompute_all(s)
	for k in 32:
		s.block[GameState.OFF_CHESTS + k] = 0
	s.set_money(140)
