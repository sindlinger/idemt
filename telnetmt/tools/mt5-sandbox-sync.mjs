#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const SANDBOX_WIN = process.env.MT5_SANDBOX_WIN || "C:\\mql\\mt5-sandbox\\terminal";
const DEFAULT_CMD = ["cmdmt", "--runner", "sandbox", "expert", "test", "M5", "DukaEA"];

const args = process.argv.slice(2);
let timeoutSec = Number(process.env.MT5_SANDBOX_TIMEOUT_SEC || 300);
let pollSec = Number(process.env.MT5_SANDBOX_POLL_SEC || 2);
let refreshCred = process.env.MT5_SANDBOX_REFRESH_CRED || "1";
let cmdmtArgs = [...DEFAULT_CMD];

function usage() {
  console.log(`Uso:
  node tools\\mt5-sandbox-sync.mjs [--timeout SEC] [--poll SEC] [--refresh-cred|--no-refresh-cred] [--] [cmdmt args...]

Exemplos:
  node tools\\mt5-sandbox-sync.mjs
  node tools\\mt5-sandbox-sync.mjs -- --runner sandbox expert test M5 DukaEA
  set MT5_SANDBOX_TIMEOUT_SEC=600 && node tools\\mt5-sandbox-sync.mjs
`);
}

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--help" || a === "-h") {
    usage();
    process.exit(0);
  }
  if (a === "--timeout" && args[i + 1]) {
    timeoutSec = Number(args[i + 1]);
    i++;
    continue;
  }
  if (a === "--poll" && args[i + 1]) {
    pollSec = Number(args[i + 1]);
    i++;
    continue;
  }
  if (a === "--refresh-cred") {
    refreshCred = "1";
    continue;
  }
  if (a === "--no-refresh-cred") {
    refreshCred = "0";
    continue;
  }
  if (a === "--") {
    cmdmtArgs = args.slice(i + 1);
    break;
  }
}

function readTextWithEncoding(filePath) {
  const buf = fs.readFileSync(filePath);
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: buf.toString("utf16le"), encoding: "utf16le" };
  }
  return { text: buf.toString("utf8"), encoding: "utf8" };
}

function writeTextWithEncoding(filePath, text, encoding) {
  if (encoding === "utf16le") {
    const bom = Buffer.from([0xff, 0xfe]);
    const body = Buffer.from(text, "utf16le");
    fs.writeFileSync(filePath, Buffer.concat([bom, body]));
    return;
  }
  fs.writeFileSync(filePath, text, "utf8");
}

function updateCommonIni(login, password, server) {
  const iniPath = path.join(SANDBOX_WIN, "Config", "common.ini");
  if (!fs.existsSync(iniPath)) {
    console.warn(`[sandbox] common.ini nao encontrado: ${iniPath}`);
    return;
  }
  const { text, encoding } = readTextWithEncoding(iniPath);
  const nl = text.includes("\r\n") ? "\r\n" : "\n";
  const secRe = /(^\[Common\][\s\S]*?)(?=^\[|\Z)/m;
  let updated = text;
  let match = secRe.exec(text);
  if (!match) {
    updated = `[Common]${nl}` + text;
    match = secRe.exec(updated);
  }
  const block = match[1];
  const lines = block.split(/\r?\n/);
  const newLines = [lines[0]];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("Login=") || line.startsWith("Password=") || line.startsWith("Server=")) continue;
    if (!line.trim() && newLines.length && !newLines[newLines.length - 1].trim()) continue;
    newLines.push(line);
  }
  newLines.push(`Login=${login}`, `Password=${password}`, `Server=${server}`);
  const newBlock = newLines.join(nl) + nl;
  updated = updated.replace(block, newBlock);
  writeTextWithEncoding(iniPath, updated, encoding);
}

