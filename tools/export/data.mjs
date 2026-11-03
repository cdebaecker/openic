// Non-graphics game data -> JSON for the Godot port (and a catalogue of every file on the disks).
// Output: ../work/export/data (game data: never commit it).
//
//   node tools/export/data.mjs                 export everything (index, maps, events, tables, catalogue)
//   node tools/export/data.mjs --previews      also render a PNG preview of every map (vr + sub layer)
//   node tools/export/data.mjs verify [frame]  boot the game (new game), and compare what ICITY68
//                                              loaded into RAM for the first map with the decoders
//   node tools/export/data.mjs verify-screen   same, then play to frame 11000 and check the map
//                                              drawn in text VRAM against a render of the decoded data
//
// Formats: docs/formats/data.md. Decoders: tools/export/data/*.mjs.
import fs from 'node:fs';
import { allFiles, readFile, exportDir, writeJson, writePng, ensureDir, root } from './common.mjs';
import { parseFil, lookup, FILE_TYPES } from './data/fil.mjs';
import { parseLayer, parseTileset, tilesetAtlas, renderLayer } from './data/maps.mjs';
import { parseEvt, parseScn } from './data/evt.mjs';
import { parseIcTable } from './data/tables.mjs';
import { parseRpt, parseMtable, parsePld, parseSave, ROOT_FILES } from './data/misc.mjs';

