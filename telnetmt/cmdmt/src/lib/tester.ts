import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { isWsl, isWindowsPath, toWslPath, toWindowsPath } from "./config.js";
import type { RunnerConfig, TesterConfig } from "./config.js";
import { safeFileBase, stableHash } from "./naming.js";
import { createExpertTemplate } from "./template.js";

export type TestSpec = {
  expert: string;
  symbol: string;
  tf: string;
  params?: string;
  oneShot?: boolean;
  baseTpl?: string;
};

export type TestResult = {
  runDir: string;
  iniPath: string;
  setPath: string;
  reportPath?: string;
  copiedReport?: string;
  copiedLogs: string[];
};

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

function readTextWithEncoding(filePath: string): { text: string; encoding: "utf16le" | "utf8"; bom: boolean } {
  const buf = fs.readFileSync(filePath);
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: buf.slice(2).toString("utf16le"), encoding: "utf16le", bom: true };
  }
  return { text: buf.toString("utf8"), encoding: "utf8", bom: false };
}

function writeTextWithEncoding(filePath: string, text: string, encoding: "utf16le" | "utf8", bom: boolean) {
  if (encoding === "utf16le") {
    const content = Buffer.from(text, "utf16le");
    const out = bom ? Buffer.concat([Buffer.from([0xff, 0xfe]), content]) : content;
    fs.writeFileSync(filePath, out);
    return;
  }
  fs.writeFileSync(filePath, text, "utf8");
}

function parseParams(params?: string): Array<{ key: string; value: string }> {
  if (!params) return [];
  return params
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((entry) => {
      const idx = entry.indexOf("=");
      if (idx <= 0) return { key: entry, value: "" };
      return { key: entry.slice(0, idx).trim(), value: entry.slice(idx + 1).trim() };
    });
}

function writeSetFile(filePath: string, inputs: Array<{ key: string; value: string }>) {
  const lines = inputs.map((pair) => `${pair.key}=${pair.value}`);
  fs.writeFileSync(filePath, lines.join("\n"), "utf8");
}

function formatIniSection(name: string, entries: Record<string, string | number | undefined>): string {
  const lines = Object.entries(entries)
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([key, value]) => `${key}=${value}`);
  return [`[${name}]`, ...lines, ""].join("\n");
}

function resolveRunnerPaths(runner: RunnerConfig): { terminalPath: string; dataPath: string } {
  const terminalPath = runner.terminalPath ?? "";
  const dataPath = runner.dataPath ?? "";
  if (!terminalPath || !dataPath) {
    throw new Error("runner incompleto: terminalPath e dataPath sao obrigatorios para o tester");
  }
  return { terminalPath, dataPath };
}

function resolveDataPathWsl(dataPath: string): string {
  if (isWsl() && isWindowsPath(dataPath)) return toWslPath(dataPath);
  return dataPath;
}

function normalizeExpertId(expert: string): string {
  let e = expert.replace(/\//g, "\\");
  const lower = e.toLowerCase();
  const marker = "\\mql5\\experts\\";
  const idx = lower.indexOf(marker);
  if (idx >= 0) e = e.slice(idx + marker.length);
  if (e.toLowerCase().startsWith("experts\\")) e = e.slice("experts\\".length);
  const tail = e.slice(-4).toLowerCase();
  if (tail === ".ex5" || tail === ".mq5") e = e.slice(0, -4);
  return e;
}

function joinExpertPath(base: string, expertId: string, ext: string): string {
  const parts = expertId.split("\\").filter(Boolean);
  return path.join(base, ...parts) + ext;
}

function findExpertByName(base: string, name: string): Array<{ path: string; ext: string }> {
  const results: Array<{ path: string; ext: string }> = [];
  const stack: string[] = [base];
  while (stack.length) {
    const dir = stack.pop();
    if (!dir) break;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(p);
        continue;
      }
      if (!entry.isFile()) continue;
      const lower = entry.name.toLowerCase();
      if (lower === `${name.toLowerCase()}.ex5`) results.push({ path: p, ext: ".ex5" });
      if (lower === `${name.toLowerCase()}.mq5`) results.push({ path: p, ext: ".mq5" });
    }
  }
  return results;
}

