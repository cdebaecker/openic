// Motorola 68000 interpreter.
// Registers are kept in Int32Arrays; values handed around internally are
// unsigned (>>> 0) or masked to the operand size.

const MASK = [0, 0xff, 0xffff, 0, 0xffffffff];
const MSB = [0, 0x80, 0x8000, 0, 0x80000000];

function sx8(v) { return (v << 24) >> 24; }
function sx16(v) { return (v << 16) >> 16; }
function u32(v) { return v >>> 0; }
function trunc(v, sz) { return sz === 4 ? v >>> 0 : v & MASK[sz]; }
function neg(v, sz) { return sz === 4 ? (v & MSB[4]) !== 0 : (v & MSB[sz]) !== 0; }

export class M68K {
  constructor(bus) {
    this.bus = bus;
    this.d = new Int32Array(8);
    this.a = new Int32Array(8);
    this.pc = 0;
    this.usp = 0;
    this.ssp = 0;
    this.s = 1; this.t = 0; this.ipl = 7;
    this.x = 0; this.n = 0; this.z = 0; this.v = 0; this.c = 0;
    this.cycles = 0;
    this.stopped = false;
    this.pendingIrq = 0;       // highest pending interrupt level
    this.irqVector = null;     // function(level) -> vector number or -1 for autovector
    this.hle = null;           // function(pc) -> true if handled (address in HLE range)
    this.hleLo = 0xfe0000;     // instruction fetches at or above this address go to hle()
    this.opPC = 0;
    this.op = 0;
    this.table = new Array(65536);
    this.buildTable();
  }

  // ---- memory -------------------------------------------------------------
  rb(a) { this.cycles += 4; return this.bus.read8(a & 0xffffff); }
  rw(a) { this.cycles += 4; return this.bus.read16(a & 0xffffff); }
  rl(a) { this.cycles += 8; return this.bus.read32(a & 0xffffff) >>> 0; }
  wb(a, v) { this.cycles += 4; this.bus.write8(a & 0xffffff, v & 0xff); }
  ww(a, v) { this.cycles += 4; this.bus.write16(a & 0xffffff, v & 0xffff); }
  wl(a, v) { this.cycles += 8; this.bus.write32(a & 0xffffff, v >>> 0); }
  read(a, sz) { return sz === 1 ? this.rb(a) : sz === 2 ? this.rw(a) : this.rl(a); }
  write(a, sz, v) { if (sz === 1) this.wb(a, v); else if (sz === 2) this.ww(a, v); else this.wl(a, v); }
  fetch16() { const v = this.rw(this.pc); this.pc = (this.pc + 2) >>> 0; return v; }
  fetch32() { const v = this.rl(this.pc); this.pc = (this.pc + 4) >>> 0; return v; }
  push16(v) { this.a[7] -= 2; this.ww(this.a[7], v); }
  push32(v) { this.a[7] -= 4; this.wl(this.a[7], v); }
  pop16() { const v = this.rw(this.a[7]); this.a[7] += 2; return v; }
  pop32() { const v = this.rl(this.a[7]); this.a[7] += 4; return v; }

  // ---- status register ----------------------------------------------------
  getCCR() { return (this.x << 4) | (this.n << 3) | (this.z << 2) | (this.v << 1) | this.c; }
  setCCR(v) { this.x = (v >> 4) & 1; this.n = (v >> 3) & 1; this.z = (v >> 2) & 1; this.v = (v >> 1) & 1; this.c = v & 1; }
  getSR() { return (this.t << 15) | (this.s << 13) | (this.ipl << 8) | this.getCCR(); }
  setSR(v) {
    const ns = (v >> 13) & 1;
    if (ns !== this.s) {
      if (this.s) { this.ssp = this.a[7]; this.a[7] = this.usp; }
      else { this.usp = this.a[7]; this.a[7] = this.ssp; }
      this.s = ns;
    }
    this.t = (v >> 15) & 1;
    this.ipl = (v >> 8) & 7;
    this.setCCR(v);
  }
  getUSP() { return this.s ? this.usp >>> 0 : this.a[7] >>> 0; }
  getSSP() { return this.s ? this.a[7] >>> 0 : this.ssp >>> 0; }

  reset() {
    this.s = 1; this.ipl = 7; this.t = 0;
    this.a[7] = this.rl(0); this.pc = this.rl(4);
    this.stopped = false;
  }

  exception(vec, pc = this.pc) {
    const sr = this.getSR();
    if (!this.s) { this.usp = this.a[7]; this.a[7] = this.ssp; this.s = 1; }
    this.t = 0;
    this.push32(pc);
    this.push16(sr);
    this.pc = this.rl(vec * 4);
    this.cycles += 34;
  }

  interrupt(level) {
    this.stopped = false;
    const sr = this.getSR();
    if (!this.s) { this.usp = this.a[7]; this.a[7] = this.ssp; this.s = 1; }
    this.t = 0;
    this.push32(this.pc);
    this.push16(sr);
    this.ipl = level;
    let vec = this.irqVector ? this.irqVector(level) : -1;
    if (vec < 0) vec = 24 + level;
    this.pc = this.rl(vec * 4);
    this.cycles += 44;
  }

  checkIrq() {
    const lv = this.pendingIrq;
    if (lv > this.ipl || lv === 7) {
      this.interrupt(lv);
      return true;
    }
    return false;
  }

  // Run until at least `budget` cycles have elapsed.
  run(budget) {
    const end = this.cycles + budget;
    this.runEnd = end;
    while (this.cycles < end) {
      if (this.pendingIrq) this.checkIrq();
      if (this.stopped) { this.cycles = end; break; }
      this.step();
    }
  }

