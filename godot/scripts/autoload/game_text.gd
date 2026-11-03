extends Node
## Translation: the dialogue/narration table (text/messages.json, rows keyed by id) and the
## glossary of names (text/glossary.json). language "en" uses the English column where it is
## filled and falls back to the Japanese; "ja" always shows the original. "fr" uses the French
## tables (text/messages_fr.json: id -> text, text/glossary_fr.json: names / rules / templates,
## Japanese -> French) and falls back to the English, then the Japanese.

const TextCodec := preload("res://scripts/events/text_codec.gd")
const LANGUAGES := ["en", "fr", "ja"]
const LANGUAGE_NAMES := {"en": "English", "fr": "Français", "ja": "日本語"}

var language := "en":
	set(v):
		language = v if v in LANGUAGES else "en"
		if _loaded:
			_compile_glossary()
## 16-dot font for game text (fonts/README.md), pixel-exact at sizes 16 (full-width 16x16,
## half-width 8x16).
var font := _load_font("res://fonts/unifont_jp-15.1.05.otf")

var _messages := {}
var _french := {}               # message id -> French
var _glossary := {}
var _glossary_fr := {}
var _names := {}
var _sjis := {}
var _sjis_rev := {}
var _templates := {}           # system / battle message templates (glossary "templates")
var _rules: Array = []          # interface rules [[ja bytes, en bytes]], longest first
var _loaded := false


func _ready() -> void:
	# The default UI font has no Japanese glyphs; desktop systems supply them, browsers do not:
	# the bundled game font (Unifont, CJK) is its fallback everywhere.
	var f: Font = ThemeDB.fallback_font
	if f != null and font != null and not f.fallbacks.has(font):
		var fb := f.fallbacks.duplicate()
		fb.append(font)
		f.fallbacks = fb
	# Every screen's text (title, options, notices...) in the game's font at its pixel-exact size, so
	# the port's own English looks like the game's text
	# (Godot's default theme names its own font, Open Sans, so it is set there and as the fallback)
	if font != null:
		for t: Theme in [ThemeDB.get_default_theme(), ThemeDB.get_project_theme()]:
			if t != null:
				t.default_font = font
				t.default_font_size = 16
		ThemeDB.fallback_font = font
		ThemeDB.fallback_font_size = 16


func _ensure_loaded() -> void:
	if _loaded or not GameData.available():
		return
	_loaded = true
	var table: Variant = GameData.json("text/messages.json") if GameData.exists("text/messages.json") else null
	if table is Dictionary:
		for row in table.get("messages", []):
			_messages[row["id"]] = row
	var sjis: Variant = GameData.json("text/sjis.json") if GameData.exists("text/sjis.json") else null
	if sjis is Dictionary:
		for k in sjis:
			_sjis[k.hex_to_int()] = sjis[k]
	var glossary: Variant = GameData.json("text/glossary.json") if GameData.exists("text/glossary.json") else null
	if glossary is Dictionary:
		_glossary = glossary
	var fr: Variant = GameData.json("text/messages_fr.json") if GameData.exists("text/messages_fr.json") else null
	if fr is Dictionary:
		_french = fr.get("messages", {})
	var gfr: Variant = GameData.json("text/glossary_fr.json") if GameData.exists("text/glossary_fr.json") else null
	if gfr is Dictionary:
		_glossary_fr = gfr
	_compile_glossary()


## Names, interface rules and templates in the selected language.
func _compile_glossary() -> void:
	_names.clear()
	_templates.clear()
	if language == "ja":
		_rules.clear()
		return
	var fr := language == "fr"
	var entries := {}
	for kind in ["names", "rules", "templates"]:
		var tr: Dictionary = _glossary_fr.get(kind, {}) if fr else {}
		var list: Array = []
		for e: Dictionary in _glossary.get(kind, []):
			list.append({"ja": e["ja"], "en": tr.get(e["ja"], e["en"])})
		entries[kind] = list
	for e: Dictionary in entries["names"]:
		_names[str(e["ja"]).strip_edges().replace("　", "")] = e["en"]   # keys as name_of looks them up
	_compile_rules(entries["rules"] + entries["names"])
	for e: Dictionary in entries["templates"]:
		_templates[e["ja"]] = e["en"]


