#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { handleError } from "./lib/errors.js";
import { Ctx, splitArgs } from "./lib/args.js";
import { dispatch } from "./lib/dispatch.js";
import type { SendAction } from "./lib/dispatch.js";
import { sendLine, sendJson } from "./lib/transport.js";
import { runRepl } from "./repl.js";
import { renderBanner } from "./lib/banner.js";
import {
  requireRunner,
  requireTestRunner,
  requireTransport,
  requireTestTransport,
  resolveConfig,
  toWslPath,
  toWindowsPath,
  isWindowsPath,
  isWsl
} from "./lib/config.js";
import { runTester } from "./lib/tester.js";
import { createExpertTemplate } from "./lib/template.js";
import { buildAttachReport, formatAttachReport, DEFAULT_ATTACH_META, findLatestLogFile } from "./lib/attach_report.js";
import { runDoctor, runInstall } from "./lib/install.js";
import { resolveExpertFromRunner } from "./lib/expert_resolve.js";
import { ensureExpertInRunner } from "./lib/expert_sync.js";
import { performDataImport } from "./lib/data_import.js";
import { readTextWithEncoding, writeTextWithEncoding } from "./lib/textfile.js";
import { toSendKeysTokens } from "./lib/keys.js";

type AttachReport = Awaited<ReturnType<typeof buildAttachReport>>;

let TRACE = false;
function trace(msg: string): void {
  if (TRACE) process.stderr.write(`[trace] ${msg}\n`);
}

function currentCmdmtRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..");
}

function resolveRepoRoot(repoPath?: string): string | null {
  if (!repoPath) return null;
  let root = isWindowsPath(repoPath) ? toWslPath(repoPath) : repoPath;
  root = path.resolve(root);
  const nested = path.join(root, "services", "telnetmt", "cmdmt");
  if (fs.existsSync(path.join(nested, "package.json"))) return nested;
  if (fs.existsSync(path.join(root, "package.json"))) return root;
  return null;
}

function shouldBuild(repoRoot: string, distPath: string): boolean {
  if (!fs.existsSync(distPath)) return true;
  const distStat = fs.statSync(distPath);
  const srcRoot = path.join(repoRoot, "src");
  if (fs.existsSync(srcRoot)) {
    const stack: string[] = [srcRoot];
    while (stack.length) {
      const dir = stack.pop();
      if (!dir) continue;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
          continue;
        }
        if (!entry.isFile()) continue;
        if (!/\.(ts|tsx)$/.test(entry.name)) continue;
        if (fs.statSync(full).mtimeMs > distStat.mtimeMs) return true;
      }
    }
  }
  const pkg = path.join(repoRoot, "package.json");
  if (fs.existsSync(pkg) && fs.statSync(pkg).mtimeMs > distStat.mtimeMs) return true;
  const tsconfig = path.join(repoRoot, "tsconfig.json");
  if (fs.existsSync(tsconfig) && fs.statSync(tsconfig).mtimeMs > distStat.mtimeMs) return true;
  return false;
}

function maybeDelegateToRepo(repoRoot: string, autoBuild: boolean): boolean {
  const currentRoot = currentCmdmtRoot();
  if (path.resolve(repoRoot) === path.resolve(currentRoot)) return false;
  const distPath = path.join(repoRoot, "dist", "index.js");
  if (autoBuild && shouldBuild(repoRoot, distPath)) {
    const build = spawnSync("npm", ["run", "build"], { cwd: repoRoot, stdio: "inherit" });
    if (build.status !== 0) {
      process.exitCode = build.status ?? 1;
      return true;
    }
  }
  if (!fs.existsSync(distPath)) {
    process.stderr.write("WARN repoPath configurado mas dist/index.js nao encontrado; usando cmdmt atual.\n");
    return false;
  }
  const result = spawnSync(process.execPath, [distPath, ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env, CMDMT_DELEGATED: "1" }
  });
  process.exitCode = result.status ?? 1;
  return true;
}

function formatTraceResponse(resp: string): string {
  const trimmed = resp.replace(/\s+$/, "");
  const lines = trimmed.split(/\r?\n/);
  if (lines.length > 80) {
    return lines.slice(0, 80).join("\n") + `\n... (${lines.length} lines)`;
  }
  if (trimmed.length > 4000) {
    return trimmed.slice(0, 4000) + `\n... (${trimmed.length} chars)`;
  }
  return trimmed;
}

function isErrorResponse(resp: string): boolean {
  const up = resp.trim().toUpperCase();
  return up.startsWith("ERR") || up.includes(" ERR ") || up.includes("CODE=");
}

function extractDataLines(resp: string): string[] {
  const lines = resp.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  while (lines.length && lines[0].toUpperCase().startsWith("OK")) lines.shift();
  return lines;
}

function maybeExplainError(resp: string): void {
  const low = resp.toLowerCase();
  const has4802 = low.includes("code=4802") || low.includes(" 4802");
  const icustom = low.includes("icustom") || low.includes("indicator cannot be created");
  if (has4802 && icustom) {
    process.stderr.write(
      "AVISO: indicador nao pode ser criado (4802).\n" +
      "Verifique se o .ex5 existe em MQL5/Indicators (nao em MQL5/Files) e se o nome/caminho esta correto.\n" +
      "Use caminho relativo sem extensao, ex: Subpasta\\\\NomeIndicador\n"
    );
  }
}

function isBaseTplError(resp: string): boolean {
  const low = resp.toLowerCase();
  return low.includes("base_tpl") || low.includes("invalid file name");
}

type ChartInfo = { id: string; sym: string; tf: string };

function parseChartList(resp: string): ChartInfo[] {
  const out: ChartInfo[] = [];
  const lines = resp.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    if (!/^\d+\|/.test(line)) continue;
    const parts = line.split("|");
    if (parts.length < 3) continue;
    out.push({ id: parts[0], sym: parts[1], tf: parts[2] });
  }
  return out;
}

function normalizeTf(tf: string): string {
  const t = tf.toUpperCase();
  return t.startsWith("PERIOD_") ? t : `PERIOD_${t}`;
}

function buildPowerShellSendKeysScript(winPath: string, keys: string[], delayMs: number): string {
  const payload = JSON.stringify({ path: winPath, keys, delay: delayMs });
  return [
    `$payload = @'`,
    payload,
    `'@`,
    `$data = $payload | ConvertFrom-Json`,
    `$target = $data.path`,
    `$keys = $data.keys`,
    `$delay = [int]$data.delay`,
    `$proc = Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $target } | Select-Object -First 1`,
    `if (-not $proc) { Write-Error "process not found for $target"; exit 2 }`,
    `$p = Get-Process -Id $proc.ProcessId -ErrorAction Stop`,
    `$h = $p.MainWindowHandle`,
    `if ($h -eq 0) { Write-Error "window handle not found for $target"; exit 3 }`,
    `Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@`,
    `[Win32]::ShowWindow([IntPtr]$h, 5) | Out-Null`,
    `[Win32]::SetForegroundWindow([IntPtr]$h) | Out-Null`,
    `Add-Type -AssemblyName System.Windows.Forms`,
    `foreach ($k in $keys) {`,
    `  if ($null -ne $k -and $k -ne "") {`,
    `    [System.Windows.Forms.SendKeys]::SendWait($k)`,
    `    if ($delay -gt 0) { Start-Sleep -Milliseconds $delay }`,
    `  }`,
    `}`
  ].join("\n");
}

async function ensureChartOpen(sym: string, tf: string, transport: { hosts: string[]; port: number; timeoutMs: number }) {
  const listResp = await executeSend({ type: "LIST_CHARTS", params: [] }, transport);
  const charts = parseChartList(listResp);
  const targetTf = normalizeTf(tf);
  if (charts.some((c) => c.sym === sym && c.tf === targetTf)) return;
  await executeSend({ type: "OPEN_CHART", params: [sym, tf] }, transport);
}

function readTextMaybeUtf16(p: string): string {
  const raw = fs.readFileSync(p);
  if (raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xfe) {
    return raw.slice(2).toString("utf16le");
  }
  return raw.toString("utf8");
}