  step() {
    const pc = this.pc & 0xffffff;
    this.pc = pc;
    if (pc >= this.hleLo && this.hle && this.hle(pc)) { this.cycles += 20; return; }
    // Hook points (same addresses translated code reports through R.at).
    if (this.hooks && this.hooks[pc]) this.onHook(pc);
    // Translated (JavaScript) functions take over at their entry point.
    if (this.compiled && this.compiled[pc] && this.onCompiled(pc)) return;
    this.opPC = pc;
    const op = this.fetch16();
    this.op = op;
    this.table[op].call(this, op);
  }

  // ---- effective addresses ------------------------------------------------
  index(base) {
    const ext = this.fetch16();
    let idx = (ext & 0x8000) ? this.a[(ext >> 12) & 7] : this.d[(ext >> 12) & 7];
    if (!(ext & 0x800)) idx = sx16(idx);
    this.cycles += 2;
    return (base + idx + sx8(ext)) >>> 0;
  }

  // Address of a memory operand (modes 2-7, excluding immediate).
  eaAddr(mode, reg, sz) {
    switch (mode) {
      case 2: return this.a[reg] >>> 0;
      case 3: { const a = this.a[reg] >>> 0; this.a[reg] += (sz === 1 && reg === 7) ? 2 : sz; return a; }
      case 4: { this.a[reg] -= (sz === 1 && reg === 7) ? 2 : sz; this.cycles += 2; return this.a[reg] >>> 0; }
      case 5: return (this.a[reg] + sx16(this.fetch16())) >>> 0;
      case 6: return this.index(this.a[reg]);
      case 7:
        switch (reg) {
          case 0: return sx16(this.fetch16()) >>> 0;
          case 1: return this.fetch32();
          case 2: { const b = this.pc; return (b + sx16(this.fetch16())) >>> 0; }
          case 3: return this.index(this.pc);
        }
    }
    return this.illegal();
  }

  readEA(mode, reg, sz) {
    switch (mode) {
      case 0: return trunc(this.d[reg], sz);
      case 1: return trunc(this.a[reg], sz);
      case 7:
        if (reg === 4) {
          if (sz === 1) return this.fetch16() & 0xff;
          if (sz === 2) return this.fetch16();
          return this.fetch32();
        }
    }
    return this.read(this.eaAddr(mode, reg, sz), sz);
  }

  writeEA(mode, reg, sz, v) {
    if (mode === 0) { this.setD(reg, sz, v); return; }
    if (mode === 1) { this.a[reg] = sz === 2 ? sx16(v) : v; return; }
    this.write(this.eaAddr(mode, reg, sz), sz, v);
  }

  setD(r, sz, v) {
    if (sz === 4) this.d[r] = v;
    else if (sz === 2) this.d[r] = (this.d[r] & ~0xffff) | (v & 0xffff);
    else this.d[r] = (this.d[r] & ~0xff) | (v & 0xff);
  }

  // Read-modify-write on an EA. fn(value) returns new value or undefined.
  rmw(mode, reg, sz, fn) {
    if (mode === 0) {
      const r = fn(trunc(this.d[reg], sz));
      if (r !== undefined) this.setD(reg, sz, r);
      return;
    }
    if (mode === 1) {
      const r = fn(this.a[reg] >>> 0);
      if (r !== undefined) this.a[reg] = r;
      return;
    }
    const a = this.eaAddr(mode, reg, sz);
    const r = fn(this.read(a, sz));
    if (r !== undefined) this.write(a, sz, r);
  }

  // ---- flag helpers -------------------------------------------------------
  logic(r, sz) { this.n = neg(r, sz) ? 1 : 0; this.z = trunc(r, sz) === 0 ? 1 : 0; this.v = 0; this.c = 0; return trunc(r, sz); }

  add(s, d, sz, x = 0) {
    const m = MASK[sz];
    let r = s + d + x;
    const c = r > m ? 1 : 0;
    r = sz === 4 ? r >>> 0 : r & m;
    this.v = ((s ^ r) & (d ^ r) & MSB[sz]) !== 0 ? 1 : 0;
    this.c = this.x = c;
    this.n = neg(r, sz) ? 1 : 0;
    return r;
  }

  sub(s, d, sz, x = 0) {
    let r = d - s - x;
    const c = r < 0 ? 1 : 0;
    r = sz === 4 ? r >>> 0 : r & MASK[sz];
    this.v = ((s ^ d) & (r ^ d) & MSB[sz]) !== 0 ? 1 : 0;
    this.c = this.x = c;
    this.n = neg(r, sz) ? 1 : 0;
    return r;
  }

  cmp(s, d, sz) {
    let r = d - s;
    this.c = r < 0 ? 1 : 0;
    r = sz === 4 ? r >>> 0 : r & MASK[sz];
    this.v = ((s ^ d) & (r ^ d) & MSB[sz]) !== 0 ? 1 : 0;
    this.n = neg(r, sz) ? 1 : 0;
    this.z = r === 0 ? 1 : 0;
  }

  cond(cc) {
    switch (cc) {
      case 0: return true;
      case 1: return false;
      case 2: return !this.c && !this.z;
      case 3: return !!(this.c || this.z);
      case 4: return !this.c;
      case 5: return !!this.c;
      case 6: return !this.z;
      case 7: return !!this.z;
      case 8: return !this.v;
      case 9: return !!this.v;
      case 10: return !this.n;
      case 11: return !!this.n;
      case 12: return this.n === this.v;
      case 13: return this.n !== this.v;
      case 14: return !this.z && this.n === this.v;
      case 15: return !!this.z || this.n !== this.v;
    }
  }

