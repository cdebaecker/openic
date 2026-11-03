// Cutscene timelines for the opening (IL_OPEN.X), the ending (IL_END.X) and the title menu
// (MENU68.X), recovered by running the programs in the emulator with hooks on their drawing
// primitives (tools/export/cutscenes/programs.mjs), and checked by replaying the timeline into a
// model of graphic VRAM in lockstep with the emulator (tools/export/cutscenes/replay.mjs).
//
// Usage: node tools/export/cutscenes.mjs [opening|ending|title ...] [--shots] [--listing]
//   -> ../work/export/cutscenes/{opening,ending,title}.json
//   --shots    also save a screenshot at every scene start to ../work/pic-scratch/shots-<name>/
//   --listing  write disassembly listings of the three programs to ../work/pic-scratch/
// See docs/cutscenes.md for the format.
import fs from 'node:fs';
import { exportDir, root, writeJson, writePng, ensureDir } from './common.mjs';
import { makeMachine, boot, applyInput, Recorder } from './cutscenes/record.mjs';
import { Checker } from './cutscenes/replay.mjs';
import { messageId } from '../../src/text/codec.js';
import { endingToText } from '../../src/text/ending.js';

const outDir = `${exportDir}/cutscenes`;
const scratch = `${root}/work/pic-scratch`;
const args = process.argv.slice(2);
const wantShots = args.includes('--shots');
const which = args.filter((a) => !a.startsWith('--'));
const todo = which.length ? which : ['title', 'opening', 'ending'];

// ---- input scripts (keyboard: 62 = cursor down, 29 = Return), as tools/scripts/new-game.json ----
// MENU68: controller menu (Joystick / Mouse) -> Mouse; sound menu -> FM; start menu -> entry n.
const menuInput = (startEntry) => {
  const s = [{ frame: 1520, key: 62 }, { frame: 1526, keyup: 62 }, { frame: 1540, key: 29 }, { frame: 1546, keyup: 29 },
    { frame: 2400, key: 29 }, { frame: 2406, keyup: 29 }];
  for (let i = 0; i < startEntry; i++) s.push({ frame: 2700 + 20 * i, key: 62 }, { frame: 2706 + 20 * i, keyup: 62 });
  s.push({ frame: 2740, key: 29 }, { frame: 2746, keyup: 29 });
  return s;
};

const hex = (v, n = 4) => (v >>> 0).toString(16).padStart(n, '0');

function frameRate(sys) {
  const g = sys.video.geometry();
  const lineSec = g.hf ? 1 / 31500 : 1 / 15980;
  return +(1 / (lineSec * g.vtotal)).toFixed(3);
}

function shotPng(sys, file) {
  const v = sys.video, n = v.frameW * v.frameH, rgba = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) { const p = v.frame[i]; rgba[i * 4] = p & 255; rgba[i * 4 + 1] = (p >> 8) & 255; rgba[i * 4 + 2] = (p >> 16) & 255; rgba[i * 4 + 3] = 255; }
  writePng(file, rgba, v.frameW, v.frameH);
}

