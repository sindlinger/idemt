#!/usr/bin/env python
"""PySide6 UI for PyShared Hub (multi-channel)."""
from __future__ import annotations

import html
import importlib.util
import logging
import os
import queue
import re
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

try:
    from PySide6 import QtCore, QtGui, QtWidgets
except Exception as exc:
    print("PySide6 not installed or failed to import:", exc)
    sys.exit(1)

from config.defaults import default_indicator_dir

try:
    import pyshared_client_base as psb
except Exception:
    psb = None

try:
    from pyshared_wizard import (
        run_wizard,
        write_indicator_file,
        write_plugin_file,
        create_from_wizard,
    )
except Exception:
    run_wizard = None
    write_indicator_file = None
    write_plugin_file = None
    create_from_wizard = None


APP_NAME = "PyPlot-MT"
APP_VERSION = "1.0.5"
APP_AUTHOR = "Eduardo Candeia Gonçalves"
APP_YEAR = "2026"


def _load_channels(cfg_path: Path) -> list[dict]:
    if cfg_path.exists():
        try:
            text = cfg_path.read_text(encoding="utf-8")
            ns: dict = {}
            exec(text, ns)
            channels = ns.get("CHANNELS", [])
            if isinstance(channels, list):
                return channels
        except Exception:
            pass
        return []

    # Fallback to internal module (zipapp)
    try:
        import hub_config  # type: ignore

        channels = getattr(hub_config, "CHANNELS", [])
        if isinstance(channels, list):
            return channels
    except Exception:
        pass

    return []


class HubRunner:
    def __init__(self, on_line, on_status):
        self._on_line = on_line
        self._on_status = on_status
        self._proc = None
        self._reader = None
        self._queue: queue.Queue[str] = queue.Queue()
        self._stop_requested = False

    def start(self, cmd: list[str], env: dict | None = None) -> None:
        if self.is_running():
            self._on_line("[ui] hub already running")
            return
        self._stop_requested = False
        creationflags = 0
        if os.name == "nt":
            creationflags = subprocess.CREATE_NEW_PROCESS_GROUP
        self._proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            universal_newlines=True,
            creationflags=creationflags,
            env=env,
        )
        self._on_status("starting")
        self._reader = threading.Thread(target=self._read_stdout, daemon=True)
        self._reader.start()

    def stop(self) -> None:
        if not self.is_running():
            self._on_line("[ui] hub not running")
            return
        self._stop_requested = True
        self._on_status("stopping")
        try:
            if os.name == "nt":
                self._proc.send_signal(signal.CTRL_BREAK_EVENT)
            else:
                self._proc.terminate()
        except Exception as exc:
            if getattr(exc, "winerror", None) == 6:
                self._on_line("[ui] hub already stopped")
                return
            self._on_line(f"[ui] stop error: {exc}")

    def force_kill(self) -> None:
        if not self.is_running():
            return
        pid = getattr(self._proc, "pid", None)
        try:
            if os.name == "nt" and pid:
                subprocess.run(
                    ["taskkill", "/PID", str(pid), "/T", "/F"],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    check=False,
                )
            else:
                self._proc.kill()
        except Exception as exc:
            self._on_line(f"[ui] force kill error: {exc}")

    def is_running(self) -> bool:
        return self._proc is not None and self._proc.poll() is None

    def poll_lines(self) -> None:
        while True:
            try:
                line = self._queue.get_nowait()
            except queue.Empty:
                break
            self._on_line(line)
        if self._proc is not None and self._proc.poll() is not None:
            code = self._proc.poll()
            self._on_line(f"[ui] hub exited with code {code}")
            self._proc = None
            self._on_status("stopped")

    def _read_stdout(self) -> None:
        assert self._proc is not None
        for raw in self._proc.stdout:
            line = raw.rstrip("\r\n")
            self._queue.put(line)
        if not self._stop_requested:
            self._queue.put("[ui] hub stopped (stdout closed)")