  illegal() {
    this.pc = this.opPC;
    this.exception(4);
    return 0;
  }

  privileged() {
    if (this.s) return true;
    this.pc = this.opPC;
    this.exception(8);
    return false;
  }

  // ---- decode table -------------------------------------------------------
  buildTable() {
    const T = this.table;
    for (let i = 0; i < 65536; i++) T[i] = this.illegal;
    const set = (op, fn) => { T[op] = fn; };
    // Valid EA checks: data alterable, memory alterable, control, etc.
    const validEA = (mode, reg, kind) => {
      // kind flags: 'd' data, 'm' memory, 'a' alterable, 'c' control
      const isImm = mode === 7 && reg === 4;
      if (mode === 7 && reg > 4) return false;
      if (kind.includes('c')) {
        if (mode === 0 || mode === 1 || mode === 3 || mode === 4 || isImm) return false;
      }
      if (kind.includes('a')) {
        if (mode === 7 && reg >= 2) return false;
      }
      if (kind.includes('d') && mode === 1) return false;
      if (kind.includes('m') && (mode === 0 || mode === 1)) return false;
      return true;
    };
    const SZ = [1, 2, 4];

    for (let op = 0; op < 65536; op++) {
      const hi = op >> 12;
      const mode = (op >> 3) & 7, reg = op & 7;
      const rx = (op >> 9) & 7;
      const opmode = (op >> 6) & 7;
      switch (hi) {
        case 0x0: this.decode0(op, mode, reg, rx, validEA, SZ, set); break;
        case 0x1: case 0x2: case 0x3: {
          const sz = hi === 1 ? 1 : hi === 3 ? 2 : 4;
          const dmode = (op >> 6) & 7;
          if (!validEA(mode, reg, '')) break;
          if (sz === 1 && mode === 1) break;
          if (dmode === 1) {
            if (sz === 1) break;
            set(op, sz === 2 ? opMoveaW : opMoveaL);
          } else {
            if (!validEA(dmode, rx, 'da')) break;
            set(op, opMove);
          }
          break;
        }
        case 0x4: this.decode4(op, mode, reg, rx, opmode, validEA, SZ, set); break;
        case 0x5: {
          const s = (op >> 6) & 3;
          if (s === 3) {
            if (mode === 1) set(op, opDBcc);
            else if (validEA(mode, reg, 'da')) set(op, opScc);
          } else {
            if (!validEA(mode, reg, 'a')) break;
            if (mode === 1 && s === 0) break;
            set(op, (op & 0x100) ? opSubq : opAddq);
          }
          break;
        }
        case 0x6: set(op, opBcc); break;
        case 0x7: if (!(op & 0x100)) set(op, opMoveq); break;
        case 0x8: case 0x9: case 0xb: case 0xc: case 0xd:
          this.decodeArith(op, hi, mode, reg, rx, opmode, validEA, set); break;
        case 0xa: set(op, opLineA); break;
        case 0xe: this.decodeShift(op, mode, reg, validEA, set); break;
        case 0xf: set(op, opLineF); break;
      }
    }
  }

  decode0(op, mode, reg, rx, validEA, SZ, set) {
    if (op & 0x100) {
      if (mode === 1) { set(op, opMovep); return; }
      // dynamic bit ops
      const t = (op >> 6) & 3;
      if (t === 0) { if (validEA(mode, reg, 'd')) set(op, opBitDyn); }
      else if (validEA(mode, reg, 'da')) set(op, opBitDyn);
      return;
    }
    const sub = (op >> 9) & 7;
    const s = (op >> 6) & 3;
    if (sub === 4) {
      // static bit ops
      if (s === 0) { if (validEA(mode, reg, 'd') && !(mode === 7 && reg === 4)) set(op, opBitStatic); }
      else if (validEA(mode, reg, 'da')) set(op, opBitStatic);
      return;
    }
    if (s === 3) return;
    if (op === 0x003c) { set(op, opOriCCR); return; }
    if (op === 0x007c) { set(op, opOriSR); return; }
    if (op === 0x023c) { set(op, opAndiCCR); return; }
    if (op === 0x027c) { set(op, opAndiSR); return; }
    if (op === 0x0a3c) { set(op, opEoriCCR); return; }
    if (op === 0x0a7c) { set(op, opEoriSR); return; }
    if (sub === 7) return;
    if (!validEA(mode, reg, 'da')) {
      // CMPI allows only data alterable on 68000
      return;
    }
    set(op, opImm);
  }