// Run the machine until `stop(sys, rec)` or `max` frames. Returns { sys, rec, check }.
const shotFrames = new Set((process.env.SHOT_FRAMES ?? '').split(',').filter(Boolean).map(Number));
function run({ how, input = [], programs, check, stop, max, shots }) {
  const sys = makeMachine();
  // The recording reads the program's writes (VRAM, CRTC, palette), not the picture: draw scanlines
  // only when screenshots are wanted (most of the emulation time otherwise).
  if (!shots && !shotFrames.size) sys.video.renderLine = () => {};
  const rec = new Recorder(sys, { programs: new Set(programs) });
  const checker = check ? new Checker(sys, rec, new Set(check)) : null;
  boot(sys, how);
  let lastPic = null;
  if (shots) rec.listeners.push((e) => { if (e.op === 'loadPic' || e.op === 'loadGrp') lastPic = e; });
  const t0 = Date.now();
  for (let f = 0; f < max && !sys.finished; f++) {
    applyInput(sys, input, f);
    sys.runFrame();
    if (shots && lastPic && sys.frameCount === lastPic.f + 60) shotPng(sys, `${shots}/f${String(sys.frameCount).padStart(5, '0')}.png`);
    // SHOT_FRAMES=f1,f2,...: screenshots at those frames (e.g. to compare the Godot player).
    if (shotFrames.has(sys.frameCount)) shotPng(sys, `${ensureDir(`${scratch}/shots-at`)}/${how}_f${sys.frameCount}.png`);
    if (stop(sys, rec)) break;
  }
  console.log(`  ${sys.frameCount} frames in ${((Date.now() - t0) / 1000).toFixed(0)} s, ${rec.events.length} events`);
  if (rec.problems.length) console.log('  problems:', rec.problems.slice(0, 5));
  return { sys, rec, checker };
}

// ---- event list -> timeline steps -----------------------------------------------------------
const DROP = new Set(['frame', 'open', 'create', 'read', 'write']);
function compact(events, program, base) {
  const steps = [];
  let cur = null;
  const push = (f, op) => {
    if (!cur || cur.f !== f) { cur = { f, do: [] }; steps.push(cur); }
    cur.do.push(op);
  };
  for (const e of events) {
    const { f, prog: _prog, ...op } = e;
    if (e.op === 'read' && e.bytes > 0) {
      // file loads other than the pictures (their loader is recorded as loadPic/loadGrp)
      if (/\.PIC$/i.test(e.file) || /ICITY_|\.X$/i.test(e.file)) continue;
      const dest = parseInt(e.dest, 16);
      const to = dest === 0xe82000 ? 'graphic palette' : dest >= 0xe00000 && dest < 0xe80000 ? `text VRAM $${e.dest}` : `RAM +$${hex(dest - base, 5)}`;
      push(f, { op: 'loadFile', file: e.file, bytes: e.bytes, to });
      continue;
    }
    if (DROP.has(e.op)) continue;
    if (e.op === 'wait' && e.kind === 'counted') continue;   // per-frame throttle of animation loops
    if (e.op === 'program') continue;
    // R21-R23 (text VRAM access masks / raster copy) only matter to the text drawing internals
    if (e.op === 'crtc' && (e.reg === 21 || e.reg === 22 || e.reg === 23)) continue;
    if (e.op === 'crtc' && typeof e.reg === 'number') op.reg = crtcName(e.reg);
    if (e.op === 'zmusic') Object.assign(op, zmusicMeaning(e));
    if ((e.op === 'blit' || e.op === 'wipe') && e.dx >= 0x8000) op.dxSigned = e.dx - 0x10000;
    push(f, op);
  }
  return steps;
}

function crtcName(r) {
  if (r >= 12 && r <= 19) return `R${r} (GP${(r - 12) >> 1} scroll ${(r & 1) ? 'Y' : 'X'})`;
  if (r === 10 || r === 11) return `R${r} (text scroll ${r === 10 ? 'X' : 'Y'})`;
  if (r === 20) return 'R20 (memory mode / resolution)';
  if (r === 21) return 'R21 (text access)';
  return `R${r}`;
}

// ZMUSIC v1 trap #3 functions as these programs use them (d1 = function number).
function zmusicMeaning(e) {
  switch (e.fn) {
    case 0x11: return { meaning: 'play compiled music (ZMD data)', music: e.file ?? null };
    case 0x13: return { meaning: 'play ADPCM sample a1 (d2 = bytes, d3 = rate/pan)', adpcm: e.file ?? null };
    case 0x0a: return { meaning: 'stop / reset music (all tracks)' };
    case 0x1a: return { meaning: `fade music out (speed ${e.d2})` };
    default: return { meaning: 'unknown ZMUSIC function' };
  }
}