## True when a language other than Japanese is selected.
func translated() -> bool:
	return language != "ja"


## The port's own text in the selected language (French falls back to the English).
func pick(en: String, ja: String, fr := "") -> String:
	match language:
		"ja":
			return ja
		"fr":
			return fr if fr != "" else en
	return en


## pick() for a [English, Japanese, French] list (French optional).
func pick_list(l: Array) -> String:
	return pick(str(l[0]), str(l[1]), str(l[2]) if l.size() > 2 else "")


## The next language (title menu / options toggle).
func next_language() -> String:
	return LANGUAGES[(LANGUAGES.find(language) + 1) % LANGUAGES.size()]


func has_translation(id: String) -> bool:
	return translation_for(id) != ""


## Translation of a message id in the selected language ("" when there is none or Japanese is
## selected); French rows not translated yet use the English.
func translation_for(id: String) -> String:
	_ensure_loaded()
	if language == "ja":
		return ""
	if language == "fr" and str(_french.get(id, "")) != "":
		return str(_french[id])
	return str(_messages.get(id, {}).get("english", ""))


## Character for a glyph code of the message engine: half-width byte or Shift-JIS pair.
func char_for(code: int) -> String:
	_ensure_loaded()
	if code == 0xa0:
		return "!"   # the translation's '!' (the engine reserves the ASCII one)
	if language == "fr" and code > 0xa0 and code <= 0xa0 + TextCodec.LATIN.length():
		return TextCodec.LATIN[code - 0xa1]   # accented letters in the half-width kana slots
	if code < 0x80:
		return char(code) if code >= 0x20 else " "
	return _sjis.get(code, "?")


## Text of a message row: English when available and selected, else Japanese.
func message(id: String) -> String:
	_ensure_loaded()
	var row: Dictionary = _messages.get(id, {})
	if has_translation(id):
		return translation_for(id)
	return row.get("japanese", "")


## A character/place/item name in the selected language (names are padded with full-width
## spaces in the original; the padding is dropped).
func name_of(japanese: String) -> String:
	_ensure_loaded()
	var key := japanese.strip_edges().replace("　", "")
	if translated() and _names.has(key):
		return _names[key]
	if translated():
		# no entry (e.g. the firearms' names, "ＵＺＩ"): full-width ASCII as ASCII, so that the English
		# text, which drops other non-ASCII characters, still shows the name
		var half := ""
		for ch in key:
			var u := ch.unicode_at(0)
			half += char(u - 0xfee0) if u >= 0xff01 and u <= 0xff5e else ch
		return half
	return key


## English of a system / battle message template ("$1を手に入れた。" -> "Got $1."), or "" when
## there is none or Japanese is selected.
func template(japanese: String) -> String:
	_ensure_loaded()
	return str(_templates.get(japanese, "")) if translated() else ""


## Text of Shift-JIS bytes (half-width bytes and double-byte codes).
func decode(bytes: PackedByteArray) -> String:
	var out := ""
	var i := 0
	while i < bytes.size() and bytes[i] != 0:
		if _is_lead(bytes[i]) and i + 1 < bytes.size():
			out += char_for((bytes[i] << 8) | bytes[i + 1])
			i += 2
		else:
			out += "\n" if bytes[i] == 0x0a else char_for(bytes[i])
			i += 1
	return out


