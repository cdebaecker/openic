// High-level emulation of the X68000 IOCS (ROM BIOS, trap #15).

import { HLE_IOCS_BASE } from './human68k.js';

// CRTC register sets for CRTMOD 0-19: R0-R8, R20 low byte
const CRT_31K_512 = [0x5b, 0x09, 0x11, 0x51, 0x237, 0x05, 0x28, 0x228, 0x1b, 0x15];
const CRT_15K_512 = [0x4b, 0x03, 0x05, 0x45, 0x103, 0x02, 0x10, 0x100, 0x2c, 0x05];
const CRT_31K_256 = [0x2d, 0x04, 0x06, 0x26, 0x237, 0x05, 0x28, 0x228, 0x11, 0x10];
const CRT_15K_256 = [0x25, 0x01, 0x00, 0x20, 0x103, 0x02, 0x10, 0x100, 0x24, 0x00];
const CRT_768 = [0x89, 0x0e, 0x1c, 0x7c, 0x237, 0x05, 0x28, 0x228, 0x1b, 0x16];
const CRT_TABLE = [CRT_31K_512, CRT_15K_512, CRT_31K_256, CRT_15K_256];
// sprite controller: htotal, hdisp, vdisp, res
const SP_31K_512 = [0xff, 0x15, 0x28, 0x15];
const SP_15K_512 = [0xff, 0x09, 0x10, 0x05];
const SP_31K_256 = [0x25, 0x04, 0x28, 0x10];
const SP_15K_256 = [0x25, 0x04, 0x10, 0x00];
const SP_TABLE = [SP_31K_512, SP_15K_512, SP_31K_256, SP_15K_256];

const DEFAULT_TPAL = [0x0000, 0xf83e, 0xffc0, 0xfffe, 0xde6c, 0x4022, 0x0700, 0x003e,
  0x07c0, 0x07fe, 0xf800, 0xf83e, 0xffc0, 0xfffe, 0x0000, 0xfffe];

// X68000 scan code -> [normal, shifted] ASCII
const KEYMAP = {
  0x01: [0x1b, 0x1b], 0x02: [0x31, 0x21], 0x03: [0x32, 0x22], 0x04: [0x33, 0x23], 0x05: [0x34, 0x24],
  0x06: [0x35, 0x25], 0x07: [0x36, 0x26], 0x08: [0x37, 0x27], 0x09: [0x38, 0x28], 0x0a: [0x39, 0x29],
  0x0b: [0x30, 0x30], 0x0c: [0x2d, 0x3d], 0x0d: [0x5e, 0x7e], 0x0e: [0x5c, 0x7c], 0x0f: [0x08, 0x08],
  0x10: [0x09, 0x09], 0x1b: [0x40, 0x60], 0x1c: [0x5b, 0x7b], 0x1d: [0x0d, 0x0d], 0x27: [0x3b, 0x2b],
  0x28: [0x3a, 0x2a], 0x29: [0x5d, 0x7d], 0x31: [0x2c, 0x3c], 0x32: [0x2e, 0x3e], 0x33: [0x2f, 0x3f],
  0x34: [0x5f, 0x5f], 0x35: [0x20, 0x20], 0x4e: [0x0d, 0x0d], 0x3c: [0x05, 0x05], 0x3e: [0x18, 0x18],
  0x3b: [0x13, 0x13], 0x3d: [0x04, 0x04],
};
const LETTERS = 'QWERTYUIOP';
for (let i = 0; i < 10; i++) KEYMAP[0x11 + i] = [LETTERS.charCodeAt(i) + 32, LETTERS.charCodeAt(i)];
const L2 = 'ASDFGHJKL';
for (let i = 0; i < 9; i++) KEYMAP[0x1e + i] = [L2.charCodeAt(i) + 32, L2.charCodeAt(i)];
const L3 = 'ZXCVBNM';
for (let i = 0; i < 7; i++) KEYMAP[0x2a + i] = [L3.charCodeAt(i) + 32, L3.charCodeAt(i)];
const KP = { 0x43: 0x37, 0x44: 0x38, 0x45: 0x39, 0x47: 0x34, 0x48: 0x35, 0x49: 0x36, 0x4b: 0x31, 0x4c: 0x32, 0x4d: 0x33, 0x4f: 0x30, 0x40: 0x2f, 0x41: 0x2a, 0x42: 0x2d, 0x46: 0x2b, 0x4a: 0x3d, 0x50: 0x2c, 0x51: 0x2e };
for (const [k, v] of Object.entries(KP)) KEYMAP[k] = [v, v];

const HLE_VEC_KEY = HLE_IOCS_BASE + 0x400;

