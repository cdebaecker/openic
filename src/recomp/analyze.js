// Recursive-descent analysis of an unpacked program image: finds functions,
// basic blocks, call edges and switch jump tables.

import { decode } from './decode.js';

export class Image {
  constructor(bytes, base) {
    this.bytes = bytes; this.base = base; this.end = base + bytes.length;
  }
  has(a) { return a >= this.base && a + 1 < this.end; }
  r8(a) { return this.has(a) ? this.bytes[a - this.base] : 0; }
  r16(a) { const o = a - this.base; return o >= 0 && o + 1 < this.bytes.length ? (this.bytes[o] << 8) | this.bytes[o + 1] : 0; }
  r32(a) { return ((this.r16(a) << 16) | this.r16(a + 2)) >>> 0; }
}

const TERMINAL = new Set(['rts', 'rte', 'rtr', 'jmp', 'bra', 'illegal', 'stop']);

export function analyze(img, opts = {}) {
  const codeEnd = opts.codeEnd ?? img.end;
  const inCode = (a) => a >= img.base && a < codeEnd && !(a & 1);
  const insns = new Map();          // addr -> decoded instruction
  const funcs = new Map();          // entry -> { entry, blocks:Set, insns:[], calls:Set, end, tables:[], indirect:[] }
  const tableBytes = new Set();     // addresses covered by jump tables (data inside code)
  const queue = [];
  const addFunc = (a, why) => {
    if (!inCode(a) || funcs.has(a)) return;
    funcs.set(a, { entry: a, why, blocks: new Set(), insnAddrs: new Set(), calls: new Set(), tables: [], indirect: [], tail: new Set() });
    queue.push(a);
  };

  for (const e of opts.entries ?? [img.base]) addFunc(e, 'entry');
  // Code pointers stored in data: long words pointing at a C function prologue.
  if (opts.scanPointers !== false) {
    for (let a = codeEnd; a + 3 < img.end; a += 2) {
      const v = img.r32(a);
      if (inCode(v) && img.r16(v) === 0x4e56) addFunc(v, 'ptr');
    }
  }

  const getIns = (a) => {
    let i = insns.get(a);
    if (!i) { i = decode(img, a); insns.set(a, i); }
    return i;
  };

  // Previous instructions by address (crossing block boundaries).
  function before(a, n) {
    const out = [];
    let cur = a;
    for (let k = 0; k < n; k++) {
      let found = null;
      for (let d = 2; d <= 10; d += 2) { const p = insns.get(cur - d); if (p && p.addr + p.len === cur) { found = p; break; } }
      if (!found) break;
      out.unshift(found); cur = found.addr;
    }
    return out;
  }

  function resolveTable(f, ins) {
    // jmp T(pc,dY.w) preceded by move.w T(pc,dX.?),dY and an earlier bound check
    const T = ins.src.abs;
    const prevs = before(ins.addr, 8);
    let count = -1;
    for (let k = prevs.length - 1; k >= Math.max(0, prevs.length - 8); k--) {
      const p = prevs[k];
      if ((p.op === 'cmp' || p.op === 'cmpi' || p.op === 'cmpa') && p.src.m === 'imm') { count = p.src.imm + 1; break; }
      if (p.op === 'cmp' && p.src.m === 'd') {
        // bound loaded by moveq into the register
        for (let j = k - 1; j >= Math.max(0, k - 4); j--) {
          const q = prevs[j];
          if (q.op === 'moveq' && q.dst.r === p.src.r) { count = (q.src.imm | 0) + 1; break; }
        }
        if (count > 0) break;
      }
    }
    const targets = [];
    if (count <= 0 || count > 512) count = 0;
    for (let n = 0; n < count; n++) {
      const t = (T + ((img.r16(T + n * 2) << 16) >> 16)) >>> 0;
      tableBytes.add(T + n * 2);
      targets.push(t);
    }
    f.tables.push({ at: ins.addr, base: T, targets });
    return targets;
  }

  function runQueue() {
  while (queue.length) {
    const entry = queue.shift();
    const f = funcs.get(entry);
    const work = [entry];
    while (work.length) {
      const start = work.pop();
      if (f.blocks.has(start)) continue;
      f.blocks.add(start);
      let a = start;
      for (let guard = 0; guard < 4096; guard++) {
        if (!inCode(a) || tableBytes.has(a)) break;
        if (a !== start && f.blocks.has(a)) break;
        const ins = getIns(a);
        f.insnAddrs.add(a);
        const next = a + ins.len;
        switch (ins.op) {
          case 'bcc': work.push(ins.target); work.push(next); break;
          case 'dbcc': work.push(ins.target); work.push(next); break;
          case 'bra': work.push(ins.target); break;
          case 'bsr': addFunc(ins.target, 'bsr'); f.calls.add(ins.target); break;
          case 'jsr':
            if (ins.src.m === 'absl' || ins.src.m === 'absw' || ins.src.m === 'pcd') { addFunc(ins.src.abs, 'jsr'); f.calls.add(ins.src.abs); }
            else f.indirect.push(a);
            break;
          case 'jmp':
            if (ins.src.m === 'absl' || ins.src.m === 'absw' || ins.src.m === 'pcd') {
              // tail call or long branch: treat targets outside a link frame as functions
              if (img.r16(ins.src.abs) === 0x4e56) { addFunc(ins.src.abs, 'tail'); f.tail.add(ins.src.abs); }
              else work.push(ins.src.abs);
            } else if (ins.src.m === 'pci') {
              for (const t of resolveTable(f, ins)) work.push(t);
            } else f.indirect.push(a);
            break;
        }
        if (TERMINAL.has(ins.op) || ins.op === 'bcc' || ins.op === 'dbcc') break;
        a = next;
      }
    }
  }
  }
  runQueue();

  // Resolve jsr/jmp (aN) where aN was loaded with a constant address earlier in
  // the same function (the compiler hoists repeated call targets into registers).
  const tried = new Set();
  const tryAdd = (t) => { if (tried.has(t)) return false; tried.add(t); const had = funcs.has(t); addFunc(t, 'reg'); return !had && funcs.has(t); };
  let changed = true;
  while (changed) {
    changed = false;
    for (const f of [...funcs.values()]) {
      if (!f.indirect.length) continue;
      const known = new Map();
      const resolved = [];
      for (const a of [...f.insnAddrs].sort((x, y) => x - y)) {
        const i = insns.get(a);
        if (f.blocks.has(a) && a !== f.entry) { /* keep constants across blocks: compiler loads them once */ }
        const writesA = (e) => e && e.m === 'a' ? e.r : -1;
        // Constant address loads only: lea addr,aN or movea #imm,aN. (movea.l addr,aN
        // reads a pointer from memory and is not a constant.)
        if ((i.op === 'lea' && (i.src.m === 'absl' || i.src.m === 'absw' || i.src.m === 'pcd')) || (i.op === 'movea' && i.src.m === 'imm')) {
          known.set(i.dst.r, i.src.m === 'imm' ? i.src.imm : i.src.abs);
          continue;
        }
        const w = writesA(i.dst);
        if (w >= 0) known.delete(w);
        if (i.op === 'movem' && !i.toMem) for (let r = 0; r < 8; r++) if (i.mask & (1 << (8 + r))) known.delete(r);
        if ((i.op === 'jsr' || i.op === 'jmp') && i.src.m === 'ind' && known.has(i.src.r)) {
          const t = known.get(i.src.r);
          i.resolved = t;
          resolved.push(a);
          if (i.op === 'jsr') f.calls.add(t); else f.tail.add(t);
          if (tryAdd(t)) changed = true;
        }
      }
      f.indirect = f.indirect.filter((x) => !resolved.includes(x));
    }
    if (changed) runQueue();
  }

  // Ownership: an instruction may be reachable from several functions (shared tails).
  const owner = new Map();
  for (const f of funcs.values()) for (const a of f.insnAddrs) if (!owner.has(a) || a >= f.entry && owner.get(a) < f.entry) owner.set(a, f.entry);
  for (const f of funcs.values()) {
    const addrs = [...f.insnAddrs].sort((x, y) => x - y);
    f.start = addrs[0]; f.end = addrs.length ? addrs[addrs.length - 1] + insns.get(addrs[addrs.length - 1]).len : f.entry;
    f.size = addrs.length;
  }
  return { img, insns, funcs, tableBytes, owner, codeEnd };
}
