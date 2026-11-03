// Reference model of the ICITY68 event-script VM (interpreter f_7a55e, builtins table $9C240).
// Spec: docs/events.md. Verified against emulator traces by tools/events/trace.mjs (verify).
//
//   import { VM, newState } from './vm.mjs';
//   import { loadScn, loadMap } from './vm/programs.mjs';
//   const state = newState();                       // or stateFromBlock(saveFileBytes)
//   const progs = { main: loadScn('IC_MAIN.SCN'), map: loadMap('A00') };
//   const vm = new VM(progs.map, state, host, { programs: progs });
//   let st = vm.run(entry);                         // runs until 'done' | 'blocked' | 'aborted'
//   while (st === 'blocked') st = vm.resume(valueFromHost);
//
// host = {
//   builtin(n, args, vm)  -> number | { block: any }   builtins not implemented here (cutscenes,
//                          messages, menus, battles, actors, music, random, ...; BUILTINS[n].kind
//                          'host', and the host part of the 'mixed' ones 19 and 33). args[k] = raw value of the
//                          k-th stack entry from the top (first argument = last pushed). Return a
//                          number (-> result register) or { block } to suspend the VM; the host
//                          later calls vm.resume(value).
//   message(offset, vm)   -> undefined | { block }     MSG instruction / builtin 38: show the text at
//                          prog.code[offset] through the message engine (f_7b452).
//   warp?(info, vm)       -> undefined | { block }     builtin 10 when called from IC_MAIN (map load now)
//   onAbort?(vm)                                       builtin 4 (exit) unwound the script
// }
// A "program" is { name, kind: 'main' | 'consult' | 'map', code: Uint8Array } (vm/programs.mjs).
// The game state is plain data (newState): the 954-byte block $9C794-$9CB4D that is also the save
// file, plus a few non-saved run-time values ("rt") that builtins read or set.

// ---- game state ----------------------------------------------------------------------------
export const BLOCK_ADDR = 0x9c794, BLOCK_SIZE = 954;
export const VAR_ADDR = 0x9c798;                  // VM variable 0 (result register)
const VAR_OFF = VAR_ADDR - BLOCK_ADDR;            // 4

// Offsets in the block (address - $9C794). Words marked LE are little-endian (VM variables,
// character records, inventory); the others are 68000 big-endian words.
export const OFF = {
  disk: 0x000,          // 2 x BE word: disk drive/number bookkeeping (patched on save/load)
  vars: 0x004,          // VM variables: var i at $9C798 + i (byte or LE word); 0 = result register
  chests: 0x104,        // $9C898: 256-bit set of opened chests / picked-up items (f_79f7a)
  mapId: 0x124,         // $9C8B8: id of the loaded map (3 chars + 0); '|' in RAM right after a load
  view: 0x128,          // $9C8BC: view origin x, y (BE words), +4 sub layer, +8 second sub layer
  scroll: 0x134,        // $9C8C8: sub-layer scroll steps (cleared by builtin 11)
  camera: 0x13c,        // $9C8D0: camera bounds min x, min y, max x, max y
  items: 0x144,         // $9C8D8: 40 x {LE u16 item code, LE u16 count}
  keyItems: 0x1e4,      // $9C978: 8 x {LE u16 code, LE u16 count} (codes $40-$FF, $217, $231)
  money: 0x204,         // $9C998: BE u32
  curChar: 0x208,       // $9C99C: BE word (builtin 23)
  partyCount: 0x20a,    // $9C99E: BE word
  party: 0x20c,         // $9C9A0: 3 x BE word character ids of the party slots
  partyB: 0x212,        // $9C9A6: 3 x BE word (builtin 33 arg 4)
  partyC: 0x218,        // $9C9AC: 3 x BE word (builtin 33 arg 1 - 1)
  chars: 0x21e,         // $9C9B2: 8 x 40-byte character records (LE words)
  partyPos: 0x35e,      // $9CAF2: 3 x 20-byte actor records of the party (copied on save/checkpoint)
  speed: 0x39a,         // $9CB2E: vsyncs per field tick (5) and other speeds
  mouseMode: 0x3a6,     // $9CB3A: 1 = mouse mode
  returnPoint: 0x3a8,   // $9CB3C: builtin 22 record: map id[3], 0, BE words a, d, b, c, 0, disk
};
export const CHAR_SIZE = 40;

