import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { isWsl, toWslPath, toWindowsPath, isWindowsPath } from "./config.js";
import { readTextWithEncoding, writeTextWithEncoding } from "./textfile.js";

export type InstallSpec = {
  dataPath?: string;
  repoPath?: string;
  name?: string;
  namePrefix?: string;
  mirrorFrom?: string;
  mirrorDirs?: string[];
  allowDll: boolean;
  allowLive: boolean;
  syncCommon?: boolean;
  login?: string | number;
  password?: string;
  server?: string;
  web: string[];
  dryRun: boolean;
};

type ConfigFile = {
  envPath?: string;
  transport?: { host?: string; hosts?: string[]; port?: number; timeoutMs?: number };
  testerTransport?: { host?: string; hosts?: string[]; port?: number; timeoutMs?: number };
  context?: { symbol?: string; tf?: string; sub?: number };
  runner?: string;
  testerRunner?: string;
  baseTpl?: string;
  compilePath?: string;
  repoPath?: string;
  repoAutoBuild?: boolean;
  tester?: Record<string, unknown>;
  defaults?: Record<string, unknown>;
  profiles?: Record<string, unknown>;
  runners?: Record<string, Record<string, unknown>>;
  profile?: string;
};

function normalizeDataPath(raw?: string): string | null {
  if (!raw) return null;
  let p = raw.trim().replace(/^"|"$/g, "");
  if (!p) return null;
  const lower = p.toLowerCase().replace(/\\/g, "/");
  if (lower.endsWith("/mql5")) {
    p = path.dirname(p);
  }
  return p;
}

function findTelnetMtRoot(start: string): string | null {
  let dir = path.resolve(start);
  for (let i = 0; i < 6; i++) {
    const candidates = [
      { probe: path.join(dir, "services", "telnetmt", "Services"), root: path.join(dir, "services", "telnetmt") },
      { probe: path.join(dir, "Services", "telnetmt", "Services"), root: path.join(dir, "Services", "telnetmt") },
      { probe: path.join(dir, "telnetmt", "Services"), root: path.join(dir, "telnetmt") }
    ];
    for (const cand of candidates) {
      if (fs.existsSync(cand.probe)) return cand.root;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
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
  if (!found) lines.push(line);
  const updated = lines.join(newline);
  return text.replace(block, updated);
}

function updateIniList(text: string, section: string, key: string, values: string[]): string {
  if (!values.length) return text;
  const escapedSection = section.replace(/[[\]{}()*+?.\\^$|]/g, "\\$&");
  const sectionRe = new RegExp(`(^\\[${escapedSection}\\][\\s\\S]*?)(?=^\\[|\\Z)`, "m");
  const match = text.match(sectionRe);
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  if (!match) {
    const lines = [`[${section}]`, ...values.map((v) => `${key}=${v}`), ""].join(newline);
    return text + newline + lines;
  }
  const block = match[1];
  const lines = block.split(/\r?\n/);
  const next: string[] = [lines[0]];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith(`${key}=`)) continue;
    if (!line.trim() && next.length && !next[next.length - 1].trim()) continue;
    next.push(line);
  }
  for (const v of values) next.push(`${key}=${v}`);
  const updated = next.join(newline) + newline;
  return text.replace(block, updated);
}

