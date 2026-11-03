// Live synthesis of the game's music from chip logs (tools/export/audio/chiplog.mjs): the OPM
// register writes go to ymfm's YM2151, the ADPCM events to an MSM6258 decoder modelled on the
// emulator's (src/adpcm.js). Output is stereo at the OPM's own rate (4 MHz / 64 = 62500 Hz).
#pragma once

#include <cstddef>
#include <cstdint>
#include <memory>
#include <vector>

class ChipLogPlayer {
public:
	static constexpr double OPM_CLOCK = 4000000.0;
	static constexpr double RATE = OPM_CLOCK / 64.0;

	ChipLogPlayer();
	~ChipLogPlayer();

	// Parses a log; false if it is not one. Restarts playback.
	bool load(const uint8_t *data, size_t size);
	void set_loop(bool loop) { loop_enabled = loop; }
	bool has_loop() const { return loop_start != NO_LOOP; }
	double length_seconds() const { return end / double(log_rate); }
	double loop_start_seconds() const { return has_loop() ? loop_start / double(log_rate) : 0.0; }

	void restart();
	// Plays silently up to `seconds` (log time, the loop followed).
	void seek(double seconds);
	// Renders up to `frames` stereo frames (interleaved L, R) at RATE. Returns the frames written:
	// fewer once a song without loop (or with looping off) has ended.
	int render(float *out, int frames);
	bool finished() const { return done; }
	double position_seconds() const { return played / RATE; }
	int loops() const { return loop_count; }

private:
	static constexpr uint32_t NO_LOOP = 0xffffffffu;
	struct Opm;
	std::unique_ptr<Opm> opm;

	// log
	std::vector<uint8_t> data;
	uint32_t log_rate = 48000, loop_start = NO_LOOP, end = 0;
	size_t events = 0, events_end = 0, loop_offset = 0;
	uint8_t start_ppi = 0;
	struct Blob { size_t offset, size; };
	std::vector<Blob> blobs;
	bool loop_enabled = true;

	// playback state
	size_t p = 0;              // next event in data
	double next_t = 0;         // its time (log samples, relative to the current pass)
	double t = 0;              // time of the last event read
	double now = 0;            // current time (log samples)
	uint64_t played = 0;       // output frames since the start
	int loop_count = 0;
	bool done = false;

	// MSM6258 (src/adpcm.js)
	int clock8 = 1, ppi = 0;
	bool ad_playing = false;
	const uint8_t *ad_data = nullptr;
	uint32_t ad_pos = 0, ad_len = 0;
	int ad_nib[2] = {0, 0}, ad_nibs = 0, ad_nib_i = 0;
	int ad_signal = 0, ad_step = 0;
	double ad_frac = 0, ad_last = 0, ad_cur = 0, ad_filt = 0;
	double dc_x[2] = {0, 0}, dc_y[2] = {0, 0};

	double read_time();
	void apply();
	void adpcm_sample(double &out);
	void tick(float &l, float &r);
};
