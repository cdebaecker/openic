extends Control
## The HD art version of an index screen (scripts/field/field_screen_image.gd): the screen's blits
## replayed in order with the HD pictures of their sources (scripts/hd/hd_art.gd), so each pixel
## comes from the same blit as in the index screen, drawn in more detail. Parts without an HD
## picture are drawn from the index screen itself. Placed behind the index screen's TextureRect
## (show_behind_parent), which is drawn over it half transparent: the "HD anime + pixels" mix.

const HdArt := preload("res://scripts/hd/hd_art.gd")
const HdShader := preload("res://shaders/hd_art.gdshader")

const WHOLE := 1.0
const MASKED := 0.75
const INDEX := 0.5

## The index screen (R8), for the parts drawn from it
var screen: Texture2D = null
## [texture or null, source rect, destination, kind]
var _ops: Array = []


func _init() -> void:
	mouse_filter = Control.MOUSE_FILTER_IGNORE
	show_behind_parent = true
	texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST
	size = Vector2(768, 512)
	material = ShaderMaterial.new()
	material.shader = HdShader


func set_palette(pal: PackedColorArray) -> void:
	material.set_shader_parameter("palette", pal)


func set_ops(ops: Array) -> void:
	_ops = ops.duplicate()
	queue_redraw()


func _draw() -> void:
	var s := float(HdArt.SCALE)
	for op: Array in _ops:
		var dst := Rect2(op[2], Vector2(op[1].size))
		if op[0] == null:
			if screen != null:
				draw_texture_rect_region(screen, dst, dst, Color(1, 1, 1, INDEX))
		else:
			var src := Rect2(Vector2(op[1].position) * s, Vector2(op[1].size) * s)
			draw_texture_rect_region(op[0], dst, src, Color(1, 1, 1, op[3]))
