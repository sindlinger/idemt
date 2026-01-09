import fs from "node:fs";
import readline from "node:readline";
import { splitArgs, Ctx } from "./lib/args.js";
import { dispatch } from "./lib/dispatch.js";
import type { SendAction } from "./lib/dispatch.js";
import { sendLine, sendJson, TransportOpts } from "./lib/transport.js";
import { requireRunner } from "./lib/config.js";
import type { ResolvedConfig } from "./lib/config.js";
import { runTester } from "./lib/tester.js";
import { createExpertTemplate } from "./lib/template.js";
import { buildAttachReport, formatAttachReport, DEFAULT_ATTACH_META, findLatestLogFile } from "./lib/attach_report.js";
import { renderBanner } from "./lib/banner.js";

export type ReplOpts = TransportOpts & { json?: boolean; quiet?: boolean };

async function executeSend(action: SendAction, opts: TransportOpts): Promise<string> {
  if (action.type === "RAW") {
    const line = action.params[0] ?? "";
    return sendLine(line, opts);
  }
  if (action.type === "JSON") {
    const raw = action.params[0] ?? "";
    let obj: unknown = raw;
    try {
      obj = JSON.parse(raw);
    } catch {
      // keep raw
    }
    return sendJson(obj, opts);
  }
  const id = Date.now().toString();
  const line = [id, action.type, ...action.params].join("|");
  return sendLine(line, opts);
}

function isErrorResponse(resp: string): boolean {
  const up = resp.trim().toUpperCase();
  return up.startsWith("ERR") || up.includes(" ERR ") || up.includes("CODE=");
}

async function handleCommand(tokens: string[], ctx: Ctx, opts: ReplOpts, resolved: ResolvedConfig) {
  const res = dispatch(tokens, ctx);
  if (res.kind === "local") {
    if (res.output) process.stdout.write(res.output + "\n");
    return;
  }
  if (res.kind === "error") {
    process.stderr.write(res.message + "\n");
    return;
  }
  if (res.kind === "exit") {
    throw new Error("__EXIT__");
  }
  if (res.kind === "test") {
    const runner = requireRunner(resolved);
    const result = await runTester(res.spec, runner, resolved.tester);
    process.stdout.write(`tester: ${result.runDir}\n`);
    if (result.copiedReport) process.stdout.write(`report: ${result.copiedReport}\n`);
    if (result.copiedLogs.length) process.stdout.write(`logs: ${result.copiedLogs.join(", ")}\n`);
    return;
  }
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
        // ignore
      }
    }
    const resp = await executeSend({ type: res.type, params: res.params }, opts);
    process.stdout.write(resp);
    const attachMeta = res.meta ?? DEFAULT_ATTACH_META;
    if (!isErrorResponse(resp) && res.attach && attachMeta.report) {
      try {
        const runner = requireRunner(resolved);
        const report = await buildAttachReport({
          kind: res.attach.kind,
          name: res.attach.name,
          symbol: res.attach.symbol,
          tf: res.attach.tf,
          sub: res.attach.sub,
          meta: attachMeta,
          runner,
          send: (action) => executeSend(action, opts),
          logStart: logStart ?? undefined
        });
        process.stdout.write(formatAttachReport(report) + "\n");
      } catch (err) {
        process.stderr.write(`WARN attach_report: ${String(err)}\n`);
      }
    }
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
        // ignore
      }
    }
    let hadError = false;
    for (const step of res.steps) {
      const resp = await executeSend(step, opts);
      process.stdout.write(resp);
      if (isErrorResponse(resp)) hadError = true;
      if (resp.toLowerCase().includes("base_tpl")) {
        try {
          const applyStep = res.steps.find((s) => s.type === "APPLY_TPL");
          if (!applyStep) throw new Error("apply step ausente para fallback local");
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
          const applyResp = await executeSend({ type: "APPLY_TPL", params: applyStep.params }, opts);
          process.stdout.write(applyResp);
          hadError = isErrorResponse(applyResp);
        } catch (err) {
          process.stderr.write(String(err) + "\n");
          hadError = true;
        }
        break;
      }
    }
    const attachMeta = res.meta ?? DEFAULT_ATTACH_META;
    if (!hadError && res.attach && attachMeta.report) {
      try {
        const runner = requireRunner(resolved);
        const report = await buildAttachReport({
          kind: res.attach.kind,
          name: res.attach.name,
          symbol: res.attach.symbol,
          tf: res.attach.tf,
          sub: res.attach.sub,
          meta: attachMeta,
          runner,
          send: (action) => executeSend(action, opts),
          logStart: logStart ?? undefined
        });
        process.stdout.write(formatAttachReport(report) + "\n");
      } catch (err) {
        process.stderr.write(`WARN attach_report: ${String(err)}\n`);
      }
    }
    return;
  }
}

export async function runRepl(opts: ReplOpts, ctx: Ctx, resolved: ResolvedConfig) {
  if (!opts.quiet) {
    const hosts = opts.hosts.join(",");
    const label = (process.env.CMDMT_INVOKE_AS?.trim() || "cmdmt").toUpperCase();
    process.stdout.write(
      renderBanner({
        label,
        owner: "Eduardo Candeiro Goncalves",
        socket: `${hosts}:${opts.port}`
      })
    );
    process.stdout.write("Dica: digite help\n");
  }
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true
  });

  const prompt = () => rl.prompt();
  rl.setPrompt("mt> ");
  prompt();

  rl.on("line", async (line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      prompt();
      return;
    }
    try {
      const tokens = splitArgs(trimmed);
      await handleCommand(tokens, ctx, opts, resolved);
    } catch (err) {
      if (err instanceof Error && err.message === "__EXIT__") {
        rl.close();
        return;
      }
      process.stderr.write(String(err) + "\n");
    }
    prompt();
  });

  rl.on("close", () => process.stdout.write("\n"));
}
