"""PyShared integrated client + dominant-cycle wave engine.

This file replaces the "plugin" step by embedding the full processing pipeline.

Architecture (as requested):
  - Python client connects to MetaTrader via the shared-memory DLL (PyShared/PyBridge).
  - MQL5 indicator sends price arrays (full or incremental) on stream 0.
  - Python computes the dominant-cycle wave and writes results to stream 1.

Protocol notes (consistent with the provided mq5):
  - stream 0: MT5 -> PY
      series_id 900: META (optional; config + timing)
      series_id 100: FULL price window (series array; index 0 = most recent)
      series_id 101: UPDATE (usually one bar; series array)
  - stream 1: PY -> MT5
      series_id 201: FULL wave output (series array)
      series_id 202: UPDATE wave output (usually one value; series array)

Important practical point:
  - To avoid repainting the whole history every timer tick, this client returns:
      * FULL output when a FULL input arrives
      * only the most recent value when an UPDATE input arrives
    (the indicator already supports this, because it only overwrites Out[0..got-1]).

Dependencies:
  - numpy
  - scipy (for stft/istft)
  - cupy + cupyx.scipy.signal (optional; GPU backend)
"""

from __future__ import annotations

import argparse
import ctypes as ct
import json
import logging
import math
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, Optional, Sequence, Tuple, Union

import numpy as np
import scipy.signal as spsig  # used for get_window even when GPU backend is enabled


# ============================================================
# Backend: CuPy preferred, NumPy/SciPy fallback
# ============================================================


def _get_backend(prefer: Literal["cupy", "numpy"] = "cupy"):
    if prefer == "cupy":
        try:
            import cupy as cp  # type: ignore
            import cupyx.scipy.signal as cpsig  # type: ignore

            # Defensive: some minimal CuPy installs may not ship the STFT helpers.
            if hasattr(cpsig, "stft") and hasattr(cpsig, "istft"):
                return cp, cpsig, "cupy"
        except Exception:
            pass
    import scipy.signal as spsig  # type: ignore

    return np, spsig, "numpy"


def _to_cpu(x: Any) -> np.ndarray:
    try:
        import cupy as cp  # type: ignore

        if isinstance(x, cp.ndarray):
            return cp.asnumpy(x)
    except Exception:
        pass
    return np.asarray(x)


def _wrap_pi(x: Any, xp: Any) -> Any:
    pi = xp.asarray(math.pi, dtype=xp.float64)
    two_pi = xp.asarray(2.0 * math.pi, dtype=xp.float64)
    return (x + pi) % two_pi - pi


def _wrap_pi_scalar(x: float) -> float:
    return (x + math.pi) % (2.0 * math.pi) - math.pi


# ============================================================
# DLL bridge
# ============================================================


class PySharedBridge:
    def __init__(self, dll_path: str):
        self.dll_path = dll_path
        self.dll = ct.WinDLL(dll_path)

        self.dll.PB_Init.argtypes = [ct.c_wchar_p, ct.c_longlong]
        self.dll.PB_Init.restype = ct.c_int

        self.dll.PB_Close.argtypes = []
        self.dll.PB_Close.restype = None

        self.dll.PB_MaxDoubles.argtypes = []
        self.dll.PB_MaxDoubles.restype = ct.c_int

        self.dll.PB_WriteDoubles.argtypes = [
            ct.c_int,
            ct.c_int,
            ct.POINTER(ct.c_double),
            ct.c_int,
            ct.c_longlong,
        ]
        self.dll.PB_WriteDoubles.restype = ct.c_int

        self.dll.PB_ReadDoubles.argtypes = [
            ct.c_int,
            ct.POINTER(ct.c_int),
            ct.POINTER(ct.c_double),
            ct.c_int,
            ct.POINTER(ct.c_int),
            ct.POINTER(ct.c_longlong),
        ]
        self.dll.PB_ReadDoubles.restype = ct.c_int

        # v2 DLL (queue): read-next (FIFO). If absent, we fall back to PB_ReadDoubles.
        self._has_read_next = hasattr(self.dll, "PB_ReadNextDoubles")
        if self._has_read_next:
            self.dll.PB_ReadNextDoubles.argtypes = [
                ct.c_int,
                ct.POINTER(ct.c_int),
                ct.POINTER(ct.c_double),
                ct.c_int,
                ct.POINTER(ct.c_int),
                ct.POINTER(ct.c_longlong),
            ]
            self.dll.PB_ReadNextDoubles.restype = ct.c_int

        self.max_doubles: int = 0
        self._buf: Any = None

    def connect(self, channel: str, capacity_bytes: int) -> None:
        if self.dll.PB_Init(channel, int(capacity_bytes)) != 1:
            raise RuntimeError("PB_Init failed (check DLL imports, channel, permissions)")
        self.max_doubles = int(self.dll.PB_MaxDoubles())
        if self.max_doubles <= 0:
            raise RuntimeError("PB_MaxDoubles returned 0")
        self._buf = (ct.c_double * self.max_doubles)()

    def close(self) -> None:
        try:
            self.dll.PB_Close()
        except Exception:
            pass

    def read(self, stream: int) -> Tuple[int, np.ndarray, int]:
        """Returns (series_id, data, ts). If no message: (0, empty, 0)."""
        sid = ct.c_int()
        got = ct.c_int()
        ts = ct.c_longlong()

        r = int(
            self.dll.PB_ReadDoubles(
                int(stream), ct.byref(sid), self._buf, int(self.max_doubles), ct.byref(got), ct.byref(ts)
            )
        )

        if r <= 0 or int(got.value) <= 0:
            return 0, np.zeros((0,), dtype=np.float64), 0

        n = int(got.value)
        # Copy to numpy
        x = np.frombuffer(ct.string_at(self._buf, n * 8), dtype=np.float64).copy()
        return int(sid.value), x, int(ts.value)

    def read_next(self, stream: int) -> Tuple[int, np.ndarray, int]:
        """FIFO read if supported (v2 DLL)."""
        if not self._has_read_next:
            return self.read(stream)

        sid = ct.c_int()
        got = ct.c_int()
        ts = ct.c_longlong()

        r = int(
            self.dll.PB_ReadNextDoubles(
                int(stream), ct.byref(sid), self._buf, int(self.max_doubles), ct.byref(got), ct.byref(ts)
            )
        )

        if r <= 0 or int(got.value) <= 0:
            return 0, np.zeros((0,), dtype=np.float64), 0

        n = int(got.value)
        x = np.frombuffer(ct.string_at(self._buf, n * 8), dtype=np.float64).copy()
        return int(sid.value), x, int(ts.value)

    def write(self, stream: int, series_id: int, arr: np.ndarray, ts: int) -> int:
        arr = np.asarray(arr, dtype=np.float64)
        if arr.size <= 0:
            return 0
        ptr = arr.ctypes.data_as(ct.POINTER(ct.c_double))
        return int(self.dll.PB_WriteDoubles(int(stream), int(series_id), ptr, int(arr.size), int(ts)))