  decode4(op, mode, reg, rx, opmode, validEA, SZ, set) {
    if (op & 0x100) {
      if (opmode === 7) { if (validEA(mode, reg, 'c')) set(op, opLea); }
      else if (opmode === 6) { if (validEA(mode, reg, 'd')) set(op, opChk); }
      return;
    }
    const sub = (op >> 8) & 0xf;
    const s = (op >> 6) & 3;
    switch (sub) {
      case 0x0:
        if (s === 3) { if (validEA(mode, reg, 'da')) set(op, opMoveFromSR); }
        else if (validEA(mode, reg, 'da')) set(op, opNegx);
        return;
      case 0x2:
        if (s !== 3 && validEA(mode, reg, 'da')) set(op, opClr);
        return;
      case 0x4:
        if (s === 3) { if (validEA(mode, reg, 'd')) set(op, opMoveToCCR); }
        else if (validEA(mode, reg, 'da')) set(op, opNeg);
        return;
      case 0x6:
        if (s === 3) { if (validEA(mode, reg, 'd')) set(op, opMoveToSR); }
        else if (validEA(mode, reg, 'da')) set(op, opNot);
        return;
      case 0x8:
        if (s === 0) { if (validEA(mode, reg, 'da')) set(op, opNbcd); }
        else if (s === 1) {
          if (mode === 0) set(op, opSwap);
          else if (validEA(mode, reg, 'c')) set(op, opPea);
        } else {
          if (mode === 0) set(op, opExt);
          else if (mode === 4 || validEA(mode, reg, 'ca')) set(op, opMovemToMem);
        }
        return;
      case 0xa:
        if (op === 0x4afc) { set(op, opIllegal); return; }
        if (s === 3) { if (validEA(mode, reg, 'da')) set(op, opTas); }
        else if (validEA(mode, reg, '') && !(s === 0 && mode === 1)) set(op, opTst);
        return;
      case 0xc:
        if (s >= 2 && (mode === 3 || validEA(mode, reg, 'c'))) set(op, opMovemToReg);
        return;
      case 0xe:
        if (s === 1) {
          const t = (op >> 3) & 7;
          if (t === 0 || t === 1) set(op, opTrap);
          else if (t === 2) set(op, opLink);
          else if (t === 3) set(op, opUnlk);
          else if (t === 4 || t === 5) set(op, opMoveUSP);
          else if (t === 6) {
            switch (op & 7) {
              case 0: set(op, opReset); break;
              case 1: set(op, opNop); break;
              case 2: set(op, opStop); break;
              case 3: set(op, opRte); break;
              case 5: set(op, opRts); break;
              case 6: set(op, opTrapv); break;
              case 7: set(op, opRtr); break;
            }
          }
        } else if (s === 2) { if (validEA(mode, reg, 'c')) set(op, opJsr); }
        else if (s === 3) { if (validEA(mode, reg, 'c')) set(op, opJmp); }
        return;
    }
  }

  decodeArith(op, hi, mode, reg, rx, opmode, validEA, set) {
    switch (hi) {
      case 0x8: // OR / DIVU / DIVS / SBCD
        if (opmode === 3 || opmode === 7) { if (validEA(mode, reg, 'd')) set(op, opmode === 3 ? opDivu : opDivs); }
        else if (opmode === 4 && mode <= 1) set(op, opSbcd);
        else if (opmode < 3) { if (validEA(mode, reg, 'd')) set(op, opOr); }
        else if (validEA(mode, reg, 'ma')) set(op, opOr);
        break;
      case 0xc: // AND / MULU / MULS / ABCD / EXG
        if (opmode === 3 || opmode === 7) { if (validEA(mode, reg, 'd')) set(op, opmode === 3 ? opMulu : opMuls); }
        else if (opmode === 4 && mode <= 1) set(op, opAbcd);
        else if (opmode === 5 && mode <= 1) set(op, opExg);
        else if (opmode === 6 && mode === 1) set(op, opExg);
        else if (opmode < 3) { if (validEA(mode, reg, 'd')) set(op, opAnd); }
        else if (validEA(mode, reg, 'ma')) set(op, opAnd);
        break;
      case 0x9: case 0xd: { // SUB / ADD
        const isAdd = hi === 0xd;
        if (opmode === 3 || opmode === 7) { if (validEA(mode, reg, '')) set(op, isAdd ? opAdda : opSuba); }
        else if (opmode >= 4 && mode <= 1) set(op, isAdd ? opAddx : opSubx);
        else if (opmode < 3) {
          if (validEA(mode, reg, '') && !(opmode === 0 && mode === 1)) set(op, isAdd ? opAdd : opSub);
        } else if (validEA(mode, reg, 'ma')) set(op, isAdd ? opAdd : opSub);
        break;
      }
      case 0xb: // CMP / CMPA / CMPM / EOR
        if (opmode === 3 || opmode === 7) { if (validEA(mode, reg, '')) set(op, opCmpa); }
        else if (opmode < 3) { if (validEA(mode, reg, '') && !(opmode === 0 && mode === 1)) set(op, opCmp); }
        else if (mode === 1) set(op, opCmpm);
        else if (validEA(mode, reg, 'da')) set(op, opEor);
        break;
    }
  }

  decodeShift(op, mode, reg, validEA, set) {
    if (((op >> 6) & 3) === 3) {
      if ((op & 0x800) === 0 && validEA(mode, reg, 'ma')) set(op, opShiftMem);
    } else set(op, opShiftReg);
  }
}

// ---- instruction implementations (called with this = cpu) ------------------
const SIZES = [1, 2, 4, 0];

function opMove(op) {
  const sz = (op >> 12) === 1 ? 1 : (op >> 12) === 3 ? 2 : 4;
  const v = this.readEA((op >> 3) & 7, op & 7, sz);
  this.logic(v, sz);
  this.writeEA((op >> 6) & 7, (op >> 9) & 7, sz, v);
}
function opMoveaW(op) { const v = this.readEA((op >> 3) & 7, op & 7, 2); this.a[(op >> 9) & 7] = sx16(v); }
function opMoveaL(op) { const v = this.readEA((op >> 3) & 7, op & 7, 4); this.a[(op >> 9) & 7] = v; }
function opMoveq(op) { const v = sx8(op & 0xff); this.d[(op >> 9) & 7] = v; this.logic(v >>> 0, 4); }

