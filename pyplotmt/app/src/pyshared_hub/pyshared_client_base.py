"""Portable, agnostic PyShared client base.

Do not change DLL bridge logic here. Other indicator clients import this module
and only implement their own compute + stream mapping.
"""
from __future__ import annotations

import ctypes as ct
import json
import logging
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Optional, Tuple

import numpy as np

LOG = logging.getLogger("PySharedBase")
_LOG_SEQ = 0
LOG_IO = True  # log every read/write (verbose)


def log_event(msg: str, level: str = "info") -> None:
    """Emit non-repeating log line with a monotonically increasing id."""
    global _LOG_SEQ
    _LOG_SEQ += 1
    line = f"[{_LOG_SEQ:06d}] {msg}"
    getattr(LOG, level, LOG.info)(line)


@dataclass
class BridgeConfig:
    channel: str = "MAIN"
    capacity_bytes: int = 8 * 1024 * 1024
    dll_path: str = ""


class PySharedBridge:
    def __init__(self, dll_path: str):
        if os.name != "nt":
            log_event("PySharedBridge requires Windows (ct.WinDLL)", "error")
            raise RuntimeError("PySharedBridge requires Windows (ct.WinDLL)")
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
        self._buf = None

    def connect(self, channel: str, capacity_bytes: int) -> None:
        log_event(f"PB_Init attempt channel={channel} capacity_bytes={capacity_bytes}")
        if self.dll.PB_Init(channel, int(capacity_bytes)) != 1:
            log_event("PB_Init failed", "error")
            raise RuntimeError("PB_Init failed")
        self.max_doubles = int(self.dll.PB_MaxDoubles())
        if self.max_doubles <= 0:
            log_event("PB_MaxDoubles returned 0", "error")
            raise RuntimeError("PB_MaxDoubles returned 0")
        self._buf = (ct.c_double * self.max_doubles)()
        log_event(f"PB_Init OK max_doubles={self.max_doubles} (waiting for indicator data)")

    def close(self) -> None:
        try:
            self.dll.PB_Close()
            log_event("[Disconnected] PB_Close OK")
        except Exception:
            pass

    def read_next(self, stream: int) -> Tuple[int, np.ndarray, int]:
        sid = ct.c_int()
        out_count = ct.c_int()
        ts = ct.c_longlong()

        if self._has_read_next:
            got = self.dll.PB_ReadNextDoubles(
                stream,
                ct.byref(sid),
                self._buf,
                self.max_doubles,
                ct.byref(out_count),
                ct.byref(ts),
            )
        else:
            got = self.dll.PB_ReadDoubles(
                stream,
                ct.byref(sid),
                self._buf,
                self.max_doubles,
                ct.byref(out_count),
                ct.byref(ts),
            )

        if got <= 0 or out_count.value <= 0:
            return 0, np.empty(0, dtype=np.float64), 0

        data = np.frombuffer(self._buf, dtype=np.float64, count=out_count.value).copy()
        if LOG_IO:
            log_event(
                f"read_next stream={stream} sid={int(sid.value)} count={int(out_count.value)} ts={int(ts.value)}"
            )
        return int(sid.value), data, int(ts.value)

    def write(self, stream: int, series_id: int, data: np.ndarray, ts: int = 0) -> int:
        if data is None:
            return 0
        arr = np.asarray(data, dtype=np.float64)
        count = int(arr.size)
        if count <= 0:
            return 0
        buf = (ct.c_double * count)(*arr.tolist())
        wrote = int(self.dll.PB_WriteDoubles(stream, series_id, buf, count, int(ts)))
        if LOG_IO:
            log_event(f"write stream={stream} sid={series_id} count={count} ts={int(ts)} wrote={wrote}")
        return wrote


def _find_mql5_root(start: Path) -> Optional[Path]:
    for p in [start] + list(start.parents):
        if p.name.lower() == "mql5":
            log_event(f"found MQL5 root: {str(p)}")
            return p
    return None


