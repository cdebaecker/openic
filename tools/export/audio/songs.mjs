// ICITY68 music number (resource type 7) -> file, as returned by the game's path routine
// $6A79C(7, n), and the MIDI tone file MTABLE.COM assigns to it (tools/export/audio/musictable.mjs).
// In FM mode (PARA.DAT word 1 = 0, the default) f_69B44 loads GROUP00\0000nn.DAT; in MIDI mode
// it loads GROUPMD\0000nn.DAT instead. Numbers 12, 19, 36 have no file; 30 and 31 point at
// files that are not music (GROUP01\000060.DAT does not exist, GROUP00\000045.DAT is map data).
export const MUSIC_TABLE = {
  1: [18, 'FLH'], 2: [19, 'FLH'], 3: [20, 'CAPAN'], 4: [21, 'AWAW'], 5: [22, 'AWAW'], 6: [23, 'FLH'],
  7: [24, 'OTO_IC'], 8: [25, 'FLH'], 9: [26, 'OTO_IC'], 10: [27, 'FLH'], 11: [28, 'OTO_IC'],
  13: [29, 'AWAW'], 14: [30, 'CAPAN'], 15: [31, 'OTO_IC'], 16: [32, 'OTO_IC'], 17: [33, 'KIKI'],
  18: [34, 'KIKI'], 20: [35, 'KIKI'], 21: [36, 'AWAW'], 22: [37, 'OTO_IC'], 23: [38, 'OTO_IC'],
  24: [39, 'KIKI'], 25: [40, 'KIKI'], 26: [41, 'KIKI'], 27: [42, 'OTO_IC'], 28: [43, 'FLH'],
  29: [44, 'CAPAN'], 32: [46, 'OTO_IC'], 33: [47, 'KIKI'], 34: [61, 'OTO_IC'], 35: [62, 'OTO_IC'],
};
