extends RefCounted
## Constant data of the battle logic (scripts/battle/battle_model.gd): loadBattleData of
## tools/battle/model.mjs. IC_TABLE.COM comes from data/systems.json (systems_model.gd tables:
## `raw` = the whole file, `offsets`), the tables inside ICITY68.X and the message templates from
## data/battle.json (tools/export/battledata.mjs).
##
## Result (snake_case keys of the JS object): raw, off, event_groups (10 lists of [set, x, row,
## pose]), party_pos3, party_pos2, cmd_codes, skill_word (PackedByteArrays), plus what the
## presentation needs to print the log: messages {address: PackedByteArray template},
## message_names {name: address}, table_stride, table_name_off.

const SYS := preload("res://scripts/systems/systems_model.gd")

static var _data := {}


static func load_battle_data() -> Dictionary:
	if _data.is_empty():
		var gd: Node = Engine.get_main_loop().root.get_node("/root/GameData")
		_data = build(SYS.tables(), gd.json("data/battle.json"))
	return _data


static func set_data(d: Dictionary) -> void:
	_data = d


## systems tables + battle.json -> the data dictionary
static func build(tables: Dictionary, bj: Dictionary) -> Dictionary:
	var d := {"raw": tables["raw"], "off": tables["offsets"]}
	var groups := []
	for g: Array in bj["eventGroups"]:
		var r := []
		for e: Array in g:
			r.append(PackedByteArray(e))
		groups.append(r)
	d["event_groups"] = groups
	d["party_pos3"] = PackedByteArray(bj["partyPos3"])
	d["party_pos2"] = PackedByteArray(bj["partyPos2"])
	d["cmd_codes"] = PackedByteArray(bj["cmdCodes"])
	d["skill_word"] = PackedByteArray(bj["skillWord"])
	d["table_stride"] = PackedInt32Array(bj["tableStride"])
	d["table_name_off"] = PackedInt32Array(bj["tableNameOff"])
	var names := {}
	for k: String in bj["messageNames"]:
		names[k.to_snake_case()] = int(bj["messageNames"][k])
	d["message_names"] = names
	var msgs := {}
	for k: String in bj["messages"]:
		msgs[k.hex_to_int()] = Marshalls.base64_to_raw(bj["messages"][k])
	d["messages"] = msgs
	return d
