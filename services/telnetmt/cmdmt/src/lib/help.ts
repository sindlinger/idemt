import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BLUE_BG = "\x1b[44m";
const WHITE = "\x1b[97m";
const RESET = "\x1b[0m";

// CMDMT_CMD_COLOR presets (use in env): gray90, gray80, gray70, gray60, gray50,
// gray40, gray30, gray20, gray10, white, black, yellow, cyan, green, magenta, red.
const COLOR_PRESETS: Record<string, string> = {
  gray90: "e5e5e5",
  gray80: "cccccc",
  gray70: "b3b3b3",
  gray60: "999999",
  gray50: "808080",
  gray40: "666666",
  gray30: "4d4d4d",
  gray20: "333333",
  gray10: "1a1a1a",
  white: "ffffff",
  black: "000000",
  yellow: "ffd54f",
  cyan: "4dd0e1",
  green: "81c784",
  magenta: "ce93d8",
  red: "ef9a9a"
};

function resolveCmdColor(): string {
  const env = process.env.CMDMT_CMD_COLOR?.trim();
  if (env) {
    const key = env.toLowerCase();
    const preset = COLOR_PRESETS[key] || COLOR_PRESETS[key.replace("grey", "gray")];
    if (preset) {
      const r = parseInt(preset.slice(0, 2), 16);
      const g = parseInt(preset.slice(2, 4), 16);
      const b = parseInt(preset.slice(4, 6), 16);
      return `\x1b[38;2;${r};${g};${b}m`;
    }
    // Accept "#RRGGBB" or "R,G,B"
    const hex = env.replace(/^#/, "");
    if (/^[0-9a-fA-F]{6}$/.test(hex)) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      return `\x1b[38;2;${r};${g};${b}m`;
    }
    const rgb = env.split(",").map((v) => Number(v.trim()));
    if (rgb.length === 3 && rgb.every((n) => Number.isFinite(n))) {
      const [r, g, b] = rgb.map((n) => Math.max(0, Math.min(255, Math.round(n))));
      return `\x1b[38;2;${r};${g};${b}m`;
    }
  }
  const colorterm = (process.env.COLORTERM || "").toLowerCase();
  if (colorterm.includes("truecolor") || colorterm.includes("24bit")) {
    // Darker gray for truecolor terminals
    return "\x1b[38;2;105;105;105m";
  }
  // Fallback: normal white (slightly dimmer than bright white on 16-color)
  return "\x1b[37m";
}

function resolveVersion(): string {
  const env = process.env.npm_package_version?.trim();
  if (env) return env;
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.resolve(here, "../../package.json");
    const raw = fs.readFileSync(pkgPath, "utf8");
    const pkg = JSON.parse(raw) as { version?: string };
    if (pkg.version) return String(pkg.version);
  } catch {
    // ignore
  }
  return "dev";
}

const CMD = resolveCmdColor();
const VERSION = resolveVersion();

export type HelpSection = { title: string; items: string[] };

const SECTIONS: HelpSection[] = [
  { title: "basic", items: ["ping", "debug", "compile", "use", "ctx", "help", "indicador", "install"] },
  { title: "chart", items: ["open", "close", "list", "closeall", "redraw", "detachall", "find"] },
  { title: "template", items: ["apply", "save", "saveea", "savechart"] },
  { title: "indicator", items: ["attach", "detach", "total", "name", "handle", "get", "release"] },
  { title: "expert", items: ["attach", "detach", "find", "run", "test"] },
  { title: "script", items: ["run"] },
  { title: "trade", items: ["buy", "sell", "list", "closeall"] },
  { title: "global", items: ["set", "get", "del", "delprefix", "list"] },
  { title: "input", items: ["list", "set"] },
  { title: "snapshot", items: ["save", "apply", "list"] },
  { title: "object", items: ["list", "delete", "delprefix", "move", "create"] },
  { title: "screen", items: ["shot", "sweep", "drop"] },
  { title: "other", items: ["cmd", "raw", "json", "quit"] }
];

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;

function visibleLen(s: string): number {
  return s.replace(ANSI_RE, "").length;
}

function pad(s: string, width: number): string {
  const len = visibleLen(s);
  if (len >= width) return s;
  return s + " ".repeat(width - len);
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function renderGroupBlock(
  group: HelpSection,
  nameWidth: number,
  subCols: number,
  subWidth: number,
  nameGap: number,
  subGap: number,
  colWidth: number
): string[] {
  const rows = chunk(group.items, subCols);
  const lines: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const name = i === 0 ? pad(group.title, nameWidth) : " ".repeat(nameWidth);
    let line = name + " ".repeat(nameGap);
    for (let c = 0; c < subCols; c++) {
      const raw = row[c] ?? "";
      const item = raw ? `${CMD}${raw}${WHITE}` : "";
      line += pad(item, subWidth);
      if (c < subCols - 1) line += " ".repeat(subGap);
    }
    lines.push(pad(line, colWidth));
  }
  return lines;
}

