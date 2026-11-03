// Draw-list model of ICITY68's battle screen (docs/battle-ui.md): layout constants, the command
// selector f_81d00, the status list f_6f9ae, the battle panel f_6e140, the target marker / hit
// test (f_70cb4, f_70e18), the battle message templates (f_6dee4 -> f_72286 with the slot arrays
// $9EDB0/$9EDB6/$9EDA4/$9ED9E) and the end-of-battle messages (f_6b3c4, f_6b4fa, f_6b63e).
// Pure functions: they take battle records / character data and return what the game prints
// or draws (print ops for tools/systems-ui/ui.mjs UI, ASDF tile draws, glyph streams).
//
// Coordinates: screen pixels of the 768x512 frame; mouse units are x = screenX - 64,
// y = screenY / 2 - 24 (f_88ed2). Windows in 8-pixel columns / 16-line rows from (64, 48).
import fs from 'node:fs';
import { root } from '../root.mjs';
import * as SYS from '../systems/model.mjs';

// ---- the ICITY68 image (strings and tables by run-time address) ----------------------------------
const BASE = 0x65c70;
let IMG = null;
const img = () => (IMG ??= fs.readFileSync(`${root}/work/icity68.image.bin`));
export const byte = (a) => img()[a - BASE];
export const word = (a) => (byte(a) << 8) | byte(a + 1);
export const long = (a) => ((word(a) << 16) | word(a + 2)) >>> 0;
export const leWord = (a) => byte(a) | (byte(a + 1) << 8);
export function cstr(a, max = 512) { const o = []; for (let i = 0; i < max && byte(a + i); i++) o.push(byte(a + i)); return o; }
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));

// ---- layout ---------------------------------------------------------------------------------------
export const ARENA = { x: 192, y: 64, w: 352, h: 224, cols: 22, rows: 14 };   // f_731a8(1): 22 x 14 tiles of 16 x 16
export const WINDOWS = {
  selector: [70, 2, 10, 15],   // $8CD02 opened with flags 4 (no frame): command labels over the panel buttons
  message: [16, 17, 40, 7],    // $8CCFA flags 4: battle messages / status list (screen 192, 320)
};
// party positions in arena tiles (x, bottom row) by party slot: f_6d4a0 ($8CCF0 for 3, $8CCF6 for 2)
export const PARTY_POS = { 3: [[9, 13], [3, 13], [15, 13]], 2: [[12, 13], [6, 13]], 1: [[12, 13]] };
export const partyPositions = (n) => PARTY_POS[n] ?? PARTY_POS[3].slice(0, n);
// sprite placement: a combatant at record (x, y) is sprite (x, y) in arena tiles; a CG9 part at cell
// (px, py) covers screen pixels (ARENA.x + 16 (x + px), ARENA.y + 16 (y + py + 1) - 16 h) ...
export const tilePixel = (x, y) => [ARENA.x + 16 * x, ARENA.y + 16 * y];

// enemy rows (f_6dcd2): the row's first enemy x = cg9.attr[33] + fmt[1] - y0 / 2 ... see docs §2.3
export function enemyRow({ y, kind, attr33, fmt, first }) {
  const out = [];
  let x = (attr33 + fmt[1] - (kind >> 1)) & 0xff;
  for (let k = 0; k < fmt[0]; k++) { out.push({ rec: first + k, x, y }); x = (x + fmt[2]) & 0xff; }
  return out;
}

