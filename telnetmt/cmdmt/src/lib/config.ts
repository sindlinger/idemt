import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

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
};

export type RunnerConfig = {
  terminalPath?: string;
  dataPath?: string;
  metaeditorPath?: string;
  workspacePath?: string;
  portable?: boolean;
};

export type ConfigLayer = {
  transport?: TransportConfig;
  context?: ContextConfig;
  runner?: string;
  baseTpl?: string;
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
  host?: string;
  hosts?: string;
  port?: number;
  timeoutMs?: number;
  symbol?: string;
  tf?: string;
  sub?: number;
  baseTpl?: string;
  mt5Path?: string;
  mt5Data?: string;
};

export type ResolvedConfig = {
  configPath: string;
  profile?: string;
  transport: { hosts: string[]; port: number; timeoutMs: number };
  context: { symbol?: string; tf?: string; sub?: number };
  baseTpl?: string;
  runnerId?: string;
  runner?: RunnerConfig;
  tester: Required<Pick<TesterConfig, "artifactsDir" | "reportDir">> & TesterConfig;
};

const DEFAULT_PORT = 9090;
const DEFAULT_TIMEOUT = 3000;
const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".cmdmt", "config.json");
const DEFAULT_TESTER: Required<Pick<TesterConfig, "artifactsDir" | "reportDir">> & TesterConfig = {
  artifactsDir: "cmdmt-artifacts",
  reportDir: "reports",
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

function parseHostsValue(value?: string | string[]): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((h) => h.trim()).filter(Boolean);
  return value
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
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
    context: mergeDefined(base.context ?? {}, overlay.context),
    runner: overlay.runner ?? base.runner,
    baseTpl: overlay.baseTpl ?? base.baseTpl,
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
  return [];
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
    forwardMode: coerceNumber(merged.forwardMode)
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

function resolveRunnerDataPath(runner: RunnerConfig): string | undefined {
  if (runner.dataPath) return runner.dataPath;
  if (!runner.portable || !runner.terminalPath) return undefined;
  const tp = runner.terminalPath;
  if (isWindowsPath(tp)) return path.win32.dirname(tp);
  return path.dirname(tp);
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
  const p = cliPath ?? env.CMDMT_CONFIG ?? DEFAULT_CONFIG_PATH;
  return normalizePath(p) ?? p;
}

export function resolveConfig(cli: CliOptions, env = process.env): ResolvedConfig {
  const configPath = resolveConfigPath(cli.configPath, env);
  const configFile = loadConfigFile(configPath, Boolean(cli.configPath || env.CMDMT_CONFIG));

  const profile = cli.profile ?? env.CMDMT_PROFILE ?? configFile.profile;
  const profileLayer = profile ? configFile.profiles?.[profile] : undefined;
  if (profile && !profileLayer) {
    throw new Error(`perfil nao encontrado: ${profile}`);
  }

  const defaultsLayer = configFile.defaults ?? {};
  const configLayer = pickConfigLayer(configFile);
  const envLayer: ConfigLayer = {
    transport: {
      host: env.CMDMT_HOST,
      hosts: env.CMDMT_HOSTS,
      port: env.CMDMT_PORT,
      timeoutMs: env.CMDMT_TIMEOUT
    },
    context: {
      symbol: env.CMDMT_SYMBOL,
      tf: env.CMDMT_TF,
      sub: env.CMDMT_SUB
    },
    runner: env.CMDMT_RUNNER,
    baseTpl: env.CMDMT_BASE_TPL
  };
  const cliLayer: ConfigLayer = {
    transport: {
      host: cli.host,
      hosts: cli.hosts,
      port: cli.port,
      timeoutMs: cli.timeoutMs
    },
    context: {
      symbol: cli.symbol,
      tf: cli.tf,
      sub: cli.sub
    },
    runner: cli.runner,
    baseTpl: cli.baseTpl
  };

  const merged = [defaultsLayer, profileLayer ?? {}, configLayer, envLayer, cliLayer].reduce(
    (acc, layer) => mergeLayer(acc, layer),
    {} as ConfigLayer
  );

  const hosts = resolveHosts([cliLayer, envLayer, configLayer, profileLayer ?? {}, defaultsLayer]);
  const port = coerceNumber(merged.transport?.port) ?? DEFAULT_PORT;
  const timeoutMs = coerceNumber(merged.transport?.timeoutMs) ?? DEFAULT_TIMEOUT;

  const runnerId = merged.runner;
  const runnerBase = runnerId ? configFile.runners?.[runnerId] : undefined;
  const runnerOverride: RunnerConfig = {
    terminalPath: cli.mt5Path ?? env.CMDMT_MT5_PATH,
    dataPath: cli.mt5Data ?? env.CMDMT_MT5_DATA
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

  const context = normalizeContext(merged.context);
  const tester = normalizeTester(merged.tester);

  return {
    configPath,
    profile,
    transport: { hosts, port, timeoutMs },
    context,
    baseTpl: merged.baseTpl,
    runnerId,
    runner,
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

export function requireRunner(config: ResolvedConfig): RunnerConfig {
  const runner = config.runner;
  if (!runner) {
    throw new Error(
      "runner nao configurado. Use --runner/CMDMT_RUNNER e defina runners.<id> no config."
    );
  }
  const terminalPath = runner.terminalPath;
  const dataPath = resolveRunnerDataPath(runner);
  if (!terminalPath) {
    throw new Error("runner sem terminalPath. Defina runners.<id>.terminalPath ou CMDMT_MT5_PATH.");
  }
  if (!dataPath) {
    throw new Error("runner sem dataPath. Defina runners.<id>.dataPath ou CMDMT_MT5_DATA.");
  }
  return { ...runner, terminalPath, dataPath };
}