function ensureIniAllows(dataPathWsl: string, spec: InstallSpec, log: string[]) {
  const commonPath = path.join(dataPathWsl, "config", "common.ini");
  if (!fs.existsSync(commonPath)) {
    log.push(`common.ini nao encontrado: ${commonPath}`);
  } else {
    const { text, encoding, bom } = readTextWithEncoding(commonPath);
    let next = text;
    next = updateIniValue(next, "Experts", "AllowDllImport", spec.allowDll ? 1 : 0);
    next = updateIniValue(next, "Experts", "AllowLiveTrading", spec.allowLive ? 1 : 0);
    const wantsSync =
      spec.syncCommon === true ||
      spec.login !== undefined ||
      spec.password !== undefined ||
      spec.server !== undefined;
    if (wantsSync) {
      next = updateIniValue(next, "Common", "Login", spec.login);
      next = updateIniValue(next, "Common", "Password", spec.password);
      next = updateIniValue(next, "Common", "Server", spec.server);
    }
    if (next !== text) writeTextWithEncoding(commonPath, next, encoding, bom);
    log.push(`common.ini atualizado: AllowDllImport=${spec.allowDll ? 1 : 0}, AllowLiveTrading=${spec.allowLive ? 1 : 0}`);
    if (wantsSync) {
      log.push("common.ini atualizado: Login/Password/Server");
    }
  }

  if (spec.web.length) {
    const terminalPath = path.join(dataPathWsl, "config", "terminal.ini");
    if (!fs.existsSync(terminalPath)) {
      log.push(`terminal.ini nao encontrado: ${terminalPath}`);
    } else {
      const { text, encoding, bom } = readTextWithEncoding(terminalPath);
      const next = updateIniList(text, "WebRequest", "Url", spec.web);
      if (next !== text) writeTextWithEncoding(terminalPath, next, encoding, bom);
      log.push(`terminal.ini atualizado: WebRequest Url x${spec.web.length}`);
    }
  }
}

function toWinPath(p: string): string {
  return isWsl() ? toWindowsPath(p) : p;
}

function psEscape(value: string): string {
  return value.replace(/'/g, "''");
}

function readJsonFile(filePath: string): ConfigFile | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw) as ConfigFile;
  } catch {
    return null;
  }
}

function writeJsonFile(filePath: string, data: ConfigFile): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

function deriveTerminalPaths(dataPathWsl: string): { terminalPath?: string; metaeditorPath?: string } {
  const originPath = path.join(dataPathWsl, "origin.txt");
  if (!fs.existsSync(originPath)) return {};
  let origin = "";
  try {
    origin = readTextWithEncoding(originPath).text.trim();
  } catch {
    return {};
  }
  if (!origin) return {};
  const winOrigin = isWindowsPath(origin) ? origin : toWindowsPath(origin);
  let installDir = winOrigin;
  if (/\.exe$/i.test(winOrigin)) installDir = path.win32.dirname(winOrigin);
  const terminal64 = path.win32.join(installDir, "terminal64.exe");
  const terminal32 = path.win32.join(installDir, "terminal.exe");
  const terminalPath = fs.existsSync(toWslPath(terminal64))
    ? terminal64
    : fs.existsSync(toWslPath(terminal32))
      ? terminal32
      : undefined;
  const meta64 = path.win32.join(installDir, "MetaEditor64.exe");
  const meta32 = path.win32.join(installDir, "MetaEditor.exe");
  const metaeditorPath = fs.existsSync(toWslPath(meta64))
    ? meta64
    : fs.existsSync(toWslPath(meta32))
      ? meta32
      : undefined;
  return { terminalPath, metaeditorPath };
}

function mergeTransport(target: ConfigFile, source?: ConfigFile["transport"]): void {
  if (!source) return;
  if (!target.transport) {
    target.transport = { ...source };
    return;
  }
  if (!target.transport.hosts && source.hosts) target.transport.hosts = [...source.hosts];
  if (!target.transport.host && source.host) target.transport.host = source.host;
  if (!target.transport.port && source.port) target.transport.port = source.port;
  if (!target.transport.timeoutMs && source.timeoutMs) target.transport.timeoutMs = source.timeoutMs;
}

function mergeRunner(target: ConfigFile, runnerId: string, runner: Record<string, unknown>): void {
  if (!target.runners) target.runners = {};
  const existing = target.runners[runnerId] ?? {};
  target.runners[runnerId] = { ...existing, ...runner };
}

