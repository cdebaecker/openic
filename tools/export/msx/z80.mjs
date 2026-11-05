// Compact Z80 interpreter for the MSX version's sound driver (tools/export/msx.mjs): documented
// instructions plus the undocumented IXH/IXL/IYH/IYL forms and SLL the driver uses.
// mem: Uint8Array(65536); io: {in(port), out(port, v)}. Flags computed with tables.
const SZ = new Uint8Array(256), SZP = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  SZ[i] = (i & 0x80) | (i === 0 ? 0x40 : 0) | (i & 0x28);
  let p = i; p ^= p >> 4; p ^= p >> 2; p ^= p >> 1;
  SZP[i] = SZ[i] | ((p & 1) ? 0 : 4);
}
const FC = 1, FN = 2, FPV = 4, FH = 16, FZ = 64, FS = 128;

export class Z80 {
  constructor(mem, io) {
    this.m = mem; this.io = io;
    this.a = this.f = this.b = this.c = this.d = this.e = this.h = this.l = 0;
    this.a_ = this.f_ = this.b_ = this.c_ = this.d_ = this.e_ = this.h_ = this.l_ = 0;
    this.ix = this.iy = 0; this.sp = 0xf000; this.pc = 0; this.i = 0; this.r = 0;
    this.iff1 = this.iff2 = 0; this.im = 1; this.halted = false; this.cycles = 0;
  }
  rb(a) { return this.m[a & 0xffff]; }
  wb(a, v) { this.m[a & 0xffff] = v & 0xff; }
  rw(a) { return this.rb(a) | (this.rb(a + 1) << 8); }
  ww(a, v) { this.wb(a, v); this.wb(a + 1, v >> 8); }
  fetch() { const v = this.m[this.pc]; this.pc = (this.pc + 1) & 0xffff; return v; }
  fetchw() { const l = this.fetch(); return l | (this.fetch() << 8); }
  push(v) { this.sp = (this.sp - 2) & 0xffff; this.ww(this.sp, v); }
  pop() { const v = this.rw(this.sp); this.sp = (this.sp + 2) & 0xffff; return v; }
  get bc() { return (this.b << 8) | this.c; } set bc(v) { this.b = (v >> 8) & 255; this.c = v & 255; }
  get de() { return (this.d << 8) | this.e; } set de(v) { this.d = (v >> 8) & 255; this.e = v & 255; }
  get hl() { return (this.h << 8) | this.l; } set hl(v) { this.h = (v >> 8) & 255; this.l = v & 255; }
  get af() { return (this.a << 8) | this.f; } set af(v) { this.a = (v >> 8) & 255; this.f = v & 255; }

