// The whole machine: CPU, memory map, devices, OS layer and frame timing.

import { Machine } from './machine.js';
import { Human68k, ROM_BASE } from './human68k.js';
import { IOCS } from './iocs.js';
import { Video, RGB } from './video.js';
import { MFP } from './mfp.js';
import { OPM } from './opm.js';
import { ADPCM } from './adpcm.js';
import { DMAC } from './dmac.js';
import { Font } from './font.js';

export const CPU_CLOCK = 10000000;

export class X68k {
  constructor(opts = {}) {
    this.log = opts.log ?? (() => {});
    this.m = new Machine({ ramSize: opts.ramSize ?? 0x200000, log: this.log });
    this.cpu = this.m.cpu;
    this.video = new Video(this);
    this.mfp = new MFP(this);
    this.opm = new OPM();
    this.adpcm = new ADPCM(this);
    this.dmac = new DMAC(this);
    this.font = opts.font ?? new Font();
    this.sysport = { contrast: 15 };
    this.joy = [0xff, 0xff];
    // Wall clock seen by the game. Tests pass a fixed `epoch` (ms) so that the
    // game's clock-seeded randomness repeats exactly from run to run.
    this.epoch = opts.epoch ?? null;
    this.timeBase = this.epoch ?? Date.now();
    this.emuTime = 0;          // seconds of emulated time
    this.frameCount = 0;
    this.audioRate = opts.audioRate ?? 48000;
    this.audioAcc = 0;
    this.audioOut = opts.audioOut ?? null; // function(Float32Array interleaved stereo)
    this.opm.setSampleRate(this.audioRate);
    this.adpcm.sampleRate = this.audioRate;
    this.audioBuf = new Float32Array(8192);

    this.human = new Human68k(this.m, { log: opts.dosLog ?? this.log, console: opts.console ?? (() => {}),
      onMissingFile: (drive, parts) => this.findOnOtherDisk(drive, parts) });
    this.human.onLookup = (drive, parts) => this.noteLookup(drive, parts);
    // fn(name, psp, base) for every program the DOS layer loads
    this.loadListeners = [];
    this.human.onProgramLoad = (name, psp, base) => { for (const f of this.loadListeners) f(name, psp, base); };
    this.human.clock = () => this.now();
    this.lastMarker = [];
    this.iocs = new IOCS(this);
    this.consoleEcho = opts.console ?? null;
    this.human.iocs = this.iocs;

    const m = this.m;
    this.video.install(m);
    this.mfp.install(m);
    this.opm.install(m);
    this.adpcm.install(m);
    this.dmac.install(m);
    this.font.install(m);
    this.installMisc(m);

    this.opm.onIrq = (irq) => this.mfp.setGPIP(3, irq ? 0 : 1);
    this.opm.onCT = (ct1) => { this.adpcm.clock8 = ct1 ? 0 : 1; };
    this.cpu.irqVector = (level) => {
      if (level === 6) return this.mfp.acknowledge();
      if (level === 3) return this.dmac.acknowledge();
      return -1;
    };
    this.disks = opts.disks ?? [];
    this.dataDrive = 1;
  }

