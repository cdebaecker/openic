extends Node
## Development: replays the golden battles of the reference battle model (tools/battle/golden.mjs:
## every battle of the emulator traces plus randomized battles) through
## scripts/battle/battle_model.gd and compares the log entry by entry, the result, the state
## block, the battle records, the gauges, the rng state, the experience and the money.
## Run: godot --headless --path godot -- --battle-test=<golden.json>
## With BATTLE_TEST_SUSPEND=1 the host waits one frame before every answer (as an interactive
## presentation does), which checks that every host call is awaited along the way.

signal finished(next: String, args: Dictionary)

const BM := preload("res://scripts/battle/battle_model.gd")
const CRand := preload("res://scripts/systems/c_rand.gd")
const GameState := preload("res://scripts/events/game_state.gd")


## answers command / impacts from the case's queues (immediately unless `tree` is set)
class QueueHost:
	var commands: Array = []
	var impacts_q: Array = []
	var ci := 0
	var ii := 0
	var tree: SceneTree = null
	var hooks: Array = []
	var hi := 0
	var st: GameState = null
	var rng: CRand = null

	func command(_bs: Dictionary, _idx: int, _attempt: int) -> Dictionary:
		if tree != null:
			await tree.process_frame
		if ci >= commands.size():
			ci += 1
			# the reference answers {cmd: 0} (refused, asked again): after a divergence that would
			# loop forever, so defend instead once the queue is well past its end
			return {"cmd": 0} if ci < commands.size() + 50 else {"cmd": 2}
		var c: Dictionary = commands[ci]
		ci += 1
		var out := {}
		for k: String in c:
			if c[k] != null:
				out[k] = int(c[k])
		return out

	## event battles (golden "hooks"): the map scripts' effects in call order, replayed as patches
	func hook(bs: Dictionary, _which: String) -> void:
		await _script_effect(bs)

	func enemy_slot(bs: Dictionary, _idx: int) -> int:
		return await _script_effect(bs)

	func _script_effect(bs: Dictionary) -> int:
		if tree != null:
			await tree.process_frame
		if hi >= hooks.size():
			return 0
		var h: Dictionary = hooks[hi]
		hi += 1
		var br: PackedByteArray = bs["br"]
		for p: Array in h["br"]:
			br[int(p[0])] = int(p[1])
		bs["br"] = br
		for p: Array in h["block"]:
			st.block[int(p[0])] = int(p[1])
		for k in int(h["rand"]):
			rng.rand()
		return int(h["slot"])

	func impacts(_bs: Dictionary, _idx: int) -> int:
		if tree != null:
			await tree.process_frame
		var n := 2
		if ii < impacts_q.size():
			n = int(impacts_q[ii])
		ii += 1
		return n


func _ready() -> void:
	var file := ""
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("--battle-test="):
			file = arg.trim_prefix("--battle-test=")
	var golden: Dictionary = JSON.parse_string(FileAccess.get_file_as_string(file))
	var data := BM.load_battle_data()
	var ok := 0
	var shown := 0
	var per_kind := {}
	var entries := 0
	var t0 := Time.get_ticks_msec()
	for c: Dictionary in golden["cases"]:
		var why: String = await _run_case(data, c)
		entries += c["log"].size()
		var kind: String = "%s/%s" % [c["name"].get_slice(":", 0), c["start"]["from"]]
		var p: Vector2i = per_kind.get(kind, Vector2i.ZERO)
		per_kind[kind] = p + Vector2i(1 if why == "" else 0, 1)
		if why == "":
			ok += 1
		elif shown < 10:
			shown += 1
			print("%s: %s" % [c["name"], why])
	for kind: String in per_kind:
		var p: Vector2i = per_kind[kind]
		print("  %s %d/%d" % [kind, p.x, p.y])
	print("battle cases %d/%d (%d log entries, %d ms)" % [ok, golden["cases"].size(), entries,
		Time.get_ticks_msec() - t0])
	get_tree().quit()


