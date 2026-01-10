"""PyShared multi-channel hub (single process).

- Connects to DLL once per channel.
- Loads plugin modules (no DLL inside plugins).
- Each channel maps to one indicator (one subwindow).
"""
from __future__ import annotations

import importlib
import importlib.machinery
import importlib.util
import logging
import os
import sys
import signal
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

import pyshared_client_base as psb
import hub_config


@dataclass
class ChannelConfig:
    name: str
    plugin: str
    params: dict


class ChannelWorker(threading.Thread):
    def __init__(self, cfg: ChannelConfig, dll_path: str, capacity_bytes: int, context: dict[str, Any]):
        super().__init__(daemon=True)
        self.cfg = cfg
        self.dll_path = dll_path
        self.capacity_bytes = capacity_bytes
        self.context = context
        self.stop_event = threading.Event()
        self.log = logging.getLogger(f"Hub[{cfg.name}]")
        self.bridge = None
        self.plugin = None
        self._last_rx_time: float | None = None
        self._indicator_online = False
        self._idle_seconds = 5.0

    def run(self) -> None:
        self._init_plugin()
        self._init_bridge()
        self._loop()

    def _init_plugin(self) -> None:
        psb.log_event(f"[{self.cfg.name}] loading plugin: {self.cfg.plugin}")
        mod = self._load_plugin_module(self.cfg.plugin)
        if not hasattr(mod, "Plugin"):
            raise RuntimeError(f"Plugin {self.cfg.plugin} missing Plugin class")
        self.plugin = mod.Plugin(self.cfg.params, self.context)
        psb.log_event(f"[{self.cfg.name}] plugin loaded: {self.cfg.plugin} params={self.cfg.params}")

    def _load_plugin_module(self, spec: str):
        p = Path(spec)
        if p.exists() and p.suffix.lower() == ".py":
            psb.log_event(f"[{self.cfg.name}] plugin path resolved: {spec}")
            mod_name = f"ext_{self.cfg.name.lower()}"
            loader = importlib.machinery.SourceFileLoader(mod_name, str(p))
            spec_obj = importlib.util.spec_from_loader(mod_name, loader)
            if spec_obj is None or spec_obj.loader is None:
                raise RuntimeError(f"Failed to load plugin file: {spec}")
            mod = importlib.util.module_from_spec(spec_obj)
            spec_obj.loader.exec_module(mod)
            return mod
        psb.log_event(f"[{self.cfg.name}] importing plugin module: {spec}")
        return importlib.import_module(spec)

    def _init_bridge(self) -> None:
        self.bridge = psb.PySharedBridge(self.dll_path)
        self.bridge.connect(self.cfg.name, self.capacity_bytes)
        psb.log_event(f"[{self.cfg.name}] [Connected] PB_Init OK")

    def _loop(self) -> None:
        assert self.bridge is not None
        assert self.plugin is not None

        last_bar_ts = -1
        while not self.stop_event.is_set():
            full_chunks = []
            last_full_ts = None
            last_upd = None
            last_upd_ts = None
            last_meta = None
            last_meta_ts = None

            while True:
                sid, data, ts = self.bridge.read_next(0)
                if sid == 0 or data.size == 0:
                    break
                if sid == 100:
                    full_chunks.append(data)
                    last_full_ts = ts
                elif sid == 101:
                    last_upd = data
                    last_upd_ts = ts
                elif sid == 900:
                    last_meta = data
                    last_meta_ts = ts

            if not full_chunks and last_upd is None and last_meta is None:
                if self._indicator_online and self._last_rx_time is not None:
                    if (time.time() - self._last_rx_time) > self._idle_seconds:
                        self._indicator_online = False
                        psb.log_event(f"[{self.cfg.name}] [Disconnected] indicator idle")
                time.sleep(0.001)
                continue

            now = time.time()
            self._last_rx_time = now
            if not self._indicator_online:
                self._indicator_online = True
                psb.log_event(f"[{self.cfg.name}] [Connected] indicator stream active")

            if last_meta is not None:
                self._handle_meta(last_meta, int(last_meta_ts or 0))

            if full_chunks:
                series = np.concatenate(full_chunks).astype(np.float64)
                psb.log_event(
                    f"[{self.cfg.name}] RX FULL chunks={len(full_chunks)} count={int(series.size)} "
                    f"v0={float(series[0]) if series.size else 0.0:.6f} "
                    f"vN={float(series[-1]) if series.size else 0.0:.6f} "
                    f"ts={int(last_full_ts or 0)}"
                )
                out = self.plugin.process_full(series, int(last_full_ts or 0))
                if out is not None and len(out) > 0:
                    self.bridge.write(1, 201, np.asarray(out, dtype=np.float64), int(last_full_ts or 0))
                    psb.log_event(
                        f"[{self.cfg.name}] TX FULL count={int(len(out))} "
                        f"v0={float(out[0]) if len(out) else 0.0:.6f} "
                        f"vN={float(out[-1]) if len(out) else 0.0:.6f}"
                    )

            if last_upd is not None:
                out = self.plugin.process_update(last_upd.astype(np.float64), int(last_upd_ts or 0))
                if last_upd_ts is not None and int(last_upd_ts) != last_bar_ts:
                    last_bar_ts = int(last_upd_ts)
                    psb.log_event(
                        f"[{self.cfg.name}] RX UPDATE count={int(last_upd.size)} "
                        f"v0={float(last_upd[0]) if last_upd.size else 0.0:.6f} "
                        f"vN={float(last_upd[-1]) if last_upd.size else 0.0:.6f} "
                        f"ts={int(last_upd_ts or 0)}"
                    )
                if out is not None and len(out) > 0:
                    self.bridge.write(1, 202, np.asarray(out, dtype=np.float64), int(last_upd_ts or 0))
                    psb.log_event(
                        f"[{self.cfg.name}] TX UPDATE count={int(len(out))} "
                        f"v0={float(out[0]) if len(out) else 0.0:.6f}"
                    )

        try:
            if self.bridge is not None:
                self.bridge.close()
        finally:
            psb.log_event(f"[{self.cfg.name}] [Disconnected] PB_Close")

    def stop(self) -> None:
        self.stop_event.set()

    def _handle_meta(self, meta: np.ndarray, ts: int) -> None:
        if self.plugin is None:
            return
        if hasattr(self.plugin, "process_meta"):
            try:
                self.plugin.process_meta(meta.astype(np.float64), ts)
                psb.log_event(f"[{self.cfg.name}] RX META count={int(meta.size)} ts={int(ts)}")
                # ACK back to indicator
                if self.bridge is not None:
                    ack = np.array([float(meta.size)], dtype=np.float64)
                    self.bridge.write(1, 990, ack, int(ts))
                    psb.log_event(f"[{self.cfg.name}] TX ACK sid=990 count=1")
            except Exception as exc:
                psb.log_event(f"[{self.cfg.name}] META error: {exc}", "error")


