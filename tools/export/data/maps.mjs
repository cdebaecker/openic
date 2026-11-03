// "map\0" containers: map layers (file tables 0/2/4) and tilesets (tables 1/3/5).
// Both are read by ICITY68 with plain reads + its LZSS (f_6aa40). All words little-endian.
import { lzss } from '../lzss.mjs';

const u16 = (b, a) => b[a] | (b[a + 1] << 8);
const isMap = (b) => b[0] === 0x6d && b[1] === 0x61 && b[2] === 0x70 && b[3] === 0;

// Map layer (f_69f9a). Header (32 bytes):
//   +0 "map\0"  +4 u16 file size  +6 u16 unpacked size  +8 u16 metatile block size (0x800)
//   +10 u16 extra block size (0x100 = 6-byte records for the vr layer; 0x20 = second header)
//   +12 u16 packed size  +16 u16 width  +18 u16 height (in metatiles)  +30 01 01
// Then: extra block, metatile block, LZSS data (unpacked: width*height bytes, then for a
// second header its width*height bytes). Cells are stored column by column (x-major):
// cell(x, y) = data[x * height + y] — verified against the screen (text VRAM) at map A00.
// A metatile is 2x2 tiles (TL, TR, BL, BR) of u16: bits 0-7 tile number, bit 8 tileset
// (0 = vr_chr loaded at $9DD5A, 1 = sub_chr at $9DD5E).
// ICITY68 does not check the magic; two files on disk 3 (GROUP02/000036, 000044) have a
// damaged one ("\x8c<p\0") and are otherwise normal.
export function parseLayer(b) {
  if (u16(b, 4) !== b.length) throw new Error('size field does not match');
  const hdr = header(b, 0);
  const rawSize = u16(b, 6), mtSize = u16(b, 8), extSize = u16(b, 10), packed = u16(b, 12);
  let p = 32;
  const ext = b.subarray(p, p + extSize); p += extSize;
  const mt = b.subarray(p, p + mtSize); p += mtSize;
  const { data, consumed } = lzss(b, rawSize, p);
  const layers = [];
  const second = extSize === 0x20 && isMap(ext) ? header(ext, 0) : null;
  let off = 0;
  for (const h of [hdr, second]) {
    if (!h || !h.width) continue;
    const n = h.width * h.height;
    const col = data.subarray(off, off + n); off += n;
    const rows = [];
    for (let y = 0; y < h.height; y++) { const r = new Array(h.width); for (let x = 0; x < h.width; x++) r[x] = col[x * h.height + y]; rows.push(r); }
    layers.push({ width: h.width, height: h.height, cells: rows });
  }
  const metatiles = [];
  for (let i = 0; i < mtSize / 8; i++) {
    const q = [0, 1, 2, 3].map((k) => u16(mt, i * 8 + k * 2));
    metatiles.push(q.map((v) => ({ tile: v & 0xff, bank: (v >> 8) & 1, raw: v })));
  }
  let extRecords = null;
  if (extSize === 0x100) {
    extRecords = [];
    for (let i = 0; i + 6 <= extSize; i += 6) extRecords.push([u16(ext, i), u16(ext, i + 2), ext[i + 4], ext[i + 5]]);
  }
  return {
    kind: 'layer', header: hdr, secondHeader: second, packedSize: packed, packedOk: consumed === packed && p + packed === b.length,
    layers, metatiles, extRecords, extraB64: extSize === 0x100 ? Buffer.from(ext).toString('base64') : null, unpacked: data,
  };
}

function header(b, a) {
  return { fileSize: u16(b, a + 4), rawSize: u16(b, a + 6), w8: u16(b, a + 8), w10: u16(b, a + 10), w12: u16(b, a + 12), w14: u16(b, a + 14),
    width: u16(b, a + 16), height: u16(b, a + 18), tail: [...b.subarray(a + 20, a + 32)] };
}

