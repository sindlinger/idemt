import fs from "node:fs";
import path from "node:path";
import { Ctx, isTf, parseSub, resolveSymTf } from "./args.js";
import { renderHelp, renderExamples } from "./help.js";
import { formatAutoList, parseAutoCodes, normalizeAutoMacroName, resolveAutoCodes } from "./auto.js";
import { safeFileBase, stableHash } from "./naming.js";
import type { TestSpec } from "./tester.js";
import type { AttachMeta } from "./attach_report.js";
import type { CsvImportSpec } from "./data_import.js";
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
  | { kind: "diag"; target: "indicator" | "expert"; name: string }
  | { kind: "log"; tail: number }
  | { kind: "hotkey"; action: "list" | "set" | "del" | "clear"; key?: string; value?: string }
  | { kind: "test"; spec: TestSpec }
  | {
      kind: "doctor";
      dataPath?: string;
      apply?: boolean;
      allowDll?: boolean;
      allowLive?: boolean;
      syncCommon?: boolean;
      web?: string[];
      repoPath?: string;
      name?: string;
      namePrefix?: string;
      mirrorFrom?: string;
      mirrorDirs?: string[];
    }
  | { kind: "install"; dataPath: string; allowDll?: boolean; allowLive?: boolean; syncCommon?: boolean; web?: string[]; dryRun?: boolean; repoPath?: string; name?: string; namePrefix?: string; mirrorFrom?: string; mirrorDirs?: string[] }
  | {
      kind: "data_import";
      mode: "rates" | "ticks";
      csv: string;
      symbol: string;
      tf?: string;
      base?: string;
      digits?: number;
      spread?: number;
      tz?: number;
      sep?: string;
      recreate?: boolean;
      common?: boolean;
    };


function err(msg: string): DispatchResult {
  return { kind: "error", message: msg };
}

const PARAMS_HINT = "params devem ser passados com --params k=v ... (ex: --params depth=12 deviation=5)";
const DEFAULT_SYMBOL = "EURUSD";
const DEFAULT_TF = "M5";

function parseKindFlags(args: string[]): { kind?: "indicator" | "expert"; rest: string[] } {
  let kind: "indicator" | "expert" | undefined;
  const rest: string[] = [];
  for (const tok of args) {
    const low = tok.toLowerCase();
    if (low === "--ind" || low === "-i") {
      kind = "indicator";
      continue;
    }
    if (low === "--exp" || low === "-e") {
      kind = "expert";
      continue;
    }
    rest.push(tok);
  }
  return { kind, rest };
}

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

