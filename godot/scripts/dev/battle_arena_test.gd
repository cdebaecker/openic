extends Node
## Development: renders the battle arena of every recorded battle snapshot (tools/battle-ui/
## golden.mjs: the sprites of the displayed redraw and the marker tiles) with scripts/battle/
## battle_view.gd and compares it with the original's text VRAM, pixel by pixel.
## Run: godot --headless --path godot -- --battle-arena-test=<golden.json> [--diff-dir=<folder>]
## --diff-dir saves <trace>_<snap>_got.png / _want.png (palette index x 16) for failing snapshots.

signal finished(next: String, args: Dictionary)

const BattleView := preload("res://scripts/battle/battle_view.gd")
const SpriteSet := preload("res://scripts/battle/battle_sprite_set.gd")
const BattleAnim := preload("res://scripts/battle/battle_anim.gd")
const SYS := preload("res://scripts/systems/systems_model.gd")


func _ready() -> void:
	var file := ""
	var diff_dir := ""
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("--battle-arena-test="):
			file = arg.trim_prefix("--battle-arena-test=")
		elif arg.begins_with("--diff-dir="):
			diff_dir = arg.trim_prefix("--diff-dir=")
			DirAccess.make_dir_recursive_absolute(diff_dir)
	var golden: Dictionary = JSON.parse_string(FileAccess.get_file_as_string(file))
	var view := BattleView.new()
	var map := ""
	var ok := 0
	var px_ok := 0
	var px_all := 0
	var shown := 0
	var steps := 0
	for c: Dictionary in golden["cases"]:
		if c["map"] + str(c["trace"]) != map:
			map = c["map"] + str(c["trace"])
			view.load_background(str(c["map"]))
			steps = 0
		var o: Array = c.get("org", [0, 0, 0, 0])
		view.origin0 = Vector2i(int(o[0]), int(o[1]))
		view.origin1 = Vector2i(int(o[2]), int(o[3]))
		while steps < int(c.get("tileAnim", 0)):   # f_749aa(2) once per battle redraw
			view.tile_anim_step()
			steps += 1
		var sprites: Array = []
		for s: Dictionary in c["sprites"]:
			var e := s.duplicate()
			e["set"] = SpriteSet.load_set(str(s["set"]))
			sprites.append(e)
		view.draw_arena(sprites)
		for m: Dictionary in c["marker"]:
			view.draw_marker_tile(int(m["tile"]), Vector2i(int(m["x"]), int(m["y"])))
		var want := Marshalls.base64_to_raw(c["arena"])
		var got := view.image.get_region(BattleView.ARENA).get_data()
		var same := 0
		for k in want.size():
			if got[k] == want[k]:
				same += 1
		px_ok += same
		px_all += want.size()
		if same == want.size():
			ok += 1
		elif shown < 5:
			shown += 1
			var first := -1
			for k in want.size():
				if got[k] != want[k]:
					first = k
					break
			print("%s snap %d: %d px differ, first at (%d, %d): got %d want %d" % [c["trace"], c["snap"],
				want.size() - same, first % 352, first / 352, got[first], want[first]])
			if diff_dir != "":
				var stem := "%s/%s_%d" % [diff_dir, c["trace"], c["snap"]]
				_save_indices(got, stem + "_got.png")
				_save_indices(want, stem + "_want.png")
	print("battle arena %d/%d snapshots, %d/%d px" % [ok, golden["cases"].size(), px_ok, px_all])
	var anim_ok := _test_anim(golden.get("anim", []))
	get_tree().quit(0 if ok == golden["cases"].size() and anim_ok else 1)


## A 352x224 arena of palette indices as a greyscale PNG (index x 16).
static func _save_indices(indices: PackedByteArray, path: String) -> void:
	var grey := PackedByteArray()
	grey.resize(indices.size())
	for k in indices.size():
		grey[k] = mini(indices[k] * 16, 255)
	Image.create_from_data(352, 224, false, Image.FORMAT_L8, grey).save_png(path)


## The presentation of every recorded action (battle_anim.gd) = the reference's calls.
func _test_anim(cases: Array) -> bool:
	var t: Dictionary = SYS.tables()
	var raw: PackedByteArray = t["raw"]
	var off5: int = t["offsets"][5]
	var ok := 0
	for c: Dictionary in cases:
		var trig := {}
		for q: Array in c["trigger"]:
			trig[Vector2i(int(q[0]), int(q[1]))] = bool(q[2])
		var char_of: Array = c["charOf"]
		var attr: Array = c["cgAttr32"]
		var ctx := {"rec": int(c["rec"]), "side": str(c["side"]),
			"char_of": func(r: int) -> int: return int(char_of[r]) if r < 3 else -1,
			"cg_attr32": func(r: int) -> int: return int(attr[r]),
			"trigger": func(r: int, a: int) -> bool: return trig.get(Vector2i(r, a), false),
			"effect_anim": func(id: int) -> int: return raw[off5 + 4 * id + 3] if off5 + 4 * id + 3 < raw.size() else 0}
		var recs: Array = c["recs"]
		var calls := BattleAnim.presentation(BattleAnim.parse_action(Marshalls.base64_to_raw(c["act"])), recs, ctx)
		var keys: Array = calls.map(func(x: Dictionary) -> String: return BattleAnim.call_key(x))
		if keys == c["calls"]:
			ok += 1
		else:
			print("action %s rec %d: got %s want %s" % [c["trace"], c["rec"], str(keys), str(c["calls"])])
	print("battle actions %d/%d" % [ok, cases.size()])
	return ok == cases.size()
