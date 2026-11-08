extends RefCounted
## Development: follow a story route unattended (-- --story-route=<steps> or -- --story-route=@<file>,
## several files as @<file>+@<file>; with -- --new-game the route also answers the intro).
## Steps are separated by commas or new lines; '#' starts a comment. Clicks are answered, VM menus
## take the queued answers (else the first item), interface menus are cancelled, battles attack.
##
##   t<n>          fire trigger n of the current map (a plain door warps to its destination)
##   a<n>          talk to actor n (its talk entry)
##   W<n>          walk the leader into actor n (BFS over both layers and the map's internal doors on
##                 the live collision map, then the field runs with that input) and so talk to it
##   o<n>          open chest actor n
##   c<n>          field command n (0 MAGIC ... 3 TALK ...)
##   w<n>          wait n frames with the field running
##   m<a>.<b>...   queue answers (0-based items) for the next VM menus / yes-no prompts
##   map=<ID>      expect the current map (stops the route with ROUTE FAIL otherwise)
##   var<i>=<v>    expect story word variable i (var4 = progress)
##   dump=<file>   write the state block (relative paths go to -- --route-out=<dir>, default user://route)
##   heal          full heal (rest)
##   --- development shortcuts (reported as ROUTE CHEAT) ---
##   lv<n>         raise every character to at least level n
##   setw<i>=<v>   set word variable i;  setb<i>=<v>  set byte variable i
##   give<code>=<n>  give item code (decimal or 0x..) n times
##   gear[<price>] equip every member with the strongest weapon / body armour costing at most
##                 <price> (shop price), 500 rounds of every ammunition, 20 HP and 20 MP pills
##   go<ID>@<trigger>  warp to a map, placed at a trigger
##
## Prints "ROUTE <step> -> map <id> var4 <n> ..." after every step.

const GameState := preload("res://scripts/events/game_state.gd")
const FieldMap := preload("res://scripts/field/field_map.gd")
const SYSTEMS_MODEL := "res://scripts/systems/systems_model.gd"

var field
var failed := false
var defeats := 0


func _init(f) -> void:
	field = f


static func parse(spec: String) -> PackedStringArray:
	if spec.begins_with("@") and spec.contains("+@"):
		# several route files, one after the other: @a.txt+@b.txt
		var all := PackedStringArray()
		for part in spec.split("+@"):
			all.append_array(parse(part if part.begins_with("@") else "@" + part))
		return all
	var text := spec
	if spec.begins_with("@"):
		# a route file: absolute, or relative to the repository (the folder above godot/)
		var path := spec.substr(1)
		if not path.is_absolute_path():
			path = ProjectSettings.globalize_path("res://").path_join("..").path_join(path).simplify_path()
		if not FileAccess.file_exists(path):
			push_error("story route: no file " + path)
		text = FileAccess.get_file_as_string(path)
	var out := PackedStringArray()
	for line in text.split("\n"):
		var c := line.find("#")
		if c >= 0:
			line = line.substr(0, c)
		for st in line.split(","):
			st = st.strip_edges()
			if st != "":
				out.append(st)
	return out


func run(steps: PackedStringArray) -> void:
	field.auto = true
	var speed := OS.get_environment("ROUTE_SPEED")
	Engine.time_scale = float(speed) if speed != "" else 8.0
	var state: GameState = field.state
	for st in steps:
		await _step(st)
		if int(field.get_meta("defeats", 0)) > defeats:
			defeats = int(field.get_meta("defeats", 0))
			_fail("defeat in a battle at step " + st)
		if failed:
			break
		if field.ended:
			print("ROUTE ending reached at step %s (builtin 5(99): the ending cutscene starts)" % st)
			break
		print("ROUTE %s -> map %s var4 %d party %s lv %s money %d" % [st, field.map.id, state.get_var16(4),
			str(state.party_ids()), str(_levels()), state.money()])
	print("ROUTE end map %s var4 %d defeats %d%s" % [field.map.id, state.get_var16(4), defeats,
		" FAILED" if failed else ""])
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("--route-dump="):
			_dump(arg.trim_prefix("--route-dump="))


