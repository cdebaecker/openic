// The MIDI side of ZMUSIC: a minimal YM3802 (the MIDI interface board's controller, CZ-6BM1 at
// $EAFA00-$EAFA0F) so that ZMUSIC finds the board and plays the game's MIDI songs
// (GROUPMD\0000nn.DAT), and capture of the bytes it transmits, with loop detection.
//
// YM3802 registers sit at the odd addresses: R0-R3 directly, R4-R7 at register 10 * group + n
// where R1 selects the group. ZMUSIC needs R54 (transmit status: ready, buffer empty) and writes
// every byte it sends to R56 (transmit data). Nothing is ever received.
import { ZM } from './session.mjs';
import { detectLoop } from './render.mjs';

const BASE = 0xeafa00;
const FPS = 55.46;

// Add the board to the machine before ZMUSIC boots (Session `setup`). onByte(byte) for each byte
// written to the transmit data register.
export function attachMidi(sys, onByte) {
  sys.m.isPresent = (a) => a >= BASE && a < BASE + 16;    // DOS _BUS_ERR probe
  const regs = new Uint8Array(160);
  let group = 0;
  const reg = (a) => { const r = (a & 15) >> 1; return r < 4 ? r : 10 * group + r; };
  sys.m.map(0xeae000, 0xeb0000, {
    read8: (a) => {
      if (a < BASE || a >= BASE + 16 || !(a & 1)) return 0xff;
      const r = reg(a);
      return r === 54 ? 0xc0 : regs[r];
    },
    write8: (a, d) => {
      if (a < BASE || a >= BASE + 16 || !(a & 1)) return;
      const r = reg(a);
      if (r === 1) group = d & 15;
      regs[r] = d;
      if (r === 56) onByte(d);
    },
  });
}

// Messages from timed bytes: [[t, Uint8Array], ...]. Running status and SysEx; real-time bytes
// (clock, active sensing) are dropped.
export function midiMessages(stream) {
  const out = [];
  let status = 0, cur = [], t0 = 0;
  for (const [t, b] of stream) {
    if (b >= 0xf8) continue;
    if (b === 0xf0) { status = 0xf0; cur = [b]; t0 = t; continue; }
    if (status === 0xf0) {
      cur.push(b);
      if (b === 0xf7) { out.push([t0, Uint8Array.from(cur)]); status = 0; cur = []; }
      continue;
    }
    if (b & 0x80) { status = b; cur = [b]; t0 = t; }
    else if (status) { if (!cur.length) { cur = [status]; t0 = t; } cur.push(b); }
    else continue;
    const need = (status & 0xf0) === 0xc0 || (status & 0xf0) === 0xd0 ? 2 : 3;
    if (cur.length === need) { out.push([t0, Uint8Array.from(cur)]); cur = []; }
  }
  return out;
}

// Flat [t, token] list for detectLoop: one token per message.
function events(stream) {
  const ev = [];
  for (const [t, m] of midiMessages(stream)) {
    let h = 0x811c9dc5;
    for (const b of m) h = Math.imul(h ^ b, 0x01000193);
    ev.push(t, h | 0);
  }
  return ev;
}

// Play compiled ZMUSIC data at `addr` and record the transmitted bytes until the song ends or a
// loop is found and confirmed (the message stream repeats with steady timing, as in
// renderMusic). `bytes` is the array attachMidi fills. Times are in session samples.
export function captureMidi(sess, addr, bytes, { maxSec = 900, log = () => {} } = {}) {
  const rate = sess.rate;
  sess.reset();
  bytes.length = 0;
  sess.call(ZM.PLAY_CNV_DATA, { a1: addr + 7 });
  const sec = () => sess.samples / rate;
  let cand = null, loop = null, ended = false, endAt = Infinity, nextCheck = 20;
  while (sec() < maxSec) {
    sess.runFrames(Math.round(FPS));
    if (!ended && sess.call(ZM.M_STAT) === 0) { ended = true; endAt = sec() + 1; }
    if (ended) { if (sec() >= endAt) break; continue; }
    if (cand) {
      if (sess.samples < cand.until) continue;
      const c = detectLoop(events(bytes), { rate });
      if (c && c.k === cand.k && Math.abs(c.start - cand.start) < 1 && c.jitter < rate * 0.004) { loop = c; break; }
      log(`  loop candidate rejected (k=${cand.k} start=${(cand.start / rate).toFixed(2)}s)`);
      cand = null;
    } else if (sec() >= nextCheck) {
      nextCheck = sec() + 10;
      const c = detectLoop(events(bytes), { rate });
      if (c && c.jitter < rate * 0.004) {
        cand = { ...c, until: c.start + 2 * c.period + Math.max(30 * rate, c.period) };
        log(`  loop candidate k=${c.k} start=${(c.start / rate).toFixed(2)}s period=${(c.period / rate).toFixed(2)}s; confirming`);
      }
    }
  }
  return { loop: loop && { start: loop.start, period: loop.period, jitter: loop.jitter }, ended, rendered: sec() };
}

// Notes per MIDI channel (1-16) in a captured stream.
export function channelNotes(stream) {
  const n = new Array(17).fill(0);
  for (const [, m] of midiMessages(stream)) if ((m[0] & 0xf0) === 0x90 && m[2] > 0) n[(m[0] & 15) + 1]++;
  return n;
}