function parseCsvFlags(tokens: string[]): { csv?: CsvImportSpec; rest: string[] } {
  let csv: CsvImportSpec | undefined;
  const rest: string[] = [];

  const readValue = (tok: string, i: number): { value: string; skip: number } => {
    if (tok.includes("=")) {
      return { value: tok.slice(tok.indexOf("=") + 1), skip: 0 };
    }
    if (i + 1 < tokens.length && !tokens[i + 1].startsWith("--")) {
      return { value: tokens[i + 1], skip: 1 };
    }
    return { value: "", skip: 0 };
  };

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const lower = tok.toLowerCase();

    if (lower === "--csv-rates" || lower.startsWith("--csv-rates=")) {
      const { value, skip } = readValue(tok, i);
      i += skip;
      csv = { mode: "rates", csv: value, symbol: "" };
      continue;
    }
    if (lower === "--csv-ticks" || lower.startsWith("--csv-ticks=")) {
      const { value, skip } = readValue(tok, i);
      i += skip;
      csv = { mode: "ticks", csv: value, symbol: "" };
      continue;
    }
    if (lower === "--csv-symbol" || lower.startsWith("--csv-symbol=")) {
      const { value, skip } = readValue(tok, i);
      i += skip;
      csv = csv ?? { mode: "rates", csv: "", symbol: "" };
      csv.symbol = value;
      continue;
    }
    if (lower === "--csv-tf" || lower.startsWith("--csv-tf=")) {
      const { value, skip } = readValue(tok, i);
      i += skip;
      csv = csv ?? { mode: "rates", csv: "", symbol: "" };
      csv.tf = value;
      continue;
    }
    if (lower === "--csv-base" || lower.startsWith("--csv-base=")) {
      const { value, skip } = readValue(tok, i);
      i += skip;
      csv = csv ?? { mode: "rates", csv: "", symbol: "" };
      csv.base = value;
      continue;
    }
    if (lower === "--csv-digits" || lower.startsWith("--csv-digits=")) {
      const { value, skip } = readValue(tok, i);
      i += skip;
      const n = parseIntFlag(value, 0, 12);
      csv = csv ?? { mode: "rates", csv: "", symbol: "" };
      if (n !== null) csv.digits = n;
      continue;
    }
    if (lower === "--csv-spread" || lower.startsWith("--csv-spread=")) {
      const { value, skip } = readValue(tok, i);
      i += skip;
      const n = parseIntFlag(value, 0, 1000000);
      csv = csv ?? { mode: "rates", csv: "", symbol: "" };
      if (n !== null) csv.spread = n;
      continue;
    }
    if (lower === "--csv-tz" || lower.startsWith("--csv-tz=")) {
      const { value, skip } = readValue(tok, i);
      i += skip;
      const n = parseIntFlag(value, -24, 24);
      csv = csv ?? { mode: "rates", csv: "", symbol: "" };
      if (n !== null) csv.tz = n;
      continue;
    }
    if (lower === "--csv-sep" || lower.startsWith("--csv-sep=")) {
      const { value, skip } = readValue(tok, i);
      i += skip;
      csv = csv ?? { mode: "rates", csv: "", symbol: "" };
      csv.sep = value;
      continue;
    }
    if (lower === "--csv-recreate") {
      csv = csv ?? { mode: "rates", csv: "", symbol: "" };
      csv.recreate = true;
      continue;
    }
    if (lower === "--csv-common") {
      csv = csv ?? { mode: "rates", csv: "", symbol: "" };
      csv.common = true;
      continue;
    }

    rest.push(tok);
  }
  return { csv, rest };
}

function extractFlagValue(tokens: string[], name: string): { value?: string; rest: string[] } {
  const rest: string[] = [];
  let value: string | undefined;
  const flag = `--${name}`;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const low = tok.toLowerCase();
    if (low === flag) {
      const next = tokens[i + 1];
      if (next && !next.startsWith("--")) {
        value = next;
        i += 1;
      } else {
        value = "";
      }
      continue;
    }
    if (low.startsWith(`${flag}=`)) {
      value = tok.slice(flag.length + 1);
      continue;
    }
    rest.push(tok);
  }
  return { value, rest };
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

function parseInstallArgs(tokens: string[]): { dataPath: string; allowDll?: boolean; allowLive?: boolean; syncCommon?: boolean; web?: string[]; dryRun?: boolean; repoPath?: string; name?: string; namePrefix?: string; mirrorFrom?: string; mirrorDirs?: string[] } | null {
  let allowDll: boolean | undefined = undefined;
  let allowLive: boolean | undefined = undefined;
  let syncCommon: boolean | undefined = undefined;
  let dryRun: boolean | undefined = undefined;
  let repoPath: string | undefined = undefined;
  let name: string | undefined = undefined;
  let namePrefix: string | undefined = undefined;
  let mirrorFrom: string | undefined = undefined;
  let mirrorDirs: string[] | undefined = undefined;
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
    if (lower === "--sync-common") {
      syncCommon = true;
      continue;
    }
    if (lower === "--no-sync-common") {
      syncCommon = false;
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
    if (lower === "--mirror-from" || lower.startsWith("--mirror-from=")) {
      let val = lower.includes("=") ? tok.slice(tok.indexOf("=") + 1) : "";
      if (!val && i + 1 < tokens.length && !tokens[i + 1].startsWith("--")) {
        val = tokens[i + 1];
        i += 1;
      }
      if (val) mirrorFrom = val;
      continue;
    }
    if (lower === "--mirror-dirs" || lower.startsWith("--mirror-dirs=")) {
      let val = lower.includes("=") ? tok.slice(tok.indexOf("=") + 1) : "";
      if (!val && i + 1 < tokens.length && !tokens[i + 1].startsWith("--")) {
        val = tokens[i + 1];
        i += 1;
      }
      if (val) {
        mirrorDirs = val.split(",").map((v) => v.trim()).filter(Boolean);
      }
      continue;
    }
    rest.push(tok);
  }

  if (!rest.length) return null;
  const dataPath = rest.join(" ");
  return { dataPath, allowDll, allowLive, syncCommon, web, dryRun, repoPath, name, namePrefix, mirrorFrom, mirrorDirs };
}

