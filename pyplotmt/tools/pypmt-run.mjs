#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync, spawn } from "node:child_process";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const APP_DIR = path.join(ROOT, "app", "src", "pyshared_hub");
const PY_PATH_FILE = path.join(APP_DIR, "pymtplot_python_path.txt");
const DEFAULT_PY = "C:\\mql\\Python3.12\\venv\\Scripts\\python.exe";

function winPath(p) {
  return p.replace(/^\/mnt\/(\w)\//, (_, d) => `${d.toUpperCase()}:\\`).replace(/\//g, "\\");
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

function checkPython(pyExe) {
  if (!fs.existsSync(winPath(pyExe)) && !fs.existsSync(pyExe)) {
    console.error(`[pypmt] Python nao encontrado: ${pyExe}`);
    process.exit(1);
  }
  const check = spawnSync(pyExe, ["-c", "import PySide6, numpy"], { stdio: "pipe" });
  if (check.status !== 0) {
    const err = (check.stderr || check.stdout || "").toString().trim();
    console.error("[pypmt] PySide6/numpy nao encontrados no Python configurado.");
    console.error(err);
    process.exit(1);
  }
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

function main() {
  const pyExe = readPythonPath();
  checkPython(pyExe);

  const cfgPath = resolveConfigPath();
  const env = { ...process.env };
  if (cfgPath) env.PYMTPLOT_CONFIG = cfgPath;

  const uiScript = path.join(APP_DIR, "PyShared_hub_ui.py");
  if (!fs.existsSync(uiScript)) {
    console.error(`[pypmt] UI nao encontrada: ${uiScript}`);
    process.exit(1);
  }

  console.log(`[pypmt] Python: ${pyExe}`);
  console.log(`[pypmt] UI: ${uiScript}`);
  if (cfgPath) console.log(`[pypmt] Config: ${cfgPath}`);

  const child = spawn(pyExe, [uiScript], {
    stdio: "inherit",
    env,
    cwd: APP_DIR,
  });
  child.on("exit", (code) => process.exit(code ?? 0));
}

main();