function eventsOf(rec, program) {
  // events emitted while `program` was the running program (its own load event included)
  return rec.events.filter((e) => (e.op === 'program' ? e.name === program : e.prog === program));
}

function summary(events) {
  const ops = {};
  for (const e of events) ops[e.op] = (ops[e.op] ?? 0) + 1;
  return ops;
}

function scenesFrom(events, notes, lastFrame) {
  const loads = events.filter((e) => e.op === 'loadPic' || e.op === 'loadGrp');
  const count = new Map();
  return loads.map((e, i) => {
    const name = e.file.replace(/^.*\\/, '');
    const k = (count.get(name) ?? 0) + 1; count.set(name, k);
    const end = (loads[i + 1]?.f ?? lastFrame) - 1;
    const inScene = events.filter((x) => x.f >= e.f && x.f <= end);
    const music = inScene.filter((x) => x.op === 'zmusic').map((x) => x.file ?? `fn $${hex(x.fn, 2)}`);
    return {
      start: e.f, end, picture: e.file, kind: e.op === 'loadGrp' ? 'GRP (text-VRAM buffer)' : 'PIC',
      blits: inScene.filter((x) => x.op === 'blit').length, wipes: inScene.filter((x) => x.op === 'wipe').length,
      ...(music.length ? { music } : {}),
      description: notes[`${name}#${k}`] ?? notes[name] ?? '',
    };
  });
}

// ---- opening ----------------------------------------------------------------------------------
const OPENING_NOTES = {
  'CABIN.PIC': 'Copyright card "…" (CABIN.PIC, palette CABIN.000), contrast fade in and out.',
  'OP_01_1.PIC': 'Logo sequence: the rings of the Microcabin logo, "MICROCABIN" sliding in (page scroll) over the emblem, "PROJECT I PRESENTS", the "ILLUSION CITY" letters sliding apart, a red flash with thunder (THUNDER.PCM), the 香港 / HONG-KONG emblem. Palette animation from OP_01.001-.003 (RAM tables), per-entry palette fades. The theme (テーマB.ZMD) starts at the end.',
  'FIN.PIC': 'Narration 1: gunships flying over a sea of clouds (FIN.PIC sheet: waves and aircraft, layered pages scrolling), palette FIN.000; MSG04 is loaded in the same frame.',
  'MSG04.PIC': 'Narration 1 text (MSG04 GRP): the SIVA report revealed under the gunships two lines at a time with single dissolve passes from the text-VRAM buffer, then faded.',
  'MSG05.PIC': 'Narration 2: MSG05 vertical brush text drawn column by column (one blit per character), twice the same message.',
  'MSG02.PIC#1': 'Narration 3 sheet (vertical brush text) loaded to the buffer; drawn in the next scene.',
  'OP_03_1.PIC': 'Narration 3, first block of MSG02 ("…") on both sides of a red tower picture (OP_03_1) scrolling up.',
  'MSG02.PIC#2': 'MSG02 reloaded for the second block.',
  'OP_04_1.PIC': 'Second block of MSG02 ("…") around a red demon picture (OP_04_1).',
  'OP_05_1.PIC': '"…" (last columns of MSG02) with a red claw picture (OP_05_1).',
  'OP_06_1.PIC': 'Narration 4: red ruined landscape and the "…" text typed column by column (the text is part of OP_06_1.PIC); the theme fades out at the end (ZMUSIC $1A).',
  'OP_07_1.PIC': 'Blue network of city lights, then the brush title 幻影都市 (cyan, then grey); music stops and 10THE_A9.ZMD starts.',
  'OP_STAFF.PIC#1': 'Staff card: 企画・原案 中津泰彦 (red brush, from OP_STAFF.PIC).',
  'OP_09_1.PIC': 'City towers seen from above, a craft passing.',
  'OP_STAFF.PIC#2': 'Staff card: 脚本・イベント絵コンテ 加藤雅史 / キャラクターコンセプトデザイン 百鬼丸.',
  'OP_09_2.PIC': 'Skyscraper at night with a flying craft.',
  'OP_STAFF.PIC#3': 'Staff card: ミュージック 新田忠弘 福田康文 瓜田幸治.',
  'OP_10_1.PIC': 'Tento (天人) and a creature, panels sliding in.',
  'OP_STAFF.PIC#4': 'Staff card: プログラマー 中津泰彦 青木正二郎 三曽田明 山田浩司 伊藤勝己.',
  'OP_10_2.PIC': 'Panels: a demon mask and Tento.',
  'OP_STAFF.PIC#5': 'Staff card: グラフィック 陣内靖弘 古屋賢三 末永仁志 青木文秀 川口洋一郎.',
  'OP_10_4.PIC': 'Tento aiming a gun.',
  'OP_STAFF.PIC#6': 'Staff card: ゲームデザイン＆ディレクション 中津泰彦.',
  'OP_10_5.PIC': 'Tento aiming a gun, washed out (fade).',
  'OP_STAFF.PIC#7': 'Last card: 製作・著作 (株)マイクロキャビン; music fades out and stops; the program exits to MENU68.',
};

