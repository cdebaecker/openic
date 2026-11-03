// IC_TABLE.COM with every field named (milestone 5: game systems) -> ../work/export/data/systems.json
// for the Godot port. Decoder: tools/systems/tables.mjs; spec: docs/systems.md §1.
//
//   node tools/export/systems.mjs            # reads IC_TABLE.COM from the disk images
//
// Besides the tables it writes derived lists the port needs: the experience needed for every level
// of every character (f_81a52), the effect handlers by id, the field-usable items and spells and
// the shops with names and prices resolved. The output is game data: never commit it.
import { readFile, exportDir, ensureDir, writeJson } from './common.mjs';
import { decodeTables, itemName, itemPrice, codeClass, WEAPON_TYPES, ARMOUR_CATS } from '../systems/tables.mjs';
import { isMain } from '../root.mjs';

// What each effect id does (handler table $9CFB8, f_847b4). field = changes the game state when
// used outside battle; passive = equipment bonus (applied by the stat recompute).
export const EFFECT_KINDS = {
  7: 'battle: attack down', 8: 'battle: defence down', 9: 'battle: agility down',
  2: 'battle', 3: 'battle', 5: 'battle', 6: 'battle', 10: 'battle',
  18: 'HP +50', 19: 'HP +100', 20: 'HP +300', 21: 'HP +9999 (full)',
  22: 'MP +100', 23: 'MP +200', 24: 'MP +999', 25: 'MP +16',
  26: 'cure sleep (battle)', 27: 'cure paralysis (battle)', 28: 'cure poison (battle)', 29: 'cure confusion (battle)',
  30: 'HP +9999, MP +16, cure all (battle statuses)', 31: 'nothing (sound only)',
  36: 'battle: attack up', 37: 'battle: defence up', 38: 'battle: hit rate up',
  40: 'battle', 41: 'battle', 42: 'battle: barrier', 43: 'battle: barrier', 44: 'battle: barrier', 45: 'battle: barrier', 46: 'battle: barrier', 47: 'battle: barrier',
  49: 'hit +32 (+5)', 50: 'hit +64 (+5)', 51: 'hit -32 (+5)', 52: 'agility +10 (+7)', 53: 'agility +20 (+7)', 54: 'agility -10 (+7)', 55: 'agility -20 (+7)',
  56: 'attack +20 (not firearms)', 57: 'attack +40 (not firearms)', 58: 'attack +80 (not firearms)',
  59: '+37 bit 2', 60: '+37 bit 1', 61: '+37 bit 0', 62: '+37 bit 7', 63: '+37 bit 6', 64: '+37 bit 5', 65: '+37 bit 4',
  66: 'battle: HP +50', 67: 'repel encounters ($9CB4C = 200)', 70: 'battle: MP -5 (self)', 71: 'battle: HP drain',
  73: '+36 bit 6', 74: '+36 bit 5', 75: '+36 bit 4', 76: '+38 bit 4', 77: '+4 bit 4', 78: '+38 bit 2',
  80: 'attack +40 (not firearms), agility -10', 81: '+36 bit 5, agility +10', 82: '+36 bit 3', 83: '+36 bit 7, hit +32', 84: '+38 bit 3, +4 bit 2',
  86: 'battle', 87: 'battle', 88: 'battle', 89: 'battle', 90: 'return spell: warp to the return point (builtin 22)',
  91: 'battle', 92: 'battle', 95: 'battle: seal spells', 97: 'battle: poison', 98: 'battle: paralysis', 99: 'battle: petrify',
  100: 'battle: sleep', 101: 'battle: illusion', 102: 'battle: confusion', 103: 'battle', 104: 'battle',
  106: 'battle: attack', 107: 'battle: attack', 108: 'battle: attack', 109: 'battle: attack', 110: 'battle: attack', 111: 'battle: attack',
};

export function systemsJson(T) {
  const { raw, ...t } = T;
  const named = (code) => ({ code, class: codeClass(code), name: itemName(T, code), price: itemPrice(T, code) });
  const expTable = T.expCurve.map((curve) => {
    const need = []; let sum = 0;
    for (let lv = 1; lv <= 98; lv++) { const k = Math.min(lv, 40); sum += curve[k >> 2] * k * k; need.push(sum); }
    return need;   // need[lv - 1] = total experience needed to leave level lv (0 from level 99)
  });
  return {
    note: 'IC_TABLE.COM decoded (docs/systems.md §1). Item codes: $0xx/$1xx items (table 4, index = low byte), $2xx weapons (table 6), $3xx armour (table 7).',
    offsets: t.offsets,
    raw: Buffer.from(raw).toString('base64'),   // the whole file (records point into the string pool)
    names: t.names,
    expCurve: t.expCurve, growth: t.growth, expTable,
    items: t.items, effects: t.effects.map((e) => ({ ...e, does: EFFECT_KINDS[e.id] ?? null })),
    weapons: t.weapons, weaponTypes: WEAPON_TYPES, armour: t.armour, armourCategories: ARMOUR_CATS,
    spells: t.spells, spellLists: t.spellLists.map((l) => l.map((id) => ({ id, name: T.spells[id]?.name }))),
    outOfAmmo: t.outOfAmmo, classes: t.classes, weaponTypeNames: t.weaponTypeNames, music: t.music,
    initialChars: t.initialChars, initialItems: t.initialItems.map((x) => ({ ...named(x.code), count: x.count })),
    places: t.places,
    shops: t.shops.map((s) => ({ ...s, categories: s.categories.map((c) => ({ ...c, rows: c.rows?.map((r) => ({ ...r, items: r.codes.filter((x) => x & 0xff).map(named) })) })) })),
    fieldItems: t.items.filter((i) => i.field).map((i) => ({ index: i.index, name: i.name, effect: i.effect, does: EFFECT_KINDS[i.effect] ?? (i.effect ? null : 'nothing') })),
    fieldSpells: t.spells.filter((s) => s.field).map((s) => ({ index: s.index, name: s.name, cost: s.cost, single: s.single, all: s.all, effect: s.effect, does: EFFECT_KINDS[s.effect] ?? null })),
    battle8: t.battle8, t11: t.t11, t12: t.t12,
  };
}

if (isMain(import.meta.url)) {
  const T = decodeTables(new Uint8Array(readFile('IC_TABLE.COM')));
  const out = ensureDir(`${exportDir}/data`);
  const j = systemsJson(T);
  writeJson(`${out}/systems.json`, j);
  console.log(`${out}/systems.json: ${j.items.length} items, ${j.weapons.length} weapons, ${j.armour.length} armour, ${j.spells.length} spells, ${j.effects.length} effects, ${j.names.length} names, ${j.shops.length} shops, ${j.places.length} places`);
}
