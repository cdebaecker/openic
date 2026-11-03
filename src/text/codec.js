// Message text codec shared by the extractor (Node) and the runtime patcher.
//
// In-game messages are Shift-JIS with single-byte commands. The message engine
// (ICITY68 f_72286) ends a message at $00 or '!' and treats $0A (new line), $0F,
// ' ', '#', '$', '%', '&', '*' and ':' specially; every other byte is drawn,
// bytes below $80 as half-width glyphs.
//
// Table text form: Japanese/English characters as-is, every command byte as a
// {xx} token (two hex digits), e.g. "{03}" or "{0A}".

const sjis = new TextDecoder('shift_jis');

export const isLead = (c) => (c >= 0x81 && c <= 0x9f) || (c >= 0xe0 && c <= 0xfc);
const isTrail = (c) => c >= 0x40 && c <= 0xfc && c !== 0x7f;
export const isEnd = (c) => c === 0x00 || c === 0x21;

// Bytes of the message starting at `at` in `bytes` (up to, not including, the terminator).
export function messageBytes(read, at, max = 2048) {
  const out = [];
  for (let i = 0; i < max; i++) {
    const c = read(at + i);
    if (isEnd(c)) break;
    out.push(c);
    if (isLead(c)) { out.push(read(at + i + 1)); i++; }
  }
  return out;
}

// Split a message into the command prefix before its first Shift-JIS character
// and the rest; the rest is what identifies the message.
export function splitPrefix(bytes) {
  let i = 0;
  while (i < bytes.length && !isLead(bytes[i])) i++;
  return [bytes.slice(0, i), bytes.slice(i)];
}

// Length of the first page of a message: up to its first ':' (page break,
// the engine resumes after it) or the whole message.
export function pageLength(bytes) {
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x3a) return i;
    if (isLead(bytes[i])) i++;
  }
  return bytes.length;
}

// FNV-1a hash -> 8 hex digits
export function messageId(bytes) {
  let h = 0x811c9dc5;
  for (const b of bytes) { h ^= b; h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

// Bytes -> table text
export function toText(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i];
    if (isLead(c) && i + 1 < bytes.length && isTrail(bytes[i + 1])) { s += sjis.decode(new Uint8Array([c, bytes[i + 1]])); i++; }
    else if (c >= 0xa1 && c <= 0xdf) s += sjis.decode(new Uint8Array([c]));
    else if (c > 0x20 && c < 0x7f && !'!#$%&*:{}'.includes(String.fromCharCode(c))) s += String.fromCharCode(c);
    else s += `{${c.toString(16).padStart(2, '0')}}`;
  }
  return s;
}

// Replacements for ASCII the message engine reserves as commands: '!' uses the
// spare half-width slot $A0 (the port's font draws '!' there), the rest use
// their full-width forms.
const RESERVED = { '!': [0xa0], '#': [0x81, 0x94], '$': [0x81, 0x90], '%': [0x81, 0x93], '&': [0x81, 0x95], '*': [0x81, 0x96], ':': [0x81, 0x46] };

// Table text (English) -> bytes for the game. {xx} tokens pass through; ASCII is
// drawn half-width; reserved punctuation becomes full-width; other characters
// are dropped with a warning callback.
export function fromText(text, warn = () => {}) {
  const out = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') {
      const m = /^\{([0-9a-fA-F]{2})\}/.exec(text.slice(i));
      if (m) { out.push(parseInt(m[1], 16)); i += 3; continue; }
    }
    if (ch === '\n') { out.push(0x0a); continue; }
    if (RESERVED[ch]) { out.push(...RESERVED[ch]); continue; }
    const code = ch.charCodeAt(0);
    if (code === 0x20 || (code > 0x20 && code < 0x7f)) { out.push(code); continue; }
    // typographic punctuation -> ASCII
    const map = { '‘': "'", '’': "'", '“': '"', '”': '"', '…': '...', '–': '-', '—': '-', ' ': ' ' };
    if (map[ch]) { for (const c of map[ch]) out.push(...(RESERVED[c] ?? [c.charCodeAt(0)])); continue; }
    warn(ch);
  }
  return out;
}

// Wrap plain text segments to `width` half-width columns, keeping {xx} tokens
// and explicit line breaks. Line breaks are inserted at spaces.
export function wrap(text, width) {
  const parts = text.split(/(\{0[aA]\}|\n)/);
  return parts.map((p) => {
    if (p === '\n' || /^\{0[aA]\}$/.test(p)) return p;
    const visible = (s) => s.replace(/\{[0-9a-fA-F]{2}\}/g, '').length;
    const words = p.split(' ');
    const lines = [];
    let cur = '';
    for (const w of words) {
      const cand = cur ? `${cur} ${w}` : w;
      if (visible(cand) > width && cur) { lines.push(cur); cur = w; } else cur = cand;
    }
    lines.push(cur);
    return lines.join('{0a}');
  }).join('');
}

