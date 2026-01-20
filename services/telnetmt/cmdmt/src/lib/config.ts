import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readTextWithEncoding } from "./textfile.js";

export type TransportConfig = {
  host?: string;
  hosts?: string[] | string;
  port?: number | string;
  timeoutMs?: number | string;
};

export type ContextConfig = {
  symbol?: string;
  tf?: string;
  sub?: number | string;
};

export type TesterConfig = {
  artifactsDir?: string;
  reportDir?: string;
  allowOpen?: boolean;
  login?: string | number;
  password?: string;
  server?: string;
  syncCommon?: boolean;
  maxBars?: number | string;
  maxBarsInChart?: number | string;
  model?: number | string;
  executionMode?: number | string;
  optimization?: number | string;
  useLocal?: number | string;
  useRemote?: number | string;
  useCloud?: number | string;
  visual?: number | string;
  replaceReport?: number | string;
  shutdownTerminal?: number | string;
  deposit?: number | string;
  leverage?: string;
  currency?: string;
  fromDate?: string;
  toDate?: string;
  forwardMode?: number | string;
  forwardDate?: string;
  windowLeft?: number | string;
  windowTop?: number | string;
  windowRight?: number | string;
  windowBottom?: number | string;
  windowWidth?: number | string;
  windowHeight?: number | string;
  windowFullscreen?: number | string;
};

export type RunnerConfig = {
  terminalPath?: string;
  dataPath?: string;
  metaeditorPath?: string;
  workspacePath?: string;
  portable?: boolean;
};

export type ConfigLayer = {
  envPath?: string;
  transport?: TransportConfig;
  testerTransport?: TransportConfig;
  context?: ContextConfig;
  runner?: string;
  testerRunner?: string;
  baseTpl?: string;
  compilePath?: string;
  repoPath?: string;
  repoAutoBuild?: boolean;
  tester?: TesterConfig;
};

export type ConfigFile = ConfigLayer & {
  defaults?: ConfigLayer;
  profiles?: Record<string, ConfigLayer>;
  runners?: Record<string, RunnerConfig>;
  profile?: string;
};

export type CliOptions = {
  configPath?: string;
  profile?: string;
  runner?: string;
  testRunner?: string;
  testHost?: string;
  testHosts?: string;
  testPort?: number;
  testTimeoutMs?: number;
  host?: string;
  hosts?: string;
  port?: number;
  timeoutMs?: number;
  symbol?: string;
  tf?: string;
  sub?: number;
  baseTpl?: string;
  compilePath?: string;
  repoPath?: string;
  mt5Path?: string;
  mt5Data?: string;
};

export type ResolvedConfig = {
  configPath: string;
  profile?: string;
  transport: { hosts: string[]; port: number; timeoutMs: number };
  testerTransport?: { hosts: string[]; port: number; timeoutMs: number };
  context: { symbol?: string; tf?: string; sub?: number };
  baseTpl?: string;
  compilePath?: string;
  repoPath?: string;
  repoAutoBuild?: boolean;
  runnerId?: string;
  runner?: RunnerConfig;
  testerRunnerId?: string;
  testerRunner?: RunnerConfig;
  tester: Required<Pick<TesterConfig, "artifactsDir" | "reportDir">> & TesterConfig;
};

const DEFAULT_PORT = 9090;
const DEFAULT_TIMEOUT = 3000;
const DEFAULT_HOSTS = ["host.docker.internal", "127.0.0.1"];
const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".cmdmt", "config.json");
const LOCAL_CONFIG_FILENAME = "cmdmt.config.json";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOCAL_CONFIG_PATHS = [
  path.join(process.cwd(), LOCAL_CONFIG_FILENAME),
  path.resolve(__dirname, "..", "..", LOCAL_CONFIG_FILENAME)
];
const DEFAULT_TESTER: Required<Pick<TesterConfig, "artifactsDir" | "reportDir">> & TesterConfig = {
  artifactsDir: "cmdmt-artifacts",
  reportDir: "reports",
  allowOpen: false,
  model: 0,
  executionMode: 0,
  optimization: 0,
  useLocal: 1,
  useRemote: 0,
  useCloud: 0,
  visual: 0,
  replaceReport: 1,
  shutdownTerminal: 1
};

