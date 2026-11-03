// The interface tiles of the game screen: ASDF.CHR, the 16x16 text-VRAM tile set ICITY68 uses for
// everything on the screen frame that changes (docs/systems-ui.md §2):
//   * the party panel: the name of each character (5 tiles, 80x16, per character id 0-7) and the
//     LV/HP/MP digits (blue 0-9 when the value is 0, yellow 0-9 otherwise);
//   * the lamps left of the six command buttons (lit / unlit, two variants for even/odd buttons);
//   * the MOUSE/KEY indicator, the VR switch and the cross pad (pressed / released arrows);
//   * the selection pointer of the battle panel (f_81d00).
//
// File: "CHR\0" header (16 bytes; byte 4 = 90 = tile count), then 90 cells of 80 bytes like CG9
// cells: a 16-byte mask (unused: f_86a2e draws opaque) and 4 planes of 8 rows x 16 px; every row is
// drawn twice (16x16 on screen). Loaded by f_677c4 to the buffer at $A0702 (+16 skips the header).
// Drawn by f_827ec(textOffset, tile, count) into both text pages (f_869ea -> f_86a2e).
//
// Usage: node tools/export/ui.mjs  -> ../work/export/ui/asdf.idx.png (1440x16 sheet: tile k at x=16k,
//        red = colour index, alpha = mask), asdf.preview.png (with the A00 text palette), ui.json
import { readFile, writePng, writeJson, exportDir, x68kColor } from './common.mjs';
import { isMain } from '../root.mjs';

export const TILE_COUNT = 90;

// What each tile is (ICITY68 constants; see docs/systems-ui.md)
export const ASDF = {
  name: (charId) => charId * 5,           // f_6dff8: 5 tiles per character id 0..7 (tiles 0-39)
  blank: 0,                               // f_6e232: a space in a number draws tile 0 (the first, empty, tile of 天人's name)
  digitZero: 40,                          // tiles 40-49: digits drawn when the value is 0 (blue)
  digit: 50,                              // tiles 50-59: digits of a non-zero value (yellow)
  mouseMode: 60,                          // 60-62: "MOUSE" indicator (3 tiles, f_66a86, $9CB3A = 1)
  lampOn: 63,                             // 63 + (button & 1): lit lamp of command button (f_823be)
  keyMode: 65,                            // 65-67: keyboard indicator (3 tiles, $9CB3A = 0)
  lampOff: 68,                            // 68 + (button & 1): unlit lamp
  vrOnTop: 70, vrOffTop: 72,              // 2 tiles at text (384, 400): VR switch on ($9CB38) / off
  pointer: 74,                            // battle panel selection pointer (f_81d00), 79 = no pointer
  vrOnBottom: 75, vrOffBottom: 77,        // 2 tiles at (384, 416)
  pointerOff: 79,
  padPressed: { up: 80, left: 81, down: 82, right: 83 },   // f_66a86: $50.. when the direction is held
  padReleased: { up: 85, left: 86, down: 87, right: 88 },  // $55..$58
};

// tile k as rows of 16 [index, mask] pairs (16 rows: the 8 stored rows doubled)
export function asdfTiles(data = readFile('ASDF.CHR')) {
  const tiles = [];
  for (let k = 0; k < TILE_COUNT; k++) {
    const base = 16 + 80 * k, px = [], mask = [];
    for (let y = 0; y < 8; y++) {
      const w = (pl) => (data[base + pl * 16 + y * 2] << 8) | data[base + pl * 16 + y * 2 + 1];
      const row = [], mrow = [];
      for (let x = 0; x < 16; x++) {
        const bit = 15 - x;
        let v = 0; for (let p = 0; p < 4; p++) v |= ((w(p + 1) >> bit) & 1) << p;
        row.push(v); mrow.push((w(0) >> bit) & 1);
      }
      px.push(row, row); mask.push(mrow, mrow);
    }
    tiles.push({ px, mask });
  }
  return tiles;
}

// the four text-plane words (B,R,G,I order = planes 0..3) of row y of tile k, as f_86a2e writes them
export function asdfPlaneWords(data, k, y) {
  const base = 16 + 80 * k + 16 + (y >> 1) * 2;
  return [0, 1, 2, 3].map((p) => (data[base + p * 16] << 8) | data[base + p * 16 + 1]);
}

// A00's text palette (the map palette at free control), only for the preview
const PREVIEW_PAL = [0x529d, 0x0001, 0x5295, 0xb5a5, 0x328d, 0x939d, 0x358d, 0x94ad, 0x739d, 0x538d, 0x758d, 0xb781, 0x71ad, 0xb3bd, 0xd7a5, 0xf7bd];

if (isMain(import.meta.url)) {
  const data = readFile('ASDF.CHR');
  const tiles = asdfTiles(data);
  const W = 16 * TILE_COUNT, idx = new Uint8Array(W * 16 * 4), rgb = new Uint8Array(W * 16 * 4);
  tiles.forEach((t, k) => {
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const o = (y * W + 16 * k + x) * 4, v = t.px[y][x];
      idx[o] = v; idx[o + 3] = t.mask[y][x] ? 255 : 0;
      const [r, g, b] = x68kColor(PREVIEW_PAL[v]); rgb[o] = r; rgb[o + 1] = g; rgb[o + 2] = b; rgb[o + 3] = 255;
    }
  });
  writePng(`${exportDir}/ui/asdf.idx.png`, idx, W, 16);
  writePng(`${exportDir}/ui/asdf.preview.png`, rgb, W, 16);
  writeJson(`${exportDir}/ui/ui.json`, {
    source: 'ASDF.CHR', tiles: TILE_COUNT, tileSize: [16, 16], sheet: 'asdf.idx.png (tile k at x = 16k; red = text palette index, alpha = mask, unused by the game: drawn opaque)',
    roles: ASDF,
    note: 'drawn into text VRAM with the text palette in effect (the map palette); see docs/systems-ui.md',
  });
  console.log(`ui -> ${exportDir}/ui`);
}
