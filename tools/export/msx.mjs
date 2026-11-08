// The MSX version's FM music (MSX-MUSIC YM2413 + PSG) as chip logs for live synthesis, from the
// player's own MSX turbo R disks. Optional: without the disks it writes nothing.
//
// The game's own sound driver (disk 1 system file 0, loaded at 8000h of mapper segment 4) runs in
// a Z80 interpreter: function 0 (init), function 9 with HL = the song (loaded at 9800h as the game
// does), then the tick at 8000h once per frame, as the VDP interrupt calls it. Its OPLL (ports
// 7Ch/7Dh) and PSG (A0h/A1h) writes are recorded per frame until the song loops, then written as
// an MSL1 chip log (native/src/chipsynth.h). The song numbers are the X68000's (bgm_NN).
//
// Usage: node tools/export/msx.mjs [--disks DIR]    (default: $IC_MSX_DISKS, else the root folder)
// Output: ../work/export/msx/music/bgm_NN.msl and msx/index.json (fields of audio/index.json).
import fs from 'node:fs';
import path from 'node:path';
import { root, exportDir, ensureDir, writeJson } from './common.mjs';
import { Z80 } from './msx/z80.mjs';
import { findMsxDisks, systemFile, fmSongs } from './msx/disks.mjs';
import { detectLoop } from './audio/render.mjs';

const OUT = `${exportDir}/msx`;
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const FPS = 59.9227;               // NTSC VDP interrupt (MSX turbo R, 60 Hz mode)
const UNIT = 1000;                 // log time units per frame: rate = FPS * UNIT

// The custom FM voice most songs set: the OPLL keeps the last one set, so a song that uses
// instrument 0 before setting its own plays with the voice the previous songs left
const DEFAULT_VOICE = [0x51, 0x61, 0x17, 0x07, 0x50, 0xf1, 0x5c, 0xdc];

// Start one song. driver: disk 1 system files 0-3, put where the game's loader (file 4) puts them
// in the sound segment: the driver at 8000h, file 1 (PSG envelopes, voices) at 9000h, the effect
// and jingle tables at 9200h and 9980h. Returns { log: [{f, chip, reg, val}], run(frames) }:
// run() ticks on up to `frames` in total and tells whether the song stopped.
export function startSong(driver, song) {
  const mem = new Uint8Array(0x10000);
  for (const [data, at] of driver) mem.set(data.subarray(0, Math.min(data.length, 0x10000 - at)), at);
  mem.set(song.subarray(0, Math.min(song.length, 0x10000 - 0x9800)), 0x9800);
  const log = []; let frame = 0, timer = 0, psgReg = 0, opllReg = 0;
  const psg = new Uint8Array(16);
  const io = {
    in(port) { port &= 255; if (port === 0xe6) { timer = (timer + 3) & 255; return timer; } if (port === 0xa2) return psg[psgReg & 15]; return 0xff; },
    out(port, v) {
      port &= 255;
      if (port === 0xa0) psgReg = v;
      else if (port === 0xa1) { psg[psgReg & 15] = v; log.push({ f: frame, chip: 2, reg: psgReg & 15, val: v }); }
      else if (port === 0x7c) opllReg = v;
      else if (port === 0x7d) log.push({ f: frame, chip: 1, reg: opllReg, val: v });
    },
  };
  const cpu = new Z80(mem, io);
  const call = (pc, regs = {}) => {
    Object.assign(cpu, regs); cpu.sp = 0xf000; cpu.push(0xfff0); cpu.pc = pc;
    for (let n = 0; cpu.pc !== 0xfff0; n++) { cpu.step(); if (n > 5e6) throw new Error(`driver runaway at ${cpu.pc.toString(16)}`); }
    return cpu.a;
  };
  call(0x8003, { a: 0 });
  call(0x8003, { a: 9, h: 0x98, l: 0x00 });
  // frame 0 starts with the common custom voice unless the song sets one at once
  DEFAULT_VOICE.forEach((val, reg) => log.push({ f: 0, chip: 1, reg, val }));
  const s = { log, frames: 0, stopped: false };
  s.run = (frames) => {
    while (!s.stopped && s.frames < frames) {
      frame = s.frames;
      call(0x8000);
      if (frame % 60 === 59 && !call(0x8003, { a: 6 })) s.stopped = true;   // frames: the stop frame
      else s.frames++;
    }
    return s.stopped;
  };
  return s;
}

const token = (e) => (e.chip << 16) | (e.reg << 8) | e.val;
// a key-on or an audible PSG volume in the events: false for the idle repeat after a song ends
const audible = (evs) => evs.some((e) => (e.chip === 1 && ((e.reg >= 0x20 && e.reg <= 0x28 && (e.val & 0x10)) || (e.reg === 0x0e && (e.val & 0x1f))))
  || (e.chip === 2 && e.reg >= 8 && e.reg <= 10 && (e.val & 0x1f)));

