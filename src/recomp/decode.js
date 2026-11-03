// Static 68000 decoder producing structured instructions for analysis and
// translation. decode(mem, addr) reads big-endian words through mem.r16(addr).
//
// Instruction: { addr, len, op, size, src, dst, cc, target, imm, mask, ... }
// Operand (EA): { m: 'd'|'a'|'ind'|'post'|'pre'|'disp'|'idx'|'absw'|'absl'|'pcd'|'pci'|'imm',
//                 r, disp, xr, xa, xl, abs, imm }
//   idx/pci: xr = index register number, xa = index is An, xl = long index.
//   pcd/pci: abs = PC-relative base resolved to an absolute address (+disp).

const SZ = [1, 2, 4];
const CC = ['t', 'f', 'hi', 'ls', 'cc', 'cs', 'ne', 'eq', 'vc', 'vs', 'pl', 'mi', 'ge', 'lt', 'gt', 'le'];
export { CC };

const sx8 = (v) => (v << 24) >> 24;
const sx16 = (v) => (v << 16) >> 16;

class Reader {
  constructor(mem, addr) { this.mem = mem; this.pc = addr; this.start = addr; }
  w() { const v = this.mem.r16(this.pc); this.pc += 2; return v; }
  l() { const v = ((this.mem.r16(this.pc) << 16) | this.mem.r16(this.pc + 2)) >>> 0; this.pc += 4; return v; }
}

function ea(rd, mode, reg, size) {
  switch (mode) {
    case 0: return { m: 'd', r: reg };
    case 1: return { m: 'a', r: reg };
    case 2: return { m: 'ind', r: reg };
    case 3: return { m: 'post', r: reg };
    case 4: return { m: 'pre', r: reg };
    case 5: return { m: 'disp', r: reg, disp: sx16(rd.w()) };
    case 6: { const x = rd.w(); return { m: 'idx', r: reg, disp: sx8(x & 0xff), xr: (x >> 12) & 7, xa: !!(x & 0x8000), xl: !!(x & 0x800) }; }
    case 7:
      switch (reg) {
        case 0: return { m: 'absw', abs: sx16(rd.w()) >>> 0 };
        case 1: return { m: 'absl', abs: rd.l() };
        case 2: { const base = rd.pc; return { m: 'pcd', abs: (base + sx16(rd.w())) >>> 0 }; }
        case 3: { const base = rd.pc; const x = rd.w(); return { m: 'pci', abs: (base + sx8(x & 0xff)) >>> 0, xr: (x >> 12) & 7, xa: !!(x & 0x8000), xl: !!(x & 0x800) }; }
        case 4: {
          if (size === 1) return { m: 'imm', imm: rd.w() & 0xff };
          if (size === 2) return { m: 'imm', imm: rd.w() };
          return { m: 'imm', imm: rd.l() };
        }
      }
  }
  return null;
}

export function decode(mem, addr) {
  const rd = new Reader(mem, addr);
  const op = rd.w();
  const ins = decodeOp(rd, op);
  ins.addr = addr;
  ins.opcode = op;
  ins.len = rd.pc - addr;
  return ins;
}

function bad() { return { op: 'illegal' }; }