export function newState(block) {
  const b = new Uint8Array(BLOCK_SIZE);
  if (block) b.set(block.subarray(0, BLOCK_SIZE));
  return {
    block: b,
    outside: {},          // VM variables outside the block (address -> byte); never used by the game
    rt: {                 // run-time values outside the save block
      lastTrigger: -1,    // $9EEEA: trigger that fired last (-1 = none); builtin 8 returns it + 1
      pendingTrigger: -1, // $9EEEC: destination trigger after a warp (-1 = none)
      nextMap: null,      // $9EEE2: map id requested by builtin 10
      facing: 0,          // $9EEE8: party facing after a warp
      warpPending: 0,     // $A258A: builtin 10 was called from a map script; the field loop loads the map
      picture: 0,         // $A1BAA: event-picture mode (builtin 20 sets it; warp clears it)
      enemyAction: 0,     // $A1B14: builtin 39 (enemy AI scripts choose an action)
      moneyShown: 0,      // $9ED9E: amount of the last money() call (shown by messages)
      actorsDirty: 0,     // $A2584: builtin 33 changed the party; actors are rebuilt before the next cutscene
      battleFlag: 0,      // $9EEE6: builtin 33(1, 0, ...) sets it to 1, other forms clear it
      itemPending: 0,     // $A1B54 (internal to the inventory code)
      hdd: 0,             // $9DD40: installed on a hard disk (builtin 22 stores the other disk word)
    },
  };
}
export const stateFromBlock = (bytes) => newState(bytes);

// block access
const b8 = (s, off) => s.block[off];
const be16 = (s, off) => (s.block[off] << 8) | s.block[off + 1];
const le16 = (s, off) => s.block[off] | (s.block[off + 1] << 8);
const setBe16 = (s, off, v) => { s.block[off] = (v >> 8) & 255; s.block[off + 1] = v & 255; };
const setLe16 = (s, off, v) => { s.block[off] = v & 255; s.block[off + 1] = (v >> 8) & 255; };
export const S = {
  b8, be16, le16, setBe16, setLe16,
  money: (s) => ((s.block[OFF.money] << 24) | (s.block[OFF.money + 1] << 16) | (s.block[OFF.money + 2] << 8) | s.block[OFF.money + 3]) >>> 0,
  setMoney: (s, v) => { for (let i = 0; i < 4; i++) s.block[OFF.money + i] = (v >>> (24 - 8 * i)) & 255; },
  partyCount: (s) => be16(s, OFF.partyCount),
  partyIds: (s) => [0, 1, 2].slice(0, Math.max(0, Math.min(3, be16(s, OFF.partyCount)))).map((i) => be16(s, OFF.party + 2 * i)),
  char: (s, c) => s.block.subarray(OFF.chars + CHAR_SIZE * c, OFF.chars + CHAR_SIZE * (c + 1)),
  mapId: (s) => String.fromCharCode(...s.block.subarray(OFF.mapId, OFF.mapId + 3)).replace(/\0.*/, ''),
  chestOpen: (s, n) => (s.block[OFF.chests + (n >> 3)] >> (n & 7)) & 1,
  items: (s) => { const out = []; for (let i = 0; i < 40; i++) { const c = le16(s, OFF.items + 4 * i); if (c) out.push({ code: c, count: le16(s, OFF.items + 4 * i + 2) }); } return out; },
  keyItems: (s) => { const out = []; for (let i = 0; i < 8; i++) { const c = le16(s, OFF.keyItems + 4 * i); if (c) out.push({ code: c, count: le16(s, OFF.keyItems + 4 * i + 2) }); } return out; },
};

// VM memory: variable index (signed 16) -> address $9C798 + index
function memAddr(idx) { return VAR_ADDR + ((idx << 16) >> 16); }
function rd8(s, addr) { const o = addr - BLOCK_ADDR; return o >= 0 && o < BLOCK_SIZE ? s.block[o] : (s.outside[addr] ?? 0); }
function wr8(s, addr, v) { const o = addr - BLOCK_ADDR; if (o >= 0 && o < BLOCK_SIZE) s.block[o] = v & 255; else s.outside[addr] = v & 255; }
export const getVar16 = (s, i) => rd8(s, memAddr(i)) | (rd8(s, memAddr(i) + 1) << 8);
export const setVar16 = (s, i, v) => { wr8(s, memAddr(i), v); wr8(s, memAddr(i) + 1, v >> 8); };
export const getVar8 = (s, i) => rd8(s, memAddr(i));
export const setVar8 = (s, i, v) => wr8(s, memAddr(i), v);

