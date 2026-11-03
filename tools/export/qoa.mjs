// QOA ("Quite OK Audio", https://qoaformat.org) encoder: lossy, 3.2 bits per sample, decoded by
// Godot's AudioStreamWAV (FORMAT_QOA) with no extra tool. Follows the reference encoder (qoa.h):
// slices of 20 samples, a 4-tap LMS predictor per channel, the scale factor with the least error.
//
//   encodeQoa(samples, rate, channels) -> Uint8Array   (samples: interleaved floats in [-1, 1])
import fs from 'node:fs';
import path from 'node:path';

const SLICE_LEN = 20, SLICES_PER_FRAME = 256, FRAME_LEN = SLICE_LEN * SLICES_PER_FRAME;
const QUANT = [7, 7, 7, 5, 5, 3, 3, 1, 0, 0, 2, 2, 4, 4, 6, 6, 6];   // residual / scale clamped to -8..8
const DQ = [0.75, -0.75, 2.5, -2.5, 4.5, -4.5, 7, -7];
const SCALE = Array.from({ length: 16 }, (_, s) => Math.round(Math.pow(s + 1, 2.75)));
const RECIP = SCALE.map((sf) => Math.floor(((1 << 16) + sf - 1) / sf));
const DEQUANT = SCALE.map((sf) => DQ.map((d) => Math.sign(d) * Math.round(Math.abs(sf * d))));

const clamp16 = (v) => (v < -32768 ? -32768 : v > 32767 ? 32767 : v);
function div(v, s) {
  let n = Math.floor((v * RECIP[s] + (1 << 15)) / 65536);
  return n + Math.sign(v) - Math.sign(n);
}

export function encodeQoa(samples, rate, channels) {
  const total = Math.floor(samples.length / channels);
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) pcm[i] = clamp16(Math.round(samples[i] * 32767));
  const frames = Math.ceil(total / FRAME_LEN);
  const size = 8 + frames * (8 + 16 * channels) + 8 * Math.ceil(total / SLICE_LEN) * channels;
  const out = new Uint8Array(size), dv = new DataView(out.buffer);
  let p = 0;
  dv.setUint32(p, 0x716f6166); dv.setUint32(p + 4, total); p += 8;   // "qoaf", samples per channel
  const lms = Array.from({ length: channels }, () => ({ h: [0, 0, 0, 0], w: [0, 0, -(1 << 13), 1 << 14] }));
  const prevSf = new Array(channels).fill(0);
  for (let f0 = 0; f0 < total; f0 += FRAME_LEN) {
    const flen = Math.min(FRAME_LEN, total - f0), slices = Math.ceil(flen / SLICE_LEN);
    const fsize = 8 + 16 * channels + 8 * slices * channels;
    dv.setUint32(p, (channels << 24) | rate); dv.setUint16(p + 4, flen); dv.setUint16(p + 6, fsize); p += 8;
    for (const L of lms) {
      for (const v of L.h) { dv.setInt16(p, v); p += 2; }
      for (const v of L.w) { dv.setInt16(p, v); p += 2; }
    }
    for (let s0 = f0; s0 < f0 + flen; s0 += SLICE_LEN) {
      const slen = Math.min(SLICE_LEN, f0 + flen - s0);
      for (let c = 0; c < channels; c++) {
        let best = Infinity, bestHi = 0, bestLo = 0, bestLms = null, bestSf = 0;
        for (let k = 0; k < 16; k++) {
          // the previous slice's scale factor first: the search often stops early there
          const sf = (k + prevSf[c]) & 15;
          const h = lms[c].h.slice(), w = lms[c].w.slice();
          let err = 0, hi = 0, lo = sf;
          for (let i = 0; i < slen; i++) {
            const smp = pcm[(s0 + i) * channels + c];
            const pred = (w[0] * h[0] + w[1] * h[1] + w[2] * h[2] + w[3] * h[3]) >> 13;
            const r = smp - pred;
            let sc = div(r, sf);
            sc = sc < -8 ? -8 : sc > 8 ? 8 : sc;
            const q = QUANT[sc + 8], dq = DEQUANT[sf][q];
            const rec = clamp16(pred + dq), e = smp - rec;
            // keeps the LMS weights from growing without bound (qoa.h)
            let wp = ((w[0] * w[0] + w[1] * w[1] + w[2] * w[2] + w[3] * w[3]) / 262144 | 0) - 0x8ff;
            if (wp < 0) wp = 0;
            err += e * e + wp * wp;
            if (err > best) break;
            const d = dq >> 4;
            for (let j = 0; j < 4; j++) w[j] += h[j] < 0 ? -d : d;
            h[0] = h[1]; h[1] = h[2]; h[2] = h[3]; h[3] = rec;
            hi = ((hi << 3) | (lo >>> 29)) >>> 0; lo = ((lo << 3) | q) >>> 0;
          }
          if (err < best) { best = err; bestHi = hi; bestLo = lo; bestLms = { h, w }; bestSf = sf; }
        }
        prevSf[c] = bestSf;
        lms[c] = bestLms;
        for (let i = slen; i < SLICE_LEN; i++) { bestHi = ((bestHi << 3) | (bestLo >>> 29)) >>> 0; bestLo = (bestLo << 3) >>> 0; }
        dv.setUint32(p, bestHi); dv.setUint32(p + 4, bestLo); p += 8;
      }
    }
  }
  return out.subarray(0, p);
}

export function writeQoa(file, samples, rate = 48000, channels = 2) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, encodeQoa(samples, rate, channels));
}