const OPENING_NARRATION = [
  { image: 'IGRP\\MSG04.PIC', format: 'GRP (headerless run-length, 1024 wide; game uses the first 160 lines); palette IGRP\\FIN.000', layout: 'horizontal, 6 lines, katakana-kanbun style',
    text: null },
  { image: 'IGRP\\MSG05.PIC', format: 'PIC 768x512', layout: 'vertical, right to left',
    text: null },
  { image: 'IGRP\\MSG02.PIC', format: 'PIC 768x512', layout: 'vertical, right to left, two blocks (top block shown first, bottom block in the second MSG02 scene)',
    text: null },
  { image: 'IGRP\\OP_06_1.PIC', format: 'PIC 768x512 (text area x 0-510, y 200-375 of the sheet, below the landscape)', layout: 'vertical, right to left, 14 columns of 8 characters, typed one character at a time',
    text: null },
  { image: 'IGRP\\OP_07_1.PIC', format: 'PIC 768x512', layout: 'brush title', text: null },
  { image: 'IGRP\\OP_STAFF.PIC', format: 'PIC 768x512', layout: 'staff cards, vertical red brush text', text: null },
];

function buildOpening() {
  console.log('opening: MENU68 -> オープニングから -> IL_OPEN');
  const shots = wantShots ? ensureDir(`${scratch}/shots-opening`) : null;
  let seen = false, ended = 0;
  const { sys, rec, checker } = run({
    how: 'menu', input: menuInput(1), programs: ['MENU68.X', 'IL_OPEN.X'], check: ['IL_OPEN.X'], max: 30000, shots,
    // stop a little after IL_OPEN has returned to MENU68
    stop: (s) => {
      if (s.programName() === 'IL_OPEN.X') seen = true;
      else if (seen && !ended) ended = s.frameCount;
      return ended && s.frameCount > ended + 300;
    },
  });
  const base = rec.bases.get('IL_OPEN.X');
  const ev = eventsOf(rec, 'IL_OPEN.X');
  const start = ev[0].f, last = ev[ev.length - 1].f;
  const steps = compact(ev, 'IL_OPEN.X', base);
  const menuAfter = rec.events.filter((e) => e.f >= last && e.prog === 'MENU68.X' && !DROP.has(e.op) && e.op !== 'program' && e.op !== 'gpal' && e.op !== 'tpal').map(({ f, prog, ...o }) => ({ f, prog, ...o }));
  const doc = {
    program: 'IL_OPEN.X',
    title: 'Opening',
    origin: 'disk 1 A:\\IL_OPEN.X, started by MENU68.X (title menu entry 2, オープニングから) with exec("il_open.x"); returns to MENU68, which continues as "from start point" (new game).',
    recorded: { emulatorFrames: [start, last], base: hex(base, 6), frameRate: frameRate(sys), input: 'none during the opening (MENU68 choices: mouse, FM, opening)', clock: 'fixed (deterministic run)' },
    skip: 'No skip key. Every wait (vsync wait $A0606 and the counted wait $A05C6) is skipped while a key of IOCS BITSNS group $0E is held (SHIFT, CTRL, OPT.1, OPT.2), which fast-forwards the sequence.',
    display: {
      mode: '512x512, 31 kHz, graphic memory mode 0 (four 16-colour 512x512 pages), set by CRTC writes at the start (see first steps); IL_OPEN draws every picture line twice (line doubling), so PIC coordinates are 768x256-style art shown 2x vertically.',
      layers: 'VC R2 low byte = page enable bits (bit p = page p), written by the program ($A0711 -> $E82601); see vc steps.',
      contrast: 'IOCS CONTRAST levels 0-15 (screen brightness) are used for fade in/out; see contrast steps.',
    },
    resources: resourceList(ev),
    narration: { note: 'The opening narration is not text: it is drawn from images. Transcriptions below are read from the exported PNGs (not from game data).', images: OPENING_NARRATION },
    scenes: scenesFrom(ev, OPENING_NOTES, last),
    validation: { ...checker.report(), method: 'Each step list was replayed into a model of graphic VRAM (tools/export/cutscenes/replay.mjs) in lockstep with the emulator; after every frame in which no drawing routine was still running, the model equalled the emulator\'s VRAM word for word. Picture buffers were compared with tools/export/pic.mjs output right after each load.' },
    counts: summary(ev),
    stepsFormat: 'see docs/cutscenes.md',
    steps,
    afterwards: menuAfter.slice(0, 40),
  };
  writeJson(`${outDir}/opening.json`, doc);
  console.log(`  -> ${outDir}/opening.json (${steps.length} frames with steps)`, JSON.stringify(checker.report()).slice(0, 200));
  return { rec };
}