function findLoop(log) {
  const ev = []; for (const e of log) ev.push(e.f, token(e));
  return detectLoop(ev, { rate: 60, minPeriodSec: 2 });
}
// per-channel loops when the whole never repeats: the longest period, from the latest start
function approxLoop(log) {
  const ch = (e) => e.chip === 1 ? (e.reg >= 0x10 && e.reg < 0x40 ? `fm${e.reg & 15}` : e.reg === 0x0e ? 'rhythm' : null)
    : (e.reg < 6 ? `psg${e.reg >> 1}` : e.reg >= 8 && e.reg <= 10 ? `psg${e.reg - 8}` : e.reg === 6 ? 'noise' : null);
  const by = {};
  for (const e of log) { const k = ch(e); if (k) (by[k] ??= []).push(e.f, token(e)); }
  let start = 0, period = 0;
  for (const ev of Object.values(by)) {
    const L = detectLoop(ev, { rate: 60, minPeriodSec: 2, window: 24 });
    if (!L) continue;
    start = Math.max(start, L.start); period = Math.max(period, Math.round(L.period));
  }
  return period ? { start, period } : null;
}

// Writes within a frame are spread as the driver spaces them on the machine (its OPLL write routine
// waits on the system timer, about 25 us, between writes): the chip must see a key-off before the
// key-on that follows it in the same frame, or a decaying instrument never sounds again.
const OPLL_GAP = 3, PSG_GAP = 1;   // log units (1/1000 frame, about 16.7 us)

function writeLog(file, log, loopStart, end) {
  const out = []; let last = 0, loopOff = -1, frame = -1, sub = 0;
  const u8 = (v) => out.push(v & 255);
  for (const e of log) {
    if (e.f >= end) break;
    if (e.f !== frame) { frame = e.f; sub = 0; }
    const t = e.f * UNIT + Math.min(sub, UNIT - 1);
    sub += e.chip === 1 ? OPLL_GAP : PSG_GAP;
    if (loopOff < 0 && loopStart >= 0 && e.f >= loopStart) loopOff = out.length;
    let d = t - last; last = t;
    do { u8((d & 127) | (d > 127 ? 128 : 0)); d = Math.floor(d / 128); } while (d);
    u8(e.chip); u8(e.reg); u8(e.val);
  }
  if (loopOff < 0) loopOff = out.length;
  const h = Buffer.alloc(24);
  h.write('MSL1', 0); h.writeUInt32LE(Math.round(FPS * UNIT), 4);
  h.writeUInt32LE(loopStart >= 0 ? loopStart * UNIT : 0xffffffff, 8); h.writeUInt32LE(end * UNIT, 12);
  h.writeUInt32LE(loopOff, 16); h.writeUInt32LE(out.length, 20);
  fs.writeFileSync(file, Buffer.concat([h, Buffer.from(out)]));
}

const dir = path.resolve(arg('--disks', process.env.IC_MSX_DISKS ?? root));
const disks = findMsxDisks(dir);
if (!disks.has(1)) {
  console.log(`msx: no MSX game disk 1 in ${dir} (the MSX music needs the player's own MSX turbo R disks): nothing written`);
  process.exit(0);
}
const driver = [[0, 0x8000], [1, 0x9000], [2, 0x9200], [3, 0x9980]].map(([k, at]) => [systemFile(disks.get(1), k), at]);
const songs = fmSongs(disks);
ensureDir(`${OUT}/music`);
const items = [];
const t0 = Date.now();
for (const n of [...songs.keys()].sort((a, b) => a - b)) {
  if (n > 35) continue;                         // 36, 37: one-sector stubs no map plays
  const copies = songs.get(n);
  const src = copies.find((c) => c.disk !== 1) ?? copies[0];   // disk 1 holds the opening's versions
  const r = startSong(driver, src.data);
  r.run(Math.round(600 * FPS));
  let L = r.stopped ? null : findLoop(r.log), approx = false;
  if (!r.stopped && !L) { r.run(Math.round(1500 * FPS)); L = r.stopped ? null : findLoop(r.log); }   // long loops
  let loopStart = -1, end;
  if (L) {
    const S = Math.round(L.start), P = Math.round(L.period);
    if (audible(r.log.filter((e) => e.f >= S && e.f < S + P))) { loopStart = S; end = S + P; }
    else end = S + 60;                          // the song ended: keep a second of release
  } else if (!r.stopped) {
    const A = approxLoop(r.log);
    if (A) { loopStart = A.start; end = A.start + A.period; approx = true; }
    else end = r.frames;
  } else end = r.frames + 60;
  const name = `bgm_${String(n).padStart(2, '0')}`;
  writeLog(`${OUT}/music/${name}.msl`, r.log, loopStart, end);
  const item = { name, kind: 'music', file: null, chip_log: `music/${name}.msl`, source: `MSX disk ${src.disk}, song ${n}`,
    source_disks: copies.map((c) => c.disk), duration: +(end / FPS).toFixed(4), loop: loopStart >= 0 };
  if (loopStart >= 0) Object.assign(item, { loop_start_sec: +(loopStart / FPS).toFixed(4), loop_end_sec: +(end / FPS).toFixed(4) });
  if (approx) Object.assign(item, { loop_approx: true, loop_note: 'channels loop at different lengths: the longest channel loop' });
  items.push(item);
  console.log(`${name}  disk ${src.disk}  ${item.loop ? `loop ${item.loop_start_sec.toFixed(2)}-${item.loop_end_sec.toFixed(2)} s${approx ? ' (approx)' : ''}` : `${item.duration.toFixed(1)} s, no loop`}`);
}
writeJson(`${OUT}/index.json`, {
  generator: 'tools/export/msx.mjs', driver: 'the MSX version\'s FM sound driver (disk 1 system file 0) in a Z80 interpreter',
  format: 'MSL1 chip logs (YM2413 + YM2149), played live by the chipsynth extension', items,
});
console.log(`${items.length} items in ${OUT}/index.json (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