func _levels() -> Array:
	var out := []
	for c in field.state.party_ids():
		out.append(field.state.block[GameState.OFF_CHARS + GameState.CHAR_SIZE * c + 3] if c < 8 else -1)
	return out


func _dump(path: String) -> void:
	if not path.is_absolute_path():
		# relative to -- --route-out=<dir> (default user://route)
		var dir := "user://route"
		for arg in OS.get_cmdline_user_args():
			if arg.begins_with("--route-out="):
				dir = arg.trim_prefix("--route-out=")
		DirAccess.make_dir_recursive_absolute(dir)
		path = dir.path_join(path)
	var f := FileAccess.open(path, FileAccess.WRITE)
	if f == null:
		print("ROUTE FAIL cannot write ", path)
		return
	var b: PackedByteArray = field.party_actor_bytes()   # also writes the map id and view
	var block: PackedByteArray = field.state.block.duplicate()
	for k in b.size():
		block[GameState.OFF_PARTY_POS + k] = b[k]
	f.store_buffer(block)
	f.close()


func _fail(msg: String) -> void:
	print("ROUTE FAIL ", msg)
	failed = true


func _num(s: String) -> int:
	return s.hex_to_int() if s.begins_with("0x") else s.to_int()


func _step(st: String) -> void:
	var state: GameState = field.state
	if st.begins_with("map="):
		if field.map.id != st.substr(4):
			_fail("expected map %s, on %s" % [st.substr(4), field.map.id])
		return
	if st.begins_with("var") and st.contains("="):
		var kv := st.substr(3).split("=")
		if state.get_var16(kv[0].to_int()) != kv[1].to_int():
			_fail("expected %s, have %d" % [st, state.get_var16(kv[0].to_int())])
		return
	if st.begins_with("dump="):
		_dump(st.substr(5))
		return
	if st == "heal":
		load(SYSTEMS_MODEL).full_heal(state)
		return
	if st.begins_with("lv"):
		print("ROUTE CHEAT ", st)
		var sys = load(SYSTEMS_MODEL)
		for c in 8:
			if state.block[GameState.OFF_CHARS + GameState.CHAR_SIZE * c + 3] < st.substr(2).to_int():
				sys.set_level(state, c, st.substr(2).to_int(), field.events._rand.fn())
		sys.full_heal(state)
		return
	if st.begins_with("setw") or st.begins_with("setb"):
		print("ROUTE CHEAT ", st)
		var kv := st.substr(4).split("=")
		if st[3] == "w":
			state.set_var16(kv[0].to_int(), _num(kv[1]))
		else:
			state.set_var8(kv[0].to_int(), _num(kv[1]))
		return
	if st.begins_with("gear"):
		print("ROUTE CHEAT ", st)
		_gear(st.substr(4).to_int() if st.length() > 4 else 0x7fffffff)
		return
	if st.begins_with("give"):
		print("ROUTE CHEAT ", st)
		var kv := st.substr(4).split("=")
		state.give_item(_num(kv[0]), kv[1].to_int() if kv.size() > 1 else 1)
		return
	if st.begins_with("go"):
		print("ROUTE CHEAT ", st)
		var kv := st.substr(2).split("@")
		field._busy = true
		await field.warp_to(kv[0], kv[1].to_int() if kv.size() > 1 else 0, 2)
		await field._after_script()
		field._busy = false
		return
	var n := st.substr(1).to_int()
	field._busy = true
	match st[0]:
		"t":
			await _trigger(n)
		"c":
			if field.commands != null:
				await field.commands.run(n)
				await field._after_script()
		"W":
			await _walk_to_actor(n)
		"a":
			# walking up to the actor leaves any trigger: "last fired" is cleared (f_79b3a)
			field.field.last_trigger = -1
			state.rt["last_trigger"] = -1
			await field.events.on_talk(n)
			await field._after_script()
		"o":
			await field.events.chest(n)
		"m":
			for a in st.substr(1).split("."):
				field.route_answers.append(a.to_int())
		"w":
			field._busy = false
			for i in n:
				await field.get_tree().process_frame
		_:
			_fail("unknown step " + st)
	field._busy = false


