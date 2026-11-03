// Render the game's MIDI music (the Roland MT-32 / CM-64 version) for the Godot port.
//
// In MIDI mode ICITY68 plays GROUPMD\0000nn.DAT instead of the FM songs, and MENU68 first sends
// ICITY.MDD (the patches and timbres) to the module. Here the game's own sound driver (ZMUSIC
// 1.49F) plays each song to an emulated MIDI interface (audio/midi.mjs); the bytes it sends are
// recorded with their timing until the song loops, then played through Munt (libmt32emu) with
// the user's ROMs (audio/mt32render.py) and cut like the FM tracks: intro + one loop body.
//
// The ROMs are not part of the game and never go into the repository or the game data's source:
// the render needs the user's own MT-32 or CM-32L control and PCM ROMs.
//
// Usage: node tools/export/mt32.mjs [--munt DLL] [--roms DIR] [--jobs N] [--only REGEX]
//   --munt   libmt32emu shared library (default ../work/munt/build/mt32emu-2.dll, or $IC_MUNT)
//   --roms   folder with the control and PCM ROM files (default ../work/mt32rom, or $IC_MT32_ROMS)
// Output: ../work/export/mt32/music/<name>.wav and mt32/index.json (same fields as audio/).
// Without Munt or the ROMs it prints why and writes nothing.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { root, allFiles, loadDisks, exportDir, ensureDir, writeWav, writeJson } from './common.mjs';
import { unpackMusic } from './audio/unpack.mjs';
import { MUSIC_TABLE } from './audio/songs.mjs';

const OUT = `${exportDir}/mt32`;
const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const munt = path.resolve(arg('--munt', process.env.IC_MUNT ?? `${root}/work/munt/build/mt32emu-2.dll`));
const roms = path.resolve(arg('--roms', process.env.IC_MT32_ROMS ?? `${root}/work/mt32rom`));
const python = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');

const findFile = (p) => allFiles().find((f) => f.path === p);
const pad = (n, w = 2) => String(n).padStart(w, '0');

function jobs() {
  return Object.entries(MUSIC_TABLE).map(([id, [file]]) => ({
    name: `bgm_${pad(id)}`, src: `GROUPMD/${pad(file, 6)}.DAT`,
    used_by: [`ICITY68 music ${id} in MIDI mode (f_69B44 -> f_66988 -> play_cnv_data)`] }));
}

function readWav(file) {
  const b = fs.readFileSync(file);
  let pos = 12, rate = 0, data = null;
  while (pos + 8 <= b.length) {
    const id = b.toString('ascii', pos, pos + 4), size = b.readUInt32LE(pos + 4);
    if (id === 'fmt ') rate = b.readUInt32LE(pos + 12);
    if (id === 'data') data = b.subarray(pos + 8, pos + 8 + size);
    pos += 8 + size + (size & 1);
  }
  const au = new Float32Array(data.length >> 1);
  for (let i = 0; i < au.length; i++) au[i] = data.readInt16LE(i * 2) / 32768;
  return { rate, au };
}

async function renderJob(job) {
  const { Session } = await import('./audio/session.mjs');
  const { attachMidi, captureMidi, channelNotes } = await import('./audio/midi.mjs');
  const { assembleLoop, firstAudible, lastAudible, rms } = await import('./audio/render.mjs');
  const bytes = [];
  let sess = null;
  sess = new Session(loadDisks(), { setup: (sys) => attachMidi(sys, (d) => bytes.push([sess ? sess.now() : 0, d])) });
  const addr = sess.write(0, unpackMusic(findFile(job.src).data));
  const log = (s) => process.stderr.write(`[${job.name}] ${s}\n`);
  const cap = captureMidi(sess, addr, bytes, { log });
  const crate = sess.rate;
  // FM voices the MIDI song still plays on the OPM (none expected: the MIDI songs are all-MIDI)
  const opmKeyOns = sess.keyOns;
  // render up to the end of the second loop pass (+ the crossfade), or the whole song
  const until = cap.loop ? cap.loop.start + 2 * cap.loop.period + 0.1 * crate : Infinity;
  const tmp = ensureDir(`${OUT}/.tmp`);
  const capFile = `${tmp}/${job.name}.json`, wavFile = `${tmp}/${job.name}.wav`;
  fs.writeFileSync(capFile, JSON.stringify({ rate: crate, bytes: bytes.filter(([t]) => t < until) }));
  const mdd = findFile('ICITY.MDD').data;
  const mddFile = `${tmp}/ICITY.MDD`;
  if (!fs.existsSync(mddFile)) fs.writeFileSync(mddFile, mdd);
  const p = spawnSync(python, ['-I', `${here}/audio/mt32render.py`, munt, roms, mddFile, capFile, wavFile,
    ...(cap.loop ? ['--end', String(Math.ceil(until))] : [])], { encoding: 'utf8' });
  if (p.status !== 0) throw new Error(`mt32render failed: ${p.stderr || p.error}`);
  const { rate, au } = readWav(wavFile);
  fs.rmSync(capFile); fs.rmSync(wavFile);
  const lead = Math.max(0, firstAudible(au));
  let out, loop = null;
  if (cap.loop) {
    const S = Math.max(Math.round(cap.loop.start * rate / crate), lead), P = Math.round(cap.loop.period * rate / crate);
    out = assembleLoop(au, lead, S, P, P, rate);
    loop = { start: S - lead, end: S - lead + P };
  } else {
    const end = Math.min(au.length >> 1, lastAudible(au) + Math.round(0.05 * rate));
    out = au.slice(lead * 2, Math.max(lead, end) * 2);
  }
  const file = `${OUT}/music/${job.name}.wav`;
  writeWav(file, out, rate, 2);
  const notes = channelNotes(bytes.filter(([t]) => t < until));
  const n = out.length / 2;
  return {
    name: job.name, kind: 'music', file: path.relative(OUT, file).replace(/\\/g, '/'), source: job.src,
    duration: +(n / rate).toFixed(4), sample_rate: rate, channels: 2,
    loop: !!loop,
    loop_start_sec: loop ? +(loop.start / rate).toFixed(4) : null,
    loop_end_sec: loop ? +(loop.end / rate).toFixed(4) : null,
    loop_start_sample: loop ? loop.start : null,
    loop_end_sample: loop ? loop.end : null,
    ...(loop ? {} : { ends: cap.ended }),
    midi_bytes: bytes.length,
    notes_per_channel: Object.fromEntries(notes.map((c, i) => [i, c]).filter(([i, c]) => i && c)),
    ...(opmKeyOns ? { opm_key_ons: opmKeyOns } : {}),
    rms: +rms(out).toFixed(4),
    used_by: job.used_by,
  };
}

