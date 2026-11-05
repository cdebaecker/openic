// Reference model of the ICITY68 game systems (milestone 5): character records and derived stats,
// level-up, effects, field use of items and spells, inventory, equipment, shops, inn, checkpoint,
// save/load, settings. Spec: docs/systems.md. Verified against emulator traces by
// tools/systems/trace.mjs (verify).
//
// Every function works on the game state object of tools/events/vm.mjs (`state.block` = the
// 954-byte block $9C794 = the save file, `state.rt` = run-time values) and transcribes one ICITY68
// routine; the routine is named in its comment. Interactive routines (a menu loop that lets the
// player apply an item several times, choose targets, confirm) take the player's answers as
// arguments, in the order the game asks for them, so a port can drive them from its own UI and a
// trace can replay what the player did.
//
//   import * as SYS from './tools/systems/model.mjs';
//   SYS.useItem(state, slot, code, [targetSlot, ..., -1]);   // ITEM > use
//   SYS.castSpell(state, char, spell, { mode, targets });     // MAGIC
//   SYS.equip(state, partySlot, row, itemIndex);              // EQUIP
//   SYS.shopBuy(state, shop, code, qtyIndex, true);           // builtin 35 mode >= 2
//   SYS.rest(state);                                          // builtin 35 mode 1
//   SYS.saveFile(state, actors) / SYS.loadFile(state, bytes)  // ISV0-7.DAT
//
// Randomness: level-up draws from the C library rand() through f_88e00(n) = n ? rand() % n : 0.
// Functions that need it take `rng(n)`; `CRand` is the library generator itself (f_8b718).
import { OFF, CHAR_SIZE, S, giveItem as vmGiveItem } from '../events/vm.mjs';
import { loadTables, codeClass, itemPrice } from './tables.mjs';

let TABLES = null;
export const tables = () => (TABLES ??= loadTables());
export function setTables(T) { TABLES = T; }

// ---- character records ($9C9B2 + 40*c, block +$21E) -----------------------------------------
export const C = {
  EXP: 0,        // 24-bit LE experience (+0..+2)
  LEVEL: 3,      // level (99 = max: no more experience needed)
  FLAGS: 4,      // derived: bit 5 firearm equipped, bit 4 / bit 2 equipment flags (effects 77, 84)
  HIT: 5,        // derived: hit-rate modifier (signed; effects 49-51, 83)
  AGI: 6,        // base agility (素早さ), grows on level-up
  AGI_EQ: 7,     // derived: agility from equipment (signed; effects 52-55)
  MAXMP: 8, MP: 10, MAXHP: 12, HP: 14,   // LE words (術気 = MP, 体力 = HP)
  VIT: 16,       // base defence (防御力), grows on level-up
  DEF: 17,       // derived LE word: armour defence (防御力 +)
  POW: 19,       // base attack (攻撃力), grows on level-up
  ATK: 20,       // derived LE word: weapon attack (攻撃力 +)
  MASK: 22,      // weapon types the character can equip (bit = type, see tables.WEAPON_TYPES)
  WEAPON: 23,    // weapon index (table 6), 0 = none
  ARMOUR: 24,    // body armour index (table 7), 0 = none
  ACC: 25,       // 3 accessory indices (table 7), +25..+27
  SKILL: 28,     // 4 LE words: weapon skill counters (status screen; battle, milestone 6)
  FX36: 36, FX37: 37, FX38: 38, // derived: resistance / immunity bits from equipment
};
export const charOff = (c) => OFF.chars + CHAR_SIZE * c;
const le16 = (s, o) => s.block[o] | (s.block[o + 1] << 8);
const setLe16 = (s, o, v) => { s.block[o] = v & 255; s.block[o + 1] = (v >> 8) & 255; };
const be16 = (s, o) => (s.block[o] << 8) | s.block[o + 1];
const setBe16 = (s, o, v) => { s.block[o] = (v >> 8) & 255; s.block[o + 1] = v & 255; };
export const cget = (s, c, f) => s.block[charOff(c) + f];
export const cset = (s, c, f, v) => { s.block[charOff(c) + f] = v & 255; };
export const cget16 = (s, c, f) => le16(s, charOff(c) + f);
export const cset16 = (s, c, f, v) => setLe16(s, charOff(c) + f, v);
export const exp = (s, c) => s.block[charOff(c)] | (s.block[charOff(c) + 1] << 8) | (s.block[charOff(c) + 2] << 16);
const setExp = (s, c, v) => { const o = charOff(c); s.block[o] = v & 255; s.block[o + 1] = (v >> 8) & 255; s.block[o + 2] = (v >> 16) & 255; };
export const party = (s) => [0, 1, 2].map((i) => be16(s, OFF.party + 2 * i));   // all three words (not limited by the party size)

