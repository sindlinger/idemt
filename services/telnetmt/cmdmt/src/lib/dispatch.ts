import fs from "node:fs";
import path from "node:path";
import { Ctx, isTf, parseSub, resolveSymTf } from "./args.js";
import { renderHelp, renderExamples } from "./help.js";
import { safeFileBase, stableHash } from "./naming.js";
import type { TestSpec } from "./tester.js";
import type { AttachMeta } from "./attach_report.js";
import { DEFAULT_ATTACH_META } from "./attach_report.js";

export type SendAction = { type: string; params: string[] };

export type AttachInfo = {
  kind: "indicator" | "expert";
  name: string;
  symbol: string;
  tf: string;
  sub?: number;
};

export type DispatchResult =
  | { kind: "send"; type: string; params: string[]; attach?: AttachInfo; meta?: AttachMeta }
  | { kind: "local"; output: string }
  | { kind: "exit" }
  | { kind: "error"; message: string }
  | { kind: "multi"; steps: SendAction[]; attach?: AttachInfo; meta?: AttachMeta }
  | { kind: "ind_detach_index"; sym: string; tf: string; sub: string; index: number }
  | { kind: "test"; spec: TestSpec }
  | { kind: "install"; dataPath: string; allowDll?: boolean; allowLive?: boolean; web?: string[]; dryRun?: boolean; repoPath?: string; name?: string; namePrefix?: string };


function err(msg: string): DispatchResult {
  return { kind: "error", message: msg };
}

const PARAMS_HINT = "params devem ser passados com --params k=v ... (ex: --params depth=12 deviation=5)";
const DEFAULT_SYMBOL = "EURUSD";
const DEFAULT_TF = "M5";

function parseSymTfDefault(args: string[], ctx: Ctx): { sym: string; tf: string; rest: string[] } {
  const a = [...args];
  let sym = ctx.symbol?.trim() || DEFAULT_SYMBOL;
  let tf = ctx.tf?.trim() || DEFAULT_TF;
  if (a.length >= 2 && isTf(a[1])) {
    sym = a[0];
    tf = a[1];
    a.splice(0, 2);
  } else if (a.length >= 1 && isTf(a[0])) {
    tf = a[0];
    a.splice(0, 1);
  }
  return { sym, tf, rest: a };
}

function requireSymTf(args: string[], ctx: Ctx): { sym: string; tf: string; rest: string[] } | null {
  return resolveSymTf(args, ctx, true);
}

function parseBoolFlag(val: string | undefined, defaultValue: boolean): boolean {
  if (val === undefined || val === "") return defaultValue;
  const v = val.toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(v)) return true;
  if (["0", "false", "no", "n", "off"].includes(v)) return false;
  return defaultValue;
}

function parseIntFlag(val: string | undefined, min: number, max: number): number | null {
  if (!val) return null;
  const n = parseInt(val, 10);
  if (!Number.isFinite(n)) return null;
  return Math.max(min, Math.min(max, n));
}

