extends RefCounted
## The map cutscene ("letter") interpreter (f_78622 run, f_78784 step), transcribed from
## tools/events/cutscene.mjs, which reproduces every recorded cutscene pass of the original
## (docs/cutscenes-field.md, section 1). Requests are performed by the host and awaited.
##
## host fields: part1 (PackedByteArray), count, sprites (Array of sprite dicts), field (FieldLogic:
##   actor records act[]), n_actors, party_size, view (Vector2i), bounds (Rect2i: min / max),
##   triggers, pending_trigger, picture_mode, resume_pending, wait_vsyncs
## host methods (may be coroutines): frame(vsyncs), redraw(), message_cutscene(key, window), wait_click(),
##   clear_window(), continue_message(), close_windows(), close_picture(), picture(n),
##   music_fade_out(n), music_start(), sound(n), palette(set), restore_palette(),
##   map_anim(slot, code, value), map_anim_done(slot, code, pass) -> bool

const Actors := preload("res://scripts/events/actors.gd")
const COMMANDS := "SMALTPGCgpmwfBbE"   # $9C106; 'e' is deliberately not in the table

var h
var wait := 10                 # $9CB2E during a cutscene
var moves := {}                # actor -> M record
var delay: Array[int] = []
var delay0: Array[int] = []


func _init(host) -> void:
	h = host


static func _u16(b: PackedByteArray, i: int) -> int:
	return (b[i] if i < b.size() else 0) | ((b[i + 1] if i + 1 < b.size() else 0) << 8)


static func _s16(v: int) -> int:
	v &= 0xffff
	return v - 0x10000 if v & 0x8000 else v


## One step from `at`: commands up to and including 'E'. abort = an unknown byte (stops the cutscene).
static func parse_step(b: PackedByteArray, at: int) -> Dictionary:
	var cmds := []
	var p := at
	while true:
		if p >= b.size() or COMMANDS.find(char(b[p])) < 0:
			return {"cmds": cmds, "next": p, "abort": true}
		var ch := char(b[p])
		var c := {"cmd": ch, "at": p}
		p += 1
		match ch:
			"S":
				var n := b[p]
				p += 1
				var list := []
				for i in n:
					list.append({"actor": b[p], "visible": b[p + 1]})
					p += 2
				c["list"] = list
			"M":
				var n := b[p]
				p += 1
				var list := []
				for i in n:
					list.append({"actor": b[p], "mode": b[p + 1], "rel": b[p + 2], "x": _s16(_u16(b, p + 3)),
						"y": _s16(_u16(b, p + 5)), "action": b[p + 7], "dir": b[p + 8], "delay": b[p + 9]})
					p += 10
				c["list"] = list
			"A":
				var n := b[p]
				p += 1
				var list := []
				for i in n:
					list.append({"code": b[p], "value": b[p + 1]})
					p += 2
				c["list"] = list
			"L":
				c["x"] = _s16(_u16(b, p))
				c["y"] = _s16(_u16(b, p + 2))
				c["speed"] = b[p + 4]
				p += 5
			"T":
				c["key"] = _u16(b, p)
				c["mode"] = b[p + 2]
				p += 3
			"P":
				c["restore"] = b[p]
				var n := b[p + 1]
				p += 2
				var colours := {}
				for i in n:
					colours[b[p]] = _u16(b, p + 1)
					p += 3
				c["set"] = colours
			"G":
				c["n"] = b[p]
				p += 2
			"C":
				p += 3
			"m":
				p += 4
			"w", "f", "B", "b", "g", "p":
				c["n"] = b[p]
				p += 1
		cmds.append(c)
		if ch == "E":
			return {"cmds": cmds, "next": p, "abort": false}
	return {}


## f_79726: move p toward (tx, ty) by up to sp on each axis; 1 if p was not already there.
static func step_toward(p: Array, tx: int, ty: int, sp: int) -> int:
	var moved := 0 if p[0] == tx and p[1] == ty else 1
	for k in 2:
		var v: int = p[k]
		var t := ty if k else tx
		if t > v:
			p[k] = t if t <= v + sp else _s16(v + sp)
		elif t < v:
			p[k] = t if t >= v - sp else _s16(v - sp)
	return moved