function normalizeExpertName(expert: string): string {
  let e = expert.replace(/\//g, "\\");
  const lower = e.toLowerCase();
  const marker = "\\mql5\\experts\\";
  const idx = lower.indexOf(marker);
  if (idx >= 0) e = e.slice(idx + marker.length);
  const low2 = e.toLowerCase();
  if (low2.startsWith("experts\\")) e = e.slice("Experts\\".length);
  if (e.toLowerCase().endsWith(".ex5") || e.toLowerCase().endsWith(".mq5")) {
    e = e.slice(0, -4);
  }
  return e;
}

function expertNameCandidates(expert: string): string[] {
  const norm = normalizeExpertName(expert);
  const base = path.win32.basename(norm);
  const out = new Set<string>();
  if (norm) out.add(norm);
  if (base) out.add(base);
  return Array.from(out);
}

async function verifyExpertAttached(
  sym: string,
  tf: string,
  expertName: string,
  transport: { hosts: string[]; port: number; timeoutMs: number },
  dataPath: string
): Promise<boolean> {
  const listResp = await executeSend({ type: "LIST_CHARTS", params: [] }, transport);
  const charts = parseChartList(listResp);
  const targetTf = normalizeTf(tf);
  const candidates = charts.filter((c) => c.sym === sym && c.tf === targetTf);
  trace(`verify_ea charts=${charts.length} match=${candidates.length} sym=${sym} tf=${targetTf}`);
  if (!candidates.length) return false;

  const templatesDir = path.join(toWslPath(dataPath), "MQL5", "Profiles", "Templates");
  const expCandidates = expertNameCandidates(expertName).map((v) => v.toLowerCase());
  trace(`verify_ea names=${expCandidates.join(",")}`);

  for (const chart of candidates) {
    const checkName = `__cmdmt_check_${Date.now()}_${chart.id}`;
    await executeSend({ type: "CHART_SAVE_TPL", params: [chart.id, checkName] }, transport);
    const tplPath = path.join(templatesDir, `${checkName}.tpl`);
    if (!fs.existsSync(tplPath)) {
      trace(`verify_ea tpl_missing=${tplPath}`);
      continue;
    }
    const txt = readTextMaybeUtf16(tplPath);
    try {
      fs.unlinkSync(tplPath);
    } catch {
      // ignore
    }
    const lower = txt.toLowerCase();
    const s = lower.indexOf("<expert>");
    if (s < 0) continue;
    const e = lower.indexOf("</expert>", s);
    if (e < 0) continue;
    const block = lower.slice(s, e);
    if (expCandidates.some((exp) => block.includes(`name=${exp}`))) {
      trace(`verify_ea ok chart=${chart.id}`);
      return true;
    }
  }
  return false;
}

function existsPath(p?: string): boolean {
  if (!p) return false;
  const local = isWindowsPath(p) ? toWslPath(p) : p;
  return fs.existsSync(local);
}

function detectMqlKind(filePath: string): "indicator" | "script" | "expert" | "unknown" {
  try {
    const local = isWindowsPath(filePath) ? toWslPath(filePath) : filePath;
    const text = fs.readFileSync(local, "utf8").toLowerCase();
    if (text.includes("#property indicator_") || text.includes("indicator_separate_window") || text.includes("indicator_chart_window"))
      return "indicator";
    if (text.includes("#property script")) return "script";
    if (text.includes("ontick") || text.includes("ontrade") || text.includes("ontradeevent")) return "expert";
    return "unknown";
  } catch {
    return "unknown";
  }
}

function resolveCompilePath(resolved: { compilePath?: string }): string | null {
  const env = process.env.CMDMT_COMPILE?.trim();
  const candidates = [
    resolved.compilePath,
    env,
    "/mnt/c/git/mt5ide/services/telnetmt/tools/mt5-compile.exe"
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    if (existsPath(c)) return c;
  }
  return null;
}

function deriveMt5Home(resolved: {
  runner?: { terminalPath?: string; metaeditorPath?: string };
}): string | null {
  const candidate =
    resolved.runner?.metaeditorPath ??
    resolved.runner?.terminalPath ??
    process.env.CMDMT_MT5_PATH;
  if (!candidate) return null;
  const winPath = isWindowsPath(candidate) ? candidate : isWsl() ? toWindowsPath(candidate) : candidate;
  if (isWindowsPath(winPath)) return path.win32.dirname(winPath);
  return path.dirname(winPath);
}

function deriveMt5HomeFromDataPath(dataPath?: string): string | null {
  if (!dataPath) return null;
  const dataWsl = isWindowsPath(dataPath) && isWsl() ? toWslPath(dataPath) : dataPath;
  const originPath = path.join(dataWsl, "origin.txt");
  if (!fs.existsSync(originPath)) return null;
  try {
    const originRaw = readTextWithEncoding(originPath).text.trim();
    if (!originRaw) return null;
    const winPath = isWindowsPath(originRaw) ? originRaw : isWsl() ? toWindowsPath(originRaw) : originRaw;
    if (!winPath) return null;
    if (/\.exe$/i.test(winPath)) return path.win32.dirname(winPath);
    return winPath;
  } catch {
    return null;
  }
}

function buildCompileEnv(
  resolved: { runner?: { terminalPath?: string; metaeditorPath?: string; dataPath?: string } },
  compilePath: string
): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (!env.MT5_HOME) {
    const home = deriveMt5Home(resolved) ?? deriveMt5HomeFromDataPath(resolved.runner?.dataPath);
    if (home) env.MT5_HOME = home;
  }
  return env;
}

function inferDataPathFromSource(src: string): string | null {
  if (!src) return null;
  const raw = isWindowsPath(src) ? src.replace(/\\/g, "/") : src;
  const lower = raw.toLowerCase();
  const idx = lower.lastIndexOf("/mql5/");
  if (idx === -1) return null;
  const base = raw.slice(0, idx);
  if (!base) return null;
  return isWindowsPath(src) ? base.replace(/\//g, "\\") : base;
}

function deriveMetaEditorFromEnv(): string | null {
  const mt5Path = process.env.CMDMT_MT5_PATH;
  if (!mt5Path) return null;
  const winPath = isWindowsPath(mt5Path) ? mt5Path : isWsl() ? toWindowsPath(mt5Path) : mt5Path;
  if (!winPath) return null;
  const meta = path.win32.join(path.win32.dirname(winPath), "MetaEditor64.exe");
  if (existsPath(meta)) return meta;
  return null;
}

function isPlainFileName(p?: string): boolean {
  if (!p) return false;
  if (p.includes("/") || p.includes("\\")) return false;
  return true;
}

function collapseWinPath(p: string): string {
  return p.replace(/[\\/]/g, "").toLowerCase();
}

function looksLikeCollapsedWinPath(p: string): boolean {
  if (!/^[A-Za-z]:/i.test(p)) return false;
  if (/[\\/]/.test(p)) return false;
  return /\.mq[45]$/i.test(p);
}

function findFileRecursive(root: string, fileName: string, maxDepth = 6): string | null {
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (queue.length) {
    const { dir, depth } = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      let isFile = entry.isFile();
      let isDir = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        try {
          const stat = fs.statSync(full);
          if (stat.isFile()) isFile = true;
          if (stat.isDirectory()) isDir = true;
        } catch {
          // ignore broken symlink
        }
      }
      if (isFile && entry.name.toLowerCase() === fileName.toLowerCase()) {
        return full;
      }
      if (isDir && depth < maxDepth) {
        queue.push({ dir: full, depth: depth + 1 });
      }
    }
  }
  return null;
}

function findFileByCollapsedPath(root: string, collapsedTarget: string, maxDepth = 10): string | null {
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (queue.length) {
    const { dir, depth } = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      let isFile = entry.isFile();
      let isDir = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        try {
          const stat = fs.statSync(full);
          if (stat.isFile()) isFile = true;
          if (stat.isDirectory()) isDir = true;
        } catch {
          // ignore broken symlink
        }
      }
      if (isFile) {
        const winFull = toWindowsPath(full);
        if (collapseWinPath(winFull) === collapsedTarget) return full;
      }
      if (isDir && depth < maxDepth) {
        queue.push({ dir: full, depth: depth + 1 });
      }
    }
  }
  return null;
}

function normalizeIndicatorRel(rel: string): string {
  let out = rel.replace(/\\/g, "/");
  out = out.replace(/\.(mq5|ex5)$/i, "");
  out = out.replace(/^[/\\]+/, "");
  return out.replace(/\//g, "\\");
}

function normalizeIndicatorKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/\.(mq5|ex5)$/i, "")
    .replace(/[^a-z0-9]+/g, "");
}

function buildIndicatorAcronym(name: string): string {
  const tokens = name
    .replace(/\.(mq5|ex5)$/i, "")
    .split(/[^a-z0-9]+/i)
    .filter(Boolean);
  if (!tokens.length) return "";
  return tokens.map((t) => t[0]!.toLowerCase()).join("");
}

type IndicatorFile = { full: string; rel: string; base: string; ext: string; depth: number };