## Interface text in the selected language: the glossary rules applied to the Shift-JIS bytes of a
## string printed by the UI printer, as the web build's patcher does (src/text/codec.js
## applyRules): each term is replaced in place, padded to its width; full-width ASCII becomes
## half-width; the string keeps its byte length (= screen columns).
func interface_bytes(bytes: PackedByteArray) -> PackedByteArray:
	_ensure_loaded()
	if not translated() or _rules.is_empty():
		return bytes
	var out := PackedByteArray()
	var changed := false
	var i := 0
	var n := bytes.size()
	while i < n:
		var hit: Array = []
		for r: Array in _rules:
			var ja: PackedByteArray = r[0]
			if ja[0] == bytes[i] and i + ja.size() <= n and bytes.slice(i, i + ja.size()) == ja:
				hit = r
				break
		if not hit.is_empty():
			var ja: PackedByteArray = hit[0]
			var en: PackedByteArray = hit[1]
			var width := ja.size()
			var j := i + ja.size()
			while width < en.size() and j < n and bytes[j] == 0x20:
				width += 1
				j += 1
			out.append_array(en)
			for k in range(en.size(), width):
				out.append(0x20)
			changed = true
			i = j
			continue
		var c := bytes[i]
		if _is_lead(c) and i + 1 < n:
			var run := PackedByteArray()
			var j := i
			while j + 1 < n:
				var a := bytes[j]
				var t := bytes[j + 1]
				var half := -1
				if a == 0x82 and t >= 0x4f and t <= 0x58:
					half = 0x30 + t - 0x4f
				elif a == 0x82 and t >= 0x60 and t <= 0x79:
					half = 0x41 + t - 0x60
				elif a == 0x82 and t >= 0x81 and t <= 0x9a:
					half = 0x61 + t - 0x81
				elif a == 0x81 and t == 0x7c:
					half = 0x2d
				elif a == 0x81 and t == 0x40:
					if not run.is_empty():
						break
					half = 0x20
				if half < 0:
					break
				run.append(half)
				j += 2
				if half == 0x20:
					break
			if not run.is_empty():
				out.append_array(run)
				var width := 2 if run.size() == 1 and run[0] == 0x20 else j - i
				if run.size() == 1 and run[0] == 0x20:
					out.append(0x20)
				else:
					for k in range(run.size(), width):
						out.append(0x20)
				changed = true
				i = j
				continue
			out.append(c)
			out.append(bytes[i + 1])
			i += 2
			continue
		out.append(c)
		i += 1
	if not changed:
		return bytes
	var end := out.size()
	while end > 0 and out[end - 1] < 0x20:
		end -= 1
	var tail := out.slice(end)
	out = out.slice(0, end)
	while out.size() + tail.size() > n and not out.is_empty() and out[out.size() - 1] == 0x20:
		out.remove_at(out.size() - 1)
	while out.size() + tail.size() < n:
		out.append(0x20)
	out.append_array(tail)
	return out


## Shift-JIS bytes of a string (characters the table has; "{xx}" is a raw byte).
func encode_sjis(text: String) -> PackedByteArray:
	_ensure_loaded()
	if _sjis_rev.is_empty():
		for code: int in _sjis:
			var ch: String = _sjis[code]
			if not _sjis_rev.has(ch):
				_sjis_rev[ch] = code
	var out := PackedByteArray()
	var i := 0
	while i < text.length():
		var ch := text[i]
		if ch == "{" and i + 3 < text.length() and text[i + 3] == "}" and text.substr(i + 1, 2).is_valid_hex_number():
			out.append(text.substr(i + 1, 2).hex_to_int())
			i += 4
			continue
		var u := ch.unicode_at(0)
		if u < 0x80:
			out.append(u)
		elif _sjis_rev.has(ch):
			var code: int = _sjis_rev[ch]
			if code > 0xff:
				out.append(code >> 8)
			out.append(code & 0xff)
		i += 1
	return out


func _compile_rules(rules: Array) -> void:
	_rules.clear()
	for r in rules:
		var ja := encode_sjis(str(r["ja"]))
		if ja.is_empty():
			continue
		var en := PackedByteArray()
		for ch in str(r["en"]):
			var l := TextCodec.LATIN.find(ch)
			en.append(0xa1 + l if l >= 0 else ch.unicode_at(0) & 0x7f)
		_rules.append([ja, en])
	_rules.sort_custom(func(a: Array, b: Array) -> bool: return a[0].size() > b[0].size())


static func _is_lead(c: int) -> bool:
	return (c >= 0x81 and c < 0xa0) or (c >= 0xe0 and c < 0xf0)


static func _load_font(path: String) -> Font:
	# The imported resource in exported builds; the raw file when the project was not imported.
	var f: FontFile = null
	if ResourceLoader.exists(path):
		f = (load(path) as FontFile).duplicate()
	else:
		f = FontFile.new()
		f.data = FileAccess.get_file_as_bytes(path)
	f.antialiasing = TextServer.FONT_ANTIALIASING_NONE
	f.hinting = TextServer.HINTING_NONE
	f.subpixel_positioning = TextServer.SUBPIXEL_POSITIONING_DISABLED
	f.allow_system_fallback = true
	return f
