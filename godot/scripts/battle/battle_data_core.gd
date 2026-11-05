extends RefCounted
## Battle model, part 1 (see scripts/battle/battle_model.gd, which extends this chain): constants,
## battle records, character records, messages, rng draws, target lists, hit checks, damage and
## the battle inventory helpers of tools/battle/model.mjs.

# battle records ($9F2A2 + 36*i; 0-2 party slots, 3-7 enemies): see model.mjs R
enum R {
	X = 0, ROW = 1, SPR = 2, F = 3, SLOT = 4, NAME = 5, DATA = 6, FLASH = 10, SEAL = 11, ILLU = 12,
	MBAR = 13, PBAR = 14, SLEEP = 15, CONF = 16, CLONE = 17, AGI = 18, CHARGE = 19, MP = 20, HP = 22,
	DEF = 24, ATK = 26, POSE = 28, LAST = 29, HITMOD = 30, CF = 31, SHEET = 32,
}

const GameState := preload("res://scripts/events/game_state.gd")
const CRand := preload("res://scripts/systems/c_rand.gd")
const SYS := preload("res://scripts/systems/systems_model.gd")
const BattleData := preload("res://scripts/battle/battle_data.gd")


# message addresses used by the battle (model.mjs M; templates: data/battle.json)
const M := {
	"encounter": 0x6abbc, "defeated": 0x6b396, "exp": 0x6b39f, "money": 0x6b3b0, "level_up": 0x6b4e2,
	"found": 0x6b630, "game_over": 0x6b79e, "turn": 0x8d160, "attack_with": 0x8d1ae, "dmg": 0x8d1bb,
	"dmg_each": 0x8d1cc, "transform": 0x8d21f, "use_item": 0x8d245, "cant_use": 0x8d252, "cast": 0x8d263,
	"fled": 0x8d274, "flee_fail": 0x8d285, "defend": 0x8d294, "pbar_absorb": 0x8d29d,
	"mbar_absorb": 0x8d2b6, "revived": 0x8d388, "pbar_break": 0x8d3a1, "mbar_break": 0x8d3ba,
	"cant_move": 0x8d375, "enemy_attack": 0x8d491, "cant_act": 0x8d49a, "sealed": 0x8d4a7,
	"poisoned": 0x8cdb1, "asleep": 0x8cdc4, "confused": 0x8cdd3, "judgement": 0x8cde4, "missed": 0x9d178,
	"quick_fail": 0x6b85c, "unsealed": 0x8cdfb, "unillusion": 0x8ce18, "awake": 0x8ce2b, "sane": 0x8ce3e,
	"unclone": 0x8ce51,
}
## Optional fixes of bugs of the original (bs["fixes"] = {name: true}; none = the original game,
## as every verification and golden case runs), see tools/battle/model.mjs FIXES:
## damage (16-bit square of f_6bd5e), status_messages (expiry lines never shown), flight (the target
## list read past the enemies), enemy_ai (the wrapped weight sum), effects (item / spell effect values
## and the spell cost bit, as the MSX code has them).
const FIXES := ["damage", "status_messages", "flight", "enemy_ai", "effects"]
const COUNTERS := [R.SEAL, R.ILLU, R.SLEEP, R.CONF, R.CLONE]
const WEAPON_LIKE := {106: 1, 107: 2, 108: 3, 109: 4, 110: 5, 111: 7}


static func load_battle_data() -> Dictionary:
	return BattleData.load_battle_data()


static func s16(v: int) -> int:
	v &= 0xffff
	return v - 0x10000 if v & 0x8000 else v


static func s8(v: int) -> int:
	v &= 0xff
	return v - 0x100 if v & 0x80 else v


static func _s32(v: int) -> int:
	v &= 0xffffffff
	return v - 0x100000000 if v & 0x80000000 else v


## LE word; bytes beyond the array read as 0 (as undefined does in the JS bit operations)
static func rd16(b: PackedByteArray, o: int) -> int:
	var n := b.size()
	var lo: int = b[o] if o >= 0 and o < n else 0
	var hi: int = b[o + 1] if o + 1 >= 0 and o + 1 < n else 0
	return lo | (hi << 8)


static func _rb(b: PackedByteArray, o: int) -> int:
	return b[o] if o >= 0 and o < b.size() else 0


static func _tbl(data: Dictionary, t: int) -> int:
	return data["off"][t]


static func _t4(data: Dictionary, code: int) -> int:
	return _tbl(data, 4) + 8 * (code & 0xffff)


