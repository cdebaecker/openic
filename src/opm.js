// Yamaha YM2151 (OPM) emulation at 0xE90000.
// Envelope generator follows the chip's rate/increment tables; phase and
// output are computed in floating point at the host sample rate.

const EG_INC = [
  0, 1, 0, 1, 0, 1, 0, 1,
  0, 1, 0, 1, 1, 1, 0, 1,
  0, 1, 1, 1, 0, 1, 1, 1,
  0, 1, 1, 1, 1, 1, 1, 1,
  1, 1, 1, 1, 1, 1, 1, 1,
  1, 1, 1, 2, 1, 1, 1, 2,
  1, 2, 1, 2, 1, 2, 1, 2,
  1, 2, 2, 2, 1, 2, 2, 2,
  2, 2, 2, 2, 2, 2, 2, 2,
  2, 2, 2, 4, 2, 2, 2, 4,
  2, 4, 2, 4, 2, 4, 2, 4,
  2, 4, 4, 4, 2, 4, 4, 4,
  4, 4, 4, 4, 4, 4, 4, 4,
  4, 4, 4, 8, 4, 4, 4, 8,
  4, 8, 4, 8, 4, 8, 4, 8,
  4, 8, 8, 8, 4, 8, 8, 8,
  8, 8, 8, 8, 8, 8, 8, 8,
  16, 16, 16, 16, 16, 16, 16, 16,
  0, 0, 0, 0, 0, 0, 0, 0,
];
// index = 32 + rate (rate 0..63 after key scaling; extra headroom on both sides)
const EG_SEL = new Uint8Array(128);
const EG_SH = new Uint8Array(128);
for (let i = 0; i < 128; i++) {
  const r = i - 32;
  if (r < 0) { EG_SEL[i] = 18 * 8; EG_SH[i] = 0; continue; }
  if (r < 48) { EG_SEL[i] = (r & 3) * 8; EG_SH[i] = 11 - (r >> 2); continue; }
  if (r < 52) { EG_SEL[i] = (4 + (r & 3)) * 8; EG_SH[i] = 0; continue; }
  if (r < 56) { EG_SEL[i] = (8 + (r & 3)) * 8; EG_SH[i] = 0; continue; }
  if (r < 60) { EG_SEL[i] = (12 + (r & 3)) * 8; EG_SH[i] = 0; continue; }
  EG_SEL[i] = 16 * 8; EG_SH[i] = 0;
}
const DT1_TAB = [
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 6, 6, 7, 8, 8, 8, 8,
  1, 1, 1, 1, 2, 2, 2, 2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 6, 6, 7, 8, 8, 9, 10, 11, 12, 13, 14, 16, 16, 16, 16,
  2, 2, 2, 2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 6, 6, 7, 8, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 20, 22, 22, 22, 22,
];
const DT2_CENTS = [0, 600, 781, 950];
const NOTE_MAP = [0, 1, 2, 2, 3, 4, 5, 5, 6, 7, 8, 8, 9, 10, 11, 11];
const PMS_CENTS = [0, 5, 10, 20, 50, 100, 400, 700];
const AMS_MUL = [0, 1, 2, 4];

// Attenuation (10-bit, 0.09375 dB/step) to linear amplitude.
const ATT = new Float32Array(4096);
for (let i = 0; i < 4096; i++) ATT[i] = i >= 1024 ? 0 : Math.pow(10, -(i * 0.09375) / 20);
const SIN = new Float32Array(4096);
for (let i = 0; i < 4096; i++) SIN[i] = Math.sin((i + 0.5) * 2 * Math.PI / 4096);

const EG_ATTACK = 1, EG_DECAY = 2, EG_SUSTAIN = 3, EG_RELEASE = 4, EG_OFF = 0;

class Op {
  constructor() {
    this.dt1 = 0; this.mul = 0; this.tl = 0; this.ks = 0; this.ar = 0; this.amsEn = 0;
    this.d1r = 0; this.dt2 = 0; this.d2r = 0; this.d1l = 0; this.rr = 0;
    this.phase = 0; this.inc = 0; this.env = 1023; this.state = EG_OFF;
    this.key = false; this.out = 0;
  }
}

