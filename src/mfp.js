// MC68901 MFP at 0xE88000 (registers on odd addresses).
// Channel numbers follow the MFP priority order (15 = highest).
//  ch15 GPIP7 H-SYNC   ch14 GPIP6 CRTC raster   ch13 timer A   ch12 RX full (keyboard)
//  ch11 RX error       ch10 TX empty            ch9 TX error   ch8 timer B
//  ch7 GPIP5           ch6 GPIP4 V-DISP         ch5 timer C    ch4 timer D
//  ch3 GPIP3 OPM       ch2 GPIP2                ch1 GPIP1      ch0 GPIP0 RTC alarm

const GPIP_CH = [0, 1, 2, 3, 6, 7, 14, 15];
const PRESCALE = [0, 4, 10, 16, 50, 64, 100, 200];
export const MFP_CLOCK = 4000000;

export class MFP {
  constructor(sys) {
    this.sys = sys;
    this.gpip = 0xff; this.aer = 0; this.ddr = 0;
    this.ier = 0; this.ipr = 0; this.isr = 0; this.imr = 0;
    this.vr = 0x40;
    this.tcr = [0, 0, 0, 0];         // A, B, C, D control (mode 0-15 for A/B, 0-7 for C/D)
    this.tdr = [0, 0, 0, 0];         // reload values (0 = 256)
    this.tcount = [0, 0, 0, 0];      // current counter
    this.tacc = [0, 0, 0, 0];        // fractional clock accumulation
    this.rsr = 0; this.tsr = 0x80; this.ucr = 0; this.scr = 0;
    this.rxQueue = [];
    this.udr = 0;
    this.gpip = 0x7b;                // V-DISP etc. idle levels
  }

  install(m) {
    m.map(0xe88000, 0xe8a000, {
      read8: (a) => this.read((a & 0x3f) >> 1, a),
      write8: (a, d) => this.write((a & 0x3f) >> 1, d, a),
    });
  }

  read(r, a) {
    if (!(a & 1)) return 0xff;
    switch (r) {
      case 0: return this.gpip;
      case 1: return this.aer;
      case 2: return this.ddr;
      case 3: return this.ier >> 8;
      case 4: return this.ier & 0xff;
      case 5: return this.ipr >> 8;
      case 6: return this.ipr & 0xff;
      case 7: return this.isr >> 8;
      case 8: return this.isr & 0xff;
      case 9: return this.imr >> 8;
      case 10: return this.imr & 0xff;
      case 11: return this.vr;
      case 12: return this.tcr[0];
      case 13: return this.tcr[1];
      case 14: return (this.tcr[2] << 4) | this.tcr[3];
      case 15: case 16: case 17: case 18: return this.tcount[r - 15] & 0xff;
      case 19: return this.scr;
      case 20: return this.ucr;
      case 21: return this.rsr | (this.rxQueue.length ? 0x80 : 0);
      case 22: return this.tsr;
      case 23: {
        const v = this.rxQueue.length ? this.rxQueue.shift() : this.udr;
        this.udr = v;
        if (this.rxQueue.length) this.raise(12);
        return v;
      }
    }
    return 0xff;
  }

  write(r, d, a) {
    if (!(a & 1)) return;
    switch (r) {
      case 0: this.gpip = (this.gpip & ~this.ddr) | (d & this.ddr); break;
      case 1: this.aer = d; break;
      case 2: this.ddr = d; break;
      case 3: this.ier = (this.ier & 0xff) | (d << 8); this.ipr &= this.ier; break;
      case 4: this.ier = (this.ier & 0xff00) | d; this.ipr &= this.ier; break;
      case 5: this.ipr &= (d << 8) | 0xff; break;
      case 6: this.ipr &= 0xff00 | d; break;
      case 7: this.isr &= (d << 8) | 0xff; break;
      case 8: this.isr &= 0xff00 | d; break;
      case 9: this.imr = (this.imr & 0xff) | (d << 8); break;
      case 10: this.imr = (this.imr & 0xff00) | d; break;
      case 11: this.vr = d; break;
      case 12: this.setTCR(0, d & 15); break;
      case 13: this.setTCR(1, d & 15); break;
      case 14: this.setTCR(2, (d >> 4) & 7); this.setTCR(3, d & 7); break;
      case 15: case 16: case 17: case 18: {
        const t = r - 15;
        this.tdr[t] = d;
        if (!this.tcr[t]) this.tcount[t] = d || 256;
        break;
      }
      case 19: this.scr = d; break;
      case 20: this.ucr = d; break;
      case 21: this.rsr = d & 1; break;
      case 22: this.tsr = (d & 0x0f) | 0x80; break;
      case 23: if (this.sys.keyboardCommand) this.sys.keyboardCommand(d); break;
    }
    this.update();
  }

