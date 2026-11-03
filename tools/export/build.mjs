// Build the Godot port's game data from the original disk images: run every exporter, then
// assemble their output with the translation tables into one folder (and optionally a zip).
//
// Usage: node tools/export/build.mjs [--reuse] [--only name,...] [--out DIR] [--zip]
//   --reuse   skip exporters whose output already exists in ../work/export
//   --only    run just these exporters (pic, cg9, data, audio, mt32, cutscenes, frame, text, events, ui, gep, systems, uistrings, battle, battledata)
//   --out     destination (default godot/gamedata, which the project finds in development)
//   --zip     also write <out>.zip, which the game mounts as a resource pack
// The result is game data: never commit it (godot/.gitignore excludes it).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { root, exportDir, ensureDir, writeJson } from './common.mjs';
import { writeZip } from './zip.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const out = path.resolve(opt('--out', `${repo}/godot/gamedata`));
const only = opt('--only', '')?.split(',').filter(Boolean);

// name, exporter arguments, file that shows the export is complete. mt32 is optional: it needs
// Munt and the player's own MT-32 / CM-32L ROMs (tools/export/mt32.mjs) and writes nothing without.
const EXPORTERS = [
  ['pic', [], 'pic/index.json'],
  ['cg9', [], 'cg9/index.json'],
  ['data', ['--previews'], 'data/index.json'],
  ['audio', [], 'audio/index.json'],
  ['mt32', [], 'mt32/index.json'],
  ['cutscenes', [], 'cutscenes/ending.json'],
  ['frame', [], 'frame/battle.json'],
  ['text', [], 'text/sjis.json'],
  ['events', [], 'events/index.json'],
  ['ui', [], 'ui/asdf.idx.png'],
  ['gep', [], 'gep/index.json'],
  ['systems', [], 'data/systems.json'],
  ['uistrings', [], 'ui/strings.json'],
  ['battle', [], 'battle/index.json'],
  ['battledata', [], 'data/battle.json'],
];

// The exporters run at the same time (they write to separate folders); one reads another's output.
const AFTER = { events: 'data' };   // events reads data/index.json
const PARTS = { cutscenes: ['title', 'opening', 'ending'] };   // independent runs, one process each
const started = new Map();          // name -> promise
const exportOne = (name, extra, done) => {
  if (started.has(name)) return started.get(name);
  const p = (async () => {
    if (AFTER[name] && started.has(AFTER[name])) await started.get(AFTER[name]);
    console.log(`${name}: exporting…`);
    const t0 = Date.now();
    const runs = (PARTS[name] ?? [null]).map((part) => new Promise((r) => spawn(process.execPath,
      ['--max-old-space-size=8192', `${here}/${name}.mjs`, ...extra, ...(part ? [part] : [])],
      { stdio: ['ignore', name === 'mt32' ? 'inherit' : 'ignore', 'inherit'] }).on('close', r)));
    const codes = await Promise.all(runs);
    if (codes.some((c) => c !== 0)) throw new Error(`${name}: the exporter failed (exit codes ${codes.join(', ')})`);
    if (name === 'mt32' && !fs.existsSync(`${exportDir}/${done}`)) { console.log(`${name}: done in 0s (not rendered)`); return; }
    if (!fs.existsSync(`${exportDir}/${done}`)) throw new Error(`${name}: the exporter finished without writing ${exportDir}/${done}`);
    console.log(`${name}: done in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  })();
  started.set(name, p);
  return p;
};
const jobs = [];
for (const [name, extra, done] of EXPORTERS) {
  if (only?.length && !only.includes(name)) continue;
  if (flag('--reuse') && fs.existsSync(`${exportDir}/${done}`)) { console.log(`${name}: reusing ${exportDir}/${name}`); continue; }
  jobs.push(exportOne(name, extra, done));
}
await Promise.all(jobs);

fs.rmSync(out, { recursive: true, force: true });
ensureDir(out);
// The game reads these files itself; keep the Godot editor from importing them.
fs.writeFileSync(`${out}/.gdignore`, '');
const sections = {};
for (const [name, , done] of EXPORTERS) {
  if (!fs.existsSync(`${exportDir}/${done}`)) { console.warn(`${name}: missing (${exportDir}/${done}), not included`); continue; }
  // (an exporter may write into another one's folder, e.g. systems -> data/)
  if (!fs.existsSync(`${exportDir}/${name}`)) continue;
  fs.cpSync(`${exportDir}/${name}`, `${out}/${name}`, { recursive: true, filter: (p) => !p.endsWith('.wav') || !fs.existsSync(p.slice(0, -4) + '.ogg') });
  sections[name] = `${name}/`;
}
// Translation: dialogue/narration table and interface glossary (README, "English translation"),
// and the subtitles of text in the cutscenes' pictures (*_subtitles.json: data/text in this
// repository, or the translation folder, ../work/text, as the OpenIC importer lays it out).
const text = `${root}/work/text`;
for (const dir of [`${repo}/data/text`, text]) {
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('_subtitles.json'))) {
    fs.mkdirSync(`${out}/text`, { recursive: true });
    fs.cpSync(`${dir}/${f}`, `${out}/text/${f}`);
  }
}
for (const f of ['messages.json', 'glossary.json', 'messages_fr.json', 'glossary_fr.json']) {
  if (fs.existsSync(`${text}/${f}`)) { fs.cpSync(`${text}/${f}`, `${out}/text/${f}`); sections.text = 'text/'; }
}

let commit = '';
try { commit = execFileSync('git', ['-C', repo, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(); } catch {}
const count = (d) => fs.readdirSync(d, { recursive: true }).filter((f) => fs.statSync(path.join(d, f)).isFile()).length;
writeJson(`${out}/manifest.json`, {
  format: 1,
  game: 'Genei Toshi / Illusion City (X68000, MicroCabin 1991)',
  notice: 'Game data extracted from the original disks for the fan port; see PERMISSION.md. Do not redistribute outside the terms.',
  built: new Date().toISOString(),
  tools_commit: commit,
  sections,
  files: count(out),
});

if (flag('--zip')) {
  // Inside the zip everything sits under gamedata/, which is where GameData reads a mounted pack.
  const zip = `${out}.zip`;
  fs.rmSync(zip, { force: true });
  writeZip(zip, out);
  console.log(`wrote ${zip} (${(fs.statSync(zip).size / 1048576).toFixed(0)} MB)`);
}
console.log(`game data in ${out}: ${Object.keys(sections).join(', ')}`);
