extends RefCounted
## Screen builders of the systems' interface (docs/systems-ui.md sections 3-7), transcribed from
## tools/systems-ui/screens.mjs: the exact bytes each command screen prints, built from the game
## state the way ICITY68 builds them (templates filled in place by sprintf / strcpy).
##
## Templates and names come from ui/strings.json (tools/export/uistrings.mjs: the ICITY68
## templates by address, IC_TABLE names); values derived by the game systems (item list, spells,
## equipment candidates, experience) from the systems model (sys, scripts/systems/systems_model.gd).

const GameState := preload("res://scripts/events/game_state.gd")

var state                     # GameState
var sys                       # the systems model (static functions taking the state)
var _strings := {}
var _lists := {}
var _bytes := {}
var _names := {}
var _flags := {}


func _init(game_state, systems_model) -> void:
	state = game_state
	sys = systems_model
	var d: Dictionary = GameData.json("ui/strings.json") if GameData.exists("ui/strings.json") else {}
	for k in d.get("strings", {}):
		_strings[k.hex_to_int()] = Marshalls.base64_to_raw(d["strings"][k])
	for k in d.get("lists", {}):
		var l: Array = []
		for s in d["lists"][k]:
			l.append(Marshalls.base64_to_raw(s))
		_lists[k.hex_to_int()] = l
	for k in d.get("bytes", {}):
		_bytes[k.hex_to_int()] = Marshalls.base64_to_raw(d["bytes"][k])
	_names = d.get("names", {})
	_flags = d.get("flags", {})


func available() -> bool:
	return not _strings.is_empty()


# --- strings -------------------------------------------------------------------------------------

## A template (a fresh copy, filled in place by the builders).
func cstr(addr: int) -> PackedByteArray:
	return (_strings.get(addr, PackedByteArray()) as PackedByteArray).duplicate()


func str_list(addr: int) -> Array:
	var out: Array = []
	for s: PackedByteArray in _lists.get(addr, []):
		out.append(s.duplicate())
	return out


func image_byte(addr: int) -> int:
	for base: int in _bytes:
		var b: PackedByteArray = _bytes[base]
		if addr >= base and addr < base + b.size():
			return b[addr - base]
	return 0


func _name(kind: String, i: int) -> PackedByteArray:
	var l: Array = _names.get(kind, [])
	return Marshalls.base64_to_raw(l[i]) if i >= 0 and i < l.size() else PackedByteArray()


func char_name(id: int) -> PackedByteArray:
	var d: Dictionary = _names.get("chars", {})
	return Marshalls.base64_to_raw(d[str(id)]) if d.has(str(id)) else PackedByteArray()


## f_7ea98: name by class (high byte 0/1 items, 2 weapons, 3 armour).
func item_name(code: int) -> PackedByteArray:
	var h := code >> 8
	var i := code & 0xff
	if h <= 1:
		return _name("items", i)
	if h == 2:
		return _name("weapons", i)
	if h == 3:
		return _name("armour", i)
	return PackedByteArray()


func spell_name(id: int) -> PackedByteArray:
	return _name("spells", id)


func _flag(kind: String, i: int) -> Variant:
	var l: Array = _flags.get(kind, [])
	return l[i] if i >= 0 and i < l.size() else null


## strcpy without the terminator: overwrite dst at off (extending it if needed); returns the end.
static func put(dst: PackedByteArray, off: int, src: PackedByteArray) -> int:
	if dst.size() < off + src.size():
		dst.resize(off + src.size())
	for i in src.size():
		dst[off + i] = src[i]
	return off + src.size()


static func fmt(v: int, n: int) -> PackedByteArray:
	return str(v).lpad(n).to_ascii_buffer()


static func signed(v: int, n: int) -> PackedByteArray:
	var out := PackedByteArray([0x2d if v < 0 else 0x2b])
	out.append_array(fmt(absi(v), n))
	return out


static func s8(v: int) -> int:
	return v - 256 if v >= 128 else v


# --- state ---------------------------------------------------------------------------------------

func party_size() -> int:
	return state.be16(GameState.OFF_PARTY_COUNT)