function resourceList(ev) {
  const pics = new Map(), files = new Map(), music = new Map();
  for (const e of ev) {
    if (e.op === 'loadPic' || e.op === 'loadGrp') {
      const name = e.file;
      const dir = /IGRP2/i.test(name) ? 'IGRP2' : 'IGRP';
      const stem = name.replace(/^.*\\/, '').replace(/\.PIC$/i, '');
      const p = pics.get(name) ?? { file: name, format: e.op === 'loadGrp' ? 'grp' : 'pic', png: `export/pic/${dir}/${stem}.png`, loads: [] };
      p.loads.push(e.f); pics.set(name, p);
    }
    if (e.op === 'read' && e.bytes > 0 && !/\.PIC$|ICITY_|\.X$/i.test(e.file)) {
      const f = files.get(e.file) ?? { file: e.file, bytes: e.bytes, dest: [] };
      if (!f.dest.includes(e.dest)) f.dest.push(e.dest);
      files.set(e.file, f);
    }
    if (e.op === 'zmusic') { const k = `${e.fn}:${e.file ?? ''}`; if (!music.has(k)) music.set(k, { fn: e.fn, file: e.file ?? null, first: e.f, ...zmusicMeaning(e) }); }
  }
  return { pictures: [...pics.values()], files: [...files.values()], music: [...music.values()] };
}

// ---- ending -------------------------------------------------------------------------------------
function loadMessages() {
  const p = `${root}/work/text/messages.json`;
  if (!fs.existsSync(p)) return new Map();
  const t = JSON.parse(fs.readFileSync(p, 'utf8'));
  return new Map(t.messages.map((m) => [m.id, m]));
}

