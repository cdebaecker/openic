// Illusion City picture decoder and exporter (IGRP/*.PIC on disk 1, IGRP2/*.PIC on disk 7).
//
// Two formats share the .PIC extension (docs/formats/pic.md):
//  - "PIC\x1a" files: Yanagisawa's X68000 PIC format (here always 16 colours, 768x512, palette in
//    the header). decodePic() implements the full format (4/8-bit palette modes and the 15/16-bit
//    colour-cache modes), checked pixel-exact against the decode buffer of the game's own loader.
//  - IGRP/MSG04.PIC has no header: it is the game's "GRP" run-length format (3-byte records, two
//    4-bit colours and two run lengths), expanded by IL_OPEN into a 1024-pixel-wide buffer.
//
// Library:  decodePic(bytes) -> { format, width, height, bits, palette (GRB words), indices
//           (Uint8Array/Uint16Array, one entry per pixel), rgba, x, y, comment, ... }
//           decodeGrp(bytes, palette?)  (called by decodePic for headerless files)
//           companionPalette(bytes)  -> 16 GRB words of a 32-byte .000/.001... palette file
// CLI:      node tools/export/pic.mjs [outDir]
//           -> <outDir>/<IGRP|IGRP2>/<NAME>.png (+ <NAME>.<nnn>.png for each extra palette file),
//              <outDir>/<IGRP|IGRP2>/<NAME>.json and <outDir>/index.json
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { allFiles, exportDir, writePng, writeJson, x68kColor } from './common.mjs';

class Bits {
  constructor(bytes, pos) { this.b = bytes; this.p = pos * 8; }
  bit() {
    const i = this.p >> 3;
    if (i >= this.b.length) throw new Error('PIC: unexpected end of data');
    return (this.b[i] >> (7 - (this.p++ & 7))) & 1;
  }
  bits(n) { let v = 0; while (n--) v = v * 2 + this.bit(); return v; }
}

// Header: "PIC", comment up to 0x1A, filler up to 0x00, reserved byte, machine type byte,
// colour bits (word), width (word), height (word), then for <= 8 bits a palette of 2^bits GRB words.
export function parsePicHeader(d) {
  if (d[0] !== 0x50 || d[1] !== 0x49 || d[2] !== 0x43) throw new Error('not a PIC file');
  let p = 3;
  while (p < d.length && d[p] !== 0x1a) p++;
  const comment = new TextDecoder('shift_jis').decode(d.subarray(3, p));
  p++;
  while (p < d.length && d[p] !== 0) p++;
  p++;
  const reserved = d[p], type = d[p + 1];
  const bits = (d[p + 2] << 8) | d[p + 3];
  const width = (d[p + 4] << 8) | d[p + 5], height = (d[p + 6] << 8) | d[p + 7];
  p += 8;
  // Machine type 0 is the X68000 (no extension). A non-zero machine type may carry a position
  // and aspect extension; none of the game's files has one.
  let x = 0, y = 0;
  const palette = [];
  if (bits <= 8) {
    for (let i = 0; i < 1 << bits; i++) { palette.push((d[p] << 8) | d[p + 1]); p += 2; }
  }
  return { comment, reserved, type, bits, width, height, x, y, palette, dataOffset: p };
}

