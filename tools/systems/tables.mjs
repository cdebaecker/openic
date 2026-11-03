// IC_TABLE.COM fully decoded (milestone 5): every table with named fields, as used by the game
// systems (items, equipment, spells, effects, levels, shops, new game) and, where noted, battles.
// Spec: docs/systems.md §1. ICITY68 loads the file once to $9EDC0 (f_71a0a); table i is at
// $9EDC0 + u16le[i] (pointer at $9C736 + 4i). All words are little-endian; "name"/"msg" fields
// are offsets of Shift-JIS strings (pool from $1649) and are resolved to text here.
//
//   import { loadTables } from './tables.mjs';
//   const T = loadTables();            // reads IC_TABLE.COM from the disk images
//   const T = decodeTables(bytes);     // or from the file's bytes (tools/export/systems.mjs reads the disks)
//   T.items[1]  -> { name: '救丹', price: 30, effect: 18, flags: 0x70, field: true, ... }
import fs from 'node:fs';
import { root } from '../root.mjs';
import { stringPool } from '../export/data/tables.mjs';
import { readFile } from '../export/common.mjs';

const u16 = (b, a) => b[a] | (b[a + 1] << 8);

// Item code classes (high byte of a 16-bit item code): 0/1 -> table 4 (items; low byte = index),
// 2 -> table 6 (weapons), 3 -> table 7 (armour / accessories). Key items are codes $40-$FF with a
// zero high byte (and $217, $231 for the VM's inventory routine f_7116c).
export const CODE = { item: 0x000, weapon: 0x200, armour: 0x300 };
export const codeClass = (code) => { const h = (code >> 8) & 0xff; return h <= 1 ? 'item' : h === 2 ? 'weapon' : h === 3 ? 'armour' : 'other'; };

// Weapon type (weapon data +4) -> name (= table 14 entry `type`, stored from 斬糸 to Gun). A
// character may equip a weapon when bit `type` of its mask (record +22) is set ($9C38E[type]).
export const WEAPON_TYPES = ['斬糸', '剣', '杖', 'クロー', 'ヘビーGun', '砲', 'ライフル', 'Gun'];
// Armour category (armour +7): which equipment slot / restriction (f_7f138).
export const ARMOUR_CATS = ['body', 'head', 'arms', 'feet', 'special', 'body (char 3 only)'];

const bit = (v, n) => ((v >> n) & 1) === 1;

export function loadTables(bytes) {
  const b = bytes ?? readIcTableSync();
  return decodeTables(b);
}
// the file from a scratch copy if there is one, else from the disk images (tools/export/common.mjs)
function readIcTableSync() {
  const p = `${root}/work/data-scratch/IC_TABLE.COM`;
  if (fs.existsSync(p)) return new Uint8Array(fs.readFileSync(p));
  const f = readFile('IC_TABLE.COM');
  if (!f) throw new Error('IC_TABLE.COM not found (disk images missing?)');
  return new Uint8Array(f);
}

