// X68000 video: CRTC (0xE80000), video controller (0xE82000), graphic VRAM
// (0xC00000), text VRAM (0xE00000) and the sprite/BG controller (0xEB0000).
// Rendering is done one scanline at a time into an RGBA framebuffer.

// GGGGGRRRRRBBBBBI -> 0xAABBGGRR (little-endian canvas ImageData order)
const RGB = new Uint32Array(65536);
for (let v = 0; v < 65536; v++) {
  const i = v & 1;
  const g = (((v >> 11) & 31) << 1 | i) * 255 / 63;
  const r = (((v >> 6) & 31) << 1 | i) * 255 / 63;
  const b = (((v >> 1) & 31) << 1 | i) * 255 / 63;
  RGB[v] = (0xff000000 | (Math.round(b) << 16) | (Math.round(g) << 8) | Math.round(r)) >>> 0;
}

export class Video {
  constructor(sys) {
    this.sys = sys;
    this.crtc = new Uint16Array(48);
    this.crtcOp = 0;
    this.fastClearPending = false;
    this.palBytes = new Uint8Array(0x400);  // e82000-e823ff: graphic + text/sprite palettes
    this.gpal = new Uint16Array(256);
    this.spal = new Uint16Array(256);
    this.vc = new Uint16Array(3);           // R0 e82400, R1 e82500, R2 e82600
    this.gram = new Uint16Array(512 * 512); // physical graphic memory
    this.tram = new Uint8Array(0x80000);
    this.spr = new Uint16Array(0x200);      // eb0000-eb03ff
    this.bgr = new Uint16Array(0x20);       // eb0800-eb083f
    this.pcg = new Uint8Array(0x8000);      // eb8000-ebffff
    this.width = 512; this.height = 512;
    this.frame = new Uint32Array(1024 * 1024);
    this.frameW = 512; this.frameH = 512;
    this.lineBuf = new Int32Array(1024);
    this.txLine = new Uint8Array(1024);
    this.grLine = new Int32Array(1024);
    this.spLine = new Int32Array(1024);
    this.spriteDirty = true;
    // Defaults similar to CRTMOD 16 (768x512, 31 kHz)
    this.setCRTCDefaults();
  }

  setCRTCDefaults() {
    const r = [0x89, 0x0e, 0x1c, 0x7c, 0x237, 0x05, 0x28, 0x228, 0x1b];
    for (let i = 0; i < r.length; i++) this.crtc[i] = r[i];
    this.crtc[20] = 0x0416;
  }

  // ---- address-space devices -------------------------------------------------
  install(m) {
    const v = this;
    m.map(0xc00000, 0xe00000, {
      read8: (a) => (a & 1) ? v.gread(a) & 0xff : (v.gread(a) >> 8) & 0xff,
      read16: (a) => v.gread(a),
      write8: (a, d) => {
        const w = v.gread(a & ~1);
        v.gwrite(a & ~1, (a & 1) ? (w & 0xff00) | d : (w & 0x00ff) | (d << 8));
      },
      write16: (a, d) => v.gwrite(a, d),
    });
    m.map(0xe00000, 0xe80000, {
      read8: (a) => v.tram[a - 0xe00000],
      read16: (a) => (v.tram[a - 0xe00000] << 8) | v.tram[a - 0xe00000 + 1],
      write8: (a, d) => v.twrite8(a - 0xe00000, d),
      write16: (a, d) => { v.twrite8(a - 0xe00000, d >> 8); v.twrite8(a - 0xe00000 + 1, d & 0xff); },
    });
    m.map(0xe80000, 0xe82000, {
      read8: (a) => { const w = v.crtcRead(a & ~1); return (a & 1) ? w & 0xff : w >> 8; },
      read16: (a) => v.crtcRead(a),
      write8: (a, d) => {
        const w = v.crtcRead(a & ~1);
        v.crtcWrite(a & ~1, (a & 1) ? (w & 0xff00) | d : (w & 0xff) | (d << 8));
      },
      write16: (a, d) => v.crtcWrite(a, d),
    });
    m.map(0xe82000, 0xe84000, {
      read8: (a) => v.vcRead8(a),
      write8: (a, d) => v.vcWrite8(a, d),
    });
    m.map(0xeb0000, 0xec0000, {
      read8: (a) => { const w = v.spRead(a & ~1); return (a & 1) ? w & 0xff : w >> 8; },
      read16: (a) => v.spRead(a),
      write8: (a, d) => {
        if (a >= 0xeb8000) { v.pcg[a - 0xeb8000] = d; return; }
        const w = v.spRead(a & ~1);
        v.spWrite(a & ~1, (a & 1) ? (w & 0xff00) | d : (w & 0xff) | (d << 8));
      },
      write16: (a, d) => v.spWrite(a, d),
    });
  }

