#!/usr/bin/env python3
"""Render a captured MIDI byte stream through Munt (libmt32emu) to a WAV file.

  python mt32render.py <munt.dll> <rom dir> <ICITY.MDD> <capture.json> <out.wav> [--seconds N] [--end T]

--end T: render at least up to capture position T (capture sample rate), then the release tail.

capture.json: {"rate": capture sample rate, "bytes": [[sample position, byte], ...]}: what ZMUSIC
wrote to the MIDI interface's transmit register (tools/export/audio/midi.mjs). ICITY.MDD (hex
text of Roland SysEx: the patch and timbre memory MENU68 sends at start-up) is sent first, as on
the real machine; that set-up time is not written, so the WAV starts at capture position 0.
The ROM dir holds the control and PCM ROMs (MT-32 or CM-32L) Munt identifies.
"""
import ctypes, json, os, re, sys, wave

def load_munt(dll):
    os.add_dll_directory(os.path.dirname(os.path.abspath(dll)))
    lib = ctypes.CDLL(os.path.abspath(dll))
    lib.mt32emu_create_context.restype = ctypes.c_void_p
    lib.mt32emu_create_context.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    for f in ['mt32emu_add_rom_file', 'mt32emu_open_synth', 'mt32emu_play_msg_now', 'mt32emu_play_sysex_now',
              'mt32emu_render_bit16s', 'mt32emu_get_actual_stereo_output_samplerate']:
        getattr(lib, f).argtypes = None
    return lib

def messages(stream):
    """[(position, bytes)] from the raw byte stream: running status, SysEx, real-time bytes skipped."""
    out, status, cur, t0 = [], 0, [], 0
    for t, b in stream:
        if b >= 0xf8:            # real-time (clock, active sensing, reset): not for the module
            continue
        if b == 0xf0:
            status, cur, t0 = 0xf0, [b], t
            continue
        if status == 0xf0:
            cur.append(b)
            if b == 0xf7:
                out.append((t0, bytes(cur))); status, cur = 0, []
            continue
        if b & 0x80:
            status, cur, t0 = b, [b], t
        elif status:
            if not cur:
                cur, t0 = [status], t
            cur.append(b)
        else:
            continue
        need = 2 if (status & 0xf0) in (0xc0, 0xd0) else 3
        if len(cur) == need:
            out.append((t0, bytes(cur))); cur = []
    return out

def mdd_sysex(path):
    data = bytes(int(h, 16) for h in re.findall(r'[0-9A-Fa-f]{2}', open(path, encoding='ascii', errors='ignore').read()))
    return [m.group() for m in re.finditer(rb'\xf0[^\xf0\xf7]*\xf7', data)]

def main():
    dll, roms, mdd, cap, out = sys.argv[1:6]
    seconds = float(sys.argv[sys.argv.index('--seconds') + 1]) if '--seconds' in sys.argv else None
    end = float(sys.argv[sys.argv.index('--end') + 1]) if '--end' in sys.argv else 0
    lib = load_munt(dll)
    ctx = ctypes.c_void_p(lib.mt32emu_create_context(None, None))
    for f in sorted(os.listdir(roms)):
        if f.lower().endswith('.rom'):
            lib.mt32emu_add_rom_file(ctx, os.path.join(roms, f).encode())
    rc = lib.mt32emu_open_synth(ctx)
    if rc != 0:
        sys.exit(f'Munt could not open the synth ({rc}): check the ROMs in {roms}')
    rate = lib.mt32emu_get_actual_stereo_output_samplerate(ctx)
    buf = (ctypes.c_int16 * (2 * 4096))()
    w = wave.open(out, 'wb'); w.setnchannels(2); w.setsampwidth(2); w.setframerate(rate)
    done = 0
    def render_to(n, write=True):
        nonlocal done
        while done < n:
            k = min(4096, n - done)
            lib.mt32emu_render_bit16s(ctx, buf, ctypes.c_uint32(k))
            if write:
                w.writeframes(bytes(buf)[:k * 4])
            done += k
    # start-up: ICITY.MDD, given time as the real module needs it (about 40 ms per message)
    for sx in mdd_sysex(mdd):
        lib.mt32emu_play_sysex_now(ctx, (ctypes.c_uint8 * len(sx)).from_buffer_copy(sx), ctypes.c_uint32(len(sx)))
        render_to(done + rate // 25, write=False)
    lead = done
    j = json.load(open(cap))
    scale = rate / j['rate']
    for t, msg in messages(j['bytes']):
        at = lead + int(t * scale)
        if seconds and at - lead > seconds * rate:
            break
        render_to(at)
        if msg[0] == 0xf0:
            lib.mt32emu_play_sysex_now(ctx, (ctypes.c_uint8 * len(msg)).from_buffer_copy(msg), ctypes.c_uint32(len(msg)))
        else:
            lib.mt32emu_play_msg_now(ctx, ctypes.c_uint32(int.from_bytes(msg, 'little')))
    render_to(max(done, lead + int(end * scale)))
    render_to(done + rate * 2)   # release tails
    w.close()
    print(f'{out}: {(done - lead) / rate:.1f} s at {rate} Hz, {len(mdd_sysex(mdd))} start-up SysEx')

if __name__ == '__main__':
    main()
