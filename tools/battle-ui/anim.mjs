// Presentation model of battle actions (docs/battle-ui.md §4): which sprite animations the game
// plays for an executed action, read from the action struct $A1A9A that the logic fills
// (f_6f888 / enemy AI) and the battle records. Mirrors f_6baa4 (party attack), f_6b98c (enemy
// action), f_6ba3e (items / spells), f_6c648 (weapon pose), f_6c816 / f_6c948 (lunge + effect
// placement), f_6cd3c (attack animation, effect trigger), f_6e4d8 / f_6e6b0 (effect sprites) and
// f_6cfda (back to the idle pose).
//
//   const act = parseAction(hex)                 // 54 bytes from $A1A9A (recorder 'exec' / logic 'exec')
//   presentation(act, recs, ctx) -> [{op, ...}]  // op: oneshot | place | attackAnim | effect | effectAll
//   ctx: { rec, side: 'party' | 'enemy', charOf(rec) -> character id, cgAttr32(rec) -> attribute byte 0
//          of the enemy's CG9, trigger(rec, action) -> true when the action's sequence has a step with
//          flags bit 0 (the impact frame that spawns the effect sprite) }
//
// Timing (docs §4.3): every animation step is one battle redraw (f_73668(0x1000)), which waits
// for $9CB2E[1] vsyncs since the previous flip (battle speed, 4 at the default setting); a one-shot or
// attack animation lasts its sequence length in redraws; the effect sprite runs its own sequence.

import * as SYS from '../systems/model.mjs';
// IC_TABLE table 5 (effects): {u16 message, u8 passive, u8 anim}
export function effectAnim(id) { const T = SYS.tables(); return T.raw[T.offsets[5] + 4 * id + 3] ?? 0; }

// ---- the action struct ($A1A9A, 54 bytes; offsets from $A1A9A) -----------------------------------
export function parseAction(hex) {
  const b = Buffer.from(hex, 'hex'), w = (o) => (b[o] << 8) | b[o + 1], s = (v) => (v << 16) >> 16;
  const targets = []; const n = w(16); for (let k = 0; k < Math.min(n, 12); k++) targets.push(w(18 + 2 * k));
  return {
    msg: ((w(2) << 16) | w(4)) >>> 0,       // $A1A9C message template (f_6dee4)
    w8: w(8), hit: s(w(10)), w12: w(12), w14: s(w(14)),
    count: n, targets,                       // $A1AAA / $A1AAC
    trigger: b[44],                          // $A1AC6: effect at the impact frame (1 = effect set 0/1, 2 = the map's set)
    type: b[45],                             // $A1AC7: 0/5 item-spell (f_6ba3e), 2 attack (f_6baa4), 3 f_6c268, 6 f_6c36a
    pose: b[46],                             // $A1AC8: weapon class -> pose (f_6c648)
    b47: b[47],                              // $A1AC9: effect id (table 5) for f_6cc02
    action: b[48],                           // $A1ACA: attacker's animation
    effect: b[49],                           // $A1ACB: effect sprite animation (0 = none)
    b50: b[50], b51: b[51],
    lunge: b[52],                            // $A1ACE: 1 / 2 / 3 the attacker moves onto the target (dy 1 / 5)
    place: b[53],                            // $A1ACF: effect sprite at 0 the attacker, 1 the target, 2 the attacker (dy 1); 1 = on every target
    raw: [...b],
  };
}

