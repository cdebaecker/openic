extends RefCounted
## Event programs from the export (events/*.evt, IC_MAIN.SCN, CONSULT.SCN), as
## tools/events/vm/programs.mjs: a program is {"name", "kind", "code"}; map programs also carry the
## EVT blocks (actors, triggers, part 1 = cutscenes) and their entry points.


static func load_scn(name: String) -> Dictionary:
	var code := FileAccess.get_file_as_bytes(GameData.path("events/" + name))
	return {"name": name, "kind": "consult" if name.to_upper().begins_with("CONSULT") else "main", "code": code}


static func load_map(id: String) -> Dictionary:
	var b := FileAccess.get_file_as_bytes(GameData.path("events/%s.evt" % id))
	if b.size() < 32:
		return {}
	var actor_size := b.decode_u16(6)
	var trig_size := b.decode_u16(8)
	var b3_size := b.decode_u16(10)
	var p1_size := b.decode_u16(12)
	var p2_size := b.decode_u16(14)
	var p := 32
	var actors := b.slice(p, p + actor_size)
	p += actor_size
	var triggers := b.slice(p, p + trig_size)
	p += trig_size
	p += b3_size
	var part1 := b.slice(p, p + p1_size)
	p += p1_size
	var code := b.slice(p, p + p2_size)
	return {"name": id, "kind": "map", "code": code, "raw": b, "trigger_count": b[18], "cutscene_count": b[21],
		"actors": actors, "triggers": triggers, "part1": part1}


## Entry points (trigger block header): enter +0, load +2, always +4, talk prologue +10; triggers.
static func entries(prog: Dictionary) -> Dictionary:
	var t: PackedByteArray = prog["triggers"]
	var a: PackedByteArray = prog["actors"]
	var hdr := []
	for i in 8:
		hdr.append(t.decode_u16(2 * i))
	var triggers := []
	for i in int(prog["trigger_count"]):
		var o := 16 + 12 * i
		triggers.append({"index": i, "x": t.decode_u16(o), "y": t.decode_u16(o + 2), "w": t[o + 4], "h": t[o + 5],
			"entry": t.decode_u16(o + 6), "flags": t[o + 11]})
	var actors := []
	for k in 29:
		var o := 16 + 8 * k
		actors.append({"slot": k + 3, "talk": a.decode_u16(o + 6)})
	return {"enter": hdr[0], "load": hdr[1], "always": hdr[2], "talk_pre": hdr[5], "header": hdr,
		"triggers": triggers, "actors": actors}
