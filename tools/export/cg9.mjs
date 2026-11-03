// CG9 sprite containers (GROUPxx/*.DAT starting with "CG9\0", YORO98.CG9): parser and exporter.
// Format spec: docs/formats/cg9.md. Loader in ICITY68: f_692aa ($692aa); sprite engine
// (hand-written assembly) f_75504/f_755e0 (animation), f_74d74 (frame -> draw list),
// f_753d0 + f_8710c (blit 16x8 cells into text VRAM with line doubling).
//
//   node tools/export/cg9.mjs            export every CG9 to ../work/export/cg9/<dir>/<name>.{png,json}
//   node tools/export/cg9.mjs --native   sheet PNGs without line doubling (16x8 cells)
//   node tools/export/cg9.mjs FILE...    dump the parsed structure of single files (disk paths)
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lzss } from './lzss.mjs';

export const CELL_W = 16;          // pixels
export const CELL_H = 8;           // stored rows; drawn on 16 scanlines (each row twice)
export const CELL_BYTES = 80;      // mask plane + 4 colour planes, 8 big-endian words each
export const SHEET_COLS = 32;      // cells per sheet row (one 2560-byte "row" of the sheet)
export const ROW_BYTES = SHEET_COLS * CELL_BYTES;

// Text palette of the first map (ICITY68 writes it through f_87bcc from 12-bit
// PC-98-style data that belongs to the map, not to the CG9 file). Index 0 is transparent:
// the sprites are drawn into text VRAM, where colour 0 shows the layers below.
export const DEFAULT_PALETTE = [
  0x529d, 0x0001, 0x5295, 0xb5a5, 0x328d, 0x939d, 0x358d, 0x94ad,
  0x739d, 0x538d, 0x758d, 0xb781, 0x71ad, 0xb3bd, 0xd7a5, 0xf7bd,
];

export function isCg9(b) { return b.length >= 32 && b[0] === 0x43 && b[1] === 0x47 && b[2] === 0x39 && b[3] === 0; }

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const s8 = (v) => (v << 24) >> 24;

