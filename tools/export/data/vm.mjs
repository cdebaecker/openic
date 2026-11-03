// The script VM of ICITY68 (interpreter f_7a55e, handlers table at $9C240).
// Used by IC_MAIN.SCN / CONSULT.SCN (base = file start, buffer $A0650) and by the second
// part of every map EVT file (base = EVT part 2, buffer $A0654 + part-1 size).
// Code is compiled C-like bytecode; addresses are 16-bit offsets from the base.
//
// Byte classes (top two bits):
//   00xxxxxx  RET      return from a call (any value; the frame is restored, empty stack = end)
//   01tttttw  PUSH     push {type t, value}; w=1: u16le operand, w=0: s8 operand.
//                      types: 0/1 immediate, 2 u8 var, 4 s8 var, 3/5 u16 var at $9C798+value,
//                      6/7 frame slot (args/locals, value = slot index; negative = args)
//   10oooooo  OP       0 load (lvalue -> rvalue) 1 assign (a = b) 2 ++ 3 -- 4 ~ 5 & 6 | 7 ^
//                      8 + 9 - 10 * 11 / 12 % 13 == 14 != 15 < 16 <= 17 > 18 >= 19 << 20 >>
//                      (comparisons are unsigned, true = -1)
//   11oooooo  CTRL     0 SETR   pop -> result register ($9C798, word var 0)
//                      1 DROP s8   adjust stack by n entries (positive = pop)
//                      2 CALL u16  call script function
//                      3 NOP
//                      4 JMP u16   absolute jump
//                      5 JR s16    relative jump (from the next instruction)
//                      6 JZ s16    relative jump if the result register is 0
//                      7 MSG u16   show the message at base+u16 (f_7b452)
//                      8 SYS u8    call builtin (table $9C240, 48 entries); args are the stack
//                                  entries' raw values, first argument = last pushed; return
//                                  value -> result register
export const BINOPS = ['load', 'assign', 'inc', 'dec', 'not', 'and', 'or', 'xor', 'add', 'sub', 'mul', 'div', 'mod',
  'eq', 'ne', 'lt', 'le', 'gt', 'ge', 'shl', 'shr'];
export const PUSH_TYPES = ['imm', 'imm', 'u8var', 'u16var', 's8var', 'u16var', 'local', 'local'];

