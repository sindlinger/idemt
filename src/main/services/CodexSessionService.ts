import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { BrowserWindow } from "electron";
import { spawn } from "node-pty";
import type { IPty } from "node-pty";
import type {
  CodexEvent,
  CodexRunRequest,
  CodexRunStatus,
  ReviewChangePayload,
  Settings
} from "../../shared/ipc";
import { LogsService } from "./LogsService";
import { WorkspaceService } from "./WorkspaceService";
import type { ReviewStoreService } from "./ReviewStoreService";
import { resolveCodexConfigPath } from "./CodexConfigService";
import {
  buildCodexAgentArgs,
  ensureInstructionsFile,
  toWslPath
} from "./CodexInstructionsService";

type SessionState = {
  id: string;
  pty: IPty;
  cwd: string;
  runTarget: "windows" | "wsl";
  codexPath: string;
  running: boolean;
  ready: boolean;
  queue: Array<{ prompt: string; settings: Settings }>;
  lastOutputAt: number;
  promptBuffer?: string;
  idleTimer?: NodeJS.Timeout;
  readyTimer?: NodeJS.Timeout;
  acknowledged?: boolean;
  snapshots?: Map<string, string>;
  runId?: string;
  status: CodexRunStatus;
  lastSettings?: Settings;
};

const IDLE_MS = 900;
const READY_FALLBACK_MS = 800;

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

export class CodexSessionService {
  private window: BrowserWindow;
  private logs: LogsService;
  private workspace: WorkspaceService;
  private reviewStore?: ReviewStoreService;
  private session: SessionState | null = null;

  constructor(
    window: BrowserWindow,
    logs: LogsService,
    workspace: WorkspaceService,
    reviewStore?: ReviewStoreService
  ) {
    this.window = window;
    this.logs = logs;
    this.workspace = workspace;
    this.reviewStore = reviewStore;
  }

  async sendMessage(request: CodexRunRequest, settings: Settings): Promise<CodexRunStatus> {
    const session = await this.ensureSession(settings);
    if (!session) {
      return { running: false, startedAt: Date.now(), endedAt: Date.now(), exitCode: -1 };
    }
    const selection = request.selection?.trim();
    const prompt = selection
      ? `${request.userMessage}\n\n${selection}`
      : request.userMessage;
    if (session.running || !session.ready) {
      session.queue.push({ prompt, settings });
      return session.status;
    }

    await this.startRun(session, prompt, settings);
    return session.status;
  }

  stopSession() {
    if (this.session) {
      if (this.session.idleTimer) clearTimeout(this.session.idleTimer);
      if (this.session.readyTimer) clearTimeout(this.session.readyTimer);
      this.session.pty.kill();
      this.session = null;
    }
  }

  resizeSession(cols: number, rows: number) {
    if (!this.session) return;
    try {
      this.session.pty.resize(cols, rows);
    } catch {
      // ignore resize errors
    }
  }

  private async ensureSession(settings: Settings): Promise<SessionState | null> {
    const cwd = this.workspace.getRoot() ?? process.cwd();
    const runTarget = settings.codexRunTarget ?? "windows";
    const useWsl = runTarget === "wsl" && process.platform === "win32";
    const codexPath = useWsl ? settings.codexPathWsl || "codex" : settings.codexPath || "codex";

    if (
      this.session &&
      this.session.cwd === cwd &&
      this.session.runTarget === runTarget &&
      this.session.codexPath === codexPath
    ) {
      return this.session;
    }

    if (this.session) {
      this.session.pty.kill();
      this.session = null;
    }

    try {
      const codexConfigPath = await resolveCodexConfigPath(this.logs, { target: runTarget });
      const env: NodeJS.ProcessEnv = useWsl
        ? buildWslHostEnv(process.env)
        : {
            ...process.env,
            ...(codexConfigPath && !useWsl ? { CODEX_CONFIG: codexConfigPath } : {})
          };

      const instructionsPathWin = await ensureInstructionsFile(cwd, this.logs);
      const instructionsPath = useWsl ? toWslPath(instructionsPathWin) : instructionsPathWin;
      const agentArgs = buildCodexAgentArgs(instructionsPath);
      const command = useWsl ? "wsl.exe" : codexPath;
      const shellEscape = (value: string) => `'${value.replace(/'/g, `'\"'\"'`)}'`;
      const args = useWsl
        ? [
            "--",
            "bash",
            "--noprofile",
            "--norc",
            "-lc",
            `cd ${shellEscape(toWslPath(cwd))} && ${shellEscape(codexPath)} ${agentArgs
              .map(shellEscape)
              .join(" ")}`
          ]
        : [...agentArgs];
      const pty = spawn(command, args, {
        name: "xterm-color",
        cwd,
        env
      });

      const session: SessionState = {
        id: randomUUID(),
        pty,
        cwd,
        runTarget,
        codexPath,
        running: false,
        ready: false,
        queue: [],
        lastOutputAt: Date.now(),
        status: { running: false, startedAt: 0 }
      };
      pty.onData((data) => this.handleOutput(session, data));
      pty.onExit(() => {
        if (this.session?.id === session.id) {
          this.session = null;
        }
      });
      this.session = session;
      session.readyTimer = setTimeout(() => {
        this.markReady(session);
      }, READY_FALLBACK_MS);
      return session;
    } catch (error) {
      this.logs.append("codex", `Codex session start failed: ${String(error)}`);
      return null;
    }
  }

