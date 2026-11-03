extends Node
## Development: replays the golden logs of the reference VM (tools/events/vm/golden.mjs: random
## programs and real scripts, stub host) through the GDScript VM and compares every instruction,
## builtin call and return, the final status and the final state block.
## Run: godot --headless --path godot -- --vm-test=<golden.json>

signal finished(next: String, args: Dictionary)

const VM := preload("res://scripts/events/vm.gd")
const GameState := preload("res://scripts/events/game_state.gd")
const Programs := preload("res://scripts/events/programs.gd")


class StubHost:
	var log := PackedStringArray()

	func builtin(n: int, args: Array[int], _vm) -> int:
		return (args[0] + n) & 0xffff

	func message(_offset: int, _vm) -> void:
		pass

	func warp(_info: Dictionary, _vm) -> void:
		pass

	func trace(e: Dictionary) -> void:
		match e["e"]:
			"i":
				log.append("%d,%d,%d,%d,%d,%d,%d" % [e["pc"], e["op"], e["depth"], e["t"], e["v"], e["r0"], e["nest"]])
			"s":
				log.append("s%d:%s" % [e["n"], ",".join(e["args"].map(func(x: int) -> String: return str(x)))])
			"r":
				log.append("r%d:%d" % [e["n"], e["value"]])


func _ready() -> void:
	var file := ""
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("--vm-test="):
			file = arg.trim_prefix("--vm-test=")
	var golden: Dictionary = JSON.parse_string(FileAccess.get_file_as_string(file))
	var main := Programs.load_scn("IC_MAIN.SCN")
	var maps := {}
	var ok := 0
	var instr := 0
	var instr_ok := 0
	var shown := 0
	for c: Dictionary in golden["cases"]:
		var pname: String = c["prog"]
		var prog: Dictionary = main if pname == "IC_MAIN.SCN" else maps.get(pname, {})
		if prog.is_empty():
			prog = Programs.load_map(pname)
			maps[pname] = prog
		if c["patch"] != null:
			prog = prog.duplicate()
			var code: PackedByteArray = prog["code"].duplicate()
			var patch := Marshalls.base64_to_raw(c["patch"]["b64"])
			for i in patch.size():
				code[int(c["patch"]["at"]) + i] = patch[i]
			prog["code"] = code
		var map_prog: Dictionary = prog if prog["kind"] == "map" else maps.get("A00", Programs.load_map("A00"))
		var host := StubHost.new()
		var state := GameState.new()
		var vm := VM.new(prog, state, host, {"main": main, "map": map_prog})
		var status: String = await vm.run(int(c["entry"]), -1, 20000)
		var want: Array = c["log"]
		var same: bool = host.log.size() == want.size() and status == c["status"] \
			and Marshalls.raw_to_base64(state.block) == c["block"]
		var first := -1
		for i in mini(host.log.size(), want.size()):
			if host.log[i] == want[i]:
				instr_ok += 1
			elif first < 0:
				first = i
		instr += want.size()
		if same and first < 0:
			ok += 1
		elif shown < 8:
			shown += 1
			var at := first if first >= 0 else mini(host.log.size(), want.size())
			var mine := host.log[at] if at < host.log.size() else "-"
			var theirs: String = want[at] if at < want.size() else "-"
			print("%s: status %s/%s, log %d/%d, first difference at %d: godot %s reference %s" % [
				c["name"], status, c["status"], host.log.size(), want.size(), at, mine, theirs])
	print("vm cases %d/%d, log lines %d/%d" % [ok, golden["cases"].size(), instr_ok, instr])
	get_tree().quit()
