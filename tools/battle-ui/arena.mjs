// Model of the battle arena (docs/battle-ui.md §2): the battle background (map table 4 layer +
// table 5 tileset, drawn by the battle redraw f_73668 with $9F260 = 1: f_7450c main layer,
// f_745ba second layer, 22 x 14 tiles at screen (192, 64)) and the combatant / effect sprites
// (sprite records $9FBDA + 32 i: 0-2 party, 3-7 enemies, 8-15 effects; CG9 frames, f_74c08 order).
// Everything is drawn into text VRAM; the model renders 768x512 palette indices of the arena.
//
//   const bg = battleBackground('A10')            // layers, metatiles, tileset (from the disk images)
//   renderBackground(bg, out)                      // arena cells, opaque main layer + masked second layer
//   const sp = parseSprites(hex)                   // sprite records (recorder 'redraw' / snapshot spr)
//   drawSprites(out, sp, cgOf)                     // cgOf(hdrOffset) -> parsed CG9 (tools/export/cg9.mjs)
import { readFile } from '../export/common.mjs';
import { parseFil, lookup } from '../export/data/fil.mjs';
import { parseLayer, parseTileset } from '../export/data/maps.mjs';
import { parseCg9, decodeSheet } from '../export/cg9.mjs';
import { ARENA } from './screen.mjs';

let FIL = null;
export const fil = () => (FIL ??= parseFil(readFile('ICITY.FIL')));

// battle tilesets carry a wrong size word (+4); the loader (f_6a2b0) never reads it
export function parseBattleTileset(b) {
  const c = Uint8Array.from(b); c[4] = b.length & 0xff; c[5] = b.length >> 8;
  return parseTileset(c);
}

export function battleBackground(mapId) {
  const me = fil().maps.find((m) => m.id === mapId);
  if (!me || !me.btlMap) return null;
  const lf = lookup(fil(), 4, me.btlMap).file, tf = lookup(fil(), 5, me.btlChr).file;
  const layer = parseLayer(readFile(lf)), ts = parseBattleTileset(readFile(tf));
  return { map: mapId, layerFile: lf, tilesetFile: tf, layer, ts, palette: ts.palette };
}

// the field palette of a map (vr tileset), faded out when a battle starts
export function fieldPalette(mapId) {
  const me = fil().maps.find((m) => m.id === mapId);
  if (!me?.vrChr) return null;
  const b = readFile(lookup(fil(), 1, me.vrChr).file);
  try { return parseTileset(b).palette; } catch { return parseBattleTileset(b).palette; }
}

// one 16 x 8 tile (lines doubled) at screen (X, Y); opaque or through its mask
function putTile(out, ts, t, X, Y, opaque, clip) {
  const tile = ts.tiles[t]; if (!tile) return;
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const sx = X + x, sy = Y + y;
    if (clip && (sx < clip.x || sx >= clip.x + clip.w || sy < clip.y || sy >= clip.y + clip.h)) continue;
    const s = (y >> 1) * 16 + x;
    if (!opaque && !tile.mask[s]) continue;
    out[sy * 768 + sx] = opaque ? tile.px[s] : (out[sy * 768 + sx] & 0) | tile.px[s];
  }
}

// f_7450c / f_745ba: 22 x 14 tiles from tile origin (ox, oy) of each layer; metatile = 2 x 2 tiles
// (TL, TR, BL, BR), cells column-major in the file (parseLayer gives cells[y][x]). How a tile is
// drawn depends on its attribute byte (tileset attribute word 2 t, low byte; f_747f0 -> cell flags,
// f_74918 draws): bit 6 set = not drawn, bit 7 = through the tile mask, neither = opaque; per cell
// the second layer first, then the main layer (an opaque main tile hides the second layer: f_747f0
// does not even list it). Traced on A10, J20, H51, B6X, I52, F60.
export function renderBackground(bg, out = new Uint8Array(768 * 512), { scroll = [0, 0], scroll2 = [0, 0], second = true, remap = null } = {}) {
  const L = bg.layer, mt = L.metatiles;
  const attr = (t) => (bg.ts.attrWords[2 * t] ?? 0) & 0xff;
  const tileAt = (lay, X, Y) => {
    const row = lay.cells[Y >> 1]; if (!row) return null;
    const cell = row[X >> 1]; if (cell === undefined) return null;
    const q = mt[cell][(Y & 1) * 2 + (X & 1)];
    return remap ? remap[q.tile] : q.tile;
  };
  for (let ty = 0; ty < ARENA.rows; ty++) for (let tx = 0; tx < ARENA.cols; tx++) {
    const X = ARENA.x + 16 * tx, Y = ARENA.y + 16 * ty;
    for (let y = 0; y < 16; y++) out.fill(0, (Y + y) * 768 + X, (Y + y) * 768 + X + 16);
    const t1 = second && L.layers[1] ? tileAt(L.layers[1], scroll2[0] + tx, scroll2[1] + ty) : null;
    const t0 = tileAt(L.layers[0], scroll[0] + tx, scroll[1] + ty);
    for (const t of [t1, t0]) {                  // second layer first, the main layer over it
      if (t === null || (attr(t) & 0x40)) continue;
      putTile(out, bg.ts, t, X, Y, !(attr(t) & 0x80), null);
    }
  }
  return out;
}

