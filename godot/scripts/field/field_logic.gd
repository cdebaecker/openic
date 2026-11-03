extends RefCounted
## ICITY68's field movement, one game tick at a time: a transcription of the reference model
## tools/field/model.mjs (itself a transcription of the original routines, named in comments),
## which reproduces the recorded traces exactly. See docs/field.md.
##
##   var f := FieldLogic.new(map, party, view)
##   var events := f.tick(bits, mouse)   # bits: input word as f_8822e builds it

const NONE := 0x80

# Input bits: 1 up, 2 down, 4 left, 8 right, $10/$20 Z/X, $40 Return, $80 Space, $8000 ESC.
const DIR_OF_BITS := [NONE, 0, 4, NONE, 6, 7, 5, 6, 2, 1, 3, 2, NONE, 0, 4, NONE]  # $9BFAC
# Direction 0..7 = N NE E SE S SW W NW -> cardinal steps (vertical part first), $9BFD0.
const STEPS := [[0, NONE], [0, 1], [NONE, 1], [2, 1], [2, NONE], [2, 3], [NONE, 3], [0, 3]]
const DELTA := [Vector2i(0, -1), Vector2i(1, 0), Vector2i(0, 1), Vector2i(-1, 0)]  # $9BFE0
const FACE := [0x80, 0x81, 0x85, 0x89, 0x8a, 0x8b, 0x8f, 0x83]  # $9BFC8
const SLIDE_DEFAULT := [0, 1, 0xff, 2, 0xfe, NONE]  # $9BFC2
const PUSH := [0, 1, 0xff, 2, 0xfe, NONE]  # $9BFBC
const MOUSE_BITS := [[1, 9, 8], [1, 5, 4], [2, 10, 8], [2, 6, 4]]  # $9C0E6
const WINDOW := Vector2i(24, 18)
const FORMATION_TWO := "041102068010" + "0e0280130a0e8012060a80"
const FORMATION_THREE1 := "081c11104403145580221013400f165780201312" + "4c0b1859801e121148071a5b80"
const FORMATION_THREE2 := "081d11124405145580231013400116578021131" + "04c0d1859801f121148091a5b80"
const SLOT_OFFSETS := (
	"fffc0000fffd0001fffe0002ffff00030000000400010003000200020003000100040000fffdffff0002fffe"
	+ "fffffffd0000fffcfffffffdfffefffe0003fffffffe000000000002000200000000fffeffff000300010005"
	+ "fffdfffffffb00010001fffdfffffffb000300010005ffffffff000200010002000200010002ffff0001fffe"
	+ "fffffffefffefffffffe0001"
)


class Actor:
	var x := 0
	var y := 0
	var facing := 0
	var flags := 0
	var w := 2
	var h := 1
	var step := 0
	var shown := 0
	var layer := 0
	var visible := 0
	var dir := 0
	var type := -1


var map  # FieldMap
var w2 := 0
var h2 := 0
var min_view := Vector2i.ZERO
var n := 3
var act: Array[Actor] = []
var view := Vector2i.ZERO
var slide: Array = SLIDE_DEFAULT.duplicate()
var last_trigger := -1
var pending := -1
var auto_walk := 0
var auto_bits := 0
var mouse_mode := 1
var seq_len := 4
var events: Array = []
var input_after_mouse := 0
var arrival := Vector2i.ZERO

var _dir := NONE
var _slide_used := NONE
var _ef38 := 0
var _hit := -1
var _push_depth := 0
var _ptr := 0
var _leader_conveyed := 0
var _two := PackedByteArray()
var _three1 := PackedByteArray()
var _three2 := PackedByteArray()
var _slots: Array[Vector2i] = []


