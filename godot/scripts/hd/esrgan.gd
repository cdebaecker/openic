extends RefCounted
## Real-ESRGAN's anime model (RRDBNet, 6 blocks, x4; hd/anime6b.bin from tools/hd/export_model.py)
## run with compute shaders on a local RenderingDevice. Only renderers with a RenderingDevice have
## one, so the game runs this in a helper process started with --rendering-method forward_plus
## (scripts/hd/hd_build.gd).
##
## upscale(image) gives the image 4x as the PyTorch model does (float32 throughout, zero padding at
## each convolution, the picture cut in tiles with a margin mirrored at the picture's edges; checked
## against PyTorch to +-2 of 255 from the half-float weights). bake(index image, palette) gives
## the stored HD picture of scripts/hd/hd_art.gd.

const MODEL := "res://hd/anime6b.bin"
const TILE := 160
const PAD := 10
const F := 64
const G := 32
const OC := 16  # output channels per workgroup (CONV_SRC's OCB)
const FILL_STEPS := 16

# One 3x3 convolution: a workgroup computes 16 output channels of 16x16 pixels, taking the input
# 8 channels at a time into shared memory (18x18 with the border) with the weights for them.
# Zero padding at the output's size; `up`: the input is half the size (nearest 2x upsampling).
const CONV_SRC := """
#version 450
layout(local_size_x = 16, local_size_y = 16, local_size_z = 1) in;
layout(set = 0, binding = 0, std430) readonly buffer In { float v[]; } src;
layout(set = 0, binding = 1, std430) buffer Out { float v[]; } dst;
layout(set = 0, binding = 2, std430) readonly buffer Res { float v[]; } res;
layout(set = 0, binding = 3, std430) readonly buffer W { float v[]; } wt;
layout(push_constant, std430) uniform P {
	int w; int h; int cin; int in_off;
	int cout; int out_off; int res_off; int w_off;
	int up; int lrelu; float scale; float res_scale;
} p;

#define OCB 16
#define CH 8
shared float tile[CH * 324];
shared float wsh[OCB * CH * 9];

void main() {
	int lx = int(gl_LocalInvocationID.x);
	int ly = int(gl_LocalInvocationID.y);
	int lid = ly * 16 + lx;
	int gx0 = int(gl_WorkGroupID.x) * 16;
	int gy0 = int(gl_WorkGroupID.y) * 16;
	int co0 = int(gl_WorkGroupID.z) * OCB;
	int x = gx0 + lx;
	int y = gy0 + ly;
	int iw = p.w >> p.up;
	int ih = p.h >> p.up;
	int plane = iw * ih;
	int stride = p.cin * 9;
	float acc[OCB];
	for (int o = 0; o < OCB; o++) {
		acc[o] = 0.0;
	}
	for (int c0 = 0; c0 < p.cin; c0 += CH) {
		barrier();
		for (int k = lid; k < CH * 324; k += 256) {
			int ci = k / 324;
			int r = k - ci * 324;
			int sy = gy0 + r / 18 - 1;
			int sx = gx0 + r % 18 - 1;
			float v = 0.0;
			if (c0 + ci < p.cin && sx >= 0 && sy >= 0 && sx < p.w && sy < p.h) {
				v = src.v[(p.in_off + c0 + ci) * plane + (sy >> p.up) * iw + (sx >> p.up)];
			}
			tile[k] = v;
		}
		for (int k = lid; k < OCB * CH * 9; k += 256) {
			int o = k / (CH * 9);
			int r = k - o * CH * 9;
			int ci = r / 9;
			float v = 0.0;
			if (co0 + o < p.cout && c0 + ci < p.cin) {
				v = wt.v[p.w_off + (co0 + o) * stride + (c0 + ci) * 9 + r % 9];
			}
			wsh[k] = v;
		}
		barrier();
		for (int ci = 0; ci < CH; ci++) {
			for (int ky = 0; ky < 3; ky++) {
				for (int kx = 0; kx < 3; kx++) {
					float v = tile[ci * 324 + (ly + ky) * 18 + lx + kx];
					int wi = ci * 9 + ky * 3 + kx;
					for (int o = 0; o < OCB; o++) {
						acc[o] += v * wsh[o * CH * 9 + wi];
					}
				}
			}
		}
	}
	if (x >= p.w || y >= p.h) return;
	int oplane = p.w * p.h;
	int px = y * p.w + x;
	int nb = p.cout * stride;
	for (int o = 0; o < OCB; o++) {
		int co = co0 + o;
		if (co >= p.cout) break;
		float a = acc[o] + wt.v[p.w_off + nb + co];
		if (p.lrelu == 1 && a < 0.0) a *= 0.2;
		a *= p.scale;
		if (p.res_scale != 0.0) a += p.res_scale * res.v[(p.res_off + co) * oplane + px];
		dst.v[(p.out_off + co) * oplane + px] = a;
	}
}
"""

