// "EVT\0" map event files (file table 6), loaded by ICITY68 f_69e80.
//
// Header (32 bytes, $A062C):
//   +0 "EVT\0" +4 u16 file size +6 u16 actor block size (0x150) +8 u16 trigger block size (0x190)
//   +10 u16 block-3 size (0x48) +12 u16 part-1 size +14 u16 part-2 size
//   +16 u8 ? +17 u8 ? +18 u8 trigger count ($A063E) +19 u8 ? +20 u8 ? +21 u8 cutscene count ($A0641)
//   +22..31 unknown (last 4 bytes look like a checksum)
// Blocks: actors ($A04DC), triggers ($A034C), block 3 ($A02FC), then part 1 + part 2 copied to
// the script buffer ($A0654).
//   actors:   16 bytes of sprite-set ids (table 8 index - 1, $FF = none) + 40 x 8-byte records
//             (u16 x, u16 y, u16, u16) — initial actor placement (partially understood)
//   triggers: 16-byte header + 32 x 12-byte records (f_79b3a):
//             u16 x, u16 y (map tile units), u8 w, u8 h, u16 entry (part-2 VM offset, run by
//             f_7c804(1, entry) when the leader steps inside), map[3] (destination id for
//             doors, or zeros), u8 flags (bit 7 + direction bits; f_79d4c)
//   part 1:   cutscene ("letter") scripts: u16 offsets[n] (relative to the end of the table),
//             then byte code (see LETTERS); run by VM builtin 0 (f_78622 / step f_78784).
//   part 2:   VM byte code + message text (see vm.mjs); base offset 0 = start of part 2.
import { disassemble, formatIns, sweep } from './vm.mjs';
import { toText, isLead } from '../../../src/text/codec.js';

const u16 = (b, a) => b[a] | (b[a + 1] << 8);
const s16 = (v) => (v < 32768 ? v : v - 65536);

// Letter commands of the cutscene language (string "SMALTPGCgpmwfBbEe" at $9C106; f_798b0).
// Operand sizes from the handlers in f_78784.
export const LETTERS = {
  S: { what: 'show/hide actors', args: 'n, n x (actor u8, visible u8)' },
  M: { what: 'move actors', args: 'n, n x 10-byte move record (actor u8, mode u8, ...) -> $A0138+10*actor' },
  A: { what: 'tile animation / map part state', args: 'n, n x (code u8, value u8); code&$E0: $80 anim set A ($C100), $A0 anim set B ($C300), $C0 $C280, $E0 $C080; code&$1F = index' },
  L: { what: 'L (5 bytes -> $9FFF0; scroll/look?)', args: '5 bytes' },
  T: { what: 'talk: show message', args: 'u16 key (message key-1 in the map message table), u8 mode (\'c\' = wait)' },
  P: { what: 'palette', args: 'u8 ?, n, n x (index u8, u16 colour)' },
  G: { what: 'G (2 bytes -> $9FFE6; \'c\' = wait)', args: '2 bytes' },
  C: { what: 'C (no-op, skips 3 bytes)', args: '3 bytes' },
  g: { what: 'g (1 byte)', args: '1 byte' },
  p: { what: 'p (1 byte)', args: '1 byte' },
  m: { what: 'm (no-op, skips 4 bytes)', args: '4 bytes' },
  w: { what: 'wait/speed', args: 'u8 (<=9: speed = n/2+5, else n) -> $9CB2E' },
  f: { what: 'facing/frame', args: 'u8 -> $9FFF6 = n+1' },
  B: { what: 'music', args: 'u8 track (table 7 index - 1)' },
  b: { what: 'b (1 byte)', args: '1 byte' },
  E: { what: 'end of step (the interpreter returns; next frame continues after it)', args: '' },
  e: { what: 'end of script', args: '' },
};