  // ---- graphic VRAM -----------------------------------------------------------
  gaddr(a) {
    // returns [index, shift, mask] for the current memory mode
    const o = a - 0xc00000;
    const mode = (this.crtc[20] >> 8) & 7;
    if (mode & 4) {
      // 1024x1024, 16 colours
      const y = o >> 11, x = (o >> 1) & 1023;
      const page = ((y & 512) ? 2 : 0) + ((x & 512) ? 1 : 0);
      return [((y & 511) << 9) | (x & 511), page * 4, 0xf];
    }
    const w = (o & 0x7ffff) >> 1;
    const page = o >> 19;
    if (mode === 0) return [w, page * 4, 0xf];
    if (mode === 1) return page < 2 ? [w, page * 8, 0xff] : null;
    return page === 0 ? [w, 0, 0xffff] : null;
  }
  gread(a) {
    const g = this.gaddr(a);
    if (!g) return 0;
    return (this.gram[g[0]] >> g[1]) & g[2];
  }
  gwrite(a, d) {
    const g = this.gaddr(a);
    if (!g) return;
    const [i, sh, mk] = g;
    this.gram[i] = (this.gram[i] & ~(mk << sh)) | ((d & mk) << sh);
  }

  // ---- text VRAM ---------------------------------------------------------------
  twrite8(o, d) {
    const r21 = this.crtc[21];
    let mask = 0;
    if (r21 & 0x200) mask = (o & 1) ? this.crtc[23] & 0xff : this.crtc[23] >> 8;
    if (r21 & 0x100) {
      const off = o & 0x1ffff;
      for (let p = 0; p < 4; p++) {
        if (!(r21 & (0x10 << p))) continue;
        const idx = p * 0x20000 + off;
        this.tram[idx] = (this.tram[idx] & mask) | (d & ~mask);
      }
    } else {
      this.tram[o] = (this.tram[o] & mask) | (d & ~mask);
    }
  }

  // ---- CRTC -----------------------------------------------------------------------
  crtcRead(a) {
    const o = a - 0xe80000;
    if (o === 0x480) return this.crtcOp;
    if (o < 0x60) return this.crtc[o >> 1];
    return 0;
  }
  crtcWrite(a, d) {
    const o = a - 0xe80000;
    if (o === 0x480) {
      this.crtcOp = d & 0x0b;
      if (d & 1) this.rasterCopy();
      if (d & 2) this.fastClearPending = true;
      return;
    }
    if (o < 0x60) {
      const r = o >> 1;
      this.crtc[r] = d;
      if (r === 9 && this.sys.rasterChanged) this.sys.rasterChanged();
    }
  }
  rasterCopy() {
    const r22 = this.crtc[22];
    const src = (r22 >> 8) & 0xff, dst = r22 & 0xff;
    const planes = this.crtc[21] & 0xf;
    for (let p = 0; p < 4; p++) {
      if (!(planes & (1 << p))) continue;
      const base = p * 0x20000;
      this.tram.copyWithin(base + dst * 512, base + src * 512, base + src * 512 + 512);
    }
    this.crtcOp &= ~1;
  }
  doFastClear() {
    // Clear the pages selected by R21 bits 0-3 (as nibble masks of the physical word).
    const sel = this.crtc[21] & 0xf;
    let keep = 0xffff;
    for (let p = 0; p < 4; p++) if (sel & (1 << p)) keep &= ~(0xf << (p * 4));
    const g = this.gram;
    for (let i = 0; i < g.length; i++) g[i] &= keep;
    this.fastClearPending = false;
    this.crtcOp &= ~2;
  }