// ---- inventory (f_7116c / f_7122c / f_712d8) -------------------------------------------------
// Two lists of {LE u16 code, LE u16 count}: key items (codes $40-$FF with a zero high byte, and
// $217, $231) in 8 slots, all other items in 40 slots. A code's slot is found by linear search;
// code 0 = free slot. Counts are not capped; a slot whose count drops to 0 keeps its code.
function itemList(code) {
  return ((code & 0xff00) === 0 && (code & 0xff) > 0x3f) || code === 0x231 || code === 0x217 ? [OFF.keyItems, 8] : [OFF.items, 40];
}
function findItem(s, code, listCode = code) { const [off, n] = itemList(listCode); for (let i = 0; i < n; i++) if (le16(s, off + 4 * i) === code) return off + 4 * i; return -1; }
export function itemCount(s, code) { if (code === 0) return 0; const p = findItem(s, code); return p < 0 ? 0 : le16(s, p + 2); }
// f_7122c: returns 0 = done, 1 = list full
export function giveItem(s, code, count) {
  code &= 0xffff; count &= 0xffff;
  if ((count & 0xff) === 0) return 0;
  let p = code ? findItem(s, code) : -1;
  if (code && p >= 0) { setLe16(s, p + 2, le16(s, p + 2) + count); return 0; }
  p = findItem(s, 0, code);
  if (p < 0) return 1;
  setLe16(s, p, code); setLe16(s, p + 2, count);
  return 0;
}
// f_712d8: returns 0 = done (or code & $FF = 0), 1 = not held
export function takeItem(s, code, count) {
  code &= 0xffff;
  if ((code & 0xff) === 0) return 0;
  const p = findItem(s, code);
  if (p < 0) return 1;
  let v = ((le16(s, p + 2) - count) << 16) >> 16;
  setLe16(s, p + 2, v < 0 ? 0 : v);
  return 0;
}

