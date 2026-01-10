"""VROC FFT Spike plugin (GPU/CuPy)."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import numpy as np

try:
    import cupy as cp
    from cupyx.scipy.signal import find_peaks, convolve
except Exception as exc:  # pragma: no cover
    raise SystemExit(f"CuPy not available: {exc}")

EMPTY_VALUE = np.finfo(np.float64).max


@dataclass
class VrocFftConfig:
    vroc_period: int = 25
    fft_window: int = 256
    calc_bars: int = 2048
    peak_height_std: float = 1.0
    peak_distance: int = 3
    peak_prominence: float = 0.0
    use_convolution: bool = False
    kernel: Optional[np.ndarray] = None


def compute_vroc(vol: cp.ndarray, period: int) -> cp.ndarray:
    n = vol.size
    out = cp.zeros(n, dtype=cp.float32)
    if n <= period:
        return out
    prev = vol[:-period]
    curr = vol[period:]
    denom = cp.where(prev != 0, prev, cp.nan)
    v = 100.0 * (curr - prev) / denom
    v = cp.nan_to_num(v, nan=0.0)
    out[period:] = v.astype(cp.float32)
    return out


def fft_peak_spike(window: cp.ndarray, cfg: VrocFftConfig) -> float:
    if window.size <= 8:
        return 0.0
    if cfg.use_convolution and cfg.kernel is not None:
        k = cp.asarray(cfg.kernel, dtype=cp.float32)
        window = convolve(window, k, mode="same", method="fft")

    X = cp.fft.rfft(window)
    mag = cp.abs(X)
    if mag.size > 0:
        mag[0] = 0.0

    mean = cp.mean(mag)
    std = cp.std(mag)
    height = float(mean + cfg.peak_height_std * std)

    peaks, props = find_peaks(
        mag,
        height=height,
        distance=cfg.peak_distance,
        prominence=(cfg.peak_prominence if cfg.peak_prominence > 0 else None),
    )

    if peaks.size == 0:
        return 0.0
    heights = props.get("peak_heights")
    if heights is None or heights.size == 0:
        return 0.0
    idx = int(cp.argmax(heights))
    return float(heights[idx])


class Plugin:
    def __init__(self, params: dict, context: dict):
        self.cfg = VrocFftConfig(
            vroc_period=int(params.get("vroc_period", 25)),
            fft_window=int(params.get("fft_window", 256)),
            calc_bars=int(params.get("calc_bars", 2048)),
            peak_height_std=float(params.get("peak_height_std", 1.0)),
            peak_distance=int(params.get("peak_distance", 3)),
            peak_prominence=float(params.get("peak_prominence", 0.0)),
            use_convolution=bool(params.get("use_convolution", False)),
            kernel=params.get("kernel"),
        )
        self.vol_hist: Optional[cp.ndarray] = None
        self.vroc_hist: Optional[cp.ndarray] = None

    def process_full(self, series: np.ndarray, ts: int) -> np.ndarray:
        vol = cp.asarray(series[::-1], dtype=cp.float32)
        self.vol_hist = vol.copy()
        spikes = self._compute_spikes_full(self.vol_hist)
        out_series = cp.asnumpy(spikes[::-1]).astype(np.float64)
        return out_series

    def process_update(self, series: np.ndarray, ts: int) -> np.ndarray:
        if self.vol_hist is None:
            return np.array([], dtype=np.float64)
        upd_series = series[::-1].astype(np.float32)
        spike_vals = []

        for v in upd_series:
            self.vol_hist = cp.concatenate([self.vol_hist, cp.asarray([v], dtype=cp.float32)])
            n = int(self.vol_hist.size)
            if n - 1 >= self.cfg.vroc_period:
                prev = self.vol_hist[n - 1 - self.cfg.vroc_period]
                curr = self.vol_hist[n - 1]
                vroc_val = float(0.0) if prev == 0 else float(100.0 * (curr - prev) / prev)
            else:
                vroc_val = 0.0

            if self.vroc_hist is None:
                self.vroc_hist = compute_vroc(self.vol_hist, self.cfg.vroc_period)
            else:
                self.vroc_hist = cp.concatenate([self.vroc_hist, cp.asarray([vroc_val], dtype=cp.float32)])

            if n - 1 >= self.cfg.vroc_period + self.cfg.fft_window - 1:
                window = self.vroc_hist[n - self.cfg.fft_window : n]
                spike = fft_peak_spike(window, self.cfg)
                if spike <= 0:
                    spike = EMPTY_VALUE
            else:
                spike = EMPTY_VALUE
            spike_vals.append(spike)

        out_update = np.array(spike_vals[::-1], dtype=np.float64)
        return out_update

    def _compute_spikes_full(self, vol: cp.ndarray) -> cp.ndarray:
        vroc = compute_vroc(vol, self.cfg.vroc_period)
        n = vroc.size
        out = cp.full(n, EMPTY_VALUE, dtype=cp.float64)

        start = self.cfg.vroc_period + self.cfg.fft_window - 1
        if n <= start:
            return out

        calc_start = max(start, n - self.cfg.calc_bars)
        for i in range(calc_start, n):
            window = vroc[i - self.cfg.fft_window + 1 : i + 1]
            spike = fft_peak_spike(window, self.cfg)
            if spike > 0:
                out[i] = spike

        return out
