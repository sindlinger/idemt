import type { BrowserWindow } from "electron";
import type { LogsAppendPayload } from "../../shared/ipc";
import { logLine } from "../logger";

export class LogsService {
  private window: BrowserWindow;
  private buffers: Record<string, string[]> = {
    build: [],
    test: [],
    codex: [],
    terminal: [],
    system: []
  };
  private maxLines = 400;

  constructor(window: BrowserWindow) {
    this.window = window;
  }

  append(source: LogsAppendPayload["source"], line: string) {
    const payload: LogsAppendPayload = {
      source,
      line,
      timestamp: Date.now()
    };
    if (!this.buffers[source]) this.buffers[source] = [];
    this.buffers[source].push(line);
    if (this.buffers[source].length > this.maxLines) {
      this.buffers[source].splice(0, this.buffers[source].length - this.maxLines);
    }
    this.window.webContents.send("logs:append", payload);
    logLine(`logs:${source}`, line);
  }

  getRecent(source: LogsAppendPayload["source"], max = 200): string[] {
    const buffer = this.buffers[source] ?? [];
    return buffer.slice(Math.max(0, buffer.length - max));
  }
}