static func _t5(data: Dictionary, e: int) -> int:
	return _tbl(data, 5) + 4 * e


static func _t9(data: Dictionary, sp: int) -> int:
	return _tbl(data, 9) + 10 * sp


static func _t6(data: Dictionary, w: int) -> int:
	return _tbl(data, 6) + 8 * w


static func _weapon_data(data: Dictionary, w: int) -> int:
	return rd16(data["raw"], _t6(data, w) + 6)


static func _t8(data: Dictionary, a: int) -> int:
	return _tbl(data, 8) + 4 * a - 164


## table 0 entry of a name id (f_6b926)
static func _name_entry(data: Dictionary, id: int) -> int:
	var b: PackedByteArray = data["raw"]
	var a := _tbl(data, 0)
	while b[a] != 0xff:
		if b[a] == id:
			return a
		a += 5
	return -1


static func br_get(bs: Dictionary, i: int, f: int) -> int:
	return bs["br"][36 * i + f]


static func br_set(bs: Dictionary, i: int, f: int, v: int) -> void:
	bs["br"][36 * i + f] = v & 255


static func br_get16(bs: Dictionary, i: int, f: int) -> int:
	var b: PackedByteArray = bs["br"]
	return b[36 * i + f] | (b[36 * i + f + 1] << 8)


static func br_set16(bs: Dictionary, i: int, f: int, v: int) -> void:
	bs["br"][36 * i + f] = v & 255
	bs["br"][36 * i + f + 1] = (v >> 8) & 255


static func _alive(bs: Dictionary, i: int) -> bool:
	return i >= 0 and i < 8 and (bs["br"][36 * i + 3] & 0x80) != 0


static func _is_party(bs: Dictionary, i: int) -> bool:
	return bs["br"][36 * i + R.SPR] <= 2


static func _char_of_slot(s: GameState, slot: int) -> int:
	return _party_word(s, slot)


## $9C9A0[k] (k may be > 2)
static func _party_word(s: GameState, k: int) -> int:
	var o := GameState.OFF_PARTY + 2 * k
	return (_rb(s.block, o) << 8) | _rb(s.block, o + 1)


## f_716c2
static func _char_of(s: GameState, bs: Dictionary, i: int) -> int:
	return _party_word(s, bs["br"][36 * i + R.SPR])


static func _char_rec(c: int) -> int:
	return GameState.OFF_CHARS + 40 * c


static func _cb(s: GameState, c: int, f: int) -> int:
	return _rb(s.block, _char_rec(c) + f)


static func _cw(s: GameState, c: int, f: int) -> int:
	return rd16(s.block, _char_rec(c) + f)


static func _set_cw(s: GameState, c: int, f: int, v: int) -> void:
	var o := _char_rec(c) + f
	if o >= 0 and o + 1 < s.block.size():
		s.block[o] = v & 255
		s.block[o + 1] = (v >> 8) & 255


## enemy attribute byte k of record i (bs.attrs[i] = 32 bytes)
static func _attr(bs: Dictionary, i: int, k: int) -> int:
	var a: Variant = bs["attrs"].get(i)
	if a == null or k >= a.size():
		return 0
	return int(a[k])


static func _attr16(bs: Dictionary, i: int, k: int) -> int:
	return _attr(bs, i, k) | (_attr(bs, i, k + 1) << 8)


static func clear_act(bs: Dictionary) -> void:
	bs["act"] = {
		"msg": 0, "msg_str": 0, "actor": 0, "hit": 0, "mult": 0, "skill": 0, "targets": [], "anim0": 0,
		"kind": 0, "emult": 0, "effect": 0, "anim1": 0, "anim2": 0, "anim3": 0, "element": 0,
		"anim_type": 0, "anim_sub": 0, "dmg": 0,
	}


static func _new_mg() -> Dictionary:
	return {"d9e": 0, "da0": 0, "da2": 0, "da4": 0, "dac": 0, "db0": 0, "db2": 0, "db6": 0, "db8": 0, "dba": 0}


static func _msg(bs: Dictionary, addr: int, str_off := 0) -> void:
	bs["log"].append({"t": "msg", "addr": addr, "str": str_off, "args": bs["mg"].duplicate()})


## f_6de9e
static func _msg_t(bs: Dictionary, i: int, addr: int) -> void:
	bs["mg"]["db6"] = 0
	bs["mg"]["db0"] = br_get(bs, i, R.NAME)
	_msg(bs, addr)


