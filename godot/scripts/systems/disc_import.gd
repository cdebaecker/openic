extends RefCounted
## Builds the game data from the player's own disk images (OpenIC: the game ships without any of
## the original's assets). Finds the seven disks among the images of a folder, writes them as
## linear sector dumps under the names the exporters expect, then runs tools/openic/import.mjs
## with Node, which boots the game in the emulator and exports everything to user://gamedata.
##
## Node and the tools: <executable folder>/importer/ in a release (node.exe, tools/, src/, text/),
## else the repository the project sits in (development; `node` from PATH).

const DiskImage := preload("res://scripts/systems/disk_image.gd")
const IMAGE_EXT := ["dim", "xdf", "hdm", "d88"]
## A file only disk N (1-7) has
const SIGNATURE := ["ZMUSIC.X", "GROUP00/000028.DAT", "GROUP02/000000.DAT", "GROUP03/000000.DAT",
	"GROUP05/000025.DAT", "GROUP05/000014.DAT", "GROUP06/000089.DAT"]
const WORK := "user://import"
const OUT := "user://gamedata"

## Where start() writes the game data (tests point it elsewhere)
static var out_dir := OUT


static func disk_name(n: int) -> String:
	return "Genei Toshi (1991)(Microcabin)(Disk %d of 7).dim" % n


## Disk number (1-7) -> image path, for the images in `folder` that are disks of the game.
static func find_disks(folder: String) -> Dictionary:
	var found := {}
	var dir := DirAccess.open(folder)
	if dir == null:
		return found
	for f in dir.get_files():
		if not f.get_extension().to_lower() in IMAGE_EXT:
			continue
		var p := folder.path_join(f)
		var files := DiskImage.files(FileAccess.get_file_as_bytes(p))
		for k in SIGNATURE.size():
			if files.has(SIGNATURE[k]) and not found.has(k + 1):
				found[k + 1] = p
	return found


## Write the seven images (linear dumps) to the work folder. False if one cannot be read.
static func stage(disks: Dictionary) -> bool:
	DirAccess.make_dir_recursive_absolute(WORK)
	for n in range(1, 8):
		var data := DiskImage.linear(FileAccess.get_file_as_bytes(disks[n]))
		if data.is_empty():
			return false
		var f := FileAccess.open(WORK.path_join(disk_name(n)), FileAccess.WRITE)
		if f == null:
			return false
		f.store_buffer(data)
		f.close()
	return true


## Folder holding tools/openic/import.mjs: the release's importer/ folder, or the repository.
static func tools_dir() -> String:
	var bundled := OS.get_executable_path().get_base_dir().path_join("importer")
	if FileAccess.file_exists(bundled.path_join("tools/openic/import.mjs")):
		return bundled
	var repo := ProjectSettings.globalize_path("res://").path_join("..").simplify_path()
	if FileAccess.file_exists(repo.path_join("tools/openic/import.mjs")):
		return repo
	return ""


static func node_path() -> String:
	var dir := tools_dir()
	for n in ["node.exe", "node"]:
		if dir != "" and FileAccess.file_exists(dir.path_join(n)):
			return dir.path_join(n)
	# development: Node.js on PATH (process creation needs the full path)
	var exe := "node.exe" if OS.get_name() == "Windows" else "node"
	for p in OS.get_environment("PATH").split(";" if OS.get_name() == "Windows" else ":", false):
		if FileAccess.file_exists(p.path_join(exe)):
			return p.path_join(exe)
	return exe


## Translation tables: text/ next to the tools; in the private development layout ../work/text.
static func text_dir() -> String:
	var dir := tools_dir()
	for c in [dir.path_join("text"), dir.path_join("../work/text").simplify_path()]:
		if FileAccess.file_exists(c.path_join("messages.json")):
			return c
	return dir.path_join("text")


## Start the import; {stdio, stderr, pid} from OS.execute_with_pipe (empty on failure).
static func start() -> Dictionary:
	var dir := tools_dir()
	if dir == "":
		return {}
	var args := PackedStringArray([dir.path_join("tools/openic/import.mjs"),
		"--root", ProjectSettings.globalize_path(WORK),
		"--out", ProjectSettings.globalize_path(out_dir),
		"--text", text_dir()])
	# FM music as chip logs only when it can be synthesized (about 100 MB less game data)
	if ClassDB.class_exists("AudioStreamChipLog"):
		args.append("--live-music")
	return OS.execute_with_pipe(node_path(), args, false)


## The staged images and the exporters' scratch files.
static func clean_up() -> void:
	for n in range(1, 8):
		DirAccess.remove_absolute(ProjectSettings.globalize_path(WORK.path_join(disk_name(n))))
	DirAccess.remove_absolute(ProjectSettings.globalize_path(WORK))