  // ---- video controller ------------------------------------------------------------
  vcRead8(a) {
    const o = a - 0xe82000;
    if (o < 0x400) return this.palBytes[o];
    const r = (o - 0x400) >> 8;
    if (r < 3) return (o & 1) ? this.vc[r] & 0xff : this.vc[r] >> 8;
    return 0;
  }
  vcWrite8(a, d) {
    const o = a - 0xe82000;
    if (o < 0x400) {
      this.palBytes[o] = d;
      const i = o >> 1;
      const v = (this.palBytes[i * 2] << 8) | this.palBytes[i * 2 + 1];
      if (i < 256) this.gpal[i] = v; else this.spal[i - 256] = v;
      return;
    }
    const r = (o - 0x400) >> 8;
    if (r < 3 && (o & 0xff) < 2) {
      this.vc[r] = (o & 1) ? (this.vc[r] & 0xff00) | d : (this.vc[r] & 0xff) | (d << 8);
    }
  }

  // ---- sprites ---------------------------------------------------------------------
  spRead(a) {
    if (a >= 0xeb8000) { const o = a - 0xeb8000; return (this.pcg[o] << 8) | this.pcg[o + 1]; }
    if (a < 0xeb0400) return this.spr[(a - 0xeb0000) >> 1];
    if (a >= 0xeb0800 && a < 0xeb0840) return this.bgr[(a - 0xeb0800) >> 1];
    return 0xffff;
  }
  spWrite(a, d) {
    if (a >= 0xeb8000) { const o = a - 0xeb8000; this.pcg[o] = d >> 8; this.pcg[o + 1] = d; return; }
    if (a < 0xeb0400) { this.spr[(a - 0xeb0000) >> 1] = d; return; }
    if (a >= 0xeb0800 && a < 0xeb0840) this.bgr[(a - 0xeb0800) >> 1] = d;
  }

  // ---- timing helpers ------------------------------------------------------------------
  // Display geometry derived from the CRTC registers.
  geometry() {
    const c = this.crtc;
    const r20 = c[20];
    const hf = (r20 >> 4) & 1;
    const vres = (r20 >> 2) & 3;
    let w = (c[3] - c[2]) * 8;
    let lines = c[7] - c[6];
    if (w <= 0 || w > 1024) w = [256, 512, 768, 768][r20 & 3];
    if (lines <= 0 || lines > 1024) lines = 512;
    let h = lines;
    let doubled = false;
    if (hf && vres === 0) { h = lines >> 1; doubled = true; }
    else if (!hf && vres >= 1) h = lines * 2;
    const vtotal = Math.max(c[4] + 1, lines + 16);
    return { w, h, lines, vtotal, vstart: c[6], hf, doubled };
  }

  beginFrame() {
    const g = this.geometry();
    this.frameW = Math.min(g.w, 1024);
    this.frameH = Math.min(g.h, 1024);
    this.geo = g;
    this.prepareSprites();
  }

