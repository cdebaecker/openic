// Render every music track and sound effect of Illusion City to audio files for the Godot port.
//
// Each item is played by the game's own sound driver (ZMUSIC 1.49F, booted with ICITY.ZPD as in
// AUTOEXEC.BAT) through its trap #3 API, exactly as the game programs call it, and the mixed
// OPM + ADPCM output is recorded. Looping songs are rendered until the loop has repeated (found
// on the OPM/ADPCM register-write stream, see audio/render.mjs) and written as
// intro + one loop body, so the file end flows into loop_start_sec.
//
// Usage: node tools/export/audio.mjs [--jobs N] [--only REGEX] [--wav] [--keep-wav]
//   --jobs N     worker processes (default: CPU count - 1)
//   --only RE    render only items whose name matches RE (index.json is merged)
//   --wav        write WAV instead of OGG (OGG needs ffmpeg with libvorbis)
// Output: ../work/export/audio/{music,sfx}/<name>.ogg and audio/index.json.
// See docs/formats/audio.md for where the data lives and how the game selects it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { allFiles, loadDisks, exportDir, ensureDir, writeWav, writeJson } from './common.mjs';
import { unpackMusic } from './audio/unpack.mjs';
import { MUSIC_TABLE } from './audio/songs.mjs';

const OUT = `${exportDir}/audio`;
const RATE = 48000;
const SE_TIMER_B = 0xd7;

// IC98.BEM: u16 BE count, then u16 BE offsets; entry n = [off[n], off[n+1]) (one ZMD each).
function bemEntries(bem) {
  const w = (i) => (bem[2 * i] << 8) | bem[2 * i + 1];
  const count = w(0), out = [];
  for (let n = 1; n < count; n++) out.push({ n, start: w(n), end: w(n + 1) });
  return out;
}
// IC98.BGE: u16 BE count (0x37), then u16 BE offsets for effects 1..count; each points at a ZMD
// header ("\x10ZmuSiC\x14" + $FFFF); f_758B4 passes offset + 10 to se_play. Zero-filled = unused.
function bgeEntries(bge) {
  const w = (i) => (bge[2 * i] << 8) | bge[2 * i + 1];
  const count = w(0), out = [];
  for (let n = 1; n <= count; n++) {
    const off = w(n);
    if (off + 10 <= bge.length && bge[off] === 0x10 && bge[off + 1] === 0x5a) out.push({ n, off });
  }
  return out;
}

function findFile(p) {
  const hits = allFiles().filter((f) => f.path === p);
  if (!hits.length) return null;
  const same = hits.every((h) => Buffer.compare(Buffer.from(h.data), Buffer.from(hits[0].data)) === 0);
  return { data: hits[0].data, disks: hits.map((h) => h.disk), consistent: same };
}

// ---- job list -------------------------------------------------------------------------------
function jobs() {
  const list = [];
  const pad = (n) => String(n).padStart(2, '0');
  for (const [id, [file, tone]] of Object.entries(MUSIC_TABLE)) {
    const src = `GROUP00/${String(file).padStart(6, '0')}.DAT`;
    list.push({ name: `bgm_${pad(id)}`, kind: 'music', src, unpack: true,
      used_by: [`ICITY68 music ${id} (f_69B44 -> f_66988 -> play_cnv_data)`],
      notes: `MIDI version GROUPMD/${String(file).padStart(6, '0')}.DAT, MIDI tone file ${tone}.BIN` +
        (file === 35 ? '; FM mode loads the identical GROUPMD/100035.DAT instead' : '') });
  }
  const bem = findFile('IC98.BEM').data;
  for (const e of bemEntries(bem)) {
    if (e.end - e.start <= 12) continue;   // entry 1 is an empty song (used to silence music)
    list.push({ name: `jingle_${pad(e.n)}`, kind: 'music', src: 'IC98.BEM', entry: e.n,
      used_by: [`ICITY68 sound ${60 + e.n} (f_66A5C -> f_6DF30(${e.n}))${e.n === 2 ? '; f_6B3C4 plays it after fading out the area music' : ''}`] });
  }
  const imus = [
    ['imus_theme_b', 'IMUS/ﾃｰﾏB.ZMD', ['IL_OPEN (opening, after the thunder)', 'IL_END (second ending tune)']],
    ['imus_10the_a9', 'IMUS/10THE_A9.ZMD', ['IL_OPEN (after the opening, until it exits)']],
    ['imus_31win', 'IMUS/31WIN_.ZMD', ['IL_END (first ending tune)']],
    ['imus_ending', 'IMUS/ENDING.ZMD', ['IL_END (staff roll)']],
  ];
  for (const [name, src, used_by] of imus) list.push({ name, kind: 'music', src, used_by });
  const bge = findFile('IC98.BGE').data;
  for (const e of bgeEntries(bge)) {
    list.push({ name: `se_${pad(e.n)}`, kind: 'sfx', src: 'IC98.BGE', entry: e.n,
      used_by: [`ICITY68 sound ${e.n} (f_66A5C / f_6DF8C -> f_758B4 -> se_play)`] });
  }
  list.push({ name: 'thunder', kind: 'sfx', src: 'IMUS/THUNDER.PCM', adpcm: true,
    used_by: ['IL_OPEN (se_adpcm1, 15.6 kHz, centre)'] });
  // identical song data under two names (IL_OPEN/IL_END files also used as area music)
  const seen = new Map();
  for (const j of list) {
    if (j.kind !== 'music') continue;
    let d = findFile(j.src).data;
    if (j.unpack) d = unpackMusic(d);
    if (j.entry) { const e = bemEntries(d).find((x) => x.n === j.entry); d = d.subarray(e.start, e.end); }
    const key = Buffer.from(d).toString('base64');
    if (seen.has(key)) j.same_as = seen.get(key); else seen.set(key, j.name);
  }
  return list;
}