// Readable view of a character (for UIs and debugging).
export function charInfo(s, c) {
  const g = (f) => cget(s, c, f), w = (f) => cget16(s, c, f), sb = (v) => (v << 24) >> 24;
  return {
    exp: exp(s, c), level: g(C.LEVEL), hp: w(C.HP), maxHp: w(C.MAXHP), mp: w(C.MP), maxMp: w(C.MAXMP),
    power: g(C.POW), attack: w(C.ATK), vitality: g(C.VIT), defence: w(C.DEF), agility: g(C.AGI), agilityEq: sb(g(C.AGI_EQ)), hit: sb(g(C.HIT)),
    flags: g(C.FLAGS), fx: [g(C.FX36), g(C.FX37), g(C.FX38)], mask: g(C.MASK), weapon: g(C.WEAPON), armour: g(C.ARMOUR), accessories: [g(25), g(26), g(27)],
    skill: [w(28), w(30), w(32), w(34)], next: expNeeded(s, c),
  };
}

// ---- RNG: the C library rand() of ICITY68 (f_8b718, srand f_8b6ca, refill f_8b6f4) -----------
// 55-word table at $9DCD2, index at $8B74C (-1 = not seeded: rand() seeds with 51 first).
export class CRand {
  constructor(table = null, index = -1) { this.t = new Uint16Array(55); if (table) this.t.set(table); this.i = index; }
  srand(seed) {
    let d0 = seed >>> 0;
    for (let k = 0; k < 55; k++) { d0 = (((d0 & 0xffff) * 0x3d09) >>> 0); d0 = ((d0 & 0xffff0000) | ((d0 + 1) & 0xffff)) >>> 0; this.t[k] = d0 & 0xffff; }
    this.i = 54; this.refill();
  }
  refill() {
    const t = this.t;
    for (let k = 0; k < 24; k++) t[k] = (t[k] - t[k + 31]) & 0xffff;
    for (let k = 24; k < 55; k++) t[k] = (t[k] - t[k - 24]) & 0xffff;
  }
  rand() {
    if (this.i < 0 || this.i > 0x7fff) this.srand(0x33);
    if (this.i === 54) { this.refill(); this.i = -1; }
    this.i++;
    return this.t[this.i] & 0x7fff;
  }
  // f_88e00(n): n ? rand() % n : 0  (rand() is not called for n = 0)
  mod(n) { n &= 0xffff; return n ? this.rand() % n : 0; }
  get fn() { return (n) => this.mod(n); }
}

// ---- derived stats: f_81850 (one party slot) / f_72e24 (all eight characters) ---------------
// Clears +4/+5/+7/+17/+20/+36..+38, then: weapon attack, firearm flag and the weapon's passive
// effect; armour + accessories: defence and their passive effects (table 5 passive = 1).
export function recomputeChar(s, c, rt = s.rt) {
  const T = tables(), o = charOff(c), b = s.block;
  setLe16(s, o + C.ATK, 0); setLe16(s, o + C.DEF, 0);
  b[o + 5] = 0; b[o + 7] = 0; b[o + 4] = 0; b[o + 36] = 0; b[o + 37] = 0; b[o + 38] = 0;
  const w = b[o + C.WEAPON];
  if (w) {
    // weapon data record (table 1) through the weapon's offset (raw reads, as the routine does)
    const T6 = T.offsets[6] + 8 * w, raw = T.raw, d = raw[T6 + 6] | (raw[T6 + 7] << 8);
    setLe16(s, o + C.ATK, raw[d + 2] | (raw[d + 3] << 8));
    if (rt) rt.targets = [0];                       // $A1AAA = 1, $A1AAC = slot (unused by passive effects)
    if (raw[d + 5] & 0x80) b[o + 4] = (b[o + 4] & 0xdf) | 0x20;
    effect(s, raw[d], 1, { rec: c });
  }
  for (let k = 0; k < 4; k++) {
    const a = b[o + C.ARMOUR + k];
    if (!a) continue;
    const r = armourRaw(a);
    setLe16(s, o + C.DEF, le16(s, o + C.DEF) + r.defence);
    effect(s, r.effect, 1, { rec: c });
  }
}
// armour record by index straight from the raw table (indices past the table read what follows)
function armourRaw(i) { const T = tables(), a = T.offsets[7] + 8 * i, r = T.raw; return { defence: r[a + 4] | (r[a + 5] << 8), effect: r[a + 6], category: r[a + 7] }; }
export function recomputeAll(s) { for (let c = 0; c < 8; c++) recomputeChar(s, c); }   // f_72e24
// f_81850(slot): the routine takes a party slot
export const recomputeSlot = (s, slot) => recomputeChar(s, party(s)[slot]);

