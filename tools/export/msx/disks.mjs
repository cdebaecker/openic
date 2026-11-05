// The MSX turbo R version's disks: finds the eight game disks among the images of a
// folder by their volume label (boot sector bytes 3-10, "IPROJ01".."IPROJ08"), reads each disk's
// system file table (sector 11: 2 bytes per file, start sector and count) and its index (file 6,
// "INF"), whose third table lists the songs (3 bytes each: u16 start sector, u8 sector count).
import fs from 'node:fs';
import path from 'node:path';

export const DISK_SIZE = 737280;   // 720 KB, 2DD, 9 sectors per track, 512-byte sectors

// Disk number (1-8) -> image bytes, for the images in `dir` (raw .dsk; the game uses no file system)
export function findMsxDisks(dir) {
  const found = new Map();
  if (!dir || !fs.existsSync(dir)) return found;
  const walk = (d, depth) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (depth < 1) walk(p, depth + 1); continue; }
      if (!/\.(dsk|di1)$/i.test(e.name) || fs.statSync(p).size !== DISK_SIZE) continue;
      const b = fs.readFileSync(p);
      const m = /^IPROJ0([1-8])$/.exec(b.toString('latin1', 3, 10));
      if (m && !found.has(+m[1])) found.set(+m[1], b);
    }
  };
  walk(dir, 0);
  return found;
}

export function systemFile(disk, n) {
  const s = disk[0x1600 + 2 * n], c = disk[0x1600 + 2 * n + 1];
  return disk.subarray(s * 512, (s + c) * 512);
}

// INF tables: sizes at +6 (u16 each, five tables), data from +$20; table 0 maps, table 2 songs
export function infTables(disk) {
  const inf = systemFile(disk, 6);
  if (inf.toString('latin1', 0, 3) !== 'INF') return null;
  const tables = []; let p = 0x20;
  for (let k = 0; k < 5; k++) { const n = inf.readUInt16LE(6 + 2 * k); tables.push(inf.subarray(p, p + n)); p += n; }
  return tables;
}

// Song number -> [{disk, data}] for the FM songs (1-37) on the given disks
export function fmSongs(disks) {
  const out = new Map();
  for (const [n, d] of [...disks].sort((a, b) => a[0] - b[0])) {
    const t = infTables(d)?.[2]; if (!t) continue;
    for (let i = 0; (i + 1) * 3 <= t.length && i < 37; i++) {
      const c = t[i * 3 + 2]; if (!c) continue;
      const s = t.readUInt16LE(i * 3);
      if (!out.has(i + 1)) out.set(i + 1, []);
      out.get(i + 1).push({ disk: n, data: d.subarray(s * 512, (s + c) * 512) });
    }
  }
  return out;
}