# ============================================================
# Wave engine config
# ============================================================


@dataclass
class EngineConfig:
    # Data interpretation
    fs: float = 1.0  # samples per bar
    use_log_price: bool = True
    detrend_linear: bool = True

    # STFT/ISTFT
    window: Union[str, Tuple[str, float], np.ndarray] = "hann"
    nperseg: int = 16384
    noverlap: int = 16128
    nfft: int = 65536
    return_onesided: bool = True
    scaling: Literal["spectrum", "psd"] = "spectrum"
    # Using boundary padding makes ISTFT well-posed at the signal edges (avoids NOLA warnings).
    # This does NOT add latency; it only defines the boundary condition outside the finite window.
    boundary: Optional[str] = "zeros"
    padded: bool = True

    # Dominant-cycle band (period in bars)
    min_period_bars: float = 10.0
    max_period_bars: float = 200.0

    # Ridge + harmonic score
    ridge_penalty: float = 0.20
    score_harmonics: int = 3
    score_weights: Optional[Tuple[float, ...]] = None
    power_eps: float = 1e-20

    # Mask (reconstruction)
    sigma_bins_fund: float = 3.0
    sigma_bins_harm: float = 3.0
    mask_max_harmonic: int = 3
    mask_truncate: float = 4.0

    # Baseline via low-pass mask
    baseline_enable: bool = True
    baseline_cutoff_period_bars: float = 800.0

    # Prediction (enabled by default, phase projection by default)
    prediction_enable: bool = True
    prediction_method: Literal["phase", "ar", "hybrid", "gbm_mc"] = "phase"

    # AR
    ar_order: int = 64
    ar_fit_len: int = 8192
    ar_reg: float = 1e-6

    # GBM MC
    gbm_paths: int = 4096
    gbm_seed: Optional[int] = None

    # Anti-noise gate
    min_confidence: float = 0.10

    # Output
    output_mode: Literal["cycle", "price_wave"] = "price_wave"
    update_returns_full: bool = False
    predict_wave_horizon: int = 0


@dataclass
class EngineState:
    initialized: bool = False
    phi_end_cont: float = 0.0
    z_end_prev: complex = 0.0 + 0.0j
    last_bar_ts: int = 0
    # price buffer in chronological order (oldest -> newest)
    price_chrono: Optional[np.ndarray] = None
    # cached full output (series orientation) for no-repaint updates
    last_full_out_series: Optional[np.ndarray] = None


# ============================================================
# Internal helpers: detrend, prediction, score, ridge, masks
# ============================================================


def _linear_detrend(x: Any, xp: Any) -> tuple[Any, Any, float, float]:
    x = xp.asarray(x, dtype=xp.float64)
    N = int(x.shape[0])
    n = xp.arange(N, dtype=xp.float64)
    n_mean = xp.mean(n)
    x_mean = xp.mean(x)
    cov = xp.mean((n - n_mean) * (x - x_mean))
    var = xp.mean((n - n_mean) ** 2)
    a = cov / var
    b = x_mean - a * n_mean
    trend = a * n + b
    return x - trend, trend, float(_to_cpu(a)), float(_to_cpu(b))


def _coeff_to_amplitude(absC: float, cfg: EngineConfig) -> float:
    if cfg.scaling == "spectrum":
        return 2.0 * absC
    # psd -> approximate conversion
    win_np = spsig.get_window(cfg.window, int(cfg.nperseg), fftbins=True)
    sumw = float(win_np.sum())
    sumw2 = float((win_np**2).sum())
    return 2.0 * absC * math.sqrt(float(cfg.fs) * sumw2) / sumw


def _predict_future_phase(horizon: int, amp: float, phi_end: float, omega: float, xp: Any) -> Any:
    if horizon <= 0:
        return xp.zeros((0,), dtype=xp.float64)
    k = xp.arange(1, horizon + 1, dtype=xp.float64)
    return xp.asarray(amp, dtype=xp.float64) * xp.cos(
        xp.asarray(phi_end, dtype=xp.float64) + xp.asarray(omega, dtype=xp.float64) * k
    )


def _ar_fit_and_predict(x: Any, horizon: int, *, order: int, fit_len: int, reg: float, xp: Any) -> Any:
    x = xp.asarray(x, dtype=xp.float64)
    N = int(x.shape[0])
    if horizon <= 0:
        return xp.zeros((0,), dtype=xp.float64)
    if N <= order + 2:
        raise ValueError("Need N > order+2 for AR")
    L = min(int(fit_len), N)
    x_fit = x[N - L :]
    Nf = int(x_fit.shape[0])
    if Nf <= order + 2:
        raise ValueError("fit_len too small")

    y = x_fit[order:]
    cols = []
    for i in range(1, order + 1):
        cols.append(x_fit[order - i : Nf - i])
    X = xp.stack(cols, axis=1)
    XtX = X.T @ X + float(reg) * xp.eye(order, dtype=xp.float64)
    Xty = X.T @ y
    a = xp.linalg.solve(XtX, Xty)

    hist = x[-order:].astype(xp.float64).copy()
    out = xp.empty((horizon,), dtype=xp.float64)
    for k in range(horizon):
        yhat = a @ hist[::-1]
        out[k] = yhat
        hist = xp.concatenate([hist[1:], out[k : k + 1]], axis=0)
    return out


def _gbm_mc_predict_logprice(logp: Any, horizon: int, *, n_paths: int, seed: Optional[int], xp: Any) -> Any:
    logp = xp.asarray(logp, dtype=xp.float64)
    if horizon <= 0:
        return xp.zeros((0,), dtype=xp.float64)

    r = logp[1:] - logp[:-1]
    mu = xp.mean(r)
    sigma = xp.std(r)

    if seed is not None:
        try:
            xp.random.seed(int(seed))
        except Exception:
            pass

    Z = xp.random.standard_normal((int(n_paths), int(horizon)), dtype=xp.float64)
    drift = (mu - 0.5 * sigma * sigma)
    inc = drift + sigma * Z
    logp0 = logp[-1]
    paths = logp0 + xp.cumsum(inc, axis=1)
    return xp.mean(paths, axis=0)