export class IOCS {
  constructor(sys) {
    this.sys = sys;
    this.m = sys.m;
    this.cpu = sys.cpu;
    this.log = sys.log;
    this.keyBuf = [];
    this.matrix = new Uint8Array(16);
    this.mouse = { x: 256, y: 256, dx: 0, dy: 0, left: false, right: false, cursor: false,
      minX: 0, minY: 0, maxX: 767, maxY: 511 };
    this.tgusemd = [0, 0];
    this.apage = 0;
    this.contrast = 15;
    this.cursorOn = false;
    this.con = { x: 0, y: 0, color: 3, cols: 96, rows: 31 };
    this.waitingForInput = false;
    this.calls = new Map();
    this.unknown = new Set();
  }

  hle() { return false; }

  // ---- input from the host -----------------------------------------------------
  keyEvent(code, down) {
    const g = code >> 3, b = 1 << (code & 7);
    if (down) this.matrix[g] |= b; else this.matrix[g] &= ~b;
    this.m.w8(0x800 + g, this.matrix[g]);
    // shift status byte at $811
    this.m.w8(0x811, this.shiftState() & 0xff);
    if (down) {
      const map = KEYMAP[code];
      const shift = (this.matrix[0x70 >> 3] & 1) !== 0;
      let ascii = map ? map[shift ? 1 : 0] : 0;
      if (this.matrix[0x71 >> 3] & 2) { if (ascii >= 0x40 && ascii < 0x80) ascii &= 0x1f; }
      if (this.keyBuf.length < 64) this.keyBuf.push((code << 8) | ascii);
      this.waitingForInput = false;
    }
  }

  shiftState() {
    const mtx = this.matrix;
    let s = 0;
    if (mtx[14] & 1) s |= 1;      // SHIFT 0x70
    if (mtx[14] & 2) s |= 2;      // CTRL 0x71
    if (mtx[14] & 4) s |= 4;      // OPT1
    if (mtx[14] & 8) s |= 8;      // OPT2
    return s;
  }

  keyAvailable() { return this.keyBuf.length > 0; }
  popKey() { return this.keyBuf.length ? this.keyBuf.shift() : -1; }
  peekKey() { return this.keyBuf.length ? this.keyBuf[0] : -1; }
  flushKeys() { this.keyBuf.length = 0; }

  // Host coordinates are screen pixels; the IOCS cursor lives in text VRAM
  // space, so add the text layer scroll.
  mouseMove(sx, sy) {
    const c = this.sys.video.crtc;
    const x = (sx + (c[10] & 1023)) & 1023, y = (sy + (c[11] & 1023)) & 1023;
    const ms = this.mouse;
    const nx = Math.max(ms.minX, Math.min(ms.maxX, Math.round(x)));
    const ny = Math.max(ms.minY, Math.min(ms.maxY, Math.round(y)));
    ms.dx += nx - ms.x; ms.dy += ny - ms.y;
    ms.x = nx; ms.y = ny;
  }
  mouseButton(btn, down) {
    if (btn === 0) this.mouse.left = down; else if (btn === 2) this.mouse.right = down;
  }

