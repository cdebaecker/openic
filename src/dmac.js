// HD63450 DMA controller at 0xE84000 (4 channels x 0x40 bytes).
// Channel 3 feeds the ADPCM chip one byte per request; other channels run
// memory-to-memory transfers instantly when started.

export class DMAC {
  constructor(sys) {
    this.sys = sys;
    this.ch = [];
    for (let i = 0; i < 4; i++) {
      this.ch.push({
        csr: 0, cer: 0, dcr: 0, ocr: 0, scr: 0, ccr: 0, mtc: 0, mar: 0, dar: 0,
        btc: 0, bar: 0, niv: 0x0f, eiv: 0x0f, mfc: 0, cpr: 0, dfc: 0, bfc: 0,
        active: false,
      });
    }
    this.gcr = 0;
    this.irqPending = -1;
  }

  install(m) {
    m.map(0xe84000, 0xe86000, {
      read8: (a) => this.read8(a),
      write8: (a, d) => this.write8(a, d),
    });
  }

  read8(a) {
    const o = a & 0xff;
    if (o === 0xff) return this.gcr;
    const c = this.ch[o >> 6];
    const r = o & 0x3f;
    switch (r) {
      case 0x00: return c.csr | (c.active ? 0x08 : 0);
      case 0x01: return c.cer;
      case 0x04: return c.dcr;
      case 0x05: return c.ocr;
      case 0x06: return c.scr;
      case 0x07: return c.ccr;
      case 0x0a: return c.mtc >> 8;
      case 0x0b: return c.mtc & 0xff;
      case 0x0c: case 0x0d: case 0x0e: case 0x0f: return (c.mar >>> ((3 - (r - 0x0c)) * 8)) & 0xff;
      case 0x14: case 0x15: case 0x16: case 0x17: return (c.dar >>> ((3 - (r - 0x14)) * 8)) & 0xff;
      case 0x1a: return c.btc >> 8;
      case 0x1b: return c.btc & 0xff;
      case 0x1c: case 0x1d: case 0x1e: case 0x1f: return (c.bar >>> ((3 - (r - 0x1c)) * 8)) & 0xff;
      case 0x25: return c.niv;
      case 0x27: return c.eiv;
      case 0x29: return c.mfc;
      case 0x2d: return c.cpr;
      case 0x31: return c.dfc;
      case 0x39: return c.bfc;
    }
    return 0;
  }

  setLong(v, r, base, d) {
    const sh = (3 - (r - base)) * 8;
    return ((v & ~(0xff << sh)) | (d << sh)) >>> 0;
  }

  write8(a, d) {
    const o = a & 0xff;
    if (o === 0xff) { this.gcr = d; return; }
    const n = o >> 6;
    const c = this.ch[n];
    const r = o & 0x3f;
    switch (r) {
      case 0x00: c.csr &= ~(d & 0xf6); this.updateIrq(); break;
      case 0x04: c.dcr = d; break;
      case 0x05: c.ocr = d; break;
      case 0x06: c.scr = d; break;
      case 0x07: this.writeCCR(n, d); break;
      case 0x0a: c.mtc = (c.mtc & 0xff) | (d << 8); break;
      case 0x0b: c.mtc = (c.mtc & 0xff00) | d; break;
      case 0x0c: case 0x0d: case 0x0e: case 0x0f: c.mar = this.setLong(c.mar, r, 0x0c, d); break;
      case 0x14: case 0x15: case 0x16: case 0x17: c.dar = this.setLong(c.dar, r, 0x14, d); break;
      case 0x1a: c.btc = (c.btc & 0xff) | (d << 8); break;
      case 0x1b: c.btc = (c.btc & 0xff00) | d; break;
      case 0x1c: case 0x1d: case 0x1e: case 0x1f: c.bar = this.setLong(c.bar, r, 0x1c, d); break;
      case 0x25: c.niv = d; break;
      case 0x27: c.eiv = d; break;
      case 0x29: c.mfc = d; break;
      case 0x2d: c.cpr = d; break;
      case 0x31: c.dfc = d; break;
      case 0x39: c.bfc = d; break;
    }
  }

  writeCCR(n, d) {
    const c = this.ch[n];
    if (d & 0x10) { // software abort
      c.active = false;
      c.csr = (c.csr & ~0x08) | 0x90;
      c.cer = 0x11;
      c.ccr = 0;
      this.updateIrq();
      return;
    }
    c.ccr = d & 0x78 | (c.ccr & 0x80);
    if (d & 0x40) c.cont = true;   // continue mode (for chaining next block from BAR/BTC)
    if (d & 0x80) this.start(n);
  }

