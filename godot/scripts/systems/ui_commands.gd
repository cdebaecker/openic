extends RefCounted
## The six field commands (docs/systems-ui.md sections 2-6): f_7e16a(n) opens the money window,
## then runs MAGIC (f_7e8d0), ITEM (f_7ec7e), EQUIP (f_7f596), TALK (f_7c91c), STATUS (f_80390)
## or SYSTEM (f_7fa5c); afterwards every window closes and the field is redrawn. The keyboard
## command menu (confirm on the field) chooses n.
##
## Screens print what ui_screens.gd builds; the game logic is the systems model's.
## Also the shops and the inn (builtin 35) and the save menu (builtin 1, SYSTEM > load).
## Not yet: the debug menu.
##
## Save files are the original's ISV0-7.DAT (954 bytes, the state block) in user://saves/disk0
## (game disk 1) and user://saves/user (user disk): saves of the original can be copied there.

const UiToolkit := preload("res://scripts/systems/ui_toolkit.gd")
const UiScreens := preload("res://scripts/systems/ui_screens.gd")
const Programs := preload("res://scripts/events/programs.gd")
const GameState := preload("res://scripts/events/game_state.gd")

const MAGIC := 0
const ITEM := 1
const EQUIP := 2
const TALK := 3
const STATUS := 4
const SYSTEM := 5
const SAVE_DIRS := ["user://saves/disk0", "user://saves/user"]
## The port's quick save (F5 / F9 in the field): an ISV file like the slots'
const QUICK_FILE := "user://saves/quick/QUICK.DAT"
const SLOTS := 8
# medicines that ask for a member again and again (f_8148c)
const HP_ITEMS := [1, 2, 3, 4, 50, 51, 52, 53]
const MP_ITEMS := [5, 6, 7]

var host                       # the field screen
var ui: UiToolkit
var screens: UiScreens
var sys
var _command_cursor := -1
var _spells: Array = []


func _init(field_screen, systems_model) -> void:
	host = field_screen
	sys = systems_model
	ui = UiToolkit.new(host)
	screens = UiScreens.new(host.state, sys)
	if GameData.exists("data/systems.json"):
		_spells = GameData.json("data/systems.json").get("spells", [])


func available() -> bool:
	return screens.available() and sys != null


## Confirm on the field: the command menu, then the chosen command.
func command_menu() -> void:
	var win := ui.open("command")
	var n: int = await ui.menu(win, 0, _command_cursor, screens.command_menu())
	ui.close()
	if n >= 0:
		_command_cursor = n
		await run(n)


## f_7e16a(n)
func run(n: int) -> void:
	var money := ui.open("money")
	ui.print_lines(money, [screens.money_line()], 2)
	match n:
		MAGIC:
			await _magic()
		ITEM:
			await _item()
		EQUIP:
			await _equip()
		TALK:
			await _talk()
		STATUS:
			await _status()
		SYSTEM:
			await _system()
	ui.close_all()
	host.ui_boxes.clear()
	host.render()


func _charsel() -> int:
	var visible: Array = []
	for k in 3:
		visible.append(host.events.sprites[k]["visible"])
	var items := screens.charsel_items(visible)
	return await ui.charsel(items, screens.charsel_accepted(items))


func _buzz() -> void:
	host.events.sound(UiToolkit.BUZZER)


func _refresh_money() -> void:
	for w: Dictionary in host.events.windows:
		if w.get("name", "") == "money":
			ui.clear(w)
			ui.print_lines(w, [screens.money_line()], 2)


## A message in a UI window (the original uses the message engine f_72286), then a click.
func _message(win: Dictionary, bytes: PackedByteArray) -> void:
	ui.clear(win)
	ui.print_bytes(win, bytes)
	await ui.wait_click()


# --- MAGIC (f_7e8d0) -----------------------------------------------------------------------------

func _magic() -> void:
	while true:
		var slot := await _charsel()
		if slot < 0:
			return
		var header := screens.magic_header(slot)
		if header.is_empty():
			var none := ui.open("magicNone")
			await _message(none, screens.cstr(0x7e8b8))
			ui.close()
			continue
		var head := ui.open("magicHead")
		ui.print_lines(head, header)
		var list_win := ui.open("magicList")
		var cursor := -1
		var top := 0
		while true:
			var se := screens.spell_entries(slot)
			var r: Dictionary = await ui.run_list(list_win, 0, cursor, top, 2, 6, se[0])
			top = r["top"]
			var k: int = r["index"]
			if k < 0:
				break
			cursor = k
			var spell: int = se[1][k]
			if spell == 0 or not _spell_flag(spell, "field"):
				_buzz()
				continue
			await _cast(slot, spell)
			ui.clear(head)
			ui.print_lines(head, screens.magic_header(slot))
			host.render()
		ui.close()
		ui.close()