// ---- command selector f_81d00 --------------------------------------------------------------------
// Menus per character ($8CF1A, 8-byte entries {label ptr, 4 bytes}, null-terminated; f_717b6 picks
// the start index by character id; command codes $8D092[index]):
export const MENU_START = { 0: 0, 1: 6, 2: 11, 3: 0, 4: 21, 5: 6, 6: 27, 7: 0 };
export const COMMANDS = { 1: 'attack', 2: 'defend', 3: 'flee', 4: 'magic', 5: 'item', 6: 'transform', 7: 'claw', 8: 'kosin', 9: 'pass', 10: 'cannon', 11: 'mbh', 12: 'none', 13: 'yakusen' };
export function menuStart(charId, idleAction) { return charId === 2 && idleAction === 0x0f ? 17 : MENU_START[charId] ?? 0; }
export function commandMenu(charId, idleAction = 6) {
  const start = menuStart(charId, idleAction), items = [];
  for (let i = start; long(0x8cf1a + 8 * i); i++) {
    const code = byte(0x8d092 + i);
    items.push({ label: cstr(long(0x8cf1a + 8 * i)), code, command: COMMANDS[code] });
  }
  return { start, items };
}
export const SELECTOR = {
  // labels at window cell (0, 3k): screen (624, 80 + 48k); pointer tiles at text (592, 80 + 48k)
  labelCell: (k) => [0, 3 * k],
  pointer: (k, on) => ({ x: 592, y: 80 + 48 * k, tile: on ? 74 : 79, count: 1 }),
  // mouse hit test (f_81d00): with x >= 8 win.x - 40 the item k under y in [8 win.y + 24k - 4, +24) and
  // x < 8 win.x - 40 + 128; left of that column the selection follows y: <= $5B -> 0, <= $7B -> 1, else 2
  hit(mx, my, n, win = WINDOWS.selector) {
    if (mx >= 8 * win[0] - 40) {
      for (let k = 0; k < n; k++) {
        const y0 = 8 * win[1] + 24 * k - 4;
        if (my >= y0 && my < y0 + 24 && mx < 8 * win[0] - 40 + 128) return k;
      }
      return null;                                        // no change
    }
    return my <= 0x5b ? 0 : my <= 0x7b ? 1 : 2;
  },
  point: (k) => [650, 96 + 48 * k],                      // a screen point inside item k
};
// what f_81d00 draws: clear the window, pointer off at the remembered row ($9DC14), labels, pointer on row 0
export function selectorOps(items, last) {
  const ops = [{ op: 'clear' }, { op: 'tile', ...SELECTOR.pointer(last, false) }];
  items.forEach((it, k) => ops.push({ op: 'print', cx: 0, cy: 3 * k, bytes: it }));
  ops.push({ op: 'tile', ...SELECTOR.pointer(0, true) });
  return ops;
}

// ---- target selection (f_70a96 / f_70e18 / marker f_70cb4 -> f_6e2be) -----------------------------
// hit box of combatant (x, y): mouse x in [16x + 128, +48), y in [8 (y - 5) + 8, +48): 48 x 96 screen pixels
export const targetBox = (x, y) => ({ x: 64 + 16 * x + 128, y: 2 * (8 * (y - 5) + 8 + 24), w: 48, h: 96 });
export const targetPoint = (x, y) => { const b = targetBox(x, y); return [b.x + 24, b.y + 48]; };
export function targetHit(mx, my, cands, recs) {
  for (const id of cands) {
    const r = recs[id], x0 = 16 * r.x + 128, y0 = 8 * (r.y - 5) + 8;
    if (mx >= x0 && mx < x0 + 48 && my >= y0 && my < y0 + 48) return id;
  }
  return -1;
}
// marker: ASDF tiles 84 (top) and 89 (bottom), masked, into both text pages at
// text (64 + 16 (x + 9), 48 + 16 (y - 4)) and 16 lines below; shown while $A1B50 = 1 (toggles every 10 frames)
export function markerTiles(x, y) {
  const X = 64 + 16 * (x + 1 + 8), Y = 48 + 16 * (y - 5 + 1);
  return [{ x: X, y: Y, tile: 84 }, { x: X, y: Y + 16, tile: 89 }];
}