// ---- worker: render one job ------------------------------------------------------------------
async function renderJob(job, opts) {
  const { Session, ZM } = await import('./audio/session.mjs');
  const { renderMusic, renderEffect, rms } = await import('./audio/render.mjs');
  const f = findFile(job.src);
  if (!f) throw new Error(`missing ${job.src}`);
  const sess = new Session(loadDisks(), { rate: RATE });
  // MENU68 plays SE_TONE.ZMD once at start-up: it only defines the voices the effects use.
  const tone = findFile('SE_TONE.ZMD').data;
  const toneAddr = sess.write(0x30000, tone);
  sess.call(ZM.PLAY_CNV_DATA, { a1: toneAddr + 7 });
  sess.runFrames(10);
  let r;
  if (job.kind === 'music') {
    let data = f.data, addr;
    if (job.unpack) data = unpackMusic(data);
    if (job.entry) { const base = sess.write(0, data); addr = base + bemEntries(data).find((e) => e.n === job.entry).start; }
    else addr = sess.write(0, data);
    r = renderMusic(sess, addr, { log: (s) => process.stderr.write(`[${job.name}] ${s}\n`) });
  } else if (job.adpcm) {
    const addr = sess.write(0, f.data);
    r = renderEffect(sess, () => sess.call(ZM.SE_ADPCM1, { a1: addr, d2: f.data.length, d3: 0x0403, d4: 0x1a4 }));
  } else {
    const base = sess.write(0, f.data);
    const off = bgeEntries(f.data).find((e) => e.n === job.entry).off;
    // ZMUSIC runs effect tracks from the music timer (OPM timer B), so in the game an effect
    // plays at the tempo of the current BGM. Run the timer at $D7 (about tempo 120, the
    // middle of the BGM tempos, which range from $AE to $E4) as the song would.
    r = renderEffect(sess, () => {
      sess.call(ZM.SE_PLAY, { a1: base + off + 10, d2: 8 });
      sess.sys.opm.write(0x12, SE_TIMER_B);
      sess.sys.opm.write(0x14, 0x3a);
    });
  }
  const dir = job.kind === 'music' ? 'music' : 'sfx';
  const wavPath = opts.wav ? `${OUT}/${dir}/${job.name}.wav` : `${opts.tmp}/${job.name}.wav`;
  writeWav(wavPath, r.audio, RATE, 2);
  let file = wavPath;
  if (!opts.wav) {
    file = `${OUT}/${dir}/${job.name}.ogg`;
    ensureDir(path.dirname(file));
    const p = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', wavPath, '-c:a', 'libvorbis', '-q:a', '6', file]);
    if (p.status !== 0) throw new Error(`ffmpeg failed: ${p.stderr}`);
    if (!opts.keepWav) fs.unlinkSync(wavPath);
  }
  const n = r.audio.length / 2;
  return {
    name: job.name, kind: job.kind, file: path.relative(OUT, file),
    source: job.src + (job.entry ? `#${job.entry}` : ''), source_disks: f.disks,
    ...(f.consistent ? {} : { warning: 'file differs between disks; first copy used' }),
    duration: +(n / RATE).toFixed(4), sample_rate: RATE, channels: 2,
    loop: !!r.loop,
    loop_start_sec: r.loop ? +(r.loop.start / RATE).toFixed(4) : null,
    loop_end_sec: r.loop ? +(r.loop.end / RATE).toFixed(4) : null,
    loop_start_sample: r.loop ? r.loop.start : null,
    loop_end_sample: r.loop ? r.loop.end : null,
    ...(r.loop && Math.abs(r.exactStart - r.loop.start / RATE) > 0.01 ? { loop_start_register_exact_sec: +r.exactStart.toFixed(4) } : {}),
    ...(r.loop ? { loop_match: r.specMatch, loop_match_baseline: r.specBaseline, loop_envelope_corr: r.loopMatch, loop_lag_ms: r.loopLagMs } : {}),
    ...(r.approx ? r.approx.method === 'audio'
      ? { loop_approx: true, loop_note: `tracks never realign exactly; loop is the lag with the most similar spectra (score ${r.approx.score})` }
      : { loop_approx: true, loop_note: `tracks have different loop lengths; loop uses the period of ${Math.round(r.approx.share * 100)}% of the notes`, loop_drift_channels: r.approx.drift } : {}),
    ...(job.kind === 'music' && !r.loop ? { ends: r.ended } : {}),
    ...(job.kind === 'sfx' ? { ends: r.ended } : {}),
    ...(job.kind === 'sfx' && !r.ended ? { sfx_note: 'still sounding when the 20 s render limit was reached (held note): the game stops it with the next effect or music' } : {}),
    rms: +rms(r.audio).toFixed(4),
    used_by: job.used_by, ...(job.notes ? { notes: job.notes } : {}),
    ...(job.same_as ? { same_as: job.same_as } : {}),
  };
}