def _auto_config_path() -> Optional[Path]:
    mql5_root = _find_mql5_root(Path(__file__).resolve())
    if mql5_root:
        path = mql5_root / "Files" / "pyshared_config.json"
        log_event(f"config path (from MQL5 root): {str(path)}")
        return path
    appdata = os.environ.get("APPDATA")
    if not appdata:
        return None
    base = Path(appdata) / "MetaQuotes" / "Terminal"
    if not base.exists():
        return None
    candidates = list(base.glob("*/MQL5/Files/pyshared_config.json"))
    if not candidates:
        return None
    path = max(candidates, key=lambda p: p.stat().st_mtime)
    log_event(f"config path (from APPDATA): {str(path)}")
    return path


def _load_config(path: Path, log: logging.Logger) -> Optional[dict]:
    try:
        if not path.exists():
            log_event(f"config missing: {str(path)}", "warning")
            return None
        data = path.read_bytes()
        if data.startswith(b"\xff\xfe") or data.startswith(b"\xfe\xff"):
            text = data.decode("utf-16")
        else:
            if b"\x00" in data:
                try:
                    text = data.decode("utf-16le")
                except Exception:
                    text = data.decode("utf-16be")
            else:
                text = data.decode("utf-8-sig")
        cfg = json.loads(text.strip("\ufeff"))
        log_event(f"config loaded keys={list(cfg.keys())}")
        return cfg
    except Exception as exc:
        log.warning("failed to read config %s: %s", str(path), exc)
        return None


def _resolve_dll_path(cfg: Optional[dict], log: logging.Logger, cfg_path: Optional[Path]) -> str:
    if cfg and isinstance(cfg.get("dll_path"), str) and cfg["dll_path"]:
        log_event(f"dll_path from config: {cfg['dll_path']}")
        return cfg["dll_path"]

    mql5_root = _find_mql5_root(Path(__file__).resolve())
    if not mql5_root and cfg_path is not None:
        mql5_root = _find_mql5_root(cfg_path.resolve())
    if mql5_root:
        dll_name = "PyShared_v2.dll"
        if cfg and isinstance(cfg.get("dll_name"), str) and cfg["dll_name"]:
            dll_name = cfg["dll_name"]
        candidate = mql5_root / "Libraries" / dll_name
        if candidate.exists():
            log_event(f"dll_path resolved: {str(candidate)}")
            return str(candidate)
        # fallback to legacy name if v2 not found
        if dll_name != "PyShared.dll":
            legacy = mql5_root / "Libraries" / "PyShared.dll"
            if legacy.exists():
                log_event(f"dll_path resolved (legacy): {str(legacy)}")
                return str(legacy)

    log.error("DLL path not provided and default not found.")
    log_event("dll_path resolve failed", "error")
    raise SystemExit(2)


def _extract_capacity_bytes(cfg: Optional[dict]) -> int:
    if not cfg:
        log_event("capacity default=8MB (no config)")
        return 8 * 1024 * 1024
    if cfg.get("capacity_bytes") is not None:
        try:
            cap = int(cfg.get("capacity_bytes"))
            log_event(f"capacity_bytes from config: {cap}")
            return cap
        except Exception:
            return 8 * 1024 * 1024
    if cfg.get("capacity_mb") is not None:
        try:
            cap = int(cfg.get("capacity_mb")) * 1024 * 1024
            log_event(f"capacity_mb from config: {cap}")
            return cap
        except Exception:
            return 8 * 1024 * 1024
    return 8 * 1024 * 1024


def load_bridge_config(logger: logging.Logger) -> BridgeConfig:
    cfg_path = _auto_config_path()
    cfg_data = _load_config(cfg_path, logger) if cfg_path else None

    channel = (cfg_data.get("channel") if cfg_data else None) or "MAIN"
    capacity = _extract_capacity_bytes(cfg_data)
    dll_path = _resolve_dll_path(cfg_data, logger, cfg_path if cfg_path else None)

    log_event(f"bridge_config channel={channel} capacity_bytes={capacity} dll_path={dll_path}")
    return BridgeConfig(channel=channel, capacity_bytes=capacity, dll_path=dll_path)


def load_raw_config(logger: logging.Logger) -> tuple[Optional[dict], Optional[Path]]:
    cfg_path = _auto_config_path()
    cfg_data = _load_config(cfg_path, logger) if cfg_path else None
    log_event(f"raw_config path={str(cfg_path) if cfg_path else 'None'} loaded={cfg_data is not None}")
    return cfg_data, cfg_path