// ---- battle panel (f_6e0e8 -> f_6e140) -------------------------------------------------------------
// HP (record +22) at text (112, 112 + 96 slot), MP (+20) at (112, 128 + 96 slot): 3 digit tiles,
// right-aligned, clamped to 999; digits 50 + d (40 + d when the value is 0), blank = tile 0
export function battlePanelTiles(slot, hp, mp) {
  const out = [];
  const num = (v, y) => {
    v = Math.min(v, 999);
    const s = String(v).padStart(3, ' ');
    for (let k = 0; k < 3; k++) out.push({ x: 112 + 16 * k, y, tile: s[k] === ' ' ? 0 : (v ? 50 : 40) + (s.charCodeAt(k) - 48), count: 1 });
  };
  num(hp, 112 + 96 * slot); num(mp, 128 + 96 * slot);
  return out;
}

// ---- battle records ($9F2A2 + 36 i; i = 0-2 party slots, 3-7 enemies) ----------------------------------
export function parseRecords(hex) {
  const b = Buffer.from(hex, 'hex'), out = [];
  for (let i = 0; i < 8; i++) {
    const o = 36 * i, le = (k) => b[o + k] | (b[o + k + 1] << 8);
    out.push({ i, x: b[o], y: b[o + 1], spr: b[o + 2], flags: b[o + 3], alive: (b[o + 3] & 0x80) !== 0, id: b[o + 5],
      cgHdr: le(6), blink: b[o + 10], seal: b[o + 11], illusion: b[o + 12], sleep: b[o + 15], confuse: b[o + 16], gauge: null,
      speed: b[o + 18], mp: le(20), hp: le(22), idle: b[o + 28], b29: b[o + 29], b31: b[o + 31], raw: [...b.subarray(o, o + 36)] });
  }
  return out;
}

// ---- status list f_6f9ae (message window while a party member chooses) ------------------------------
// "            ［ステータス］\n" ($8D0B2), then per party slot with an alive record: name padded to 12
// bytes + 7 two-byte marks (default "－" $815D; 縛 bit 6, 麻 bit 2, 毒 bit 1 of +3; 封 +11, 幻 +12,
// 眠 +15, 乱 +16 non-zero) + "\n"; printed with f_6dee4(0, 1, line) -> f_72286(0, ...)
const MARKS = [[(r) => r.flags & 0x40, 0x8d0ce], [(r) => r.flags & 4, 0x8d0d0], [(r) => r.flags & 2, 0x8d0d2],
  [(r) => r.raw[11], 0x8d0d4], [(r) => r.raw[12], 0x8d0d6], [(r) => r.raw[15], 0x8d0d8], [(r) => r.raw[16], 0x8d0da]];
export function statusLines(recs, partySize, nameOf) {
  const lines = [cstr(0x8d0b2)];
  for (let k = 0; k < partySize; k++) {
    const r = recs[k]; if (!r.alive) continue;
    const name = nameOf(r.id), line = [];
    for (let i = 0; i < 12; i++) line.push(name[i] ?? 0x20);
    for (const [test, a] of MARKS) line.push(...(test(r) ? [byte(a), byte(a + 1)] : [0x81, 0x5d]));
    line.push(0x0a);
    lines.push(line);
  }
  return lines;
}