function updateConfigFromInstall(
  configPath: string,
  repoCfg: ConfigFile | null,
  runnerId: string,
  runnerData: { terminalPath?: string; dataPath?: string; metaeditorPath?: string },
  repoPathForDelegate?: string
): void {
  const cfg = readJsonFile(configPath) ?? {};
  if (!cfg.runner && repoCfg?.runner) cfg.runner = repoCfg.runner;
  if (!cfg.runner) cfg.runner = runnerId;
  if (!cfg.testerRunner && repoCfg?.testerRunner) cfg.testerRunner = repoCfg.testerRunner;
  if (!cfg.envPath && repoCfg?.envPath) cfg.envPath = repoCfg.envPath;
  if (!cfg.baseTpl && repoCfg?.baseTpl) cfg.baseTpl = repoCfg.baseTpl;
  if (!cfg.compilePath && repoCfg?.compilePath) cfg.compilePath = repoCfg.compilePath;
  if (!cfg.repoPath && repoPathForDelegate) cfg.repoPath = repoPathForDelegate;
  if (cfg.repoAutoBuild === undefined && repoCfg?.repoAutoBuild !== undefined) {
    cfg.repoAutoBuild = repoCfg.repoAutoBuild;
  }
  if (cfg.repoAutoBuild === undefined && repoPathForDelegate) cfg.repoAutoBuild = true;
  mergeTransport(cfg, repoCfg?.transport);
  if (repoCfg?.testerTransport && !cfg.testerTransport) cfg.testerTransport = repoCfg.testerTransport;
  if (repoCfg?.runners) {
    for (const [id, data] of Object.entries(repoCfg.runners)) {
      if (!cfg.runners?.[id]) {
        mergeRunner(cfg, id, data);
      }
    }
  }
  const runnerPayload: Record<string, unknown> = {
    ...(runnerData.terminalPath ? { terminalPath: runnerData.terminalPath } : {}),
    ...(runnerData.dataPath ? { dataPath: runnerData.dataPath } : {}),
    ...(runnerData.metaeditorPath ? { metaeditorPath: runnerData.metaeditorPath } : {})
  };
  mergeRunner(cfg, runnerId, runnerPayload);
  writeJsonFile(configPath, cfg);
}

function runPowerShell(script: string): { ok: boolean; out: string } {
  const direct = () => {
    const res = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { encoding: "utf8", timeout: 30000 }
    );
    const out = `${res.stdout || ""}${res.stderr || ""}`.trim();
    return { ok: res.status === 0, out };
  };

  if (isWsl() && process.env.CMDMT_INSTALL_TTY !== "0") {
    const safe = script.replace(/"/g, "\\\"");
    const cmd = `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command \"${safe}\"`;
    const res = spawnSync("script", ["-q", "-c", cmd, "/dev/null"], { encoding: "utf8", timeout: 30000 });
    const out = `${res.stdout || ""}${res.stderr || ""}`.trim();
    if (res.status === 0 || out) {
      return { ok: res.status === 0, out };
    }
  }

  return direct();
}

function statusLine(status: "OK" | "WARN" | "FAIL", message: string, log: string[]) {
  log.push(`[${status}] ${message}`);
}

function formatBool(val: string | undefined): string {
  if (val === undefined || val === "") return "?";
  return val === "1" ? "1" : "0";
}

function getIniValue(text: string, section: string, key: string): string | undefined {
  const escapedSection = section.replace(/[[\]{}()*+?.\\^$|]/g, "\\$&");
  const sectionRe = new RegExp(`^\\[${escapedSection}\\]$`, "i");
  const keyRe = new RegExp(`^${key}\\s*=\\s*(.*)$`, "i");
  const lines = text.split(/\r?\n/);
  let inSection = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith(";") || trimmed.startsWith("#")) continue;
    if (sectionRe.test(trimmed)) {
      inSection = true;
      continue;
    }
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      inSection = false;
      continue;
    }
    if (!inSection) continue;
    const m = trimmed.match(keyRe);
    if (m) return m[1]?.trim();
  }
  return undefined;
}

function checkPathExists(pathWsl: string): boolean {
  try {
    return fs.existsSync(pathWsl);
  } catch {
    return false;
  }
}

function isSymlink(pathWsl: string): boolean {
  try {
    return fs.lstatSync(pathWsl).isSymbolicLink();
  } catch {
    return false;
  }
}