// Tileset (f_6a2b0). Header (32 bytes): +4 u16 file size, +6 u16 unpacked size (0x5000),
// +8 u16 0x200, +10 u16 0x400, +14 u16 packed size. Then:
//   32 bytes  palette: 16 x u16 0x0GRB (4 bits per gun) -> loaded to $9DD4E+$C822/$C842/$C862
//   0x200     tile animation table: 24 x 16-byte records (f_742e8: +2 count, +3.. frame tiles),
//             rest (0x180..0x1FF) unknown (two 16-word blocks are nibble-expanded by f_6a2b0)
//   0x400     per-tile attribute words (collision/priority; read by the hand-written walker at
//             $75274.. as attr[(tile*2 + n)] with bits 8/9 tested) — 256 tiles x 2 x u16
//   LZSS      0x5000 bytes = 256 tiles x 80 bytes: 16-byte 1-bit mask (16x8, 1 = opaque),
//             then 4 bit planes x 16 bytes (8 rows x 2 bytes, MSB = leftmost pixel).
// A tile is 16x8 pixels; the game doubles every line on screen (16x16 on the 768x512 screen,
// drawn into text VRAM by $86A2E).
export function parseTileset(b) {
  if (u16(b, 4) !== b.length) throw new Error('size field does not match');
  const rawSize = u16(b, 6), animSize = u16(b, 8), attrSize = u16(b, 10), packed = u16(b, 14);
  let p = 32;
  const palette = []; for (let i = 0; i < 16; i++) palette.push(u16(b, p + i * 2)); p += 32;
  const anim = b.subarray(p, p + animSize); p += animSize;
  const attr = b.subarray(p, p + attrSize); p += attrSize;
  const { data, consumed } = lzss(b, rawSize, p);
  const tiles = [];
  for (let t = 0; t < rawSize / 80; t++) {
    const o = t * 80, px = new Uint8Array(128), mask = new Uint8Array(128);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 16; x++) {
      const bit = 7 - (x & 7), k = y * 2 + (x >> 3);
      let v = 0; for (let pl = 0; pl < 4; pl++) v |= ((data[o + 16 + pl * 16 + k] >> bit) & 1) << pl;
      px[y * 16 + x] = v; mask[y * 16 + x] = (data[o + k] >> bit) & 1;
    }
    tiles.push({ px, mask });
  }
  const animRecords = [];
  for (let i = 0; i < 24; i++) { const r = anim.subarray(i * 16, i * 16 + 16); if (r.some((x) => x)) animRecords.push({ index: i, raw: [...r] }); }
  const attrWords = []; for (let i = 0; i < attrSize / 2; i++) attrWords.push(u16(attr, i * 2));
  return {
    kind: 'tileset', palette, paletteRGB: palette.map(grb), animRecords, animTail: [...anim.subarray(0x180)], attrWords,
    tiles, packedSize: packed, packedOk: consumed === packed && p + packed === b.length, unpacked: data,
  };
}

export const grb = (c) => [((c >> 4) & 15) * 17, ((c >> 8) & 15) * 17, (c & 15) * 17];

// Tile atlas as RGBA: 16 tiles per row, each tile 16x16 (source lines doubled, as on screen).
// Mask 0 pixels are transparent.
export function tilesetAtlas(ts, perRow = 16, doubled = true) {
  const th = doubled ? 16 : 8, n = ts.tiles.length, rows = Math.ceil(n / perRow);
  const w = perRow * 16, h = rows * th, rgba = new Uint8Array(w * h * 4);
  const pal = ts.paletteRGB;
  ts.tiles.forEach((t, i) => {
    const ox = (i % perRow) * 16, oy = Math.floor(i / perRow) * th;
    for (let y = 0; y < th; y++) for (let x = 0; x < 16; x++) {
      const sy = doubled ? y >> 1 : y, k = sy * 16 + x, o = ((oy + y) * w + ox + x) * 4;
      if (!t.mask[k]) continue;
      const c = pal[t.px[k]]; rgba[o] = c[0]; rgba[o + 1] = c[1]; rgba[o + 2] = c[2]; rgba[o + 3] = 255;
    }
  });
  return { rgba, w, h };
}

// Render a layer with its tileset to RGBA; 32x32 screen pixels per metatile. Each layer uses its
// own tileset (vr layer -> vr_chr, sub layer -> sub_chr): bit 8 of a metatile entry does not
// select the tileset (checked tile by tile against text VRAM at the first free control).
// The base (vr) layer is drawn opaque (the blitter at $86A2E copies the planes as they are);
// the overlay uses the tile masks.
export function renderLayer(layer, metatiles, ts, palette, opaque = false) {
  const W = layer.width * 32, H = layer.height * 32, rgba = new Uint8Array(W * H * 4);
  const pal = palette.map(grb);
  for (let my = 0; my < layer.height; my++) for (let mx = 0; mx < layer.width; mx++) {
    const m = metatiles[layer.cells[my][mx]];
    m.forEach((q, k) => {
      if (!ts) return;
      const t = ts.tiles[q.tile]; if (!t) return;
      const ox = mx * 32 + (k & 1) * 16, oy = my * 32 + (k >> 1) * 16;
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        const s = (y >> 1) * 16 + x; if (!opaque && !t.mask[s]) continue;
        const c = pal[t.px[s]], o = ((oy + y) * W + ox + x) * 4;
        rgba[o] = c[0]; rgba[o + 1] = c[1]; rgba[o + 2] = c[2]; rgba[o + 3] = 255;
      }
    });
  }
  return { rgba, w: W, h: H };
}