func _trigger(n: int) -> void:
	var map = field.map
	if n >= map.triggers.size():
		_fail("map %s has no trigger %d" % [map.id, n])
		return
	# a door places the party beside the destination by the leader's facing (f_7a100): face the
	# trigger, as a player walking into it would
	var tr0: Dictionary = map.triggers[n]
	var lead = field.field.act[0]
	var d := Vector2(int(tr0["x"]) + int(tr0["w"]) / 2.0 - (lead.x + 1), int(tr0["y"]) + int(tr0["h"]) / 2.0 - lead.y)
	lead.facing = (2 if d.y > 0 else 0) if absf(d.y) >= absf(d.x) else (1 if d.x > 0 else 3)
	await field.events.on_trigger(n)
	if await field._after_script():
		return
	# no script warp: a direct door (flags bit 7 clear) leads to the trigger's map, at trigger flags - 1
	var tr: Dictionary = map.triggers[n]
	var dest := str(tr.get("dest", ""))
	if dest != "" and not (int(tr["flags"]) & 0x80) and FieldMap.map_ids().find(dest) >= 0:
		await field.warp_to(dest, (int(tr["flags"]) & 0xff) - 1, field.field.act[0].facing)


## Development: the strongest weapon (table-1 attack) and body armour (defence) priced at most
## max_price for every party member who can equip them (systems_model.equip_candidates' rules),
## plus 500 rounds of each ammunition item ($11 + type, f_7111c) and 20 HP / MP pills (items 3, 6).
func _gear(max_price: int) -> void:
	var sys = load(SYSTEMS_MODEL)
	var state: GameState = field.state
	var tb: Dictionary = sys.tables()
	for c: int in state.party_ids():
		if c == 4 or c == 6 or c > 7:
			continue
		var o: int = sys.char_off(c)
		var best := [0, -1]
		for i in range(1, tb["weapons"].size()):
			var w: Dictionary = tb["weapons"][i]
			var d: int = w["data_offset"]
			if int(w["price"]) > max_price or not d:
				continue
			var t: int = sys._raw(d + 4)
			var atk: int = sys._raw(d + 2) | (sys._raw(d + 3) << 8)
			if state.block[o + sys.C_MASK] & (1 << (t & 31)) and atk > best[1]:
				best = [i, atk]
		if best[0]:
			state.block[o + sys.C_WEAPON] = best[0]
		if c != 5:
			var arm := [0, -1]
			for i in range(1, tb["armour"].size()):
				var r: Vector3i = sys._armour_raw(i)
				var ok: bool = r.z == 0 or (r.z == 5 and c == 3)
				if ok and int(tb["armour"][i]["price"]) <= max_price and r.x > arm[1]:
					arm = [i, r.x]
			if arm[0]:
				state.block[o + sys.C_ARMOUR] = arm[0]
		sys.recompute_char(state, c)
		print("ROUTE gear char %d weapon %d (atk %d) armour %d" % [c, best[0], best[1], state.block[o + sys.C_ARMOUR]])
	for code in range(0x12, 0x1a):   # ammunition: item $11 + type (types 1-8)
		if state.item_count(code) < 500:
			state.give_item(code, 500 - state.item_count(code))
	for code in [3, 6]:   # 金丹 (HP +300) and 仙気丸 (MP +200), 20 each
		if state.item_count(code) < 20:
			state.give_item(code, 20 - state.item_count(code))


