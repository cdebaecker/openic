extends RefCounted
## Loads 16-bit PCM .wav files at run time (the exported music is not imported by the editor).


static func load_file(file: String, loop_start := -1.0, loop_end := 0.0) -> AudioStreamWAV:
	var b := FileAccess.get_file_as_bytes(file)
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
	if loop_start >= 0.0:
		var frames := data.size() / (2 * channels)
		s.loop_mode = AudioStreamWAV.LOOP_FORWARD
		s.loop_begin = clampi(int(loop_start * rate), 0, frames - 1)
		s.loop_end = frames if loop_end <= 0.0 else clampi(int(loop_end * rate), s.loop_begin + 1, frames)
	return s