function opImm(op) {
  const sz = SIZES[(op >> 6) & 3];
  const sub = (op >> 9) & 7;
  const imm = sz === 4 ? this.fetch32() : sz === 2 ? this.fetch16() : this.fetch16() & 0xff;
  const mode = (op >> 3) & 7, reg = op & 7;
  if (sub === 6) { this.cmp(imm, this.readEA(mode, reg, sz), sz); return; }
  this.rmw(mode, reg, sz, (d) => {
    switch (sub) {
      case 0: return this.logic(d | imm, sz);
      case 1: return this.logic(d & imm, sz);
      case 2: { const r = this.sub(imm, d, sz); this.z = r === 0 ? 1 : 0; return r; }
      case 3: { const r = this.add(imm, d, sz); this.z = r === 0 ? 1 : 0; return r; }
      case 5: return this.logic(d ^ imm, sz);
    }
  });
}
function opOriCCR() { this.setCCR(this.getCCR() | (this.fetch16() & 0x1f)); }
function opAndiCCR() { this.setCCR(this.getCCR() & this.fetch16()); }
function opEoriCCR() { this.setCCR(this.getCCR() ^ (this.fetch16() & 0x1f)); }
function opOriSR() { if (!this.privileged()) return; this.setSR(this.getSR() | this.fetch16()); }
function opAndiSR() { if (!this.privileged()) return; this.setSR(this.getSR() & this.fetch16()); }
function opEoriSR() { if (!this.privileged()) return; this.setSR(this.getSR() ^ this.fetch16()); }

function bitOp(cpu, op, bit) {
  const mode = (op >> 3) & 7, reg = op & 7;
  const t = (op >> 6) & 3;
  if (mode === 0) {
    bit &= 31;
    const m = 1 << bit;
    cpu.z = (cpu.d[reg] & m) === 0 ? 1 : 0;
    if (t === 1) cpu.d[reg] ^= m;
    else if (t === 2) cpu.d[reg] &= ~m;
    else if (t === 3) cpu.d[reg] |= m;
    return;
  }
  bit &= 7;
  const m = 1 << bit;
  if (t === 0) {
    const v = cpu.readEA(mode, reg, 1);
    cpu.z = (v & m) === 0 ? 1 : 0;
    return;
  }
  const a = cpu.eaAddr(mode, reg, 1);
  let v = cpu.rb(a);
  cpu.z = (v & m) === 0 ? 1 : 0;
  if (t === 1) v ^= m; else if (t === 2) v &= ~m; else v |= m;
  cpu.wb(a, v);
}
function opBitDyn(op) { bitOp(this, op, this.d[(op >> 9) & 7]); }
function opBitStatic(op) { bitOp(this, op, this.fetch16() & 0xff); }

function opMovep(op) {
  const dr = (op >> 9) & 7, ar = op & 7;
  const addr = (this.a[ar] + sx16(this.fetch16())) >>> 0;
  const om = (op >> 6) & 7;
  if (om === 4) { this.setD(dr, 2, (this.rb(addr) << 8) | this.rb(addr + 2)); }
  else if (om === 5) { this.d[dr] = (this.rb(addr) << 24) | (this.rb(addr + 2) << 16) | (this.rb(addr + 4) << 8) | this.rb(addr + 6); }
  else if (om === 6) { const v = this.d[dr]; this.wb(addr, v >> 8); this.wb(addr + 2, v); }
  else { const v = this.d[dr]; this.wb(addr, v >> 24); this.wb(addr + 2, v >> 16); this.wb(addr + 4, v >> 8); this.wb(addr + 6, v); }
}

function opMoveFromSR(op) { this.rmw((op >> 3) & 7, op & 7, 2, () => this.getSR()); }
function opMoveToCCR(op) { this.setCCR(this.readEA((op >> 3) & 7, op & 7, 2)); }
function opMoveToSR(op) { if (!this.privileged()) return; this.setSR(this.readEA((op >> 3) & 7, op & 7, 2)); }

