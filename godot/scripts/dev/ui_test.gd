extends Node
## Development: checks the systems-UI screen builders (scripts/systems/ui_screens.gd) against the
## golden outputs of the reference builders (tools/systems-ui/golden.mjs: tools/systems-ui/
## screens.mjs, verified against the original, on the states of the systems-UI traces and random
## variations of them): every line byte for byte.
## Run: godot --headless --path godot -- --ui-test=<golden.json>

signal finished(next: String, args: Dictionary)

const SYS := preload("res://scripts/systems/systems_model.gd")
const UiScreens := preload("res://scripts/systems/ui_screens.gd")
const GameState := preload("res://scripts/events/game_state.gd")


func _ready() -> void:
	var file := ""
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("--ui-test="):
			file = arg.trim_prefix("--ui-test=")
	var golden: Dictionary = JSON.parse_string(FileAccess.get_file_as_string(file))
	var total := 0
	var ok := 0
	var shown := 0
	var per := {}
	for c: Dictionary in golden["cases"]:
		var out: Dictionary = c["out"]
		for name: String in out:
			var got: Variant = _build(Marshalls.base64_to_raw(c["block"]), name)
			var want: Variant = out[name]
			var same := _same(got, want)
			total += 1
			var key := name.rstrip("0123456789_")
			var p: Vector2i = per.get(key, Vector2i.ZERO)
			per[key] = p + Vector2i(1 if same else 0, 1)
			if same:
				ok += 1
			elif shown < 8:
				shown += 1
				print("%s: %s" % [name, _diff(got, want)])
	var parts := PackedStringArray()
	for k: String in per:
		var p: Vector2i = per[k]
		parts.append("%s %d/%d" % [k, p.x, p.y])
	print("ui builders %d/%d (%s)" % [ok, total, ", ".join(parts)])
	get_tree().quit(0 if ok == total else 1)


func _build(block: PackedByteArray, name: String) -> Variant:
	var st := GameState.new(block)
	st.block = block.duplicate()
	var s := UiScreens.new(st, SYS)
	var n := name.lstrip("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ").to_int()
	var out: Variant = null
	if name == "money":
		out = s.money_line()
	elif name == "charsel":
		out = s.charsel_items([0x80, 0x80, 0x80])
	elif name.begins_with("item"):
		out = s.item_entries(n)[0]
	elif name.begins_with("magicHead"):
		out = s.magic_header(n)
		out = null if (out as Array).is_empty() else out
	elif name.begins_with("spells"):
		out = s.spell_entries(n)[0]
		out = null if (out as Array).is_empty() else out
	elif name.begins_with("equipItems"):
		out = s.equip_header(n)["items"]
	elif name.begins_with("equipBonus"):
		out = s.equip_header(n)["bonus"]
	elif name.begins_with("equip"):
		var cr := name.trim_prefix("equip").split("_")
		out = s.equip_entries(cr[0].to_int(), cr[1].to_int())[0]
	elif name.begins_with("personal"):
		out = s.personal_lines(n)
	elif name == "skills":
		out = s.skill_lines()
	elif name == "strength":
		out = s.strength_lines()
	return out


static func _same(got: Variant, want: Variant) -> bool:
	if want == null or got == null:
		return want == null and got == null
	if want is String:
		return got is PackedByteArray and _b64(got) == want
	if not (got is Array) or (got as Array).size() != (want as Array).size():
		return false
	for k in (want as Array).size():
		if _b64(got[k]) != want[k]:
			return false
	return true


## Marshalls.raw_to_base64 reports an error for an empty array (Godot 4.7) although it returns "".
static func _b64(bytes: PackedByteArray) -> String:
	return "" if bytes.is_empty() else Marshalls.raw_to_base64(bytes)


static func _diff(got: Variant, want: Variant) -> String:
	if got is Array and want is Array:
		for k in mini((got as Array).size(), (want as Array).size()):
			if _b64(got[k]) != want[k]:
				return "line %d: got %s want %s" % [k, (got[k] as PackedByteArray).hex_encode(),
					Marshalls.base64_to_raw(want[k]).hex_encode()]
		return "sizes %d / %d" % [(got as Array).size(), (want as Array).size()]
	return "got %s want %s" % [str(_dec(got)).left(200), str(_dec(want)).left(200)]


static func _dec(v: Variant) -> Variant:
	if v is String:
		return Marshalls.base64_to_raw(v).hex_encode()
	if v is PackedByteArray:
		return (v as PackedByteArray).hex_encode()
	if v is Array:
		return (v as Array).map(func(x: Variant) -> Variant: return _dec(x))
	return v