# dst[d_off + i] = a * x[x_off + i] + b * y[y_off + i]
const AXPY_SRC := """
#version 450
layout(local_size_x = 64, local_size_y = 1, local_size_z = 1) in;
layout(set = 0, binding = 0, std430) readonly buffer X { float v[]; } xs;
layout(set = 0, binding = 1, std430) buffer D { float v[]; } dst;
layout(set = 0, binding = 2, std430) readonly buffer Y { float v[]; } ys;
layout(push_constant, std430) uniform P {
	int count; int x_off; int d_off; int y_off; float a; float b; int pad0; int pad1;
} p;
void main() {
	int i = int(gl_GlobalInvocationID.x);
	if (i >= p.count) return;
	dst.v[p.d_off + i] = p.a * xs.v[p.x_off + i] + p.b * ys.v[p.y_off + i];
}
"""

# the source picture (RGBA8 words) -> 3 float planes of the tile, mirrored at the picture's edges
const UNPACK_SRC := """
#version 450
layout(local_size_x = 8, local_size_y = 8, local_size_z = 1) in;
layout(set = 0, binding = 0, std430) readonly buffer S { uint v[]; } img;
layout(set = 0, binding = 1, std430) buffer D { float v[]; } dst;
layout(push_constant, std430) uniform P {
	int img_w; int img_h; int x0; int y0; int w; int h; int pad0; int pad1;
} p;
int mirror(int c, int n) {
	if (n == 1) return 0;
	int period = 2 * n - 2;
	// (% is undefined for negative operands in GLSL; the mirror is symmetric about 0)
	c = abs(c) % period;
	return c < n ? c : period - c;
}
void main() {
	int x = int(gl_GlobalInvocationID.x);
	int y = int(gl_GlobalInvocationID.y);
	if (x >= p.w || y >= p.h) return;
	int sx = mirror(p.x0 + x, p.img_w);
	int sy = mirror(p.y0 + y, p.img_h);
	vec4 c = unpackUnorm4x8(img.v[sy * p.img_w + sx]);
	int plane = p.w * p.h;
	int i = y * p.w + x;
	dst.v[i] = c.r;
	dst.v[plane + i] = c.g;
	dst.v[2 * plane + i] = c.b;
}
"""

# 3 float planes (the 4x tile) -> RGBA8 words of the 4x picture: the tile's part without its
# margin, at (x0, y0) of a picture out_w words wide
const PACK_SRC := """
#version 450
layout(local_size_x = 8, local_size_y = 8, local_size_z = 1) in;
layout(set = 0, binding = 0, std430) readonly buffer S { float v[]; } src;
layout(set = 0, binding = 1, std430) buffer D { uint v[]; } img;
layout(push_constant, std430) uniform P {
	int src_w; int src_h; int sx0; int sy0; int w; int h; int x0; int y0;
	int out_w; int pad0; int pad1; int pad2;
} p;
void main() {
	int x = int(gl_GlobalInvocationID.x);
	int y = int(gl_GlobalInvocationID.y);
	if (x >= p.w || y >= p.h) return;
	int plane = p.src_w * p.src_h;
	int i = (p.sy0 + y) * p.src_w + p.sx0 + x;
	vec3 c = clamp(vec3(src.v[i], src.v[plane + i], src.v[2 * plane + i]), 0.0, 1.0);
	// as the PyTorch tools round: floor(c * 255 + 0.5)
	uvec3 q = uvec3(floor(c * 255.0 + 0.5));
	img.v[(p.y0 + y) * p.out_w + p.x0 + x] = q.r | (q.g << 8) | (q.b << 16) | (255u << 24);
}
"""