function buildEnding() {
  console.log('ending: ZMUSIC, IL_END.X (disk 7) standalone');
  const shots = wantShots ? ensureDir(`${scratch}/shots-ending`) : null;
  // IL_END exits by itself (DOS _EXIT after the last picture); the machine then has no command left.
  const { sys, rec, checker } = run({ how: 'ending', programs: ['IL_END.X'], check: ['IL_END.X'], max: 40000, shots, stop: () => false });
  const base = rec.bases.get('IL_END.X');
  const ev = eventsOf(rec, 'IL_END.X');
  const last = ev[ev.length - 1].f;
  const steps = compact(ev, 'IL_END.X', base);
  const table = loadMessages();
  // narration scripts -> message ids
  const narration = [];
  const speakers = [], credits = [];
  let speaker = null;
  for (const st of steps) for (const op of st.do) {
    // B_PUTMES at column 0 of row 23/24 = speaker label; elsewhere (non-blank) = staff roll line
    if (op.op === 'text' && op.name === 'B_PUTMES' && op.text.replace(/[\s\u3000]/g, '')) {
      if (op.x === 0 && (op.y === 23 || op.y === 24)) { speaker = op.text.replace(/^[\s\u3000]+/, ''); speakers.push({ f: st.f, name: speaker }); }
      else credits.push({ f: st.f, x: op.x, y: op.y, color: op.color, text: op.text.replace(/[\s\u3000]+$/, '') });
    }
    if (op.op !== 'narration') continue;
    const id = messageId(op.bytes);
    const row = table.get(id);
    op.id = id;
    op.text = endingToText(op.bytes);
    op.inMessagesJson = !!row;
    delete op.bytes;
    const sp = speakers.length && speakers[speakers.length - 1].f >= st.f - 2 ? speakers[speakers.length - 1].name : null;
    narration.push({ f: st.f, id, speaker: sp, inMessagesJson: !!row, japanese: op.text, english: row?.english || null });
  }
  void speaker;
  const doc = {
    program: 'IL_END.X',
    title: 'Ending',
    origin: 'disk 7 B:\\IL_END.X, run by LOAD.X after ICITY68.X exits (the game ends by exiting ICITY68). Recorded standalone: ZMUSIC, then IL_END.X from drive B: with disk 7.',
    recorded: { emulatorFrames: [ev[0].f, last], base: hex(base, 6), frameRate: frameRate(sys), clock: 'fixed (deterministic run)' },
    skip: 'No skip key. Every delay ($49254, n = count >> 12 vsyncs) is skipped while a key of IOCS BITSNS group $0E is held (SHIFT, CTRL, OPT.1, OPT.2).',
    display: {
      mode: '512x512 31 kHz, graphic memory mode 0 (4 pages of 16 colours) with line-doubled blits like the opening; the narration is printed on the text layer (IOCS B_LOCATE / B_PRINT two bytes at a time, from column 13, rows 24-26).',
    },
    resources: resourceList(ev),
    narration: { note: 'Each entry is one script of the narration engine ($466BE); ids are those of ../work/text/messages.json (IL_END.X rows). The engine prints a pair of bytes per step: \\p \\u short pauses, \\t long pause, \\w wait, \\c clear the 3 text rows, \\r new line, \\1 flash (blits from the scene\'s flash table), \\e end of script.', scripts: narration },
    staffRoll: { note: 'B_PUTMES lines printed into text VRAM (row = y, 0-63, wrapping) while CRTC R11 (text scroll Y) advances one line per step; the roll runs in 768x512 mode (CRTMOD $110).', lines: credits },
    scenes: scenesFrom(ev, ENDING_NOTES, last),
    validation: { ...checker.report(), method: 'as for the opening (lockstep replay of the steps into a VRAM model).' },
    counts: summary(ev),
    stepsFormat: 'see docs/cutscenes.md',
    steps,
  };
  writeJson(`${outDir}/ending.json`, doc);
  console.log(`  -> ${outDir}/ending.json (${steps.length} frames with steps, ${narration.length} narration scripts, ${narration.filter((n) => n.inMessagesJson).length} in messages.json)`, JSON.stringify(checker.report()).slice(0, 200));
}