static func _act_msg(bs: Dictionary) -> void:
	_msg(bs, bs["act"]["msg"], bs["act"]["msg_str"])


static func _draw(bs: Dictionary, rng: CRand, n: int, at: String) -> int:
	var r := rng.mod(n)
	if n & 0xffff:
		bs["log"].append({"t": "rng", "n": n & 0xffff, "r": r, "at": at})
	return r


static func _opt(o: Dictionary, k: String, def: Variant) -> Variant:
	var v: Variant = o.get(k)
	return def if v == null else v


## copy a 36-byte record into slot i, keeping its sprite index (+2)
static func _put_record(bs: Dictionary, i: int, rec: PackedByteArray) -> void:
	var br: PackedByteArray = bs["br"]
	var keep := br[36 * i + 2]
	for j in 36:
		br[36 * i + j] = rec[j]
	br[36 * i + 2] = keep
	bs["br"] = br


static func _put16(b: PackedByteArray, o: int, v: int) -> void:
	b[o] = v & 255
	b[o + 1] = (v >> 8) & 255


## f_715f2(start, count, row): living records of list positions start.. in that row
static func _count_row(bs: Dictionary, start: int, count: int, row: int, list: Variant = null) -> int:
	var n := 0
	var ev: bool = bs["event"] != 0
	for k in count:
		var i: int = bs["order"][start + k]
		if not _alive(bs, i):
			continue
		if br_get(bs, i, R.ROW) != row and not ev:
			continue
		if ev and bs["group"] == 8 and i == 4:
			continue
		if not (br_get(bs, i, R.F) & 0x10) and list != null:
			list.append(i)
		n += 1
	return n


## f_7150a(start, count): living, not hidden records of list positions start..
static func _list_alive(bs: Dictionary, start: int, count: int) -> Array:
	var out := []
	var order: Array = bs["order"]
	for k in count:
		var i: int = order[start + k] if start + k < order.size() else 0
		if not _alive(bs, i):
			continue
		if bs["event"] and bs["group"] == 8 and i == 4:
			continue
		if br_get(bs, i, R.F) & 0x10:
			continue
		out.append(i)
	return out


## f_7116c: slot offset of an item code in the block, -1 = none
static func _find_slot(s: GameState, code: int) -> int:
	var key := ((code & 0xff00) == 0 and (code & 0xff) > 0x3f) or code == 0x231 or code == 0x217
	var base := GameState.OFF_KEY_ITEMS if key else GameState.OFF_ITEMS
	var n := 8 if key else 40
	for k in n:
		if s.le16(base + 4 * k) == code:
			return base + 4 * k
	return -1


## f_7122c(code, n): 0 = done, 1 = no slot
static func _give_item(s: GameState, code: int, n: int) -> int:
	if not (n & 0xff):
		return 0
	var p := _find_slot(s, code)
	if p >= 0:
		s.set_le16(p + 2, s16(s.le16(p + 2)) + s16(n))
		return 0
	p = _find_slot(s, 0)
	if p < 0:
		return 1
	s.set_le16(p, code)
	s.set_le16(p + 2, n)
	return 0


## f_712d8(code, n): count -= n (not below 0); 1 = not found
static func _take_item(s: GameState, code: int, n: int) -> int:
	if not (code & 0xff):
		return 0
	var p := _find_slot(s, code)
	if p < 0:
		return 1
	var v := s16(s.le16(p + 2)) - n
	if v < 0:
		v = 0
	s.set_le16(p + 2, v)
	return 0


## f_6c414(a, t, hit): chance = (hit + hitmod_a) * ((agi_a - agi_t)/2 + agi_t)/2 / (agi_a/2), 15..255
static func hit_check(bs: Dictionary, rng: CRand, a: int, t: int, hit: int) -> int:
	var d2 := (hit + s8(br_get(bs, a, R.HITMOD))) & 0xffff
	var aa := br_get(bs, a, R.AGI)
	var at := br_get(bs, t, R.AGI)
	var avg := s16(((aa - at) / 2 + at) / 2)
	var d3 := aa >> 1
	if d3 == 0:
		d3 = 1
	var prod := _s32(d2 * avg)
	var c := (prod / d3) & 0xffff
	if c > 255:
		c = 255
	if c <= 14:
		c = 15
	return 1 if _draw(bs, rng, 256, "hit") <= c else 0


