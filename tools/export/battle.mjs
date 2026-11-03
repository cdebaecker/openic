// Battle-screen assets for the port (docs/battle-ui.md): battle backgrounds, the battle sprite sets
// (party, enemies, effects) as index sheets + animation JSON, and the screen constants (selector
// menus, windows, positions, message templates, music). Game data: written to ../work/export/battle.
//
//   node tools/export/battle.mjs        -> ../work/export/battle/
//     index.json                         what was written (and the format notes below)
//     backgrounds/<file>.json            battle layer (file table 4) + tileset (table 5): sizes, cells, metatiles,
//                                        palette (0GRB, X68000 words, RGB), tile animation, the maps using it
//     backgrounds/<file>.layer0.idx.png  the main layer, 32 x 32 px per metatile (lines doubled), red = colour index
//     backgrounds/<file>.layer1.idx.png  the second layer (alpha = tile mask), when present
//     backgrounds/<file>.tiles.idx.png   the tileset (16 tiles per row, 16 x 16), red = index, alpha = mask
//     backgrounds/<file>.arena.png       RGB preview of the 22 x 14-tile arena at origin (0, 0), as drawn in battle
//                                        (per tile attribute: bit 6 hidden, bit 7 masked, else opaque; second layer under the main)
//     sprites/<GROUPnn_nnnnnn>.idx.png   CG9 sheet (512 px wide, rows doubled), red = colour index, alpha = mask
//     sprites/<GROUPnn_nnnnnn>.json      roles (party character / enemy / effect set), actions -> sequences
//                                        (frame, flags: bit 0 impact (effect trigger), bit 1 sound, bit 2 hook),
//                                        frames -> parts with sheet rectangles and pixel offsets
//     screen.json                        layout, selector menus per character, status marks, templates, timings
//     music.json                         battle music per map (music2) and the jingles
//     effects.json                       effect sprite sets: 0/1 (table 12 #4/#5) and set 2 per map (table 10, f_68dac(1, 1))
import { readFile, writePng, writeJson, exportDir, x68kColor } from './common.mjs';
import { parseFil, lookup } from './data/fil.mjs';
import { parseLayer } from './data/maps.mjs';
import { parseRpt } from './data/misc.mjs';
import { parseCg9, decodeSheet, isCg9, CELL_W, CELL_H } from './cg9.mjs';
import { parseBattleTileset, SHARED_SHEET, renderBackground } from '../battle-ui/arena.mjs';
import * as S from '../battle-ui/screen.mjs';
import { paletteWord } from '../battle-ui/anim.mjs';

const OUT = `${exportDir}/battle`;
const td = new TextDecoder('shift_jis');
const sjis = (bytes) => td.decode(Uint8Array.from(bytes));
const grb = (c) => [((c >> 4) & 15) * 17, ((c >> 8) & 15) * 17, (c & 15) * 17];
const safe = (p) => p.replace(/\.DAT$/i, '').replace(/[\\/]/g, '_');

const fil = parseFil(readFile('ICITY.FIL'));
let rpt = [];
try { rpt = parseRpt(readFile('ICITY.RPT')); } catch { rpt = []; }
const rptName = (file) => rpt.find((r) => r.file === file)?.name ?? null;

