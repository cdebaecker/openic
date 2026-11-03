// OpenIC: build a Windows release - the exported game, and next to it the importer it runs on
// first launch (Node.js, the exporters, the emulator, the translations). No game data: players
// build it from their own disks.
//
//   node tools/openic/package.mjs [--godot <Godot executable>] [--out dist/windows] [--zip]
//     --godot  the Godot 4 editor executable (default: $GODOT); its export templates must be installed
//     --zip    also write <out>.zip
// Run it in the OpenIC repository (tools/openic/sync.mjs makes one): tools/, src/ and text/ are
// copied whole into <out>/importer/, with this Node.js executable as importer/node.exe.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const godot = opt('--godot', process.env.GODOT);
const out = path.resolve(opt('--out', path.join(repo, 'dist/windows')));
if (!godot) { console.log('Godot executable: pass --godot <path> or set GODOT'); process.exit(1); }

// live synthesis of the music (native/); without it the game plays the rendered files
const dll = path.join(repo, 'godot/bin/chipsynth.windows.template_release.x86_64.dll');
if (!fs.existsSync(dll)) {
  try { execFileSync(process.execPath, [path.join(repo, 'tools/native/build.mjs')], { stdio: 'inherit' }); }
  catch { console.log('chipsynth not built: the release plays the rendered music files'); }
}
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
console.log('exporting the game…');
execFileSync(godot, ['--headless', '--path', path.join(repo, 'godot'), '--export-release', 'Windows', path.join(out, 'OpenIC.exe')], { stdio: 'inherit' });

const importer = path.join(out, 'importer');
for (const d of ['tools', 'src', 'text']) {
  fs.cpSync(path.join(repo, d), path.join(importer, d), { recursive: true,
    filter: (p) => !p.includes(`${path.sep}recomp${path.sep}gen`) && !p.includes('__pycache__') });
}
fs.copyFileSync(path.join(repo, 'package.json'), path.join(importer, 'package.json'));
fs.copyFileSync(process.execPath, path.join(importer, 'node.exe'));
// Node.js's licence (and its bundled dependencies'), from the nodejs/node repository at the
// version bundled here; the Windows installer does not install it
fs.copyFileSync(path.join(here, 'LICENSE-nodejs.txt'), path.join(out, 'LICENSE-nodejs.txt'));
fs.writeFileSync(path.join(out, 'README.txt'), [
  'OpenIC - unofficial fan port of Illusion City (X68000)',
  '',
  'Start OpenIC.exe. On first launch it asks for the folder with your seven disk images of the',
  'X68000 game (DIM, XDF, HDM or D88) and builds the game data from them (about 2 minutes).',
  'Nothing of the original game is included. Unofficial, non-commercial fan project.',
  '',
  'importer/ holds the tools that read your disks (Node.js, MIT licence; the X68000 emulator and',
  'exporters of OpenIC).',
  '',
  'OpenIC is free software under the GNU GPL v3 (LICENSE.txt); source: https://github.com/cdebaecker/openic',
  'The music is synthesized live with ymfm (BSD 3-Clause, Copyright Aaron Giles) and godot-cpp (MIT).',
  '',
].join('\r\n'));
if (fs.existsSync(path.join(repo, 'LICENSE'))) fs.copyFileSync(path.join(repo, 'LICENSE'), path.join(out, 'LICENSE.txt'));
for (const [dep, file] of [['ymfm', 'LICENSE'], ['godot-cpp', 'LICENSE.md']]) {
  const f = path.join(repo, 'native/deps', dep, file);
  if (fs.existsSync(f)) fs.copyFileSync(f, path.join(out, `LICENSE-${dep}.txt`));
}

if (args.includes('--zip')) {
  const { writeZip } = await import('../export/zip.mjs');
  const zip = `${out}.zip`;
  fs.rmSync(zip, { force: true });
  writeZip(zip, out);
  console.log(`wrote ${zip}`);
}
console.log(`release in ${out}`);
