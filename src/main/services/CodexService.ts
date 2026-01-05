import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { BrowserWindow } from "electron";
import type { CodexEvent, CodexRunRequest, CodexRunStatus, Settings } from "../../shared/ipc";
import { LogsService } from "./LogsService";
import { WorkspaceService } from "./WorkspaceService";
import { BuildService } from "./BuildService";
import { buildContext } from "./ContextBuilder";

const CODEX_LOG_DIR = path.join(process.cwd(), "logs", "codex");
const parseArgs = (value?: string): string[] => {
  if (!value) return [];
  return value
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
};

export class CodexService {
  private window: BrowserWindow;
  private logs: LogsService;
  private workspace: WorkspaceService;
  private build: BuildService;
  private currentProcess: ReturnType<typeof spawn> | null = null;
  private status: CodexRunStatus = { running: false, startedAt: 0 };

  constructor(window: BrowserWindow, logs: LogsService, workspace: WorkspaceService, build: BuildService) {
    this.window = window;
    this.logs = logs;
    this.workspace = workspace;
    this.build = build;
  }

  async run(request: CodexRunRequest, settings: Settings): Promise<CodexRunStatus> {
    if (this.currentProcess) return this.status;

    await fs.mkdir(CODEX_LOG_DIR, { recursive: true });
    const runId = randomUUID();
    const logPath = path.join(CODEX_LOG_DIR, `codex-${Date.now()}-${runId}.log`);

    const promptBase = await buildContext({
      requestMessage: request.userMessage,
      activeFilePath: request.activeFilePath,
      selection: request.selection,
      diagnostics: this.build.getLastDiagnostics(),
      logs: this.logs,
      workspace: this.workspace,
      settings
    });
    const gitStatus = await getGitStatus(this.workspace.getRoot() ?? process.cwd());
    const contextBundle = request.contextBundle ? `\n\n# Context Bundle\n${request.contextBundle}` : "";
    const prompt = `${promptBase}\n\n# Git Status\n${gitStatus || "(git status unavailable)"}${contextBundle}`;

    const snapshots = await snapshotWorkspace(this.workspace);

    const codexPath = settings.codexPath || "codex";
    const extraArgs = parseArgs(settings.codexArgs);
    const model = request.model && request.model !== "default" ? request.model : undefined;
    const level = request.level && request.level !== "default" ? request.level : undefined;
    const args = [
      "exec",
      "--skip-git-repo-check",
      ...(model ? ["--model", model] : []),
      ...(level ? ["-c", `reasoning.level="${level}"`] : []),
      ...extraArgs,
      "-"
    ];
    this.logs.append("system", `Codex exec: ${codexPath} ${args.join(" ")}`);
    const child = spawn(codexPath, args, {
      cwd: this.workspace.getRoot() ?? process.cwd(),
      env: { ...process.env }
    });

    this.currentProcess = child;
    this.status = { running: true, startedAt: Date.now() };
    this.window.webContents.send("codex:run:start", this.status);
    this.window.webContents.send("codex:run:event", {
      type: "status",
      data: "Codex run started",
      timestamp: Date.now()
    } satisfies CodexEvent);

    const logHandle = await fs.open(logPath, "w");

    const handleOutput = (type: "stdout" | "stderr") => (chunk: Buffer) => {
      const text = chunk.toString();
      text.split(/\r?\n/).forEach((line) => line && this.logs.append("codex", line));
      this.window.webContents.send("codex:run:event", {
        type,
        data: text,
        timestamp: Date.now()
      } satisfies CodexEvent);
      logHandle.write(text);
    };

    child.stdout.on("data", handleOutput("stdout"));
    child.stderr.on("data", handleOutput("stderr"));

    child.on("error", (error) => {
      this.logs.append("codex", `Codex spawn failed: ${error.message}`);
    });

    child.on("close", async (exitCode) => {
      await logHandle.close();
      this.status = {
        running: false,
        startedAt: this.status.startedAt,
        endedAt: Date.now(),
        exitCode: exitCode ?? undefined
      };
      this.currentProcess = null;

      await this.emitFileChanges(snapshots, runId);
      this.window.webContents.send("codex:run:done", this.status);
    });

    child.stdin.write(prompt);
    child.stdin.end();

    return this.status;
  }

  cancel() {
    if (this.currentProcess) {
      this.currentProcess.kill();
      this.currentProcess = null;
      this.status = { running: false, startedAt: Date.now(), endedAt: Date.now(), exitCode: -1 };
      this.window.webContents.send("codex:run:done", this.status);
    }
  }

  private async emitFileChanges(snapshots: Map<string, string>, changeId: string) {
    for (const [filePath, beforeContent] of snapshots.entries()) {
      try {
        const afterContent = await fs.readFile(filePath, "utf-8");
        if (afterContent !== beforeContent) {
          this.window.webContents.send("file:changed", {
            path: filePath,
            content: afterContent,
            previousContent: beforeContent,
            source: "codex",
            changeId
          });
        }
      } catch {
        continue;
      }
    }
  }
}

const snapshotWorkspace = async (workspace: WorkspaceService) => {
  const files = await workspace.listWorkspaceFiles([
    ".mq4",
    ".mq5",
    ".mqh",
    ".py",
    ".c",
    ".cpp",
    ".cc",
    ".cxx",
    ".h",
    ".hpp",
    ".hh",
    ".ts",
    ".tsx",
    ".json",
    ".md"
  ]);
  const snapshots = new Map<string, string>();
  const candidates = files.filter((file) =>
    [".mq4", ".mq5", ".mqh", ".ts", ".tsx", ".json", ".md"].includes(
      path.extname(file).toLowerCase()
    )
  );

  for (const filePath of candidates) {
    try {
      const stat = await fs.stat(filePath);
      if (stat.size > 512 * 1024) continue;
      const content = await fs.readFile(filePath, "utf-8");
      snapshots.set(filePath, content);
    } catch {
      continue;
    }
  }

  return snapshots;
};

const getGitStatus = async (cwd: string) => {
  try {
    const child = spawn("git", ["status", "--porcelain"], { cwd });
    const chunks: Buffer[] = [];
    for await (const chunk of child.stdout) {
      chunks.push(Buffer.from(chunk));
    }
    const output = Buffer.concat(chunks).toString().trim();
    return output || "(clean)";
  } catch {
    return null;
  }
};
