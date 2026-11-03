// LZSS as decoded by ICITY68 (f_6aa40): flag byte LSB first (1 = literal),
// references are a little-endian word: position = low 12 bits, length = top 4 bits + 3.
// The 4 KB ring starts zeroed with the write position at $FEE.
export function lzss(src, outSize, start = 0) {
  const out = new Uint8Array(outSize);
  const ring = new Uint8Array(4096);
  let r = 0xfee, o = 0, i = start, flags = 0;
  while (i < src.length && o < outSize) {
    flags >>= 1;
    if (!(flags & 0x100)) flags = src[i++] | 0xff00;
    if (flags & 1) {
      if (i >= src.length) break;
      const c = src[i++];
      out[o++] = c; ring[r] = c; r = (r + 1) & 0xfff;
    } else {
      if (i + 1 >= src.length) break;
      const w = src[i] | (src[i + 1] << 8); i += 2;
      let p = w & 0xfff;
      for (let n = (w >> 12) + 3; n > 0 && o < outSize; n--) {
        const c = ring[p]; p = (p + 1) & 0xfff;
        out[o++] = c; ring[r] = c; r = (r + 1) & 0xfff;
      }
    }
  }
  return { data: out, written: o, consumed: i - start };
}