  // ---- dispatcher -------------------------------------------------------------------
  call(n) {
    const cpu = this.cpu, m = this.m;
    this.calls.set(n, (this.calls.get(n) || 0) + 1);
    const d1 = cpu.d[1], d2 = cpu.d[2];
    const ret = (v) => { cpu.d[0] = v; };
    switch (n) {
      case 0x00: { // B_KEYINP: wait for key
        const k = this.popKey();
        if (k < 0) {
          // Block: re-run the call later. We are called from the trap handler; rewind.
          this.blockRetry();
          return;
        }
        return ret(k);
      }
      case 0x01: { const k = this.peekKey(); return ret(k < 0 ? 0 : k); }
      case 0x02: return ret(this.shiftState());
      case 0x03: this.flushKeys(); return ret(0);
      case 0x04: return ret(this.matrix[d1 & 15]);
      case 0x0c: return ret(0);
      case 0x0d: return ret(0);
      case 0x0e: { // TGUSEMD
        const which = d1 & 1;
        const old = this.tgusemd[which];
        if ((d2 & 0xff) !== 0xff && d2 >= 0) this.tgusemd[which] = d2 & 3;
        return ret(old);
      }
      case 0x0f: return ret(0); // DEFCHR
      case 0x10: return ret(this.crtmod(d1));
      case 0x11: { // CONTRAST
        const old = this.contrast;
        if ((d1 & 0xff) !== 0xff && d1 >= 0) this.setContrast(d1 & 15);
        else if (d1 === -2) this.setContrast(15);
        return ret(old);
      }
      case 0x13: { // TPALET
        const v = this.sys.video;
        const idx = d1 & 0xff;
        if (idx > 15) return ret(-1);
        const old = v.spal[idx];
        if (d2 === -1) return ret(old);
        if (d2 === -2) this.setPal(0xe82200, idx, DEFAULT_TPAL[idx]);
        else this.setPal(0xe82200, idx, d2 & 0xffff);
        return ret(old);
      }
      case 0x14: return this.call(0x13);
      case 0x16: return ret(this.fntadr(d1));
      case 0x19: return ret(this.fntget(d1, cpu.a[1] >>> 0));
      case 0x1e: this.cursorOn = true; return ret(0);
      case 0x1f: this.cursorOn = false; return ret(0);
      case 0x20: this.putc(d1 & 0xffff); return ret(this.con.x | (this.con.y << 16));
      case 0x21: { const s = m.readCString(cpu.a[1] >>> 0, 4096); this.print(s); cpu.a[1] += s.length + 1; return ret(this.con.x | (this.con.y << 16)); }
      case 0x22: { const old = this.con.color; if (d1 >= 0 && d1 !== 0xffff) this.con.color = d1 & 15; return ret(old); }
      case 0x23: { const old = this.con.x | (this.con.y << 16); if (d1 !== -1) this.locate(d1 & 0xffff, d2 & 0xffff); return ret(old); }
      case 0x2a: this.clearScreen(d1 & 3); return ret(0);
      case 0x2b: this.clearLine(d1 & 3); return ret(0);
      case 0x2f: { // B_PUTMES: string a1 with attribute d1 at (d2, d3), at most d4+1 characters; cursor unchanged
        const s = m.readCString(cpu.a[1] >>> 0, (cpu.d[4] & 0xffff) + 1);
        const { x, y, color } = this.con;
        this.con.color = d1 & 15;
        this.locate(d2 & 0xffff, cpu.d[3] & 0xffff);
        this.print(s);
        Object.assign(this.con, { x, y, color });
        return ret(0);
      }
      case 0x3b: return ret(this.sys.joystick(d1 & 1));
      case 0x44: return ret(0x02);             // B_DRVSNS
      case 0x45: return ret(this.bwrite(d1, d2, cpu.d[3], cpu.a[1] >>> 0));
      case 0x46: return ret(this.bread(d1, d2, cpu.d[3], cpu.a[1] >>> 0));
      case 0x47: return ret(0);
      case 0x4d: return ret(-1);
      case 0x4e: return ret(this.drvchk(d1, d2));
      case 0x4f: return ret(0);
      case 0x50: case 0x52: case 0x54: case 0x55: case 0x56: case 0x57:
        return ret(this.dateTime(n, d1));
      case 0x60: this.sys.adpcmOut(cpu.a[1] >>> 0, d1, d2 >>> 0); return ret(0);
      case 0x61: return ret(0);
      case 0x62: this.sys.adpcmArrayOut(cpu.a[1] >>> 0, d1, d2 >>> 0); return ret(0);
      case 0x64: this.sys.adpcmLinkOut(cpu.a[1] >>> 0, d1); return ret(0);
      case 0x66: return ret(this.sys.adpcmBusy() ? 2 : 0);
      case 0x67: this.sys.adpcmMod(d1 & 0xff); return ret(0);
      case 0x68: this.sys.opm.write(d1 & 0xff, d2 & 0xff); return ret(0);
      case 0x69: return ret(this.sys.opm.regs ? this.sys.opm.regs[0x1b] : 0);
      case 0x6a: return ret(this.opmintst(cpu.a[1] >>> 0));
      case 0x6b: return ret(this.timerdst(cpu.a[1] >>> 0, d1));
      case 0x6c: return ret(this.vdispst(cpu.a[1] >>> 0, d1));
      case 0x6d: return ret(this.crtcras(cpu.a[1] >>> 0, d1));
      case 0x6e: return ret(this.hsyncst(cpu.a[1] >>> 0));
      case 0x70: this.msInit(); return ret(0);
      case 0x71: this.mouse.cursor = true; return ret(0);
      case 0x72: this.mouse.cursor = false; return ret(0);
      case 0x73: return ret(this.mouse.cursor ? -1 : 0);
      case 0x74: { // MS_GETDT
        const ms = this.mouse;
        const cl = (v) => Math.max(-128, Math.min(127, v)) & 0xff;
        const v = (cl(ms.dx) << 24) | (cl(ms.dy) << 16) | ((ms.left ? 0xff : 0) << 8) | (ms.right ? 0xff : 0);
        ms.dx = 0; ms.dy = 0;
        return ret(v);
      }
      case 0x75: return ret((this.mouse.x << 16) | (this.mouse.y & 0xffff));
      case 0x76: {
        const ms = this.mouse;
        ms.x = Math.max(ms.minX, Math.min(ms.maxX, (d1 >> 16) & 0xffff));
        ms.y = Math.max(ms.minY, Math.min(ms.maxY, d1 & 0xffff));
        if (this.sys.onMouseWarp) this.sys.onMouseWarp(ms.x, ms.y);
        return ret(0);
      }
      case 0x77: {
        const ms = this.mouse;
        ms.minX = (d1 >> 16) & 0xffff; ms.minY = d1 & 0xffff;
        ms.maxX = (d2 >> 16) & 0xffff; ms.maxY = d2 & 0xffff;
        ms.x = Math.max(ms.minX, Math.min(ms.maxX, ms.x));
        ms.y = Math.max(ms.minY, Math.min(ms.maxY, ms.y));
        return ret(0);
      }
      case 0x78: case 0x79: case 0x7a: case 0x7b: case 0x7c: return ret(0);
      case 0x7d: return ret(0);
      case 0x7e: return ret(0);
      case 0x7f: { // ONTIME
        const t = this.sys.timeMs();
        const now = this.sys.now();
        cpu.d[1] = Math.floor((now - new Date(1980, 0, 1)) / 86400000);
        return ret(Math.floor(t / 10) % 8640000);
      }
      case 0x80: { // B_INTVCS
        return ret(this.sys.human.setVector(d1 & 0xffff, cpu.a[1] >>> 0));
      }
      case 0x81: return this.bsuper();
      case 0x82: { const a = cpu.a[1] >>> 0; cpu.a[1] += 1; return ret((cpu.d[0] & ~0xff) | m.r8(a)); }
      case 0x83: { const a = cpu.a[1] >>> 0; cpu.a[1] += 2; return ret((cpu.d[0] & ~0xffff) | m.r16(a)); }
      case 0x84: { const a = cpu.a[1] >>> 0; cpu.a[1] += 4; return ret(m.r32(a)); }
      case 0x85: { // B_MEMSTR: copy d1 bytes a1 -> a2
        const a1 = cpu.a[1] >>> 0, a2 = cpu.a[2] >>> 0, n2 = d1 >>> 0;
        for (let i = 0; i < n2; i++) m.w8(a2 + i, m.r8(a1 + i));
        cpu.a[1] += n2; cpu.a[2] += n2; return ret(0);
      }
      case 0x86: { m.w8(cpu.a[1], d1); cpu.a[1] += 1; return ret(0); }
      case 0x87: { m.w16(cpu.a[1], d1); cpu.a[1] += 2; return ret(0); }
      case 0x88: { m.w32(cpu.a[1], d1); cpu.a[1] += 4; return ret(0); }
      case 0x89: { // B_MEMSET: copy d1 bytes a2 -> a1? (set a1 from a2)
        const a1 = cpu.a[1] >>> 0, a2 = cpu.a[2] >>> 0, n2 = d1 >>> 0;
        for (let i = 0; i < n2; i++) m.w8(a1 + i, m.r8(a2 + i));
        cpu.a[1] += n2; cpu.a[2] += n2; return ret(0);
      }
      case 0x8a: this.dmamove(d1, d2 >>> 0, cpu.a[1] >>> 0, cpu.a[2] >>> 0); return ret(0);
      case 0x8b: case 0x8c: this.dmamoveChain(n, d1, d2 >>> 0, cpu.a[1] >>> 0, cpu.a[2] >>> 0); return ret(0);
      case 0x8d: return ret(0);
      case 0x8e: return ret(0x90);
      case 0x8f: return ret(0x13921127);
      case 0x90: this.gclrOn(); return ret(0);
      case 0x91: return ret(this.gmod(d1));
      case 0x92: return ret(0);
      case 0x93: return ret(0);
      case 0x94: { // GPALET
        const v = this.sys.video;
        const idx = d1 & 0xff;
        const old = v.gpal[idx];
        if (d2 === -1) return ret(old);
        this.setPal(0xe82000, idx, d2 & 0xffff);
        return ret(old);
      }
      case 0xa0: return ret(this.sftjis(d1 & 0xffff));
      case 0xa1: return ret(this.jissft(d1 & 0xffff));
      case 0xac: return ret(0);
      case 0xad: return ret(0);
      case 0xae: this.cursorOn = true; return ret(0);
      case 0xaf: this.cursorOn = false; return ret(0);
      case 0xb0: return ret(0);
      case 0xb1: { const old = this.apage; if (d1 >= 0 && d1 < 4) this.apage = d1; return ret(old); }
      case 0xb2: { // VPAGE
        const v = this.sys.video;
        v.vc[2] = (v.vc[2] & ~0x1f) | (d1 & 0xf);
        return ret(0);
      }
      case 0xb3: case 0xb4: return ret(0);
      case 0xb5: this.wipe(); return ret(0);
      case 0xb6: this.gpset(cpu.a[1] >>> 0); return ret(0);
      case 0xba: this.gfill(cpu.a[1] >>> 0); return ret(0);
      case 0xc0: this.spInit(); return ret(0);
      case 0xc1: { const v = this.sys.video; v.vc[2] |= 0x40; v.bgr[4] |= 0x200; return ret(0); }
      case 0xc2: { const v = this.sys.video; v.vc[2] &= ~0x40; v.bgr[4] &= ~0x200; return ret(0); }
      case 0xfd: case 0xfe: case 0xff: return ret(0);
    }
    if (!this.unknown.has(n)) {
      this.unknown.add(n);
      this.log(`unimplemented IOCS $${n.toString(16)} d1=${(d1 >>> 0).toString(16)} d2=${(d2 >>> 0).toString(16)}`);
    }
    return ret(0);
  }

