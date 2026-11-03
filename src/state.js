// In-memory machine snapshots: every piece of emulated state (RAM, CPU,
// devices, OS bookkeeping) is copied; host-side objects (disks, callbacks,
// fonts) are shared by reference.

import { VNode, Disk } from './fs.js';

const SKIP = new Set(['sys', 'm', 'cpu', 'bus', 'table', 'log', 'console', 'font', 'iocs', 'human',
  'onIrq', 'onCT', 'onMissingFile', 'onLookup', 'irqVector', 'hle', 'extraHle', 'audioOut', 'audioBuf',
  'frame', 'lineBuf', 'txLine', 'grLine', 'spLine', 'consoleEcho', 'disks', 'onDiskSwap', 'onMouseWarp']);

function clone(v) {
  if (v === null || typeof v !== 'object') return v;
  if (ArrayBuffer.isView(v)) return v.slice();
  if (v instanceof VNode || v instanceof Disk) return v;
  if (Array.isArray(v)) return v.map(clone);
  if (v instanceof Map) return new Map([...v].map(([k, x]) => [k, clone(x)]));
  if (v instanceof Set) return new Set(v);
  const out = Object.create(Object.getPrototypeOf(v));
  for (const k of Object.keys(v)) {
    if (SKIP.has(k) || typeof v[k] === 'function') continue;
    out[k] = clone(v[k]);
  }
  return out;
}

function copyInto(target, src) {
  for (const k of Object.keys(src)) {
    const sv = src[k], tv = target[k];
    if (ArrayBuffer.isView(sv) && ArrayBuffer.isView(tv) && tv.length === sv.length) tv.set(sv);
    else if (sv && typeof sv === 'object' && !Array.isArray(sv) && !(sv instanceof Map) && !(sv instanceof Set)
      && !ArrayBuffer.isView(sv) && !(sv instanceof VNode) && !(sv instanceof Disk) && tv && typeof tv === 'object') copyInto(tv, sv);
    else target[k] = clone(sv);
  }
}

const PARTS = ['video', 'mfp', 'opm', 'adpcm', 'dmac', 'iocs', 'human'];

export function snapshot(sys) {
  const cpu = sys.cpu;
  return {
    ram: sys.m.ram.slice(),
    cpu: {
      d: cpu.d.slice(), a: cpu.a.slice(), pc: cpu.pc, usp: cpu.usp, ssp: cpu.ssp, s: cpu.s, t: cpu.t, ipl: cpu.ipl,
      x: cpu.x, n: cpu.n, z: cpu.z, v: cpu.v, c: cpu.c, cycles: cpu.cycles, stopped: cpu.stopped, pendingIrq: cpu.pendingIrq,
    },
    parts: Object.fromEntries(PARTS.map((p) => [p, clone(sys[p])])),
    sys: {
      sysport: clone(sys.sysport), joy: sys.joy.slice(), ppiC: sys.ppiC, sram: sys.sram.slice(), emuTime: sys.emuTime,
      frameCount: sys.frameCount, audioAcc: sys.audioAcc, commands: clone(sys.commands), finished: sys.finished,
      lastMarker: clone(sys.lastMarker), probing: clone(sys.probing), vdispSlot: sys.vdispSlot,
    },
  };
}

export function restore(sys, s) {
  sys.m.ram.set(s.ram);
  const cpu = sys.cpu;
  cpu.d.set(s.cpu.d); cpu.a.set(s.cpu.a);
  for (const k of ['pc', 'usp', 'ssp', 's', 't', 'ipl', 'x', 'n', 'z', 'v', 'c', 'cycles', 'stopped', 'pendingIrq']) cpu[k] = s.cpu[k];
  for (const p of PARTS) copyInto(sys[p], s.parts[p]);
  for (const [k, v] of Object.entries(s.sys)) {
    if (ArrayBuffer.isView(v) && ArrayBuffer.isView(sys[k])) sys[k].set(v);
    else sys[k] = clone(v);
  }
}
