// Run the emulator and log what a cutscene program does, frame by frame:
//  - its drawing primitives (hooks in programs.mjs): PIC/GRP loads, blits, wipe passes, waits,
//    palette-fade setups, narration scripts;
//  - generic machine activity: DOS file opens/reads/writes, IOCS calls (fill, contrast, text
//    console, CRTMOD...), ZMUSIC trap #3 calls, CRTC and video-controller register writes, and at
//    the end of every frame the palette/contrast changes.
// The event list is what tools/export/cutscenes/replay.mjs replays (and checks against the
// emulator's graphic VRAM).
import fs from 'node:fs';
import { X68k } from '../../../src/x68k.js';
import { Font } from '../../../src/font.js';
import { loadDisks, root } from '../common.mjs';
import { PROGRAMS } from './programs.mjs';

const sjis = new TextDecoder('shift_jis');
export const EPOCH = Date.UTC(1993, 4, 24, 12, 0, 0);

export function makeMachine() {
  const cg = `${root}/work/cgrom.bin`;
  const log = [];
  const sys = new X68k({ epoch: EPOCH, disks: loadDisks(), font: new Font(fs.existsSync(cg) ? new Uint8Array(fs.readFileSync(cg)) : null), log: (s) => log.push(`[${sys.frameCount}] ${s}`) });
  sys.machineLog = log;
  return sys;
}

// Boot paths. 'menu': ZMUSIC, LOAD (-> MENU68 -> IL_OPEN/ICITY68), like AUTOEXEC.BAT.
// 'ending': ZMUSIC, then IL_END.X from drive B: (disk 7), as LOAD.X runs it after ICITY68 exits.
export function boot(sys, how) {
  if (how === 'ending') {
    sys.boot([['A:\\ZMUSIC.X', '-U -BICITY.ZPD'], ['B:', ''], ['B:\\IL_END.X', '']]);
    sys.human.mount(1, loadDisks()[6]);
  } else sys.boot([['A:\\ZMUSIC.X', '-U -BICITY.ZPD'], ['A:\\LOAD.X', '']]);
}

export function applyInput(sys, script, f) {
  for (const ev of script) {
    if (ev.frame !== f) continue;
    if (ev.mouse) sys.iocs.mouseMove(ev.mouse[0], ev.mouse[1]);
    if (ev.down !== undefined) sys.iocs.mouseButton(ev.down, true);
    if (ev.up !== undefined) sys.iocs.mouseButton(ev.up, false);
    if (ev.key !== undefined) sys.keyEvent(ev.key, true);
    if (ev.keyup !== undefined) sys.keyEvent(ev.keyup, false);
  }
}

const hex = (v, n = 4) => (v >>> 0).toString(16).padStart(n, '0');
// DOS path strings reach src/human68k.js as one JS character per byte: decode them as Shift-JIS
// (IMUS\ﾃｰﾏB.ZMD has half-width katakana).
const fname = (p) => sjis.decode(Uint8Array.from([...p].map((c) => c.charCodeAt(0) & 0xff)));

export class Recorder {
  constructor(sys, opts = {}) {
    this.sys = sys;
    this.events = [];
    this.only = opts.programs ?? null;    // record only while one of these programs runs (null: always)
    this.listeners = [];                  // fn(event) called as events are produced (replay in lockstep)
    this.problems = [];
    this.bases = new Map();
    this.fds = new Map();
    this.buffers = new Map();             // RAM address -> file name last read there (music data)
    this.iocsCounts = new Map();
    this.prevPal = new Uint16Array(32).fill(0xffff);
    this.prevContrast = -1;
    this.install();
  }

  get f() { return this.sys.frameCount; }
  active() { return !this.only || this.only.has(this.sys.programName()); }
  emit(ev, force = false) {
    if (!force && !this.active()) return;
    const e = { f: this.f, ...ev, prog: this.sys.programName() };
    this.events.push(e);
    for (const l of this.listeners) l(e);
  }
  problem(s) { this.problems.push(`f${this.f}: ${s}`); }

