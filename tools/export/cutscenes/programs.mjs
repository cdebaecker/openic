// What the recorder knows about IL_OPEN.X, IL_END.X and MENU68.X: offsets (from the program's
// load base = PSP + $100) of the routines it hooks, the work variables they read, and the first
// opcode word of every hooked instruction (checked before a hook is trusted: the programs unpack
// themselves, so the code only exists after their first DOS call).
//
// IL_OPEN and IL_END are hand-written assembly built on the same graphics library (see
// docs/cutscenes.md); the offsets below were read from their disassembly (tools/export/
// cutscenes.mjs --listing writes it).

export const PROGRAMS = {
  'IL_OPEN.X': {
    // reference base in a normal boot (MENU68 runs it): $9B9B0
    picBuffer: 0x1e426,           // $B9DD6: 1024 x 512 words, one pixel per word (bss end)
    picName: 0x5046,              // $A09F6: file name given to the PIC loader
    picDone: [0x4360, 0x4e75],    // $9FD10: rts after "bsr picload" -> buffer complete
    grpName: 0x4d35,              // $A06E5: file name buffer of the plain file loader
    grpDone: [0x435a, 0x4e75],    // $9FD0A: rts after the GRP expansion into text VRAM ($E00000)
    blit: [0x47a8, 0x48e7],       // $A0158: DMA blit, every source line on two screen lines
    blitEnd: [0x485a, 0x4cdf],    // $A020A: its exit (events are stamped when the drawing is done)
    wipePass: [0x4874, 0x95ca],   // $A0224: one pass of the 4-pass interleaved "dissolve" blit
    wipePassEnd: [0x491a, 0x3839], // $A02CA: end of a pass
    vars: {                       // blit parameters (bytes / words)
      page: 0x4d5f,               // $A070F
      rect: 0x4d88,               // $A0738: dx, dy, sx, sy, w, h (6 words)
      single: 0x49ac,             // $A035C (long): wipe draws only the pass in d3
      srcText: 0x4d62,            // $A0712 (byte): wipe source = $E00000 (GRP buffer) instead of the PIC buffer
      fadeDuringWipe: 0x49aa,     // $A035A (word): step palette fades after each wipe pass
    },
    waits: { vsync: [0x4c56, 0x48e7], counted: [0x4c16, 0x48e7], count: 0x4d78 }, // $A0606 wait(n) / $A05C6, n at $A0728
    fadeSetup: [0x49b0, 0x48e7],  // $A0360: palette entry fade from -> to (index $A0766, from $A076A, to $A076C)
    fadeVars: { index: 0x4db6, from: 0x4dba, to: 0x4dbc },
  },
  'IL_END.X': {
    // reference base when started after ZMUSIC from a shell: $43BB0
    picBuffer: 0x1ee74,           // $62A24
    picName: 0x5a94,              // $49644
    picDone: [0x4dee, 0x4e75],    // $4899E
    blit: [0x5236, 0x48e7],       // $48DE6
    blitEnd: [0x52e8, 0x4cdf],    // $48E98
    wipePass: [0x5302, 0x95ca],   // $48EB2
    wipePassEnd: [0x53a8, 0x3839], // $48F58
    vars: {
      page: 0x57b1,               // $49361
      rect: 0x57da,               // $4938A
      single: 0x543a,             // $48FEA
      srcText: 0x57b4,            // $49364
      fadeDuringWipe: 0x5438,     // $48FE8
    },
    waits: { delay: [0x56a4, 0x48e7], count: 0x57ca }, // $49254 delay(count>>12 vsyncs), count at $4937A
    fadeSetup: [0x543e, 0x48e7],  // $48FEE (index $493B8 long, from $493BC, to $493BE)
    fadeVars: { index: 0x5808, from: 0x580c, to: 0x580e },    // index is a long in both programs
    // narration engine (see src/text/ending.js): fetch of the next pair, script pointer
    narration: { read: [0x2b34, null], ptr: 0x2e32 },  // $466E4 / $469E2 (as in src/text/ending.js)
  },
  'MENU68.X': {
    // C program (XC library). Reference base $65C70. Arguments are on the stack (C calling).
    menu: [0x0f64, 0x4e56],        // $66BD4 menu(window, items[]) -> index (d0), -1 = cancelled
    print: [0x1e64, 0x4e56],       // $67AD4 print(window, string) (also hooked by src/text/patcher.js)
    requireDisk: [0x0d4a, 0x4e56], // $669BA require(drive, disk): checks <drive>:ICITY_<disk-1>, asks for the disk
    exec: [0x486e, 0x4e56],        // $6A4DE spawn(file, args) (il_open.x)
    writeFile: [0x4764, 0x4e56],   // $6A3D4 writefile(name, buffer, length) (PARA.DAT)
    vars: { drive: 0x10470, sound: 0x10476, controller: 0x10478, start: 0x1047a, devices: 0xfdfa },
  },
};