// ---- backgrounds ---------------------------------------------------------------------------------
function exportBackgrounds() {
  const pairs = new Map();
  for (const m of fil.maps) {
    if (!m.btlMap) continue;
    const k = `${m.btlMap}/${m.btlChr}`;
    if (!pairs.has(k)) pairs.set(k, { btlMap: m.btlMap, btlChr: m.btlChr, maps: [] });
    pairs.get(k).maps.push(m.id);
  }
  const out = [];
  for (const p of pairs.values()) {
    const lf = lookup(fil, 4, p.btlMap)?.file, tf = lookup(fil, 5, p.btlChr)?.file;
    if (!lf || !tf) continue;
    const layer = parseLayer(readFile(lf)), ts = parseBattleTileset(readFile(tf));
    const name = safe(lf);
    const layerPng = (lay, masked) => {
      const W = lay.width * 32, H = lay.height * 32, rgba = new Uint8Array(W * H * 4);
      for (let my = 0; my < lay.height; my++) for (let mx = 0; mx < lay.width; mx++) {
        layer.metatiles[lay.cells[my][mx]].forEach((q, k) => {
          const t = ts.tiles[q.tile]; if (!t) return;
          for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
            const s = (y >> 1) * 16 + x, o = ((my * 32 + (k >> 1) * 16 + y) * W + mx * 32 + (k & 1) * 16 + x) * 4;
            if (masked && !t.mask[s]) continue;
            rgba[o] = t.px[s]; rgba[o + 3] = 255;
          }
        });
      }
      return { rgba, W, H };
    };
    const l0 = layerPng(layer.layers[0], false);
    writePng(`${OUT}/backgrounds/${name}.layer0.idx.png`, l0.rgba, l0.W, l0.H);
    if (layer.layers[1]) { const l1 = layerPng(layer.layers[1], true); writePng(`${OUT}/backgrounds/${name}.layer1.idx.png`, l1.rgba, l1.W, l1.H); }
    // tileset atlas
    const TW = 256, TH = Math.ceil(ts.tiles.length / 16) * 16, atlas = new Uint8Array(TW * TH * 4);
    ts.tiles.forEach((t, i) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { const s = (y >> 1) * 16 + x, o = (((i >> 4) * 16 + y) * TW + (i & 15) * 16 + x) * 4; atlas[o] = t.px[s]; atlas[o + 3] = t.mask[s] ? 255 : 0; } });
    writePng(`${OUT}/backgrounds/${name}.tiles.idx.png`, atlas, TW, TH);
    // arena preview: the battle redraw at origin (0, 0) (arena.renderBackground: attribute rules)
    const pal = ts.palette.map(paletteWord).map(x68kColor);
    const A = S.ARENA, prev = new Uint8Array(A.w * A.h * 4), idx = renderBackground({ layer, ts });
    for (let y = 0; y < A.h; y++) for (let x = 0; x < A.w; x++) {
      const c = pal[idx[(A.y + y) * 768 + A.x + x]], o = (y * A.w + x) * 4;
      prev[o] = c[0]; prev[o + 1] = c[1]; prev[o + 2] = c[2]; prev[o + 3] = 255;
    }
    writePng(`${OUT}/backgrounds/${name}.arena.png`, prev, A.w, A.h);
    const json = {
      layerFile: lf, tilesetFile: tf, names: { layer: rptName(lf), tileset: rptName(tf) }, maps: p.maps,
      layers: layer.layers.map((l, i) => { const h = i ? layer.secondHeader : layer.header; return { width: l.width, height: l.height, cells: l.cells, image: `${name}.layer${i}.idx.png`, masked: i > 0, scroll: { b29: h.tail[9], b30: h.tail[10], b31: h.tail[11], note: 'f_73d0e each redraw (tools/battle-ui/arena.mjs scrollStep): b29 bit 3 auto-scroll, bits 0-2 direction, b31 step, b30 threshold' } }; }),
      metatiles: layer.metatiles.map((m) => m.map((q) => q.raw)),
      tileset: { image: `${name}.tiles.idx.png`, count: ts.tiles.length, attrWords: ts.attrWords },
      palette: { grb: ts.palette, x68k: ts.palette.map(paletteWord), rgb: ts.palette.map(grb), note: 'text palette in battle (f_782d4 with $9DD4E+$C862); 0GRB -> G<<12 | R<<7 | B<<2 | 1' },
      tileAnimation: ts.animRecords,
      arena: { ...S.ARENA, origin: [0, 0], note: '22 x 14 tiles of 16 x 16 px at screen (192, 64); main layer opaque, second layer through tile masks, both from the battle tileset and from tile origin ($A1B72.. = 0 at the start, then scrollStep)' },
    };
    writeJson(`${OUT}/backgrounds/${name}.json`, json);
    out.push({ name, maps: p.maps, layer: lf, tileset: tf, size: layer.layers.map((l) => [l.width * 2, l.height * 2]) });
  }
  return out;
}

