// mt32render: render a captured MIDI byte stream through Munt (libmt32emu, linked in) to a WAV
// file. The native twin of tools/export/audio/mt32render.py, so the importer needs no Python. Same
// steps; the samples differ slightly from the Python one's (floating point in Munt, built apart).
//
//   mt32render <rom dir> <ICITY.MDD> <capture.txt> <out.wav> [--end T] [--partials N]
//
// capture.txt: the capture sample rate on the first line, then "<sample position> <byte>" per line:
// what ZMUSIC wrote to the MIDI interface (tools/export/audio/midi.mjs). ICITY.MDD (hex text of
// Roland SysEx, the patch and timbre memory MENU68 sends at start-up) is sent first, as on the
// real machine; that set-up time is not written, so the WAV starts at capture position 0.
// --end T: render at least up to capture position T, then 2 s of release tails.
// --partials N: Munt's partial count (default 32, as the hardware). The songs are dense: with 32
// the module cuts playing notes short to free partials, as a real MT-32 / CM-32L does; more
// partials keep every note. The counts are printed: "notes ignored", "polys silenced".
// The ROM dir holds the player's MT-32 or CM-32L control and PCM ROMs; Munt identifies them by
// their contents, so every file of a ROM's size is offered to it.
#include <algorithm>
#include <cctype>
#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

#define MT32EMU_API_TYPE 1   // the C interface (static library built with it)
#include <mt32emu/mt32emu.h>

namespace fs = std::filesystem;
using Bytes = std::vector<uint8_t>;

static int fail(const std::string &msg) {
	std::fprintf(stderr, "mt32render: %s\n", msg.c_str());
	return 1;
}

// [(position, message)] from the raw byte stream: running status, SysEx, real-time bytes skipped
static std::vector<std::pair<double, Bytes>> messages(const std::vector<std::pair<double, int>> &stream) {
	std::vector<std::pair<double, Bytes>> out;
	int status = 0;
	Bytes cur;
	double t0 = 0;
	for (auto [t, b] : stream) {
		if (b >= 0xf8) continue;   // clock, active sensing, reset: not for the module
		if (b == 0xf0) { status = 0xf0; cur = {uint8_t(b)}; t0 = t; continue; }
		if (status == 0xf0) {
			cur.push_back(uint8_t(b));
			if (b == 0xf7) { out.emplace_back(t0, cur); status = 0; cur.clear(); }
			continue;
		}
		if (b & 0x80) { status = b; cur = {uint8_t(b)}; t0 = t; }
		else if (status) {
			if (cur.empty()) { cur = {uint8_t(status)}; t0 = t; }
			cur.push_back(uint8_t(b));
		} else continue;
		size_t need = ((status & 0xf0) == 0xc0 || (status & 0xf0) == 0xd0) ? 2 : 3;
		if (cur.size() == need) { out.emplace_back(t0, cur); cur.clear(); }
	}
	return out;
}