// f_73d0e (from f_73934, battle mode, every redraw before the layers are drawn): one layer's scroll.
// s = { sx, sy, ox, oy } (sub-step counters $A1B6A/$A1B6C or $A1B6E/$A1B70, tile origins $A1B72/$A1B74
// or $A1B76/$A1B78; all 0 at the start, f_731a8); h = layer header bytes { b29, b30, b31 } and the
// size in metatiles { width, height }. b29 bit 3 = auto-scroll, bits 0-2 direction (0 up, 1 up-right,
// 2 right, 3 down-right, 4 down, 5 down-left, 6 left, 7 up-left: the sign of the origin change), b31
// step, b30 threshold. Mutates and returns s. Without bit 3 the counters stay ($9F264 = $9F262 = 8,
// $9F266 = 0) and nothing moves (b30 = 0 only clears the counters).
export const SCROLL_DIRS = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]];
export function scrollStep(s, h, view = { cols: ARENA.cols, rows: ARENA.rows }) {
  const auto = (h.b29 >> 3) & 1, step = h.b31, thr = h.b30;
  let dir = 0;
  if (auto) { dir = h.b29 & 7; const [dx, dy] = SCROLL_DIRS[dir]; s.sx = (s.sx + dx * step) << 16 >> 16; s.sy = (s.sy + dy * step) << 16 >> 16; }
  let over = 0;
  if (s.sx < 0 || s.sx >= thr) over |= 0xf0;
  if (s.sy < 0 || s.sy >= thr) over |= 0x0f;
  const need = dir & 1 ? 0xff : (dir & 3) === 2 ? 0xf0 : 0x0f;   // diagonals need both axes
  if ((need & over) === need) {
    if (!thr) { s.sx = 0; s.sy = 0; return s; }
    if (2 * h.width > view.cols) {
      while (s.sx < 0) { s.ox -= step; s.sx += thr; }
      while (s.sx >= thr) { s.ox += step; s.sx -= thr; }
    }
    if (2 * h.height > view.rows) {
      while (s.sy < 0) { s.oy -= step; s.sy += thr; }
      while (s.sy >= thr) { s.oy += step; s.sy -= thr; }
    }
  }
  if (auto) {                                    // wrap the origins (period: layer size - view, in tiles)
    const px = 2 * h.width - view.cols, py = 2 * h.height - view.rows;   // > 0 for every scrolling layer
    if (px <= 0 || py <= 0) return s;            // (the original would loop forever on a negative period)
    for (let last = null; s.ox > px && s.ox !== last;) { last = s.ox; s.ox -= px; }
    for (let last = null; s.oy > py && s.oy !== last;) { last = s.oy; s.oy -= py; }
    for (let last = null; s.ox < 0 && s.ox !== last;) { last = s.ox; s.ox += px; }
    for (let last = null; s.oy < 0 && s.oy !== last;) { last = s.oy; s.oy += py; }
  }
  return s;
}

// Battle tile animation: the battle tileset's 24 animation records (tileset +$40, in the pool at
// $C500; 16 bytes: +0 period, +1 counter, +2 frame count n, +3.. n frame tiles). f_742e8 (battle
// setup) makes the remap table $CE22 the identity and points tile rec[3 + j] (j < n) at slot 3 + j;
// f_749aa(2), at the start of every battle redraw (never held), counts each record with a period
// down: counter 0, or 1 before the decrement -> counter = period and the frames rotate left by one;
// then remap[t] = the tile now in t's slot. Both layers draw remap[tile].
//   const ta = tileAnim(ts.animRecords)  ->  tileAnimStep(ta) per redraw, tileAnimRemap(ta)
export function tileAnim(animRecords) {
  const recs = [...Array(24)].map(() => new Array(16).fill(0));
  for (const r of animRecords ?? []) recs[r.index] = [...r.raw];
  const ptr = new Array(256).fill(null);         // f_742e8: tile -> [record, slot]
  recs.forEach((r, k) => { for (let j = 0; j < r[2]; j++) ptr[r[3 + j]] = [k, 3 + j]; });
  return { recs, ptr };
}
export function tileAnimStep(ta) {
  for (const r of ta.recs) {
    if (!r[0]) continue;
    if (r[1]) { r[1] = (r[1] - 1) & 255; if (r[1]) continue; }
    const n = r[2] - 1;
    if (n > 0 && n < 128) { const first = r[3]; for (let j = 0; j < n; j++) r[3 + j] = r[4 + j]; r[3 + n] = first; }
    r[1] = r[0];
  }
  return ta;
}
export function tileAnimRemap(ta) {
  const m = [...Array(256).keys()];
  ta.ptr.forEach((p, t) => { if (p) m[t] = ta.recs[p[0]][p[1]]; });
  return m;
}