// ---- sprite sets ---------------------------------------------------------------------------------
function cgJson(path, cg, sheetCg, roles) {
  const name = safe(path);
  let image = null;
  if (sheetCg?.sheet) {
    const sp = decodeSheet(sheetCg), H = sp.H * 2, ix = new Uint8Array(sp.W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < sp.W; x++) { const k = (y >> 1) * sp.W + x, o = (y * sp.W + x) * 4; ix[o] = sp.idx[k]; ix[o + 3] = sp.mask[k] ? 255 : 0; }
    image = `${safe(sheetCg === cg ? path : SHARED_SHEET[path])}.idx.png`;
    if (sheetCg === cg) writePng(`${OUT}/sprites/${name}.idx.png`, ix, sp.W, H);
  }
  writeJson(`${OUT}/sprites/${name}.json`, {
    file: path, name: rptName(path), roles, image, sharedSheet: SHARED_SHEET[path] ?? null,
    sheetRows: cg.header.sheetRows, attributes: cg.attributes,
    actions: cg.actions.map((a) => ({ action: a.action, dir: a.dir, sequence: a.sequence })),
    sequences: cg.sequences.map((q) => ({ sound: q.sound, steps: q.steps })),
    frames: cg.frames.map((f) => ({ parts: f.parts })),
    parts: cg.parts.map((p) => ({ x: p.x, y: p.y, w: p.w, h: p.h, col: p.col, row: p.row, skipped: !!p.skipped,
      sheetRect: { x: p.col * CELL_W, y: (p.row - p.h + 1) * CELL_H * 2, w: p.w * CELL_W, h: p.h * CELL_H * 2 },
      offset: { x: p.x * CELL_W, y: (p.y - p.h + 1) * CELL_H * 2 } })),
    notes: {
      units: 'part x/y in cells (16 x 16 screen px); a sprite at arena tile (tx, ty) draws part p at screen (192 + 16 (tx + p.x), 64 + 16 (ty + p.y - p.h + 1)), parts in list order (mask clears, then colour ORed), clipped to the arena',
      flags: 'sequence step flags: bit 0 impact frame (spawns the effect sprite when the action struct asks for one, f_6cd3c), bit 1 play the sequence sound (f_66a5c), bit 2 impact callback (damage / messages, $6BC10)',
      timing: 'one step per battle redraw; a redraw waits for $9CB2E[1] vsyncs since the previous one (4 at the default speed); sequences loop, one-shots stop when the step counter wraps',
    },
  });
  return name;
}

function exportSprites() {
  const roles = new Map();      // path -> roles
  const add = (path, role) => { if (!path) return; if (!roles.has(path)) roles.set(path, []); roles.get(path).push(role); };
  const t9 = fil.tables[9].entries, t8 = fil.tables[8].entries;
  for (const e of t9) add(e.file, e.index <= 8 ? { kind: 'party', charId: e.index - 1, table: 9, index: e.index } : { kind: 'battle', table: 9, index: e.index, field: t8.find((x) => x.index === e.index)?.file ?? null });
  for (const e of fil.tables[10].entries) add(e.file, { kind: 'special', table: 10, index: e.index });
  for (const e of fil.tables[12].entries) add(e.file, { kind: e.index === 4 ? 'effects0' : e.index === 5 ? 'effects1' : 'common', table: 12, index: e.index });
  // field sets of enemies (CG9 attribute byte 9 = 4: touching starts a battle); enemies fight with their own set
  for (const e of t8) {
    const d = readFile(e.file); if (!d || !isCg9(d)) continue;
    try { const cg = parseCg9(d); if (cg.attributes && cg.attributes[9] === 4) add(e.file, { kind: 'enemy', table: 8, index: e.index }); } catch { /* skip */ }
  }
  const out = [];
  for (const [path, r] of roles) {
    const d = readFile(path); if (!d || !isCg9(d)) continue;
    let cg; try { cg = parseCg9(d); } catch { continue; }
    const sheetCg = cg.sheet ? cg : SHARED_SHEET[path] ? parseCg9(readFile(SHARED_SHEET[path])) : null;
    const name = cgJson(path, cg, sheetCg, r);
    out.push({ name, file: path, roles: r, actions: cg.actions.length, frames: cg.frames.length });
  }
  return out;
}

