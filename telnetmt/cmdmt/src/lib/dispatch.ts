import { Ctx, isTf, parseSub, resolveSymTf } from "./args.js";
import { renderHelp, renderExamples } from "./help.js";
import { safeFileBase, stableHash } from "./naming.js";
import type { TestSpec } from "./tester.js";

export type SendAction = { type: string; params: string[] };

export type DispatchResult =
  | { kind: "send"; type: string; params: string[] }
  | { kind: "local"; output: string }
  | { kind: "exit" }
  | { kind: "error"; message: string }
  | { kind: "multi"; steps: SendAction[] }
  | { kind: "test"; spec: TestSpec };


function err(msg: string): DispatchResult {
  return { kind: "error", message: msg };
}

function requireSymTf(args: string[], ctx: Ctx): { sym: string; tf: string; rest: string[] } | null {
  return resolveSymTf(args, ctx, true);
}

function parseParamsTokens(tokens: string[]): { params: string; rest: string[] } {
  if (tokens.length === 0) return { params: "", rest: tokens };
  let rest = [...tokens];
  let paramsTokens: string[] = [];
  const idx = rest.indexOf("--");
  if (idx >= 0) {
    paramsTokens = rest.slice(idx + 1);
    rest = rest.slice(0, idx);
  } else {
    const i = rest.findIndex((t) => t.includes("=") && !t.toLowerCase().startsWith("sub="));
    if (i >= 0) {
      paramsTokens = rest.slice(i);
      rest = rest.slice(0, i);
    }
  }
  return { params: paramsTokens.join(";"), rest };
}

function requireDefaultSymbol(ctx: Ctx): string | null {
  return ctx.symbol?.trim() || null;
}

function requireBaseTpl(ctx: Ctx): string | null {
  return ctx.baseTpl?.trim() || null;
}