const ENDING_NOTES = {
  'ED_01A.PIC': 'A patrol craft flies over the ruins (lavender sky, broken wall); radio narration of patrol 305 (no speaker label). Music 31WIN_.ZMD from the start.',
  'ED_03.PIC': 'Miku (美紅) and Homei (ホーメイ) in the ruins; the craft; Miku gives orders, Homei asks about Tento.',
  'ED_04.PIC': 'Flamenco (フラメンコ) and Airen (アイレン) among the rubble.',
  'ED_06.PIC': 'Fade in from white: every palette entry fades from $FFFF to ED_06.000 (read into text VRAM $E50000 by $48920 and used as the fade target); a wide panorama assembled from blits on all four pages.',
  'ED_07.PIC': 'Doc (ドク), Aya (アーヤ) and Neotikas (ネオティカス).',
  'ED_2C.PIC#1': 'Close-up of the patrol craft.',
  'ED_08.PIC': 'Lee (リー), Elfas (エルファス) and McGregor (マクレガー): three portraits slid in from the side.',
  'ED_02D.PIC': '"From the notes of R. Mortimer": text on black, then the craft over the city; the music fades and テーマB.ZMD starts.',
  'ED_11.PIC': 'The craft over the desert outside the barrier: "Lady Lee, ten o\'clock, a heat source - human."',
  'ED_12.PIC': 'Tento (天人) close-up.',
  'ED_2C.PIC#2': 'The craft again.',
  'ED_13.PIC': 'Tento in his trench coat: "Hey, got a cigarette?"',
  'ED_16.PIC': 'Miku and Tento; the music fades and ENDING.ZMD starts.',
  'ED_END.PIC#1': 'Brush title 幻影都市 and the staff roll (text layer, 768x512, scrolling).',
  'ED_21.PIC': 'Epilogue picture.',
  'ED_22.PIC': 'Tento shouting "Choose! Death or shame?"',
  'ED_END.PIC#2': 'Final title card, then the program exits.',
};

// ---- title (MENU68) -----------------------------------------------------------------------------
function buildTitle() {
  console.log('title: MENU68 -> スタート地点から -> ICITY68');
  const { rec } = run({
    how: 'menu', input: menuInput(2), programs: ['MENU68.X'], max: 4000,
    stop: (s) => s.programName() === 'ICITY68.X',
  });
  const base = rec.bases.get('MENU68.X');
  const ev = eventsOf(rec, 'MENU68.X');
  const steps = compact(ev, 'MENU68.X', base);
  const para = ev.filter((e) => e.op === 'writeFile');
  const doc = {
    program: 'MENU68.X',
    title: 'Title / start menu',
    origin: 'disk 1 A:\\MENU68.X, the first program LOAD.X runs (LOAD.X: exec MENU68.X, then ICITY68.X, then IL_END.X, then loops forever).',
    recorded: { base: hex(base, 6), input: 'cursor down + Return (mouse), Return (FM), down x2 + Return (スタート地点から)', clock: 'fixed' },
    screen: 'CRTMOD 16 (768x512, 16 colours), black. Each menu is a framed window: the frame is drawn into graphic page 0 by CPU from WIN.DAT (720 bytes, loaded at start), items are printed on the text layer; windowRect = the page-0 area MENU68 erases with IOCS FILL after the choice (x1, y1, x2, y2 in 768x512 pixels). The highlighted item has a box cursor.',
    screens: TITLE_SCREENS,
    paraDat: {
      file: 'A:\\PARA.DAT (10 bytes, five big-endian words), written by MENU68 ($66628) just before it exits; read by ICITY68.',
      words: ['drive mode ($760E0: 0 = two drives; the 1-drive menu is not offered, so always 0)', 'sound device ($760E6: 0 FM, 1 MIDI IF board, 2 MIDI RS-232C)', 'start mode ($760EA: 0 from save, 1 opening (rewritten to 2 after IL_OPEN returns), 2 from start point, 4 user disk)', 'unknown ($780EC)', 'controller ($760E8: 0 joystick, 1 mouse)'],
      recorded: para.map((p) => ({ f: p.f, data: p.data })),
    },
    counts: summary(ev),
    steps,
  };
  writeJson(`${outDir}/title.json`, doc);
  console.log(`  -> ${outDir}/title.json (${steps.length} frames with steps)`);
}

