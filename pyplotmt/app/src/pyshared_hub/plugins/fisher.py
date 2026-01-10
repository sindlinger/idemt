"""Fisher plugin (no DLL, no IO)."""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Optional

import numpy as np


@dataclass
class FisherConfig:
    period: int = 260
    applied_price: str = "median"  # close/open/high/low/median/typical/weighted
    max_keep: Optional[int] = None


def _get_price(applied: str, open_, high, low, close):
    if applied == "close":
        return close
    if applied == "open":
        return open_
    if applied == "high":
        return high
    if applied == "low":
        return low
    if applied == "median":
        return (high + low) / 2.0
    if applied == "typical":
        return (high + low + close) / 3.0
    if applied == "weighted":
        return (high + low + close + close) / 4.0
    return close


def compute_fisher_full(price: np.ndarray, period: int) -> tuple[np.ndarray, np.ndarray]:
    n = len(price)
    fisher = np.zeros(n, dtype=np.float64)
    value1 = np.zeros(n, dtype=np.float64)

    for i in range(n):
        start = max(0, i - period + 1)
        window = price[start : i + 1]
        max_p = float(np.max(window))
        min_p = float(np.min(window))

        prev_val = value1[i - 1] if i > 0 else 0.0
        if max_p != min_p:
            v = 0.33 * 2.0 * ((price[i] - min_p) / (max_p - min_p) - 0.5) + 0.67 * prev_val
        else:
            v = 0.67 * prev_val

        v = min(0.999, max(-0.999, v))
        value1[i] = v

        f = 0.5 * math.log((1.0 + v) / (1.0 - v))
        fisher[i] = f + 0.5 * fisher[i - 1] if i > 0 else f

    return fisher, value1


def compute_fisher_increment(
    price: np.ndarray,
    period: int,
    fisher: np.ndarray,
    value1: np.ndarray,
    start_idx: int,
) -> None:
    for i in range(start_idx, len(price)):
        start = max(0, i - period + 1)
        window = price[start : i + 1]
        max_p = float(np.max(window))
        min_p = float(np.min(window))

        prev_val = value1[i - 1] if i > 0 else 0.0
        if max_p != min_p:
            v = 0.33 * 2.0 * ((price[i] - min_p) / (max_p - min_p) - 0.5) + 0.67 * prev_val
        else:
            v = 0.67 * prev_val

        v = min(0.999, max(-0.999, v))
        value1[i] = v

        f = 0.5 * math.log((1.0 + v) / (1.0 - v))
        fisher[i] = f + 0.5 * fisher[i - 1] if i > 0 else f


class Plugin:
    def __init__(self, params: dict, context: dict):
        period = int(params.get("period", 260))
        applied = params.get("applied_price", "median")
        max_keep = params.get("max_keep")
        if max_keep is None:
            max_keep = context.get("send_bars")
        self.cfg = FisherConfig(period=period, applied_price=applied, max_keep=max_keep)
        self.price_hist: Optional[np.ndarray] = None
        self.fisher_hist: Optional[np.ndarray] = None
        self.value1_hist: Optional[np.ndarray] = None

    def process_full(self, series: np.ndarray, ts: int) -> np.ndarray:
        prices = series[::-1].astype(np.float64)
        self.price_hist = prices.copy()
        self.fisher_hist, self.value1_hist = compute_fisher_full(prices, self.cfg.period)
        out_series = self.fisher_hist[::-1]
        return out_series.astype(np.float64)

    def process_update(self, series: np.ndarray, ts: int) -> np.ndarray:
        if self.price_hist is None:
            return np.array([], dtype=np.float64)
        upd_prices = series[::-1].astype(np.float64)

        start_idx = len(self.price_hist)
        self.price_hist = np.concatenate([self.price_hist, upd_prices])

        if self.cfg.max_keep and self.price_hist.size > self.cfg.max_keep:
            overflow = self.price_hist.size - self.cfg.max_keep
            self.price_hist = self.price_hist[overflow:]
            if self.fisher_hist is not None and self.value1_hist is not None:
                self.fisher_hist = self.fisher_hist[overflow:]
                self.value1_hist = self.value1_hist[overflow:]
            start_idx = max(0, start_idx - overflow)

        if self.fisher_hist is None or self.value1_hist is None:
            self.fisher_hist, self.value1_hist = compute_fisher_full(self.price_hist, self.cfg.period)
        else:
            if len(self.fisher_hist) != len(self.price_hist):
                self.fisher_hist = np.pad(self.fisher_hist, (0, len(self.price_hist) - len(self.fisher_hist)))
                self.value1_hist = np.pad(self.value1_hist, (0, len(self.price_hist) - len(self.value1_hist)))
            compute_fisher_increment(
                self.price_hist,
                self.cfg.period,
                self.fisher_hist,
                self.value1_hist,
                start_idx,
            )

        k = len(upd_prices)
        out_update = self.fisher_hist[-k:][::-1]
        return out_update.astype(np.float64)
