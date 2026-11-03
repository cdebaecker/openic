// X68000 graphic plane for the cutscenes: four 16-colour pages (R8 index textures) composited by
// priority with colour 0 transparent, per-page scroll, one 16-entry palette and IOCS CONTRAST.
// In memory mode 4 the pages are the quadrants of one 1024x1024 plane scrolled by page 0's
// registers.
shader_type canvas_item;
render_mode unshaded;

uniform sampler2D page0 : filter_nearest;
uniform sampler2D page1 : filter_nearest;
uniform sampler2D page2 : filter_nearest;
uniform sampler2D page3 : filter_nearest;
uniform vec4 palette[16];
uniform vec4 scroll_x;      // per page
uniform vec4 scroll_y;
uniform vec4 priority;      // 0 = front
uniform vec4 enabled;       // 1 = page shown
uniform bool mode4 = false;
uniform float brightness = 1.0;
uniform vec4 backdrop : source_color = vec4(0.0, 0.0, 0.0, 1.0); // text palette entry 0
uniform vec2 view_size = vec2(512.0, 512.0);

int index_at(int p, ivec2 c) {
	if (p == 0) return int(round(texelFetch(page0, c, 0).r * 255.0));
	if (p == 1) return int(round(texelFetch(page1, c, 0).r * 255.0));
	if (p == 2) return int(round(texelFetch(page2, c, 0).r * 255.0));
	return int(round(texelFetch(page3, c, 0).r * 255.0));
}

void fragment() {
	ivec2 s = ivec2(floor(UV * view_size));
	int color = 0;
	if (mode4) {
		if (dot(enabled, vec4(1.0)) > 0.0) {
			ivec2 c = ivec2((s.x + (int(scroll_x[0]) & 1023)) & 1023, (s.y + (int(scroll_y[0]) & 1023)) & 1023);
			int q = (c.y >= 512 ? 2 : 0) + (c.x >= 512 ? 1 : 0);
			color = index_at(q, c & ivec2(511));
		}
	} else {
		float best = 99.0;
		for (int p = 0; p < 4; p++) {
			if (enabled[p] < 0.5 || priority[p] >= best) continue;
			ivec2 c = ivec2((s.x + int(scroll_x[p])) & 511, (s.y + int(scroll_y[p])) & 511);
			int i = index_at(p, c);
			if (i != 0) {
				color = i;
				best = priority[p];
			}
		}
	}
	// Where every page is transparent the backdrop (text palette entry 0) shows.
	vec3 rgb = color == 0 ? backdrop.rgb : palette[color].rgb;
	COLOR = vec4(rgb * brightness, 1.0);
}
