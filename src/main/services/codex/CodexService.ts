import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { BrowserWindow } from "electron";
import type {
  CodexEvent,
  CodexReviewRequest,
  CodexRunRequest,
  CodexRunStatus,
  ReviewChangePayload,
  Settings
} from "../../shared/ipc";
import { LogsService } from "../logging/LogsService";
import { WorkspaceService } from "../workspace/WorkspaceService";
import { BuildService } from "../build/BuildService";
import { buildContext } from "./ContextBuilder";
import type { ReviewStoreService } from "../review/ReviewStoreService";
import { resolveCodexConfigPath } from "./CodexConfigService";
import {
  buildCodexAgentArgs,
  ensureInstructionsFile,
  toWslPath
} from "./CodexInstructionsService";

const CODEX_LOG_DIR = path.join(process.cwd(), "logs", "codex");
const parseArgs = (value?: string): string[] => {
  if (!value) return [];
  return value
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
};

const buildWslHostEnv = (source: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({
  SystemRoot: source.SystemRoot ?? "C:\\\\Windows",
  WINDIR: source.WINDIR ?? "C:\\\\Windows",
  COMSPEC: source.COMSPEC ?? "C:\\\\Windows\\\\System32\\\\cmd.exe",
  PATH: "C:\\\\Windows\\\\System32",
  TEMP: source.TEMP,
  TMP: source.TMP,
  USERNAME: source.USERNAME,
  USERDOMAIN: source.USERDOMAIN,
  WSLENV: ""
});

export class CodexService {
  private window: BrowserWindow;
  private logs: LogsService;
  private workspace: WorkspaceService;
  private build: BuildService;
  private reviewStore?: ReviewStoreService;
  private currentProcess: ReturnType<typeof spawn> | null = null;
  private status: CodexRunStatus = { running: false, startedAt: 0 };

  constructor(
    window: BrowserWindow,
    logs: LogsService,
    workspace: WorkspaceService,
    build: BuildService,
    reviewStore?: ReviewStoreService
  ) {
    this.window = window;
    this.logs = logs;
    this.workspace = workspace;
    this.build = build;
    this.reviewStore = reviewStore;
  }

  async run(request: CodexRunRequest, settings: Settings): Promise<CodexRunStatus> {
    if (this.currentProcess) return this.status;

    await fs.mkdir(CODEX_LOG_DIR, { recursive: true });
    const runId = randomUUID();
    const logPath = path.join(CODEX_LOG_DIR, `codex-${Date.now()}-${runId}.log`);

    const runTarget = settings.codexRunTarget ?? "windows";
    const useWsl = runTarget === "wsl" && process.platform === "win32";
    const pathMapper = useWsl ? toWslPath : undefined;
    const workspaceRoot = this.workspace.getRoot() ?? process.cwd();
    const instructionsPathWin = await ensureInstructionsFile(workspaceRoot, this.logs);
    const instructionsPath = useWsl ? toWslPath(instructionsPathWin) : instructionsPathWin;
    const agentArgs = buildCodexAgentArgs(instructionsPath);

    const promptBase = await buildContext({
      requestMessage: request.userMessage,
      activeFilePath: request.activeFilePath,
      selection: request.selection,
      diagnostics: this.build.getLastDiagnostics(),
      logs: this.logs,
      workspace: this.workspace,
      settings,
      pathMapper
    });
    const gitStatus = await getGitStatus(this.workspace.getRoot() ?? process.cwd());
    const contextBundle = request.contextBundle ? `\n\n# Context Bundle\n${request.contextBundle}` : "";
    const prompt = `${promptBase}\n\n# Git Status\n${gitStatus || "(git status unavailable)"}${contextBundle}`;

    const snapshots = await snapshotWorkspace(this.workspace);

    const codexPath = useWsl ? settings.codexPathWsl || "codex" : settings.codexPath || "codex";
    const baseArgs = parseArgs(settings.codexArgs);
    const targetArgs = parseArgs(useWsl ? settings.codexArgsWsl : settings.codexArgsWindows);
    const extraArgs = [...baseArgs, ...targetArgs];
    const model = request.model && request.model !== "default" ? request.model : undefined;
    const level = request.level && request.level !== "default" ? request.level : undefined;
    const useResume = Boolean(request.sessionActive);
    if (useResume && (model || level || extraArgs.length > 0)) {
      this.logs.append(
        "codex",
        "Resume mode ignores model/level/extra args (Codex CLI resume does not accept those flags)."
      );
    }
    const execArgs = useResume
      ? ["exec", "resume", "--last", "-"]
      : [
          "exec",
          "--skip-git-repo-check",
          ...(model ? ["--model", model] : []),
          ...(level ? ["-c", `reasoning.level=\"${level}\"`] : []),
          ...extraArgs,
          "-"
        ];
    const args = [...agentArgs, ...execArgs];
    const command = useWsl ? "wsl.exe" : codexPath;
    const commandArgs = useWsl ? ["--", codexPath, ...args] : args;
    this.logs.append("system", `Codex exec: ${command} ${commandArgs.join(" ")}`);
    const codexConfigPath = await resolveCodexConfigPath(this.logs, { target: runTarget });
    const baseEnv: NodeJS.ProcessEnv = useWsl
      ? buildWslHostEnv(process.env)
      : {
          ...process.env,
          ...(codexConfigPath ? { CODEX_CONFIG: codexConfigPath } : {})
        };
    const child = spawn(command, commandArgs, {
      cwd: workspaceRoot,
      env: baseEnv
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

      await this.emitFileChanges(snapshots, runId, settings);
      this.window.webContents.send("codex:run:done", this.status);
    });

    child.stdin.write(prompt);
    child.stdin.end();

    return this.status;
  }

  async review(request: CodexReviewRequest, settings: Settings): Promise<CodexRunStatus> {
    if (this.currentProcess) return this.status;

    await fs.mkdir(CODEX_LOG_DIR, { recursive: true });
    const runId = randomUUID();
    const logPath = path.join(CODEX_LOG_DIR, `codex-review-${Date.now()}-${runId}.log`);

    const runTarget = settings.codexRunTarget ?? "windows";
    const useWsl = runTarget === "wsl" && process.platform === "win32";
    const workspaceRoot = this.workspace.getRoot() ?? process.cwd();
    const instructionsPathWin = await ensureInstructionsFile(workspaceRoot, this.logs);
    const instructionsPath = useWsl ? toWslPath(instructionsPathWin) : instructionsPathWin;
    const agentArgs = buildCodexAgentArgs(instructionsPath);
    const codexPath = useWsl ? settings.codexPathWsl || "codex" : settings.codexPath || "codex";

    const args: string[] = [...agentArgs, "review"];
    if (request.preset === "uncommitted") {
      args.push("--uncommitted");
    } else if (request.preset === "base") {
      if (request.baseBranch) args.push("--base", request.baseBranch);
    } else if (request.preset === "commit") {
      if (request.commitSha) args.push("--commit", request.commitSha);
    }
    if (request.instructions) {
      args.push(request.instructions);
    }

    const command = useWsl ? "wsl.exe" : codexPath;
    const commandArgs = useWsl ? ["--", codexPath, ...args] : args;
    this.logs.append("system", `Codex review: ${command} ${commandArgs.join(" ")}`);
    const codexConfigPath = await resolveCodexConfigPath(this.logs, { target: runTarget });
    const baseEnv: NodeJS.ProcessEnv = useWsl
      ? buildWslHostEnv(process.env)
      : {
          ...process.env,
          ...(codexConfigPath ? { CODEX_CONFIG: codexConfigPath } : {})
        };
    const child = spawn(command, commandArgs, {
      cwd: workspaceRoot,
      env: baseEnv
    });

    this.currentProcess = child;
    this.status = { running: true, startedAt: Date.now() };
    this.window.webContents.send("codex:run:start", this.status);
    this.window.webContents.send("codex:run:event", {
      type: "status",
      data: "Codex review started",
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
      this.logs.append("codex", `Codex review spawn failed: ${error.message}`);
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
      this.window.webContents.send("codex:run:done", this.status);
    });

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

  private async emitFileChanges(
    snapshots: Map<string, string>,
    changeId: string,
    settings: Settings
  ) {
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
          if (this.reviewStore) {
            const payload: ReviewChangePayload = {
              path: filePath,
              before: beforeContent,
              after: afterContent,
              source: "codex",
              changeId,
              timestamp: Date.now()
            };
            await this.reviewStore.storeChange(payload, settings);
          }
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
