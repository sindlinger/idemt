import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { Command } from "commander";
import { handleError } from "./lib/errors.js";
import { Ctx, splitArgs } from "./lib/args.js";
import { dispatch } from "./lib/dispatch.js";
import type { SendAction } from "./lib/dispatch.js";
import { sendLine, sendJson } from "./lib/transport.js";
import { runRepl } from "./repl.js";
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

type AttachReport = Awaited<ReturnType<typeof buildAttachReport>>;

function isErrorResponse(resp: string): boolean {
  const up = resp.trim().toUpperCase();
  return up.startsWith("ERR") || up.includes(" ERR ") || up.includes("CODE=");
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
  if (!candidates.length) return false;

  const templatesDir = path.join(toWslPath(dataPath), "MQL5", "Profiles", "Templates");
  const expCandidates = expertNameCandidates(expertName).map((v) => v.toLowerCase());

  for (const chart of candidates) {
    const checkName = `__cmdmt_check_${Date.now()}_${chart.id}`;
    await executeSend({ type: "CHART_SAVE_TPL", params: [chart.id, checkName] }, transport);
    const tplPath = path.join(templatesDir, `${checkName}.tpl`);
    if (!fs.existsSync(tplPath)) continue;
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
    if (expCandidates.some((exp) => block.includes(`name=${exp}`))) return true;
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
    "/mnt/c/mql/mt5-shellscripts/CLI/mt5-compile.exe",
    "/mnt/c/mql/mt5-shellscripts/compile.cmd"
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    if (existsPath(c)) return c;
  }
  return null;
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
    return sendLine(line, transport);
  }
  if (action.type === "JSON") {
    const raw = action.params[0] ?? "";
    let obj: unknown = raw;
    try {
      obj = JSON.parse(raw);
    } catch {
      // keep raw
    }
    return sendJson(obj, transport);
  }

  const id = Date.now().toString();
  const line = [id, action.type, ...action.params].join("|");
  return sendLine(line, transport);
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
    .version("0.1.10")
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
    .option("--json", "saida em JSON", false)
    .option("--quiet", "nao imprime banner no modo interativo", false)
    .argument("[cmd...]", "comando e parametros")
    .allowUnknownOption(true)
    .configureOutput({
      writeErr: (str) => process.stderr.write(str),
      writeOut: (str) => process.stdout.write(str)
    })
    .exitOverride();

  await program.parseAsync(process.argv);
  const opts = program.opts();

  const resolved = resolveConfig({
    configPath: opts.config,
    profile: opts.profile,
    runner: opts.runner,
    symbol: opts.symbol,
    tf: opts.tf,
    sub: opts.sub,
    baseTpl: opts.baseTpl,
    compilePath: opts.compilePath,
    host: opts.host,
    hosts: opts.hosts,
    port: opts.port,
    timeoutMs: opts.timeout,
    mt5Path: opts.mt5Path,
    mt5Data: opts.mt5Data
  });

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
    await runCompile(compilePath, finalArgs);
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
  if (res.kind === "test") {
    const runner = requireRunner(resolved);
    const result = await runTester(res.spec, runner, resolved.tester);
    if (opts.json) {
      process.stdout.write(JSON.stringify({ kind: "test", result }) + "\n");
    } else {
      process.stdout.write(`tester: ${result.runDir}\n`);
      if (result.copiedReport) process.stdout.write(`report: ${result.copiedReport}\n`);
      if (result.copiedLogs.length) process.stdout.write(`logs: ${result.copiedLogs.join(", ")}\n`);
    }
    return;
  }

  const transport = requireTransport(resolved);

  if (res.kind === "send") {
    let logStart = null as null | { file: string; offset: number };
    if (res.attach) {
      try {
        const runner = requireRunner(resolved);
        const logFile = findLatestLogFile(runner.dataPath);
        if (logFile && fs.existsSync(logFile)) {
          const stat = fs.statSync(logFile);
          logStart = { file: logFile, offset: stat.size };
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
    if (isErrorResponse(response)) process.exitCode = 1;
    return;
  }

  if (res.kind === "multi") {
    let logStart = null as null | { file: string; offset: number };
    if (res.attach) {
      try {
        const runner = requireRunner(resolved);
        const logFile = findLatestLogFile(runner.dataPath);
        if (logFile && fs.existsSync(logFile)) {
          const stat = fs.statSync(logFile);
          logStart = { file: logFile, offset: stat.size };
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