## Development: walk the leader into actor n with the field running (input word from a BFS re-planned
## every tick): over (x, y, layer) with the leader's footprint (f_775e0: attr & (4 << 8 * layer)
## blocks), the layer tiles (f_76440), the map's internal doors (out beside the destination trigger,
## f_7a100) and the actors' overlap rule (same layer, f_7763a). Ends when a talk entry has run.
func _walk_to_actor(n: int) -> void:
	var ev = field.events
	var talks0: int = ev.talks
	field._busy = false
	var frames := 0
	while ev.talks == talks0 and frames < 6000:
		if not field._busy:
			var d: int = _plan(n)
			if d < 0:
				_fail("no path to actor %d at %s from %s" % [n, str(Vector2i(field.field.act[n].x, field.field.act[n].y)),
					str(Vector2i(field.field.act[0].x, field.field.act[0].y))])
				break
			field.route_input = [1, 8, 2, 4][d]
		await field.get_tree().process_frame
		frames += 1
	field.route_input = -1
	while field._busy:
		await field.get_tree().process_frame
	if ev.talks == talks0 and not failed:
		_fail("actor %d not reached" % n)


func _plan(n: int) -> int:
	var f = field.field
	var map = field.map
	var lead = f.act[0]
	var target = f.act[n]
	var dirs := [Vector2i(0, -1), Vector2i(1, 0), Vector2i(0, 1), Vector2i(-1, 0)]
	var tw: int = maxi(1, target.w)
	var th: int = maxi(1, target.h)
	var start := Vector3i(lead.x, lead.y, lead.layer & 1)
	var prev := {start: null}
	var q: Array[Vector3i] = [start]
	var head := 0
	while head < q.size():
		var c: Vector3i = q[head]
		head += 1
		for d in 4:
			var nx: int = c.x + dirs[d].x
			var ny: int = c.y + dirs[d].y
			if c.z == (target.layer & 1) and nx + 1 >= target.x and nx <= target.x + tw - 1 \
					and ny >= target.y - th + 1 and ny <= target.y:
				var k: Vector3i = c
				var first := d
				while prev[k] != null:
					first = prev[k][1]
					k = prev[k][0]
				return first
			if nx < 0 or ny < 0 or nx + 1 >= 2 * map.width or ny >= 2 * map.height:
				continue   # off the map (attr_at reads 0 there: the search would never end)
			if f.attr_at(nx, ny) & (4 << (8 * c.z)) or f.attr_at(nx + 1, ny) & (4 << (8 * c.z)):
				continue
			var node := Vector3i(nx, ny, _layer_at(f, nx, ny, c.z))
			var door: Dictionary = _door_at(map, nx, ny)
			if not door.is_empty():
				if str(door.get("dest", "")) != map.id:
					continue
				var dt: Dictionary = map.triggers[(int(door["flags"]) & 0xff) - 1]
				var p: Vector2i = [Vector2i(dt["x"], int(dt["y"]) - 1), Vector2i(int(dt["x"]) + int(dt["w"]) + 1, dt["y"]),
					Vector2i(dt["x"], int(dt["y"]) + int(dt["h"]) + 1), Vector2i(int(dt["x"]) - 2, dt["y"])][d]
				node = Vector3i(p.x, p.y, 0)
			if prev.has(node):
				continue
			prev[node] = [c, d]
			q.append(node)
	return -1


static func _layer_at(f, x: int, y: int, l: int) -> int:
	var a := 0
	for i in 2:
		a = f.attr_at(x + i, y)
		if a & 0xf800:
			break
	return (a & 0x1800) >> 12 if not (a & 0xc000) and (a & 0x3800) else l


## A direct door (a trigger with a destination, flags bit 7 clear) under the footprint at (x, y).
static func _door_at(map, x: int, y: int) -> Dictionary:
	for t: Dictionary in map.triggers:
		if str(t.get("dest", "")) == "" or int(t["flags"]) & 0x80:
			continue
		var tx: int = t["x"]
		var ty: int = t["y"]
		if not (tx >= x + 2 or tx + int(t["w"]) < x) and not (ty > y or ty + int(t["h"]) <= y - 1):
			return t
	return {}
