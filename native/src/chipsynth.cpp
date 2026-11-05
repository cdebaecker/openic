#include "chipsynth.h"

#include <algorithm>
#include <cmath>
#include <cstring>

#include "ymfm_opm.h"
#include "ymfm_opl.h"
#include "ymfm_misc.h"

// Output levels matched to the exported WAVs (the emulator's OPM gives 0.18 for one channel at
// full level; tools/export/audio/chipplay.mjs and icl2wav compare the two).
static constexpr double OPM_GAIN = 0.18 / 8192.0;
static constexpr double ADPCM_GAIN = 0.5;
// MSX: YM2413 (melody + rhythm) at full level, the YM2149 (three channels) at half, as MSX-MUSIC
// sits above the PSG on the machine
static constexpr double MSX_GAIN = 1.0 / 32768.0, MSX_PSG = 0.5;
static constexpr double OPLL_CLOCK = 3579545.0, PSG_CLOCK = 1789772.5;

static const int STEP[49] = { 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97,
	107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544,
	598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552 };
static const int ADJ[8] = { -1, -1, -1, -1, 2, 4, 6, 8 };

struct ChipLogPlayer::Opm : ymfm::ymfm_interface {
	ymfm::ym2151 chip;
	Opm() : chip(*this) { chip.reset(); }
};

struct ChipLogPlayer::Msx : ymfm::ymfm_interface {
	ymfm::ym2413 opll;
	ymfm::ym2149 psg;
	double opll_rate, psg_rate;
	Msx() : opll(*this), psg(*this) {
		opll.reset(); psg.reset();
		opll_rate = opll.sample_rate(uint32_t(OPLL_CLOCK));
		psg_rate = psg.sample_rate(uint32_t(PSG_CLOCK));
	}
};

ChipLogPlayer::ChipLogPlayer() : opm(std::make_unique<Opm>()), msx(std::make_unique<Msx>()) {}
ChipLogPlayer::~ChipLogPlayer() = default;

static uint32_t rd32(const uint8_t *b) { return b[0] | b[1] << 8 | b[2] << 16 | uint32_t(b[3]) << 24; }

bool ChipLogPlayer::load(const uint8_t *src, size_t size) {
	data.assign(src, src + size);
	blobs.clear();
	msx_log = size >= 24 && std::memcmp(src, "MSL1", 4) == 0;
	if (msx_log) {
		// "MSL1", u32 rate, u32 loop start, u32 end, u32 loop offset, u32 event bytes, events
		const uint8_t *b = data.data();
		log_rate = rd32(b + 4); loop_start = rd32(b + 8); end = rd32(b + 12);
		uint32_t loop_off = rd32(b + 16), n = rd32(b + 20);
		if (24 + size_t(n) > size || loop_off > n || log_rate == 0) { data.clear(); done = true; return false; }
		events = 24; events_end = 24 + n; loop_offset = 24 + loop_off; start_ppi = 0;
		restart();
		return true;
	}
	if (size < 23 || std::memcmp(src, "ICL1", 4) != 0) { data.clear(); done = true; return false; }
	const uint8_t *b = data.data();
	size_t q = 4;
	log_rate = rd32(b + q); q += 4;
	loop_start = rd32(b + q); q += 4;
	end = rd32(b + q); q += 4;
	uint32_t loop_off = rd32(b + q); q += 4;
	start_ppi = b[q++];
	uint32_t nb = b[q] | b[q + 1] << 8; q += 2;
	for (uint32_t i = 0; i < nb; i++) {
		if (q + 4 > size) { data.clear(); done = true; return false; }
		uint32_t n = rd32(b + q); q += 4;
		blobs.push_back({ q, n });
		q += n;
	}
	if (q + 4 > size) { data.clear(); done = true; return false; }
	uint32_t n = rd32(b + q); q += 4;
	if (q + n > size || loop_off > n || log_rate == 0) { data.clear(); done = true; return false; }
	events = q;
	events_end = q + n;
	loop_offset = q + loop_off;
	restart();
	return true;
}

void ChipLogPlayer::restart() {
	opm->chip.reset();
	msx->opll.reset(); msx->psg.reset();
	msx_opll_phase = msx_psg_phase = 0;
	msx_opll[0] = msx_opll[1] = msx_psg[0] = msx_psg[1] = 0;
	p = events; t = 0; now = 0; played = 0; loop_count = 0;
	done = data.empty();
	clock8 = 1; ppi = start_ppi;
	ad_playing = false; ad_data = nullptr; ad_pos = ad_len = 0; ad_nibs = ad_nib_i = 0;
	ad_signal = ad_step = 0; ad_frac = ad_last = ad_cur = ad_filt = 0;
	dc_x[0] = dc_x[1] = dc_y[0] = dc_y[1] = 0;
	next_t = done ? 0 : read_time();
}

double ChipLogPlayer::read_time() {
	if (p >= events_end) return INFINITY;
	uint32_t d = 0; int s = 0; uint8_t c;
	do { c = data[p++]; d |= uint32_t(c & 127) << s; s += 7; } while ((c & 128) && p < events_end && s < 32);
	return t + d;
}

