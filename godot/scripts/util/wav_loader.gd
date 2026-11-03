extends RefCounted
## Loads 16-bit PCM .wav and QOA (.qoa, tools/export/qoa.mjs) files at run time (the exported
## audio is not imported by the editor).


static func load_file(file: String, loop_start := -1.0, loop_end := 0.0) -> AudioStreamWAV:
	var b := FileAccess.get_file_as_bytes(file)
	if b.size() >= 16 and b.slice(0, 4).get_string_from_ascii() == "qoaf":
		return _qoa(b, loop_start, loop_end)
	if b.size() < 44 or b.slice(0, 4).get_string_from_ascii() != "RIFF":
		return null
	if b.slice(8, 12).get_string_from_ascii() != "WAVE":
		return null
	var channels := 0
	var rate := 0
	var bits := 0
	var data := PackedByteArray()
	var pos := 12
	while pos + 8 <= b.size():
		var id := b.slice(pos, pos + 4).get_string_from_ascii()
		var size := b.decode_u32(pos + 4)
		var body := pos + 8
		if id == "fmt ":
			if b.decode_u16(body) != 1:
				return null  # only uncompressed PCM
			channels = b.decode_u16(body + 2)
			rate = b.decode_u32(body + 4)
			bits = b.decode_u16(body + 14)
		elif id == "data":
			data = b.slice(body, mini(body + size, b.size()))
		pos = body + size + (size & 1)
	if bits != 16 or channels < 1 or channels > 2 or data.is_empty():
		return null
	var s := AudioStreamWAV.new()
	s.format = AudioStreamWAV.FORMAT_16_BITS
	s.stereo = channels == 2
	s.mix_rate = rate
	s.data = data
	_set_loop(s, data.size() / (2 * channels), rate, loop_start, loop_end)
	return s


## QOA: the whole file is the stream's data; samples per channel in the file header, channels
## and rate in the first frame's (big endian).
static func _qoa(b: PackedByteArray, loop_start: float, loop_end: float) -> AudioStreamWAV:
	var frames := b[4] << 24 | b[5] << 16 | b[6] << 8 | b[7]
	var channels := b[8]
	var rate := b[9] << 16 | b[10] << 8 | b[11]
	if frames == 0 or channels < 1 or channels > 2 or rate == 0:
		return null
	var s := AudioStreamWAV.new()
	s.format = AudioStreamWAV.FORMAT_QOA
	s.stereo = channels == 2
	s.mix_rate = rate
	s.data = b
	_set_loop(s, frames, rate, loop_start, loop_end)
	return s


static func _set_loop(s: AudioStreamWAV, frames: int, rate: int, loop_start: float, loop_end: float) -> void:
	if loop_start >= 0.0:
		s.loop_mode = AudioStreamWAV.LOOP_FORWARD
		s.loop_begin = clampi(int(loop_start * rate), 0, frames - 1)
		s.loop_end = frames if loop_end <= 0.0 else clampi(int(loop_end * rate), s.loop_begin + 1, frames)
