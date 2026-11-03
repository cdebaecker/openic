extends RefCounted
## The event-script VM (interpreter f_7a55e, builtins $9C240), transcribed from
## tools/events/vm.mjs, the reference model that reproduces the original's traces exactly
## (docs/events.md). Blocking builtins are awaited on the host, so a run is a coroutine:
##
##   var vm := VM.new(program, state, host, {"main": ..., "map": ...})
##   var status: String = await vm.run(entry)        # "done" | "aborted" | "error:..."
##
## host: builtin(n, args, vm) -> int (may be a coroutine), message(offset, vm) (coroutine),
##       warp(info, vm) (coroutine, builtin 10 from IC_MAIN), on_abort(vm), trace(event) (optional)
## A program is {"name", "kind": "main" | "consult" | "map", "code": PackedByteArray}.

const GameState := preload("res://scripts/events/game_state.gd")

const STACK_ENTRIES := 100
const ENTRY_MAIN := 0x14
const ENTRY_MAP := 1
# Builtin kinds: "vm" = game state only (here), "host", "mixed" (state here, then host), "nop".
const KINDS := {
	0: "host", 1: "host", 2: "vm", 3: "vm", 4: "vm", 5: "host", 6: "host", 8: "vm", 9: "host",
	10: "mixed", 11: "host", 12: "vm", 13: "host", 15: "host", 16: "host", 19: "mixed", 20: "host",
	21: "vm", 22: "vm", 23: "vm", 24: "host", 25: "host", 26: "vm", 29: "host", 30: "host",
	31: "host", 33: "mixed", 34: "host", 35: "host", 37: "host", 38: "host", 39: "vm", 40: "vm",
	41: "vm",
}


## Stack memory of the interpreter (400 bytes at $A1BBC: 100 x {type, value}); a run starts with
## whatever the previous run left there, nested runs work on a copy.
class Mem:
	var t := PackedInt32Array()
	var v := PackedInt32Array()

	func _init() -> void:
		t.resize(100)
		v.resize(100)

	func copy() -> Mem:
		var m := Mem.new()
		m.t = t.duplicate()
		m.v = v.duplicate()
		return m


class Context:
	var prog: Dictionary
	var code: PackedByteArray
	var pc := 0
	var on_end := -1        # builtin whose nested run this is (finishSys(n, 0) at its end), -1 = none
	var mem: Mem
	var sp := 100
	var fp := 100

	func _init(program: Dictionary, entry: int, end_builtin: int, memory: Mem) -> void:
		prog = program
		code = program["code"]
		pc = entry
		on_end = end_builtin
		mem = memory


var prog: Dictionary
var state  # GameState
var host
var programs: Dictionary
var root  # VM that builtin 4 unwinds to
var ctx: Array[Context] = []
var status := "idle"
var steps := 0
var nested: Context = null
var _error := ""


func _init(program: Dictionary, game_state, vm_host, progs := {}, root_vm = null) -> void:
	prog = program
	state = game_state
	host = vm_host
	programs = progs
	root = root_vm if root_vm != null else self


func get_r0() -> int:
	return state.get_var16(0)


func set_r0(v: int) -> void:
	state.set_var16(0, v)


## f_7a55e(entry): run to the end. r0 >= 0 sets the result register first.
func run(entry: int, r0 := -1, limit := 10000000) -> String:
	if r0 >= 0:
		set_r0(r0)
	ctx.clear()
	if not entry:
		status = "done"
		return status
	if not state.has_meta("vm_mem"):
		state.set_meta("vm_mem", Mem.new())
	var mem: Mem = nested.mem.copy() if nested != null else state.get_meta("vm_mem")
	ctx.append(Context.new(prog, entry & 0xffff, -1, mem))
	status = "running"
	_error = ""
	while status == "running" and limit > 0:
		limit -= 1
		await _step()
	if _error != "":
		status = "error:" + _error
	elif status == "running":
		status = "error:step"
	return status


## A VM on another program sharing this state and host (cutscene T -> map entry 4, battle hooks).
func spawn(program := {}):
	var p := program if not program.is_empty() else prog
	var v = load("res://scripts/events/vm.gd").new(p, state, host, programs, root)
	v.nested = _cur() if not ctx.is_empty() else null
	return v


func _cur() -> Context:
	return ctx[ctx.size() - 1]


func _fail(what: String) -> void:
	_error = what
	status = "error"