export function decodeTables(b) {
  const pool = stringPool(b);
  const S = (o) => (o ? pool.get(o) ?? null : null);
  const off = []; for (let i = 0; i < 21; i++) off.push(u16(b, 2 * i));
  const recs = (t, size, end, fn) => { const out = []; for (let a = off[t], i = 0; a + size <= end; a += size, i++) out.push(fn(a, i)); return out; };

  // ---- table 0: names of characters / enemies, with their battle action lists ---------------
  // {u8 id, u16 name, u16 actions} until id $FF. actions = offset of a list of {u8 action,
  // u16 message} ended by a byte with bit 7 set (enemy battle lines; battle, milestone 6).
  const names = [];
  for (let a = off[0]; b[a] !== 0xff; a += 5) {
    const r = { id: b[a], name: S(u16(b, a + 1)), actionsOffset: u16(b, a + 3) || null, actions: [] };
    if (r.actionsOffset) for (let p = r.actionsOffset; p < b.length && !(b[p] & 0x80); p += 3) r.actions.push({ action: b[p], msg: S(u16(b, p + 1)) });
    names.push(r);
  }

  // ---- tables 2, 3: experience curve and level-up growth (8 characters) --------------------
  const expCurve = recs(2, 16, off[2] + 128, (a) => [...b.subarray(a, a + 16)]);
  // growth[c] = [agility(+6), power(+19), vitality(+16), maxHP(+12), maxMP(+8)] base gains
  const growth = recs(3, 5, off[3] + 40, (a) => { const g = [...b.subarray(a, a + 5)]; return { raw: g, agility: g[0], power: g[1], vitality: g[2], hp: g[3], mp: g[4] }; });

  // ---- table 4: items (index = low byte of codes $0xx / $1xx) -------------------------------
  const items = recs(4, 8, off[5], (a, i) => {
    const flags = b[a + 5];
    return {
      index: i, name: S(u16(b, a)), price: u16(b, a + 2), effect: b[a + 4], flags,
      field: bit(flags, 4), battle: bit(flags, 5), reusable: bit(flags, 2), // not consumed when used
      single: bit(flags, 6), all: bit(flags, 7), enemy: bit(flags, 3), // battle targeting (tentative)
      b6: b[a + 6], anim: b[a + 7], // +7: battle animation / sound (tentative)
      key: i > 0x3f, droppable: !(i > 0x3f),
    };
  });

  // ---- table 5: effects (index = effect id used by items, spells, weapons, armour) ----------
  // {u16 message ({24}2 = target name, {23}1 = amount), u8 passive, u8 anim}. passive = 1: the
  // effect is an equipment bonus (run by the stat recompute, mode 1); 0: an action (mode 2).
  const effects = recs(5, 4, off[5] + 448, (a, i) => ({ id: i, msg: S(u16(b, a)), passive: b[a + 2], anim: b[a + 3] }));

  // ---- table 1 + 6: weapons ----------------------------------------------------------------
  // table 6 {u16 name, u16 0, u16 price, u16 data} ; data -> 10-byte record in table 1:
  // {u8 effect (passive bonus / battle effect), u8 0, u16 attack, u8 type, u8 flags, u8 b6, u8 b7,
  //  u8 anim, u8 effect2}. flags bit 7: firearm (sets char +4 bit 5: power bonuses 56-58 do not
  //  apply); flags & 15 + 17 = ammunition item code for firearms (tentative, battle).
  const weaponData = (a) => ({ offset: a, effect: b[a], attack: u16(b, a + 2), type: b[a + 4], typeName: WEAPON_TYPES[b[a + 4]] ?? null, flags: b[a + 5], firearm: bit(b[a + 5], 7), ammo: bit(b[a + 5], 7) ? (b[a + 5] & 15) + 17 : null, b6: b[a + 6], b7: b[a + 7], anim: b[a + 8], effect2: b[a + 9] });
  const weapons = recs(6, 8, off[6] + 704, (a, i) => { const d = u16(b, a + 6); return { index: i, code: 0x200 + i, name: S(u16(b, a)), w2: u16(b, a + 2), price: u16(b, a + 4), dataOffset: d, data: d ? weaponData(d) : null }; });

  // ---- table 7: armour and accessories -----------------------------------------------------
  // {u16 name, u16 price, u16 defence, u8 effect (passive), u8 category}
  const armour = recs(7, 8, off[7] + 496, (a, i) => ({ index: i, code: 0x300 + i, name: S(u16(b, a)), price: u16(b, a + 2), defence: u16(b, a + 4), effect: b[a + 6], category: b[a + 7], categoryName: ARMOUR_CATS[b[a + 7]] ?? null }));

  // ---- table 8: battle table read by f_6ee78 (236 bytes; milestone 6) ----------------------
  const battle8 = Buffer.from(b.subarray(off[8], off[8] + 236)).toString('hex');

  // ---- table 9: spells ---------------------------------------------------------------------
  // {u16 name, u16 incantation, u8 effect, u8 MP cost, u8 school, u8 flags, u8 5, u8 anim}
  // flags: bit 4 castable in the field, bit 6 one target, bit 7 whole party (cost x4 in the
  // field; both 6 and 7 -> the caster chooses), bit 5 battle?, bits 0-3 battle targeting.
  const spells = recs(9, 10, off[9] + 410, (a, i) => { const f = b[a + 7]; return { index: i, name: S(u16(b, a)), msg: S(u16(b, a + 2)), effect: b[a + 4], cost: b[a + 5], school: b[a + 6], flags: f, field: bit(f, 4), single: bit(f, 6), all: bit(f, 7), b8: b[a + 8], anim: b[a + 9] }; });

  // ---- table 10: per-character "out of ammunition" lines (3 messages each) -----------------
  const outOfAmmo = recs(10, 16, off[10] + 128, (a) => [S(u16(b, a)), S(u16(b, a + 2)), S(u16(b, a + 4))]);

  // ---- tables 11, 12: no reference found in ICITY68 (kept raw) -----------------------------
  const t11 = recs(11, 2, off[11] + 60, (a) => [b[a], b[a + 1]]);
  const t12 = recs(12, 2, off[12] + 24, (a) => [b[a], b[a + 1]]);

  // ---- tables 13, 14, 15: class names, weapon type names, music titles (sound test) --------
  const strList = (t, n) => recs(t, 2, off[t] + 2 * n, (a) => S(u16(b, a)));
  const classes = strList(13, 8), weaponTypeNames = strList(14, 8), music = strList(15, 36);

  // ---- table 16: spell lists. 12 u16 offsets -> spell ids ended by $80 ---------------------
  // list = char 3 -> 0, char 6 -> 1, char 7 -> 2, char 0 -> 3 + tier ($9C99C, builtin 23),
  // other characters have no magic (f_7e488).
  const spellLists = []; for (let k = 0; k < 12; k++) { const o = u16(b, off[16] + 2 * k), l = []; for (let p = o; b[p] !== 0x80; p++) l.push(b[p]); spellLists.push(l); }

  // ---- table 17: the 8 character records of a new game (40 bytes each, f_72d5e) ------------
  const initialChars = recs(17, 40, off[17] + 320, (a) => [...b.subarray(a, a + 40)]);
  // ---- table 18: the items of a new game ({u16 code, u16 count} until code 0) --------------
  const initialItems = []; for (let a = off[18]; u16(b, a); a += 4) initialItems.push({ code: u16(b, a), count: u16(b, a + 2) });

  // ---- table 19: place names (save slots, area display) {char id[3], u16 name} -------------
  const places = []; for (let a = off[19]; b[a]; a += 5) places.push({ id: String.fromCharCode(b[a], b[a + 1], b[a + 2]), name: S(u16(b, a + 3)) });

  // ---- table 20: shops (builtin 35 mode 2 + n) ---------------------------------------------
  // {u16 categories, u16 strings}; categories = {u16 name, u16 stock} until name 0, stock 0 =
  // the SELL page; stock -> u8 unit (not read by the code), then rows {u8 level, 8 x u16 code}
  // until $FF (level & $7F: the buy list opens on the last row whose level <= the hero's level).
  // strings: 8 strings: title, not enough money, thanks, cannot carry, buy?, sell?, discount,
  // cannot buy that.
  const shops = [];
  for (let s = 0; s < 3; s++) {
    const catOff = u16(b, off[20] + 4 * s), strOff = u16(b, off[20] + 4 * s + 2);
    const strings = []; for (let k = 0, p = strOff; k < 8; k++) { strings.push(S(p)); while (b[p]) p++; p++; }
    const categories = [];
    for (let k = 0, p = catOff; u16(b, p); k++, p += 4) {
      const name = S(u16(b, p)), stock = u16(b, p + 2);
      const cat = { name, stockOffset: stock, sell: stock === 0 };
      if (stock) {
        cat.unit = b[stock]; cat.rows = [];
        for (let r = stock + 1; b[r] !== 0xff; r += 17) { const codes = []; for (let j = 0; j < 8; j++) codes.push(u16(b, r + 1 + 2 * j)); cat.rows.push({ level: b[r] & 0x7f, flag: b[r] >> 7, codes }); }
      }
      categories.push(cat);
    }
    shops.push({ index: s, mode: s + 2, title: strings[0], strings, categories });
  }

  return { offsets: off, names, expCurve, growth, items, effects, weapons, armour, battle8, spells, outOfAmmo, t11, t12, classes, weaponTypeNames, music, spellLists, initialChars, initialItems, places, shops, raw: b };
}

// Name of an item code (any class).
export function itemName(T, code) {
  const c = codeClass(code), i = code & 0xff;
  return c === 'item' ? T.items[i]?.name : c === 'weapon' ? T.weapons[i]?.name : c === 'armour' ? T.armour[i]?.name : null;
}
// Price of an item code as the shop routine reads it (f_84296: $9DC18).
export function itemPrice(T, code) {
  const c = codeClass(code), i = code & 0xff;
  return c === 'item' ? T.items[i]?.price ?? 0 : c === 'weapon' ? T.weapons[i]?.price ?? 0 : c === 'armour' ? T.armour[i]?.price ?? 0 : 0;
}
