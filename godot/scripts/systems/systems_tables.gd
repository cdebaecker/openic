extends RefCounted
## Table loading for scripts/systems/systems_model.gd: IC_TABLE.COM as tools/systems/tables.mjs
## decodes it, from the exported data/systems.json (named fields, tools/export/systems.mjs) and
## data/IC_TABLE.json (raw table bytes up to the string pool, tools/export/data.mjs; the stat
## recompute reads weapon and armour records by raw offset, as the game does).


## systems.json + IC_TABLE.json -> the tables dictionary of systems_model.gd
static func build(sj: Dictionary, ict: Dictionary) -> Dictionary:
	var t := {}
	var raw := PackedByteArray()
	var offsets := PackedInt32Array()
	for o in ict["offsets"]:
		offsets.append(int(o))
	var end := 2 * offsets.size()
	for tb: Dictionary in ict["tables"]:
		end = maxi(end, int(tb["offset"]) + int(tb["size"]))
	raw.resize(end)
	for k in offsets.size():
		raw[2 * k] = offsets[k] & 255
		raw[2 * k + 1] = offsets[k] >> 8
	for tb: Dictionary in ict["tables"]:
		var hex: String = tb["raw"] if tb.has("raw") else ""
		if not tb.has("raw"):
			for r: Dictionary in tb["records"]:
				hex += r["bytes"]
			hex += tb["tail"]
		var bytes := hex.hex_decode()
		var at := int(tb["offset"])
		for k in bytes.size():
			raw[at + k] = bytes[k]
	if sj.has("raw"):
		# the whole file (tools/export/systems.mjs): out-of-range weapon indices read into the
		# string pool, which IC_TABLE.json does not carry
		raw = Marshalls.base64_to_raw(sj["raw"])
	t["raw"] = raw
	t["offsets"] = offsets
	var items := []
	for it: Dictionary in sj["items"]:
		items.append({"price": int(it["price"]), "effect": int(it["effect"]), "field": bool(it["field"]),
			"reusable": bool(it["reusable"])})
	t["items"] = items
	var passive := PackedInt32Array()
	for e: Dictionary in sj["effects"]:
		passive.append(int(e["passive"]))
	t["effects_passive"] = passive
	var weapons := []
	for w: Dictionary in sj["weapons"]:
		weapons.append({"price": int(w["price"]), "data_offset": int(w["dataOffset"])})
	t["weapons"] = weapons
	var armour := []
	for a: Dictionary in sj["armour"]:
		armour.append({"price": int(a["price"])})
	t["armour"] = armour
	var spells := []
	for sp: Dictionary in sj["spells"]:
		spells.append({"name": sp["name"], "cost": int(sp["cost"]), "effect": int(sp["effect"]),
			"field": bool(sp["field"]), "single": bool(sp["single"]), "all": bool(sp["all"])})
	t["spells"] = spells
	var lists := []
	for l: Array in sj["spellLists"]:
		var ids := PackedInt32Array()
		for x: Dictionary in l:
			ids.append(int(x["id"]))
		lists.append(ids)
	t["spell_lists"] = lists
	t["exp_curve"] = sj["expCurve"].map(func(a: Array) -> PackedInt32Array: return PackedInt32Array(a))
	t["growth"] = sj["growth"].map(func(g: Dictionary) -> PackedInt32Array: return PackedInt32Array(g["raw"]))
	t["initial_chars"] = sj["initialChars"].map(func(a: Array) -> PackedByteArray: return PackedByteArray(a))
	t["initial_items"] = sj["initialItems"].map(
		func(x: Dictionary) -> Vector2i: return Vector2i(int(x["code"]), int(x["count"])))
	t["places"] = sj["places"]
	return t