func _trace(e: Dictionary) -> void:
	if host.has_method("trace"):
		host.trace(e)


# --- stack ------------------------------------------------------------------------------------

func _push(c: Context, t: int, v: int) -> void:
	if c.sp <= 0:
		_fail("stack")
		return
	c.sp -= 1
	c.mem.t[c.sp] = t & 0xffff
	c.mem.v[c.sp] = v & 0xffff


func _value(c: Context, i: int) -> int:  # f_7ad70
	var t := _entry_type(c, i)
	var v := _entry_value(c, i)
	match t:
		0, 1:
			return v
		2:
			return state.get_var8(v)
		4:
			var b: int = state.get_var8(v)
			return (b - 256 if b & 0x80 else b) & 0xffff
		3, 5:
			return state.get_var16(v)
		6, 7:
			return _slot(c, v)
	return t  # types 8-31: the handler returns the type number


func _store(c: Context, i: int, x: int) -> void:  # f_7adfc
	var t := _entry_type(c, i)
	var v := _entry_value(c, i)
	match t:
		2, 4:
			state.set_var8(v, x)
		3, 5:
			state.set_var16(v, x)
		6, 7:
			_set_slot(c, v, x)


func _entry_type(c: Context, i: int) -> int:
	if i < STACK_ENTRIES:
		return c.mem.t[i]
	return 0x000a if i < STACK_ENTRIES + 3 else 0


func _entry_value(c: Context, i: int) -> int:
	if i < STACK_ENTRIES:
		return c.mem.v[i]
	# beyond the stack area: the interpreter's own variables ($A1D4C sp, $A1D50 fp, $A1D54 base)
	if i == STACK_ENTRIES:
		return (0x1bbc + 4 * c.sp) & 0xffff
	if i == STACK_ENTRIES + 1:
		return (0x1bbc + 4 * c.fp) & 0xffff
	if i == STACK_ENTRIES + 2:
		return 0x1bbc
	return 0


func _slot(c: Context, k: int) -> int:
	return _entry_value(c, c.fp + GameState._s16(k))


func _set_slot(c: Context, k: int, x: int) -> void:
	var i := c.fp + GameState._s16(k)
	if i < 0 or i >= STACK_ENTRIES:
		_fail("frame")
		return
	c.mem.v[i] = x & 0xffff


func _set_top(c: Context, x: int) -> void:
	if c.sp >= STACK_ENTRIES:
		_fail("stack")   # popped past the bottom (the original writes past its stack area)
		return
	c.mem.t[c.sp] = 1
	c.mem.v[c.sp] = x & 0xffff


func _args(c: Context, n := 8) -> Array[int]:
	var a: Array[int] = []
	for k in n:
		a.append(_entry_value(c, c.sp + k))
	return a


# --- one instruction ---------------------------------------------------------------------------

func _step() -> void:
	var c := _cur()
	var code := c.code
	var at := c.pc
	if at >= code.size():
		_fail("pc")
		return
	var b := code[at]
	steps += 1
	_trace({"e": "i", "pc": at, "op": b, "depth": STACK_ENTRIES - c.sp,
		"t": c.mem.t[c.sp] if c.sp < STACK_ENTRIES else -1, "v": c.mem.v[c.sp] if c.sp < STACK_ENTRIES else -1,
		"r0": get_r0(), "nest": ctx.size() - 1})
	match b >> 6:
		0:
			_ret(c)
		1:  # PUSH type, s8 | u16
			var t := (b & 0x3f) >> 1
			if b & 1:
				_push(c, t, _u16(code, at + 1))
				c.pc = at + 3
			else:
				var s8 := code[at + 1]
				_push(c, t, s8 - 256 if s8 & 0x80 else s8)
				c.pc = at + 2
		2:
			c.pc = at + 1
			_op(c, b & 0x3f)
		_:
			var o := b & 0x3f
			c.pc = at + 1
			match o:
				0:  # SETR
					set_r0(_value(c, c.sp))
					c.sp += 1
				1:  # DROP s8
					var n := code[at + 1]
					c.sp += n - 256 if n & 0x80 else n
					c.pc = at + 2
				2:  # CALL u16
					_push(c, 1, at + 3)
					_push(c, 1, 4 * c.fp)
					c.fp = c.sp
					c.pc = _u16(code, at + 1)
				4:  # JMP
					c.pc = _u16(code, at + 1)
				5:  # JR
					c.pc = (at + 3 + _u16(code, at + 1)) & 0xffff
				6:  # JZ (tests the result register)
					c.pc = (at + 3 + _u16(code, at + 1)) & 0xffff if get_r0() == 0 else at + 3
				7:  # MSG u16
					c.pc = at + 3
					if host.has_method("message"):
						await host.message(_u16(code, at + 1), self)
				8:  # SYS u8
					c.pc = at + 2
					await _sys(c, code[at + 1])
				_:  # NOP ($C3) and $C9-$FF: ignored
					pass