// ---- builtins ------------------------------------------------------------------------------
// kind: 'vm' = implemented here (game state only); 'host' = host.builtin; 'mixed' = state part
// here, then host.builtin for the rest; 'nop' = handler $7C7FA (returns 0).
// block: the builtin waits (message engine / cutscene / menu / fade / battle) in the original.
export const BUILTINS = [
  { n: 0, name: 'cutscene', args: ['n'], kind: 'host', block: true, h: 0x7aff2 },
  { n: 1, name: 'saveMenu', args: ['mode'], kind: 'host', block: true, h: 0x7bd9e },
  { n: 2, name: 'callMain', args: ['n'], kind: 'vm', h: 0x7b032 },
  { n: 3, name: 'callMap', args: ['n'], kind: 'vm', h: 0x7b10e },
  { n: 4, name: 'exit', args: [], kind: 'vm', h: 0x7c06c },
  { n: 5, name: 'battle', args: ['event', 'group'], kind: 'host', block: true, h: 0x7c084 },
  { n: 6, name: 'message', args: ['key', 'table'], kind: 'host', block: true, h: 0x7b33e },
  { n: 7, name: 'nop', args: [], kind: 'nop' },
  { n: 8, name: 'triggerIndex', args: [], kind: 'vm', h: 0x7b5b8 },
  { n: 9, name: 'gatherParty', args: [], kind: 'host', block: true, h: 0x7c1d6 },
  { n: 10, name: 'warp', args: ['mapId', 'trigger', 'x', 'y', 'facing'], kind: 'mixed', h: 0x7b5cc },
  { n: 11, name: 'scrollLayer', args: ['layer', 'dx', 'dy', 'speed', 'step'], kind: 'host', block: true, h: 0x7c528 },
  { n: 12, name: 'heroBoost', args: ['what'], kind: 'vm', h: 0x7c4c4 },
  { n: 13, name: 'diskCheck', args: ['n'], kind: 'host', block: true, h: 0x7c10c },
  { n: 14, name: 'nop', args: [], kind: 'nop' },
  { n: 15, name: 'music', args: ['track'], kind: 'host', block: true, h: 0x7ba5e },
  { n: 16, name: 'sound', args: ['n'], kind: 'host', h: 0x7bac4 },
  { n: 17, name: 'nop', args: [], kind: 'nop' },
  { n: 18, name: 'nop', args: [], kind: 'nop' },
  { n: 19, name: 'setCharByte', args: ['char', 'offset', 'value'], kind: 'mixed', h: 0x7c5f0 },
  { n: 20, name: 'picture', args: ['n'], kind: 'host', block: true, h: 0x7bae0 },
  { n: 21, name: 'inParty', args: ['char'], kind: 'vm', h: 0x7c3a8 },
  { n: 22, name: 'setReturnPoint', args: ['mapId', 'a', 'b', 'c', 'd'], kind: 'vm', h: 0x7c3e8 },
  { n: 23, name: 'setCurrentChar', args: ['n'], kind: 'vm', h: 0x7c4aa },
  { n: 24, name: 'menu', args: ['text...', '0'], kind: 'host', block: true, h: 0x7bc48 },
  { n: 25, name: 'yesNo', args: ['text'], kind: 'host', block: true, h: 0x7bb00 },
  { n: 26, name: 'money', args: ['amount', 'add'], kind: 'vm', h: 0x7c194 },
  { n: 27, name: 'nop', args: [], kind: 'nop' },
  { n: 28, name: 'nop', args: [], kind: 'nop' },
  { n: 29, name: 'objectVisible', args: ['n', 'on'], kind: 'host', h: 0x7c680 },
  { n: 30, name: 'random', args: [], kind: 'host', h: 0x7c710 },
  { n: 31, name: 'level', args: ['char', 'level'], kind: 'host', h: 0x7c2ee },
  { n: 32, name: 'nop', args: [], kind: 'nop' },
  { n: 33, name: 'party', args: ['slot', 'op', 'char', 'b', 'actor'], kind: 'mixed', h: 0x7b904 },
  { n: 34, name: 'actorVisible', args: ['actor', 'on'], kind: 'host', h: 0x7be20 },
  { n: 35, name: 'service', args: ['mode'], kind: 'host', block: true, h: 0x7bf14 },
  { n: 36, name: 'nop', args: [], kind: 'nop' },
  { n: 37, name: 'objectHealth', args: ['n'], kind: 'host', h: 0x7c724 },
  { n: 38, name: 'text', args: ['offset'], kind: 'host', block: true, h: 0x7c7ae },
  { n: 39, name: 'setEnemyAction', args: ['n'], kind: 'vm', h: 0x7c7e4 },
  { n: 40, name: 'itemCount', args: ['item'], kind: 'vm', h: 0x7c000 },
  { n: 41, name: 'item', args: ['item', 'count'], kind: 'vm', h: 0x7c026 },
];
for (let n = 42; n < 48; n++) BUILTINS.push({ n, name: 'nop', args: [], kind: 'nop' });

export const OPS = ['load', 'assign', 'inc', 'dec', 'not', 'and', 'or', 'xor', 'add', 'sub', 'mul', 'div', 'mod',
  'eq', 'ne', 'lt', 'le', 'gt', 'ge', 'shl', 'shr'];

export class VMError extends Error {}

const STACK_ENTRIES = 100;               // $A1BBC-$A1D4B (400 bytes)
const ENTRY_MAIN = 0x14, ENTRY_MAP = 1;

// One activation of f_7a55e: own stack (the original saves/restores the 400-byte stack area
// around nested runs), pc, frame pointer.
// The stack area is one block of memory: a run starts with whatever the previous run left there
// (uninitialised locals read stale values), and nested runs work on a copy that is thrown away
// when they end (the original copies the area out and back).
class Context {
  constructor(prog, entry, onEnd, mem) {
    this.prog = prog; this.code = prog.code; this.pc = entry; this.onEnd = onEnd;
    this.t = mem.t; this.v = mem.v;
    this.sp = STACK_ENTRIES; this.fp = STACK_ENTRIES;
  }
}
// stack memory of the interpreter (400 bytes at $A1BBC: 100 x {BE u16 type, BE u16 value})
export function newStackMemory(bytes) {
  const m = { t: new Uint16Array(STACK_ENTRIES), v: new Uint16Array(STACK_ENTRIES) };
  if (bytes) for (let i = 0; i < STACK_ENTRIES; i++) { m.t[i] = (bytes[4 * i] << 8) | bytes[4 * i + 1]; m.v[i] = (bytes[4 * i + 2] << 8) | bytes[4 * i + 3]; }
  return m;
}
const copyMem = (c) => ({ t: c.t.slice(), v: c.v.slice() });