  start(n) {
    const c = this.ch[n];
    c.csr &= ~0xf0;
    c.active = true;
    c.ccr |= 0x80;
    c.cont = (c.ccr & 0x40) !== 0;
    const chain = (c.ocr >> 2) & 3;
    if (chain === 2) { // array chain
      c.chainCount = c.btc;
      this.loadArrayEntry(c);
    } else if (chain === 3) { // link array chain
      this.loadLinkEntry(c);
    }
    if (n !== 3) this.runImmediate(n);
  }

  loadArrayEntry(c) {
    const m = this.sys.m;
    if (c.chainCount <= 0) { this.finish(c); return false; }
    c.mar = m.r32(c.bar) & 0xffffff;
    c.mtc = m.r16(c.bar + 4);
    c.bar = (c.bar + 6) >>> 0;
    c.chainCount--;
    c.btc = c.chainCount;
    return true;
  }

  loadLinkEntry(c) {
    const m = this.sys.m;
    if (!c.bar) { this.finish(c); return false; }
    c.mar = m.r32(c.bar) & 0xffffff;
    c.mtc = m.r16(c.bar + 4);
    c.bar = m.r32(c.bar + 6) >>> 0;
    return true;
  }

  // Called after a block (MTC reached 0); returns true if more data follows.
  blockDone(n) {
    const c = this.ch[n];
    const chain = (c.ocr >> 2) & 3;
    if (chain === 2) {
      if (c.chainCount > 0) return this.loadArrayEntry(c);
    } else if (chain === 3) {
      if (c.bar) return this.loadLinkEntry(c);
    } else if (c.ccr & 0x40) {
      // continue mode: reload from BAR/BTC
      c.csr |= 0x40; // block complete
      c.ccr &= ~0x40;
      c.mar = c.bar; c.mtc = c.btc;
      if (c.ccr & 0x08) this.raise(n, false);
      return c.mtc > 0;
    }
    this.finish(c);
    return false;
  }

  finish(c) {
    c.active = false;
    c.csr = (c.csr & ~0x08) | 0x80 | 0x40 * 0; // COC
    c.ccr &= ~0x80;
    const n = this.ch.indexOf(c);
    if (c.ccr & 0x08) this.raise(n, false);
  }

  raise(n, err) {
    const c = this.ch[n];
    c.irq = err ? c.eiv : c.niv;
    this.updateIrq();
  }

  updateIrq() {
    let p = -1;
    for (let i = 0; i < 4; i++) {
      const c = this.ch[i];
      if (c.irq !== undefined && c.irq !== null && (c.csr & 0xf0) && (c.ccr & 0x08)) { p = i; break; }
    }
    this.irqPending = p;
    this.sys.updateIrq();
  }

  acknowledge() {
    const p = this.irqPending;
    if (p < 0) return -1;
    const c = this.ch[p];
    const v = c.irq;
    c.irq = null;
    this.updateIrq();
    return v;
  }

  // Fetch the next byte for a device-paced channel (ADPCM on channel 3).
  // Returns -1 when no data is available.
  pullByte(n) {
    const c = this.ch[n];
    if (!c.active) return -1;
    while (c.mtc === 0) { if (!this.blockDone(n)) return -1; }
    const v = this.sys.m.r8(c.mar);
    const mac = (c.scr >> 2) & 3;
    if (mac === 1) c.mar = (c.mar + 1) >>> 0; else if (mac === 2) c.mar = (c.mar - 1) >>> 0;
    c.mtc--;
    if (c.mtc === 0) this.blockDone(n);
    return v;
  }

  runImmediate(n) {
    // memory <-> memory or memory <-> device transfer, done at once
    const c = this.ch[n];
    const m = this.sys.m;
    const size = [1, 2, 4, 1][(c.ocr >> 4) & 3];
    const dir = (c.ocr >> 7) & 1;   // 0: memory -> device, 1: device -> memory
    const mac = (c.scr >> 2) & 3, dac = c.scr & 3;
    let guard = 0;
    while (c.active && guard++ < 0x100000) {
      while (c.active && c.mtc > 0) {
        for (let i = 0; i < size; i++) {
          if (dir) m.w8(c.mar + i, m.r8(c.dar + i));
          else m.w8(c.dar + i, m.r8(c.mar + i));
        }
        if (mac === 1) c.mar += size; else if (mac === 2) c.mar -= size;
        if (dac === 1) c.dar += size; else if (dac === 2) c.dar -= size;
        c.mtc--;
      }
      if (!this.blockDone(n)) break;
    }
  }
}
