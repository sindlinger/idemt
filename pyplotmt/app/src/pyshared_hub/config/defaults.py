from __future__ import annotations

import logging
import os
import sys
from pathlib import Path

try:
    import pyshared_client_base as psb
except Exception:
    psb = None


def default_plugin_dir() -> Path:
    candidates = []
    exe_dir = Path(os.path.abspath(os.path.dirname(os.path.realpath(sys.argv[0]))))
    candidates.append(exe_dir / "plugins")
    candidates.append(Path.home() / "PyPlot-MT" / "plugins")
    candidates.append(Path.home() / "PyMTPlot" / "plugins")

    for c in candidates:
        try:
            c.mkdir(parents=True, exist_ok=True)
            if os.access(c, os.W_OK):
                return c
        except Exception:
            continue

    return Path.home()


def default_indicator_dir() -> Path:
    if psb is not None:
        try:
            _, cfg_path = psb.load_raw_config(logging.getLogger("PyPlotMTDefaults"))
            if cfg_path is not None:
                mql5 = cfg_path.parent.parent
                if mql5.name.lower() == "mql5":
                    return mql5 / "Indicators"
        except Exception:
            pass
    return Path.home()
