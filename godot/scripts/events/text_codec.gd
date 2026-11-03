extends RefCounted
## Message text helpers, as src/text/codec.js (the web build's translation patcher): message ids,
## page splitting, English table text -> game bytes, word wrapping, Shift-JIS -> Unicode.

## Replacements for ASCII the message engine reserves as commands: '!' uses the spare half-width
## slot $A0 (drawn as '!'), the rest their full-width forms.
const RESERVED := {
	"!": [0xa0], "#": [0x81, 0x94], "$": [0x81, 0x90], "%": [0x81, 0x93], "&": [0x81, 0x95],
	"*": [0x81, 0x96], ":": [0x81, 0x46],
}
const TYPOGRAPHIC := {"‘": "'", "’": "'", "“": "\"", "”": "\"", "…": "...", "–": "-", "—": "-",
	"œ": "oe", "Œ": "OE", " ": " ", " ": " "}
## French letters: drawn from the half-width katakana slots $A1.. (GameText.char_for), which no
## translated text needs; one column wide like ASCII.
const LATIN := "àâäçéèêëîïôöùûüÿÀÂÄÇÉÈÊËÎÏÔÖÙÛÜ«»°"


static func is_lead(c: int) -> bool:
	return (c >= 0x81 and c <= 0x9f) or (c >= 0xe0 and c <= 0xfc)


## FNV-1a hash of the bytes -> 8 hex digits (the translation table's message id).
static func message_id(bytes: PackedByteArray) -> String:
	var h := 0x811c9dc5
	for b in bytes:
		h = ((h ^ b) * 0x01000193) & 0xffffffff
	return "%08x" % h


## Length of the command prefix before the first Shift-JIS character.
static func prefix_length(bytes: PackedByteArray) -> int:
	var i := 0
	while i < bytes.size() and not is_lead(bytes[i]):
		i += 1
	return i


## Length of the first page: up to the first ':' (page break) or the whole message.
static func page_length(bytes: PackedByteArray) -> int:
	var i := 0
	while i < bytes.size():
		if bytes[i] == 0x3a:
			return i
		if is_lead(bytes[i]):
			i += 1
		i += 1
	return bytes.size()


## Message bytes from `at` up to the terminator ($00 or '!').
static func message_at(code: PackedByteArray, at: int) -> PackedByteArray:
	var out := PackedByteArray()
	var i := at
	while i < code.size():
		var c := code[i]
		if c == 0 or c == 0x21:
			break
		out.append(c)
		if is_lead(c) and i + 1 < code.size():
			out.append(code[i + 1])
			i += 1
		i += 1
	return out


## Table text (English) -> game bytes: {xx} tokens pass through, ASCII is half-width,
## reserved punctuation becomes full-width, other characters are dropped.
static func from_text(text: String) -> PackedByteArray:
	var out := PackedByteArray()
	var i := 0
	while i < text.length():
		var ch := text[i]
		if ch == "{" and i + 3 < text.length() and text[i + 3] == "}" and text.substr(i + 1, 2).is_valid_hex_number():
			out.append(text.substr(i + 1, 2).hex_to_int())
			i += 4
			continue
		if ch == "\n":
			out.append(0x0a)
		elif RESERVED.has(ch):
			out.append_array(PackedByteArray(RESERVED[ch]))
		elif ch.unicode_at(0) >= 0x20 and ch.unicode_at(0) < 0x7f:
			out.append(ch.unicode_at(0))
		elif LATIN.contains(ch):
			out.append(0xa1 + LATIN.find(ch))
		elif TYPOGRAPHIC.has(ch):
			out.append_array(from_text(TYPOGRAPHIC[ch]))
		i += 1
	return out


## Wrap text to `width` columns at spaces, keeping {xx} tokens and explicit line breaks
## ({0a} or a new line, both become {0a}).
static func wrap(text: String, width: int) -> String:
	var tokens := RegEx.create_from_string("\\{[0-9a-fA-F]{2}\\}")
	var out := PackedStringArray()
	for para in text.replace("{0A}", "{0a}").replace("{0a}", "\n").split("\n"):
		var lines := PackedStringArray()
		var cur := ""
		for w in para.split(" "):
			var cand := w if cur.is_empty() else cur + " " + w
			if tokens.sub(cand, "", true).length() > width and not cur.is_empty():
				lines.append(cur)
				cur = w
			else:
				cur = cand
		lines.append(cur)
		out.append("{0a}".join(lines))
	return "{0a}".join(out)