// ---- effects: f_847b4(?, record, effect, mode) ----------------------------------------------
// mode 1 = equipment (only passive effects run), mode 2 = action (only non-passive effects run).
// Targets of action effects are party slots (actor indices: the field uses actor record +8 =
// party slot; the model assumes actor i is party slot i, as on every map). Effects that only
// touch battle records (status cures 26-29, debuffs, attacks) change nothing in the game state
// when used in the field; they are reported as { battleOnly: true }.
const HEAL_HP = { 18: 50, 19: 100, 20: 300, 21: 9999 };            // f_845c2(n): 体力 (HP)
const HEAL_MP = { 22: 100, 23: 200, 24: 999, 25: 16 };             // f_846ba(n): 術気 (MP)
// s.fixes?.effects: the MSX values (霊神石 MP + 20, 延寿丸 MP + 999; battle model FIXES 'effects')
export function effect(s, id, mode, { rec = null, targets = null } = {}) {
  const T = tables();
  if (!id || id > 0x6f) return { skipped: true };
  const passive = T.effects[id]?.passive ?? 0;
  if (passive ? mode !== 1 : mode !== 2) return { skipped: true };   // f_8456c
  if (mode === 1) { passiveEffect(s, rec, id); return { passive: true }; }
  targets ??= s.rt?.targets ?? [];
  const P = party(s);
  if (HEAL_HP[id] !== undefined) { for (const t of targets) heal(s, P[t], C.HP, C.MAXHP, HEAL_HP[id]); return { heal: 'hp' }; }
  const fix = !!s.fixes?.effects;
  if (HEAL_MP[id] !== undefined) { for (const t of targets) heal(s, P[t], C.MP, C.MAXMP, fix && id === 25 ? 20 : HEAL_MP[id]); return { heal: 'mp' }; }
  switch (id) {
    case 30: for (const t of targets) { heal(s, P[t], C.HP, C.MAXHP, 9999); } for (const t of targets) heal(s, P[t], C.MP, C.MAXMP, fix ? 999 : 16); return { heal: 'full', battleOnly: true }; // f_84d5a: + status cures (battle)
    case 31: return { none: true };                                   // f_84d78: sound only
    case 67: setBe16(s, 0x3b8, 200); return { repel: 200 };           // f_853ca: $9CB4C = 200 (encounter repel steps)
    case 90: return returnSpell(s);                                   // f_85602
    default: return { battleOnly: true };
  }
}
// f_845a2(max, cur, add): clamp to [0, max] on signed words
function heal(s, c, fCur, fMax, add) {
  const max = (cget16(s, c, fMax) << 16) >> 16, cur = cget16(s, c, fCur);
  let v = ((cur + add) << 16) >> 16; if (v < 0) v = 0; if (max < v) v = max;
  cset16(s, c, fCur, v);
}
// passive (equipment) effects, applied to the character record ($9DC2E)
function passiveEffect(s, c, id) {
  const o = charOff(c), b = s.block;
  const add8 = (f, v) => { b[o + f] = (b[o + f] + v) & 255; };
  const or8 = (f, m) => { b[o + f] |= m; };
  const atk = (v) => { if (!(b[o + 4] & 0x20)) setLe16(s, o + C.ATK, le16(s, o + C.ATK) + v); };
  switch (id) {
    case 49: add8(5, 0x20); break; case 50: add8(5, 0x40); break; case 51: add8(5, 0xe0); break;
    case 52: add8(7, 10); break; case 53: add8(7, 20); break; case 54: add8(7, -10); break; case 55: add8(7, -20); break;
    case 56: atk(20); break; case 57: atk(40); break; case 58: atk(80); break;
    case 59: or8(37, 4); break; case 60: or8(37, 2); break; case 61: or8(37, 1); break; case 62: or8(37, 0x80); break;
    case 63: or8(37, 0x40); break; case 64: or8(37, 0x20); break; case 65: or8(37, 0x10); break;
    case 73: or8(36, 0x40); break; case 74: or8(36, 0x20); break; case 75: or8(36, 0x10); break;
    case 76: or8(38, 0x10); break; case 77: or8(4, 0x10); break; case 78: or8(38, 4); break;
    case 80: atk(40); add8(7, -10); break;                 // 57 + 54
    case 81: or8(36, 0x20); add8(7, 10); break;            // 74 + 52
    case 82: or8(36, 8); break;
    case 83: or8(36, 0x80); add8(5, 0x20); break;          // + 49
    case 84: or8(38, 8); or8(4, 4); break;
    default: break;
  }
}
// f_85602: the return spell (瞬帰): warp to the return point of builtin 22 ($9CB3C, block +$3A8)
function returnSpell(s) {
  const rt = s.rt, b = s.block;
  rt.nextMap = String.fromCharCode(b[0x3a8], b[0x3a9], b[0x3aa]).replace(/\0.*/, '');
  const disk = be16(s, 0x3b6);                 // $9CB4A
  setBe16(s, 0x002, disk);                     // $9C796
  setBe16(s, 0x000, rt.hdd ? disk : (rt.drives === 4 ? 7 : 0));
  rt.pendingTrigger = ((be16(s, 0x3ac) - 1) << 16) >> 16;  // $9CB40 - 1
  rt.facing = be16(s, 0x3ae);                  // $9CB42
  rt.warpLongjmp = 1;                          // longjmp($A06BA): the field loop loads the map
  return { warp: rt.nextMap };
}