def _load_channels_from_file(path: Path) -> list[dict]:
    try:
        text = path.read_text(encoding="utf-8")
        ns: dict = {}
        exec(text, ns)
        channels = ns.get("CHANNELS", [])
        if isinstance(channels, list):
            return channels
    except Exception:
        pass
    return []


def _external_config_path() -> Path | None:
    env = os.environ.get("PYMTPLOT_CONFIG")
    if env:
        return Path(env)
    argv0 = Path(sys.argv[0]).resolve()
    return argv0.with_name("hub_config.py")


def _build_channels() -> list[ChannelConfig]:
    channels = []
    cfg_path = _external_config_path()
    raw = None
    if cfg_path and cfg_path.exists():
        raw = _load_channels_from_file(cfg_path)
        if raw:
            psb.log_event(f"config loaded from file: {str(cfg_path)}")

    if raw is None:
        raw = getattr(hub_config, "CHANNELS", [])

    for item in raw:
        name = item.get("name")
        plugin = item.get("plugin")
        params = item.get("params", {})
        if not name or not plugin:
            continue
        if item.get("disabled"):
            psb.log_event(f"channel disabled: {name} ({plugin})")
            continue
        psb.log_event(f"channel enabled: {name} ({plugin}) params={params}")
        channels.append(ChannelConfig(name=name, plugin=plugin, params=params))
    return channels


def main() -> None:
    logging.basicConfig(level=logging.DEBUG, format="[%(asctime)s] %(levelname)s: %(message)s")
    log = logging.getLogger("PySharedHub")
    psb.LOG_IO = True
    psb.log_event("debug enabled (LOG_IO=True)")

    psb.log_event("hub start")
    base_cfg = psb.load_bridge_config(log)
    raw_cfg, _ = psb.load_raw_config(log)
    context = {
        "send_bars": raw_cfg.get("send_bars") if raw_cfg else None,
    }

    channels = _build_channels()
    if not channels:
        log.error("No channels defined in hub_config.CHANNELS")
        return

    workers = []
    for ch in channels:
        w = ChannelWorker(ch, base_cfg.dll_path, base_cfg.capacity_bytes, context)
        w.start()
        workers.append(w)

    stop_event = threading.Event()

    def _stop(*_args):
        stop_event.set()
        for w in workers:
            w.stop()

    signal.signal(signal.SIGINT, _stop)
    signal.signal(signal.SIGTERM, _stop)

    while not stop_event.is_set():
        time.sleep(0.2)

    for w in workers:
        w.join(timeout=2.0)

    psb.log_event("hub exit")


if __name__ == "__main__":
    main()