func _spell_flag(spell: int, key: String) -> bool:
	return spell < _spells.size() and bool(_spells[spell].get(key, false))


## f_80e9a: a field spell. Spells that may take one or all ask (［術効果］ 個別 / 集団); one target:
## the party-status window and the character selection, again and again while MP lasts; all: the
## whole party at 4x the cost; no target: cast at once. The status window stays for a click
## when the MP runs out or after a cast on all.
func _cast(slot: int, spell: int) -> void:
	var caster: int = screens.member(slot)
	var single := _spell_flag(spell, "single")
	var all := _spell_flag(spell, "all")
	var mode := 2
	if single and all:
		var mw := ui.open("spellMode")
		mode = await ui.menu(mw, 1, -1, screens.spell_mode_menu())
		if mode < 0:
			ui.close()
			return
	elif single:
		mode = 0
	elif all:
		mode = 1
	var cost: int = 0 if caster == 6 else int(_spells[spell].get("cost", 0))
	var mp := func() -> int: return host.state.le16(GameState.OFF_CHARS + GameState.CHAR_SIZE * caster + 10)
	if mode == 0:
		if mp.call() < cost:
			_buzz()
		else:
			while true:
				var win := _status_window(0x80e6e)
				var t := await _charsel()
				if t < 0:
					ui.close()
					break
				var res: Dictionary = sys.cast_spell(host.state, caster, spell, {"mode": 0, "targets": [t]})
				if int(res.get("casts", 0)) == 0:
					_buzz()
				if mp.call() < cost:
					_status_lines(win, PackedByteArray())
					await ui.wait_click()
					ui.close()
					break
				ui.close()
	elif mode == 1:
		var res: Dictionary = sys.cast_spell(host.state, caster, spell, {"mode": 1})
		match res.get("result", ""):
			"no-return":
				var w := ui.open("magicNone")
				await _message(w, screens.cstr(0x80e7b))
				ui.close()
			"warp":
				host.state.rt["return_spell"] = 1
			"done":
				var w := _status_window(-1)
				await ui.wait_click()
				ui.close()
			_:
				_buzz()
	else:
		var res: Dictionary = sys.cast_spell(host.state, caster, spell, {"mode": 2})
		if res.get("result", "") != "done":
			_buzz()
	if single and all:
		ui.close()
	host.render()


## f_817ec: the party-status window ($9C590): the HP / MP block, then the title over its first
## row (title_addr -1 = none); the panel is redrawn.
func _status_window(title_addr: int) -> Dictionary:
	var win := ui.open("magicNone")
	_status_lines(win, screens.cstr(title_addr) if title_addr >= 0 else PackedByteArray())
	return win


func _status_lines(win: Dictionary, title: PackedByteArray) -> void:
	ui.clear(win)
	ui.print_lines(win, screens.party_status_lines())
	if not title.is_empty():
		ui.print_at(win, 0, 0, title)
	host.render()


# --- ITEM (f_7ec7e) ------------------------------------------------------------------------------

func _item() -> void:
	var cmd_win := ui.open("itemCmd")
	var list_win := ui.open("itemList")
	var cmd_items := screens.item_command_row()
	# the inventory first appears through f_82e60 with the previous widget's geometry: no arrows
	var first: Array = screens.item_entries(3)[0]
	ui.list_draw(list_win, {"header": 0, "cols": 1, "width": ui.list_geometry(0, first, 1)["width"], "total_rows": 0},
		0, 8, first)
	var cmd := -1
	while true:
		var r: Dictionary = await ui.run_list(cmd_win, 1, cmd, 0, 3, 1, cmd_items)
		cmd = r["index"]
		if cmd < 0:
			break
		match cmd:
			0:
				await _item_use(list_win)
			1:
				await _item_sort(list_win)
			2:
				await _item_drop(list_win)
	ui.close()
	ui.close()