# The index picture (RGBA8 words: red = index, alpha = mask) -> colour words through the palette;
# with `hide`, pixels outside the mask are unknown (alpha 0) for FILL_SRC to fill.
const COLOUR_SRC := """
#version 450
layout(local_size_x = 64, local_size_y = 1, local_size_z = 1) in;
layout(set = 0, binding = 0, std430) readonly buffer S { uint v[]; } idx;
layout(set = 0, binding = 1, std430) buffer D { uint v[]; } col;
layout(set = 0, binding = 2, std430) readonly buffer Pal { vec4 c[16]; } pal;
layout(push_constant, std430) uniform P { int count; int hide; int pad0; int pad1; } p;
void main() {
	int i = int(gl_GlobalInvocationID.x);
	if (i >= p.count) return;
	uint w = idx.v[i];
	bool shown = (w >> 24) >= 128u;
	vec3 c = clamp(pal.c[w & 15u].rgb, 0.0, 1.0);
	uvec3 q = uvec3(floor(c * 255.0 + 0.5));
	uint a = (shown || p.hide == 0) ? 255u : 0u;
	col.v[i] = q.r | (q.g << 8) | (q.b << 16) | (a << 24);
}
"""

# One step of filling the unknown pixels (alpha 0) with the mean of their known neighbours, so
# the edges of sprites are upscaled against their own colours rather than a background.
const FILL_SRC := """
#version 450
layout(local_size_x = 8, local_size_y = 8, local_size_z = 1) in;
layout(set = 0, binding = 0, std430) readonly buffer S { uint v[]; } src;
layout(set = 0, binding = 1, std430) buffer D { uint v[]; } dst;
layout(push_constant, std430) uniform P { int w; int h; int pad0; int pad1; } p;
void main() {
	int x = int(gl_GlobalInvocationID.x);
	int y = int(gl_GlobalInvocationID.y);
	if (x >= p.w || y >= p.h) return;
	uint c = src.v[y * p.w + x];
	if ((c >> 24) != 0u) {
		dst.v[y * p.w + x] = c;
		return;
	}
	vec3 sum = vec3(0.0);
	float n = 0.0;
	for (int dy = -1; dy <= 1; dy++) {
		for (int dx = -1; dx <= 1; dx++) {
			int sx = x + dx;
			int sy = y + dy;
			if (sx < 0 || sy < 0 || sx >= p.w || sy >= p.h) continue;
			vec4 k = unpackUnorm4x8(src.v[sy * p.w + sx]);
			if (k.a > 0.0) {
				sum += k.rgb;
				n += 1.0;
			}
		}
	}
	dst.v[y * p.w + x] = n > 0.0 ? packUnorm4x8(vec4(sum / n, 1.0)) : 0u;
}
"""

# The 4x tile (3 float planes) -> the stored HD picture (scripts/hd/hd_art.gd): each texel the
# mean of 2x2 of the 4x result, as the nearest mix of the colour of the index under it (i) and
# the colour of an index around it (j, from the 3x3 pixels around: the colours the upscaling
# blends, so the mix means the same in another palette): mix(pal[i], pal[j], t).
const ENCODE_SRC := """
#version 450
layout(local_size_x = 8, local_size_y = 8, local_size_z = 1) in;
layout(set = 0, binding = 0, std430) readonly buffer S { float v[]; } src;
layout(set = 0, binding = 1, std430) buffer D { uint v[]; } img;
layout(set = 0, binding = 2, std430) readonly buffer I { uint v[]; } idx;
layout(set = 0, binding = 3, std430) readonly buffer Pal { vec4 c[16]; } pal;
layout(push_constant, std430) uniform P {
	int src_w; int src_h; int sx0; int sy0; int w; int h; int x0; int y0;
	int idx_w; int idx_h; int pad1; int pad2;
} p;
void main() {
	int x = int(gl_GlobalInvocationID.x);
	int y = int(gl_GlobalInvocationID.y);
	if (x >= p.w || y >= p.h) return;
	int plane = p.src_w * p.src_h;
	int idx_h = p.idx_h;
	vec3 c = vec3(0.0);
	for (int k = 0; k < 4; k++) {
		int i = (p.sy0 + 2 * y + (k >> 1)) * p.src_w + p.sx0 + 2 * x + (k & 1);
		c += clamp(vec3(src.v[i], src.v[plane + i], src.v[2 * plane + i]), 0.0, 1.0);
	}
	c *= 0.25;
	// output texel (ox, oy) lies in index pixel (ox / 2, oy / 2)
	int ox = p.x0 + x;
	int oy = p.y0 + y;
	uint w = idx.v[(oy >> 1) * p.idx_w + (ox >> 1)];
	uint i = w & 15u;
	uint m = (w >> 24) >= 128u ? 16u : 0u;
	vec3 pi = clamp(pal.c[i].rgb, 0.0, 1.0);
	uint best_j = i;
	float best_t = 0.0;
	float best_e = dot(c - pi, c - pi);
	for (int n = 0; n < 9; n++) {
		int nx = clamp((ox >> 1) + n % 3 - 1, 0, p.idx_w - 1);
		int ny = clamp((oy >> 1) + n / 3 - 1, 0, idx_h - 1);
		uint j = idx.v[ny * p.idx_w + nx] & 15u;
		vec3 d = clamp(pal.c[j].rgb, 0.0, 1.0) - pi;
		float dd = dot(d, d);
		if (dd <= 0.0) continue;
		float t = clamp(dot(c - pi, d) / dd, 0.0, 1.0);
		vec3 e = pi + t * d - c;
		if (dot(e, e) < best_e) {
			best_e = dot(e, e);
			best_j = j;
			best_t = t;
		}
	}
	uint q = uint(floor(best_t * 255.0 + 0.5));
	img.v[oy * p.idx_w * 2 + ox] = best_j | (q << 8) | ((32u + i + m) << 24);
}
"""

