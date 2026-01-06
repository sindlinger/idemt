import { Command } from "commander";
import { handleError } from "./lib/errors.js";
import { Ctx, splitArgs } from "./lib/args.js";
import { dispatch } from "./lib/dispatch.js";
import type { SendAction } from "./lib/dispatch.js";
import { sendLine, sendJson } from "./lib/transport.js";
import { runRepl } from "./repl.js";
import { requireRunner, requireTransport, resolveConfig } from "./lib/config.js";
import { runTester } from "./lib/tester.js";
import { createExpertTemplate } from "./lib/template.js";

function isErrorResponse(resp: string): boolean {
  const up = resp.trim().toUpperCase();
  return up.startsWith("ERR") || up.includes(" ERR ") || up.includes("CODE=");
}

function isBaseTplError(resp: string): boolean {
  const low = resp.toLowerCase();
  return low.includes("base_tpl") || low.includes("invalid file name");
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

async function main() {
  const program = new Command();

  program
    .name("cmdmt")
    .description("TelnetMT CLI (socket)")
    .version("0.1.0")
    .option("--config <path>", "caminho do config JSON")
    .option("--profile <name>", "perfil do config")
    .option("--runner <id>", "runner do config")
    .option("--symbol <symbol>", "symbol default")
    .option("--tf <tf>", "timeframe default")
    .option("--sub <n>", "subwindow/indice default", (v) => parseInt(v, 10))
    .option("--base-tpl <tpl>", "template base para expert run")
    .option("--mt5-path <path>", "override do terminalPath")
    .option("--mt5-data <path>", "override do dataPath")
    .option("--host <host>", "host unico (ex: 127.0.0.1)")
    .option("--hosts <hosts>", "lista separada por virgula")
    .option("-p, --port <port>", "porta", (v) => parseInt(v, 10), 9090)
    .option("-t, --timeout <ms>", "timeout em ms", (v) => parseInt(v, 10), 3000)
    .option("--json", "saida em JSON", false)
    .option("--quiet", "nao imprime banner no modo interativo", false)
    .argument("[cmd...]", "comando e parametros")
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
    const response = await executeSend({ type: res.type, params: res.params }, transport);
    if (opts.json) {
      process.stdout.write(JSON.stringify({ kind: "send", type: res.type, params: res.params, response }) + "\n");
    } else {
      process.stdout.write(response);
    }
    if (isErrorResponse(response)) process.exitCode = 1;
    return;
  }

  if (res.kind === "multi") {
    const responses: Array<{ type: string; params: string[]; response: string }> = [];
    for (const step of res.steps) {
      const response = await executeSend(step, transport);
      responses.push({ type: step.type, params: step.params, response });
      if (!opts.json) process.stdout.write(response);
      if (isErrorResponse(response)) {
        if (step.type === "SAVE_TPL_EA" && isBaseTplError(response)) {
          const applyStep = res.steps.find((s) => s.type === "APPLY_TPL");
          if (!applyStep) {
            process.exitCode = 1;
            break;
          }
          try {
            const runner = requireRunner(resolved);
            const baseTpl = step.params[2] ?? resolved.baseTpl ?? "";
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
            if (!opts.json) process.stdout.write(applyResp);
            if (isErrorResponse(applyResp)) process.exitCode = 1;
          } catch (err) {
            process.stderr.write(String(err) + "\n");
            process.exitCode = 1;
          }
          break;
        }
        process.exitCode = 1;
        break;
      }
    }
    if (opts.json) {
      process.stdout.write(JSON.stringify({ kind: "multi", responses }) + "\n");
    }
  }
}

main().catch(handleError);
