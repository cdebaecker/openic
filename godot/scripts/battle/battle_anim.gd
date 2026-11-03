extends RefCounted
## Presentation of battle actions (docs/battle-ui.md section 4), transcribed from
## tools/battle-ui/anim.mjs: which sprite animations the game plays for an executed action, from
## the action struct $A1A9A (54 bytes) the logic fills and the battle records.
##
##   var act := BattleAnim.parse_action(bytes)
##   BattleAnim.presentation(act, recs, ctx) -> [{op, ...}]   op: oneshot | place | attack | effect | effect_all
##   recs: [{spr, idle}] per record; ctx: {rec, side ("party" / "enemy"), char_of: Callable(rec) -> id,
##   cg_attr32: Callable(rec) -> attribute byte 0, trigger: Callable(rec, action) -> bool (the action's
##   sequence has a step with flags bit 0), effect_anim: Callable(id) -> table 5 record +3}

const ENEMY_SLOT_SHIFT := [[0, 8], [0x10, 0x20], [0x18, 0x28]]


static func parse_action(b: PackedByteArray) -> Dictionary:
	var w := func(o: int) -> int: return (b[o] << 8) | b[o + 1]
	var n: int = w.call(16)
	var targets: Array = []
	for k in mini(n, 12):
		targets.append(w.call(18 + 2 * k))
	return {"count": n, "targets": targets, "trigger": b[44], "type": b[45], "pose": b[46], "b47": b[47],
		"action": b[48], "effect": b[49], "b50": b[50], "b51": b[51], "lunge": b[52], "place": b[53]}


## f_6c648: {oneshot (-1 = none), idle} or {reset: true} by weapon class.
static func weapon_pose(cls: int, idle: int, char_id: int) -> Dictionary:
	match cls:
		1:
			return {"oneshot": 2 if char_id == 7 and idle != 0x0e else -1, "idle": 0x0e}
		2:
			return {"oneshot": -1, "idle": 0x0e}
		4:
			return {"oneshot": 2 if idle != 0x0c else -1, "idle": 0x0c}
		5:
			return {"oneshot": -1, "idle": 0x0d}
		6:
			return {"oneshot": -1, "idle": 0x0b}
		7:
			return {"oneshot": 2 if idle != 0x0a else -1, "idle": 0x0a}
		8:
			return {"oneshot": 8 if idle != 0x0c else -1, "idle": 0x0c}
		9:
			return {"oneshot": 7 if idle != 0x0d else -1, "idle": 0x0d}
		11:
			return {"oneshot": 3 if idle != 0x0f else -1, "idle": 0x0f}
	return {"reset": true}


## f_6cfda
static func reset_pose(idle: int, char_id: int) -> Dictionary:
	if char_id == 4 and idle == 0x0c:
		return {"oneshot": 0x31, "idle": idle}
	if char_id == 4 and idle == 0x0d:
		return {"oneshot": 0x32, "idle": idle}
	if idle == 0x0a:
		return {"oneshot": 0x30, "idle": 6}
	return {"oneshot": -1, "idle": idle}


static func presentation(act: Dictionary, recs: Array, ctx: Dictionary) -> Array:
	var out: Array = []
	var rec: int = ctx["rec"]
	var spr: int = recs[rec]["spr"]
	var st := {"idle": int(recs[rec]["idle"])}
	var char_id: int = ctx["char_of"].call(rec) if ctx.has("char_of") else -1
	var targets: Array = act["targets"]
	var t0: int = targets[0] if not targets.is_empty() else 0
	if ctx["side"] == "party":
		if act["type"] == 2:   # f_6baa4
			_do_pose(out, rec, st, weapon_pose(act["pose"], st["idle"], char_id), char_id)
			if not act["count"]:
				return out
			_lunge_party(out, act, rec, spr, t0)
			_attack_anim(out, act, ctx, rec, spr, act["action"], act["effect"])
			_apply_effect(out, act, ctx, rec, spr, act["effect"])
			if char_id != 4:
				_do_pose(out, rec, st, {"reset": true}, char_id)
		elif act["type"] == 0 or act["type"] == 5:   # f_6ba3e
			if not act["count"]:
				return out
			_lunge_party(out, act, rec, spr, t0)
			_attack_anim(out, act, ctx, rec, spr, act["action"], 0)
			_apply_effect(out, act, ctx, rec, spr, act["effect"])
		return out
	# enemy: f_6b98c
	if not act["count"] or (not act["pose"] and not act["b47"]):
		return out
	var action: int = act["action"]
	var effect: int = act["effect"]
	if act["lunge"] == 1:
		out.append({"op": "place", "rec": t0, "spr": spr, "dy": -5})
	if act["place"]:
		out.append({"op": "place", "rec": t0, "spr": 8 + spr, "dy": -1})
	else:
		out.append({"op": "place", "rec": rec, "spr": 8 + spr, "dy": 0})
	var a32: int = ctx["cg_attr32"].call(rec) if ctx.has("cg_attr32") else 0
	if act["lunge"] == 3:
		var t_spr: int = recs[t0]["spr"] if t0 < recs.size() else -1
		var sh: Array = ENEMY_SLOT_SHIFT[t_spr] if t_spr >= 0 and t_spr < 3 else [0, 0]
		action = (action + int(sh[0])) & 0xff
		effect = (effect + int(sh[1] if a32 else sh[0])) & 0xff
	elif a32:
		effect = (effect + 8) & 0xff
	_attack_anim(out, act, ctx, rec, spr, action, effect)
	_apply_effect(out, act, ctx, rec, spr, act["b50"])
	return out


