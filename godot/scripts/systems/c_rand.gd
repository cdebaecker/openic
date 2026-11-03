extends RefCounted
## The C library rand() of ICITY68 (f_8b718; srand f_8b6ca, refill f_8b6f4): a subtractive
## generator over 55 words at $9DCD2 with its index at $8B74C (-1 = not seeded: rand() seeds
## with 51 first). A transcription of CRand in tools/systems/model.mjs (exact 16/32-bit arithmetic).

var t := PackedInt32Array()
var i := -1


func _init(table: Array = [], index := -1) -> void:
	t.resize(55)
	for k in mini(table.size(), 55):
		t[k] = int(table[k]) & 0xffff
	i = index


func srand(seed: int) -> void:
	var d0 := seed & 0xffffffff
	for k in 55:
		d0 = ((d0 & 0xffff) * 0x3d09) & 0xffffffff
		d0 = (d0 & 0xffff0000) | ((d0 + 1) & 0xffff)
		t[k] = d0 & 0xffff
	i = 54
	refill()


func refill() -> void:
	for k in 24:
		t[k] = (t[k] - t[k + 31]) & 0xffff
	for k in range(24, 55):
		t[k] = (t[k] - t[k - 24]) & 0xffff


func rand() -> int:
	if i < 0 or i > 0x7fff:
		srand(0x33)
	if i == 54:
		refill()
		i = -1
	i += 1
	return t[i] & 0x7fff


## f_88e00(n): n ? rand() % n : 0 (rand() is not called for n = 0)
func mod(n: int) -> int:
	n &= 0xffff
	return rand() % n if n else 0


## The rng(n) callable the level-up functions take.
func fn() -> Callable:
	return mod
