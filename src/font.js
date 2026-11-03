// CGROM substitute. The X68000 font ROM (0xF00000-0xFBFFFF) is not
// distributable, so glyphs are rasterized from a host font at startup into
// the same layout the ROM uses:
//   0xF00000  16x16 full-width (JIS rows 0x21-0x28, then 0x30-0x74)
//   0xF3A000  8x8 ANK
//   0xF3A800  8x16 ANK
//   0xF3B800  12x12 full-width (same row layout, 24 bytes per glyph)
//   0xF40000  24x24 full-width (72 bytes per glyph)

const sjisDecoder = new TextDecoder('shift_jis');

export const CG_BASE = 0xf00000;
export const CG_SIZE = 0xc0000;

export function jisIndex(hi, lo) {
  if (hi < 0x21 || lo < 0x21 || lo > 0x7e) return -1;
  if (hi <= 0x28) return (hi - 0x21) * 94 + (lo - 0x21);
  if (hi >= 0x30 && hi <= 0x74) return (hi - 0x21 - 7) * 94 + (lo - 0x21);
  return -1;
}

export function sjisToJis(c) {
  let hi = c >> 8, lo = c & 0xff;
  hi -= hi <= 0x9f ? 0x71 : 0xb1;
  hi = hi * 2 + 1;
  if (lo > 0x7f) lo--;
  if (lo >= 0x9e) { lo -= 0x7d; hi++; } else lo -= 0x1f;
  return (hi << 8) | lo;
}

export function jisToSjis(hi, lo) {
  let s1 = ((hi + 1) >> 1) + (hi <= 0x5e ? 0x70 : 0xb0);
  let s2 = lo + ((hi & 1) ? (lo >= 0x60 ? 0x20 : 0x1f) : 0x7e);
  return [s1, s2];
}

export function jisChar(hi, lo) {
  const [a, b] = jisToSjis(hi, lo);
  const s = sjisDecoder.decode(new Uint8Array([a, b]));
  return s === '�' ? '' : s;
}

export function ankChar(c) {
  if (c >= 0x20 && c < 0x7f) return c === 0x5c ? '¥' : String.fromCharCode(c);
  if (c >= 0xa1 && c <= 0xdf) return sjisDecoder.decode(new Uint8Array([c]));
  return '';
}

export class Font {
  constructor(cgrom = null) {
    this.cgrom = cgrom ?? new Uint8Array(CG_SIZE);
    this.lastWidth = 16; this.lastHeight = 16;
    // ANK code $A0 (blank on the real ROM, unused by the game) draws '!': the
    // message engine reserves the ASCII '!' as a command, so translated text
    // encodes it as $A0 to keep it half-width (see src/text/codec.js).
    const r = this.cgrom;
    r.copyWithin(0xf3a000 - CG_BASE + 0xa0 * 8, 0xf3a000 - CG_BASE + 0x21 * 8, 0xf3a000 - CG_BASE + 0x22 * 8);
    r.copyWithin(0xf3a800 - CG_BASE + 0xa0 * 16, 0xf3a800 - CG_BASE + 0x21 * 16, 0xf3a800 - CG_BASE + 0x22 * 16);
  }

  install(m) {
    const rom = this.cgrom;
    m.map(0xf00000, 0xfc0000, {
      read8: (a) => rom[a - CG_BASE],
      write8: () => {},
    });
  }

  romAddress(code, size) {
    if (code < 0x100) {
      this.lastWidth = 8;
      if (size === 6) { this.lastHeight = 8; return 0xf3a000 + code * 8; }
      this.lastHeight = 16;
      return 0xf3a800 + code * 16;
    }
    const jis = sjisToJis(code);
    const idx = Math.max(0, jisIndex(jis >> 8, jis & 0xff));
    if (size === 12) { this.lastWidth = 12; this.lastHeight = 12; return 0xf3b800 + idx * 24; }
    if (size === 24) { this.lastWidth = 24; this.lastHeight = 24; return 0xf40000 + idx * 72; }
    this.lastWidth = 16; this.lastHeight = 16;
    return CG_BASE + idx * 32;
  }

  glyph16(code) {
    const a = this.romAddress(code, 8) - CG_BASE;
    const len = this.lastWidth === 8 ? 16 : 32;
    return { width: this.lastWidth, height: 16, data: this.cgrom.subarray(a, a + len) };
  }
  glyph8(code) {
    const a = this.romAddress(code & 0xff, 6) - CG_BASE;
    return { width: 8, height: 8, data: this.cgrom.subarray(a, a + 8) };
  }

  // Build the ROM image. rasterize(chars[], w, h) returns an array of
  // Uint8Array(w*h) coverage maps (0/1), one per character.
  static build(rasterize) {
    const rom = new Uint8Array(CG_SIZE);
    const put = (addr, bitmap, w, h) => {
      const bpr = Math.ceil(w / 8);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        if (bitmap[y * w + x]) rom[addr - CG_BASE + y * bpr + (x >> 3)] |= 0x80 >> (x & 7);
      }
    };
    // full-width
    const jisList = [];
    for (let hi = 0x21; hi <= 0x74; hi++) {
      if (hi > 0x28 && hi < 0x30) continue;
      for (let lo = 0x21; lo <= 0x7e; lo++) jisList.push([hi, lo, jisChar(hi, lo)]);
    }
    for (const [size, base, bytes] of [[16, CG_BASE, 32], [12, 0xf3b800, 24], [24, 0xf40000, 72]]) {
      const maps = rasterize(jisList.map((x) => x[2]), size, size);
      jisList.forEach(([hi, lo], i) => {
        if (maps[i]) put(base + jisIndex(hi, lo) * bytes, maps[i], size, size);
      });
    }
    const ank = [];
    for (let c = 0; c < 256; c++) ank.push(ankChar(c));
    const m8 = rasterize(ank, 8, 8);
    const m16 = rasterize(ank, 8, 16);
    for (let c = 0; c < 256; c++) {
      if (m8[c]) put(0xf3a000 + c * 8, m8[c], 8, 8);
      if (m16[c]) put(0xf3a800 + c * 16, m16[c], 8, 16);
    }
    return rom;
  }
}
