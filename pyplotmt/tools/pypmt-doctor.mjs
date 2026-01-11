#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const APP_DIR = path.join(ROOT, "app", "src", "pyshared_hub");
const PY_PATH_FILE = path.join(APP_DIR, "pymtplot_python_path.txt");
const DEFAULT_PY = "C:\\mql\\Python3.12\\venv\\Scripts\\python.exe";

function isWindowsPath(p) {
  return /^[A-Za-z]:\\/.test(p) || /^\\\\/.test(p);
}

function isWsl() {
  return Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
}

function toWslPath(p) {
  if (!p || !isWsl() || !isWindowsPath(p)) return p;
  const m = /^([A-Za-z]):\\(.*)$/.exec(p);
  if (m) {
    const drive = m[1].toLowerCase();
    const rest = m[2].replace(/\\/g, "/");
    return `/mnt/${drive}/${rest}`;
  }
  return p;
}

function readPythonPath() {
  const envPy = process.env.PYMTPLOT_PY?.trim();
  if (envPy) return envPy;
  if (fs.existsSync(PY_PATH_FILE)) {
    const line = fs.readFileSync(PY_PATH_FILE, "utf8").trim();
    if (line) return line;
  }
  return DEFAULT_PY;
}

function resolveConfigPath() {
  if (process.env.PYMTPLOT_CONFIG) return process.env.PYMTPLOT_CONFIG;
  const appdata = process.env.APPDATA;
  if (!appdata) return null;
  const base = path.join(appdata, "MetaQuotes", "Terminal");
  if (!fs.existsSync(base)) return null;
  const dirs = fs.readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(base, d.name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  for (const dir of dirs) {
    const cfg = path.join(dir, "MQL5", "Files", "pyshared_config.json");
    if (fs.existsSync(cfg)) return cfg;
  }
  return null;
}

function checkPython(pyExe) {
  let pathToCheck = pyExe;
  let exists = fs.existsSync(pathToCheck);
  if (!exists && isWsl() && isWindowsPath(pyExe)) {
    const wslPath = toWslPath(pyExe);
    if (wslPath && wslPath !== pyExe) {
      pathToCheck = wslPath;
      exists = fs.existsSync(pathToCheck);
    }
  }
  console.log(`Python: ${pyExe} ${exists ? "OK" : "MISSING"}`);
  if (!exists) return;
  const check = spawnSync(pathToCheck, ["-c", "import PySide6, numpy"], { stdio: "pipe" });
  if (check.status === 0) {
    console.log("PySide6/numpy: OK");
  } else {
    const err = (check.stderr || check.stdout || "").toString().trim();
    console.log("PySide6/numpy: FAIL");
    console.log(err);
  }
  const cupy = spawnSync(pyExe, ["-c", "import cupy"], { stdio: "pipe" });
  console.log(`cupy: ${cupy.status === 0 ? "OK" : "FAIL"}`);
}

function checkConfig(cfgPath) {
  if (!cfgPath) {
    console.log("pyshared_config.json: NOT FOUND");
    return null;
  }
  console.log(`pyshared_config.json: ${cfgPath}`);
  try {
    const obj = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    const dll = obj.dll_path || "";
    console.log(`dll_path: ${dll}`);
    if (dll) {
      let dllCheck = dll;
      let dllExists = fs.existsSync(dllCheck);
      if (!dllExists && isWsl() && isWindowsPath(dll)) {
        const wslPath = toWslPath(dll);
        if (wslPath && wslPath !== dll) {
          dllCheck = wslPath;
          dllExists = fs.existsSync(dllCheck);
        }
      }
      console.log(`dll_path exists: ${dllExists ? "OK" : "MISSING"}`);
    }
    return { obj, cfgPath };
  } catch (err) {
    console.log("pyshared_config.json: FAIL to parse");
    console.log(String(err));
    return null;
  }
}

function main() {
  console.log("[PyPlotMT Doctor]");
  console.log(`APP_DIR: ${APP_DIR} ${fs.existsSync(APP_DIR) ? "OK" : "MISSING"}`);
  const pyExe = readPythonPath();
  checkPython(pyExe);

  const cfgPath = resolveConfigPath();
  const cfg = checkConfig(cfgPath);
  if (cfg && cfgPath) {
    const terminalRoot = path.dirname(path.dirname(path.dirname(cfgPath)));
    const libDll = path.join(terminalRoot, "MQL5", "Libraries", "PyShared_v2.dll");
    console.log(`MQL5 Libraries dll: ${libDll} ${fs.existsSync(libDll) ? "OK" : "MISSING"}`);
  }

  const hubCfg = path.join(APP_DIR, "hub_config.py");
  console.log(`hub_config.py: ${hubCfg} ${fs.existsSync(hubCfg) ? "OK" : "MISSING"}`);
}

main();
