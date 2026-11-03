// Event programs for the Godot port's script VM (docs/events.md): the raw EVT file of every map
// (actors, triggers, cutscenes, VM code + messages) and the two SCN scripts, as the game loads them.
// Also the new-game state: the 954-byte state block ($9C794, docs/events.md section 6) as it is
// when the new game's first script starts (IC_MAIN entry $10, first entry to the interpreter
// f_7a55e): party of three, character records, ... — captured from the original running in the
// emulator (tools/emu.mjs, the title-menu route of tools/scripts/new-game.json).
// Usage: node tools/export/events.mjs   -> ../work/export/events/{<map>.evt, IC_MAIN.SCN, CONSULT.SCN,
//                                          newgame.block, index.json}
import fs from 'node:fs';
import { readFile, exportDir, ensureDir, writeJson } from './common.mjs';
import { Session } from '../emu.mjs';

async function newGameBlock() {
  const s = await Session.create();
  const script = JSON.parse(fs.readFileSync(new URL('../scripts/new-game.json', import.meta.url), 'utf8'));
  let block = null;
  s.sys.addHook(0x7a55e, () => {
    if (!block && s.sys.programName() === 'ICITY68.X') block = s.m.ram.slice(0x9c794, 0x9c794 + 954);
  });
  for (let f = 0; f < 4000 && !block; f++) {
    for (const ev of script) if (ev.frame === f) { if (ev.key !== undefined) s.sys.keyEvent(ev.key, true); if (ev.keyup !== undefined) s.sys.keyEvent(ev.keyup, false); }
    s.run(1);
  }
  if (!block) throw new Error('the new game did not start a script');
  return block;
}

const out = ensureDir(`${exportDir}/events`);
const index = JSON.parse(fs.readFileSync(`${exportDir}/data/index.json`, 'utf8'));
const maps = {};
for (const m of index.maps) {
  if (!m.event) continue;
  const b = readFile(m.event.file);
  if (!b) continue;
  fs.writeFileSync(`${out}/${m.id}.evt`, b);
  maps[m.id] = { file: `${m.id}.evt`, source: m.event.file };
}
for (const f of ['IC_MAIN.SCN', 'CONSULT.SCN']) fs.writeFileSync(`${out}/${f}`, readFile(f));
const block = await newGameBlock();
fs.writeFileSync(`${out}/newgame.block`, block);
console.log(`events: new-game block, party count ${(block[0x20a] << 8) | block[0x20b]}`);
writeJson(`${out}/index.json`, { maps, scn: ['IC_MAIN.SCN', 'CONSULT.SCN'] });
console.log(`events: ${Object.keys(maps).length} maps + 2 SCN -> ${out}`);