function decodeOp(rd, op) {
  const hi = op >> 12;
  const mode = (op >> 3) & 7, reg = op & 7, rx = (op >> 9) & 7, opm = (op >> 6) & 7;
  switch (hi) {
    case 0x0: {
      if (op === 0x003c) return { op: 'ori_ccr', imm: rd.w() & 0xff };
      if (op === 0x007c) return { op: 'ori_sr', imm: rd.w() };
      if (op === 0x023c) return { op: 'andi_ccr', imm: rd.w() & 0xff };
      if (op === 0x027c) return { op: 'andi_sr', imm: rd.w() };
      if (op === 0x0a3c) return { op: 'eori_ccr', imm: rd.w() & 0xff };
      if (op === 0x0a7c) return { op: 'eori_sr', imm: rd.w() };
      if (op & 0x100) {
        if (mode === 1) {
          const disp = sx16(rd.w());
          return { op: 'movep', size: opm & 1 ? 4 : 2, toMem: opm >= 6, dr: rx, ar: reg, disp };
        }
        const t = ['btst', 'bchg', 'bclr', 'bset'][(op >> 6) & 3];
        return { op: t, bit: { m: 'd', r: rx }, dst: ea(rd, mode, reg, 1), size: mode === 0 ? 4 : 1 };
      }
      const sub = (op >> 9) & 7;
      if (sub === 4) {
        const t = ['btst', 'bchg', 'bclr', 'bset'][(op >> 6) & 3];
        const bit = rd.w() & 0xff;
        return { op: t, bit: { m: 'imm', imm: bit }, dst: ea(rd, mode, reg, 1), size: mode === 0 ? 4 : 1 };
      }
      const s = (op >> 6) & 3;
      if (s === 3) return bad();
      const size = SZ[s];
      const name = ['ori', 'andi', 'subi', 'addi', null, 'eori', 'cmpi', null][sub];
      if (!name) return bad();
      const imm = ea(rd, 7, 4, size).imm;
      return { op: name, size, src: { m: 'imm', imm }, dst: ea(rd, mode, reg, size) };
    }
    case 0x1: case 0x2: case 0x3: {
      const size = hi === 1 ? 1 : hi === 3 ? 2 : 4;
      const src = ea(rd, mode, reg, size);
      const dmode = (op >> 6) & 7;
      if (dmode === 1) return { op: 'movea', size, src, dst: { m: 'a', r: rx } };
      return { op: 'move', size, src, dst: ea(rd, dmode, rx, size) };
    }
    case 0x4: return decode4(rd, op, mode, reg, rx, opm);
    case 0x5: {
      const s = (op >> 6) & 3;
      if (s === 3) {
        const cc = (op >> 8) & 15;
        if (mode === 1) { const base = rd.pc; const d = sx16(rd.w()); return { op: 'dbcc', cc, r: reg, target: (base + d) >>> 0 }; }
        return { op: 'scc', cc, size: 1, dst: ea(rd, mode, reg, 1) };
      }
      let q = (op >> 9) & 7; if (!q) q = 8;
      return { op: op & 0x100 ? 'subq' : 'addq', size: SZ[s], src: { m: 'imm', imm: q }, dst: ea(rd, mode, reg, SZ[s]) };
    }
    case 0x6: {
      const cc = (op >> 8) & 15;
      const base = rd.pc;
      let d = sx8(op & 0xff);
      if (d === 0) d = sx16(rd.w());
      const target = (base + d) >>> 0;
      if (cc === 0) return { op: 'bra', target };
      if (cc === 1) return { op: 'bsr', target };
      return { op: 'bcc', cc, target };
    }
    case 0x7: return { op: 'moveq', size: 4, src: { m: 'imm', imm: sx8(op & 0xff) >>> 0 }, dst: { m: 'd', r: rx } };
    case 0x8: case 0x9: case 0xb: case 0xc: case 0xd: return decodeArith(rd, op, hi, mode, reg, rx, opm);
    case 0xa: return { op: 'linea' };
    case 0xe: {
      if (((op >> 6) & 3) === 3) {
        const t = ['as', 'ls', 'rox', 'ro'][(op >> 9) & 3];
        return { op: t + (op & 0x100 ? 'l' : 'r'), size: 2, count: { m: 'imm', imm: 1 }, dst: ea(rd, mode, reg, 2) };
      }
      const t = ['as', 'ls', 'rox', 'ro'][(op >> 3) & 3];
      const size = SZ[(op >> 6) & 3];
      const count = op & 0x20 ? { m: 'd', r: rx } : { m: 'imm', imm: rx || 8 };
      return { op: t + (op & 0x100 ? 'l' : 'r'), size, count, dst: { m: 'd', r: reg } };
    }
    case 0xf: return { op: 'linef', fn: op & 0xff };
  }
  return bad();
}