  blockRetry() {
    // Called from IOCS dispatch inside trap #15: rewind the trap so it re-executes.
    // The trap frame's PC points after "trap #15"; move it back by 2.
    const cpu = this.cpu;
    const sp = cpu.a[7] >>> 0;
    this.m.w32(sp + 2, this.m.r32(sp + 2) - 2);
    this.waitingForInput = true;
    cpu.d[0] = 0;
  }

  bsuper() {
    // B_SUPER from inside trap #15: frame on SSP is [sr, pc].
    const cpu = this.cpu, m = this.m;
    const a1 = cpu.a[1] >>> 0;
    const ssp = cpu.a[7] >>> 0;
    const sr = m.r16(ssp);
    if (a1 === 0) {
      if (sr & 0x2000) { cpu.d[0] = -1; return; }
      // Enter supervisor: returning from trap leaves us in supervisor with SSP = USP
      const pc = m.r32(ssp + 2);
      const old = (ssp + 6) >>> 0;
      // build a new frame on the user stack and switch
      const usp = cpu.usp >>> 0;
      cpu.a[7] = usp - 6;
      m.w16(usp - 6, sr | 0x2000);
      m.w32(usp - 4, pc);
      cpu.d[0] = old;
      return;
    }
    // Leave supervisor: SSP = a1, user stack = current stack after frame
    const pc = m.r32(ssp + 2);
    const cur = (ssp + 6) >>> 0;
    cpu.usp = cur;
    const nssp = a1 - 6;
    m.w16(nssp, sr & ~0x2000);
    m.w32(nssp + 2, pc);
    cpu.a[7] = nssp;
    cpu.d[0] = 0;
  }

