// High-level emulation of the Human68k operating system (DOS calls via the
// F-line exception) and the program loader.

import { displayName } from './fs.js';

export const ROM_BASE = 0xff0000;         // HLE entry points live here
const HLE_DOS = ROM_BASE + 0x000;           // F-line handler
const HLE_TRAP15 = ROM_BASE + 0x002;        // IOCS trap handler
const HLE_RTE = ROM_BASE + 0x004;           // plain RTE (default vector)
const HLE_RTS = ROM_BASE + 0x006;           // plain RTS
const HLE_IOCS_RET = ROM_BASE + 0x008;      // return from user IOCS routine
const HLE_EXIT = ROM_BASE + 0x00a;          // process falls off its end
const HLE_PRIV = ROM_BASE + 0x00c;          // privilege violation (logged)
const HLE_SUPERJSR_RET = ROM_BASE + 0x00e;  // return from _SUPER_JSR
export const HLE_IOCS_BASE = ROM_BASE + 0x1000; // + 2*n: IOCS routine n

const MEM_START = 0x8000;                   // first memory block managed by DOS

const ERR = {
  INVALID_FUNC: -1, FILE_NOT_FOUND: -2, PATH_NOT_FOUND: -3, TOO_MANY: -4,
  ACCESS: -5, BAD_HANDLE: -6, BAD_MEM: -7, NO_MEM: -8, BAD_ADDR: -9,
  BAD_ENV: -10, BAD_FORMAT: -11, BAD_MODE: -12, BAD_NAME: -13, BAD_PARAM: -14,
  BAD_DRIVE: -15, NO_MORE: -18, WRITE_PROTECT: -19, EXISTS: -80,
};

function toU8(s) { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return b; }

export class Human68k {
  constructor(machine, opts = {}) {
    this.m = machine;
    this.cpu = machine.cpu;
    this.log = opts.log ?? (() => {});
    this.trace = opts.trace ?? false;
    this.drives = [];           // index 0 = A:
    this.curDrive = 0;
    this.curDir = [];           // per drive: array of path components
    this.files = new Map();     // handle -> open file
    this.findState = new Map(); // buffer address -> iterator state
    this.procStack = [];        // saved parent contexts for _EXEC
    this.iocs = null;           // IOCS HLE object (set later)
    this.console = opts.console ?? ((s) => process.stdout.write(s));
    this.onMissingFile = opts.onMissingFile ?? null;
    this.memEnd = machine.ramSize;
    this.curPSP = 0;
    this.env = 0;
    this.breakFlag = 0;
    this.verify = 0;
    this.diskSwaps = 0;
    this.dosCallCounts = new Map();
  }

  // ---- boot / vectors -------------------------------------------------------
  install() {
    const m = this.m;
    for (let v = 0; v < 256; v++) m.w32(v * 4, HLE_RTE);
    m.w32(11 * 4, HLE_DOS);          // line F
    m.w32(47 * 4, HLE_TRAP15);       // trap #15
    m.w32(8 * 4, HLE_PRIV);
    for (let n = 0; n < 256; n++) m.w32(0x400 + n * 4, HLE_IOCS_BASE + n * 2);
    this.cpu.hle = (pc) => this.hle(pc);
    this.cpu.hleLo = ROM_BASE;
    // System stack for the "OS"
    this.cpu.s = 1;
    this.cpu.a[7] = 0x2000;
    this.cpu.ssp = 0x2000;
    // Initial free memory block covering everything
    this.firstBlock = MEM_START;
    this.writeBlock(MEM_START, 0, 0, this.memEnd, 0);
    // A dummy root process owns nothing; free blocks have parent 0 and are
    // represented by gaps between allocated blocks (Human68k style chain).
    this.blocks = [];
    // Device driver chain: Human68k keeps its built-in NUL device here.
    // Programs like ZMUSIC scan for it to append their own drivers.
    m.w32(0x6800, 0xffffffff);
    m.w16(0x6804, 0x8024);
    m.w32(0x6806, HLE_RTS);
    m.w32(0x680a, HLE_RTS);
    m.writeBytes(0x680e, toU8('NUL     '));
    // environment block
    this.env = this.allocRaw(0x400, 0);
    m.w32(this.env, 0x400);
    m.writeCString(this.env + 4, 'path=A:\\');
    m.w8(this.env + 4 + 9, 0);
    m.w8(this.env + 4 + 10, 0);
  }

  hle(pc) {
    switch (pc) {
      case HLE_DOS: this.dosEntry(); return true;
      case HLE_TRAP15: this.iocsEntry(); return true;
      case HLE_RTE: this.rte(); return true;
      case HLE_RTS: this.cpu.pc = this.cpu.pop32(); return true;
      case HLE_IOCS_RET: this.cpu.a[0] = this.cpu.pop32(); this.rte(); return true;
      case HLE_EXIT: this.exitProcess(0, false); return true;
      case HLE_SUPERJSR_RET: this.superJsrReturn(); return true;
      case HLE_PRIV: {
        const sp = this.cpu.a[7] >>> 0;
        const at = this.m.r32(sp + 2);
        const usp = this.cpu.usp >>> 0;
        const stack = [0, 2, 4, 6, 8, 10].map((o) => this.m.r16(usp + o).toString(16).padStart(4, '0')).join(' ');
        this.log(`privilege violation at ${at.toString(16)} op=${this.m.r16(at).toString(16)} usp=${usp.toString(16)} [${stack}]`);
        this.halt('privilege violation');
        return true;
      }
    }
    if (pc >= HLE_IOCS_BASE && pc < HLE_IOCS_BASE + 512) {
      // Direct jsr to an IOCS routine (via the table at $400). Behaves like a subroutine.
      const n = (pc - HLE_IOCS_BASE) >> 1;
      this.iocs.call(n);
      this.cpu.pc = this.cpu.pop32();
      return true;
    }
    if (this.iocs && this.iocs.hle && this.iocs.hle(pc)) return true;
    if (this.extraHle && this.extraHle(pc)) return true;
    this.log(`jump to unknown ROM address ${pc.toString(16)} from ${this.cpu.opPC.toString(16)}`);
    this.halt('rom');
    return true;
  }

