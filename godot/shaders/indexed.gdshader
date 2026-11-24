// A plane of 16-colour indices (R8 texture) shown through a palette, as the X68000 text layer.
shader_type canvas_item;
render_mode unshaded;

uniform vec4 palette[16];
uniform float brightness = 1.0;
// below 1 over HD art (scripts/hd/hd_layer.gd): the "HD anime + pixels" mix
uniform float opacity = 1.0;

void fragment() {
	int i = int(round(texture(TEXTURE, UV).r * 255.0)) & 15;
	COLOR = vec4(palette[i].rgb * brightness, opacity);
}