  // 8-bit register access by index, with prefix substitution (xy: 0 none, 1 ix, 2 iy)
  getr(i, xy) {
    switch (i) {
      case 0: return this.b; case 1: return this.c; case 2: return this.d; case 3: return this.e;
      case 4: return xy === 1 ? this.ix >> 8 : xy === 2 ? this.iy >> 8 : this.h;
      case 5: return xy === 1 ? this.ix & 255 : xy === 2 ? this.iy & 255 : this.l;
      case 6: return this.rb(this.addr);
      default: return this.a;
    }
  }
  setr(i, v, xy) {
    v &= 255;
    switch (i) {
      case 0: this.b = v; break; case 1: this.c = v; break; case 2: this.d = v; break; case 3: this.e = v; break;
      case 4: if (xy === 1) this.ix = (this.ix & 255) | (v << 8); else if (xy === 2) this.iy = (this.iy & 255) | (v << 8); else this.h = v; break;
      case 5: if (xy === 1) this.ix = (this.ix & 0xff00) | v; else if (xy === 2) this.iy = (this.iy & 0xff00) | v; else this.l = v; break;
      case 6: this.wb(this.addr, v); break;
      default: this.a = v;
    }
  }
  getrp(p, xy) { return p === 0 ? this.bc : p === 1 ? this.de : p === 2 ? (xy === 1 ? this.ix : xy === 2 ? this.iy : this.hl) : this.sp; }
  setrp(p, v, xy) {
    v &= 0xffff;
    if (p === 0) this.bc = v; else if (p === 1) this.de = v;
    else if (p === 2) { if (xy === 1) this.ix = v; else if (xy === 2) this.iy = v; else this.hl = v; }
    else this.sp = v;
  }
  cond(y) {
    const f = this.f;
    switch (y) {
      case 0: return !(f & FZ); case 1: return !!(f & FZ); case 2: return !(f & FC); case 3: return !!(f & FC);
      case 4: return !(f & FPV); case 5: return !!(f & FPV); case 6: return !(f & FS); default: return !!(f & FS);
    }
  }
  alu(y, v) {
    const a = this.a; let r;
    switch (y) {
      case 0: case 1: { const c = y === 1 ? this.f & 1 : 0; r = a + v + c;
        this.f = SZ[r & 255] | ((r >> 8) & 1) | ((a ^ v ^ r) & FH) | ((((a ^ ~v) & (a ^ r)) & 0x80) ? FPV : 0); this.a = r & 255; break; }
      case 2: case 3: case 7: { const c = y === 3 ? this.f & 1 : 0; r = a - v - c;
        this.f = SZ[r & 255] | ((r >> 8) & 1) | FN | ((a ^ v ^ r) & FH) | ((((a ^ v) & (a ^ r)) & 0x80) ? FPV : 0);
        if (y === 7) this.f = (this.f & ~0x28) | (v & 0x28); else this.a = r & 255; break; }
      case 4: this.a = a & v; this.f = SZP[this.a] | FH; break;
      case 5: this.a = a ^ v; this.f = SZP[this.a]; break;
      case 6: this.a = a | v; this.f = SZP[this.a]; break;
    }
  }
  inc8(v) { const r = (v + 1) & 255; this.f = (this.f & FC) | SZ[r] | ((v & 15) === 15 ? FH : 0) | (v === 0x7f ? FPV : 0); return r; }
  dec8(v) { const r = (v - 1) & 255; this.f = (this.f & FC) | SZ[r] | FN | ((v & 15) === 0 ? FH : 0) | (v === 0x80 ? FPV : 0); return r; }
  rot(y, v) {
    let r, c;
    switch (y) {
      case 0: c = v >> 7; r = ((v << 1) | c) & 255; break;
      case 1: c = v & 1; r = (v >> 1) | (c << 7); break;
      case 2: c = v >> 7; r = ((v << 1) | (this.f & 1)) & 255; break;
      case 3: c = v & 1; r = (v >> 1) | ((this.f & 1) << 7); break;
      case 4: c = v >> 7; r = (v << 1) & 255; break;
      case 5: c = v & 1; r = (v >> 1) | (v & 0x80); break;
      case 6: c = v >> 7; r = ((v << 1) | 1) & 255; break;
      default: c = v & 1; r = v >> 1;
    }
    this.f = SZP[r] | c; return r;
  }
  add16(a, b) { const r = a + b; this.f = (this.f & (FS | FZ | FPV)) | ((r >> 16) & 1) | (((a ^ b ^ r) >> 8) & FH) | ((r >> 8) & 0x28); return r & 0xffff; }
  adc16(a, b) { const c = this.f & 1; const r = a + b + c;
    this.f = ((r >> 16) & 1) | (((a ^ b ^ r) >> 8) & FH) | ((r & 0xffff) ? 0 : FZ) | ((r >> 8) & 0x80) | ((((a ^ ~b) & (a ^ r)) & 0x8000) ? FPV : 0); return r & 0xffff; }
  sbc16(a, b) { const c = this.f & 1; const r = a - b - c;
    this.f = ((r >> 16) & 1) | FN | (((a ^ b ^ r) >> 8) & FH) | ((r & 0xffff) ? 0 : FZ) | ((r >> 8) & 0x80) | ((((a ^ b) & (a ^ r)) & 0x8000) ? FPV : 0); return r & 0xffff; }

  interrupt() {
    if (!this.iff1) return false;
    this.halted = false; this.iff1 = this.iff2 = 0;
    this.push(this.pc); this.pc = 0x38; this.cycles += 13; return true;
  }

