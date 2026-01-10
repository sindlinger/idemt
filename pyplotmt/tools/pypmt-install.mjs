#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const DLL_SRC = path.resolve(ROOT, "..", "dll", "PyShared_v2.dll");
const IND_TEMPLATE = path.resolve(ROOT, "app", "src", "pyshared_hub", "templates", "PyPlotMT_Bridge_v7.mq5");
const HUB_CFG = path.resolve(ROOT, "app", "src", "pyshared_hub", "hub_config.py");

function isWindowsPath(p) {
  return /^[A-Za-z]:\\/.test(p) || /^\\\\/.test(p);
}

function isWsl() {
  return Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
}

function toWslPath(p) {
  if (!p) return p;
  if (!isWsl()) return p;
  if (!isWindowsPath(p)) return p;
  const m = /^([A-Za-z]):\\(.*)$/.exec(p);
  if (m) {
    const drive = m[1].toLowerCase();
    const rest = m[2].replace(/\\/g, "/");
    return `/mnt/${drive}/${rest}`;
  }
  return p;
}

function toWinPath(p) {
  if (!p) return p;
  if (isWindowsPath(p)) return p;
  if (!isWsl()) return p;
  if (p.startsWith("/mnt/")) {
    const drive = p.slice(5, 6).toUpperCase();
    const rest = p.slice(7).replace(/\//g, "\\");
    return `${drive}:\\${rest}`;
  }
  return p;
}

function readArg(name) {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return null;
}

function detectChannelFromHubConfig() {
  if (!fs.existsSync(HUB_CFG)) return null;
  const text = fs.readFileSync(HUB_CFG, "utf8");
  const m = text.match(/\"name\"\\s*:\\s*\"([^\"]+)\"/);
  if (m && m[1]) return m[1];
  const m2 = text.match(/'name'\\s*:\\s*'([^']+)'/);
  if (m2 && m2[1]) return m2[1];
  return null;
}

function findLatestDataPath(appdata) {
  const base = path.join(appdata, "MetaQuotes", "Terminal");
  if (!fs.existsSync(base)) return null;
  const dirs = fs.readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(base, d.name))
    .filter((d) => fs.existsSync(path.join(d, "MQL5")));
  if (!dirs.length) return null;
  dirs.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return dirs[0];
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function main() {
  const dataArg = readArg("--data");
  const nameArg = readArg("--name");
  const channelArg = readArg("--channel") || detectChannelFromHubConfig() || "MAIN";

  const appdata = process.env.APPDATA || (isWsl() ? "/mnt/c/Users" : null);
  let dataPath = dataArg || null;

  if (!dataPath && appdata && !isWsl()) {
    dataPath = findLatestDataPath(appdata);
  }

  if (!dataPath && isWsl()) {
    if (!dataArg) {
      console.error("[pypmt-install] --data <MT5_DATA> is required in WSL");
      process.exit(1);
    }
  }

  if (!dataPath) {
    console.error("[pypmt-install] MT5 data path not found. Use --data <path>");
    process.exit(1);
  }

  const dataPathWsl = toWslPath(dataPath);
  const dataPathWin = toWinPath(dataPathWsl);

  const mql5Root = path.join(dataPathWsl, "MQL5");
  const filesDir = path.join(mql5Root, "Files");
  const libsDir = path.join(mql5Root, "Libraries");
  const indDir = path.join(mql5Root, "Indicators", nameArg || "PyPlotMT");

  ensureDir(filesDir);
  ensureDir(libsDir);
  ensureDir(indDir);

  if (!fs.existsSync(DLL_SRC)) {
    console.error(`[pypmt-install] DLL source missing: ${DLL_SRC}`);
    process.exit(1);
  }

  const dllDest = path.join(libsDir, "PyShared_v2.dll");
  fs.copyFileSync(DLL_SRC, dllDest);

  const cfgPath = path.join(filesDir, "pyshared_config.json");
  const cfg = {
    dll_path: toWinPath(dllDest),
    dll_name: "PyShared_v2.dll",
    channel: channelArg,
    capacity_mb: 8
  };
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

  if (fs.existsSync(IND_TEMPLATE)) {
    const indName = `PyPlotMT_${channelArg}.mq5`;
    const out = path.join(indDir, indName);
    const text = fs.readFileSync(IND_TEMPLATE, "utf8").replace(
      /input string Channel\s*=\s*".*?";/,
      `input string Channel  = "${channelArg}";`
    );
    fs.writeFileSync(out, text, "utf8");
  }

  console.log("[pypmt-install] OK");
  console.log(`data: ${dataPathWin}`);
  console.log(`dll:  ${toWinPath(dllDest)}`);
  console.log(`cfg:  ${toWinPath(cfgPath)}`);
  console.log(`ind:  ${toWinPath(indDir)}`);
}

main();