function updateCmdmtConfig(login, password, server) {
  const home = process.env.USERPROFILE || "";
  const cfgPath = path.join(home, ".cmdmt", "config.json");
  if (!fs.existsSync(cfgPath)) return;
  const obj = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  const tester = (obj.defaults ||= {}).tester ||= {};
  tester.login = /^\d+$/.test(login) ? Number(login) : login;
  tester.password = password;
  tester.server = server;
  fs.writeFileSync(cfgPath, JSON.stringify(obj, null, 2));
}

function parseMt5Creds(output) {
  const idx = output.toLowerCase().indexOf("credenciais mt5");
  if (idx === -1) return null;
  const slice = output.slice(idx);
  const grab = (label) => {
    const re = new RegExp(`^\\s*${label}\\s*:\\s*(.+)$`, "mi");
    const m = slice.match(re);
    return m ? m[1].trim() : "";
  };
  const login = grab("login");
  const password = grab("senha");
  const server = grab("servidor");
  if (!login || !password || !server) return null;
  return { login, password, server };
}

function refreshCredentials() {
  console.log("[sandbox] Atualizando credenciais via cli-duka-account...");
  const res = spawnSync("cli-duka-account", [], { encoding: "utf8", timeout: 180000 });
  const out = `${res.stdout || ""}${res.stderr || ""}`;
  const creds = parseMt5Creds(out);
  if (!creds) {
    console.warn("[sandbox] Aviso: nao consegui ler credenciais do cli-duka-account.");
    return null;
  }
  console.log(`[sandbox] credenciais: ${creds.login} / ${creds.server}`);
  updateCommonIni(creds.login, creds.password, creds.server);
  updateCmdmtConfig(creds.login, creds.password, creds.server);
  return creds;
}

function startTerminal() {
  console.log("[sandbox] Iniciando MT5 portable...");
  const exe = path.join(SANDBOX_WIN, "terminal64.exe");
  const child = spawn(exe, ["/portable"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    cwd: SANDBOX_WIN
  });
  child.unref();
}

function killTerminal() {
  console.log("[sandbox] Encerrando MT5 sandbox...");
  const ps = `Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'terminal64.exe' -and $_.CommandLine -like '*${SANDBOX_WIN.replace(/\\/g, "\\\\")}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`;
  spawnSync("powershell.exe", ["-NoProfile", "-Command", ps], { stdio: "ignore" });
}

function readLogText(logPath) {
  if (!fs.existsSync(logPath)) return "";
  const { text } = readTextWithEncoding(logPath);
  return text;
}

async function waitForLogin() {
  const logFile = `${new Date().toISOString().slice(0, 10).replace(/-/g, "")}.log`;
  const logPath = path.join(SANDBOX_WIN, "Logs", logFile);
  const start = Date.now();
  let found = false;
  while (Date.now() - start < timeoutSec * 1000) {
    const text = readLogText(logPath).toLowerCase();
    if (text.includes("authorized on dukascopy-demo-mt5-1") || text.includes("authorization on dukascopy-demo-mt5-1")) {
      found = true;
      console.log("[sandbox] Login confirmado no log.");
      break;
    }
    await new Promise((r) => setTimeout(r, pollSec * 1000));
  }
  if (!found) {
    console.warn(`[sandbox] Timeout aguardando login (${timeoutSec} s).`);
  }
  return found;
}

function runCmdmt() {
  console.log("[sandbox] Rodando cmdmt...");
  const res = spawnSync(cmdmtArgs[0], cmdmtArgs.slice(1), { stdio: "inherit" });
  return res.status ?? 0;
}

async function main() {
  if (refreshCred !== "0") refreshCredentials();
  startTerminal();
  const ok = await waitForLogin();
  killTerminal();
  const code = runCmdmt();
  if (!ok) {
    const logFile = `${new Date().toISOString().slice(0, 10).replace(/-/g, "")}.log`;
    console.warn(`[sandbox] Aviso: login não confirmado no log. Verifique ${path.join(SANDBOX_WIN, "Logs", logFile)}`);
  }
  process.exit(code);
}

main().catch((err) => {
  console.error("[sandbox] Erro:", err);
  process.exit(1);
});
