import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs/promises";
import type { BrowserWindow } from "electron";
import type { BuildResult, Diagnostic, Settings } from "../../shared/ipc";
import { LogsService } from "./LogsService";

const LOG_DIR = path.join(process.cwd(), "logs", "build");

export class BuildService {
  private window: BrowserWindow;
  private logs: LogsService;
  private lastDiagnostics: Diagnostic[] = [];

  constructor(window: BrowserWindow, logs: LogsService) {
    this.window = window;
    this.logs = logs;
  }

  getLastDiagnostics(): Diagnostic[] {
    return this.lastDiagnostics;
  }

  async compile(filePath: string, settings: Settings): Promise<BuildResult> {
    if (!settings.metaeditorPath) {
      this.logs.append("build", "MetaEditor path not configured.");
      const result = { success: false, diagnostics: [] };
      this.window.webContents.send("build:result", result);
      return result;
    }

    this.window.webContents.send("build:start", { filePath });

    await fs.mkdir(LOG_DIR, { recursive: true });
    const logPath = path.join(LOG_DIR, `build-${Date.now()}.log`);
    const compileArg = `/compile:${quotePath(filePath)}`;
    const logArg = `/log:${quotePath(logPath)}`;

    const child = spawn(settings.metaeditorPath, [compileArg, logArg], {
      windowsHide: true
    });

    let rawOutput = "";
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      rawOutput += text;
      text.split(/\r?\n/).forEach((line: string) => line && this.logs.append("build", line));
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      rawOutput += text;
      text.split(/\r?\n/).forEach((line: string) => line && this.logs.append("build", line));
    });

    const exitCode: number = await new Promise((resolve) => {
      child.on("error", (error) => {
        this.logs.append("build", `MetaEditor spawn failed: ${error.message}`);
        resolve(1);
      });
      child.on("close", resolve);
    });

    let diagnostics: Diagnostic[] = [];
    try {
      const logContents = await fs.readFile(logPath, "utf-8");
      diagnostics = parseDiagnostics(logContents);
    } catch {
      this.logs.append("build", "Build log not found. Check MetaEditor log output.");
    }

    const success = exitCode === 0 && diagnostics.length === 0;
    this.lastDiagnostics = diagnostics;
    const result: BuildResult = {
      success,
      diagnostics,
      rawLogPath: logPath,
      rawOutput
    };

    this.window.webContents.send("build:result", result);
    return result;
  }
}

const quotePath = (value: string) => {
  if (value.includes(" ") || value.includes("(")) {
    return `\"${value}\"`;
  }
  return value;
};

const parseDiagnostics = (contents: string): Diagnostic[] => {
  const diagnostics: Diagnostic[] = [];
  const lines = contents.split(/\r?\n/);
  const regex = /^(.*)\((\d+),(\d+)\):\s*(warning|error|info)\s*(.*)$/i;

  for (const line of lines) {
    const match = regex.exec(line.trim());
    if (!match) continue;
    const [, filePath, lineStr, colStr, severity, message] = match;
    diagnostics.push({
      filePath: filePath.trim(),
      line: Number(lineStr),
      column: Number(colStr),
      severity: severity.toLowerCase() as Diagnostic["severity"],
      message: message.trim(),
      source: "MetaEditor"
    });
  }

  return diagnostics;
};