function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  for (let raw of lines) {
    let line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice(7).trim();
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if ((val.startsWith("\"") && val.endsWith("\"")) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
      val = val.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t");
    }
    if (key) out[key] = val;
  }
  return out;
}

function applyEnv(
  base: Record<string, string | undefined>,
  extra: Record<string, string>,
  opts: { override?: boolean; locked?: Set<string> } = {}
): Record<string, string | undefined> {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra)) {
    if (opts.locked?.has(k)) continue;
    if (!opts.override && out[k] !== undefined) continue;
    out[k] = v;
  }
  return out;
}

function loadDotEnvFile(filePath: string): Record<string, string> {
  try {
    if (!fs.existsSync(filePath)) return {};
    const text = fs.readFileSync(filePath, "utf8");
    return parseDotEnv(text);
  } catch {
    return {};
  }
}

function collectEnv(
  cliPath?: string,
  env = process.env,
  opts: { profile?: string; runner?: string } = {}
): Record<string, string | undefined> {
  const locked = new Set(Object.keys(env));
  let merged: Record<string, string | undefined> = { ...env };
  const baseCandidates: string[] = [];
  const fromEnv = env.CMDMT_ENV?.trim();
  if (fromEnv) {
    baseCandidates.push(expandHome(fromEnv));
  } else {
    baseCandidates.push(path.join(process.cwd(), ".env"));
    baseCandidates.push(path.join(os.homedir(), ".cmdmt", ".env"));
  }
  if (cliPath) {
    baseCandidates.push(path.join(path.dirname(cliPath), ".env"));
  }

  for (const p of baseCandidates) {
    merged = applyEnv(merged, loadDotEnvFile(p), { override: false, locked });
  }

  const overrideCandidates: string[] = [];
  const suffixes = [opts.profile, opts.runner].filter(Boolean) as string[];
  for (const suffix of suffixes) {
    for (const base of baseCandidates) {
      overrideCandidates.push(`${base}.${suffix}`);
    }
  }
  for (const p of overrideCandidates) {
    merged = applyEnv(merged, loadDotEnvFile(p), { override: true, locked });
  }
  return merged;
}

function expandHome(p: string): string {
  if (p.startsWith("~")) return path.join(os.homedir(), p.slice(1));
  return p;
}

export function isWindowsPath(p: string): boolean {
  return /^[A-Za-z]:\\/.test(p) || /^\\\\/.test(p);
}

export function isWsl(): boolean {
  return Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
}

export function toWslPath(p: string): string {
  if (!p) return p;
  if (!isWsl()) return p;
  if (!isWindowsPath(p)) return p;
  const match = /^([A-Za-z]):\\(.*)$/.exec(p);
  if (match) {
    const drive = match[1].toLowerCase();
    const rest = match[2].replace(/\\/g, "/");
    return `/mnt/${drive}/${rest}`;
  }
  try {
    return execFileSync("wslpath", ["-u", p], { encoding: "utf8" }).trim();
  } catch {
    return p;
  }
}

export function toWindowsPath(p: string): string {
  if (!p) return p;
  if (isWindowsPath(p)) return p;
  if (!isWsl()) return p;
  if (p.startsWith("/mnt/")) {
    const drive = p.slice(5, 6).toUpperCase();
    const rest = p.slice(7).replace(/\//g, "\\");
    return `${drive}:\\${rest}`;
  }
  try {
    return execFileSync("wslpath", ["-w", p], { encoding: "utf8" }).trim();
  } catch {
    return p;
  }
}

function normalizePath(p?: string): string | undefined {
  if (!p) return undefined;
  const expanded = expandHome(p);
  if (isWindowsPath(expanded)) return expanded;
  return path.resolve(expanded);
}

function coerceNumber(value?: number | string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function coerceBool(value?: string | number | boolean): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const v = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(v)) return true;
  if (["0", "false", "no", "n", "off"].includes(v)) return false;
  return undefined;
}