  install() {
    const sys = this.sys, h = sys.human, v = sys.video, m = sys.m, io = sys.iocs;
    // ---- DOS files
    const open = h.open.bind(h), read = h.read.bind(h), write = h.write.bind(h), create = h.create.bind(h);
    h.open = (p, mode) => { const r = open(p, mode); if (r >= 0) this.fds.set(r, fname(p)); this.emit({ op: 'open', file: fname(p), ok: r >= 0 }); return r; };
    h.create = (p, a, n) => { const r = create(p, a, n); if (r >= 0) this.fds.set(r, fname(p)); this.emit({ op: 'create', file: fname(p), ok: r >= 0 }); return r; };
    h.read = (fd, buf, n) => {
      const r = read(fd, buf, n);
      const file = this.fds.get(fd) ?? `fd${fd}`;
      if (r > 0) this.buffers.set(buf >>> 0, { file, end: (buf >>> 0) + r });
      this.emit({ op: 'read', file, dest: hex(buf, 6), bytes: r });
      return r;
    };
    h.write = (fd, buf, n) => {
      const file = this.fds.get(fd) ?? `fd${fd}`;
      const bytes = [];
      if (fd > 2) for (let i = 0; i < Math.min(n, 64); i++) bytes.push(hex(m.r8(buf + i), 2));
      this.emit({ op: 'write', file, bytes: n, data: bytes.join('') || undefined });
      return write(fd, buf, n);
    };
    // ---- program loads: install the program's hooks
    sys.loadListeners.push((name, psp, base) => {
      name = name.toUpperCase().replace(/^.*[\\:]/, '');
      this.bases.set(name, base);
      this.emit({ op: 'program', name, base: hex(base, 6) }, true);
      this.hookProgram(name, base);
    });
    // ---- IOCS
    const call = io.call.bind(io);
    io.call = (n) => {
      this.iocsCounts.set(n, (this.iocsCounts.get(n) ?? 0) + 1);
      if (!this.active()) return call(n);
      this.onIocs(n);
      // IOCS calls that set video registers themselves (CRTMOD, G_CLR_ON...): log the changes
      const crtc = v.crtc.slice(0, 0x30), vc = v.vc.slice(0, 3);
      const r = call(n);
      for (let i = 0; i < 0x30; i++) if (v.crtc[i] !== crtc[i]) this.emit({ op: 'crtc', reg: i, value: v.crtc[i], via: hex(n, 2) });
      for (let i = 0; i < 3; i++) if (v.vc[i] !== vc[i]) this.emit({ op: 'vc', reg: i, value: v.vc[i], via: hex(n, 2) });
      return r;
    };
    // ---- video registers (in program order)
    const crtcWrite = v.crtcWrite.bind(v);
    v.crtcWrite = (a, d) => {
      const r = (a - 0xe80000) >> 1;
      if (r === 0x240) { if (d & 3) this.emit({ op: 'crtc', reg: 'op', value: d & 0xb }); }
      else if (r < 0x30 && v.crtc[r] !== (d & 0xffff)) this.emit({ op: 'crtc', reg: r, value: d & 0xffff });
      return crtcWrite(a, d);
    };
    const vcWrite8 = v.vcWrite8.bind(v);
    v.vcWrite8 = (a, d) => {
      const o = a - 0xe82000;
      if (o >= 0x400) {
        const r = (o - 0x400) >> 8;
        if (r < 3 && (o & 0xff) < 2) {
          const nv = (o & 1) ? (v.vc[r] & 0xff00) | d : (v.vc[r] & 0xff) | (d << 8);
          if (nv !== v.vc[r]) this.emit({ op: 'vc', reg: r, value: nv });
        }
      }
      return vcWrite8(a, d);
    };
    // ---- end of frame: palette and contrast
    const runFrame = sys.runFrame.bind(sys);
    sys.runFrame = () => {
      runFrame();
      this.endFrame();
    };
    // ---- ZMUSIC: hook its trap #3 entry once it is resident
    this.zmusicHooked = false;
  }

  hookZmusic() {
    if (this.zmusicHooked) return;
    const vec = this.sys.m.r32(0x23 * 4) >>> 0;
    if (vec < 0x8000 || vec > 0x200000) return;
    this.zmusicHooked = true;
    this.sys.addHook(vec, (c) => {
      if (!this.active()) return;
      const fn = c.d[1] & 0xff, a1 = c.a[1] >>> 0;
      const ev = { op: 'zmusic', fn, d2: c.d[2] >>> 0, d3: c.d[3] >>> 0, a1: hex(a1, 6) };
      // the data pointer may be inside a file read earlier (ZMD data starts after its header)
      if (fn === 0x11 || fn === 0x13) {
        for (const [reg, p] of [['a1', a1], ['d3', c.d[3] >>> 0]]) {
          for (const [start, b] of this.buffers) if (p >= start && p < b.end) { ev.file = b.file; ev.dataIn = reg; if (p !== start) ev.offset = p - start; }
          if (ev.file) break;
        }
      }
      this.emit(ev);
    });
  }