  halt(why) {
    this.halted = why;
    this.cpu.stopped = true;
    this.cpu.ipl = 7;
  }

  rte() {
    const cpu = this.cpu;
    const sr = cpu.pop16();
    cpu.pc = cpu.pop32();
    cpu.setSR(sr);
  }

  iocsEntry() {
    // trap #15: call through the IOCS table at $400 + (d0 & 0xff) * 4
    const cpu = this.cpu;
    const n = cpu.d[0] & 0xff;
    const target = this.m.r32(0x400 + n * 4);
    if (target === HLE_IOCS_BASE + n * 2) {
      this.iocs.call(n);
      this.rte();
      return;
    }
    // user installed routine: save a0, call it, then RTE
    cpu.push32(cpu.a[0]);
    cpu.push32(HLE_IOCS_RET);
    cpu.a[0] = target;
    cpu.pc = target;
  }

  // ---- memory blocks --------------------------------------------------------
  // Allocated blocks are kept in a sorted JS array mirrored into RAM headers:
  // +0 prev, +4 parent (owner PSP), +8 end, +12 next.
  writeBlock(addr, prev, parent, end, next) {
    const m = this.m;
    m.w32(addr, prev); m.w32(addr + 4, parent); m.w32(addr + 8, end); m.w32(addr + 12, next);
  }

  syncBlocks() {
    const b = this.blocks;
    b.sort((x, y) => x.addr - y.addr);
    for (let i = 0; i < b.length; i++) {
      this.writeBlock(b[i].addr, i ? b[i - 1].addr : 0, b[i].owner, b[i].end, i + 1 < b.length ? b[i + 1].addr : 0);
    }
  }

  freeRegions() {
    const out = [];
    let p = MEM_START;
    for (const b of this.blocks) {
      if (b.addr > p) out.push([p, b.addr]);
      p = Math.max(p, b.end);
    }
    if (p < this.memEnd) out.push([p, this.memEnd]);
    return out;
  }

  // Allocate `size` bytes (excluding the 16-byte header). mode: 0 first fit,
  // 1 smallest fit, 2 highest address. Returns block address (header).
  allocRaw(size, owner, mode = 0) {
    size = (size + 16 + 15) & ~15;
    const free = this.freeRegions().filter(([s, e]) => e - s >= size);
    if (!free.length) return 0;
    let addr;
    if (mode === 2) { const [s, e] = free[free.length - 1]; addr = (e - size) & ~15; if (addr < s) addr = s; }
    else if (mode === 1) { free.sort((x, y) => (x[1] - x[0]) - (y[1] - y[0])); addr = free[0][0]; }
    else addr = free[0][0];
    this.blocks.push({ addr, end: addr + size, owner });
    this.syncBlocks();
    return addr;
  }

  largestFree() {
    let best = 0;
    for (const [s, e] of this.freeRegions()) best = Math.max(best, e - s - 16);
    return Math.max(0, best);
  }

  // ---- paths & drives -----------------------------------------------------
  mount(driveIndex, disk) {
    this.drives[driveIndex] = disk;
    if (!this.curDir[driveIndex]) this.curDir[driveIndex] = [];
  }

  // Parse a Human68k path string (latin1 / Shift-JIS bytes). Returns
  // {drive, parts} with parts upper-cased and resolved.
  parsePath(path) {
    let drive = this.curDrive;
    let p = path;
    if (p.length >= 2 && p[1] === ':') {
      drive = (p.charCodeAt(0) | 0x20) - 0x61;
      p = p.slice(2);
    }
    p = p.replace(/\//g, '\\');
    let parts = p.startsWith('\\') ? [] : [...(this.curDir[drive] || [])];
    for (const seg of p.split('\\')) {
      if (!seg || seg === '.') continue;
      if (seg === '..') { parts.pop(); continue; }
      parts.push(this.upper(seg));
    }
    return { drive, parts };
  }

  upper(s) {
    // upper-case ASCII only, leaving Shift-JIS second bytes alone
    let o = '';
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if ((c >= 0x81 && c <= 0x9f) || (c >= 0xe0 && c <= 0xfc)) { o += s[i] + (s[i + 1] ?? ''); i++; continue; }
      o += (c >= 0x61 && c <= 0x7a) ? String.fromCharCode(c - 32) : s[i];
    }
    return o;
  }

  lookup(path) {
    const { drive, parts } = this.parsePath(path);
    const disk = this.drives[drive];
    if (!disk) return { err: ERR.BAD_DRIVE };
    if (this.onLookup) this.onLookup(drive, parts);
    let node = disk.lookup(parts);
    if (!node && this.onMissingFile) {
      if (this.onMissingFile(drive, parts)) node = this.drives[drive].lookup(parts);
    }
    return { node, drive, parts, disk: this.drives[drive] };
  }

  // ---- DOS dispatcher -------------------------------------------------------
  dosEntry() {
    const cpu = this.cpu, m = this.m;
    const ssp = cpu.a[7] >>> 0;
    const sr = m.r16(ssp);
    const retpc = m.r32(ssp + 2);
    const op = m.r16(retpc);
    if ((op & 0xff00) !== 0xff00) {
      this.log(`line-F exception op=${op.toString(16)} at ${retpc.toString(16)}`);
      this.halt('linef');
      return;
    }
    // Parameters live on the caller's stack.
    const callerSuper = (sr & 0x2000) !== 0;
    const sp = callerSuper ? ssp + 6 : cpu.usp >>> 0;
    m.w32(ssp + 2, retpc + 2);
    const n = op & 0xff;
    if (this.onDosCall) this.onDosCall(n);
    this.dosCallCounts.set(n, (this.dosCallCounts.get(n) || 0) + 1);
    const r = this.dos(n, sp, ssp, sr);
    if (r === undefined) return; // call manipulated control flow itself
    cpu.d[0] = r;
    this.rte();
  }