export class VM {
  // opts.programs = { main, map } (callMain / callMap targets); opts.root = VM that a builtin 4
  // (exit) unwinds to (spawned VMs share their parent's).
  constructor(program, state, host = {}, opts = {}) {
    this.prog = program; this.state = state; this.host = host;
    this.programs = opts.programs ?? {};
    this.root = opts.root ?? this;
    this.ctx = [];            // active contexts (innermost last)
    this.status = 'idle';     // idle | running | blocked | done | aborted
    this.pending = null;      // blocked builtin { n } or { msg }
    this.steps = 0;
    this.trace = opts.trace ?? null;   // optional fn(event) for every instruction / builtin
  }

  get r0() { return getVar16(this.state, 0); }
  set r0(v) { setVar16(this.state, 0, v); }

  // f_7a55e(entry): entry 0 = nothing to do. r0: optional value for the result register first
  // (callMain/callMap/f_7b1ea and the cutscene T command set it).
  start(entry, r0) {
    const state = this.state;
    if (r0 !== undefined) this.r0 = r0;
    this.ctx = []; this.pending = null;
    if (!entry) { this.status = 'done'; return this; }
    state.vmStack ??= newStackMemory();
    this.ctx.push(new Context(this.prog, entry & 0xffff, null, this.nested ? copyMem(this.nested) : this.state.vmStack));
    this.status = 'running';
    return this;
  }

  run(entry, r0, limit = 1e7) { this.start(entry, r0); return this.continue(limit); }

  continue(limit = 1e7) {
    while (this.status === 'running' && limit-- > 0) this.step();
    if (this.status === 'running') throw new VMError('step limit reached');
    return this.status;
  }

  // Provide the value of a blocked builtin (ignored for MSG) and continue.
  resume(value = 0, limit) {
    if (this.status !== 'blocked') throw new VMError(`resume while ${this.status}`);
    const p = this.pending; this.pending = null; this.status = 'running';
    if (p.n !== undefined) this.finishSys(p.n, value);
    return this.continue(limit);
  }

  // A new VM on another program sharing this state/host (host-started nested runs: the cutscene
  // T command -> map entry 4, battle hooks -> f_7b1ea). Builtin 4 in it unwinds this VM's root.
  spawn(program = this.prog) {
    const v = new VM(program, this.state, this.host, { programs: this.programs, root: this.root, trace: this.trace });
    v.nested = this.ctx.length ? this.cur() : null;   // runs on a copy of the stack memory
    return v;
  }

  // ---- stack ----------------------------------------------------------------------------
  cur() { return this.ctx[this.ctx.length - 1]; }
  push(c, t, v) { if (c.sp <= 0) throw new VMError('stack overflow'); c.sp--; c.t[c.sp] = t & 0xffff; c.v[c.sp] = v & 0xffff; }
  // f_7ad70: value of an entry
  value(c, i) {
    const t = this.entryType(c, i), v = this.entryValue(c, i);
    switch (t) {
      case 0: case 1: return v;
      case 2: return getVar8(this.state, v);
      case 4: return ((getVar8(this.state, v) << 24) >> 24) & 0xffff;
      case 3: case 5: return getVar16(this.state, v);
      case 6: case 7: return this.slot(c, v);
      default: return t;   // types 8-31: the handler returns the type number
    }
  }
  // f_7adfc: store into an entry's lvalue (types 0, 1 and >= 8: nothing)
  store(c, i, x) {
    const t = this.entryType(c, i), v = this.entryValue(c, i);
    switch (t) {
      case 2: case 4: setVar8(this.state, v, x); break;
      case 3: case 5: setVar16(this.state, v, x); break;
      case 6: case 7: this.setSlot(c, v, x); break;
    }
  }
  // entries beyond the stack area read the interpreter's own variables ($A1D4C sp, $A1D50 fp,
  // $A1D54 base); the game never does this on purpose
  entryType(c, i) { if (i < STACK_ENTRIES) return c.t[i]; return i < STACK_ENTRIES + 3 ? 0x000a : 0; }
  entryValue(c, i) {
    if (i < STACK_ENTRIES) return c.v[i];
    const ptr = (j) => (0x1bbc + 4 * j) & 0xffff;
    return i === STACK_ENTRIES ? ptr(c.sp) : i === STACK_ENTRIES + 1 ? ptr(c.fp) : i === STACK_ENTRIES + 2 ? 0x1bbc : 0;
  }
  slot(c, k) { return this.entryValue(c, c.fp + ((k << 16) >> 16)); }
  setSlot(c, k, x) { const i = c.fp + ((k << 16) >> 16); if (i < 0 || i >= STACK_ENTRIES) throw new VMError(`frame slot ${i} out of the stack`); c.v[i] = x & 0xffff; }
  setTop(c, x) { c.t[c.sp] = 1; c.v[c.sp] = x & 0xffff; }
  // raw values of the top entries = builtin arguments
  args(c, n = 8) { const a = []; for (let k = 0; k < n; k++) a.push(this.entryValue(c, c.sp + k)); return a; }