function ensureJunctions(
  dataPathWin: string,
  telnetRootWin: string,
  names: { services: string; experts: string; scripts: string },
  dryRun: boolean,
  log: string[]
) {
  const mql5Root = path.win32.join(dataPathWin, "MQL5");
  const services = path.win32.join(mql5Root, "Services");
  const experts = path.win32.join(mql5Root, "Experts");
  const scripts = path.win32.join(mql5Root, "Scripts");
  const targetServices = path.win32.join(services, names.services);
  const targetExperts = path.win32.join(experts, names.experts);
  const targetScripts = path.win32.join(scripts, names.scripts);
  const srcServices = path.win32.join(telnetRootWin, "Services");
  const srcExperts = path.win32.join(telnetRootWin, "Experts");
  const srcScripts = path.win32.join(telnetRootWin, "Scripts");

  if (dryRun) {
    log.push(`dry-run junctions:`);
    log.push(`  ${targetServices} -> ${srcServices}`);
    log.push(`  ${targetExperts} -> ${srcExperts}`);
    log.push(`  ${targetScripts} -> ${srcScripts}`);
    return;
  }

  const ps = [
    "$ErrorActionPreference='Stop'",
    `$mql='${psEscape(mql5Root)}'`,
    "$svc=Join-Path $mql 'Services'",
    "$exp=Join-Path $mql 'Experts'",
    "$scr=Join-Path $mql 'Scripts'",
    "New-Item -ItemType Directory -Force -Path $svc,$exp,$scr | Out-Null",
    `$t1='${psEscape(targetServices)}'`,
    `$t2='${psEscape(targetExperts)}'`,
    `$t3='${psEscape(targetScripts)}'`,
    "if (Test-Path $t1) { Remove-Item -Force -Recurse $t1 }",
    "if (Test-Path $t2) { Remove-Item -Force -Recurse $t2 }",
    "if (Test-Path $t3) { Remove-Item -Force -Recurse $t3 }",
    `New-Item -ItemType Junction -Path $t1 -Target '${psEscape(srcServices)}' | Out-Null`,
    `New-Item -ItemType Junction -Path $t2 -Target '${psEscape(srcExperts)}' | Out-Null`,
    `New-Item -ItemType Junction -Path $t3 -Target '${psEscape(srcScripts)}' | Out-Null`
  ].join("; ");

  const res = runPowerShell(ps);
  if (!res.ok) {
    throw new Error(`falha ao criar junctions: ${res.out || "erro desconhecido"}`);
  }
  log.push("junctions criadas para Services/Experts/Scripts");
}

function normalizeMirrorDirs(raw?: string[]): string[] {
  if (!raw || raw.length === 0) {
    return [
      "Indicators",
      "Experts",
      "Include",
      "Libraries",
      "Files",
      "Profiles",
      "Presets",
      "Services",
      "Scripts"
    ];
  }
  const out = raw
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => d.replace(/[\\/]+$/, ""));
  return Array.from(new Set(out));
}

function ensureMql5Mirror(
  dataPathWin: string,
  mirrorFromWin: string,
  dirs: string[],
  dryRun: boolean,
  log: string[]
) {
  const targetRoot = path.win32.join(dataPathWin, "MQL5");
  const sourceRoot = path.win32.join(mirrorFromWin, "MQL5");
  const entries = dirs.map((dir) => ({
    dir,
    target: path.win32.join(targetRoot, dir),
    source: path.win32.join(sourceRoot, dir)
  }));

  if (dryRun) {
    log.push("dry-run mirror MQL5:");
    for (const e of entries) log.push(`  ${e.target} -> ${e.source}`);
    return;
  }

  const ps = [
    "$ErrorActionPreference='Stop'",
    `New-Item -ItemType Directory -Force -Path '${psEscape(targetRoot)}' | Out-Null`
  ];
  for (const e of entries) {
    ps.push(`if (Test-Path '${psEscape(e.target)}') { Remove-Item -Force -Recurse '${psEscape(e.target)}' }`);
    ps.push(`New-Item -ItemType Junction -Path '${psEscape(e.target)}' -Target '${psEscape(e.source)}' | Out-Null`);
  }
  const res = runPowerShell(ps.join("; "));
  if (!res.ok) {
    throw new Error(`falha ao criar mirror MQL5: ${res.out || "erro desconhecido"}`);
  }
  log.push(`mirror MQL5 criado (${dirs.length} dirs)`);
}