  arg16(sp, off) { return this.m.r16(sp + off); }
  arg32(sp, off) { return this.m.r32(sp + off); }
  str(addr) { return this.m.readCString(addr); }

  dos(n, sp, ssp, sr) {
    const m = this.m, cpu = this.cpu;
    let fn = n;
    if (fn >= 0x50 && fn < 0x80) fn += 0x30;
    if (this.trace) this.log(`DOS $FF${n.toString(16).padStart(2, '0')} sp=${sp.toString(16)} pc=${m.r32(ssp + 2).toString(16)}`);
    switch (fn) {
      case 0x00: this.exitProcess(0, false); return undefined;
      case 0x01: case 0x08: return this.getKey(true);
      case 0x02: this.console(String.fromCharCode(this.arg16(sp, 0) & 0xff)); return 0;
      case 0x06: {
        const c = this.arg16(sp, 0);
        if (c === 0xff) return this.getKey(false);
        if (c === 0xfe) return this.peekKey();
        this.console(String.fromCharCode(c & 0xff)); return 0;
      }
      case 0x07: return this.getKey(true);
      case 0x09: this.console(this.str(this.arg32(sp, 0))); return 0;
      case 0x0b: return this.iocs ? (this.iocs.keyAvailable() ? -1 : 0) : 0;
      case 0x0c: { // KFLUSH
        if (this.iocs) this.iocs.flushKeys();
        const mode = this.arg16(sp, 0);
        if (mode === 1 || mode === 7 || mode === 8) return this.getKey(true);
        if (mode === 6) { const c = this.arg16(sp, 2); if (c === 0xff) return this.getKey(false); return 0; }
        return 0;
      }
      case 0x0d: return 0;
      case 0x0e: { const d = this.arg16(sp, 0); if (this.drives[d]) this.curDrive = d; return 26; }
      case 0x0f: return this.drives[this.arg16(sp, 0) & 0xff ? (this.arg16(sp, 0) & 0xff) - 1 : this.curDrive] ? 0x02 : 0x04;
      case 0x10: return 0;
      case 0x19: return this.curDrive;
      case 0x1b: { // FGETC
        const f = this.files.get(this.arg16(sp, 0));
        if (!f || !f.node) return ERR.BAD_HANDLE;
        if (f.pos >= f.node.data.length) return -1;
        return f.node.data[f.pos++];
      }
      case 0x1d: { const c = this.arg16(sp, 0); const h = this.arg16(sp, 2); this.writeHandle(h, new Uint8Array([c])); return 0; }
      case 0x1e: { const s = this.str(this.arg32(sp, 0)); this.writeHandle(this.arg16(sp, 4), toU8(s)); return 0; }
      case 0x1f: return 0;
      case 0x20: return this.super(sp, ssp, sr);
      case 0x21: return 0;  // FNCKEY
      case 0x22: return 0;  // KNJCTRL
      case 0x23: return this.conctrl(sp);
      case 0x24: return 0;
      case 0x25: { // INTVCS
        const v = this.arg16(sp, 0), addr = this.arg32(sp, 2);
        return this.setVector(v, addr);
      }
      case 0x26: return 0;
      case 0x27: return this.gettim2();
      case 0x2a: return this.getdate();
      case 0x2c: return this.gettime();
      case 0x2e: this.verify = this.arg16(sp, 0); return 0;
      case 0x30: return 0x36380302; // Human68k 3.02
      case 0x31: { // KEEPPR
        const keep = this.arg32(sp, 0);
        const code = this.arg16(sp, 4);
        this.exitProcess(code, true, keep);
        return undefined;
      }
      case 0x33: { const f = this.arg16(sp, 0); if (f <= 1) this.breakFlag = f; return this.breakFlag; }
      case 0x35: return this.getVector(this.arg16(sp, 0));
      case 0x36: { // DSKFRE
        const buf = this.arg32(sp, 2);
        m.w16(buf, 100); m.w16(buf + 2, 1232); m.w16(buf + 4, 1); m.w16(buf + 6, 1024);
        return 100 * 1024;
      }
      case 0x37: return this.nameck(this.arg32(sp, 0), this.arg32(sp, 4));
      case 0x39: return this.mkdir(this.str(this.arg32(sp, 0)));
      case 0x3b: return this.chdir(this.str(this.arg32(sp, 0)));
      case 0x3c: return this.create(this.str(this.arg32(sp, 0)), this.arg16(sp, 4), false);
      case 0x3d: return this.open(this.str(this.arg32(sp, 0)), this.arg16(sp, 4));
      case 0x3e: return this.close(this.arg16(sp, 0));
      case 0x3f: return this.read(this.arg16(sp, 0), this.arg32(sp, 2), this.arg32(sp, 6));
      case 0x40: return this.write(this.arg16(sp, 0), this.arg32(sp, 2), this.arg32(sp, 6));
      case 0x41: return this.del(this.str(this.arg32(sp, 0)));
      case 0x42: return this.seek(this.arg16(sp, 0), this.arg32(sp, 2) | 0, this.arg16(sp, 6));
      case 0x43: return this.chmod(this.str(this.arg32(sp, 0)), this.arg16(sp, 4));
      case 0x44: return this.ioctrl(sp);
      case 0x45: return this.dup(this.arg16(sp, 0));
      case 0x46: return this.dup2(this.arg16(sp, 0), this.arg16(sp, 2));
      case 0x47: return this.curdir(this.arg16(sp, 0), this.arg32(sp, 2));
      case 0x48: return this.malloc(this.arg32(sp, 0) & 0xffffff, 0);
      case 0x49: return this.mfree(this.arg32(sp, 0));
      case 0x4a: return this.setblock(this.arg32(sp, 0), this.arg32(sp, 4) & 0xffffff);
      case 0x4b: return this.exec(sp, ssp, sr);
      case 0x4c: this.exitProcess(this.arg16(sp, 0), false); return undefined;
      case 0x4d: return this.lastExit ?? 0;
      case 0x4e: return this.files_(this.arg32(sp, 0), this.str(this.arg32(sp, 4)), this.arg16(sp, 8));
      case 0x4f: return this.nfiles(this.arg32(sp, 0));
      case 0x80: this.curPSP = this.arg32(sp, 0) - 0x10; return 0; // SETPDB
      case 0x81: return this.curPSP + 0x10;                       // GETPDB
      case 0x83: return this.getenv(sp);
      case 0x86: return this.rename(this.str(this.arg32(sp, 0)), this.str(this.arg32(sp, 4)));
      case 0x87: return this.filedate(this.arg16(sp, 0), this.arg32(sp, 2));
      case 0x88: { // MALLOC2
        const mode = this.arg16(sp, 0) & 0xff;
        return this.malloc(this.arg32(sp, 2) & 0xffffff, mode);
      }
      case 0x8b: return this.create(this.str(this.arg32(sp, 0)), this.arg16(sp, 4), true);
      case 0xf5: return 0; // INDOSFLG (address); unused
      case 0xf6: return this.superJsr(sp);
      case 0xf7: { // BUS_ERR: check readable/writable memory
        const md = this.arg16(sp, 8);
        const a = md & 1 ? this.arg32(sp, 4) : this.arg32(sp, 0);
        // I/O devices that exist answer too (m.isPresent: e.g. an emulated MIDI interface)
        return (a & 0xffffff) < this.m.ramSize || this.m.isPresent?.(a & 0xffffff) ? 0 : 2;
      }
      case 0xff: return 0; // CHANGE_PR
      case 0xfa: case 0xfb: case 0xfc: case 0xfd: case 0xfe: case 0xf8: case 0xf9: return -1;
      case 0xf0: case 0xf1: case 0xf2: return 0;
    }
    this.log(`unimplemented DOS call $FF${n.toString(16).padStart(2, '0')} at ${m.r32(ssp + 2).toString(16)}`);
    return ERR.INVALID_FUNC;
  }

