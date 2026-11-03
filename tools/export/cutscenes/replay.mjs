// Reference replayer for the cutscene timelines: rebuilds graphic VRAM from timeline events only
// (pictures decoded with tools/export/pic.mjs). It is what a port has to implement, and the
// recorder runs it in lockstep with the emulator to prove the timeline complete: after every
// frame the replayed VRAM must equal the emulator's.
//
// Graphic VRAM is kept in the emulator's physical layout (src/video.js): 512x512 words, each word
// holding the four 16-colour pages as nibbles (page p = bits 4p..4p+3). In memory mode 4
// (1024x1024, 16 colours) the four 512x512 quadrants are those four pages.
import { decodePic } from '../pic.mjs';
import { readFile } from '../common.mjs';

export class Replayer {
  constructor() {
    this.gram = new Uint16Array(512 * 512);
    this.crtc = new Uint16Array(0x30);
    this.vc = new Uint16Array(3);
    this.apage = 0;
    this.pic = new Uint16Array(1024 * 512);       // PIC decode buffer, 1024 words per line
    this.grp = new Uint16Array(1024 * 512);       // GRP buffer at $E00000, same layout
    this.fastClear = false;
  }

  // Initial state = the emulator's when recording starts.
  sync(video) {
    this.gram.set(video.gram);
    this.crtc.set(video.crtc.subarray(0, 0x30));
    this.vc.set(video.vc.subarray(0, 3));
  }

  // A word write to graphic VRAM address a ($C00000-$DFFFFF) in the current memory mode.
  gw(a, d) {
    const o = a - 0xc00000;
    const mode = (this.crtc[20] >> 8) & 7;
    let i, sh, mk;
    if (mode & 4) {
      const y = o >> 11, x = (o >> 1) & 1023;
      i = ((y & 511) << 9) | (x & 511); sh = (((y & 512) ? 2 : 0) + ((x & 512) ? 1 : 0)) * 4; mk = 0xf;
    } else {
      const page = o >> 19;
      i = (o & 0x7ffff) >> 1;
      if (mode === 0) { sh = page * 4; mk = 0xf; }
      else if (mode === 1) { if (page >= 2) return; sh = page * 8; mk = 0xff; }
      else { if (page) return; sh = 0; mk = 0xffff; }
    }
    this.gram[i] = (this.gram[i] & ~(mk << sh)) | ((d & mk) << sh);
  }

  source(src) { return src === 'grp' ? this.grp : this.pic; }

  // Offsets as the 68000 code computes them: d0 = y << shift (long), then "add.w x,d0" twice,
  // which adds 2x to the low word only (16-bit wrap, no carry). With x >= 0 and in range this is
  // just y * line + 2x; a negative x (stored as $FFxx) starts on the previous line.
  static off(y, x, shift) {
    let d0 = (y << shift) >>> 0;
    for (let k = 0; k < 2; k++) d0 = ((d0 & 0xffff0000) | ((d0 + x) & 0xffff)) >>> 0;
    return d0;
  }

  // Blit (IL_OPEN $A0158 / IL_END $48DE6): w x h words from the buffer at (sx, sy) to page
  // `page` at (dx, dy); every source line is written to two consecutive 512-word VRAM lines.
  blit({ page, dx, dy, sx, sy, w, h }) {
    const base = 0xc00000 + page * 0x80000 + Replayer.off(dy, dx & 0xffff, 10);
    const src = Replayer.off(sy, sx & 0xffff, 11) >> 1;
    for (let r = 0; r < h; r++) {
      const s = src + r * 1024;
      for (let k = 0; k < 2; k++) {
        const a = base + r * 0x800 + k * 0x400;
        for (let i = 0; i < w; i++) this.gw(a + i * 2, this.pic[(s + i) & 0x7ffff]);
      }
    }
  }

  // One pass (pass = 0, 2, 4 or 6) of the dissolve blit (IL_OPEN $A0210 / IL_END $48E9E):
  // the same copy, one word in four, the phase shifting by one word each line (5-line cycle).
  wipe({ page, dx, dy, sx, sy, w, h, pass, src }) {
    const buf = this.source(src);
    let a2 = 0xc00000 + page * 0x80000 + Replayer.off(dy, dx & 0xffff, 10);
    let s = Replayer.off(sy, sx & 0xffff, 11) >> 1;
    let d2 = 0;
    const rowBytes = w * 2, n = ((w - 1) >> 2) + 1;
    for (let r = 0; r < h; r++) {
      let d6 = 0;
      for (let k = 0; k < n; k++) {
        let d5 = d2 + pass + d6;
        if (d5 >= rowBytes) d5 -= rowBytes;
        const v = buf[(s + (d5 >> 1)) & 0x7ffff];
        this.gw(a2 + d5, v);
        this.gw(a2 + 0x400 + d5, v);
        d6 += 8;
      }
      a2 += 0x800; s += 1024;
      d2 += 2; if (d2 === 10) d2 = 0;
    }
  }

