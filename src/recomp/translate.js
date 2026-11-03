// 68000 -> JavaScript translator (phase 1: exact, mechanical).
//
// Each function becomes `function(c, M, R)` where c is the CPU state shared
// with the interpreter (d/a registers, flags x n z v c), M the bus and R the
// runtime (calls, traps, flag helpers). Control flow is a dispatch loop over
// basic-block labels; condition flags are only materialized when a later
// instruction can observe them.

import { fmt } from './decode.js';

const MASK = { 1: '0xff', 2: '0xffff', 4: '0xffffffff' };
const hex = (v) => '0x' + (v >>> 0).toString(16);

// Which flags an instruction writes / reads (X N Z V C bit set: x=16 n=8 z=4 v=2 c=1)
const ALL = 31, NZVC = 15;
function flagsOf(i) {
  switch (i.op) {
    case 'move': case 'moveq': case 'tst': case 'clr': case 'and': case 'andi': case 'or': case 'ori':
    case 'eor': case 'eori': case 'not': case 'swap': case 'extw': case 'extl': case 'mulu': case 'muls':
    case 'divu': case 'divs': case 'tas': return { w: NZVC, r: 0 };
    case 'cmp': case 'cmpi': case 'cmpa': case 'cmpm': return { w: NZVC, r: 0 };
    case 'add': case 'addi': case 'sub': case 'subi': case 'neg': return { w: ALL, r: 0 };
    case 'addq': case 'subq': return i.dst.m === 'a' ? { w: 0, r: 0 } : { w: ALL, r: 0 };
    case 'addx': case 'subx': case 'negx': case 'abcd': case 'sbcd': case 'nbcd': return { w: ALL, r: 20 };
    case 'asl': case 'asr': case 'lsl': case 'lsr': return { w: ALL, r: 0 };
    case 'rol': case 'ror': return { w: NZVC, r: 0 };
    case 'roxl': case 'roxr': return { w: ALL, r: 16 };
    case 'btst': case 'bchg': case 'bclr': case 'bset': return { w: 4, r: 0 };
    case 'chk': return { w: NZVC, r: 0 };
    case 'bcc': case 'scc': case 'dbcc': return { w: 0, r: NZVC };
    case 'move_to_ccr': case 'move_to_sr': case 'andi_ccr': case 'ori_ccr': case 'eori_ccr':
    case 'andi_sr': case 'ori_sr': case 'eori_sr': return { w: ALL, r: ALL };
    case 'move_from_sr': return { w: 0, r: ALL };
    // calls/traps: callee may read or produce flags
    case 'jsr': case 'bsr': case 'trap': case 'linef': case 'rts': case 'rte': case 'rtr': case 'jmp': case 'trapv':
      return { w: 0, r: ALL };
  }
  return { w: 0, r: 0 };
}

const CONDS = [
  'true', 'false', '(!c.c && !c.z)', '(c.c || c.z)', '!c.c', 'c.c', '!c.z', 'c.z', '!c.v', 'c.v', '!c.n', 'c.n',
  '(c.n === c.v)', '(c.n !== c.v)', '(!c.z && c.n === c.v)', '(c.z || c.n !== c.v)',
];

export class Translator {
  constructor(analysis, opts = {}) {
    this.an = analysis;
    this.insns = analysis.insns;
    this.reloc = opts.reloc ?? null;   // Set of image addresses holding relocated longs
    this.comments = opts.comments ?? true;
    // Addresses where the runtime may inspect/patch state before the instruction
    // runs (e.g. the message engine's text pointer): emitted as R.at(addr).
    this.hooks = new Set(opts.hooks ?? []);
  }

