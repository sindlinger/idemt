import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { isWsl, toWslPath, toWindowsPath } from "./config.js";

export type InstallSpec = {
  dataPath?: string;
  repoPath?: string;
  allowDll: boolean;
  allowLive: boolean;
  web: string[];
  dryRun: boolean;
};

type TextEncoding = "utf16le" | "utf8";

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
    const candidate = path.join(dir, "services", "telnetmt", "Services");
    if (fs.existsSync(candidate)) return path.join(dir, "services", "telnetmt");
    const alt = path.join(dir, "telnetmt", "Services");
    if (fs.existsSync(alt)) return path.join(dir, "telnetmt");
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function readTextWithEncoding(filePath: string): { text: string; encoding: TextEncoding; bom: boolean } {
  const buf = fs.readFileSync(filePath);
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: buf.slice(2).toString("utf16le"), encoding: "utf16le", bom: true };
  }
  return { text: buf.toString("utf8"), encoding: "utf8", bom: false };
}

function writeTextWithEncoding(filePath: string, text: string, encoding: TextEncoding, bom: boolean) {
  if (encoding === "utf16le") {
    const prefix = bom ? Buffer.from([0xff, 0xfe]) : Buffer.alloc(0);
    const body = Buffer.from(text, "utf16le");
    fs.writeFileSync(filePath, Buffer.concat([prefix, body]));
    return;
  }
  fs.writeFileSync(filePath, text, "utf8");
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
    if (next !== text) writeTextWithEncoding(commonPath, next, encoding, bom);
    log.push(`common.ini atualizado: AllowDllImport=${spec.allowDll ? 1 : 0}, AllowLiveTrading=${spec.allowLive ? 1 : 0}`);
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

function runPowerShell(script: string): { ok: boolean; out: string } {
  const res = spawnSync("powershell.exe", ["-NoProfile", "-Command", script], { encoding: "utf8" });
  const out = `${res.stdout || ""}${res.stderr || ""}`.trim();
  return { ok: res.status === 0, out };
}

function ensureJunctions(dataPathWin: string, telnetRootWin: string, dryRun: boolean, log: string[]) {
  const mql5Root = path.win32.join(dataPathWin, "MQL5");
  const services = path.win32.join(mql5Root, "Services");
  const experts = path.win32.join(mql5Root, "Experts");
  const scripts = path.win32.join(mql5Root, "Scripts");
  const targetServices = path.win32.join(services, "TelnetMT");
  const targetExperts = path.win32.join(experts, "TelnetMT");
  const targetScripts = path.win32.join(scripts, "TelnetMT");
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

export function runInstall(spec: InstallSpec, cwd = process.cwd()): string {
  const log: string[] = [];
  const dataPathRaw = normalizeDataPath(spec.dataPath);
  if (!dataPathRaw) throw new Error("mt5 data path ausente. Use: cmdmt install <MT5_DATA>");
  const dataPathWsl = isWsl() && /^[A-Za-z]:/.test(dataPathRaw) ? toWslPath(dataPathRaw) : dataPathRaw;
  const dataPathWin = toWinPath(dataPathWsl);

  const repoRoot = spec.repoPath ? path.resolve(spec.repoPath) : findTelnetMtRoot(cwd) ?? "";
  if (!repoRoot) {
    throw new Error("nao encontrei services/telnetmt. Use --repo <path>.");
  }
  const telnetRootWin = toWinPath(repoRoot);

  log.push(`mt5 data: ${dataPathWin}`);
  log.push(`telnetmt: ${telnetRootWin}`);

  ensureJunctions(dataPathWin, telnetRootWin, spec.dryRun, log);
  if (!spec.dryRun) ensureIniAllows(dataPathWsl, spec, log);

  if (spec.web.length) {
    log.push(`webrequest allowlist: ${spec.web.join(", ")}`);
  }
  if (spec.dryRun) log.push("dry-run: nenhuma alteracao aplicada");
  return log.join("\n");
}