func _item_use(list_win: Dictionary) -> void:
	var top := 0
	while true:
		var e: Array = screens.item_entries(0)
		var r: Dictionary = await ui.run_list(list_win, 0, -1, top, 1, 8, e[0])
		top = r["top"]
		var k: int = r["index"]
		if k < 0:
			return
		var row: Dictionary = e[1][k]
		var code: int = row["code"]
		var entry: PackedByteArray = e[0][k]
		if entry[1] != 7 or not (code & 0xff):
			_buzz()
			continue
		if code in HP_ITEMS or code in MP_ITEMS:
			# f_8148c: the party-status window under ［体力回復］ / ［術力回復］, one member at a time
			# until cancelled or the slot is used up (then the window stays for a click)
			var slot: int = row["slot"]
			while true:
				var win := _status_window(0x80e6e if code in HP_ITEMS else 0x8147e)
				var t := await _charsel()
				if t < 0:
					ui.close()
					break
				var res: Dictionary = sys.use_item(host.state, slot, code, [t])
				if int(res.get("refused", 0)) > 0:
					_buzz()
				if host.state.le16(GameState.OFF_ITEMS + 4 * slot + 2) == 0:
					_status_lines(win, PackedByteArray())
					await ui.wait_click()
					ui.close()
					break
				ui.close()
		else:
			sys.use_item(host.state, int(row["slot"]), code, [])
			host.render()


func _item_sort(list_win: Dictionary) -> void:
	var top := 0
	while true:
		var e: Array = screens.item_entries(1)
		var r: Dictionary = await ui.run_list(list_win, 0, -1, top, 1, 8, e[0])
		top = r["top"]
		var a: int = r["index"]
		if a < 0:
			return
		if (e[0][a] as PackedByteArray)[1] != 7:
			_buzz()
			continue
		(e[0][a] as PackedByteArray)[1] = 6        # the first pick is shown in colour 6
		var r2: Dictionary = await ui.run_list(list_win, 0, a, top, 1, 8, e[0])
		top = r2["top"]
		var b: int = r2["index"]
		if b >= 0 and (e[0][b] as PackedByteArray)[1] != 1:
			sys.swap_slots(host.state, int(e[1][a]["slot"]), int(e[1][b]["slot"]))


func _item_drop(list_win: Dictionary) -> void:
	var top := 0
	while true:
		var e: Array = screens.item_entries(2)
		var r: Dictionary = await ui.run_list(list_win, 0, -1, top, 1, 8, e[0])
		top = r["top"]
		var k: int = r["index"]
		if k < 0:
			return
		var row: Dictionary = e[1][k]
		if (e[0][k] as PackedByteArray)[1] != 7 or not (int(row["code"]) & 0xff):
			_buzz()
			continue
		var dw := ui.open("discard")
		var what: int = await ui.menu(dw, 0, -1, screens.discard_menu())
		if what >= 0:
			var cw := ui.open("confirm")
			var yes: int = await ui.menu(cw, 0, -1, screens.confirm_menu())
			ui.close()
			if yes == 0:
				sys.drop_item(host.state, int(row["slot"]), what)
		ui.close()


# --- EQUIP (f_7f596) -----------------------------------------------------------------------------

func _equip() -> void:
	while true:
		var slot := await _charsel()
		if slot < 0:
			return
		var c: int = screens.member(slot)
		if c == 4 or c == 6 or c > 7:
			_buzz()
			continue
		var head := ui.open("equipHead")
		var row := -1
		while true:
			var h := screens.equip_header(slot)
			ui.clear(head)
			for k in (h["bonus"] as Array).size():
				ui.print_at(head, 25, 2 + k, h["bonus"][k])
			row = await ui.menu(head, 2, row, h["items"])
			if row < 0:
				break
			var lw := ui.open("equipList")
			var ee: Array = screens.equip_entries(c, row)
			var r: Dictionary = await ui.run_list(lw, 0, -1, 0, 1, 6, ee[0])
			var k: int = r["index"]
			if k >= 0 and k < (ee[1] as Array).size():
				var res: String = sys.equip(host.state, slot, row, int(ee[1][k]["index"]))
				if res != "equipped":
					_buzz()
				host.render()
			ui.close()
		ui.close()


# --- TALK (f_7c91c) ------------------------------------------------------------------------------