// ---- screen constants ------------------------------------------------------------------------------
function exportScreen() {
  const menus = {};
  for (let c = 0; c < 8; c++) for (const idle of c === 2 ? [6, 0x0f] : [6]) {
    const m = S.commandMenu(c, idle);
    menus[c === 2 && idle === 0x0f ? '2-wolf' : String(c)] = { start: m.start, items: m.items.map((it) => ({ label: sjis(it.label), bytes: Buffer.from(it.label).toString('base64'), code: it.code, command: it.command })) };
  }
  const templates = {};
  for (const [k, a] of Object.entries(S.TEMPLATES)) templates[k] = { address: `$${a.toString(16).toUpperCase()}`, ja: sjis(S.cstr(a)), bytes: Buffer.from(S.cstr(a)).toString('base64') };
  const marks = [0x8d0ce, 0x8d0d0, 0x8d0d2, 0x8d0d4, 0x8d0d6, 0x8d0d8, 0x8d0da].map((a) => sjis([S.byte(a), S.byte(a + 1)]));
  writeJson(`${OUT}/screen.json`, {
    arena: S.ARENA, windows: S.WINDOWS, partyPositions: S.PARTY_POS,
    selector: { window: S.WINDOWS.selector, labelCell: 'item k at window cell (0, 3k) = screen (624, 80 + 48k)', pointer: 'ASDF tile 74 (pointer) / 79 (none) at text (592, 80 + 48k)', menus },
    target: { hitBox: 'combatant at arena tile (x, y): screen x 192 + 16x .. +48, y 16y - 16 .. +96', marker: 'ASDF 84 at text (64 + 16 (x + 9), 48 + 16 (y - 4)) and 89 16 lines below, blinking every 10 frames' },
    panel: { hp: 'ASDF digits at text (112, 112 + 96 slot)', mp: '(112, 128 + 96 slot)', digits: '50 + d (40 + d when the value is 0), blank tile 0, 3 digits right-aligned, clamped to 999' },
    status: { head: sjis(S.cstr(0x8d0b2)), marks, rule: 'name padded to 12 bytes + 7 marks (縛 +3 bit 6, 麻 bit 2, 毒 bit 1, 封 +11, 幻 +12, 眠 +15, 乱 +16), default －' },
    templates,
    placeholders: { '#n': 'signed decimal of number n', '*n': 'number n right-aligned in 6 columns', '$n': 'string slot n (character / enemy name, item, weapon, spell; see docs §3.5)', '$$': '$' },
    timing: { redraw: 'battle redraw waits $9CB2E[1] vsyncs (battle speed, default 4)', message: 'after each message f_75948($9CB32) (message speed)', fadeIn: 'one step every 2 vsyncs, gun = min(target, k), k = 1..15', fadeOut: 'one step per vsync, gun = max(0, gun - k)' },
  });
}

function exportMusic() {
  const maps = {};
  for (const m of fil.maps) if (m.btlMap) maps[m.id] = { field: m.music, battle: m.music2, file: lookup(fil, 7, m.music2)?.file ?? null };
  writeJson(`${OUT}/music.json`, {
    battleMusic: maps, note: 'battle music = the map\'s second track (ICITY.FIL map entry +11, music slot 1, f_66988 from f_72fde); audio/music/bgm_NN.ogg in the audio export',
    jingles: { victory: 2, source: 'IC98.BEM jingle n via f_6df30(n) (not in event battles)' },
  });
}

// ---- effect set 2 per map (f_6ce6c -> f_68dac(1, 1)) ---------------------------------------------
// An action whose trigger $A1AC6 is 2 (every enemy action, f_6e9ec) shows its impact-frame effect
// from slot 20 ($9FA6A). f_68dac mode 1 walks the map's sprite-set ids (EVT actor block $A04DC,
// count = EVT header +16 = $A063C) and takes the first id whose byte 2 of the 3-byte ICITY.FIL record
// at 3229 + 3 id is non-zero: that byte is a table 10 index (the boss's effect sheet). No such id:
// nothing is loaded and slot 20 keeps whatever the field left there (the port shows no effect).
function exportEffects() {
  const raw = readFile('ICITY.FIL'), maps = {};
  for (const m of fil.maps) {
    const e = lookup(fil, 6, m.evt); if (!e) continue;
    const d = readFile(e.file); if (!d || d.length < 48) continue;
    const count = Math.min(d[16], 16), ids = [...d.subarray(32, 32 + count)];
    const id = ids.find((k) => raw[3229 + 3 * k + 2]);
    if (id === undefined) continue;
    const index = raw[3229 + 3 * id + 2], f = lookup(fil, 10, index)?.file;
    if (f) maps[m.id] = { set: safe(f), table10: index, spriteSetId: id };
  }
  const t12 = (i) => safe(lookup(fil, 12, i)?.file ?? '');
  writeJson(`${OUT}/effects.json`, {
    sets: { 0: t12(4), 1: t12(5) }, maps,
    note: 'f_6ce6c: trigger $A1AC6 = 2 -> the map set (maps; none: no effect); else effect animation $A1ACB <= $9F -> set 0, > $9F -> set 1 (set 1 uses set 0\'s sheet). Set 2 = table 10 entry named by byte 2 of ICITY.FIL + 3229 + 3 id for the first EVT sprite-set id that has one (f_68dac(1, 1)).',
  });
  return Object.keys(maps).length;
}

const backgrounds = exportBackgrounds();
const effectMaps = exportEffects();
const sprites = exportSprites();
exportScreen();
exportMusic();
writeJson(`${OUT}/index.json`, { backgrounds, sprites, screen: 'screen.json', music: 'music.json', effects: 'effects.json', doc: 'docs/battle-ui.md' });
console.log(`battle -> ${OUT}: ${backgrounds.length} backgrounds, ${sprites.length} sprite sets, effect set 2 on ${effectMaps} maps`);