def _harmonic_score_matrix(
    logP: Any,
    f_axis: Any,
    band_idx: Any,
    *,
    fs: float,
    max_m: int,
    weights: Optional[Sequence[float]],
    xp: Any,
) -> Any:
    band_idx = band_idx.astype(xp.int32, copy=False)
    f_band = f_axis[band_idx].astype(xp.float64)
    score = logP[band_idx, :].astype(xp.float64)
    if max_m < 2:
        return score
    if weights is None:
        w = [0.0] * (max_m + 1)
        for m in range(2, max_m + 1):
            w[m] = 0.5 / float(m)
        weights = w
    else:
        if len(weights) < max_m + 1:
            raise ValueError("score_weights length must be >= max_m+1")

    df = float(_to_cpu(f_axis[1] - f_axis[0]))
    nyq = fs / 2.0
    nF = int(f_axis.shape[0])
    for m in range(2, max_m + 1):
        wm = float(weights[m])
        if wm == 0.0:
            continue
        f_target = f_band * float(m)
        valid = f_target <= nyq * 0.999999
        idx = xp.rint(f_target / df).astype(xp.int32)
        idx = xp.clip(idx, 0, nF - 1)
        idx = xp.where(valid, idx, xp.asarray(0, dtype=xp.int32))
        score = score + wm * logP[idx, :]
    return score


def _causal_ridge(score_band: Any, band_full_idx: Any, penalty: float, xp: Any) -> Any:
    K, T = int(score_band.shape[0]), int(score_band.shape[1])
    band_full_idx = band_full_idx.astype(xp.int32, copy=False)
    ridge = xp.empty((T,), dtype=xp.int32)
    k0 = int(_to_cpu(xp.argmax(score_band[:, 0])))
    k_prev_full = band_full_idx[k0]
    ridge[0] = k_prev_full
    for t in range(1, T):
        diff = band_full_idx.astype(xp.float64) - k_prev_full.astype(xp.float64)
        s = score_band[:, t] - float(penalty) * diff * diff
        kt = int(_to_cpu(xp.argmax(s)))
        k_prev_full = band_full_idx[kt]
        ridge[t] = k_prev_full
    return ridge


def _phase_vocoder_ridge(Zxx: Any, ridge_idx: Any, f_axis: Any, *, fs: float, hop: int, xp: Any):
    T = int(Zxx.shape[1])
    tt = xp.arange(T, dtype=xp.int32)
    C = Zxx[ridge_idx, tt]
    absC = xp.abs(C).astype(xp.float64)
    phi_obs = xp.angle(C).astype(xp.float64)
    two_pi = xp.asarray(2.0 * math.pi, dtype=xp.float64)
    omega_bin = two_pi * f_axis[ridge_idx].astype(xp.float64) / float(fs)
    omega_inst = omega_bin.copy()
    if T >= 2:
        dphi = phi_obs[1:] - phi_obs[:-1] - omega_bin[1:] * float(hop)
        dphi = _wrap_pi(dphi, xp)
        omega_inst[1:] = omega_bin[1:] + dphi / float(hop)
    phi_cont = xp.empty_like(phi_obs)
    phi_cont[0] = phi_obs[0]
    if T >= 2:
        phi_cont[1:] = phi_cont[0] + xp.cumsum(omega_inst[1:] * float(hop))
    return C, absC, phi_obs, omega_bin, omega_inst, phi_cont


def _gaussian_mask(n_freq: int, ridge_idx: Any, sigma_bins: float, truncate: float, xp: Any) -> Any:
    f = xp.arange(int(n_freq), dtype=xp.float64)[:, None]
    r = ridge_idx.astype(xp.float64, copy=False)[None, :]
    d = (f - r) / float(sigma_bins)
    m = xp.exp(-0.5 * d * d)
    if truncate and truncate > 0:
        m = xp.where(xp.abs(d) > float(truncate), xp.asarray(0.0, dtype=xp.float64), m)
    return m


def _mask_with_harmonics(
    f_axis: Any,
    ridge_idx: Any,
    *,
    fs: float,
    sigma_fund: float,
    sigma_harm: float,
    max_harm: int,
    truncate: float,
    xp: Any,
) -> tuple[Any, Any]:
    nF = int(f_axis.shape[0])
    mask_fund = _gaussian_mask(nF, ridge_idx, float(sigma_fund), float(truncate), xp)
    mask_total = mask_fund
    if int(max_harm) < 2:
        return mask_fund, mask_total

    df = float(_to_cpu(f_axis[1] - f_axis[0]))
    nyq = fs / 2.0
    ridge_freq = f_axis[ridge_idx].astype(xp.float64)
    for m in range(2, int(max_harm) + 1):
        f_target = ridge_freq * float(m)
        valid = f_target <= (nyq * 0.999999)
        idx = xp.rint(f_target / df).astype(xp.int32)
        idx = xp.clip(idx, 0, nF - 1)
        idx = xp.where(valid, idx, xp.asarray(-10_000, dtype=xp.int32))
        mask_m = _gaussian_mask(nF, idx, float(sigma_harm), float(truncate), xp)
        mask_total = xp.maximum(mask_total, mask_m)
    return mask_fund, mask_total


def _fix_len(y: Any, L: int, xp: Any) -> Any:
    y = xp.asarray(y)
    if int(y.shape[0]) >= L:
        return y[:L]
    return xp.pad(y, (0, L - int(y.shape[0])), mode="constant")


# ============================================================
# Meta parsing (indicator -> python)
# ============================================================


def _meta_decode_prediction_method(code: int) -> Literal["phase", "ar", "hybrid", "gbm_mc"]:
    return {0: "phase", 1: "ar", 2: "hybrid", 3: "gbm_mc"}.get(int(code), "phase")


def update_config_from_meta(cfg: EngineConfig, meta: np.ndarray, logger: logging.Logger) -> None:
    """Supports old meta len=3 and new meta len>=24."""
    if meta.size < 3:
        return

    # Old: [in_sec, out_sec, out_bars]
    if meta.size < 24:
        in_sec = float(meta[0])
        # We keep fs=1 sample/bar. Periods are in bars. No change needed.
        logger.debug("META(v1): in_sec=%.0f (ignored), out_sec=%.0f out_bars=%.0f", float(meta[0]), float(meta[1]), float(meta[2]))
        return

    # New meta (v2)
    # idx map (see mq5 v2 below)
    proto = int(meta[0])
    if proto != 2:
        logger.debug("META proto=%d (expected 2)", proto)

    # meta[1]=in_sec, meta[2]=out_sec, meta[3]=out_bars, meta[4]=send_bars
    cfg.min_period_bars = float(meta[5])
    cfg.max_period_bars = float(meta[6])
    cfg.nperseg = int(meta[7])
    cfg.noverlap = int(meta[8])
    cfg.nfft = int(meta[9])
    cfg.ridge_penalty = float(meta[10])
    cfg.score_harmonics = int(meta[11])
    cfg.mask_max_harmonic = int(meta[12])
    cfg.sigma_bins_fund = float(meta[13])
    cfg.sigma_bins_harm = float(meta[14])
    cfg.baseline_enable = bool(int(meta[15]) != 0)
    cfg.baseline_cutoff_period_bars = float(meta[16])
    cfg.min_confidence = float(meta[17])
    cfg.prediction_method = _meta_decode_prediction_method(int(meta[18]))
    cfg.ar_order = int(meta[19])
    cfg.ar_fit_len = int(meta[20])
    cfg.ar_reg = float(meta[21])
    cfg.predict_wave_horizon = int(meta[22])
    cfg.output_mode = "price_wave" if int(meta[23]) != 0 else "cycle"
    # optionally: meta[24]=use_log, meta[25]=detrend_linear, meta[26]=update_full
    if meta.size >= 27:
        cfg.use_log_price = bool(int(meta[24]) != 0)
        cfg.detrend_linear = bool(int(meta[25]) != 0)
        cfg.update_returns_full = bool(int(meta[26]) != 0)


