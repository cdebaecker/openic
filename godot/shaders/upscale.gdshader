// The 768x512 game screen drawn at the window's size (main.gd). One fragment per window pixel,
// reading the screen's pixels with texelFetch:
//   0 sharp: nearest neighbour, as the original pixels
//   1 smooth: sharp bilinear (nearest inside a pixel, blended only across pixel edges)
//   2 xBR: the xBR level 1 rules (Hyllian): pixel-art edges rounded into diagonals
//   3 CRT: scanlines and a light aperture mask, as a 31 kHz monitor
//   4 HD: the screen drawn at 2x with HD art (scripts/hd/hd_art.gd), filtered to the window's
//     size (bilinear, four taps when it is made smaller)
shader_type canvas_item;
render_mode unshaded;

uniform int mode = 0;
// the screen (helper functions cannot read TEXTURE)
uniform sampler2D screen : filter_nearest;

ivec2 src_size() {
	return textureSize(screen, 0);
}

vec3 px(ivec2 p) {
	ivec2 s = src_size();
	return texelFetch(screen, clamp(p, ivec2(0), s - 1), 0).rgb;
}

vec3 bilinear(vec2 t) {
	vec2 b = t - 0.5;
	ivec2 i = ivec2(floor(b));
	vec2 f = fract(b);
	vec3 top = mix(px(i), px(i + ivec2(1, 0)), f.x);
	vec3 bottom = mix(px(i + ivec2(0, 1)), px(i + ivec2(1, 1)), f.x);
	return mix(top, bottom, f.y);
}

// Sharp bilinear: the position moved to the pixel's centre except within one output pixel of
// its edges. `scale` = output pixels per source pixel.
vec2 sharp(vec2 t, vec2 scale) {
	vec2 fl = floor(t);
	vec2 c = fract(t) - 0.5;
	vec2 region = max(0.5 - 0.5 / scale, 0.0);
	return fl + (c - clamp(c, -region, region)) * scale + 0.5;
}

// The colour distance xBR uses (YUV, luma weighted).
float dist(vec3 a, vec3 b) {
	vec3 d = a - b;
	vec3 yuv = vec3(dot(d, vec3(0.299, 0.587, 0.114)), dot(d, vec3(-0.169, -0.331, 0.5)),
		dot(d, vec3(0.5, -0.419, -0.081)));
	return dot(abs(yuv), vec3(48.0, 7.0, 6.0));
}

bool same(vec3 a, vec3 b) {
	return dist(a, b) < 1.0;
}

vec3 xbr(vec2 t) {
	ivec2 e0 = ivec2(floor(t));
	vec2 f = fract(t) - 0.5;
	// the quadrant's corner: pF the pixel beside it, pH below or above, pI diagonal
	ivec2 sx = ivec2(f.x < 0.0 ? -1 : 1, 0);
	ivec2 sy = ivec2(0, f.y < 0.0 ? -1 : 1);
	vec3 pE = px(e0);
	vec3 pF = px(e0 + sx), pH = px(e0 + sy), pI = px(e0 + sx + sy);
	vec3 pB = px(e0 - sy), pD = px(e0 - sx);
	vec3 pC = px(e0 + sx - sy), pG = px(e0 - sx + sy);
	vec3 pF4 = px(e0 + 2 * sx), pH5 = px(e0 + 2 * sy);
	vec3 pI4 = px(e0 + 2 * sx + sy), pI5 = px(e0 + sx + 2 * sy);
	// an edge runs along pF-pH when that diagonal is more alike than pE-pI
	float wd1 = dist(pE, pC) + dist(pE, pG) + dist(pI, pF4) + dist(pI, pH5) + 4.0 * dist(pH, pF);
	float wd2 = dist(pH, pD) + dist(pH, pI5) + dist(pF, pI4) + dist(pF, pB) + 4.0 * dist(pE, pI);
	bool edge = wd1 < wd2 && !same(pE, pF) && !same(pE, pH);
	if (!edge) {
		return pE;
	}
	vec3 nc = dist(pE, pF) <= dist(pE, pH) ? pF : pH;
	// level 1: the corner's triangle beyond the line through the two edge midpoints,
	// antialiased over one output pixel
	float l = abs(f.x) + abs(f.y);
	float w = max(fwidth(l), 1e-4);
	return mix(pE, nc, clamp((l - 0.5) / w + 0.5, 0.0, 1.0));
}

vec3 crt(vec2 t, vec2 scale, vec2 frag) {
	// sharp horizontally, each line a soft beam vertically
	vec2 s = sharp(t, scale);
	float row = floor(t.y);
	vec3 c = bilinear(vec2(s.x, row + 0.5));
	// the beam's centre on an output row: at 2x the first of the two rows is lit, the second dark
	float n = max(round(scale.y), 1.0);
	float centre = (floor((n - 1.0) / 2.0) + 0.5) / n;
	float d = fract(t.y) - centre;
	float beam = exp(-d * d * 12.0);
	c *= mix(0.35, 1.2, beam);
	// a faint RGB stripe mask, one column per output pixel
	int col = int(mod(frag.x, 3.0));
	vec3 mask = col == 0 ? vec3(1.0, 0.9, 0.9) : col == 1 ? vec3(0.9, 1.0, 0.9) : vec3(0.9, 0.9, 1.0);
	return clamp(c * mask, 0.0, 1.0);
}

void fragment() {
	vec2 size = vec2(src_size());
	vec2 t = UV * size;
	vec2 raw = 1.0 / max(fwidth(t), vec2(1e-4));   // output pixels per source pixel
	vec2 scale = max(raw, vec2(1.0));
	vec3 c;
	if (mode == 1) {
		c = bilinear(sharp(t, scale));
	} else if (mode == 2) {
		c = xbr(t);
	} else if (mode == 3) {
		c = crt(t, scale, FRAGCOORD.xy);
	} else if (mode == 4) {
		if (raw.x >= 1.0) {
			c = bilinear(t);
		} else {
			vec2 q = 0.25 / raw;
			c = 0.25 * (bilinear(t + vec2(-q.x, -q.y)) + bilinear(t + vec2(q.x, -q.y))
				+ bilinear(t + vec2(-q.x, q.y)) + bilinear(t + vec2(q.x, q.y)));
		}
	} else {
		c = px(ivec2(floor(t)));
	}
	COLOR = vec4(c, 1.0);
}
