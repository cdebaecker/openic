// OpenIC: the interface glossary without the game's text. Each Japanese key (item, spell and place
// names, interface labels, battle message templates) is published as a hash of its Shift-JIS
// bytes and their length ("k": "<hash>:<length>"); the importer finds those bytes again in the
// player's own disks and the game's memory image, and writes the glossary back with the Japanese.
// A few keys the game data does not hold as such (the start menu of MENU68, a multi-line game
// over text) stay as plain Japanese: short interface labels.
import { encodeSJIS } from '../../src/text/codec.js';

// Shift-JIS bytes of a key; "{xx}" is a raw byte (as in the translation tables)
export function keyBytes(ja) {
  const out = [];
  for (let i = 0; i < ja.length;) {
    const m = /^\{([0-9a-fA-F]{2})\}/.exec(ja.slice(i));
    if (m) { out.push(parseInt(m[1], 16)); i += 4; continue; }
    out.push(...encodeSJIS(ja[i]));
    i++;
  }
  return Uint8Array.from(out);
}

// Two polynomial hashes (mod 2^32), so the importer can scan for a key with a rolling window
const B1 = 0x01000193, B2 = 0x5bd1e995;
function hash(bytes, from = 0, n = bytes.length) {
  let a = 0, b = 0;
  for (let i = from; i < from + n; i++) { a = (Math.imul(a, B1) + bytes[i]) | 0; b = (Math.imul(b, B2) + bytes[i]) | 0; }
  return [a >>> 0, b >>> 0];
}
const hex = ([a, b]) => a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
export const keyOf = (bytes) => `${hex(hash(bytes))}:${bytes.length}`;

const contains = (src, b) => Buffer.from(src.buffer, src.byteOffset, src.byteLength).indexOf(Buffer.from(b)) >= 0;

// glossary.json / glossary_fr.json -> their public form ("k" instead of "ja" where the bytes
// occur in `sources`). Returns { glossary, fr, kept: [ja...] }.
export function hide(glossary, fr, sources) {
  const out = { ...glossary }, outFr = { ...fr }, kept = [];
  for (const kind of ['names', 'rules', 'templates']) {
    const frKind = fr[kind] ?? {};
    const newFr = {};
    out[kind] = glossary[kind].map((e) => {
      const b = keyBytes(e.ja);
      if (!sources.some((s) => contains(s, b))) {
        kept.push(e.ja);
        if (frKind[e.ja] !== undefined) newFr[e.ja] = frKind[e.ja];
        return e;
      }
      const k = keyOf(b);
      if (frKind[e.ja] !== undefined) newFr[k] = frKind[e.ja];
      const { ja, ...rest } = e;
      return { k, ...rest };
    });
    outFr[kind] = newFr;
  }
  return { glossary: out, fr: outFr, kept };
}

// The reverse, in the importer: find each hashed key in `sources` and put the Japanese back.
// Returns { glossary, fr, missing: [k...] } (entries not found are dropped).
export function restore(glossary, fr, sources) {
  const want = new Map();   // length -> Map(first hash -> [[second hash, key]...])
  for (const kind of ['names', 'rules', 'templates']) for (const e of glossary[kind] ?? []) {
    if (!e.k) continue;
    const [h, n] = e.k.split(':');
    if (!want.has(+n)) want.set(+n, new Map());
    const m = want.get(+n), a = parseInt(h.slice(0, 8), 16) | 0, b = parseInt(h.slice(8), 16) | 0;
    if (!m.has(a)) m.set(a, []);
    m.get(a).push([b, e.k]);
  }
  const found = new Map();  // k -> bytes
  const decoder = new TextDecoder('shift_jis');
  for (const [n, hashes] of want) {
    // rolling: hash(window) = hash(prev) * B - first * B^n + next
    let p1 = 1, p2 = 1;
    for (let i = 0; i < n; i++) { p1 = Math.imul(p1, B1); p2 = Math.imul(p2, B2); }
    for (const s of sources) {
      if (s.length < n) continue;
      let [a, b] = hash(s, 0, n).map((x) => x | 0);
      for (let i = 0; ; i++) {
        const hits = hashes.get(a);
        if (hits) for (const [hb, k] of hits) if (hb === b && !found.has(k)) found.set(k, s.slice(i, i + n));
        if (i + n >= s.length) break;
        a = (Math.imul(a, B1) - Math.imul(s[i], p1) + s[i + n]) | 0;
        b = (Math.imul(b, B2) - Math.imul(s[i], p2) + s[i + n]) | 0;
      }
    }
  }
  const ja = (k) => decoder.decode(found.get(k));
  const out = { ...glossary }, outFr = { ...fr }, missing = [];
  for (const kind of ['names', 'rules', 'templates']) {
    const frKind = fr[kind] ?? {};
    const newFr = {};
    out[kind] = [];
    for (const e of glossary[kind] ?? []) {
      if (!e.k) { out[kind].push(e); if (frKind[e.ja] !== undefined) newFr[e.ja] = frKind[e.ja]; continue; }
      if (!found.has(e.k)) { missing.push(e.k); continue; }
      const { k, ...rest } = e;
      out[kind].push({ ja: ja(k), ...rest });
      if (frKind[k] !== undefined) newFr[ja(k)] = frKind[k];
    }
    outFr[kind] = newFr;
  }
  return { glossary: out, fr: outFr, missing };
}