  // ---- rendering ------------------------------------------------------------------------
  renderLine(y) {
    const W = this.frameW;
    if (y < 0 || y >= this.frameH) return;
    const out = this.frame;
    const base = y * W;
    const vc0 = this.vc[0], vc1 = this.vc[1], vc2 = this.vc[2];
    const txOn = (vc2 & 0x20) !== 0;
    const spOn = (vc2 & 0x40) !== 0 && (this.bgr[4] & 0x200) !== 0;
    const grOn = (vc2 & 0x1f) !== 0;
    const tx = this.txLine, gr = this.grLine, sp = this.spLine;
    if (txOn) this.renderText(y, W); else tx.fill(0, 0, W);
    if (grOn) this.renderGraphic(y, W, vc0, vc1, vc2); else gr.fill(-1, 0, W);
    if (spOn && W <= 512) this.renderSprites(y, W); else sp.fill(-1, 0, W);

    const pSP = (vc1 >> 12) & 3, pTX = (vc1 >> 10) & 3, pGR = (vc1 >> 8) & 3;
    // order[0] is front-most
    const layers = [[pSP, 0], [pTX, 1], [pGR, 2]].sort((a, b) => a[0] - b[0] || a[1] - b[1]).map((x) => x[1]);
    const l0 = layers[0], l1 = layers[1], l2 = layers[2];
    const spal = this.spal, gpal = this.gpal;
    const back = RGB[spal[0]];
    const halfTone = (vc2 & 0x1800) === 0x1800 ? 0 : 0; // reserved for translucency effects
    for (let x = 0; x < W; x++) {
      let col = -1;
      for (let k = 0; k < 3 && col < 0; k++) {
        const l = k === 0 ? l0 : k === 1 ? l1 : l2;
        if (l === 0) { const s = sp[x]; if (s >= 0) col = spal[s]; }
        else if (l === 1) { const t = tx[x]; if (t) col = spal[t]; }
        else { const g = gr[x]; if (g >= 0) col = g; }
      }
      out[base + x] = col < 0 ? back : RGB[col];
    }
    void halfTone;
  }

  renderText(y, W) {
    const c = this.crtc;
    const sx = c[10] & 1023, sy = (y + c[11]) & 1023;
    const t = this.tram, line = this.txLine;
    const row = sy * 128;
    for (let x = 0; x < W;) {
      const px = (x + sx) & 1023;
      const byte = row + (px >> 3);
      const b0 = t[byte], b1 = t[byte + 0x20000], b2 = t[byte + 0x40000], b3 = t[byte + 0x60000];
      let bit = 7 - (px & 7);
      if ((b0 | b1 | b2 | b3) === 0) {
        const n = Math.min(bit + 1, W - x);
        line.fill(0, x, x + n); x += n; continue;
      }
      for (; bit >= 0 && x < W; bit--, x++) {
        line[x] = ((b0 >> bit) & 1) | (((b1 >> bit) & 1) << 1) | (((b2 >> bit) & 1) << 2) | (((b3 >> bit) & 1) << 3);
      }
    }
  }

  renderGraphic(y, W, vc0, vc1, vc2) {
    const c = this.crtc, g = this.gram, out = this.grLine, pal = this.gpal;
    out.fill(-1, 0, W);
    const mode = vc0 & 7;
    if (mode & 4) {
      if (!(vc2 & 0x10)) return;
      const sx = c[12] & 1023, sy = (y + c[13]) & 1023;
      const quadY = (sy & 512) ? 2 : 0;
      const rowBase = (sy & 511) << 9;
      for (let x = 0; x < W; x++) {
        const px = (x + sx) & 1023;
        const page = quadY + ((px & 512) ? 1 : 0);
        const v = (g[rowBase | (px & 511)] >> (page * 4)) & 15;
        if (v) out[x] = pal[v];
      }
      return;
    }
    if (mode === 3) {
      if (!(vc2 & 0xf)) return;
      const sx = c[12] & 511, sy = (y + c[13]) & 511;
      const row = sy << 9;
      for (let x = 0; x < W; x++) {
        const v = g[row | ((x + sx) & 511)];
        if (v) out[x] = v;
      }
      return;
    }
    // Paged modes: determine page order by VC R1 bits 0-7 (lower = front).
    const pages = mode === 1 ? 2 : 4;
    const order = [];
    for (let p = 0; p < 4; p++) order.push([(vc1 >> (p * 2)) & 3, p]);
    order.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    // draw back to front
    for (let k = 3; k >= 0; k--) {
      const p = order[k][1];
      if (p >= pages) continue;
      let on, shift, mask, scr;
      if (mode === 1) {
        on = (vc2 >> (p * 2)) & 3; shift = p * 8; mask = 0xff; scr = p * 4;
      } else {
        on = (vc2 >> p) & 1; shift = p * 4; mask = 0xf; scr = p * 2;
      }
      if (!on) continue;
      const sx = c[12 + scr] & 511, sy = (y + c[13 + scr]) & 511;
      const row = sy << 9;
      for (let x = 0; x < W; x++) {
        const v = (g[row | ((x + sx) & 511)] >> shift) & mask;
        if (v) out[x] = pal[v];
      }
    }
  }