function buildTplName(expert: string, symbol: string, tf: string, params: string): string {
  const base = safeFileBase(`${expert}-${symbol}-${tf}`);
  const hash = stableHash(`${expert}|${symbol}|${tf}|${params}`);
  return `${base}-${hash}.tpl`;
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
  if (cmd === "exit" || cmd === "quit") {
    return { kind: "exit" };
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

  if (cmd === "indicador") {
    const symbol = requireDefaultSymbol(ctx);
    if (!symbol) return err("symbol default ausente. Use --symbol/CMDMT_SYMBOL ou defaults.context.symbol.");
    let tf = ctx.tf;
    let remaining = [...rest];
    if (remaining.length >= 1 && isTf(remaining[0])) {
      tf = remaining[0];
      remaining = remaining.slice(1);
    }
    if (!tf) return err("tf default ausente. Use --tf/CMDMT_TF ou defaults.context.tf.");
    const { params, rest: rest2 } = parseParamsTokens(remaining);
    const { sub: subw, rest: rest3 } = parseSub(rest2, ctx);
    const name = rest3.join(" ");
    if (!name) return err("uso: indicador [TF] NOME [sub=N] [k=v ...]");
    const payload = [symbol, tf, name, subw];
    if (params) payload.push(params);
    return { kind: "send", type: "ATTACH_IND_FULL", params: payload };
  }

  if (cmd === "chart") {
    if (rest.length === 0) return err("uso: chart <open|close|list|closeall|redraw|detachall|find>");
    const sub = rest[0].toLowerCase();
    const args = rest.slice(1);
    if (sub === "list") return { kind: "send", type: "LIST_CHARTS", params: [] };
    if (sub === "closeall") return { kind: "send", type: "CLOSE_ALL", params: [] };
    if (sub === "open") {
      const r = resolveSymTf(args, ctx, false);
      if (!r || !r.sym || !r.tf) return err("uso: chart open [SYMBOL TF]");
      return { kind: "send", type: "OPEN_CHART", params: [r.sym, r.tf] };
    }
    if (sub === "close") {
      const r = resolveSymTf(args, ctx, false);
      if (!r || !r.sym || !r.tf) return err("uso: chart close [SYMBOL TF]");
      return { kind: "send", type: "CLOSE_CHART", params: [r.sym, r.tf] };
    }
    if (sub === "redraw") {
      const r = resolveSymTf(args, ctx, false);
      if (!r || !r.sym || !r.tf) return err("uso: chart redraw [SYMBOL TF]");
      return { kind: "send", type: "REDRAW_CHART", params: [r.sym, r.tf] };
    }
    if (sub === "detachall") {
      const r = resolveSymTf(args, ctx, false);
      if (!r || !r.sym || !r.tf) return err("uso: chart detachall [SYMBOL TF]");
      return { kind: "send", type: "DETACH_ALL", params: [r.sym, r.tf] };
    }
    if (sub === "find") {
      const r = resolveSymTf(args, ctx, false);
      if (!r || !r.sym || !r.tf || r.rest.length < 1) return err("uso: chart find [SYMBOL TF] NAME");
      return { kind: "send", type: "WINDOW_FIND", params: [r.sym, r.tf, r.rest.join(" ")] };
    }
  }

  if (cmd === "template") {
    if (rest.length === 0) return err("uso: template <apply|save|saveea|savechart>");
    const sub = rest[0].toLowerCase();
    const args = rest.slice(1);
    if (sub === "apply") {
      const r = resolveSymTf(args, ctx, false);
      if (!r || !r.sym || !r.tf || r.rest.length < 1) return err("uso: template apply [SYMBOL TF] TEMPLATE");
      return { kind: "send", type: "APPLY_TPL", params: [r.sym, r.tf, r.rest.join(" ")] };
    }
    if (sub === "save") {
      const r = resolveSymTf(args, ctx, false);
      if (!r || !r.sym || !r.tf || r.rest.length < 1) return err("uso: template save [SYMBOL TF] TEMPLATE");
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
      const r = resolveSymTf(args, ctx, false);
      if (!r || !r.sym || !r.tf || r.rest.length < 1)
        return err("uso: indicator attach [SYMBOL TF] NAME [SUB|sub=N] [k=v ...]");
      const { params, rest: rest2 } = parseParamsTokens(r.rest);
      const { sub: subw, rest: rest3 } = parseSub(rest2, ctx);
      const name = rest3.join(" ");
      const payload = [r.sym, r.tf, name, subw];
      if (params) payload.push(params);
      return { kind: "send", type: "ATTACH_IND_FULL", params: payload };
    }
    if (sub === "detach") {
      const r = resolveSymTf(args, ctx, false);
      if (!r || !r.sym || !r.tf || r.rest.length < 1)
        return err("uso: indicator detach [SYMBOL TF] NAME [SUB|sub=N]");
      const { sub: subw, rest: rest2 } = parseSub(r.rest, ctx);
      const name = rest2.join(" ");
      return { kind: "send", type: "DETACH_IND_FULL", params: [r.sym, r.tf, name, subw] };
    }
    if (sub === "total") {
      const r = resolveSymTf(args, ctx, false);
      if (!r || !r.sym || !r.tf) return err("uso: indicator total [SYMBOL TF] [SUB]");
      const { sub: subw, rest: rest2 } = parseSub(r.rest, ctx);
      if (rest2.length) {
        // allow explicit sub as arg
        return { kind: "send", type: "IND_TOTAL", params: [r.sym, r.tf, rest2[0]] };
      }
      return { kind: "send", type: "IND_TOTAL", params: [r.sym, r.tf, subw] };
    }
    if (sub === "name" || sub === "handle" || sub === "get") {
      const r = resolveSymTf(args, ctx, false);
      if (!r || !r.sym || !r.tf || r.rest.length < 1)
        return err(`uso: indicator ${sub} [SYMBOL TF] NAME|INDEX [SUB]`);
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
      let symbol = ctx.symbol?.trim();
      let tf = ctx.tf?.trim();
      let restArgs = [...args];
      if (restArgs.length >= 2 && isTf(restArgs[1])) {
        symbol = restArgs[0];
        tf = restArgs[1];
        restArgs = restArgs.slice(2);
      } else if (restArgs.length >= 1 && isTf(restArgs[0])) {
        tf = restArgs[0];
        restArgs = restArgs.slice(1);
      }
      if (!symbol) return err("symbol default ausente. Use --symbol/CMDMT_SYMBOL ou defaults.context.symbol.");
      if (!tf) return err("tf default ausente. Use --tf/CMDMT_TF ou defaults.context.tf.");
      let baseTpl = requireBaseTpl(ctx) ?? "";
      const tplIdx = restArgs.findIndex((t) => t.toLowerCase().endsWith(".tpl"));
      if (tplIdx >= 0) {
        baseTpl = restArgs[tplIdx];
        restArgs.splice(tplIdx, 1);
      }
      const { params, rest: rest2 } = parseParamsTokens(restArgs);
      const name = rest2.join(" ");
      if (!name) return err("uso: expert run [TF] NOME [BASE_TPL] [k=v ...]");
      const spec: TestSpec = { expert: name, symbol, tf, params, oneShot: true, baseTpl };
      return { kind: "test", spec };
    }
    if (sub === "test") {
      let symbol = ctx.symbol?.trim();
      let tf = ctx.tf?.trim();
      let restArgs = [...args];
      if (restArgs.length >= 2 && isTf(restArgs[1])) {
        symbol = restArgs[0];
        tf = restArgs[1];
        restArgs = restArgs.slice(2);
      } else if (restArgs.length >= 1 && isTf(restArgs[0])) {
        tf = restArgs[0];
        restArgs = restArgs.slice(1);
      }
      if (!symbol) return err("symbol default ausente. Use --symbol/CMDMT_SYMBOL ou defaults.context.symbol.");
      if (!tf) return err("tf default ausente. Use --tf/CMDMT_TF ou defaults.context.tf.");
      const { params, rest: rest2 } = parseParamsTokens(restArgs);
      const name = rest2.join(" ");
      if (!name) return err("uso: expert test [TF] NOME [k=v ...]");
      const spec: TestSpec = { expert: name, symbol, tf, params };
      return { kind: "test", spec };
    }
    if (sub === "oneshot") {
      const symbol = requireDefaultSymbol(ctx);
      if (!symbol) return err("symbol default ausente. Use --symbol/CMDMT_SYMBOL ou defaults.context.symbol.");
      if (args.length < 2 || !isTf(args[0])) return err("uso: expert oneshot TF NOME [BASE_TPL] [k=v ...]");
      const tf = args[0];
      const restArgs = args.slice(1);
      let baseTpl = requireBaseTpl(ctx) ?? "";
      const tplIdx = restArgs.findIndex((t) => t.toLowerCase().endsWith(".tpl"));
      if (tplIdx >= 0) {
        baseTpl = restArgs[tplIdx];
        restArgs.splice(tplIdx, 1);
      }
      if (!baseTpl) return err("base template ausente. Use --base-tpl/CMDMT_BASE_TPL ou defaults.baseTpl.");
      const { params, rest: rest2 } = parseParamsTokens(restArgs);
      const name = rest2.join(" ");
      if (!name) return err("uso: expert oneshot TF NOME [BASE_TPL] [k=v ...]");
      const spec: TestSpec = { expert: name, symbol, tf, params, oneShot: true, baseTpl };
      return { kind: "test", spec };
    }
    if (sub === "attach") {
      const r = resolveSymTf(args, ctx, false);
      if (!r || !r.sym || !r.tf || r.rest.length < 1)
        return err("uso: expert attach [SYMBOL TF] NAME [BASE_TPL] [k=v ...]");
      const name = r.rest[0];
      const rest2 = r.rest.slice(1);
      let baseTpl = "";
      const tplIdx = rest2.findIndex((t) => t.toLowerCase().endsWith(".tpl"));
      if (tplIdx >= 0) {
        baseTpl = rest2[tplIdx];
        rest2.splice(tplIdx, 1);
      }
      const params = rest2.length ? rest2.join(";") : "";
      const payload = [r.sym, r.tf, name];
      if (baseTpl) payload.push(baseTpl);
      if (params) payload.push(params);
      return { kind: "send", type: "ATTACH_EA_FULL", params: payload };
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