// ---- main ------------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const opts = { wav: argv.includes('--wav'), keepWav: argv.includes('--keep-wav'), tmp: `${OUT}/.tmp` };

if (argv[0] === '--worker') {
  process.on('message', async (job) => {
    try { process.send({ ok: true, entry: await renderJob(job, opts) }); }
    catch (e) { process.send({ ok: false, name: job.name, error: e.stack }); }
  });
} else {
  if (!opts.wav && spawnSync('ffmpeg', ['-hide_banner', '-encoders']).stdout?.toString().includes('libvorbis') !== true) {
    console.log('ffmpeg with libvorbis not found: writing WAV');
    opts.wav = true;
  }
  ensureDir(opts.tmp);
  const only = arg('--only') ? new RegExp(arg('--only')) : null;
  const todo = jobs().filter((j) => !only || only.test(j.name));
  const nWorkers = Math.max(1, Math.min(todo.length, Number(arg('--jobs') ?? Math.max(1, os.cpus().length - 1))));
  const indexFile = `${OUT}/index.json`;
  const prev = only && fs.existsSync(indexFile) ? JSON.parse(fs.readFileSync(indexFile, 'utf8')).items : [];
  const results = new Map(prev.map((e) => [e.name, e]));
  let next = 0, running = 0, failed = 0;
  const t0 = Date.now();
  const self = fileURLToPath(import.meta.url);
  await new Promise((done) => {
    const startWorker = () => {
      const w = fork(self, ['--worker', ...argv, ...(opts.wav && !argv.includes('--wav') ? ['--wav'] : [])]);
      const feed = () => {
        if (next >= todo.length) { w.kill(); if (--running === 0) done(); return; }
        const job = todo[next++];
        w.once('message', (m) => {
          if (m.ok) {
            const e = m.entry;
            results.set(e.name, e);
            console.log(`${e.name.padEnd(14)} ${e.duration.toFixed(2).padStart(7)}s ` +
              (e.loop ? `loop ${e.loop_start_sec.toFixed(2)}-${e.loop_end_sec.toFixed(2)}s match ${e.loop_match}${e.loop_approx ? ' (approx)' : ''}` : e.ends ? 'ends' : e.kind === 'sfx' ? 'cut at limit' : 'NO LOOP FOUND') +
              ` rms ${e.rms}  (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
          } else { failed++; console.log(`${m.name} FAILED\n${m.error}`); }
          feed();
        });
        w.send(job);
      };
      running++;
      feed();
    };
    for (let i = 0; i < nWorkers; i++) startWorker();
  });
  fs.rmSync(opts.tmp, { recursive: true, force: true });
  const order = jobs().map((j) => j.name);
  const items = [...results.values()].sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
  writeJson(indexFile, {
    generator: 'tools/export/audio.mjs', driver: 'ZMUSIC 1.49F (ZMUSIC -U -BICITY.ZPD) in the emulator',
    sample_rate: RATE, format: opts.wav ? 'wav' : 'ogg',
    loop_convention: 'file = intro + one loop body; loop region is [loop_start_sec, loop_end_sec) and loop_end_sec is the file end. Godot: AudioStreamOggVorbis.loop = true, loop_offset = loop_start_sec.',
    trim: 'leading silence removed up to the first sample above 2e-4 (-74 dBFS); one-shot items end 20-50 ms after the last audible sample',
    items,
  });
  console.log(`${items.length} items in ${indexFile}${failed ? `, ${failed} failed` : ''} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
}