func _init(field_map, party: Array, start_view: Vector2i) -> void:
	_two = FORMATION_TWO.hex_decode()
	_three1 = FORMATION_THREE1.hex_decode()
	_three2 = FORMATION_THREE2.hex_decode()
	var offs := SLOT_OFFSETS.hex_decode()
	for i in offs.size() / 4:
		_slots.append(Vector2i(_s16(offs[4 * i] << 8 | offs[4 * i + 1]), _s16(offs[4 * i + 2] << 8 | offs[4 * i + 3])))
	for i in 32:
		act.append(Actor.new())
	set_map(field_map)
	n = party.size()
	for i in party.size():
		var p: Dictionary = party[i]
		var a := act[i]
		a.x = p.get("x", 0)
		a.y = p.get("y", 0)
		a.facing = p.get("facing", 2)
		a.dir = a.facing
		a.flags = p.get("flags", 0x80)
		a.w = p.get("w", 2)
		a.h = p.get("h", 1)
		a.step = p.get("step", 0)
		a.layer = p.get("layer", 0)
		a.visible = p.get("visible", 0x80)
	view = start_view


func set_map(field_map) -> void:
	map = field_map
	w2 = map.width * 2   # $9EF30 / $9C8D2
	h2 = map.height * 2


static func _s16(v: int) -> int:
	return v - 0x10000 if v & 0x8000 else v


## Attribute word of the vr tile at (x, y) (f_78204 + f_78274): attr[tile*2 + bit 8 of the entry].
func attr_at(x: int, y: int) -> int:
	var e: int = map.tile_at(map.vr_cells, map.vr_meta, x, y)
	if e < 0:
		return 0
	var i := (e & 255) * 2 + ((e >> 8) & 1)
	return map.attr_words[i] if i < map.attr_words.size() else 0


# --- collision ---------------------------------------------------------------------------------

func tile_blocked(a: int) -> int:  # f_77934
	var r := act[a]
	var bit := 4 << (8 * r.layer)
	for i in r.w:
		if attr_at(r.x + i, r.y) & bit:
			return 1
	return 0


func overlap(a: int) -> int:  # f_7763a
	var ra := act[a]
	for j in 32:
		var rb := act[j]
		if not (rb.flags & 0x80) or rb.visible != 0x80:
			continue
		if (a > 2 or j > 2) and (rb.layer & 1) != (ra.layer & 1):
			continue
		if j == a:
			continue
		if rb.x + rb.w - 1 < ra.x or rb.x > ra.x + ra.w - 1:
			continue
		if rb.y + 1 - rb.h > ra.y or rb.y < ra.y + 1 - ra.h:
			continue
		return j
	return -1


func _step(a: int, s: int, chk: int) -> int:  # f_77840
	var r := act[a]
	if s != NONE:
		r.x += DELTA[s].x
		r.y += DELTA[s].y
		if r.x > w2 or r.y > h2:
			return 1
		if a == 0:
			check_triggers(0)
	return tile_blocked(a) if chk else 0


func _move(a: int, d: int, flag: int) -> int:  # f_775e0: 0 free, 1 tile/edge, 2 actor (_hit)
	var s: Array = STEPS[d]
	var r := _step(a, s[0], flag if flag <= 1 else 0) | _step(a, s[1], 1)
	if r:
		return 1
	var j := overlap(a)
	if j >= 0:
		_hit = j
		return 2
	return 0


func _save(a: int) -> Vector2i:
	return Vector2i(act[a].x, act[a].y)


func _restore(a: int, p: Vector2i) -> void:
	act[a].x = p.x
	act[a].y = p.y


func _try_move_keep(a: int, d: int, flag: int) -> int:  # f_7743a
	var p := _save(a)
	var r := _move(a, d, flag)
	if r:
		_restore(a, p)
	return r


# --- leader ------------------------------------------------------------------------------------

func _try_leader(d: int) -> int:  # f_76602(0, d)
	var p := _save(0)
	var r := _move(0, d, 1)
	if r == 0:
		return 0
	if r == 1:
		_restore(0, p)
		return 0 if pending != -1 else 1
	var j := _hit
	if j <= 2:
		_push_depth = 1
		if _push(j, d) == 0:
			return 0
		_restore(0, p)
		return 1
	var t := act[j].type
	_restore(0, p)
	if t == 0 or t == 2:
		events.append({"kind": "talk", "actor": j, "state": 1})
		return 0
	if t == 3:
		events.append({"kind": "actor", "actor": j, "state": 2})
		return 0
	if t == 4:
		events.append({"kind": "actor", "actor": j, "state": 3})
		return 0
	return 2