const out = `${exportDir}/data`;
const args = process.argv.slice(2);
const magic = (d) => String.fromCharCode(...d.subarray(0, 4)).replace(/[^\x20-\x7e]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
const strip = ({ unpacked, ...rest }) => rest;

if (args[0] === 'verify' || args[0] === 'verify-screen') await verify(args[0] === 'verify-screen', Number(args[1] ?? 3500));
else exportAll(args.includes('--previews'));

function exportAll(previews) {
  ensureDir(out);
  const fil = parseFil(readFile('ICITY.FIL'));
  const ict = parseIcTable(readFile('IC_TABLE.COM'));
  const rpt = parseRpt(readFile('ICITY.RPT'));
  const rptByFile = new Map(rpt.map((r) => [r.file, r]));
  const placeNames = new Map(ict.tables[19].records.map((r) => [Buffer.from(r.bytes.slice(0, 6), 'hex').toString('latin1'), r.names[0]]));

  // which file table(s) each GROUP file belongs to
  const roles = new Map();
  fil.tables.forEach((t) => t.entries.forEach((e) => { const k = e.file; if (!roles.has(k)) roles.set(k, []); roles.get(k).push({ type: t.type, kind: t.kind, index: e.index }); }));

  // ---- catalogue of every file on every disk ----
  const files = allFiles();
  const byPath = new Map();
  for (const f of files) { if (!byPath.has(f.path)) byPath.set(f.path, { path: f.path, disks: [], size: f.data.length, magic: magic(f.data), data: f.data }); byPath.get(f.path).disks.push(f.disk); }
  const catalogue = [];
  const decodedGroup = new Map();
  for (const e of byPath.values()) {
    const g = /^GROUP(\w\w)\/(\d+)\.DAT$/.exec(e.path);
    const c = { path: e.path, disks: e.disks, size: e.size, magic: e.magic };
    if (g) {
      c.roles = roles.get(e.path) ?? [];
      const r = rptByFile.get(e.path); if (r) c.originalName = r.name;
      c.what = describeGroup(e, c.roles);
      const res = decodeGroup(e, c.roles);
      if (res) { c.decoded = `groups/${e.path.replace('.DAT', '.json')}`; decodedGroup.set(e.path, res); writeJson(`${out}/${c.decoded}`, res.json); if (res.png) { c.png = c.decoded.replace('.json', '.png'); writePng(`${out}/${c.png}`, res.png.rgba, res.png.w, res.png.h); } }
    } else {
      const base = e.path.split('/').pop();
      c.what = ROOT_FILES[base] ?? ROOT_FILES[base.toUpperCase()] ?? rootGuess(e);
    }
    catalogue.push(c);
  }

  // ---- root files ----
  writeJson(`${out}/ICITY.FIL.json`, fil);
  writeJson(`${out}/IC_TABLE.json`, ict);
  writeJson(`${out}/ICITY.RPT.json`, rpt);
  writeJson(`${out}/MTABLE.json`, parseMtable(readFile('MTABLE.COM')));
  writeJson(`${out}/EVTGRH.PLD.json`, parsePld(readFile('EVTGRH.PLD')));
  for (const n of ['IC_MAIN.SCN', 'CONSULT.SCN']) writeJson(`${out}/${n}.json`, parseScn(readFile(n)));
  const saves = {}; for (const n of ['ISV.DAT', 'ISV0.DAT', 'ISV1.DAT', 'ISV2.DAT', 'ISV3.DAT', 'ISV4.DAT', 'ISV5.DAT', 'ISV6.DAT', 'ISV7.DAT']) { const d = readFile(n); if (d) saves[n] = parseSave(d); }
  writeJson(`${out}/saves.json`, saves);

  // ---- index: maps with their files ----
  const ref = (type, index) => { const e = lookup(fil, type, index); if (!e) return null; const r = { index, file: e.file }; const c = catalogue.find((x) => x.path === e.file); if (c?.decoded) r.json = c.decoded; if (c?.png) r.png = c.png; if (c?.originalName) r.originalName = c.originalName; if (!c) r.missing = true; return r; };
  const maps = fil.maps.map((m) => {
    const vr = decodedGroup.get(lookup(fil, 0, m.vrMap)?.file);
    return {
      id: m.id, index: m.index, name: placeNames.get(m.id) ?? null,
      size: vr ? { width: vr.json.layers[0].width, height: vr.json.layers[0].height } : null,
      event: ref(6, m.evt), vrMap: ref(0, m.vrMap), vrChr: ref(1, m.vrChr), subMap: ref(2, m.subMap), subChr: ref(3, m.subChr),
      battleMap: ref(4, m.btlMap), battleChr: ref(5, m.btlChr), music: ref(7, m.music), music2: ref(7, m.music2),
    };
  });
  writeJson(`${out}/index.json`, {
    note: 'Illusion City data index. Map cells are row-major [y][x] metatile numbers; a metatile is 2x2 tiles (TL,TR,BL,BR); a tile is 16x8 pixels shown with doubled lines (16x16). Positions in triggers/actors and the party position ($9C8BC/$9C8BE) are in tile units (2 per metatile). See docs/formats/data.md.',
    fileTypes: FILE_TYPES, maps,
    groups: Object.fromEntries([...new Set(catalogue.filter((c) => c.path.startsWith('GROUP')).map((c) => c.path.split('/')[0]))].sort().map((g) => {
      const cs = catalogue.filter((c) => c.path.startsWith(g + '/'));
      const kinds = {}; for (const c of cs) { const k = c.roles[0]?.kind ?? (c.magic.startsWith('CG9') ? 'cg9_unindexed' : /music/.test(c.what) ? 'music' : c.magic); kinds[k] = (kinds[k] ?? 0) + 1; }
      return [g, { files: cs.length, disks: [...new Set(cs.flatMap((c) => c.disks))].sort(), kinds }];
    })),
  });
  writeJson(`${out}/catalogue.json`, catalogue);

  if (previews) for (const m of maps) {
    const vr = decodedGroup.get(m.vrMap?.file), vc = decodedGroup.get(m.vrChr?.file), sm = decodedGroup.get(m.subMap?.file), sc = decodedGroup.get(m.subChr?.file);
    if (!vr || !vc) continue;
    const banks = [vc.ts, sc?.ts];
    const img = renderLayer(vr.json.layers[0], vr.layer.metatiles, banks[0], vc.ts.palette, true);
    if (sm) { const o = renderLayer(sm.json.layers[0], sm.layer.metatiles, banks[1], vc.ts.palette); for (let i = 0; i < o.rgba.length; i += 4) if (o.rgba[i + 3] && i < img.rgba.length) img.rgba.set(o.rgba.subarray(i, i + 4), i); }
    writePng(`${out}/previews/${m.id}.png`, img.rgba, img.w, img.h);
  }
  const n = catalogue.filter((c) => c.decoded).length;
  console.log(`${catalogue.length} files catalogued, ${n} GROUP files decoded, ${maps.length} maps -> ${out}`);
}

function describeGroup(e, roles) {
  if (roles.length) return roles.map((r) => FILE_TYPES[r.type].what).filter((v, i, a) => a.indexOf(v) === i).join(' / ');
  if (e.magic === 'CG9\\x00') return 'CG9 graphics (not in ICITY.FIL) — graphics lane';
  if (e.magic === 'map\\x00') return 'map container not referenced by ICITY.FIL (unused?)';
  if (e.magic === 'EVT\\x00') return 'event file not referenced by ICITY.FIL (unused?)';
  if (/^GROUP00\/0000(6[12])/.test(e.path)) return 'music (u32 size + compressed, same format as table 7; not in ICITY.FIL) — audio lane';
  if (e.path.startsWith('GROUPMD/')) return 'music (same compressed format as table 7; GROUPMD = music disk copy) — audio lane';
  return 'unknown';
}

function rootGuess(e) {
  if (e.magic.startsWith('PIC')) return 'PIC image (opening/ending) — graphics lane';
  if (/\.(ZMD|ZPD|PCM)$/i.test(e.path)) return 'ZMUSIC data — audio lane';
  if (/\.X$/i.test(e.path)) return 'program (Human68k .X)';
  if (/IGRP2?\/.*\.PIC$/i.test(e.path)) return 'PIC image (opening/ending; MSG04.PIC has a different header) — graphics lane';
  if (/IGRP2?\/.*\.00\d$/.test(e.path)) return '32-byte PIC companion (palette/position) — graphics lane';
  if (/^ICITY_\d$/.test(e.path)) return 'empty marker file: disk id (f_67b56 looks for x:ICITY_?)';
  if (/^(HUMAN\.SYS|COMMAND\.X|CONFIG\.SYS|AUTOEXEC\.BA[TK])$/i.test(e.path)) return 'Human68k system file';
  if (/^WAKU/i.test(e.path)) return 'window frame graphics (LZSS) — graphics lane';
  if (/^ISV\d\.DAT$/i.test(e.path)) return 'save slot (954 bytes) — raw, map id at +$124';
  return 'unknown';
}

function decodeGroup(e, roles) {
  const d = e.data, t = roles[0]?.type;
  try {
    if (e.magic === 'map\\x00' || (t !== undefined && t <= 5)) {
      if (t === 1 || t === 3 || t === 5 || (t === undefined && d[8] === 0 && d[9] === 2)) {
        const ts = parseTileset(d);
        const json = { file: e.path, roles, ...strip(ts), tiles: undefined, tileCount: ts.tiles.length,
          tilesB64: Buffer.from(ts.tiles.flatMap((x) => [...x.px])).toString('base64'), masksB64: Buffer.from(ts.tiles.flatMap((x) => [...x.mask])).toString('base64'),
          tileFormat: 'tilesB64: 256 tiles x 128 bytes (16x8, one palette index per byte); masksB64: same layout, 1 = opaque. Atlas PNG: 16 tiles per row, lines doubled (16x16).' };
        return { json, png: tilesetAtlas(ts), ts };
      }
      const layer = parseLayer(d);
      return { json: { file: e.path, roles, ...strip(layer) }, layer };
    }
    if (e.magic === 'EVT\\x00') return { json: { file: e.path, roles, ...parseEvt(d) } };
  } catch (err) { return { json: { file: e.path, roles, error: String(err) } }; }
  return null;
}

// ---- verification against the running game ----
async function verify(screen, frame) {
  const { X68k } = await import('../../src/x68k.js');
  const { Disk } = await import('../../src/fs.js');
  const { Font } = await import('../../src/font.js');
  const disks = []; for (let i = 1; i <= 7; i++) disks.push(new Disk(new Uint8Array(fs.readFileSync(`${root}/Genei Toshi (1991)(Microcabin)(Disk ${i} of 7).dim`)), `disk${i}`));
  const sys = new X68k({ epoch: Date.UTC(1993, 4, 24, 12, 0, 0), disks, font: new Font(), log: () => {} });
  const script = JSON.parse(fs.readFileSync(new URL('../scripts/new-game.json', import.meta.url), 'utf8'));
  if (screen) for (let f = 3500; f < 15000; f += 40) script.push({ frame: f, key: 29 }, { frame: f + 4, keyup: 29 });
  const loads = [];
  let armed = false;
  sys.boot([['A:\\ZMUSIC.X', '-U -BICITY.ZPD'], ['A:\\LOAD.X', '']]);
  const m = sys.m, r32 = (a) => m.r32(a) >>> 0;
  const end = screen ? 11000 : frame;
  for (let f = 0; f < end; f++) {
    for (const ev of script) if (ev.frame === f) { if (ev.key !== undefined) sys.keyEvent(ev.key, true); if (ev.keyup !== undefined) sys.keyEvent(ev.keyup, false); }
    sys.runFrame();
    if (!armed && sys.programName?.() === 'ICITY68.X') { armed = true; sys.addHook(0x6a79c, (c) => { const sp = c.a[7] >>> 0; loads.push([r32(sp + 4), r32(sp + 8)]); }); }
  }
  const ram = m.ram, B = r32(0x9dd4e);
  const mapId = String.fromCharCode(...ram.subarray(0x9c8b8, 0x9c8bb));
  const fil = parseFil(readFile('ICITY.FIL'));
  const me = fil.maps.find((x) => x.id === mapId);
  const file = (type, idx) => readFile(lookup(fil, type, idx).file);
  const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
  const res = [];
  const check = (name, ok) => { res.push([name, ok]); console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}`); };
  console.log(`map ${mapId} (entry ${me.index}); files requested: ${loads.map(([t, i]) => `${t}:${i}`).join(' ')}`);
  const vr = parseLayer(file(0, me.vrMap));
  check('vr layer header ($C882)', eq(file(0, me.vrMap).subarray(0, 32), ram.subarray(B + 0xc882, B + 0xc8a2)));
  check('vr layer cells (unpacked at map buffer +0)', eq(vr.unpacked, ram.subarray(B, B + vr.unpacked.length)));
  check('vr metatiles (+$5000)', eq(file(0, me.vrMap).subarray(32 + 0x100, 32 + 0x900), ram.subarray(B + 0x5000, B + 0x5800)));
  check('vr extra block (+$C000)', eq(file(0, me.vrMap).subarray(32, 32 + 0x100), ram.subarray(B + 0xc000, B + 0xc100)));
  if (me.subMap) {
    const sm = parseLayer(file(2, me.subMap));
    check('sub layer cells (after vr layer)', eq(sm.unpacked, ram.subarray(B + vr.unpacked.length, B + vr.unpacked.length + sm.unpacked.length)));
    check('sub metatiles (+$5C00)', eq(file(2, me.subMap).subarray(64, 64 + 0x800), ram.subarray(B + 0x5c00, B + 0x6400)));
  }
  const vc = parseTileset(file(1, me.vrChr));
  check('vr_chr tiles unpacked at ($9DD5A)', eq(vc.unpacked, ram.subarray(r32(0x9dd5a), r32(0x9dd5a) + vc.unpacked.length)));
  check('vr_chr attributes (+$4C00)', eq(file(1, me.vrChr).subarray(64 + 0x200, 64 + 0x600), ram.subarray(B + 0x4c00, B + 0x5000)));
  if (me.subChr) {
    const sc = parseTileset(file(3, me.subChr));
    check('sub_chr tiles unpacked at ($9DD5E)', eq(sc.unpacked, ram.subarray(r32(0x9dd5e), r32(0x9dd5e) + sc.unpacked.length)));
  }
  const ev = file(6, me.evt);
  const h = parseEvt(ev).header;
  check('EVT trigger block ($A034C)', eq(ev.subarray(32 + h.actorSize, 32 + h.actorSize + h.triggerSize), ram.subarray(0xa034c, 0xa034c + h.triggerSize)));
  check('EVT actor block ($A04DC)', eq(ev.subarray(32, 32 + h.actorSize), ram.subarray(0xa04dc, 0xa04dc + h.actorSize)));
  const sp = 32 + h.actorSize + h.triggerSize + h.block3Size, sb = r32(0xa0654);
  check('EVT scripts ($A0654)', eq(ev.subarray(sp, sp + h.part1Size + h.part2Size), ram.subarray(sb, sb + h.part1Size + h.part2Size)));
  const px = m.r16(0x9c8bc), py = m.r16(0x9c8be);
  console.log(`party position $9C8BC/$9C8BE = (${px}, ${py}) tiles; map is ${vr.layers[0].width * 2} x ${vr.layers[0].height * 2} tiles`);
  if (screen) {
    // Identify every 16x8 tile drawn in the map window (text VRAM, lines doubled, scroll y 512)
    // and compare with the decoded layer at origin ($9C8BC, $9C8BE).
    const t = sys.video.tram, sy = sys.video.crtc[11] & 1023;
    const sc = me.subChr ? parseTileset(file(3, me.subChr)) : null;
    const key = (ts, k) => Buffer.from(ts.unpacked.subarray(k * 80 + 16, k * 80 + 80)).toString('hex');
    const idx = new Map(); for (let k = 255; k >= 0; k--) { if (sc) idx.set(key(sc, k), 256 + k); } for (let k = 255; k >= 0; k--) idx.set(key(vc, k), k);
    let hit = 0, known = 0;
    for (let ty = 0; ty < 16; ty++) for (let tx = 0; tx < 24; tx++) {
      const b = new Uint8Array(64);
      for (let p = 0; p < 4; p++) for (let y = 0; y < 8; y++) for (let k = 0; k < 2; k++) b[p * 16 + y * 2 + k] = t[p * 0x20000 + ((80 + ty * 16 + 2 * y + sy) & 1023) * 128 + 22 + tx * 2 + k];
      const id = idx.get(Buffer.from(b).toString('hex')); if (id === undefined) continue;
      known++;
      const X = px + tx, Y = py + ty, cell = vr.layers[0].cells[Y >> 1][X >> 1], q = vr.metatiles[cell][(Y & 1) * 2 + (X & 1)];
      if (q.raw === id) hit++;
    }
    check(`screen: ${hit}/${known} identifiable tiles in the map window match the vr layer at origin (${px},${py})`, hit / known > 0.75);
  }
  const bad = res.filter((r) => !r[1]).length;
  console.log(bad ? `${bad} check(s) failed` : 'all checks passed');
  process.exitCode = bad ? 1 : 0;
}