function parseHostsValue(value?: string | string[]): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((h) => h.trim()).filter(Boolean);
  return value
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
}

function detectWslNameserver(): string[] {
  if (!isWsl()) return [];
  try {
    const text = fs.readFileSync("/etc/resolv.conf", "utf8");
    const match = text.match(/^nameserver\s+([0-9.]+)/m);
    if (match?.[1]) return [match[1]];
  } catch {
    // ignore
  }
  return [];
}

function defaultHosts(): string[] {
  const out: string[] = [];
  if (isWsl()) {
    out.push(...detectWslNameserver());
    out.push("192.168.64.1");
  }
  out.push(...DEFAULT_HOSTS);
  return Array.from(new Set(out.filter(Boolean)));
}

function pickConfigLayer(file: ConfigFile): ConfigLayer {
  const { defaults, profiles, runners, profile, ...rest } = file;
  return rest;
}

function mergeLayer(base: ConfigLayer, overlay: ConfigLayer): ConfigLayer {
  const mergeDefined = <T extends Record<string, unknown>>(src: T, extra?: Partial<T>): T => {
    const out = { ...src };
    if (!extra) return out;
    for (const [key, value] of Object.entries(extra)) {
      if (value !== undefined) (out as Record<string, unknown>)[key] = value;
    }
    return out;
  };

  return {
    transport: mergeDefined(base.transport ?? {}, overlay.transport),
    testerTransport: mergeDefined(base.testerTransport ?? {}, overlay.testerTransport),
    context: mergeDefined(base.context ?? {}, overlay.context),
    runner: overlay.runner ?? base.runner,
    testerRunner: overlay.testerRunner ?? base.testerRunner,
    baseTpl: overlay.baseTpl ?? base.baseTpl,
    compilePath: overlay.compilePath ?? base.compilePath,
    repoPath: overlay.repoPath ?? base.repoPath,
    repoAutoBuild: overlay.repoAutoBuild ?? base.repoAutoBuild,
    tester: mergeDefined(base.tester ?? {}, overlay.tester)
  };
}

function resolveHosts(layers: ConfigLayer[]): string[] {
  for (const layer of layers) {
    const transport = layer.transport;
    if (!transport) continue;
    const hosts = parseHostsValue(transport.hosts);
    if (hosts.length) return hosts;
    const host = transport.host?.trim();
    if (host) return [host];
  }
  return defaultHosts();
}

function normalizeTester(cfg?: TesterConfig): Required<Pick<TesterConfig, "artifactsDir" | "reportDir">> & TesterConfig {
  const merged = { ...DEFAULT_TESTER, ...(cfg ?? {}) };
  return {
    ...merged,
    maxBars: coerceNumber(merged.maxBars),
    maxBarsInChart: coerceNumber(merged.maxBarsInChart),
    model: coerceNumber(merged.model),
    executionMode: coerceNumber(merged.executionMode),
    optimization: coerceNumber(merged.optimization),
    useLocal: coerceNumber(merged.useLocal),
    useRemote: coerceNumber(merged.useRemote),
    useCloud: coerceNumber(merged.useCloud),
    visual: coerceNumber(merged.visual),
    replaceReport: coerceNumber(merged.replaceReport),
    shutdownTerminal: coerceNumber(merged.shutdownTerminal),
    deposit: coerceNumber(merged.deposit),
    forwardMode: coerceNumber(merged.forwardMode),
    windowLeft: coerceNumber(merged.windowLeft),
    windowTop: coerceNumber(merged.windowTop),
    windowRight: coerceNumber(merged.windowRight),
    windowBottom: coerceNumber(merged.windowBottom),
    windowWidth: coerceNumber(merged.windowWidth),
    windowHeight: coerceNumber(merged.windowHeight),
    windowFullscreen: coerceNumber(merged.windowFullscreen)
  };
}

function normalizeContext(cfg?: ContextConfig): { symbol?: string; tf?: string; sub?: number } {
  const symbol = cfg?.symbol?.trim() || undefined;
  const tf = cfg?.tf?.trim() || undefined;
  const sub = coerceNumber(cfg?.sub);
  return { symbol, tf, sub };
}

