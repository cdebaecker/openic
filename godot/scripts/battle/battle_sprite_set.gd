extends RefCounted
## A battle sprite set (CG9) from the export (battle/sprites/<name>.{json, idx.png}, tools/export/
## battle.mjs): actions -> sequences of (frame, flags) steps, frames -> parts cut from the sheet.
## Sheet rectangles are in screen pixels (lines already doubled); red = colour index, alpha = mask.

static var _cache := {}

var data: Dictionary = {}
var sheet: Image = null        # R8 colour indices
var mask: Image = null         # RGBA, alpha = mask
var name := ""


static func load_set(set_name: String) -> RefCounted:
	if _cache.has(set_name):
		return _cache[set_name]
	var s = load("res://scripts/battle/battle_sprite_set.gd").new()
	s.name = set_name
	var rel := "battle/sprites/%s.json" % set_name
	s.data = GameData.json(rel) if GameData.exists(rel) else {}
	var image_name: String = s.data.get("image", "")
	if s.data.get("sharedSheet") != null:
		image_name = str(s.data["sharedSheet"]).replace("/", "_").replace(".DAT", "") + ".idx.png"
	if image_name != "":
		var img := Image.new()
		if img.load_png_from_buffer(FileAccess.get_file_as_bytes(GameData.path("battle/sprites/" + image_name))) == OK:
			img.convert(Image.FORMAT_RGBA8)
			s.mask = img.duplicate()
			img.convert(Image.FORMAT_R8)
			s.sheet = img
	_cache[set_name] = s
	return s


## Sequence index of (action, dir), or -1.
func sequence_of(action: int, dir := 0) -> int:
	for a: Dictionary in data.get("actions", []):
		if int(a["action"]) == action and int(a["dir"]) == dir:
			return int(a["sequence"])
	return -1


func steps(seq: int) -> Array:
	var seqs: Array = data.get("sequences", [])
	return seqs[seq]["steps"] if seq >= 0 and seq < seqs.size() else []


func sound(seq: int) -> int:
	var seqs: Array = data.get("sequences", [])
	return int(seqs[seq].get("sound", 0)) if seq >= 0 and seq < seqs.size() else 0


func attribute(k: int) -> int:
	var a: Array = data.get("attributes", [])
	return int(a[k]) if k < a.size() else 0