function opNegx(op) {
  const sz = SIZES[(op >> 6) & 3];
  this.rmw((op >> 3) & 7, op & 7, sz, (d) => {
    const r = this.sub(d, 0, sz, this.x);
    if (r !== 0) this.z = 0;
    return r;
  });
}
function opClr(op) {
  const sz = SIZES[(op >> 6) & 3];
  const mode = (op >> 3) & 7, reg = op & 7;
  if (mode === 0) this.setD(reg, sz, 0);
  else this.write(this.eaAddr(mode, reg, sz), sz, 0);
  this.n = 0; this.z = 1; this.v = 0; this.c = 0;
}
function opNeg(op) {
  const sz = SIZES[(op >> 6) & 3];
  this.rmw((op >> 3) & 7, op & 7, sz, (d) => { const r = this.sub(d, 0, sz); this.z = r === 0 ? 1 : 0; return r; });
}
function opNot(op) {
  const sz = SIZES[(op >> 6) & 3];
  this.rmw((op >> 3) & 7, op & 7, sz, (d) => this.logic(~d, sz));
}
function opNbcd(op) {
  this.rmw((op >> 3) & 7, op & 7, 1, (d) => bcdSub(this, d, 0));
}
function opSwap(op) {
  const r = op & 7; const v = this.d[r] >>> 0;
  const n = ((v >>> 16) | (v << 16)) >>> 0;
  this.d[r] = n; this.logic(n, 4);
}
function opPea(op) { const a = this.eaAddr((op >> 3) & 7, op & 7, 4); this.push32(a); }
function opExt(op) {
  const r = op & 7;
  if (op & 0x40) { this.d[r] = sx16(this.d[r]); this.logic(this.d[r] >>> 0, 4); }
  else { const v = sx8(this.d[r]) & 0xffff; this.setD(r, 2, v); this.logic(v, 2); }
}
function opMovemToMem(op) {
  const mask = this.fetch16();
  const sz = (op & 0x40) ? 4 : 2;
  const mode = (op >> 3) & 7, reg = op & 7;
  if (mode === 4) {
    let a = this.a[reg] >>> 0;
    const init = a;
    for (let i = 0; i < 16; i++) {
      if (!(mask & (1 << i))) continue;
      const r = 15 - i;
      a = (a - sz) >>> 0;
      // 68000 writes the initial value when the address register itself is stored
      const v = r >= 8 ? (r - 8 === reg ? init : this.a[r - 8]) : this.d[r];
      this.write(a, sz, v);
    }
    this.a[reg] = a;
  } else {
    let a = this.eaAddr(mode, reg, sz);
    for (let i = 0; i < 16; i++) {
      if (!(mask & (1 << i))) continue;
      const v = i >= 8 ? this.a[i - 8] : this.d[i];
      this.write(a, sz, v);
      a = (a + sz) >>> 0;
    }
  }
}
function opMovemToReg(op) {
  const mask = this.fetch16();
  const sz = (op & 0x40) ? 4 : 2;
  const mode = (op >> 3) & 7, reg = op & 7;
  let a = mode === 3 ? this.a[reg] >>> 0 : this.eaAddr(mode, reg, sz);
  for (let i = 0; i < 16; i++) {
    if (!(mask & (1 << i))) continue;
    let v = this.read(a, sz);
    if (sz === 2) v = sx16(v);
    if (i >= 8) this.a[i - 8] = v; else this.d[i] = v;
    a = (a + sz) >>> 0;
  }
  if (mode === 3) this.a[reg] = a;
}
function opTst(op) { const sz = SIZES[(op >> 6) & 3]; this.logic(this.readEA((op >> 3) & 7, op & 7, sz), sz); }
function opTas(op) { this.rmw((op >> 3) & 7, op & 7, 1, (d) => { this.logic(d, 1); return d | 0x80; }); }
function opIllegal() { this.illegal(); }
function opTrap(op) { this.exception(32 + (op & 15)); }
function opLink(op) {
  const r = op & 7;
  this.push32(r === 7 ? this.a[7] - 4 : this.a[r]);
  this.a[r] = this.a[7];
  this.a[7] += sx16(this.fetch16());
}
function opUnlk(op) { const r = op & 7; this.a[7] = this.a[r]; this.a[r] = this.pop32(); }
function opMoveUSP(op) {
  if (!this.privileged()) return;
  const r = op & 7;
  if (op & 8) this.a[r] = this.usp; else this.usp = this.a[r];
}
function opReset() { if (!this.privileged()) return; this.cycles += 128; }
function opNop() {}
function opStop() { if (!this.privileged()) return; const v = this.fetch16(); this.setSR(v); this.stopped = true; }
function opRte() {
  if (!this.privileged()) return;
  const sr = this.pop16();
  this.pc = this.pop32();
  this.setSR(sr);
}
function opRts() { this.pc = this.pop32(); }
function opTrapv() { if (this.v) this.exception(7); }
function opRtr() { this.setCCR(this.pop16()); this.pc = this.pop32(); }
function opJsr(op) { const a = this.eaAddr((op >> 3) & 7, op & 7, 4); this.push32(this.pc); this.pc = a; }
function opJmp(op) { this.pc = this.eaAddr((op >> 3) & 7, op & 7, 4); }
function opLea(op) { this.a[(op >> 9) & 7] = this.eaAddr((op >> 3) & 7, op & 7, 4); }
function opChk(op) {
  const bound = sx16(this.readEA((op >> 3) & 7, op & 7, 2));
  const v = sx16(this.d[(op >> 9) & 7]);
  this.z = v === 0 ? 1 : 0; this.v = 0; this.c = 0;
  if (v < 0) { this.n = 1; this.exception(6); }
  else if (v > bound) { this.n = 0; this.exception(6); }
}

function opAddq(op) {
  let q = (op >> 9) & 7; if (q === 0) q = 8;
  const mode = (op >> 3) & 7, reg = op & 7;
  if (mode === 1) { this.a[reg] += q; return; }
  const sz = SIZES[(op >> 6) & 3];
  this.rmw(mode, reg, sz, (d) => { const r = this.add(q, d, sz); this.z = r === 0 ? 1 : 0; return r; });
}
function opSubq(op) {
  let q = (op >> 9) & 7; if (q === 0) q = 8;
  const mode = (op >> 3) & 7, reg = op & 7;
  if (mode === 1) { this.a[reg] -= q; return; }
  const sz = SIZES[(op >> 6) & 3];
  this.rmw(mode, reg, sz, (d) => { const r = this.sub(q, d, sz); this.z = r === 0 ? 1 : 0; return r; });
}
function opScc(op) {
  const v = this.cond((op >> 8) & 15) ? 0xff : 0;
  const mode = (op >> 3) & 7, reg = op & 7;
  if (mode === 0) this.setD(reg, 1, v);
  else this.wb(this.eaAddr(mode, reg, 1), v);
}
function opDBcc(op) {
  const base = this.pc;
  const disp = sx16(this.fetch16());
  if (this.cond((op >> 8) & 15)) return;
  const r = op & 7;
  const v = ((this.d[r] & 0xffff) - 1) & 0xffff;
  this.setD(r, 2, v);
  if (v !== 0xffff) this.pc = (base + disp) >>> 0;
}
function opBcc(op) {
  const cc = (op >> 8) & 15;
  const base = this.pc;
  let disp = sx8(op & 0xff);
  if (disp === 0) disp = sx16(this.fetch16());
  if (cc === 1) { this.push32(this.pc); this.pc = (base + disp) >>> 0; return; }
  if (this.cond(cc)) this.pc = (base + disp) >>> 0;
}