export function runDoctor(spec: InstallSpec, cwd = process.cwd()): string {
  const log: string[] = [];
  const dataPathRaw = normalizeDataPath(spec.dataPath);
  if (!dataPathRaw) {
    statusLine("FAIL", "MT5 dataPath nao informado.", log);
    statusLine("FAIL", "Use: doctor <MT5_DATA> ou configure runner.dataPath.", log);
    return log.join("\n");
  }
  const dataPathWsl = isWsl() && /^[A-Za-z]:/.test(dataPathRaw) ? toWslPath(dataPathRaw) : dataPathRaw;
  const dataPathWin = toWinPath(dataPathWsl);
  statusLine("OK", `dataPath=${dataPathWin}`, log);

  const mql5Root = path.join(dataPathWsl, "MQL5");
  statusLine(checkPathExists(mql5Root) ? "OK" : "FAIL", `MQL5=${toWinPath(mql5Root)}`, log);

  const originPath = path.join(dataPathWsl, "origin.txt");
  if (!checkPathExists(originPath)) {
    statusLine("WARN", "origin.txt nao encontrado (nao foi possivel validar instalacao).", log);
  } else {
    const origin = readTextWithEncoding(originPath).text.trim();
    statusLine("OK", `origin.txt=${origin || "(vazio)"}`, log);
    const paths = deriveTerminalPaths(dataPathWsl);
    if (paths.terminalPath) {
      statusLine("OK", `terminalPath=${paths.terminalPath}`, log);
    } else {
      statusLine("FAIL", "terminalPath nao encontrado a partir do origin.txt.", log);
    }
    if (paths.metaeditorPath) {
      statusLine("OK", `metaeditorPath=${paths.metaeditorPath}`, log);
    } else {
      statusLine("WARN", "MetaEditor nao encontrado a partir do origin.txt.", log);
    }
  }

  const commonPath = path.join(dataPathWsl, "config", "common.ini");
  if (checkPathExists(commonPath)) {
    const { text } = readTextWithEncoding(commonPath);
    const dllVal = getIniValue(text, "Experts", "AllowDllImport");
    const liveVal = getIniValue(text, "Experts", "AllowLiveTrading");
    statusLine("OK", `common.ini AllowDllImport=${formatBool(dllVal)} AllowLiveTrading=${formatBool(liveVal)}`, log);
  } else {
    statusLine("WARN", `common.ini nao encontrado: ${toWinPath(commonPath)}`, log);
  }

  const terminalIni = path.join(dataPathWsl, "config", "terminal.ini");
  if (checkPathExists(terminalIni)) {
    statusLine("OK", `terminal.ini=${toWinPath(terminalIni)}`, log);
  } else {
    statusLine("WARN", `terminal.ini nao encontrado: ${toWinPath(terminalIni)}`, log);
  }

  const repoInput = spec.repoPath
    ? (isWindowsPath(spec.repoPath) ? toWslPath(spec.repoPath) : spec.repoPath)
    : undefined;
  let repoRoot = repoInput ? path.resolve(repoInput) : findTelnetMtRoot(cwd) ?? "";
  if (repoRoot) {
    const svcNested = path.join(repoRoot, "Services", "telnetmt", "Services");
    const svcNestedLower = path.join(repoRoot, "services", "telnetmt", "Services");
    if (fs.existsSync(svcNested)) {
      repoRoot = path.join(repoRoot, "Services", "telnetmt");
    } else if (fs.existsSync(svcNestedLower)) {
      repoRoot = path.join(repoRoot, "services", "telnetmt");
    } else if (!fs.existsSync(path.join(repoRoot, "Services"))) {
      const nested = findTelnetMtRoot(repoRoot);
      if (nested) repoRoot = nested;
    }
  }
  if (!repoRoot) {
    statusLine("WARN", "telnetmt repo nao encontrado (sem junctions).", log);
  } else {
    const telnetRootWin = toWinPath(repoRoot);
    statusLine("OK", `telnetmt=${telnetRootWin}`, log);
    const toolsPath = path.join(repoRoot, "tools", "mt5-compile.exe");
    if (checkPathExists(toWslPath(toolsPath))) {
      statusLine("OK", `compile tool=mt5-compile (${toWinPath(toolsPath)})`, log);
    } else {
      statusLine("WARN", "compile tool mt5-compile.exe nao encontrado no repo.", log);
    }
    const name = (spec.name || "").trim();
    const prefixRaw = (spec.namePrefix ?? "").trim();
    const defaultPrefix = "TelnetMT_";
    const prefix = prefixRaw || defaultPrefix;
    const names = name
      ? { services: name, experts: name, scripts: name }
      : { services: `${prefix}Services`, experts: `${prefix}Experts`, scripts: `${prefix}Scripts` };
    const svcTarget = path.join(mql5Root, "Services", names.services);
    const expTarget = path.join(mql5Root, "Experts", names.experts);
    const scrTarget = path.join(mql5Root, "Scripts", names.scripts);
    const checkTarget = (label: string, target: string) => {
      if (!checkPathExists(target)) {
        statusLine("FAIL", `${label} junction ausente: ${toWinPath(target)}`, log);
        return;
      }
      if (isSymlink(target)) {
        statusLine("OK", `${label} junction OK: ${toWinPath(target)}`, log);
      } else {
        statusLine("WARN", `${label} existe mas nao parece junction: ${toWinPath(target)}`, log);
      }
    };
    checkTarget("Services", svcTarget);
    checkTarget("Experts", expTarget);
    checkTarget("Scripts", scrTarget);
  }

  if (spec.mirrorFrom) {
    const mirrorFromRaw = normalizeDataPath(spec.mirrorFrom);
    const mirrorFromWsl = mirrorFromRaw
      ? isWsl() && /^[A-Za-z]:/.test(mirrorFromRaw)
        ? toWslPath(mirrorFromRaw)
        : mirrorFromRaw
      : "";
    const mirrorFromWin = mirrorFromWsl ? toWinPath(mirrorFromWsl) : "";
    if (!mirrorFromWin) {
      statusLine("WARN", "mirror-from invalido.", log);
    } else {
      statusLine("OK", `mirror-from=${mirrorFromWin}`, log);
      const dirs = normalizeMirrorDirs(spec.mirrorDirs);
      for (const dir of dirs) {
        const target = path.join(mql5Root, dir);
        if (!checkPathExists(target)) {
          statusLine("FAIL", `mirror ${dir} ausente: ${toWinPath(target)}`, log);
        } else if (isSymlink(target)) {
          statusLine("OK", `mirror ${dir} junction OK`, log);
        } else {
          statusLine("WARN", `mirror ${dir} existe mas nao parece junction`, log);
        }
      }
    }
  }

  const cmdmtRoot = repoRoot ? path.join(repoRoot, "cmdmt") : "";
  if (cmdmtRoot) {
    const repoCfgPath = path.join(cmdmtRoot, "cmdmt.config.json");
    statusLine(checkPathExists(repoCfgPath) ? "OK" : "WARN", `repo config=${toWinPath(repoCfgPath)}`, log);
  }
  const globalCfgPath = path.join(os.homedir(), ".cmdmt", "config.json");
  statusLine(checkPathExists(globalCfgPath) ? "OK" : "WARN", `global config=${globalCfgPath}`, log);

  return log.join("\n");
}