export class OPM {
  constructor(clock = 4000000) {
    this.clock = clock;
    this.regs = new Uint8Array(256);
    this.ops = [];
    for (let i = 0; i < 32; i++) this.ops.push(new Op());
    this.ch = [];
    for (let c = 0; c < 8; c++) this.ch.push({ kc: 0, kf: 0, fb: 0, con: 0, rl: 0, pms: 0, ams: 0, fb1: 0, fb2: 0 });
    this.sampleRate = 48000;
    this.egCnt = 0; this.egAcc = 0;
    this.lfoPhase = 0; this.lfoFreq = 0; this.lfoWave = 0; this.amd = 0; this.pmd = 0;
    this.lfoNoise = 0; this.lfoNoiseCnt = 0;
    this.noise = 0; this.noiseLFSR = 1; this.noiseAcc = 0; this.noiseFreq = 0;
    this.addr = 0;
    this.timerA = 0; this.timerB = 0;
    this.timerACnt = 0; this.timerBCnt = 0;
    this.status = 0;
    this.onIrq = null;  // callback(level)
    this.onCT = null;   // callback(ct1, ct2) for ADPCM clock / FDC
    this.irq = false;
    this.mute = false;
  }

  setSampleRate(r) { this.sampleRate = r; for (let i = 0; i < 32; i++) this.calcInc(i); }

  install(m) {
    m.map(0xe90000, 0xe92000, {
      read8: (a) => (a & 3) === 3 ? this.status : 0xff,
      write8: (a, d) => {
        if ((a & 3) === 1) this.addr = d;
        else if ((a & 3) === 3) this.write(this.addr, d);
      },
    });
  }

  write(r, v) {
    this.regs[r] = v;
    if (r < 0x20) {
      switch (r) {
        case 0x01: if (v & 2) this.lfoPhase = 0; break;
        case 0x08: {
          const c = v & 7;
          this.keyOp(c, 0, v & 0x08);   // M1
          this.keyOp(c, 2, v & 0x10);   // C1
          this.keyOp(c, 1, v & 0x20);   // M2
          this.keyOp(c, 3, v & 0x40);   // C2
          break;
        }
        case 0x0f: this.noise = v; this.noiseFreq = v & 31; break;
        case 0x10: this.timerA = (this.timerA & 3) | (v << 2); break;
        case 0x11: this.timerA = (this.timerA & ~3) | (v & 3); break;
        case 0x12: this.timerB = v; break;
        case 0x14: {
          if ((v & 1) && !(this.ctrl & 1)) this.timerACnt = (1024 - this.timerA);
          if ((v & 2) && !(this.ctrl & 2)) this.timerBCnt = 16 * (256 - this.timerB);
          this.ctrl = v;
          if (v & 0x10) this.status &= ~1;
          if (v & 0x20) this.status &= ~2;
          this.updateIrq();
          break;
        }
        case 0x18: this.lfoFreq = 0.0081 * Math.pow(2, v * 12.67 / 255); break;
        case 0x19: if (v & 0x80) this.pmd = v & 0x7f; else this.amd = v & 0x7f; break;
        case 0x1b:
          this.lfoWave = v & 3;
          if (this.onCT) this.onCT((v >> 7) & 1, (v >> 6) & 1);
          break;
      }
      return;
    }
    if (r < 0x40) {
      const c = r & 7;
      const ch = this.ch[c];
      switch (r & 0x38) {
        case 0x20: ch.rl = v >> 6; ch.fb = (v >> 3) & 7; ch.con = v & 7; break;
        case 0x28: ch.kc = v & 0x7f; this.calcChannel(c); break;
        case 0x30: ch.kf = v >> 2; this.calcChannel(c); break;
        case 0x38: ch.pms = (v >> 4) & 7; ch.ams = v & 3; break;
      }
      return;
    }
    // operator registers: slot = (r & 0x1f); slot order M1(0-7), M2(8-15), C1(16-23), C2(24-31)
    const slot = r & 0x1f;
    const c = slot & 7, opIdx = slot >> 3;   // opIdx: 0=M1,1=M2,2=C1,3=C2
    const op = this.ops[c * 4 + opIdx];
    switch (r & 0xe0) {
      case 0x40: op.dt1 = (v >> 4) & 7; op.mul = v & 15; this.calcInc(c * 4 + opIdx); break;
      case 0x60: op.tl = v & 0x7f; break;
      case 0x80: op.ks = v >> 6; op.ar = v & 31; break;
      case 0xa0: op.amsEn = v >> 7; op.d1r = v & 31; break;
      case 0xc0: op.dt2 = v >> 6; op.d2r = v & 31; this.calcInc(c * 4 + opIdx); break;
      case 0xe0: op.d1l = v >> 4; op.rr = v & 15; break;
    }
  }