// ---- interface strings ---------------------------------------------------------------

// Shift-JIS encoder (browsers only decode Shift-JIS): built once from the decoder.
let sjisMap = null;
export function encodeSJIS(str) {
  if (!sjisMap) {
    sjisMap = new Map();
    const pair = new Uint8Array(2);
    for (let a = 0x81; a <= 0xfc; a++) {
      if (a > 0x9f && a < 0xe0) continue;
      for (let b = 0x40; b <= 0xfc; b++) {
        if (b === 0x7f) continue;
        pair[0] = a; pair[1] = b;
        const ch = sjis.decode(pair);
        if (ch.length === 1 && ch !== '�' && !sjisMap.has(ch)) sjisMap.set(ch, [a, b]);
      }
    }
    for (let c = 0xa1; c <= 0xdf; c++) { const ch = sjis.decode(new Uint8Array([c])); if (!sjisMap.has(ch)) sjisMap.set(ch, [c]); }
  }
  const out = [];
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === '{') { const m = /^\{([0-9a-fA-F]{2})\}/.exec(str.slice(i)); if (m) { out.push(parseInt(m[1], 16)); i += 3; continue; } }
    const code = ch.charCodeAt(0);
    if (code < 0x80) { out.push(code); continue; }
    const b = sjisMap.get(ch);
    if (b) out.push(...b);
  }
  return out;
}

// Interface rules: [{ ja, en }] in table text form. Compiled once to byte patterns,
// longest first so phrases win over the single words they contain.
export function compileRules(rules) {
  return rules.map((r) => ({ ja: encodeSJIS(r.ja), en: [...r.en].map((c) => c.charCodeAt(0) & 0x7f) }))
    .filter((r) => r.ja.length)
    .sort((a, b) => b.ja.length - a.ja.length);
}

// Apply rules to a drawn string; returns new bytes or null if nothing changed.
// Full-width ASCII (letters, digits, space, some punctuation) becomes half-width;
// the result keeps the original byte length (= screen columns) by padding with,
// or giving up, trailing spaces.
export function applyRules(bytes, rules) {
  // Each replacement is padded in place to the width of what it replaces, so
  // later columns stay aligned; replacements wider than the original borrow
  // from the string's trailing spaces.
  const out = [];
  let changed = false;
  const put = (repl, width) => {
    out.push(...repl);
    for (let k = repl.length; k < width; k++) out.push(0x20);
    changed = true;
  };
  for (let i = 0; i < bytes.length;) {
    let hit = null;
    for (const r of rules) {
      const p = r.ja;
      if (p.length && p[0] === bytes[i] && p.every((v, k) => bytes[i + k] === v)) { hit = r; break; }
    }
    if (hit) {
      // a longer replacement first uses the padding right after it (keeps the
      // next column in place), then the string's trailing spaces
      let width = hit.ja.length;
      let j = i + hit.ja.length;
      while (width < hit.en.length && bytes[j] === 0x20) { width++; j++; }
      put(hit.en, width); i = j; continue;
    }
    const c = bytes[i];
    if (isLead(c) && i + 1 < bytes.length) {
      // a run of full-width ASCII (digits, letters, space, minus) -> half-width + padding
      const run = [];
      let j = i;
      for (;;) {
        const a = bytes[j], t = bytes[j + 1];
        let half = null;
        if (a === 0x82 && t >= 0x4f && t <= 0x58) half = 0x30 + (t - 0x4f);
        else if (a === 0x82 && t >= 0x60 && t <= 0x79) half = 0x41 + (t - 0x60);
        else if (a === 0x82 && t >= 0x81 && t <= 0x9a) half = 0x61 + (t - 0x81);
        else if (a === 0x81 && t === 0x7c) half = 0x2d;
        else if (a === 0x81 && t === 0x40) { if (run.length) break; half = 0x20; }
        if (half === null) break;
        run.push(half); j += 2;
        if (half === 0x20) break;
      }
      if (run.length) {
        if (run.length === 1 && run[0] === 0x20) put([0x20, 0x20], 2);
        else put(run, j - i);
        i = j; continue;
      }
      out.push(c, bytes[i + 1]); i += 2; continue;
    }
    out.push(c); i++;
  }
  if (!changed) return null;
  // Restore the original width at the end of the text, before any trailing
  // control bytes (e.g. a final line break).
  let end = out.length;
  while (end > 0 && out[end - 1] < 0x20) end--;
  const tail = out.splice(end);
  while (out.length + tail.length > bytes.length && out[out.length - 1] === 0x20) out.pop();
  while (out.length + tail.length < bytes.length) out.push(0x20);
  return out.concat(tail);
}