// ---- f_6c648: pose by weapon class (party attacks) ------------------------------------------------
// returns { oneshot, idle } (idle = new record +28, null = unchanged; 'reset' = f_6cfda)
export function weaponPose(cls, idle, charId) {
  switch (cls) {
    case 1: return { oneshot: charId === 7 && idle !== 0x0e ? 2 : null, idle: 0x0e };
    case 2: return { oneshot: null, idle: 0x0e };
    case 4: return { oneshot: idle !== 0x0c ? 2 : null, idle: 0x0c };
    case 5: return { oneshot: null, idle: 0x0d };
    case 6: return { oneshot: null, idle: 0x0b };
    case 7: return { oneshot: idle !== 0x0a ? 2 : null, idle: 0x0a };
    case 8: return { oneshot: idle !== 0x0c ? 8 : null, idle: 0x0c };
    case 9: return { oneshot: idle !== 0x0d ? 7 : null, idle: 0x0d };
    case 11: return { oneshot: idle !== 0x0f ? 3 : null, idle: 0x0f };
    default: return { reset: true };          // 0, 3, 10, > 11: f_6cfda
  }
}
// f_6cfda: robot (character 4) with idle $C / $D plays $31 / $32; idle $A plays $30 and returns to 6
export function resetPose(idle, charId) {
  if (charId === 4 && idle === 0x0c) return { oneshot: 0x31, idle };
  if (charId === 4 && idle === 0x0d) return { oneshot: 0x32, idle };
  if (idle === 0x0a) return { oneshot: 0x30, idle: 6 };
  return { oneshot: null, idle };
}

const enemySlotShift = [[0, 8], [0x10, 0x20], [0x18, 0x28]];

export function presentation(act, recs, ctx) {
  const out = [], rec = ctx.rec, r = recs[rec], spr = r.spr;
  let idle = r.idle;
  const charId = ctx.charOf ? ctx.charOf(rec) : null;
  const oneshot = (a) => out.push({ op: 'oneshot', rec, action: a });
  const t0 = act.targets[0];
  const doPose = (res) => { if (res.reset) { const z = resetPose(idle, charId); if (z.oneshot !== null) oneshot(z.oneshot); idle = z.idle; return; } if (res.oneshot !== null) oneshot(res.oneshot); idle = res.idle; };
  const attackAnim = (action, effect) => {
    out.push({ op: 'attackAnim', rec, action, effect });
    if (act.trigger && ctx.trigger && ctx.trigger(rec, action)) {
      out.push({ op: 'effect', spr, rec, action: effect });
      if (act.place) out.push({ op: 'effectAll', rec, slot: spr });
    }
  };
  // f_6cc02 (effect of table 5 id $A1AC9): when it has one and $A1ACB != 0, f_6e676 -> f_6e6b0 shows the
  // effect sprite on every target
  // the effect's own animation (table 5 record +3) replaces $A1ACB when non-zero
  const applyEffect = (eff) => { if (!act.b47) return; const a = effectAnim(act.b47); if (a) eff = a; if (eff) out.push({ op: 'effectAll', rec, slot: spr, effect: eff }); };
  if (ctx.side === 'party') {
    if (act.type === 2) {                         // f_6baa4
      doPose(weaponPose(act.pose, idle, charId));
      if (!act.count) return out;
      lungeParty(out, act, rec, spr, t0);
      attackAnim(act.action, act.effect);
      applyEffect(act.effect);
      if (charId !== 4) doPose({ reset: true });
    } else if (act.type === 0 || act.type === 5) { // f_6ba3e: the effect id is cleared during the lunge
      if (!act.count) return out;
      lungeParty(out, act, rec, spr, t0);
      attackAnim(act.action, 0);
      applyEffect(act.effect);
    }
    return out;
  }
  // enemy: f_6b98c
  if (!act.count) return out;
  if (!act.pose && !act.b47) return out;
  let action = act.action, effect = act.effect;
  if (act.lunge === 1) out.push({ op: 'place', rec: t0, spr, dy: -5 });
  out.push(act.place ? { op: 'place', rec: t0, spr: 8 + spr, dy: -1 } : { op: 'place', rec, spr: 8 + spr, dy: 0 });
  const a32 = ctx.cgAttr32 ? ctx.cgAttr32(rec) : 0;
  if (act.lunge === 3) {
    const [d4, d5] = enemySlotShift[recs[t0]?.spr] ?? [0, 0];
    action = (action + d4) & 0xff; effect = (effect + (a32 ? d5 : d4)) & 0xff;
  } else if (a32) effect = (effect + 8) & 0xff;
  attackAnim(action, effect);
  applyEffect(act.b50);                          // f_6b98c copies $A1ACC into $A1ACB before f_6cc02
  return out;
}
// f_6c816: the attacker moves onto target 0 (lunge 1: dy 1, 2/3: dy 5), the effect sprite is placed
function lungeParty(out, act, rec, spr, t0) {
  if (act.lunge === 1) out.push({ op: 'place', rec: t0, spr, dy: 1 });
  else if (act.lunge === 2 || act.lunge === 3) out.push({ op: 'place', rec: t0, spr, dy: 5 });
  if (act.place === 0) out.push({ op: 'place', rec, spr: 8 + spr, dy: 0 });
  else if (act.place === 1) out.push({ op: 'place', rec: t0, spr: 8 + spr, dy: 0 });
  else if (act.place === 2) out.push({ op: 'place', rec, spr: 8 + spr, dy: 1 });
}

