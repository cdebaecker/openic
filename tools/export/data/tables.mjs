// IC_TABLE.COM: the game's data tables, loaded once by ICITY68 f_71a0a to the buffer at $9EDC0.
// Layout: 21 u16le offsets (from the file start) -> table pointers at $9C736 + 4*i; then the
// tables; the end of the file ($1649..) is a Shift-JIS string pool (item, weapon, armour,
// spell, character and place names) referenced by u16 offsets inside the records.
// Record layouts are not fully decoded: this decoder infers the record size of each table from
// the period of its string references (and otherwise leaves the table as raw bytes).
import { toText, isLead } from '../../../src/text/codec.js';

const u16 = (b, a) => b[a] | (b[a + 1] << 8);

// What each table is, from its names / use (tentative where marked '?'). xrefs = number of
// instructions in ICITY68 that load the table pointer ($9C736+4*i).
// Known record layouts: size, offsets of u16 string references, short description.
// (Tentative meanings come from the names the records point at.)
export const LAYOUTS = {
  0: { size: 5, names: [1], what: 'character / enemy names: u8 id, u16 name, u16 ?' },
  4: { size: 8, names: [0], what: 'items: u16 name, u16 price, 4 bytes (effect / target / flags?)' },
  5: { size: 4, names: [0], what: 'item effect messages: u16 message, u16 ?' },
  6: { size: 8, names: [0], what: 'weapons: u16 name, u16 ?, u16 (power/price?), u16 offset into table 1 (weapon data)' },
  7: { size: 8, names: [0], what: 'armour: u16 name, u16 (price?), u16 (defence?), u16 ?' },
  9: { size: 10, names: [0], what: 'spells / skills: u16 name, u16 ?, u8, u8, u16, u16' },
  10: { size: 16, names: [0, 2, 4], what: 'per-weapon-type messages (u16 x3)' },
  13: { size: 2, names: [0], what: 'character classes (u16 name)' },
  14: { size: 2, names: [0], what: 'weapon types (u16 name)' },
  15: { size: 2, names: [0], what: 'area types (u16 name; shop, crisis area, indoor combat, ...)' },
  19: { size: 5, names: [3], what: 'place names: map id[3], u16 name' },
};
const NOTES = { 1: 'weapon data referenced by table 6 (unknown layout)', 2: 'byte table (stat growth curves?)', 3: 'byte table', 8: 'unknown', 11: 'u8 pairs', 12: 'unknown', 16: 'byte lists', 17: 'unknown', 18: 'unknown (14 bytes)', 20: 'records + references into the string pool' };

export function stringPool(b, start = 0x1649) {
  const map = new Map();
  let i = start;
  while (i < b.length) {
    const s = i, bytes = [];
    while (i < b.length && b[i] !== 0) { bytes.push(b[i]); if (isLead(b[i]) && i + 1 < b.length) bytes.push(b[++i]); i++; }
    if (bytes.length) map.set(s, toText(bytes));
    i++;
  }
  return map;
}

export function parseIcTable(b) {
  const offs = []; for (let i = 0; i < 21; i++) offs.push(u16(b, i * 2));
  const sorted = [...new Set([...offs, b.length])].sort((x, y) => x - y);
  const pool = stringPool(b);
  const poolStart = Math.min(...pool.keys());
  const tables = offs.map((o, i) => {
    let end = sorted[sorted.indexOf(o) + 1];
    if (end > poolStart && o < poolStart) end = poolStart;
    const raw = b.subarray(o, end);
    const t = { index: i, offset: o, size: raw.length, note: LAYOUTS[i]?.what ?? NOTES[i] ?? null };
    const L = LAYOUTS[i];
    if (L) {
      t.recordSize = L.size; t.records = [];
      for (let r = 0; r * L.size + L.size <= raw.length; r++) {
        const rec = raw.subarray(r * L.size, (r + 1) * L.size);
        const names = L.names.map((f) => pool.get(u16(rec, f)) ?? null);
        const words = []; for (let k = 0; k + 1 < rec.length; k += 2) words.push(u16(rec, k));
        t.records.push({ i: r, names, bytes: Buffer.from(rec).toString('hex'), words });
      }
      t.tail = Buffer.from(raw.subarray(Math.floor(raw.length / L.size) * L.size)).toString('hex');
    } else t.raw = Buffer.from(raw).toString('hex');
    return t;
  });
  return { offsets: offs, tables, strings: [...pool].map(([offset, text]) => ({ offset, text })) };
}