func _push(j: int, d: int) -> int:  # f_76daa
	if _push_depth > 2:
		return _push_depth
	if j == 0:
		return 1
	_push_depth += 1
	var k := 0
	while PUSH[k] != NONE:
		var d4: int = (PUSH[k] + d) & 7
		if _push_one(j, d4) == 0 or _push_two(j, d4) == 0:
			act[j].flags |= 2
			set_facing(j, d4)
			_sync_sprite(j)
			return 0
		k += 1
	return 1


func _push_one(j: int, d: int) -> int:  # f_76e9e
	var p := _save(j)
	var r := _move(j, d, 2)
	if r == 0:
		return 0
	if r == 2 and _hit <= 2 and _push(_hit, d) == 0:
		return 0
	_restore(j, p)
	return 1


func _push_two(j: int, d: int) -> int:  # f_76f6c
	var p := _save(j)
	var r := _move(j, d, 2)
	if r != 1 and _push_one(j, d) == 0:
		return 0
	_restore(j, p)
	return 1


func set_facing(a: int, d: int) -> void:  # f_77ace
	if d == NONE:
		return
	var v: int = FACE[d]
	var p := v & 3
	var q := (v >> 2) & 3
	var r := act[a]
	r.facing &= 3
	while r.facing != p and r.facing != q:
		r.facing = (r.facing + 1) & 3


func _sync_sprite(a: int) -> void:  # f_77b3a
	act[a].dir = act[a].facing


func _animate(a: int) -> void:  # f_755e0: show seq[step], then advance
	var r := act[a]
	r.shown = r.step
	r.step = (r.step + 1) % seq_len


func _conveyor(a: int, flag: int) -> int:  # f_76440
	var r := act[a]
	var at := 0
	for i in r.w:
		at = attr_at(r.x + i, r.y)
		if at & 0xf800:
			break
	var t := at & 0xc000
	if t == 0 and (at & 0x3800):
		r.layer = (at & 0x1800) >> 12
		r.flags = r.flags | 1 if r.layer else r.flags & ~1
		return 0
	if t == 0x8000:
		var p := _save(a)
		if _move(a, (at & 0x3800) >> 11, flag):
			_restore(a, p)
			return 0
		return 1
	return 0


# --- triggers (f_79b3a, f_79d4c) ----------------------------------------------------------------

func check_triggers(mode: int) -> int:
	var lead := act[0]
	lead.h = 1
	for i in map.triggers.size():
		var t: Dictionary = map.triggers[i]
		var tx: int = t["x"]
		var ty: int = t["y"]
		if tx >= lead.x + lead.w or tx + int(t["w"]) < lead.x:
			lead.w = 2
			continue
		if ty > lead.y or ty + int(t["h"]) <= lead.y - lead.h:
			lead.w = 2
			continue
		if i != last_trigger:
			pending = i
			arrival = Vector2i(lead.x - tx, lead.y - ty)
		lead.w = 2
		return 1
	if mode:
		last_trigger = -1
	return 0


func _fire_trigger() -> void:
	if pending == -1:
		return
	var i := pending
	var t: Dictionary = map.triggers[i]
	last_trigger = i
	pending = -1
	var ev := {"kind": "trigger", "index": i, "entry": t["entry"], "dest": t.get("dest")}
	if not (int(t["flags"]) & 0x80):
		ev["warp"] = t.get("dest")
		ev["dest_trigger"] = (int(t["flags"]) & 0xff) - 1
	events.append(ev)


# --- mouse (f_75d8c) -------------------------------------------------------------------------------