  // ---- console --------------------------------------------------------------
  getKey(wait) {
    if (!this.iocs) return 0;
    const k = this.iocs.popKey();
    if (k >= 0) return k & 0xff;
    if (wait) {
      // Re-execute the DOS call until a key is available.
      const ssp = this.cpu.a[7] >>> 0;
      this.m.w32(ssp + 2, this.m.r32(ssp + 2) - 2);
      this.rte();
      this.iocs.waitingForInput = true;
      return undefined;
    }
    return 0;
  }
  peekKey() { if (!this.iocs) return 0; const k = this.iocs.peekKey(); return k >= 0 ? k & 0xff : 0; }

  conctrl(sp) {
    const mode = this.arg16(sp, 0);
    const io = this.iocs;
    switch (mode) {
      case 0: io && io.putc(this.arg16(sp, 2)); return 0;
      case 1: io && io.print(this.str(this.arg32(sp, 2))); return 0;
      case 2: io && io.setColor(this.arg16(sp, 2)); return 0;
      case 3: io && io.locate(this.arg16(sp, 2), this.arg16(sp, 4)); return 0;
      case 4: io && io.cursorDownScroll(); return 0;
      case 5: io && io.cursorUpScroll(); return 0;
      case 10: io && io.clearScreen(this.arg16(sp, 2)); return 0;
      case 11: io && io.clearLine(this.arg16(sp, 2)); return 0;
      case 12: case 13: return 0;
      case 14: return 0; // function key display mode
      case 16: return 0; // screen mode
      case 17: case 18: return 0; // cursor on/off
    }
    return 0;
  }

  writeHandle(h, bytes) {
    if (h === 1 || h === 2 || h === 0) { let s = ''; for (const b of bytes) s += String.fromCharCode(b); this.consoleOut(s); return bytes.length; }
    const f = this.files.get(h);
    if (!f) return ERR.BAD_HANDLE;
    if (f.device) return bytes.length;
    return this.writeFile(f, bytes);
  }

  consoleOut(s) {
    if (this.iocs && this.iocs.print) this.iocs.print(s);
    else this.console(s);
  }

  // ---- supervisor / vectors -----------------------------------------------
  super(sp, ssp, sr) {
    const cpu = this.cpu;
    const arg = this.arg32(sp, 0);
    const callerSuper = (sr & 0x2000) !== 0;
    const retpc = this.m.r32(ssp + 2);
    if (this.trace) this.log(`SUPER arg=${arg.toString(16)} callerSuper=${callerSuper} ssp=${ssp.toString(16)} usp=${(this.cpu.usp >>> 0).toString(16)}`);
    // Drop the exception frame first.
    cpu.a[7] = ssp + 6;
    if (arg === 0) {
      if (callerSuper) { cpu.a[7] = ssp; return -1; }
      // user -> supervisor: SSP becomes the caller's USP, returns old SSP
      const oldSSP = (ssp + 6) >>> 0;
      cpu.a[7] = cpu.usp;
      cpu.setCCR(sr);
      cpu.ipl = (sr >> 8) & 7;
      cpu.pc = retpc;
      cpu.d[0] = oldSSP;
      return undefined;
    }
    // supervisor -> user: restore SSP to arg, USP = current stack
    cpu.ssp = arg;
    cpu.s = 0;
    cpu.a[7] = cpu.usp;
    cpu.setCCR(sr);
    cpu.ipl = (sr >> 8) & 7;
    cpu.pc = retpc;
    cpu.d[0] = 0;
    return undefined;
  }