func member(k: int) -> int:
	return state.be16(GameState.OFF_PARTY + 2 * k)


## Character record fields; outside the block (ids of guests > 7) they read 0, as the reference does.
func cb(c: int, f: int) -> int:
	var o: int = GameState.OFF_CHARS + GameState.CHAR_SIZE * c + f
	return state.block[o] if o < state.block.size() else 0


func cw(c: int, f: int) -> int:
	return cb(c, f) | (cb(c, f + 1) << 8)


# --- fixed menus ---------------------------------------------------------------------------------

func command_menu() -> Array:
	return str_list(0x9c3f0)


func status_menu() -> Array:
	return str_list(0x9c504)


func system_menu() -> Array:
	return str_list(0x9c5cc)


func load_menu(save: bool) -> Array:
	var out: Array = [cstr(0x6745c if save else 0x67451)]
	out.append_array(str_list(0x8cb72))
	return out


func discard_menu() -> Array:
	return str_list(0x9c490)


func confirm_menu() -> Array:
	return str_list(0x9c4a4)


func item_command_row() -> Array:
	return str_list(0x9c46c)


# --- builders ------------------------------------------------------------------------------------

## f_7e0d8: "所持金 %7ldH$" (number at +7).
func money_line() -> PackedByteArray:
	var t := cstr(0x9c3ce)
	put(t, 7, fmt(state.money(), 7))
	return t


## f_7e350: per member "$0E $01" + 14 spaces, name at +2 and colour 7 when its sprite is shown;
## blank entries up to 3. visible[k] = sprite +8 of party slot k.
func charsel_items(visible: Array) -> Array:
	var out: Array = []
	for k in party_size():
		var e := cstr(0x7e32e)
		if int(visible[k]) & 0x80:
			put(e, 2, char_name(member(k)))
			e[1] = 7
		out.append(e)
	for k in range(party_size(), 3):
		out.append(cstr(0x7e33f))
	return out


func charsel_accepted(items: Array) -> Array:
	var out: Array = []
	for k in items.size():
		var e: PackedByteArray = items[k]
		out.append(e[1] == 7 and state.be16(GameState.OFF_PARTY_C + 2 * k) == 0)
	return out


## f_7ea98(mode): the 48 inventory rows (0 use, 1 sort, 2 drop, 3 all); [entries, rows].
func item_entries(mode: int) -> Array:
	var rows: Array = sys.item_list(state, mode)
	var out: Array = []
	for r: Dictionary in rows:
		var e := cstr(0x7ea7a)
		var code: int = r["code"]
		var en := false
		if mode == 0:
			en = (code >> 8) <= 1 and _flag("itemField", code & 0xff) == true
		elif mode == 1:
			en = int(r["slot"]) <= 0x27
		elif mode == 2:
			en = not sys.is_key_item(code)
		else:
			en = true
		if en:
			e[1] = 7
		if code & 0xff:
			put(e, 2, item_name(code))
			put(e, 20, cstr(0x7ea95))
			put(e, 22, fmt(int(r["count"]), 4))
		out.append(e)
	return [out, rows]


## f_7e488: MAGIC header lines, or [] when the character has no spell list.
func magic_header(slot: int) -> Array:
	var c := member(slot)
	if sys.spell_list(state, c) == null:
		return []
	var lines := str_list(0x9c42c)
	put(lines[0], 6, cstr(0x7e46a))
	put(lines[0], 6, char_name(c))
	put(lines[3], 6, fmt(cw(c, 10), 4))
	put(lines[4], 6, fmt(cw(c, 8), 4))
	return lines


## The 32 spell entries (even = left column, odd = right) and the spell id per entry (0 = none).
func spell_entries(slot: int) -> Array:
	var sl: Variant = sys.spell_list(state, member(slot))
	if sl == null:
		return [[], []]
	var out: Array = []
	var ids: Array = []
	for k in 32:
		out.append(cstr(0x7e47d))
		ids.append(0)
	for col in 2:
		var l: Array = sl["left"] if col == 0 else sl["right"]
		for k in l.size():
			var sp: int = l[k]["spell"]
			var e: PackedByteArray = out[col + 2 * k]
			put(e, 2, spell_name(sp))
			if _flag("spellField", sp) == true:
				e[1] = 7
			ids[col + 2 * k] = sp
	return [out, ids]