// The bit stream is a sequence of (run length, new colour[, chain]) records in raster order:
//   length  = n one-bits, a zero, then n+1 bits v:  length = v + 2^(n+1) - 1  (>= 1)
//   the run's first length-1 pixels keep the current colour (a pixel already marked by a chain
//   switches the current colour to the chain's colour instead), then the next pixel gets a new colour:
//   - 4/8-bit modes: `bits` bits, a palette index;
//   - 15/16-bit modes: flag 1 -> 7-bit index into a 128-entry most-recently-used colour cache,
//     flag 0 -> a raw colour of `bits` bits, inserted at the front of the cache;
//   then one flag bit: 1 = a chain follows. Each chain code moves one line down and gives dx:
//     01 -> -1, 10 -> 0, 11 -> +1, 0001 -> -2, 0011 -> +2 ... and 000 ends the chain
//     (exactly: '00' then a bit 0 = end, 1 = two-step move; then a bit 0 = -2, 1 = +2).
//   Chain points are painted with the new colour and become colour-change points.
export function decodePicStream(d, h) {
  const { width: w, height: hgt, bits } = h;
  const N = w * hgt;
  const big = bits > 8;
  const out = big ? new Uint16Array(N) : new Uint8Array(N);
  const mark = new Uint8Array(N);
  const s = new Bits(d, h.dataOffset);
  const readLen = () => { let n = 0; while (s.bit()) n++; return s.bits(n + 1) + (1 << (n + 1)) - 1; };
  const cache = big ? new Array(128).fill(0) : null;
  const readColour = () => {
    if (!big) return s.bits(bits);
    if (s.bit()) {
      const i = s.bits(7), c = cache[i];
      cache.splice(i, 1); cache.unshift(c);
      return c;
    }
    const c = s.bits(bits);
    cache.pop(); cache.unshift(c);
    return c;
  };
  let pos = -1, c = 0, runs = 0;
  for (;;) {
    let len = readLen();
    runs++;
    while (--len > 0) {
      if (++pos >= N) return { indices: out, runs, endBit: s.p };
      if (mark[pos]) c = out[pos]; else out[pos] = c;
    }
    if (++pos >= N) return { indices: out, runs, endBit: s.p };
    c = readColour();
    out[pos] = c;
    if (s.bit()) {
      let x = pos % w, y = (pos / w) | 0;
      for (;;) {
        let dx;
        const t = s.bits(2);
        if (t) dx = t - 2;
        else { if (!s.bit()) break; dx = s.bit() ? 2 : -2; }
        x += dx; y++;
        if (y < hgt && x >= 0 && x < w) { const q = y * w + x; out[q] = c; mark[q] = 1; }
      }
    }
  }
}

// GRP: records of 3 bytes [a<<4 | b, countA, countB]: countA pixels of colour a, then countB
// pixels of colour b (a count of 0 means 256), into a buffer 1024 pixels wide. MSG04.PIC holds
// 1024x512 pixels (+512 padding); IL_OPEN expands it to $E00000 and stops after the word at
// $E50000, so the game only ever uses the first 160 lines (+ the end of the last record).
export function decodeGrp(d, palette = null, width = 1024, height = 512) {
  const N = width * height;
  const out = new Uint8Array(N);
  let pos = 0, i = 0;
  while (pos < N && i + 2 < d.length) {
    const a = d[i] >> 4, b = d[i] & 15;
    let na = d[i + 1] || 256, nb = d[i + 2] || 256;
    i += 3;
    while (na-- && pos < N) out[pos++] = a;
    while (nb-- && pos < N) out[pos++] = b;
  }
  return { format: 'grp', width, height, bits: 4, palette: palette ?? defaultGrey(), indices: out, recordsUsed: i / 3, bytesUsed: i };
}

function defaultGrey() { return Array.from({ length: 16 }, (_, i) => { const v = (i * 31 / 15) | 0; return (v << 11) | (v << 6) | (v << 1); }); }

export function companionPalette(bytes) {
  const pal = [];
  for (let i = 0; i + 1 < bytes.length && pal.length < 16; i += 2) pal.push((bytes[i] << 8) | bytes[i + 1]);
  return pal;
}

// rgba from indices. Palette modes: index 0 is drawn opaque (graphic colour 0 is transparent on
// the X68000 only when another layer is behind it; the cutscenes show it as black).
export function toRgba(img, palette = img.palette, transparent0 = false) {
  const n = img.width * img.height, rgba = new Uint8Array(n * 4);
  const lut = img.bits <= 8 ? palette.map((w) => x68kColor(w)) : null;
  for (let i = 0; i < n; i++) {
    const v = img.indices[i];
    const [r, g, b] = lut ? lut[v] : x68kColor(v);
    rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b;
    rgba[i * 4 + 3] = transparent0 && lut && v === 0 ? 0 : 255;
  }
  return rgba;
}

export function decodePic(bytes, opts = {}) {
  const d = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (!(d[0] === 0x50 && d[1] === 0x49 && d[2] === 0x43)) {
    const img = decodeGrp(d, opts.palette);
    img.x = 0; img.y = 0;
    img.rgba = toRgba(img);
    return img;
  }
  const h = parsePicHeader(d);
  const r = decodePicStream(d, h);
  const img = { format: 'pic', ...h, indices: r.indices, runs: r.runs, trailingBits: d.length * 8 - r.endBit };
  if (opts.palette) img.palette = opts.palette;
  img.rgba = toRgba(img);
  return img;
}