## f_6c5f2(i, n): atk + atk/4 * (n - 1)
static func _attack_base(bs: Dictionary, i: int, n: int) -> int:
	if not n:
		n = 1
	var atk := br_get16(bs, i, R.ATK)
	return s16(atk + _s32((s16(atk) >> 2) * (n - 1)))


## f_6c548: defending halves; barriers absorb (magic: kind 5, else physical) -> 0
static func _guard(bs: Dictionary, t: int, d: int) -> int:
	if br_get(bs, t, R.F) & 0x20:
		d = s16(d) >> 1
	var magic: bool = bs["act"]["kind"] == 5
	var f := R.MBAR if magic else R.PBAR
	if br_get(bs, t, f):
		br_set(bs, t, f, br_get(bs, t, f) - 1)
		var addr: int
		if br_get(bs, t, f):
			addr = M["mbar_absorb"] if magic else M["pbar_absorb"]
		else:
			addr = M["mbar_break"] if magic else M["pbar_break"]
		_msg_t(bs, t, addr)
		d = 0
	return d


## f_6bd5e(t, d, def): (2d / (def/2))^2 / 4 in 16-bit arithmetic
static func _defend(bs: Dictionary, t: int, d: int, def: int) -> int:
	var d3 := s16(def) >> 1
	if not d3:
		d3 = 1
	var g := s16(_guard(bs, t, d))
	var q := (2 * g) / d3
	var sq := _s32(s16(q) * s16(q))
	if _fixed(bs, "damage"):
		return mini(9999, maxi(0, sq / 4))
	return s16(s16(sq) >> 2)


static func _fixed(bs: Dictionary, name: String) -> bool:
	var f: Variant = bs.get("fixes")
	return f is Dictionary and bool(f.get(name, false))


## f_6bc74: party target: element 6 vs armour bit 6, physical: armour bits 5, 4, 3
static func _party_damage(s: GameState, bs: Dictionary, t: int) -> int:
	var c := _char_of(s, bs, t)
	var fx := _cb(s, c, 36)
	var d := s16(bs["act"]["dmg"])
	if bs["act"]["element"] == 6 and (fx & 0x40):
		d = s16(d) >> 2
	if bs["act"]["kind"] != 5:
		if fx & 0x20:
			d = s16(d) >> 2
		if fx & 0x10:
			d = s16(d) >> 2
		if fx & 0x08:
			d = s16(d) >> 2
			var v := s16(br_get16(bs, t, R.MP) + (s16(d) >> 1))
			br_set16(bs, t, R.MP, v)
			if _cw(s, c, 8) < v:
				br_set16(bs, t, R.MP, _cw(s, c, 8))
	return _defend(bs, t, d, br_get16(bs, t, R.DEF))


## f_6c012: enemy target: immune when attribute 4 = the element (and element & 15), defence/2
static func _enemy_damage(bs: Dictionary, t: int) -> int:
	var d: int = bs["act"]["dmg"]
	var el := _attr(bs, t, 4)
	if el == bs["act"]["element"] and (el & 15):
		d = 0
	var def := s16(br_get16(bs, t, R.DEF)) / 2
	return _defend(bs, t, d, def)


## f_6bbb0: apply $A1AD2 to t
static func apply_damage(s: GameState, _data: Dictionary, bs: Dictionary, t: int) -> void:
	bs["log"].append({"t": "damage", "target": t, "base": s16(bs["act"]["dmg"])})
	if _is_party(bs, t):
		_take_party(s, bs, t, _party_damage(s, bs, t))
	else:
		_take_enemy(bs, t, _enemy_damage(bs, t))


## f_6be42: party record loses d (a message for each hit); 0 HP: revive once (CF bit 6)
static func _take_party(s: GameState, bs: Dictionary, t: int, d: int) -> void:
	bs["cb_armed"] = false
	if not d:
		return
	bs["mg"]["d9e"] = d & 0xffff
	bs["mg"]["db8"] = 0
	bs["mg"]["db2"] = br_get(bs, t, R.NAME)
	_msg(bs, M["dmg"])
	var v := s16(br_get16(bs, t, R.HP) - d)
	br_set16(bs, t, R.HP, v)
	bs["log"].back()["amount"] = d
	if v <= 0:
		br_set16(bs, t, R.HP, 0)
		if br_get(bs, t, R.CF) & 0x40:
			_msg(bs, M["revived"])
			br_set(bs, t, R.CF, br_get(bs, t, R.CF) & 0xbf)
			br_set16(bs, t, R.HP, _cw(s, _char_of(s, bs, t), 12))
	br_set(bs, t, R.FLASH, 4)