  // Live-flag analysis inside one function: flagsNeeded(addr) = flags written
  // by this instruction that may be read before being overwritten.
  liveness(f, order) {
    const succ = new Map();
    for (const a of order) {
      const i = this.insns.get(a);
      const next = a + i.len;
      const s = [];
      switch (i.op) {
        case 'bcc': case 'dbcc': s.push(i.target, next); break;
        case 'bra': s.push(i.target); break;
        case 'jmp': if (i.src.m === 'pci') { const t = f.tables.find((x) => x.at === a); if (t) s.push(...t.targets); } break;
        case 'rts': case 'rte': case 'rtr': case 'illegal': break;
        default: s.push(next);
      }
      succ.set(a, s.filter((x) => f.insnAddrs.has(x)));
    }
    const liveIn = new Map(order.map((a) => [a, 0]));
    let changed = true;
    while (changed) {
      changed = false;
      for (let k = order.length - 1; k >= 0; k--) {
        const a = order[k];
        const i = this.insns.get(a);
        let out = 0;
        for (const s of succ.get(a)) out |= liveIn.get(s);
        const fl = flagsOf(i);
        const inn = (out & ~fl.w) | fl.r;
        if (inn !== liveIn.get(a)) { liveIn.set(a, inn); changed = true; }
      }
    }
    this.liveIn = liveIn;
    const need = new Map();
    for (const a of order) {
      const i = this.insns.get(a);
      let out = 0;
      for (const s of succ.get(a)) out |= liveIn.get(s);
      need.set(a, out & flagsOf(i).w);
    }
    return need;
  }

  // Address constant: absolute addresses inside the image are emitted as-is
  // (the image is generated for a fixed load base).
  addr(v) { return hex(v); }

  translate(f) {
    const order = [...f.insnAddrs].sort((x, y) => x - y);
    const need = this.liveness(f, order);
    const labels = new Set([f.entry]);
    for (const a of order) {
      const i = this.insns.get(a);
      if (i.target !== undefined) labels.add(i.target);
      if (i.op === 'jmp' && i.src.m === 'pci') { const t = f.tables.find((x) => x.at === a); if (t) t.targets.forEach((x) => labels.add(x)); }
    }
    // Blocks not reachable by fallthrough also need labels.
    for (const b of f.blocks) labels.add(b);
    this.tmp = 0;
    const body = [];
    let prev = null;
    for (const a of order) {
      const i = this.insns.get(a);
      if (labels.has(a) || (prev && prev.addr + prev.len !== a)) body.push(`    case ${hex(a)}:`);
      if (this.comments) body.push(`      // ${a.toString(16)}: ${fmt(i)}`);
      if (this.hooks.has(a)) body.push(`      R.at(${hex(a)});`);
      body.push(...this.ins(i, need.get(a), f).map((s) => '      ' + s));
      prev = i;
    }
    const temps = this.tmp ? `  let ${Array.from({ length: this.tmp }, (_, k) => `t${k}`).join(', ')};\n` : '';
    return `function f_${f.entry.toString(16)}(c, M, R) {\n${temps}  let pc = ${hex(f.entry)};\n  for (;;) {\n    switch (pc) {\n${body.join('\n')}\n      return R.fellOff(${hex(f.entry)});\n    default: return R.badLabel(${hex(f.entry)}, pc);\n    }\n  }\n}`;
  }

