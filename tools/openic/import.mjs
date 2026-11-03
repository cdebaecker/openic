// OpenIC: build the game data from the player's own disk images (the game's in-app importer
// runs this; it also works from a terminal).
//
//   node tools/openic/import.mjs --root <dir> --out <dir> [--text <dir>] [--live-music] [--folder]
//     --root  work folder holding the seven images under the names tools/export/common.mjs
//             expects ("Genei Toshi (1991)(Microcabin)(Disk N of 7).dim"; raw XDF/HDM or DIM);
//             the exporters' scratch files go to <root>/work
//     --out   where the game data goes: <out>.zip, compressed (the game reads user://gamedata.zip),
//             or the folder <out> itself with --folder
//     --live-music  FM music as chip logs only, for a game with the chipsynth extension
//     --text  translation tables (messages.json, glossary.json, *_fr.json, *_subtitles.json);
//             default: the text folder next to tools/
//   Or: --disks <dir> instead of --root: finds and names the seven images in <dir> itself (raw
//   or DIM only; the game's importer also reads D88).
//
// Progress lines on stdout, for the importer screen: "step <i>/<n> <name>", then "done".
// Nothing is downloaded and nothing of the game is in this repository: everything comes from
// the disks given.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const fail = (msg) => { console.log(`error ${msg}`); process.exit(1); };

const DISK_NAME = (i) => `Genei Toshi (1991)(Microcabin)(Disk ${i} of 7).dim`;
// A file only disk N has (the game's file tree; checked by name and size class only)
const SIGNATURE = ['ZMUSIC.X', 'GROUP00/000028.DAT', 'GROUP02/000000.DAT', 'GROUP03/000000.DAT',
  'GROUP05/000025.DAT', 'GROUP05/000014.DAT', 'GROUP06/000089.DAT'];
const EXPORTERS = 15;   // tools/export/build.mjs EXPORTERS

let root = opt('--root');
const out = opt('--out');
if (!out) fail('--out is required');
if (!root) {
  const disks = opt('--disks');
  if (!disks) fail('--root or --disks is required');
  root = path.resolve(opt('--work') ?? path.join(disks, '.openic-work'));
  fs.mkdirSync(root, { recursive: true });
  const { Disk } = await import('../../src/fs.js');
  const found = new Map();
  for (const f of fs.readdirSync(disks)) {
    if (!/\.(dim|xdf|hdm)$/i.test(f)) continue;
    let d;
    try { d = new Disk(new Uint8Array(fs.readFileSync(path.join(disks, f)))); } catch { continue; }
    const names = new Set();
    const walk = (n, p) => { for (const c of n.children.values()) { const q = p ? `${p}/${c.name}` : c.name; if (c.isDir) walk(c, q); else names.add(q); } };
    walk(d.root, '');
    SIGNATURE.forEach((s, k) => { if (names.has(s) && !found.has(k + 1)) found.set(k + 1, path.join(disks, f)); });
  }
  for (let i = 1; i <= 7; i++) {
    if (!found.has(i)) fail(`disk ${i} of 7 not found in ${disks}`);
    fs.copyFileSync(found.get(i), path.join(root, DISK_NAME(i)));
  }
}
root = path.resolve(root);
for (let i = 1; i <= 7; i++) if (!fs.existsSync(path.join(root, DISK_NAME(i)))) fail(`missing ${DISK_NAME(i)} in ${root}`);

// translation tables -> <root>/work/text, where the build and the cutscene exporter read them
const text = path.resolve(opt('--text') ?? path.join(repo, 'text'));
const workText = path.join(root, 'work', 'text');
fs.mkdirSync(workText, { recursive: true });
if (fs.existsSync(text)) for (const f of fs.readdirSync(text)) if (f.endsWith('.json')) fs.copyFileSync(path.join(text, f), path.join(workText, f));

const env = { ...process.env, IC_ROOT: root.replace(/\\/g, '/'), IC_EXPORT: path.join(root, 'work', 'export').replace(/\\/g, '/') };
const run = (script, extra, label) => {
  const p = spawnSync(process.execPath, ['--max-old-space-size=8192', path.join(repo, script), ...extra], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (p.status !== 0) fail(`${label}: ${(p.stderr || p.stdout || String(p.error)).trim().split('\n').slice(-3).join(' | ')}`);
  return p.stdout;
};

const total = EXPORTERS + 2;
console.log(`step 1/${total} boot`);
run('tools/gen.mjs', ['--image-only'], 'booting the game to read its memory image');
// glossary keys published as hashes: put the Japanese back from the disks (tools/openic/glossary.mjs)
{
  process.env.IC_ROOT = env.IC_ROOT;
  const { restore } = await import('./glossary.mjs');
  const { allFiles } = await import('../export/common.mjs');
  const read = (f) => JSON.parse(fs.readFileSync(path.join(workText, f), 'utf8'));
  if (fs.existsSync(path.join(workText, 'glossary.json'))) {
    const fr = fs.existsSync(path.join(workText, 'glossary_fr.json')) ? read('glossary_fr.json') : {};
    const sources = [new Uint8Array(fs.readFileSync(path.join(root, 'work', 'icity68.image.bin'))), ...allFiles().map((f) => f.data)];
    const r = restore(read('glossary.json'), fr, sources);
    fs.writeFileSync(path.join(workText, 'glossary.json'), JSON.stringify(r.glossary, null, 1));
    fs.writeFileSync(path.join(workText, 'glossary_fr.json'), JSON.stringify(r.fr, null, 1));
    if (r.missing.length) console.log(`warning ${r.missing.length} glossary entries not found on these disks`);
  }
}
// build.mjs runs each exporter and prints "<name>: exporting…"; relay those as steps
let step = 1;
const child = (await import('node:child_process')).spawn(process.execPath,
  ['--max-old-space-size=8192', path.join(repo, 'tools/export/build.mjs'), '--out', path.resolve(out),
    ...(args.includes('--folder') ? [] : ['--zip']), ...(args.includes('--live-music') ? ['--live-music'] : [])],
  { env, stdio: ['ignore', 'pipe', 'pipe'] });
let errTail = '';
child.stderr.on('data', (d) => { errTail = (errTail + d).slice(-2000); });
let buf = '';
child.stdout.on('data', (d) => {
  buf += d;
  let k;
  while ((k = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, k).trim(); buf = buf.slice(k + 1);
    const m = /^(\w+): done in/.exec(line);   // the exporters run concurrently: count finished ones
    if (m) console.log(`step ${++step}/${total} ${m[1]}`);
  }
});
const code = await new Promise((r) => child.on('close', r));
if (code !== 0) fail(`building the game data: ${errTail.trim().split('\n').slice(-3).join(' | ')}`);
console.log(`step ${total}/${total} cleanup`);
fs.rmSync(path.join(root, 'work'), { recursive: true, force: true });
// the game reads the compressed <out>.zip (a resource pack) when there is no <out> folder
if (!args.includes('--folder')) fs.rmSync(path.resolve(out), { recursive: true, force: true });
console.log('done');
