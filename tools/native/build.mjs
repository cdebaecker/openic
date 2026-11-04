// Build the chipsynth GDExtension (live synthesis of the music, native/): fetch godot-cpp and
// ymfm at pinned commits into native/deps, configure with CMake and build the Release library into
// godot/bin, plus icl2wav (renders a chip log to WAV, for comparing with the exported files) and
// mt32render (the MT-32 music through Munt, for the importer: tools/export/mt32.mjs).
//
//   node tools/native/build.mjs [--cmake <cmake executable>]
// Needs git, CMake 3.17+ and a C++17 compiler (on Windows: Visual Studio with the C++ workload,
// whose bundled CMake is found when cmake is not on the PATH).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const native = path.resolve(here, '../../native');
const deps = path.join(native, 'deps');
const DEPS = [
  ['godot-cpp', 'https://github.com/godotengine/godot-cpp.git', '27d9dd23c83871e0619fca5dc2cddfbfd69e926a'],
  ['ymfm', 'https://github.com/aaronsgiles/ymfm.git', '81aec25ccbb98f4873a255f7551ac4dadac59b4a'],
  // libmt32emu 2.8.3, for mt32render (the MT-32 music from the player's ROMs)
  ['munt', 'https://github.com/munt/munt.git', '3b05ec276f9e605af86b0eaef7f5eda43477a31f'],
];
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });

function findCmake() {
  const args = process.argv.slice(2), i = args.indexOf('--cmake');
  if (i >= 0) return args[i + 1];
  if (spawnSync('cmake', ['--version']).status === 0) return 'cmake';
  for (const root of ['C:/Program Files/Microsoft Visual Studio', 'C:/Program Files (x86)/Microsoft Visual Studio']) {
    if (!fs.existsSync(root)) continue;
    for (const ver of fs.readdirSync(root).sort().reverse()) {
      for (const ed of ['Community', 'Professional', 'Enterprise', 'BuildTools']) {
        const c = path.join(root, ver, ed, 'Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/cmake.exe');
        if (fs.existsSync(c)) return c;
      }
    }
  }
  throw new Error('CMake not found: install it or pass --cmake <path>');
}

fs.mkdirSync(deps, { recursive: true });
for (const [name, url, commit] of DEPS) {
  const dir = path.join(deps, name);
  if (!fs.existsSync(path.join(dir, '.git'))) run('git', ['clone', '--filter=blob:none', url, dir]);
  const head = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD']).toString().trim();
  if (head !== commit) {
    run('git', ['-C', dir, 'fetch', '--quiet', 'origin', commit]);
    run('git', ['-C', dir, 'checkout', '--quiet', commit]);
  }
}
const cmake = findCmake();
const build = path.join(native, 'build');
run(cmake, ['-S', native, '-B', build, `-DDEPS=${deps}`, '-DCMAKE_BUILD_TYPE=Release']);   // single-config generators (Linux)
// a bounded job count: plain --parallel is unlimited make -j on Linux, too many compilers at once
run(cmake, ['--build', build, '--config', 'Release', '--target', 'chipsynth', 'icl2wav', 'mt32render', '--parallel', String(os.availableParallelism())]);
console.log(`chipsynth in ${path.resolve(native, '../godot/bin')}`);