function normalizeRunner(cfg?: RunnerConfig): RunnerConfig | undefined {
  if (!cfg) return undefined;
  return {
    ...cfg,
    terminalPath: normalizePath(cfg.terminalPath),
    dataPath: normalizePath(cfg.dataPath),
    metaeditorPath: normalizePath(cfg.metaeditorPath),
    workspacePath: normalizePath(cfg.workspacePath)
  };
}

function listWinTerminalRootsFromEnv(env: NodeJS.ProcessEnv): string[] {
  const roots: string[] = [];
  const appdata = env.APPDATA || env.AppData;
  if (appdata) roots.push(path.win32.join(appdata, "MetaQuotes", "Terminal"));
  const userProfile = env.USERPROFILE || env.UserProfile;
  if (userProfile) roots.push(path.win32.join(userProfile, "AppData", "Roaming", "MetaQuotes", "Terminal"));
  return roots;
}

function listWinTerminalRootsFallback(terminalPath: string): string[] {
  if (!isWindowsPath(terminalPath) || !isWsl()) return [];
  const drive = terminalPath.slice(0, 1).toLowerCase();
  const usersRoot = `/mnt/${drive}/Users`;
  if (!fs.existsSync(usersRoot)) return [];
  const roots: string[] = [];
  for (const entry of fs.readdirSync(usersRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(usersRoot, entry.name, "AppData", "Roaming", "MetaQuotes", "Terminal");
    if (fs.existsSync(candidate)) {
      roots.push(toWindowsPath(candidate));
    }
  }
  return roots;
}

function resolveDataPathFromOrigin(terminalPath: string): string | undefined {
  const winTerminal = isWindowsPath(terminalPath) ? terminalPath : toWindowsPath(terminalPath);
  if (!isWindowsPath(winTerminal)) return undefined;
  const installDir = path.win32.dirname(winTerminal).toLowerCase();
  const roots = [
    ...listWinTerminalRootsFromEnv(process.env),
    ...listWinTerminalRootsFallback(winTerminal)
  ];
  for (const rootWin of roots) {
    const root = toWslPath(rootWin);
    if (!fs.existsSync(root)) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const origin = path.join(root, entry.name, "origin.txt");
      if (!fs.existsSync(origin)) continue;
      let content = "";
      try {
        content = readTextWithEncoding(origin).text.trim().toLowerCase();
      } catch {
        continue;
      }
      if (content && content.includes(installDir)) {
        return toWindowsPath(path.join(root, entry.name));
      }
    }
  }
  return undefined;
}

function resolveRunnerDataPath(runner: RunnerConfig): string | undefined {
  if (runner.dataPath) return runner.dataPath;
  if (!runner.terminalPath) return undefined;
  const tp = runner.terminalPath;
  if (runner.portable) {
    if (isWindowsPath(tp)) return path.win32.dirname(tp);
    return path.dirname(tp);
  }
  return resolveDataPathFromOrigin(tp);
}

function loadConfigFile(filePath: string, required: boolean): ConfigFile {
  if (!fs.existsSync(filePath)) {
    if (required) throw new Error(`config nao encontrado: ${filePath}`);
    return {};
  }
  const raw = fs.readFileSync(filePath, "utf8");
  try {
    return JSON.parse(raw) as ConfigFile;
  } catch (err) {
    throw new Error(`config invalido em ${filePath}: ${(err as Error).message}`);
  }
}

export function resolveConfigPath(cliPath?: string, env = process.env): string {
  const p = cliPath ?? env.CMDMT_CONFIG;
  if (!p) {
    for (const candidate of LOCAL_CONFIG_PATHS) {
      try {
        if (fs.existsSync(candidate)) return normalizePath(candidate) ?? candidate;
      } catch {
        // ignore
      }
    }
  }
  const fallback = p ?? DEFAULT_CONFIG_PATH;
  return normalizePath(fallback) ?? fallback;
}