// ---- level and experience --------------------------------------------------------------------
// f_81a52(c): total experience needed for the next level = sum over k = 1..level of
// expCurve[c][min(k,40) >> 2] * min(k,40)^2; 0 at level 99. (f_80bd2, the status screen's NEXT,
// computes the same sum.)
export function expNeeded(s, c) {
  const T = tables(), lv = cget(s, c, C.LEVEL);
  if (lv === 99) return 0;
  let sum = 0;
  for (let k = 1; k <= lv; k++) { const kk = Math.min(k, 40); sum = (sum + T.expCurve[c][kk >> 2] * kk * kk) >>> 0; }
  return sum;
}
// f_81b68 + f_81b90: level +1 and stat growth (table 3), 5 rng draws in this order
export function levelUp(s, c, rng) {
  const T = tables(), g = T.growth[c].raw, o = charOff(c), b = s.block;
  b[o + C.LEVEL] = (b[o + C.LEVEL] + 1) & 255;
  let r = rng((g[3] + 5) >> 2);
  setLe16(s, o + C.MAXHP, le16(s, o + C.MAXHP) + g[3] + r + 5);
  if (g[4]) { r = rng(g[4] >> 2); setLe16(s, o + C.MAXMP, le16(s, o + C.MAXMP) + g[4] + r); }
  r = rng(g[1] >> 2); b[o + C.POW] = Math.min(255, b[o + C.POW] + g[1] + r);
  r = rng(g[2] >> 2); b[o + C.VIT] = Math.min(255, b[o + C.VIT] + g[2] + r);
  r = rng(g[0] >> 2); b[o + C.AGI] = Math.min(255, b[o + C.AGI] + g[0] + r);
}
// f_759c2: 24-bit add to the experience (returns the new value)
export function addExp(s, c, n) { const v = (exp(s, c) + (n & 0xffffff)) & 0xffffff; setExp(s, c, v); return v; }
// after a battle (f_6b4fa, per living party member): experience += n, then level up while the
// next threshold is reached (each level-up shows a message and plays sound $14)
export function gainExp(s, c, n, rng) {
  const e = addExp(s, c, n); let ups = 0;
  for (;;) { const need = expNeeded(s, c); if (!need || need > e) break; levelUp(s, c, rng); ups++; }
  return ups;
}
// builtin 31 (f_7c2ee) with lv != 0: experience := the amount needed to reach lv, then level up
// from the current level while it suffices; full heal of everybody. Returns lv.
export function setLevel(s, c, lv, rng) {
  const o = charOff(c), old = s.block[o + C.LEVEL];
  s.block[o + C.LEVEL] = (lv - 1) & 255;
  const target = expNeeded(s, c) | 0;
  s.block[o] = 0; s.block[o + 1] = 0; s.block[o + 2] = 0;
  addExp(s, c, target);
  s.block[o + C.LEVEL] = old;
  for (;;) { const need = expNeeded(s, c) | 0; if (!need || need > target) break; levelUp(s, c, rng); }
  fullHeal(s);
  return lv;
}

// ---- inn / full heal: f_7beb0 (builtin 35 mode 1, event battles, builtin 31) ----------------
export function fullHeal(s) { for (let c = 0; c < 8; c++) { cset16(s, c, C.HP, cget16(s, c, C.MAXHP)); cset16(s, c, C.MP, cget16(s, c, C.MAXMP)); } }
export const rest = fullHeal;   // builtin 35(1): fade out, f_7beb0, fade in (the script charges the price with builtin 26)