  installMisc(m) {
    const sys = this;
    // system port
    m.map(0xe8e000, 0xe90000, {
      read8: (a) => {
        switch (a & 0x1f) {
          case 0x01: return 0xf0 | sys.sysport.contrast;
          case 0x0b: return 0xff;  // 68000, 10 MHz
          default: return 0xff;
        }
      },
      write8: (a, d) => {
        if ((a & 0x1f) === 0x01) sys.sysport.contrast = d & 15;
      },
    });
    // RTC RP5C15
    m.map(0xe8a000, 0xe8c000, {
      read8: (a) => {
        if (!(a & 1)) return 0xff;
        const r = (a >> 1) & 15;
        const d = sys.now();
        const v = [d.getSeconds() % 10, (d.getSeconds() / 10) | 0, d.getMinutes() % 10, (d.getMinutes() / 10) | 0,
          d.getHours() % 10, (d.getHours() / 10) | 0, d.getDay(), d.getDate() % 10, (d.getDate() / 10) | 0,
          (d.getMonth() + 1) % 10, ((d.getMonth() + 1) / 10) | 0, (d.getFullYear() - 1980) % 10,
          ((d.getFullYear() - 1980) / 10) | 0, 0, 0, 0][r];
        return 0xf0 | v;
      },
      write8: () => {},
    });
    // printer, SCC (mouse), FDC, HDD, I/O interrupt controller: idle stubs
    const idle = { read8: () => 0xff, write8: () => {} };
    m.map(0xe8c000, 0xe8e000, idle);
    m.map(0xe94000, 0xe96000, { read8: (a) => (a & 3) === 1 ? 0x80 : 0x00, write8: () => {} });
    m.map(0xe96000, 0xe98000, idle);
    m.map(0xe98000, 0xe9a000, { read8: () => 0x04, write8: () => {} });
    m.map(0xe9c000, 0xe9e000, { read8: () => 0x00, write8: () => {} });
    m.map(0xe86000, 0xe88000, idle);
    m.map(0xea0000, 0xeb0000, idle);  // SCSI / expansion
    m.map(0xec0000, 0xed0000, idle);  // user I/O
    // PPI 8255: joystick + ADPCM control
    this.ppiC = 0x0b;
    m.map(0xe9a000, 0xe9c000, {
      read8: (a) => {
        switch (a & 7) {
          case 1: return sys.joy[0];
          case 3: return sys.joy[1];
          case 5: return sys.ppiC;
          default: return 0xff;
        }
      },
      write8: (a, d) => {
        if ((a & 7) === 5) sys.setPPIC(d);
        else if ((a & 7) === 7) {
          if (!(d & 0x80)) {
            const bit = (d >> 1) & 7;
            sys.setPPIC(d & 1 ? sys.ppiC | (1 << bit) : sys.ppiC & ~(1 << bit));
          }
        }
      },
    });
    // SRAM
    this.sram = new Uint8Array(0x4000);
    const magic = [0x82, 0x77, 0x36, 0x38, 0x30, 0x30, 0x30, 0x57];
    magic.forEach((b, i) => { this.sram[i] = b; });
    const put32 = (o, v) => { this.sram[o] = v >>> 24; this.sram[o + 1] = v >>> 16; this.sram[o + 2] = v >>> 8; this.sram[o + 3] = v; };
    put32(8, this.m.ramSize);
    put32(0x0c, 0x00fc0000);
    put32(0x10, 0x00ed0100);
    this.sram[0x1d] = 16;
    m.map(0xed0000, 0xee0000, {
      read8: (a) => this.sram[(a - 0xed0000) & 0x3fff],
      write8: (a, d) => { this.sram[(a - 0xed0000) & 0x3fff] = d; },
    });
    m.map(0xee0000, 0xf00000, idle);
    // ROM area (HLE entry points are intercepted on instruction fetch)
    m.map(0xfc0000, 0x1000000, {
      read8: (a) => {
        if (a >= 0xfffff0) return 0;
        return 0xff;
      },
      write8: () => {},
    });
  }

  // Hook points: fn(cpu) runs before the instruction at `addr`, whether that
  // code is interpreted or translated (translated code calls R.at(addr)).
  // Several hooks at one address run in the order they were added.
  addHook(addr, fn) {
    this.hookFns ??= new Map();
    const prev = this.hookFns.get(addr);
    this.hookFns.set(addr, prev ? (c) => { prev(c); fn(c); } : fn);
    const c = this.cpu;
    if (!c.hooks) { c.hooks = new Uint8Array(0x1000000); c.onHook = (pc) => this.runHook(pc); }
    c.hooks[addr] = 1;
  }
  runHook(addr) { const f = this.hookFns && this.hookFns.get(addr); if (f) f(this.cpu); }

  // Name of the running program (from its process block), e.g. "ICITY68.X".
  programName() { return this.m.readCString(this.human.curPSP + 0xc4, 16).toUpperCase(); }

  setAudioRate(rate) {
    this.audioRate = rate;
    this.opm.setSampleRate(rate);
    this.adpcm.sampleRate = rate;
  }

  setPPIC(d) {
    this.ppiC = d & 0xff;
    this.adpcm.pan = d & 3;
    this.adpcm.divider = (d >> 2) & 3;
  }

  joystick(n) { return this.joy[n & 1]; }

  updateIrq() {
    let level = 0;
    if (this.mfp.pendingChannel() >= 0) level = 6;
    else if (this.dmac.irqPending >= 0) level = 3;
    this.cpu.pendingIrq = level;
  }

  rasterChanged() {}

  now() { return this.epoch !== null ? new Date(this.epoch + this.emuTime * 1000) : new Date(); }

  timeMs() { return this.emuTime * 1000 + (this.timeBase % 86400000); }