export function runInstall(spec: InstallSpec, cwd = process.cwd()): string {
  const log: string[] = [];
  const dataPathRaw = normalizeDataPath(spec.dataPath);
  if (!dataPathRaw) throw new Error("mt5 data path ausente. Use: cmdmt install <MT5_DATA>");
  const dataPathWsl = isWsl() && /^[A-Za-z]:/.test(dataPathRaw) ? toWslPath(dataPathRaw) : dataPathRaw;
  const dataPathWin = toWinPath(dataPathWsl);

  const repoInput = spec.repoPath
    ? (isWindowsPath(spec.repoPath) ? toWslPath(spec.repoPath) : spec.repoPath)
    : undefined;
  let repoRoot = repoInput ? path.resolve(repoInput) : findTelnetMtRoot(cwd) ?? "";
  if (repoRoot) {
    const svcNested = path.join(repoRoot, "Services", "telnetmt", "Services");
    const svcNestedLower = path.join(repoRoot, "services", "telnetmt", "Services");
    if (fs.existsSync(svcNested)) {
      repoRoot = path.join(repoRoot, "Services", "telnetmt");
    } else if (fs.existsSync(svcNestedLower)) {
      repoRoot = path.join(repoRoot, "services", "telnetmt");
    } else if (!fs.existsSync(path.join(repoRoot, "Services"))) {
      const nested = findTelnetMtRoot(repoRoot);
      if (nested) repoRoot = nested;
    }
  }
  if (!repoRoot) {
    throw new Error("nao encontrei services/telnetmt. Use --repo <path>.");
  }
  const telnetRootWin = toWinPath(repoRoot);
  const cmdmtRoot = path.join(repoRoot, "cmdmt");
  const name = (spec.name || "").trim();
  const prefixRaw = (spec.namePrefix ?? "").trim();
  const defaultPrefix = "TelnetMT_";
  const prefix = prefixRaw || defaultPrefix;
  const names = name
    ? { services: name, experts: name, scripts: name }
    : { services: `${prefix}Services`, experts: `${prefix}Experts`, scripts: `${prefix}Scripts` };

  log.push(`mt5 data: ${dataPathWin}`);
  log.push(`telnetmt: ${telnetRootWin}`);
  log.push(`junction services: ${names.services}`);
  log.push(`junction experts: ${names.experts}`);
  log.push(`junction scripts: ${names.scripts}`);

  ensureJunctions(dataPathWin, telnetRootWin, names, spec.dryRun, log);
  if (!spec.dryRun) ensureIniAllows(dataPathWsl, spec, log);

  if (spec.mirrorFrom) {
    const mirrorFromRaw = normalizeDataPath(spec.mirrorFrom);
    if (!mirrorFromRaw) {
      throw new Error("mirror-from invalido.");
    }
    const mirrorFromWsl = isWsl() && /^[A-Za-z]:/.test(mirrorFromRaw) ? toWslPath(mirrorFromRaw) : mirrorFromRaw;
    const mirrorFromWin = toWinPath(mirrorFromWsl);
    const dirs = normalizeMirrorDirs(spec.mirrorDirs);
    log.push(`mirror-from: ${mirrorFromWin}`);
    log.push(`mirror-dirs: ${dirs.join(", ")}`);
    ensureMql5Mirror(dataPathWin, mirrorFromWin, dirs, spec.dryRun, log);
  }

  if (spec.web.length) {
    log.push(`webrequest allowlist: ${spec.web.join(", ")}`);
  }
  if (!spec.dryRun) {
    const runnerId = name || "default";
    const runnerPaths = deriveTerminalPaths(dataPathWsl);
    const repoCfgPath = path.join(cmdmtRoot, "cmdmt.config.json");
    const repoCfg = readJsonFile(repoCfgPath);
    const globalCfgPath = path.join(os.homedir(), ".cmdmt", "config.json");
    updateConfigFromInstall(globalCfgPath, repoCfg, runnerId, { ...runnerPaths, dataPath: dataPathWin }, cmdmtRoot);
    updateConfigFromInstall(repoCfgPath, repoCfg, runnerId, { ...runnerPaths, dataPath: dataPathWin }, cmdmtRoot);
    log.push(`config atualizado: ${globalCfgPath}`);
    log.push(`config atualizado: ${repoCfgPath}`);
  }
  if (spec.dryRun) log.push("dry-run: nenhuma alteracao aplicada");
  return log.join("\n");
}