function opOr(op) { arithLogic(this, op, (s, d, sz) => this.logic(s | d, sz)); }
function opAnd(op) { arithLogic(this, op, (s, d, sz) => this.logic(s & d, sz)); }
function opEor(op) {
  const sz = SIZES[(op >> 6) & 3];
  const s = trunc(this.d[(op >> 9) & 7], sz);
  this.rmw((op >> 3) & 7, op & 7, sz, (d) => this.logic(s ^ d, sz));
}
function opAdd(op) { arithLogic(this, op, (s, d, sz) => { const r = this.add(s, d, sz); this.z = r === 0 ? 1 : 0; return r; }); }
function opSub(op) { arithLogic(this, op, (s, d, sz) => { const r = this.sub(s, d, sz); this.z = r === 0 ? 1 : 0; return r; }); }
function arithLogic(cpu, op, fn) {
  const sz = SIZES[(op >> 6) & 3];
  const dn = (op >> 9) & 7;
  const mode = (op >> 3) & 7, reg = op & 7;
  if (op & 0x100) {
    const s = trunc(cpu.d[dn], sz);
    cpu.rmw(mode, reg, sz, (d) => fn(s, d, sz));
  } else {
    const s = cpu.readEA(mode, reg, sz);
    cpu.setD(dn, sz, fn(s, trunc(cpu.d[dn], sz), sz));
  }
}
function opCmp(op) {
  const sz = SIZES[(op >> 6) & 3];
  const s = this.readEA((op >> 3) & 7, op & 7, sz);
  this.cmp(s, trunc(this.d[(op >> 9) & 7], sz), sz);
}
function opCmpa(op) {
  const sz = (op & 0x100) ? 4 : 2;
  let s = this.readEA((op >> 3) & 7, op & 7, sz);
  if (sz === 2) s = sx16(s) >>> 0;
  this.cmp(s, this.a[(op >> 9) & 7] >>> 0, 4);
}
function opCmpm(op) {
  const sz = SIZES[(op >> 6) & 3];
  const s = this.read(this.eaAddr(3, op & 7, sz), sz);
  const d = this.read(this.eaAddr(3, (op >> 9) & 7, sz), sz);
  this.cmp(s, d, sz);
}
function opAdda(op) {
  const sz = (op & 0x100) ? 4 : 2;
  let s = this.readEA((op >> 3) & 7, op & 7, sz);
  if (sz === 2) s = sx16(s);
  this.a[(op >> 9) & 7] += s;
}
function opSuba(op) {
  const sz = (op & 0x100) ? 4 : 2;
  let s = this.readEA((op >> 3) & 7, op & 7, sz);
  if (sz === 2) s = sx16(s);
  this.a[(op >> 9) & 7] -= s;
}
function xOp(cpu, op, fn) {
  const sz = SIZES[(op >> 6) & 3];
  const rx = (op >> 9) & 7, ry = op & 7;
  if (op & 8) {
    const s = cpu.read(cpu.eaAddr(4, ry, sz), sz);
    const a = cpu.eaAddr(4, rx, sz);
    const d = cpu.read(a, sz);
    cpu.write(a, sz, fn(s, d, sz));
  } else {
    cpu.setD(rx, sz, fn(trunc(cpu.d[ry], sz), trunc(cpu.d[rx], sz), sz));
  }
}
function opAddx(op) { xOp(this, op, (s, d, sz) => { const r = this.add(s, d, sz, this.x); if (r !== 0) this.z = 0; return r; }); }
function opSubx(op) { xOp(this, op, (s, d, sz) => { const r = this.sub(s, d, sz, this.x); if (r !== 0) this.z = 0; return r; }); }

// BCD arithmetic including the undocumented V/N behaviour of the real chip.
function bcdAdd(cpu, s, d) {
  const ss = s + d + cpu.x;
  const bc = ((s & d) | (~ss & (s | d))) & 0x88;
  const dc = (((ss + 0x66) ^ ss) & 0x110) >> 1;
  const corf = (bc | dc) - ((bc | dc) >> 2);
  const rr = ss + corf;
  cpu.c = cpu.x = ((bc | (ss & ~rr)) >> 7) & 1;
  cpu.v = ((~ss & rr) >> 7) & 1;
  const r = rr & 0xff;
  if (r) cpu.z = 0;
  cpu.n = (r >> 7) & 1;
  return r;
}
function bcdSub(cpu, s, d) {
  const dd = d - s - cpu.x;
  const bc = ((~d & s) | (dd & ~(d ^ s))) & 0x88;
  const corf = bc - (bc >> 2);
  const rr = dd - corf;
  cpu.c = cpu.x = ((bc | (~dd & rr)) >> 7) & 1;
  cpu.v = ((dd & ~rr) >> 7) & 1;
  const r = rr & 0xff;
  if (r) cpu.z = 0;
  cpu.n = (r >> 7) & 1;
  return r;
}
function opAbcd(op) { xOp(this, (op & ~0xc0), (s, d) => bcdAdd(this, s, d)); }
function opSbcd(op) { xOp(this, (op & ~0xc0), (s, d) => bcdSub(this, s, d)); }