  // IOCS _FILL on the active page (as src/iocs.js does it).
  fill({ page, x1, y1, x2, y2, color }) {
    if (x1 > x2) [x1, x2] = [x2, x1];
    if (y1 > y2) [y1, y2] = [y2, y1];
    const mem = (this.crtc[20] >> 8) & 7;
    for (let y = y1; y <= y2; y++) for (let x = x1; x <= x2; x++) {
      if (mem & 4) { if (x < 0 || y < 0 || x > 1023 || y > 1023) continue; this.gw(0xc00000 + y * 2048 + x * 2, color); }
      else { if (x < 0 || y < 0 || x > 511 || y > 511) continue; this.gw(0xc00000 + page * 0x80000 + y * 1024 + x * 2, color); }
    }
  }

  loadPic(file) {
    const img = decodePic(readFile(file.replace(/^[A-Z]:/i, '')));
    for (let y = 0; y < img.height; y++) this.pic.set(img.indices.subarray(y * img.width, (y + 1) * img.width), y * 1024);
  }

  // GRP expansion (IL_OPEN $9FBB4): whole records until the write pointer passes $E50000.
  loadGrp(file) {
    const d = readFile(file.replace(/^[A-Z]:/i, ''));
    let pos = 0;
    for (let i = 0; i + 2 < d.length && pos <= 0x28000; i += 3) {
      let na = d[i + 1] || 256, nb = d[i + 2] || 256;
      while (na--) this.grp[pos++] = d[i] >> 4;
      while (nb--) this.grp[pos++] = d[i] & 15;
    }
  }

  apply(e) {
    switch (e.op) {
      case 'crtc':
        if (e.reg === 'op') { if (e.value & 2) this.fastClear = true; }
        else this.crtc[e.reg] = e.value;
        break;
      case 'vc': this.vc[e.reg] = e.value; break;
      case 'iocs': if (e.name === 'G_CLR_ON') { this.gram.fill(0); this.apage = 0; } break;
      case 'loadPic': this.loadPic(e.file); break;
      case 'loadGrp': this.loadGrp(e.file); break;
      case 'blit': this.blit(e); break;
      case 'wipe': this.wipe(e); break;
      case 'fill': this.fill(e); break;
      case 'frame':
        if (this.fastClear) {
          const sel = this.crtc[21] & 0xf;
          let keep = 0xffff;
          for (let p = 0; p < 4; p++) if (sel & (1 << p)) keep &= ~(0xf << (p * 4));
          for (let i = 0; i < this.gram.length; i++) this.gram[i] &= keep;
          this.fastClear = false;
        }
        break;
    }
  }
}

// Lockstep checker: compares the replayed VRAM with the emulator's after every frame.
export class Checker {
  constructor(sys, rec, programs = null) {
    this.sys = sys; this.programs = programs; this.rp = new Replayer(); this.rp.sync(sys.video);
    this.frames = 0; this.badFrames = 0; this.skipped = 0; this.firstBad = null; this.maxDiff = 0;
    this.picChecks = []; this.grpChecks = [];
    rec.listeners.push((e) => {
      if (e.op === 'program') { this.rp.sync(sys.video); return; }
      this.rp.apply(e);
      if (e.op === 'loadPic') this.checkBuffer(e, this.rp.pic, parseInt(e.buffer, 16), this.picChecks, 512);
      if (e.op === 'loadGrp') this.checkBuffer(e, this.rp.grp, 0xe00000, this.grpChecks, 160);
      if (e.op === 'frame') this.compare(e.busy);
    });
  }
  checkBuffer(e, buf, addr, out, lines) {
    const m = this.sys.m;
    let bad = 0;
    for (let y = 0; y < lines; y++) for (let x = 0; x < 768; x++) if (m.r16(addr + (y * 1024 + x) * 2) !== buf[y * 1024 + x]) bad++;
    out.push({ f: e.f, file: e.file, mismatches: bad, pixels: lines * 768 });
  }
  compare(busy) {
    // While a drawing routine is still running at the end of a frame (its event is emitted when it
    // is done) the emulator shows a partly drawn picture: compare only at the other frames.
    if (this.programs && !this.programs.has(this.sys.programName())) return;
    if (busy) { this.skipped++; return; }
    this.frames++;
    const a = this.rp.gram, b = this.sys.video.gram;
    let diff = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
    if (!diff) return;
    this.badFrames++;
    this.maxDiff = Math.max(this.maxDiff, diff);
    this.firstBad ??= { f: this.sys.frameCount - 1, words: diff };
    a.set(b);   // resynchronise to keep checking what follows
  }
  report() {
    return { framesCompared: this.frames, framesWithDifferences: this.badFrames, framesSkippedWhileDrawing: this.skipped, firstDifference: this.firstBad, maxDifferingWords: this.maxDiff, picBuffers: this.picChecks, grpBuffers: this.grpChecks };
  }
}