// Builtins (handler addresses in ICITY68). Names are tentative where marked '?'.
// args are in call order (first argument = top of stack at the call).
export const SYS = {
  0: { name: 'cutscene', args: ['script'], h: '7aff2', note: 'run letter-script (EVT part 1) #script-1 (f_78622)' },
  1: { name: 'refresh?', args: [], h: '7bd9e', note: 'redraw / screen refresh' },
  2: { name: 'callMain', args: ['n'], h: '7b032', note: 'call IC_MAIN.SCN entry $14 with result reg = n (common routines)' },
  3: { name: 'callMap', args: ['n'], h: '7b10e', note: 'call this map\'s part-2 code (f_7c8c2) with result reg = n' },
  4: { name: 'sys4?', args: [], h: '7c06c', note: 'f_89eca($A2558, 1)' },
  5: { name: 'sys5?', args: ['?'], h: '7c084', note: 'calls f_6abca / f_7c626 (window/graphics?)' },
  6: { name: 'message', args: ['speaker?', 'text'], h: '7b33e', note: 'show message at base+text through the message engine (f_7ca4a/f_72286)' },
  7: { name: 'nop', args: [], h: '7c7fa' },
  8: { name: 'triggerIndex', args: [], h: '7b5b8', note: 'returns current trigger index + 1 ($9EEEA)' },
  9: { name: 'sys9?', args: ['?'], h: '7c1d6', note: 'actor / letter-script related (uses $9F722 leader pos, f_78784)' },
  10: { name: 'warp', args: ['mapId', 'trigger', '?', '?', 'dir'], h: '7b5cc', note: 'change map: mapId = base offset of a 3-letter id string; loads via f_67d0e' },
  11: { name: 'sys11?', args: ['?'], h: '7c528', note: 'party walking positions $9C8C0.. (f_79726)' },
  12: { name: 'sys12?', args: ['?'], h: '7c4c4', note: 'writes $9C9BA.. (character records)' },
  13: { name: 'diskCheck?', args: ['?'], h: '7c10c', note: 'disk swap prompt (f_678ec)' },
  14: { name: 'nop', args: [], h: '7c7fa' },
  15: { name: 'music', args: ['?'], h: '7ba5e', note: 'music change (f_69b44)' },
  16: { name: 'sys16?', args: ['n'], h: '7bac4', note: 'f_66a5c(n)' },
  17: { name: 'nop', args: [], h: '7c7fa' }, 18: { name: 'nop', args: [], h: '7c7fa' },
  19: { name: 'setCharByte', args: ['char', 'offset', 'value'], h: '7c5f0', note: 'character record (40 bytes at $9C9B2+40*char)[offset] = value' },
  20: { name: 'battle', args: ['encounter'], h: '7bae0', note: 'scripted battle (f_798e8; loads event picture table 11 #(enc-1)/3+1)' },
  21: { name: 'inParty', args: ['char'], h: '7c3a8', note: 'returns 1 if char is in the party ($9C99E count, $9C9A0 list)' },
  22: { name: 'sys22?', args: ['?'], h: '7c3e8', note: 'copies into $9CB3C.. (disk/save state?)' },
  23: { name: 'setCurrentChar?', args: ['n'], h: '7c4aa', note: '$9C99C = n-1' },
  24: { name: 'menu?', args: ['?'], h: '7bc48', note: 'choice window (f_7cb54/f_81f8e)' },
  25: { name: 'menu2?', args: ['?'], h: '7bb00', note: 'choice window variant' },
  26: { name: 'money', args: ['amount', 'add'], h: '7c194', note: 'add=0: pay if possible (returns 1/0); add!=0: gain. Money is u32 at $9C998' },
  27: { name: 'nop', args: [], h: '7c7fa' }, 28: { name: 'nop', args: [], h: '7c7fa' },
  29: { name: 'sys29?', args: ['?'], h: '7c680', note: 'character data $9FBDA/$9F2A2' },
  30: { name: 'random', args: [], h: '7c710', note: 'returns a random number (f_88de0)' },
  31: { name: 'sys31?', args: ['?'], h: '7c2ee', note: 'party / item (f_81a1c, f_81b68)' },
  32: { name: 'nop', args: [], h: '7c7fa' },
  33: { name: 'sys33?', args: ['?'], h: '7b904', note: 'party member join/leave? ($9C99E, $9C9A4..)' },
  34: { name: 'actorFlag?', args: ['actor', 'value'], h: '7be20', note: 'actor table $9FBDA / $9F722 (show/hide or set state)' },
  35: { name: 'fade?', args: ['mode'], h: '7bf14', note: 'screen/palette transition, redraw' },
  36: { name: 'nop', args: [], h: '7c7fa' },
  37: { name: 'sys37?', args: ['?'], h: '7c724', note: 'uses map buffer and $9F2A2 (distance/direction?)' },
  38: { name: 'message2?', args: ['text'], h: '7c7ae', note: 'f_7b452 (same as MSG opcode)' },
  39: { name: 'setA1B14', args: ['v'], h: '7c7e4' },
  40: { name: 'sys40?', args: ['n'], h: '7c000', note: 'f_7116c(0, n); returns $A1B42' },
  41: { name: 'sys41?', args: ['a', 'b'], h: '7c026', note: 'f_7122c / f_712d8 (item give/take?)' },
};
for (let i = 42; i < 48; i++) SYS[i] = { name: 'nop', args: [], h: '7c7fa' };

const s8 = (v) => (v < 128 ? v : v - 256), s16 = (v) => (v < 32768 ? v : v - 65536);

// Decode one instruction at pc (offset into code). Returns { at, len, op, ... }.
export function decodeAt(code, pc) {
  const b = code[pc];
  const u16 = (a) => code[a] | (code[a + 1] << 8);
  switch (b >> 6) {
    case 0: return { at: pc, len: 1, op: 'ret' };
    case 1: {
      const t = (b & 0x3f) >> 1;
      if (b & 1) return { at: pc, len: 3, op: 'push', type: PUSH_TYPES[t] ?? `t${t}`, t, value: u16(pc + 1) };
      return { at: pc, len: 2, op: 'push', type: PUSH_TYPES[t] ?? `t${t}`, t, value: s8(code[pc + 1]) };
    }
    case 2: return { at: pc, len: 1, op: BINOPS[b & 0x3f] ?? `op${b & 0x3f}` };
    default: {
      const o = b & 0x3f;
      switch (o) {
        case 0: return { at: pc, len: 1, op: 'setr' };
        case 1: return { at: pc, len: 2, op: 'drop', n: s8(code[pc + 1]) };
        case 2: return { at: pc, len: 3, op: 'call', target: u16(pc + 1) };
        case 3: return { at: pc, len: 1, op: 'nop' };
        case 4: return { at: pc, len: 3, op: 'jmp', target: u16(pc + 1) };
        case 5: return { at: pc, len: 3, op: 'jr', target: (pc + 3 + s16(u16(pc + 1))) & 0xffff };
        case 6: return { at: pc, len: 3, op: 'jz', target: (pc + 3 + s16(u16(pc + 1))) & 0xffff };
        case 7: return { at: pc, len: 3, op: 'msg', text: u16(pc + 1) };
        case 8: return { at: pc, len: 2, op: 'sys', n: code[pc + 1], name: SYS[code[pc + 1]]?.name ?? `sys${code[pc + 1]}` };
        default: return { at: pc, len: 1, op: `bad_c${o}` };
      }
    }
  }
}