## CONSULT.SCN runs (entry $10) in place of the map's script; the money window stays open below.
func _talk() -> void:
	var consult := Programs.load_scn("CONSULT.SCN")
	if consult["code"].is_empty():
		return
	await host.events.run_entry(0x10, -1, consult)
	if host.events.picture_mode:
		host.events.close_picture()   # the field redraw after the command ends the picture


# --- STATUS (f_80390) ----------------------------------------------------------------------------

func _status() -> void:
	var menu_win := ui.open("statusMenu")
	var sel := -1
	while true:
		sel = await ui.menu(menu_win, 0, sel, screens.status_menu())
		if sel < 0:
			break
		if sel == 0:
			var slot := await _charsel()
			if slot < 0:
				continue
			var w := ui.open("personal")
			ui.print_lines(w, screens.personal_lines(slot))
			await ui.wait_click()
			ui.close()
		else:
			var w := ui.open("skills" if sel == 1 else "strength")
			ui.print_lines(w, screens.skill_lines() if sel == 1 else screens.strength_lines())
			await ui.wait_click()
			ui.close()
	ui.close()


# --- SYSTEM (f_7fa5c) ----------------------------------------------------------------------------

func _system() -> void:
	var sel := -1
	while true:
		# the SYSTEM window is closed while a sub-screen runs and reopened after (system trace)
		var win := ui.open("system")
		sel = await ui.menu(win, 0, sel, screens.system_menu())
		ui.close()
		if sel < 0:
			break
		match sel:
			0:
				await _speed()
			1:
				await _switches()
			2:
				await _bgm()
			3:
				if await save_menu(false):
					break


## f_829d0: the three speeds (message, movement, battle) on a 1..9 scale. Up/down choose the row,
## left/right (or confirm, or a click on the label) step it with wrap-around, a click on the scale
## sets it.
func _speed() -> void:
	var win := ui.open("speed")
	ui.menu_layout(win, 0, screens.speed_lines())
	var which := ["message", "move", "battle"]
	var draw := func(r: int) -> void:
		var v: int = host.state.be16(sys.SPEED[which[r]])
		win["w"] += 2
		ui.print_at(win, 13, 4 + r, screens.speed_marker(clampi(v, 0, 8)))
		win["w"] -= 2
	for r in 3:
		draw.call(r)
	var row := 0
	var frames := 0
	ui.reset_input()
	ui.set_box(win, 0, 4, 12)
	while true:
		await host.get_tree().process_frame
		frames += 1
		ui.blink(frames)
		var prev := row
		var step := 0
		if ui.pressed("ui_up"):
			row = posmod(row - 1, 3)
		elif ui.pressed("ui_down"):
			row = (row + 1) % 3
		elif ui.pressed("ui_left"):
			step = -1
		elif ui.pressed("ui_right"):
			step = 1
		var p := ui.pointer()
		var col := int((p.x - 64) / 8) - int(win["x"])
		var r := int((p.y - 48) / 16) - int(win["y"]) - 4
		var click := ui.clicked(MOUSE_BUTTON_LEFT)
		if ui.pressed("cancel") or ui.clicked(MOUSE_BUTTON_RIGHT):
			break
		if click and r >= 0 and r < 3:
			row = r
			if col >= 13:
				sys.set_speed(host.state, which[row], (col - 13) / 3)
				draw.call(row)
			else:
				step = 1
		elif ui.pressed("confirm") and not click:
			step = 1
		if step != 0:
			sys.step_speed(host.state, which[row], step)
			draw.call(row)
		if row != prev:
			frames = 0
			ui.set_box(win, 0, 4 + row, 12)
	ui.close()


## f_80516: the switches menu; choosing a line toggles it.
func _switches() -> void:
	var win := ui.open("switches")
	var keys := ["vr", "mouse", "auto_avoid", "talk"]
	var cursor := -1
	while true:
		var values: Array = []
		for k: String in keys:
			values.append(host.state.be16(sys.SWITCH[k]) != 0)
		ui.clear(win)
		cursor = await ui.menu(win, 2, cursor, screens.switch_items(values))
		if cursor < 0:
			break
		sys.toggle_switch(host.state, keys[cursor], true)
		host.render()
	ui.close()