  superJsr(sp) {
    // Call a subroutine in supervisor mode. We are already in supervisor mode
    // inside the exception; stack the frame and jump.
    const cpu = this.cpu;
    const addr = this.arg32(sp, 0);
    cpu.push32(HLE_SUPERJSR_RET);
    cpu.pc = addr;
    return undefined;
  }
  superJsrReturn() {
    const d0 = this.cpu.d[0];
    this.rte();
    this.cpu.d[0] = d0;
  }

  setVector(v, addr) {
    const old = this.getVector(v);
    if (v < 0x100) this.m.w32(v * 4, addr);
    else if (v < 0x200) this.m.w32(0x400 + (v - 0x100) * 4, addr);
    else if (v >= 0xff00) { (this.dosVec ??= new Map()).set(v, addr); }
    if (this.iocs && this.iocs.vectorChanged) this.iocs.vectorChanged(v, addr);
    return old;
  }
  getVector(v) {
    if (v < 0x100) return this.m.r32(v * 4);
    if (v < 0x200) return this.m.r32(0x400 + (v - 0x100) * 4);
    return this.dosVec?.get(v) ?? 0;
  }

  // ---- time -----------------------------------------------------------------
  now() { return this.clock ? this.clock() : new Date(); }
  getdate() {
    const d = this.now();
    return ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() | (d.getDay() << 16);
  }
  gettime() { const d = this.now(); return (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1); }
  gettim2() { const d = this.now(); return (d.getHours() << 16) | (d.getMinutes() << 8) | d.getSeconds(); }

  // ---- files ----------------------------------------------------------------
  allocHandle() { for (let h = 5; h < 96; h++) if (!this.files.has(h)) return h; return -1; }

  open(path, mode) {
    const p = path.replace(/[\0 ]+$/, '');
    const up = this.upper(p);
    if (up === 'CON' || up === 'NUL' || up === 'PRN' || up === 'AUX' || up === 'CLOCK') {
      const h = this.allocHandle(); this.files.set(h, { device: up, pos: 0 }); return h;
    }
    const r = this.lookup(p);
    if (r.err) return r.err;
    if (!r.node || r.node.isDir) { if (this.trace) this.log(`open fail ${p}`); return ERR.FILE_NOT_FOUND; }
    const h = this.allocHandle();
    if (h < 0) return ERR.TOO_MANY;
    this.files.set(h, { node: r.node, pos: 0, mode: mode & 3, path: p, drive: r.drive, parts: r.parts });
    this.log(`open ${displayName(p)} -> ${h} (${r.node.data.length} bytes)`);
    return h;
  }

  create(path, attr, newOnly) {
    const p = path.replace(/[\0 ]+$/, '');
    const { drive, parts } = this.parsePath(p);
    const disk = this.drives[drive];
    if (!disk) return ERR.BAD_DRIVE;
    const dir = disk.lookup(parts.slice(0, -1));
    if (!dir || !dir.isDir) return ERR.PATH_NOT_FOUND;
    const name = parts[parts.length - 1];
    let node = dir.children.get(name);
    if (node && newOnly) return ERR.EXISTS;
    if (node && node.isDir) return ERR.ACCESS;
    if (!node) {
      node = new (dir.constructor)(name, (attr & 0xff) | 0x20);
      dir.children.set(name, node);
    }
    node.data = new Uint8Array(0);
    const h = this.allocHandle();
    this.files.set(h, { node, pos: 0, mode: 2, path: p, drive, parts, dirty: true });
    this.log(`create ${displayName(p)} -> ${h}`);
    if (disk.onChange) disk.onChange(parts, node);
    return h;
  }

  close(h) {
    const f = this.files.get(h);
    if (!f) return h < 5 ? 0 : ERR.BAD_HANDLE;
    this.files.delete(h);
    if (f.dirty && this.drives[f.drive]?.onChange) this.drives[f.drive].onChange(f.parts, f.node);
    return 0;
  }

  read(h, buf, len) {
    if (h === 0) return 0;
    const f = this.files.get(h);
    if (!f) return ERR.BAD_HANDLE;
    if (f.device) return 0;
    const data = f.node.data;
    const n = Math.max(0, Math.min(len, data.length - f.pos));
    this.m.writeBytes(buf, data.subarray(f.pos, f.pos + n));
    f.pos += n;
    return n;
  }

  write(h, buf, len) {
    const bytes = this.m.readBytes(buf, len);
    return this.writeHandle(h, bytes);
  }

  writeFile(f, bytes) {
    const node = f.node;
    const end = f.pos + bytes.length;
    if (end > node.data.length) {
      const nd = new Uint8Array(end);
      nd.set(node.data);
      node.data = nd;
    }
    node.data.set(bytes, f.pos);
    f.pos = end;
    f.dirty = true;
    return bytes.length;
  }

  seek(h, off, mode) {
    const f = this.files.get(h);
    if (!f) return ERR.BAD_HANDLE;
    if (f.device) return 0;
    const len = f.node.data.length;
    let p = mode === 0 ? off : mode === 1 ? f.pos + off : len + off;
    if (p < 0 || p > len) return -25; // CANNOT_SEEK
    f.pos = p;
    return p;
  }

  del(path) {
    const { drive, parts } = this.parsePath(path);
    const disk = this.drives[drive];
    if (!disk) return ERR.BAD_DRIVE;
    const dir = disk.lookup(parts.slice(0, -1));
    const name = parts[parts.length - 1];
    if (!dir || !dir.children.has(name)) return ERR.FILE_NOT_FOUND;
    dir.children.delete(name);
    if (disk.onChange) disk.onChange(parts, null);
    return 0;
  }