  // ---- one instruction --------------------------------------------------------------------
  step() {
    const c = this.cur(), code = c.code, at = c.pc;
    if (at >= code.length) throw new VMError(`pc ${at} outside ${c.prog.name}`);
    const b = code[at];
    const u16 = (a) => code[a] | (code[a + 1] << 8);
    this.steps++;
    if (this.trace) this.trace({ e: 'i', pc: at, op: b, depth: STACK_ENTRIES - c.sp, t: c.sp < STACK_ENTRIES ? c.t[c.sp] : -1, v: c.sp < STACK_ENTRIES ? c.v[c.sp] : -1, r0: this.r0, nest: this.ctx.length - 1 });
    switch (b >> 6) {
      case 0: return this.ret(c);
      case 1: {                                  // PUSH type, s8 | u16
        const t = (b & 0x3f) >> 1;
        if (b & 1) { this.push(c, t, u16(at + 1)); c.pc = at + 3; } else { this.push(c, t, (code[at + 1] << 24) >> 24); c.pc = at + 2; }
        return;
      }
      case 2: { c.pc = at + 1; return this.op(c, b & 0x3f); }
      default: {
        const o = b & 0x3f;
        c.pc = at + 1;
        switch (o) {
          case 0: this.r0 = this.value(c, c.sp); c.sp++; return;                       // SETR
          case 1: c.sp += (code[at + 1] << 24) >> 24; c.pc = at + 2; return;              // DROP s8
          case 2: {                                                                       // CALL u16
            this.push(c, 1, at + 3);
            this.push(c, 1, 4 * c.fp);
            c.fp = c.sp; c.pc = u16(at + 1); return;
          }
          case 3: return;                                                                 // NOP
          case 4: c.pc = u16(at + 1); return;                                             // JMP
          case 5: c.pc = (at + 3 + u16(at + 1)) & 0xffff; return;                         // JR
          case 6: c.pc = this.r0 === 0 ? (at + 3 + u16(at + 1)) & 0xffff : at + 3; return; // JZ
          case 7: {                                                                       // MSG u16
            c.pc = at + 3;
            const r = this.host.message ? this.host.message(u16(at + 1), this) : undefined;
            if (r && r.block !== undefined) { this.status = 'blocked'; this.pending = { msg: u16(at + 1), block: r.block }; }
            return;
          }
          case 8: { c.pc = at + 2; return this.sys(c, code[at + 1]); }                    // SYS u8
          default: return;                                                                // $C9-$FF: ignored
        }
      }
    }
  }

  ret(c) {
    c.sp = c.fp;
    if (c.sp === STACK_ENTRIES) return this.endContext();
    c.fp = ((c.v[c.sp] << 16) >> 16) / 4;     // saved fp (byte offset from the stack base)
    c.sp++;
    c.pc = c.v[c.sp];                          // return address
    c.sp++;
  }

  endContext() {
    const c = this.ctx.pop();
    if (this.trace) this.trace({ e: 'end', nest: this.ctx.length });
    if (!this.ctx.length) { this.status = 'done'; return; }
    if (c.onEnd) c.onEnd();
  }