static func _do_pose(out: Array, rec: int, st: Dictionary, res: Dictionary, char_id: int) -> void:
	if res.get("reset", false):
		var z := reset_pose(st["idle"], char_id)
		if z["oneshot"] >= 0:
			out.append({"op": "oneshot", "rec": rec, "action": z["oneshot"]})
		st["idle"] = z["idle"]
		return
	if res["oneshot"] >= 0:
		out.append({"op": "oneshot", "rec": rec, "action": res["oneshot"]})
	st["idle"] = res["idle"]


static func _attack_anim(out: Array, act: Dictionary, ctx: Dictionary, rec: int, spr: int, action: int,
		effect: int) -> void:
	out.append({"op": "attack", "rec": rec, "action": action, "effect": effect})
	if act["trigger"] and ctx.has("trigger") and ctx["trigger"].call(rec, action):
		out.append({"op": "effect", "spr": spr, "rec": rec, "action": effect})
		if act["place"]:
			out.append({"op": "effect_all", "rec": rec, "slot": spr})


## f_6cc02: the effect of table 5 id $A1AC9 on every target (its own animation replaces eff).
static func _apply_effect(out: Array, act: Dictionary, ctx: Dictionary, rec: int, spr: int, eff: int) -> void:
	if not act["b47"]:
		return
	var a: int = ctx["effect_anim"].call(act["b47"]) if ctx.has("effect_anim") else 0
	if a:
		eff = a
	if eff:
		out.append({"op": "effect_all", "rec": rec, "slot": spr, "effect": eff})


## f_6c816: the attacker moves onto target 0, the effect sprite is placed.
static func _lunge_party(out: Array, act: Dictionary, rec: int, spr: int, t0: int) -> void:
	if act["lunge"] == 1:
		out.append({"op": "place", "rec": t0, "spr": spr, "dy": 1})
	elif act["lunge"] == 2 or act["lunge"] == 3:
		out.append({"op": "place", "rec": t0, "spr": spr, "dy": 5})
	match int(act["place"]):
		0:
			out.append({"op": "place", "rec": rec, "spr": 8 + spr, "dy": 0})
		1:
			out.append({"op": "place", "rec": t0, "spr": 8 + spr, "dy": 0})
		2:
			out.append({"op": "place", "rec": rec, "spr": 8 + spr, "dy": 1})


## Comparable key of a call (tools/battle-ui/anim.mjs callKey).
static func call_key(x: Dictionary) -> String:
	match str(x["op"]):
		"oneshot":
			return "oneshot %d %d" % [x["rec"], x["action"]]
		"place":
			return "place %d %d %d" % [x["rec"], x["spr"], x["dy"]]
		"attack":
			return "attack %d %d %d" % [x["rec"], x["action"], x["effect"]]
		"effect":
			return "effect %d %d %d" % [x["spr"], x["rec"], x["action"]]
		"effect_all":
			return "effectAll %d %d" % [x["rec"], x["slot"]]
	return str(x["op"])


## Text palette fade (f_87bcc): 0GRB entry c at step k (fading in: min(gun, k); out: max(0, gun - k)).
static func fade_word(c: int, k: int, fade_out := false) -> int:
	var f := func(v: int) -> int: return maxi(0, v - k) if fade_out else mini(v, k)
	var g: int = f.call((c >> 8) & 15)
	var r: int = f.call((c >> 4) & 15)
	var b: int = f.call(c & 15)
	return (g << 12) | (r << 7) | (b << 2) | 1