  rename(from, to) {
    const a = this.parsePath(from), b = this.parsePath(to);
    const disk = this.drives[a.drive];
    if (!disk) return ERR.BAD_DRIVE;
    const dirA = disk.lookup(a.parts.slice(0, -1));
    const dirB = disk.lookup(b.parts.slice(0, -1));
    const na = a.parts[a.parts.length - 1], nb = b.parts[b.parts.length - 1];
    const node = dirA?.children.get(na);
    if (!node || !dirB) return ERR.FILE_NOT_FOUND;
    dirA.children.delete(na);
    node.name = nb;
    dirB.children.set(nb, node);
    if (disk.onChange) { disk.onChange(a.parts, null); disk.onChange(b.parts, node); }
    return 0;
  }

  chmod(path, attr) {
    const r = this.lookup(path);
    if (r.err) return r.err;
    if (!r.node) return ERR.FILE_NOT_FOUND;
    if (attr !== 0xffff && attr !== -1) r.node.attr = (r.node.attr & 0x10) | (attr & 0xef);
    return r.node.attr;
  }

  mkdir(path) {
    const { drive, parts } = this.parsePath(path);
    const disk = this.drives[drive];
    if (!disk) return ERR.BAD_DRIVE;
    const dir = disk.lookup(parts.slice(0, -1));
    if (!dir) return ERR.PATH_NOT_FOUND;
    const name = parts[parts.length - 1];
    if (dir.children.has(name)) return ERR.EXISTS;
    dir.children.set(name, new (dir.constructor)(name, 0x10));
    return 0;
  }

  chdir(path) {
    const { drive, parts } = this.parsePath(path);
    const disk = this.drives[drive];
    if (!disk) return ERR.BAD_DRIVE;
    const n = disk.lookup(parts);
    if (!n || !n.isDir) return ERR.PATH_NOT_FOUND;
    this.curDir[drive] = parts;
    return 0;
  }

  curdir(d, buf) {
    const drive = d === 0 ? this.curDrive : d - 1;
    if (!this.drives[drive]) return ERR.BAD_DRIVE;
    this.m.writeCString(buf, (this.curDir[drive] || []).join('\\'));
    return 0;
  }

  dup(h) {
    const f = this.files.get(h);
    const nh = this.allocHandle();
    if (h < 5 && !f) { this.files.set(nh, { device: 'CON', pos: 0 }); return nh; }
    if (!f) return ERR.BAD_HANDLE;
    this.files.set(nh, f);
    return nh;
  }
  dup2(h, nh) {
    const f = this.files.get(h);
    if (!f) return h < 5 ? 0 : ERR.BAD_HANDLE;
    this.files.set(nh, f);
    return 0;
  }

  ioctrl(sp) {
    const mode = this.arg16(sp, 0);
    const h = this.arg16(sp, 2);
    switch (mode) {
      case 0: { // get device info
        if (h < 5) return 0x80 | (h === 0 ? 1 : 2);
        const f = this.files.get(h);
        if (!f) return ERR.BAD_HANDLE;
        return f.device ? 0x80 : (f.drive & 0x1f);
      }
      case 6: return -1; // input ready
      case 7: return -1; // output ready
      case 9: return 0;
      case 10: return 0;
    }
    return 0;
  }

  filedate(h, v) {
    const f = this.files.get(h);
    if (!f || !f.node) return ERR.BAD_HANDLE;
    if (v === 0) return (f.node.date << 16) | f.node.time;
    f.node.date = v >>> 16; f.node.time = v & 0xffff;
    return 0;
  }

  nameck(src, buf) {
    const p = this.str(src);
    const { drive, parts } = this.parsePath(p);
    const m = this.m;
    const last = parts.length ? parts[parts.length - 1] : '';
    const dir = parts.slice(0, -1);
    m.w8(buf, 0x41 + drive); m.w8(buf + 1, 0x3a);
    let path = '\\' + dir.join('\\') + (dir.length ? '\\' : '');
    for (let i = 0; i < 65; i++) m.w8(buf + 2 + i, i < path.length ? path.charCodeAt(i) : 0);
    const dot = last.lastIndexOf('.');
    const base = dot >= 0 ? last.slice(0, dot) : last;
    const ext = dot >= 0 ? last.slice(dot) : '';
    for (let i = 0; i < 19; i++) m.w8(buf + 67 + i, i < base.length ? base.charCodeAt(i) : 0);
    for (let i = 0; i < 5; i++) m.w8(buf + 86 + i, i < ext.length ? ext.charCodeAt(i) : 0);
    return /[*?]/.test(last) ? 1 : 0;
  }

  getenv(sp) {
    const name = this.str(this.arg32(sp, 0)).toLowerCase();
    let env = this.arg32(sp, 4);
    const buf = this.arg32(sp, 8);
    if (!env) env = this.env;
    let a = env + 4;
    for (;;) {
      const s = this.str(a);
      if (!s) break;
      const i = s.indexOf('=');
      if (s.slice(0, i).toLowerCase() === name) { this.m.writeCString(buf, s.slice(i + 1)); return 0; }
      a += s.length + 1;
    }
    return -10;
  }

  // FILES / NFILES -------------------------------------------------------------
  matchWild(pat, name) {
    const split = (s) => { const i = s.lastIndexOf('.'); return i >= 0 ? [s.slice(0, i), s.slice(i + 1)] : [s, '']; };
    const [pb, pe] = split(pat), [nb, ne] = split(name);
    const m1 = (p, n, len) => {
      for (let i = 0; i < len; i++) {
        const pc = p[i] ?? ' ', nc = n[i] ?? ' ';
        if (pc === '*') return true;
        if (pc === '?') continue;
        if (pc !== nc) return false;
      }
      return true;
    };
    return m1(pb, nb, 18) && m1(pe, ne, 3);
  }

