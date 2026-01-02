import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { BrowserWindow } from "electron";
import type { Settings, TestRequest, TestStatus } from "../../shared/ipc";
import { LogsService } from "./LogsService";

export class TestService {
  private window: BrowserWindow;
  private logs: LogsService;
  private status: TestStatus = { running: false, phase: "idle", lastLogLines: [] };
  private poller: NodeJS.Timeout | null = null;
  private lastLogFile: string | null = null;

  constructor(window: BrowserWindow, logs: LogsService) {
    this.window = window;
    this.logs = logs;
  }

  getLastStatus(): TestStatus {
    return this.status;
  }

  async run(request: TestRequest, settings: Settings): Promise<TestStatus> {
    if (!settings.terminalPath || !settings.mtDataDir) {
      this.logs.append("test", "Terminal path or MT data dir not configured.");
      this.status = { running: false, phase: "missing-config", lastLogLines: [] };
      this.window.webContents.send("test:done", this.status);
      return this.status;
    }

    const runDir = path.join(process.cwd(), "runs", `${Date.now()}`);
    await fs.mkdir(runDir, { recursive: true });

    const reportPath = request.reportPath || path.join(runDir, "report.html");
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    const iniPath = path.join(runDir, "tester.ini");
    const expertPath = await resolveExpertBinary(request.expertPath);
    const testerConfig = buildTesterConfig({ ...request, expertPath }, settings, reportPath);
    await fs.writeFile(iniPath, testerConfig, "utf-8");

    this.status = { running: true, phase: "starting", lastLogLines: [], reportPath };
    this.window.webContents.send("test:start", this.status);
    this.window.webContents.send("test:status", this.status);

    const args = [`/config:${quotePath(iniPath)}`];
    const child = spawn(settings.terminalPath, args, { windowsHide: true });

    child.stdout.on("data", (chunk) => this.appendOutput(chunk.toString()));
    child.stderr.on("data", (chunk) => this.appendOutput(chunk.toString()));

    this.startLogPolling(settings.mtDataDir, reportPath);

    const exitCode: number = await new Promise((resolve) => {
      child.on("error", (error) => {
        this.logs.append("test", `Terminal spawn failed: ${error.message}`);
        resolve(1);
      });
      child.on("close", resolve);
    });

    this.stopLogPolling();
    const reportReady = await exists(reportPath);
    const runReportPath = path.join(runDir, "report.html");
    if (reportReady && reportPath !== runReportPath) {
      try {
        await fs.copyFile(reportPath, runReportPath);
      } catch {
        // ignore copy failures
      }
    }
    if (this.lastLogFile) {
      try {
        await fs.copyFile(this.lastLogFile, path.join(runDir, "tester.log"));
      } catch {
        // ignore copy failures
      }
    }

    const reportPathForUi = reportReady ? runReportPath : reportPath;
    this.status = {
      running: false,
      phase: exitCode === 0 ? "completed" : "exit-code",
      lastLogLines: this.status.lastLogLines,
      reportReady,
      reportPath: reportPathForUi
    };

    this.window.webContents.send("test:done", this.status);
    return this.status;
  }

  private appendOutput(text: string) {
    text.split(/\r?\n/).forEach((line) => line && this.logs.append("test", line));
  }

  private startLogPolling(mtDataDir: string, reportPath: string) {
    const logDirCandidates = [
      path.join(mtDataDir, "Tester", "Logs"),
      path.join(mtDataDir, "Logs")
    ];

    this.poller = setInterval(async () => {
      const logFile = await findLatestLog(logDirCandidates);
      if (logFile) {
        this.lastLogFile = logFile;
        const lastLines = await readLastLines(logFile, 40);
        this.status = {
          ...this.status,
          running: true,
          phase: "running",
          lastLogLines: lastLines,
          reportReady: await exists(reportPath),
          reportPath
        };
        this.window.webContents.send("test:status", this.status);
      }
    }, 2000);
  }

  private stopLogPolling() {
    if (this.poller) {
      clearInterval(this.poller);
      this.poller = null;
    }
  }
}

const buildTesterConfig = (request: TestRequest, settings: Settings, reportPath: string) => {
  const expert = resolveExpertPath(request.expertPath, settings.mtDataDir ?? "");
  const report = normalizeWindowsPath(reportPath);
  return [
    "[Tester]",
    `Expert=${expert}`,
    `Symbol=${request.symbol}`,
    `Period=${request.timeframe}`,
    `FromDate=${request.fromDate}`,
    `ToDate=${request.toDate}`,
    `Deposit=${request.deposit ?? 10000}`,
    "Optimization=0",
    `Report=${report}`,
    "ReplaceReport=1",
    "ShutdownTerminal=1"
  ].join("\r\n");
};

const resolveExpertPath = (expertPath: string, mtDataDir: string) => {
  if (!mtDataDir) return normalizeWindowsPath(expertPath);
  const mqlRoot = path.join(mtDataDir, "MQL5");
  if (expertPath.startsWith(mqlRoot)) {
    const relative = path.relative(mqlRoot, expertPath);
    return normalizeWindowsPath(relative);
  }
  return normalizeWindowsPath(expertPath);
};

const normalizeWindowsPath = (value: string) => value.replace(/\//g, "\\");

const quotePath = (value: string) => {
  if (value.includes(" ") || value.includes("(")) {
    return `\"${value}\"`;
  }
  return value;
};

const exists = async (filePath: string) => {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
};

const findLatestLog = async (dirs: string[]) => {
  let latest: { path: string; mtime: number } | null = null;
  for (const dir of dirs) {
    try {
      const entries = await fs.readdir(dir);
      for (const entry of entries) {
        if (!entry.endsWith(".log")) continue;
        const fullPath = path.join(dir, entry);
        const stat = await fs.stat(fullPath);
        if (!latest || stat.mtimeMs > latest.mtime) {
          latest = { path: fullPath, mtime: stat.mtimeMs };
        }
      }
    } catch {
      continue;
    }
  }
  return latest?.path ?? null;
};

const readLastLines = async (filePath: string, maxLines: number) => {
  try {
    const contents = await fs.readFile(filePath, "utf-8");
    const lines = contents.split(/\r?\n/).filter(Boolean);
    return lines.slice(Math.max(0, lines.length - maxLines));
  } catch {
    return [];
  }
};

const resolveExpertBinary = async (expertPath: string) => {
  const ext = path.extname(expertPath).toLowerCase();
  if (ext !== ".mq5" && ext !== ".mq4") return expertPath;
  const binary = expertPath.replace(ext, ext === ".mq5" ? ".ex5" : ".ex4");
  try {
    await fs.access(binary);
    return binary;
  } catch {
    return expertPath;
  }
};