if (argv[0] === '--worker') {
  process.on('message', async (job) => {
    try { process.send({ ok: true, entry: await renderJob(job) }); }
    catch (e) { process.send({ ok: false, name: job.name, error: e.stack }); }
  });
} else {
  const missing = [];
  if (!fs.existsSync(munt)) missing.push(`Munt library ${munt}`);
  if (!fs.existsSync(roms) || !fs.readdirSync(roms).some((f) => /\.rom$/i.test(f))) missing.push(`ROM files (*.rom) in ${roms}`);
  if (spawnSync(python, ['--version']).status !== 0) missing.push(`Python (${python})`);
  if (missing.length) {
    console.log(`MT-32 music not rendered: missing ${missing.join(', ')}`);
    process.exit(0);
  }
  const only = arg('--only') ? new RegExp(arg('--only')) : null;
  const todo = jobs().filter((j) => !only || only.test(j.name));
  const nWorkers = Math.max(1, Math.min(todo.length, Number(arg('--jobs', Math.max(1, os.cpus().length - 1)))));
  const indexFile = `${OUT}/index.json`;
  const prev = only && fs.existsSync(indexFile) ? JSON.parse(fs.readFileSync(indexFile, 'utf8')).items : [];
  const results = new Map(prev.map((e) => [e.name, e]));
  let next = 0, running = 0, failed = 0;
  const t0 = Date.now();
  await new Promise((done) => {
    const startWorker = () => {
      const w = fork(fileURLToPath(import.meta.url), ['--worker', ...argv]);
      const feed = () => {
        if (next >= todo.length) { w.kill(); if (--running === 0) done(); return; }
        const job = todo[next++];
        w.once('message', (m) => {
          if (m.ok) {
            const e = m.entry;
            results.set(e.name, e);
            const hi = Object.entries(e.notes_per_channel).filter(([c]) => c > 10).map(([c, n]) => `ch${c}:${n}`);
            console.log(`${e.name.padEnd(8)} ${e.duration.toFixed(2).padStart(7)}s ` +
              (e.loop ? `loop ${e.loop_start_sec.toFixed(2)}-${e.loop_end_sec.toFixed(2)}s` : e.ends ? 'ends' : 'NO LOOP FOUND') +
              ` rms ${e.rms}${hi.length ? `  notes outside the LA parts: ${hi.join(' ')}` : ''}${e.opm_key_ons ? `  OPM key-ons ${e.opm_key_ons}` : ''}` +
              `  (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
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
  fs.rmSync(`${OUT}/.tmp`, { recursive: true, force: true });
  const order = jobs().map((j) => j.name);
  const items = [...results.values()].sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
  writeJson(indexFile, {
    generator: 'tools/export/mt32.mjs',
    driver: 'ZMUSIC 1.49F in MIDI mode (emulated YM3802) -> Munt (libmt32emu) with ICITY.MDD sent first',
    format: 'wav',
    loop_convention: 'as audio/index.json: file = intro + one loop body, loop region [loop_start_sec, loop_end_sec)',
    items,
  });
  console.log(`${items.length} items in ${indexFile}${failed ? `, ${failed} failed` : ''} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
}