function listIndicatorFiles(root: string, maxDepth = 6): IndicatorFile[] {
  const out: IndicatorFile[] = [];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (queue.length) {
    const { dir, depth } = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      let isFile = entry.isFile();
      let isDir = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        try {
          const stat = fs.statSync(full);
          if (stat.isFile()) isFile = true;
          if (stat.isDirectory()) isDir = true;
        } catch {
          // ignore broken symlink
        }
      }
      if (isFile && /\.(mq5|ex5)$/i.test(entry.name)) {
        const rel = path.relative(root, full);
        const ext = path.extname(entry.name).toLowerCase();
        const base = path.basename(entry.name, ext);
        out.push({ full, rel, base, ext, depth });
        continue;
      }
      if (isDir && depth < maxDepth) {
        queue.push({ dir: full, depth: depth + 1 });
      }
    }
  }
  return out;
}

function resolveIndicatorFromRunner(name: string, dataPath?: string): string | null {
  if (!dataPath) return null;
  if (!name) return null;
  const trimmed = name.trim().replace(/^"+|"+$/g, "");
  if (!trimmed) return null;

  const base = path.join(toWslPath(dataPath), "MQL5", "Indicators");
  const hasExt = /\.(mq5|ex5)$/i.test(trimmed);

  const tryResolveAbsolute = (absPath: string): string | null => {
    const normalized = absPath.replace(/\\/g, path.sep);
    if (!fs.existsSync(normalized)) return null;
    if (!normalized.startsWith(base)) return null;
    const rel = path.relative(base, normalized);
    return normalizeIndicatorRel(rel);
  };

  if (isWindowsPath(trimmed)) {
    const rel = tryResolveAbsolute(toWslPath(trimmed));
    if (rel) return rel;
  } else if (path.isAbsolute(trimmed)) {
    const rel = tryResolveAbsolute(trimmed);
    if (rel) return rel;
  }

  let relInput = trimmed.replace(/^[/\\]+/, "");
  relInput = relInput.replace(/^mql5[\\/]/i, "");
  relInput = relInput.replace(/^indicators[\\/]/i, "");
  const relFs = relInput.replace(/\\/g, path.sep);
  if (hasExt && fs.existsSync(path.join(base, relFs))) {
    return normalizeIndicatorRel(relInput);
  }
  if (!hasExt) {
    if (fs.existsSync(path.join(base, `${relFs}.ex5`))) {
      return normalizeIndicatorRel(`${relInput}.ex5`);
    }
    if (fs.existsSync(path.join(base, `${relFs}.mq5`))) {
      return normalizeIndicatorRel(`${relInput}.mq5`);
    }
  }

  if (!isPlainFileName(trimmed)) return null;
  const candidates = hasExt ? [trimmed] : [`${trimmed}.ex5`, `${trimmed}.mq5`];
  for (const candidate of candidates) {
    const found = findFileRecursive(base, candidate);
    if (found) {
      const rel = path.relative(base, found);
      return normalizeIndicatorRel(rel);
    }
  }

  const target = normalizeIndicatorKey(trimmed);
  if (!target) return null;
  const acronym = buildIndicatorAcronym(trimmed);
  const files = listIndicatorFiles(base);
  let best: { rel: string; score: number; extRank: number; depth: number } | null = null;
  for (const f of files) {
    const norm = normalizeIndicatorKey(f.base);
    if (!norm) continue;
    let score = 0;
    if (norm === target) {
      score = 10000 + norm.length;
    } else if (acronym && norm === acronym) {
      score = 9000 + norm.length;
    } else if (target.includes(norm) || norm.includes(target)) {
      score = 1000 + Math.min(norm.length, target.length);
    }
    if (score <= 0) continue;
    const extRank = f.ext === ".ex5" ? 2 : 1;
    const depth = f.depth;
    if (
      !best ||
      score > best.score ||
      (score === best.score && extRank > best.extRank) ||
      (score === best.score && extRank === best.extRank && depth < best.depth)
    ) {
      best = { rel: f.rel, score, extRank, depth };
    }
  }
  if (best) return normalizeIndicatorRel(best.rel);
  return null;
}


function resolveMqSourceFromRunner(input: string, dataPath?: string): string | null {
  if (!dataPath || !input) return null;
  const base = path.join(toWslPath(dataPath), "MQL5");
  const trimmed = input.trim().replace(/^"+|"+$/g, "");
  if (looksLikeCollapsedWinPath(trimmed)) {
    const collapsed = collapseWinPath(trimmed);
    const found = findFileByCollapsedPath(base, collapsed);
    if (found) return found;
  }
  const hasExt = /\.(mq4|mq5)$/i.test(input);
  const candidates = hasExt ? [input] : [`${input}.mq5`, `${input}.mq4`];
  const hasSeparators = input.includes("/") || input.includes("\\");
  for (const candidate of candidates) {
    if (hasSeparators) {
      const rel = candidate.replace(/^[/\\]+/, "");
      const full = path.join(base, rel);
      if (fs.existsSync(full)) return full;
      continue;
    }
    const found = findFileRecursive(base, candidate);
    if (found) return found;
  }
  return null;
}

function tailLines(text: string, count: number): string {
  const lines = text.split(/\r?\n/);
  if (count <= 0) return "";
  const start = Math.max(0, lines.length - count);
  return lines.slice(start).join("\n");
}

function resolveIndicatorFiles(name: string, dataPath?: string): { rel?: string; mq5?: string; ex5?: string } {
  if (!dataPath || !name) return {};
  const base = path.join(toWslPath(dataPath), "MQL5", "Indicators");
  const trimmed = name.trim().replace(/^"+|"+$/g, "");
  if (!trimmed) return {};
  const resolvedRel = resolveIndicatorFromRunner(trimmed, dataPath);
  if (resolvedRel) {
    const relFs = resolvedRel.replace(/\\/g, path.sep);
    return {
      rel: resolvedRel,
      mq5: path.join(base, `${relFs}.mq5`),
      ex5: path.join(base, `${relFs}.ex5`)
    };
  }
  const hasExt = /\.(mq5|ex5)$/i.test(trimmed);
  if (isWindowsPath(trimmed)) {
    const abs = toWslPath(trimmed);
    return hasExt
      ? { mq5: trimmed.toLowerCase().endsWith(".mq5") ? abs : undefined, ex5: trimmed.toLowerCase().endsWith(".ex5") ? abs : undefined }
      : { mq5: `${abs}.mq5`, ex5: `${abs}.ex5` };
  }
  if (path.isAbsolute(trimmed)) {
    return hasExt
      ? { mq5: trimmed.toLowerCase().endsWith(".mq5") ? trimmed : undefined, ex5: trimmed.toLowerCase().endsWith(".ex5") ? trimmed : undefined }
      : { mq5: `${trimmed}.mq5`, ex5: `${trimmed}.ex5` };
  }
  const relRaw = trimmed.replace(/^mql5[\\/]/i, "").replace(/^indicators[\\/]/i, "");
  const relFs = relRaw.replace(/\\/g, path.sep);
  return {
    rel: normalizeIndicatorRel(relRaw),
    mq5: path.join(base, `${relFs}.mq5`),
    ex5: path.join(base, `${relFs}.ex5`)
  };
}

function resolveExpertFiles(name: string, dataPath?: string): { rel?: string; mq5?: string; ex5?: string } {
  if (!dataPath || !name) return {};
  const resolved = resolveExpertFromRunner(name, dataPath);
  if (!resolved) return {};
  return {
    rel: resolved.name,
    mq5: resolved.mq5,
    ex5: resolved.ex5
  };
}

function updateHotkeyText(text: string, action: "set" | "del" | "clear", key?: string, value?: string): string {
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const sectionRe = /(^\[Hotkeys\][\s\S]*?)(?=^\[|\Z)/im;
  const match = text.match(sectionRe);
  const header = "[Hotkeys]";
  const safeKey = key?.trim() ?? "";
  if (!match) {
    if (action === "set" && safeKey && value) {
      return (text ? text + newline : "") + `${header}${newline}${safeKey}=${value}${newline}`;
    }
    if (action === "clear") return "";
    return text;
  }
  const block = match[1];
  const lines = block.split(/\r?\n/);
  const next: string[] = [lines[0] || header];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (safeKey && line.startsWith(`${safeKey}=`)) continue;
    next.push(line);
  }
  if (action === "set" && safeKey && value) {
    next.push(`${safeKey}=${value}`);
  }
  if (action === "clear") {
    return text.replace(block, `${header}${newline}`);
  }
  const updated = next.join(newline) + newline;
  return text.replace(block, updated);
}

