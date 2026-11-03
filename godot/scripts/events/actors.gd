extends RefCounted
## Map actors and sprite animation, transcribed from tools/events/actors.mjs and the animation
## primitives of tools/events/cutscene.mjs (f_75504 set_action, f_755e0 advance), verified against
## the original (docs/cutscenes-field.md, section 2).
##
## Sprite records ($9FBDA + 32*i) are dictionaries:
##   {x, y, action, dir, step, layer, visible, len, sound, seq, frame, flags, set (SpriteSet)}

const SpriteSet := preload("res://scripts/field/sprite_set.gd")

static var _sets := {}
static var _table8 := {}


## Sprite set id (EVT list / party character) -> SpriteSet, through ICITY.FIL table 8.
static func sprite_set(id: int):
	if id == 0xff or id < 0:
		return null
	if _sets.has(id):
		return _sets[id]
	if _table8.is_empty():
		var fil: Dictionary = GameData.json("data/ICITY.FIL.json")
		for t in fil.get("tables", []):
			if int(t["type"]) == 8:
				for e in t["entries"]:
					_table8[int(e["index"])] = str(e["file"])
	var file: String = _table8.get(id + 1, "")
	var s = null
	if file != "" and GameData.exists("cg9/%s.json" % file.get_basename()):
		s = SpriteSet.load_set(file.get_basename())
	_sets[id] = s
	return s


static func new_sprite() -> Dictionary:
	return {"x": 0, "y": 0, "action": 0, "dir": 0, "step": 0, "layer": 0, "visible": 0, "len": 0, "sound": 0,
		"seq": 0, "frame": 0, "flags": 0, "set": null}


## f_75504: select the sequence of (action, dir), or the set's first action if there is none.
static func set_action(s: Dictionary, action: int, dir: int) -> void:
	var sprite_set = s["set"]
	if sprite_set == null:
		return
	var actions: Array = sprite_set.data["actions"]
	if actions.is_empty():
		return
	var e: Dictionary = actions[0]
	var found := false
	for a: Dictionary in actions:
		if int(a["action"]) == action and int(a["dir"]) == dir:
			e = a
			found = true
			break
	if not found:
		action = int(e["action"])
		dir = int(e["dir"])
	s["action"] = action
	s["dir"] = dir
	s["seq"] = int(e["sequence"])
	s["step"] = 0
	var q: Dictionary = sprite_set.data["sequences"][s["seq"]]
	s["sound"] = int(q["sound"])
	s["len"] = q["steps"].size()


## f_755e0: show seq[step], then step++ (wrapping to 0 returns 1).
static func advance(s: Dictionary) -> int:
	var sprite_set = s["set"]
	if sprite_set == null:
		return 0
	var steps: Array = sprite_set.data["sequences"][s["seq"]]["steps"]
	var st: Dictionary = steps[s["step"]] if s["step"] < steps.size() else {"flags": 0, "frame": 0}
	s["flags"] = int(st["flags"])
	s["frame"] = int(st["frame"])
	s["step"] = (int(s["step"]) + 1) & 0xff
	if s["step"] >= s["len"]:
		s["step"] = 0
		return 1
	return 0


## f_77cc0 + f_7800e: actors (FieldLogic actor records) and sprites after a map load.
## prog: the map program (Programs.load_map); party: [{x, y, set}]; facing: arrival facing.
static func load_actors(prog: Dictionary, field, sprites: Array, party: Array, facing: int, flag_set: Callable) -> void:
	var raw: PackedByteArray = prog["actors"]
	var count: int = prog["raw"][17]
	var sets := raw.slice(0, 16)
	var n_party: int = party.size()
	for i in 32:
		var a = field.act[i]
		a.x = 0
		a.y = 0
		a.facing = 0
		a.flags = 0
		a.type = -1
		a.visible = 0
		sprites[i] = new_sprite()
	var recs := []
	for i in count + 3:
		var a = field.act[i]
		var set_id := -1
		var rec := {}
		if i <= 2:
			if i >= n_party:
				continue
			var p: Dictionary = party[i]
			a.x = p["x"]
			a.y = p["y"]
			a.facing = facing
			a.flags = 0
			set_id = p["set"]
		else:
			var o := 16 + 8 * (i - 3)
			var ex := 0x110 + 2 * i
			rec = {"x": _s16(raw.decode_u16(o)), "y": _s16(raw.decode_u16(o + 2)), "set": raw[o + 4],
				"flag_ref": raw[o + 5], "action": raw[ex] if ex < raw.size() else 0,
				"bits": raw[ex + 1] if ex + 1 < raw.size() else 0}
			a.x = rec["x"]
			a.y = rec["y"]
			a.facing = rec["bits"] & 15
			set_id = sets[rec["set"]] if rec["set"] < 16 else 0xff
			a.flags = (rec["bits"] >> 4) & 1
			if (rec["bits"] & 0x20) or rec["flag_ref"]:
				a.flags |= 4   # stationary: animates in place, never wanders
		recs.append(rec)
		# shared tail of f_77d20
		a.flags |= 0x80
		var sprite_set = sprite_set(set_id)
		var attr: Array = _attributes(sprite_set)
		a.w = int(attr[11]) if attr.size() > 11 and int(attr[11]) else 2
		a.h = int(attr[10]) if attr.size() > 10 and int(attr[10]) else 2
		a.type = int(attr[9]) if attr.size() > 9 else -1
		a.layer = a.flags & 1
		var s: Dictionary = sprites[i]
		s["set"] = sprite_set
		s["set_id"] = set_id
		s["x"] = a.x
		s["y"] = a.y
		s["layer"] = a.flags & 1
		if (a.flags & 0x80) and sprite_set != null:
			s["visible"] = 0x80
		else:
			s["visible"] = 0
			a.flags &= 0x7f
		a.visible = s["visible"]
		if sprite_set == null:
			continue
		var action := 0
		var dir: int = a.facing
		if i > 2:
			if rec["flag_ref"]:
				dir = 2 if flag_set.call(rec["flag_ref"]) else 0   # doors: open / closed from a flag
			action = rec["action"]
		set_action(s, action, dir)
		advance(s)
		a.dir = s["dir"]
		a.step = s["step"]   # one record in the original: the walk logic's step is the sprite's