// ---- inventory (the menus' routines; the VM's give/take are in tools/events/vm.mjs) ---------
// One list of 48 slots {LE code, LE count} at $9C8D8: slots 0-39 ordinary items, 40-47 key items.
const SLOT = (i) => OFF.items + 4 * i;
export const slotCode = (s, i) => le16(s, SLOT(i));
export const slotCount = (s, i) => le16(s, SLOT(i) + 2);
// f_7ea3c: cannot be dropped / sold (and lives in the key-item slots): codes $40-$FF with a zero
// high byte, and $201, $238, $317, $331
export function isKeyItem(code) { return ((code & 0xff00) === 0 && (code & 0xffff) > 0x3f) || [0x201, 0x238, 0x317, 0x331].includes(code & 0xffff); }
// f_80c6a(code, delta): add (delta > 0) or remove (delta < 0) items. Returns 0 = done, 1 = no
// free slot, 2 = the count would leave 0..9999 (nothing changed). A slot whose count reaches 0 is
// freed (code := 0). New items go to the first slot of their list (0-39 or, for key items except
// $201, 40-47) whose code low byte is 0 or whose count is 0.
export function invAdd(s, code, delta) {
  code &= 0xffff; delta = (delta << 16) >> 16;
  if ((code & 0xff) === 0) return 0;
  let i = 0;
  for (; i <= 47; i++) if (slotCode(s, i) === code) break;
  if (i <= 47) {
    const n = ((slotCount(s, i) << 16) >> 16) + delta;
    if (n < 0 || n > 9999) return 2;
    setLe16(s, SLOT(i) + 2, ((slotCount(s, i) << 16) >> 16) + delta);
  } else {
    const list = code === 0x201 ? 0 : (isKeyItem(code) ? 1 : 0);
    const [lo, hi] = [[0, 40], [40, 48]][list];
    for (i = lo; i < hi; i++) if ((slotCode(s, i) & 0xff) === 0 || slotCount(s, i) === 0) break;
    if (i >= hi) return 1;
    if (delta > 0) { setLe16(s, SLOT(i), code); setLe16(s, SLOT(i) + 2, delta); }
  }
  if (slotCount(s, i) === 0) setLe16(s, SLOT(i), 0);
  return 0;
}
// f_84534(delta): money += delta unless that would be negative (returns 1, nothing changed);
// capped at 9 999 999. Money = BE u32 at block +$204.
export function addMoney(s, delta) {
  const m = S.money(s) | 0;
  if (((m + delta) | 0) < 0) return 1;
  let v = (m + delta) >>> 0; if (v > 9999999) v = 9999999;
  S.setMoney(s, v); return 0;
}
// f_7ea98(mode): building the item list (every time the item menu is drawn, and for the shops'
// SELL page) frees the slots whose count is 0. Returns the 48 rows with an `enabled` flag as the
// menu shows them: mode 0 use (field-usable items), 1 sort (slots 0-39), 2 drop/sell (not key
// items), 3 all.
export function itemList(s, mode) {
  const T = tables(), rows = [];
  for (let i = 0; i < 48; i++) {
    if (slotCount(s, i) === 0) setLe16(s, SLOT(i), 0);
    const code = slotCode(s, i);
    let en = false;
    if (mode === 0) en = (code >> 8) <= 1 && !!T.items[code & 0xff]?.field;
    else if (mode === 1) en = i <= 39;
    else if (mode === 2) en = !isKeyItem(code);
    rows.push({ slot: i, code, count: slotCount(s, i), enabled: en });
  }
  return rows;
}
// ITEM > 入替 (sort): swap two slots (both must be 0-39; f_7ec7e)
export function swapSlots(s, a, b) {
  if (a < 0 || a > 39 || b < 0 || b > 39) return false;
  const ca = slotCode(s, a), na = slotCount(s, a), cb = slotCode(s, b), nb = slotCount(s, b);
  setLe16(s, SLOT(a), cb); setLe16(s, SLOT(a) + 2, nb); setLe16(s, SLOT(b), ca); setLe16(s, SLOT(b) + 2, na);
  return true;
}
// ITEM > 捨てる (drop): what 0 = one, 1 = all (after the yes/no prompt; f_7ec7e)
export function dropItem(s, slot, what) {
  const code = slotCode(s, slot);
  if (!(code & 0xff) || isKeyItem(code)) return false;
  if (what === 0) return invAdd(s, code, -1) === 0;
  if (what === 1) return invAdd(s, code, -slotCount(s, slot)) === 0;
  return false;
}

// ---- ITEM > use: f_8148c(slot, code) ---------------------------------------------------------
// HP medicines (codes 1-4, 50-53) and MP medicines (5-7) ask for a party member again and again:
// `choices` are the answers of the character window (party slot, or -1 = cancel / a member that
// cannot be chosen). A member at full HP (MP) is refused with a beep. The loop ends on -1, or when
// as many items as the slot held have been used. Other field items apply their effect once.
// Afterwards the used count is removed unless the item is reusable (flags bit 2).
// Returns { used, applied: [{slot, char}], refused, end: 'cancel' | 'empty' | 'once' }.
export function useItem(s, slot, code, choices = []) {
  const T = tables(), it = T.items[code & 0xff], q = [...choices];
  if ((code >> 8) > 1 || !it?.field) return { used: 0, applied: [], refused: 0, end: 'not-usable' };  // the menu beeps
  let used = 0, refused = 0, end;
  const applied = [];
  const kind = code >= 1 && code <= 4 || code >= 50 && code <= 53 ? 'hp' : code >= 5 && code <= 7 ? 'mp' : null;
  if (kind) {
    const [fCur, fMax] = kind === 'hp' ? [C.HP, C.MAXHP] : [C.MP, C.MAXMP];
    for (;;) {
      const t = q.length ? q.shift() : -1;
      if (t === -1) { end = 'cancel'; break; }
      const c = party(s)[t];
      if (cget16(s, c, fCur) < cget16(s, c, fMax)) {
        s.rt.targets = [t];
        effect(s, it.effect, 2, { targets: [t] });
        used++; applied.push({ slot: t, char: c });
      } else refused++;
      if (!it.reusable && used >= slotCount(s, slot)) { end = 'empty'; break; }
    }
  } else {
    effect(s, it.effect, 2, {});
    used = 1; end = 'once';
  }
  if (!it.reusable && used) invAdd(s, code, -used);
  return { used, applied, refused, end };
}

