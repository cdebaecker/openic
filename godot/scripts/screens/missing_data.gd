extends Control
## Shown when no exported game data was found (see GameData for where it is looked up).
## Desktop: the importer - the player picks the folder with their own seven disk images and the
## game data is built from them (DiscImport, tools/openic/import.mjs). Web: pick gamedata.zip.

signal finished(next: String, args: Dictionary)

const DiscImport := preload("res://scripts/systems/disc_import.gd")

# Web: the browser picks gamedata.zip; JavaScript reads it in chunks and hands them over as base64
const PICK_JS := """(function(){var i=document.createElement('input');i.type='file';i.accept='.zip';
i.onchange=async function(){var f=i.files[0];if(!f){return;}var S=4<<20;
for(var o=0;o<f.size;o+=S){var b=new Uint8Array(await f.slice(o,o+S).arrayBuffer());var s='';
for(var k=0;k<b.length;k+=32768){s+=String.fromCharCode.apply(null,b.subarray(k,k+32768));}
window.icGodotChunk(btoa(s),o+b.length,f.size);}window.icGodotDone();};i.click();})()"""

var _label: Label
var _file: FileAccess
var _cb_chunk: JavaScriptObject
var _cb_done: JavaScriptObject
var _disks := {}
var _mt32_roms := ""        # folder with MT-32 / CM-32L ROMs next to the disks, if any
var _state := "intro"       # intro, choosing, ready, running, failed
var _pipe := {}
var _thread: Thread
var _done := false
var _last_error := ""


func _ready() -> void:
	set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	var bg := ColorRect.new()
	bg.color = Color(0.03, 0.03, 0.05)
	bg.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	add_child(bg)
	var l := Label.new()
	_label = l
	l.position = Vector2(64, 128)
	l.size = Vector2(640, 280)
	l.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	add_child(l)
	_intro()
	if OS.has_feature("web"):
		l.text = ("Game data not found.\n\nBuild gamedata.zip from the original disk images with\n"
			+ "    node tools/export/build.mjs --zip\n\nthen press Enter (or click) to choose it. "
			+ "It is kept in this browser's storage for the next visits.")


func _intro() -> void:
	_state = "intro"
	_label.text = GameText.pick(
		"OpenIC needs your own copy of Illusion City.\n\nThe port contains none of the original's "
		+ "pictures, music or text: it builds them from the seven floppy disk images of the X68000 "
		+ "game (DIM, XDF, HDM or D88), once, on this computer.\n\nPress Enter (or click) to choose "
		+ "the folder with your disk images.",
		"幻影都市のゲームデータがありません。\n\nこの移植版には元のゲームの画像・音楽・テキストは含まれていません。"
		+ "お手持ちのX68000版の７枚のディスクイメージ（DIM、XDF、HDM、D88）から、このパソコンで一度だけ作成します。"
		+ "\n\nEnter（またはクリック）でディスクイメージのフォルダを選んでください。",
		"OpenIC a besoin de votre propre exemplaire d'Illusion City.\n\nCe portage ne contient aucune "
		+ "image, musique ou texte de l'original : il les construit, une seule fois et sur cet ordinateur, "
		+ "à partir des sept images de disquettes du jeu X68000 (DIM, XDF, HDM ou D88).\n\nAppuyez sur "
		+ "Entrée (ou cliquez) pour choisir le dossier de vos images disque.")


func _unhandled_input(event: InputEvent) -> void:
	var click: bool = event is InputEventMouseButton and event.pressed and event.button_index == MOUSE_BUTTON_LEFT
	if not (event.is_action_pressed("confirm") or click):
		return
	get_viewport().set_input_as_handled()
	if OS.has_feature("web"):
		if _file == null:
			_pick_web()
		return
	match _state:
		"intro", "failed":
			if GameData.locate():
				finished.emit("title", {})
				return
			_choose_folder()
		"ready":
			_run()


func _choose_folder() -> void:
	_state = "choosing"
	var dlg := FileDialog.new()
	dlg.file_mode = FileDialog.FILE_MODE_OPEN_DIR
	dlg.access = FileDialog.ACCESS_FILESYSTEM
	dlg.use_native_dialog = true
	dlg.title = GameText.pick("Folder with the disk images", "ディスクイメージのフォルダ", "Dossier des images disque")
	dlg.dir_selected.connect(_on_folder)
	dlg.canceled.connect(_intro)
	add_child(dlg)
	dlg.popup_centered(Vector2i(640, 400))


