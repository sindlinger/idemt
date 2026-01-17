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
  requireTransport,
  resolveConfig,
  toWslPath,
  toWindowsPath,
  isWindowsPath,
  isWsl
} from "./lib/config.js";
import { runTester } from "./lib/tester.js";
import { createExpertTemplate } from "./lib/template.js";
import { buildAttachReport, formatAttachReport, DEFAULT_ATTACH_META, findLatestLogFile } from "./lib/attach_report.js";
import { runInstall } from "./lib/install.js";

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
    "/mnt/c/git/mt5ide/services/telnetmt/tools/mt5-compile.exe",
    "/mnt/c/mql/mt5-shellscripts/CLI/mt5-compile.exe",
    "/mnt/c/mql/mt5-shellscripts/compile.cmd"
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    if (existsPath(c)) return c;
  }
  return null;
}

function isPlainFileName(p?: string): boolean {
  if (!p) return false;
  if (p.includes("/") || p.includes("\\")) return false;
  return true;
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

type ResolvedExpert = { name: string; mq5?: string; ex5?: string };

function normalizeExpertRelName(relPath: string): string {
  let rel = relPath.replace(/\\/g, "/");
  rel = rel.replace(/\.(mq5|ex5)$/i, "");
  return rel.replace(/\//g, "\\");
}

function resolveExpertFromRunner(input: string, dataPath?: string): ResolvedExpert | null {
  if (!dataPath || !input) return null;
  const base = path.join(toWslPath(dataPath), "MQL5", "Experts");
  const hasExt = /\.(mq5|ex5)$/i.test(input);
  const hasSeparators = input.includes("/") || input.includes("\\");
  const candidates = hasExt ? [input] : [`${input}.ex5`, `${input}.mq5`];

  if (hasSeparators) {
    const localRaw = isWindowsPath(input) ? toWslPath(input) : input;
    if (fs.existsSync(localRaw)) {
      if (localRaw.startsWith(base)) {
        const rel = path.relative(base, localRaw);
        const name = normalizeExpertRelName(rel);
        const mq5 = localRaw.toLowerCase().endsWith(".mq5") ? localRaw : undefined;
        const ex5 = localRaw.toLowerCase().endsWith(".ex5") ? localRaw : undefined;
        return { name, mq5, ex5 };
      }
      const name = normalizeExpertRelName(path.basename(localRaw));
      const mq5 = localRaw.toLowerCase().endsWith(".mq5") ? localRaw : undefined;
      const ex5 = localRaw.toLowerCase().endsWith(".ex5") ? localRaw : undefined;
      return { name, mq5, ex5 };
    }
    let relInput = input.replace(/^[/\\]+/, "");
    relInput = relInput.replace(/^mql5[\\/]/i, "");
    relInput = relInput.replace(/^experts[\\/]/i, "");
    const relCandidates = hasExt ? [relInput] : [`${relInput}.ex5`, `${relInput}.mq5`];
    for (const candidate of relCandidates) {
      const full = path.join(base, candidate);
      if (fs.existsSync(full)) {
        const name = normalizeExpertRelName(candidate);
        const mq5 = full.toLowerCase().endsWith(".mq5") ? full : undefined;
        const ex5 = full.toLowerCase().endsWith(".ex5") ? full : undefined;
        return { name, mq5, ex5 };
      }
    }
    return null;
  }

  for (const candidate of candidates) {
    const found = findFileRecursive(base, candidate);
    if (found) {
      const rel = path.relative(base, found);
      const name = normalizeExpertRelName(rel);
      const mq5 = found.toLowerCase().endsWith(".mq5") ? found : undefined;
      const ex5 = found.toLowerCase().endsWith(".ex5") ? found : undefined;
      return { name, mq5, ex5 };
    }
  }
  return null;
}

function resolveMqSourceFromRunner(input: string, dataPath?: string): string | null {
  if (!dataPath || !input) return null;
  const base = path.join(toWslPath(dataPath), "MQL5");
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

function toWindowsArgsIfNeeded(args: string[], compilePath: string): string[] {
  if (!isWsl()) return args;
  const lower = compilePath.toLowerCase();
  const isWinTarget = isWindowsPath(compilePath) || lower.endsWith(".cmd") || lower.endsWith(".bat");
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

async function compileMqSource(src: string, resolved: { compilePath?: string }): Promise<void> {
  let compilePath = resolveCompilePath(resolved);
  if (!compilePath) {
    throw new Error(
      "compile nao configurado. Use --compile-path, CMDMT_COMPILE ou defaults.compilePath no config."
    );
  }
  const args = isMetaEditorPath(compilePath) ? buildMetaEditorArgs(src, []) : [src];
  await runCompile(compilePath, toWindowsArgsIfNeeded(args, compilePath));
}

async function runCompile(pathOrCmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const isCmd = pathOrCmd.toLowerCase().endsWith(".cmd") || pathOrCmd.toLowerCase().endsWith(".bat");
    if (isWsl() && (isWindowsPath(pathOrCmd) || isCmd)) {
      const winPath = isWindowsPath(pathOrCmd) ? pathOrCmd : toWindowsPath(pathOrCmd);
      const cmdArgs = ["/C", winPath, ...args];
      const child = spawn("cmd.exe", cmdArgs, { stdio: "inherit" });
      child.on("error", reject);
      child.on("exit", (code: number | null) =>
        code && code !== 0 ? reject(new Error(`compile retornou ${code}`)) : resolve()
      );
      return;
    }
    const execPath = isWsl() && isWindowsPath(pathOrCmd) ? toWslPath(pathOrCmd) : pathOrCmd;
    const child = spawn(execPath, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code: number | null) =>
      code && code !== 0 ? reject(new Error(`compile retornou ${code}`)) : resolve()
    );
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
    .option("--visual", "tester visual (override)")
    .option("--no-visual", "tester sem visual (override)")
    .option("--win <WxH>", "tamanho da janela do terminal (ex: 1400x900)")
    .option("--pos <X,Y>", "posicao da janela do terminal (ex: 100,40)")
    .option("--fullscreen", "terminal fullscreen (override)")
    .option("--no-fullscreen", "terminal sem fullscreen (override)")
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
    const compileArgs = tokens.slice(1);
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
    if (compileArgs.length && looksLikeMqSource(compileArgs[0]) && !userSpecified) {
      try {
        const runner = requireRunner(resolved);
        if (runner.metaeditorPath && existsPath(runner.metaeditorPath)) {
          compilePath = runner.metaeditorPath;
        }
      } catch {
        // ignore, use compilePath resolved
      }
    }
    const finalArgs = isMetaEditorPath(compilePath) && compileArgs.length
      ? buildMetaEditorArgs(compileArgs[0], compileArgs)
      : compileArgs;
    await runCompile(compilePath, toWindowsArgsIfNeeded(finalArgs, compilePath));
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
    const web = res.web ?? (Array.isArray(opts.web) ? opts.web : []);
    const dryRun = res.dryRun ?? Boolean(opts.dryRun);
    const repoPath = res.repoPath ?? opts.repo;
    const name = res.name;
    const namePrefix = res.namePrefix;
    const output = runInstall(
      { dataPath, allowDll, allowLive, web, dryRun, repoPath, name, namePrefix },
      process.cwd()
    );
    if (opts.json) {
      process.stdout.write(JSON.stringify({ kind: "install", output }) + "\n");
    } else {
      process.stdout.write(output + "\n");
    }
    return;
  }
  if (res.kind === "test") {
    const runner = requireRunner(resolved);
    const result = await runTester(res.spec, runner, resolved.tester);
    if (opts.json) {
      process.stdout.write(JSON.stringify({ kind: "test", result }) + "\n");
    } else {
      process.stdout.write(`tester: ${result.runDir}\n`);
      if (result.terminalLogPath) process.stdout.write(`terminal-log: ${result.terminalLogPath}\n`);
      if (result.copiedReport) process.stdout.write(`report: ${result.copiedReport}\n`);
      if (result.copiedLogs.length) process.stdout.write(`logs: ${result.copiedLogs.join(", ")}\n`);
    }
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