// ---- MAGIC: f_80e9a(char, spell) ---------------------------------------------------------------
// Field-castable spells (flags bit 4). Cost = spell cost (0 for character 6). flags bit 6 only:
// one target, repeated like the medicines; bit 7 only: the whole party at 4x the cost; both: the
// player chooses (opts.mode 0 = one, 1 = all, -1 = cancel). Spell 1 (瞬帰, all) needs a return
// point ($9CB40 != 0). opts.targets = answers of the character window for mode 0.
// Returns { mode, casts, result } (result: 'cancel' | 'no-mp' | 'empty' | 'full' | 'no-return' | 'warp' | 'done').
export function castSpell(s, caster, spell, opts = {}) {
  const T = tables(), sp = T.spells[spell];
  const cost = caster === 6 ? 0 : sp.cost;
  let mode;
  if (sp.single && sp.all) mode = opts.mode ?? -1;
  else mode = sp.single ? 0 : sp.all ? 1 : 2;
  const mp = () => cget16(s, caster, C.MP);
  const pay = (n) => cset16(s, caster, C.MP, (mp() - n) & 0xffff);
  let casts = 0;
  if (mode === 0) {
    const q = [...(opts.targets ?? [])];
    for (;;) {
      if (mp() < cost || !sp.single) return { mode, casts, result: 'no-mp' };
      const t = q.length ? q.shift() : -1;
      if (t === -1) return { mode, casts, result: 'cancel' };
      const c = party(s)[t];
      if (cget16(s, c, C.HP) < cget16(s, c, C.MAXHP)) {
        s.rt.targets = [t];
        effect(s, sp.effect, 2, { targets: [t] }); pay(cost); casts++;
      }
      if (mp() < cost) return { mode, casts, result: 'empty' };
    }
  }
  if (mode === 1) {
    const c4 = cost * 4;
    if (mp() < c4 || !sp.all) return { mode, casts, result: 'no-mp' };
    if (spell === 1) {
      if (!be16(s, 0x3ac)) return { mode, casts, result: 'no-return' };
      pay(c4); s.rt.targets = []; effect(s, sp.effect, 2, { targets: [] });
      return { mode, casts: 1, result: 'warp' };
    }
    const P = party(s);
    if (!P.some((c) => cget16(s, c, C.HP) < cget16(s, c, C.MAXHP))) return { mode, casts, result: 'full' };
    s.rt.targets = [0, 1, 2];
    effect(s, sp.effect, 2, { targets: [0, 1, 2] }); pay(c4);
    return { mode, casts: 1, result: 'done' };
  }
  if (mode === 2) {
    if (mp() < cost) return { mode, casts, result: 'no-mp' };
    s.rt.targets = []; effect(s, sp.effect, 2, { targets: [] }); pay(cost);
    return { mode, casts: 1, result: 'done' };
  }
  return { mode, casts, result: 'cancel' };
}
// f_7e488: the spells a character knows (table 16), in menu order (two columns: $9C396 / $9C3B6).
const COL1 = [0x0d, 0x0c, 0x0b, 0x0a, 0x02, 0x03, 0x14, 0x15, 0x18, 0x19, 0x1a];
const COL2 = [0x01, 0x0f, 0x10, 0x04, 0x05, 0x07, 0x08, 0x06, 0x12, 0x11];
export function spellList(s, c) {
  const T = tables();
  const list = c === 0 ? 3 + be16(s, OFF.curChar) : c === 3 ? 0 : c === 6 ? 1 : c === 7 ? 2 : -1;
  if (list < 0) return null;
  const known = T.spellLists[list] ?? [];
  const col = (order) => order.filter((id) => known.includes(id)).map((id) => ({ spell: id, name: T.spells[id].name, cost: T.spells[id].cost, field: T.spells[id].field }));
  return { list, left: col(COL1), right: col(COL2) };
}

