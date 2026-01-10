"""FFT WaveForm v2 plugin (12-cycle output or summed wave).

Input:
  - FULL: price series (newest first)
  - UPDATE: one or more newest bars (newest first)

Output:
  - FULL: concatenated buffers (buf1||buf2||...||bufN) or single buffer when sum_cycles=True
  - UPDATE: one value per buffer (or single value when sum_cycles=True)
"""
from __future__ import annotations

import logging
import math
from dataclasses import dataclass
from typing import List, Optional

import numpy as np


@dataclass
class WaveFormConfig:
    fft_window: int = 4096
    min_period: int = 18
    max_period: int = 52
    trend_period: int = 1024
    bandwidth: float = 0.5
    window_type: int = 3  # 0=none,1=hann,2=hamming,3=blackman,4=bartlett
    sum_cycles: bool = False
    sort_by_power: bool = True
    max_bars: int = 0
    hop: int = 0
    tracker_tolerance: float = 5.0
    max_cycles: int = 12


def _window(kind: int, n: int) -> np.ndarray:
    if n <= 0:
        return np.ones(0, dtype=np.float64)
    if kind == 1:
        return np.hanning(n).astype(np.float64)
    if kind == 2:
        return np.hamming(n).astype(np.float64)
    if kind == 3:
        return np.blackman(n).astype(np.float64)
    if kind == 4:
        return np.bartlett(n).astype(np.float64)
    return np.ones(n, dtype=np.float64)


def _detrend(x: np.ndarray, trend_period: int) -> np.ndarray:
    if x.size <= 1:
        return x
    if trend_period and 1 < trend_period < x.size:
        kernel = np.ones(int(trend_period), dtype=np.float64) / float(trend_period)
        trend = np.convolve(x, kernel, mode="same")
        return x - trend
    return x - np.mean(x)


