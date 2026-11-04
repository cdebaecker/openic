// OpenIC: build a release - the exported game, and next to it the importer it runs on first
// launch (Node.js, the exporters, the emulator, the translations). No game data:
// players build it from their own disks.
//
//   node tools/openic/package.mjs [--godot <Godot executable>] [--platform windows|linux]
//                                 [--out dist/<platform>] [--zip] [--template <file>]
//     --godot     the Godot 4 editor executable (default: $GODOT); its export templates must be installed
//     --platform  default: this system's. The importer's Node.js is the one running this script,
//                 so build each platform's release on that platform.
//     --zip       also write <out>.zip (Windows) or <out>.tar.gz (Linux, keeps the executable bits)
//     --template  a custom export template (tools/openic/godot_template.py) instead of the official one
// Run it in the OpenIC repository (tools/openic/sync.mjs makes one): tools/, src/ and text/ are
// copied whole into <out>/importer/, with this Node.js executable as importer/node[.exe].
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const platform = opt('--platform', process.platform === 'win32' ? 'windows' : 'linux');
const P = {
  windows: { preset: 'Windows', game: 'OpenIC.exe', node: 'node.exe', ext: '.dll' },
  linux: { preset: 'Linux', game: 'OpenIC.x86_64', node: 'node', ext: '.so' },
}[platform];
if (!P) { console.log(`unknown platform ${platform}`); process.exit(1); }
const godot = opt('--godot', process.env.GODOT);
const out = path.resolve(opt('--out', path.join(repo, 'dist', platform)));
if (!godot) { console.log('Godot executable: pass --godot <path> or set GODOT'); process.exit(1); }

// live synthesis of the music (native/); without it the game plays the rendered files
const bin = path.join(repo, 'godot/bin');
const dll = path.join(bin, `chipsynth.${platform}.template_release.x86_64${P.ext}`);
if (!fs.existsSync(dll)) {
  try { execFileSync(process.execPath, [path.join(repo, 'tools/native/build.mjs')], { stdio: 'inherit' }); }
  catch { console.log('chipsynth not built: the release plays the rendered music files'); }
}
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
console.log(`exporting the game for ${platform}…`);
// --template: a custom export template, set in the preset for this export only
const template = opt('--template');
const presets = path.join(repo, 'godot/export_presets.cfg');
const presetsBefore = fs.readFileSync(presets, 'utf8');
if (template) {
  const at = presetsBefore.indexOf(`\nname="${P.preset}"`);
  const key = presetsBefore.indexOf('custom_template/release=""', at);
  if (at < 0 || key < 0) throw new Error(`export_presets.cfg: no ${P.preset} custom_template/release`);
  fs.writeFileSync(presets, presetsBefore.slice(0, key) + `custom_template/release="${path.resolve(template).replaceAll('\\', '/')}"`
    + presetsBefore.slice(key + 'custom_template/release=""'.length));
}
try {
  execFileSync(godot, ['--headless', '--path', path.join(repo, 'godot'), '--export-release', P.preset, path.join(out, P.game)], { stdio: 'inherit' });
} finally {
  if (template) fs.writeFileSync(presets, presetsBefore);
}

const importer = path.join(out, 'importer');
for (const d of ['tools', 'src', 'text']) {
  fs.cpSync(path.join(repo, d), path.join(importer, d), { recursive: true,
    filter: (p) => !p.includes(`${path.sep}recomp${path.sep}gen`) && !p.includes('__pycache__') });
}
fs.copyFileSync(path.join(repo, 'package.json'), path.join(importer, 'package.json'));
fs.copyFileSync(process.execPath, path.join(importer, P.node));
fs.chmodSync(path.join(importer, P.node), 0o755);
// Node.js's licence (and its bundled dependencies'), from the nodejs/node repository at the
// version bundled here; the Windows installer does not install it
fs.copyFileSync(path.join(here, 'LICENSE-nodejs.txt'), path.join(out, 'LICENSE-nodejs.txt'));
const nl = platform === 'windows' ? '\r\n' : '\n';
fs.writeFileSync(path.join(out, 'README.txt'), [
  'OpenIC - unofficial fan port of Illusion City (X68000)',
  '',
  `Start ${P.game}. On first launch it asks for the folder with your seven disk images of the`,
  'X68000 game (DIM, XDF, HDM or D88) and builds the game data from them (about 2 minutes).',
  'Nothing of the original game is included. Unofficial, non-commercial fan project.',
  '',
  'importer/ holds the tools that read your disks (Node.js, MIT licence; the X68000 emulator and',
  'exporters of OpenIC).',
  '',
  'OpenIC is free software under the GNU GPL v3 (LICENSE.txt); source: https://github.com/cdebaecker/openic',
  'The music is synthesized live with ymfm (BSD 3-Clause, Copyright Aaron Giles) and godot-cpp (MIT).',
  '',
].join(nl));
if (fs.existsSync(path.join(repo, 'LICENSE'))) fs.copyFileSync(path.join(repo, 'LICENSE'), path.join(out, 'LICENSE.txt'));
for (const [dep, file] of [['ymfm', 'LICENSE'], ['godot-cpp', 'LICENSE.md']]) {
  const f = path.join(repo, 'native/deps', dep, file);
  if (fs.existsSync(f)) fs.copyFileSync(f, path.join(out, `LICENSE-${dep}.txt`));
}

if (args.includes('--zip')) {
  if (platform === 'windows') {
    const { writeZip } = await import('../export/zip.mjs');
    const zip = `${out}.zip`;
    fs.rmSync(zip, { force: true });
    writeZip(zip, out);
    console.log(`wrote ${zip}`);
  } else {
    const tgz = `${out}.tar.gz`;
    execFileSync('tar', ['-czf', tgz, '-C', path.dirname(out), path.basename(out)], { stdio: 'inherit' });
    console.log(`wrote ${tgz}`);
  }
}
console.log(`release in ${out}`);