// ---- EQUIP: f_7f596(slot) --------------------------------------------------------------------
// Characters 4 and 6 cannot equip (f_7e16a). Rows: 0 weapon, 1 body armour (not character 5),
// 2-4 accessories. The candidates (f_7f138) are inventory items of the right class that the
// character may use. Equipping takes the new item out of the inventory and puts the old one back
// (if there is no room, nothing changes and the game beeps), then recomputes the derived stats.
export function equipCandidates(s, c, row) {
  const T = tables(), kind = row === 0 ? 2 : row === 1 ? 3 : 4, out = [];
  for (let i = 0; i <= 47; i++) {
    const code = slotCode(s, i);
    if (!(code & 0xff) || !slotCount(s, i) || (code >> 8) !== (kind === 4 ? 3 : kind)) continue;
    const idx = code & 0xff;
    if (kind === 2) { const t = T.raw[(T.weapons[idx]?.dataOffset ?? 0) + 4]; if (!(cget(s, c, C.MASK) & (1 << t))) continue; }
    if (kind === 3) { if (c === 5) continue; const cat = armourRaw(idx).category; if (cat !== 0 && !(cat === 5 && c === 3)) continue; }
    if (kind === 4) { const cat = armourRaw(idx).category; if (cat > 4 || cat < 1) continue; }
    out.push({ slot: i, code, index: idx, count: slotCount(s, i) });
  }
  return out;
}
// row, itemIndex (the candidate's table index; -1 = cancelled). Returns 'equipped' | 'full' |
// 'clash' (accessory of a category already worn) | 'none' | 'refused'.
export function equip(s, pslot, row, itemIndex) {
  const c = party(s)[pslot];
  if (c === 4 || c === 6 || c > 7) return 'refused';
  if (itemIndex === -1 || itemIndex === null || itemIndex === undefined) return 'none';
  const o = charOff(c), b = s.block;
  if (row === 0) {
    if (!itemIndex) return 'none';
    if (invAdd(s, 0x200 + itemIndex, -1)) return 'none';
    if (invAdd(s, 0x200 + b[o + C.WEAPON], 1) === 0) { b[o + C.WEAPON] = itemIndex; recomputeSlot(s, pslot); return 'equipped'; }
    invAdd(s, 0x200 + itemIndex, 1); return 'full';
  }
  if (row === 1) {
    if (c === 5) return 'refused';
    invAdd(s, 0x300 + itemIndex, -1);
    if (invAdd(s, 0x300 + b[o + C.ARMOUR], 1) === 0) { b[o + C.ARMOUR] = itemIndex; recomputeSlot(s, pslot); return 'equipped'; }
    invAdd(s, 0x300 + itemIndex, 1); return 'full';
  }
  if (row >= 2 && row <= 4) {
    if (itemIndex) {
      const cat = armourRaw(itemIndex).category;
      for (let k = 0; k <= 2; k++) { if (k === row - 2) continue; if (armourRaw(b[o + C.ACC + k]).category === cat) return 'clash'; }
    }
    invAdd(s, 0x300 + itemIndex, -1);
    if (invAdd(s, 0x300 + b[o + C.WEAPON + row], 1) === 0) { b[o + C.WEAPON + row] = itemIndex; recomputeSlot(s, pslot); return 'equipped'; }
    invAdd(s, 0x300 + itemIndex, 1); return 'full';
  }
  return 'none';
}

// ---- shops: f_8393a(shop) / f_83b06(category) ---------------------------------------------------
export const QUANTITIES = [1, 10, 100, 1000, 9999];     // $9CFAE (the quantity menu's choices)
// Row the buy list opens on: the last row whose level <= the hero's level (character 0, +3);
// consecutive rows with the same level count as one (the cursor stays on the first).
export function shopStartRow(rows, heroLevel) {
  let r = 0;
  const lv = (k) => rows[k] ? rows[k].level : null;
  if (rows.length) {
    for (;;) {
      if (r >= rows.length || lv(r) > heroLevel) break;
      r++;
      if (r < rows.length && lv(r) === lv(r - 1)) { r--; break; }
      if (r >= rows.length) break;
    }
  }
  return r ? r - 1 : 0;
}
// Buy `code` (any row of the category) in quantity QUANTITIES[qi]; total = price x qty, -1/8
// for the 1000 pack. confirm = the yes/no answer. Returns 'bought' | 'full' | 'money' | 'cancel'.
export function shopBuy(s, code, qi, confirm = true) {
  if (qi < 0 || !(code & 0xff)) return 'cancel';
  const qty = QUANTITIES[qi];
  let total = Math.imul(itemPrice(tables(), code), qty) >>> 0;
  if (qi === 3) total = (total - (total >> 3)) >>> 0;
  if (!confirm) return 'cancel';
  if (invAdd(s, code, qty)) return 'full';
  if (addMoney(s, -total)) { invAdd(s, code, -qty); return 'money'; }
  return 'bought';
}
// Sell from inventory slot `slot`: qty = min(QUANTITIES[qi], count); money += price x qty x 3/4.
// Refused ('refused') for a zero price and code $201. Returns 'sold' | 'refused' | 'cancel'.
export function shopSell(s, slot, qi, confirm = true) {
  const code = slotCode(s, slot), count = slotCount(s, slot);
  if (!(code & 0xff) || isKeyItem(code) || qi < 0) return 'cancel';
  let qty = QUANTITIES[qi]; if (count < qty) qty = count;
  const total = Math.floor((Math.imul(itemPrice(tables(), code), qty) >>> 0) * 3 / 4) >>> 0;
  if (total === 0 || code === 0x201) return 'refused';
  if (!confirm) return 'cancel';
  invAdd(s, code, -qty); addMoney(s, total);
  return 'sold';
}
export function shopTotal(code, qi, sell = false, count = Infinity) {
  const p = itemPrice(tables(), code);
  if (sell) { const q = Math.min(QUANTITIES[qi], count); return Math.floor(p * q * 3 / 4); }
  let t = p * QUANTITIES[qi]; if (qi === 3) t -= Math.floor(t / 8); return t;
}