  keyOp(c, opIdx, on) {
    const op = this.ops[c * 4 + opIdx];
    if (on && !op.key) {
      op.key = true;
      op.phase = 0;
      op.state = EG_ATTACK;
      if (this.rate(op, op.ar) >= 62 + 32) { op.env = 0; op.state = EG_DECAY; }
    } else if (!on && op.key) {
      op.key = false;
      if (op.state !== EG_OFF) op.state = EG_RELEASE;
    }
  }

  calcChannel(c) { for (let i = 0; i < 4; i++) this.calcInc(c * 4 + i); }

  keyCode5(c) { return (this.ch[c].kc >> 2) & 31; }

  calcInc(i) {
    const c = i >> 2;
    const ch = this.ch[c], op = this.ops[i];
    const oct = (ch.kc >> 4) & 7, note = ch.kc & 15;
    const semis = oct * 12 + NOTE_MAP[note] + ch.kf / 64 + DT2_CENTS[op.dt2] / 100;
    let f = 440 * Math.pow(2, (semis - 56) / 12) * (this.clock / 3579545);
    const dt = DT1_TAB[(op.dt1 & 3) * 32 + this.keyCode5(c)] * (this.clock / 64) / 1048576;
    f += (op.dt1 & 4) ? -dt : dt;
    f *= op.mul ? op.mul : 0.5;
    op.freq = f;
    op.inc = f / this.sampleRate;
  }

  rate(op, r) {
    if (!r) return 0;
    const kc = this.keyCode5(this.ops.indexOf(op) >> 2);
    return Math.min(63, r * 2 + (kc >> (3 - op.ks))) + 32;
  }

  // Envelope generator tick (chip rate clock/192).
  egTick() {
    this.egCnt++;
    const cnt = this.egCnt;
    for (let i = 0; i < 32; i++) {
      const op = this.ops[i];
      if (op.state === EG_OFF) continue;
      const kc = this.keyCode5(i >> 2);
      const ksr = kc >> (3 - op.ks);
      let rIdx;
      switch (op.state) {
        case EG_ATTACK: rIdx = op.ar ? Math.min(63, op.ar * 2 + ksr) + 32 : 0; break;
        case EG_DECAY: rIdx = op.d1r ? Math.min(63, op.d1r * 2 + ksr) + 32 : 0; break;
        case EG_SUSTAIN: rIdx = op.d2r ? Math.min(63, op.d2r * 2 + ksr) + 32 : 0; break;
        case EG_RELEASE: rIdx = Math.min(63, op.rr * 4 + 2 + ksr) + 32; break;
      }
      const sh = EG_SH[rIdx];
      if (cnt & ((1 << sh) - 1)) continue;
      const inc = EG_INC[EG_SEL[rIdx] + ((cnt >> sh) & 7)];
      if (op.state === EG_ATTACK) {
        if (inc) op.env += (~op.env * inc) >> 4;
        if (op.env <= 0) { op.env = 0; op.state = EG_DECAY; }
      } else if (op.state === EG_DECAY) {
        op.env += inc;
        const sl = op.d1l === 15 ? 31 * 32 : op.d1l * 32;
        if (op.env >= sl) op.state = EG_SUSTAIN;
        if (op.env >= 1023) op.env = 1023;
      } else if (op.state === EG_SUSTAIN) {
        op.env += inc;
        if (op.env >= 1023) op.env = 1023;
      } else {
        op.env += inc;
        if (op.env >= 1023) { op.env = 1023; op.state = EG_OFF; }
      }
    }
  }