## f_76980 for a stationary map actor, once per field tick: the animation timer.
static func tick_stationary(a, s: Dictionary, timers: Dictionary, i: int) -> void:
	var sprite_set = s["set"]
	var attr: Array = _attributes(sprite_set)
	var speed: int = int(attr[8]) if attr.size() > 8 and int(attr[8]) else 15
	var t: int = (int(timers.get(i, 0)) + speed) & 0xff
	if t <= 0x13:
		timers[i] = t
		return
	timers[i] = 1
	if a.flags & 4:
		advance(s)


## f_76980: an active, visible map actor's behaviour each field tick. The timer adds the speed
## (attribute 8, 0 -> 15) and acts above 19 (then 1). Stationary actors (flags bit 2) animate.
## Behaviour flags (actor +6 = attribute 2): bit 1 wait until the leader is within (attr 4, 5),
## then wander; bit 0 head toward the leader when within (attr 6, 7). Wandering starts from the
## facing (8-direction 2 * facing); for each offset of $9BFBC (0, +1, -1, +2, -2) a draw r =
## rng(255) turns ±90° when r & 15 <= 1, then one step is tried (f_7743a). A type-4 actor bumping
## into a party member starts a contact battle (returns true); another actor blocking turns the
## base direction by +2. Then face, sync and animate. rand: Callable(n) -> f_88e00(n).
static func behave(field, s: Dictionary, i: int, timers: Dictionary, rand: Callable) -> bool:
	var a = field.act[i]
	var attr: Array = _attributes(s["set"])
	var at := func(k: int) -> int: return int(attr[k]) if k < attr.size() else 0
	field._conveyor(i, 2)
	var speed: int = at.call(8) if at.call(8) else 15
	var t: int = (int(timers.get(i, 0)) + speed) & 0xff
	if t <= 0x13:
		timers[i] = t
		return false
	timers[i] = 1
	if a.flags & 4:
		advance(s)
		return false
	var beh: int = int(s.get("beh", at.call(2)))
	var d8: int = 2 * (a.facing & 3)
	var contact := false
	if beh & 2:
		if field.near(i, at.call(4), at.call(5)):
			s["beh"] = beh ^ 2
	else:
		var d3: int = d8
		if (beh & 1) and field.near(i, at.call(6), at.call(7)):
			var lead = field.act[0]
			d3 = field.dir_toward(lead.x - a.x, lead.y - a.y)
		for off: int in [0, 1, -1, 2, -2]:
			var r: int = rand.call(255)
			if (r & 15) <= 1:
				d3 = ((r >> 7) * 4 + d3 - 2) & 7
			d8 = (off + d3) & 7
			var res: int = field._try_move_keep(i, d8, 2)
			if res == 0:
				break
			if res == 2:
				if at.call(9) == 4:
					if field._hit <= 2:
						contact = true
						break
				else:
					d3 += 2
	field.set_facing(i, d8)
	field._sync_sprite(i)
	if int(s["dir"]) != (a.facing & 3):
		var step: int = s["step"]
		set_action(s, int(s["action"]), a.facing & 3)
		s["step"] = step
	s["x"] = a.x
	s["y"] = a.y
	advance(s)
	return contact


## builtin 34 actorShow(n, on), n 1-based.
static func actor_show(field, sprites: Array, n: int, on: bool) -> void:
	if n < 1 or n > 32:
		return
	var a = field.act[n - 1]
	var s: Dictionary = sprites[n - 1]
	if on:
		a.flags |= 0x80
		s["visible"] = int(s["visible"]) | 0x80
	else:
		a.flags &= 0x3f
		s["visible"] = int(s["visible"]) & 0x7f
	a.visible = s["visible"]


static func _s16(v: int) -> int:
	return v - 0x10000 if v & 0x8000 else v


## CG9 attribute bytes of a sprite set ([] when none).
static func _attributes(sprite_set) -> Array:
	if sprite_set == null or sprite_set.data.get("attributes") == null:
		return []
	return sprite_set.data["attributes"]