export function renderHelp(): string[] {
  const width = Math.max(process.stdout.columns ?? 120, 80);
  const divider = " │ ";
  const cols = 2;
  const colWidth = Math.floor((width - divider.length * (cols - 1)) / cols);
  const nameWidth = Math.max(...SECTIONS.map((s) => s.title.length));
  const subWidth = Math.max(...SECTIONS.flatMap((s) => s.items.map((i) => i.length)));
  const nameGap = 2;
  const subGap = 2;
  const available = colWidth - nameWidth - nameGap;
  const subCols = clamp(Math.floor((available + subGap) / (subWidth + subGap)), 1, 5);

  const mid = Math.ceil(SECTIONS.length / cols);
  const leftGroups = SECTIONS.slice(0, mid);
  const rightGroups = SECTIONS.slice(mid);

  const buildColumn = (groups: HelpSection[]): string[] => {
    const out: string[] = [];
    for (let i = 0; i < groups.length; i++) {
      out.push(
        ...renderGroupBlock(groups[i], nameWidth, subCols, subWidth, nameGap, subGap, colWidth)
      );
      if (i < groups.length - 1) out.push(" ".repeat(colWidth));
    }
    return out;
  };

  const leftLines = buildColumn(leftGroups);
  const rightLines = buildColumn(rightGroups);

  const maxLines = Math.max(leftLines.length, rightLines.length);
  const lines: string[] = [];
  const title = `cmdmt v${VERSION} - comandos principais (socket)`;
  lines.push(`${BLUE_BG}${WHITE}${pad(" " + title + " ", width)}${RESET}`);

  for (let i = 0; i < maxLines; i++) {
    const left = leftLines[i] ?? " ".repeat(colWidth);
    const right = rightLines[i] ?? " ".repeat(colWidth);
    const line = left + divider + right;
    lines.push(`${BLUE_BG}${WHITE}${pad(line, width)}${RESET}`);
  }
  lines.push(`${BLUE_BG}${" ".repeat(width)}${RESET}`);
  return lines;
}

type ExampleGroup = { title: string; lines: string[] };

