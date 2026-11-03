// A minimal X68000 session for rendering ZMUSIC data: boots ZMUSIC.X with the game's
// ADPCM bank (ICITY.ZPD, as AUTOEXEC.BAT does), then runs a tiny resident driver program
// (injected into disk 1 as AUDDRV.R) that waits in STOP and performs trap #3 calls
// requested through a mailbox in memory. Captures the mixed audio and logs every
// OPM register write with its sample position (for loop detection).
import { X68k } from '../../../src/x68k.js';
import { Font } from '../../../src/font.js';
import { VNode } from '../../../src/fs.js';

// Driver (position independent, loaded as a .R file):
//   clr.l -(sp) / DOS _SUPER / addq.l #4,sp / lea mbox(pc),a2
// L: tst.l (a2) / bne.s do / stop #$2000 / bra.s L
// do: movem.l 4(a2),d1-d4/a1 / trap #3 / move.l d0,24(a2) / clr.l (a2) / bra.s L
// mbox: flag, d1, d2, d3, d4, a1, result
const DRIVER = [
  0x42a7, 0xff20, 0x588f, 0x45fa, 0x001c,
  0x4a92, 0x6606, 0x4e72, 0x2000, 0x60f6,
  0x4cea, 0x021e, 0x0004, 0x4e43, 0x2540, 0x0018, 0x4292, 0x60e6,
];
const MBOX = 0x24;          // offset of the mailbox in the driver
const LOOP = 0x0a;          // offset of the idle loop
export const DATA_OFFSET = 0x1000;   // free memory for data, inside the driver's block

function driverImage() {
  const b = new Uint8Array(0x40);
  DRIVER.forEach((w, i) => { b[i * 2] = w >> 8; b[i * 2 + 1] = w & 0xff; });
  return b;
}

export function installDriver(disks) {
  const root = disks[0].root;
  if (!root.children.has('AUDDRV.R')) root.children.set('AUDDRV.R', new VNode('AUDDRV.R', 0x20, driverImage()));
}

export const ZM = { M_PLAY: 0x08, M_STAT: 0x09, M_STOP: 0x0a, PLAY_CNV_DATA: 0x11, SE_PLAY: 0x12, SE_ADPCM1: 0x13, FADE_OUT: 0x1a };

export class Session {
  constructor(disks, { rate = 48000, dmacFix = true, setup = null } = {}) {
    installDriver(disks);
    this.rate = rate;
    this.chunks = [];
    this.samples = 0;       // stereo frames captured so far
    this.events = [];       // {t (sample position), k (token)}
    this.keyOns = 0;
    const sys = this.sys = new X68k({ epoch: Date.UTC(1993, 4, 24, 12, 0, 0), disks, font: new Font(), log: () => {},
      audioRate: rate, audioOut: (buf) => { this.chunks.push(Float32Array.from(buf)); this.samples += buf.length / 2; } });
    // No display needed: skip scanline rendering (most of the emulation time otherwise).
    sys.video.renderLine = () => {};
    const opm = sys.opm, origWrite = opm.write.bind(opm);
    opm.write = (r, v) => {
      if (r < 0x10 || r > 0x14) {
        this.events.push(this.now(), (r << 8) | v);
        if (r === 0x08 && (v & 0x78)) this.keyOns++;
      }
      origWrite(r, v);
    };
    const dmac = sys.dmac, origStart = dmac.start.bind(dmac);
    dmac.start = (n) => {
      // ADPCM starts only count as activity: they follow the same sequencer as the OPM writes,
      // and the DMA registers at start depend on how the previous sample was cut off.
      if (n === 3) this.keyOns++;
      origStart(n);
    };
    // The IPL ROM leaves DMAC channel 3 with SCR = $04 (memory address counts up); ZMUSIC
    // relies on that and never writes SCR. The emulator's HLE boot leaves it 0, so every
    // ADPCM sample (drums from ICITY.ZPD, THUNDER.PCM) would replay its first byte and peg
    // the MSM6258 at full negative scale. Set it as the ROM does.
    if (dmacFix) sys.dmac.ch[3].scr = 0x04;
    this.base = 0;
    sys.loadListeners.push((name, psp, base) => { if (name.toUpperCase() === 'AUDDRV.R') this.base = base; });
    setup?.(sys);   // devices to add before ZMUSIC boots (e.g. the MIDI interface)
    sys.boot([['A:\\ZMUSIC.X', '-U -BICITY.ZPD'], ['A:\\AUDDRV.R', '']]);
    for (let f = 0; f < 600 && !this.idle(); f++) sys.runFrame();
    if (!this.idle()) throw new Error('driver did not start');
    this.reset();
  }

  now() { return this.samples + this.sys.audioAcc; }
  idle() { return this.base && this.sys.cpu.stopped && this.sys.cpu.pc === this.base + LOOP + 8; }
  get mbox() { return this.base + MBOX; }

  // Drop captured audio and events (keeps the machine state).
  reset() { this.chunks = []; this.samples = 0; this.events = []; this.keyOns = 0; }

  write(offset, bytes) { this.sys.m.writeBytes(this.base + DATA_OFFSET + offset, bytes); return this.base + DATA_OFFSET + offset; }

  // trap #3 with the given registers; runs frames until the driver has made the call.
  call(d1, { d2 = 0, d3 = 0, d4 = 0, a1 = 0 } = {}) {
    const m = this.sys.m, mb = this.mbox;
    m.w32(mb + 4, d1); m.w32(mb + 8, d2); m.w32(mb + 12, d3); m.w32(mb + 16, d4); m.w32(mb + 20, a1);
    m.w32(mb, 1);
    this.sys.cpu.stopped = false;   // wake the driver from STOP
    for (let f = 0; f < 100 && m.r32(mb) !== 0; f++) this.sys.runFrame();
    if (m.r32(mb) !== 0) throw new Error(`trap #3 call $${d1.toString(16)} did not complete`);
    return m.r32(mb + 24) | 0;
  }

  runFrames(n) { for (let i = 0; i < n; i++) this.sys.runFrame(); }

  // Captured audio as one interleaved stereo Float32Array.
  audio() {
    const out = new Float32Array(this.samples * 2);
    let o = 0;
    for (const c of this.chunks) { out.set(c, o); o += c.length; }
    return out;
  }
}
