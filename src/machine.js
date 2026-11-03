// X68000 address space. RAM is a flat byte array; the I/O area 0xC00000-0xFFFFFF
// is dispatched to device objects registered per 8 KB page.

import { M68K } from './m68k.js';

export class Machine {
  constructor(opts = {}) {
    this.ramSize = opts.ramSize ?? 0x200000;
    this.ram = new Uint8Array(this.ramSize);
    this.pages = new Array(0x200).fill(null); // 0xC00000-0xFFFFFF in 8 KB pages
    this.log = opts.log ?? (() => {});
    this.unmapped = new Map();
    this.cpu = new M68K(this);
    this.busErrorHook = null;
  }

  map(start, end, dev) {
    for (let a = start; a < end; a += 0x2000) this.pages[(a - 0xc00000) >> 13] = dev;
  }

  dev(a) {
    if (a < 0xc00000) return null;
    return this.pages[(a - 0xc00000) >> 13];
  }

  noteUnmapped(a, w, v) {
    const k = (a >= 0xe00000 ? a & 0xffff00 : a & 0xfc0000).toString(16) + (w ? 'w' : 'r');
    let e = this.unmapped.get(k);
    if (!e) { e = { n: 0, pcs: new Set(), first: a }; this.unmapped.set(k, e); }
    e.n++;
    if (e.pcs.size < 4) e.pcs.add(this.cpu.opPC.toString(16));
  }

  read8(a) {
    if (a < this.ramSize) return this.ram[a];
    const d = this.dev(a);
    if (d) return d.read8(a);
    this.noteUnmapped(a, false);
    return 0xff;
  }
  read16(a) {
    if (a < this.ramSize - 1) return (this.ram[a] << 8) | this.ram[a + 1];
    const d = this.dev(a);
    if (d) return d.read16 ? d.read16(a) : (d.read8(a) << 8) | d.read8(a + 1);
    this.noteUnmapped(a, false);
    return 0xffff;
  }
  read32(a) {
    if (a < this.ramSize - 3) {
      const r = this.ram;
      return ((r[a] << 24) | (r[a + 1] << 16) | (r[a + 2] << 8) | r[a + 3]) >>> 0;
    }
    return ((this.read16(a) << 16) | this.read16((a + 2) & 0xffffff)) >>> 0;
  }
  write8(a, v) {
    if (a < this.ramSize) { this.ram[a] = v; return; }
    const d = this.dev(a);
    if (d) { d.write8(a, v & 0xff); return; }
    this.noteUnmapped(a, true, v);
  }
  write16(a, v) {
    if (a < this.ramSize - 1) { this.ram[a] = v >> 8; this.ram[a + 1] = v; return; }
    const d = this.dev(a);
    if (d) {
      if (d.write16) d.write16(a, v & 0xffff);
      else { d.write8(a, (v >> 8) & 0xff); d.write8(a + 1, v & 0xff); }
      return;
    }
    this.noteUnmapped(a, true, v);
  }
  write32(a, v) {
    if (a < this.ramSize - 3) {
      const r = this.ram;
      r[a] = v >>> 24; r[a + 1] = v >>> 16; r[a + 2] = v >>> 8; r[a + 3] = v;
      return;
    }
    this.write16(a, v >>> 16);
    this.write16((a + 2) & 0xffffff, v & 0xffff);
  }

  // Convenience accessors used by HLE code (no cycle accounting).
  r8(a) { return this.read8(a & 0xffffff); }
  r16(a) { return this.read16(a & 0xffffff); }
  r32(a) { return this.read32(a & 0xffffff); }
  w8(a, v) { this.write8(a & 0xffffff, v & 0xff); }
  w16(a, v) { this.write16(a & 0xffffff, v & 0xffff); }
  w32(a, v) { this.write32(a & 0xffffff, v >>> 0); }
  readBytes(a, n) { const o = new Uint8Array(n); for (let i = 0; i < n; i++) o[i] = this.r8(a + i); return o; }
  writeBytes(a, bytes) {
    a &= 0xffffff;
    if (a + bytes.length <= this.ramSize) { this.ram.set(bytes, a); return; }
    for (let i = 0; i < bytes.length; i++) this.w8(a + i, bytes[i]);
  }
  readCString(a, max = 1024) {
    let s = '';
    for (let i = 0; i < max; i++) { const c = this.r8(a + i); if (!c) break; s += String.fromCharCode(c); }
    return s;
  }
  writeCString(a, s) { for (let i = 0; i < s.length; i++) this.w8(a + i, s.charCodeAt(i)); this.w8(a + s.length, 0); }
}
