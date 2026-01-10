from __future__ import annotations

from pathlib import Path
from typing import Optional

from PySide6 import QtWidgets

from config.defaults import default_indicator_dir, default_plugin_dir
from generators.indicator_generator import write_indicator_file
from generators.plugin_generator import write_plugin_file


class PluginWizard(QtWidgets.QDialog):
    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        self.setWindowTitle("New Plugin Wizard")

        self.name_edit = QtWidgets.QLineEdit("MyPlugin")
        self.channel_edit = QtWidgets.QLineEdit("MYPLUGIN")

        self.template_combo = QtWidgets.QComboBox()
        self.template_combo.addItems([
            "Custom (new file)",
            "FFT WaveForm v2 (12 cycles)",
            "STFT Dominant Wave (1 buffer)",
        ])

        self.buffers_spin = QtWidgets.QSpinBox()
        self.buffers_spin.setRange(1, 256)
        self.buffers_spin.setValue(1)

        self.plot_combo = QtWidgets.QComboBox()
        self.plot_combo.addItems(["Line", "Histogram", "Arrow"])
        self.plot_combo.setCurrentText("Line")
        self.plot_combo.setEnabled(True)

        self.plugin_dir = QtWidgets.QLineEdit(str(default_plugin_dir()))
        self.indicator_dir = QtWidgets.QLineEdit(str(default_indicator_dir()))

        self.create_plugin = QtWidgets.QCheckBox("Create plugin (.py)")
        self.create_plugin.setChecked(True)
        self.create_indicator = QtWidgets.QCheckBox("Create indicator (.mq5)")
        self.create_indicator.setChecked(True)

        plugin_browse = QtWidgets.QPushButton("Browse")
        indicator_browse = QtWidgets.QPushButton("Browse")
        plugin_browse.clicked.connect(lambda: self._browse_dir(self.plugin_dir))
        indicator_browse.clicked.connect(lambda: self._browse_dir(self.indicator_dir))

        form = QtWidgets.QFormLayout(self)
        form.addRow("Plugin name:", self.name_edit)
        form.addRow("Channel name:", self.channel_edit)
        form.addRow("Template:", self.template_combo)
        form.addRow("Buffers:", self.buffers_spin)
        form.addRow("Plot type:", self.plot_combo)

        plug_row = QtWidgets.QHBoxLayout()
        plug_row.addWidget(self.plugin_dir)
        plug_row.addWidget(plugin_browse)
        form.addRow("Plugins folder:", plug_row)

        ind_row = QtWidgets.QHBoxLayout()
        ind_row.addWidget(self.indicator_dir)
        ind_row.addWidget(indicator_browse)
        form.addRow("Indicators folder:", ind_row)

        form.addRow(self.create_plugin)
        form.addRow(self.create_indicator)

        btns = QtWidgets.QDialogButtonBox(QtWidgets.QDialogButtonBox.Ok | QtWidgets.QDialogButtonBox.Cancel)
        form.addRow(btns)
        btns.accepted.connect(self.accept)
        btns.rejected.connect(self.reject)

        self.template_combo.currentIndexChanged.connect(self._apply_template)
        self._apply_template()

    def _browse_dir(self, edit: QtWidgets.QLineEdit) -> None:
        folder = QtWidgets.QFileDialog.getExistingDirectory(self, "Select folder", edit.text())
        if folder:
            edit.setText(folder)

    def _apply_template(self) -> None:
        template = self.template_combo.currentText()
        if template == "FFT WaveForm v2 (12 cycles)":
            self.buffers_spin.setValue(12)
            self.buffers_spin.setEnabled(False)
            self.plot_combo.setCurrentText("Line")
            self.plot_combo.setEnabled(False)
            self.create_plugin.setChecked(False)
            self.create_plugin.setEnabled(False)
        elif template == "STFT Dominant Wave (1 buffer)":
            self.buffers_spin.setValue(1)
            self.buffers_spin.setEnabled(False)
            self.plot_combo.setCurrentText("Line")
            self.plot_combo.setEnabled(False)
            self.create_plugin.setChecked(False)
            self.create_plugin.setEnabled(False)
        else:
            self.buffers_spin.setEnabled(True)
            self.plot_combo.setEnabled(True)
            self.create_plugin.setEnabled(True)

    def result(self) -> Optional[dict]:
        if self.exec() != QtWidgets.QDialog.Accepted:
            return None
        name = self.name_edit.text().strip()
        channel = self.channel_edit.text().strip()
        if not name or not channel:
            return None
        template = self.template_combo.currentText()
        return {
            "name": name,
            "channel": channel,
            "buffers": int(self.buffers_spin.value()),
            "plot_type": self.plot_combo.currentText(),
            "template": template,
            "plugin_dir": Path(self.plugin_dir.text().strip()),
            "indicator_dir": Path(self.indicator_dir.text().strip()),
            "create_plugin": self.create_plugin.isChecked(),
            "create_indicator": self.create_indicator.isChecked(),
        }


def run_wizard(parent=None) -> Optional[dict]:
    wiz = PluginWizard(parent)
    res = wiz.result()
    if res is None:
        return None

    plugin_dir = res["plugin_dir"]
    indicator_dir = res["indicator_dir"]

    template = res.get("template", "Custom (new file)")

    plugin_path = plugin_dir / f"{res['name']}.py"
    if template == "FFT WaveForm v2 (12 cycles)":
        res["plugin_spec"] = "plugins.fft_waveform_v2"
        res["create_plugin"] = False
        res["params"] = {
            "fft_window": 4096,
            "min_period": 18,
            "max_period": 52,
            "trend_period": 1024,
            "bandwidth": 0.5,
            "window_type": 3,
            "sum_cycles": False,
            "sort_by_power": True,
            "max_cycles": 12,
        }
    elif template == "STFT Dominant Wave (1 buffer)":
        res["plugin_spec"] = "plugins.integrated_wave_v5_5"
        res["create_plugin"] = False
        res["params"] = {
            "backend": "cupy",
            "min_period_bars": 20.0,
            "max_period_bars": 240.0,
        }
    else:
        res["plugin_spec"] = str(plugin_path)
        res["params"] = {}

    indicator_path = indicator_dir / f"PyPlot-MT_{res['name']}.mq5"

    res["plugin_path"] = plugin_path
    res["indicator_path"] = indicator_path
    return res


def create_from_wizard(res: dict) -> None:
    if res.get("create_plugin"):
        write_plugin_file(Path(res["plugin_path"]), res["name"], res["channel"], res["buffers"])
    if res.get("create_indicator"):
        write_indicator_file(Path(res["indicator_path"]), res)
