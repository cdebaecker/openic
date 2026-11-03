extends Control
## Opening screen. The rights holder's terms (PERMISSION.md) require it to credit their
## ownership of the assets and state that this is an unofficial fan project: keep this text
## and keep it on screen until the player dismisses it.

signal finished(next: String, args: Dictionary)

const NOTICE := (
	"Unofficial, non-commercial fan creation based on the 1991 X68000 game 幻影都市 (Illusion City). "
	+ "The original game and all of its assets — story, graphics and music — are © 1991 MicroCabin "
	+ "and owned by their rights holders. This fan project is not affiliated with or endorsed by them."
)


func _ready() -> void:
	set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	var bg := ColorRect.new()
	bg.color = Color(0.03, 0.03, 0.05)
	bg.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	add_child(bg)

	var center := CenterContainer.new()
	center.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	add_child(center)
	var box := VBoxContainer.new()
	box.custom_minimum_size = Vector2(560, 0)
	box.add_theme_constant_override("separation", 14)
	center.add_child(box)

	box.add_child(_label("OpenIC: FAN-MADE PORT OF", 16, Color(0.85, 0.65, 0.25)))
	box.add_child(_label("幻影都市", 48, Color(0.95, 0.92, 0.85)))
	box.add_child(_label("Illusion City", 32, Color(0.8, 0.78, 0.72)))
	var notice := _label(NOTICE, 16, Color(0.75, 0.75, 0.78))
	notice.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	box.add_child(notice)
	box.add_child(_label("Click or press Enter to start", 16, Color(0.85, 0.65, 0.25)))


## size: a multiple of 16 (the game font is pixel-exact at 16 and its multiples)
func _label(text: String, size: int, color: Color) -> Label:
	var l := Label.new()
	l.text = text
	l.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	l.add_theme_font_size_override("font_size", size)
	l.add_theme_color_override("font_color", color)
	return l


func _unhandled_input(event: InputEvent) -> void:
	if event.is_action_pressed("confirm"):
		get_viewport().set_input_as_handled()
		finished.emit("title", {})