  private handleOutput(session: SessionState, data: string) {
    session.lastOutputAt = Date.now();
    if (!session.acknowledged) {
      const normalized = data.toLowerCase();
      if (
        normalized.includes("press enter to continue") ||
        normalized.includes("allowcodex") ||
        normalized.includes("require approval")
      ) {
        session.acknowledged = true;
        session.pty.write("\r");
      }
    }
    this.window.webContents.send("codex:run:event", {
      type: "stdout",
      data,
      timestamp: Date.now()
    } satisfies CodexEvent);

    session.promptBuffer = this.updatePromptBuffer(session.promptBuffer ?? "", data);
    if (this.isPromptReady(session.promptBuffer)) {
      this.markReady(session);
    }
    if (session.running) {
      if (this.isPromptReady(session.promptBuffer)) {
        if (session.idleTimer) clearTimeout(session.idleTimer);
        void this.finishRun(session);
        return;
      }
      if (session.idleTimer) clearTimeout(session.idleTimer);
      session.idleTimer = setTimeout(() => {
        void this.finishRun(session);
      }, IDLE_MS);
    }
  }

  private updatePromptBuffer(existing: string, data: string) {
    const sanitized = data
      .replace(/\x1b\][^\x07]*\x07/g, "")
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
      .replace(/\x1b[@-Z\\-_]/g, "")
      .replace(/\r/g, "");
    const combined = `${existing}${sanitized}`;
    return combined.length > 800 ? combined.slice(-800) : combined;
  }

  private isPromptReady(buffer: string) {
    if (!buffer) return false;
    const lines = buffer.split(/\n/).slice(-6);
    for (const line of lines) {
      const cleaned = line.replace(/[│┃║╎┊┆┇┋]/g, "").trim();
      if (/^[>❯›»]\s*$/.test(cleaned)) return true;
      if (/^PS\s.+>\s*$/.test(cleaned)) return true;
    }
    if (/(^|\n)[│┃║╎┊┆┇┋\s]*[>❯›»]\s*$/.test(buffer)) return true;
    return false;
  }

  private markReady(session: SessionState) {
    if (session.ready) return;
    session.ready = true;
    if (session.readyTimer) {
      clearTimeout(session.readyTimer);
      session.readyTimer = undefined;
    }
    if (!session.running && session.queue.length) {
      const next = session.queue.shift();
      if (next) {
        void this.startRun(session, next.prompt, next.settings);
      }
    }
  }

  private async finishRun(session: SessionState) {
    if (!session.running || !session.snapshots || !session.runId) return;
    session.running = false;
    session.status = {
      running: false,
      startedAt: session.status.startedAt,
      endedAt: Date.now(),
      exitCode: 0
    };
    await this.emitFileChanges(session.snapshots, session.runId, session.lastSettings);
    this.window.webContents.send("codex:run:done", session.status);
    if (session.queue.length) {
      const next = session.queue.shift();
      if (next) {
        await this.startRun(session, next.prompt, next.settings);
      }
    }
  }

  private async startRun(session: SessionState, prompt: string, settings: Settings) {
    if (!session.ready) {
      session.queue.unshift({ prompt, settings });
      return;
    }
    session.promptBuffer = "";
    session.snapshots = await snapshotWorkspace(this.workspace);
    session.runId = randomUUID();
    session.lastSettings = settings;
    session.running = true;
    session.status = { running: true, startedAt: Date.now() };
    this.window.webContents.send("codex:run:start", session.status);
    const safePrompt = prompt.replace(/\x1b/g, "");
    session.pty.write("\r");
    session.pty.write(safePrompt);
    session.pty.write("\r");
  }

  private async emitFileChanges(
    snapshots: Map<string, string>,
    changeId: string,
    settings?: Settings
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
            await this.reviewStore.storeChange(payload, settings ?? ({} as Settings));
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