class Plugin:
    def __init__(self, params: dict | None = None, context: dict | None = None):
        params = params or {}
        context = context or {}

        self.cfg = WaveFormConfig(
            fft_window=int(params.get("fft_window", 4096)),
            min_period=int(params.get("min_period", 18)),
            max_period=int(params.get("max_period", 52)),
            trend_period=int(params.get("trend_period", 1024)),
            bandwidth=float(params.get("bandwidth", 0.5)),
            window_type=int(params.get("window_type", 3)),
            sum_cycles=bool(params.get("sum_cycles", False)),
            sort_by_power=bool(params.get("sort_by_power", True)),
            max_bars=int(params.get("max_bars", 0)),
            hop=int(params.get("hop", 0)),
            tracker_tolerance=float(params.get("tracker_tolerance", 5.0)),
            max_cycles=int(params.get("max_cycles", 12)),
        )
        self.buffers = int(params.get("buffers", 12))
        self.logger = logging.getLogger("Plugin[FFT_WAVEFORM]")
        level = str(params.get("log_level", "INFO")).upper()
        if hasattr(logging, level):
            self.logger.setLevel(getattr(logging, level))
        self.max_keep = params.get("max_keep")
        if self.max_keep is None:
            self.max_keep = context.get("send_bars")

        self.series: Optional[np.ndarray] = None
        self._dirty = True

        self._k = np.zeros(self.buffers, dtype=np.int32)
        self._amp = np.zeros(self.buffers, dtype=np.float64)
        self._phase = np.zeros(self.buffers, dtype=np.float64)
        self._active = np.zeros(self.buffers, dtype=bool)
        self._last_periods: List[float] = []
        self._last_nfft = 0
        self._last_t0 = 0

    def process_meta(self, meta: np.ndarray, ts: int) -> None:
        if meta is None or len(meta) < 2:
            return
        if int(meta[0]) != 101:
            return
        if len(meta) > 1:
            self.cfg.fft_window = int(meta[1])
        if len(meta) > 2:
            self.cfg.min_period = int(meta[2])
        if len(meta) > 3:
            self.cfg.max_period = int(meta[3])
        if len(meta) > 4:
            self.cfg.trend_period = int(meta[4])
        if len(meta) > 5:
            self.cfg.bandwidth = float(meta[5])
        if len(meta) > 6:
            self.cfg.window_type = int(meta[6])
        if len(meta) > 7:
            self.cfg.sum_cycles = bool(int(meta[7]) > 0)
        if len(meta) > 8:
            self.cfg.sort_by_power = bool(int(meta[8]) > 0)
        if len(meta) > 9:
            self.cfg.max_bars = int(meta[9])
        if len(meta) > 10:
            self.cfg.hop = int(meta[10])
        if len(meta) > 11:
            self.cfg.tracker_tolerance = float(meta[11])
        if len(meta) > 12:
            self.cfg.max_cycles = int(meta[12])
        self._dirty = True
        self.logger.info("META count=%d ts=%d max_cycles=%d", int(len(meta)), int(ts), int(self.cfg.max_cycles))

    def process_full(self, series: np.ndarray, ts: int) -> np.ndarray:
        self._ingest_full(series)
        self._compute_cycles()
        out = self._render_full()
        if series is not None and len(series) > 0:
            self.logger.info(
                "RX FULL count=%d v0=%.6f vN=%.6f ts=%d",
                int(len(series)),
                float(series[0]),
                float(series[-1]),
                int(ts),
            )
        if out is not None and len(out) > 0:
            self.logger.info(
                "TX FULL count=%d v0=%.6f vN=%.6f",
                int(len(out)),
                float(out[0]),
                float(out[-1]),
            )
        return out

    def process_update(self, series: np.ndarray, ts: int) -> np.ndarray:
        if self.series is None:
            return np.array([], dtype=np.float64)
        self._ingest_update(series)
        if self._dirty or self._last_nfft <= 0:
            self._compute_cycles()
        out = self._render_update()
        if series is not None and len(series) > 0:
            self.logger.info(
                "RX UPDATE count=%d v0=%.6f vN=%.6f ts=%d",
                int(len(series)),
                float(series[0]),
                float(series[-1]),
                int(ts),
            )
        if out is not None and len(out) > 0:
            self.logger.info(
                "TX UPDATE count=%d v0=%.6f",
                int(len(out)),
                float(out[0]),
            )
        return out

    # ---------------------------
    # Internal helpers
    # ---------------------------

    def _ingest_full(self, series: np.ndarray) -> None:
        s = np.asarray(series, dtype=np.float64)
        s = np.nan_to_num(s, nan=0.0, posinf=0.0, neginf=0.0)
        s = s[::-1]  # chronological (oldest -> newest)

        max_bars = self.cfg.max_bars if self.cfg.max_bars > 0 else None
        if max_bars and s.size > max_bars:
            s = s[-max_bars:]

        self.series = s.copy()
        self._dirty = True

    def _ingest_update(self, series: np.ndarray) -> None:
        upd = np.asarray(series, dtype=np.float64)
        upd = np.nan_to_num(upd, nan=0.0, posinf=0.0, neginf=0.0)
        upd = upd[::-1]  # chronological

        if upd.size == 0:
            return

        self.series = np.concatenate([self.series, upd])  # type: ignore[arg-type]

        max_bars = self.cfg.max_bars if self.cfg.max_bars > 0 else None
        max_keep = max_bars or (self.max_keep if self.max_keep else None)
        if max_keep and self.series.size > max_keep:
            overflow = int(self.series.size - max_keep)
            self.series = self.series[overflow:]
            self._dirty = True

    def _effective_cycles(self) -> int:
        max_cycles = int(self.cfg.max_cycles)
        if max_cycles <= 0:
            max_cycles = self.buffers
        return max(1, min(self.buffers, max_cycles))

    def _select_indices(self, periods: np.ndarray, power: np.ndarray, max_cycles: int) -> List[int]:
        if periods.size == 0:
            return []

        tol = float(self.cfg.tracker_tolerance or 0.0)
        selected: List[int] = []
        used = set()

        if tol > 0 and self._last_periods:
            for prev in self._last_periods:
                diffs = np.abs(periods - float(prev))
                cand = np.where(diffs <= tol)[0]
                if cand.size <= 0:
                    continue
                if self.cfg.sort_by_power:
                    best = cand[int(np.argmax(power[cand]))]
                else:
                    best = cand[int(np.argmin(diffs[cand]))]
                if best in used:
                    continue
                selected.append(int(best))
                used.add(int(best))

        if self.cfg.sort_by_power:
            order = np.argsort(power)[::-1]
        else:
            order = np.argsort(periods)

        for idx in order:
            i = int(idx)
            if i in used:
                continue
            selected.append(i)
            if len(selected) >= max_cycles:
                break

        return selected[:max_cycles]

    def _compute_cycles(self) -> None:
        self._active[:] = False
        self._amp[:] = 0.0
        self._phase[:] = 0.0
        self._k[:] = 0
        self._last_periods = []
        self._last_nfft = 0
        self._last_t0 = 0
        self._dirty = False

        if self.series is None:
            return
        n_total = int(self.series.size)
        if n_total < 8:
            return

        n_fft = int(self.cfg.fft_window) if self.cfg.fft_window > 0 else n_total
        n_fft = max(8, min(n_fft, n_total))
        x = self.series[-n_fft:]
        x = _detrend(x, self.cfg.trend_period)

        win = _window(int(self.cfg.window_type), n_fft)
        if win.size == n_fft:
            x = x * win

        X = np.fft.rfft(x)
        if X.size <= 1:
            return

        k_all = np.arange(1, X.size)
        periods = n_fft / k_all.astype(np.float64)
        mask = (periods >= float(self.cfg.min_period)) & (periods <= float(self.cfg.max_period))
        if not np.any(mask):
            return

        k_sel = k_all[mask]
        p_sel = periods[mask]
        power = (np.abs(X[k_sel]) ** 2).astype(np.float64)

        max_cycles = self._effective_cycles()
        sel_idx = self._select_indices(p_sel, power, max_cycles)
        if not sel_idx:
            return

        self._last_nfft = n_fft
        self._last_t0 = n_total - n_fft

        for i, idx in enumerate(sel_idx):
            k = int(k_sel[idx])
            amp = (2.0 / n_fft) * float(np.abs(X[k]))
            phase = float(np.angle(X[k]))
            if i >= self.buffers:
                break
            self._k[i] = k
            self._amp[i] = amp
            self._phase[i] = phase
            self._active[i] = True
            self._last_periods.append(float(p_sel[idx]))

    def _render_full(self) -> np.ndarray:
        if self.series is None:
            return np.array([], dtype=np.float64)
        n_total = int(self.series.size)
        if n_total <= 0:
            return np.array([], dtype=np.float64)

        t = np.arange(n_total, dtype=np.float64)
        t0 = float(self._last_t0)
        freq_base = 2.0 * math.pi / float(self._last_nfft or max(1, n_total))

        if self.cfg.sum_cycles:
            acc = np.zeros(n_total, dtype=np.float64)
            for i in range(self.buffers):
                if not self._active[i]:
                    continue
                acc += self._amp[i] * np.cos(freq_base * self._k[i] * (t - t0) + self._phase[i])
            return acc[::-1].astype(np.float64)

        buffers: List[np.ndarray] = []
        for i in range(self.buffers):
            if self._active[i]:
                wave = self._amp[i] * np.cos(freq_base * self._k[i] * (t - t0) + self._phase[i])
            else:
                wave = np.zeros(n_total, dtype=np.float64)
            buffers.append(wave[::-1])
        return np.concatenate(buffers).astype(np.float64)

    def _render_update(self) -> np.ndarray:
        if self.series is None or self.series.size <= 0:
            return np.array([], dtype=np.float64)
        n_total = int(self.series.size)
        if self._last_nfft <= 0:
            return np.array([], dtype=np.float64)

        t = float(n_total - 1)
        t0 = float(self._last_t0)
        freq_base = 2.0 * math.pi / float(self._last_nfft)

        if self.cfg.sum_cycles:
            val = 0.0
            for i in range(self.buffers):
                if not self._active[i]:
                    continue
                val += self._amp[i] * np.cos(freq_base * self._k[i] * (t - t0) + self._phase[i])
            return np.array([val], dtype=np.float64)

        out = np.zeros(self.buffers, dtype=np.float64)
        for i in range(self.buffers):
            if not self._active[i]:
                continue
            out[i] = self._amp[i] * np.cos(freq_base * self._k[i] * (t - t0) + self._phase[i])
        return out.astype(np.float64)
