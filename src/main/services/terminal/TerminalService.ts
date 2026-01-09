import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { BrowserWindow } from "electron";
import { spawn } from "node-pty";
import type { IPty } from "node-pty";
import { logLine } from "../logger";

export class TerminalService {
  private window: BrowserWindow;
  private sessions = new Map<string, IPty>();

  constructor(window: BrowserWindow) {
    this.window = window;
  }

  spawnSession(options: { cwd?: string; shell?: string; env?: Record<string, string> }) {
    try {
      const id = randomUUID();
      const shell = options.shell || this.defaultShell();
      const pty = spawn(shell, [], {
        name: "xterm-color",
        cwd: options.cwd || process.cwd(),
        env: { ...process.env, ...(options.env ?? {}) }
      });

      this.sessions.set(id, pty);

      pty.onData((data) => {
        this.window.webContents.send("terminal:data", { id, data });
      });

      pty.onExit(() => {
        this.sessions.delete(id);
        this.window.webContents.send("terminal:data", { id, data: "\r\n[terminal closed]\r\n" });
      });

      return { id };
    } catch (error) {
      logLine("terminal", `spawn failed ${String(error)}`);
      return { id: "" };
    }
  }

  write(id: string, data: string) {
    this.sessions.get(id)?.write(data);
  }

  resize(id: string, cols: number, rows: number) {
    this.sessions.get(id)?.resize(cols, rows);
  }

  close(id: string) {
    const session = this.sessions.get(id);
    if (session) {
      session.kill();
      this.sessions.delete(id);
    }
  }

  private defaultShell() {
    if (os.platform() === "win32") {
      return "powershell.exe";
    }
    return process.env.SHELL || "bash";
  }
}
