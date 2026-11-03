extends Node
## Development: replays the reference traces of tools/field/trace.mjs through FieldLogic and
## reports how many ticks match the original exactly (same comparison as tools/field/model.mjs).
## Run: godot --headless --path godot -- --field-test=<folder with the trace .json files>

signal finished(next: String, args: Dictionary)

const FieldMap := preload("res://scripts/field/field_map.gd")
const FieldLogic := preload("res://scripts/field/field_logic.gd")


func _ready() -> void:
	var dir := ""
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("--field-test="):
			dir = arg.trim_prefix("--field-test=")
	var names := Array(DirAccess.get_files_at(dir)).filter(func(f: String) -> bool: return f.ends_with(".json"))
	names.sort()
	var total := 0
	var exact := 0
	for name: String in names:
		var r := _replay(JSON.parse_string(FileAccess.get_file_as_string(dir.path_join(name))))
		total += r[1]
		exact += r[0]
		print("%-12s %d/%d ticks exact%s" % [name.get_basename(), r[0], r[1], r[2]])
	print("total %d/%d" % [exact, total])
	get_tree().quit(0 if exact == total else 1)


func _replay(t: Dictionary) -> Array:
	var f0: Dictionary = t["frames"][0]
	var map = FieldMap.load_map(f0["map"])
	if f0.has("cellsB64"):
		map.vr_cells = Marshalls.base64_to_raw(f0["cellsB64"])
	var party: Array = f0["party"]
	var n := party.size()
	var field = FieldLogic.new(map, party, Vector2i(f0["view"][0], f0["view"][1]))
	field.slide = f0["slideTable"].map(func(v: float) -> int: return int(v))
	field.last_trigger = f0["lastTrigger"]
	field.pending = f0["pendingTrigger"]
	field.auto_walk = f0["autoWalk"]
	field.mouse_mode = f0["mouseMode"]
	_set_npcs(field, f0.get("npcs", []))
	var ok := 0
	var count := 0
	var first := ""
	var first_warp := INF
	for w in t["warps"]:
		first_warp = minf(first_warp, w["frame"])
	for k: Dictionary in t["ticks"]:
		if k["frame"] >= first_warp:
			break
		for i in range(3, 32):
			field.act[i].flags = 0
		_set_npcs(field, k.get("npcs", []))
		field.tick(int(k["input"]), k.get("mouse"))
		var got := []
		var want := []
		for i in n:
			var a = field.act[i]
			var p: Dictionary = k["party"][i]
			got.append([a.x, a.y, a.facing, a.step, a.layer])
			want.append([int(p["x"]), int(p["y"]), int(p["facing"]), int(p["step"]), int(p["layer"])])
		got.append([field.view.x, field.view.y, field.input_after_mouse])
		want.append([int(k["view"][0]), int(k["view"][1]), int(k["inputAfterMouse"])])
		count += 1
		if str(got) == str(want):
			ok += 1
		elif first == "":
			first = "  first miss f%d: godot %s game %s" % [k["frame"], str(got), str(want)]
		if str(got.slice(0, n)) != str(want.slice(0, n)):
			for i in n:
				var p: Dictionary = k["party"][i]
				var a = field.act[i]
				a.x = p["x"]
				a.y = p["y"]
				a.facing = p["facing"]
				a.step = p["step"]
				a.layer = p["layer"]
		field.view = Vector2i(k["view"][0], k["view"][1])
		for c in k.get("cellChanges", []):
			map.vr_cells[int(c[1]) * map.width + int(c[0])] = int(c[2])
	return [ok, count, first]


func _set_npcs(field, npcs: Array) -> void:
	for p: Dictionary in npcs:
		var a = field.act[int(p["i"])]
		for key in p:
			if key != "i":
				a.set(key, int(p[key]))