function toWindowsArgsIfNeeded(args: string[], compilePath: string): string[] {
  if (!isWsl()) return args;
  const lower = compilePath.toLowerCase();
  const isWinTarget =
    isWindowsPath(compilePath) ||
    lower.endsWith(".cmd") ||
    lower.endsWith(".bat") ||
    (lower.endsWith(".exe") && isWsl());
  if (!isWinTarget) return args;
  return args.map((arg) => {
    if (!arg) return arg;
    const lowerArg = arg.toLowerCase();
    if (lowerArg.startsWith("/compile:") || lowerArg.startsWith("/log:")) return arg;
    if (arg.includes("/") || arg.includes("\\")) {
      return isWindowsPath(arg) ? arg : toWindowsPath(arg);
    }
    return arg;
  });
}

function isMetaEditorPath(p: string): boolean {
  const base = path.basename(p).toLowerCase();
  return base.includes("metaeditor") && base.endsWith(".exe");
}

function looksLikeMqSource(p: string): boolean {
  return /\.mq[45]$/i.test(p);
}

function buildMetaEditorArgs(src: string, args: string[]): string[] {
  const hasCompile = args.some((a) => a.toLowerCase().startsWith("/compile:"));
  if (hasCompile) return args;
  const srcWin = isWindowsPath(src) ? src : isWsl() ? toWindowsPath(src) : src;
  const logArg = args.find((a) => a.toLowerCase().startsWith("/log:"));
  const logPath = logArg
    ? logArg.slice(5)
    : path.win32.join(path.win32.dirname(srcWin), "mt5-compile.log");
  return [`/compile:${srcWin}`, `/log:${logPath}`];
}

async function compileMqSource(
  src: string,
  resolved: { compilePath?: string; runner?: { terminalPath?: string; metaeditorPath?: string } }
): Promise<void> {
  let compilePath = resolveCompilePath(resolved);
  if (!compilePath) {
    throw new Error(
      "compile nao configurado. Use --compile-path, CMDMT_COMPILE ou defaults.compilePath no config."
    );
  }
  const args = isMetaEditorPath(compilePath) ? buildMetaEditorArgs(src, []) : [src];
  const env = buildCompileEnv(resolved, compilePath);
  if (!env.MT5_HOME) {
    const dataPath = inferDataPathFromSource(src);
    const inferred = deriveMt5HomeFromDataPath(dataPath ?? undefined);
    if (inferred) env.MT5_HOME = inferred;
  }
  await runCompile(compilePath, toWindowsArgsIfNeeded(args, compilePath), env);
}

async function runCompile(pathOrCmd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const lower = pathOrCmd.toLowerCase();
    if (lower.endsWith(".cmd")) {
      reject(new Error("compile nao suporta .cmd. Use metaeditor.exe, mt5-compile.exe ou .bat."));
      return;
    }
    const envMerged: NodeJS.ProcessEnv = { ...process.env, ...(env ?? {}) };
    if (isWsl() && envMerged.MT5_HOME) {
      const wslEnv = envMerged.WSLENV ? envMerged.WSLENV.split(":").filter(Boolean) : [];
      const hasWin = isWindowsPath(envMerged.MT5_HOME);
      if (hasWin) {
        // Remove path-translation for MT5_HOME when already in Windows format.
        const filtered = wslEnv.filter((v) => v !== "MT5_HOME/p");
        if (!filtered.includes("MT5_HOME")) filtered.push("MT5_HOME");
        envMerged.WSLENV = filtered.join(":");
      } else {
        if (!wslEnv.includes("MT5_HOME/p")) wslEnv.push("MT5_HOME/p");
        envMerged.WSLENV = wslEnv.join(":");
      }
    }
    const quoteWin = (value: string): string => {
      if (!/[\\s"]/g.test(value)) return value;
      return `"${value.replace(/\"/g, '""')}"`;
    };
    const isBat = lower.endsWith(".bat");
    const winPath = isWindowsPath(pathOrCmd) ? pathOrCmd : isWsl() ? toWindowsPath(pathOrCmd) : pathOrCmd;
    const useCmd = isBat;
    const execPath = isWsl() && isWindowsPath(pathOrCmd) ? toWslPath(pathOrCmd) : pathOrCmd;
    const winArgs = toWindowsArgsIfNeeded(args, winPath);
    const cmdLine = [quoteWin(winPath), ...winArgs.map(quoteWin)].join(" ");
    const cmdArg = cmdLine.startsWith("\"") ? `"${cmdLine}"` : cmdLine;
    const child = useCmd
      ? spawn("cmd.exe", ["/c", cmdArg], {
          stdio: "inherit",
          env: envMerged
        })
      : spawn(execPath, args, { stdio: "inherit", env: envMerged });
    child.on("error", reject);
    child.on("exit", (code: number | null) => {
      let metaErrors: number | null = null;
      const isMeta = isMetaEditorPath(pathOrCmd);
      if (isMeta) {
        const logArg = args.find((a) => a.toLowerCase().startsWith("/log:"));
        if (logArg) {
          const logPath = logArg.slice(5);
          const local = isWindowsPath(logPath) ? toWslPath(logPath) : logPath;
          try {
            if (fs.existsSync(local)) {
              const raw = readTextWithEncoding(local).text;
              const text = raw.replace(/\0/g, "");
              const tail = tailLines(text, 80);
              if (tail.trim()) process.stdout.write(tail + "\n");
              const match = text.match(/result:\s*(\d+)\s+errors/i);
              if (match) metaErrors = Number(match[1]);
            }
          } catch {
            // ignore log read errors
          }
        }
      }

      if (!code || code === 0) {
        if (metaErrors !== null && metaErrors > 0) {
          reject(new Error(`compile retornou ${metaErrors} errors`));
          return;
        }
        resolve();
        return;
      }
      if (isMeta && metaErrors === 0) {
        resolve();
        return;
      }
      reject(new Error(`compile retornou ${code}`));
    });
  });
}

async function executeSend(action: SendAction, transport: { hosts: string[]; port: number; timeoutMs: number }): Promise<string> {
  if (action.type === "RAW") {
    const line = action.params[0] ?? "";
    trace(`send RAW ${line}`);
    const resp = await sendLine(line, transport);
    trace(`resp ${formatTraceResponse(resp)}`);
    return resp;
  }
  if (action.type === "JSON") {
    const raw = action.params[0] ?? "";
    let obj: unknown = raw;
    try {
      obj = JSON.parse(raw);
    } catch {
      // keep raw
    }
    trace(`send JSON ${typeof obj === "string" ? obj : JSON.stringify(obj)}`);
    const resp = await sendJson(obj, transport);
    trace(`resp ${formatTraceResponse(resp)}`);
    return resp;
  }

  const id = Date.now().toString();
  const line = [id, action.type, ...action.params].join("|");
  trace(`send ${line}`);
  const resp = await sendLine(line, transport);
  trace(`resp ${formatTraceResponse(resp)}`);
  return resp;
}

