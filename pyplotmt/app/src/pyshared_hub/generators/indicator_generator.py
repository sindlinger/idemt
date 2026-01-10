from __future__ import annotations

from pathlib import Path
import re


def _load_template(buffers: int, template_name: str | None = None) -> str:
    templates_dir = Path(__file__).resolve().parent.parent / "templates"
    if template_name == "fft_waveform":
        template_path = templates_dir / "PyPlotMT_WaveForm12_v1.mq5"
    elif template_name == "stft_dominant":
        template_path = templates_dir / "PyPlotMT_Bridge_v7.mq5"
    else:
        if buffers and buffers > 1:
            template_path = templates_dir / "PyPlotMT_WaveForm12_v1.mq5"
        else:
            template_path = templates_dir / "PyPlotMT_Bridge_v7.mq5"
    return template_path.read_text(encoding="utf-8", errors="ignore")


def _plot_type_const(plot_type: str) -> str:
    key = (plot_type or "").strip().lower()
    if key == "histogram":
        return "DRAW_HISTOGRAM"
    if key == "arrow":
        return "DRAW_ARROW"
    return "DRAW_LINE"


def _plot_color(idx: int) -> str:
    return "clrLime"


def _strip_plot_properties(lines: list[str]) -> list[str]:
    stripped = []
    for line in lines:
        if re.match(r"\s*#property\s+indicator_buffers\b", line):
            continue
        if re.match(r"\s*#property\s+indicator_plots\b", line):
            continue
        if re.match(r"\s*#property\s+indicator_type\d+\b", line):
            continue
        if re.match(r"\s*#property\s+indicator_color\d+\b", line):
            continue
        if re.match(r"\s*#property\s+indicator_label\d+\b", line):
            continue
        stripped.append(line)
    return stripped


def _insert_plot_properties(lines: list[str], buffers: int, name: str, plot_type: str | list[str]) -> list[str]:
    props = []
    props.append(f"#property indicator_buffers {buffers}")
    props.append(f"#property indicator_plots   {buffers}")
    for i in range(1, buffers + 1):
        label = f"{name}_{i}" if buffers > 1 else name
        if isinstance(plot_type, (list, tuple)) and len(plot_type) >= i:
            draw = _plot_type_const(str(plot_type[i - 1]))
        else:
            draw = _plot_type_const(str(plot_type))
        props.append(f"#property indicator_type{i}   {draw}")
        props.append(f"#property indicator_color{i}  {_plot_color(i)}")
        props.append(f"#property indicator_label{i}  \"{label}\"")

    out = []
    inserted = False
    for line in lines:
        out.append(line)
        if (not inserted) and re.match(r"\s*#property\s+indicator_separate_window\b", line):
            out.extend(props)
            inserted = True
    if not inserted:
        out = props + out
    return out


def _apply_dynamic_buffers(text: str, buffers: int, name: str, plot_type: str | list[str]) -> str:
    lines = text.splitlines()
    lines = _strip_plot_properties(lines)
    lines = _insert_plot_properties(lines, buffers, name, plot_type)
    text = "\n".join(lines)
    text = re.sub(r"#define\s+BUF_COUNT\s+\d+", f"#define BUF_COUNT {buffers}", text)
    return text


def indicator_template(opts: dict) -> str:
    channel = opts["channel"]
    name = opts["name"]
    buffers = int(opts.get("buffers", 1))
    plot_type = str(opts.get("plot_type", "Line"))
    template_key = None
    template = opts.get("template", "")
    if "FFT WaveForm" in template:
        template_key = "fft_waveform"
    elif "STFT Dominant" in template:
        template_key = "stft_dominant"
    text = _load_template(buffers, template_key)
    text = text.replace("PySharedBridgePlot_v6", "PyPlot-MT")
    text = text.replace("PySharedBridgePlot_v7", "PyPlot-MT")
    text = re.sub(r'input string Channel\s*=\s*".*?";', f'input string Channel  = "{channel}";', text)
    if buffers >= 1:
        text = _apply_dynamic_buffers(text, buffers, name, plot_type)
    if "IndicatorSetString" not in text:
        text = text.replace(
            "int OnInit()\n{",
            f'int OnInit()\n{{\n   IndicatorSetString(INDICATOR_SHORTNAME, "PyPlot-MT {name}");',
        )
    return text


def write_indicator_file(path: Path, opts: dict) -> None:
    template = indicator_template(opts)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(template, encoding="utf-8")