  // ---- boot ---------------------------------------------------------------------------
  // Use translated JavaScript functions for a program when it is loaded at the
  // address the translation was generated for. `recomp` is
  // { name, base, functions: Map, allow: Set } (see src/recomp/gen/).
  attachRecomp(runtime, recomp) {
    this.recomp = { runtime, ...recomp, armed: false };
    for (const [a, f] of recomp.functions) runtime.define(a, f);
    const h = this.human;
    // The executable unpacks itself after loading; arm on its first DOS call,
    // once the code in memory matches the translation's signature.
    this.loadListeners.push((name, psp, base) => {
      const r = this.recomp;
      r.pending = name.toUpperCase() === r.name && base === r.base ? psp : false;
    });
    h.onDosCall = () => {
      const r = this.recomp;
      if (!r.pending || r.pending !== h.curPSP) return;
      r.pending = false;
      const ok = (r.signature ?? []).every(([a, bytes]) => bytes.every((b, k) => this.m.r8(a + k) === b));
      if (!ok) { this.log(`recomp: ${r.name} in memory does not match the translation; staying interpreted`); return; }
      for (const a of r.allow) runtime.enable(a);
      r.armed = h.curPSP;
      this.log(`recomp: ${r.allow.size} translated functions active for ${r.name}`);
    };
    h.onProgramExit = (psp) => {
      const r = this.recomp;
      if (r.armed !== psp) return;
      for (const a of r.allow) runtime.enable(a, false);
      r.armed = false;
    };
  }

  boot(commands) {
    const h = this.human;
    h.mount(0, this.disks[0]);
    if (this.disks[1]) h.mount(1, this.disks[1]);
    h.install();
    this.defaultVector = this.m.r32(0x40 * 4);
    // MFP setup as left by the IPL: vector base 0x40, auto end-of-interrupt
    this.mfp.vr = 0x40;
    this.mfp.aer = 0x06;
    // The IPL leaves the ADPCM DMA channel counting through memory (SCR memory-address
    // count up). ZMUSIC never writes SCR, so with 0 every sample replays its first byte.
    this.dmac.ch[3].scr = 0x04;
    this.iocs.crtmod(16);
    this.commands = [...commands];
    this.nextCommand();
  }

  nextCommand() {
    const h = this.human;
    if (!this.commands.length) return false;
    const [prog, args] = this.commands.shift();
    if (/^[A-Za-z]:$/.test(prog)) {   // "B:" style drive change, as typed at the shell
      h.curDrive = (prog.charCodeAt(0) | 0x20) - 0x61;
      return this.nextCommand();
    }
    h.halted = undefined;
    this.cpu.stopped = false;
    h.start(prog, args ?? '');
    return true;
  }

  // Called when the top-level process exits.
  checkProcess() {
    if (this.human.halted === 'exit') {
      this.log(`top-level process exited (${this.human.exitCode})`);
      if (!this.nextCommand()) this.finished = true;
    }
  }

  // ---- disk swapping ----------------------------------------------------------------------
  // The game identifies disks by marker files ICITY_0..ICITY_6. To find out
  // which disk is inserted it probes ICITY_8, ICITY_7, ... downwards; a probe
  // must see the disk that is really there, so swaps are suppressed while one
  // is in progress. A lone check for ICITY_n means "disk n is required".
  noteLookup(drive, parts) {
    const m = /^ICITY_(\d)$/.exec(parts[parts.length - 1] ?? '');
    const n = m ? Number(m[1]) : -1;
    const prev = this.lastMarker[drive] ?? -1;
    this.probing ??= [];
    if (n >= 7) this.probing[drive] = true;
    else if (n < 0 || n !== prev - 1) this.probing[drive] = false;
    this.lastMarker[drive] = n;
    // A probe stops at the first marker it finds.
    if (n >= 0 && this.probing[drive] && this.human.drives[drive]?.lookup(parts)) {
      this.probing[drive] = false;
      this.lastMarker[drive] = -1;
    }
  }

  findOnOtherDisk(drive, parts) {
    if (drive < 1 || this.disks.length < 3) return false;
    if (this.probing && this.probing[drive]) return false;
    const cur = this.human.drives[drive];
    for (let i = 1; i < this.disks.length; i++) {
      const d = this.disks[i];
      if (d === cur) continue;
      if (d.lookup(parts)) {
        this.log(`disk swap: drive ${String.fromCharCode(65 + drive)}: <- ${d.label} (needed ${parts.join('\\')})`);
        this.human.drives[drive] = d;
        if (this.onDiskSwap) this.onDiskSwap(drive, i);
        return true;
      }
    }
    return false;
  }

