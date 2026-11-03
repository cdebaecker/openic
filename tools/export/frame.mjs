// The in-game screen frame (the panel around the map window), as ICITY68 draws it into the four
// text planes ($E00000/$E20000/$E40000/$E60000, 1024x1024, 128 bytes per line) — f_6a486:
//   1. outer border, WAKU_OU{B,R,G,I}.DAT (unpacked with f_660ec, tools/export/audio/unpack.mjs),
//      drawn by f_8808c: 768 px (48 words) per line, 48 single lines, then 200 lines each written
//      twice, then 64 single lines (312 stored lines; zero words are skipped = left at 0);
//   2. inner frame, WAKUF_* (field) or WAKUB_* (battle), LZSS (f_6aa40), drawn by f_8800e:
//      640 x 200, each line written twice, at (64, 48).
// Plane k is bit k of the colour (B, R, G, I = text planes 0..3); colours come from the text
// palette in effect (the map's).
//
// Usage: node tools/export/frame.mjs   -> ../work/export/frame/{field,battle}.idx.png + .json
import { readFile, writePng, writeJson, exportDir } from './common.mjs';
import { lzss } from './lzss.mjs';
import { unpackMusic } from './audio/unpack.mjs';
import { isMain } from '../root.mjs';

export const W = 768, H = 512;
const PLANES = ['B', 'R', 'G', 'I'];

// 768x512 palette indices of the frame (inner = 'F' field or 'B' battle).
export function composeFrame(inner = 'F') {
  const out = new Uint8Array(W * H);
  PLANES.forEach((p, k) => {
    const plane = new Uint8Array(W * H);   // 1 bit per pixel, as bytes
    const put = (y, x, word) => { for (let b = 0; b < 16; b++) plane[y * W + x + b] = (word >> (15 - b)) & 1; };
    const ou = unpackMusic(readFile(`WAKU_OU${p}.DAT`));
    let i = 0;
    const row = (ys) => { for (let x = 0; x < W; x += 16, i += 2) { const w = (ou[i] << 8) | ou[i + 1]; if (w) for (const y of ys) put(y, x, w); } };
    for (let y = 0; y < 48; y++) row([y]);
    for (let r = 0; r < 200; r++) row([48 + 2 * r, 49 + 2 * r]);
    for (let y = 448; y < 512; y++) row([y]);
    const d = readFile(`WAKU${inner}_${p}.DAT`);
    const px = lzss(d, 16000, 0).data;
    for (let r = 0, j = 0; r < 200; r++) for (let x = 0; x < 640; x += 16, j += 2) {
      const w = (px[j] << 8) | px[j + 1];
      put(48 + 2 * r, 64 + x, w); put(49 + 2 * r, 64 + x, w);
    }
    for (let n = 0; n < W * H; n++) out[n] |= plane[n] << k;
  });
  return out;
}

// Window frame tiles (WIN.DAT, loaded at $9DD62): 9 cells of 80 bytes like CG9 cells (16-byte mask,
// then 4 planes of 8 rows x 16 px), drawn with lines doubled as 16x16 text tiles; row-major 3x3
// (corners, edges, centre). Returns a 144x16 sheet: red = colour index, alpha = mask.
export function windowTiles() {
  const d = readFile('WIN.DAT');
  const out = new Uint8Array(144 * 16 * 4);
  for (let c = 0; c < 9; c++) for (let y = 0; y < 8; y++) {
    const w = (pl) => (d[c * 80 + pl * 16 + y * 2] << 8) | d[c * 80 + pl * 16 + y * 2 + 1];
    for (let x = 0; x < 16; x++) {
      const bit = 15 - x;
      let v = 0; for (let k = 0; k < 4; k++) v |= ((w(k + 1) >> bit) & 1) << k;
      const m = (w(0) >> bit) & 1;
      for (const yy of [2 * y, 2 * y + 1]) { const o = (yy * 144 + c * 16 + x) * 4; out[o] = v; out[o + 3] = m ? 255 : 0; }
    }
  }
  return out;
}

if (isMain(import.meta.url)) {
  for (const [name, inner] of [['field', 'F'], ['battle', 'B']]) {
    const idx = composeFrame(inner);
    const rgba = new Uint8Array(W * H * 4);
    for (let n = 0; n < W * H; n++) { rgba[n * 4] = idx[n]; rgba[n * 4 + 3] = 255; }
    writePng(`${exportDir}/frame/${name}.idx.png`, rgba, W, H);
    writeJson(`${exportDir}/frame/${name}.json`, {
      source: `WAKU_OU{B,R,G,I}.DAT + WAKU${inner}_{B,R,G,I}.DAT`, width: W, height: H,
      note: 'palette indices (red channel) for the text palette; map window at (176,80) 384x256',
    });
  }
  writePng(`${exportDir}/frame/window.idx.png`, windowTiles(), 144, 16);
  console.log(`frame -> ${exportDir}/frame`);
}