  // ---- video helpers -------------------------------------------------------------------
  setPal(base, idx, v) {
    this.m.w8(base + idx * 2, v >> 8);
    this.m.w8(base + idx * 2 + 1, v & 0xff);
  }

  setContrast(c) {
    this.contrast = c;
    this.sys.sysport.contrast = c;
  }

  crtmod(d1) {
    const mode = d1 & 0xff;
    if (mode === 0xff) return this.crtMode ?? 16;
    const v = this.sys.video;
    let regs, sp = SP_31K_512, mem;
    if (mode <= 15) {
      regs = CRT_TABLE[mode & 3];
      sp = SP_TABLE[mode & 3];
      mem = mode < 4 ? 4 : mode < 8 ? 0 : mode < 12 ? 1 : 3;
    } else {
      regs = CRT_768; mem = 4;
    }
    this.crtMode = mode;
    for (let i = 0; i < 9; i++) v.crtc[i] = regs[i];
    v.crtc[20] = (mem << 8) | regs[9];
    for (let i = 10; i < 20; i++) v.crtc[i] = 0;
    v.crtc[21] = 0;
    v.vc[0] = mem;
    v.vc[1] = 0x06e4;
    v.vc[2] = 0x0020;
    v.bgr[5] = sp[0]; v.bgr[6] = sp[1]; v.bgr[7] = sp[2]; v.bgr[8] = sp[3];
    if (!(d1 & 0x100)) {
      v.tram.fill(0);
      for (let i = 0; i < 16; i++) this.setPal(0xe82200, i, DEFAULT_TPAL[i]);
    }
    const w = (regs[3] - regs[2]) * 8;
    const h = mode >= 16 ? 512 : (mode & 2) ? 256 : 512;
    this.con.cols = Math.floor(w / 8); this.con.rows = Math.floor(h / 16) - 1;
    this.con.x = 0; this.con.y = 0;
    const ms = this.mouse;
    ms.minX = 0; ms.minY = 0; ms.maxX = w - 1; ms.maxY = h - 1;
    this.sys.sysport.contrast = 15; this.contrast = 15;
    return 0;
  }

  gclrOn() {
    const v = this.sys.video;
    v.gram.fill(0);
    const mem = v.crtc[20] >> 8 & 7;
    v.vc[0] = mem;
    v.vc[2] = (v.vc[2] & ~0x1f) | (mem & 4 ? 0x10 : 0x0f);
    // default graphic palette
    if (mem === 0 || mem === 4) {
      for (let i = 0; i < 16; i++) this.setPal(0xe82000, i, DEFAULT_TPAL[i]);
    } else if (mem === 1) {
      for (let i = 0; i < 256; i++) {
        const g = (i >> 5) & 7, r = (i >> 2) & 7, b = i & 3;
        this.setPal(0xe82000, i, ((g * 31 / 7) << 11) | ((r * 31 / 7) << 6) | ((b * 31 / 3) << 1));
      }
    } else {
      for (let i = 0; i < 256; i++) {
        const lo = (i & 0xfe) | (i & 1);
        this.setPal(0xe82000, i, (i << 8) | lo);
      }
    }
    this.apage = 0;
  }

  gmod(d1) { return 0; }