  // Advance the chip timers by `us` microseconds.
  tickTimers(seconds) {
    const samples = seconds * this.clock / 64;
    let fired = false;
    if (this.ctrl & 1) {
      this.timerACnt -= samples;
      while (this.timerACnt <= 0) {
        this.timerACnt += (1024 - this.timerA);
        if (this.ctrl & 4) { this.status |= 1; fired = true; }
        if (this.ctrl & 0x80) this.csmKey();
      }
    }
    if (this.ctrl & 2) {
      this.timerBCnt -= samples;
      while (this.timerBCnt <= 0) {
        this.timerBCnt += 16 * (256 - this.timerB);
        if (this.ctrl & 8) { this.status |= 2; fired = true; }
      }
    }
    if (fired) this.updateIrq();
  }

  // Seconds until a timer fires, for scheduling
  nextTimerSeconds() {
    let t = Infinity;
    const k = 64 / this.clock;
    if ((this.ctrl & 5) === 5) t = Math.min(t, this.timerACnt * k);
    if ((this.ctrl & 0xa) === 0xa) t = Math.min(t, this.timerBCnt * k);
    return t;
  }

  csmKey() {
    for (let c = 0; c < 8; c++) for (let o = 0; o < 4; o++) { this.keyOp(c, o, true); this.keyOp(c, o, false); }
  }

  updateIrq() {
    const irq = ((this.status & 1) && (this.ctrl & 4)) || ((this.status & 2) && (this.ctrl & 8));
    if (irq !== this.irq) {
      this.irq = !!irq;
      if (this.onIrq) this.onIrq(this.irq);
    }
  }

  lfoValue() {
    // returns [am 0..1, pm -1..1]
    const p = this.lfoPhase;
    switch (this.lfoWave) {
      case 0: return [1 - p, p < 0.5 ? p * 2 : p * 2 - 2];
      case 1: return [p < 0.5 ? 1 : 0, p < 0.5 ? 1 : -1];
      case 2: return [p < 0.5 ? 1 - p * 2 : p * 2 - 1, p < 0.25 ? p * 4 : p < 0.75 ? 2 - p * 4 : p * 4 - 4];
      default: return [this.lfoNoise, this.lfoNoise * 2 - 1];
    }
  }

