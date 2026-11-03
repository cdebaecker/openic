// A zip writer (deflate, or stored where deflate does not help: PNG, QOA, Ogg), so the game data pack
// and the releases can be built without a zip program (Windows has none). Godot mounts the game
// data pack as a resource pack.
//
//   writeZip(zipFile, dir)   puts every file under dir in the zip as <basename of dir>/<relative path>
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const CRC = new Int32Array(256);
for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c; }
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function listFiles(dir, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listFiles(dir, r)); else if (e.isFile()) out.push(r);
  }
  return out;
}

export function writeZip(zipFile, dir) {
  const files = listFiles(dir);
  if (files.length > 0xffff) throw new Error(`${files.length} files: more than a zip without zip64 holds`);
  const fd = fs.openSync(zipFile, 'w');
  const central = [];
  let offset = 0;
  // DOS time of 1980-01-01 00:00 for every entry: the pack's content does not depend on the build time
  const dosTime = 0, dosDate = (0 << 9) | (1 << 5) | 1;
  for (const rel of files) {
    const raw = fs.readFileSync(path.join(dir, rel));
    const packed = zlib.deflateRawSync(raw, { level: 9 });
    const deflate = packed.length < raw.length * 0.95;   // method 8, else 0 (stored)
    const data = deflate ? packed : raw;
    const name = Buffer.from(`${path.basename(dir)}/${rel}`, 'utf8');
    if (offset + data.length > 0xffffffff) throw new Error('zip larger than 4 GB');
    const crc = crc32(raw), method = deflate ? 8 : 0, version = deflate ? 20 : 10;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(version, 4); local.writeUInt16LE(0x800, 6);   // UTF-8 names
    local.writeUInt16LE(method, 8); local.writeUInt16LE(dosTime, 10); local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    fs.writeSync(fd, local); fs.writeSync(fd, name); fs.writeSync(fd, data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(version, 6); c.writeUInt16LE(0x800, 8);
    c.writeUInt16LE(method, 10); c.writeUInt16LE(dosTime, 12); c.writeUInt16LE(dosDate, 14);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(raw.length, 24);
    c.writeUInt16LE(name.length, 28); c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(central);
  fs.writeSync(fd, cd);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  fs.writeSync(fd, end);
  fs.closeSync(fd);
  return files.length;
}