export function parseCg9(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (!isCg9(b)) throw new Error('not a CG9 file');
  const header = {
    magic: 'CG9',
    fileSize: u16(b, 4),                 // bytes the loader reads (some files carry trailing padding)
    sectionSizes: {
      attributes: u16(b, 6),             // 32 or 0
      actions: u16(b, 8),
      sequences: u16(b, 10),
      frames: u16(b, 12),
      parts: u16(b, 14),
    },
    packedSize: u16(b, 16),              // LZSS bytes at the end of the file (0 = no pixel data)
    unpackedSize: u16(b, 18),            // = sheetRows * 2560
    sheetRows: u16(b, 20),               // rows of 32 cells in the sheet
    field22: u16(b, 22),                 // always 0
    field24: u16(b, 24),                 // not read by ICITY68 (tool checksum/stamp?)
    field26: u16(b, 26),                 // not read by ICITY68
    actionCount: b[28],                  // read by f_75504
    sequenceCount: b[29],                // not read (= number of sequences)
    frameCount: b[30],                   // not read (= frame lists, mod 256)
    partCount: b[31],                    // not read (= parts, mod 256)
  };
  const s = header.sectionSizes;
  const off = {}; let o = 32;
  for (const k of ['attributes', 'actions', 'sequences', 'frames', 'parts']) { off[k] = o; o += s[k]; }
  const packedOffset = o;
  header.packedOffset = packedOffset;
  const end = packedOffset + header.packedSize;
  if (end > b.length) throw new Error(`truncated: sections+packed end at ${end}, file is ${b.length}`);

  // Section 1: 32 bytes of object attributes read by game logic (f_77d20 copies [2], [10], [11]
  // into the object; [4] and [9] are compared elsewhere). Meaning mostly unknown.
  const attributes = s.attributes ? [...b.subarray(off.attributes, off.attributes + s.attributes)] : null;

  // Section 2: action table, 4 bytes per entry: action id (byte 0), direction/variant
  // (byte 1), u16 offset of the sequence inside section 3. f_75504 looks up (dir<<8)|action
  // and falls back to the first entry.
  const actions = [];
  for (let i = 0; i + 4 <= s.actions; i += 4) {
    const p = off.actions + i;
    actions.push({ action: b[p], dir: b[p + 1], sequenceOffset: u16(b, p + 2) });
  }

  // Section 3: animation sequences, addressed by byte offset. Each: u8 sound id, u8 length,
  // then length x {u8 flags, u8 frame index}. Flag bit 1 plays the sound (f_66a5c) when the
  // frame is shown. f_755e0 advances one step per call and wraps.
  const sequences = new Map();
  for (const a of actions) {
    const at = a.sequenceOffset;
    if (sequences.has(at) || at + 2 > s.sequences) continue;
    const p = off.sequences + at, n = b[p + 1], steps = [];
    for (let k = 0; k < n && at + 2 + 2 * k + 2 <= s.sequences; k++) steps.push({ flags: b[p + 2 + 2 * k], frame: b[p + 3 + 2 * k] });
    sequences.set(at, { offset: at, sound: b[p], steps });
  }
  for (const a of actions) a.sequence = [...sequences.keys()].indexOf(a.sequenceOffset);

  // Section 4: frames. u16 offset table (relative to the section; its length is given by the
  // first offset), then per frame: u8 part count, part indices (into section 5).
  const frames = [];
  const readFrame = (i) => {
    const fo = u16(b, off.frames + 2 * i);
    if (fo >= s.frames) return { offset: fo, parts: [], bad: true };
    const c = b[off.frames + fo], parts = [];
    for (let k = 0; k < c && fo + 1 + k < s.frames; k++) parts.push(b[off.frames + fo + 1 + k]);
    return { offset: fo, parts };
  };
  if (s.frames >= 2) {
    const n = Math.min(u16(b, off.frames), s.frames) >> 1;
    for (let i = 0; i < n; i++) frames.push(readFrame(i));
    // A few sequences index past the offset table; the engine then reads the following bytes
    // as an offset (GROUP01/000042 frame 12 -> offset 1 -> empty list). Reproduce that.
    const maxRef = Math.max(-1, ...[...sequences.values()].flatMap((q) => q.steps.map((st) => st.frame)));
    for (let i = n; i <= maxRef && off.frames + 2 * i + 1 < off.frames + s.frames; i++) frames.push({ ...readFrame(i), outsideTable: true });
  }

  // Section 5: parts, 8 bytes: u16 unknown (never read by the engine), s8 x (cells, 16 px),
  // s8 y = bottom row (cells, 8 stored rows), u8 width, u8 height (cells), u8 sheet column and
  // u8 sheet row of the bottom-left cell. The engine draws rows bottom-up.
  const parts = [];
  for (let i = 0; i + 8 <= s.parts; i += 8) {
    const p = off.parts + i;
    const part = { unk: u16(b, p), x: s8(b[p + 2]), y: s8(b[p + 3]), w: b[p + 4], h: b[p + 5], col: b[p + 6], row: b[p + 7] };
    part.topRow = part.row - part.h + 1;   // sheet rect: cols col..col+w-1, rows topRow..row
    if (part.row >= header.sheetRows) part.skipped = true;   // f_74d74 ignores these parts
    parts.push(part);
  }

  let sheet = null;
  if (header.packedSize) {
    const r = lzss(b, header.unpackedSize, packedOffset);
    sheet = { data: r.data, written: r.written, consumed: r.consumed };
  }
  return { header, offsets: off, attributes, actions, sequences: [...sequences.values()], frames, parts, sheet, trailing: b.length - end };
}

// One cell -> 16x8 colour indices (0-15) and mask bits.
export function decodeCell(data, cell) {
  const base = cell * CELL_BYTES, idx = new Uint8Array(CELL_W * CELL_H), mask = new Uint8Array(CELL_W * CELL_H);
  for (let y = 0; y < CELL_H; y++) {
    const w = (pl) => (data[base + pl * 16 + y * 2] << 8) | data[base + pl * 16 + y * 2 + 1];
    const m = w(0), p0 = w(1), p1 = w(2), p2 = w(3), p3 = w(4);
    for (let x = 0; x < CELL_W; x++) {
      const bit = 15 - x;
      idx[y * CELL_W + x] = ((p0 >> bit) & 1) | (((p1 >> bit) & 1) << 1) | (((p2 >> bit) & 1) << 2) | (((p3 >> bit) & 1) << 3);
      mask[y * CELL_W + x] = (m >> bit) & 1;
    }
  }
  return { idx, mask };
}

// Whole sheet as indices + mask: width 512, height rows*8 (stored rows).
export function decodeSheet(cg) {
  const rows = cg.header.sheetRows, W = SHEET_COLS * CELL_W, H = rows * CELL_H;
  const idx = new Uint8Array(W * H), mask = new Uint8Array(W * H);
  if (!cg.sheet) return { W, H, idx, mask };
  const cells = Math.min(rows * SHEET_COLS, cg.sheet.data.length / CELL_BYTES | 0);
  for (let c = 0; c < cells; c++) {
    const d = decodeCell(cg.sheet.data, c), cx = (c % SHEET_COLS) * CELL_W, cy = (c / SHEET_COLS | 0) * CELL_H;
    for (let y = 0; y < CELL_H; y++) for (let x = 0; x < CELL_W; x++) {
      idx[(cy + y) * W + cx + x] = d.idx[y * CELL_W + x];
      mask[(cy + y) * W + cx + x] = d.mask[y * CELL_W + x];
    }
  }
  return { W, H, idx, mask };
}

