// HD art (scripts/hd/hd_layer.gd): draws the stored HD pictures of scripts/hd/hd_art.gd in the
// palette the game has set, or parts of the index screen itself. The kind of each draw is in the
// alpha of its colour (the vertex colour; fades go through `brightness`):
//   1.0  HD picture, whole
//   0.75 HD picture, its mask only (the pixels the index image's mask has)
//   0.5  index texture (R8) through the palette
// HD texel: mix(palette[i], palette[R], G), A = 32 + i + 16 if masked.
shader_type canvas_item;
render_mode unshaded;

uniform vec4 palette[16];
uniform float brightness = 1.0;

varying float kind;

void vertex() {
	kind = COLOR.a;
}

void fragment() {
	vec4 t = texture(TEXTURE, UV);
	vec3 rgb;
	if (kind < 0.625) {
		rgb = palette[int(round(t.r * 255.0)) & 15].rgb;
	} else {
		int a = int(round(t.a * 255.0)) - 32;
		if (kind < 0.875 && (a < 16 || a > 31)) {
			discard;
		}
		rgb = mix(palette[a & 15].rgb, palette[int(round(t.r * 255.0)) & 15].rgb, t.g);
	}
	COLOR = vec4(clamp(rgb, 0.0, 1.0) * brightness, 1.0);
}