var rd: RenderingDevice
var _shaders := {}        # name -> RID
var _pipes := {}          # shader RID -> pipeline RID
var _weights: RID
var _layers: Array = []   # [cin, cout, offset in floats]
var _buf := {}            # the network's buffers by name
var _sets := {}
var _list := -1
var debug_stop := -1      # tests: run the convolutions before this one only
var debug_out := []       # [buffer, channel offset, channels, w, h] of the last one run


## False when there is no RenderingDevice (the Compatibility renderer) or no model file.
func setup() -> bool:
	rd = RenderingServer.create_local_rendering_device()
	if rd == null:
		push_error("HD: no RenderingDevice (run with --rendering-method forward_plus)")
		return false
	if not _load_model():
		return false
	var sources := {"conv": CONV_SRC, "axpy": AXPY_SRC, "unpack": UNPACK_SRC, "pack": PACK_SRC,
		"colour": COLOUR_SRC, "fill": FILL_SRC, "encode": ENCODE_SRC}
	for k: String in sources:
		var sh := _shader(sources[k])
		if not sh.is_valid():
			return false
		_shaders[k] = sh
	# the network's buffers, for the largest tile
	var plane := (TILE + 2 * PAD) * (TILE + 2 * PAD)
	for b in [["img", 3], ["f0", F], ["r", F], ["c1", F + 4 * G], ["c2", F + 4 * G], ["u1", F * 4],
			["u2", F * 16], ["u3", F * 16], ["out", 3 * 16]]:
		_buf[b[0]] = rd.storage_buffer_create(int(b[1]) * plane * 4)
	return true


func _shader(src: String) -> RID:
	var s := RDShaderSource.new()
	s.source_compute = src
	var spirv := rd.shader_compile_spirv_from_source(s)
	if spirv.compile_error_compute != "":
		push_error("HD shader: " + spirv.compile_error_compute)
		return RID()
	var sh := rd.shader_create_from_spirv(spirv)
	_pipes[sh] = rd.compute_pipeline_create(sh)
	return sh


func _load_model() -> bool:
	var b := FileAccess.get_file_as_bytes(MODEL)
	if b.size() < 8 or b.slice(0, 4).get_string_from_ascii() != "ESR1":
		push_error("HD: no model at " + MODEL)
		return false
	var n := b.decode_u32(4)
	var floats := PackedFloat32Array()
	var at := 8
	for k in n:
		var cin := b.decode_u32(at)
		var cout := b.decode_u32(at + 4)
		at += 8
		var count := cout * cin * 9 + cout
		_layers.append([cin, cout, floats.size()])
		var start := floats.size()
		floats.resize(start + count)
		for i in count:
			floats[start + i] = b.decode_half(at + 2 * i)
		at += 2 * (count + (count & 1))
	var bytes := floats.to_byte_array()
	_weights = rd.storage_buffer_create(bytes.size(), bytes)
	return true


func _uniforms(shader: RID, rids: Array) -> RID:
	var key := str(shader) + str(rids)
	if _sets.has(key) and rd.uniform_set_is_valid(_sets[key]):
		return _sets[key]
	var us: Array[RDUniform] = []
	for i in rids.size():
		var u := RDUniform.new()
		u.uniform_type = RenderingDevice.UNIFORM_TYPE_STORAGE_BUFFER
		u.binding = i
		u.add_id(rids[i])
		us.append(u)
	var s := rd.uniform_set_create(us, shader, 0)
	_sets[key] = s
	return s


