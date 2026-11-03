// Text support data for the Godot port: a Shift-JIS -> Unicode table (Godot has no Shift-JIS
// decoder; the message engine works on the game's Shift-JIS bytes). Generated from the standard
// encoding, not from game data.
// Usage: node tools/export/text.mjs   -> ../work/export/text/sjis.json
import { exportDir, writeJson } from './common.mjs';

const dec = new TextDecoder('shift_jis', { fatal: true });
const table = {};
// half-width katakana $A1-$DF
for (let c = 0xa1; c <= 0xdf; c++) table[c.toString(16)] = dec.decode(Uint8Array.of(c));
// double-byte codes: lead $81-$9F, $E0-$EF; trail $40-$FC except $7F
for (const lead of [...Array(0x1f).keys()].map((i) => 0x81 + i).concat([...Array(0x10).keys()].map((i) => 0xe0 + i))) {
  for (let t = 0x40; t <= 0xfc; t++) {
    if (t === 0x7f) continue;
    try { table[((lead << 8) | t).toString(16)] = dec.decode(Uint8Array.of(lead, t)); } catch { /* unassigned */ }
  }
}
writeJson(`${exportDir}/text/sjis.json`, table);
console.log(`text: ${Object.keys(table).length} Shift-JIS codes -> ${exportDir}/text/sjis.json`);