function resolveExpertFiles(dataPathWsl: string, expert: string): { expertId: string; ex5Path?: string; mq5Path?: string } {
  const base = path.join(dataPathWsl, "MQL5", "Experts");
  const expertId = normalizeExpertId(expert);
  const directEx5 = joinExpertPath(base, expertId, ".ex5");
  const directMq5 = joinExpertPath(base, expertId, ".mq5");
  if (fs.existsSync(directEx5) || fs.existsSync(directMq5)) {
    return { expertId, ex5Path: fs.existsSync(directEx5) ? directEx5 : undefined, mq5Path: fs.existsSync(directMq5) ? directMq5 : undefined };
  }

  const nameOnly = expertId.split("\\").pop() ?? expertId;
  const matches = findExpertByName(base, nameOnly);
  const ex5 = matches.find((m) => m.ext === ".ex5")?.path;
  const mq5 = matches.find((m) => m.ext === ".mq5")?.path;
  if (!ex5 && !mq5) {
    throw new Error(`expert nao encontrado em ${base}: ${expert}`);
  }
  const chosen = ex5 ?? mq5!;
  const rel = path.relative(base, chosen).replace(/\//g, "\\");
  const resolvedId = rel.replace(/\.(mq5|ex5)$/i, "");
  return { expertId: resolvedId, ex5Path: ex5, mq5Path: mq5 };
}

function compileMq5(mq5Path: string, metaeditorPath?: string, logPath?: string) {
  if (!metaeditorPath) {
    throw new Error("metaeditorPath nao configurado. Defina runners.<id>.metaeditorPath no config.");
  }
  const execPath = isWsl() && isWindowsPath(metaeditorPath) ? toWslPath(metaeditorPath) : metaeditorPath;
  const winMq5 = toWindowsPath(mq5Path);
  const winLog = logPath ? toWindowsPath(logPath) : undefined;
  const args = ["/compile:" + winMq5];
  if (winLog) args.push("/log:" + winLog);
  const result = spawnSync(execPath, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status && result.status !== 0) {
    throw new Error(`metaeditor retornou ${result.status}`);
  }
}

function updateIniValue(text: string, section: string, key: string, value: string | number | undefined): string {
  if (value === undefined || value === "") return text;
  const escapedSection = section.replace(/[[\]{}()*+?.\\^$|]/g, "\\$&");
  const sectionRe = new RegExp(`(^\\[${escapedSection}\\][\\s\\S]*?)(?=^\\[|\\Z)`, "m");
  const match = text.match(sectionRe);
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const line = `${key}=${value}`;
  if (!match) {
    return text + newline + `[${section}]` + newline + line + newline;
  }
  const block = match[1];
  const lines = block.split(/\r?\n/);
  let found = false;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].startsWith(`${key}=`)) {
      lines[i] = line;
      found = true;
      break;
    }
  }
  if (!found) {
    lines.push(line);
  }
  const updated = lines.join(newline);
  return text.replace(block, updated);
}

function syncCommonIni(dataPathWsl: string, tester: TesterConfig) {
  const commonPath = path.join(dataPathWsl, "config", "common.ini");
  if (!fs.existsSync(commonPath)) return;
  const shouldSync =
    tester.syncCommon === true ||
    tester.login !== undefined ||
    tester.password !== undefined ||
    tester.server !== undefined ||
    tester.maxBars !== undefined ||
    tester.maxBarsInChart !== undefined;
  if (!shouldSync) return;
  const { text, encoding, bom } = readTextWithEncoding(commonPath);
  let next = text;
  next = updateIniValue(next, "Common", "Login", tester.login);
  next = updateIniValue(next, "Common", "Password", tester.password);
  next = updateIniValue(next, "Common", "Server", tester.server);
  next = updateIniValue(next, "Charts", "MaxBars", tester.maxBars);
  next = updateIniValue(next, "Charts", "MaxBarsInChart", tester.maxBarsInChart);
  if (next !== text) writeTextWithEncoding(commonPath, next, encoding, bom);
}