// Pixel bounds of a frame relative to the anchor (top-left of the object's cell), in
// displayed pixels (rows doubled when yScale = 2).
export function frameBounds(cg, f, yScale = 2) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const pi of cg.frames[f].parts) {
    const p = cg.parts[pi]; if (!p || p.skipped) continue;
    const px = p.x * CELL_W, py = (p.y - p.h + 1) * CELL_H * yScale;
    x0 = Math.min(x0, px); y0 = Math.min(y0, py);
    x1 = Math.max(x1, px + p.w * CELL_W); y1 = Math.max(y1, py + p.h * CELL_H * yScale);
  }
  return x0 === Infinity ? null : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// Compose a frame as the engine draws it (parts in list order; a later part's mask clears
// what earlier parts drew, then ORs its planes). Returns indices + "covered" mask.
export function composeFrame(cg, sheetPix, f, yScale = 2) {
  const bb = frameBounds(cg, f, yScale);
  if (!bb) return null;
  const idx = new Uint8Array(bb.w * bb.h), cov = new Uint8Array(bb.w * bb.h);
  for (const pi of cg.frames[f].parts) {
    const p = cg.parts[pi]; if (!p || p.skipped) continue;
    const px = p.x * CELL_W - bb.x, py = (p.y - p.h + 1) * CELL_H * yScale - bb.y;
    for (let y = 0; y < p.h * CELL_H * yScale; y++) for (let x = 0; x < p.w * CELL_W; x++) {
      const sy = (p.topRow * CELL_H) + (y / yScale | 0), sx = p.col * CELL_W + x;
      if (sx >= sheetPix.W || sy < 0 || sy >= sheetPix.H) continue;
      const s = sy * sheetPix.W + sx, d = (py + y) * bb.w + px + x;
      if (sheetPix.mask[s]) { idx[d] = 0; cov[d] = 1; }
      idx[d] |= sheetPix.idx[s];
      if (sheetPix.idx[s]) cov[d] = 1;
    }
  }
  return { ...bb, idx, cov };
}

export function toRgba(idx, n, palette, x68kColor) {
  const out = new Uint8Array(n * 4);
  const cols = palette.map(x68kColor);
  for (let i = 0; i < n; i++) { const c = idx[i]; if (!c) continue; out.set([...cols[c], 255], i * 4); }
  return out;
}

