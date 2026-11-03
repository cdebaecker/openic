// ICITY.FIL: the game's master index (loaded once by ICITY68 f_67840 to the buffer at $9EF4A).
//
//   $0000  "FIL\0" + 9 bytes (unknown)
//   $000D  9 x 16-byte "project" entries: name[8] (e.g. "IPROJ02") + 8 bytes (unknown, unused by ICITY68)
//   $009D  256 x 12-byte map entries (f_67d0e looks a map up by its 3-letter id):
//            +0 id[3] (e.g. "A00"; "---" = unused)
//            +3 evt      file-table index in table 6 (event file, *.EVT)            -> f_69e80
//            +4 vrMap    table 0 (main map layer, *.MVL)                             -> f_69f9a(0)
//            +5 vrChr    table 1 (tileset for vr layer, *.CV9)                      -> f_6a2b0(1)
//            +6 subMap   table 2 (overlay layer, *.MSL)                              -> f_69f9a(2)
//            +7 subChr   table 3 (tileset for the overlay, *.CS9)                   -> f_6a2b0(3)
//            +8 btlMap   table 4 (battle background layer, *.MSL)                    -> f_69f9a(4)
//            +9 btlChr   table 5 (battle background tileset, *.CS9)                 -> f_6a2b0(5) (f_68362)
//            +10 music   table 7 (field music)                                       -> f_69b44(0)
//            +11 music2  table 7 (second track; loaded by f_69b44(1) when $9DD42==0)
//          0 = none. All indices are 1-based.
//   $0C9D  256 x 3 bytes (unknown; small numbers, looks like a per-map table, not read by the loader)
//   $0F9D  13 file tables x 255 entries x 3 bytes (f_6a79c):
//            +0 u16le group mask: lowest set bit = GROUPnn directory (other bits: alternative copies)
//            +2 u8 file number -> "X:GROUPnn\%06d.DAT"
//          entry k (0-based) is file index k+1.
export const FILE_TYPES = [
  { type: 0, kind: 'vr_map', ext: 'MVL', what: 'main map layer (layout + metatiles), "map\\0" container' },
  { type: 1, kind: 'vr_chr', ext: 'CV9', what: 'tileset for the main layer, "map\\0" container' },
  { type: 2, kind: 'sub_map', ext: 'MSL', what: 'overlay map layer (+ a small second layer), "map\\0" container' },
  { type: 3, kind: 'sub_chr', ext: 'CS9', what: 'tileset for the overlay layer, "map\\0" container' },
  { type: 4, kind: 'battle_map', ext: 'MSL', what: 'battle background layer, "map\\0" container' },
  { type: 5, kind: 'battle_chr', ext: 'CS9', what: 'battle background tileset, "map\\0" container' },
  { type: 6, kind: 'event', ext: 'EVT', what: 'map event file: actors, triggers, cutscene scripts, VM code, messages' },
  { type: 7, kind: 'music', ext: '98P', what: 'music (compressed; not ICITY68 LZSS) — audio lane' },
  { type: 8, kind: 'field_chr', ext: 'CG9', what: 'field character sprites (CG9) — graphics lane' },
  { type: 9, kind: 'battle_chr', ext: 'CG9', what: 'battle sprites (CG9) — graphics lane' },
  { type: 10, kind: 'cg9', ext: 'CG9', what: 'more CG9 sprite sets (enemies?) — graphics lane' },
  { type: 11, kind: 'event_graphic', ext: 'GEP', what: 'IVENT_G*.GEP event/battle pictures ("\\x7fG.BLC04"), loaded by battle start (sys 20)' },
  { type: 12, kind: 'cg9', ext: 'CG9', what: 'CG9 sets loaded at map start (party/common sprites) — graphics lane' },
];

const ascii = (b, a, n) => { let s = ''; for (let i = 0; i < n; i++) { const c = b[a + i]; if (!c) break; s += String.fromCharCode(c); } return s; };

export function fileName(group, num) { return `GROUP${String(group).padStart(2, '0')}/${String(num).padStart(6, '0')}.DAT`; }

export function parseFil(b) {
  if (ascii(b, 0, 3) !== 'FIL') throw new Error('not a FIL file');
  const projects = [];
  for (let i = 0; i < 9; i++) {
    const a = 0x0d + i * 16;
    projects.push({ name: ascii(b, a, 8), raw: [...b.subarray(a + 8, a + 16)] });
  }
  const tables = [];
  for (let t = 0; t < 13; t++) {
    const rows = [];
    for (let k = 0; k < 255; k++) {
      const a = 0xf9d + 765 * t + 3 * k;
      const mask = b[a] | (b[a + 1] << 8), num = b[a + 2];
      if (!mask) continue;
      let g = 0; while (!((mask >> g) & 1)) g++;
      const alt = [];
      for (let h = g + 1; h < 16; h++) if ((mask >> h) & 1) alt.push(h);
      rows.push({ index: k + 1, group: g, num, file: fileName(g, num), ...(alt.length ? { altGroups: alt } : {}) });
    }
    tables.push({ ...FILE_TYPES[t], entries: rows });
  }
  const maps = [];
  for (let i = 0; i < 256; i++) {
    const a = 0x9d + 12 * i;
    const id = ascii(b, a, 3);
    const f = [...b.subarray(a + 3, a + 12)];
    if (!id || id === '---' || f.every((x) => !x)) continue;
    maps.push({ index: i, id, evt: f[0], vrMap: f[1], vrChr: f[2], subMap: f[3], subChr: f[4], btlMap: f[5], btlChr: f[6], music: f[7], music2: f[8] });
  }
  const perMap = [...b.subarray(0xc9d, 0xf9d)];
  return { projects, maps, tables, unknownPerMap3: perMap };
}

// Resolve a 1-based index of a file table to its entry.
export function lookup(fil, type, index) {
  return index ? fil.tables[type].entries.find((e) => e.index === index) ?? null : null;
}