  // ---- input --------------------------------------------------------------------------------
  keyEvent(code, down) {
    this.iocs.keyEvent(code, down);
    if (this.m.r32(0x4c * 4) !== this.defaultVector) this.mfp.receive(code | (down ? 0 : 0x80));
  }

  // ---- main loop ----------------------------------------------------------------------------
  runFrame() {
    const v = this.video, cpu = this.cpu, mfp = this.mfp;
    v.beginFrame();
    const g = v.geo;
    const lineSec = g.hf ? 1 / 31500 : 1 / 15980;
    const lineCycles = CPU_CLOCK * lineSec;
    const dispStart = g.vstart, dispEnd = g.vstart + g.lines;
    let cycleDebt = 0;
    for (let line = 0; line < g.vtotal; line++) {
      if (line === dispStart) mfp.setGPIP(4, 1);
      if (line === dispEnd) {
        mfp.setGPIP(4, 0);
        mfp.eventCount(0);
        if (v.fastClearPending) v.doFastClear();
      }
      mfp.setGPIP(6, (line === (v.crtc[9] & 1023)) ? 0 : 1);
      // H-sync: low during the active part of the line, high in the blank
      mfp.setGPIP(7, 0);
      cycleDebt += lineCycles * 0.85;
      const start = cpu.cycles;
      cpu.run(cycleDebt);
      cycleDebt -= cpu.cycles - start;
      mfp.setGPIP(7, 1);
      cycleDebt += lineCycles * 0.15;
      const s2 = cpu.cycles;
      cpu.run(cycleDebt);
      cycleDebt -= cpu.cycles - s2;
      mfp.tick(lineSec * 4000000);
      this.opm.tickTimers(lineSec);
      if (line >= dispStart && line < dispEnd) {
        const idx = line - dispStart;
        if (g.doubled) { if (!(idx & 1)) v.renderLine(idx >> 1); }
        else v.renderLine(idx);
      }
      this.emuTime += lineSec;
      this.audioAcc += this.audioRate * lineSec;
      if (this.audioAcc >= 64) this.flushAudio();
      if (this.human.halted) { this.checkProcess(); if (this.finished) break; }
    }
    this.flushAudio();
    this.frameCount++;
    this.applyContrast();
  }

  flushAudio() {
    const n = Math.floor(this.audioAcc);
    if (n <= 0) return;
    this.audioAcc -= n;
    const buf = n * 2 <= this.audioBuf.length ? this.audioBuf.subarray(0, n * 2) : new Float32Array(n * 2);
    buf.fill(0);
    this.opm.render(buf, 0, n);
    this.adpcm.render(buf, 0, n);
    if (this.audioOut) this.audioOut(buf);
  }

  applyContrast() {
    const c = this.sysport.contrast & 15;
    if (c === 15) return;
    const f = this.video.frame;
    const n = this.video.frameW * this.video.frameH;
    const k = c / 15;
    for (let i = 0; i < n; i++) {
      const p = f[i];
      const r = (p & 0xff) * k, gg = ((p >> 8) & 0xff) * k, b = ((p >> 16) & 0xff) * k;
      f[i] = (0xff000000 | (b << 16) | (gg << 8) | r) >>> 0;
    }
  }

  // Draw the IOCS mouse cursor on top of the frame (not part of VRAM).
  drawCursor(target, w, h) {
    const ms = this.iocs.mouse;
    if (!ms.cursor) return;
    const shape = [
      'X...........', 'XX..........', 'XWX.........', 'XWWX........', 'XWWWX.......', 'XWWWWX......',
      'XWWWWWX.....', 'XWWWWWWX....', 'XWWWWWWWX...', 'XWWWWWWWWX..', 'XWWWWWXXXXX.', 'XWWXWWX.....',
      'XWX.XWWX....', 'XX..XWWX....', 'X....XWWX...', '.....XWWX...', '......XX....',
    ];
    const crtc = this.video.crtc;
    const ox = (ms.x - (crtc[10] & 1023)) & 1023, oy = (ms.y - (crtc[11] & 1023)) & 1023;
    for (let y = 0; y < shape.length; y++) for (let x = 0; x < 12; x++) {
      const c = shape[y][x];
      if (c === '.') continue;
      const px = ox + x, py = oy + y;
      if (px < 0 || py < 0 || px >= w || py >= h) continue;
      target[py * w + px] = c === 'X' ? 0xff000000 : 0xffffffff;
    }
  }
}

export { RGB, ROM_BASE };