function parseParamsAndMeta(tokens: string[]): { params: string; rest: string[]; meta: AttachMeta } {
  const meta: AttachMeta = { ...DEFAULT_ATTACH_META };
  if (tokens.length === 0) return { params: "", rest: tokens, meta };

  const rest: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const lower = tok.toLowerCase();

    if (lower === "--params" || lower.startsWith("--params=")) {
      const inline = lower.startsWith("--params=") ? tok.slice("--params=".length) : "";
      const paramsTokens = inline ? [inline] : tokens.slice(i + 1);
      return { params: paramsTokens.join(";"), rest, meta };
    }
    if (lower === "--report" || lower.startsWith("--report=")) {
      const val = lower.includes("=") ? tok.slice(tok.indexOf("=") + 1) : "";
      meta.report = parseBoolFlag(val, true);
      continue;
    }
    if (lower === "--no-report") {
      meta.report = false;
      continue;
    }
    if (lower === "--buffers" || lower.startsWith("--buffers=")) {
      let val = lower.includes("=") ? tok.slice(tok.indexOf("=") + 1) : "";
      if (!val && i + 1 < tokens.length && !tokens[i + 1].startsWith("--")) {
        val = tokens[i + 1];
        i += 1;
      }
      const n = parseIntFlag(val, 1, 200);
      if (n !== null) meta.buffers = n;
      continue;
    }
    if (lower === "--log" || lower.startsWith("--log=")) {
      let val = lower.includes("=") ? tok.slice(tok.indexOf("=") + 1) : "";
      if (!val && i + 1 < tokens.length && !tokens[i + 1].startsWith("--")) {
        val = tokens[i + 1];
        i += 1;
      }
      const n = parseIntFlag(val, 1, 500);
      if (n !== null) meta.logTail = n;
      continue;
    }
    if (lower === "--shot" || lower.startsWith("--shot=")) {
      const val = lower.includes("=") ? tok.slice(tok.indexOf("=") + 1) : "";
      meta.shot = parseBoolFlag(val, true);
      continue;
    }
    if (lower === "--no-shot") {
      meta.shot = false;
      continue;
    }
    if (lower === "--shotname" || lower.startsWith("--shotname=")) {
      let val = lower.includes("=") ? tok.slice(tok.indexOf("=") + 1) : "";
      if (!val && i + 1 < tokens.length && !tokens[i + 1].startsWith("--")) {
        val = tokens[i + 1];
        i += 1;
      }
      if (val) {
        meta.shotName = val;
        meta.shot = true;
      }
      continue;
    }

    rest.push(tok);
  }
  return { params: "", rest, meta };
}

function hasImplicitParams(tokens: string[]): boolean {
  return tokens.some((t) => t.includes("=") && !t.toLowerCase().startsWith("sub="));
}

function maybeResolveLocalPath(name: string): string {
  const trimmed = name.trim().replace(/^"+|"+$/g, "");
  if (!/\.(mq5|ex5)$/i.test(trimmed)) return name;
  const abs = path.isAbsolute(trimmed) ? trimmed : path.resolve(process.cwd(), trimmed);
  if (fs.existsSync(abs)) return abs;
  return name;
}

function requireBaseTpl(ctx: Ctx): string | null {
  return ctx.baseTpl?.trim() || null;
}

function buildTplName(expert: string, symbol: string, tf: string, params: string): string {
  const base = safeFileBase(`${expert}-${symbol}-${tf}`);
  const hash = stableHash(`${expert}|${symbol}|${tf}|${params}`);
  return `${base}-${hash}.tpl`;
}

function parseInstallArgs(tokens: string[]): { dataPath: string; allowDll?: boolean; allowLive?: boolean; web?: string[]; dryRun?: boolean; repoPath?: string; name?: string; namePrefix?: string } | null {
  let allowDll: boolean | undefined = undefined;
  let allowLive: boolean | undefined = undefined;
  let dryRun: boolean | undefined = undefined;
  let repoPath: string | undefined = undefined;
  let name: string | undefined = undefined;
  let namePrefix: string | undefined = undefined;
  const web: string[] = [];
  const rest: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const lower = tok.toLowerCase();
    if (lower === "--allow-dll") {
      allowDll = true;
      continue;
    }
    if (lower === "--no-allow-dll") {
      allowDll = false;
      continue;
    }
    if (lower === "--allow-live") {
      allowLive = true;
      continue;
    }
    if (lower === "--no-allow-live") {
      allowLive = false;
      continue;
    }
    if (lower === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (lower === "--web" || lower.startsWith("--web=")) {
      let val = lower.includes("=") ? tok.slice(tok.indexOf("=") + 1) : "";
      if (!val && i + 1 < tokens.length && !tokens[i + 1].startsWith("--")) {
        val = tokens[i + 1];
        i += 1;
      }
      if (val) web.push(val);
      continue;
    }
    if (lower === "--repo" || lower.startsWith("--repo=")) {
      let val = lower.includes("=") ? tok.slice(tok.indexOf("=") + 1) : "";
      if (!val && i + 1 < tokens.length && !tokens[i + 1].startsWith("--")) {
        val = tokens[i + 1];
        i += 1;
      }
      if (val) repoPath = val;
      continue;
    }
    if (lower === "--name" || lower.startsWith("--name=")) {
      let val = lower.includes("=") ? tok.slice(tok.indexOf("=") + 1) : "";
      if (!val && i + 1 < tokens.length && !tokens[i + 1].startsWith("--")) {
        val = tokens[i + 1];
        i += 1;
      }
      if (val) name = val;
      continue;
    }
    if (lower === "--name-prefix" || lower.startsWith("--name-prefix=")) {
      let val = lower.includes("=") ? tok.slice(tok.indexOf("=") + 1) : "";
      if (!val && i + 1 < tokens.length && !tokens[i + 1].startsWith("--")) {
        val = tokens[i + 1];
        i += 1;
      }
      if (val) namePrefix = val;
      continue;
    }
    rest.push(tok);
  }

  if (!rest.length) return null;
  const dataPath = rest.join(" ");
  return { dataPath, allowDll, allowLive, web, dryRun, repoPath, name, namePrefix };
}

