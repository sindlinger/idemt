"""Hub config (no JSON). One channel per indicator."""

CHANNELS = [
    {
        "name": "FISHER",
        "plugin": "plugins.fisher",
        "params": {"period": 260, "applied_price": "median"},
    },
    {
        "name": "VROCFFT",
        "plugin": "plugins.vroc_fft_spike",
        "params": {
            "vroc_period": 25,
            "fft_window": 256,
            "calc_bars": 2048,
            "peak_height_std": 1.0,
            "peak_distance": 3,
            "peak_prominence": 0.0,
            "use_convolution": False,
        },
    },
    {
        "name": "WAVEV6",
        "plugin": "plugins.integrated_wave_v5_5",
        "params": {
            "backend": "cupy",  # fallback to numpy if unavailable
            "min_period_bars": 20.0,
            "max_period_bars": 240.0,
        },
        "disabled": False,
    },
    {
        "name": "WAVEFORM12",
        "plugin": "plugins.fft_waveform_v2",
        "params": {
            "fft_window": 4096,
            "min_period": 18,
            "max_period": 52,
            "trend_period": 1024,
            "bandwidth": 0.5,
            "window_type": 3,
            "sum_cycles": False,
            "sort_by_power": True,
            "max_cycles": 12,
        },
        "disabled": False,
    },

    {
        "name": "RLSGPU",
        "plugin": "plugins.online_rls_predict",
        "params": {
            "lookback": 256,
            "forget": 0.995,
            "delta": 100.0,
        },
    },
]