static func _u16(code: PackedByteArray, a: int) -> int:
	var lo := code[a] if a < code.size() else 0
	var hi := code[a + 1] if a + 1 < code.size() else 0
	return lo | (hi << 8)


func _ret(c: Context) -> void:
	c.sp = c.fp
	if c.sp == STACK_ENTRIES:
		_end_context()
		return
	c.fp = int(GameState._s16(c.mem.v[c.sp]) / 4.0)   # saved fp (byte offset from the stack base)
	c.sp += 1
	c.pc = c.mem.v[c.sp]
	c.sp += 1


func _end_context() -> void:
	var c: Context = ctx.pop_back()
	_trace({"e": "end", "nest": ctx.size()})
	if ctx.is_empty():
		status = "done"
		return
	if c.on_end >= 0:
		_finish_sys(c.on_end, 0)


func _op(c: Context, o: int) -> void:
	if o > 20:
		return  # undefined operator: ignored
	var top := c.sp
	match o:
		0:  # load
			_set_top(c, _value(c, top))
			return
		1:  # assign
			var x := _value(c, top)
			c.sp += 1
			_store(c, c.sp, x)
			_set_top(c, x)
			return
		2, 3:  # ++ --
			var x := (_value(c, top) + (1 if o == 2 else -1)) & 0xffff
			_store(c, top, x)
			_set_top(c, x)
			return
		4:  # not (bitwise)
			_set_top(c, ~_value(c, top))
			return
	c.sp += 1
	var a := _value(c, c.sp)
	var bb := _value(c, top)
	var r := 0
	match o:
		5:
			r = a & bb
		6:
			r = a | bb
		7:
			r = a ^ bb
		8:
			r = a + bb
		9:
			r = a - bb
		10:
			r = a * bb
		11:
			if not bb:
				_fail("division")
				return
			r = a / bb
		12:
			if not bb:
				_fail("division")
				return
			r = a % bb
		13:
			r = -1 if a == bb else 0
		14:
			r = -1 if a != bb else 0
		15:
			r = -1 if a < bb else 0
		16:
			r = -1 if a <= bb else 0
		17:
			r = -1 if a > bb else 0
		18:
			r = -1 if a >= bb else 0
		19:
			var n := bb & 63
			r = 0 if n >= 16 else a << n
		20:
			var n := bb & 63
			r = 0 if n >= 16 else a >> n
	_set_top(c, r)


# --- builtins ------------------------------------------------------------------------------------

