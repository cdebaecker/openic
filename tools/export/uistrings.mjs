// Interface strings for the Godot port's systems screens (docs/systems-ui.md §3): the template
// strings ICITY68's screens fill in place, read from the ICITY68 image by their run-time address
// (as tools/systems-ui/screens.mjs does), the two small byte tables the screens index, and the
// IC_TABLE names the screens print, all as raw Shift-JIS bytes (base64) so the port prints exactly
// what the original prints and applies the interface glossary to it.
//
//   node tools/export/uistrings.mjs     -> ../work/export/ui/strings.json   (needs ../work/icity68.image.bin)
//
// Output (game data: never commit it):
//   strings: { "9c3ce": b64, ... }            single templates (cstr)
//   lists:   { "9c3f0": [b64, ...], ... }     NULL-terminated pointer lists of templates (strList)
//   bytes:   { "9c70e": b64, "9c78c": b64 }   skill table (8 x {mask, group, column, skill}) and
//                                             weapon type -> skill word index
//   names:   { chars: {id: b64}, items: [b64 x 256], weapons: [...], armour: [...], spells: [...],
//              classes: [...], weaponTypes: [...] }
//   flags:   { itemField: [bool], spellField: [bool], weaponType: [int] }
import fs from 'node:fs';
import { root } from '../root.mjs';
import { exportDir, writeJson } from './common.mjs';
import { tables } from '../systems/model.mjs';

const IMAGE_BASE = 0x65c70;
const imgPath = `${root}/work/icity68.image.bin`;
if (!fs.existsSync(imgPath)) {
  console.log(`uistrings: ${imgPath} missing (run node tools/gen.mjs first) - skipped`);
  process.exit(0);
}
const img = fs.readFileSync(imgPath);
const byte = (a) => img[a - IMAGE_BASE];
const word = (a) => (byte(a) << 8) | byte(a + 1);
const long = (a) => ((word(a) << 16) | word(a + 2)) >>> 0;
const cstr = (a) => { const o = []; for (let i = 0; byte(a + i); i++) o.push(byte(a + i)); return o; };
const strList = (a) => { const o = []; for (let k = 0; long(a + 4 * k); k++) o.push(cstr(long(a + 4 * k))); return o; };
const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const hex = (a) => a.toString(16);

// Addresses used by tools/systems-ui/screens.mjs, the MAGIC "no spells" message $7E8B8, the shop,
// slot-list and SYSTEM (speed $9C5E8, switches $9C610, BGM $9C634) templates
const STRINGS = [0x9c3ce, 0x7e32e, 0x7e33f, 0x7ea7a, 0x7ea95, 0x7e46a, 0x7e47d, 0x7f370, 0x7f11c, 0x7fae4,
  0x7fafd, 0x7fb04, 0x7fb14, 0x7ff70, 0x7ff8b, 0x800e0, 0x800fe, 0x6745c, 0x67451, 0x7e8b8, 0x9c3df, 0x9c3e3,
  0x83acc, 0x83ae7, 0x8cb18, 0x8cb2b, 0x8cb32, 0x8cb39, 0x8cb40, 0x8cb47, 0x8cb56, 0x9c634,
  0x80e6e, 0x8147e, 0x80e7b, 0x9c136, 0x9c147];
const LISTS = [0x9c3f0, 0x9c504, 0x9c5cc, 0x8cb72, 0x9c490, 0x9c4a4, 0x9c46c, 0x9c42c, 0x9c4b8, 0x9c4e0,
  0x9c51c, 0x9c55c, 0x9c598, 0x9cf7a, 0x9cf9a, 0x9c5e8, 0x9c610, 0x9c454];

const out = { note: 'ICITY68 interface templates by run-time address (docs/systems-ui.md); Shift-JIS bytes, base64.', strings: {}, lists: {}, bytes: {}, names: {}, flags: {} };
for (const a of STRINGS) out.strings[hex(a)] = b64(cstr(a));
for (const a of LISTS) out.lists[hex(a)] = strList(a).map(b64);
out.bytes[hex(0x9c70e)] = b64([...Array(32).keys()].map((k) => byte(0x9c70e + k)));
out.bytes[hex(0x9c78c)] = b64([...Array(8).keys()].map((k) => byte(0x9c78c + k)));

// IC_TABLE names (screens.mjs charName / itemNameBytes / spellName / className / weaponTypeName)
const T = tables();
const raw = T.raw, off = T.offsets;
const u16 = (o) => raw[o] | (raw[o + 1] << 8);
const icStr = (o) => { const s = []; for (let i = o; i < raw.length && raw[i]; i++) s.push(raw[i]); return s; };
const chars = {};
for (let a = off[0]; raw[a] !== 0xff; a += 5) chars[raw[a]] = b64(icStr(u16(a + 1)));
const COUNTS = { 4: T.items.length, 6: T.weapons.length, 7: T.armour.length, 9: T.spells.length };
const count = (t) => COUNTS[t];
const names = (t, size, n = count(t, size)) => [...Array(Math.max(0, n)).keys()].map((i) => b64(icStr(u16(off[t] + size * i))));
out.names = {
  chars,
  // all 256 indices of an item code's low byte: out-of-range ones read whatever the table holds,
  // as the game does
  items: names(4, 8, 256), weapons: names(6, 8, 256), armour: names(7, 8, 256), spells: names(9, 10),
  classes: names(13, 2, 8), weaponTypes: names(14, 2, 256),
};
out.flags = {
  itemField: [...Array(256).keys()].map((i) => (raw[off[4] + 8 * i + 5] & 0x10) !== 0),
  spellField: [...Array(count(9, 10)).keys()].map((i) => (raw[off[9] + 10 * i + 7] & 0x10) !== 0),
  weaponType: [...Array(256).keys()].map((i) => raw[u16(off[6] + 8 * i + 6) + 4] ?? 0),
};
writeJson(`${exportDir}/ui/strings.json`, out);
console.log(`uistrings: ${STRINGS.length} strings, ${LISTS.length} lists -> ${exportDir}/ui/strings.json`);
