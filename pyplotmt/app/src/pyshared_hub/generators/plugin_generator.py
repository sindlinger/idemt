from __future__ import annotations

from pathlib import Path


def write_plugin_file(path: Path, name: str, channel: str, buffers: int) -> None:
    template = f'''# Auto-generated PyPlot-MT plugin
import numpy as np


class Plugin:
    def __init__(self, params=None, context=None):
        self.params = params or {{}}
        self.context = context or {{}}
        self.channel = "{channel}"
        self.buffers = {buffers}

    def process_meta(self, meta, ts):
        # Optional: receive META packets from the indicator (sid=900).
        # meta is a numpy array of floats; use it to update parameters/state.
        pass

    def process_full(self, series, ts):
        series = np.asarray(series, dtype=np.float64)
        # TODO: replace with your logic.
        # If you use multiple buffers, return concatenated arrays:
        # return np.concatenate([buf1, buf2, ...])
        return np.zeros_like(series)

    def process_update(self, series, ts):
        series = np.asarray(series, dtype=np.float64)
        # TODO: replace with your logic.
        return np.zeros_like(series)
'''
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(template, encoding="utf-8")