  onIocs(n) {
    const c = this.sys.cpu, m = this.sys.m, io = this.sys.iocs;
    const d1 = c.d[1], d2 = c.d[2], a1 = c.a[1] >>> 0;
    const s16 = (a) => m.r16(a) << 16 >> 16;
    switch (n) {
      case 0x10: this.emit({ op: 'iocs', name: 'CRTMOD', mode: d1 & 0xff }); break;
      case 0x11: this.emit({ op: 'iocs', name: 'CONTRAST', level: d1 & 0xff }); break;
      case 0x90: this.emit({ op: 'iocs', name: 'G_CLR_ON' }); break;
      case 0x91: this.emit({ op: 'iocs', name: 'GPALMOD', mode: d1 & 0xff }); break;
      case 0xb1: break; // APAGE: recorded with FILL
      case 0xba: this.emit({ op: 'fill', page: io.apage, x1: s16(a1), y1: s16(a1 + 2), x2: s16(a1 + 4), y2: s16(a1 + 6), color: m.r16(a1 + 8) }); break;
      case 0x20: this.emit({ op: 'text', name: 'B_PUTC', code: hex(d1 & 0xffff) }); break;
      case 0x21: this.emit({ op: 'text', name: 'B_PRINT', text: this.str(a1), at: [io.con.x, io.con.y], color: io.con.color }); break;
      case 0x22: this.emit({ op: 'text', name: 'B_COLOR', color: d1 & 0xffff }); break;
      case 0x23: this.emit({ op: 'text', name: 'B_LOCATE', x: d1 & 0xffff, y: d2 & 0xffff }); break;
      case 0x2a: this.emit({ op: 'text', name: 'B_CLR_ST', mode: d1 & 3 }); break;
      case 0x2b: this.emit({ op: 'text', name: 'B_ERA_ST', mode: d1 & 3 }); break;
      case 0x2f: this.emit({ op: 'text', name: 'B_PUTMES', text: this.str(a1, (c.d[4] & 0xffff) + 1), color: d1 & 0xff, x: d2 & 0xffff, y: c.d[3] & 0xffff, len: (c.d[4] & 0xffff) + 1 }); break;
      case 0x13: case 0x14: if (d2 !== -1) this.emit({ op: 'iocs', name: 'TPALET', index: d1 & 0xff, color: d2 }); break;
      case 0x94: this.emit({ op: 'iocs', name: 'GPALET', index: d1 & 0xffff, color: d2 }); break;
      default:
        if (n >= 0xc0 && n <= 0xcf) this.emit({ op: 'iocs', name: `SP_${hex(n, 2)}`, d1: hex(d1), d2: hex(d2) });
    }
  }

  str(a, max = 4096) {
    const m = this.sys.m, b = [];
    for (let i = 0; i < max; i++) { const x = m.r8(a + i); if (!x) break; b.push(x); }
    return sjis.decode(Uint8Array.from(b));
  }

  endFrame() {
    this.hookZmusic();
    if (!this.active()) return;
    const v = this.sys.video;
    const changed = {};
    let any = false;
    for (let i = 0; i < 16; i++) {
      if (v.gpal[i] !== this.prevPal[i]) { changed[i] = v.gpal[i]; this.prevPal[i] = v.gpal[i]; any = true; }
    }
    if (any) this.emit({ op: 'gpal', set: Object.fromEntries(Object.entries(changed).map(([k, w]) => [k, hex(w)])) });
    const tch = {};
    any = false;
    for (let i = 0; i < 16; i++) {
      if (v.spal[i] !== this.prevPal[16 + i]) { tch[i] = hex(v.spal[i]); this.prevPal[16 + i] = v.spal[i]; any = true; }
    }
    if (any) this.emit({ op: 'tpal', set: tch });
    const ct = this.sys.iocs.contrast;
    if (ct !== this.prevContrast) { this.emit({ op: 'contrast', level: ct }); this.prevContrast = ct; }
    this.emit(this.busy ? { op: 'frame', busy: true } : { op: 'frame' });
  }