void ChipLogPlayer::apply() {
	const uint8_t *b = data.data();
	uint8_t c = b[p++];
	if (msx_log) {   // $01 r v: YM2413, $02 r v: YM2149
		uint8_t r = b[p++], v = b[p++];
		if (c == 1) { msx->opll.write_address(r); msx->opll.write_data(v); }
		else if (c == 2) { msx->psg.write_address(r); msx->psg.write_data(v); }
		return;
	}
	if (c == 2 || c == 3) {
		uint32_t id = b[p] | b[p + 1] << 8, len = rd32(b + p + 2);
		p += 6;
		if (c == 2) { ad_signal = 0; ad_step = 0; ad_nibs = ad_nib_i = 0; }
		if (id < blobs.size()) { ad_data = b + blobs[id].offset; ad_len = std::min<uint32_t>(len, uint32_t(blobs[id].size)); }
		else { ad_data = nullptr; ad_len = 0; }
		ad_pos = 0;
		ad_playing = true;
	} else if (c == 4) {
		ad_playing = false;
	} else if (c == 5) {
		ppi = b[p++];
	} else {
		uint8_t v = b[p++];
		if (c == 0x1b) clock8 = (v & 0x80) ? 0 : 1;   // CT1: the ADPCM clock (8 or 4 MHz)
		opm->chip.write_address(c);
		opm->chip.write_data(v);
	}
}

// One output frame of the MSM6258, as src/adpcm.js renders it.
void ChipLogPlayer::adpcm_sample(double &out) {
	static const double DIV[4] = { 1024, 768, 512, 512 };
	double r = (clock8 ? 8e6 : 4e6) / DIV[(ppi >> 2) & 3];
	if (ad_playing) {
		ad_frac += r / RATE;
		while (ad_frac >= 1) {
			ad_frac -= 1;
			ad_last = ad_cur;
			if (ad_nib_i >= ad_nibs) {
				if (ad_data && ad_pos < ad_len) {
					uint8_t byte = ad_data[ad_pos++];
					ad_nib[0] = byte & 15; ad_nib[1] = byte >> 4; ad_nibs = 2; ad_nib_i = 0;
				} else {
					ad_cur *= 0.9; ad_playing = false; continue;
				}
			}
			int n = ad_nib[ad_nib_i++], ss = STEP[ad_step];
			int diff = ss >> 3;
			if (n & 1) diff += ss >> 2;
			if (n & 2) diff += ss >> 1;
			if (n & 4) diff += ss;
			if (n & 8) diff = -diff;
			ad_signal = std::clamp(ad_signal + diff, -2048, 2047);
			ad_step = std::clamp(ad_step + ADJ[n & 7], 0, 48);
			ad_cur = ad_signal;
		}
	} else {
		ad_cur *= 0.995;
	}
	double v = (ad_last + (ad_cur - ad_last) * ad_frac) / 2048.0;
	ad_filt += (v - ad_filt) * 0.5;
	out = ad_filt * ADPCM_GAIN;
}

void ChipLogPlayer::tick(float &l, float &r) {
	while (next_t <= now) {
		t = next_t;
		apply();
		next_t = read_time();
	}
	if (msx_log) {
		// each chip at its own rate, linearly interpolated to RATE
		msx_opll_phase += msx->opll_rate / RATE;
		while (msx_opll_phase >= 1) {
			msx_opll_phase -= 1;
			ymfm::ym2413::output_data o; msx->opll.generate(&o, 1);
			msx_opll[0] = msx_opll[1]; msx_opll[1] = o.data[0] + o.data[1];
		}
		msx_psg_phase += msx->psg_rate / RATE;
		while (msx_psg_phase >= 1) {
			msx_psg_phase -= 1;
			ymfm::ym2149::output_data o; msx->psg.generate(&o, 1);
			msx_psg[0] = msx_psg[1]; msx_psg[1] = o.data[0] + o.data[1] + o.data[2];
		}
		double v = (msx_opll[0] + (msx_opll[1] - msx_opll[0]) * msx_opll_phase
			+ (msx_psg[0] + (msx_psg[1] - msx_psg[0]) * msx_psg_phase) * MSX_PSG) * MSX_GAIN;
		static const double RM = 1.0 - 2.0 * M_PI * 4.0 / RATE;
		dc_y[0] = v - dc_x[0] + RM * dc_y[0];
		dc_x[0] = v;
		l = r = float(dc_y[0]);
		return;
	}
	ymfm::ym2151::output_data o;
	opm->chip.generate(&o, 1);
	double a = 0;
	adpcm_sample(a);
	double x[2] = { o.data[0] * OPM_GAIN + ((ppi & 2) ? 0 : a), o.data[1] * OPM_GAIN + ((ppi & 1) ? 0 : a) };
	// DC blocker (about 4 Hz): the X68000 output is AC coupled, as on the WAVs
	static const double R = 1.0 - 2.0 * M_PI * 4.0 / RATE;
	for (int c = 0; c < 2; c++) {
		dc_y[c] = x[c] - dc_x[c] + R * dc_y[c];
		dc_x[c] = x[c];
	}
	l = float(dc_y[0]);
	r = float(dc_y[1]);
}

int ChipLogPlayer::render(float *out, int frames) {
	const double step = log_rate / RATE;
	int i = 0;
	for (; i < frames && !done; i++) {
		if (now >= end) {
			if (has_loop() && loop_enabled) {
				now -= end - loop_start;
				p = loop_offset; t = loop_start;
				next_t = read_time();
				loop_count++;
			} else {
				done = true;
				break;
			}
		}
		float l, r;
		tick(l, r);
		if (out) { out[i * 2] = l; out[i * 2 + 1] = r; }
		now += step;
		played++;
	}
	return i;
}

void ChipLogPlayer::seek(double seconds) {
	restart();
	uint64_t n = uint64_t(std::max(0.0, seconds) * RATE);
	while (n > 0 && !done) {
		int k = int(std::min<uint64_t>(n, 4096));
		k = render(nullptr, k);
		if (k == 0) break;
		n -= k;
	}
}