function opExg(op) {
  const rx = (op >> 9) & 7, ry = op & 7;
  const m = (op >> 3) & 0x1f;
  let t;
  if (m === 0x08) { t = this.d[rx]; this.d[rx] = this.d[ry]; this.d[ry] = t; }
  else if (m === 0x09) { t = this.a[rx]; this.a[rx] = this.a[ry]; this.a[ry] = t; }
  else { t = this.d[rx]; this.d[rx] = this.a[ry]; this.a[ry] = t; }
}
function opMulu(op) {
  const s = this.readEA((op >> 3) & 7, op & 7, 2);
  const r = (s * (this.d[(op >> 9) & 7] & 0xffff)) >>> 0;
  this.d[(op >> 9) & 7] = r;
  this.logic(r, 4);
  this.cycles += 54;
}
function opMuls(op) {
  const s = sx16(this.readEA((op >> 3) & 7, op & 7, 2));
  const r = Math.imul(s, sx16(this.d[(op >> 9) & 7]));
  this.d[(op >> 9) & 7] = r;
  this.logic(r >>> 0, 4);
  this.cycles += 54;
}
function opDivu(op) {
  const s = this.readEA((op >> 3) & 7, op & 7, 2);
  const dn = (op >> 9) & 7;
  if (s === 0) { this.c = 0; this.exception(5); return; }
  const d = this.d[dn] >>> 0;
  const q = Math.floor(d / s);
  this.cycles += 120;
  this.c = 0;
  if (q > 0xffff) { this.v = 1; return; }
  const r = d % s;
  this.d[dn] = ((r & 0xffff) << 16) | q;
  this.n = (q & 0x8000) ? 1 : 0; this.z = q === 0 ? 1 : 0; this.v = 0;
}
function opDivs(op) {
  const s = sx16(this.readEA((op >> 3) & 7, op & 7, 2));
  const dn = (op >> 9) & 7;
  if (s === 0) { this.c = 0; this.exception(5); return; }
  const d = this.d[dn];
  const q = Math.trunc(d / s);
  this.cycles += 140;
  this.c = 0;
  if (q > 32767 || q < -32768) { this.v = 1; return; }
  const r = d - q * s;
  this.d[dn] = ((r & 0xffff) << 16) | (q & 0xffff);
  this.n = (q & 0x8000) ? 1 : 0; this.z = q === 0 ? 1 : 0; this.v = 0;
}

function shift(cpu, type, left, v, cnt, sz) {
  const m = MASK[sz], msb = MSB[sz], bits = sz * 8;
  v = trunc(v, sz);
  cpu.cycles += cnt * 2;
  if (cnt === 0) {
    cpu.c = type === 2 ? cpu.x : 0;
    cpu.v = 0;
    cpu.n = neg(v, sz) ? 1 : 0; cpu.z = v === 0 ? 1 : 0;
    return v;
  }
  let c = 0, ov = 0;
  switch (type) {
    case 0: // AS
      if (left) {
        for (let i = 0; i < cnt; i++) {
          c = neg(v, sz) ? 1 : 0;
          const nv = trunc(v * 2, sz);
          if (neg(nv, sz) !== neg(v, sz)) ov = 1;
          v = nv;
        }
      } else {
        const sgn = neg(v, sz);
        for (let i = 0; i < cnt; i++) {
          c = v & 1;
          v = trunc(Math.floor(v / 2) + (sgn ? msb : 0), sz);
        }
      }
      cpu.x = c;
      break;
    case 1: // LS
      if (left) {
        for (let i = 0; i < cnt; i++) { c = neg(v, sz) ? 1 : 0; v = trunc(v * 2, sz); }
      } else {
        for (let i = 0; i < cnt; i++) { c = v & 1; v = Math.floor(v / 2); }
      }
      cpu.x = c;
      break;
    case 2: // ROX
      c = cpu.x;
      for (let i = 0; i < cnt; i++) {
        if (left) { const o = neg(v, sz) ? 1 : 0; v = trunc(v * 2 + c, sz); c = o; }
        else { const o = v & 1; v = Math.floor(v / 2) + (c ? msb : 0); v = trunc(v, sz); c = o; }
      }
      cpu.x = c;
      break;
    case 3: // RO
      cnt %= bits;
      if (left) {
        if (cnt) v = trunc(sz === 4 ? ((v << cnt) | (v >>> (bits - cnt))) : ((v << cnt) | (v >>> (bits - cnt))), sz);
        c = v & 1;
      } else {
        if (cnt) v = trunc(sz === 4 ? ((v >>> cnt) | (v << (bits - cnt))) : ((v >>> cnt) | (v << (bits - cnt))), sz);
        c = neg(v, sz) ? 1 : 0;
      }
      break;
  }
  cpu.c = c;
  cpu.v = ov;
  cpu.n = neg(v, sz) ? 1 : 0;
  cpu.z = v === 0 ? 1 : 0;
  return v;
}
function opShiftReg(op) {
  const sz = SIZES[(op >> 6) & 3];
  const r = op & 7;
  let cnt = (op >> 9) & 7;
  if (op & 0x20) cnt = this.d[cnt] & 63;
  else if (cnt === 0) cnt = 8;
  const type = (op >> 3) & 3;
  const res = shift(this, type, (op & 0x100) !== 0, this.d[r], cnt, sz);
  this.setD(r, sz, res);
}
function opShiftMem(op) {
  const type = (op >> 9) & 3;
  this.rmw((op >> 3) & 7, op & 7, 2, (d) => shift(this, type, (op & 0x100) !== 0, d, 1, 2));
}

function opLineA() { this.pc = this.opPC; this.exception(10); }
function opLineF() { this.pc = this.opPC; this.exception(11); }

export { sx8, sx16, u32, shift };