function parseDoctorArgs(tokens: string[]): { dataPath?: string; apply?: boolean; allowDll?: boolean; allowLive?: boolean; syncCommon?: boolean; web?: string[]; repoPath?: string; name?: string; namePrefix?: string; mirrorFrom?: string; mirrorDirs?: string[] } | null {
  let allowDll: boolean | undefined = undefined;
  let allowLive: boolean | undefined = undefined;
  let syncCommon: boolean | undefined = undefined;
  let apply: boolean | undefined = undefined;
  let repoPath: string | undefined = undefined;
  let name: string | undefined = undefined;
  let namePrefix: string | undefined = undefined;
  let mirrorFrom: string | undefined = undefined;
  let mirrorDirs: string[] | undefined = undefined;
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
    if (lower === "--sync-common") {
      syncCommon = true;
      continue;
    }
    if (lower === "--no-sync-common") {
      syncCommon = false;
      continue;
    }
    if (lower === "--apply") {
      apply = true;
      continue;
    }
    if (lower === "--dry-run") {
      apply = false;
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
    if (lower === "--mirror-from" || lower.startsWith("--mirror-from=")) {
      let val = lower.includes("=") ? tok.slice(tok.indexOf("=") + 1) : "";
      if (!val && i + 1 < tokens.length && !tokens[i + 1].startsWith("--")) {
        val = tokens[i + 1];
        i += 1;
      }
      if (val) mirrorFrom = val;
      continue;
    }
    if (lower === "--mirror-dirs" || lower.startsWith("--mirror-dirs=")) {
      let val = lower.includes("=") ? tok.slice(tok.indexOf("=") + 1) : "";
      if (!val && i + 1 < tokens.length && !tokens[i + 1].startsWith("--")) {
        val = tokens[i + 1];
        i += 1;
      }
      if (val) {
        mirrorDirs = val.split(",").map((v) => v.trim()).filter(Boolean);
      }
      continue;
    }
    rest.push(tok);
  }

  const dataPath = rest.length ? rest.join(" ") : undefined;
  return { dataPath, apply, allowDll, allowLive, syncCommon, web, repoPath, name, namePrefix, mirrorFrom, mirrorDirs };
}

