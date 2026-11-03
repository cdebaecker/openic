// Chip log of a rendered song, for live synthesis in the game (godot/native: ymfm's YM2151 and
// an MSM6258 decoder): the OPM register writes and ADPCM events of a Session, cut like the WAV
// (renderMusic's `cut`: intro from the first pass, loop body from the second).
//
// Format (little endian):
//   "ICL1", u32 sample rate, u32 loop start (samples, 0xFFFFFFFF: no loop), u32 end (samples),
//   u32 loop offset (byte offset in the event stream of the first loop event), u8 PPI (bits 0-1
//   pan, 2-3 divider at start), u16 blob count, per blob: u32 length + ADPCM bytes,
//   u32 event stream length, events.
// Event: varint samples since the previous event, then a code byte:
//   $01, $08-$FF  OPM register write, value byte follows
//   $02 blob(u16) len(u32)  ADPCM play (decoder reset) from the start of a blob
//   $03 blob(u16) len(u32)  ADPCM data resumes without a reset
//   $04                     ADPCM stop
//   $05 v                   PPI port C bits 0-3 (pan, divider)
// The stream starts with the OPM state the song inherits (voices of the effects, LFO, CT bits).

const STATE_REGS = [0x0f, 0x18, 0x19, 256, 0x1b, ...Array.from({ length: 0xe0 }, (_, i) => 0x20 + i)];

export function buildChipLog(sess, cut) {
  const { lead } = cut;
  const loops = cut.P !== undefined;
  const S = loops ? cut.S : cut.end, P = loops ? cut.P : 0, second = loops ? cut.second : 0;
  // all events in time order: [t, kind, ...]; OPM before ADPCM at the same time
  const all = [];
  const ev = sess.events;
  for (let i = 0; i < ev.length; i += 2) all.push({ t: ev[i], o: 0, r: ev[i + 1] >> 8, v: ev[i + 1] & 255 });
  for (const c of sess.chip) all.push({ t: c.t, o: 1, c });
  all.sort((a, b) => a.t - b.t || a.o - b.o);

  // ADPCM blobs: one per start address, as long as the longest run from it
  const blobs = new Map();
  for (const c of sess.chip) {
    if ((c.op === 'play' || c.op === 'cont') && c.len > 0) blobs.set(c.addr, Math.max(blobs.get(c.addr) ?? 0, c.len));
  }
  const blobIds = new Map([...blobs.keys()].map((a, i) => [a, i]));

  const out = [];
  let last = 0;
  const u8 = (v) => out.push(v & 255);
  const u16 = (v) => { u8(v); u8(v >> 8); };
  const u32 = (v) => { u16(v & 0xffff); u16(v >>> 16); };
  const emit = (t, f) => {
    let d = Math.max(0, t - last); last += d;
    do { u8((d & 127) | (d > 127 ? 128 : 0)); d >>>= 7; } while (d);
    f();
  };
  const put = (e, t) => {
    if (e.o === 0) { emit(t, () => { u8(e.r); u8(e.v); }); return; }
    const c = e.c;
    if (c.op === 'stop') emit(t, () => u8(4));
    else if (c.op === 'ppi') emit(t, () => { u8(5); u8(c.v); });
    else emit(t, () => { u8(c.op === 'play' ? 2 : 3); u16(c.len ? blobIds.get(c.addr) : 0xffff); u32(c.len); });
  };

  for (const r of STATE_REGS) {
    const v = sess.startRegs[r];
    if (v >= 0) emit(0, () => { u8(r === 256 ? 0x19 : r); u8(v); });
  }
  for (const e of all) if (e.t < S) put(e, Math.round(Math.max(0, e.t - lead)));
  const loopOffset = out.length;
  if (loops) {
    for (const e of all) {
      if (e.t >= S + second && e.t < S + second + P) put(e, Math.round(e.t - second - lead));
    }
  }

  const head = [];
  const h32 = (v) => { for (let k = 0; k < 4; k++) head.push((v >>> (8 * k)) & 255); };
  head.push(...[...'ICL1'].map((ch) => ch.charCodeAt(0)));
  h32(sess.rate);
  h32(loops ? S - lead : 0xffffffff);
  h32(loops ? S - lead + P : cut.end - lead);
  h32(loopOffset);
  head.push(sess.startPPI & 15);
  head.push(blobs.size & 255, blobs.size >> 8);
  const m = sess.sys.m;
  for (const [addr, len] of blobs) {
    h32(len);
    for (let i = 0; i < len; i++) head.push(m.r8(addr + i));
  }
  h32(out.length);
  const res = new Uint8Array(head.length + out.length);
  res.set(head); res.set(out, head.length);
  return res;
}