  prepareSprites() {
    // Cache the list of active sprites for this frame.
    const list = [];
    for (let i = 0; i < 128; i++) {
      const prw = this.spr[i * 4 + 3] & 3;
      if (!prw) continue;
      list.push(i);
    }
    this.activeSprites = list;
  }

  renderSprites(y, W) {
    const out = this.spLine;
    out.fill(-1, 0, W);
    const bgc = this.bgr[4];
    const res = this.bgr[8] & 3;   // eb0810 bits 0-1: 0 = 256 (16x16 BG tiles), 1 = 512
    const big = res === 0;
    // Layer precedence: BG1 (back) < sprites prw1 < BG0? Use: prw1 below BGs, prw2 between, prw3 on top.
    const tmpSp = this.lineBuf;
    // Sprites, grouped by prw. Lower sprite number has priority.
    const spr = this.spr, pcg = this.pcg;
    const drawSprites = (prwWanted) => {
      for (let k = this.activeSprites.length - 1; k >= 0; k--) {
        const i = this.activeSprites[k];
        if ((spr[i * 4 + 3] & 3) !== prwWanted) continue;
        const sy = (spr[i * 4 + 1] & 1023) - 16;
        let ry = y - sy;
        if (ry < 0 || ry >= 16) continue;
        const sx = (spr[i * 4] & 1023) - 16;
        const attr = spr[i * 4 + 2];
        if (attr & 0x8000) ry = 15 - ry;
        const hflip = (attr & 0x4000) !== 0;
        const palBase = ((attr >> 8) & 15) << 4;
        const pat = (attr & 0xff) * 128;
        for (let rx = 0; rx < 16; rx++) {
          const x = sx + rx;
          if (x < 0 || x >= W) continue;
          const px = hflip ? 15 - rx : rx;
          const blk = (px >> 3) * 2 + (ry >> 3);
          const byte = pcg[pat + blk * 32 + (ry & 7) * 4 + ((px & 7) >> 1)];
          const ci = (px & 1) ? byte & 15 : byte >> 4;
          if (ci) out[x] = palBase | ci;
        }
      }
    };
    const drawBG = (layer) => {
      const on = layer === 0 ? bgc & 1 : (bgc >> 3) & 1;
      if (!on) return;
      const area = layer === 0 ? (bgc >> 1) & 3 : (bgc >> 4) & 3;
      const base = area & 1 ? 0x6000 : 0x4000; // eb e000 / eb c000 within pcg
      const scx = this.bgr[layer * 2] & 1023, scy = this.bgr[layer * 2 + 1] & 1023;
      const ts = big ? 16 : 8;
      const ty = (y + scy) & (big ? 1023 : 511);
      for (let x = 0; x < W; x++) {
        const tx = (x + scx) & (big ? 1023 : 511);
        const entry = (pcg[base + ((ty / ts | 0) * 64 + (tx / ts | 0)) * 2] << 8) | pcg[base + ((ty / ts | 0) * 64 + (tx / ts | 0)) * 2 + 1];
        let px = tx % ts, py = ty % ts;
        if (entry & 0x4000) px = ts - 1 - px;
        if (entry & 0x8000) py = ts - 1 - py;
        let byte;
        if (big) {
          const blk = (px >> 3) * 2 + (py >> 3);
          byte = pcg[(entry & 0xff) * 128 + blk * 32 + (py & 7) * 4 + ((px & 7) >> 1)];
        } else {
          byte = pcg[(entry & 0xff) * 32 + py * 4 + (px >> 1)];
        }
        const ci = (px & 1) ? byte & 15 : byte >> 4;
        if (ci) out[x] = (((entry >> 8) & 15) << 4) | ci;
      }
    };
    void tmpSp;
    drawSprites(1);
    drawBG(1);
    drawSprites(2);
    drawBG(0);
    drawSprites(3);
  }
}

export { RGB };
