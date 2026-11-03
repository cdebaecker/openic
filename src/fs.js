// Human68k FAT12 disk image (.DIM / raw XDF) reader.
// The image is parsed into an in-memory tree; writes go to the tree only.

const sjisDecoder = new TextDecoder('shift_jis');

export class VNode {
  constructor(name, attr, data = null) {
    this.name = name;        // raw Shift-JIS bytes as latin1 string, upper case
    this.attr = attr;        // 0x10 = directory, 0x20 = archive, 0x01 = read-only
    this.data = data;        // Uint8Array for files
    this.children = attr & 0x10 ? new Map() : null;
    this.time = 0; this.date = 0;
  }
  get isDir() { return (this.attr & 0x10) !== 0; }
}

function latin1(bytes) { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return s; }

export function displayName(n) {
  const b = new Uint8Array(n.length);
  for (let i = 0; i < n.length; i++) b[i] = n.charCodeAt(i);
  return sjisDecoder.decode(b);
}

export class Disk {
  constructor(image, label = '') {
    this.label = label;
    let data = image;
    // DIM images carry a 256 byte header
    if (data.length === 1261824 || data.length === 1261568 + 256) data = data.subarray(256);
    this.root = new VNode('', 0x10);
    this.parse(data);
  }

  parse(data) {
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const bps = dv.getUint16(0x0b, true);
    const spc = data[0x0d];
    const reserved = dv.getUint16(0x0e, true);
    const nfats = data[0x10];
    const rootents = dv.getUint16(0x11, true);
    const spf = dv.getUint16(0x16, true);
    const fatOff = reserved * bps;
    const rootOff = fatOff + nfats * spf * bps;
    const dataOff = Math.ceil((rootOff + rootents * 32) / bps) * bps;
    const csize = bps * spc;
    const fat = data.subarray(fatOff, fatOff + spf * bps);
    const next = (c) => {
      const o = (c * 3) >> 1;
      const v = fat[o] | (fat[o + 1] << 8);
      return c & 1 ? v >> 4 : v & 0xfff;
    };
    const readChain = (c, size) => {
      const parts = [];
      let guard = 0;
      while (c >= 2 && c < 0xff0 && guard++ < 4096) {
        parts.push(data.subarray(dataOff + (c - 2) * csize, dataOff + (c - 1) * csize));
        c = next(c);
      }
      const total = parts.reduce((n, p) => n + p.length, 0);
      const out = new Uint8Array(size ?? total);
      let o = 0;
      for (const p of parts) {
        const n = Math.min(p.length, out.length - o);
        if (n <= 0) break;
        out.set(p.subarray(0, n), o); o += n;
      }
      return out;
    };
    const walk = (bytes, dir) => {
      for (let i = 0; i + 32 <= bytes.length; i += 32) {
        const e = bytes.subarray(i, i + 32);
        if (e[0] === 0) break;
        if (e[0] === 0xe5) continue;
        const attr = e[11];
        if (attr & 0x08) continue;
        let base = latin1(e.subarray(0, 8)).replace(/ +$/, '');
        // Human68k long names: bytes 12..21 extend the 8 char name
        const ext2 = latin1(e.subarray(12, 22)).replace(/[\0 ]+$/, '');
        if (base.length === 8 && ext2) base += ext2;
        if (base.charCodeAt(0) === 0x05) base = '\xe5' + base.slice(1);
        const ext = latin1(e.subarray(8, 11)).replace(/ +$/, '');
        const name = ext ? `${base}.${ext}` : base;
        if (name === '.' || name === '..') continue;
        const dv2 = new DataView(e.buffer, e.byteOffset, 32);
        const clus = dv2.getUint16(26, true);
        const size = dv2.getUint32(28, true);
        const node = new VNode(name.toUpperCase(), attr);
        node.time = dv2.getUint16(22, true);
        node.date = dv2.getUint16(24, true);
        dir.children.set(node.name, node);
        if (attr & 0x10) walk(readChain(clus), node);
        else node.data = readChain(clus, size);
      }
    };
    walk(data.subarray(rootOff, rootOff + rootents * 32), this.root);
  }

  // path: array of components (latin1 strings), already upper-cased
  lookup(parts) {
    let n = this.root;
    for (const p of parts) {
      if (!p) continue;
      if (!n.isDir) return null;
      n = n.children.get(p);
      if (!n) return null;
    }
    return n;
  }
}