func _push(ints: Array, floats: Array = []) -> PackedByteArray:
	var b := PackedInt32Array(ints).to_byte_array()
	b.append_array(PackedFloat32Array(floats).to_byte_array())
	while b.size() % 16:
		b.append(0)
	return b


## One pass, finished before the next starts (compute_list_add_barrier alone let passes overlap:
## the results differed from PyTorch).
func _dispatch(name: String, rids: Array, push: PackedByteArray, gx: int, gy: int, gz: int) -> void:
	var shader: RID = _shaders[name]
	rd.compute_list_bind_compute_pipeline(_list, _pipes[shader])
	rd.compute_list_bind_uniform_set(_list, _uniforms(shader, rids), 0)
	rd.compute_list_set_push_constant(_list, push, push.size())
	rd.compute_list_dispatch(_list, gx, gy, gz)
	rd.compute_list_end()
	rd.submit()
	rd.sync()
	_list = rd.compute_list_begin()


func _conv_op(layer: int, src: RID, in_off: int, dst: RID, out_off: int, w: int, h: int,
		up: bool = false, lrelu: bool = false, scale: float = 1.0, res: RID = RID(), res_off: int = 0,
		res_scale: float = 0.0) -> void:
	if debug_stop >= 0:
		if layer >= debug_stop:
			return
		debug_out = [dst, out_off, _layers[layer][1], w, h]
	var l: Array = _layers[layer]
	var push := _push([w, h, l[0], in_off, l[1], out_off, res_off, l[2], 1 if up else 0, 1 if lrelu else 0],
		[scale, res_scale])
	_dispatch("conv", [src, dst, res if res.is_valid() else src, _weights], push,
		ceili(w / 16.0), ceili(h / 16.0), ceili(l[1] / float(OC)))


func _axpy_op(x: RID, dst: RID, y: RID, count: int, a: float, b: float) -> void:
	_dispatch("axpy", [x, dst, y], _push([count, 0, 0, 0], [a, b, 0.0, 0.0]), ceili(count / 64.0), 1, 1)


## The network on one tile already unpacked into "img" (3 planes of w x h); the result is in
## "out" (3 planes of 4w x 4h).
func _network(w: int, h: int) -> void:
	var plane := w * h
	var f0: RID = _buf["f0"]
	var r: RID = _buf["r"]
	var cat := [_buf["c1"], _buf["c2"]]
	var layer := 0
	_conv_op(layer, _buf["img"], 0, f0, 0, w, h)
	layer += 1
	_axpy_op(f0, cat[0], f0, F * plane, 1.0, 0.0)
	var cur := 0
	var blocks := (_layers.size() - 6) / 15
	for b in blocks:
		_axpy_op(cat[cur], r, r, F * plane, 1.0, 0.0)
		for k in 3:
			var c: RID = cat[cur]
			for i in 4:
				_conv_op(layer, c, 0, c, F + G * i, w, h, false, true)
				layer += 1
			_conv_op(layer, c, 0, cat[1 - cur], 0, w, h, false, false, 0.2, c, 0, 1.0)
			layer += 1
			cur = 1 - cur
		# RRDB: the three dense blocks x 0.2 + the block's input
		_axpy_op(cat[cur], cat[cur], r, F * plane, 0.2, 1.0)
	_conv_op(layer, cat[cur], 0, r, 0, w, h, false, false, 1.0, f0, 0, 1.0)
	layer += 1
	_conv_op(layer, r, 0, _buf["u1"], 0, w * 2, h * 2, true, true)
	layer += 1
	_conv_op(layer, _buf["u1"], 0, _buf["u2"], 0, w * 4, h * 4, true, true)
	layer += 1
	_conv_op(layer, _buf["u2"], 0, _buf["u3"], 0, w * 4, h * 4, false, true)
	layer += 1
	_conv_op(layer, _buf["u3"], 0, _buf["out"], 0, w * 4, h * 4)