  hookProgram(name, base) {
    const P = PROGRAMS[name];
    if (!P) return;
    const sys = this.sys, m = sys.m;
    const at = (spec, fn) => {
      const [off, word] = spec;
      sys.addHook(base + off, (c) => {
        if (sys.programName() !== name || this.bases.get(name) !== base) return;
        if (word !== null && m.r16(base + off) !== word) { this.problem(`${name}: code at +${hex(off)} is ${hex(m.r16(base + off))}, expected ${hex(word)}`); return; }
        fn(c);
      });
    };
    const rect = (o) => { const a = base + o; return { dx: m.r16(a), dy: m.r16(a + 2), sx: m.r16(a + 4), sy: m.r16(a + 6), w: m.r16(a + 8), h: m.r16(a + 10) }; };
    if (P.picDone) at(P.picDone, () => this.emit({ op: 'loadPic', file: this.str(base + P.picName), buffer: hex(base + P.picBuffer, 6) }));
    if (P.grpDone) at(P.grpDone, () => this.emit({ op: 'loadGrp', file: this.str(base + P.grpName), buffer: 'e00000' }));
    // Drawing primitives: parameters read at entry, event emitted when the drawing is finished
    // (a large blit takes most of a frame).
    let blit = null, wipe = null;
    const done = (ev) => { const f0 = ev.f0; delete ev.f0; if (f0 !== this.f) ev.started = f0; this.emit(ev); };
    if (P.blit) at(P.blit, () => { this.busy = true; blit = { op: 'blit', page: m.r8(base + P.vars.page), ...rect(P.vars.rect), f0: this.f }; });
    if (P.blitEnd) at(P.blitEnd, () => { if (blit) done(blit); blit = null; this.busy = false; });
    if (P.wipePass) at(P.wipePass, (c) => {
      const single = m.r32(base + P.vars.single) !== 0;
      this.busy = true;
      wipe = { op: 'wipe', page: m.r8(base + P.vars.page), ...rect(P.vars.rect), pass: c.d[3] & 0xffff, src: m.r8(base + P.vars.srcText) ? 'grp' : 'pic', single, fadeStep: m.r16(base + P.vars.fadeDuringWipe) !== 0, f0: this.f };
    });
    if (P.wipePassEnd) at(P.wipePassEnd, () => { if (wipe) done(wipe); wipe = null; this.busy = false; });
    if (P.waits?.vsync) at(P.waits.vsync, () => this.emit({ op: 'wait', frames: m.r32(base + P.waits.count) + 1, kind: 'vsync' }));
    if (P.waits?.counted) at(P.waits.counted, () => this.emit({ op: 'wait', every: m.r32(base + P.waits.count), kind: 'counted' }));
    if (P.waits?.delay) at(P.waits.delay, () => this.emit({ op: 'wait', frames: (m.r32(base + P.waits.count) >>> 12) + 1, kind: 'delay', count: hex(m.r32(base + P.waits.count)) }));
    if (P.fadeSetup) at(P.fadeSetup, () => {
      const fv = P.fadeVars;
      this.emit({ op: 'fade', index: m.r32(base + fv.index), from: hex(m.r16(base + fv.from)), to: hex(m.r16(base + fv.to)) });
    });
    if (P.narration) {
      const ptr = base + P.narration.ptr;
      let last = -1;
      at(P.narration.read, () => {
        const p = m.r32(ptr) >>> 0;
        const fresh = p !== last && p !== last + 2;
        last = p;
        if (!fresh) return;
        const bytes = [];
        for (let i = 0; i < 4096; i += 2) { const a = m.r8(p + i), b = m.r8(p + i + 1); if (a === 0) break; bytes.push(a, b); }
        if (bytes.length >= 2) this.emit({ op: 'narration', script: hex(p, 6), offset: hex(p - base), bytes });
      });
    }
    // MENU68 (C calling convention: return address at (sp), arguments from 4(sp))
    const arg = (c, i) => m.r32((c.a[7] >>> 0) + 4 + i * 4) >>> 0;
    const onReturn = (c, fn) => {
      const ret = m.r32(c.a[7] >>> 0) >>> 0;
      this.returns ??= new Map();
      if (!this.returns.has(ret)) {
        this.returns.set(ret, []);
        sys.addHook(ret, (cc) => { const q = this.returns.get(ret); if (q.length) q.shift()(cc); });
      }
      this.returns.get(ret).push(fn);
    };
    if (P.menu) at(P.menu, (c) => {
      const items = arg(c, 1), list = [];
      for (let i = 0; i < 8; i++) { const p = m.r32(items + i * 4) >>> 0; if (!p) break; list.push(this.str(p)); }
      const f0 = this.f;
      onReturn(c, (cc) => this.emit({ op: 'menu', items: list, selected: cc.d[0] << 16 >> 16, shown: f0, table: hex(items, 6) }));
    });
    if (P.print) at(P.print, (c) => this.emit({ op: 'print', window: hex(arg(c, 0), 6), text: this.str(arg(c, 1)) }));
    if (P.requireDisk) at(P.requireDisk, (c) => this.emit({ op: 'requireDisk', drive: m.r16((c.a[7] >>> 0) + 6), disk: m.r16((c.a[7] >>> 0) + 10) }));
    if (P.exec) at(P.exec, (c) => this.emit({ op: 'exec', file: this.str(arg(c, 0)), args: this.str(arg(c, 1)) }));
    if (P.writeFile) at(P.writeFile, (c) => {
      const n = arg(c, 2), b = [];
      for (let i = 0; i < Math.min(n, 64); i++) b.push(hex(m.r8(arg(c, 1) + i), 2));
      this.emit({ op: 'writeFile', file: this.str(arg(c, 0)), bytes: n, data: b.join('') });
    });
  }
}