  // Test mode: every basic block as a standalone function `(c, M, R) => nextPc`.
  // Calls, traps and DOS calls end a block (the stubs only perform the jump).
  // Returns [{ start, count, src, liveIn }] where liveIn maps instruction
  // addresses to the flags code there may read (to compare only observable flags).
  blocks(f) {
    const order = [...f.insnAddrs].sort((x, y) => x - y);
    const need = this.liveness(f, order);
    const liveIn = this.liveIn;
    const labels = new Set([f.entry, ...f.blocks]);
    for (const a of order) {
      const i = this.insns.get(a);
      if (i.target !== undefined) labels.add(i.target);
      if (i.op === 'jmp' && i.src.m === 'pci') { const t = f.tables.find((x) => x.at === a); if (t) t.targets.forEach((x) => labels.add(x)); }
    }
    const ENDS = new Set(['bra', 'bcc', 'dbcc', 'jmp', 'rts', 'rte', 'rtr', 'jsr', 'bsr', 'trap', 'linef', 'illegal', 'linea', 'stop']);
    const out = [];
    for (const start of [...labels].filter((x) => f.insnAddrs.has(x)).sort((x, y) => x - y)) {
      this.tmp = 0;
      const body = [];
      let a = start, count = 0;
      for (;;) {
        const i = this.insns.get(a);
        count++;
        if (this.hooks.has(a)) body.push(`R.at(${hex(a)});`);
        let st = this.ins(i, need.get(a), f)
          .map((x) => x.replace(/if \(c\.cycles > R\.deadline\) return R\.bail\([^)]*\); /g, '')
            .replace(/pc = ([^;]+); continue;/g, 'return $1;'));
        body.push(...st);
        if (['jsr', 'bsr', 'trap', 'linef'].includes(i.op)) { body.push('return c.pc;'); break; }
        if (ENDS.has(i.op)) { if (i.op === 'bcc' || i.op === 'dbcc') body.push(`return ${hex(a + i.len)};`); break; }
        const next = a + i.len;
        if (!f.insnAddrs.has(next) || labels.has(next)) { body.push(`return ${hex(next)};`); break; }
        a = next;
      }
      const temps = this.tmp ? `let ${Array.from({ length: this.tmp }, (_, k) => `t${k}`).join(', ')};\n` : '';
      out.push({ start, count, liveIn, src: `(function (c, M, R) {\n${temps}${body.join('\n')}\n})` });
    }
    return out;
  }

  t() { return `t${this.tmp++}`; }

  // Loops check the time slice so code that waits on interrupts (vsync
  // counters, key polling) hands control back to the interpreter.
  backEdge(i) {
    return i.target <= i.addr ? `if (c.cycles > R.deadline) return R.bail(${hex(i.target)}); ` : '';
  }

  // ---- operand helpers ---------------------------------------------------------------
  // Returns { pre: [stmts], read: expr, write: (v) => stmt } for an EA of a given size.
  // `rmw` computes the address once for read-modify-write.
  ea(e, size, rmw = false) {
    const pre = [];
    const R = { 1: 'M.read8', 2: 'M.read16', 4: 'M.read32' }[size];
    const W = { 1: 'M.write8', 2: 'M.write16', 4: 'M.write32' }[size];
    const memAt = (expr) => {
      let addr = expr;
      if (rmw || !/^0x[0-9a-f]+$/.test(expr)) { const t = this.t(); pre.push(`${t} = ${expr} & 0xffffff;`); addr = t; }
      else addr = hex(Number(expr) & 0xffffff);
      return { pre, read: size === 4 ? `(${R}(${addr}) >>> 0)` : `${R}(${addr})`, write: (v) => `${W}(${addr}, ${v});`, addr };
    };
    const idx = (e2) => {
      const reg = `c.${e2.xa ? 'a' : 'd'}[${e2.xr}]`;
      return e2.xl ? reg : `((${reg} << 16) >> 16)`;
    };
    switch (e.m) {
      case 'd': {
        const r = `c.d[${e.r}]`;
        const read = size === 4 ? `(${r} >>> 0)` : `(${r} & ${MASK[size]})`;
        const write = size === 4 ? (v) => `${r} = ${v};` : (v) => `${r} = (${r} & ~${MASK[size]}) | ((${v}) & ${MASK[size]});`;
        return { pre, read, write };
      }
      case 'a': {
        const r = `c.a[${e.r}]`;
        return { pre, read: size === 4 ? `(${r} >>> 0)` : `(${r} & ${MASK[size]})`, write: (v) => `${r} = ${v};` };
      }
      case 'ind': return memAt(`c.a[${e.r}]`);
      case 'post': {
        const t = this.t();
        const inc = size === 1 && e.r === 7 ? 2 : size;
        pre.push(`${t} = c.a[${e.r}] & 0xffffff; c.a[${e.r}] += ${inc};`);
        return { pre, read: size === 4 ? `(${R}(${t}) >>> 0)` : `${R}(${t})`, write: (v) => `${W}(${t}, ${v});` };
      }
      case 'pre': {
        const t = this.t();
        const inc = size === 1 && e.r === 7 ? 2 : size;
        pre.push(`c.a[${e.r}] -= ${inc}; ${t} = c.a[${e.r}] & 0xffffff;`);
        return { pre, read: size === 4 ? `(${R}(${t}) >>> 0)` : `${R}(${t})`, write: (v) => `${W}(${t}, ${v});` };
      }
      case 'disp': return memAt(`(c.a[${e.r}] + ${e.disp})`);
      case 'idx': return memAt(`(c.a[${e.r}] + ${e.disp} + ${idx(e)})`);
      case 'absw': case 'absl': case 'pcd': return memAt(this.addr(e.abs));
      case 'pci': return memAt(`(${this.addr(e.abs)} + ${idx(e)})`);
      case 'imm': return { pre, read: hex(e.imm), write: () => '/* write to immediate */' };
    }
    throw new Error('bad ea ' + JSON.stringify(e));
  }

  // effective address value (lea/pea/jsr/jmp)
  eaAddr(e) {
    const idx = (e2) => { const reg = `c.${e2.xa ? 'a' : 'd'}[${e2.xr}]`; return e2.xl ? reg : `((${reg} << 16) >> 16)`; };
    switch (e.m) {
      case 'ind': return `(c.a[${e.r}] >>> 0)`;
      case 'disp': return `((c.a[${e.r}] + ${e.disp}) >>> 0)`;
      case 'idx': return `((c.a[${e.r}] + ${e.disp} + ${idx(e)}) >>> 0)`;
      case 'absw': case 'absl': case 'pcd': return this.addr(e.abs);
      case 'pci': return `((${this.addr(e.abs)} + ${idx(e)}) >>> 0)`;
    }
    throw new Error('bad control ea ' + e.m);
  }

  // ---- instructions --------------------------------------------------------------------
  ins(i, need, f) {
    const out = [];
    const sz = i.size;
    const next = i.addr + i.len;
    const cyc = `c.cycles += ${4 + i.len * 2};`;
    const nz = (v, s) => {
      const st = [];
      if (need & 8) st.push(`c.n = (${v}) ${s === 4 ? '>>> 31' : `>> ${s * 8 - 1} & 1`};`);
      if (need & 4) st.push(`c.z = (${v}) === 0 ? 1 : 0;`);
      if (need & 2) st.push('c.v = 0;');
      if (need & 1) st.push('c.c = 0;');
      return st;
    };
    const logic = (resExpr) => { const t = this.t(); return [`${t} = ${resExpr};`, ...nz(t, sz), t]; };
    switch (i.op) {
      case 'move': case 'moveq': {
        const s = this.ea(i.src, sz);
        out.push(...s.pre);
        const t = this.t();
        out.push(`${t} = ${s.read};`);
        if (need) out.push(...nz(t, sz));
        const d = this.ea(i.dst, sz);
        out.push(...d.pre, d.write(t));
        break;
      }
      case 'movea': {
        const s = this.ea(i.src, sz);
        out.push(...s.pre, `c.a[${i.dst.r}] = ${sz === 2 ? `(${s.read} << 16) >> 16` : s.read};`);
        break;
      }
      case 'lea': out.push(`c.a[${i.dst.r}] = ${this.eaAddr(i.src)};`); break;
      case 'pea': { const t = this.t(); out.push(`${t} = ${this.eaAddr(i.src)};`, `c.a[7] -= 4; M.write32(c.a[7] & 0xffffff, ${t});`); break; }
      case 'clr': {
        const d = this.ea(i.dst, sz);
        out.push(...d.pre, d.write('0'));
        if (need & 8) out.push('c.n = 0;'); if (need & 4) out.push('c.z = 1;'); if (need & 2) out.push('c.v = 0;'); if (need & 1) out.push('c.c = 0;');
        break;
      }
      case 'tst': { const s = this.ea(i.src, sz); const t = this.t(); out.push(...s.pre, `${t} = ${s.read};`, ...nz(t, sz)); break; }
      case 'and': case 'andi': case 'or': case 'ori': case 'eor': case 'eori': {
        const opch = i.op.startsWith('and') ? '&' : i.op.startsWith('or') ? '|' : '^';
        const s = this.ea(i.src, sz);
        out.push(...s.pre);
        const sv = this.t(); out.push(`${sv} = ${s.read};`);
        const d = this.ea(i.dst, sz, true);
        out.push(...d.pre);
        const r = this.t();
        out.push(`${r} = (${d.read} ${opch} ${sv})${sz === 4 ? ' >>> 0' : ` & ${MASK[sz]}`};`, ...nz(r, sz), d.write(r));
        break;
      }
      case 'not': {
        const d = this.ea(i.dst, sz, true); out.push(...d.pre);
        const r = this.t(); out.push(`${r} = (~${d.read})${sz === 4 ? ' >>> 0' : ` & ${MASK[sz]}`};`, ...nz(r, sz), d.write(r));
        break;
      }
      case 'add': case 'addi': case 'addq': case 'sub': case 'subi': case 'subq': {
        const isAdd = i.op.startsWith('add');
        if (i.dst.m === 'a') { // addq/subq to An: whole register, no flags
          out.push(`c.a[${i.dst.r}] ${isAdd ? '+' : '-'}= ${i.src.imm};`);
          break;
        }
        const s = this.ea(i.src, sz); out.push(...s.pre);
        const sv = this.t(); out.push(`${sv} = ${s.read};`);
        const d = this.ea(i.dst, sz, true); out.push(...d.pre);
        const r = this.t();
        if (need) {
          out.push(`${r} = c.${isAdd ? 'add' : 'sub'}(${sv}, ${d.read}, ${sz});`);
          if (need & 4) out.push(`c.z = ${r} === 0 ? 1 : 0;`);
        } else out.push(`${r} = (${d.read} ${isAdd ? '+' : '-'} ${sv})${sz === 4 ? ' >>> 0' : ` & ${MASK[sz]}`};`);
        out.push(d.write(r));
        break;
      }
      case 'adda': case 'suba': {
        const s = this.ea(i.src, sz); out.push(...s.pre);
        out.push(`c.a[${i.dst.r}] ${i.op === 'adda' ? '+' : '-'}= ${sz === 2 ? `(${s.read} << 16) >> 16` : s.read};`);
        break;
      }
      case 'cmp': case 'cmpi': {
        const s = this.ea(i.src, sz); out.push(...s.pre);
        const sv = this.t(); out.push(`${sv} = ${s.read};`);
        const d = this.ea(i.dst, sz); out.push(...d.pre);
        if (need) out.push(`c.cmp(${sv}, ${d.read}, ${sz});`);
        break;
      }
      case 'cmpa': {
        const s = this.ea(i.src, sz); out.push(...s.pre);
        if (need) out.push(`c.cmp(${sz === 2 ? `((${s.read} << 16) >> 16) >>> 0` : s.read}, c.a[${i.dst.r}] >>> 0, 4);`);
        break;
      }
      case 'cmpm': {
        const ta = this.t(), tb = this.t();
        const inc = (r) => sz === 1 && r === 7 ? 2 : sz;
        out.push(`${ta} = c.a[${i.ry}] & 0xffffff; c.a[${i.ry}] += ${inc(i.ry)};`, `${tb} = c.a[${i.rx}] & 0xffffff; c.a[${i.rx}] += ${inc(i.rx)};`);
        const R = { 1: 'M.read8', 2: 'M.read16', 4: 'M.read32' }[sz];
        out.push(`c.cmp(${R}(${ta})${sz === 4 ? ' >>> 0' : ''}, ${R}(${tb})${sz === 4 ? ' >>> 0' : ''}, ${sz});`);
        break;
      }
      case 'neg': case 'negx': {
        const d = this.ea(i.dst, sz, true); out.push(...d.pre);
        const r = this.t();
        if (i.op === 'neg') {
          out.push(`${r} = c.sub(${d.read}, 0, ${sz});`);
          if (need & 4) out.push(`c.z = ${r} === 0 ? 1 : 0;`);
        } else out.push(`${r} = c.sub(${d.read}, 0, ${sz}, c.x); if (${r} !== 0) c.z = 0;`);
        out.push(d.write(r));
        break;
      }
      case 'addx': case 'subx': {
        const R = { 1: 'M.read8', 2: 'M.read16', 4: 'M.read32' }[sz];
        const W = { 1: 'M.write8', 2: 'M.write16', 4: 'M.write32' }[sz];
        const fn = i.op === 'addx' ? 'add' : 'sub';
        const r = this.t();
        if (i.mem) {
          const ts = this.t(), td = this.t();
          const dec = (n) => sz === 1 && n === 7 ? 2 : sz;
          out.push(`c.a[${i.ry}] -= ${dec(i.ry)}; ${ts} = ${R}(c.a[${i.ry}] & 0xffffff)${sz === 4 ? ' >>> 0' : ''};`,
            `c.a[${i.rx}] -= ${dec(i.rx)}; ${td} = c.a[${i.rx}] & 0xffffff;`,
            `${r} = c.${fn}(${ts}, ${R}(${td})${sz === 4 ? ' >>> 0' : ''}, ${sz}, c.x); if (${r} !== 0) c.z = 0;`,
            `${W}(${td}, ${r});`);
        } else {
          const d = this.ea({ m: 'd', r: i.rx }, sz), s = this.ea({ m: 'd', r: i.ry }, sz);
          out.push(`${r} = c.${fn}(${s.read}, ${d.read}, ${sz}, c.x); if (${r} !== 0) c.z = 0;`, d.write(r));
        }
        break;
      }
      case 'abcd': case 'sbcd': case 'nbcd':
        out.push(`R.interp(${hex(i.addr)}, ${hex(next)});`);  // rare: run through the interpreter
        break;
      case 'mulu': case 'muls': {
        const s = this.ea(i.src, 2); out.push(...s.pre);
        const r = this.t();
        if (i.op === 'mulu') out.push(`${r} = (${s.read} * (c.d[${i.dst.r}] & 0xffff)) >>> 0;`);
        else out.push(`${r} = Math.imul((${s.read} << 16) >> 16, (c.d[${i.dst.r}] << 16) >> 16);`);
        out.push(`c.d[${i.dst.r}] = ${r};`, ...nz(`${r} >>> 0`, 4));
        break;
      }
      case 'divu': case 'divs': case 'chk': case 'tas': case 'movep': case 'move_to_sr': case 'move_from_sr':
      case 'andi_sr': case 'ori_sr': case 'eori_sr': case 'stop': case 'reset': case 'trapv': case 'rtr':
      case 'move_to_usp': case 'move_from_usp': case 'linea': case 'illegal':
        out.push(`R.interp(${hex(i.addr)}, ${hex(next)});`);
        if (i.op === 'illegal' || i.op === 'linea') out.push('return;');
        break;
      case 'move_to_ccr': { const s = this.ea(i.src, 2); out.push(...s.pre, `c.setCCR(${s.read});`); break; }
      case 'andi_ccr': out.push(`c.setCCR(c.getCCR() & ${hex(i.imm)});`); break;
      case 'ori_ccr': out.push(`c.setCCR(c.getCCR() | ${hex(i.imm)});`); break;
      case 'eori_ccr': out.push(`c.setCCR(c.getCCR() ^ ${hex(i.imm)});`); break;
      case 'swap': {
        const r = this.t();
        out.push(`${r} = ((c.d[${i.dst.r}] >>> 16) | (c.d[${i.dst.r}] << 16)) >>> 0;`, `c.d[${i.dst.r}] = ${r};`, ...nz(r, 4));
        break;
      }
      case 'extw': {
        const r = this.t();
        out.push(`${r} = ((c.d[${i.dst.r}] << 24) >> 24) & 0xffff;`, `c.d[${i.dst.r}] = (c.d[${i.dst.r}] & ~0xffff) | ${r};`, ...nz(r, 2));
        break;
      }
      case 'extl': {
        out.push(`c.d[${i.dst.r}] = (c.d[${i.dst.r}] << 16) >> 16;`, ...nz(`c.d[${i.dst.r}] >>> 0`, 4));
        break;
      }
      case 'exg': {
        const r = this.t();
        const A = `c.${i.a.m}[${i.a.r}]`, B = `c.${i.b.m}[${i.b.r}]`;
        out.push(`${r} = ${A}; ${A} = ${B}; ${B} = ${r};`);
        break;
      }
      case 'btst': case 'bchg': case 'bclr': case 'bset': {
        const bit = i.bit.m === 'imm' ? `${i.bit.imm & (i.dst.m === 'd' ? 31 : 7)}` : `(c.d[${i.bit.r}] & ${i.dst.m === 'd' ? 31 : 7})`;
        const d = this.ea(i.dst, i.dst.m === 'd' ? 4 : 1, true); out.push(...d.pre);
        const v = this.t(), mk = this.t();
        out.push(`${mk} = 1 << ${bit};`, `${v} = ${d.read};`);
        if (need & 4) out.push(`c.z = (${v} & ${mk}) === 0 ? 1 : 0;`);
        if (i.op === 'bchg') out.push(d.write(`${v} ^ ${mk}`));
        if (i.op === 'bclr') out.push(d.write(`${v} & ~${mk}`));
        if (i.op === 'bset') out.push(d.write(`${v} | ${mk}`));
        break;
      }
      case 'asl': case 'asr': case 'lsl': case 'lsr': case 'rol': case 'ror': case 'roxl': case 'roxr': {
        const type = { as: 0, ls: 1, rox: 2, ro: 3 }[i.op.slice(0, -1)];
        const left = i.op.endsWith('l');
        const cnt = i.count.m === 'imm' ? `${i.count.imm}` : `(c.d[${i.count.r}] & 63)`;
        const d = this.ea(i.dst, sz, true); out.push(...d.pre);
        const r = this.t();
        if (!need && type !== 2 && i.count.m === 'imm' && sz !== 4 && type === 1) {
          out.push(`${r} = (${d.read} ${left ? '<<' : '>>>'} ${cnt}) & ${MASK[sz]};`);
        } else if (!need && type === 1 && i.count.m === 'imm' && sz === 4) {
          out.push(`${r} = ${cnt} >= 32 ? 0 : (${d.read} ${left ? '<<' : '>>>'} ${cnt}) >>> 0;`);
        } else {
          out.push(`${r} = R.shift(${type}, ${left}, ${d.read}, ${cnt}, ${sz});`);
        }
        out.push(d.write(r));
        break;
      }
      case 'scc': {
        const d = this.ea(i.dst, 1); out.push(...d.pre, d.write(`${CONDS[i.cc]} ? 0xff : 0`));
        break;
      }
      case 'movem': {
        const regs = [];
        for (let k = 0; k < 16; k++) if (i.mask & (1 << k)) regs.push(k);
        const W = i.size === 4 ? 'M.write32' : 'M.write16';
        const RD = i.size === 4 ? 'M.read32' : 'M.read16';
        const rn = (k) => k < 8 ? `c.d[${k}]` : `c.a[${k - 8}]`;
        const t = this.t();
        if (i.toMem && i.ea.m === 'pre') {
          // mask bit 0 = a7 ... bit 15 = d0; registers stored from a7 down to d0
          const init = this.t();
          out.push(`${init} = c.a[${i.ea.r}]; ${t} = c.a[${i.ea.r}] >>> 0;`);
          for (const k of regs) {
            const reg = 15 - k;
            const val = reg >= 8 && reg - 8 === i.ea.r ? init : rn(reg);
            out.push(`${t} = (${t} - ${i.size}) >>> 0; ${W}(${t} & 0xffffff, ${val});`);
          }
          out.push(`c.a[${i.ea.r}] = ${t};`);
        } else if (i.toMem) {
          out.push(`${t} = ${this.eaAddr(i.ea)};`);
          for (const k of regs) out.push(`${W}(${t} & 0xffffff, ${rn(k)}); ${t} = (${t} + ${i.size}) >>> 0;`);
        } else {
          out.push(`${t} = ${i.ea.m === 'post' ? `c.a[${i.ea.r}] >>> 0` : this.eaAddr(i.ea)};`);
          for (const k of regs) {
            const rd = i.size === 4 ? `${RD}(${t} & 0xffffff)` : `(${RD}(${t} & 0xffffff) << 16) >> 16`;
            out.push(`${rn(k)} = ${rd}; ${t} = (${t} + ${i.size}) >>> 0;`);
          }
          if (i.ea.m === 'post') out.push(`c.a[${i.ea.r}] = ${t};`);
        }
        break;
      }
      case 'link': out.push(`c.a[7] -= 4; M.write32(c.a[7] & 0xffffff, ${i.r === 7 ? 'c.a[7]' : `c.a[${i.r}]`});`, `c.a[${i.r}] = c.a[7];`, `c.a[7] += ${i.imm};`); break;
      case 'unlk': out.push(`c.a[7] = c.a[${i.r}];`, `c.a[${i.r}] = M.read32(c.a[7] & 0xffffff); c.a[7] += 4;`); break;
      case 'nop': break;
      case 'bra': out.push(cyc, `${this.backEdge(i)}pc = ${hex(i.target)}; continue;`); return out;
      case 'bcc': out.push(cyc, `if (${CONDS[i.cc]}) { ${this.backEdge(i)}pc = ${hex(i.target)}; continue; }`); return out;
      case 'dbcc': {
        const r = this.t();
        out.push(cyc, `if (!${CONDS[i.cc]}) { ${r} = (c.d[${i.r}] - 1) & 0xffff; c.d[${i.r}] = (c.d[${i.r}] & ~0xffff) | ${r}; if (${r} !== 0xffff) { ${this.backEdge(i)}pc = ${hex(i.target)}; continue; } }`);
        return out;
      }
      case 'bsr': out.push(cyc, `R.call(${hex(i.target)}, ${hex(next)});`); return out;
      case 'jsr': {
        // Always go through the register: the analyzer's resolved target (a hint for
        // finding functions) is not guaranteed on every path.
        const tgt = this.eaAddr(i.src) + (i.resolved !== undefined ? ` /* usually ${hex(i.resolved)} */` : '');
        out.push(cyc, `R.call(${tgt}, ${hex(next)});`);
        return out;
      }
      case 'jmp': {
        if (i.src.m === 'pci') {
          const tb = f.tables.find((x) => x.at === i.addr);
          if (tb) { out.push(cyc, `pc = ${this.eaAddr(i.src)}; continue;`); return out; }
        }
        if ((i.src.m === 'absl' || i.src.m === 'absw' || i.src.m === 'pcd') && f.insnAddrs.has(i.src.abs)) { out.push(cyc, `pc = ${hex(i.src.abs)}; continue;`); return out; }
        // Always go through the register: the analyzer's resolved target (a hint for
        // finding functions) is not guaranteed on every path.
        const tgt = this.eaAddr(i.src) + (i.resolved !== undefined ? ` /* usually ${hex(i.resolved)} */` : '');
        out.push(cyc, `return R.jump(${tgt});`);
        return out;
      }
      case 'rts': out.push(cyc, 'c.pc = M.read32(c.a[7] & 0xffffff); c.a[7] += 4; return;'); return out;
      case 'rte': out.push(`R.interp(${hex(i.addr)}, -1);`, 'return;'); return out;
      case 'trap': out.push(cyc, `R.trap(${i.vec}, ${hex(i.addr)}, ${hex(next)});`); return out;
      case 'linef': out.push(cyc, `R.dos(${hex(i.addr)}, ${hex(next)});`); return out;
      default:
        out.push(`R.interp(${hex(i.addr)}, ${hex(next)}); /* ${i.op} */`);
    }
    // non-memory-flag instructions still charge time
    out.push(cyc);
    return out;
  }
}