  op(c, o) {
    if (o > 20) return;                        // undefined operator: ignored (1 byte)
    const top = c.sp;
    switch (o) {
      case 0: this.setTop(c, this.value(c, top)); return;                                   // load
      case 1: { const x = this.value(c, top); c.sp++; this.store(c, c.sp, x); this.setTop(c, x); return; } // assign
      case 2: case 3: { const x = (this.value(c, top) + (o === 2 ? 1 : -1)) & 0xffff; this.store(c, top, x); this.setTop(c, x); return; }
      case 4: this.setTop(c, ~this.value(c, top)); return;                                  // not (bitwise)
    }
    c.sp++;
    const a = this.value(c, c.sp), bb = this.value(c, top);
    let r;
    switch (o) {
      case 5: r = a & bb; break;
      case 6: r = a | bb; break;
      case 7: r = a ^ bb; break;
      case 8: r = a + bb; break;
      case 9: r = a - bb; break;
      case 10: r = Math.imul(a, bb); break;
      case 11: if (!bb) throw new VMError('division by zero (68000 zero-divide trap)'); r = Math.floor(a / bb); break;
      case 12: if (!bb) throw new VMError('division by zero (68000 zero-divide trap)'); r = a % bb; break;
      case 13: r = a === bb ? -1 : 0; break;
      case 14: r = a !== bb ? -1 : 0; break;
      case 15: r = a < bb ? -1 : 0; break;
      case 16: r = a <= bb ? -1 : 0; break;
      case 17: r = a > bb ? -1 : 0; break;
      case 18: r = a >= bb ? -1 : 0; break;
      case 19: { const n = bb & 63; r = n >= 16 ? 0 : a << n; break; }
      case 20: { const n = bb & 63; r = n >= 16 ? 0 : a >>> n; break; }
    }
    this.setTop(c, r);
  }