// recorder event -> comparable key ('flash' is the recorder's name for f_6cb30 = place)
export function callKey(x) {
  switch (x.op) {
    case 'oneshot': return `oneshot ${x.rec} ${x.action}`;
    case 'flash': case 'place': return `place ${x.rec} ${x.spr} ${x.n ?? x.dy}`;
    case 'attackAnim': return `attack ${x.rec} ${x.action} ${x.effect}`;
    case 'effect': return `effect ${x.spr} ${x.rec} ${x.action}`;
    case 'effectAll': return `effectAll ${x.rec} ${x.slot}`;
    default: return x.op;
  }
}

// ---- palettes --------------------------------------------------------------------------------------
// tileset palette entry 0x0GRB (4 bits per gun) -> X68000 text palette word GGGGG RRRRR BBBBB I
export const paletteWord = (c) => (((c >> 8) & 15) << 12) | (((c >> 4) & 15) << 7) | ((c & 15) << 2) | 1;
// f_87bcc fade steps (4-bit guns of the 0GRB palette): fading in, step k = 1..15 shows every gun at
// min(c, k); fading out, step k shows max(0, c - k). One step every 2 vsyncs (fade-in) / every vsync
// (fade-out) in the traces.
export function fadeWord(c, k, out = false) {
  const f = (v) => (out ? Math.max(0, v - k) : Math.min(v, k));
  return paletteWord((f((c >> 8) & 15) << 8) | (f((c >> 4) & 15) << 4) | f(c & 15));
}
// -> {k, out} or -1
export function matchFadeStep(pal, spal) {
  for (const out of [false, true]) for (let k = 0; k <= 15; k++) if (pal.every((c, i) => fadeWord(c, k, out) === spal[i])) return { k, out };
  return -1;
}

// Contact battles (f_6abca mode 0) start with f_78546 twice: f_7857e(16, 1, 4, $AAA) and
// f_7857e(16, 1, 2, $00A) — the 16 text palette entries set to the colour (0GRB, through f_87bcc),
// 2 vsyncs, the palette back (f_87bcc($9EEFA)), then 4 / 2 vsyncs: gray, blue, gray, blue.
export const CONTACT_FLASH = [[0xaaa, 4], [0x00a, 2], [0xaaa, 4], [0x00a, 2]];   // [colour, vsyncs after]
// a sampled palette during the flash: every entry the flash colour or the field palette's (the
// sampler may catch f_87bcc half-way through its 16 writes) -> the colour, or -1
export function matchFlash(fieldPal, spal) {
  for (const [c] of CONTACT_FLASH.slice(0, 2)) {
    const w = paletteWord(c);
    if (spal.some((v) => v === w) && fieldPal.every((p, i) => spal[i] === w || spal[i] === paletteWord(p))) return c;
  }
  return -1;
}
