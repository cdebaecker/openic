extends RefCounted
## Import the saves of the original into the port's save folders (UiCommands.SAVE_DIRS): the
## ISV0-7.DAT files (954-byte state blocks, docs/systems.md §9) of a floppy image (DiskImage) or a
## loose ISVn.DAT. Game disk 1 (it holds ICITY68.X) goes to the game-disk folder, any other disk to
## the user-disk folder; a file it replaces is kept as ISVn.DAT.bak.
##
##   var r: Dictionary = SaveImport.import_file(path)   # {ok, disk, slots: [n...], message}

const DiskImage := preload("res://scripts/systems/disk_image.gd")
const UiCommands := preload("res://scripts/systems/ui_commands.gd")
const BLOCK := 954


static func import_file(path: String) -> Dictionary:
	var bytes := FileAccess.get_file_as_bytes(path)
	if bytes.is_empty():
		return {"ok": false, "message": GameText.pick("Cannot read %s", "%s を読めません", "Impossible de lire %s") % path.get_file()}
	return import_bytes(path.get_file(), bytes)


static func import_bytes(file_name: String, bytes: PackedByteArray) -> Dictionary:
	var saves := {}   # slot -> block
	var disk := 1
	var upper := file_name.to_upper()
	if bytes.size() == BLOCK and upper.begins_with("ISV") and upper.ends_with(".DAT"):
		var n := upper.trim_prefix("ISV").trim_suffix(".DAT")
		if n.length() == 1 and n.is_valid_int():
			saves[n.to_int()] = bytes
	else:
		var files := DiskImage.files(bytes)
		if files.is_empty():
			return {"ok": false, "message": GameText.pick("%s is not an X68000 disk image (XDF, HDM, DIM, D88)",
				"%s はX68000のディスクイメージではありません（XDF、HDM、DIM、D88）",
				"%s n'est pas une image disque X68000 (XDF, HDM, DIM, D88)") % file_name}
		if files.has("ICITY68.X"):
			disk = 0
		for n in 8:
			var b: Variant = files.get("ISV%d.DAT" % n)
			if b is PackedByteArray and b.size() == BLOCK and valid(b):
				saves[n] = b
	if saves.is_empty():
		return {"ok": false, "message": GameText.pick("No Illusion City saves (ISV0-7.DAT) in %s",
			"%s に幻影都市のセーブ（ISV0-7.DAT）がありません",
			"Aucune sauvegarde d'Illusion City (ISV0-7.DAT) dans %s") % file_name}
	var dir: String = UiCommands.SAVE_DIRS[disk]
	DirAccess.make_dir_recursive_absolute(dir)
	var slots := []
	for n: int in saves:
		var target := "%s/ISV%d.DAT" % [dir, n]
		if FileAccess.file_exists(target):
			var old := FileAccess.get_file_as_bytes(target)
			if old == saves[n]:
				continue
			DirAccess.copy_absolute(target, target + ".bak")
		var f := FileAccess.open(target, FileAccess.WRITE)
		if f == null:
			continue
		f.store_buffer(saves[n])
		f.close()
		slots.append(n)
	slots.sort()
	var where := (GameText.pick("game disk", "ゲームディスク", "disque de jeu") if disk == 0
		else GameText.pick("user disk", "ユーザーディスク", "disque utilisateur"))
	if slots.is_empty():
		return {"ok": true, "disk": disk, "slots": slots, "message": GameText.pick("The saves are already there (%s).",
			"セーブはすでにあります（%s）。", "Les sauvegardes sont déjà là (%s).") % where}
	return {"ok": true, "disk": disk, "slots": slots,
		"message": GameText.pick("Imported %d save(s) to the %s: slot %s.",
			"%d個のセーブを%sに読み込みました：スロット %s。",
			"%d sauvegarde(s) importée(s) sur le %s : emplacement %s.") % [slots.size(), where,
			", ".join(slots.map(func(n: int) -> String: return str(n)))]}


## A state block: the map id at +$124 is three letters / digits (A00, J90 ...).
static func valid(b: PackedByteArray) -> bool:
	for k in 3:
		var c: int = b[0x124 + k]
		if not ((c >= 0x30 and c <= 0x39) or (c >= 0x41 and c <= 0x5a)):
			return false
	return true