// ---- sprites -------------------------------------------------------------------------------------
export function parseSprites(hex) {
  const b = Buffer.from(hex, 'hex'), out = [];
  for (let i = 0; i < b.length / 32; i++) {
    const o = 32 * i, le = (k) => b[o + k] | (b[o + k + 1] << 8), s16 = (v) => (v << 16) >> 16;
    out.push({ i, x: s16(le(0)), y: s16(le(2)), action: b[o + 4], dir: b[o + 5], step: b[o + 6], layer: b[o + 7], vis: b[o + 8], blink: b[o + 9],
      len: b[o + 14], flags15: b[o + 15], hdr: le(16), frame: le(18), raw: [...b.subarray(o, o + 32)] });
  }
  return out;
}
// CG9 header bytes in the pool: the loader rewrote the five section sizes (+6..+14) into pool offsets
export function poolSections(hex) {
  const b = Buffer.from(hex, 'hex'), le = (k) => b[k] | (b[k + 1] << 8);
  return { attributes: le(6), actions: le(8), sequences: le(10), frames: le(12), parts: le(14), size: le(4), sheetRows: le(20), actionCount: b[28] };
}
// frame index of a sprite: its frame-list pointer (+18, pool offset) relative to the frames section
export function frameIndex(cg, sec, framePtr) {
  const rel = framePtr - sec.frames;
  return cg.frames.findIndex((f) => f.offset === rel);
}

const sheets = new WeakMap();
export const sheetOf = (cg) => { let s = sheets.get(cg); if (!s) { s = decodeSheet(cg); sheets.set(cg, s); } return s; };

// draw one frame of a CG9 at sprite tile position (x, y), clipped to the arena (f_74d74 + f_753d0):
// part (px, py bottom row, w, h, column, row) -> screen x = 192 + 16 (x + px), rows bottom-up
export function drawFrame(out, cg, f, x, y, clip = ARENA, { noMask = false, sheet = null } = {}) {
  const fr = cg.frames[f]; if (!fr) return 0;
  const sh = sheet ?? sheetOf(cg);
  let n = 0;
  for (const pi of fr.parts) {
    const p = cg.parts[pi]; if (!p || p.skipped) continue;
    const X0 = ARENA.x + 16 * (x + p.x), Y0 = ARENA.y + 16 * (y + p.y - p.h + 1);
    for (let yy = 0; yy < 16 * p.h; yy++) for (let xx = 0; xx < 16 * p.w; xx++) {
      const X = X0 + xx, Y = Y0 + yy;
      if (X < clip.x || X >= clip.x + clip.w || Y < clip.y || Y >= clip.y + clip.h) continue;
      const sx = 16 * p.col + xx, sy = 8 * p.topRow + (yy >> 1);
      if (sy < 0 || sy >= sh.H || sx >= sh.W) continue;
      const s = sy * sh.W + sx, d = Y * 768 + X;
      if (sh.mask[s] && !noMask) out[d] = 0;
      out[d] |= sh.idx[s];
      n++;
    }
  }
  return n;
}

// draw order of f_74c08: visible sprites (+8 bit 7) sorted by layer (+7), then by y (smaller first);
// ties keep the record order
export function drawOrder(sprites) {
  return sprites.filter((s) => s.vis & 0x80).map((s, k) => ({ s, k })).sort((a, b) => (a.s.layer - b.s.layer) || (a.s.y - b.s.y) || (a.k - b.k)).map((x) => x.s);
}

// cache of parsed CG9 files by disk path
const cgCache = new Map();
export function cg9(path) { if (!cgCache.has(path)) cgCache.set(path, parseCg9(readFile(path))); return cgCache.get(path); }

// a CG9 without a sheet borrows the sheet loaded before it: f_68dac mode 0 loads table 12 #4
// (GROUP00/000056) and #5 (GROUP00/000057, no sheet) and copies #4's sheet pointer into #5's slot
export const SHARED_SHEET = { 'GROUP00/000057.DAT': 'GROUP00/000056.DAT' };
export function sharedSheetCg(path) { return cg9(SHARED_SHEET[path] ?? path); }

// 16 x 16 screen cells covered by the parts of the visible sprites (the cells the redraw repaints
// every pass besides the dirty-map cells); keys "X,Y" of the cell's top-left screen pixel
export function spriteCells(sprites, cgOf) {
  const out = new Set();
  for (const sp of sprites) {
    if (!(sp.vis & 0x80)) continue;
    const c = cgOf(sp.hdr); if (!c?.cg) continue;
    const f = frameIndex(c.cg, c.sec, sp.frame); const fr = c.cg.frames[f]; if (!fr) continue;
    for (const pi of fr.parts) {
      const p = c.cg.parts[pi]; if (!p || p.skipped) continue;
      for (let j = 0; j < p.h; j++) for (let i = 0; i < p.w; i++) out.add(`${ARENA.x + 16 * (sp.x + p.x + i)},${ARENA.y + 16 * (sp.y + p.y - p.h + 1 + j)}`);
    }
  }
  return out;
}
