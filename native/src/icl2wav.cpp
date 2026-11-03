// icl2wav <song.icl> <out.wav> [loops]: renders a chip log with the game's player (16-bit, 62500 Hz),
// to compare with the exported WAVs.
#include <cstdio>
#include <cstdlib>
#include <vector>

#include "chipsynth.h"

int main(int argc, char **argv) {
	if (argc < 3) { std::fprintf(stderr, "usage: icl2wav <song.icl> <out.wav> [loops]\n"); return 1; }
	FILE *f = std::fopen(argv[1], "rb");
	if (!f) { std::perror(argv[1]); return 1; }
	std::vector<uint8_t> in;
	uint8_t buf[65536];
	size_t n;
	while ((n = std::fread(buf, 1, sizeof buf, f)) > 0) in.insert(in.end(), buf, buf + n);
	std::fclose(f);
	ChipLogPlayer pl;
	if (!pl.load(in.data(), in.size())) { std::fprintf(stderr, "%s: not a chip log\n", argv[1]); return 1; }
	int loops = argc > 3 ? std::atoi(argv[3]) : 1;
	double sec = pl.has_loop() ? pl.loop_start_seconds() + loops * (pl.length_seconds() - pl.loop_start_seconds()) : pl.length_seconds();
	size_t frames = size_t(sec * ChipLogPlayer::RATE);
	std::vector<float> out(frames * 2);
	frames = pl.render(out.data(), int(frames));
	std::vector<int16_t> pcm(frames * 2);
	for (size_t i = 0; i < frames * 2; i++) {
		double v = out[i] * 32767.0;
		pcm[i] = int16_t(v > 32767 ? 32767 : v < -32768 ? -32768 : v);
	}
	FILE *o = std::fopen(argv[2], "wb");
	if (!o) { std::perror(argv[2]); return 1; }
	auto u32 = [&](uint32_t v) { std::fwrite(&v, 4, 1, o); };
	auto u16 = [&](uint16_t v) { std::fwrite(&v, 2, 1, o); };
	uint32_t rate = uint32_t(ChipLogPlayer::RATE), bytes = uint32_t(pcm.size() * 2);
	std::fwrite("RIFF", 1, 4, o); u32(36 + bytes); std::fwrite("WAVEfmt ", 1, 8, o);
	u32(16); u16(1); u16(2); u32(rate); u32(rate * 4); u16(4); u16(16);
	std::fwrite("data", 1, 4, o); u32(bytes);
	std::fwrite(pcm.data(), 2, pcm.size(), o);
	std::fclose(o);
	std::printf("%s: %.2f s\n", argv[2], frames / ChipLogPlayer::RATE);
	return 0;
}
