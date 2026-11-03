// Godot classes for live synthesis: AudioStreamChipLog (a chip log, `data`, played by an
// AudioStreamPlayer like any stream) and its playback, resampled by Godot from the OPM's 62500 Hz.
#include <gdextension_interface.h>
#include <godot_cpp/classes/audio_stream.hpp>
#include <godot_cpp/classes/audio_stream_playback_resampled.hpp>
#include <godot_cpp/core/class_db.hpp>
#include <godot_cpp/godot.hpp>
#include <godot_cpp/variant/packed_byte_array.hpp>

#include "chipsynth.h"

using namespace godot;

class AudioStreamChipLog;

class AudioStreamPlaybackChipLog : public AudioStreamPlaybackResampled {
	GDCLASS(AudioStreamPlaybackChipLog, AudioStreamPlaybackResampled)

public:
	ChipLogPlayer player;
	bool active = false;
	float buf[2 * 1024];

	void _start(double from_pos) override {
		player.seek(from_pos);
		active = !player.finished();
		begin_resample();
	}
	void _stop() override { active = false; }
	bool _is_playing() const override { return active; }
	int32_t _get_loop_count() const override { return player.loops(); }
	double _get_playback_position() const override { return player.position_seconds(); }
	void _seek(double pos) override { player.seek(pos); }
	float _get_stream_sampling_rate() const override { return ChipLogPlayer::RATE; }

	int32_t _mix_resampled(AudioFrame *dst, int32_t frames) override {
		int32_t done = 0;
		while (done < frames && active) {
			int n = player.render(buf, std::min<int32_t>(frames - done, 1024));
			for (int i = 0; i < n; i++) dst[done + i] = AudioFrame{ buf[i * 2], buf[i * 2 + 1] };
			done += n;
			if (player.finished()) active = false;
		}
		for (int32_t i = done; i < frames; i++) dst[i] = AudioFrame{ 0, 0 };
		return done;
	}

protected:
	static void _bind_methods() {}
};

class AudioStreamChipLog : public AudioStream {
	GDCLASS(AudioStreamChipLog, AudioStream)

	PackedByteArray data;
	bool loop = true;
	double length = 0;
	bool valid = false;

public:
	void set_data(const PackedByteArray &p) {
		data = p;
		ChipLogPlayer probe;
		valid = probe.load(data.ptr(), data.size());
		length = valid ? probe.length_seconds() : 0;
	}
	PackedByteArray get_data() const { return data; }
	void set_loop(bool p) { loop = p; }
	bool get_loop() const { return loop; }
	bool is_valid() const { return valid; }

	Ref<AudioStreamPlayback> _instantiate_playback() const override {
		Ref<AudioStreamPlaybackChipLog> pb;
		pb.instantiate();
		pb->player.load(data.ptr(), data.size());
		pb->player.set_loop(loop);
		return pb;
	}
	String _get_stream_name() const override { return "ChipLog"; }
	double _get_length() const override { return length; }
	bool _is_monophonic() const override { return false; }

protected:
	static void _bind_methods() {
		ClassDB::bind_method(D_METHOD("set_data", "data"), &AudioStreamChipLog::set_data);
		ClassDB::bind_method(D_METHOD("get_data"), &AudioStreamChipLog::get_data);
		ClassDB::bind_method(D_METHOD("set_loop", "loop"), &AudioStreamChipLog::set_loop);
		ClassDB::bind_method(D_METHOD("get_loop"), &AudioStreamChipLog::get_loop);
		ClassDB::bind_method(D_METHOD("is_valid"), &AudioStreamChipLog::is_valid);
		ADD_PROPERTY(PropertyInfo(Variant::PACKED_BYTE_ARRAY, "data"), "set_data", "get_data");
		ADD_PROPERTY(PropertyInfo(Variant::BOOL, "loop"), "set_loop", "get_loop");
	}
};

static void initialize(ModuleInitializationLevel level) {
	if (level != MODULE_INITIALIZATION_LEVEL_SCENE) return;
	GDREGISTER_CLASS(AudioStreamPlaybackChipLog);
	GDREGISTER_CLASS(AudioStreamChipLog);
}

static void uninitialize(ModuleInitializationLevel level) {}

extern "C" GDExtensionBool GDE_EXPORT chipsynth_init(GDExtensionInterfaceGetProcAddress get_proc_address,
		GDExtensionClassLibraryPtr library, GDExtensionInitialization *init) {
	GDExtensionBinding::InitObject obj(get_proc_address, library, init);
	obj.register_initializer(initialize);
	obj.register_terminator(uninitialize);
	obj.set_minimum_library_initialization_level(MODULE_INITIALIZATION_LEVEL_SCENE);
	return obj.init();
}