# ============================================================
# Core algorithm: full pipeline
# ============================================================


def compute_wave_pipeline(
    price_chrono: np.ndarray,
    cfg: EngineConfig,
    *,
    backend: Literal["cupy", "numpy"],
    state: EngineState,
) -> Tuple[np.ndarray, float, float, float, float, float]:
    """Returns (out_chrono, f0_end, period_end, phi_end, amp_end, conf_end)."""
    xp, signal, _name = _get_backend(backend)

    price = xp.asarray(price_chrono, dtype=xp.float64)
    N = int(price.shape[0])

    if cfg.use_log_price:
        if bool(xp.any(price <= 0)):
            raise ValueError("Price must be > 0 for log")
        x_raw = xp.log(price)
    else:
        x_raw = price

    if cfg.detrend_linear:
        x_proc, trend, a, b = _linear_detrend(x_raw, xp)
    else:
        trend = xp.zeros_like(x_raw)
        x_proc = x_raw - xp.mean(x_raw)
        a = 0.0
        b = float(_to_cpu(xp.mean(x_raw)))

    nperseg = int(cfg.nperseg)
    noverlap = int(cfg.noverlap)
    hop = nperseg - noverlap
    if hop <= 0:
        raise ValueError("nperseg-noverlap must be > 0")
    nfft = int(cfg.nfft)
    if nfft < nperseg:
        raise ValueError("nfft must be >= nperseg")

    # cupyx.scipy.signal may not expose check_NOLA in every build; fall back to scipy.
    check_nola = getattr(signal, "check_NOLA", None)
    if check_nola is None:
        check_nola = spsig.check_NOLA
    if not bool(check_nola(cfg.window, nperseg, noverlap)):
        raise ValueError("NOLA violated: adjust window/noverlap")

    # Band (period in bars)
    if cfg.min_period_bars <= 0 or cfg.max_period_bars <= 0 or cfg.min_period_bars >= cfg.max_period_bars:
        raise ValueError("Invalid period band")
    f_low = float(cfg.fs) / float(cfg.max_period_bars)
    f_high = float(cfg.fs) / float(cfg.min_period_bars)

    # PASS 1: historical STFT (no future)
    f1, t1, Z1 = signal.stft(
        x_proc,
        fs=float(cfg.fs),
        window=cfg.window,
        nperseg=nperseg,
        noverlap=noverlap,
        nfft=nfft,
        detrend=False,
        return_onesided=cfg.return_onesided,
        boundary=cfg.boundary,
        padded=cfg.padded,
        axis=-1,
        scaling=cfg.scaling,
    )
    P1 = xp.abs(Z1) ** 2
    logP1 = xp.log(P1 + float(cfg.power_eps))

    band1 = (f1 >= f_low) & (f1 <= f_high) & (f1 > 0)
    if not bool(xp.any(band1)):
        raise ValueError("No bins in band; increase nfft or adjust period band")
    band_idx = xp.where(band1)[0].astype(xp.int32)

    score1 = _harmonic_score_matrix(
        logP1, f_axis=f1, band_idx=band_idx, fs=float(cfg.fs), max_m=int(cfg.score_harmonics), weights=cfg.score_weights, xp=xp
    )
    ridge1 = _causal_ridge(score1, band_full_idx=band_idx, penalty=float(cfg.ridge_penalty), xp=xp)

    C1, absC1, phi_obs1, omega_bin1, omega_inst1, phi_cont1 = _phase_vocoder_ridge(
        Z1, ridge_idx=ridge1, f_axis=f1, fs=float(cfg.fs), hop=hop, xp=xp
    )

    m_last = int(Z1.shape[1]) - 1
    center_last = int(round(float(_to_cpu(t1[m_last])) * float(cfg.fs)))
    dt_to_end = (N - 1) - center_last
    if dt_to_end < 0:
        dt_to_end = 0

    omega0 = float(_to_cpu(omega_inst1[m_last]))
    phi0_center = float(_to_cpu(phi_cont1[m_last]))
    phi_end0 = phi0_center + omega0 * float(dt_to_end)

    ridge_pow_last = float(_to_cpu(P1[ridge1[m_last], m_last]))
    band_pow_last = float(_to_cpu(xp.sum(P1[band_idx, m_last])))
    conf0 = ridge_pow_last / (band_pow_last + float(cfg.power_eps))

    amp0 = _coeff_to_amplitude(float(_to_cpu(absC1[m_last])), cfg)
    if conf0 < float(cfg.min_confidence):
        amp0 = 0.0
        omega0 = 0.0

    # Prediction horizon required for end-centered symmetry
    L_need = nperseg // 2
    if not cfg.prediction_enable:
        x_future = xp.zeros((L_need,), dtype=xp.float64)
    else:
        if cfg.prediction_method == "phase":
            x_future = _predict_future_phase(L_need, amp0, phi_end0, omega0, xp)
        elif cfg.prediction_method == "ar":
            x_future = _ar_fit_and_predict(
                x_proc, L_need, order=int(cfg.ar_order), fit_len=int(cfg.ar_fit_len), reg=float(cfg.ar_reg), xp=xp
            )
        elif cfg.prediction_method == "hybrid":
            x_phase = _predict_future_phase(L_need, amp0, phi_end0, omega0, xp)
            x_ar = _ar_fit_and_predict(
                x_proc, L_need, order=int(cfg.ar_order), fit_len=int(cfg.ar_fit_len), reg=float(cfg.ar_reg), xp=xp
            )
            x_future = x_phase + 0.5 * (x_ar - x_phase)
        elif cfg.prediction_method == "gbm_mc":
            if not cfg.use_log_price:
                raise ValueError("gbm_mc requires use_log_price=True")
            logp_fut = _gbm_mc_predict_logprice(x_raw, L_need, n_paths=int(cfg.gbm_paths), seed=cfg.gbm_seed, xp=xp)
            n_fut = xp.arange(N, N + L_need, dtype=xp.float64)
            trend_fut = xp.asarray(a, dtype=xp.float64) * n_fut + xp.asarray(b, dtype=xp.float64)
            x_future = logp_fut - trend_fut
        else:
            raise ValueError("Unknown prediction_method")

    # If padded=False, guarantee coverage for ISTFT overlap-add
    if not cfg.padded:
        N_ext0 = N + int(x_future.shape[0])
        r = (N_ext0 - nperseg) % hop
        extra = (hop - r) % hop
        if extra:
            if cfg.prediction_enable and cfg.prediction_method in ("phase", "hybrid") and (amp0 > 0) and (omega0 != 0.0):
                k0 = int(x_future.shape[0])
                k = xp.arange(k0 + 1, k0 + extra + 1, dtype=xp.float64)
                x_extra = xp.asarray(amp0, dtype=xp.float64) * xp.cos(
                    xp.asarray(phi_end0, dtype=xp.float64) + xp.asarray(omega0, dtype=xp.float64) * k
                )
            else:
                x_extra = xp.zeros((extra,), dtype=xp.float64)
            x_future = xp.concatenate([x_future, x_extra], axis=0)

    x_proc_ext = xp.concatenate([x_proc, x_future.astype(xp.float64, copy=False)], axis=0)

    # PASS 2: STFT on extended series
    f, t, Zxx = signal.stft(
        x_proc_ext,
        fs=float(cfg.fs),
        window=cfg.window,
        nperseg=nperseg,
        noverlap=noverlap,
        nfft=nfft,
        detrend=False,
        return_onesided=cfg.return_onesided,
        boundary=cfg.boundary,
        padded=cfg.padded,
        axis=-1,
        scaling=cfg.scaling,
    )
    P = xp.abs(Zxx) ** 2
    logP = xp.log(P + float(cfg.power_eps))

    band = (f >= f_low) & (f <= f_high) & (f > 0)
    band_idx2 = xp.where(band)[0].astype(xp.int32)
    score = _harmonic_score_matrix(
        logP, f_axis=f, band_idx=band_idx2, fs=float(cfg.fs), max_m=int(cfg.score_harmonics), weights=cfg.score_weights, xp=xp
    )
    ridge = _causal_ridge(score, band_full_idx=band_idx2, penalty=float(cfg.ridge_penalty), xp=xp)

    # confidence per frame
    T = int(Zxx.shape[1])
    tt = xp.arange(T, dtype=xp.int32)
    ridge_pow = P[ridge, tt]
    band_pow = xp.sum(P[band_idx2, :], axis=0)
    ridge_conf = ridge_pow / (band_pow + float(cfg.power_eps))

    # masks
    mask_fund, mask_total = _mask_with_harmonics(
        f_axis=f,
        ridge_idx=ridge,
        fs=float(cfg.fs),
        sigma_fund=float(cfg.sigma_bins_fund),
        sigma_harm=float(cfg.sigma_bins_harm),
        max_harm=int(cfg.mask_max_harmonic),
        truncate=float(cfg.mask_truncate),
        xp=xp,
    )
    Z_wave = Zxx * mask_total
    Z_fund = Zxx * mask_fund

    if cfg.baseline_enable:
        if cfg.baseline_cutoff_period_bars <= cfg.max_period_bars:
            raise ValueError("baseline_cutoff_period_bars must be > max_period_bars")
        f_base_max = float(cfg.fs) / float(cfg.baseline_cutoff_period_bars)
        base_mask = ((f >= 0) & (f <= f_base_max)).astype(xp.float64)[:, None]
        Z_base = Zxx * base_mask
    else:
        Z_base = xp.zeros_like(Zxx)

    boundary_flag = cfg.boundary is not None

    _, wave_rich_ext = signal.istft(
        Z_wave,
        fs=float(cfg.fs),
        window=cfg.window,
        nperseg=nperseg,
        noverlap=noverlap,
        nfft=nfft,
        input_onesided=cfg.return_onesided,
        boundary=boundary_flag,
        time_axis=-1,
        freq_axis=-2,
        scaling=cfg.scaling,
    )
    _, cycle_fund_ext = signal.istft(
        Z_fund,
        fs=float(cfg.fs),
        window=cfg.window,
        nperseg=nperseg,
        noverlap=noverlap,
        nfft=nfft,
        input_onesided=cfg.return_onesided,
        boundary=boundary_flag,
        time_axis=-1,
        freq_axis=-2,
        scaling=cfg.scaling,
    )
    _, baseline_ext = signal.istft(
        Z_base,
        fs=float(cfg.fs),
        window=cfg.window,
        nperseg=nperseg,
        noverlap=noverlap,
        nfft=nfft,
        input_onesided=cfg.return_onesided,
        boundary=boundary_flag,
        time_axis=-1,
        freq_axis=-2,
        scaling=cfg.scaling,
    )

    L_ext = int(x_proc_ext.shape[0])
    wave_rich_ext = _fix_len(wave_rich_ext, L_ext, xp)
    cycle_fund_ext = _fix_len(cycle_fund_ext, L_ext, xp)
    baseline_ext = _fix_len(baseline_ext, L_ext, xp)

    wave_rich_x = wave_rich_ext[:N]
    baseline_x = baseline_ext[:N] if cfg.baseline_enable else xp.zeros_like(wave_rich_x)

    # End-centered evaluation at n_end=N-1 (center = last sample)
    # Build end-centered FFT using x_proc_ext (already has predicted future)
    n_end = N - 1
    start = n_end - (nperseg // 2)
    end = start + nperseg
    if start < 0 or end > L_ext:
        # fallback: use last frame from t[]
        m_last2 = int(Zxx.shape[1]) - 1
        k_end = int(_to_cpu(ridge[m_last2]))
        f0_end = float(_to_cpu(f[k_end]))
        period_end = float(cfg.fs) / f0_end if f0_end > 0 else float("inf")
        # use frame center phase
        C_last = Zxx[k_end, m_last2]
        phi_end_raw = float(_to_cpu(xp.angle(C_last)))
        amp_end = _coeff_to_amplitude(float(_to_cpu(xp.abs(C_last))), cfg)
        conf_end = float(_to_cpu(ridge_conf[m_last2]))
    else:
        seg = x_proc_ext[start:end]
        win_np = spsig.get_window(cfg.window, nperseg, fftbins=True)
        win = xp.asarray(win_np, dtype=xp.float64)
        X_end = xp.fft.rfft(seg * win, n=nfft)
        # scale like stft
        sumw = float(win_np.sum())
        sumw2 = float((win_np**2).sum())
        if cfg.scaling == "spectrum":
            scale = 1.0 / sumw
        else:
            scale = 1.0 / math.sqrt(float(cfg.fs) * sumw2)
        X_end = X_end * xp.asarray(scale, dtype=xp.float64)

        logP_end = xp.log(xp.abs(X_end) ** 2 + float(cfg.power_eps))

        # score end
        score_end = _harmonic_score_matrix(
            logP_end[:, None],
            f_axis=f,
            band_idx=band_idx2,
            fs=float(cfg.fs),
            max_m=int(cfg.score_harmonics),
            weights=cfg.score_weights,
            xp=xp,
        )[:, 0]
        # penalize jumps from previous ridge bin near end
        centers = _to_cpu(t) * float(cfg.fs)
        m_prev = int(np.max(np.where(centers <= n_end)[0])) if np.any(centers <= n_end) else 0
        k_prev = int(_to_cpu(ridge[m_prev]))
        diff = band_idx2.astype(xp.float64) - xp.asarray(k_prev, dtype=xp.float64)
        score_end = score_end - float(cfg.ridge_penalty) * diff * diff

        k_band = int(_to_cpu(xp.argmax(score_end)))
        k_end = int(_to_cpu(band_idx2[k_band]))
        f0_end = float(_to_cpu(f[k_end]))
        period_end = float(cfg.fs) / f0_end if f0_end > 0 else float("inf")

        ridge_pow_end = float(_to_cpu(xp.abs(X_end[k_end]) ** 2))
        band_pow_end = float(_to_cpu(xp.sum(xp.abs(X_end[band_idx2]) ** 2)))
        conf_end = ridge_pow_end / (band_pow_end + float(cfg.power_eps))

        phi_end_raw = float(_to_cpu(xp.angle(X_end[k_end])))
        amp_end = _coeff_to_amplitude(float(_to_cpu(xp.abs(X_end[k_end]))), cfg)

    # Phase continuity (no batch unwrap): accumulate from previous end
    if not state.initialized:
        state.initialized = True
        state.phi_end_cont = phi_end_raw
        state.z_end_prev = amp_end * (math.cos(phi_end_raw) + 1j * math.sin(phi_end_raw))
    else:
        z_now = amp_end * (math.cos(phi_end_raw) + 1j * math.sin(phi_end_raw))
        if abs(z_now) < 1e-12 or abs(state.z_end_prev) < 1e-12:
            state.z_end_prev = z_now
        else:
            cross = z_now * complex(state.z_end_prev).conjugate()
            dphi = math.atan2(cross.imag, cross.real)
            state.phi_end_cont += dphi
            state.z_end_prev = z_now

    phi_end = float(state.phi_end_cont)

    # Final output series (chronological)
    if cfg.output_mode == "cycle":
        out_x = wave_rich_x
    else:
        # price-like reconstruction
        log_wave = trend + baseline_x + wave_rich_x
        if cfg.use_log_price:
            out_x = xp.exp(log_wave)
        else:
            out_x = log_wave

    out_np = _to_cpu(out_x).astype(np.float64, copy=False)

    return out_np, float(f0_end), float(period_end), float(phi_end), float(amp_end), float(conf_end)


# ============================================================
# Engine
# ============================================================


class DominantWaveEngine:
    def __init__(self, cfg: EngineConfig, *, backend: Literal["cupy", "numpy"], logger: logging.Logger):
        self.cfg = cfg
        self.backend = backend
        self.logger = logger
        self.state = EngineState()

    def on_meta(self, meta: np.ndarray) -> None:
        old = self.cfg.__dict__.copy()
        update_config_from_meta(self.cfg, meta, self.logger)
        if self.cfg.__dict__ != old:
            self.logger.info("config updated from META")
            # Changing windowing/band parameters invalidates phase continuity assumptions.
            self.state.initialized = False
            self.state.phi_end_cont = 0.0
            self.state.z_end_prev = 0.0 + 0.0j

    def on_full(self, price_series: np.ndarray, ts: int) -> np.ndarray:
        # series -> chrono
        price_chrono = np.asarray(price_series[::-1], dtype=np.float64)
        self.state.price_chrono = price_chrono
        self.state.last_bar_ts = int(ts)

        out_chrono, f0, per, phi, amp, conf = compute_wave_pipeline(
            price_chrono, self.cfg, backend=self.backend, state=self.state
        )
        out_series = out_chrono[::-1].copy()
        self.state.last_full_out_series = out_series

        self.logger.info(
            "FULL: f0=%.6f period=%.2f amp=%.6f conf=%.3f", f0, per, amp, conf
        )
        return out_series

    def on_update(self, price_series: np.ndarray, ts: int) -> np.ndarray:
        if self.state.price_chrono is None or self.state.price_chrono.size == 0:
            # no buffer yet -> treat as full
            return self.on_full(price_series, ts)

        x = np.asarray(price_series, dtype=np.float64)
        if x.size <= 0:
            return np.zeros((0,), dtype=np.float64)

        new_price = float(x[0])  # series: most recent
        ts = int(ts)
        last_ts = int(self.state.last_bar_ts)

        if ts != 0 and last_ts != 0 and ts != last_ts:
            # new bar -> shift
            buf = self.state.price_chrono
            buf = np.concatenate([buf[1:], np.asarray([new_price], dtype=np.float64)])
            self.state.price_chrono = buf
            self.state.last_bar_ts = ts
        else:
            # same bar update -> replace last
            self.state.price_chrono[-1] = new_price

        # Strategy: compute full wave but return only the last value (no repaint)
        out_chrono, f0, per, phi, amp, conf = compute_wave_pipeline(
            self.state.price_chrono, self.cfg, backend=self.backend, state=self.state
        )

        if self.cfg.update_returns_full:
            out_series = out_chrono[::-1].copy()
            self.state.last_full_out_series = out_series
            self.logger.info("UPDATE(full): f0=%.6f period=%.2f conf=%.3f", f0, per, conf)
            return out_series

        # single value update
        last_val = float(out_chrono[-1])
        self.logger.info("UPDATE(1): f0=%.6f period=%.2f conf=%.3f", f0, per, conf)
        return np.asarray([last_val], dtype=np.float64)


# ============================================================
# Main loop
# ============================================================


def _env_int(name: str, default: int) -> int:
    v = os.environ.get(name, "")
    if v == "":
        return default
    try:
        return int(v)
    except Exception:
        return default


def _find_mql5_root(start: Path) -> Optional[Path]:
    for p in [start] + list(start.parents):
        if p.name.lower() == "mql5":
            return p
    return None


def _auto_config_path() -> Optional[Path]:
    mql5_root = _find_mql5_root(Path(__file__).resolve())
    if mql5_root:
        return mql5_root / "Files" / "pyshared_config.json"

    appdata = os.environ.get("APPDATA")
    if not appdata:
        return None
    base = Path(appdata) / "MetaQuotes" / "Terminal"
    if not base.exists():
        return None
    candidates = list(base.glob("*/MQL5/Files/pyshared_config.json"))
    if not candidates:
        return None
    return max(candidates, key=lambda p: p.stat().st_mtime)


def _load_config(path: Path, logger: logging.Logger) -> Optional[dict]:
    try:
        if not path.exists():
            return None
        data = path.read_bytes()
        if data.startswith(b"\xff\xfe") or data.startswith(b"\xfe\xff"):
            text = data.decode("utf-16")
        else:
            try:
                text = data.decode("utf-8-sig")
            except Exception:
                text = data.decode("utf-16")
        return json.loads(text)
    except Exception as exc:
        logger.warning("failed to read config %s: %s", str(path), exc)
        return None


def _resolve_dll_path(
    dll_arg: Optional[str],
    cfg: Optional[dict],
    logger: logging.Logger,
    cfg_path: Optional[Path] = None,
) -> str:
    if dll_arg:
        return dll_arg

    mql5_root = _find_mql5_root(Path(__file__).resolve())
    if not mql5_root and cfg_path is not None:
        mql5_root = _find_mql5_root(cfg_path.resolve())
    if cfg and isinstance(cfg.get("dll_path"), str) and cfg["dll_path"]:
        return cfg["dll_path"]

    if mql5_root:
        dll_name = None
        if cfg and isinstance(cfg.get("dll_name"), str) and cfg["dll_name"]:
            dll_name = cfg["dll_name"]
        candidate = mql5_root / "Libraries" / (dll_name or "PyShared.dll")
        if candidate.exists():
            return str(candidate)

    logger.error("DLL path not provided and default not found. Use --dll.")
    raise SystemExit(2)


def _get_config_mtime(path: Optional[Path]) -> Optional[float]:
    if not path or not path.exists():
        return None
    try:
        return path.stat().st_mtime
    except Exception:
        return None


def _extract_capacity_bytes(cfg: dict) -> Optional[int]:
    if cfg.get("capacity_bytes") is not None:
        try:
            return int(cfg.get("capacity_bytes"))
        except Exception:
            return None
    cap_mb = cfg.get("capacity_mb")
    if cap_mb is not None:
        try:
            return int(cap_mb) * 1024 * 1024
        except Exception:
            return None
    return None


def _apply_runtime_config(
    cfg: Optional[dict],
    log: logging.Logger,
    *,
    channel: str,
    capacity: int,
    log_every_ms: int,
) -> int:
    if not cfg:
        return log_every_ms

    new_log_every = log_every_ms
    if cfg.get("log_every_ms") is not None:
        try:
            new_log_every = int(cfg.get("log_every_ms"))
        except Exception:
            pass

    if new_log_every != log_every_ms:
        log.info("log_every_ms updated: %d -> %d", log_every_ms, new_log_every)

    cfg_channel = cfg.get("channel")
    if isinstance(cfg_channel, str) and cfg_channel and cfg_channel != channel:
        log.warning("config channel changed to %s (restart required)", cfg_channel)

    cfg_capacity = _extract_capacity_bytes(cfg)
    if cfg_capacity is not None and int(cfg_capacity) != int(capacity):
        log.warning("config capacity changed to %d (restart required)", int(cfg_capacity))

    return new_log_every


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dll", help="Path to PyShared.dll / PyBridge.dll (optional if config is present)")
    ap.add_argument("--channel", default=None)
    ap.add_argument("--capacity", type=int, default=None)
    ap.add_argument("--config", help="Path to config JSON (default: MQL5/Files/pyshared_config.json)")
    ap.add_argument("--sleep_ms", type=int, default=1)
    ap.add_argument("--verbose", action="store_true")
    ap.add_argument("--backend", choices=["cupy", "numpy"], default="cupy")
    ap.add_argument(
        "--backend-warn-every",
        type=int,
        default=10,
        help="Warn every N processed bars when CuPy is unavailable (0 disables)",
    )
    ap.add_argument(
        "--no-backend-warn",
        action="store_true",
        help="Disable backend fallback warnings",
    )
    args = ap.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="[%(asctime)s] %(levelname)s: %(message)s",
    )
    log = logging.getLogger("PySharedWave")

    log.info("starting integrated client")

    cfg_path = Path(args.config) if args.config else _auto_config_path()
    cfg_data = _load_config(cfg_path, log) if cfg_path else None
    if cfg_path and cfg_data:
        log.info("loaded config: %s", str(cfg_path))
    elif cfg_path:
        log.info("config not found: %s", str(cfg_path))

    channel = args.channel or (cfg_data.get("channel") if cfg_data else None) or "MAIN"
    capacity = args.capacity if args.capacity is not None else (_extract_capacity_bytes(cfg_data) if cfg_data else None)
    if capacity is None:
        capacity = 8 * 1024 * 1024
    capacity = int(capacity)
    dll_path = _resolve_dll_path(args.dll, cfg_data, log, cfg_path if cfg_path else None)
    log_every_ms = None
    if cfg_data is not None and cfg_data.get("log_every_ms") is not None:
        try:
            log_every_ms = int(cfg_data.get("log_every_ms"))
        except Exception:
            log_every_ms = None
    if log_every_ms is None:
        log_every_ms = 5000

    log.info("dll=%s channel=%s capacity=%d backend=%s", dll_path, channel, int(capacity), args.backend)

    # Detect actual backend availability once at startup.
    backend_effective = _get_backend(args.backend)[2]
    backend_fallback = (args.backend == "cupy" and backend_effective != "cupy")
    if backend_fallback:
        log.warning(
            "CuPy backend not available; falling back to NumPy. "
            "Use --no-backend-warn or --backend-warn-every 0 to silence."
        )

    bridge = PySharedBridge(dll_path)
    bridge.connect(channel, capacity)
    log.info("PB_Init ok, max_doubles=%d", bridge.max_doubles)

    cfg = EngineConfig()
    engine = DominantWaveEngine(cfg, backend=backend_effective, logger=log)

    warn_every = 0 if args.no_backend_warn else max(0, int(args.backend_warn_every))
    processed_bars = 0
    rx_full = 0
    rx_upd = 0
    tx_full = 0
    tx_upd = 0
    last_in_sid = 0
    last_out_sid = 0
    last_log_ms = int(time.time() * 1000.0)
    last_cfg_check_ms = last_log_ms
    cfg_mtime = _get_config_mtime(cfg_path)

    last_idle_log = 0.0
    log_idle = _env_int("PYSHARED_LOG_IDLE", 0) == 1
    log_idle_every = max(1, _env_int("PYSHARED_LOG_IDLE_EVERY", 5))

    try:
        while True:
            # Drain all pending messages from stream 0.
            # With the v2 DLL ring buffer, this ensures we do NOT lose META packets
            # that are written immediately before FULL/UPDATE in the same MT5 timer tick.
            last_meta: Optional[np.ndarray] = None
            last_full: Optional[Tuple[np.ndarray, int]] = None
            last_upd: Optional[Tuple[np.ndarray, int]] = None

            while True:
                sid, data, ts = bridge.read_next(0)
                if sid == 0 or data.size == 0:
                    break
                if sid == 900:
                    last_meta = data
                elif sid == 100:
                    last_full = (data, ts)
                    last_in_sid = 100
                elif sid == 101:
                    last_upd = (data, ts)
                    last_in_sid = 101
                else:
                    # Treat unknown packets as FULL
                    last_full = (data, ts)
                    last_in_sid = int(sid)

            if last_meta is None and last_full is None and last_upd is None:
                if args.verbose and log_idle:
                    now = time.time()
                    if now - last_idle_log >= log_idle_every:
                        log.debug("no new data")
                        last_idle_log = now
                if log_every_ms > 0:
                    now_ms = int(time.time() * 1000.0)
                    if (now_ms - last_log_ms) >= log_every_ms:
                        log.info(
                            "traffic: rx_full=%d rx_upd=%d tx_full=%d tx_upd=%d last_in=%d last_out=%d (idle)",
                            rx_full,
                            rx_upd,
                            tx_full,
                            tx_upd,
                            last_in_sid,
                            last_out_sid,
                        )
                        last_log_ms = now_ms
                now_ms = int(time.time() * 1000.0)
                if (now_ms - last_cfg_check_ms) >= 1000:
                    last_cfg_check_ms = now_ms
                    if cfg_path is not None:
                        mtime = _get_config_mtime(cfg_path)
                        if mtime and (cfg_mtime is None or mtime > cfg_mtime):
                            cfg_mtime = mtime
                            new_cfg = _load_config(cfg_path, log)
                            if new_cfg is not None:
                                log_every_ms = _apply_runtime_config(
                                    new_cfg,
                                    log,
                                    channel=channel,
                                    capacity=capacity,
                                    log_every_ms=log_every_ms,
                                )
                time.sleep(args.sleep_ms / 1000.0)
                continue

            # Apply latest META first (if any).
            if last_meta is not None:
                engine.on_meta(last_meta)

            # Process only the newest price packet (FULL has priority over UPDATE).
            if last_full is not None:
                data, ts = last_full
                out = engine.on_full(data, ts)
                bridge.write(1, 201, out, int(ts) if ts else int(time.time()))
                processed_bars += 1
                rx_full += 1
                tx_full += 1
                last_out_sid = 201
            elif last_upd is not None:
                data, ts = last_upd
                out = engine.on_update(data, ts)
                bridge.write(1, 202, out, int(ts) if ts else int(time.time()))
                processed_bars += 1
                rx_upd += 1
                tx_upd += 1
                last_out_sid = 202

            if backend_fallback and warn_every > 0 and processed_bars % warn_every == 0:
                log.warning(
                    "Running on NumPy fallback (CuPy unavailable). "
                    "Disable with --no-backend-warn or --backend-warn-every 0."
                )

            if log_every_ms > 0:
                now_ms = int(time.time() * 1000.0)
                if (now_ms - last_log_ms) >= log_every_ms:
                    log.info(
                        "traffic: rx_full=%d rx_upd=%d tx_full=%d tx_upd=%d last_in=%d last_out=%d",
                        rx_full,
                        rx_upd,
                        tx_full,
                        tx_upd,
                        last_in_sid,
                        last_out_sid,
                    )
                    last_log_ms = now_ms

            # Config hot-reload (log interval + warnings for channel/capacity changes)
            now_ms = int(time.time() * 1000.0)
            if (now_ms - last_cfg_check_ms) >= 1000:
                last_cfg_check_ms = now_ms
                if cfg_path is not None:
                    mtime = _get_config_mtime(cfg_path)
                    if mtime and (cfg_mtime is None or mtime > cfg_mtime):
                        cfg_mtime = mtime
                        new_cfg = _load_config(cfg_path, log)
                        if new_cfg is not None:
                            log_every_ms = _apply_runtime_config(
                                new_cfg,
                                log,
                                channel=channel,
                                capacity=capacity,
                                log_every_ms=log_every_ms,
                            )

            time.sleep(args.sleep_ms / 1000.0)
    finally:
        bridge.close()