const TITLE_SCREENS = [
  { name: 'controller', variable: '$760E8', items: ['ジョイスティック (Joystick)', 'マウス (Mouse)'], window: 'table $6E470', windowRect: [280, 192, 488, 256], note: 'first screen, black background, one framed text window (frame graphics from WIN.DAT)' },
  { name: 'sound', variable: '$760E6', items: ['ＦＭ音源 (FM)', 'ＭＩＤＩ音源（IFﾎﾞｰﾄﾞ） (MIDI, interface board)', 'ＭＩＤＩ音源（RS-232C） (MIDI, RS-232C)'], window: 'table $6E438', windowRect: [264, 192, 504, 272], note: 'a MIDI entry is accepted only if its bit (1/2) is set in $75A6A, which main() sets to 6 (both allowed); cancel goes back to the controller menu' },
  { name: 'start', variable: '$760EA', items: ['セーブした時点から (continue from save)', 'オープニングから (watch the opening)', 'スタート地点から (new game from the start point)', 'ユーザーディスクの作成 (create a user disk)', 'ユーザーディスクからの起動 (start from a user disk)'], window: 'table $6E450', windowRect: [248, 192, 520, 304], note: 'cancel goes back to the controller menu; 3 (user disk creation) needs two drives and runs $663E6 (format B:, copy system files, initialise ISV?.DAT) then shows this menu again' },
];

// ---- listings --------------------------------------------------------------------------------
async function listings() {
  const { Image, analyze } = await import('../../src/recomp/analyze.js');
  const { fmt } = await import('../../src/recomp/decode.js');
  const plans = [
    { name: 'MENU68.X', how: 'menu', input: menuInput(1), frame: 200, code: 0x8760 },
    { name: 'IL_OPEN.X', how: 'menu', input: menuInput(1), frame: 2800, code: 0x5d70 },
    { name: 'IL_END.X', how: 'ending', input: [], frame: 60, code: 0x6800 },
  ];
  for (const p of plans) {
    const sys = makeMachine();
    boot(sys, p.how);
    for (let f = 0; f < p.frame; f++) { applyInput(sys, p.input, f); sys.runFrame(); }
    const base = sys.human.curPSP + 0x100;
    const img = new Image(sys.m.ram.slice(base, base + 0x20000), base);
    const an = analyze(img, { codeEnd: base + p.code, entries: [base], scanPointers: false });
    const lst = [];
    for (const f of [...an.funcs.values()].sort((a, b) => a.entry - b.entry)) {
      lst.push('', `; ==== f_${f.entry.toString(16)} (+${hex(f.entry - base, 5)})`);
      for (const a of [...f.insnAddrs].sort((x, y) => x - y)) lst.push(`${a.toString(16).padStart(6, '0')}  ${fmt(an.insns.get(a))}`);
    }
    ensureDir(scratch);
    fs.writeFileSync(`${scratch}/${p.name.replace('.X', '')}.lst`, lst.join('\n'));
    console.log(`${p.name}: base $${hex(base, 6)} -> ${scratch}/${p.name.replace('.X', '')}.lst`);
  }
}

if (args.includes('--listing')) await listings();
if (!args.includes('--listing') || which.length) {
  for (const t of todo) {
    if (t === 'opening') buildOpening();
    else if (t === 'ending') buildEnding();
    else if (t === 'title') buildTitle();
  }
}
