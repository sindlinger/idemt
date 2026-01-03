import path from "node:path";
import fs from "node:fs/promises";
import { FSWatcher, watch } from "chokidar";
import type { BrowserWindow } from "electron";
import type { FileFilters, OpenFile, WorkspaceNode } from "../../shared/ipc";

const IGNORED_DIRS = new Set([".git", "node_modules", "dist", "logs", "runs", "reports"]);
const MQL_EXTENSIONS = new Set([".mq4", ".mq5", ".mqh", ".ex4", ".ex5", ".dll"]);
const PY_EXTENSIONS = new Set([".py"]);
const C_EXTENSIONS = new Set([".c"]);
const CPP_EXTENSIONS = new Set([".cpp", ".cc", ".cxx", ".hpp", ".hh", ".h"]);

export class WorkspaceService {
  private workspaceRoot: string | null = null;
  private window: BrowserWindow;
  private openFiles = new Set<string>();
  private dirCache = new Map<string, WorkspaceNode[]>();
  private filters: FileFilters | null = null;
  private dirWatchers = new Map<string, FSWatcher>();

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
    this.dirCache.clear();
    await this.setWatchedDirs([root]);
  }

  setFilters(filters?: FileFilters) {
    this.filters = filters ?? null;
    this.dirCache.clear();
  }

  async buildTree(filters?: FileFilters): Promise<WorkspaceNode | null> {
    if (!this.workspaceRoot) return null;
    const children = await this.listDirEntries(this.workspaceRoot, filters);
    return {
      type: "dir",
      path: this.workspaceRoot,
      name: path.basename(this.workspaceRoot),
      children
    };
  }

  async listDir(dirPath: string, filters?: FileFilters): Promise<WorkspaceNode[] | null> {
    if (!this.workspaceRoot) return null;
    const root = path.resolve(this.workspaceRoot);
    const target = path.resolve(dirPath);
    const relative = path.relative(root, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
    return this.listDirEntries(target, filters);
  }

  async openFile(filePath: string): Promise<OpenFile | null> {
    try {
      const content = await fs.readFile(filePath, "utf-8");
      this.setOpenFile(filePath);
      return {
        path: filePath,
        content,
        version: 1,
        language: getLanguageForFile(filePath)
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

  async listWorkspaceFiles(extensions?: string[]): Promise<string[]> {
    if (!this.workspaceRoot) return [];
    const results: string[] = [];
    const extSet = extensions ? new Set(extensions.map((ext) => ext.toLowerCase())) : null;
    await this.walk(this.workspaceRoot, results, extSet);
    return results;
  }

  private async walk(dir: string, results: string[], extSet: Set<string> | null) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        await this.walk(path.join(dir, entry.name), results, extSet);
      } else {
        if (extSet) {
          const ext = path.extname(entry.name).toLowerCase();
          if (!extSet.has(ext)) continue;
        }
        results.push(path.join(dir, entry.name));
      }
    }
  }

  private allowFile(name: string, filters?: FileFilters | null): boolean {
    const active = filters ?? this.filters;
    const any = active !== null && (active.mql || active.python || active.cpp);
    const allSelected = active !== null && active.mql && active.python && active.cpp;
    if (allSelected) return true;
    if (!any) return false;
    const ext = path.extname(name).toLowerCase();
    if (MQL_EXTENSIONS.has(ext)) return Boolean(active?.mql);
    if (PY_EXTENSIONS.has(ext)) return Boolean(active?.python);
    if (C_EXTENSIONS.has(ext) || CPP_EXTENSIONS.has(ext)) return Boolean(active?.cpp);
    return false;
  }

  private cacheKey(dirPath: string, filters?: FileFilters | null) {
    const active = filters ?? this.filters;
    const any = active !== null && (active.mql || active.python || active.cpp);
    const allSelected = active !== null && active.mql && active.python && active.cpp;
    if (!any || allSelected) return `${dirPath}|all`;
    return `${dirPath}|m${active?.mql ? 1 : 0}p${active?.python ? 1 : 0}c${active?.cpp ? 1 : 0}`;
  }

  private invalidateDir(dirPath: string) {
    for (const key of this.dirCache.keys()) {
      if (key.startsWith(`${dirPath}|`)) {
        this.dirCache.delete(key);
      }
    }
  }

  private async listDirEntries(dirPath: string, filters?: FileFilters | null): Promise<WorkspaceNode[]> {
    const key = this.cacheKey(dirPath, filters ?? null);
    const cached = this.dirCache.get(key);
    if (cached) return cached;
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const children: WorkspaceNode[] = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        children.push({
          type: "dir",
          path: path.join(dirPath, entry.name),
          name: entry.name
        });
      } else {
        if (!this.allowFile(entry.name, filters ?? null)) continue;
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

    this.dirCache.set(key, children);
    return children;
  }

  async setWatchedDirs(dirs: string[]): Promise<void> {
    if (!this.workspaceRoot) return;
    const root = path.resolve(this.workspaceRoot);
    const next = new Set<string>();
    next.add(root);
    for (const dir of dirs) {
      const resolved = path.resolve(dir);
      const relative = path.relative(root, resolved);
      if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
      next.add(resolved);
    }

    for (const [dir, watcher] of this.dirWatchers.entries()) {
      if (!next.has(dir)) {
        await watcher.close();
        this.dirWatchers.delete(dir);
      }
    }

    for (const dir of next) {
      if (!this.dirWatchers.has(dir)) {
        const watcher = this.createWatcher(dir);
        this.dirWatchers.set(dir, watcher);
      }
    }
  }

  private createWatcher(dirPath: string): FSWatcher {
    let debounceTimer: NodeJS.Timeout | null = null;
    const scheduleDirUpdate = (targetPath: string) => {
      const parent = path.dirname(targetPath);
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(async () => {
        debounceTimer = null;
        this.invalidateDir(parent);
        const children = await this.listDirEntries(parent);
        this.window.webContents.send("workspace:dir:update", { dirPath: parent, children });
      }, 200);
    };

    const watcher = watch(dirPath, {
      ignoreInitial: true,
      depth: 1,
      awaitWriteFinish: {
        stabilityThreshold: 250,
        pollInterval: 100
      },
      ignored: (target) => {
        const segments = target.split(path.sep);
        return segments.some((segment) => IGNORED_DIRS.has(segment));
      }
    });

    watcher.on("add", scheduleDirUpdate);
    watcher.on("unlink", scheduleDirUpdate);
    watcher.on("addDir", scheduleDirUpdate);
    watcher.on("unlinkDir", scheduleDirUpdate);

    watcher.on("change", async (filePath) => {
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

    return watcher;
  }
}

const getLanguageForFile = (filePath: string): OpenFile["language"] => {
  const ext = path.extname(filePath).toLowerCase();
  if (MQL_EXTENSIONS.has(ext)) return "mql";
  if (PY_EXTENSIONS.has(ext)) return "python";
  if (C_EXTENSIONS.has(ext)) return "c";
  if (CPP_EXTENSIONS.has(ext)) return "cpp";
  return "plaintext";
};