## mouse = {buttons (bit 0 left, bit 1 right), x, y} in the game's coordinates:
## x = screen x - 64, y = (screen y mod 512) / 2 - 24.
func _mouse_bits(bits: int, mouse: Variant) -> int:
	if mouse == null or not mouse_mode:
		return bits
	var x: int = mouse["x"]
	var y: int = mouse["y"]
	var b: int = mouse["buttons"]
	var d3 := 0
	var d4 := 0
	if not (b & 3) and not auto_walk:
		return bits
	var lead := act[0]
	if x > 0x5f and x <= 0x1ff and y > 7 and y <= 0xa7:
		d3 = 2
		d4 = 1
		x = x - 0x80 - (lead.x - view.x) * 16
		y = y - 0x10 - (lead.y - view.y) * 8
		if b & 2:
			auto_walk = 1
	if auto_walk and d3 == 2:
		d3 = 1
	if b & 1:
		if d3 == 2:
			d3 = 1
		if x > 0x1ff and x <= 0x25f and y > 0x87 and y <= 0xb7:
			d3 = 1
			x -= 0x238
			y -= 0xa4
		auto_walk = 0
		auto_bits = 0
	if d3 != 1:
		return bits
	var sx := x
	var q := 0 if y < 0 else 2
	var ay := absi(y)
	var ax := absi(x)
	if x < 0:
		q += 1
	var k := 0
	if ax != 0:
		var r := int((ay * 4) / ax)  # truncation as the original's divs
		k = 2 if r <= 0 else (1 if r == 1 else 0)
	bits |= MOUSE_BITS[q][k]
	if d4 and ax != 0:
		var c := bits & 15
		var left := [1, 0xff, 2, 0xfe]
		var right := [0xff, 1, 0xfe, 2]
		if c == 1:
			_set_slide(right if sx < 0 else left)
		if c == 2:
			_set_slide(left if sx < 0 else right)
	return bits


func _set_slide(order: Array) -> void:
	for i in 4:
		slide[1 + i] = order[i]


# --- followers (f_76772) ---------------------------------------------------------------------------

func _follow(j: int) -> void:
	var r := act[j]
	var lead := act[0]
	if not (r.flags & 0x80):
		return
	var conv := _conveyor(j, 2)
	if conv or not _leader_conveyed:
		if (r.flags & 8) or _dir == NONE or _slide_used == NONE:
			if not (r.step & 1):
				_animate(j)
			return
	_ef38 = r.facing * 2
	if r.flags & 2:
		_sidestep(j)
	else:
		_formation(j)
	r.flags &= ~2
	set_facing(j, _ef38)
	r.facing = lead.facing
	_sync_sprite(j)
	_animate(j)


func _sidestep(j: int) -> void:  # f_77028
	var r := act[j]
	if r.facing != act[0].facing:
		return
	var d := (((r.facing - 1) if j == 1 else (r.facing + 1)) & 3) * 2
	if _try_move_keep(j, d, 2) == 0:
		_ef38 = d


func _formation(j: int) -> void:  # f_768b0
	var table := _two if n == 2 else (_three1 if j == 1 else _three2)
	var lead := act[0]
	var fol := act[j]
	var blk := 1 + lead.facing * table[0]
	_ptr = blk
	var r := _try_entries(j, table)
	if r == 1:
		_step_toward(j, table)
	elif r == 9:
		_ptr = 1
		for k in 4:
			if _try_entries(j, table) != 9:
				break
			_ptr += 1
	_ptr = blk
	if absi(lead.x - fol.x) + absi(lead.y - fol.y) > 11:
		_teleport(j, table)


func _try_entries(j: int, table: PackedByteArray) -> int:  # f_770d4
	while true:
		var r := _step_toward(j, table)
		if r != 9:
			return r
		_ptr += 1
		if table[_ptr] == NONE:
			return 9
	return 9


func _step_toward(j: int, table: PackedByteArray) -> int:  # f_77110 + f_774b0 + f_77578
	var lead := act[0]
	var fol := act[j]
	var o := _slots[table[_ptr] & 0x3f]
	var dx := lead.x + o.x - fol.x
	var dy := lead.y + o.y - fol.y
	if dx == 0 and dy == 0:
		return 0
	var d := dir_toward(dx, dy)
	var r := _try_move_keep(j, d, 2)
	if r == 0:
		_ef38 = d
		return 1
	if r == 2 and act[_hit].type == 4:
		events.append({"kind": "actor", "actor": _hit, "state": 3})
	return 9


