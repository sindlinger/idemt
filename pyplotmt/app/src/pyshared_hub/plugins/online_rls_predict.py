"""Online RLS predictor (log-return) for PyShared hub."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import numpy as np

try:
    import cupy as cp
    xp = cp
    GPU_ENABLED = True
    def _to_cpu(arr):
        return cp.asnumpy(arr)
except Exception:
    xp = np
    GPU_ENABLED = False
    def _to_cpu(arr):
        return arr


@dataclass
class RlsConfig:
    lookback: int = 64
    forget: float = 0.99
    delta: float = 100.0
    max_keep: Optional[int] = None


class OnlineRLS:
    def __init__(self, dim: int, lam: float, delta: float):
        self.dim = dim
        self.lam = lam
        self.w = xp.zeros((dim, 1), dtype=xp.float32)
        self.P = xp.eye(dim, dtype=xp.float32) * float(delta)

    def reset(self, delta: float) -> None:
        self.w = xp.zeros((self.dim, 1), dtype=xp.float32)
        self.P = xp.eye(self.dim, dtype=xp.float32) * float(delta)

    def update(self, x: np.ndarray, y: float) -> None:
        x_v = xp.asarray(x, dtype=xp.float32).reshape((-1, 1))
        y_v = xp.asarray([y], dtype=xp.float32).reshape((1, 1))
        Px = self.P @ x_v
        denom = self.lam + (x_v.T @ Px)
        k = Px / denom
        e = y_v - (self.w.T @ x_v)
        self.w = self.w + k * e
        self.P = (self.P - k @ x_v.T @ self.P) / self.lam

    def predict(self, x: np.ndarray) -> float:
        x_v = xp.asarray(x, dtype=xp.float32).reshape((-1, 1))
        y = float((self.w.T @ x_v).item())
        return y


class Plugin:
    def __init__(self, params: dict, context: dict):
        lookback = int(params.get("lookback", 64))
        forget = float(params.get("forget", 0.99))
        delta = float(params.get("delta", 100.0))
        max_keep = params.get("max_keep")
        if max_keep is None:
            max_keep = context.get("send_bars")

        self.cfg = RlsConfig(lookback=lookback, forget=forget, delta=delta, max_keep=max_keep)
        self.model = OnlineRLS(self.cfg.lookback + 1, self.cfg.forget, self.cfg.delta)
        self.price_hist: Optional[np.ndarray] = None
        self.ret_hist: Optional[np.ndarray] = None

    def _compute_returns(self, prices: np.ndarray) -> np.ndarray:
        if prices.size < 2:
            return np.empty(0, dtype=np.float64)
        p0 = prices[1:]
        p1 = prices[:-1]
        return np.log(p0 / p1)

    def _predict_from_returns(self, rets: np.ndarray) -> float:
        L = self.cfg.lookback
        if rets.size < L:
            return 0.0
        x = rets[-L:]
        mu = float(x.mean())
        sigma = float(x.std()) + 1e-12
        x_norm = (x - mu) / sigma
        y_pred = self.model.predict(x_norm)
        return y_pred * sigma + mu

    def process_full(self, series: np.ndarray, ts: int) -> np.ndarray:
        prices = series[::-1].astype(np.float64)
        if self.cfg.max_keep and prices.size > self.cfg.max_keep:
            prices = prices[-self.cfg.max_keep :]

        self.price_hist = prices.copy()
        self.ret_hist = self._compute_returns(prices)
        self.model.reset(self.cfg.delta)

        n = prices.size
        out = np.zeros(n, dtype=np.float64)
        L = self.cfg.lookback

        if self.ret_hist.size >= L + 1:
            for i in range(L, self.ret_hist.size):
                x = self.ret_hist[i - L : i]
                mu = float(x.mean())
                sigma = float(x.std()) + 1e-12
                x_norm = (x - mu) / sigma
                y = float(self.ret_hist[i])
                y_norm = (y - mu) / sigma

                out[i] = self.model.predict(x_norm) * sigma + mu
                self.model.update(x_norm, y_norm)

            out[-1] = self._predict_from_returns(self.ret_hist)

        return out[::-1].astype(np.float64)

    def process_update(self, series: np.ndarray, ts: int) -> np.ndarray:
        if self.price_hist is None:
            return np.array([], dtype=np.float64)

        upd_prices = series[::-1].astype(np.float64)
        outputs = []

        for p in upd_prices:
            last_price = float(self.price_hist[-1])
            self.price_hist = np.append(self.price_hist, p)
            r_new = float(np.log(p / last_price)) if p > 0 and last_price > 0 else 0.0
            if self.ret_hist is None:
                self.ret_hist = np.array([r_new], dtype=np.float64)
            else:
                self.ret_hist = np.append(self.ret_hist, r_new)

            L = self.cfg.lookback
            if self.ret_hist.size >= L + 1:
                x_train = self.ret_hist[-L - 1 : -1]
                mu = float(x_train.mean())
                sigma = float(x_train.std()) + 1e-12
                x_norm = (x_train - mu) / sigma
                y_norm = (r_new - mu) / sigma
                self.model.update(x_norm, y_norm)

            outputs.append(self._predict_from_returns(self.ret_hist))

        return np.asarray(outputs[::-1], dtype=np.float64)
