extends Node
## Development: replays every message call recorded by tools/events/trace-cutscenes.mjs through
## MessageEngine (Japanese, no substitution) and compares the event sequence (glyph code, cell,
## colour; waits; clears) and the resume point with the original's, as tools/events/cf/verify.mjs.
## Run: godot --headless --path godot -- --message-test=<trace .json>[,<trace .json>...]

signal finished(next: String, args: Dictionary)

const MessageEngine := preload("res://scripts/events/message_engine.gd")


class Recorder:
	var events: Array = []
	var inserts: Array = []
	var kinsoku := true

	func put(_win: Dictionary, cx: int, cy: int, code: int, colour: int) -> void:
		events.append(["put", code, cx, cy, colour])

	func clear(_rect: Rect2i) -> void:
		events.append(["clear"])

	func wait_click(_win: Dictionary, cx: int, cy: int) -> void:
		events.append(["wait", cx, cy])

	func delay(_vsyncs: int) -> void:
		pass

	func insert(_n: int) -> PackedByteArray:
		return PackedByteArray(inserts.pop_front()) if not inserts.is_empty() else PackedByteArray()

	func number(_n: int) -> int:
		return 0


func _ready() -> void:
	GameText.language = "ja"
	var files := []
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("--message-test="):
			files = arg.trim_prefix("--message-test=").split(",")
	var calls := 0
	var calls_ok := 0
	var events := 0
	var events_ok := 0
	for f: String in files:
		var t: Dictionary = JSON.parse_string(FileAccess.get_file_as_string(f))
		var ev: Array = t["text"]
		for i in ev.size():
			var e: Dictionary = ev[i]
			if e["op"] != "call" or not e.has("text"):
				continue
			calls += 1
			var rec := []
			var j := i + 1
			while j < ev.size() and ev[j]["op"] != "return":
				var r: Dictionary = ev[j]
				if r["op"] == "put":
					rec.append(["put", int(r["code"]), int(r["cx"]), int(r["cy"]), int(r["colour"])])
				elif r["op"] == "clear":
					rec.append(["clear"])
				elif r["op"] == "wait":
					var mk: Array = r.get("marker", [-1, -1])
					rec.append(["wait", int(mk[0]), int(mk[1])])
				j += 1
			var ret: Variant = ev[j].get("resumeAt") if j < ev.size() else null
			var host := Recorder.new()
			host.inserts = e.get("inserts", []).duplicate()
			var eng := MessageEngine.new(host)
			eng.colour = int(e.get("colour", 7))
			var w0: Dictionary = e["winBefore"] if e.get("winBefore") != null else e["win"]
			var win := {"x": int(w0["x"]), "y": int(w0["y"]), "w": int(w0["w"]), "h": int(w0["h"]),
				"cx": int(w0["cx"]), "cy": int(w0["cy"])}
			var text := PackedByteArray(e["text"])
			var resume: int = await eng.show(win, text, bool(e["open"]), 0, bool(e["cont"]))
			var ok: bool = host.events.size() == rec.size() and (resume if resume >= 0 else null) == ret
			for k in maxi(host.events.size(), rec.size()):
				events += 1
				if k < host.events.size() and k < rec.size() and str(host.events[k]) == str(rec[k]):
					events_ok += 1
				else:
					ok = false
			if ok:
				calls_ok += 1
			else:
				print("mismatch at frame %d" % int(e["f"]))
	print("messages %d/%d, events %d/%d" % [calls_ok, calls, events_ok, events])
	get_tree().quit()
