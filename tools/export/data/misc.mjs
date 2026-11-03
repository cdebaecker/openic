// Smaller files: ICITY.RPT (developer transfer report), MTABLE.COM, PARA.DAT, EVTGRH.PLD,
// ISV*.DAT saves, and the file catalogue classifier.
const u16 = (b, a) => b[a] | (b[a + 1] << 8);
const sjis = new TextDecoder('shift_jis');

// ICITY.RPT: Shift-JIS text written by the developers' transfer tool. Lines like
//   event[A00.EVT]  ---> D:\GROUP01\000008.dat ...
//   vr_map[A00.MVL] ---> ...      field_chr[AMATO--F.CG9] ---> ...      IL-SYO.98P ---> ...
// It gives the original file name of most GROUP files (31 maps, characters, music, GEP).
export function parseRpt(b) {
  const text = sjis.decode(b).replace(/\r/g, '');
  const files = [];
  let map = null, chr = null;
  for (const line of text.split('\n')) {
    const m = /ｍａｐ＿ｉｄ\[(\w+)\]/.exec(line); if (m) { map = m[1]; continue; }
    const c = /キャラ番号\[(\d+)\]/.exec(line); if (c) { chr = Number(c[1]); continue; }
    const f = /^\s*(?:(\w+)\[)?([^\s\[\]]+?)\]?\s*--->\s*D:[¥\\]GROUP(\w\w)[¥\\](\d+)\.dat/i.exec(line);
    if (f) files.push({ kind: f[1] ?? 'file', name: f[2], file: `GROUP${f[3].toUpperCase()}/${f[4]}.DAT`, ...(f[1] && /map|event|vr_|sub_/.test(f[1]) && map ? { map } : {}), ...(f[1] === 'field_chr' || f[1] === 'battle_chr' ? { chr } : {}) });
  }
  return files;
}

// MTABLE.COM: u16 offsets[11] then names ("x:oto_ic.bin", "x:awaw.bin", ...) and a byte table.
// The *.BIN files (1024 bytes) it names are FM/sound-effect data for the music driver (audio lane).
export function parseMtable(b) {
  const offs = []; for (let i = 0; i < 11; i++) offs.push(u16(b, i * 2));
  const names = [...new Set(offs)].filter((o) => o < b.length && b[o] === 0x78).map((o) => { let s = ''; for (let i = o; b[i]; i++) s += String.fromCharCode(b[i]); return { offset: o, name: s }; });
  const tail = offs.at(-1);
  return { offsets: offs, names, table: [...b.subarray(tail)] };
}

// EVTGRH.PLD: 768 bytes = 24 palettes x 16 colours (u16 0x0GRB), used for event graphics.
export function parsePld(b) {
  const pals = [];
  for (let p = 0; p + 32 <= b.length; p += 32) { const c = []; for (let i = 0; i < 16; i++) c.push(u16(b, p + i * 2)); pals.push(c); }
  return pals;
}

// ISV*.DAT (954 bytes): save slots. Known: +$124 current map id (3 chars). Rest: game state
// (party, flags $9C798.., money, positions) — raw.
export function parseSave(b) {
  const id = String.fromCharCode(...b.subarray(0x124, 0x127)).replace(/\0/g, '');
  return { mapId: id || null, size: b.length, raw: Buffer.from(b).toString('hex') };
}

// Root files that are not GROUP containers.
export const ROOT_FILES = {
  'ICITY.FIL': 'master index: projects, 256 maps, 13 file tables (data/fil.mjs) — decoded',
  'IC_TABLE.COM': 'game data tables + name string pool (data/tables.mjs) — partially decoded',
  'MTABLE.COM': 'sound table: names of the *.BIN sound files + byte table — decoded (names)',
  'IC_MAIN.SCN': 'global VM script (common routines, called by builtin 2) — disassembled',
  'CONSULT.SCN': 'VM script for the "consult" (party talk) feature — disassembled',
  'ICITY.RPT': 'developer transfer report: original names of GROUP files — parsed',
  'PARA.DAT': '10 bytes of settings (read at boot by LOAD/MENU68) — raw',
  'WIN.DAT': '720 bytes: 1-bit window frame patterns (loaded to the text plane) — raw (graphics)',
  'BRGIWIN.DAT': 'window graphics (referenced by ICITY68) — graphics lane',
  'ASDF.CHR': '"CHR\\0" 1-bit character patterns (7216 bytes, loaded to $9DD5A+$5000) — graphics lane',
  'EVTGRH.PLD': '24 palettes x 16 colours 0x0GRB for event graphics — decoded',
  'IC98.BGE': 'sound-effect table (word offsets + data) for the PC-98-style SE driver — audio lane',
  'IC98.BEM': 'embedded ZMUSIC SE data ("ZmuSiC") — audio lane',
  'IC98.CMP': 'MIDI/CM-64 sound data ("IX", "COME ON MUSIC", "CM-64") — audio lane',
  'FLH.BIN': '1024-byte sound data (FM voice / SE), named by MTABLE — audio lane',
  'AWAW.BIN': '1024-byte sound data named by MTABLE — audio lane', 'KIKI.BIN': '1024-byte sound data named by MTABLE — audio lane', 'CAPAN.BIN': '1024-byte sound data named by MTABLE — audio lane', 'OTO_IC.BIN': '1024-byte sound data named by MTABLE — audio lane', 'FLH_N.BIN': '1024-byte sound data (variant of FLH.BIN) — audio lane', 'IPL.BIN': 'boot sector image ("URUDOS") — not game data',
  'YORO98.CG9': 'CG9 graphic (loaded as A:yoro98.cg9) — graphics lane',
  'WAKUB_B.DAT': 'window frame graphics (LZSS, planes B/R/G/I) — graphics lane',
  'ISV.DAT': 'save template', 'CITY68': 'Shift-JIS text (install / readme message)',
  '000002.DAT': 'CG9 — graphics lane', '000003.DAT': 'CG9 — graphics lane',
  'ICITY.MDD': 'hex text (MIDI dump?) — audio lane', 'ICITY.ZPD': 'ZMUSIC PCM data — audio lane', 'SE_TONE.ZMD': 'ZMUSIC sound effects — audio lane',
};