// ---- message templates ------------------------------------------------------------------------------
// f_72286's placeholders (code at $72542..$7269e): '#n' signed decimal of $9ED9E[n-1]; '*n' the same
// right-aligned in 6 columns (f_88d6e with pad ' '); '$n' a string chosen by $9EDB6[n-1]:
//   -1 -> IC_TABLE + LE word at $9EDA4[n-1] + 2; -2 -> the C string at pointer $9EDA4[n-1];
//   0 -> f_721f2: name of the character / enemy id $9EDB0[n-1] (table 0);
//   t > 0 -> IC_TABLE table t, record $9EDB0[n-1] (stride $8D0DE[t], name offset $8D108[t]);
// '$$' a dollar sign, '&d' colour d, '%xy' skipped, ':' page break, $0F wait, '\n' new line.
export const TABLE_STRIDE = (t) => word(0x8d0de + 2 * t);
export const TABLE_NAMEOFF = (t) => word(0x8d108 + 2 * t);
export function slotString(slot) {   // slot = {id, tab, ptr, str}
  const T = SYS.tables(), raw = T.raw, u16 = (o) => raw[o] | (raw[o + 1] << 8);
  const icStr = (o) => { const out = []; for (let i = o; raw[i]; i++) out.push(raw[i]); return out; };
  if (slot.tab === -2) return slot.str ?? [];
  if (slot.tab === -1) return icStr(slot.ptr & 0xffff);      // IC_TABLE string at the low word of $9EDA4[n-1]
  if (slot.tab === 0) return nameOf(slot.id);
  const base = T.offsets[slot.tab];
  return icStr(u16(base + slot.id * TABLE_STRIDE(slot.tab) + TABLE_NAMEOFF(slot.tab)));
}
// f_721f2 / f_6b926: table 0 {u8 id, u16 name, u16 actions} until $FF
export function nameOf(id) {
  const T = SYS.tables(), raw = T.raw, u16 = (o) => raw[o] | (raw[o + 1] << 8);
  for (let a = T.offsets[0]; raw[a] !== 0xff; a += 5) if (raw[a] === id) { const o = []; for (let i = u16(a + 1); raw[i]; i++) o.push(raw[i]); return o; }
  return [];
}
// expand a template into the byte stream the engine draws (control codes kept: \n, :, $0F)
export function expand(tmpl, { ids = [0, 0, 0], tabs = [0, 0, 0], ptrs = [0, 0, 0], strs = [], nums = [0, 0, 0] } = {}) {
  const out = [];
  for (let p = 0; p < tmpl.length && tmpl[p];) {
    const c = tmpl[p];
    if (c === 0x23 || c === 0x2a) {
      const n = tmpl[p + 1] - 0x31, v = nums[n] ?? 0; p += 2;
      out.push(...ascii(c === 0x23 ? String(v) : String(v).padStart(6, ' ')));
    } else if (c === 0x24) {
      if (tmpl[p + 1] === 0x24) { out.push(0x24); p += 2; continue; }
      const n = tmpl[p + 1] - 0x31; p += 2;
      out.push(...slotString({ id: ids[n], tab: tabs[n], ptr: ptrs[n], str: strs[n] }));
    } else if (c === 0x26 || c === 0x25) { p += c === 0x26 ? 2 : 3; }
    else if (c >= 0x81 && c <= 0x9f || c >= 0xe0 && c <= 0xef) { out.push(c, tmpl[p + 1]); p += 2; }
    else { out.push(c); p++; }
  }
  return out;
}

// ---- known battle templates (ICITY68 image) ---------------------------------------------------------
export const TEMPLATES = {
  encounter: 0x6abbc,        // 敵と遭遇した (f_6abca, ordinary battles only)
  turn: 0x8d160,             // $1の攻撃\n (f_6f888: header while a party member chooses)
  statusHead: 0x8d0b2,       // ［ステータス］ (f_6f9ae)
  attackWith: 0x8d16a,       // $3で攻撃 (f_71084: weapon line)
  ammo: 0x8d173,             // ［$2］ 残弾数 *1 連射弾数 *3 単射弾数 *2 (firearms)
  attackerWith: 0x8d1ae,     // $1が$3で攻撃 (party attack, f_6baa4)
  damage: 0x8d1bb,           // $2に#1のダメージ
  enemyAttack: 0x8d491,      // $1が攻撃
  cannotMove: 0x8d49a,       // $1は動けない
  win: 0x6b396,              // 敵を排除
  exp: 0x6b39f,              // ＥＸＰ　#1を得た
  money: 0x6b3b0,            // 賞金　　#1H$$を得た
  level: 0x6b4e2,            // $1は#1レベルに到達した
  found: 0x6b630,            // $1を見つけた
  gameOver: 0x6b79e,         // － ＧＡＭＥ ＯＶＥＲ －
};
export const template = (k) => cstr(TEMPLATES[k] ?? k);
