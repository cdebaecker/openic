// OKI MSM6258 ADPCM at 0xE92000. Data arrives through DMAC channel 3 (or
// from HLE IOCS calls that queue memory blocks directly).

const STEP = [16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97,
  107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544,
  598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552];
const ADJ = [-1, -1, -1, -1, 2, 4, 6, 8];

export class ADPCM {
  constructor(sys) {
    this.sys = sys;
    this.playing = false;
    this.clock8 = 1;       // OPM CT1: 1 = 8 MHz, 0 = 4 MHz
    this.divider = 2;      // PPI port C bits 2-3: 0 = /1024, 1 = /768, 2 = /512
    this.pan = 0;          // PPI port C bits 0-1 (active low: bit0 = right off, bit1 = left off)
    this.signal = 0; this.step = 0;
    this.nibbles = [];
    this.pos = 0;          // fractional sample position
    this.last = 0; this.cur = 0;
    this.hle = null;       // {queue:[{addr,len}], ...} for IOCS driven playback
    this.sampleRate = 48000;
    this.volume = 1.0;
    this.filt = 0;
  }

  install(m) {
    m.map(0xe92000, 0xe94000, {
      read8: (a) => (a & 3) === 1 ? (this.playing ? 0x00 : 0x80) | 0x40 : 0x00,
      write8: (a, d) => {
        if ((a & 3) === 1) this.command(d);
        else if ((a & 3) === 3) this.directData = d;
      },
    });
  }

  command(d) {
    if (d & 1) { this.stop(); return; }
    if (d & 2) { this.playing = true; this.reset(); }
  }

  reset() { this.signal = 0; this.step = 0; this.nibbles.length = 0; this.need = 0; }
  stop() { this.playing = false; this.hle = null; }

  rate() {
    const base = this.clock8 ? 8000000 : 4000000;
    return base / [1024, 768, 512, 512][this.divider & 3];
  }

  decode(n) {
    const ss = STEP[this.step];
    let diff = ss >> 3;
    if (n & 1) diff += ss >> 2;
    if (n & 2) diff += ss >> 1;
    if (n & 4) diff += ss;
    if (n & 8) diff = -diff;
    this.signal = Math.max(-2048, Math.min(2047, this.signal + diff));
    this.step = Math.max(0, Math.min(48, this.step + ADJ[n & 7]));
    return this.signal;
  }

  nextByte() {
    if (this.hle) {
      const q = this.hle;
      while (q.blocks.length && q.blocks[0].len <= 0) q.blocks.shift();
      if (!q.blocks.length) { this.hle = null; this.playing = false; return -1; }
      const b = q.blocks[0];
      b.len--;
      return this.sys.m.r8(b.addr++);
    }
    return this.sys.dmac.pullByte(3);
  }

  nextSample() {
    if (!this.nibbles.length) {
      const b = this.nextByte();
      if (b < 0) { this.playing = this.hle ? true : this.sys.dmac.ch[3].active; return null; }
      this.nibbles.push(b & 15, b >> 4);
    }
    return this.decode(this.nibbles.shift());
  }

  render(buf, offset, n) {
    const r = this.rate();
    const step = r / this.sampleRate;
    const active = this.playing && (this.hle || this.sys.dmac.ch[3].active);
    const lOn = !(this.pan & 2), rOn = !(this.pan & 1);
    for (let i = 0; i < n; i++) {
      if (active) {
        this.pos += step;
        while (this.pos >= 1) {
          this.pos -= 1;
          this.last = this.cur;
          const s = this.nextSample();
          this.cur = s === null ? this.cur * 0.9 : s;
        }
      } else {
        this.cur *= 0.995;
      }
      const v = (this.last + (this.cur - this.last) * this.pos) / 2048;
      // simple low-pass to soften the 4-bit stepping
      this.filt += (v - this.filt) * 0.5;
      const o = this.filt * 0.5 * this.volume;
      if (lOn) buf[offset + i * 2] += o;
      if (rOn) buf[offset + i * 2 + 1] += o;
    }
  }
}