export function dispatch(tokens: string[], ctx: Ctx): DispatchResult {
  if (tokens.length === 0) return { kind: "local", output: renderHelp().join("\n") };
  const macros = ctx.autoMacros ?? (ctx.autoMacros = {});
  const firstRaw = tokens[0];
  if (firstRaw && firstRaw.startsWith("@")) {
    const output = formatAutoList(tokens, macros);
    return { kind: "local", output };
  }
  const cmd = tokens[0].toLowerCase();
  const rest = tokens.slice(1);

  if (cmd === "help") {
    return { kind: "local", output: renderHelp().join("\n") };
  }
  if (cmd === "examples") {
    const key = rest.join(" ").trim();
    return { kind: "local", output: renderExamples(key) };
  }
  if (cmd === "watch") {
    if (!rest.length) {
      if (ctx.watchKind && ctx.watchName) {
        return { kind: "local", output: `watching: ${ctx.watchKind} ${ctx.watchName}` };
      }
      return { kind: "local", output: "watching: (none)" };
    }
    const { kind, rest: r2 } = parseKindFlags(rest);
    if (r2.length && r2[0].toLowerCase() === "clear") {
      ctx.watchKind = undefined;
      ctx.watchName = undefined;
      return { kind: "local", output: "watching: (none)" };
    }
    if (!kind) return err("uso: watch -i NOME | watch -e NOME | watch clear");
    const name = r2.join(" ").trim();
    if (!name) return err("uso: watch -i NOME | watch -e NOME | watch clear");
    ctx.watchKind = kind;
    ctx.watchName = name;
    return { kind: "local", output: `watching: ${kind} ${name}` };
  }
  if (cmd === "auto") {
    const sub = rest[0]?.toLowerCase();

    const listCodes = (tokens: string[]) => {
      const { value: codeVal, rest: afterCode } = extractFlagValue(tokens, "code");
      const tailCodes = afterCode.filter((t) => !t.startsWith("--"));
      const codes = [
        ...parseAutoCodes(codeVal),
        ...tailCodes.flatMap((t) => parseAutoCodes(t))
      ];
      const output = formatAutoList(codes.length ? codes : undefined, macros);
      return { kind: "local", output } as DispatchResult;
    };

    if (!sub || sub === "ls" || sub.startsWith("--")) {
      const args = sub === "ls" ? rest.slice(1) : rest;
      return listCodes(args);
    }
    if (sub === "add") {
      const args = rest.slice(1);
      const { value: nameVal, rest: afterName } = extractFlagValue(args, "name");
      const { value: codeVal, rest: afterCode } = extractFlagValue(afterName, "code");
      const name = normalizeAutoMacroName(nameVal ?? "");
      const codesRaw = codeVal ? parseAutoCodes(codeVal) : afterCode.flatMap((t) => parseAutoCodes(t));
      if (!name) return err("uso: auto add --code C1,C2 --name @macro");
      if (!codesRaw.length) return err("uso: auto add --code C1,C2 --name @macro");
      const resolved = resolveAutoCodes(codesRaw, macros);
      if (!resolved.codes.length) {
        return err(`auto: nenhum codigo valido (${resolved.unknown.join(", ")})`);
      }
      macros[name] = resolved.codes;
      const suffix = resolved.unknown.length ? ` (ignored: ${resolved.unknown.join(", ")})` : "";
      return { kind: "local", output: `ok ${name} = ${macros[name].join(",")}${suffix}` };
    }
    if (sub === "rm" || sub === "remove" || sub === "rl" || sub === "del") {
      const args = rest.slice(1);
      const { value: nameVal, rest: afterName } = extractFlagValue(args, "name");
      const name = normalizeAutoMacroName(nameVal ?? afterName.join(" "));
      if (!name) return err("uso: auto rm --name @macro");
      if (!macros[name]) return err(`auto: macro nao encontrada: ${name}`);
      delete macros[name];
      return { kind: "local", output: `ok removed ${name}` };
    }
    if (sub === "show" || sub.startsWith("@")) {
      const name = normalizeAutoMacroName(sub === "show" ? rest[1] ?? "" : rest[0] ?? "");
      if (!name) return err("uso: auto show @macro");
      if (!macros[name]) return err(`auto: macro nao encontrada: ${name}`);
      return { kind: "local", output: formatAutoList([name], macros) };
    }
    return listCodes(rest);
  }
  if (cmd === "add") {
    const { kind: kindFlag, rest: restArgs } = parseKindFlags(rest);
    const kind = kindFlag ?? ctx.watchKind;
    if (!kind) return err("uso: add -i NOME | add -e NOME");
    if (kind === "indicator") {
      const r = parseSymTfDefault(restArgs, ctx);
      const { params, rest: rest2, meta } = parseParamsAndMeta(r.rest);
      const { sub: subw, rest: rest3 } = parseSub(rest2, ctx);
      if (!params && hasImplicitParams(rest3)) {
        return err(PARAMS_HINT);
      }
      let name = rest3.join(" ").trim();
      if (!name && ctx.watchKind === "indicator") name = ctx.watchName ?? "";
      if (!name) return err("uso: add -i NOME [SYMBOL TF] [sub=N] [--params k=v ...]");
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
    const r = parseSymTfDefault(restArgs, ctx);
    const { params, rest: rest2, meta } = parseParamsAndMeta(r.rest);
    let name = rest2.join(" ").trim();
    if (!name && ctx.watchKind === "expert") name = ctx.watchName ?? "";
    if (!name) return err("uso: add -e NOME [SYMBOL TF] [BASE_TPL] [--params k=v ...]");
    let baseTpl = "";
    const tplIdx = rest2.findIndex((t) => t.toLowerCase().endsWith(".tpl"));
    if (tplIdx >= 0) baseTpl = rest2[tplIdx];
    if (!baseTpl && ctx.baseTpl) baseTpl = ctx.baseTpl;
    if (!baseTpl) return err("base template nao definido. Use --base-tpl ou baseTpl no config.");
    const hash = stableHash(`${name}|${r.sym}|${r.tf}|${params}`);
    const outTpl = `cmdmt_ea_${hash}.tpl`;
    const saveParams = [name, outTpl, baseTpl];
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
  if (cmd === "rm") {
    const { kind: kindFlag, rest: restArgs } = parseKindFlags(rest);
    const kind = kindFlag ?? ctx.watchKind;
    if (!kind) return err("uso: rm -i NOME|INDEX | rm -e [SYMBOL TF]");
    if (kind === "indicator") {
      const r = parseSymTfDefault(restArgs, ctx);
      const hasExplicitSub = r.rest.some((t) => {
        const low = t.toLowerCase();
        if (low.startsWith("sub=")) return true;
        if ((t.startsWith("#") || t.startsWith("@")) && /^\d+$/.test(t.slice(1))) return true;
        return false;
      });
      const subParsed = hasExplicitSub ? parseSub(r.rest, ctx) : { sub: String(ctx.sub ?? 1), rest: r.rest };
      const { sub: subw, rest: rest2 } = subParsed;
      let name = rest2.join(" ").trim();
      if (!name && ctx.watchKind === "indicator") name = ctx.watchName ?? "";
      if (!name) return err("uso: rm -i NOME|INDEX [SYMBOL TF] [sub=N]");
      if (/^\d+$/.test(name)) {
        return { kind: "ind_detach_index", sym: r.sym, tf: r.tf, sub: subw, index: parseInt(name, 10) };
      }
      return { kind: "send", type: "DETACH_IND_FULL", params: [r.sym, r.tf, name, subw] };
    }
    const r = resolveSymTf(restArgs, ctx, false);
    if (!r || !r.sym || !r.tf) return err("uso: rm -e [SYMBOL TF]");
    return { kind: "send", type: "DETACH_EA_FULL", params: [r.sym, r.tf] };
  }
  if (cmd === "inspect") {
    const { kind: kindFlag, rest: restArgs } = parseKindFlags(rest);
    const kind = kindFlag ?? ctx.watchKind;
    if (!kind) return err("uso: inspect -i <total|name|handle|get|release> ... | inspect -e [find] NOME");
    if (kind === "expert") {
      const sub = restArgs[0]?.toLowerCase() ?? "";
      const name = (sub === "find" ? restArgs.slice(1) : restArgs).join(" ").trim() || (ctx.watchKind === "expert" ? ctx.watchName ?? "" : "");
      if (!name) return err("uso: inspect -e [find] NOME");
      return { kind: "send", type: "FIND_EA", params: [name] };
    }
    const subRaw = restArgs[0]?.toLowerCase() ?? "";
    const known = ["total", "name", "handle", "get", "release"];
    const sub = known.includes(subRaw) ? subRaw : "get";
    const args = known.includes(subRaw) ? restArgs.slice(1) : restArgs;
    if (sub === "release") {
      if (!args.length) return err("uso: inspect -i release HANDLE");
      return { kind: "send", type: "IND_RELEASE", params: [args[0]] };
    }
    if (sub === "total") {
      const r = parseSymTfDefault(args, ctx);
      const { sub: subw, rest: rest2 } = parseSub(r.rest, ctx);
      if (rest2.length) {
        return { kind: "send", type: "IND_TOTAL", params: [r.sym, r.tf, rest2[0]] };
      }
      return { kind: "send", type: "IND_TOTAL", params: [r.sym, r.tf, subw] };
    }
    const r = parseSymTfDefault(args, ctx);
    const { sub: subw, rest: rest2 } = parseSub(r.rest, ctx);
    let name = rest2.join(" ").trim();
    if (!name && ctx.watchKind === "indicator") name = ctx.watchName ?? "";
    if (!name) return err(`uso: inspect -i ${sub} [SYMBOL TF] NAME|INDEX [sub=N]`);
    const type = sub === "name" ? "IND_NAME" : sub === "handle" ? "IND_HANDLE" : "IND_GET";
    return { kind: "send", type, params: [r.sym, r.tf, subw, name] };
  }
  if (cmd === "debug") {
    const { kind, rest: restArgs } = parseKindFlags(rest);
    if (kind) {
      let name = restArgs.join(" ").trim();
      if (!name && ctx.watchKind === kind) name = ctx.watchName ?? "";
      if (!name) return err("uso: debug -i NOME | debug -e NOME");
      return { kind: "diag", target: kind, name };
    }
    if (!rest.length) return err("uso: debug MSG | debug -i NOME | debug -e NOME");
    return { kind: "send", type: "DEBUG_MSG", params: [rest.join(" ")] };
  }
  if (cmd === "log") {
    let tail = 200;
    const idx = rest.findIndex((t) => t.startsWith("--tail"));
    if (idx >= 0) {
      const tok = rest[idx];
      const val = tok.includes("=") ? tok.split("=")[1] : rest[idx + 1];
      const num = parseInt(val ?? "", 10);
      if (Number.isFinite(num)) tail = num;
    } else if (rest.length && /^\d+$/.test(rest[0])) {
      tail = parseInt(rest[0], 10);
    }
    return { kind: "log", tail };
  }
  if (cmd === "hotkey") {
    const sub = rest[0]?.toLowerCase() ?? "list";
    if (sub === "list") return { kind: "hotkey", action: "list" };
    if (sub === "clear") return { kind: "hotkey", action: "clear" };
    if (sub === "set") {
      const args = rest.slice(1);
      if (!args.length) return err("uso: hotkey set TECLA COMANDO");
      let key = "";
      let value = "";
      if (args[0].includes("=")) {
        const idx = args[0].indexOf("=");
        key = args[0].slice(0, idx);
        value = args[0].slice(idx + 1);
        if (!value && args.length > 1) value = args.slice(1).join(" ");
      } else {
        key = args[0];
        value = args.slice(1).join(" ");
      }
      if (!key || !value) return err("uso: hotkey set TECLA COMANDO");
      return { kind: "hotkey", action: "set", key, value };
    }
    if (sub === "del") {
      const key = rest.slice(1).join(" ").trim();
      if (!key) return err("uso: hotkey del TECLA");
      return { kind: "hotkey", action: "del", key };
    }
    return err("uso: hotkey <list|set|del|clear>");
  }
  if (cmd === "quit") {
    return { kind: "exit" };
  }
  if (cmd === "install") {
    const parsed = parseInstallArgs(rest);
    if (!parsed) {
    return err("uso: install <MT5_DATA> [--name NOME] [--name-prefix PREFIX] [--allow-dll|--no-allow-dll] [--allow-live|--no-allow-live] [--sync-common|--no-sync-common] [--web URL] [--dry-run] [--repo PATH] [--mirror-from PATH] [--mirror-dirs a,b,c]");
  }
    return { kind: "install", ...parsed };
  }
  if (cmd === "doctor") {
    const parsed = parseDoctorArgs(rest);
    if (!parsed) {
      return err("uso: doctor [MT5_DATA] [--apply|--dry-run] [--name NOME] [--name-prefix PREFIX] [--allow-dll|--no-allow-dll] [--allow-live|--no-allow-live] [--sync-common|--no-sync-common] [--web URL] [--repo PATH] [--mirror-from PATH] [--mirror-dirs a,b,c]");
    }
    return { kind: "doctor", ...parsed };
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
  if (cmd === "open") {
    const r = parseSymTfDefault(rest, ctx);
    return { kind: "send", type: "OPEN_CHART", params: [r.sym, r.tf] };
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

  if (cmd === "expert") {
    if (rest.length === 0) return err("uso: expert <find|run|test|oneshot>");
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
      const { csv, rest: restCsv } = parseCsvFlags(restArgs);
      const { params, rest: rest2 } = parseParamsAndMeta(restCsv);
      if (!params && hasImplicitParams(rest2)) {
        return err(PARAMS_HINT);
      }
      const name = rest2.join(" ");
      if (!name) return err("uso: expert run [TF] NOME [BASE_TPL] [--params k=v ...]");
      if (csv) {
        if (!csv.csv) return err("uso: --csv-rates/--csv-ticks exige caminho do CSV");
        if (!csv.symbol) csv.symbol = symbol;
        if (csv.mode === "rates" && !csv.tf) csv.tf = tf;
      }
      const spec: TestSpec = { expert: name, symbol, tf, params, oneShot: true, baseTpl, csv };
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
      const { csv, rest: restCsv } = parseCsvFlags(restArgs);
      const { params, rest: rest2 } = parseParamsAndMeta(restCsv);
      if (!params && hasImplicitParams(rest2)) {
        return err(PARAMS_HINT);
      }
      const name = rest2.join(" ");
      if (!name) return err("uso: expert test [TF] NOME [--params k=v ...]");
      if (csv) {
        if (!csv.csv) return err("uso: --csv-rates/--csv-ticks exige caminho do CSV");
        if (!csv.symbol) csv.symbol = symbol;
        if (csv.mode === "rates" && !csv.tf) csv.tf = tf;
      }
      const spec: TestSpec = { expert: name, symbol, tf, params, csv };
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
      const { csv, rest: restCsv } = parseCsvFlags(restArgs);
      const { params, rest: rest2 } = parseParamsAndMeta(restCsv);
      if (!params && hasImplicitParams(rest2)) {
        return err(PARAMS_HINT);
      }
      const name = rest2.join(" ");
      if (!name) return err("uso: expert oneshot TF NOME [BASE_TPL] [--params k=v ...]");
      if (csv) {
        if (!csv.csv) return err("uso: --csv-rates/--csv-ticks exige caminho do CSV");
        if (!csv.symbol) csv.symbol = symbol;
        if (csv.mode === "rates" && !csv.tf) csv.tf = tf;
      }
      const spec: TestSpec = { expert: name, symbol, tf, params, oneShot: true, baseTpl, csv };
      return { kind: "test", spec };
    }
    return err("uso: expert <find|run|test|oneshot>");
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

  if (cmd === "data") {
    if (rest.length === 0) return err("uso: data import <rates|ticks> CSV SYMBOL [TF] [--base SYM] [--digits N] [--spread N] [--tz H] [--sep auto|tab|comma|semicolon] [--common] [--recreate|--no-recreate]");
    const sub = rest[0].toLowerCase();
    const args = rest.slice(1);
    if (sub === "import") {
      if (args.length < 3) return err("uso: data import <rates|ticks> CSV SYMBOL [TF] [--base SYM] [--digits N] [--spread N] [--tz H] [--sep auto|tab|comma|semicolon] [--common] [--recreate|--no-recreate]");
      const mode = args[0].toLowerCase();
      if (mode !== "rates" && mode !== "ticks") return err("modo invalido. use rates ou ticks");
      let i = 1;
      const csv = args[i++] ?? "";
      const symbol = args[i++] ?? "";
      if (!csv || !symbol) return err("uso: data import <rates|ticks> CSV SYMBOL [TF] ...");
      let tf = "";
      if (mode === "rates" && i < args.length && isTf(args[i])) {
        tf = args[i];
        i++;
      }
      let base: string | undefined;
      let digits: number | undefined;
      let spread: number | undefined;
      let tz: number | undefined;
      let sep: string | undefined;
      let recreate = true;
      let common = false;
      for (; i < args.length; i++) {
        const tok = args[i];
        const lower = tok.toLowerCase();
        if (lower === "--common") { common = true; continue; }
        if (lower === "--no-common") { common = false; continue; }
        if (lower === "--recreate") { recreate = true; continue; }
        if (lower === "--no-recreate") { recreate = false; continue; }
        const eq = tok.indexOf("=");
        const key = (eq >= 0 ? tok.slice(0, eq) : tok).toLowerCase();
        let val = eq >= 0 ? tok.slice(eq + 1) : "";
        if (!val && i + 1 < args.length && !args[i + 1].startsWith("--")) {
          val = args[i + 1];
          i++;
        }
        if (key === "--base") base = val;
        else if (key === "--digits") digits = parseInt(val, 10);
        else if (key === "--spread") spread = parseInt(val, 10);
        else if (key === "--tz") tz = parseInt(val, 10);
        else if (key === "--sep") sep = val;
      }
      return {
        kind: "data_import",
        mode: mode as "rates" | "ticks",
        csv,
        symbol,
        tf: tf || undefined,
        base,
        digits: Number.isFinite(digits as number) ? digits : undefined,
        spread: Number.isFinite(spread as number) ? spread : undefined,
        tz: Number.isFinite(tz as number) ? tz : undefined,
        sep,
        recreate,
        common
      };
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