function decode4(rd, op, mode, reg, rx, opm) {
  if (op & 0x100) {
    if (opm === 7) return { op: 'lea', src: ea(rd, mode, reg, 4), dst: { m: 'a', r: rx } };
    if (opm === 6) return { op: 'chk', size: 2, src: ea(rd, mode, reg, 2), dst: { m: 'd', r: rx } };
    return bad();
  }
  const sub = (op >> 8) & 15, s = (op >> 6) & 3;
  switch (sub) {
    case 0x0: return s === 3 ? { op: 'move_from_sr', size: 2, dst: ea(rd, mode, reg, 2) } : { op: 'negx', size: SZ[s], dst: ea(rd, mode, reg, SZ[s]) };
    case 0x2: return s === 3 ? bad() : { op: 'clr', size: SZ[s], dst: ea(rd, mode, reg, SZ[s]) };
    case 0x4: return s === 3 ? { op: 'move_to_ccr', size: 2, src: ea(rd, mode, reg, 2) } : { op: 'neg', size: SZ[s], dst: ea(rd, mode, reg, SZ[s]) };
    case 0x6: return s === 3 ? { op: 'move_to_sr', size: 2, src: ea(rd, mode, reg, 2) } : { op: 'not', size: SZ[s], dst: ea(rd, mode, reg, SZ[s]) };
    case 0x8:
      if (s === 0) return { op: 'nbcd', size: 1, dst: ea(rd, mode, reg, 1) };
      if (s === 1) return mode === 0 ? { op: 'swap', dst: { m: 'd', r: reg } } : { op: 'pea', src: ea(rd, mode, reg, 4) };
      if (mode === 0) return { op: s === 2 ? 'extw' : 'extl', dst: { m: 'd', r: reg } };
      { const mask = rd.w(); return { op: 'movem', size: s === 3 ? 4 : 2, toMem: true, mask, ea: ea(rd, mode, reg, 4) }; }
    case 0xa:
      if (op === 0x4afc) return { op: 'illegal' };
      return s === 3 ? { op: 'tas', size: 1, dst: ea(rd, mode, reg, 1) } : { op: 'tst', size: SZ[s], src: ea(rd, mode, reg, SZ[s]) };
    case 0xc:
      if (s >= 2) { const mask = rd.w(); return { op: 'movem', size: s === 3 ? 4 : 2, toMem: false, mask, ea: ea(rd, mode, reg, 4) }; }
      return bad();
    case 0xe: {
      if (s === 1) {
        const t = (op >> 3) & 7;
        if (t <= 1) return { op: 'trap', vec: op & 15 };
        if (t === 2) return { op: 'link', r: reg, imm: sx16(rd.w()) };
        if (t === 3) return { op: 'unlk', r: reg };
        if (t === 4) return { op: 'move_to_usp', r: reg };
        if (t === 5) return { op: 'move_from_usp', r: reg };
        if (t === 6) {
          switch (op & 7) {
            case 0: return { op: 'reset' };
            case 1: return { op: 'nop' };
            case 2: return { op: 'stop', imm: rd.w() };
            case 3: return { op: 'rte' };
            case 5: return { op: 'rts' };
            case 6: return { op: 'trapv' };
            case 7: return { op: 'rtr' };
          }
        }
        return bad();
      }
      if (s === 2) return { op: 'jsr', src: ea(rd, mode, reg, 4) };
      if (s === 3) return { op: 'jmp', src: ea(rd, mode, reg, 4) };
    }
  }
  return bad();
}

function decodeArith(rd, op, hi, mode, reg, rx, opm) {
  const s = SZ[opm & 3];
  switch (hi) {
    case 0x8:
      if (opm === 3) return { op: 'divu', size: 2, src: ea(rd, mode, reg, 2), dst: { m: 'd', r: rx } };
      if (opm === 7) return { op: 'divs', size: 2, src: ea(rd, mode, reg, 2), dst: { m: 'd', r: rx } };
      if (opm === 4 && mode <= 1) return { op: 'sbcd', size: 1, mem: mode === 1, rx, ry: reg };
      return opm < 3 ? { op: 'or', size: s, src: ea(rd, mode, reg, s), dst: { m: 'd', r: rx } }
        : { op: 'or', size: s, src: { m: 'd', r: rx }, dst: ea(rd, mode, reg, s) };
    case 0xc:
      if (opm === 3) return { op: 'mulu', size: 2, src: ea(rd, mode, reg, 2), dst: { m: 'd', r: rx } };
      if (opm === 7) return { op: 'muls', size: 2, src: ea(rd, mode, reg, 2), dst: { m: 'd', r: rx } };
      if (opm === 4 && mode <= 1) return { op: 'abcd', size: 1, mem: mode === 1, rx, ry: reg };
      if (opm === 5 && mode === 0) return { op: 'exg', a: { m: 'd', r: rx }, b: { m: 'd', r: reg } };
      if (opm === 5 && mode === 1) return { op: 'exg', a: { m: 'a', r: rx }, b: { m: 'a', r: reg } };
      if (opm === 6 && mode === 1) return { op: 'exg', a: { m: 'd', r: rx }, b: { m: 'a', r: reg } };
      return opm < 3 ? { op: 'and', size: s, src: ea(rd, mode, reg, s), dst: { m: 'd', r: rx } }
        : { op: 'and', size: s, src: { m: 'd', r: rx }, dst: ea(rd, mode, reg, s) };
    case 0x9: case 0xd: {
      const n = hi === 0xd ? 'add' : 'sub';
      if (opm === 3 || opm === 7) { const sz = opm === 7 ? 4 : 2; return { op: n + 'a', size: sz, src: ea(rd, mode, reg, sz), dst: { m: 'a', r: rx } }; }
      if (opm >= 4 && mode <= 1) return { op: n + 'x', size: s, mem: mode === 1, rx, ry: reg };
      return opm < 3 ? { op: n, size: s, src: ea(rd, mode, reg, s), dst: { m: 'd', r: rx } }
        : { op: n, size: s, src: { m: 'd', r: rx }, dst: ea(rd, mode, reg, s) };
    }
    case 0xb:
      if (opm === 3 || opm === 7) { const sz = opm === 7 ? 4 : 2; return { op: 'cmpa', size: sz, src: ea(rd, mode, reg, sz), dst: { m: 'a', r: rx } }; }
      if (opm < 3) return { op: 'cmp', size: s, src: ea(rd, mode, reg, s), dst: { m: 'd', r: rx } };
      if (mode === 1) return { op: 'cmpm', size: s, rx, ry: reg };
      return { op: 'eor', size: s, src: { m: 'd', r: rx }, dst: ea(rd, mode, reg, s) };
  }
  return bad();
}