function extractErrorLines(resp: string): string {
  const lines = resp.split(/\r?\n/);
  const kept = lines.filter((l) => /^(ERR|ERROR)\b/.test(l.trim()));
  return kept.length ? kept.join("\n") + "\n" : "";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pingTransport(transport: { hosts: string[]; port: number; timeoutMs: number }): Promise<boolean> {
  try {
    const resp = await executeSend({ type: "PING", params: [] }, transport);
    return !isErrorResponse(resp);
  } catch {
    return false;
  }
}

function startTerminalMinimized(terminalPath: string) {
  const winPath = toWindowsPath(terminalPath);
  spawnSync("cmd.exe", ["/c", "start", "\"\"", "/min", winPath], { stdio: "ignore" });
}

function stopTerminalByPath(terminalPath: string) {
  const winPath = toWindowsPath(terminalPath);
  const script =
    "Get-Process terminal64 -ErrorAction SilentlyContinue | " +
    "Where-Object { $_.Path -eq '" +
    winPath.replace(/'/g, "''") +
    "' } | Stop-Process -Force";
  spawnSync("powershell.exe", ["-NoProfile", "-Command", script], { stdio: "ignore" });
}

function isTerminalRunning(terminalPath: string): boolean {
  const winPath = toWindowsPath(terminalPath);
  const script =
    "Get-Process terminal64 -ErrorAction SilentlyContinue | " +
    "Where-Object { $_.Path -eq '" +
    winPath.replace(/'/g, "''") +
    "' } | Select-Object -First 1 -ExpandProperty Id";
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", script], { encoding: "utf8" });
  const out = typeof result.stdout === "string" ? result.stdout.trim() : "";
  return out.length > 0;
}

async function ensureServiceAvailable(
  runner: { terminalPath?: string },
  transport: { hosts: string[]; port: number; timeoutMs: number },
  attempts = 15,
  waitMs = 800
): Promise<{ started: boolean }> {
  if (await pingTransport(transport)) return { started: false };
  if (!runner.terminalPath) return { started: false };
  startTerminalMinimized(runner.terminalPath);
  for (let i = 0; i < attempts; i++) {
    await sleep(waitMs);
    if (await pingTransport(transport)) return { started: true };
  }
  return { started: true };
}

function resolveBaseTplName(
  baseTpl: string,
  dataPath: string
): string {
  const dataPathWsl = toWslPath(dataPath);
  const templatesDir = path.join(dataPathWsl, "MQL5", "Profiles", "Templates");
  if (baseTpl) {
    if (existsPath(baseTpl)) return baseTpl;
    if (fs.existsSync(path.join(templatesDir, baseTpl))) return baseTpl;
  }
  const candidates = ["Moving Average.tpl", "Default.tpl", "default.tpl"];
  for (const name of candidates) {
    if (fs.existsSync(path.join(templatesDir, name))) return name;
  }
  return "";
}

async function main() {
  const program = new Command();

  program
    .name("cmdmt")
    .description("TelnetMT CLI (socket)")
    .version("0.1.12")
    .option("--config <path>", "caminho do config JSON")
    .option("--profile <name>", "perfil do config")
    .option("--runner <id>", "runner do config")
    .option("--test-runner <id>", "runner para expert run/test (sandbox)")
    .option("--test-host <host>", "host do sandbox (override)")
    .option("--test-hosts <hosts>", "hosts do sandbox (override)")
    .option("--test-port <port>", "porta do sandbox", (v) => parseInt(v, 10))
    .option("--test-timeout <ms>", "timeout do sandbox", (v) => parseInt(v, 10))
    .option("--symbol <symbol>", "symbol default")
    .option("--tf <tf>", "timeframe default")
    .option("--sub <n>", "subwindow/indice default", (v) => parseInt(v, 10))
    .option("--base-tpl <tpl>", "template base para expert run")
    .option("--mt5-path <path>", "override do terminalPath")
    .option("--mt5-data <path>", "override do dataPath")
    .option("--compile-path <path>", "script/exe de compile")
    .option("--host <host>", "host unico (ex: 127.0.0.1)")
    .option("--hosts <hosts>", "lista separada por virgula")
    .option("-p, --port <port>", "porta", (v) => parseInt(v, 10), 9090)
    .option("-t, --timeout <ms>", "timeout em ms", (v) => parseInt(v, 10), 3000)
    .option("--mirror-from <path>", "install: espelha MQL5 do data path fonte")
    .option("--mirror-dirs <a,b,c>", "install: dirs dentro de MQL5 a espelhar (csv)")
    .option("--sync-common", "install: escreve Login/Password/Server em common.ini")
    .option("--no-sync-common", "install: nao escreve Login/Password/Server em common.ini")
    .option("--visual", "tester visual (override)")
    .option("--no-visual", "tester sem visual (override)")
    .option("--win <WxH>", "tamanho da janela do terminal (ex: 1400x900)")
    .option("--pos <X,Y>", "posicao da janela do terminal (ex: 100,40)")
    .option("--fullscreen", "terminal fullscreen (override)")
    .option("--no-fullscreen", "terminal sem fullscreen (override)")
    .option("--keep-open", "nao fecha o terminal sandbox e nao encerra ao final do tester")
    .option("--json", "saida em JSON", false)
    .option("--quiet", "nao imprime banner no modo interativo", false)
    .option("--trace", "debug: loga comandos/respostas e verificacoes", false)
    .argument("[cmd...]", "comando e parametros")
    .option("--repo <path>", "override do caminho do repo TelnetMT")
    .option("--no-allow-dll", "desabilitar AllowDllImport (padrao: habilitado)")
    .option("--no-allow-live", "desabilitar AllowLiveTrading (padrao: habilitado)")
    .option("--web <url>", "adicionar url em WebRequest (repeatable)", (val, acc: string[]) => {
      acc.push(val);
      return acc;
    }, [] as string[])
    .option("--dry-run", "nao altera arquivos (apenas mostra plano)", false)
    .option("--apply", "aplica mudancas (doctor)", false)
    .allowUnknownOption(true)
    .configureOutput({
      writeErr: (str) => process.stderr.write(str),
      writeOut: (str) => process.stdout.write(str)
    })
    .exitOverride();

  await program.parseAsync(process.argv);
  const opts = program.opts();
  TRACE = Boolean(opts.trace || process.env.CMDMT_TRACE);

  const resolved = resolveConfig({
    configPath: opts.config,
    profile: opts.profile,
    runner: opts.runner,
    testRunner: opts.testRunner,
    symbol: opts.symbol,
    tf: opts.tf,
    sub: opts.sub,
    baseTpl: opts.baseTpl,
    compilePath: opts.compilePath,
    repoPath: opts.repo,
    host: opts.host,
    hosts: opts.hosts,
    port: opts.port,
    timeoutMs: opts.timeout,
    testHost: opts.testHost,
    testHosts: opts.testHosts,
    testPort: opts.testPort,
    testTimeoutMs: opts.testTimeout,
    mt5Path: opts.mt5Path,
    mt5Data: opts.mt5Data
  });

  if (!process.env.CMDMT_DELEGATED) {
    const repoRoot = resolveRepoRoot(resolved.repoPath ?? opts.repo);
    if (repoRoot) {
      const autoBuild = resolved.repoAutoBuild !== false;
      if (maybeDelegateToRepo(repoRoot, autoBuild)) return;
    }
  }

  const visualOverrideProvided = typeof opts.visual === "boolean";
  const testerOverride: Record<string, number> = {};
  if (typeof opts.visual === "boolean") testerOverride.visual = opts.visual ? 1 : 0;
  if (typeof opts.fullscreen === "boolean") testerOverride.windowFullscreen = opts.fullscreen ? 1 : 0;
  if (opts.win) {
    const m = String(opts.win).match(/^(\d+)\s*[x,]\s*(\d+)$/i);
    if (m) {
      testerOverride.windowWidth = parseInt(m[1], 10);
      testerOverride.windowHeight = parseInt(m[2], 10);
    } else {
      process.stderr.write("WARN --win esperado no formato WxH (ex: 1400x900)\n");
    }
  }
  if (opts.pos) {
    const m = String(opts.pos).match(/^(-?\d+)\s*[,x]\s*(-?\d+)$/i);
    if (m) {
      testerOverride.windowLeft = parseInt(m[1], 10);
      testerOverride.windowTop = parseInt(m[2], 10);
    } else {
      process.stderr.write("WARN --pos esperado no formato X,Y (ex: 100,40)\n");
    }
  }
  if (Object.keys(testerOverride).length) {
    resolved.tester = { ...resolved.tester, ...testerOverride };
  }
  if (opts.keepOpen) {
    resolved.tester = { ...resolved.tester, allowOpen: true, shutdownTerminal: 0 };
  }

  const ctx: Ctx = {
    symbol: resolved.context.symbol,
    tf: resolved.context.tf,
    sub: resolved.context.sub,
    baseTpl: resolved.baseTpl,
    profile: resolved.profile
  };

  const args = program.args as string[];
  const invokeAs = process.env.CMDMT_INVOKE_AS?.trim();

  if (!args || args.length === 0) {
    if (invokeAs) {
      const res = dispatch([invokeAs], ctx);
      if (res.kind === "error") {
        process.stderr.write(res.message + "\n");
        process.exitCode = 1;
        return;
      }
    }
    const transport = requireTransport(resolved);
    await runRepl({ ...transport, json: opts.json, quiet: opts.quiet }, ctx, resolved);
    return;
  }

  const tokensRaw = args.length === 1 ? splitArgs(args[0]) : args;
  const tokens = invokeAs ? [invokeAs, ...tokensRaw] : tokensRaw;

  if (!opts.quiet) {
    const socketLabel = resolveConfig({ configPath: opts.config }).transport.hosts.join(",");
    process.stdout.write(
      renderBanner({
        label: invokeAs || "cmdmt",
        owner: "Eduardo Candeiro Gonçalves",
        socket: `${socketLabel}:${resolved.transport.port}`
      })
    );
  }

  if (tokens[0]?.toLowerCase() === "compile") {
    let compileArgs = tokens.slice(1);
    if (!compileArgs.length && ctx.watchName) {
      compileArgs = [ctx.watchName];
    }
    if (!compileArgs.length) {
      process.stderr.write("uso: compile <arquivo.mq5|diretorio> (ou defina watch)\n");
      process.exitCode = 1;
      return;
    }
    const envCompile = process.env.CMDMT_COMPILE?.trim();
    const userSpecified = Boolean(resolved.compilePath || envCompile);
    let compilePath = resolveCompilePath(resolved);
    if (!compilePath) {
      throw new Error(
        "compile nao configurado. Use --compile-path, CMDMT_COMPILE ou defaults.compilePath no config."
      );
    }
    if (compileArgs.length) {
      const resolvedSrc = resolveMqSourceFromRunner(compileArgs[0], resolved.runner?.dataPath);
      if (resolvedSrc) {
        compileArgs[0] = resolvedSrc;
      }
    }
    // Mantem o compilador configurado (mt5-compile.exe por padrao).
    // MetaEditor so e usado se for explicitamente configurado como compilePath.
    const finalArgs = isMetaEditorPath(compilePath) && compileArgs.length
      ? buildMetaEditorArgs(compileArgs[0], compileArgs)
      : compileArgs;
    const env = buildCompileEnv(resolved, compilePath);
    if (!env.MT5_HOME && compileArgs.length) {
      const dataPath = inferDataPathFromSource(compileArgs[0]);
      const inferred = deriveMt5HomeFromDataPath(dataPath ?? undefined);
      if (inferred) env.MT5_HOME = inferred;
    }
    await runCompile(compilePath, toWindowsArgsIfNeeded(finalArgs, compilePath), env);
    return;
  }
  const res = dispatch(tokens, ctx);

  if (res.kind === "local") {
    if (opts.json) {
      process.stdout.write(JSON.stringify({ kind: "local", output: res.output }) + "\n");
    } else {
      process.stdout.write(res.output + "\n");
    }
    return;
  }
  if (res.kind === "error") {
    if (opts.json) {
      process.stdout.write(JSON.stringify({ kind: "error", message: res.message }) + "\n");
    } else {
      process.stderr.write(res.message + "\n");
    }
    process.exitCode = 1;
    return;
  }
  if (res.kind === "exit") {
    return;
  }
  if (res.kind === "install") {
    const dataPath = res.dataPath;
    const allowDll = res.allowDll ?? opts.allowDll;
    const allowLive = res.allowLive ?? opts.allowLive;
    const login = resolved.tester.login;
    const password = resolved.tester.password;
    const server = resolved.tester.server;
    const syncCommon =
      res.syncCommon ?? opts.syncCommon ?? (resolved.tester.syncCommon ?? (login || password || server ? true : undefined));
    const web = res.web ?? (Array.isArray(opts.web) ? opts.web : []);
    const dryRun = res.dryRun ?? Boolean(opts.dryRun);
    const repoPath = res.repoPath ?? opts.repo;
    const name = res.name;
    const namePrefix = res.namePrefix;
    const mirrorFrom = res.mirrorFrom ?? opts.mirrorFrom;
    const mirrorDirs =
      res.mirrorDirs ??
      (typeof opts.mirrorDirs === "string" ? opts.mirrorDirs.split(",").map((v: string) => v.trim()).filter(Boolean) : undefined);
    const output = runInstall(
      {
        dataPath,
        allowDll,
        allowLive,
        syncCommon,
        login,
        password,
        server,
        web,
        dryRun,
        repoPath,
        name,
        namePrefix,
        mirrorFrom,
        mirrorDirs
      },
      process.cwd()
    );
    if (opts.json) {
      process.stdout.write(JSON.stringify({ kind: "install", output }) + "\n");
    } else {
      process.stdout.write(output + "\n");
    }
    return;
  }
  if (res.kind === "doctor") {
    const dataPath = res.dataPath ?? resolved.runner?.dataPath;
    if (!dataPath) {
      process.stderr.write("doctor precisa de MT5_DATA ou runner.dataPath configurado.\n");
      process.exitCode = 1;
      return;
    }
    const allowDll = res.allowDll ?? opts.allowDll;
    const allowLive = res.allowLive ?? opts.allowLive;
    const login = resolved.tester.login;
    const password = resolved.tester.password;
    const server = resolved.tester.server;
    const syncCommon =
      res.syncCommon ?? opts.syncCommon ?? (resolved.tester.syncCommon ?? (login || password || server ? true : undefined));
    const web = res.web ?? (Array.isArray(opts.web) ? opts.web : []);
    const dryRun = res.apply ? false : true;
    const repoPath = res.repoPath ?? opts.repo;
    const name = res.name;
    const namePrefix = res.namePrefix;
    const mirrorFrom = res.mirrorFrom ?? opts.mirrorFrom;
    const mirrorDirs =
      res.mirrorDirs ??
      (typeof opts.mirrorDirs === "string" ? opts.mirrorDirs.split(",").map((v: string) => v.trim()).filter(Boolean) : undefined);
    const output = res.apply
      ? runInstall(
          {
            dataPath,
            allowDll,
            allowLive,
            syncCommon,
            login,
            password,
            server,
            web,
            dryRun: false,
            repoPath,
            name,
            namePrefix,
            mirrorFrom,
            mirrorDirs
          },
          process.cwd()
        )
      : runDoctor(
        {
          dataPath,
          allowDll,
          allowLive,
          syncCommon,
          login,
          password,
          server,
          web,
          dryRun: true,
          repoPath,
          name,
          namePrefix,
          mirrorFrom,
          mirrorDirs
        },
        process.cwd()
      );
    if (opts.json) {
      process.stdout.write(JSON.stringify({ kind: "doctor", output, dryRun }) + "\n");
    } else {
      process.stdout.write(output + "\n");
      if (dryRun) process.stdout.write("doctor: dry-run (use --apply para consertar)\n");
    }
    return;
  }
  if (res.kind === "test") {
    const runner = requireTestRunner(resolved);
    if (res.spec.csv) {
      const transport = requireTestTransport(resolved);
      let started = false;
      try {
        const svc = await ensureServiceAvailable(runner, transport);
        started = svc.started;
        await performDataImport(res.spec.csv, runner, transport);
      } catch (err) {
        process.stderr.write(String(err) + "\n");
        process.exitCode = 1;
        return;
      } finally {
        if (started) stopTerminalByPath(runner.terminalPath ?? "");
      }
    }
    if (resolved.testerRunner && resolved.runner && resolved.testerRunner.dataPath !== resolved.runner.dataPath) {
      const sync = ensureExpertInRunner(res.spec.expert, resolved.runner, runner);
      if (TRACE && sync.copied) {
        process.stderr.write(`[trace] synced expert to sandbox: ${sync.details.join(", ")}\n`);
      }
    }
    const testerConfig = { ...resolved.tester };
    const shouldRestartSandbox =
      Boolean(resolved.testerRunnerId) && Boolean(runner.terminalPath) && !testerConfig.allowOpen;
    if (shouldRestartSandbox && runner.terminalPath && isTerminalRunning(runner.terminalPath)) {
      if (TRACE) {
        process.stderr.write(`[trace] sandbox aberto; encerrando antes do run\n`);
      }
      stopTerminalByPath(runner.terminalPath);
      await sleep(1200);
    }
    if (res.spec.oneShot && !visualOverrideProvided) {
      testerConfig.visual = 1;
    }
    const visualMode = Number(testerConfig.visual) === 1 ? "visual" : "headless";
    if (TRACE) {
      process.stderr.write(
        `[trace] tester mode=${visualMode} symbol=${res.spec.symbol} tf=${res.spec.tf} expert=${res.spec.expert}\n`
      );
      process.stderr.write(
        `[trace] runner terminalPath=${runner.terminalPath ?? ""} dataPath=${runner.dataPath ?? ""}\n`
      );
    }
    const result = await runTester(res.spec, runner, testerConfig);
    if (opts.json) {
      process.stdout.write(JSON.stringify({ kind: "test", result }) + "\n");
    } else {
      process.stdout.write(`mode: ${visualMode}\n`);
      process.stdout.write(`tester: ${result.runDir}\n`);
      if (result.terminalLogPath) process.stdout.write(`terminal-log: ${result.terminalLogPath}\n`);
      if (result.copiedReport) process.stdout.write(`report: ${result.copiedReport}\n`);
      if (result.copiedLogs.length) process.stdout.write(`logs: ${result.copiedLogs.join(", ")}\n`);
    }
    return;
  }
  if (res.kind === "data_import") {
    const runner = requireRunner(resolved);
    const transport = requireTransport(resolved);
    try {
      await performDataImport(res, runner, transport);
    } catch (err) {
      process.stderr.write(String(err) + "\n");
      process.exitCode = 1;
      return;
    }
    return;
  }
  if (res.kind === "diag") {
    const runner = requireRunner(resolved);
    const dataPath = runner.dataPath ?? "";
    const base = path.join(toWslPath(dataPath), "MQL5");
    let lines: string[] = [];
    if (res.target === "indicator") {
      const info = resolveIndicatorFiles(res.name, dataPath);
      lines.push(`indicator: ${res.name}`);
      if (info.rel) lines.push(`resolved: ${info.rel}`);
      if (info.mq5) lines.push(`mq5: ${info.mq5} ${fs.existsSync(info.mq5) ? "(ok)" : "(missing)"}`);
      if (info.ex5) lines.push(`ex5: ${info.ex5} ${fs.existsSync(info.ex5) ? "(ok)" : "(missing)"}`);
      if (!info.rel && !info.mq5 && !info.ex5) lines.push(`not found under ${path.join(base, "Indicators")}`);
      lines.push("note: iCustom usa caminho relativo em MQL5/Indicators (sem extensao).");
    } else {
      const info = resolveExpertFiles(res.name, dataPath);
      lines.push(`expert: ${res.name}`);
      if (info.rel) lines.push(`resolved: ${info.rel}`);
      if (info.mq5) lines.push(`mq5: ${info.mq5} ${fs.existsSync(info.mq5) ? "(ok)" : "(missing)"}`);
      if (info.ex5) lines.push(`ex5: ${info.ex5} ${fs.existsSync(info.ex5) ? "(ok)" : "(missing)"}`);
      if (!info.rel && !info.mq5 && !info.ex5) lines.push(`not found under ${path.join(base, "Experts")}`);
    }
    const output = lines.join("\n");
    if (opts.json) {
      process.stdout.write(JSON.stringify({ kind: "diag", output }) + "\n");
    } else {
      process.stdout.write(output + "\n");
    }
    if (lines.some((l) => l.includes("(missing)") || l.includes("not found"))) {
      process.exitCode = 1;
    }
    return;
  }
  if (res.kind === "log") {
    const runner = requireRunner(resolved);
    const logFile = findLatestLogFile(runner.dataPath);
    if (!logFile || !fs.existsSync(logFile)) {
      process.stderr.write("log nao encontrado\n");
      process.exitCode = 1;
      return;
    }
    const text = fs.readFileSync(logFile, "utf8");
    const output = tailLines(text, res.tail || 200);
    if (opts.json) {
      process.stdout.write(JSON.stringify({ kind: "log", file: logFile, output }) + "\n");
    } else {
      process.stdout.write(output + "\n");
    }
    return;
  }
  if (res.kind === "auto_run") {
    const runner = res.target === "test" ? requireTestRunner(resolved) : requireRunner(resolved);
    const termPath = runner.terminalPath;
    if (!termPath) {
      process.stderr.write("auto: runner sem terminalPath configurado\n");
      process.exitCode = 1;
      return;
    }
    if (res.unknown?.length) {
      process.stderr.write(`auto: ignorando codigos desconhecidos: ${res.unknown.join(", ")}\n`);
    }
    const winPath = isWindowsPath(termPath) ? termPath : toWindowsPath(termPath);
    const tokens = toSendKeysTokens(res.keys);
    if (!tokens.length) {
      process.stderr.write("auto: nenhuma tecla valida para enviar\n");
      process.exitCode = 1;
      return;
    }
    const script = buildPowerShellSendKeysScript(winPath, tokens, 80);
    const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
      encoding: "utf8"
    });
    const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
    if (stderr) process.stderr.write(stderr + "\n");
    if (result.status !== 0) {
      process.exitCode = result.status ?? 1;
      return;
    }
    process.stdout.write("ok\n");
    return;
  }
  if (res.kind === "hotkey") {
    const runner = requireRunner(resolved);
    const filePath = path.join(toWslPath(runner.dataPath ?? ""), "config", "hotkeys.ini");
    const exists = fs.existsSync(filePath);
    const action = res.action;
    if (!exists && action === "list") {
      process.stdout.write("(empty)\n");
      return;
    }
    if (!exists && action !== "set") {
      process.stderr.write("hotkeys.ini nao encontrado\n");
      process.exitCode = 1;
      return;
    }
    let current = exists ? readTextWithEncoding(filePath) : { text: "", encoding: "utf16le" as const, bom: true };
    if (action === "list") {
      const text = current.text.trim();
      process.stdout.write(text ? text + "\n" : "(empty)\n");
      return;
    }
    const updated = updateHotkeyText(current.text, action === "del" ? "del" : action, res.key, res.value);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    writeTextWithEncoding(filePath, updated, current.encoding, current.bom);
    process.stdout.write("ok\n");
    return;
  }

  if (res.kind === "ind_detach_index") {
    const transport = requireTransport(resolved);
    const detachResp = await executeSend(
      { type: "DETACH_IND_INDEX", params: [res.sym, res.tf, res.sub, String(res.index)] },
      transport
    );
    const lower = detachResp.toLowerCase();
    const unsupported = lower.includes("unknown") || lower.includes("code=4113");
    if (unsupported) {
      const nameResp = await executeSend(
        { type: "IND_NAME", params: [res.sym, res.tf, res.sub, String(res.index)] },
        transport
      );
      if (isErrorResponse(nameResp)) {
        if (opts.json) {
          process.stdout.write(JSON.stringify({ kind: "send", type: "IND_NAME", params: [res.sym, res.tf, res.sub, String(res.index)], response: nameResp }) + "\n");
        } else {
          process.stdout.write(nameResp);
          maybeExplainError(nameResp);
        }
        process.exitCode = 1;
        return;
      }
      const lines = extractDataLines(nameResp);
      const name = lines[0] ?? "";
      if (!name) {
        process.stderr.write("ERR indicador nao encontrado nesse indice\n");
        process.exitCode = 1;
        return;
      }
      const fallbackResp = await executeSend(
        { type: "DETACH_IND_FULL", params: [res.sym, res.tf, name, res.sub] },
        transport
      );
      if (opts.json) {
        process.stdout.write(JSON.stringify({ kind: "send", type: "DETACH_IND_FULL", params: [res.sym, res.tf, name, res.sub], response: fallbackResp }) + "\n");
      } else {
        process.stdout.write(fallbackResp);
        if (isErrorResponse(fallbackResp)) maybeExplainError(fallbackResp);
      }
      if (isErrorResponse(fallbackResp)) process.exitCode = 1;
      return;
    }
    if (opts.json) {
      process.stdout.write(JSON.stringify({ kind: "send", type: "DETACH_IND_INDEX", params: [res.sym, res.tf, res.sub, String(res.index)], response: detachResp }) + "\n");
    } else {
      process.stdout.write(detachResp);
      if (isErrorResponse(detachResp)) maybeExplainError(detachResp);
    }
    if (isErrorResponse(detachResp)) process.exitCode = 1;
    return;
  }

  const transport = requireTransport(resolved);

  if (res.kind === "send") {
    let logStart = null as null | { file: string; offset: number };
    if (res.type === "DETACH_IND_FULL") {
      try {
        const runner = requireRunner(resolved);
        const p = res.params[2] ?? "";
        const resolvedPath = resolveIndicatorFromRunner(p, runner.dataPath);
        if (resolvedPath) {
          res.params[2] = path.win32.basename(resolvedPath);
        }
      } catch {
        // ignore resolve failure
      }
    }
    if (res.attach) {
      try {
        const runner = requireRunner(resolved);
        if (res.type === "ATTACH_IND_FULL") {
          const p = res.params[2] ?? "";
          const resolvedPath = resolveIndicatorFromRunner(p, runner.dataPath);
          if (resolvedPath) {
            res.params[2] = resolvedPath;
          }
        }
        const logFile = findLatestLogFile(runner.dataPath);
        if (logFile && fs.existsSync(logFile)) {
          const stat = fs.statSync(logFile);
          logStart = { file: logFile, offset: stat.size };
          trace(`logStart ${logFile} offset=${stat.size}`);
        }
      } catch {
        // ignore logStart
      }
    }
    const response = await executeSend({ type: res.type, params: res.params }, transport);
    let report: AttachReport | null = null;
    const attachMeta = res.meta ?? DEFAULT_ATTACH_META;
    if (!isErrorResponse(response) && res.attach && attachMeta.report) {
      try {
        const runner = requireRunner(resolved);
        report = await buildAttachReport({
          kind: res.attach.kind,
          name: res.attach.name,
          symbol: res.attach.symbol,
          tf: res.attach.tf,
          sub: res.attach.sub,
          meta: attachMeta,
          runner,
          send: (action) => executeSend(action, transport),
          logStart: logStart ?? undefined
        });
      } catch (err) {
        process.stderr.write(`WARN attach_report: ${String(err)}\n`);
      }
    }
    if (opts.json) {
      process.stdout.write(JSON.stringify({ kind: "send", type: res.type, params: res.params, response, report }) + "\n");
    } else {
      process.stdout.write(response);
      if (report) process.stdout.write(formatAttachReport(report) + "\n");
    }
    if (isErrorResponse(response)) {
      maybeExplainError(response);
      process.exitCode = 1;
    }
    return;
  }

  if (res.kind === "multi") {
    let logStart = null as null | { file: string; offset: number };
    if (res.attach) {
      try {
        const runner = requireRunner(resolved);
        if (res.attach.kind === "indicator") {
          const step = res.steps.find((s) => s.type === "ATTACH_IND_FULL");
          if (step) {
            const p = step.params[2] ?? "";
            const resolvedPath = resolveIndicatorFromRunner(p, runner.dataPath);
            if (resolvedPath) {
              step.params[2] = resolvedPath;
            }
          }
        }
        const logFile = findLatestLogFile(runner.dataPath);
        if (logFile && fs.existsSync(logFile)) {
          const stat = fs.statSync(logFile);
          logStart = { file: logFile, offset: stat.size };
          trace(`logStart ${logFile} offset=${stat.size}`);
        }
      } catch {
        // ignore logStart
      }
    }
    const applyStep = res.steps.find((s) => s.type === "APPLY_TPL");
    if (applyStep && applyStep.params.length >= 2) {
      try {
        await ensureChartOpen(applyStep.params[0], applyStep.params[1], transport);
      } catch (err) {
        process.stderr.write(`WARN chart_open: ${String(err)}\n`);
      }
    }
    const saveStep = res.steps.find((s) => s.type === "SAVE_TPL_EA");
    const attachMeta = res.meta ?? DEFAULT_ATTACH_META;
    if (saveStep) {
      const expertPath = saveStep.params[0] ?? "";
      if (expertPath && (expertPath.toLowerCase().endsWith(".mq5") || expertPath.toLowerCase().endsWith(".ex5") || expertPath.includes(":\\") || expertPath.includes("/"))) {
        const kind = detectMqlKind(expertPath);
        if (kind === "indicator") {
          process.stderr.write("ERR arquivo informado é indicador, nao Expert Advisor\n");
          process.exitCode = 1;
          return;
        }
        if (kind === "script") {
          process.stderr.write("ERR arquivo informado é script, nao Expert Advisor\n");
          process.exitCode = 1;
          return;
        }
      }
    }
    if (saveStep) {
      try {
        const runner = requireRunner(resolved);
        const resolvedExpert = resolveExpertFromRunner(saveStep.params[0] ?? "", runner.dataPath);
        if (resolvedExpert?.name) {
          saveStep.params[0] = resolvedExpert.name;
        }
        if (resolvedExpert?.mq5) {
          await compileMqSource(resolvedExpert.mq5, resolved);
        } else if (!resolvedExpert?.ex5) {
          process.stderr.write("ERR expert nao encontrado em MQL5/Experts (mq5/ex5)\n");
          process.exitCode = 1;
          return;
        } else {
          process.stderr.write("WARN sem fonte .mq5; pulando compile.\n");
        }
      } catch (err) {
        process.stderr.write(`ERR preflight_compile: ${String(err)}\n`);
        process.exitCode = 1;
        return;
      }
    }
    let steps = [...res.steps];
    if (saveStep) {
      try {
        const runner = requireRunner(resolved);
        const baseTpl = resolveBaseTplName(saveStep.params[2] ?? resolved.baseTpl ?? "", runner.dataPath ?? "");
        if (baseTpl) {
          createExpertTemplate({
            expert: saveStep.params[0],
            outTpl: saveStep.params[1],
            baseTpl,
            params: saveStep.params[3],
            dataPath: runner.dataPath ?? ""
          });
          steps = steps.filter((s) => s.type !== "SAVE_TPL_EA");
        }
      } catch {
        // fallback to service SAVE_TPL_EA
      }
    }

    const responses: Array<{ type: string; params: string[]; response: string }> = [];
    let hadBaseTplError = false;
    let lastApplyOk = false;
    let lastExpertName = saveStep?.params[0] ?? "";
    let hadFatalError = false;
    for (const step of steps) {
      const response = await executeSend(step, transport);
      responses.push({ type: step.type, params: step.params, response });
      if (isErrorResponse(response)) {
        maybeExplainError(response);
        if (step.type === "SAVE_TPL_EA" && isBaseTplError(response)) {
          hadBaseTplError = true;
          const applyStep = res.steps.find((s) => s.type === "APPLY_TPL");
          if (!applyStep) {
            process.exitCode = 1;
            hadFatalError = true;
            break;
          }
          try {
            const runner = requireRunner(resolved);
            let baseTpl = step.params[2] ?? resolved.baseTpl ?? "";
            if (!baseTpl) {
              const templatesDir = path.join(toWslPath(runner.dataPath ?? ""), "MQL5", "Profiles", "Templates");
              const candidates = ["Moving Average.tpl", "Default.tpl", "default.tpl"];
              for (const name of candidates) {
                const p = path.join(templatesDir, name);
                if (fs.existsSync(p)) {
                  baseTpl = name;
                  break;
                }
              }
            }
            if (!baseTpl) throw new Error("base template ausente para fallback local");
            createExpertTemplate({
              expert: step.params[0],
              outTpl: step.params[1],
              baseTpl,
              params: step.params[3],
              dataPath: runner.dataPath ?? ""
            });
            const applyResp = await executeSend({ type: "APPLY_TPL", params: applyStep.params }, transport);
            responses.push({ type: "APPLY_TPL", params: applyStep.params, response: applyResp });
            if (isErrorResponse(applyResp)) {
              process.exitCode = 1;
              hadFatalError = true;
            }
            else {
              lastApplyOk = true;
              lastExpertName = step.params[0];
            }
          } catch (err) {
            process.stderr.write(String(err) + "\n");
            process.exitCode = 1;
            hadFatalError = true;
          }
          break;
        }
        process.exitCode = 1;
        hadFatalError = true;
        break;
      }
      if (step.type === "APPLY_TPL") lastApplyOk = true;
      if (step.type === "SAVE_TPL_EA") lastExpertName = step.params[0];
    }
    if (hadBaseTplError && !opts.json) {
      process.stderr.write("WARN: base_tpl invalido no serviço; usado fallback local.\n");
    }
    if (lastApplyOk && lastExpertName) {
      try {
        const runner = requireRunner(resolved);
        const apply = res.steps.find((s) => s.type === "APPLY_TPL");
        if (apply) {
          let ok = await verifyExpertAttached(
            apply.params[0],
            apply.params[1],
            lastExpertName,
            transport,
            runner.dataPath ?? ""
          );
          if (!ok) {
            await sleep(400);
            const applyResp = await executeSend({ type: "APPLY_TPL", params: apply.params }, transport);
            responses.push({ type: "APPLY_TPL", params: apply.params, response: applyResp });
            if (isErrorResponse(applyResp)) {
              process.exitCode = 1;
              hadFatalError = true;
              ok = false;
            } else {
              await sleep(400);
              ok = await verifyExpertAttached(
                apply.params[0],
                apply.params[1],
                lastExpertName,
                transport,
                runner.dataPath ?? ""
              );
            }
          }
          if (!ok) {
            process.stderr.write("ERR ea_not_attached (template aplicado, mas EA nao apareceu no chart)\n");
            process.exitCode = 1;
            hadFatalError = true;
          }
        }
      } catch (err) {
        process.stderr.write(`WARN verify_ea: ${String(err)}\n`);
      }
    }
    let report: AttachReport | null = null;
    if (!hadFatalError && res.attach && attachMeta.report) {
      try {
        const runner = requireRunner(resolved);
        report = await buildAttachReport({
          kind: res.attach.kind,
          name: res.attach.name,
          symbol: res.attach.symbol,
          tf: res.attach.tf,
          sub: res.attach.sub,
          meta: attachMeta,
          runner,
          send: (action) => executeSend(action, transport),
          logStart: logStart ?? undefined
        });
      } catch (err) {
        process.stderr.write(`WARN attach_report: ${String(err)}\n`);
      }
    }
    if (opts.json) {
      process.stdout.write(JSON.stringify({ kind: "multi", responses, report }) + "\n");
    } else if (hadFatalError) {
      for (const r of responses) {
        const errs = extractErrorLines(r.response);
        if (errs) process.stderr.write(errs);
      }
    } else {
      for (const r of responses) {
        if (hadBaseTplError && r.type === "SAVE_TPL_EA" && isBaseTplError(r.response)) continue;
        process.stdout.write(r.response);
      }
      if (report) process.stdout.write(formatAttachReport(report) + "\n");
    }
  }
}

main().catch(handleError);