  files_(buf, path, attr) {
    const { drive, parts } = this.parsePath(path);
    let disk = this.drives[drive];
    if (!disk) return ERR.BAD_DRIVE;
    const pat = parts.pop() || '*.*';
    if (this.onLookup) this.onLookup(drive, [...parts, pat]);
    let dir = disk.lookup(parts);
    if ((!dir || !dir.isDir || ![...dir.children.values()].some((n) => this.matchWild(pat, n.name))) && this.onMissingFile && !/[*?]/.test(pat)) {
      if (this.onMissingFile(drive, [...parts, pat])) { disk = this.drives[drive]; dir = disk.lookup(parts); }
    }
    if (!dir || !dir.isDir) return ERR.PATH_NOT_FOUND;
    const list = [...dir.children.values()].filter((n) => {
      if (!this.matchWild(pat, n.name)) return false;
      if (n.attr & 0x10) return (attr & 0x10) !== 0;
      if ((n.attr & 0x06) && !(attr & (n.attr & 0x06))) return false;
      return true;
    });
    if (attr & 0x08) list.unshift({ name: 'VOLUME', attr: 0x08, data: new Uint8Array(0), time: 0, date: 0 });
    this.findState.set(buf, { list, i: 0 });
    return this.nfiles(buf);
  }

  nfiles(buf) {
    const st = this.findState.get(buf);
    if (!st || st.i >= st.list.length) return ERR.NO_MORE;
    const n = st.list[st.i++];
    const m = this.m;
    m.w8(buf + 21, n.attr);
    m.w16(buf + 22, n.time); m.w16(buf + 24, n.date);
    m.w32(buf + 26, n.data ? n.data.length : 0);
    for (let i = 0; i < 23; i++) m.w8(buf + 30 + i, i < n.name.length ? n.name.charCodeAt(i) : 0);
    return 0;
  }

  // ---- memory calls ---------------------------------------------------------
  malloc(size, mode) {
    if (size >= 0xffffff) return 0x81000000 | (this.largestFree() & 0xffffff);
    const a = this.allocRaw(size, this.curPSP, mode);
    if (!a) return (0x81000000 | (this.largestFree() & 0xffffff)) | 0;
    return a + 16;
  }

  mfree(addr) {
    if (addr === 0) {
      // free all blocks owned by the current process
      this.blocks = this.blocks.filter((b) => b.owner !== this.curPSP || b.addr === this.curPSP);
      this.syncBlocks();
      return 0;
    }
    const i = this.blocks.findIndex((b) => b.addr === addr - 16);
    if (i < 0) return ERR.BAD_ADDR;
    this.blocks.splice(i, 1);
    this.syncBlocks();
    return 0;
  }

  setblock(addr, size) {
    const b = this.blocks.find((x) => x.addr === addr - 16);
    if (!b) return ERR.BAD_ADDR;
    const nextStart = Math.min(this.memEnd, ...this.blocks.filter((x) => x.addr > b.addr).map((x) => x.addr));
    const want = ((size + 16 + 15) & ~15);
    const max = nextStart - b.addr;
    if (size >= 0xffffff) return 0x81000000 | ((max - 16) & 0xffffff);
    if (want > max) return 0x81000000 | ((max - 16) & 0xffffff);
    b.end = b.addr + want;
    this.syncBlocks();
    return 0;
  }

  // ---- processes --------------------------------------------------------------
  // Load an X/R executable into a fresh process. Returns {psp, entry} or error.
  loadProgram(path, cmdline, envp, parentPSP) {
    const r = this.lookup(path);
    if (r.err) return { err: r.err };
    if (!r.node || r.node.isDir) return { err: ERR.FILE_NOT_FOUND };
    const img = r.node.data;
    // Take the largest free block
    const size = this.largestFree();
    const psp = this.allocRaw(size, parentPSP);
    if (!psp) return { err: ERR.NO_MEM };
    this.blocks.find((b) => b.addr === psp).owner = parentPSP;
    const m = this.m;
    const blockEnd = m.r32(psp + 8);
    for (let i = 16; i < 256; i++) m.w8(psp + i, 0);
    const base = psp + 0x100;
    let entry, end, bssStart;
    const isX = img[0] === 0x48 && img[1] === 0x55;
    if (isX) {
      const dv = new DataView(img.buffer, img.byteOffset, img.byteLength);
      const baseAddr = dv.getUint32(4);
      const exec = dv.getUint32(8);
      const text = dv.getUint32(12), data = dv.getUint32(16), bss = dv.getUint32(20);
      const rel = dv.getUint32(24);
      const body = img.subarray(64, 64 + text + data);
      if (base + text + data + bss > blockEnd) return { err: ERR.NO_MEM };
      m.writeBytes(base, body);
      for (let i = 0; i < bss; i++) m.w8(base + text + data + i, 0);
      // relocation
      const relTab = img.subarray(64 + text + data, 64 + text + data + rel);
      const delta = (base - baseAddr) | 0;
      let p = base;
      for (let i = 0; i < relTab.length;) {
        let d = (relTab[i] << 8) | relTab[i + 1]; i += 2;
        if (d === 1) { d = (relTab[i] << 24) | (relTab[i + 1] << 16) | (relTab[i + 2] << 8) | relTab[i + 3]; i += 4; }
        let isWord = false;
        if (d & 1) { isWord = true; d &= ~1; }
        p += d;
        if (isWord) m.w16(p, m.r16(p) + delta);
        else m.w32(p, m.r32(p) + delta);
      }
      entry = base + exec - baseAddr;
      bssStart = base + text + data;
      end = bssStart + bss;
    } else {
      // .R image: raw binary, starts at offset 0
      m.writeBytes(base, img);
      entry = base;
      bssStart = end = base + img.length;
    }
    m.w32(psp + 0x10, envp || this.env);
    m.w32(psp + 0x20, cmdline);
    m.w32(psp + 0x30, bssStart);
    m.w32(psp + 0x34, end);
    m.w32(psp + 0x38, end);
    // drive and file name
    const pathStr = String.fromCharCode(0x41 + r.drive) + ':\\' + r.parts.slice(0, -1).map((x) => x + '\\').join('');
    for (let i = 0; i < pathStr.length; i++) m.w8(psp + 0x80 + i, pathStr.charCodeAt(i));
    const fname = r.parts[r.parts.length - 1];
    for (let i = 0; i < fname.length; i++) m.w8(psp + 0xc4 + i, fname.charCodeAt(i));
    if (this.onProgramLoad) this.onProgramLoad(fname, psp, base);
    this.log(`loaded ${displayName(path)} psp=${psp.toString(16)} entry=${entry.toString(16)} end=${end.toString(16)} block_end=${blockEnd.toString(16)}`);
    return { psp, entry, end, blockEnd };
  }

