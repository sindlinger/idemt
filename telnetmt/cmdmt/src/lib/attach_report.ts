import fs from "node:fs";
import path from "node:path";
import type { RunnerConfig } from "./config.js";
import { isWindowsPath, toWslPath } from "./config.js";

export type AttachMeta = {
  report: boolean;
  buffers: number;
  logTail: number;
  shot: boolean;
  shotName?: string;
};

export const DEFAULT_ATTACH_META: AttachMeta = {
  report: true,
  buffers: 5,
  logTail: 30,
  shot: false
};

export type AttachReport = {
  kind: "indicator" | "expert";
  name: string;
  symbol: string;
  tf: string;
  sub?: number;
  time0?: string;
  timeN?: string;
  bars?: number;
  buffers?: Record<string, number[]>;
  logs?: { file: string; lines: string[]; mode?: "match" | "tail" } | null;
  screenshot?: string | null;
};

function readTextMaybeUtf16(p: string): string {
  const raw = fs.readFileSync(p);
  if (raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xfe) {
    return raw.slice(2).toString("utf16le");
  }
  return raw.toString("utf8");
}

function latestFile(dir: string): string | null {
  if (!fs.existsSync(dir)) return null;
  const items = fs
    .readdirSync(dir)
    .map((name) => ({ name, stat: fs.statSync(path.join(dir, name)) }))
    .filter((e) => e.stat.isFile())
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  return items.length ? path.join(dir, items[0].name) : null;
}

function tailMatchLines(file: string, needles: string[], maxLines: number): string[] {
  if (!file || !fs.existsSync(file)) return [];
  const text = readTextMaybeUtf16(file);
  const lines = text.split(/\r?\n/).filter(Boolean);
  const lowers = needles.map((n) => n.toLowerCase()).filter(Boolean);
  const hits = lines.filter((l) => {
    const low = l.toLowerCase();
    return lowers.some((n) => low.includes(n));
  });
  if (!hits.length) return [];
  return hits.slice(-maxLines);
}

function tailLines(file: string, maxLines: number): string[] {
  if (!file || !fs.existsSync(file)) return [];
  const text = readTextMaybeUtf16(file);
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  return lines.slice(-maxLines);
}

function parseKeyValueLines(resp: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = resp.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    if (line.startsWith("OK") || line.startsWith("ERR") || line.startsWith("ERROR")) continue;
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    out[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return out;
}

function parseBuffers(map: Record<string, string>): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const [k, v] of Object.entries(map)) {
    if (!k.startsWith("buf")) continue;
    if (v === "ERR") {
      out[k] = [];
      continue;
    }
    out[k] = v
      .split(",")
      .map((n) => n.trim())
      .filter(Boolean)
      .map((n) => Number(n));
  }
  return out;
}

function normalizeIndicatorName(name: string): string {
  let n = name.trim();
  if (n.toLowerCase().startsWith("wpath ")) n = n.slice(6);
  n = n.replace(/^"+|"+$/g, "");
  n = n.replace(/\//g, "\\");
  const base = path.win32.basename(n);
  let out = base || n;
  const low = out.toLowerCase();
  if (low.endsWith(".mq5") || low.endsWith(".ex5")) out = out.slice(0, -4);
  return out || name;
}

export async function buildAttachReport(opts: {
  kind: "indicator" | "expert";
  name: string;
  symbol: string;
  tf: string;
  sub?: number;
  meta: AttachMeta;
  runner: RunnerConfig;
  send: (action: { type: string; params: string[] }) => Promise<string>;
}): Promise<AttachReport> {
  const report: AttachReport = {
    kind: opts.kind,
    name: opts.name,
    symbol: opts.symbol,
    tf: opts.tf,
    sub: opts.sub
  };

  if (opts.kind === "indicator") {
    const indName = normalizeIndicatorName(opts.name);
    const resp = await opts.send({
      type: "IND_SNAPSHOT",
      params: [opts.symbol, opts.tf, String(opts.sub ?? 1), indName, String(opts.meta.buffers)]
    });
    const map = parseKeyValueLines(resp);
    if (map.time0) report.time0 = map.time0;
    if (map.timeN) report.timeN = map.timeN;
    if (map.bars) report.bars = Number(map.bars);
    report.buffers = parseBuffers(map);
  } else {
    const resp = await opts.send({
      type: "BAR_INFO",
      params: [opts.symbol, opts.tf, String(opts.meta.buffers)]
    });
    const map = parseKeyValueLines(resp);
    if (map.time0) report.time0 = map.time0;
    if (map.timeN) report.timeN = map.timeN;
    if (map.bars) report.bars = Number(map.bars);
  }

  const dataPath = opts.runner.dataPath ? (isWindowsPath(opts.runner.dataPath) ? toWslPath(opts.runner.dataPath) : opts.runner.dataPath) : "";
  if (dataPath) {
    const mqlLogsDir = path.join(dataPath, "MQL5", "Logs");
    const logFile = latestFile(mqlLogsDir);
    const baseName = path.win32.basename(opts.name);
    let lines = logFile ? tailMatchLines(logFile, [opts.name, baseName], opts.meta.logTail) : [];
    let mode: "match" | "tail" | undefined = lines.length ? "match" : undefined;
    if (logFile && lines.length === 0) {
      lines = tailLines(logFile, opts.meta.logTail);
      mode = "tail";
    }
    report.logs = logFile ? { file: logFile, lines, mode } : null;
  }

  if (opts.meta.shot) {
    const resp = await opts.send({
      type: "SCREENSHOT",
      params: [opts.symbol, opts.tf, opts.meta.shotName ?? ""]
    });
    const map = parseKeyValueLines(resp);
    report.screenshot = map.file || null;
  }

  return report;
}

export function formatAttachReport(report: AttachReport): string {
  const lines: string[] = [];
  lines.push(`attach: ${report.kind} ${report.name} (${report.symbol} ${report.tf})`);
  if (report.time0 || report.timeN) {
    const bars = report.bars !== undefined ? ` count=${report.bars}` : "";
    lines.push(`bars:${bars} time0=${report.time0 ?? "?"} timeN=${report.timeN ?? "?"}`);
  }
  if (report.buffers && Object.keys(report.buffers).length) {
    lines.push(`buffers:`);
    for (const [k, vals] of Object.entries(report.buffers)) {
      const short = vals.slice(0, 20).map((v) => Number.isFinite(v) ? v.toString() : "nan");
      lines.push(`  ${k}=${short.join(",")}`);
    }
  }
  if (report.logs) {
    const mode = report.logs.mode === "tail" ? " (tail)" : "";
    lines.push(`log${mode}: ${report.logs.file}`);
    if (report.logs.lines.length) {
      for (const ln of report.logs.lines) lines.push(`  ${ln}`);
    } else {
      lines.push(`  (sem linhas relevantes)`);
    }
  }
  if (report.screenshot) {
    lines.push(`screenshot: ${report.screenshot}`);
  }
  return lines.join("\n");
}