export function dispatch(tokens: string[], ctx: Ctx): DispatchResult {
  if (tokens.length === 0) return { kind: "local", output: renderHelp().join("\n") };
  const cmd = tokens[0].toLowerCase();
  const rest = tokens.slice(1);

  if (cmd === "help" || cmd === "h" || cmd === "?") {
    return { kind: "local", output: renderHelp().join("\n") };
  }
  if (cmd === "examples" || cmd === "exemplos") {
    const key = rest.join(" ").trim();
    return { kind: "local", output: renderExamples(key) };
  }
  if (cmd === "add" || cmd === "del") {
    const isAdd = cmd === "add";
    let args = rest;
    let mode: "indicator" | "expert" = "indicator";
    if (args.length) {
      const head = args[0].toLowerCase();
      if (["ea", "expert", "experts"].includes(head)) {
        mode = "expert";
        args = args.slice(1);
      } else if (["ind", "indicator", "indicators"].includes(head)) {
        mode = "indicator";
        args = args.slice(1);
      }
    }

    if (mode === "indicator") {
      if (isAdd) {
        const r = parseSymTfDefault(args, ctx);
        if (r.rest.length < 1)
          return err("uso: add [SYMBOL TF] INDICADOR [SUB|sub=N] [--params k=v ...]");
        const { params, rest: rest2, meta } = parseParamsAndMeta(r.rest);
        const { sub: subw, rest: rest3 } = parseSub(rest2, ctx);
        if (!params && hasImplicitParams(rest3)) {
          return err(PARAMS_HINT);
        }
        let name = rest3.join(" ");
        name = maybeResolveLocalPath(name);
        const payload = [r.sym, r.tf, name, subw];
        if (params) payload.push(params);
        return {
          kind: "send",
          type: "ATTACH_IND_FULL",
          params: payload,
          attach: { kind: "indicator", name, symbol: r.sym, tf: r.tf, sub: Number(subw) },
          meta
        };
      }
      const r = parseSymTfDefault(args, ctx);
      if (r.rest.length < 1)
        return err("uso: del [SYMBOL TF] INDICADOR|INDEX [SUB|sub=N]");
      const hasExplicitSub = r.rest.some((t) => {
        const low = t.toLowerCase();
        if (low.startsWith("sub=")) return true;
        if ((t.startsWith("#") || t.startsWith("@")) && /^\d+$/.test(t.slice(1))) return true;
        return false;
      });
      const subParsed = hasExplicitSub ? parseSub(r.rest, ctx) : { sub: String(ctx.sub ?? 1), rest: r.rest };
      const { sub: subw, rest: rest2 } = subParsed;
      const name = rest2.join(" ");
      if (/^\d+$/.test(name)) {
        return { kind: "ind_detach_index", sym: r.sym, tf: r.tf, sub: subw, index: parseInt(name, 10) };
      }
      return { kind: "send", type: "DETACH_IND_FULL", params: [r.sym, r.tf, name, subw] };
    }

    if (isAdd) {
      const r = parseSymTfDefault(args, ctx);
      if (r.rest.length < 1) return err("uso: add ea [SYMBOL TF] EA [BASE_TPL] [--params k=v ...]");
      const { params, rest: rest2, meta } = parseParamsAndMeta(r.rest);
      if (rest2.length === 1 && rest2[0].toLowerCase().endsWith(".tpl") && !params) {
        return { kind: "send", type: "APPLY_TPL", params: [r.sym, r.tf, rest2[0]] };
      }
      let baseTpl = "";
      const tplIdx = rest2.findIndex((t) => t.toLowerCase().endsWith(".tpl"));
      if (tplIdx >= 0) {
        baseTpl = rest2[tplIdx];
        rest2.splice(tplIdx, 1);
      }
      if (!baseTpl && ctx.baseTpl) {
        baseTpl = ctx.baseTpl;
      }
      if (!params && hasImplicitParams(rest2)) {
        return err(PARAMS_HINT);
      }
      const name = rest2.join(" ");
      if (!name) return err("uso: add ea [SYMBOL TF] EA [BASE_TPL] [--params k=v ...]");
      const hash = stableHash(`${name}|${r.sym}|${r.tf}|${params}`);
      const outTpl = `cmdmt_ea_${hash}.tpl`;
      const saveParams = [name, outTpl];
      if (baseTpl) saveParams.push(baseTpl);
      if (params) saveParams.push(params);
      const steps: SendAction[] = [
        { type: "SAVE_TPL_EA", params: saveParams },
        { type: "APPLY_TPL", params: [r.sym, r.tf, outTpl] }
      ];
      return {
        kind: "multi",
        steps,
        attach: { kind: "expert", name, symbol: r.sym, tf: r.tf },
        meta
      };
    }

    const r = resolveSymTf(args, ctx, false);
    if (!r || !r.sym || !r.tf) return err("uso: del ea [SYMBOL TF]");
    return { kind: "send", type: "DETACH_EA_FULL", params: [r.sym, r.tf] };
  }
  if (cmd === "exit" || cmd === "quit") {
    return { kind: "exit" };
  }
  if (cmd === "install") {
    const parsed = parseInstallArgs(rest);
    if (!parsed) {
    return err("uso: install <MT5_DATA> [--name NOME] [--name-prefix PREFIX] [--allow-dll|--no-allow-dll] [--allow-live|--no-allow-live] [--web URL] [--dry-run] [--repo PATH]");
  }
    return { kind: "install", ...parsed };
  }
  if (cmd === "use") {
    if (rest.length < 2 || !isTf(rest[1])) return err("uso: use SYMBOL TF");
    ctx.symbol = rest[0];
    ctx.tf = rest[1];
    return { kind: "local", output: `context: ${ctx.symbol} ${ctx.tf}` };
  }
  if (cmd === "ctx") {
    return {
      kind: "local",
      output: `context: ${ctx.symbol ?? "(none)"} ${ctx.tf ?? ""}`.trim()
    };
  }
  if (cmd === "ping") return { kind: "send", type: "PING", params: [] };
  if (cmd === "debug") {
    if (!rest.length) return err("uso: debug MSG");
    return { kind: "send", type: "DEBUG_MSG", params: [rest.join(" ")] };
  }
  if (cmd === "open") {
    const r = parseSymTfDefault(rest, ctx);
    return { kind: "send", type: "OPEN_CHART", params: [r.sym, r.tf] };
  }

  if (cmd === "indicador") {
    const { sym, tf, rest: remaining } = parseSymTfDefault(rest, ctx);
    const { params, rest: rest2, meta } = parseParamsAndMeta(remaining);
    const { sub: subw, rest: rest3 } = parseSub(rest2, ctx);
    if (!params && hasImplicitParams(rest3)) {
      return err(PARAMS_HINT);
    }
    let name = rest3.join(" ");
    if (!name) return err("uso: indicador [TF] NOME [sub=N] [--params k=v ...]");
    name = maybeResolveLocalPath(name);
    const payload = [sym, tf, name, subw];
    if (params) payload.push(params);
    return {
      kind: "send",
      type: "ATTACH_IND_FULL",
      params: payload,
      attach: { kind: "indicator", name, symbol: sym, tf, sub: Number(subw) },
      meta
    };
  }

  if (cmd === "chart") {
    if (rest.length === 0) return err("uso: chart <open|close|list|closeall|redraw|detachall|find>");
    const sub = rest[0].toLowerCase();
    const args = rest.slice(1);
    if (sub === "list") return { kind: "send", type: "LIST_CHARTS", params: [] };
    if (sub === "closeall") return { kind: "send", type: "CLOSE_ALL", params: [] };
    if (sub === "open") {
      const r = parseSymTfDefault(args, ctx);
      return { kind: "send", type: "OPEN_CHART", params: [r.sym, r.tf] };
    }
    if (sub === "close") {
      const r = parseSymTfDefault(args, ctx);
      return { kind: "send", type: "CLOSE_CHART", params: [r.sym, r.tf] };
    }
    if (sub === "redraw") {
      const r = parseSymTfDefault(args, ctx);
      return { kind: "send", type: "REDRAW_CHART", params: [r.sym, r.tf] };
    }
    if (sub === "detachall") {
      const r = parseSymTfDefault(args, ctx);
      return { kind: "send", type: "DETACH_ALL", params: [r.sym, r.tf] };
    }
    if (sub === "find") {
      const r = parseSymTfDefault(args, ctx);
      if (r.rest.length < 1) return err("uso: chart find [SYMBOL TF] NAME");
      return { kind: "send", type: "WINDOW_FIND", params: [r.sym, r.tf, r.rest.join(" ")] };
    }
  }

  if (cmd === "template") {
    if (rest.length === 0) return err("uso: template <apply|save|saveea|savechart>");
    const sub = rest[0].toLowerCase();
    const args = rest.slice(1);
    if (sub === "apply") {
      const r = parseSymTfDefault(args, ctx);
      if (r.rest.length < 1) return err("uso: template apply [SYMBOL TF] TEMPLATE");
      return { kind: "send", type: "APPLY_TPL", params: [r.sym, r.tf, r.rest.join(" ")] };
    }
    if (sub === "save") {
      const r = parseSymTfDefault(args, ctx);
      if (r.rest.length < 1) return err("uso: template save [SYMBOL TF] TEMPLATE");
      return { kind: "send", type: "SAVE_TPL", params: [r.sym, r.tf, r.rest.join(" ")] };
    }
    if (sub === "savechart") {
      if (args.length < 2) return err("uso: template savechart CHART_ID NAME");
      return { kind: "send", type: "CHART_SAVE_TPL", params: [args[0], args[1]] };
    }
    if (sub === "saveea") {
      if (args.length < 2) return err("uso: template saveea EA OUT_TPL [BASE_TPL] [k=v;...]");
      const expert = args[0];
      const outTpl = args[1];
      const baseTpl = args.length >= 3 ? args[2] : "";
      const extra = args.length >= 4 ? args.slice(3).join(";") : "";
      const params = [expert, outTpl];
      if (baseTpl) params.push(baseTpl);
      if (extra) params.push(extra);
      return { kind: "send", type: "SAVE_TPL_EA", params };
    }
  }

  if (cmd === "indicator") {
    if (rest.length === 0) return err("uso: indicator <attach|detach|total|name|handle|get|release>");
    const sub = rest[0].toLowerCase();
    const args = rest.slice(1);

    if (sub === "attach") {
      const r = parseSymTfDefault(args, ctx);
      if (r.rest.length < 1)
        return err("uso: indicator attach [SYMBOL TF] NAME [SUB|sub=N] [--params k=v ...]");
      const { params, rest: rest2, meta } = parseParamsAndMeta(r.rest);
      const { sub: subw, rest: rest3 } = parseSub(rest2, ctx);
      if (!params && hasImplicitParams(rest3)) {
        return err(PARAMS_HINT);
      }
      let name = rest3.join(" ");
      name = maybeResolveLocalPath(name);
      const payload = [r.sym, r.tf, name, subw];
      if (params) payload.push(params);
      return {
        kind: "send",
        type: "ATTACH_IND_FULL",
        params: payload,
        attach: { kind: "indicator", name, symbol: r.sym, tf: r.tf, sub: Number(subw) },
        meta
      };
    }
    if (sub === "detach") {
      const r = parseSymTfDefault(args, ctx);
      if (r.rest.length < 1) return err("uso: indicator detach [SYMBOL TF] NAME [SUB|sub=N]");
      const { sub: subw, rest: rest2 } = parseSub(r.rest, ctx);
      const name = rest2.join(" ");
      return { kind: "send", type: "DETACH_IND_FULL", params: [r.sym, r.tf, name, subw] };
    }
    if (sub === "total") {
      const r = parseSymTfDefault(args, ctx);
      const { sub: subw, rest: rest2 } = parseSub(r.rest, ctx);
      if (rest2.length) {
        // allow explicit sub as arg
        return { kind: "send", type: "IND_TOTAL", params: [r.sym, r.tf, rest2[0]] };
      }
      return { kind: "send", type: "IND_TOTAL", params: [r.sym, r.tf, subw] };
    }
    if (sub === "name" || sub === "handle" || sub === "get") {
      const r = parseSymTfDefault(args, ctx);
      if (r.rest.length < 1) return err(`uso: indicator ${sub} [SYMBOL TF] NAME|INDEX [SUB]`);
      const { sub: subw, rest: rest2 } = parseSub(r.rest, ctx);
      const type = sub === "name" ? "IND_NAME" : sub === "handle" ? "IND_HANDLE" : "IND_GET";
      const params = [r.sym, r.tf, subw];
      params.push(rest2.join(" "));
      return { kind: "send", type, params };
    }
    if (sub === "release") {
      if (args.length < 1) return err("uso: indicator release HANDLE");
      return { kind: "send", type: "IND_RELEASE", params: [args[0]] };
    }
  }

  if (cmd === "expert") {
    if (rest.length === 0) return err("uso: expert <attach|detach|find|run|test|oneshot>");
    const sub = rest[0].toLowerCase();
    const args = rest.slice(1);
    if (sub === "find") {
      if (!args.length) return err("uso: expert find NAME");
      return { kind: "send", type: "FIND_EA", params: [args.join(" ")] };
    }
    if (sub === "run") {
      let symbol = ctx.symbol?.trim() || DEFAULT_SYMBOL;
      let tf = ctx.tf?.trim() || DEFAULT_TF;
      let restArgs = [...args];
      if (restArgs.length >= 2 && isTf(restArgs[1])) {
        symbol = restArgs[0];
        tf = restArgs[1];
        restArgs = restArgs.slice(2);
      } else if (restArgs.length >= 1 && isTf(restArgs[0])) {
        tf = restArgs[0];
        restArgs = restArgs.slice(1);
      }
      let baseTpl = requireBaseTpl(ctx) ?? "";
      const tplIdx = restArgs.findIndex((t) => t.toLowerCase().endsWith(".tpl"));
      if (tplIdx >= 0) {
        baseTpl = restArgs[tplIdx];
        restArgs.splice(tplIdx, 1);
      }
      const { params, rest: rest2 } = parseParamsAndMeta(restArgs);
      if (!params && hasImplicitParams(rest2)) {
        return err(PARAMS_HINT);
      }
      const name = rest2.join(" ");
      if (!name) return err("uso: expert run [TF] NOME [BASE_TPL] [--params k=v ...]");
      const spec: TestSpec = { expert: name, symbol, tf, params, oneShot: true, baseTpl };
      return { kind: "test", spec };
    }
    if (sub === "test") {
      let symbol = ctx.symbol?.trim() || DEFAULT_SYMBOL;
      let tf = ctx.tf?.trim() || DEFAULT_TF;
      let restArgs = [...args];
      if (restArgs.length >= 2 && isTf(restArgs[1])) {
        symbol = restArgs[0];
        tf = restArgs[1];
        restArgs = restArgs.slice(2);
      } else if (restArgs.length >= 1 && isTf(restArgs[0])) {
        tf = restArgs[0];
        restArgs = restArgs.slice(1);
      }
      const { params, rest: rest2 } = parseParamsAndMeta(restArgs);
      if (!params && hasImplicitParams(rest2)) {
        return err(PARAMS_HINT);
      }
      const name = rest2.join(" ");
      if (!name) return err("uso: expert test [TF] NOME [--params k=v ...]");
      const spec: TestSpec = { expert: name, symbol, tf, params };
      return { kind: "test", spec };
    }
    if (sub === "oneshot") {
      const symbol = ctx.symbol?.trim() || DEFAULT_SYMBOL;
      if (args.length < 2 || !isTf(args[0])) return err("uso: expert oneshot TF NOME [BASE_TPL] [--params k=v ...]");
      const tf = args[0];
      const restArgs = args.slice(1);
      let baseTpl = requireBaseTpl(ctx) ?? "";
      const tplIdx = restArgs.findIndex((t) => t.toLowerCase().endsWith(".tpl"));
      if (tplIdx >= 0) {
        baseTpl = restArgs[tplIdx];
        restArgs.splice(tplIdx, 1);
      }
      if (!baseTpl) return err("base template ausente. Use --base-tpl/CMDMT_BASE_TPL ou defaults.baseTpl.");
      const { params, rest: rest2 } = parseParamsAndMeta(restArgs);
      if (!params && hasImplicitParams(rest2)) {
        return err(PARAMS_HINT);
      }
      const name = rest2.join(" ");
      if (!name) return err("uso: expert oneshot TF NOME [BASE_TPL] [--params k=v ...]");
      const spec: TestSpec = { expert: name, symbol, tf, params, oneShot: true, baseTpl };
      return { kind: "test", spec };
    }
    if (sub === "attach") {
      const r = parseSymTfDefault(args, ctx);
      if (r.rest.length < 1) return err("uso: expert attach [SYMBOL TF] NAME [BASE_TPL] [--params k=v ...]");
      const { params, rest: rest2, meta } = parseParamsAndMeta(r.rest);
      if (rest2.length === 1 && rest2[0].toLowerCase().endsWith(".tpl") && !params) {
        return { kind: "send", type: "APPLY_TPL", params: [r.sym, r.tf, rest2[0]] };
      }
      let baseTpl = "";
      const tplIdx = rest2.findIndex((t) => t.toLowerCase().endsWith(".tpl"));
      if (tplIdx >= 0) {
        baseTpl = rest2[tplIdx];
        rest2.splice(tplIdx, 1);
      }
      if (!baseTpl && ctx.baseTpl) {
        baseTpl = ctx.baseTpl;
      }
      if (!params && hasImplicitParams(rest2)) {
        return err(PARAMS_HINT);
      }
      const name = rest2.join(" ");
      if (!name) return err("uso: expert attach [SYMBOL TF] NAME [BASE_TPL] [--params k=v ...]");
      const hash = stableHash(`${name}|${r.sym}|${r.tf}|${params}`);
      const outTpl = `cmdmt_ea_${hash}.tpl`;
      const saveParams = [name, outTpl];
      if (baseTpl) saveParams.push(baseTpl);
      if (params) saveParams.push(params);
      const steps: SendAction[] = [
        { type: "SAVE_TPL_EA", params: saveParams },
        { type: "APPLY_TPL", params: [r.sym, r.tf, outTpl] }
      ];
      return {
        kind: "multi",
        steps,
        attach: { kind: "expert", name, symbol: r.sym, tf: r.tf },
        meta
      };
    }
    if (sub === "detach") {
      const r = resolveSymTf(args, ctx, false);
      if (!r || !r.sym || !r.tf) return err("uso: expert detach [SYMBOL TF]");
      return { kind: "send", type: "DETACH_EA_FULL", params: [r.sym, r.tf] };
    }
  }

  if (cmd === "script") {
    if (rest.length === 0) return err("uso: script run SYMBOL TF TEMPLATE");
    const sub = rest[0].toLowerCase();
    const args = rest.slice(1);
    if (sub === "run") {
      const r = resolveSymTf(args, ctx, false);
      if (!r || !r.sym || !r.tf || r.rest.length < 1)
        return err("uso: script run [SYMBOL TF] TEMPLATE");
      return { kind: "send", type: "RUN_SCRIPT", params: [r.sym, r.tf, r.rest.join(" ")] };
    }
  }

  if (cmd === "trade") {
    if (rest.length === 0) return err("uso: trade <buy|sell|list|closeall>");
    const sub = rest[0].toLowerCase();
    const args = rest.slice(1);
    if (sub === "list") return { kind: "send", type: "TRADE_LIST", params: [] };
    if (sub === "closeall") return { kind: "send", type: "TRADE_CLOSE_ALL", params: [] };
    if (sub === "buy" || sub === "sell") {
      let payload = [...args];
      if (payload.length >= 2) {
        const type = sub === "buy" ? "TRADE_BUY" : "TRADE_SELL";
        return { kind: "send", type, params: payload };
      }
      if (payload.length === 1 && ctx.symbol) {
        payload = [ctx.symbol, payload[0]];
        const type = sub === "buy" ? "TRADE_BUY" : "TRADE_SELL";
        return { kind: "send", type, params: payload };
      }
      return err(`uso: trade ${sub} [SYMBOL] LOTS [sl] [tp]`);
    }
  }

  if (cmd === "global") {
    if (rest.length === 0) return err("uso: global <set|get|del|delprefix|list>");
    const sub = rest[0].toLowerCase();
    const args = rest.slice(1);
    if (sub === "set") return { kind: "send", type: "GLOBAL_SET", params: args };
    if (sub === "get") return { kind: "send", type: "GLOBAL_GET", params: args };
    if (sub === "del") return { kind: "send", type: "GLOBAL_DEL", params: args };
    if (sub === "delprefix") return { kind: "send", type: "GLOBAL_DEL_PREFIX", params: args };
    if (sub === "list") return { kind: "send", type: "GLOBAL_LIST", params: args };
  }

  if (cmd === "input") {
    if (rest.length === 0) return err("uso: input <list|set>");
    const sub = rest[0].toLowerCase();
    const args = rest.slice(1);
    if (sub === "list") return { kind: "send", type: "LIST_INPUTS", params: [] };
    if (sub === "set") return { kind: "send", type: "SET_INPUT", params: args };
  }

  if (cmd === "snapshot") {
    if (rest.length === 0) return err("uso: snapshot <save|apply|list>");
    const sub = rest[0].toLowerCase();
    const args = rest.slice(1);
    if (sub === "save") return { kind: "send", type: "SNAPSHOT_SAVE", params: args };
    if (sub === "apply") return { kind: "send", type: "SNAPSHOT_APPLY", params: args };
    if (sub === "list") return { kind: "send", type: "SNAPSHOT_LIST", params: [] };
  }

  if (cmd === "object") {
    if (rest.length === 0) return err("uso: object <list|delete|delprefix|move|create>");
    const sub = rest[0].toLowerCase();
    const args = rest.slice(1);
    if (sub === "list") return { kind: "send", type: "OBJ_LIST", params: args };
    if (sub === "delete") return { kind: "send", type: "OBJ_DELETE", params: args };
    if (sub === "delprefix") return { kind: "send", type: "OBJ_DELETE_PREFIX", params: args };
    if (sub === "move") return { kind: "send", type: "OBJ_MOVE", params: args };
    if (sub === "create") return { kind: "send", type: "OBJ_CREATE", params: args };
  }

  if (cmd === "screen") {
    if (rest.length === 0) return err("uso: screen <shot|sweep|drop>");
    const sub = rest[0].toLowerCase();
    const args = rest.slice(1);
    if (sub === "shot") return { kind: "send", type: "SCREENSHOT", params: args };
    if (sub === "sweep") return { kind: "send", type: "SCREENSHOT_SWEEP", params: args };
    if (sub === "drop") return { kind: "send", type: "DROP_INFO", params: args };
  }

  if (cmd === "cmd") {
    if (rest.length < 1) return err("uso: cmd TYPE [PARAMS...] ");
    const type = rest[0].toUpperCase();
    return { kind: "send", type, params: rest.slice(1) };
  }

  if (cmd === "raw") {
    if (rest.length < 1) return err("uso: raw <linha>" );
    return { kind: "send", type: "RAW", params: [rest.join(" ")] };
  }

  if (cmd === "json") {
    if (rest.length < 1) return err("uso: json <json>" );
    return { kind: "send", type: "JSON", params: [rest.join(" ")] };
  }

  return err(`comando desconhecido: ${cmd}`);
}