// ---- text formatting (for listings) ------------------------------------------------
const h = (v) => '$' + (v >>> 0).toString(16);
export function fmtEA(e) {
  if (!e) return '?';
  switch (e.m) {
    case 'd': return `d${e.r}`;
    case 'a': return e.r === 7 ? 'sp' : `a${e.r}`;
    case 'ind': return `(a${e.r})`;
    case 'post': return `(a${e.r})+`;
    case 'pre': return `-(a${e.r})`;
    case 'disp': return `${e.disp}(a${e.r})`;
    case 'idx': return `${e.disp}(a${e.r},${e.xa ? 'a' : 'd'}${e.xr}.${e.xl ? 'l' : 'w'})`;
    case 'absw': return `${h(e.abs)}.w`;
    case 'absl': return `${h(e.abs)}`;
    case 'pcd': return `${h(e.abs)}(pc)`;
    case 'pci': return `${h(e.abs)}(pc,${e.xa ? 'a' : 'd'}${e.xr}.${e.xl ? 'l' : 'w'})`;
    case 'imm': return `#${h(e.imm)}`;
  }
  return '?';
}

export function fmt(ins) {
  const sz = ins.size ? '.' + ({ 1: 'b', 2: 'w', 4: 'l' })[ins.size] : '';
  const regs = (mask, rev) => {
    const out = [];
    for (let i = 0; i < 16; i++) if (mask & (1 << (rev ? 15 - i : i))) out.push(i < 8 ? `d${i}` : `a${i - 8}`);
    return out.join('/');
  };
  switch (ins.op) {
    case 'bcc': return `b${CC[ins.cc]} ${h(ins.target)}`;
    case 'dbcc': return `db${CC[ins.cc]} d${ins.r},${h(ins.target)}`;
    case 'scc': return `s${CC[ins.cc]} ${fmtEA(ins.dst)}`;
    case 'bra': case 'bsr': return `${ins.op} ${h(ins.target)}`;
    case 'movem': {
      const r = regs(ins.mask, ins.ea.m === 'pre');
      return ins.toMem ? `movem${sz} ${r},${fmtEA(ins.ea)}` : `movem${sz} ${fmtEA(ins.ea)},${r}`;
    }
    case 'link': return `link a${ins.r},#${ins.imm}`;
    case 'unlk': return `unlk a${ins.r}`;
    case 'trap': return `trap #${ins.vec}`;
    case 'linef': return `dos $ff${ins.fn.toString(16).padStart(2, '0')}`;
    case 'exg': return `exg ${fmtEA(ins.a)},${fmtEA(ins.b)}`;
    case 'abcd': case 'sbcd': case 'addx': case 'subx':
      return ins.mem ? `${ins.op}${sz} -(a${ins.ry}),-(a${ins.rx})` : `${ins.op}${sz} d${ins.ry},d${ins.rx}`;
    case 'cmpm': return `cmpm${sz} (a${ins.ry})+,(a${ins.rx})+`;
    case 'movep': return ins.toMem ? `movep${sz} d${ins.dr},${ins.disp}(a${ins.ar})` : `movep${sz} ${ins.disp}(a${ins.ar}),d${ins.dr}`;
  }
  if (ins.op.match(/^(as|ls|rox|ro)[lr]$/)) return `${ins.op}${sz} ${fmtEA(ins.count)},${fmtEA(ins.dst)}`;
  if (ins.op === 'btst' || ins.op === 'bchg' || ins.op === 'bclr' || ins.op === 'bset') return `${ins.op} ${fmtEA(ins.bit)},${fmtEA(ins.dst)}`;
  const ops = [ins.src, ins.dst].filter(Boolean).map(fmtEA);
  if (ins.imm !== undefined && !ins.src) ops.unshift('#' + h(ins.imm));
  if (ins.r !== undefined && !ins.dst && !ins.src) ops.push(`a${ins.r}`);
  return `${ins.op}${sz} ${ops.join(',')}`.trim();
}
