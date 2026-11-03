// Ending narration (IL_END.X). Its scripts are zero-terminated byte strings
// read two bytes at a time: a backslash pair is a command, any other pair is
// printed with IOCS B_PRINT at the console cursor.
//   \r new line   \c clear the three text rows   \p \u short pauses   \w wait
//   \t long pause \e end of scene          \1 flash effect
//
// Table text form: Japanese/English as-is, a line break for \r, every other
// command as written ("\p"). English is printed half-width, so two characters
// share a pair; the encoder pads with spaces to keep commands on pair boundaries.

import { toText, encodeSJIS, isLead } from './codec.js';

const TYPO = { '‘': "'", '’': "'", '“': '"', '”': '"', '…': '...', '–': '-', '—': '-', ' ': ' ' };

export const ENDING = {
  program: 'IL_END.X',
  dumpBase: 0x8620,      // addresses below are those of the image as dumped by tools/unpack.mjs
  read: 0x2b34,          // offset of the engine's "fetch next pair" (pointer at ptr)
  ptr: 0xb452,           // script pointer
  width: 46,             // \c clears 46 columns (lines start at column 13 of 64)
  speakers: [0x2ad2, 0x2af0],  // offsets of the routines that print a speaker name (a1), right-aligned
  speakerWidth: 12,
};

// Script start addresses: every "lea script,a1 / move.l a1,ptr" in the image.
export function endingScripts(img) {
  const out = [];
  for (let i = 0; i + 12 <= img.length; i += 2) {
    const r16 = (o) => (img[o] << 8) | img[o + 1];
    const r32 = (o) => ((r16(o) << 16) | r16(o + 2)) >>> 0;
    if (r16(i) === 0x43f9 && r16(i + 6) === 0x23c9 && r32(i + 8) === ENDING.ptr) out.push(r32(i + 2));
  }
  return [...new Set(out)];
}

// Bytes of a script starting at `at`, up to (not including) the terminating pair.
export function scriptBytes(read, at, max = 4096) {
  const out = [];
  for (let i = 0; i < max; i += 2) {
    const a = read(at + i), b = read(at + i + 1);
    if (a === 0) break;
    out.push(a, b);
  }
  return out;
}

export function endingToText(bytes) {
  let s = '', run = [];
  const flush = () => { if (run.length) s += toText(run); run = []; };
  for (let i = 0; i < bytes.length; i += 2) {
    if (bytes[i] === 0x5c) { flush(); s += bytes[i + 1] === 0x72 ? '\n' : `\\${String.fromCharCode(bytes[i + 1])}`; }
    else run.push(bytes[i], bytes[i + 1]);
  }
  flush();
  return s;
}

// Table text -> script bytes (terminated). Long lines wrap at spaces.
export function endingFromText(text, width = ENDING.width) {
  const out = [];
  let padded = false;     // a space was added to align a command: drop the next leading space
  let col = 0;            // \r and \c both start a line at column 13
  const cmd = (c) => {
    if (out.length & 1) { out.push(0x20); padded = true; col++; }
    out.push(0x5c, c.charCodeAt(0));
    if (c === 'r' || c === 'c') col = 0;
  };
  const lines = text.split('\n');
  lines.forEach((line, n) => {
    if (n) cmd('r');
    for (let part of line.split(/(\\.)/)) {
      if (/^\\.$/.test(part)) { cmd(part[1]); continue; }
      if (padded && part.startsWith(' ')) part = part.slice(1);
      padded = false;
      for (const word of part.split(/(?<= )/)) {
        if (col && col + word.trimEnd().length > width) { if (out[out.length - 1] === 0x20) out.pop(); cmd('r'); }
        for (const ch of col ? word : word.trimStart()) {
          const bytes = encodeSJIS(TYPO[ch] ?? ch);
          if (bytes.length === 2 && isLead(bytes[0]) && (out.length & 1)) { out.push(0x20); col++; }  // keep a full-width character in one pair
          out.push(...bytes);
          col += bytes.length;
        }
      }
    }
  });
  if (out.length & 1) out.push(0x20);
  out.push(0, 0);
  return out;
}
