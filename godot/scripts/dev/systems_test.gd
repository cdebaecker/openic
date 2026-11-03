extends Node
## Development: replays the golden logs of the reference systems model (tools/systems/golden.mjs:
## the recorded calls of the emulator traces plus randomized cases of every function) through
## scripts/systems/systems_model.gd and compares the return value, the state block, the run-time
## values, the checkpoint copy and the rng state after every call.
## Run: godot --headless --path godot -- --systems-test=<golden.json>

signal finished(next: String, args: Dictionary)

const SYS := preload("res://scripts/systems/systems_model.gd")
const CRand := preload("res://scripts/systems/c_rand.gd")
const GameState := preload("res://scripts/events/game_state.gd")
const RT_KEYS := ["targets", "next_map", "pending_trigger", "last_trigger", "facing", "warp_longjmp",
	"checkpoint", "load_mode", "hdd", "drives", "disk_word"]


func _ready() -> void:
	var file := ""
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("--systems-test="):
			file = arg.trim_prefix("--systems-test=")
	var golden: Dictionary = JSON.parse_string(FileAccess.get_file_as_string(file))
	var model := SYS.new()
	var ok := 0
	var shown := 0
	var per_fn := {}
	for c: Dictionary in golden["cases"]:
		var why := _run_case(model, c)
		var fn: String = c["fn"]
		var p: Vector2i = per_fn.get(fn, Vector2i.ZERO)
		per_fn[fn] = p + Vector2i(1 if why == "" else 0, 1)
		if why == "":
			ok += 1
		elif shown < 10:
			shown += 1
			print("%s (%s %s): %s" % [c["name"], fn, JSON.stringify(c["args"]).left(160), why])
	var parts := PackedStringArray()
	for fn: String in per_fn:
		var p: Vector2i = per_fn[fn]
		if p.x != p.y:
			parts.append("%s %d/%d" % [fn, p.x, p.y])
	if parts.size():
		print("functions with differences: ", ", ".join(parts))
	print("systems cases %d/%d (%d functions)" % [ok, golden["cases"].size(), per_fn.size()])
	get_tree().quit()


## "" = identical, else the first difference
func _run_case(model: Object, c: Dictionary) -> String:
	if c["fn"] == "crand":
		return _run_crand(c)
	var st := GameState.new(Marshalls.base64_to_raw(c["block"]))
	for k: String in RT_KEYS:
		if c["rt"].has(k):
			st.rt[k] = _dec(c["rt"][k])
		else:
			st.rt.erase(k)
	if c["backup"] != null:
		st.rt["backup"] = Marshalls.base64_to_raw(c["backup"])
	var g: CRand = null
	if c["rand"] != null:
		g = CRand.new(c["rand"]["t"], int(c["rand"]["i"]))
	var args := []
	if not c["stateless"]:
		args.append(st)
	for a: Variant in c["args"]:
		if a is Dictionary and a.has("$rng"):
			args.append(g.fn())
		elif a is Dictionary and a.has("$draws"):
			var q: Array = a["$draws"].duplicate()
			args.append(func(_n: int) -> int: return int(q.pop_front()))
		else:
			args.append(_dec(a))
	var ret: Variant = model.callv(c["fn"], args)
	var d := _diff(_enc(ret), c["ret"], "return")
	if d != "":
		return d
	if Marshalls.raw_to_base64(st.block) != c["blockAfter"]:
		var want := Marshalls.base64_to_raw(c["blockAfter"])
		for i in want.size():
			if want[i] != st.block[i]:
				return "block +$%x: godot %d reference %d" % [i, st.block[i], want[i]]
	for k: String in RT_KEYS:
		var have: bool = st.rt.has(k)
		if have != c["rtAfter"].has(k):
			return "rt.%s present: godot %s reference %s" % [k, have, not have]
		if have:
			d = _diff(_enc(st.rt[k]), c["rtAfter"][k], "rt." + k)
			if d != "":
				return d
	var bk: Variant = Marshalls.raw_to_base64(st.rt["backup"]) if st.rt.get("backup") != null else null
	if bk != c["backupAfter"]:
		return "checkpoint copy differs"
	if g != null:
		d = _diff(_enc({"t": Array(g.t), "i": g.i}), c["randAfter"], "rand")
	return d


func _run_crand(c: Dictionary) -> String:
	var args: Array = c["args"]
	var g := CRand.new(args[0] if args[0] != null else [], int(args[1]))
	var out := []
	for op: Array in args[2]:
		match op[0]:
			"srand":
				g.srand(int(op[1]))
				out.append(null)
			"rand":
				out.append(g.rand())
			_:
				out.append(g.mod(int(op[1])))
	var d := _diff(out, c["ret"], "results")
	if d == "":
		d = _diff({"t": Array(g.t), "i": g.i}, c["randAfter"], "rand")
	return d


## golden JSON -> GDScript argument (numbers become ints, {"$b64"} byte arrays)
func _dec(v: Variant) -> Variant:
	if v is float:
		return int(v)
	if v is Array:
		return v.map(_dec)
	if v is Dictionary:
		if v.has("$b64"):
			return Marshalls.base64_to_raw(v["$b64"])
		var o := {}
		for k: String in v:
			o[k] = _dec(v[k])
		return o
	return v


## GDScript result -> comparable value
func _enc(v: Variant) -> Variant:
	if v is PackedByteArray:
		return {"$b64": Marshalls.raw_to_base64(v)}
	if v is PackedInt32Array or v is Array:
		return Array(v).map(_enc)
	if v is Dictionary:
		var o := {}
		for k: String in v:
			o[k] = _enc(v[k])
		return o
	return v


func _diff(a: Variant, b: Variant, path: String) -> String:
	var num_a := a is int or a is float
	var num_b := b is int or b is float
	if num_a and num_b:
		return "" if float(a) == float(b) else "%s: godot %s reference %s" % [path, a, b]
	if a is Array and b is Array:
		if a.size() != b.size():
			return "%s: length godot %d reference %d" % [path, a.size(), b.size()]
		for i in a.size():
			var d := _diff(a[i], b[i], "%s[%d]" % [path, i])
			if d != "":
				return d
		return ""
	if a is Dictionary and b is Dictionary:
		if a.size() != b.size() or not a.has_all(b.keys()):
			return "%s: keys godot %s reference %s" % [path, a.keys(), b.keys()]
		for k: String in b:
			var d := _diff(a[k], b[k], "%s.%s" % [path, k])
			if d != "":
				return d
		return ""
	if typeof(a) == typeof(b) and a == b:
		return ""
	return "%s: godot %s reference %s" % [path, JSON.stringify(a), JSON.stringify(b)]