func _sys(c: Context, n: int) -> void:
	if n >= 48:
		_fail("builtin")
		return
	var args := _args(c)
	_trace({"e": "s", "n": n, "args": args})
	var kind: String = KINDS.get(n, "nop")
	var rt: Dictionary = state.rt
	var ret := 0
	match kind:
		"vm":
			match n:
				2, 3:  # callMain(n) / callMap(n): nested run, result register 0 after it
					var p: Dictionary = programs.get("main" if n == 2 else "map", {})
					if p.is_empty():
						_fail("builtin")
						return
					set_r0(args[0])
					ctx.append(Context.new(p, ENTRY_MAIN if n == 2 else ENTRY_MAP, n, c.mem.copy()))
					return
				4:
					_abort()
					return
				8:
					ret = int(rt["last_trigger"]) + 1
				12:
					var o: int = GameState.OFF_CHARS
					if args[0] == 0:
						state.set_le16(o + 8, state.le16(o + 8) + 100)
					elif args[0] == 1:
						state.block[o + 0x13] = (state.block[o + 0x13] + 50) & 255
					elif args[0] == 2:
						state.block[o + 0x10] = (state.block[o + 0x10] + 50) & 255
				21:
					var k: int = GameState._s16(state.be16(GameState.OFF_PARTY_COUNT))
					for i in k:
						if state.be16(GameState.OFF_PARTY + 2 * i) == args[0]:
							ret = 1
							break
				22:
					var off: int = GameState.OFF_RETURN_POINT
					for i in 3:
						state.block[off + i] = c.code[args[0] + i] if args[0] + i < c.code.size() else 0
					state.block[off + 3] = 0
					state.set_be16(off + 4, args[1])
					state.set_be16(off + 8, args[2])
					state.set_be16(off + 10, args[3])
					state.set_be16(off + 6, args[4])
					state.set_be16(off + 12, 0)
					state.set_be16(off + 14, state.be16(0 if rt["hdd"] else 2))
				23:
					state.set_be16(GameState.OFF_CUR_CHAR, args[0] - 1)
				26:
					rt["money_shown"] = args[0]
					var m: int = state.money()
					var ms := m - 0x100000000 if m & 0x80000000 else m   # signed, as the original compares
					if args[1] == 0:
						if args[0] > ms:
							ret = 0
						else:
							state.set_money(m - args[0])
							ret = 1
					else:
						state.set_money(m + args[0])
						ret = 1
				39:
					rt["enemy_action"] = args[0]
				40:
					ret = state.item_count(args[0])
				41:
					var cnt: int = GameState._s16(args[1])
					ret = (state.give_item(args[0], cnt) if cnt >= 0 else state.take_item(args[0], -cnt)) ^ 1
		"mixed":
			if n == 10:  # warp(mapId, trigger, x, y, facing)
				var id := ""
				for i in 3:
					var ch: int = c.code[args[0] + i] if args[0] + i < c.code.size() else 0
					if ch == 0:
						break
					id += char(ch)
				rt["next_map"] = id
				rt["warp_pending"] = 1
				rt["pending_trigger"] = GameState._s16(args[1] - 1)
				rt["picture"] = 0
				rt["facing"] = args[4]
				rt["warp_args"] = Vector2i(args[2], args[3])
				if c.prog["kind"] == "main":  # from IC_MAIN: the map is loaded now
					if host.has_method("warp"):
						await host.warp({"map": id, "trigger": rt["pending_trigger"], "facing": args[4]}, self)
					rt["last_trigger"] = rt["pending_trigger"]
					rt["pending_trigger"] = -1
			elif n == 19 or n == 33:
				if n == 19:
					var o: int = GameState.OFF_CHARS + GameState.CHAR_SIZE * args[0] + args[1]
					if o >= 0 and o < GameState.BLOCK_SIZE:
						state.block[o] = args[2] & 255
				else:
					_party(args)
				if host.has_method("builtin"):
					await host.builtin(n, args, self)
			ret = 0
		"host":
			if host.has_method("builtin"):
				ret = int(await host.builtin(n, args, self))
	if status != "running":
		return
	_finish_sys(n, ret)


func _finish_sys(n: int, value: int) -> void:
	_trace({"e": "r", "n": n, "value": value & 0xffff})
	set_r0(value & 0xffff)


## builtin 33 party(slot, op, char, b, actor), game-state part (the actor swap is the host's).
func _party(a: Array[int]) -> void:
	var slot := a[0]
	var op := a[1]
	if slot == 1:
		if op == 0:
			state.rt["battle_flag"] = 1
		else:
			state.rt["battle_flag"] = 0
			state.set_be16(GameState.OFF_PARTY_B, a[3])
			state.set_be16(GameState.OFF_PARTY_C, 0)
	elif slot >= 2 and slot <= 3:
		if op == 0:
			state.set_be16(GameState.OFF_PARTY_COUNT, slot - 1)
		elif op <= 2:
			if slot > GameState._s16(state.be16(GameState.OFF_PARTY_COUNT)):
				state.set_be16(GameState.OFF_PARTY_COUNT, slot)
			state.set_be16(GameState.OFF_PARTY_COUNT + 2 * slot, a[2])
			state.set_be16(GameState.OFF_PARTY_B - 2 + 2 * slot, a[3])
			state.set_be16(GameState.OFF_PARTY_C - 2 + 2 * slot, op - 1)
	state.rt["actors_dirty"] = 1


## builtin 4: unwind every run up to the dispatcher.
func _abort() -> void:
	for v in [self, root]:
		v.ctx.clear()
		v.status = "aborted"
	_trace({"e": "abort"})
	if host.has_method("on_abort"):
		host.on_abort(self)