## f_73a34(2, x, y): view := (x, y) clamped to the map.
func camera_to(x: int, y: int) -> void:
	var b: Rect2i = h.bounds
	var vx := x
	var vy := y
	if vy < b.position.y:
		vy = b.position.y
	if vy + 18 > b.end.y:
		vy = b.end.y - 18
	if vx < b.position.x:
		vx = b.position.x
	if vx + 24 > b.end.x:
		vx = b.end.x - 24
	h.view = Vector2i(vx, vy)


## f_78622(n): the whole cutscene (n 0-based).
func run(n: int) -> void:
	if n >= h.count:
		return
	var saved: int = h.wait_vsyncs
	wait = 10
	var p: int = _u16(h.part1, 2 * n) + 2 * h.count
	while p < h.part1.size() and h.part1[p] != 0x65:   # 'e'
		var r: Dictionary = await step(h.part1, p)
		if r["abort"]:
			break
		p = r["next"]
	# copy the sprites back into the actor records
	for i in h.sprites.size():
		var a = h.field.act[i]
		var s: Dictionary = h.sprites[i]
		a.x = s["x"]
		a.y = s["y"]
		a.facing = s["dir"]
		a.dir = s["dir"]
		a.step = s["step"]
	h.wait_vsyncs = saved


## f_78784: one step at `at`. Returns the parse result ({next, abort}).
func step(bytes: PackedByteArray, at: int) -> Dictionary:
	var count: int = h.n_actors
	var parsed := parse_step(bytes, at)
	_trace_step(at, count)
	moves = {}
	delay.clear()
	delay0.clear()
	delay.resize(32)
	delay0.resize(32)
	var anim := {}
	var cam = null
	var cam_pending := false
	var talk = null
	var picture := -1
	var sound := -1
	var music := false
	var restore_pal := 0
	for c: Dictionary in parsed["cmds"]:
		match c["cmd"]:
			"S":
				for e in c["list"]:
					var i: int = e["actor"]
					var s: Dictionary = h.sprites[i]
					var a = h.field.act[i]
					if e["visible"]:
						if i > 2 or i < h.party_size:
							s["visible"] = 0x80
							a.flags |= 0x80
					else:
						s["visible"] = 0
						a.flags &= 0x7f
					a.visible = s["visible"]
			"M":
				for r0 in c["list"]:
					var i: int = r0["actor"]
					if i <= 2 and i >= h.party_size:
						continue
					var r: Dictionary = r0.duplicate()
					if (r["mode"] & 3) == 1:
						var o: Dictionary = h.sprites[r["rel"]]
						r["x"] = _s16(r["x"] + o["x"])
						r["y"] = _s16(r["y"] + o["y"])
					elif (r["mode"] & 3) == 2 and h.pending_trigger >= 0 and h.pending_trigger < h.triggers.size():
						var t: Dictionary = h.triggers[h.pending_trigger]
						r["x"] = _s16(r["x"] + int(t["x"]))
						r["y"] = _s16(r["y"] + int(t["y"]))
					var s: Dictionary = h.sprites[i]
					if r["delay"] == 0xff:
						s["x"] = r["x"]
						s["y"] = r["y"]
					else:
						delay[i] = r["delay"]
						delay0[i] = r["delay"]
					if r["mode"] & 0x78:
						Actors.set_action(s, r["action"], r["dir"])
						if r["mode"] & 0x10:
							Actors.advance(s)
						if r["mode"] & 0x08:
							s["step"] = 0
							Actors.advance(s)
					moves[i] = r
			"A":
				var k := 0
				for e in c["list"]:
					anim[k] = e["code"]
					h.map_anim(k, e["code"], e["value"])
					k += 1
			"L":
				cam = c
				cam_pending = true
			"T":
				if c["mode"] != 0x63:
					talk = {"key": (int(c["key"]) + 1) & 0xffff, "window": c["mode"]}
				elif h.picture_mode:
					h.picture_mode = 0
					await h.close_picture()
				else:
					h.close_windows()
			"P":
				restore_pal = c["restore"]
				h.palette(c["set"])
			"G":
				if c["n"] != 0x63:
					picture = c["n"]
				else:
					h.picture_mode = 0
					await h.close_picture()
			"B":
				music = true
				h.music_fade_out(int(c["n"]) + 1)
			"f":
				sound = int(c["n"]) + 1
			"w":
				wait = c["n"] if c["n"] > 9 else (c["n"] >> 1) + 5
	if parsed["abort"]:
		return parsed
	var pass_no := 0
	var local := [h.view.x, h.view.y]
	while true:
		var busy := 0
		var moved: Array[int] = []
		moved.resize(32)
		if cam != null and cam["speed"]:
			busy = step_toward(local, cam["x"], cam["y"], cam["speed"])
			camera_to(local[0], local[1])
		elif cam_pending:
			cam_pending = false
			camera_to(cam["x"], cam["y"])
			h.view = Vector2i(cam["x"], cam["y"])   # set directly after the clamp (unclamped)
			busy = 1
		for k in 16:
			if (int(anim.get(k, 0)) & 0xe0) != 0xe0:
				continue
			if h.map_anim_done(k, anim[k], pass_no):
				anim[k] = 0
			busy = 1
		for i in count:
			if delay[i]:
				continue
			var r: Dictionary = moves.get(i, {})
			var mode: int = r.get("mode", 0)
			var s: Dictionary = h.sprites[i]
			if mode & 0x80:
				var p: Array = [s["x"], s["y"]]
				moved[i] = step_toward(p, r["x"], r["y"], 1)
				s["x"] = p[0]
				s["y"] = p[1]
				busy |= moved[i]
			if (mode & 0x60) or (moved[i] == 1 and (mode & 0x10)):
				Actors.advance(s)
				if s["step"] != 0:
					busy = 1
		for i in count:
			if delay[i] or not moves.has(i):
				continue
			var r: Dictionary = moves[i]
			var mode: int = r["mode"]
			var s: Dictionary = h.sprites[i]
			if s["step"] == 0 and ((mode & 0x70) == 0x40 or ((mode & 0x70) == 0x60 and not busy)):
				r["mode"] = r["mode"] & 0x8f
			if mode & 0x80:
				if s["x"] == r["x"] and s["y"] == r["y"] and not moved[i] and (mode & 0x10):
					if not (s["step"] & 1) and busy == 1:
						Actors.advance(s)
					r["mode"] = r["mode"] & 0x8f
		for i in count:
			if not delay[i]:
				delay[i] = delay0[i]
			else:
				delay[i] -= 1
				busy = 1
		if busy or pass_no == 0:
			if not h.picture_mode:
				await h.frame(wait)
			if pass_no == 0:
				if music:
					music = false
					h.music_start()
				if sound >= 0:
					h.sound(sound)
					sound = -1
				if picture >= 0:
					await h.picture(picture)
					h.picture_mode = 1
				if talk != null:
					if not h.picture_mode:
						h.redraw()
					await h.message_cutscene(talk["key"], talk["window"])
			pass_no += 1
		if restore_pal:
			h.restore_palette()
		if not busy:
			break
	# end of step: the message's first page is on screen
	if h.resume_pending:
		await h.wait_click()
		h.clear_window()
		await h.continue_message()
		await h.wait_click()
		h.clear_window()
	elif talk != null:
		await h.wait_click()
		h.clear_window()
	return parsed


## Development: -- --cutscene-trace=<file> appends each step's starting state (JSON lines), to
## compare with tools/events/trace-cutscenes.mjs recordings.
func _trace_step(at: int, count: int) -> void:
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("--cutscene-trace="):
			var path := arg.trim_prefix("--cutscene-trace=")
			var f := FileAccess.open(path, FileAccess.READ_WRITE if FileAccess.file_exists(path) else FileAccess.WRITE)
			f.seek_end()
			var sp := []
			for i in count:
				var s: Dictionary = h.sprites[i]
				sp.append([s["x"], s["y"], s["dir"], s["visible"], s["step"], s["frame"]])
			f.store_line(JSON.stringify({"offset": at, "view": [h.view.x, h.view.y], "sprites": sp}))
			f.close()