export function resolveConfig(cli: CliOptions, env = process.env): ResolvedConfig {
  const envPre = collectEnv(cli.configPath, env);
  const configPath = resolveConfigPath(cli.configPath, envPre);
  const configFile = loadConfigFile(configPath, Boolean(cli.configPath || envPre.CMDMT_CONFIG));
  const envOverride =
    configFile.envPath && !env.CMDMT_ENV ? { ...env, CMDMT_ENV: configFile.envPath } : env;
  const envBase = collectEnv(configPath, envOverride);

  const profile = cli.profile ?? envBase.CMDMT_PROFILE ?? configFile.profile;
  const profileLayer = profile ? configFile.profiles?.[profile] : undefined;
  if (profile && !profileLayer) {
    throw new Error(`perfil nao encontrado: ${profile}`);
  }

  const runnerHint = cli.runner ?? envBase.CMDMT_RUNNER ?? profileLayer?.runner ?? configFile.runner;
  const envMerged = collectEnv(cli.configPath, env, { profile, runner: runnerHint });

  const defaultsLayer = configFile.defaults ?? {};
  const configLayer = pickConfigLayer(configFile);
  const envLayer: ConfigLayer = {
    transport: {
      host: envMerged.CMDMT_HOST,
      hosts: envMerged.CMDMT_HOSTS,
      port: envMerged.CMDMT_PORT,
      timeoutMs: envMerged.CMDMT_TIMEOUT
    },
    testerTransport: {
      host: envMerged.CMDMT_TEST_HOST,
      hosts: envMerged.CMDMT_TEST_HOSTS,
      port: envMerged.CMDMT_TEST_PORT,
      timeoutMs: envMerged.CMDMT_TEST_TIMEOUT
    },
    context: {
      symbol: envMerged.CMDMT_SYMBOL,
      tf: envMerged.CMDMT_TF,
      sub: envMerged.CMDMT_SUB
    },
    runner: envMerged.CMDMT_RUNNER,
    testerRunner: envMerged.CMDMT_TEST_RUNNER,
    baseTpl: envMerged.CMDMT_BASE_TPL,
    compilePath: envMerged.CMDMT_COMPILE,
    repoPath: envMerged.CMDMT_REPO,
    repoAutoBuild: envMerged.CMDMT_REPO_AUTOBUILD === undefined ? undefined : envMerged.CMDMT_REPO_AUTOBUILD !== "0",
    tester: {
      login: envMerged.CMDMT_LOGIN ?? envMerged.MT5_LOGIN,
      password: envMerged.CMDMT_PASSWORD ?? envMerged.MT5_PASSWORD,
      server: envMerged.CMDMT_SERVER ?? envMerged.MT5_SERVER,
      syncCommon: coerceBool(envMerged.CMDMT_SYNC_COMMON),
      maxBars: envMerged.CMDMT_MAXBARS,
      maxBarsInChart: envMerged.CMDMT_MAXBARS_CHART
    }
  };
  const cliLayer: ConfigLayer = {
    transport: {
      host: cli.host,
      hosts: cli.hosts,
      port: cli.port,
      timeoutMs: cli.timeoutMs
    },
    testerTransport: {
      host: cli.testHost,
      hosts: cli.testHosts,
      port: cli.testPort,
      timeoutMs: cli.testTimeoutMs
    },
    context: {
      symbol: cli.symbol,
      tf: cli.tf,
      sub: cli.sub
    },
    runner: cli.runner,
    testerRunner: cli.testRunner,
    baseTpl: cli.baseTpl,
    compilePath: cli.compilePath,
    repoPath: cli.repoPath
  };

  const merged = [defaultsLayer, profileLayer ?? {}, configLayer, envLayer, cliLayer].reduce(
    (acc, layer) => mergeLayer(acc, layer),
    {} as ConfigLayer
  );

  const hosts = resolveHosts([cliLayer, envLayer, configLayer, profileLayer ?? {}, defaultsLayer]);
  const port = coerceNumber(merged.transport?.port) ?? DEFAULT_PORT;
  const timeoutMs = coerceNumber(merged.transport?.timeoutMs) ?? DEFAULT_TIMEOUT;

  const testHosts = (() => {
    const t = merged.testerTransport;
    if (!t) return undefined;
    const list = parseHostsValue(t.hosts);
    if (list.length) return list;
    const host = t.host?.trim();
    return host ? [host] : undefined;
  })();
  const testPort = coerceNumber(merged.testerTransport?.port);
  const testTimeout = coerceNumber(merged.testerTransport?.timeoutMs);
  const hasTestTransport =
    (testHosts && testHosts.length > 0) ||
    testPort !== undefined ||
    testTimeout !== undefined;
  const testerTransport = hasTestTransport
    ? {
        hosts: testHosts && testHosts.length ? testHosts : hosts,
        port: testPort ?? port,
        timeoutMs: testTimeout ?? timeoutMs
      }
    : undefined;

  const runnerId = merged.runner;
  const testerRunnerId = merged.testerRunner;
  const runnerBase = runnerId ? configFile.runners?.[runnerId] : undefined;
  const testerRunnerBase = testerRunnerId ? configFile.runners?.[testerRunnerId] : undefined;
  const runnerOverride: RunnerConfig = {
    terminalPath: cli.mt5Path ?? envMerged.CMDMT_MT5_PATH,
    dataPath: cli.mt5Data ?? envMerged.CMDMT_MT5_DATA
  };
  const runner = normalizeRunner({
    ...(runnerBase ?? {}),
    ...runnerOverride,
    dataPath: runnerOverride.dataPath ?? runnerBase?.dataPath,
    terminalPath: runnerOverride.terminalPath ?? runnerBase?.terminalPath,
    metaeditorPath: runnerBase?.metaeditorPath,
    workspacePath: runnerBase?.workspacePath,
    portable: runnerBase?.portable
  });
  const testerRunner = normalizeRunner({
    ...(testerRunnerBase ?? {})
  });

  const context = normalizeContext(merged.context);
  const tester = normalizeTester(merged.tester);

  return {
    configPath,
    profile,
    transport: { hosts, port, timeoutMs },
    testerTransport,
    context,
    baseTpl: merged.baseTpl,
    compilePath: merged.compilePath,
    repoPath: merged.repoPath,
    repoAutoBuild: merged.repoAutoBuild,
    runnerId,
    runner,
    testerRunnerId,
    testerRunner,
    tester
  };
}

