import path from "node:path";
import fs from "node:fs/promises";
import { FSWatcher, watch } from "chokidar";
import type { BrowserWindow } from "electron";
import type { OpenFile, WorkspaceNode } from "../../shared/ipc";

const IGNORED_DIRS = new Set([".git", "node_modules", "dist", "logs", "runs", "reports"]);
const MQL_EXTENSIONS = new Set([".mq4", ".mq5", ".mqh"]);

export class WorkspaceService {
  private watcher: FSWatcher | null = null;
  private workspaceRoot: string | null = null;
  private window: BrowserWindow;
  private openFiles = new Set<string>();

  constructor(window: BrowserWindow) {
    this.window = window;
  }

  getRoot(): string | null {
    return this.workspaceRoot;
  }

  setOpenFile(filePath: string) {
    this.openFiles.add(filePath);
  }

  async setWorkspace(root: string): Promise<void> {
    this.workspaceRoot = root;
    await this.setupWatcher();
  }

  async buildTree(): Promise<WorkspaceNode | null> {
    if (!this.workspaceRoot) return null;
    return this.readDir(this.workspaceRoot);
  }

  async openFile(filePath: string): Promise<OpenFile | null> {
    try {
      const content = await fs.readFile(filePath, "utf-8");
      this.setOpenFile(filePath);
      return {
        path: filePath,
        content,
        version: 1,
        language: MQL_EXTENSIONS.has(path.extname(filePath).toLowerCase()) ? "mql" : "plaintext"
      };
    } catch {
      return null;
    }
  }

  async saveFile(filePath: string, content: string): Promise<boolean> {
    try {
      await fs.writeFile(filePath, content, "utf-8");
      return true;
    } catch {
      return false;
    }
  }

  async listWorkspaceFiles(): Promise<string[]> {
    if (!this.workspaceRoot) return [];
    const results: string[] = [];
    await this.walk(this.workspaceRoot, results);
    return results;
  }

  private async walk(dir: string, results: string[]) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        await this.walk(path.join(dir, entry.name), results);
      } else {
        results.push(path.join(dir, entry.name));
      }
    }
  }

  private async readDir(dirPath: string): Promise<WorkspaceNode> {
    const name = path.basename(dirPath);
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const children: WorkspaceNode[] = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        children.push(await this.readDir(path.join(dirPath, entry.name)));
      } else {
        children.push({
          type: "file",
          path: path.join(dirPath, entry.name),
          name: entry.name
        });
      }
    }

    children.sort((a, b) => {
      if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return { type: "dir", path: dirPath, name, children };
  }

  private async setupWatcher() {
    if (!this.workspaceRoot) return;
    if (this.watcher) {
      await this.watcher.close();
    }

    this.watcher = watch(this.workspaceRoot, {
      ignoreInitial: true,
      ignored: (target) => {
        const segments = target.split(path.sep);
        return segments.some((segment) => IGNORED_DIRS.has(segment));
      }
    });

    const sendTree = async () => {
      const tree = await this.buildTree();
      if (tree) this.window.webContents.send("workspace:tree", tree);
    };

    this.watcher.on("add", () => void sendTree());
    this.watcher.on("unlink", () => void sendTree());
    this.watcher.on("addDir", () => void sendTree());
    this.watcher.on("unlinkDir", () => void sendTree());

    this.watcher.on("change", async (filePath) => {
      try {
        const content = await fs.readFile(filePath, "utf-8");
        this.window.webContents.send("file:changed", {
          path: filePath,
          content,
          source: "watcher"
        });
      } catch {
        // ignore
      }
    });
  }
}