func _on_folder(folder: String) -> void:
	_disks = DiscImport.find_disks(folder)
	var lines := PackedStringArray()
	for n in range(1, 8):
		var mark: String = _disks[n].get_file() if _disks.has(n) else GameText.pick("missing", "なし", "manquant")
		lines.append(GameText.pick("Disk %d: %s", "ディスク%d：%s", "Disque %d : %s") % [n, mark])
	if _disks.size() == 7:
		_state = "ready"
		# the MT-32 music too, from the player's own ROMs put with the disks
		_mt32_roms = DiscImport.find_mt32_roms(folder)
		if _mt32_roms != "":
			lines.append(GameText.pick("MT-32 ROMs: found (the MT-32 music will be built too)",
				"MT-32 ROM：あり（MT-32版の音楽も作成します）",
				"ROM MT-32 : trouvées (la musique MT-32 sera aussi construite)"))
		_label.text = "\n".join(lines) + "\n\n" + GameText.pick(
			"All seven disks found. Press Enter to build the game data (about 2 minutes).",
			"７枚とも見つかりました。Enterでゲームデータを作成します（２分ほど）。",
			"Les sept disques sont là. Appuyez sur Entrée pour construire les données du jeu (environ 2 minutes).")
	else:
		_state = "failed"
		_label.text = "\n".join(lines) + "\n\n" + GameText.pick(
			"Some disks are missing from that folder. Press Enter to choose another one.",
			"このフォルダにはないディスクがあります。Enterで別のフォルダを選んでください。",
			"Il manque des disques dans ce dossier. Appuyez sur Entrée pour en choisir un autre.")


func _run() -> void:
	_label.text = GameText.pick("Reading the disks...", "ディスクを読み込んでいます…", "Lecture des disques...")
	if not DiscImport.stage(_disks):
		_fail(GameText.pick("A disk image could not be read.", "ディスクイメージを読めませんでした。", "Une image disque est illisible."))
		return
	_pipe = DiscImport.start(_mt32_roms)
	if _pipe.is_empty():
		_fail(GameText.pick("The importer (Node.js and tools/openic) was not found.",
			"インポーター（Node.jsとtools/openic）が見つかりません。",
			"L'importateur (Node.js et tools/openic) est introuvable."))
		return
	_state = "running"
	_done = false
	_last_error = ""
	_thread = Thread.new()
	_thread.start(_read.bind(_pipe["stdio"], int(_pipe["pid"])))


## Importer output, line by line, until the process ends (thread; the pipe does not block)
func _read(pipe: FileAccess, pid: int) -> void:
	while true:
		var line := pipe.get_line()
		if not line.is_empty():
			_on_line.call_deferred(line)
			continue
		if not OS.is_process_running(pid):
			break
		OS.delay_msec(200)
	_on_exit.call_deferred()


func _on_line(line: String) -> void:
	if line.begins_with("step "):
		var parts := line.split(" ", false, 2)
		_label.text = GameText.pick("Building the game data from your disks: step %s (%s)...",
			"ディスクからゲームデータを作成中：%s（%s）…",
			"Construction des données du jeu à partir de vos disques : étape %s (%s)...") % [
			parts[1], parts[2] if parts.size() > 2 else ""]
	elif line == "done":
		_done = true
	elif line.begins_with("error "):
		_last_error = line.trim_prefix("error ")


func _on_exit() -> void:
	if _thread:
		_thread.wait_to_finish()
		_thread = null
	DiscImport.clean_up()
	if _done and GameData.locate():
		finished.emit("title", {})
		return
	_fail(_last_error if _last_error != "" else GameText.pick("The importer stopped.",
		"インポーターが停止しました。", "L'importateur s'est arrêté."))


func _fail(message: String) -> void:
	_state = "failed"
	_label.text = GameText.pick("The game data could not be built:\n%s\n\nPress Enter to try again.",
		"ゲームデータを作成できませんでした：\n%s\n\nEnterでやり直します。",
		"Impossible de construire les données du jeu :\n%s\n\nAppuyez sur Entrée pour réessayer.") % message


func _exit_tree() -> void:
	if _thread and _thread.is_started():
		_thread.wait_to_finish()


## Web: a file picker; the chosen zip is written to user://gamedata.zip (IndexedDB), then mounted.
func _pick_web() -> void:
	_file = FileAccess.open("user://gamedata.zip", FileAccess.WRITE)
	_cb_chunk = JavaScriptBridge.create_callback(_on_chunk)
	_cb_done = JavaScriptBridge.create_callback(_on_done)
	var window := JavaScriptBridge.get_interface("window")
	window.icGodotChunk = _cb_chunk
	window.icGodotDone = _cb_done
	JavaScriptBridge.eval(PICK_JS, true)


func _on_chunk(args: Array) -> void:
	_file.store_buffer(Marshalls.base64_to_raw(str(args[0])))
	_label.text = "Reading gamedata.zip: %d / %d MB" % [int(args[1]) >> 20, int(args[2]) >> 20]


func _on_done(_args: Array) -> void:
	_file.close()
	_file = null
	if GameData.locate():
		finished.emit("title", {})
	else:
		_label.text = "That zip does not contain the game data (gamedata/manifest.json). Press Enter to try again."