function ensureExpertReady(
  dataPathWsl: string,
  expert: string,
  metaeditorPath?: string,
  logDir?: string
): { expertId: string; ex5Path: string } {
  const resolved = resolveExpertFiles(dataPathWsl, expert);
  const mq5 = resolved.mq5Path;
  let ex5 = resolved.ex5Path;
  if (!ex5 && mq5) {
    const logPath = logDir ? path.join(logDir, "metaeditor.log") : undefined;
    compileMq5(mq5, metaeditorPath, logPath);
    const base = path.join(dataPathWsl, "MQL5", "Experts");
    ex5 = joinExpertPath(base, resolved.expertId, ".ex5");
  }
  if (mq5 && ex5) {
    const mq5Stat = fs.statSync(mq5);
    const ex5Stat = fs.existsSync(ex5) ? fs.statSync(ex5) : undefined;
    if (!ex5Stat || mq5Stat.mtimeMs > ex5Stat.mtimeMs) {
      const logPath = logDir ? path.join(logDir, "metaeditor.log") : undefined;
      compileMq5(mq5, metaeditorPath, logPath);
    }
  }
  if (!ex5 || !fs.existsSync(ex5)) {
    throw new Error(`expert ex5 nao encontrado: ${resolved.expertId}`);
  }
  return { expertId: resolved.expertId, ex5Path: ex5 };
}

function pickLatestLog(dir: string, after: number): string | null {
  if (!fs.existsSync(dir)) return null;
  const entries = fs
    .readdirSync(dir)
    .map((name) => ({ name, path: path.join(dir, name) }))
    .filter((entry) => entry.name.toLowerCase().endsWith(".log"))
    .map((entry) => ({ ...entry, stat: fs.statSync(entry.path) }))
    .filter((entry) => entry.stat.mtimeMs >= after);
  if (entries.length === 0) return null;
  entries.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  return entries[0].path;
}

function copyIfExists(src: string | null | undefined, destDir: string): string | null {
  if (!src) return null;
  if (!fs.existsSync(src)) return null;
  const base = path.basename(src);
  const dest = path.join(destDir, base);
  fs.copyFileSync(src, dest);
  return dest;
}