// ---- checkpoint, save, load (f_672c4, f_671d4, f_6703e, f_67348) ----------------------------
// `actors` = the 60 bytes of the party's three actor records ($9F722; x, y, facing ... see
// tools/field/model.mjs), copied to block +$35E by every save and checkpoint.
function withDiskWords(s, fn) {
  const w0 = be16(s, 0), w2 = be16(s, 2);
  if (s.rt.hdd) { setBe16(s, 2, s.rt.diskWord ?? 0); setBe16(s, 0, 0); }
  const r = fn();
  setBe16(s, 0, w0); setBe16(s, 2, w2);
  return r;
}
// builtin 1(0) and the save menu's "Quick" (save side): the retry point
export function checkpoint(s, actors) {
  if (actors) s.block.set(actors.subarray(0, 60), OFF.partyPos);
  s.rt.checkpoint = 1;
  withDiskWords(s, () => { s.backup = new Uint8Array(s.block); });
}
// ISV<n>.DAT contents (n = 0..7, on game disk 1 or the user disk); the save also checkpoints
export function saveFile(s, actors) {
  if (actors) s.block.set(actors.subarray(0, 60), OFF.partyPos);
  const file = withDiskWords(s, () => new Uint8Array(s.block));
  checkpoint(s, null);
  return file;
}
// Loading a slot: the file replaces the block except the mouse-mode switch; the disk words are
// rewritten (opts.userDisk: loaded from the user disk -> 7, else 0; hdd install: +0 = +2); the
// party's actor records and facing come from the file; checkpoint; the map id's first byte is set
// to '|' so the field loop reloads the map (mode 2: trigger-block entries +2, then +4).
export function loadFile(s, bytes, opts = {}) {
  const mouse = be16(s, OFF.mouseMode);
  s.block.set(bytes.subarray(0, 954));
  setBe16(s, OFF.mouseMode, mouse);
  setBe16(s, 0, s.rt.hdd ? be16(s, 2) : (opts.userDisk ? 7 : 0));
  s.rt.facing = s.block[OFF.partyPos + 4];
  s.rt.nextMap = S.mapId(s);
  const actors = s.block.slice(OFF.partyPos, OFF.partyPos + 60);
  checkpoint(s, actors);
  s.block[OFF.mapId] = 0x7c;
  s.rt.loadMode = 2;
  return actors;
}
// The save menu's "Quick" (load side) and the retry after a defeat: restore the checkpoint
export function restoreCheckpoint(s, opts = {}) {
  if (!s.rt.checkpoint || !s.backup) return false;
  const mouse = be16(s, OFF.mouseMode);
  s.block.set(s.backup);
  setBe16(s, OFF.mouseMode, mouse);
  setBe16(s, 0, s.rt.hdd ? be16(s, 2) : (opts.drives === 4 ? 7 : 0));
  s.rt.nextMap = S.mapId(s);
  s.block[OFF.mapId] = 0x7c;
  s.rt.pendingTrigger = -1; s.rt.lastTrigger = -1; s.rt.loadMode = 1;
  return true;
}
// What the slot list shows for a file (f_66bf4): hero level (block +$221) and the place name of
// the map (table 19; exact id, else the id with its third character replaced by '0').
export function slotSummary(bytes) {
  const T = tables(), id = String.fromCharCode(bytes[0x124], bytes[0x125], bytes[0x126]);
  let p = T.places.find((x) => x.id === id);
  if (!p && id.charCodeAt(0) > 0x40) p = T.places.find((x) => x.id === id.slice(0, 2) + '0');
  return { level: bytes[0x221], map: id, place: p?.name ?? null };
}

// ---- SYSTEM menu settings (block +$39A..) ------------------------------------------------------
// Speeds 0-8 (shown 1-9; menu f_829d0, wrap around): message $9CB32, movement $9CB2E, battle $9CB30.
export const SPEED = { message: 0x39e, move: 0x39a, battle: 0x39c };
export function stepSpeed(s, which, dir) { const o = SPEED[which]; let v = be16(s, o); v = dir > 0 ? (v + 1) % 9 : (v ? v - 1 : 8); setBe16(s, o, v); return v; }
// a click on the scale (f_829d0): the column, clamped to <= 8 (signed)
export function setSpeed(s, which, v) { v = (v << 16) >> 16; if (v > 8) v = 8; setBe16(s, SPEED[which], v); return v; }
// Switches (f_80516): VR透過 $9CB38, マウス使用 $9CB3A (only with a mouse), 自動回避 $9CB34, 会話 $9CB36.
export const SWITCH = { vr: 0x3a4, mouse: 0x3a6, autoAvoid: 0x3a0, talk: 0x3a2 };
export function toggleSwitch(s, which, mouseAvailable = true) { if (which === 'mouse' && !mouseAvailable) return be16(s, SWITCH.mouse); const o = SWITCH[which]; setBe16(s, o, be16(s, o) ^ 1); return be16(s, o); }

// ---- new game: f_72d5e ---------------------------------------------------------------------------
export function newGameSystems(s) {
  const T = tables();
  T.initialChars.forEach((r, c) => s.block.set(r, charOff(c)));
  s.block.fill(0, OFF.items, OFF.items + 0xc0);
  for (const { code, count } of T.initialItems) vmGiveItem(s, code, count);
  recomputeAll(s);
  s.block.fill(0, OFF.chests, OFF.chests + 32);
  S.setMoney(s, 140);
}
export { codeClass };