## f_7f386: EQUIP header (menu items, 2 header rows) and the five bonus lines.
func equip_header(slot: int) -> Dictionary:
	var c := member(slot)
	var items := str_list(0x9c4b8)
	put(items[0], 8, cstr(0x7e46a))
	put(items[0], 8, char_name(c))
	put(items[2], 4, cstr(0x7f370))
	if cb(c, 23):
		put(items[2], 4, item_name(0x200 | cb(c, 23)))
	for k in 4:
		put(items[3 + k], 4, cstr(0x7f370))
		if cb(c, 24 + k):
			put(items[3 + k], 4, item_name(0x300 | cb(c, 24 + k)))
	var bonus := str_list(0x9c4e0).slice(0, 5)
	put(bonus[0], 6, fmt(cw(c, 20), 3))
	put(bonus[1], 6, fmt(cw(c, 17), 3))
	put(bonus[2], 4, signed(s8(cb(c, 7)), 4))
	var sh := skill_hit(c)
	put(bonus[3], 6, fmt(sh[0] >> 3, 3))
	put(bonus[4], 6, fmt(sh[1], 3))
	return {"items": items, "bonus": bonus}


## f_80b16: [weapon skill counter, hit rate] ([0, 0] without a weapon).
func skill_hit(c: int) -> Array:
	var w := cb(c, 23)
	if not w:
		return [0, 0]
	var type: int = _flag("weaponType", w) if _flag("weaponType", w) != null else 0
	var skill := cw(c, 28 + 2 * image_byte(0x9c78c + type))
	var hit := skill_to_hit(skill) + s8(cb(c, 5)) + 1
	hit = (hit * 25 + 24) & 0xffff
	hit = hit - 0x10000 if hit >= 0x8000 else hit
	hit = (hit + 63 if hit < 0 else hit) >> 6
	return [skill, hit & 0xffff]


static func skill_to_hit(skill: int) -> int:
	var s := skill - 0x10000 if skill >= 0x8000 else skill
	var n := s * 16 + 15
	return n / 42 if n >= 0 else -((-n) / 42)


## f_7f138: EQUIP candidates of character c for row (0 weapon, 1 body, 2-4 accessory): 48 entries
## and the candidates [{slot, code, index, count}].
func equip_entries(c: int, row: int) -> Array:
	var out: Array = []
	for k in 48:
		out.append(cstr(0x7f11c))
	var cands: Array = sys.equip_candidates(state, c, mini(row, 2))
	for k in cands.size():
		var it: Dictionary = cands[k]
		var e: PackedByteArray = out[k]
		put(e, 2, item_name(int(it["code"])))
		put(e, 20, cstr(0x7ea95))
		put(e, 22, fmt(int(it["count"]), 4))
	return [out, cands]


## f_7fb1a: STATUS > personal data, 13 lines.
func personal_lines(slot: int) -> Array:
	var c := member(slot)
	var l := str_list(0x9c51c)
	put(l[0], 0, cstr(0x7fae4))
	var p := put(l[0], 2, char_name(c))
	p = put(l[0], p, cstr(0x7fafd))
	put(l[0], p, _name("classes", c))
	put(l[1], 14, fmt(cb(c, 3), 2))
	put(l[2], 9, fmt(cb(c, 0) | (cb(c, 1) << 8) | (cb(c, 2) << 16), 7))
	put(l[3], 9, fmt(int(sys.exp_needed(state, c)), 7))
	put(l[5], 7, fmt(cw(c, 14), 4))
	put(l[5], 12, fmt(cw(c, 12), 4))
	put(l[6], 7, fmt(cw(c, 10), 4))
	put(l[6], 12, fmt(cw(c, 8), 4))
	put(l[8], 9, fmt(cb(c, 19), 3))
	put(l[8], 13, fmt(cw(c, 20), 3))
	put(l[9], 9, fmt(cb(c, 16), 3))
	put(l[9], 13, fmt(cw(c, 17), 3))
	put(l[10], 9, fmt(cb(c, 6), 3))
	put(l[10], 12, signed(s8(cb(c, 7)), 3))
	put(l[11], 9, cstr(0x7fb04))
	put(l[12], 9, cstr(0x7fb14))
	if cb(c, 23):
		l[11][14] = 0x28
		var type: int = _flag("weaponType", cb(c, 23)) if _flag("weaponType", cb(c, 23)) != null else 0
		var nm := _name("weaponTypes", type)
		if type == 4:
			nm = nm.slice(0, 8)
		var e := put(l[11], 15, nm)
		put(l[11], e, PackedByteArray([0x29]))
		var sh := skill_hit(c)
		put(l[11], 9, fmt(sh[0] >> 3, 3))
		put(l[12], 9, fmt(sh[1], 3))
	return l