export async function runTester(
  spec: TestSpec,
  runner: RunnerConfig,
  tester: TesterConfig
): Promise<TestResult> {
  const { terminalPath, dataPath } = resolveRunnerPaths(runner);
  const dataPathWsl = resolveDataPathWsl(dataPath);
  syncCommonIni(dataPathWsl, tester);

  const inputs = parseParams(spec.params);
  const hash = stableHash(`${spec.expert}|${spec.symbol}|${spec.tf}|${spec.params ?? ""}`);
  const baseName = safeFileBase(`${spec.expert}-${spec.symbol}-${spec.tf}`);
  const runDirRoot = tester.artifactsDir || "cmdmt-artifacts";
  const runDir = path.isAbsolute(runDirRoot) || isWindowsPath(runDirRoot)
    ? resolveDataPathWsl(runDirRoot)
    : path.join(dataPathWsl, runDirRoot);
  ensureDir(runDir);

  const runId = `${Date.now()}-${hash}`;
  const runDirFinal = path.join(runDir, runId);
  ensureDir(runDirFinal);

  const expertReady = ensureExpertReady(dataPathWsl, spec.expert, runner.metaeditorPath, runDirFinal);
  const expertId = expertReady.expertId;

  if (spec.oneShot) {
    let baseTpl = spec.baseTpl?.trim() ?? "";
    if (!baseTpl) {
      const templatesDir = path.join(dataPathWsl, "MQL5", "Profiles", "Templates");
      const candidates = ["Moving Average.tpl", "Default.tpl", "default.tpl"];
      const found = candidates.find((name) => fs.existsSync(path.join(templatesDir, name)));
      if (found) baseTpl = found;
    }
    if (!baseTpl) {
      throw new Error("base template ausente para expert run. Use --base-tpl/CMDMT_BASE_TPL.");
    }
    createExpertTemplate({
      expert: expertId,
      outTpl: "tester.tpl",
      baseTpl,
      params: spec.params,
      dataPath: runner.dataPath ?? ""
    });
  }

  const profilesTesterDir = path.join(dataPathWsl, "MQL5", "Profiles", "Tester");
  ensureDir(profilesTesterDir);

  const setFileName = `${baseName}-${hash}.set`;
  const setFilePath = path.join(profilesTesterDir, setFileName);
  writeSetFile(setFilePath, inputs);

  const reportDir = tester.reportDir || "reports";
  const reportFile = `${baseName}-${hash}.html`;
  const reportDirIsAbs = path.isAbsolute(reportDir) || isWindowsPath(reportDir);
  const reportAbs = reportDirIsAbs
    ? path.join(resolveDataPathWsl(reportDir), reportFile)
    : path.join(dataPathWsl, path.win32.join(reportDir, reportFile).replace(/\\/g, path.sep));
  const reportIni = reportDirIsAbs ? toWindowsPath(reportAbs) : path.win32.join(reportDir, reportFile);
  ensureDir(path.dirname(reportAbs));

  const iniEntries = {
    Expert: expertId,
    ExpertParameters: setFileName,
    Symbol: spec.symbol,
    Period: spec.tf,
    Login: tester.login,
    Password: tester.password,
    Server: tester.server,
    Model: tester.model,
    ExecutionMode: tester.executionMode,
    Optimization: tester.optimization,
    UseLocal: tester.useLocal,
    UseRemote: tester.useRemote,
    UseCloud: tester.useCloud,
    Visual: tester.visual,
    ReplaceReport: tester.replaceReport,
    ShutdownTerminal: tester.shutdownTerminal,
    Report: reportIni,
    Deposit: tester.deposit,
    Currency: tester.currency,
    Leverage: tester.leverage,
    FromDate: tester.fromDate,
    ToDate: tester.toDate,
    ForwardMode: tester.forwardMode,
    ForwardDate: tester.forwardDate
  };

  const iniContent = formatIniSection("Tester", iniEntries);
  const iniPath = path.join(runDirFinal, `${baseName}-${hash}.ini`);
  fs.writeFileSync(iniPath, iniContent, "utf8");

  const terminalExec = isWsl() && isWindowsPath(terminalPath) ? toWslPath(terminalPath) : terminalPath;
  const configArg = `/config:${toWindowsPath(iniPath)}`;
  const args = [configArg];
  if (runner.portable) args.unshift("/portable");

  const startTime = Date.now();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(terminalExec, args, { stdio: "inherit" });
    child.on("error", (err) => reject(err));
    child.on("exit", (code) => {
      if (code && code !== 0) {
        if (code === 189) {
          reject(new Error("terminal ja esta aberto com o mesmo data path; feche a instancia e tente novamente"));
          return;
        }
        reject(new Error(`terminal retornou ${code}`));
        return;
      }
      resolve();
    });
  });

  const copiedReport = copyIfExists(reportAbs, runDirFinal);

  const logDirs = [
    path.join(dataPathWsl, "Logs"),
    path.join(dataPathWsl, "Tester", "Logs"),
    path.join(dataPathWsl, "MQL5", "Logs"),
    path.join(dataPathWsl, "MQL5", "Tester", "Logs")
  ];
  const copiedLogs: string[] = [];
  for (const dir of logDirs) {
    const latest = pickLatestLog(dir, startTime);
    const copied = copyIfExists(latest, runDirFinal);
    if (copied) copiedLogs.push(copied);
  }

  return {
    runDir: runDirFinal,
    iniPath,
    setPath: setFilePath,
    reportPath: reportAbs,
    copiedReport: copiedReport ?? undefined,
    copiedLogs
  };
}