  gpageInfo() {
    const v = this.sys.video;
    const mem = (v.crtc[20] >> 8) & 7;
    return { mem, page: this.apage };
  }

  gpsetXY(x, y, c) {
    const { mem, page } = this.gpageInfo();
    if (mem & 4) {
      if (x < 0 || y < 0 || x > 1023 || y > 1023) return;
      this.m.w16(0xc00000 + y * 2048 + x * 2, c);
      return;
    }
    if (x < 0 || y < 0 || x > 511 || y > 511) return;
    this.m.w16(0xc00000 + page * 0x80000 + y * 1024 + x * 2, c);
  }

  gfill(a) {
    const m = this.m;
    let x1 = m.r16(a) << 16 >> 16, y1 = m.r16(a + 2) << 16 >> 16;
    let x2 = m.r16(a + 4) << 16 >> 16, y2 = m.r16(a + 6) << 16 >> 16;
    const c = m.r16(a + 8);
    if (x1 > x2) [x1, x2] = [x2, x1];
    if (y1 > y2) [y1, y2] = [y2, y1];
    for (let y = y1; y <= y2; y++) for (let x = x1; x <= x2; x++) this.gpsetXY(x, y, c);
  }

  gpset(a) {
    const m = this.m;
    this.gpsetXY(m.r16(a) << 16 >> 16, m.r16(a + 2) << 16 >> 16, m.r16(a + 4));
  }

  wipe() {
    const v = this.sys.video;
    const { mem, page } = this.gpageInfo();
    if (mem & 4 || mem === 3) { v.gram.fill(0); return; }
    const sh = mem === 1 ? page * 8 : page * 4;
    const mk = mem === 1 ? 0xff : 0xf;
    const keep = ~(mk << sh) & 0xffff;
    for (let i = 0; i < v.gram.length; i++) v.gram[i] &= keep;
  }

  spInit() {
    const v = this.sys.video;
    v.spr.fill(0);
    v.bgr[0] = v.bgr[1] = v.bgr[2] = v.bgr[3] = 0;
    v.bgr[4] = 0;
    return 0;
  }