  step() {
    if (this.halted) { this.cycles += 4; return; }
    let op = this.fetch(); let xy = 0; this.r = (this.r + 1) & 127;
    while (op === 0xdd || op === 0xfd) { xy = op === 0xdd ? 1 : 2; op = this.fetch(); }
    this.cycles += 4;
    if (op === 0xcb) return this.cb(xy);
    if (op === 0xed) return this.ed();
    const x = op >> 6, y = (op >> 3) & 7, z = op & 7, p = y >> 1, q = y & 1;
    // (hl) / (ix+d) address for operands using index 6
    const ea = () => { if (xy) { let d = this.fetch(); if (d > 127) d -= 256; this.addr = ((xy === 1 ? this.ix : this.iy) + d) & 0xffff; } else this.addr = this.hl; };
    switch (x) {
      case 0:
        switch (z) {
          case 0:
            if (y === 0) return;
            if (y === 1) { let t = this.a; this.a = this.a_; this.a_ = t; t = this.f; this.f = this.f_; this.f_ = t; return; }
            { let d = this.fetch(); if (d > 127) d -= 256;
              if (y === 2) { this.b = (this.b - 1) & 255; if (this.b) this.pc = (this.pc + d) & 0xffff; return; }
              if (y === 3 || this.cond(y - 4)) this.pc = (this.pc + d) & 0xffff; return; }
          case 1: if (q) this.setrp(2, this.add16(this.getrp(2, xy), this.getrp(p, xy)), xy); else this.setrp(p, this.fetchw(), xy); return;
          case 2:
            switch (y) {
              case 0: this.wb(this.bc, this.a); return; case 1: this.a = this.rb(this.bc); return;
              case 2: this.wb(this.de, this.a); return; case 3: this.a = this.rb(this.de); return;
              case 4: this.ww(this.fetchw(), this.getrp(2, xy)); return;
              case 5: this.setrp(2, this.rw(this.fetchw()), xy); return;
              case 6: this.wb(this.fetchw(), this.a); return;
              default: this.a = this.rb(this.fetchw()); return;
            }
          case 3: this.setrp(p, this.getrp(p, xy) + (q ? -1 : 1), xy); return;
          case 4: if (y === 6) ea(); this.setr(y, this.inc8(this.getr(y, xy)), xy); return;
          case 5: if (y === 6) ea(); this.setr(y, this.dec8(this.getr(y, xy)), xy); return;
          case 6: if (y === 6) ea(); this.setr(y, this.fetch(), xy); return;
          default:
            switch (y) {
              case 0: { const c = this.a >> 7; this.a = ((this.a << 1) | c) & 255; this.f = (this.f & (FS | FZ | FPV)) | c | (this.a & 0x28); return; }
              case 1: { const c = this.a & 1; this.a = (this.a >> 1) | (c << 7); this.f = (this.f & (FS | FZ | FPV)) | c | (this.a & 0x28); return; }
              case 2: { const c = this.a >> 7; this.a = ((this.a << 1) | (this.f & 1)) & 255; this.f = (this.f & (FS | FZ | FPV)) | c | (this.a & 0x28); return; }
              case 3: { const c = this.a & 1; this.a = (this.a >> 1) | ((this.f & 1) << 7); this.f = (this.f & (FS | FZ | FPV)) | c | (this.a & 0x28); return; }
              case 4: { let a = this.a, corr = 0, c = this.f & FC;
                if ((this.f & FH) || (a & 15) > 9) corr = 6;
                if (c || a > 0x99) { corr |= 0x60; c = FC; }
                const n = this.f & FN; const r = n ? (a - corr) & 255 : (a + corr) & 255;
                const h = n ? ((this.f & FH) && (a & 15) < 6 ? FH : 0) : ((a & 15) > 9 ? FH : 0);
                this.a = r; this.f = SZP[r] | c | n | h; return; }
              case 5: this.a ^= 255; this.f = (this.f & (FS | FZ | FPV | FC)) | FH | FN | (this.a & 0x28); return;
              case 6: this.f = (this.f & (FS | FZ | FPV)) | FC | (this.a & 0x28); return;
              default: this.f = ((this.f & (FS | FZ | FPV | FC)) | ((this.f & FC) ? FH : 0) | (this.a & 0x28)) ^ FC; return;
            }
        }
      case 1:
        if (op === 0x76) { this.halted = true; return; }
        if (y === 6 || z === 6) { ea(); if (y === 6) this.wb(this.addr, this.getr(z, 0)); else this.setr(y, this.rb(this.addr), 0); return; }
        this.setr(y, this.getr(z, xy), xy); return;
      case 2: if (z === 6) ea(); this.alu(y, this.getr(z, xy)); return;
      default:
        switch (z) {
          case 0: if (this.cond(y)) this.pc = this.pop(); return;
          case 1:
            if (!q) { const v = this.pop(); if (p === 3) this.af = v; else this.setrp(p, v, xy); return; }
            switch (p) {
              case 0: this.pc = this.pop(); return;
              case 1: { let t; t = this.b; this.b = this.b_; this.b_ = t; t = this.c; this.c = this.c_; this.c_ = t;
                t = this.d; this.d = this.d_; this.d_ = t; t = this.e; this.e = this.e_; this.e_ = t;
                t = this.h; this.h = this.h_; this.h_ = t; t = this.l; this.l = this.l_; this.l_ = t; return; }
              case 2: this.pc = this.getrp(2, xy); return;
              default: this.sp = this.getrp(2, xy); return;
            }
          case 2: { const a = this.fetchw(); if (this.cond(y)) this.pc = a; return; }
          case 3:
            switch (y) {
              case 0: this.pc = this.fetchw(); return;
              case 2: this.io.out(this.fetch(), this.a, this); return;
              case 3: this.a = this.io.in(this.fetch() | (this.a << 8), this) & 255; return;
              case 4: { const v = this.rw(this.sp); this.ww(this.sp, this.getrp(2, xy)); this.setrp(2, v, xy); return; }
              case 5: { const t = this.de; this.de = this.hl; this.hl = t; return; }
              case 6: this.iff1 = this.iff2 = 0; return;
              default: this.iff1 = this.iff2 = 1; return;
            }
          case 4: { const a = this.fetchw(); if (this.cond(y)) { this.push(this.pc); this.pc = a; } return; }
          case 5:
            if (!q) { this.push(p === 3 ? this.af : this.getrp(p, xy)); return; }
            if (p === 0) { const a = this.fetchw(); this.push(this.pc); this.pc = a; return; }
            throw new Error('bad prefix at ' + this.pc.toString(16));
          case 6: this.alu(y, this.fetch()); return;
          default: this.push(this.pc); this.pc = y * 8; return;
        }
    }
  }
  cb(xy) {
    let a, op;
    if (xy) { let d = this.fetch(); if (d > 127) d -= 256; a = ((xy === 1 ? this.ix : this.iy) + d) & 0xffff; op = this.fetch(); }
    else { op = this.fetch(); a = this.hl; }
    const x = op >> 6, y = (op >> 3) & 7, z = op & 7;
    this.addr = a;
    const v = xy ? this.rb(a) : this.getr(z, 0);
    let r;
    if (x === 0) r = this.rot(y, v);
    else if (x === 1) { this.f = (this.f & FC) | FH | ((v & (1 << y)) ? (y === 7 ? FS : 0) : (FZ | FPV)); return; }
    else if (x === 2) r = v & ~(1 << y);
    else r = v | (1 << y);
    if (xy) { this.wb(a, r); if (z !== 6) this.setr(z, r, 0); } else this.setr(z, r, 0);
  }
  ed() {
    const op = this.fetch(); const x = op >> 6, y = (op >> 3) & 7, z = op & 7, p = y >> 1, q = y & 1;
    if (x === 1) {
      switch (z) {
        case 0: { const v = this.io.in(this.bc, this) & 255; if (y !== 6) this.setr(y, v, 0); this.f = (this.f & FC) | SZP[v]; return; }
        case 1: this.io.out(this.c, y === 6 ? 0 : this.getr(y, 0), this); return;
        case 2: this.hl = q ? this.adc16(this.hl, this.getrp(p, 0)) : this.sbc16(this.hl, this.getrp(p, 0)); return;
        case 3: { const a = this.fetchw(); if (q) this.setrp(p, this.rw(a), 0); else this.ww(a, this.getrp(p, 0)); return; }
        case 4: { const v = this.a; this.a = 0; this.alu(2, v); return; }
        case 5: this.pc = this.pop(); this.iff1 = this.iff2; return;
        case 6: this.im = [0, 0, 1, 2, 0, 0, 1, 2][y]; return;
        default:
          switch (y) {
            case 0: this.i = this.a; return; case 1: this.r = this.a; return;
            case 2: this.a = this.i; this.f = (this.f & FC) | SZ[this.a] | (this.iff2 ? FPV : 0); return;
            case 3: this.a = this.r; this.f = (this.f & FC) | SZ[this.a] | (this.iff2 ? FPV : 0); return;
            case 4: { const m = this.rb(this.hl); this.wb(this.hl, (this.a << 4) | (m >> 4)); this.a = (this.a & 0xf0) | (m & 15); this.f = (this.f & FC) | SZP[this.a]; return; }
            case 5: { const m = this.rb(this.hl); this.wb(this.hl, (m << 4) | (this.a & 15)); this.a = (this.a & 0xf0) | (m >> 4); this.f = (this.f & FC) | SZP[this.a]; return; }
            default: return;
          }
      }
    }
    if (x === 2 && y >= 4 && z <= 3) {
      const inc = (y & 1) ? -1 : 1, rep = y >= 6;
      do {
        if (z === 0) { this.wb(this.de, this.rb(this.hl)); this.de = this.de + inc; this.hl = this.hl + inc; this.bc = this.bc - 1;
          this.f = (this.f & (FS | FZ | FC)) | (this.bc ? FPV : 0); }
        else if (z === 1) { const v = this.rb(this.hl); const r = (this.a - v) & 255; this.hl = this.hl + inc; this.bc = this.bc - 1;
          this.f = (this.f & FC) | FN | SZ[r] | ((this.a ^ v ^ r) & FH) | (this.bc ? FPV : 0); if (rep && r === 0) break; }
        else if (z === 2) { this.wb(this.hl, this.io.in(this.bc, this)); this.hl = this.hl + inc; this.b = (this.b - 1) & 255; this.f = FN | (this.b ? 0 : FZ); }
        else { const v = this.rb(this.hl); this.b = (this.b - 1) & 255; this.io.out(this.c, v, this); this.hl = this.hl + inc; this.f = FN | (this.b ? 0 : FZ); }
        this.cycles += 21;
      } while (rep && (z < 2 ? this.bc : this.b));
      return;
    }
    // R800 MULUB/MULUW and others: treat as nop
  }
}