def _apply_params_to_config(cfg: EngineConfig, params: dict) -> None:
    if not params:
        return
    skip = {"backend", "log_level"}
    for key, value in params.items():
        if key in skip:
            continue
        if hasattr(cfg, key):
            setattr(cfg, key, value)


class Plugin:
    def __init__(self, params=None, context=None):
        self.params = params or {}
        self.context = context or {}
        self.logger = logging.getLogger("Plugin[INTEGRATED_WAVE]")
        level = str(self.params.get("log_level", "INFO")).upper()
        if hasattr(logging, level):
            self.logger.setLevel(getattr(logging, level))

        self.cfg = EngineConfig()
        _apply_params_to_config(self.cfg, self.params)
        backend = self.params.get("backend", "cupy")
        self.engine = DominantWaveEngine(self.cfg, backend=backend, logger=self.logger)

    def process_meta(self, meta, ts):
        meta_arr = np.asarray(meta, dtype=np.float64)
        self.logger.info("META count=%d ts=%d", int(meta_arr.size), int(ts))
        self.engine.on_meta(meta_arr)

    def process_full(self, series, ts):
        series_arr = np.asarray(series, dtype=np.float64)
        if series_arr.size > 0:
            self.logger.info(
                "RX FULL count=%d v0=%.6f vN=%.6f ts=%d",
                int(series_arr.size),
                float(series_arr[0]),
                float(series_arr[-1]),
                int(ts),
            )
        out = self.engine.on_full(series_arr, int(ts))
        if out is not None and len(out) > 0:
            self.logger.info(
                "TX FULL count=%d v0=%.6f vN=%.6f",
                int(len(out)),
                float(out[0]),
                float(out[-1]),
            )
        return out

    def process_update(self, series, ts):
        series_arr = np.asarray(series, dtype=np.float64)
        if series_arr.size > 0:
            self.logger.info(
                "RX UPDATE count=%d v0=%.6f vN=%.6f ts=%d",
                int(series_arr.size),
                float(series_arr[0]),
                float(series_arr[-1]),
                int(ts),
            )
        out = self.engine.on_update(series_arr, int(ts))
        if out is not None and len(out) > 0:
            self.logger.info(
                "TX UPDATE count=%d v0=%.6f",
                int(len(out)),
                float(out[0]),
            )
        return out


if __name__ == "__main__":
    main()