// ---- CLI ---------------------------------------------------------------------------------
async function main(args) {
  const { allFiles, readFile, writePng, writeJson, x68kColor, exportDir } = await import('./common.mjs');
  const native = args.includes('--native');
  const yScale = native ? 1 : 2;
  const files = args.filter((a) => !a.startsWith('--'));
  if (files.length) {
    for (const f of files) {
      const cg = parseCg9(readFile(f));
      const { sheet, ...rest } = cg;
      console.log(f, JSON.stringify(rest, null, 1), sheet && { written: sheet.written, consumed: sheet.consumed });
    }
    return;
  }
  const outRoot = `${exportDir}/cg9`;
  const seen = new Map();      // path -> entries; identical copies on several disks are merged
  const index = [];
  let nFiles = 0, nPng = 0;
  const problems = [];
  for (const f of allFiles()) {
    if (!isCg9(f.data)) continue;
    nFiles++;
    const key = Buffer.from(f.data).toString('base64');
    const prev = seen.get(f.path);
    let dir = path.dirname(f.path); if (dir === '.') dir = 'root';
    let name = path.basename(f.path).replace(/\.[^.]*$/, '');
    if (prev) {
      const same = prev.find((e) => e.key === key);
      if (same) { same.disks.push(f.disk); continue; }
      name += `_d${f.disk}`;
    }
    const entry = { path: f.path, disks: [f.disk], key, dir, name, data: f.data };
    if (prev) prev.push(entry); else seen.set(f.path, [entry]);
    index.push(entry);
  }
  for (const entry of index) {
    const { dir, name } = entry, f = { path: entry.path, disk: entry.disks[0], data: entry.data };
    let cg;
    try { cg = parseCg9(f.data); } catch (e) { problems.push(`${f.path} (disk ${f.disk}): ${e.message}`); continue; }
    const base = `${outRoot}/${dir}/${name}`;
    const sp = decodeSheet(cg);
    if (cg.sheet) {
      if (cg.sheet.written !== cg.header.unpackedSize || cg.sheet.consumed !== cg.header.packedSize)
        problems.push(`${f.path}: LZSS wrote ${cg.sheet.written}/${cg.header.unpackedSize}, read ${cg.sheet.consumed}/${cg.header.packedSize}`);
      const H = sp.H * yScale, rgba = new Uint8Array(sp.W * H * 4), cols = DEFAULT_PALETTE.map(x68kColor);
      for (let y = 0; y < H; y++) for (let x = 0; x < sp.W; x++) {
        const c = sp.idx[(y / yScale | 0) * sp.W + x]; if (c) rgba.set([...cols[c], 255], (y * sp.W + x) * 4);
      }
      writePng(`${base}.png`, rgba, sp.W, H); nPng++;
      // Index sheet for palette-based renderers: red = colour index, alpha = mask (drawn pixels).
      const ix = new Uint8Array(sp.W * H * 4);
      for (let y = 0; y < H; y++) for (let x = 0; x < sp.W; x++) {
        const k = (y / yScale | 0) * sp.W + x, o = (y * sp.W + x) * 4;
        ix[o] = sp.idx[k]; ix[o + 3] = sp.mask[k] ? 255 : 0;
      }
      writePng(`${base}.idx.png`, ix, sp.W, H);
    }
    // Frames atlas: every frame composed, laid out left to right in rows of up to 1024 px.
    const frameOut = [];
    let ax = 0, ay = 0, rowH = 0; const placed = [];
    cg.frames.forEach((fr, i) => {
      const c = cg.sheet ? composeFrame(cg, sp, i, yScale) : null;
      const bb = frameBounds(cg, i, yScale);
      const o = { index: i, parts: fr.parts, bounds: bb };
      if (fr.bad) o.bad = true;
      if (c) {
        if (ax + c.w > 1024) { ax = 0; ay += rowH; rowH = 0; }
        o.atlas = { x: ax, y: ay, w: c.w, h: c.h };
        placed.push([c, ax, ay]); ax += c.w; rowH = Math.max(rowH, c.h);
      }
      frameOut.push(o);
    });
    if (placed.length) {
      const AW = Math.max(...placed.map(([c, x]) => x + c.w)), AH = ay + rowH;
      const rgba = new Uint8Array(AW * AH * 4), cols = DEFAULT_PALETTE.map(x68kColor);
      for (const [c, x0, y0] of placed) for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) {
        const v = c.idx[y * c.w + x]; if (v) rgba.set([...cols[v], 255], ((y0 + y) * AW + x0 + x) * 4);
      }
      writePng(`${base}.frames.png`, rgba, AW, AH);
    }
    const cellH = CELL_H * yScale;
    writeJson(`${base}.json`, {
      source: f.path, disks: entry.disks, format: 'CG9',
      header: cg.header,
      sheet: cg.sheet ? {
        image: `${name}.png`, indexImage: `${name}.idx.png`, width: sp.W, height: sp.H * yScale, columns: SHEET_COLS, rows: cg.header.sheetRows,
        cell: { w: CELL_W, h: cellH }, storedCell: { w: CELL_W, h: CELL_H }, yScale,
        transparentIndex: 0,
        note: 'pixels are colour indices into the 16-colour text palette; index 0 is transparent (text layer). Stored rows are 8 per cell; the game draws every row twice.',
      } : { image: null, note: 'no pixel data in this file (packedSize 0): the engine uses a sheet loaded with another file' },
      palette: { source: 'text palette of the first map (not stored in CG9)', x68k: DEFAULT_PALETTE.map((v) => `0x${v.toString(16).padStart(4, '0')}`), rgb: DEFAULT_PALETTE.map(x68kColor) },
      attributes: cg.attributes,
      actions: cg.actions,
      sequences: cg.sequences,
      frames: frameOut,
      framesImage: placed.length ? `${name}.frames.png` : null,
      parts: cg.parts.map((p) => ({ ...p,
        sheetRect: { x: p.col * CELL_W, y: p.topRow * cellH, w: p.w * CELL_W, h: p.h * cellH },
        offset: { x: p.x * CELL_W, y: (p.y - p.h + 1) * cellH } })),
      units: `part x/y are in cells (${CELL_W} px horizontally, ${cellH} px vertically); offsets are relative to the top-left of the object's anchor cell, and y is the bottom row of the part`,
      trailingBytes: cg.trailing,
    });
  }
  // Mark copies on several disks in the JSON index.
  writeJson(`${outRoot}/index.json`, index.map(({ key, data, dir, name, ...e }) => ({ ...e, out: `${dir}/${name}` })));
  console.log(`${nFiles} CG9 files on disk, ${index.length} distinct, ${nPng} sheets written to ${outRoot}`);
  if (problems.length) console.log('problems:\n  ' + problems.join('\n  '));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await main(process.argv.slice(2));