  // Render `n` stereo samples into out (interleaved L,R), adding to existing content.
  render(buf, offset, n) {
    const egStep = (this.clock / 192) / this.sampleRate;
    const chs = this.ch, ops = this.ops;
    const noiseStep = this.noiseFreq !== undefined ? (this.clock / 64 / (32 * Math.max(1, 32 - this.noiseFreq))) / this.sampleRate : 0;
    for (let s = 0; s < n; s++) {
      this.egAcc += egStep;
      while (this.egAcc >= 1) { this.egAcc -= 1; this.egTick(); }
      // LFO
      this.lfoPhase += this.lfoFreq / this.sampleRate;
      if (this.lfoPhase >= 1) { this.lfoPhase -= 1; this.lfoNoise = Math.random(); }
      const [lfoAm, lfoPm] = this.lfoValue();
      // noise
      if (this.noise & 0x80) {
        this.noiseAcc += noiseStep * 32;
        while (this.noiseAcc >= 1) {
          this.noiseAcc -= 1;
          const bit = ((this.noiseLFSR >> 0) ^ (this.noiseLFSR >> 3)) & 1;
          this.noiseLFSR = (this.noiseLFSR >> 1) | (bit << 16);
        }
      }
      let L = 0, R = 0;
      for (let c = 0; c < 8; c++) {
        const ch = chs[c];
        if (!ch.rl) continue;
        const b = c * 4;
        const m1 = ops[b], m2 = ops[b + 1], c1 = ops[b + 2], c2 = ops[b + 3];
        if (m1.state === EG_OFF && m2.state === EG_OFF && c1.state === EG_OFF && c2.state === EG_OFF) {
          ch.fb1 = ch.fb2 = 0;
          continue;
        }
        let pmMul = 1;
        if (ch.pms && this.pmd) pmMul = Math.pow(2, lfoPm * (this.pmd / 127) * PMS_CENTS[ch.pms] / 1200);
        const amAtt = ch.ams && this.amd ? lfoAm * this.amd * 2 * AMS_MUL[ch.ams] : 0;
        // envelope + TL -> amplitude
        const amp = (op) => {
          let a = op.env + (op.tl << 3) + (op.amsEn ? amAtt : 0);
          return a >= 1023 ? 0 : ATT[a | 0];
        };
        const am1 = amp(m1), am2 = amp(m2), ac1 = amp(c1), ac2 = amp(c2);
        // advance phases
        m1.phase += m1.inc * pmMul; m1.phase -= Math.floor(m1.phase);
        m2.phase += m2.inc * pmMul; m2.phase -= Math.floor(m2.phase);
        c1.phase += c1.inc * pmMul; c1.phase -= Math.floor(c1.phase);
        c2.phase += c2.inc * pmMul; c2.phase -= Math.floor(c2.phase);
        const sinAt = (ph) => SIN[((ph - Math.floor(ph)) * 4096) & 4095];
        // M1 with feedback
        let fbIn = 0;
        if (ch.fb) fbIn = (ch.fb1 + ch.fb2) * Math.pow(2, ch.fb - 7);
        const o1 = am1 ? sinAt(m1.phase + fbIn) * am1 : 0;
        ch.fb2 = ch.fb1; ch.fb1 = o1;
        let out = 0;
        const MOD = 4;
        let oc1, om2, oc2;
        switch (ch.con) {
          case 0:
            oc1 = ac1 ? sinAt(c1.phase + o1 * MOD) * ac1 : 0;
            om2 = am2 ? sinAt(m2.phase + oc1 * MOD) * am2 : 0;
            out = ac2 ? sinAt(c2.phase + om2 * MOD) * ac2 : 0; break;
          case 1:
            oc1 = ac1 ? sinAt(c1.phase) * ac1 : 0;
            om2 = am2 ? sinAt(m2.phase + (o1 + oc1) * MOD) * am2 : 0;
            out = ac2 ? sinAt(c2.phase + om2 * MOD) * ac2 : 0; break;
          case 2:
            oc1 = ac1 ? sinAt(c1.phase) * ac1 : 0;
            om2 = am2 ? sinAt(m2.phase + oc1 * MOD) * am2 : 0;
            out = ac2 ? sinAt(c2.phase + (o1 + om2) * MOD) * ac2 : 0; break;
          case 3:
            oc1 = ac1 ? sinAt(c1.phase + o1 * MOD) * ac1 : 0;
            om2 = am2 ? sinAt(m2.phase) * am2 : 0;
            out = ac2 ? sinAt(c2.phase + (oc1 + om2) * MOD) * ac2 : 0; break;
          case 4:
            oc1 = ac1 ? sinAt(c1.phase + o1 * MOD) * ac1 : 0;
            om2 = am2 ? sinAt(m2.phase) * am2 : 0;
            out = oc1 + (ac2 ? sinAt(c2.phase + om2 * MOD) * ac2 : 0); break;
          case 5:
            out = (ac1 ? sinAt(c1.phase + o1 * MOD) * ac1 : 0)
              + (am2 ? sinAt(m2.phase + o1 * MOD) * am2 : 0)
              + (ac2 ? sinAt(c2.phase + o1 * MOD) * ac2 : 0); break;
          case 6:
            out = (ac1 ? sinAt(c1.phase + o1 * MOD) * ac1 : 0)
              + (am2 ? sinAt(m2.phase) * am2 : 0)
              + (ac2 ? sinAt(c2.phase) * ac2 : 0); break;
          case 7:
            out = o1 + (ac1 ? sinAt(c1.phase) * ac1 : 0)
              + (am2 ? sinAt(m2.phase) * am2 : 0)
              + (ac2 ? sinAt(c2.phase) * ac2 : 0); break;
        }
        if (c === 7 && (this.noise & 0x80)) {
          // C2 replaced by noise
          out -= (ac2 ? sinAt(c2.phase) * ac2 : 0) * (ch.con >= 4 ? 1 : 0);
          out += ((this.noiseLFSR & 1) ? 1 : -1) * ac2;
        }
        if (ch.rl & 1) L += out;
        if (ch.rl & 2) R += out;
      }
      if (this.mute) { L = R = 0; }
      buf[offset + s * 2] += L * 0.18;
      buf[offset + s * 2 + 1] += R * 0.18;
    }
  }
}
