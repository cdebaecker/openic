// Event pictures (portraits / scenes shown by builtin 20 and the cutscene command G): the GEP files
// (ICITY.FIL table 11 = GROUP00/000048-55.DAT, developer names IVENT_G*.GEP) and their palettes
// (EVTGRH.PLD). docs/systems-ui.md §8.
//
// Picture n (0-based; builtin 20 passes n + 1, G passes n): file table-11 entry n/3 + 1, image n mod 3,
// palette n. f_798e8 → f_69da4 loads the file and unpacks it with ICITY68's LZSS (f_6aa40, the same
// as WAKU*.DAT) into $9DD5A + $5000; f_87aba draws image n mod 3 into the four text planes.
//
// Unpacked file (19 222 bytes):
//   +0   "G.BLC04" + 9 zero bytes (the packed file starts with $7F, eaten by the LZSS flag byte)
//   +16  u16 LE 15, u16 LE 480 (width of the strip in pixels), u16 LE 80 (lines)
//   +22  4 planes (B, R, G, I = text planes 0..3) of 80 lines x 60 bytes: three 160-pixel images side
//        by side (image k = bytes 20k .. 20k+19 of each line); 4 800 bytes per plane.
// Drawn (f_87b34) at text-VRAM offset $5840 + $80: lines doubled, so each picture covers screen
// (512, 176)-(671, 335): 160 x 160, the right part of the picture window $9C118 (4, 8, 72, 10).
// Palette n (16 words 0x0GRB, little-endian; 24 palettes) becomes the text palette (f_782d4(0, pal) ->
// f_87bcc: X68000 word = G<<12 | R<<7 | B<<2 | 1).
//
// Usage: node tools/export/gep.mjs -> ../work/export/gep/pic<NN>.idx.png (160x80 as stored: red =
//        palette index, alpha 255; lines are doubled on screen), pic<NN>.png (160x160 RGB, as shown),
//        index.json (files, palettes as X68000 words and RGB)
import { readFile, writePng, writeJson, exportDir, x68kColor } from './common.mjs';
import { lzss } from './lzss.mjs';
import { isMain } from '../root.mjs';

export const GEP_FILES = [48, 49, 50, 51, 52, 53, 54, 55].map((n) => `GROUP00/0000${n}.DAT`);
export const PICTURE_COUNT = 24;
export const UNPACKED_SIZE = 22 + 4 * 4800;
export const SCREEN = { x: 512, y: 176, w: 160, h: 160, textOffset: 0x5840 };

export function unpackGep(data) {
  const { data: out } = lzss(data, UNPACKED_SIZE, 0);
  const magic = String.fromCharCode(...out.subarray(0, 7));
  if (magic !== 'G.BLC04') throw new Error(`not a GEP file (${magic})`);
  const u16 = (a) => out[a] | (out[a + 1] << 8);
  return { out, header: [u16(16), u16(18), u16(20)] };
}

// 160x80 palette indices of image k (0-2) of an unpacked GEP file
export function gepImage(out, k) {
  const idx = new Uint8Array(160 * 80);
  for (let p = 0; p < 4; p++) for (let y = 0; y < 80; y++) for (let xb = 0; xb < 20; xb++) {
    const b = out[22 + p * 4800 + y * 60 + 20 * k + xb];
    for (let bit = 0; bit < 8; bit++) if (b & (0x80 >> bit)) idx[y * 160 + xb * 8 + bit] |= 1 << p;
  }
  return idx;
}

// EVTGRH.PLD palette word (0x0GRB) -> X68000 palette word, as f_87bcc
export const pldToX68k = (w) => 1 | ((w & 0xf) << 2) | ((w & 0xf0) << 3) | ((w & 0xf00) << 4);
export function pldPalettes(data = readFile('EVTGRH.PLD')) {
  const pals = [];
  for (let p = 0; p + 32 <= data.length; p += 32) { const c = []; for (let i = 0; i < 16; i++) c.push(data[p + 2 * i] | (data[p + 2 * i + 1] << 8)); pals.push(c); }
  return pals;
}

export function picture(n) {
  const { out } = unpackGep(readFile(GEP_FILES[Math.floor(n / 3)]));
  return { idx: gepImage(out, n % 3), palette: pldPalettes()[n].map(pldToX68k) };
}

if (isMain(import.meta.url)) {
  const pals = pldPalettes();
  const index = { source: 'ICITY.FIL table 11 (GROUP00/000048-55.DAT, IVENT_G*.GEP) + EVTGRH.PLD', screen: SCREEN, pictures: [] };
  for (let f = 0; f < GEP_FILES.length; f++) {
    const { out, header } = unpackGep(readFile(GEP_FILES[f]));
    for (let k = 0; k < 3; k++) {
      const n = 3 * f + k, idx = gepImage(out, k);
      const pal = pals[n].map(pldToX68k), rgbPal = pal.map(x68kColor);
      const a = new Uint8Array(160 * 80 * 4), b = new Uint8Array(160 * 160 * 4);
      for (let i = 0; i < 160 * 80; i++) {
        a[i * 4] = idx[i]; a[i * 4 + 3] = 255;
        const [r, g, bl] = rgbPal[idx[i]], y = Math.floor(i / 160), x = i % 160;
        for (const yy of [2 * y, 2 * y + 1]) { const o = (yy * 160 + x) * 4; b[o] = r; b[o + 1] = g; b[o + 2] = bl; b[o + 3] = 255; }
      }
      const name = `pic${String(n).padStart(2, '0')}`;
      writePng(`${exportDir}/gep/${name}.idx.png`, a, 160, 80);
      writePng(`${exportDir}/gep/${name}.png`, b, 160, 160);
      index.pictures.push({ n, builtin20: n + 1, file: GEP_FILES[f], image: k, header, idx: `${name}.idx.png`, png: `${name}.png`,
        palette: pal.map((w) => w.toString(16).padStart(4, '0')), paletteGrb: pals[n].map((w) => w.toString(16).padStart(3, '0')) });
    }
  }
  writeJson(`${exportDir}/gep/index.json`, index);
  console.log(`gep -> ${exportDir}/gep (${index.pictures.length} pictures)`);
}