// ---- CLI ---------------------------------------------------------------------------------------
async function main() {
  const out = process.argv[2] ?? `${exportDir}/pic`;
  const files = allFiles().filter((f) => /^IGRP2?\//.test(f.path));
  const byDir = new Map();
  for (const f of files) {
    const [dir, name] = f.path.split('/');
    if (!byDir.has(dir)) byDir.set(dir, new Map());
    byDir.get(dir).set(name, f);
  }
  const index = [];
  for (const [dir, m] of byDir) {
    // Palette files: NAME.000 belongs to NAME.PIC, else to the PIC whose name starts with its stem
    // (OP_01.000 -> OP_01_1.PIC); FIN.000 is also the palette of MSG04.PIC (GRP), as IL_OPEN loads it.
    const pals = [...m.keys()].filter((n) => /\.\d{3}$/.test(n)).sort();
    for (const [name, f] of [...m].sort()) {
      if (!name.endsWith('.PIC')) continue;
      const stem = name.slice(0, -4);
      const mine = pals.filter((p) => p.startsWith(stem + '.') || (stem.startsWith(p.slice(0, -4) + '_') && !m.has(p.slice(0, -4) + '.PIC')));
      const isGrp = f.data[0] !== 0x50;
      const palFiles = isGrp ? ['FIN.000'] : mine;
      const extPal = isGrp ? companionPalette(m.get('FIN.000').data) : null;
      const img = decodePic(f.data, { palette: extPal });
      const base = `${out}/${dir}/${stem}`;
      writePng(`${base}.png`, img.rgba, img.width, img.height);
      // Palette indices in the red channel, for players that keep the hardware's indexed pages.
      const idx = new Uint8Array(img.width * img.height * 4);
      for (let i = 0; i < img.indices.length; i++) { idx[i * 4] = img.indices[i]; idx[i * 4 + 3] = 255; }
      writePng(`${base}.idx.png`, idx, img.width, img.height);
      const pngs = [`${stem}.png`];
      const palettes = {};
      for (const p of palFiles) {
        const pal = companionPalette(m.get(p).data);
        palettes[p] = pal.map((w) => w.toString(16).padStart(4, '0'));
        const same = pal.every((w, i) => w === img.palette[i]);
        if (!same && p.slice(-3) !== '000') { // alternate palettes (palette animation)
          writePng(`${base}.${p.slice(-3)}.png`, toRgba(img, pal), img.width, img.height);
          pngs.push(`${stem}.${p.slice(-3)}.png`);
        } else if (!same) {
          writePng(`${base}.${p.slice(-3)}.png`, toRgba(img, pal), img.width, img.height);
          pngs.push(`${stem}.${p.slice(-3)}.png`);
        }
      }
      const meta = {
        file: `${dir}\\${name}`, disk: f.disk, format: img.format, width: img.width, height: img.height,
        bits: img.bits, x: img.x, y: img.y, comment: img.comment ?? null, type: img.type ?? null,
        palette: img.palette.map((w) => w.toString(16).padStart(4, '0')),
        paletteFiles: palettes,
        pngs,
        indexPng: `${stem}.idx.png`,
        ...(img.format === 'pic' ? { runs: img.runs, trailingBits: img.trailingBits } : { recordsUsed: img.recordsUsed, bytesUsed: img.bytesUsed, fileSize: f.data.length }),
      };
      writeJson(`${base}.json`, meta);
      index.push(meta);
      console.log(`${dir}/${name}: ${img.format} ${img.width}x${img.height} ${img.bits}bit palettes=${palFiles.join(',') || '-'}`);
    }
    const unused = pals.filter((p) => !index.some((e) => e.file.startsWith(dir + '\\') && e.paletteFiles[p]));
    if (unused.length) console.log(`${dir}: palette files without a picture: ${unused.join(' ')}`);
    for (const p of unused) index.push({ file: `${dir}\\${p}`, format: 'palette', palette: companionPalette(m.get(p).data).map((w) => w.toString(16).padStart(4, '0')) });
  }
  writeJson(`${out}/index.json`, index);
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? '')).href) await main();