// Recursive-descent disassembly from the given entry offsets. Returns instructions sorted by
// offset, the string offsets referenced (MSG operands, warp map ids), the message tables
// used by builtin 6 and their (key, offset) entries,
// and the list of call targets (functions).
export function disassemble(code, roots) {
  const seen = new Map(), funcs = new Set(), strings = new Map(), tables = new Set(), work = [...roots];
  const visitedRoots = new Set();
  while (work.length) {
    let pc = work.pop();
    if (pc <= 0 || pc >= code.length || visitedRoots.has(pc)) continue;
    visitedRoots.add(pc);
    const pushes = [];
    while (pc < code.length && !seen.has(pc)) {
      const ins = decodeAt(code, pc);
      if (ins.op.startsWith('bad')) break;
      seen.set(pc, ins);
      pc += ins.len;
      if (ins.op === 'push') { pushes.push(ins); continue; }
      // abstract stack: unary ops replace the top, binary ops pop one and replace the top
      if (['load', 'inc', 'dec', 'not'].includes(ins.op)) { if (pushes.length) pushes[pushes.length - 1] = { t: 99, type: 'expr', value: '?' }; continue; }
      if (BINOPS.includes(ins.op)) { pushes.pop(); if (pushes.length) pushes[pushes.length - 1] = { t: 99, type: 'expr', value: '?' }; continue; }
      if (ins.op === 'call') { funcs.add(ins.target); work.push(ins.target); }
      if (ins.op === 'jz') work.push(ins.target);
      if (ins.op === 'msg') strings.set(ins.text, (strings.get(ins.text) ?? 0) + 1);
      if (ins.op === 'sys') {
        // first argument = last push; take string args by position
        const args = pushes.slice(-(SYS[ins.n]?.args.length ?? 0)).reverse();
        ins.args = args.map((p) => (p.t <= 1 ? p.value : `${p.type}[${p.value}]`));
        // sys 6: (key, table) -> message table of (u16 key, u16 offset) pairs ending with key 0
        if (ins.n === 6 && args[1] && args[1].t <= 1) tables.add(args[1].value);
        if (ins.n === 10 && args[0] && args[0].t <= 1) strings.set(args[0].value, (strings.get(args[0].value) ?? 0) + 1);
        if (ins.n === 38 && args[0] && args[0].t <= 1) strings.set(args[0].value, (strings.get(args[0].value) ?? 0) + 1);
      }
      if (ins.op === 'drop' && ins.n > 0) pushes.length = Math.max(0, pushes.length - ins.n);
      else if (ins.op !== 'sys') pushes.length = 0;
      if (ins.op === 'jmp' || ins.op === 'jr') { work.push(ins.target); break; }
      if (ins.op === 'ret') break;
    }
  }
  // message tables: (key, offset) pairs
  const messages = [];
  for (const t of tables) for (let a = t; a + 3 < code.length; a += 4) {
    const key = code[a] | (code[a + 1] << 8); if (!key) break;
    const off = code[a + 2] | (code[a + 3] << 8); messages.push({ table: t, key, offset: off });
  }
  return { code: [...seen.values()].sort((a, b) => a.at - b.at), funcs: [...funcs].sort((a, b) => a - b), strings, tables: [...tables], messages };
}

// Linear sweep over [start, end): compiled functions are laid out back to back before the
// message text, so this also finds functions only reached through computed dispatch.
export function sweep(code, start, end) {
  const out = []; let pc = start, bad = 0;
  while (pc < end) { const i = decodeAt(code, pc); if (i.op.startsWith('bad')) bad++; out.push(i); pc += i.len; }
  return { code: out, bad };
}

export function formatIns(i) {
  switch (i.op) {
    case 'push': return `push ${i.type} ${i.value}`;
    case 'drop': return `drop ${i.n}`;
    case 'call': case 'jmp': case 'jr': case 'jz': return `${i.op} ${hex4(i.target)}`;
    case 'msg': return `msg ${hex4(i.text)}`;
    case 'sys': return `sys ${i.n} ${i.name}(${(i.args ?? []).join(', ')})`;
    default: return i.op;
  }
}
const hex4 = (v) => '$' + v.toString(16).padStart(4, '0');