## The tiles of a picture iw x ih: the picture `src` (RGBA8 words) is unpacked for the tile with
## its margin, the network runs, then `finish` takes "out" for the tile (tx, ty, cw, ch, margin
## excluded). Tiles for which `skip` says so are left out.
func _tiles(src: RID, iw: int, ih: int, finish: Callable, skip: Callable = Callable()) -> void:
	for ty in range(0, ih, TILE):
		for tx in range(0, iw, TILE):
			var cw := mini(TILE, iw - tx)
			var ch := mini(TILE, ih - ty)
			if skip.is_valid() and skip.call(Rect2i(tx, ty, cw, ch)):
				continue
			var w := cw + 2 * PAD
			var h := ch + 2 * PAD
			_list = rd.compute_list_begin()
			_dispatch("unpack", [src, _buf["img"]], _push([iw, ih, tx - PAD, ty - PAD, w, h]),
				ceili(w / 8.0), ceili(h / 8.0), 1)
			_network(w, h)
			finish.call(tx, ty, cw, ch)
			rd.compute_list_end()


## The picture 4x as the model gives it (RGB; alpha is not used and comes back opaque).
func upscale(src: Image) -> Image:
	var im := src.duplicate() as Image
	im.convert(Image.FORMAT_RGBA8)
	var iw := im.get_width()
	var ih := im.get_height()
	var data := im.get_data()
	var src_buf := rd.storage_buffer_create(data.size(), data)
	var out := rd.storage_buffer_create(iw * ih * 64)
	_tiles(src_buf, iw, ih, func(tx: int, ty: int, cw: int, ch: int) -> void:
		_dispatch("pack", [_buf["out"], out], _push([(cw + 2 * PAD) * 4, (ch + 2 * PAD) * 4, PAD * 4,
			PAD * 4, cw * 4, ch * 4, tx * 4, ty * 4, iw * 4]), ceili(cw / 2.0), ceili(ch / 2.0), 1))
	var bytes := rd.buffer_get_data(out)
	rd.free_rid(src_buf)
	rd.free_rid(out)
	_sets.clear()
	return Image.create_from_data(iw * 4, ih * 4, false, Image.FORMAT_RGBA8, bytes)


## An index picture (RGBA8: red = colour index, alpha = mask, as the exported .idx.png) as the
## stored HD picture (scripts/hd/hd_art.gd), 2x, upscaled in the colours of `palette` (16).
## `hide_unmasked`: the pixels outside the mask are never shown (sprites): they are filled from
## their neighbours before upscaling, and the tiles with nothing shown are skipped.
func bake(src: Image, palette: PackedColorArray, hide_unmasked: bool) -> Image:
	var im := src.duplicate() as Image
	im.convert(Image.FORMAT_RGBA8)
	var iw := im.get_width()
	var ih := im.get_height()
	var n := iw * ih
	var data := im.get_data()
	var idx := rd.storage_buffer_create(data.size(), data)
	var pf := PackedFloat32Array()
	for i in 16:
		var c: Color = palette[i] if i < palette.size() else Color.BLACK
		pf.append_array([c.r, c.g, c.b, 1.0])
	var pal_bytes := pf.to_byte_array()
	var pal := rd.storage_buffer_create(pal_bytes.size(), pal_bytes)
	var col := rd.storage_buffer_create(n * 4)
	var tmp := rd.storage_buffer_create(n * 4)
	var out := rd.storage_buffer_create(n * 16)
	_list = rd.compute_list_begin()
	_dispatch("colour", [idx, col, pal], _push([n, 1 if hide_unmasked else 0]), ceili(n / 64.0), 1, 1)
	if hide_unmasked:
		for k in FILL_STEPS / 2:
			_dispatch("fill", [col, tmp], _push([iw, ih]), ceili(iw / 8.0), ceili(ih / 8.0), 1)
			_dispatch("fill", [tmp, col], _push([iw, ih]), ceili(iw / 8.0), ceili(ih / 8.0), 1)
	rd.compute_list_end()
	var skip := Callable()
	if hide_unmasked:
		skip = func(r: Rect2i) -> bool: return im.get_region(r).is_invisible()
	_tiles(col, iw, ih, func(tx: int, ty: int, cw: int, ch: int) -> void:
		_dispatch("encode", [_buf["out"], out, idx, pal], _push([(cw + 2 * PAD) * 4, (ch + 2 * PAD) * 4,
			PAD * 4, PAD * 4, cw * 2, ch * 2, tx * 2, ty * 2, iw, ih]), ceili(cw / 4.0), ceili(ch / 4.0), 1),
		skip)
	var bytes := rd.buffer_get_data(out)
	for rid in [idx, pal, col, tmp, out]:
		rd.free_rid(rid)
	_sets.clear()
	return Image.create_from_data(iw * 2, ih * 2, false, Image.FORMAT_RGBA8, bytes)
