// Decompressor used by ICITY68 for music files (f_660EC): GROUPxx\0000NN.DAT music data.
// Header: u16 LE unpacked size, 2 unused bytes, u8 n, n distance bytes. Stream of codes:
//   c < n     : copy ((next-1)&255)+1 bytes from (out - (dist[c]+1))
//   c == 0xFF : ((next-1)&255)+1 literal bytes follow
//   otherwise : c-n+1 literal bytes follow
export function unpackMusic(src) {
  const size = src[0] | (src[1] << 8);
  const n = src[4];
  const dist = src.subarray(5, 5 + n);
  const out = new Uint8Array(size);
  let i = 5 + n, o = 0;
  while (o < size && i < src.length) {
    const c = src[i++];
    let cnt;
    if (c < n) {
      cnt = ((src[i++] - 1) & 0xff) + 1;
      let p = o - (dist[c] + 1);
      for (let k = 0; k < cnt && o < size; k++) out[o++] = out[p++];
    } else {
      cnt = c === 0xff ? ((src[i++] - 1) & 0xff) + 1 : c - n + 1;
      for (let k = 0; k < cnt && o < size; k++) out[o++] = src[i++];
    }
  }
  return out;
}