## The BGM menu (sound test, table 15): up/down choose the track, confirm plays it, cancel ends;
## the field's music comes back afterwards.
func _bgm() -> void:
	var titles: Array = GameData.json("data/systems.json").get("music", [])
	if titles.size() < 2:
		return
	var win := ui.open("bgm")
	var track := 1
	var draw := func(t: int) -> void:   # (lambdas capture locals by value: pass the track)
		ui.clear(win)
		ui.print_bytes(win, screens.bgm_text(str(titles[t])))
		ui.print_at(win, 36, 0, PackedByteArray([0x81, 0xa3]))
		ui.print_at(win, 36, 5, PackedByteArray([0x81, 0xa5]))
	draw.call(track)
	var played := false
	ui.reset_input()
	while true:
		await host.get_tree().process_frame
		var d := 0
		var p := ui.pointer()
		var col := int((p.x - 64) / 8) - int(win["x"])
		var row := int((p.y - 48) / 16) - int(win["y"])
		var click := ui.clicked(MOUSE_BUTTON_LEFT)
		if ui.pressed("ui_up") or (click and col >= 35 and row == 0):
			d = -1
		elif ui.pressed("ui_down") or (click and col >= 35 and row == 5):
			d = 1
		elif ui.pressed("cancel") or ui.clicked(MOUSE_BUTTON_RIGHT):
			break
		elif ui.pressed("confirm") or click:
			host.play_music_index(track, false)
			played = true
		if d != 0:
			track = posmod(track - 1 + d, titles.size() - 1) + 1
			draw.call(track)
	ui.close()
	if played:
		host.restore_music()


# --- save / load (f_67468) -----------------------------------------------------------------------

## The save menu: Quick (the in-memory checkpoint), game disk 1, user disk. Returns true when a
## game was loaded (the host reloads the map when the command / script ends).
func save_menu(save: bool) -> bool:
	var win := ui.open("load")
	var loaded := false
	while true:
		var sel: int = await ui.menu(win, 2, -1, screens.load_menu(save))
		if sel < 0:
			break
		if sel == 0:
			if save:
				sys.checkpoint(host.state, host.party_actor_bytes())
			elif sys.restore_checkpoint(host.state):
				loaded = true
				break
			else:
				_buzz()
			continue
		var disk := sel - 1
		var slot := await _slot_list(save, disk)
		if slot < 0:
			continue
		var path := "%s/ISV%d.DAT" % [SAVE_DIRS[disk], slot]
		if save:
			DirAccess.make_dir_recursive_absolute(SAVE_DIRS[disk])
			var f := FileAccess.open(path, FileAccess.WRITE)
			if f == null:
				_buzz()
				continue
			f.store_buffer(sys.save_file(host.state, host.party_actor_bytes()))
			f.close()
		else:
			if not FileAccess.file_exists(path):
				_buzz()
				continue
			sys.load_file(host.state, FileAccess.get_file_as_bytes(path), {"user_disk": disk == 1})
			loaded = true
			break
	ui.close()
	if loaded:
		host.request_reload()
	return loaded


func _slot_list(save: bool, disk: int) -> int:
	var sums: Array = []
	for n in SLOTS:
		var path := "%s/ISV%d.DAT" % [SAVE_DIRS[disk], n]
		sums.append(sys.slot_summary(FileAccess.get_file_as_bytes(path)) if FileAccess.file_exists(path) else null)
	var win := ui.open("slots")
	var n: int = await ui.menu(win, 2, -1, screens.slot_items(save, sums))
	ui.close()
	return n


## The newest save file on either disk or the quick save ("Continue" on the title), or "".
static func latest_save() -> String:
	var best := ""
	var best_time := 0
	var paths := [QUICK_FILE]
	for d in SAVE_DIRS:
		for n in SLOTS:
			paths.append("%s/ISV%d.DAT" % [d, n])
	for path: String in paths:
		if FileAccess.file_exists(path) and FileAccess.get_modified_time(path) > best_time:
			best_time = FileAccess.get_modified_time(path)
			best = path
	return best


# --- shops and the inn (builtin 35, f_7bf14 / f_8393a / f_83b06) ---------------------------------