## "" = identical, else the first difference
func _run_case(data: Dictionary, c: Dictionary) -> String:
	var st := GameState.new(Marshalls.base64_to_raw(c["block"]))
	var rng := CRand.new(c["rand"]["t"], int(c["rand"]["i"]))
	var host := QueueHost.new()
	host.commands = c["commands"]
	host.impacts_q = c["impacts"]
	host.hooks = c.get("hooks", [])
	host.st = st
	host.rng = rng
	if OS.get_environment("BATTLE_TEST_SUSPEND") == "1":
		host.tree = get_tree()
	var start: Dictionary = c["start"]
	var bs: Dictionary
	if start["from"] == "records":
		bs = BM.new_battle({"br": Marshalls.base64_to_raw(start["br"]), "gauge": start["gauge"],
			"gauge_max": int(start["gaugeMax"]), "n_party": int(start["nParty"]), "order": start["order"],
			"attrs": _attrs(start["attrs"]), "mode": int(start["mode"]), "event": int(start["event"]),
			"scripted": int(start["scripted"]), "group": int(start["group"]),
			"poison_party": int(start["poisonParty"]), "poison_enemy": int(start["poisonEnemy"])})
		var pc: Variant = start.get("partyCount")
		await BM.run_records(st, data, bs, rng, host, int(pc) if pc != null else null)
	else:
		var attrs := _attrs(start["attrs"])
		var dat := {}
		for k: String in start["data"]:
			dat[k.to_int()] = {"off": int(start["data"][k]["off"]),
				"sheet_bytes": PackedByteArray(start["data"][k]["sheet"])}
		var party := []
		for pa: Dictionary in start["partyActors"]:
			party.append({"slot": int(pa["slot"]), "set": int(pa["set"]), "off": int(pa["off"]),
				"sheet_bytes": PackedByteArray(pa["sheet"])})
		var o := {"mode": int(start["mode"]), "actor": int(start["actor"]), "scripted": int(start["scripted"]),
			"actors": Marshalls.base64_to_raw(start["actors"]), "party_actors": party,
			"attr_of": func(i: int) -> Variant: return attrs.get(i),
			"data_of": func(i: int) -> Dictionary: return dat.get(i, {"off": 0, "sheet_bytes": [0, 0, 0, 0]})}
		if start.get("fixes") is Dictionary:
			# the JS keys (camelCase) -> the GDScript fix names
			var fx := {}
			for k: String in start["fixes"]:
				fx[k.to_snake_case()] = bool(start["fixes"][k])
			o["fixes"] = fx
		bs = BM.setup_battle(st, data, o)
		await BM.run_battle(st, data, bs, rng, host)
	return _compare(c, st, bs, rng)


func _compare(c: Dictionary, st: GameState, bs: Dictionary, rng: CRand) -> String:
	var want: Array = c["log"]
	var have: Array = bs["log"]
	for k in mini(want.size(), have.size()):
		var d := _diff(have[k], want[k], "log[%d]" % k)
		if d != "":
			return "%s\n    godot     %s\n    reference %s" % [d, JSON.stringify(have[k]).left(300),
				JSON.stringify(want[k]).left(300)]
	if want.size() != have.size():
		return "log length godot %d reference %d" % [have.size(), want.size()]
	var checks := [
		[bs["over"], c["result"], "result"],
		[bs["exp"], c["exp"], "exp"],
		[bs["money"], c["money"], "money"],
		[bs["gauge"], c["gaugeAfter"], "gauge"],
		[{"t": Array(rng.t), "i": rng.i}, c["randAfter"], "rand"],
	]
	for ch: Array in checks:
		var d := _diff(ch[0], ch[1], ch[2])
		if d != "":
			return d
	var d2 := _bytes(st.block, c["blockAfter"], "block +$%x")
	if d2 == "":
		d2 = _bytes(bs["br"], c["brAfter"], "battle records byte %d")
	return d2


func _bytes(have: PackedByteArray, want_b64: String, what: String) -> String:
	var want := Marshalls.base64_to_raw(want_b64)
	if want.size() != have.size():
		return "%s: size godot %d reference %d" % [what.get_slice(" ", 0), have.size(), want.size()]
	for i in want.size():
		if want[i] != have[i]:
			return (what % i) + ": godot %d reference %d" % [have[i], want[i]]
	return ""


## golden attrs {"record": [32 numbers]} -> {record: PackedByteArray}
func _attrs(a: Dictionary) -> Dictionary:
	var out := {}
	for k: String in a:
		if a[k] != null:
			out[k.to_int()] = PackedByteArray(a[k])
	return out


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
