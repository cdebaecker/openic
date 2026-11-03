extends RefCounted
## A CG9 sprite set (docs/formats/cg9.md) from the export: cg9/<dir>/<name>.json and the index
## sheet <name>.idx.png (red = colour index, alpha = mask, rows doubled).

var data: Dictionary = {}
var sheet: Image = null     # R8 colour indices
var mask: Image = null      # LA8, alpha = drawn pixels
var _action_seq := {}       # (dir << 8) | action -> sequence index


static func load_set(rel: String) -> RefCounted:
	var s = load("res://scripts/field/sprite_set.gd").new()
	return s if s._load(rel) else null


func _load(rel: String) -> bool:
	data = GameData.json("cg9/%s.json" % rel)
	if data == null or not data.has("sheet") or data["sheet"] == null:
		push_error("SpriteSet: no sheet for %s" % rel)
		return false
	var bytes := FileAccess.get_file_as_bytes(GameData.path("cg9/%s.idx.png" % rel))
	var img := Image.new()
	if bytes.is_empty() or img.load_png_from_buffer(bytes) != OK:
		push_error("SpriteSet: no index sheet for %s" % rel)
		return false
	img.convert(Image.FORMAT_RGBA8)
	mask = img.duplicate() as Image
	sheet = img
	sheet.convert(Image.FORMAT_R8)
	for a in data["actions"]:
		_action_seq[int(a["dir"]) << 8 | int(a["action"])] = int(a["sequence"])
	return true


## Sequence of an action and direction (f_75504), or [] when the set has none.
func sequence(action: int, dir: int) -> Array:
	var k := dir << 8 | action
	if not _action_seq.has(k):
		return []
	return data["sequences"][_action_seq[k]]["steps"]


## Frame shown for sequence step `shown` (sprite record +6 minus one, see docs/field.md).
func frame_for(action: int, dir: int, shown: int) -> int:
	var seq := sequence(action, dir)
	if seq.is_empty():
		return -1
	return int(seq[posmod(shown, seq.size())]["frame"])


## Parts of a frame: [{rect: Rect2i in the sheet, offset: Vector2i from the anchor}].
func parts(frame: int) -> Array:
	var out := []
	if frame < 0 or frame >= data["frames"].size():
		return out
	for pi in data["frames"][frame]["parts"]:
		if pi >= data["parts"].size():
			continue
		var p: Dictionary = data["parts"][pi]
		if p.get("skipped", false) or not p.has("sheetRect"):
			continue
		var r: Dictionary = p["sheetRect"]
		out.append({
			"rect": Rect2i(r["x"], r["y"], r["w"], r["h"]),
			"offset": Vector2i(p["offset"]["x"], p["offset"]["y"]),
		})
	return out