const EXAMPLES: Record<string, ExampleGroup[]> = {
  ping: [{ title: "ping", lines: ["ping"] }],
  debug: [{ title: "debug", lines: ["debug hello world", "debug {\"msg\":\"ok\"}"] }],
  compile: [{ title: "compile", lines: ["compile", "compile C:\\\\caminho\\\\arquivo.mq5"] }],
  use: [{ title: "use", lines: ["use EURUSD M5", "use GBPUSD H1"] }],
  ctx: [{ title: "ctx", lines: ["ctx"] }],
  help: [{ title: "help", lines: ["help", "examples", "examples chart"] }],
  install: [
    {
      title: "install",
      lines: [
        "install C:\\\\Users\\\\...\\\\MetaQuotes\\\\Terminal\\\\<HASH>",
        "install C:\\\\...\\\\Terminal\\\\<HASH> --name-prefix TelnetMT_",
        "install C:\\\\...\\\\Terminal\\\\<HASH> --name TelnetMT",
        "install C:\\\\...\\\\Terminal\\\\<HASH> --web https://example.com --web http://localhost:9090",
        "install C:\\\\...\\\\Terminal\\\\<HASH> --no-allow-dll --no-allow-live --dry-run"
      ]
    }
  ],
  indicador: [
    {
      title: "indicador",
      lines: [
        "indicador ZigZag",
        "indicador M5 ZigZag sub=1 --params depth=12 deviation=5 backstep=3",
        "indicador M5 ZigZag --buffers 10 --log 50 --shot"
      ]
    }
  ],
  chart: [
    { title: "open", lines: ["chart open", "chart open EURUSD H1"] },
    { title: "close", lines: ["chart close", "chart close EURUSD H1"] },
    { title: "list", lines: ["chart list"] },
    { title: "closeall", lines: ["chart closeall"] },
    { title: "redraw", lines: ["chart redraw", "chart redraw EURUSD H1"] },
    { title: "detachall", lines: ["chart detachall", "chart detachall EURUSD H1"] },
    { title: "find", lines: ["chart find PRICE", "chart find EURUSD H1 PRICE"] }
  ],
  template: [
    { title: "apply", lines: ["template apply meu.tpl", "template apply EURUSD H1 meu.tpl"] },
    { title: "save", lines: ["template save snap.tpl", "template save EURUSD H1 snap.tpl"] },
    { title: "saveea", lines: ["template saveea MyEA out.tpl base.tpl lots=0.1"] },
    { title: "savechart", lines: ["template savechart 123456 snap.tpl"] }
  ],
  indicator: [
    {
      title: "attach",
      lines: [
        "indicator attach ZigZag sub=1 --params depth=12 deviation=5 backstep=3",
        "indicator attach EURUSD H1 ZigZag sub=1 --params depth=12 deviation=5 backstep=3",
        "indicator attach EURUSD H1 ZigZag --buffers 10 --log 50 --shot"
      ]
    },
    { title: "detach", lines: ["indicator detach ZigZag sub=1", "indicator detach EURUSD H1 ZigZag sub=1"] },
    { title: "total", lines: ["indicator total", "indicator total EURUSD H1"] },
    { title: "name", lines: ["indicator name 0", "indicator name EURUSD H1 0"] },
    { title: "handle", lines: ["indicator handle ZigZag sub=1", "indicator handle EURUSD H1 ZigZag sub=1"] },
    { title: "get", lines: ["indicator get ZigZag sub=1", "indicator get EURUSD H1 ZigZag sub=1"] },
    { title: "release", lines: ["indicator release 123456"] }
  ],
  expert: [
    {
      title: "attach",
      lines: [
        "expert attach MyEA base.tpl --params lots=0.1",
        "expert attach EURUSD H1 MyEA base.tpl --params lots=0.1",
        "expert attach EURUSD H1 MyEA --buffers 5 --log 50"
      ]
    },
    { title: "detach", lines: ["expert detach", "expert detach EURUSD H1"] },
    { title: "find", lines: ["expert find MyEA"] },
    { title: "run", lines: ["expert run MyEA --params lots=0.1", "expert run M5 MyEA base.tpl --params lots=0.1"] },
    { title: "test", lines: ["expert test MyEA --params lots=0.1", "expert test M5 MyEA --params lots=0.1"] }
  ],
  script: [{ title: "run", lines: ["script run MeuScript.tpl", "script run EURUSD H1 MeuScript.tpl"] }],
  trade: [
    { title: "buy", lines: ["trade buy 0.1", "trade buy EURUSD 0.1"] },
    { title: "sell", lines: ["trade sell 0.1", "trade sell EURUSD 0.1"] },
    { title: "list", lines: ["trade list"] },
    { title: "closeall", lines: ["trade closeall"] }
  ],
  global: [
    { title: "set", lines: ["global set key value"] },
    { title: "get", lines: ["global get key"] },
    { title: "del", lines: ["global del key"] },
    { title: "delprefix", lines: ["global delprefix pref_"] },
    { title: "list", lines: ["global list"] }
  ],
  input: [
    { title: "list", lines: ["input list"] },
    { title: "set", lines: ["input set name value"] }
  ],
  snapshot: [
    { title: "save", lines: ["snapshot save snap1"] },
    { title: "apply", lines: ["snapshot apply snap1"] },
    { title: "list", lines: ["snapshot list"] }
  ],
  object: [
    { title: "list", lines: ["object list"] },
    { title: "delete", lines: ["object delete OBJ_NAME"] },
    { title: "delprefix", lines: ["object delprefix OBJ_"] },
    { title: "move", lines: ["object move OBJ_NAME 100 200"] },
    { title: "create", lines: ["object create OBJ_NAME RECT 100 100 200 200"] }
  ],
  screen: [
    { title: "shot", lines: ["screen shot", "screen shot EURUSD H1"] },
    { title: "sweep", lines: ["screen sweep", "screen sweep 5"] },
    { title: "drop", lines: ["screen drop"] }
  ],
  cmd: [
    { title: "cmd", lines: ["cmd PING", "cmd ATTACH_IND_FULL EURUSD H1 ZigZag 1 depth=12"] }
  ],
  raw: [{ title: "raw", lines: ["raw PING|", "raw ATTACH_IND_FULL|EURUSD|H1|ZigZag|1|"] }],
  json: [{ title: "json", lines: ["json {\"type\":\"PING\"}", "json {\"type\":\"CMD\",\"params\":[\"PING\"]}"] }],
  quit: [{ title: "quit", lines: ["quit", "exit"] }]
};

function renderIndex(): string {
  const items = [
    "examples ping",
    "examples debug",
    "examples compile",
    "examples use",
    "examples ctx",
    "examples help",
    "examples indicador",
    "examples chart",
    "examples template",
    "examples indicator",
    "examples expert",
    "examples script",
    "examples trade",
    "examples global",
    "examples input",
    "examples snapshot",
    "examples object",
    "examples screen",
    "examples cmd",
    "examples raw",
    "examples json",
    "examples quit"
  ];
  return items.join("\n");
}

function formatGroups(groups: ExampleGroup[], only?: string): string {
  const lines: string[] = [];
  for (const group of groups) {
    if (only && group.title !== only) continue;
    lines.push(`${group.title}:`);
    for (const line of group.lines) lines.push(`  ${line}`);
    lines.push("");
  }
  if (!lines.length) return "";
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}

export function renderExamples(cmd?: string): string {
  const input = (cmd ?? "").trim();
  if (!input) return renderIndex();
  const lower = input.toLowerCase();
  const parts = lower.split(/\s+/).filter(Boolean);
  let command = parts[0] ?? "";
  let sub = parts.slice(1).join(" ");
  if (command.includes(":") && !sub) {
    const [c, s] = command.split(":", 2);
    command = c;
    sub = s ?? "";
  }
  const groups = EXAMPLES[command];
  if (!groups) return renderIndex();
  const output = formatGroups(groups, sub || undefined);
  return output || renderIndex();
}