  // ---- builtins ---------------------------------------------------------------------------
  sys(c, n) {
    const d = BUILTINS[n];
    if (!d) throw new VMError(`builtin ${n} outside the table`);
    const args = this.args(c);
    if (this.trace) this.trace({ e: 's', n, args });
    const s = this.state, rt = s.rt;
    let ret = 0;
    switch (d.kind) {
      case 'nop': break;
      case 'vm':
        switch (n) {
          case 2: case 3: {                    // callMain(n) / callMap(n): nested run, result register = 0 after
            const prog = n === 2 ? this.programs.main : this.programs.map;
            if (!prog) throw new VMError(`builtin ${n}: no ${n === 2 ? 'main' : 'map'} program`);
            this.r0 = args[0];
            if (this.trace) this.trace({ e: 'run', entry: n === 2 ? ENTRY_MAIN : ENTRY_MAP, prog: prog.name, nest: this.ctx.length });
            this.ctx.push(new Context(prog, n === 2 ? ENTRY_MAIN : ENTRY_MAP, () => this.finishSys(n, 0), copyMem(c)));
            return;
          }
          case 4: return this.abort();
          case 8: ret = rt.lastTrigger + 1; break;
          case 12:
            if (args[0] === 0) setLe16(s, OFF.chars + 8, le16(s, OFF.chars + 8) + 100);
            else if (args[0] === 1) s.block[OFF.chars + 0x13] += 50;
            else if (args[0] === 2) s.block[OFF.chars + 0x10] += 50;
            break;
          case 21: { const k = (be16(s, OFF.partyCount) << 16) >> 16; ret = 0; for (let i = 0; i < k; i++) if (be16(s, OFF.party + 2 * i) === args[0]) { ret = 1; break; } break; }
          case 22: {
            const off = OFF.returnPoint;
            for (let i = 0; i < 3; i++) s.block[off + i] = c.code[args[0] + i] ?? 0;
            s.block[off + 3] = 0;
            setBe16(s, off + 4, args[1]); setBe16(s, off + 8, args[2]); setBe16(s, off + 10, args[3]); setBe16(s, off + 6, args[4]);
            setBe16(s, off + 12, 0);
            setBe16(s, off + 14, be16(s, rt.hdd ? 0 : 2));
            break;
          }
          case 23: setBe16(s, OFF.curChar, args[0] - 1); break;
          case 26: {
            rt.moneyShown = args[0];
            const m = S.money(s);
            if (args[1] === 0) { if (args[0] > (m | 0)) ret = 0; else { S.setMoney(s, m - args[0]); ret = 1; } } else { S.setMoney(s, m + args[0]); ret = 1; }
            break;
          }
          case 39: rt.enemyAction = args[0]; break;
          case 40: ret = itemCount(s, args[0]); break;
          case 41: {
            const cnt = (args[1] << 16) >> 16;
            ret = (cnt >= 0 ? giveItem(s, args[0], cnt) : takeItem(s, args[0], -cnt)) ^ 1;
            break;
          }
        }
        break;
      case 'mixed':
        if (n === 10) {                        // warp(mapId, trigger, x, y, facing)
          const id = String.fromCharCode(...[0, 1, 2].map((i) => c.code[args[0] + i] ?? 0)).replace(/\0.*/, '');
          rt.nextMap = id; rt.warpPending = 1; rt.pendingTrigger = ((args[1] - 1) << 16) >> 16; rt.picture = 0; rt.facing = args[4];
          rt.warpArgs = { x: args[2], y: args[3] };
          if (c.prog.kind === 'main') {        // from IC_MAIN: close the window, fade, load the map now
            const r = this.host.warp ? this.host.warp({ map: id, trigger: rt.pendingTrigger, facing: args[4] }, this) : undefined;
            rt.lastTrigger = rt.pendingTrigger; rt.pendingTrigger = -1;
            if (r && r.block !== undefined) return this.blockOn(n, r.block);
          }
          break;
        }
        if (n === 19 || n === 33) {
          if (n === 19) s.block[OFF.chars + CHAR_SIZE * args[0] + args[1]] = args[2] & 255;   // then f_72e24: host recomputes derived stats
          else this.party(args);
          const r = this.host.builtin ? this.host.builtin(n, args, this) : 0;
          if (r && r.block !== undefined) return this.blockOn(n, r.block);
          break;
        }
        break;
      case 'host': {
        const r = this.host.builtin ? this.host.builtin(n, args, this) : 0;
        if (r && r.block !== undefined) return this.blockOn(n, r.block);
        ret = r ?? 0;
        break;
      }
    }
    if (n === 19 || n === 33 || n === 10) ret = 0;
    this.finishSys(n, ret);
  }

  blockOn(n, block) { this.status = 'blocked'; this.pending = { n, block }; }

  finishSys(n, value) {
    if (this.trace) this.trace({ e: 'r', n, value: value & 0xffff });
    this.r0 = value & 0xffff;
  }

  // builtin 33 party(slot, op, char, b, actor), game-state part. The actor swap
  // (f_7b698(slot-1, actor-1): actor/sprite records, map-buffer actor table) and the actor flag
  // bit 3 changes are the host's.
  party(a) {
    const s = this.state, [slot, op, ch, b, act] = a;
    if (slot === 1) {
      if (op === 0) s.rt.battleFlag = 1;
      else { s.rt.battleFlag = 0; setBe16(s, OFF.partyB, b); setBe16(s, OFF.partyC, 0); }
    } else if (slot >= 2 && slot <= 3) {
      if (op === 0) setBe16(s, OFF.partyCount, slot - 1);
      else if (op <= 2) {
        if (slot > ((be16(s, OFF.partyCount) << 16) >> 16)) setBe16(s, OFF.partyCount, slot);
        setBe16(s, OFF.partyCount + 2 * slot, ch);
        setBe16(s, OFF.partyB - 2 + 2 * slot, b);
        setBe16(s, OFF.partyC - 2 + 2 * slot, op - 1);
      }
    }
    s.rt.actorsDirty = 1;
    void act;
  }

  // builtin 4: longjmp to the setjmp of f_7c804 = abandon every run up to the dispatcher
  abort() {
    const r = this.root;
    for (const v of new Set([this, r])) { v.ctx = []; v.status = 'aborted'; v.pending = null; }
    if (this.trace) this.trace({ e: 'abort' });
    if (this.host.onAbort) this.host.onAbort(this);
  }
}

// Disassembly helper for one instruction (shared format with tools/export/data/vm.mjs).
export { decodeAt, formatIns } from '../export/data/vm.mjs';