// The SysEx messages of ICITY.MDD: hex pairs anywhere in the text, then F0 ... F7 runs
static std::vector<Bytes> mdd_sysex(const std::string &path) {
	std::ifstream f(path, std::ios::binary);
	std::string text((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
	Bytes data;
	for (size_t i = 0; i + 1 < text.size();) {
		if (std::isxdigit((unsigned char)text[i]) && std::isxdigit((unsigned char)text[i + 1])) {
			data.push_back(uint8_t(std::stoi(text.substr(i, 2), nullptr, 16)));
			i += 2;
		} else i++;
	}
	std::vector<Bytes> out;
	for (size_t i = 0; i < data.size(); i++) {
		if (data[i] != 0xf0) continue;
		size_t j = i + 1;
		while (j < data.size() && data[j] != 0xf0 && data[j] != 0xf7) j++;
		if (j < data.size() && data[j] == 0xf7) { out.emplace_back(data.begin() + i, data.begin() + j + 1); i = j; }
	}
	return out;
}

static void put16(std::ofstream &w, uint16_t v) { w.put(char(v & 0xff)); w.put(char(v >> 8)); }
static void put32(std::ofstream &w, uint32_t v) { put16(w, uint16_t(v)); put16(w, uint16_t(v >> 16)); }

int main(int argc, char **argv) {
	// --check <rom dir>: only see whether the folder holds a usable ROM pair (exit 0, "ok <name>")
	const bool check = argc == 3 && !std::strcmp(argv[1], "--check");
	if (argc < 5 && !check) return fail("usage: mt32render <rom dir> <ICITY.MDD> <capture.txt> <out.wav> [--end T] [--partials N]"
		"\n       mt32render --check <rom dir>");
	std::string roms = argv[check ? 2 : 1], mdd = check ? "" : argv[2], cap = check ? "" : argv[3], outPath = check ? "" : argv[4];
	double end = 0;
	int partials = 0;
	for (int i = 5; i + 1 < argc; i++) {
		if (!std::strcmp(argv[i], "--end")) end = std::atof(argv[i + 1]);
		if (!std::strcmp(argv[i], "--partials")) partials = std::atoi(argv[i + 1]);
	}

	// notes the module could not play: out of partials (the real MT-32 drops them the same way)
	static int ignored = 0, silenced = 0;
	static const mt32emu_report_handler_i_v2 handler = [] {
		mt32emu_report_handler_i_v2 h{};
		h.getVersionID = [](mt32emu_report_handler_i) { return MT32EMU_REPORT_HANDLER_VERSION_2; };
		h.printDebug = [](void *, const char *, va_list) {};
		h.onNoteOnIgnored = [](void *, mt32emu_bit32u, mt32emu_bit32u) { ignored++; };
		h.onPlayingPolySilenced = [](void *, mt32emu_bit32u, mt32emu_bit32u) { silenced++; };
		return h;
	}();
	mt32emu_report_handler_i rh;
	rh.v2 = &handler;
	mt32emu_context ctx = mt32emu_create_context(rh, nullptr);
	std::vector<fs::path> files;
	std::error_code ec;
	for (auto &e : fs::directory_iterator(roms, ec)) if (e.is_regular_file()) files.push_back(e.path());
	std::sort(files.begin(), files.end());
	int added = 0;
	for (auto &p : files) {
		auto size = fs::file_size(p, ec);
		// control ROMs are 32 or 64 KB, PCM ROMs 512 KB or 1 MB
		if (size != 32768 && size != 65536 && size != 524288 && size != 1048576) continue;
		if (mt32emu_add_rom_file(ctx, p.string().c_str()) > 0) added++;   // ADDED_CONTROL_ROM or ADDED_PCM_ROM
	}
	if (added < 2) return fail("no MT-32 or CM-32L control and PCM ROM pair in " + roms);
	if (partials > 0) mt32emu_set_partial_count(ctx, mt32emu_bit32u(partials));
	mt32emu_return_code rc = mt32emu_open_synth(ctx);
	if (rc != MT32EMU_RC_OK) return fail("Munt could not open the synth (" + std::to_string(rc) + "): check the ROMs in " + roms);
	if (check) {
		mt32emu_rom_info info{};
		mt32emu_get_rom_info(ctx, &info);
		std::printf("ok %s\n", info.control_rom_description ? info.control_rom_description : "");
		mt32emu_close_synth(ctx);
		mt32emu_free_context(ctx);
		return 0;
	}
	const uint32_t rate = mt32emu_get_actual_stereo_output_samplerate(ctx);

	std::ofstream w(outPath, std::ios::binary);
	w.write("RIFF\0\0\0\0WAVEfmt ", 16);
	put32(w, 16); put16(w, 1); put16(w, 2); put32(w, rate); put32(w, rate * 4); put16(w, 4); put16(w, 16);
	w.write("data\0\0\0\0", 8);
	int16_t buf[2 * 4096];
	uint64_t done = 0;
	auto render_to = [&](uint64_t n, bool write) {
		while (done < n) {
			uint32_t k = uint32_t(std::min<uint64_t>(4096, n - done));
			mt32emu_render_bit16s(ctx, buf, k);
			if (write) w.write(reinterpret_cast<const char *>(buf), k * 4);   // little-endian hosts
			done += k;
		}
	};
	// start-up: ICITY.MDD, given time as the real module needs it (about 40 ms per message)
	auto sysex = mdd_sysex(mdd);
	for (auto &sx : sysex) {
		mt32emu_play_sysex_now(ctx, sx.data(), uint32_t(sx.size()));
		render_to(done + rate / 25, false);
	}
	const uint64_t lead = done;

	std::ifstream c(cap);
	double crate = 0;
	if (!(c >> crate) || crate <= 0) return fail("bad capture file " + cap);
	std::vector<std::pair<double, int>> stream;
	double t; int b;
	while (c >> t >> b) stream.emplace_back(t, b);
	const double scale = double(rate) / crate;
	for (auto &[pos, msg] : messages(stream)) {
		render_to(lead + uint64_t(pos * scale), true);
		if (msg[0] == 0xf0) mt32emu_play_sysex_now(ctx, msg.data(), uint32_t(msg.size()));
		else {
			uint32_t m = 0;
			for (size_t i = 0; i < msg.size(); i++) m |= uint32_t(msg[i]) << (8 * i);
			mt32emu_play_msg_now(ctx, m);
		}
	}
	render_to(std::max(done, lead + uint64_t(end * scale)), true);
	render_to(done + uint64_t(rate) * 2, true);   // release tails
	const uint32_t bytes = uint32_t((done - lead) * 4);
	w.seekp(4); put32(w, 36 + bytes);
	w.seekp(40); put32(w, bytes);
	w.close();
	mt32emu_close_synth(ctx);
	mt32emu_free_context(ctx);
	std::printf("%s: %.1f s at %u Hz, %zu start-up SysEx, notes ignored %d, polys silenced %d\n", outPath.c_str(),
		double(done - lead) / rate, rate, sysex.size(), ignored, silenced);
	return 0;
}
