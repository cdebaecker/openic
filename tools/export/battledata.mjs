// Constant data of the battle logic for the Godot port (milestone 6): the tables inside ICITY68.X
// that tools/battle/model.mjs reads (loadBattleData) and the message templates of every message
// the model can log, read from the ICITY68 image by run-time address (as model.mjs does). The
// port's scripts/battle/battle_model.gd loads it with data/systems.json (IC_TABLE.COM).
//
//   node tools/export/battledata.mjs    -> ../work/export/data/battle.json   (needs ../work/icity68.image.bin)
//
// Output (game data: never commit it):
//   eventGroups  $8CD74: 10 event battle formations, each a list of [set id, x, row, pose]
//   partyPos3    $8CCF0: (x, row) of the party slots, 3 members; partyPos2 $8CCF6: 2 members
//   cmdCodes     $8D092: command codes (a member's list starts at the offset of f_717b6, items at +1)
//   skillWord    $8CF09: weapon type -> skill counter word (f_71764)
//   tableStride  $8D0DE, tableNameOff $8D108: IC_TABLE record stride / name offset by table, read by
//                the message expansion ('$n' with a table number, f_72286; presentation only)
//   messageNames { name: address } the M table of model.mjs, plus the strings the commands put in
//                the message globals ($9EDAC with $9EDBA = -2: claws, guns)
//   messages     { "<hex address>": base64 Shift-JIS bytes (C string, control codes kept) }
import fs from 'node:fs';
import { root } from '../root.mjs';
import { exportDir, writeJson, readFile } from './common.mjs';
import { parseFil } from './data/fil.mjs';

const IMAGE_BASE = 0x65c70;
const imgPath = `${root}/work/icity68.image.bin`;
if (!fs.existsSync(imgPath)) {
  console.log(`battledata: ${imgPath} missing (run node tools/gen.mjs first) - skipped`);
  process.exit(0);
}
const img = fs.readFileSync(imgPath);
const byte = (a) => img[a - IMAGE_BASE];
const word = (a) => (byte(a) << 8) | byte(a + 1);
const long = (a) => ((word(a) << 16) | word(a + 2)) >>> 0;
const bytes = (a, n) => [...Array(n).keys()].map((k) => byte(a + k));
const cstr = (a) => { const o = []; for (let i = 0; byte(a + i); i++) o.push(byte(a + i)); return o; };
const b64 = (b) => Buffer.from(b).toString('base64');
const hex = (a) => a.toString(16);

// model.mjs M (same names) and the command strings of runCommand (codes 7-11)
const MESSAGES = {
  encounter: 0x6abbc, defeated: 0x6b396, exp: 0x6b39f, money: 0x6b3b0, levelUp: 0x6b4e2, found: 0x6b630, gameOver: 0x6b79e,
  turn: 0x8d160, attackWith: 0x8d1ae, dmg: 0x8d1bb, dmgEach: 0x8d1cc, transform: 0x8d21f, useItem: 0x8d245, cantUse: 0x8d252,
  cast: 0x8d263, fled: 0x8d274, fleeFail: 0x8d285, defend: 0x8d294, pbarAbsorb: 0x8d29d, mbarAbsorb: 0x8d2b6, revived: 0x8d388,
  pbarBreak: 0x8d3a1, mbarBreak: 0x8d3ba, cantMove: 0x8d375, enemyAttack: 0x8d491, cantAct: 0x8d49a, sealed: 0x8d4a7,
  poisoned: 0x8cdb1, asleep: 0x8cdc4, confused: 0x8cdd3, judgement: 0x8cde4, missed: 0x9d178,
  quickFail: 0x6b85c, unsealed: 0x8cdfb, unillusion: 0x8ce18, awake: 0x8ce2b, sane: 0x8ce3e, unclone: 0x8ce51,
  claws: 0x8d22c, kousin: 0x8d22f, machineGun: 0x8d21a, shotCannon: 0x8d209, mbhCannon: 0x8d200,
};

const eventGroups = [];
for (let g = 0; g < 10; g++) {
  const r = [];
  for (let a = long(0x8cd74 + 4 * g); byte(a); a += 4) r.push(bytes(a, 4));
  eventGroups.push(r);
}
const out = {
  note: 'ICITY68 battle constants (tools/battle/model.mjs loadBattleData) and battle message templates by run-time address; Shift-JIS bytes, base64.',
  imageBase: IMAGE_BASE,
  eventGroups,
  partyPos3: bytes(0x8ccf0, 6), partyPos2: bytes(0x8ccf6, 4),
  cmdCodes: bytes(0x8d092, 32),
  skillWord: bytes(0x8cf09, 8),
  tableStride: [...Array(21).keys()].map((t) => word(0x8d0de + 2 * t)),
  tableNameOff: [...Array(21).keys()].map((t) => word(0x8d108 + 2 * t)),
  messageNames: MESSAGES,
  messages: {},
};
for (const a of Object.values(MESSAGES)) out.messages[hex(a)] = b64(cstr(a));
// battle sprite set of every sprite set id (f_6858e(4) -> f_68822(1, 1, k)): ICITY.FIL + 3229 holds
// 3 bytes per id; byte 1 is the ICITY.FIL table 9 index of the battle CG9 (party: their -B sets)
{
  const fil = readFile('ICITY.FIL');
  const t9 = parseFil(fil).tables.find((t) => t.type === 9).entries;
  out.battleSets = {};
  for (let id = 0; id < 256 && 3229 + 3 * id + 1 < fil.length; id++) {
    const e = t9.find((x) => x.index === fil[3229 + 3 * id + 1]);
    if (e) out.battleSets[id] = e.file.replace('.DAT', '').replace('/', '_');
  }
}
fs.mkdirSync(`${exportDir}/data`, { recursive: true });
writeJson(`${exportDir}/data/battle.json`, out);
console.log(`battledata: ${eventGroups.length} event groups, ${Object.keys(out.messages).length} messages -> ${exportDir}/data/battle.json`);