## f_7ff90: STATUS > skills.
func skill_lines() -> Array:
	var l := str_list(0x9c55c)
	for k in 3:
		var c := member(k)
		put(l[2 + k], 0, cstr(0x7ff70))
		put(l[7 + k], 0, cstr(0x7ff70))
		if k >= party_size() or c > 7:
			continue
		put(l[2 + k], 0, char_name(c))
		put(l[7 + k], 0, char_name(c))
		for t in 8:
			var e := 0x9c70e + 4 * t
			var v: PackedByteArray
			if cb(c, 22) & image_byte(e):
				v = fmt(cw(c, 28 + 2 * image_byte(e + 3)) >> 3, 3)
			else:
				v = cstr(0x7ff8b).slice(0, 3)
			put(l[image_byte(e + 1) + k], image_byte(e + 2), v)
	return l


## f_817ec's lines: the HP / MP block of the battle-strength lines (list $9C5B0 = lines 6-9 of
## $9C598, filled by f_8011e), shown by item use and field magic under a title.
func party_status_lines() -> Array:
	return strength_lines().slice(6, 10)


## ［術効果］ 個別 / 集団 (f_80e9a's choice for spells that take one or all, $9C454; header 1).
func spell_mode_menu() -> Array:
	return str_list(0x9c454)


## f_8011e: STATUS > battle strength.
func strength_lines() -> Array:
	var l := str_list(0x9c598)
	for k in 3:
		var c := member(k)
		var a: PackedByteArray = l[2 + k]
		var b: PackedByteArray = l[7 + k]
		put(a, 0, cstr(0x800e0))
		put(b, 0, cstr(0x800fe))
		if k >= party_size() or c > 7:
			continue
		put(a, 0, char_name(c))
		put(b, 0, char_name(c))
		put(a, 12, fmt(cb(c, 19) + cw(c, 20), 3))
		put(a, 19, fmt(cb(c, 16) + cw(c, 17), 3))
		put(a, 26, fmt(cb(c, 6) + s8(cb(c, 7)), 3))
		put(b, 11, fmt(cw(c, 14), 4))
		put(b, 16, fmt(cw(c, 12), 4))
		put(b, 22, fmt(cw(c, 10), 4))
		put(b, 27, fmt(cw(c, 8), 4))
	return l


# --- shops (f_8393a / f_83b06) -------------------------------------------------------------------

## A buy-list entry: "$0E $07" + name at +2, price "%6ld" + "H$" at +20 (blank for an empty code).
func shop_entry(code: int, price: int) -> PackedByteArray:
	var e := cstr(0x7f11c)
	if code & 0xff:
		put(e, 2, item_name(code))
		put(e, 20, fmt(price, 6))
		put(e, 26, "H$".to_ascii_buffer())
	return e


func buy_quantities() -> Array:
	return str_list(0x9cf9a)


func sell_quantities() -> Array:
	return str_list(0x9cf7a)


