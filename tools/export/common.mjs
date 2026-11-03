// Shared helpers for the asset exporters (tools/export/*): disk access, PNG/WAV writers,
// X68000 colours. Exported assets go to ../work/export (game data: never commit them).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { Disk, displayName } from '../../src/fs.js';
import { root } from '../root.mjs';

export { root };
export const exportDir = process.env.IC_EXPORT ?? `${root}/work/export`;

export function diskPath(i) { return `${root}/Genei Toshi (1991)(Microcabin)(Disk ${i} of 7).dim`; }

let disks = null;
export function loadDisks() {
  disks ??= [1, 2, 3, 4, 5, 6, 7].map((i) => new Disk(new Uint8Array(fs.readFileSync(diskPath(i))), `disk${i}`));
  return disks;
}

// Every file on the seven disks: { disk, path ('GROUP00/000001.DAT', display names), data }.
// Files present on several disks are listed once per disk.
export function allFiles() {
  const out = [];
  loadDisks().forEach((d, k) => {
    const walk = (n, p) => {
      for (const c of n.children.values()) {
        const q = p ? `${p}/${displayName(c.name)}` : displayName(c.name);
        if (c.isDir) walk(c, q); else out.push({ disk: k + 1, path: q, data: c.data });
      }
    };
    walk(d.root, '');
  });
  return out;
}

// First copy of a file by path (case-insensitive, '/' or '\' separators), searching disk 1 to 7
// unless a disk number is given.
export function readFile(p, disk) {
  const parts = p.toUpperCase().split(/[\\/]/).filter(Boolean);
  const list = disk ? [loadDisks()[disk - 1]] : loadDisks();
  for (const d of list) { const n = d.lookup(parts); if (n && !n.isDir) return n.data; }
  return null;
}

export function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); return p; }

// X68000 palette word (GGGGG RRRRR BBBBB I) -> [r, g, b] 8-bit, as src/video.js renders it.
export function x68kColor(w) {
  const i = w & 1;
  const c5 = (v) => Math.round((((v << 1) | i) * 255) / 63);
  return [c5((w >> 6) & 31), c5((w >> 11) & 31), c5((w >> 1) & 31)];
}

const crcTable = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

// rgba: Uint8Array of w*h*4 bytes.
export function writePng(file, rgba, w, h) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

// Interleaved float samples in [-1, 1] -> 16-bit PCM WAV.
export function writeWav(file, samples, rate = 48000, channels = 2) {
  const n = samples.length;
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(channels, 22); b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * channels * 2, 28); b.writeUInt16LE(channels * 2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), 44 + i * 2);
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, b);
}

export function writeJson(file, value) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(value, null, 1) + '\n');
}
