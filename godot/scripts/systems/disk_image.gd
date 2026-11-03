extends RefCounted
## X68000 floppy images (Human68k FAT12, the reader of src/fs.js): raw XDF / HDM (1 261 568
## bytes), DIM (a 256-byte header, then the same) and D88 (a track table and sector headers).
## Used to import the saves of the original (ISV0-7.DAT) from the player's own disks.
##
##   var files: Dictionary = DiskImage.files(bytes)   # "DIR/NAME.EXT" -> PackedByteArray ({} if not a disk)

const RAW_SIZE := 1261568
const DIM_HEADER := 256
const D88_HEADER := 0x2b0


static func files(image: PackedByteArray) -> Dictionary:
	var data := linear(image)
	if data.is_empty():
		return {}
	return _parse(data)


## The image as a linear sector dump (empty if the format is not recognised).
static func linear(image: PackedByteArray) -> PackedByteArray:
	if image.size() == RAW_SIZE:
		return image
	if image.size() == RAW_SIZE + DIM_HEADER:
		return image.slice(DIM_HEADER)
	if image.size() > D88_HEADER and image.decode_u32(0x1c) == image.size():
		return _d88(image)
	return PackedByteArray()


## D88: 164 track offsets at $20; each sector = 16-byte header (C, H, R, N, count, ..., size at
## +14) + data. Tracks in table order, sectors by R.
static func _d88(image: PackedByteArray) -> PackedByteArray:
	var out := PackedByteArray()
	for t in 164:
		var off := image.decode_u32(0x20 + 4 * t)
		if off == 0 or off >= image.size():
			continue
		var count := image.decode_u16(off + 4)
		var sectors := []
		var p := off
		for k in count:
			if p + 16 > image.size():
				break
			var size := image.decode_u16(p + 14)
			sectors.append([image[p + 2], image.slice(p + 16, p + 16 + size)])
			p += 16 + size
		sectors.sort_custom(func(a: Array, b: Array) -> bool: return a[0] < b[0])
		for s: Array in sectors:
			out.append_array(s[1])
	return out


static func _parse(data: PackedByteArray) -> Dictionary:
	if data.size() < 512:
		return {}
	var fs := {
		"data": data,
		"bps": data.decode_u16(0x0b),
		"spc": data[0x0d],
	}
	var reserved := data.decode_u16(0x0e)
	var nfats: int = data[0x10]
	var rootents := data.decode_u16(0x11)
	var spf := data.decode_u16(0x16)
	if fs["bps"] not in [256, 512, 1024] or fs["spc"] == 0 or nfats == 0 or spf == 0:
		return {}
	var fat_off: int = reserved * fs["bps"]
	var root_off: int = fat_off + nfats * spf * fs["bps"]
	fs["fat"] = data.slice(fat_off, fat_off + spf * fs["bps"])
	fs["data_off"] = ceili((root_off + rootents * 32) / float(fs["bps"])) * fs["bps"]
	var out := {}
	_walk(fs, data.slice(root_off, root_off + rootents * 32), "", out, 0)
	return out


static func _next(fat: PackedByteArray, c: int) -> int:
	var o := (c * 3) >> 1
	if o + 1 >= fat.size():
		return 0xfff
	var v: int = fat[o] | (fat[o + 1] << 8)
	return v >> 4 if c & 1 else v & 0xfff


static func _chain(fs: Dictionary, c: int, size: int) -> PackedByteArray:
	var csize: int = fs["bps"] * fs["spc"]
	var data: PackedByteArray = fs["data"]
	var out := PackedByteArray()
	var guard := 0
	while c >= 2 and c < 0xff0 and guard < 4096:
		var o: int = fs["data_off"] + (c - 2) * csize
		if o >= data.size():
			break
		out.append_array(data.slice(o, o + csize))
		c = _next(fs["fat"], c)
		guard += 1
	if size >= 0 and out.size() > size:
		out.resize(size)
	return out


static func _latin(bytes: PackedByteArray) -> String:
	var s := ""
	for b in bytes:
		if b == 0:
			break
		s += char(b)
	return s.strip_edges(false, true)


static func _walk(fs: Dictionary, dir: PackedByteArray, prefix: String, out: Dictionary, depth: int) -> void:
	for i in range(0, dir.size() - 31, 32):
		var first: int = dir[i]
		if first == 0:
			break
		var attr: int = dir[i + 11]
		if first == 0xe5 or attr & 0x08:
			continue
		var base := _latin(dir.slice(i, i + 8))
		var ext2 := _latin(dir.slice(i + 12, i + 22))   # Human68k: bytes 12-21 extend the name
		if base.length() == 8 and ext2 != "":
			base += ext2
		var ext := _latin(dir.slice(i + 8, i + 11))
		var name := (base + "." + ext if ext != "" else base).to_upper()
		if name == "." or name == "..":
			continue
		var clus := dir.decode_u16(i + 26)
		if attr & 0x10:
			if depth < 8:
				_walk(fs, _chain(fs, clus, -1), prefix + name + "/", out, depth + 1)
		else:
			out[prefix + name] = _chain(fs, clus, dir.decode_u32(i + 28))