function decodeLetters(b, start, end) {
  const out = []; let p = start;
  while (p < end) {
    const c = String.fromCharCode(b[p]), at = p; p++;
    let args;
    switch (c) {
      case 'S': case 'A': { const n = b[p++]; args = [n]; for (let i = 0; i < n; i++) { args.push([b[p], b[p + 1]]); p += 2; } break; }
      case 'M': { const n = b[p++]; args = [n]; for (let i = 0; i < n; i++) { args.push([...b.subarray(p, p + 10)]); p += 10; } break; }
      case 'P': { const k = b[p++], n = b[p++]; args = [k, n]; for (let i = 0; i < n; i++) { args.push([b[p], u16(b, p + 1)]); p += 3; } break; }
      case 'L': args = [...b.subarray(p, p + 5)]; p += 5; break;
      case 'T': args = [u16(b, p), b[p + 2]]; p += 3; break;
      case 'G': args = [b[p], b[p + 1]]; p += 2; break;
      case 'C': args = [...b.subarray(p, p + 3)]; p += 3; break;
      case 'm': args = [...b.subarray(p, p + 4)]; p += 4; break;
      case 'g': case 'p': case 'w': case 'f': case 'B': case 'b': args = [b[p++]]; break;
      case 'E': args = []; break;
      case 'e': out.push({ at: at - start, cmd: 'e' }); return out;
      default: out.push({ at: at - start, cmd: '?', byte: b[at] }); return out;
    }
    out.push({ at: at - start, cmd: c, args });
  }
  return out;
}

// Message text at an offset: up to the $00 terminator (pages are separated by ':' and the
// message engine also stops at '!').
export function textAt(b, a, limit = 4096) {
  const bytes = [];
  for (let i = a; i < b.length && i < a + limit; i++) { const c = b[i]; if (c === 0) break; bytes.push(c); if (isLead(c) && i + 1 < b.length) { bytes.push(b[++i]); } }
  return { bytes, text: toText(bytes) };
}

export function parseEvt(b) {
  if (String.fromCharCode(b[0], b[1], b[2]) !== 'EVT') throw new Error('not an EVT file');
  const hdr = { fileSize: u16(b, 4), actorSize: u16(b, 6), triggerSize: u16(b, 8), block3Size: u16(b, 10), part1Size: u16(b, 12), part2Size: u16(b, 14),
    bytes16: [...b.subarray(16, 32)], triggerCount: b[18], cutsceneCount: b[21] };
  let p = 32;
  const actorsRaw = b.subarray(p, p + hdr.actorSize); p += hdr.actorSize;
  const trigRaw = b.subarray(p, p + hdr.triggerSize); p += hdr.triggerSize;
  const block3 = b.subarray(p, p + hdr.block3Size); p += hdr.block3Size;
  const part1 = b.subarray(p, p + hdr.part1Size); p += hdr.part1Size;
  const part2 = b.subarray(p, p + hdr.part2Size); p += hdr.part2Size;

  const spriteSets = [...actorsRaw.subarray(0, 16)].filter((x) => x !== 0xff).map((x) => x + 1);
  const actors = [];
  for (let i = 0; i < 40; i++) { const a = 16 + i * 8; const r = actorsRaw.subarray(a, a + 8); if (r.some((x) => x)) actors.push({ index: i, x: u16(r, 0), y: u16(r, 2), w4: u16(r, 4), w6: u16(r, 6) }); }

  const triggers = [];
  for (let i = 0; i < 32; i++) {
    const a = 16 + i * 12; const r = trigRaw.subarray(a, a + 12);
    if (!r.some((x) => x)) continue;
    const dest = String.fromCharCode(...[...r.subarray(8, 11)].filter((c) => c >= 0x20 && c < 0x7f));
    triggers.push({ index: i, x: u16(r, 0), y: u16(r, 2), w: r[4], h: r[5], entry: u16(r, 6), dest: dest || null, flags: r[11], active: i < hdr.triggerCount });
  }

  // part 1: cutscene scripts
  const n = hdr.cutsceneCount, cutscenes = [];
  for (let i = 0; i < n; i++) {
    const off = u16(part1, i * 2), start = 2 * n + off;
    const next = i + 1 < n ? 2 * n + u16(part1, (i + 1) * 2) : part1.length;
    cutscenes.push({ index: i + 1, offset: off, commands: decodeLetters(part1, start, Math.max(next, start + 1) + 4096) });
  }

  // part 2: VM code. Roots: the jump table at the start (consecutive JMPs from offset 1) and
  // every trigger entry.
  const roots = [];
  for (let q = 1; q + 2 < part2.length && part2[q] === 0xc4; q += 3) roots.push(q);
  for (const t of triggers) if (t.entry) roots.push(t.entry);
  const dis = disassemble(part2, roots);
  const strings = [...dis.strings.keys()].sort((x, y) => x - y).filter((o) => o < part2.length).map((o) => ({ offset: o, ...textAt(part2, o) }));
  const messages = dis.messages.map((m) => ({ key: m.key, table: m.table, offset: m.offset, text: m.offset < part2.length ? textAt(part2, m.offset).text : null }));
  // cutscene T commands show message key+1 through the map script (entry $0C -> builtin 6)
  const byKey = new Map(messages.map((m) => [m.key, m]));
  for (const c of cutscenes) for (const k of c.commands) if (k.cmd === 'T') { const m = byKey.get(k.args[0] + 1); if (m) k.text = m.text; }
  return {
    header: hdr, spriteSets, actors, actorsRaw: hex(actorsRaw), triggers, block3: hex(block3),
    cutscenes, vm: vmOut(part2, dis, roots, messages, strings),
    strings: strings.map((s) => ({ offset: s.offset, text: s.text })), messages, part2Size: part2.length,
  };
}