func _teleport(j: int, table: PackedByteArray) -> int:  # f_771ec + f_77324 + f_77384
	var fol := act[j]
	var lead := act[0]
	var saved := fol.layer
	fol.layer = lead.layer
	while true:
		var p := _save(j)
		var o := _slots[table[_ptr] & 0x3f]
		fol.x = lead.x + o.x
		fol.y = lead.y + o.y
		if not tile_blocked(j) and overlap(j) < 0:
			fol.flags = fol.flags | 1 if fol.layer else fol.flags & ~1
			_ef38 = lead.facing * 2
			return 0
		_restore(j, p)
		_ptr += 1
		while table[_ptr] & 0x40:
			_ptr += 1
		if table[_ptr] == NONE:
			fol.layer = saved
			return 9
	return 9


## f_75a78 / f_76ca0: actor i within (rx, ry) tiles of the leader (0 = 255).
func near(i: int, rx: int, ry: int) -> bool:
	if rx == 0:
		rx = 255
	if ry == 0:
		ry = 255
	return absi(act[i].x - act[0].x) <= rx and absi(act[i].y - act[0].y) <= ry


static func dir_toward(dx: int, dy: int) -> int:  # f_77578
	var a := absi(dx)
	var b := absi(dy)
	var d := 3
	if b <= 1:
		d = 2
	if a <= 1:
		d = 2 if d == 2 and b <= a else 4
	if dx < 0:
		d = (8 - d) & 7
	if dy < 0:
		d = (12 - d) & 7
	return d


# --- one pass of the field loop (f_663ca from $665A0) -------------------------------------------

func tick(input_bits: int, mouse: Variant = null) -> Array:
	events = []
	var bits := _mouse_bits(input_bits, mouse)
	input_after_mouse = bits
	_dir = DIR_OF_BITS[bits & 15]
	_leader_conveyed = _conveyor(0, 1)
	if auto_walk:
		if bits & 15:
			auto_bits = bits & 15
		else:
			bits = (bits & 0xfff0) + auto_bits
		_dir = DIR_OF_BITS[bits & 15]
	if bits & 0x8120:
		auto_walk = 1
	if auto_walk and (bits & 0xd0):
		bits &= 0xff2f
		auto_walk = 0
		auto_bits = 0
	_slide_used = _dir
	var lead := act[0]
	if _dir == NONE:
		if not (lead.step & 1):
			_animate(0)
	else:
		var i := 0
		while slide[i] != NONE:
			_ef38 = (slide[i] + _dir) & 7
			if _try_leader(_ef38) == 0:
				break
			if pending != -1:
				break
			i += 1
		_slide_used = slide[i]
		if i == 4:
			var t: int = slide[3]
			slide[3] = slide[4]
			slide[4] = t
		set_facing(0, _ef38)
		_sync_sprite(0)
		_animate(0)
	check_triggers(1)
	_follow(1)
	_follow(2)
	act[1].layer = lead.layer
	act[2].layer = lead.layer
	# f_75a9e: clamp to the map (party slots 0..n-2 and all others, as the original does)
	for i in 32:
		if i <= 2 and i + 1 >= n:
			continue
		var r := act[i]
		r.x = maxi(r.x, 0)
		r.y = maxi(r.y, 0)
		if r.x > w2 - r.w:
			r.x = w2 - r.w
		if r.y > h2:
			r.y = h2
		r.flags = (r.flags & ~1) | (r.layer & 1)
	if bits & 0xd0:
		events.append({"kind": "button", "bits": bits & 0xd0})
	_fire_trigger()
	camera(0)
	return events


func camera(mode: int) -> void:  # f_73a34(mode, leader x, leader y)
	var m := [13, 10, 12, 8]
	if mode == 1:
		m = [11, 11, 10, 10]
	elif mode == 2:
		m = [0, 0, 0, 0]
	var lead := act[0]
	var rx := lead.x - view.x
	if rx > m[0]:
		view.x += rx - m[0]
	if rx < m[1]:
		view.x -= m[1] - rx
	var ry := lead.y - view.y
	if ry > m[2]:
		view.y += ry - m[2]
	if ry < m[3]:
		view.y -= m[3] - ry
	view.y = maxi(view.y, min_view.y)
	if view.y + WINDOW.y > h2:
		view.y = h2 - WINDOW.y
	view.x = maxi(view.x, min_view.x)
	if view.x + WINDOW.x > w2:
		view.x = w2 - WINDOW.x