  setTCR(t, v) {
    if (v && !this.tcr[t]) { this.tcount[t] = this.tdr[t] || 256; this.tacc[t] = 0; }
    this.tcr[t] = v;
  }

  timerChannel(t) { return [13, 8, 5, 4][t]; }

  // Advance timers by `cycles` of the 4 MHz MFP clock.
  tick(mfpCycles) {
    for (let t = 0; t < 4; t++) {
      const c = this.tcr[t];
      if (!c || c >= 8) continue;  // stopped or event count / pulse width
      const pre = PRESCALE[c & 7];
      this.tacc[t] += mfpCycles;
      let n = Math.floor(this.tacc[t] / pre);
      if (!n) continue;
      this.tacc[t] -= n * pre;
      while (n > 0) {
        if (n >= this.tcount[t]) {
          n -= this.tcount[t];
          this.tcount[t] = this.tdr[t] || 256;
          this.raise(this.timerChannel(t));
        } else { this.tcount[t] -= n; n = 0; }
      }
    }
  }

  // Time (in MFP cycles) until the next delay-mode timer fires, for scheduling.
  nextTimerEvent() {
    let best = Infinity;
    for (let t = 0; t < 4; t++) {
      const c = this.tcr[t];
      if (!c || c >= 8) continue;
      const pre = PRESCALE[c & 7];
      best = Math.min(best, this.tcount[t] * pre - this.tacc[t]);
    }
    return best;
  }

  // Event count input (timer A counts V-DISP edges on the X68000).
  eventCount(t) {
    if (this.tcr[t] !== 8) return;
    if (--this.tcount[t] <= 0) {
      this.tcount[t] = this.tdr[t] || 256;
      this.raise(this.timerChannel(t));
    }
  }

  // Set a GPIP input line; raises an interrupt on the active edge.
  setGPIP(bit, level) {
    const m = 1 << bit;
    const old = (this.gpip & m) ? 1 : 0;
    if (old === level) return;
    if (level) this.gpip |= m; else this.gpip &= ~m;
    const activeHigh = (this.aer & m) !== 0;
    if ((activeHigh && level) || (!activeHigh && !level)) this.raise(GPIP_CH[bit]);
  }

  raise(ch) {
    const m = 1 << ch;
    if (this.ier & m) { this.ipr |= m; this.update(); }
  }

  receive(byte) {
    this.rxQueue.push(byte);
    if (this.rxQueue.length === 1) this.raise(12);
  }

  pendingChannel() {
    const p = this.ipr & this.imr;
    if (!p) return -1;
    for (let ch = 15; ch >= 0; ch--) {
      const m = 1 << ch;
      if (this.isr & m) return -1;      // a higher (or equal) channel is in service
      if (p & m) return ch;
    }
    return -1;
  }

  update() {
    this.sys.updateIrq();
  }

  // Interrupt acknowledge: returns vector number.
  acknowledge() {
    const ch = this.pendingChannel();
    if (ch < 0) return -1;
    const m = 1 << ch;
    this.ipr &= ~m;
    if (this.vr & 8) this.isr |= m;   // software end-of-interrupt mode
    this.sys.updateIrq();
    return (this.vr & 0xf0) | ch;
  }
}