class MainWindow(QtWidgets.QWidget):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle(f"{APP_NAME} Hub v{APP_VERSION}")
        app_icon = self._load_app_icon()
        if app_icon is not None:
            self.setWindowIcon(app_icon)
        self.resize(980, 620)

        self.status_label = QtWidgets.QLabel("Hub: stopped")
        self.dll_path_label = QtWidgets.QLabel("DLL path:")
        self.dll_path_edit = QtWidgets.QLineEdit("")
        self.dll_path_edit.setReadOnly(True)
        self.dll_refresh_btn = QtWidgets.QPushButton("Refresh DLL path")
        self.path_edit = QtWidgets.QLineEdit(self._default_hub_path())
        self.cfg_edit = QtWidgets.QLineEdit(self._default_cfg_path())

        self.start_btn = QtWidgets.QPushButton("")
        self.stop_btn = QtWidgets.QPushButton("Disconnect DLL")
        self.stop_btn.setEnabled(False)
        self.stop_btn.setVisible(False)
        self.start_btn.setVisible(False)

        self.reload_btn = QtWidgets.QPushButton("")
        self.add_btn = QtWidgets.QPushButton("")
        self.add_existing_btn = QtWidgets.QPushButton("")
        self.connect_toggle_btn = QtWidgets.QPushButton("")
        self.make_indicator_btn = QtWidgets.QPushButton("")
        self.open_cfg_btn = QtWidgets.QPushButton("")
        self.about_btn = QtWidgets.QPushButton("")

        self.follow_btn = QtWidgets.QToolButton()
        self.follow_btn.setCheckable(True)
        self.follow_btn.setChecked(True)

        self.table = QtWidgets.QTableWidget(0, 3)
        self.table.setHorizontalHeaderLabels(["Channel", "Plugin", "Status"])
        self.table.horizontalHeader().setStretchLastSection(True)
        self.table.setSelectionBehavior(QtWidgets.QAbstractItemView.SelectRows)
        self.table.setEditTriggers(QtWidgets.QAbstractItemView.NoEditTriggers)
        self.table.setContextMenuPolicy(QtCore.Qt.CustomContextMenu)
        self.table.customContextMenuRequested.connect(self._on_table_menu)

        self.log = QtWidgets.QTextEdit()
        self.log.setReadOnly(True)
        form = QtWidgets.QFormLayout()
        form.addRow("Hub target:", self.path_edit)
        form.addRow("Config:", self.cfg_edit)
        dll_row = QtWidgets.QHBoxLayout()
        dll_row.addWidget(self.dll_path_edit)
        dll_row.addWidget(self.dll_refresh_btn)
        form.addRow(self.dll_path_label, dll_row)

        btns = QtWidgets.QHBoxLayout()
        btns.addWidget(self.reload_btn)
        btns.addWidget(self.add_btn)
        btns.addWidget(self.add_existing_btn)
        btns.addWidget(self.connect_toggle_btn)
        btns.addWidget(self.make_indicator_btn)
        btns.addWidget(self.open_cfg_btn)
        btns.addWidget(self.about_btn)
        btns.addWidget(self.follow_btn)
        btns.addStretch(1)

        layout = QtWidgets.QVBoxLayout(self)
        layout.addWidget(self.status_label)
        layout.addLayout(form)
        layout.addLayout(btns)
        layout.addWidget(self.table)
        layout.addWidget(self.log)

        self.runner = HubRunner(self._append_log, self._set_status)
        self._channel_colors: dict[str, str] = {}
        self._channel_connected: set[str] = set()
        self._channel_last_activity: dict[str, float] = {}
        self._channel_disabled: set[str] = set()
        self._channel_missing: set[str] = set()
        self._indicator_map: dict[str, str] = {}
        self._live_timeout_sec = 3.0
        self._pending_restart = False
        self._restart_deadline = 0.0
        self._mt5_queue: queue.Queue[str] = queue.Queue()
        self._mt5_stop = threading.Event()
        self._mt5_threads: list[threading.Thread] = []
        self.start_btn.clicked.connect(self._on_toggle)
        self.stop_btn.clicked.connect(self._on_stop)
        self.reload_btn.clicked.connect(self._load_channels)
        self.add_btn.clicked.connect(self._on_add_plugin)
        self.add_existing_btn.clicked.connect(self._on_add_existing_plugin)
        self.open_cfg_btn.clicked.connect(self._on_open_config)
        self.about_btn.clicked.connect(self._show_about)
        self.dll_refresh_btn.clicked.connect(self._refresh_dll_path)
        self.connect_toggle_btn.clicked.connect(self._on_toggle_connect_selected)
        self.make_indicator_btn.clicked.connect(self._on_make_indicator)
        self.table.itemSelectionChanged.connect(self._sync_plugin_buttons)
        self.follow_btn.toggled.connect(self._on_follow_toggled)

        self._init_icon_buttons()

        self.timer = QtCore.QTimer(self)
        self.timer.setInterval(100)
        self.timer.timeout.connect(self._on_timer)
        self.timer.start()

        self._init_tray()
        self._load_channels()
        self._refresh_dll_path()
        self._start_mt5_log_tail()
        self._append_log("[ui] log tags: [IND]=indicator, [PLG]=plugin")
        QtCore.QTimer.singleShot(250, self._auto_start)

    def _default_hub_path(self) -> str:
        argv0 = Path(sys.argv[0]).resolve()
        if argv0.suffix.lower() == ".pyz":
            return str(argv0)
        here = Path(__file__).resolve()
        return str(here.with_name("pyshared_hub.py"))

    def _default_cfg_path(self) -> str:
        argv0 = Path(sys.argv[0]).resolve()
        cfg = argv0.with_name("hub_config.py")
        if cfg.exists():
            if os.access(cfg, os.W_OK):
                return str(cfg)
        elif cfg.parent.exists() and os.access(cfg.parent, os.W_OK):
            return str(cfg)
        return str(self._user_config_path())

    def _user_config_path(self) -> Path:
        base = Path(os.environ.get("APPDATA", str(Path.home())))
        return base / APP_NAME / "hub_config.py"

    def _init_tray(self) -> None:
        self.tray = QtWidgets.QSystemTrayIcon(self)
        icon = self._load_app_icon()
        if icon is None:
            icon = self.style().standardIcon(QtWidgets.QStyle.SP_ComputerIcon)
        self.tray.setIcon(icon)
        self.tray.setToolTip(f"{APP_NAME} Hub v{APP_VERSION}")

        menu = QtWidgets.QMenu()
        self.action_show = menu.addAction("Show/Hide")
        self.action_about = menu.addAction("About")
        menu.addSeparator()
        self.action_quit = menu.addAction("Quit")

        self.action_show.triggered.connect(self._toggle_window)
        self.action_about.triggered.connect(self._show_about)
        self.action_quit.triggered.connect(self._quit_app)

        self.tray.setContextMenu(menu)
        self.tray.activated.connect(self._on_tray_activated)
        self.tray.show()

    def _init_icon_buttons(self) -> None:
        self._set_icon_button(
            self.start_btn,
            self._style_pixmap("SP_MediaPlay", QtWidgets.QStyle.SP_MediaPlay),
            "Connect/Disconnect DLL",
        )
        self._set_icon_button(
            self.reload_btn,
            self._style_pixmap("SP_BrowserReload", QtWidgets.QStyle.SP_BrowserStop),
            "Reload channels",
        )
        self._set_icon_button(
            self.add_btn,
            self._style_pixmap("SP_FileDialogNewFolder", QtWidgets.QStyle.SP_FileIcon),
            "New plugin",
        )
        self._set_icon_button(
            self.add_existing_btn,
            self._style_pixmap("SP_DialogOpenButton", QtWidgets.QStyle.SP_FileDialogStart),
            "Add existing plugin",
        )
        self._set_icon_button(
            self.open_cfg_btn,
            self._style_pixmap("SP_FileDialogDetailedView", QtWidgets.QStyle.SP_FileDialogListView),
            "Open config",
        )
        self._set_icon_button(
            self.about_btn,
            self._style_pixmap("SP_MessageBoxInformation", QtWidgets.QStyle.SP_MessageBoxInformation),
            "About",
        )

        self._set_icon_button(
            self.connect_toggle_btn,
            self._style_pixmap("SP_MediaPlay", QtWidgets.QStyle.SP_MediaPlay),
            "Connect/Disconnect plugin",
        )
        self._set_icon_button(
            self.make_indicator_btn,
            self._style_pixmap("SP_FileIcon", QtWidgets.QStyle.SP_FileIcon),
            "Create indicator",
        )
        self.follow_btn.setIcon(self.style().standardIcon(self._style_pixmap("SP_ArrowDown", QtWidgets.QStyle.SP_ArrowDown)))
        self.follow_btn.setToolTip("Auto-scroll log")
        self.follow_btn.setFixedHeight(28)
        self.follow_btn.setIconSize(QtCore.QSize(16, 16))

        self._sync_plugin_buttons()

    def _set_icon_button(self, btn: QtWidgets.QPushButton, icon: QtWidgets.QStyle.StandardPixmap, tip: str) -> None:
        btn.setIcon(self.style().standardIcon(icon))
        btn.setToolTip(tip)
        btn.setText("")
        btn.setFixedHeight(28)
        btn.setIconSize(QtCore.QSize(16, 16))

    def _style_pixmap(self, name: str, fallback: QtWidgets.QStyle.StandardPixmap) -> QtWidgets.QStyle.StandardPixmap:
        return getattr(QtWidgets.QStyle, name, fallback)

    def _selected_status(self) -> str | None:
        row = self.table.currentRow()
        if row < 0:
            return None
        item = self.table.item(row, 2)
        return item.text() if item else None

    def _sync_plugin_buttons(self) -> None:
        status = self._selected_status()
        if status == "disabled":
            self._set_icon_button(
                self.connect_toggle_btn,
                self._style_pixmap("SP_MediaPlay", QtWidgets.QStyle.SP_MediaPlay),
                "Connect plugin",
            )
        else:
            self._set_icon_button(
                self.connect_toggle_btn,
                self._style_pixmap("SP_MediaStop", QtWidgets.QStyle.SP_MediaStop),
                "Disconnect plugin",
            )

        enabled = status is not None and status != "missing"
        self.connect_toggle_btn.setEnabled(enabled)
        self.make_indicator_btn.setEnabled(enabled)

    def _toggle_window(self) -> None:
        if self.isVisible():
            self.hide()
        else:
            self.showNormal()
            self.raise_()
            self.activateWindow()

    def _load_app_icon(self) -> QtGui.QIcon | None:
        try:
            argv0 = Path(sys.argv[0]).resolve()
            for name in ("pyplot-mt.ico", "pymtplot.ico"):
                icon_path = argv0.with_name(name)
                if icon_path.exists():
                    return QtGui.QIcon(str(icon_path))
        except Exception:
            pass
        return None

    def _on_tray_activated(self, reason: QtWidgets.QSystemTrayIcon.ActivationReason) -> None:
        if reason == QtWidgets.QSystemTrayIcon.Trigger:
            self._toggle_window()

    def _quit_app(self) -> None:
        if self.runner.is_running():
            self.runner.stop()
        self._mt5_stop.set()
        QtWidgets.QApplication.quit()

    def _show_about(self) -> None:
        text = (
            f"<b>{APP_NAME} Hub</b><br>"
            f"Version: {APP_VERSION}<br>"
            f"Year: {APP_YEAR}<br>"
            f"Author: {APP_AUTHOR}"
        )
        QtWidgets.QMessageBox.about(self, f"About {APP_NAME}", text)

    def _set_status(self, status: str) -> None:
        label = "Hub"
        if status == "starting":
            self.status_label.setText(f"{label}: starting")
        elif status == "stopping":
            self.status_label.setText(f"{label}: stopping")
        elif status == "stopped":
            self.status_label.setText(f"{label}: stopped")
        else:
            self.status_label.setText(f"{label}: {status}")
        running = self.runner.is_running()
        if running:
            self._set_icon_button(self.start_btn, QtWidgets.QStyle.SP_MediaStop, "Disconnect DLL")
        else:
            self._set_icon_button(self.start_btn, QtWidgets.QStyle.SP_MediaPlay, "Connect DLL")
        self.start_btn.setEnabled(True)

    def _append_log(self, line: str) -> None:
        if not line:
            return
        if not line.startswith("[ui]") and "[IND]" not in line and "[PLG]" not in line:
            if re.match(r"^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},\d{3}\]", line):
                line = self._insert_tag_after_date(line, "PLG")
        self._append_colored_log(line)
        if self.follow_btn.isChecked():
            self.log.verticalScrollBar().setValue(self.log.verticalScrollBar().maximum())
        self._update_channel_status_from_log(line)

    def _update_channel_status_from_log(self, line: str) -> None:
        ch = self._extract_channel(line)
        if not ch:
            return
        if "[Connected]" in line:
            self._channel_connected.add(ch)
            self._set_channel_status(ch, "connected")
        elif "[Disconnected]" in line:
            self._channel_connected.discard(ch)
            self._set_channel_status(ch, "disconnected")
        if re.search(r"\b(RX|TX)\b", line):
            self._mark_channel_live(ch)

    def _set_channel_status(self, channel: str, status: str) -> None:
        for row in range(self.table.rowCount()):
            if self.table.item(row, 0).text() == channel:
                self.table.item(row, 2).setText(status)
                self._apply_row_style(row, status, channel)
                break
        self._sync_plugin_buttons()

    def _mark_channel_live(self, channel: str) -> None:
        if channel in self._channel_disabled or channel in self._channel_missing:
            return
        self._channel_last_activity[channel] = time.time()
        self._set_channel_status(channel, "live")

    def _apply_row_style(self, row: int, status: str, channel: str | None = None) -> None:
        base = QtGui.QColor("#1b1b1b")
        if channel:
            base = QtGui.QColor(self._channel_colors.get(channel, "#1b1b1b"))
        base_bg = base.darker(180)

        status_color = QtGui.QColor("#1b1b1b")
        if status == "connected":
            status_color = QtGui.QColor("#1e6b3a")
        elif status == "disconnected":
            status_color = QtGui.QColor("#3a3a3a")
        elif status == "disabled":
            status_color = QtGui.QColor("#2a2a2a")
        elif status == "missing":
            status_color = QtGui.QColor("#7a4a1e")
        elif status == "live":
            status_color = QtGui.QColor("#1f7a4c")
        elif status == "connecting":
            status_color = QtGui.QColor("#5a4a1a")

        for col in range(3):
            item = self.table.item(row, col)
            if item is None:
                continue
            if col == 2:
                item.setBackground(status_color)
                item.setForeground(QtGui.QColor("#ffffff"))
            else:
                item.setBackground(base_bg)
                item.setForeground(QtGui.QColor("#ffffff"))
        if channel:
            self._apply_channel_icon(row, channel)

    def _load_channels(self) -> None:
        path = Path(self.cfg_edit.text().strip().strip('"'))
        self._append_log(f"[ui] load channels from: {str(path)}")
        channels = _load_channels(path)
        self.table.setRowCount(0)
        self._channel_colors = {}
        self._channel_disabled = set()
        self._channel_missing = set()
        self._indicator_map = {}
        for ch in channels:
            row = self.table.rowCount()
            self.table.insertRow(row)
            name = str(ch.get("name", ""))
            if name and name not in self._channel_colors:
                color = self._normalize_color(ch.get("color"))
                if color is None:
                    color = self._pick_color(len(self._channel_colors))
                self._channel_colors[name] = color
            name_item = QtWidgets.QTableWidgetItem(name)
            self.table.setItem(row, 0, name_item)
            self.table.setItem(row, 1, QtWidgets.QTableWidgetItem(str(ch.get("plugin", ""))))
            plugin_spec = str(ch.get("plugin", ""))
            status = "disabled" if ch.get("disabled") else "idle"
            if not self._plugin_exists(plugin_spec):
                status = "missing"
                if name:
                    self._channel_missing.add(name)
                if plugin_spec:
                    self._append_log(f"[ui] plugin missing: {name} -> {plugin_spec}")
            if ch.get("disabled") and name:
                self._channel_disabled.add(name)
            self.table.setItem(row, 2, QtWidgets.QTableWidgetItem(status))
            self._apply_row_style(row, status, name)
            if name:
                self._append_log(
                    f"[ui] channel name={name} plugin={plugin_spec} disabled={bool(ch.get('disabled'))} status={status}"
                )
            if name:
                ind_path = self._get_channel_indicator(name)
                if ind_path is None or not ind_path.exists():
                    guess = self._guess_indicator_path(name, plugin_spec)
                    if guess is not None and guess.exists():
                        self._set_channel_indicator(name, guess)
                        self._append_log(f"[ui] indicator auto-set: {name} -> {guess}")
                        ind_path = guess
                if ind_path is not None:
                    stem = ind_path.stem.lower()
                    self._indicator_map[stem] = name
                    self._indicator_map[f"pyplotmt-{stem}".lower()] = name
            if name:
                self._indicator_map[f"pyplot-mt_{name}".lower()] = name
                self._indicator_map[f"pyplotmt-{name}".lower()] = name
        self._sync_plugin_buttons()

    def _pick_color(self, idx: int) -> str:
        palette = [
            "#6aa6ff",
            "#6ad1a6",
            "#ffb86a",
            "#ff6a88",
            "#b58cff",
            "#7bdff2",
            "#c8d66b",
            "#f2a0ff",
        ]
        return palette[idx % len(palette)]

    def _plugin_exists(self, plugin: str) -> bool:
        if not plugin:
            return False
        path = self._resolve_plugin_path(plugin)
        if path is not None and path.exists():
            return True
        try:
            spec = importlib.util.find_spec(plugin)
        except Exception:
            spec = None
        if spec is not None and spec.origin and ".pyz" in str(spec.origin).lower():
            return True
        return spec is not None

    def _guess_indicator_path(self, name: str, plugin_spec: str = "") -> Path | None:
        root = default_indicator_dir()
        candidates = [
            root / f"PyPlot-MT_{name}.mq5",
            root / f"{name}.mq5",
        ]
        if plugin_spec:
            plugin_path = self._resolve_plugin_path(plugin_spec)
            if plugin_path is not None:
                candidates.append(root / f"{plugin_path.stem}.mq5")
                candidates.append(root / f"PyPlot-MT_{plugin_path.stem}.mq5")
            else:
                mod = plugin_spec.split(".")[-1]
                candidates.append(root / f"{mod}.mq5")
                candidates.append(root / f"PyPlot-MT_{mod}.mq5")

        for cand in candidates:
            if cand.exists():
                return cand

        if root.exists():
            for cand in candidates:
                found = next(root.rglob(cand.name), None)
                if found is not None:
                    return found
        return None

    def _resolve_plugin_path(self, plugin: str) -> Path | None:
        p = Path(plugin)
        if p.exists():
            return p
        try:
            spec = importlib.util.find_spec(plugin)
        except Exception:
            spec = None
        if spec is None:
            return None
        origin = spec.origin
        if not origin or origin == "built-in":
            return None
        origin_path = Path(origin)
        if origin_path.exists():
            return origin_path
        # If running from .pyz, try to map to local source tree
        origin_str = str(origin)
        if ".pyz" in origin_str.lower():
            pyz_part = origin_str.lower().split(".pyz")[0] + ".pyz"
            pyz_path = Path(pyz_part)
            repo_root = pyz_path.parent.parent
            rel_parts = plugin.split(".")
            if rel_parts and rel_parts[0] == "plugins":
                rel_parts = ["src", "pyshared_hub"] + rel_parts
            candidate = repo_root.joinpath(*rel_parts).with_suffix(".py")
            if candidate.exists():
                return candidate
            return None
        return None

    def _normalize_color(self, value: str | None) -> str | None:
        if not value:
            return None
        color = QtGui.QColor(str(value))
        if not color.isValid():
            return None
        return color.name()

    def _apply_channel_icon(self, row: int, channel: str) -> None:
        item = self.table.item(row, 0)
        if item is None:
            return
        color = QtGui.QColor(self._channel_colors.get(channel, "#cfcfcf"))
        pix = QtGui.QPixmap(10, 10)
        pix.fill(QtCore.Qt.transparent)
        painter = QtGui.QPainter(pix)
        painter.setRenderHint(QtGui.QPainter.Antialiasing, True)
        painter.setPen(QtCore.Qt.NoPen)
        painter.setBrush(color)
        painter.drawEllipse(0, 0, 9, 9)
        painter.end()
        item.setIcon(QtGui.QIcon(pix))

    def _extract_channel(self, line: str) -> str | None:
        tags = re.findall(r"\[([^\]]+)\]", line)
        if not tags:
            line_low = line.lower()
        else:
            if tags[0].isdigit() and len(tags) > 1:
                return tags[1]
            if tags[0] in self._channel_colors:
                return tags[0]
            line_low = line.lower()
        for name in self._channel_colors.keys():
            if name and name.lower() in line_low:
                return name
        m = re.search(r"pyplotmt-([a-z0-9_\\-]+)", line_low)
        if m:
            raw = re.sub(r"[^a-z0-9_]", "", m.group(1))
            cand = raw.upper()
            if cand in self._channel_colors:
                return cand
        for key, ch in self._indicator_map.items():
            if key in line_low:
                return ch
        return None

    def _append_colored_log(self, line: str) -> None:
        channel = self._extract_channel(line)
        if channel and channel not in self._channel_colors:
            self._channel_colors[channel] = self._pick_color(len(self._channel_colors))
        color = self._color_for_log(line, channel)
        safe = html.escape(line)
        chip = ""
        if channel:
            chip = (
                f"<span style='display:inline-block;width:10px;height:10px;"
                f"background-color:{color};margin-right:6px;vertical-align:middle;'></span>"
            )
        self.log.append(f"{chip}<span style='color:{color}'>{safe}</span>")

    def _color_for_log(self, line: str, channel: str | None) -> str:
        if channel:
            return self._channel_colors.get(channel, "#cfcfcf")
        return "#cfcfcf"

    def _on_toggle(self) -> None:
        if self.runner.is_running():
            self._on_stop()
        else:
            self._on_start()

    def _on_follow_toggled(self, checked: bool) -> None:
        self.follow_btn.setToolTip("Auto-scroll log (on)" if checked else "Auto-scroll log (off)")

    def _auto_start(self) -> None:
        if not self.runner.is_running():
            self._on_start()

    def _on_start(self) -> None:
        script = self.path_edit.text().strip().strip('"')
        if not script:
            self._append_log("[ui] missing hub target")
            return
        if not Path(script).exists():
            self._append_log(f"[ui] hub not found: {script}")
            return
        cmd = self._build_hub_cmd(script)
        self._append_log(f"[ui] start: {' '.join(cmd)}")
        self.runner.start(cmd, env=self._hub_env())
        self._set_status("starting")
        QtCore.QTimer.singleShot(500, self._mark_connected_if_running)

    def _mark_connected_if_running(self) -> None:
        if self.runner.is_running():
            self.status_label.setText("Hub: running")

    def _build_hub_cmd(self, target: str) -> list[str]:
        if target.lower().endswith(".pyz"):
            return [sys.executable, target, "--hub"]
        return [sys.executable, target]

    def _refresh_dll_path(self) -> None:
        if psb is None:
            self.dll_path_edit.setText("(pyshared_client_base not found)")
            return
        try:
            cfg = psb.load_bridge_config(logging.getLogger("PyPlotMTUI"))
            self.dll_path_edit.setText(cfg.dll_path)
        except Exception:
            self.dll_path_edit.setText("(not found)")

    def _config_path(self) -> Path:
        raw = self.cfg_edit.text().strip().strip('"')
        if not raw:
            return self._user_config_path()
        return Path(os.path.expandvars(raw))

    def _hub_env(self) -> dict:
        env = os.environ.copy()
        cfg_path = self._config_path()
        if cfg_path:
            env["PYMTPLOT_CONFIG"] = str(cfg_path)
        return env

    def _write_config(self, channels: list[dict]) -> None:
        path = self._config_path()
        if not path.parent.exists():
            path.parent.mkdir(parents=True, exist_ok=True)
        body = "CHANNELS = " + repr(channels) + "\n"
        try:
            path.write_text(body, encoding="utf-8")
        except Exception as exc:
            self._append_log(f"[ui] config write error: {exc}")
            raise

    def _read_config(self) -> list[dict]:
        path = self._config_path()
        channels = _load_channels(path)
        if channels:
            return channels
        return _load_channels(Path("hub_config.py"))

    def _on_table_menu(self, pos: QtCore.QPoint) -> None:
        menu = QtWidgets.QMenu(self)
        add_action = menu.addAction("New Plugin...")
        add_existing = menu.addAction("Add Existing Plugin...")
        menu.addSeparator()
        toggle_connect = menu.addAction("Connect/Disconnect Plugin")
        set_color_action = menu.addAction("Set Color...")
        reset_color_action = menu.addAction("Reset Color")
        remove_action = menu.addAction("Remove")
        open_action = menu.addAction("Open Plugin File")
        open_indicator_action = menu.addAction("Open Indicator File")
        set_indicator_action = menu.addAction("Set Indicator File...")

        row = self.table.rowAt(pos.y())
        if row >= 0:
            self.table.selectRow(row)
            self.table.setCurrentCell(row, 0)
        else:
            row = self.table.currentRow()
        has_row = row >= 0
        toggle_connect.setEnabled(has_row)
        set_color_action.setEnabled(has_row)
        reset_color_action.setEnabled(has_row)
        remove_action.setEnabled(has_row)
        open_action.setEnabled(has_row)
        open_indicator_action.setEnabled(has_row)
        set_indicator_action.setEnabled(has_row)

        action = menu.exec(self.table.viewport().mapToGlobal(pos))
        if action == add_action:
            self._on_add_plugin()
            return
        if action == add_existing:
            self._on_add_existing_plugin()
            return
        if not has_row:
            return
        name_item = self.table.item(row, 0)
        plugin_item = self.table.item(row, 1)
        name = name_item.text() if name_item else ""
        plugin = plugin_item.text() if plugin_item else ""

        if action == toggle_connect:
            self._on_toggle_connect_selected()
        elif action == set_color_action:
            self._pick_channel_color(name)
        elif action == reset_color_action:
            self._clear_channel_color(name)
        elif action == remove_action:
            self._remove_channel(name)
        elif action == open_action:
            self._open_plugin_file(plugin)
        elif action == open_indicator_action:
            self._open_indicator_file(name)
        elif action == set_indicator_action:
            self._set_indicator_file(name)

    def _on_add_plugin(self) -> None:
        if run_wizard is None:
            self._append_log("[ui] wizard module not available")
            return
        res = run_wizard(self)
        if res is None:
            return
        channels = self._read_config()
        plugin_spec = res.get("plugin_spec") or str(res.get("plugin_path", ""))
        params = res.get("params") or {}
        entry = {"name": res["channel"], "plugin": plugin_spec, "params": params}
        if res.get("indicator_path"):
            entry["indicator"] = str(res["indicator_path"])
        channels.append(entry)
        self._write_config(channels)
        if create_from_wizard is not None:
            create_from_wizard(res)
        else:
            if res.get("create_plugin") and write_plugin_file is not None:
                write_plugin_file(Path(res["plugin_path"]), res["name"], res["channel"], res["buffers"])
            if res.get("create_indicator") and write_indicator_file is not None:
                write_indicator_file(Path(res["indicator_path"]), res)
        self._append_log(f"[ui] new plugin: {res['name']} -> {res['plugin_path']}")
        self._load_channels()
        if self.runner.is_running():
            self._append_log("[ui] restart hub to apply changes")

    def _on_add_existing_plugin(self) -> None:
        file_path, _ = QtWidgets.QFileDialog.getOpenFileName(
            self, "Select plugin (.py)", "", "Python files (*.py)"
        )
        if not file_path:
            return
        name, ok = QtWidgets.QInputDialog.getText(self, "Channel name", "Name:")
        if not ok or not name.strip():
            return
        channels = self._read_config()
        channels.append({"name": name.strip(), "plugin": file_path, "params": {}})
        self._write_config(channels)
        self._append_log(f"[ui] added existing plugin: {name.strip()}")
        self._load_channels()
        if self.runner.is_running():
            self._append_log("[ui] restart hub to apply changes")

    def _selected_channel(self) -> tuple[str, str] | None:
        row = self.table.currentRow()
        if row < 0:
            return None
        name_item = self.table.item(row, 0)
        plugin_item = self.table.item(row, 1)
        name = name_item.text() if name_item else ""
        plugin = plugin_item.text() if plugin_item else ""
        if not name:
            return None
        return name, plugin

    def _on_connect_selected(self) -> None:
        selected = self._selected_channel()
        if not selected:
            self._append_log("[ui] select a channel first")
            return
        name, _ = selected
        self._connect_channel(name)

    def _on_toggle_connect_selected(self) -> None:
        selected = self._selected_channel()
        if not selected:
            self._append_log("[ui] select a channel first")
            return
        name, _ = selected
        status = self._selected_status()
        if status == "disabled":
            self._connect_channel(name)
        else:
            self._disconnect_channel(name)

    def _on_toggle_selected(self) -> None:
        selected = self._selected_channel()
        if not selected:
            self._append_log("[ui] select a channel first")
            return
        name, _ = selected
        self._toggle_channel_disabled(name)

    def _default_buffers_for_plugin(self, plugin: str) -> int:
        low = plugin.lower()
        if "fft_waveform" in low:
            return 12
        return 1

    def _on_make_indicator(self) -> None:
        if write_indicator_file is None:
            self._append_log("[ui] indicator generator not available")
            return
        selected = self._selected_channel()
        if not selected:
            self._append_log("[ui] select a channel first")
            return
        channel, plugin = selected
        name, ok = QtWidgets.QInputDialog.getText(
            self, "Indicator name", "Name:", text=channel
        )
        if not ok or not name.strip():
            return
        buffers_default = self._default_buffers_for_plugin(plugin)
        buffers, ok = QtWidgets.QInputDialog.getInt(
            self, "Buffers", "Buffers:", value=buffers_default, min=1, max=256
        )
        if not ok:
            return
        plot_types = ["Line", "Histogram", "Arrow"]
        plot_type, ok = QtWidgets.QInputDialog.getItem(
            self, "Plot type", "Plot type:", plot_types, 0, False
        )
        if not ok:
            return
        folder = default_indicator_dir()
        folder_str = QtWidgets.QFileDialog.getExistingDirectory(
            self, "Select Indicators folder", str(folder)
        )
        if not folder_str:
            return
        indicator_path = Path(folder_str) / f"PyPlot-MT_{name.strip()}.mq5"
        try:
            write_indicator_file(indicator_path, {
                "name": name.strip(),
                "channel": channel,
                "buffers": int(buffers),
                "plot_type": plot_type,
            })
            self._set_channel_indicator(channel, indicator_path)
            self._append_log(f"[ui] indicator created: {indicator_path}")
        except Exception as exc:
            self._append_log(f"[ui] indicator create error: {exc}")

    def _on_open_config(self) -> None:
        path = self._config_path()
        if not path.exists():
            self._write_config(self._read_config())
        try:
            os.startfile(str(path))  # type: ignore[attr-defined]
        except Exception as exc:
            self._append_log(f"[ui] open config error: {exc}")

        # indicator creation moved to wizard module

    def _toggle_channel_disabled(self, name: str) -> None:
        if not name:
            return
        channels = self._read_config()
        for ch in channels:
            if ch.get("name") == name:
                ch["disabled"] = not ch.get("disabled", False)
                break
        try:
            self._write_config(channels)
        except Exception:
            return
        self._load_channels()
        if self.runner.is_running():
            self._restart_hub()
        else:
            self._append_log("[ui] channel toggled (hub stopped)")

    def _set_channel_disabled(self, name: str, disabled: bool) -> None:
        if not name:
            return
        channels = self._read_config()
        for ch in channels:
            if ch.get("name") == name:
                ch["disabled"] = disabled
                break
        try:
            self._write_config(channels)
        except Exception:
            return
        if disabled:
            self._channel_connected.discard(name)
            self._channel_last_activity.pop(name, None)
        self._load_channels()
        if self.runner.is_running():
            self._restart_hub()
        else:
            state = "disabled" if disabled else "enabled"
            self._append_log(f"[ui] channel {state} (hub stopped)")

    def _pick_channel_color(self, name: str) -> None:
        if not name:
            return
        current = QtGui.QColor(self._channel_colors.get(name, "#6aa6ff"))
        color = QtWidgets.QColorDialog.getColor(current, self, "Select color")
        if not color.isValid():
            return
        self._set_channel_color(name, color.name())

    def _clear_channel_color(self, name: str) -> None:
        if not name:
            return
        channels = self._read_config()
        for ch in channels:
            if ch.get("name") == name:
                if "color" in ch:
                    ch.pop("color", None)
                break
        try:
            self._write_config(channels)
        except Exception:
            return
        self._load_channels()

    def _set_channel_color(self, name: str, color: str) -> None:
        channels = self._read_config()
        for ch in channels:
            if ch.get("name") == name:
                ch["color"] = color
                break
        try:
            self._write_config(channels)
        except Exception:
            return
        self._channel_colors[name] = color
        self._load_channels()

    def _connect_channel(self, name: str) -> None:
        self._set_channel_disabled(name, False)
        self._set_channel_status(name, "connecting")
        if not self.runner.is_running():
            self._on_start()

    def _disconnect_channel(self, name: str) -> None:
        self._set_channel_disabled(name, True)

    def _remove_channel(self, name: str) -> None:
        if not name:
            return
        channels = self._read_config()
        channels = [c for c in channels if c.get("name") != name]
        self._write_config(channels)
        self._load_channels()
        if self.runner.is_running():
            self._append_log("[ui] restart hub to apply removal")

    def _open_plugin_file(self, plugin: str) -> None:
        if not plugin:
            return
        path = self._resolve_plugin_path(plugin)
        if path is not None and path.exists():
            try:
                os.startfile(str(path))  # type: ignore[attr-defined]
            except Exception as exc:
                self._append_log(f"[ui] open plugin error: {exc}")
            return
        try:
            spec = importlib.util.find_spec(plugin)
        except Exception:
            spec = None
        if spec is not None and spec.origin and ".pyz" in spec.origin.lower():
            self._append_log("[ui] plugin is packaged inside app (no file on disk)")
            return
        self._append_log("[ui] plugin path not found")

    def _open_indicator_file(self, name: str) -> None:
        path = self._get_channel_indicator(name)
        if path is None or not path.exists():
            plugin = ""
            sel = self._selected_channel()
            if sel is not None:
                _, plugin = sel
            guess = self._guess_indicator_path(name, plugin)
            if guess is not None and guess.exists():
                path = guess
                self._set_channel_indicator(name, guess)
            else:
                self._append_log("[ui] indicator path not set (use Set Indicator File...)")
                return
        try:
            os.startfile(str(path))  # type: ignore[attr-defined]
        except Exception as exc:
            self._append_log(f"[ui] open indicator error: {exc}")

    def _set_indicator_file(self, name: str) -> None:
        if not name:
            return
        folder = default_indicator_dir()
        file_path, _ = QtWidgets.QFileDialog.getOpenFileName(
            self, "Select indicator (.mq5)", str(folder), "MQL5 files (*.mq5)"
        )
        if not file_path:
            return
        self._set_channel_indicator(name, Path(file_path))

    def _get_channel_indicator(self, name: str) -> Path | None:
        channels = self._read_config()
        for ch in channels:
            if ch.get("name") == name:
                val = ch.get("indicator")
                if val:
                    return Path(str(val))
        return None

    def _set_channel_indicator(self, name: str, path: Path) -> None:
        channels = self._read_config()
        for ch in channels:
            if ch.get("name") == name:
                ch["indicator"] = str(path)
                break
        try:
            self._write_config(channels)
        except Exception:
            return

    def _restart_hub(self) -> None:
        if self.runner.is_running():
            self._on_stop()
            self._pending_restart = True
            self._restart_deadline = time.time() + 3.0
        else:
            self._on_start()

    def _on_stop(self) -> None:
        self.runner.stop()

    def _on_timer(self) -> None:
        self.runner.poll_lines()
        self._drain_mt5_logs()
        self._refresh_live_status()
        if self._pending_restart:
            if not self.runner.is_running():
                self._pending_restart = False
                self._on_start()
            elif time.time() > self._restart_deadline:
                self._append_log("[ui] restart timeout (forcing hub stop)")
                self.runner.force_kill()
                self._restart_deadline = time.time() + 2.0

    def _refresh_live_status(self) -> None:
        now = time.time()
        for row in range(self.table.rowCount()):
            name_item = self.table.item(row, 0)
            status_item = self.table.item(row, 2)
            if name_item is None or status_item is None:
                continue
            name = name_item.text()
            status = status_item.text()
            if name in self._channel_disabled or name in self._channel_missing:
                continue
            last = self._channel_last_activity.get(name)
            if last is None:
                continue
            if (now - last) > self._live_timeout_sec:
                if name in self._channel_connected:
                    self._set_channel_status(name, "connected")
                else:
                    self._set_channel_status(name, "idle")

    def _drain_mt5_logs(self) -> None:
        while True:
            try:
                line = self._mt5_queue.get_nowait()
            except queue.Empty:
                break
            if line.startswith("MT5:"):
                try:
                    _, rest = line.split("MT5:", 1)
                    label, raw = rest.split("|", 1)
                except Exception:
                    self._append_log(line)
                    continue
                tag = "IND"
                decorated = self._insert_tag_after_date(raw, tag)
                self._append_log(decorated)
            else:
                self._append_log(line)

    def _insert_tag_after_date(self, line: str, tag: str) -> str:
        m = re.match(r"^(\d{4}\.\d{2}\.\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\s+(.*)$", line)
        if m:
            return f"{m.group(1)} [{tag}] {m.group(2)}"
        m = re.match(r"^(\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},\d{3}\])\s+(.*)$", line)
        if m:
            return f"{m.group(1)}[{tag}] {m.group(2)}"
        return f"[{tag}] {line}"

    def closeEvent(self, event: QtCore.QEvent) -> None:
        event.ignore()
        self.hide()

    def _start_mt5_log_tail(self) -> None:
        root = self._detect_mt5_root()
        if root is None:
            self._append_log("[ui] mt5 logs not found (APPDATA/MetaQuotes/Terminal)")
            return
        experts = root / "MQL5" / "Logs"
        if experts.exists():
            self._start_mt5_thread(experts, "experts")

    def _start_mt5_thread(self, log_dir: Path, label: str) -> None:
        t = threading.Thread(target=self._tail_mt5_logs, args=(log_dir, label), daemon=True)
        self._mt5_threads.append(t)
        t.start()

    def _detect_mt5_root(self) -> Path | None:
        channels = self._read_config()
        for ch in channels:
            ind = ch.get("indicator")
            if not ind:
                continue
            p = Path(str(ind))
            for parent in [p.parent] + list(p.parents):
                if parent.name.lower() == "mql5":
                    return parent.parent
        appdata = os.environ.get("APPDATA")
        if not appdata:
            return None
        base = Path(appdata) / "MetaQuotes" / "Terminal"
        if not base.exists():
            return None
        candidates = sorted(base.glob("*"), key=lambda p: p.stat().st_mtime, reverse=True)
        for c in candidates:
            if (c / "MQL5" / "Logs").exists() or (c / "Logs").exists():
                return c
        return None

    def _tail_mt5_logs(self, log_dir: Path, label: str) -> None:
        current_path: Path | None = None
        f = None
        pos = 0
        buf = b""
        while not self._mt5_stop.is_set():
            date_name = time.strftime("%Y%m%d")
            path = log_dir / f"{date_name}.log"
            if current_path != path:
                if f:
                    try:
                        f.close()
                    except Exception:
                        pass
                current_path = path
                if path.exists():
                    try:
                        f = path.open("rb")
                        f.seek(0, os.SEEK_END)
                        pos = f.tell()
                        buf = b""
                    except Exception:
                        f = None
                else:
                    f = None
            if f is None:
                time.sleep(0.5)
                continue
            try:
                chunk = f.read()
            except Exception:
                chunk = b""
            if chunk:
                pos += len(chunk)
                buf += chunk
                while True:
                    idx = buf.find(b"\n")
                    if idx < 0:
                        break
                    raw_line = buf[: idx + 1]
                    buf = buf[idx + 1 :]
                    text = self._decode_mt5_line(raw_line)
                    if text and self._mt5_line_matches_indicator(text):
                        self._mt5_queue.put(f"MT5:{label}|{text}")
            else:
                try:
                    size = current_path.stat().st_size if current_path else 0
                except Exception:
                    size = 0
                if size < pos:
                    try:
                        f.seek(0, os.SEEK_END)
                        pos = f.tell()
                        buf = b""
                    except Exception:
                        pass
                else:
                    pos = f.tell()
                time.sleep(0.2)

    def _decode_mt5_line(self, raw: bytes) -> str:
        if not raw:
            return ""
        data = raw.replace(b"\r", b"").replace(b"\x00", b"")
        # Detect UTF-16 (BOM or null-heavy)
        if raw.startswith(b"\xff\xfe") or raw.startswith(b"\xfe\xff") or raw.count(b"\x00") > 0:
            try:
                text = raw.decode("utf-16le", errors="ignore")
            except Exception:
                text = raw.decode("utf-16", errors="ignore")
        else:
            text = data.decode("utf-8", errors="ignore")
        return text.strip()

    def _mt5_line_matches_indicator(self, line: str) -> bool:
        low = line.lower()
        for key in self._indicator_map.keys():
            if key and key in low:
                return True
        for name in self._channel_colors.keys():
            if name and name.lower() in low:
                return True
        return False


def main() -> None:
    app = QtWidgets.QApplication(sys.argv)
    app.setQuitOnLastWindowClosed(False)
    win = MainWindow()
    win.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