## f_6c0b0: enemy record loses d (only the first target shows the message); 0 HP: exp and money
static func _take_enemy(bs: Dictionary, t: int, d: int) -> void:
	var first: bool = bs["cb_armed"]
	bs["cb_armed"] = false
	if not d or not br_get16(bs, t, R.HP):
		return
	if first:
		bs["mg"]["d9e"] = d & 0xffff
		bs["mg"]["db8"] = 0
		bs["mg"]["db2"] = br_get(bs, t, R.NAME)
		_msg(bs, M["dmg"] if bs["act"]["targets"].size() <= 1 else M["dmg_each"])
	var v := s16(br_get16(bs, t, R.HP) - d)
	br_set16(bs, t, R.HP, v)
	if v <= 0:
		br_set16(bs, t, R.HP, 0)
		bs["exp"] = mini((bs["exp"] + s16(_attr16(bs, t, 20))) & 0xffffffff, 0xffff)
		bs["money"] = mini((bs["money"] + s16(_attr16(bs, t, 22))) & 0xffffffff, 0xffff)
	br_set(bs, t, R.FLASH, 4)


## the target cursor (f_70a96 / f_70bda): $A1B3C from the choice (or random when forced)
static func _pick_targets(bs: Dictionary, rng: CRand, _i: int, cands: Array, ch: Dictionary, initial: int) -> int:
	var t := initial
	if bs["forced"]:
		if t <= 0x7f:
			t = -1
			while t == -1 and not cands.is_empty():   # (an empty list loops forever in the original)
				var k := _draw(bs, rng, 8, "forcedTarget")
				t = cands[k] if k < cands.size() else -1
	else:
		t = int(_opt(ch, "target", initial))
	t &= 0xffff
	bs["last_target"] = t
	var out := []
	for c: int in cands:
		if t > 0x7f or c == t:
			out.append(c)
	bs["act"]["targets"] = out
	return t


## candidate list for f_71594 (front-row enemies) or random (confused)
static func _cand_front(bs: Dictionary, rng: CRand, i: int) -> Array:
	if br_get(bs, i, R.CONF):
		return _confused_list(bs, rng, i)
	var l := []
	_count_row(bs, 3, 5, 7, l)
	return l


## f_6f132: confused: every living record, entry 0 replaced by f_6f098's pick
static func _confused_list(bs: Dictionary, rng: CRand, i: int) -> Array:
	var l := _list_alive(bs, 0, 8)
	_pick_near(bs, rng, i, l)
	return l


## f_6f098(i, n, list): rng(2n)+1 steps; entries close to i (|x| <= 9) or decoys become entry 0
static func _pick_near(bs: Dictionary, rng: CRand, i: int, l: Array) -> int:
	var n := l.size()
	var steps := _draw(bs, rng, 2 * n, "target") + 1
	var k := 0
	var xi := br_get(bs, i, R.X)
	while steps > 0:
		steps -= 1
		k += 1
		if k >= n:
			k = 0
		if n == 0:
			continue
		var t: int = l[k]
		if (br_get(bs, t, R.CF) & 0x10) or absi(xi - br_get(bs, t, R.X)) <= 9:
			l[0] = l[k]
	return 1


## f_6efc8(i, start, count): one target (random, see f_6f098); confused: f_6f132, else the list of
## f_6f034: living records start .. start + count - 1 by record index (not through the list order)
static func _target_one(bs: Dictionary, rng: CRand, i: int, start: int, count: int) -> Array:
	if br_get(bs, i, R.CONF):
		return _confused_list(bs, rng, i).slice(0, 1)
	var l := []
	for r in range(start, start + count):
		if r < 8 and (br_get(bs, r, R.F) & 0x80):
			l.append(r)
	_pick_near(bs, rng, i, l)
	return [l[0]] if l.size() else []   # (the JS model gives [undefined] for an empty list)


## f_714b0(i, start, count): all (confused: a random one, f_6f132)
static func _targets_all(bs: Dictionary, i: int, start: int, count: int, rng: CRand = null) -> Array:
	if br_get(bs, i, R.CONF) and rng != null:
		var l := _list_alive(bs, 0, 8)
		_pick_near(bs, rng, i, l)
		return l.slice(0, 1)
	return _list_alive(bs, start, count)