## mode 1: rest (fade out, full heal, fade in); mode >= 2: shop mode - 2.
func service(mode: int) -> void:
	if mode == 1:
		await host.fade(true)
		sys.rest(host.state)
		await host.fade(false)
		host.render()
		return
	var shops: Array = GameData.json("data/systems.json").get("shops", [])
	if mode - 2 < 0 or mode - 2 >= shops.size():
		return
	var shop: Dictionary = shops[mode - 2]
	var money := ui.open("money")
	ui.print_lines(money, [screens.money_line()], 2)
	var cat_win := ui.open("shopCat")
	var cats: Array = shop["categories"]
	var names: Array = []
	for c: Dictionary in cats:
		names.append(GameText.encode_sjis(str(c["name"])))
	var k := -1
	while true:
		var r: Dictionary = await ui.run_list(cat_win, 0, k, 0, 1, 6, names)
		k = r["index"]
		if k < 0:
			break
		if cats[k].get("sell", false):
			await _shop_sell(shop)
		else:
			await _shop_buy(shop, cats[k])
	ui.close_all()
	host.ui_boxes.clear()
	host.render()


func _shop_buy(shop: Dictionary, cat: Dictionary) -> void:
	var rows: Array = cat.get("rows", [])
	var entries: Array = []
	var codes: Array = []
	for row: Dictionary in rows:
		for code: int in row["codes"]:
			entries.append(screens.shop_entry(code, sys.item_price(code)))
			codes.append(code)
	var lw := ui.open("shopList")
	var hero_level: int = screens.cb(0, 3)
	var top: int = 8 * sys.shop_start_row(rows, hero_level)   # a table row = 8 list rows
	var cursor := -1
	while true:
		var r: Dictionary = await ui.run_list(lw, 0, cursor, top, 1, 8, entries, true)
		top = r["top"]
		var k: int = r["index"]
		if k < 0:
			break
		cursor = k
		var code: int = codes[k]
		if not (code & 0xff):
			continue
		var qw := ui.open("shopQty")
		var qi: int = await ui.menu(qw, 0, -1, screens.buy_quantities())
		if qi >= 0:
			var qty: int = sys.QUANTITIES[qi]
			var total: int = sys.shop_total(code, qi)
			var mw := ui.open("shopMsg")
			var offer := screens.shop_offer(code, qty, total)
			if qi == 3:
				offer.push_front(_shop_line(shop, 6))
			offer.append(_shop_line(shop, 4))
			ui.print_lines(mw, offer)
			var yes := await _confirm()
			var res: String = sys.shop_buy(host.state, code, qi, yes)
			if res != "cancel":
				ui.clear(mw)
				ui.print_lines(mw, [_shop_line(shop, {"bought": 2, "full": 3, "money": 1}[res])])
				await ui.wait_click()
			ui.close()
			_refresh_money()   # after the message window (it covers the money line)
		ui.close()
	ui.close()


func _shop_sell(shop: Dictionary) -> void:
	var lw := ui.open("shopList")
	var top := 0
	while true:
		var e: Array = screens.item_entries(2)
		var r: Dictionary = await ui.run_list(lw, 0, -1, top, 1, 8, e[0], true)
		top = r["top"]
		var k: int = r["index"]
		if k < 0:
			break
		var row: Dictionary = e[1][k]
		var code: int = row["code"]
		if (e[0][k] as PackedByteArray)[1] != 7 or not (code & 0xff):
			_buzz()
			continue
		var qw := ui.open("shopQty")
		var qi: int = await ui.menu(qw, 0, -1, screens.sell_quantities())
		if qi >= 0:
			var count: int = row["count"]
			var qty: int = mini(sys.QUANTITIES[qi], count)
			var total: int = sys.shop_total(code, qi, true, count)
			var mw := ui.open("shopMsg")
			if total == 0 or code == 0x201:
				ui.print_lines(mw, [_shop_line(shop, 7)])
				await ui.wait_click()
			else:
				var offer := screens.shop_offer(code, qty, total)
				offer.append(_shop_line(shop, 5))
				ui.print_lines(mw, offer)
				var yes := await _confirm()
				if sys.shop_sell(host.state, int(row["slot"]), qi, yes) == "sold":
					ui.clear(mw)
					ui.print_lines(mw, [_shop_line(shop, 2)])
					await ui.wait_click()
			ui.close()
			_refresh_money()
		ui.close()
	ui.close()


func _shop_line(shop: Dictionary, n: int) -> PackedByteArray:
	return GameText.encode_sjis(str(shop["strings"][n]))


## f_80e22: Yes / No (cancel = No).
func _confirm() -> bool:
	var cw := ui.open("confirm")
	var r: int = await ui.menu(cw, 0, -1, screens.confirm_menu())
	ui.close()
	return r == 0