// Code listing: linear sweep from offset 1 up to the first text/table offset, annotated with
// the recursive pass (sys arguments) — compiled functions are contiguous before the text.
function vmOut(code, dis, roots, messages, strings, start = 1) {
  const data = [...messages.map((m) => m.offset), ...messages.map((m) => m.table), ...strings.map((s) => s.offset)].filter((x) => x > 0);
  let end = Math.min(code.length, data.length ? Math.min(...data) : code.length);
  let lin = sweep(code, start, end);
  if (lin.bad) {
    // ran into data: stop after the last RET before the first invalid opcode
    const k = lin.code.findIndex((i) => i.op.startsWith('bad'));
    let r = k; while (r > 0 && lin.code[r - 1].op !== 'ret') r--;
    end = r > 0 ? lin.code[r - 1].at + 1 : start;
    lin = sweep(code, start, end);
  }
  const rec = new Map(dis.code.map((i) => [i.at, i]));
  const agree = lin.code.filter((i) => rec.has(i.at)).length;
  return { roots, functions: dis.funcs, codeEnd: end, badOps: lin.bad, recursiveAgree: `${agree}/${rec.size}`,
    code: lin.code.map((i) => ({ at: i.at, asm: formatIns(rec.get(i.at) ?? i), ...(rec.has(i.at) ? {} : { unreached: true }) })), coverage: coverage(lin.code, code.length) };
}

function coverage(code, len) { let n = 0; for (const i of code) n += i.len; return { codeBytes: n, total: len }; }
const hex = (a) => Buffer.from(a).toString('hex');

// "scn\0" files (IC_MAIN.SCN, CONSULT.SCN): +4 u16 size, +8 u16 main entry, code from $10.
// IC_MAIN.SCN entry $14 is the common-routine dispatcher used by VM builtin 2.
export function parseScn(b) {
  if (String.fromCharCode(b[0], b[1], b[2]) !== 'scn') throw new Error('not a scn file');
  const hdr = { size: u16(b, 4), w6: u16(b, 6), entry: u16(b, 8), w10: u16(b, 10), w12: u16(b, 12), w14: u16(b, 14) };
  const roots = [u16(b, 8), 0x14];
  for (let q = 0x10; q + 2 < b.length && (b[q] === 0xc4 || b[q] === 0); q += b[q] === 0xc4 ? 3 : 1) if (b[q] === 0xc4) roots.push(q);
  const dis = disassemble(b, roots);
  const strings = [...dis.strings.keys()].sort((x, y) => x - y).filter((o) => o < b.length).map((o) => ({ offset: o, text: textAt(b, o).text }));
  const messages = dis.messages.map((m) => ({ key: m.key, table: m.table, offset: m.offset, text: m.offset < b.length ? textAt(b, m.offset).text : null }));
  return { header: hdr, messages, vm: vmOut(b, dis, [...new Set(roots)], messages, strings, 0x10), strings };
}
void s16;