  // Start the very first program (no parent).
  start(path, args = '') {
    const cmd = this.allocRaw(0x100, 0);
    this.m.w8(cmd + 16, args.length);
    this.m.writeCString(cmd + 17, args);
    const r = this.loadProgram(path, cmd + 16, this.env, 0);
    if (r.err) throw new Error(`cannot load ${path}: ${r.err}`);
    this.enterProcess(r, cmd + 16);
  }

  enterProcess(r, cmdline) {
    const cpu = this.cpu;
    const ssp = (this.procStack.length ? cpu.getSSP() : 0x2000);
    this.curPSP = r.psp;
    this.m.w32(r.psp + 4, this.procStack.length ? this.procStack[this.procStack.length - 1].psp : 0);
    for (let i = 0; i < 8; i++) { cpu.d[i] = 0; cpu.a[i] = 0; }
    cpu.a[0] = r.psp;
    cpu.a[1] = r.end;
    cpu.a[2] = cmdline;
    cpu.a[3] = this.m.r32(r.psp + 0x10);
    cpu.a[4] = r.entry;
    // user mode, stack at the end of the block
    cpu.s = 1; cpu.a[7] = ssp;
    cpu.setSR(0x0000);
    cpu.a[7] = r.blockEnd;
    cpu.usp = r.blockEnd;
    cpu.ssp = ssp;
    cpu.pc = r.entry;
    this.log(`enter process ssp=${(cpu.ssp >>> 0).toString(16)} usp=${(cpu.a[7] >>> 0).toString(16)} s=${cpu.s}`);
    // returning from main with RTS exits
    cpu.push32(HLE_EXIT);
  }

  exec(sp, ssp, sr) {
    const m = this.m, cpu = this.cpu;
    const mode = this.arg16(sp, 0) & 0xff;
    const file = this.arg32(sp, 2);
    const cmdline = this.arg32(sp, 6);
    const envp = this.arg32(sp, 10);
    if (mode === 2) { // path search: split "file args" in-place
      const s = this.str(file);
      const i = s.indexOf(' ');
      const name = i >= 0 ? s.slice(0, i) : s;
      const rest = i >= 0 ? s.slice(i + 1) : '';
      m.writeCString(file, name);
      m.w8(cmdline, rest.length);
      m.writeCString(cmdline + 1, rest);
      return 0;
    }
    if (mode === 3) { // load only, at given address
      const r = this.lookup(this.str(file));
      if (!r.node) return ERR.FILE_NOT_FOUND;
      return ERR.INVALID_FUNC;
    }
    if (mode !== 0 && mode !== 1) return ERR.INVALID_FUNC;
    let path = this.str(file);
    if (!/\.[xXrR]$/.test(path) && !this.lookup(path).node) {
      if (this.lookup(path + '.X').node) path += '.X';
      else if (this.lookup(path + '.R').node) path += '.R';
    }
    const r = this.loadProgram(path, cmdline, envp, this.curPSP);
    if (r.err) return r.err;
    if (mode === 1) {
      // load only: return entry in d0, psp in a0 etc.
      cpu.a[0] = r.psp; cpu.a[1] = r.end; cpu.a[4] = r.entry;
      return r.entry;
    }
    // Save parent context
    const ctx = {
      d: Int32Array.from(cpu.d), a: Int32Array.from(cpu.a),
      usp: cpu.usp, ssp: ssp + 6, sr, pc: m.r32(ssp + 2), psp: this.curPSP,
      files: new Map(this.files),
    };
    this.procStack.push(ctx);
    cpu.a[7] = ssp + 6;
    this.enterProcess(r, cmdline);
    return undefined;
  }

  exitProcess(code, keep, keepSize = 0) {
    const cpu = this.cpu;
    const psp = this.curPSP;
    if (keep) {
      const b = this.blocks.find((x) => x.addr === psp);
      if (b) { b.end = psp + 0x100 + ((keepSize + 15) & ~15); b.owner = 0xff000000 | 0; b.resident = true; }
      this.syncBlocks();
    } else {
      this.blocks = this.blocks.filter((b) => b.addr !== psp && b.owner !== psp);
      this.syncBlocks();
    }
    if (this.onProgramExit) this.onProgramExit(psp);
    this.log(`process ${psp.toString(16)} exit code=${code}${keep ? ' (resident)' : ''}`);
    this.lastExit = code;
    const ctx = this.procStack.pop();
    if (!ctx) { this.halt('exit'); this.exitCode = code; return; }
    // close files opened by the child
    for (const [h, f] of this.files) if (!ctx.files.has(h)) this.close(h);
    cpu.d.set(ctx.d); cpu.a.set(ctx.a);
    cpu.s = 1;
    cpu.a[7] = ctx.ssp;
    cpu.usp = ctx.usp;
    cpu.setSR(ctx.sr);
    if (ctx.sr & 0x2000) cpu.a[7] = ctx.ssp;
    cpu.pc = ctx.pc;
    cpu.d[0] = code;
    this.curPSP = ctx.psp;
  }
}