  // ---- text console (IOCS B_PUTC etc.) --------------------------------------------------
  print(s) {
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (((c >= 0x81 && c <= 0x9f) || (c >= 0xe0 && c <= 0xef)) && i + 1 < s.length) {
        this.putc((c << 8) | s.charCodeAt(++i));
      } else this.putc(c);
    }
    if (this.sys.consoleEcho) this.sys.consoleEcho(s);
  }

  putc(c) {
    const con = this.con;
    if (this.escState) { this.escape(c); return; }
    if (c === 0x1b) { this.escState = []; return; }
    if (c === 0x0d) { con.x = 0; return; }
    if (c === 0x0a) { this.newline(); return; }
    if (c === 0x08) { if (con.x > 0) con.x--; return; }
    if (c === 0x09) { con.x = (con.x + 8) & ~7; if (con.x >= con.cols) this.newline(); return; }
    if (c === 0x0c) { this.clearScreen(2); return; }
    if (c === 0x07 || c < 0x20) return;
    const wide = c > 0xff;
    if (con.x + (wide ? 2 : 1) > con.cols) { con.x = 0; this.newline(); }
    this.drawChar(con.x, con.y, c, con.color);
    con.x += wide ? 2 : 1;
  }

  escape(c) {
    const st = this.escState;
    st.push(c);
    const s = String.fromCharCode(...st);
    if (s[0] === '[') {
      if (/^\[[\d;>?]*[A-Za-z]$/.test(s)) {
        this.escState = null;
        const args = s.slice(1, -1).replace(/[>?]/g, '').split(';').map((x) => parseInt(x || '0', 10));
        const cmd = s[s.length - 1];
        const con = this.con;
        switch (cmd) {
          case 'H': case 'f': con.y = Math.max(0, (args[0] || 1) - 1); con.x = Math.max(0, (args[1] || 1) - 1); break;
          case 'J': this.clearScreen(args[0] || 0); break;
          case 'K': this.clearLine(args[0] || 0); break;
          case 'A': con.y = Math.max(0, con.y - (args[0] || 1)); break;
          case 'B': con.y = Math.min(con.rows, con.y + (args[0] || 1)); break;
          case 'C': con.x = Math.min(con.cols - 1, con.x + (args[0] || 1)); break;
          case 'D': con.x = Math.max(0, con.x - (args[0] || 1)); break;
          case 'm': for (const a of args) { if (a === 0) con.color = 3; else if (a >= 30 && a <= 37) con.color = (a - 30) & 15; else if (a >= 1 && a <= 7) con.color = a; } break;
        }
      } else if (st.length > 16) this.escState = null;
      return;
    }
    if (s === '*') { this.clearScreen(2); }
    else if (s[0] === '=' && st.length < 3) return;
    this.escState = null;
  }

  newline() {
    const con = this.con;
    con.y++;
    if (con.y > con.rows) { con.y = con.rows; this.scrollUp(); }
  }

  scrollUp() {
    const t = this.sys.video.tram;
    for (let p = 0; p < 4; p++) {
      const base = p * 0x20000;
      t.copyWithin(base, base + 16 * 128, base + (this.con.rows + 1) * 16 * 128);
      t.fill(0, base + this.con.rows * 16 * 128, base + (this.con.rows + 1) * 16 * 128);
    }
  }

  locate(x, y) { this.con.x = Math.min(x, this.con.cols - 1); this.con.y = Math.min(y, this.con.rows); }
  setColor(c) { this.con.color = c & 15; }
  cursorDownScroll() { this.newline(); }
  cursorUpScroll() { if (this.con.y > 0) this.con.y--; }

  clearScreen(mode) {
    const t = this.sys.video.tram;
    const con = this.con;
    if (mode === 2) {
      for (let p = 0; p < 4; p++) t.fill(0, p * 0x20000, p * 0x20000 + 0x20000);
      con.x = 0; con.y = 0;
      return;
    }
    const start = mode === 0 ? con.y * 16 : 0;
    const end = mode === 0 ? (con.rows + 1) * 16 : (con.y + 1) * 16;
    for (let p = 0; p < 4; p++) t.fill(0, p * 0x20000 + start * 128, p * 0x20000 + end * 128);
  }
  clearLine(mode) {
    const t = this.sys.video.tram;
    const con = this.con;
    const x0 = mode === 0 ? con.x : 0, x1 = mode === 1 ? con.x + 1 : 128;
    for (let p = 0; p < 4; p++) for (let r = 0; r < 16; r++) {
      const row = p * 0x20000 + (con.y * 16 + r) * 128;
      t.fill(0, row + x0, row + x1);
    }
  }

  drawChar(cx, cy, code, color) {
    const font = this.sys.font;
    const t = this.sys.video.tram;
    const glyph = font.glyph16(code);
    const w = glyph.width;
    const bytesPerRow = w >> 3;
    for (let r = 0; r < 16; r++) {
      for (let b = 0; b < bytesPerRow; b++) {
        const bits = glyph.data[r * bytesPerRow + b];
        const off = (cy * 16 + r) * 128 + cx + b;
        for (let p = 0; p < 4; p++) t[p * 0x20000 + off] = (color >> p) & 1 ? bits : 0;
      }
    }
  }

  fntadr(d1) {
    // Return address of the glyph in CGROM (d1 = code, d2 = size)
    const code = d1 & 0xffff;
    const font = this.sys.font;
    const addr = font.romAddress(code, this.cpu.d[2] & 0xff);
    this.cpu.d[1] = font.lastWidth - 1; this.cpu.d[2] = font.lastHeight - 1;
    return addr;
  }

  fntget(d1, buf) {
    const code = d1 & 0xffff;
    const size = (d1 >> 16) & 0xff;
    const font = this.sys.font;
    const g = size === 6 ? font.glyph8(code) : size === 12 ? font.glyph16(code) : font.glyph16(code);
    const m = this.m;
    m.w16(buf, g.width); m.w16(buf + 2, g.height);
    for (let i = 0; i < g.data.length; i++) m.w8(buf + 4 + i, g.data[i]);
    return 0;
  }

  sftjis(c) {
    let hi = c >> 8, lo = c & 0xff;
    hi -= hi <= 0x9f ? 0x71 : 0xb1;
    hi = hi * 2 + 1;
    if (lo > 0x7f) lo--;
    if (lo >= 0x9e) { lo -= 0x7d; hi++; } else lo -= 0x1f;
    return (hi << 8) | lo;
  }
  jissft(c) {
    let hi = c >> 8, lo = c & 0xff;
    if (hi & 1) { lo += lo >= 0x60 ? 0x20 : 0x1f; } else lo += 0x7e;
    hi = ((hi + 1) >> 1) + (hi <= 0x5e ? 0x70 : 0xb0);
    return (hi << 8) | lo;
  }

  // ---- disk ------------------------------------------------------------------------------
  drvchk(d1, d2) {
    // status: bit1 = medium inserted, bit2 = ready? (we always report inserted & ready)
    const drive = (d1 >> 8) & 0xff ? (d1 >> 8) & 3 : d1 & 3;
    const mode = d2 & 0xff;
    if (mode === 1 && this.sys.ejectDisk) this.sys.ejectDisk(drive);
    return this.sys.human.drives[drive] ? 0x02 : 0x04;
  }

  bread(d1, d2, len, buf) {
    const drive = (d1 >> 8) & 3;
    const disk = this.sys.human.drives[drive];
    if (!disk || !disk.image) return -1;
    // d2 = C H R N: sector address
    const c = (d2 >> 24) & 0xff, h = (d2 >> 16) & 0xff, r = (d2 >> 8) & 0xff;
    const lba = (c * 2 + h) * 8 + (r - 1);
    const off = lba * 1024;
    const n = len >>> 0;
    this.m.writeBytes(buf, disk.image.subarray(off, off + n));
    return 0;
  }
  bwrite() { return 0; }

  dateTime(n) {
    const d = this.sys.now();
    const bcd = (v) => ((Math.floor(v / 10) % 10) << 4) | (v % 10);
    switch (n) {
      case 0x54: return (d.getDay() << 24) | (bcd(d.getFullYear() - 1980) << 16) | (bcd(d.getMonth() + 1) << 8) | bcd(d.getDate());
      case 0x55: return (bcd(d.getHours()) << 16) | (bcd(d.getMinutes()) << 8) | bcd(d.getSeconds());
      case 0x56: return (d.getDay() << 28) | (d.getFullYear() << 16) | ((d.getMonth() + 1) << 8) | d.getDate();
      case 0x57: return (d.getHours() << 16) | (d.getMinutes() << 8) | d.getSeconds();
    }
    return 0;
  }

  // ---- interrupts ----------------------------------------------------------------------------
  vdispst(a1, d1) {
    const mfp = this.sys.mfp;
    if (a1 === 0) {
      mfp.write(12, 0, 0xe88019);                     // stop timer A
      mfp.ier &= ~(1 << 13); mfp.imr &= ~(1 << 13);
      this.m.w32(0x4d * 4, this.sys.defaultVector);
      return 0;
    }
    this.m.w32(0x4d * 4, a1);
    const count = d1 & 0xff;
    mfp.tcr[0] = 0;
    mfp.tdr[0] = count; mfp.tcount[0] = count || 256;
    mfp.tcr[0] = 8;
    mfp.ier |= 1 << 13; mfp.imr |= 1 << 13;
    this.sys.vdispSlot = a1;
    return 0;
  }

  crtcras(a1, d1) {
    const mfp = this.sys.mfp;
    if (a1 === 0) { mfp.ier &= ~(1 << 14); mfp.imr &= ~(1 << 14); return 0; }
    this.m.w32(0x4e * 4, a1);
    this.sys.video.crtc[9] = d1 & 0x3ff;
    mfp.aer &= ~0x40;
    mfp.ier |= 1 << 14; mfp.imr |= 1 << 14;
    return 0;
  }

  hsyncst(a1) {
    const mfp = this.sys.mfp;
    if (a1 === 0) { mfp.ier &= ~(1 << 15); mfp.imr &= ~(1 << 15); return 0; }
    this.m.w32(0x4f * 4, a1);
    mfp.ier |= 1 << 15; mfp.imr |= 1 << 15;
    return 0;
  }

  timerdst(a1, d1) {
    const mfp = this.sys.mfp;
    if (a1 === 0) { mfp.tcr[3] = 0; mfp.ier &= ~(1 << 4); mfp.imr &= ~(1 << 4); return 0; }
    this.m.w32(0x44 * 4, a1);
    mfp.tcr[3] = 0;
    mfp.tdr[3] = d1 & 0xff; mfp.tcount[3] = (d1 & 0xff) || 256;
    mfp.tcr[3] = (d1 >> 8) & 7;
    mfp.ier |= 1 << 4; mfp.imr |= 1 << 4;
    return 0;
  }

  opmintst(a1) {
    const mfp = this.sys.mfp;
    if (a1 === 0) { mfp.ier &= ~(1 << 3); mfp.imr &= ~(1 << 3); return 0; }
    this.m.w32(0x43 * 4, a1);
    mfp.aer &= ~0x08;
    mfp.ier |= 1 << 3; mfp.imr |= 1 << 3;
    return 0;
  }

  msInit() {
    const ms = this.mouse;
    ms.dx = ms.dy = 0;
    ms.cursor = false;
  }

  // ---- DMA helpers ------------------------------------------------------------------------------
  dmamove(mode, len, a1, a2) {
    // mode bit7: 0 = a1 -> a2, 1 = a2 -> a1; bits 0-1: a2 count mode, bits 2-3: a1 count mode
    const m = this.m;
    const step = (v) => v === 1 ? 1 : v === 2 ? -1 : 0;
    const s1 = step((mode >> 2) & 3), s2 = step(mode & 3);
    let p1 = a1, p2 = a2;
    for (let i = 0; i < len; i++) {
      if (mode & 0x80) m.w8(p1, m.r8(p2)); else m.w8(p2, m.r8(p1));
      p1 += s1; p2 += s2;
    }
    this.cpu.cycles += len >> 1;
  }

  dmamoveChain(n, mode, count, a1, a2) {
    const m = this.m;
    for (let i = 0; i < count; i++) {
      const addr = m.r32(a1), len = m.r16(a1 + 4);
      this.dmamove(mode, len, addr, a2);
      if (n === 0x8c) { a1 = m.r32(a1 + 6); if (!a1) break; }
      else a1 += 6;
      if ((mode & 3) === 1) a2 += len;
    }
  }
}
