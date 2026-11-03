// A scriptable emulator session for investigations and tests: boots the game on a fixed clock,
// plays input scripts (the tools/live.mjs command subset: run, key, click, hold, move) and
// saves/loads whole-machine states to disk, so experiments can start from a saved point
// (e.g. free control after the intro) instead of replaying the route each time.
//
//   import { Session } from './emu.mjs';
//   const s = await Session.create();          // boot
//   s.play(fs.readFileSync('tools/scripts/route-to-free-control.txt', 'utf8'));
//   s.save('../work/states/free.state');      // later: Session.create({ state: path })
import fs from 'node:fs';
import v8 from 'node:v8';
import zlib from 'node:zlib';
import path from 'node:path';
import { X68k } from '../src/x68k.js';
import { Disk, VNode } from '../src/fs.js';
import { Font } from '../src/font.js';
import { snapshot, restore } from '../src/state.js';
import { root, isMain } from './root.mjs';
import { writePng } from './export/common.mjs';

export const EPOCH = Date.UTC(1993, 4, 24, 12, 0, 0);

function loadDisks() {
  const disks = [];
  for (let i = 1; i <= 7; i++) disks.push(new Disk(new Uint8Array(fs.readFileSync(`${root}/Genei Toshi (1991)(Microcabin)(Disk ${i} of 7).dim`)), `disk${i}`));
  return disks;
}

export class Session {
  static async create({ state = null, log = () => {} } = {}) {
    const s = new Session(log);
    if (state) s.load(state);
    return s;
  }

  constructor(log) {
    this.disks = loadDisks();
    const cgromFile = `${root}/work/cgrom.bin`;
    const font = fs.existsSync(cgromFile) ? new Font(new Uint8Array(fs.readFileSync(cgromFile))) : new Font();
    this.sys = new X68k({ epoch: EPOCH, disks: this.disks, font, log });
    this.sys.boot([['A:\\ZMUSIC.X', '-U -BICITY.ZPD'], ['A:\\LOAD.X', '']]);
  }

  get m() { return this.sys.m; }
  get frame() { return this.sys.frameCount; }

  run(n = 1) { for (let i = 0; i < n; i++) this.sys.runFrame(); }

  key(code, frames = 6) { this.sys.keyEvent(code, true); this.run(frames); this.sys.keyEvent(code, false); }

  click(x, y, button = 0) {
    const io = this.sys.iocs;
    io.mouseMove(x, y); this.run(4);
    io.mouseButton(button, true); this.run(6); io.mouseButton(button, false); this.run(4);
  }

  hold(x, y, frames, button = 0) {
    const io = this.sys.iocs;
    io.mouseMove(x, y); this.run(2);
    io.mouseButton(button, true); this.run(frames); io.mouseButton(button, false);
  }

  // Lines in tools/live.mjs syntax; other commands are ignored.
  play(script) {
    for (const line of script.split('\n')) {
      const a = line.trim().split(/\s+/);
      switch (a[0]) {
        case 'run': this.run(Number(a[1] ?? 60)); break;
        case 'key': this.key(Number(a[1]), Number(a[2] ?? 6)); break;
        case 'click': this.click(Number(a[1]), Number(a[2]), a[3] === 'right' ? 2 : 0); break;
        case 'hold': this.hold(Number(a[1]), Number(a[2]), Number(a[3])); break;
        case 'move': this.sys.iocs.mouseMove(Number(a[1]), Number(a[2])); break;
      }
    }
  }

  shot(file) {
    const v = this.sys.video, n = v.frameW * v.frameH, rgba = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) { const p = v.frame[i]; rgba[i * 4] = p & 255; rgba[i * 4 + 1] = (p >> 8) & 255; rgba[i * 4 + 2] = (p >> 16) & 255; rgba[i * 4 + 3] = 255; }
    writePng(file, rgba, v.frameW, v.frameH);
  }

  // --- states on disk: Disk and VNode objects are stored as references and swapped back -----
  nodeIds() {
    const ids = new Map(), byId = [];
    this.disks.forEach((d) => {
      const walk = (n) => { ids.set(n, byId.length); byId.push(n); if (n.children) for (const c of n.children.values()) walk(c); };
      walk(d.root);
    });
    return { ids, byId };
  }

  save(file) {
    const { ids } = this.nodeIds();
    const seen = new Map();
    const enc = (v) => {
      if (v === null || typeof v !== 'object' || ArrayBuffer.isView(v)) return v;
      if (v instanceof Disk) return { __disk: this.disks.indexOf(v) };
      if (v instanceof VNode) return ids.has(v) ? { __node: ids.get(v) } : { __newnode: { name: v.name, attr: v.attr, data: v.data, time: v.time, date: v.date } };
      if (seen.has(v)) return seen.get(v);
      if (Array.isArray(v)) { const o = []; seen.set(v, o); for (const x of v) o.push(enc(x)); return o; }
      if (v instanceof Map) { const o = new Map(); seen.set(v, o); for (const [k, x] of v) o.set(k, enc(x)); return o; }
      if (v instanceof Set) return new Set([...v].map(enc));
      const o = {}; seen.set(v, o);
      for (const k of Object.keys(v)) o[k] = enc(v[k]);
      return o;
    };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, zlib.gzipSync(v8.serialize(enc(snapshot(this.sys)))));
  }

  load(file) {
    const { byId } = this.nodeIds();
    const dec = (v) => {
      if (v === null || typeof v !== 'object' || ArrayBuffer.isView(v)) return v;
      if ('__disk' in v) return this.disks[v.__disk];
      if ('__node' in v) return byId[v.__node];
      if ('__newnode' in v) { const n = new VNode(v.__newnode.name, v.__newnode.attr, v.__newnode.data); n.time = v.__newnode.time; n.date = v.__newnode.date; return n; }
      if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) v[i] = dec(v[i]); return v; }
      if (v instanceof Map) { for (const [k, x] of v) v.set(k, dec(x)); return v; }
      for (const k of Object.keys(v)) v[k] = dec(v[k]);
      return v;
    };
    restore(this.sys, dec(v8.deserialize(zlib.gunzipSync(fs.readFileSync(file)))));
  }
}

// CLI: node tools/emu.mjs <script.txt|-> <out.state|-> [--from in.state] [--shot out.png] [--block out.block]
// --block writes the game's 954-byte state block ($9C794, the save-file block) at the end, e.g.
//   node tools/emu.mjs - - --from ../work/states/free.state --block ../work/states/free.block
if (isMain(import.meta.url)) {
  const [script, out] = process.argv.slice(2).map((a) => (a === '-' ? null : a));
  const arg = (f) => { const i = process.argv.indexOf(f); return i > 0 ? process.argv[i + 1] : null; };
  const s = await Session.create({ state: arg('--from') });
  const t0 = Date.now();
  if (script) s.play(fs.readFileSync(script, 'utf8'));
  if (out) s.save(out);
  if (arg('--shot')) s.shot(arg('--shot'));
  if (arg('--block')) {
    const m = s.sys.m, block = new Uint8Array(954);
    for (let i = 0; i < block.length; i++) block[i] = m.r8(0x9c794 + i);
    fs.mkdirSync(path.dirname(arg('--block')), { recursive: true });
    fs.writeFileSync(arg('--block'), block);
  }
  console.log(`frame ${s.frame} (${((Date.now() - t0) / 1000).toFixed(0)} s)${out ? ` -> ${out}` : ''}`);
}