## The shop's message: "［name］×%dセットで、%ldH$です。\n所持金 %07ldH$\n" (templates $83ACC / $83AE7).
func shop_offer(code: int, qty: int, total: int) -> Array:
	var head := GameText.encode_sjis("［")
	head.append_array(_trimmed(item_name(code)))
	head.append_array(GameText.encode_sjis("］"))
	var line := head
	line.append_array(_sprintf(cstr(0x83acc), [qty, total]))
	var money := _sprintf(cstr(0x83ae7), [state.money()])
	return [line, money]


## A name without its padding (spaces, full-width spaces).
static func _trimmed(b: PackedByteArray) -> PackedByteArray:
	var n := b.size()
	while true:
		if n >= 1 and b[n - 1] == 0x20:
			n -= 1
		elif n >= 2 and b[n - 2] == 0x81 and b[n - 1] == 0x40:
			n -= 2
		else:
			break
	return b.slice(0, n)


## The few printf conversions the shop templates use: %d, %ld, %07ld.
static func _sprintf(t: PackedByteArray, values: Array) -> PackedByteArray:
	var out := PackedByteArray()
	var i := 0
	var k := 0
	while i < t.size():
		if t[i] == 0x25 and i + 1 < t.size():
			var j := i + 1
			var zero := false
			var width := 0
			if t[j] == 0x30:
				zero = true
				j += 1
			while j < t.size() and t[j] >= 0x30 and t[j] <= 0x39:
				width = width * 10 + t[j] - 0x30
				j += 1
			if j < t.size() and t[j] == 0x6c:
				j += 1
			if j < t.size() and t[j] == 0x64:
				var v := str(int(values[k]) if k < values.size() else 0)
				k += 1
				v = v.lpad(width, "0" if zero else " ")
				out.append_array(v.to_ascii_buffer())
				i = j + 1
				continue
		out.append(t[i])
		i += 1
	return out


# --- save / load slot list (f_66bf4) -------------------------------------------------------------

## Menu items (header 1, as the system trace records them): the column header, then per slot "　n　" + level
## ("ｌｖ" two full-width digits, "−−" for an empty slot) + place name or "未登録".
## summaries: per slot {level, place} or null.
func slot_items(_save: bool, summaries: Array) -> Array:
	var out: Array = [cstr(0x8cb18)]
	for n in summaries.size():
		var e := cstr(0x8cb2b)
		e[3] = 0x50 + n         # full-width digit n + 1 ($8250 = '１')
		var sm: Variant = summaries[n]
		if sm == null:
			e.append_array(cstr(0x8cb32))
			e.append_array(cstr(0x8cb40))
		else:
			var lv := cstr(0x8cb39)
			var level: int = int(sm["level"]) % 100
			lv[1] = 0x4f + level / 10
			lv[3] = 0x4f + level % 10
			e.append_array(lv)
			e.append_array(GameText.encode_sjis(str(sm["place"]) if sm["place"] != null else str(sm["map"])))
		out.append(e)
	return out


# --- SYSTEM sub-screens (f_829d0, f_80516, the BGM menu) -----------------------------------------

## ［スピード調整］ lines ($9C5E8), printed as menu rows.
func speed_lines() -> Array:
	return str_list(0x9c5e8)


## The ▲ under speed value v (0-8) on the 1..9 scale: 3·v spaces, ▲, padded to 28 bytes.
static func speed_marker(v: int) -> PackedByteArray:
	var out := PackedByteArray()
	for k in 3 * v:
		out.append(0x20)
	out.append_array([0x81, 0xa3])
	while out.size() < 28:
		out.append(0x20)
	return out


## ［スイッチ切替］ menu ($9C610): title, "", then the four switches with ON / OFF at +18.
## values: VR, mouse, auto-avoid, talk.
func switch_items(values: Array) -> Array:
	var items := str_list(0x9c610)
	for k in 4:
		if 2 + k < items.size():
			put(items[2 + k], 18, cstr(0x9c3df if values[k] else 0x9c3e3))
	return items


## ［ＢＧＭメニュー］ text ($9C634) with the track title after "曲名：".
func bgm_text(title: String) -> PackedByteArray:
	var t := cstr(0x9c634)
	put(t, 30, GameText.encode_sjis(title))
	return t