export function requireTransport(config: ResolvedConfig): { hosts: string[]; port: number; timeoutMs: number } {
  if (!config.transport.hosts || config.transport.hosts.length === 0) {
    throw new Error(
      "host nao configurado. Use --host/--hosts, CMDMT_HOST(S) ou transport.host(s) no config."
    );
  }
  return config.transport;
}

export function requireTestTransport(config: ResolvedConfig): { hosts: string[]; port: number; timeoutMs: number } {
  if (config.testerTransport) return config.testerTransport;
  return requireTransport(config);
}

function requireRunnerBase(runner: RunnerConfig | undefined, label: string): RunnerConfig {
  if (!runner) {
    throw new Error(
      `${label} nao configurado. Use --runner/CMDMT_RUNNER e defina runners.<id> no config.`
    );
  }
  const terminalPath = runner.terminalPath;
  const dataPath = resolveRunnerDataPath(runner);
  if (!terminalPath) {
    throw new Error(`${label} sem terminalPath. Defina runners.<id>.terminalPath ou CMDMT_MT5_PATH.`);
  }
  if (!dataPath) {
    throw new Error(`${label} sem dataPath. Defina runners.<id>.dataPath ou CMDMT_MT5_DATA.`);
  }
  return { ...runner, terminalPath, dataPath };
}

export function requireRunner(config: ResolvedConfig): RunnerConfig {
  return requireRunnerBase(config.runner, "runner");
}

export function requireTestRunner(config: ResolvedConfig): RunnerConfig {
  if (config.testerRunner) return requireRunnerBase(config.testerRunner, "runner de teste");
  return requireRunnerBase(config.runner, "runner");
}
