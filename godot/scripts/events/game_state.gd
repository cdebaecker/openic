extends RefCounted
## The game state the event scripts work on (docs/events.md, section 6): the 954-byte block
## $9C794-$9CB4D that the ISV*.DAT save files dump, plus run-time values outside it. A
## transcription of newState / S / the inventory functions of tools/events/vm.mjs.

const BLOCK_ADDR := 0x9c794
const BLOCK_SIZE := 954
const VAR_ADDR := 0x9c798            # VM variable 0 (result register)
const CHAR_SIZE := 40

# Offsets in the block. Words marked LE are little-endian; the others 68000 big-endian.
const OFF_DISK := 0x000
const OFF_VARS := 0x004              # VM variables: var i at $9C798 + i
const OFF_CHESTS := 0x104            # 256-bit set of opened chests / picked-up items
const OFF_MAP_ID := 0x124
const OFF_VIEW := 0x128
const OFF_SCROLL := 0x134
const OFF_CAMERA := 0x13c
const OFF_ITEMS := 0x144             # 40 x {LE u16 code, LE u16 count}
const OFF_KEY_ITEMS := 0x1e4         # 8 x {LE u16 code, LE u16 count}
const OFF_MONEY := 0x204             # BE u32
const OFF_CUR_CHAR := 0x208
const OFF_PARTY_COUNT := 0x20a
const OFF_PARTY := 0x20c             # 3 x BE word character ids
const OFF_PARTY_B := 0x212
const OFF_PARTY_C := 0x218
const OFF_CHARS := 0x21e             # 8 x 40-byte character records (LE words)
const OFF_PARTY_POS := 0x35e         # 3 x 20-byte actor records of the party
const OFF_SPEED := 0x39a
const OFF_MOUSE_MODE := 0x3a6
const OFF_RETURN_POINT := 0x3a8

var block := PackedByteArray()
var outside := {}                    # VM variables outside the block (address -> byte)
# Run-time values outside the save block.
var rt := {
	"last_trigger": -1,     # $9EEEA: builtin 8 returns it + 1
	"pending_trigger": -1,  # $9EEEC: destination trigger after a warp
	"next_map": "",         # $9EEE2: map requested by builtin 10
	"facing": 0,            # $9EEE8: party facing after a warp
	"warp_pending": 0,      # $A258A: builtin 10 from a map script; the field loop loads the map
	"warp_args": Vector2i.ZERO,
	"picture": 0,           # $A1BAA: event-picture mode
	"enemy_action": 0,      # $A1B14: builtin 39
	"money_shown": 0,       # $9ED9E: amount of the last money() call
	"actors_dirty": 0,      # $A2584: builtin 33 changed the party
	"battle_flag": 0,       # $9EEE6
	"hdd": 0,               # $9DD40
}
var vm_stack_t := PackedInt32Array()   # 100 x {type, value} at $A1BBC (never cleared by the game)
var vm_stack_v := PackedInt32Array()


func _init(from_block := PackedByteArray()) -> void:
	block.resize(BLOCK_SIZE)
	for i in mini(from_block.size(), BLOCK_SIZE):
		block[i] = from_block[i]
	vm_stack_t.resize(100)
	vm_stack_v.resize(100)


func be16(off: int) -> int:
	return (block[off] << 8) | block[off + 1]


func le16(off: int) -> int:
	return block[off] | (block[off + 1] << 8)


func set_be16(off: int, v: int) -> void:
	block[off] = (v >> 8) & 255
	block[off + 1] = v & 255


func set_le16(off: int, v: int) -> void:
	block[off] = v & 255
	block[off + 1] = (v >> 8) & 255


func money() -> int:
	return (block[OFF_MONEY] << 24) | (block[OFF_MONEY + 1] << 16) | (block[OFF_MONEY + 2] << 8) | block[OFF_MONEY + 3]


func set_money(v: int) -> void:
	for i in 4:
		block[OFF_MONEY + i] = (v >> (24 - 8 * i)) & 255


func party_count() -> int:
	return be16(OFF_PARTY_COUNT)


func party_ids() -> Array[int]:
	var out: Array[int] = []
	for i in clampi(be16(OFF_PARTY_COUNT), 0, 3):
		out.append(be16(OFF_PARTY + 2 * i))
	return out


func map_id() -> String:
	var s := ""
	for i in 3:
		if block[OFF_MAP_ID + i] == 0:
			break
		s += char(block[OFF_MAP_ID + i])
	return s


func chest_open(n: int) -> bool:
	return (block[OFF_CHESTS + (n >> 3)] >> (n & 7)) & 1 == 1


# --- VM memory: variable index (signed 16) -> address $9C798 + index ---------------------------

static func _s16(v: int) -> int:
	v &= 0xffff
	return v - 0x10000 if v & 0x8000 else v


func _rd8(addr: int) -> int:
	var o := addr - BLOCK_ADDR
	return block[o] if o >= 0 and o < BLOCK_SIZE else int(outside.get(addr, 0))


func _wr8(addr: int, v: int) -> void:
	var o := addr - BLOCK_ADDR
	if o >= 0 and o < BLOCK_SIZE:
		block[o] = v & 255
	else:
		outside[addr] = v & 255


func get_var16(i: int) -> int:
	var a := VAR_ADDR + _s16(i)
	return _rd8(a) | (_rd8(a + 1) << 8)


func set_var16(i: int, v: int) -> void:
	var a := VAR_ADDR + _s16(i)
	_wr8(a, v)
	_wr8(a + 1, v >> 8)


func get_var8(i: int) -> int:
	return _rd8(VAR_ADDR + _s16(i))


func set_var8(i: int, v: int) -> void:
	_wr8(VAR_ADDR + _s16(i), v)


# --- inventory (f_7116c / f_7122c / f_712d8) --------------------------------------------------

## Key items (codes $40-$FF with a zero high byte, and $217, $231) live in 8 slots, the others in 40.
static func _item_list(code: int) -> Vector2i:
	if ((code & 0xff00) == 0 and (code & 0xff) > 0x3f) or code == 0x231 or code == 0x217:
		return Vector2i(OFF_KEY_ITEMS, 8)
	return Vector2i(OFF_ITEMS, 40)


func _find_item(code: int, list_code: int) -> int:
	var l := _item_list(list_code)
	for i in l.y:
		if le16(l.x + 4 * i) == code:
			return l.x + 4 * i
	return -1


func item_count(code: int) -> int:
	if code == 0:
		return 0
	var p := _find_item(code, code)
	return 0 if p < 0 else le16(p + 2)


## f_7122c: 0 = done, 1 = list full
func give_item(code: int, count: int) -> int:
	code &= 0xffff
	count &= 0xffff
	if (count & 0xff) == 0:
		return 0
	var p := _find_item(code, code) if code else -1
	if code and p >= 0:
		set_le16(p + 2, le16(p + 2) + count)
		return 0
	p = _find_item(0, code)
	if p < 0:
		return 1
	set_le16(p, code)
	set_le16(p + 2, count)
	return 0


## f_712d8: 0 = done (or code & $FF = 0), 1 = not held
func take_item(code: int, count: int) -> int:
	code &= 0xffff
	if (code & 0xff) == 0:
		return 0
	var p := _find_item(code, code)
	if p < 0:
		return 1
	var v := _s16(le16(p + 2) - count)
	set_le16(p + 2, 0 if v < 0 else v)
	return 0
