import { app, dialog, ipcMain } from "electron";
import type { BrowserWindow } from "electron";
import type {
  BuildRequest,
  CodexReviewRequest,
  CodexRunRequest,
  FileFilters,
  Settings,
  TestRequest
} from "../shared/ipc";
import { BuildService } from "./services/BuildService";
import { CodexService } from "./services/CodexService";
import { CodexSessionService } from "./services/CodexSessionService";
import { getCodexModelsInfo } from "./services/CodexModelsService";
import { resolveCodexConfigPath } from "./services/CodexConfigService";
import { LogsService } from "./services/LogsService";
import type { SettingsService } from "./services/SettingsService";
import { TerminalService } from "./services/TerminalService";
import { TestService } from "./services/TestService";
import { WorkspaceService } from "./services/WorkspaceService";
import { ReviewStoreService } from "./services/ReviewStoreService";
import { logLine } from "./logger";
import fs from "node:fs/promises";
import path from "node:path";

export const registerIpc = async (window: BrowserWindow, settingsService: SettingsService) => {
  logLine("ipc", "registerIpc start");
  logLine("ipc", "settings loaded");

  const workspaceService = new WorkspaceService(window);
  const logsService = new LogsService(window);
  const buildService = new BuildService(window, logsService);
  const reviewStore = new ReviewStoreService(logsService);
  const codexService = new CodexService(
    window,
    logsService,
    workspaceService,
    buildService,
    reviewStore
  );
  const codexSessionService = new CodexSessionService(
    window,
    logsService,
    workspaceService,
    reviewStore
  );
  const testService = new TestService(window, logsService);
  const terminalService = new TerminalService(window);

  const WORKSPACE_LIMIT = 4;
  const updateRecentWorkspaces = async (root: string, remove = false) => {
    const current = settingsService.get().recentWorkspaces ?? [];
    let next = current.filter((item) => item !== root);
    if (!remove) {
      next = [...next, root];
    }
    if (next.length > WORKSPACE_LIMIT) {
      next = next.slice(next.length - WORKSPACE_LIMIT);
    }
    const nextRoot = remove
      ? settingsService.get().workspaceRoot === root
        ? next[next.length - 1] ?? ""
        : settingsService.get().workspaceRoot ?? ""
      : root;
    await settingsService.set({ workspaceRoot: nextRoot, recentWorkspaces: next });
    return { recentWorkspaces: next, workspaceRoot: nextRoot };
  };

  ipcMain.handle("settings:get", () => {
    logLine("ipc", "settings:get");
    return settingsService.get();
  });
  ipcMain.handle("settings:set", async (_event, partial: Settings) => {
    logLine("ipc", "settings:set");
    const updated = await settingsService.set(partial);
    return updated;
  });
  ipcMain.handle("settings:validate", async (_event, settings: Settings) => {
    logLine("ipc", "settings:validate");
    return settingsService.validate(settings);
  });

  ipcMain.handle("workspace:select", async () => {
    logLine("ipc", "workspace:select");
    const currentRoot = settingsService.get().workspaceRoot;
    const defaultPath = await resolveDefaultWorkspacePath(currentRoot);
    logLine("ipc", `workspace:dialog defaultPath=${defaultPath}`);
    const result = await dialog.showOpenDialog(window, {
      properties: ["openDirectory", "createDirectory"],
      defaultPath
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const root = result.filePaths[0];
    logLine("ipc", `workspace:selected ${root}`);
    await updateRecentWorkspaces(root);
    await workspaceService.setWorkspace(root);
    window.webContents.send("workspace:selected", root);
    const tree = await workspaceService.buildTree();
    if (tree) window.webContents.send("workspace:tree", tree);
    return root;
  });

  ipcMain.handle("workspace:activate", async (_event, root: string) => {
    logLine("ipc", `workspace:activate ${root}`);
    if (!root) return null;
    await updateRecentWorkspaces(root);
    await workspaceService.setWorkspace(root);
    window.webContents.send("workspace:selected", root);
    const tree = await workspaceService.buildTree();
    if (tree) window.webContents.send("workspace:tree", tree);
    return tree;
  });

  ipcMain.handle("workspace:close", async (_event, root: string) => {
    logLine("ipc", `workspace:close ${root}`);
    if (!root) return { workspaceRoot: "", recentWorkspaces: [] };
    const result = await updateRecentWorkspaces(root, true);
    if (result.workspaceRoot) {
      await workspaceService.setWorkspace(result.workspaceRoot);
      const tree = await workspaceService.buildTree();
      if (tree) window.webContents.send("workspace:tree", tree);
      window.webContents.send("workspace:selected", result.workspaceRoot);
      return { ...result, tree };
    }
    return { ...result, tree: null };
  });

  ipcMain.handle("workspace:tree:get", async (_event, filters?: FileFilters) => {
    logLine("ipc", "workspace:tree:get");
    const root = settingsService.get().workspaceRoot;
    if (root) await workspaceService.setWorkspace(root);
    return workspaceService.buildTree(filters);
  });

  ipcMain.handle(
    "workspace:dir:list",
    async (_event, payload: { dirPath: string; filters?: FileFilters }) => {
      logLine("ipc", `workspace:dir:list ${payload.dirPath}`);
      return workspaceService.listDir(payload.dirPath, payload.filters);
    }
  );

  ipcMain.on("workspace:filters:set", (_event, filters: FileFilters) => {
    logLine("ipc", "workspace:filters:set");
    workspaceService.setFilters(filters);
  });

  ipcMain.on("workspace:watch:set", (_event, payload: { dirs: string[] }) => {
    logLine("ipc", `workspace:watch:set ${payload.dirs.length}`);
    void workspaceService.setWatchedDirs(payload.dirs);
  });

  ipcMain.handle("file:open", async (_event, filePath: string) => {
    logLine("ipc", `file:open ${filePath}`);
    return workspaceService.openFile(filePath);
  });

  ipcMain.handle("file:save", async (_event, payload: { filePath: string; content: string }) => {
    logLine("ipc", `file:save ${payload.filePath}`);
    return workspaceService.saveFile(payload.filePath, payload.content);
  });

  ipcMain.handle("codex:run:start", async (_event, request: CodexRunRequest) => {
    logLine("ipc", "codex:run:start");
    return codexService.run(request, settingsService.get());
  });

  ipcMain.handle("codex:review:run", async (_event, request: CodexReviewRequest) => {
    logLine("ipc", "codex:review:run");
    return codexService.review(request, settingsService.get());
  });

  ipcMain.handle("codex:session:send", async (_event, request: CodexRunRequest) => {
    logLine("ipc", "codex:session:send");
    return codexSessionService.sendMessage(request, settingsService.get());
  });

  ipcMain.on("codex:session:stop", () => {
    logLine("ipc", "codex:session:stop");
    codexSessionService.stopSession();
  });

  ipcMain.on("codex:run:cancel", () => {
    logLine("ipc", "codex:run:cancel");
    codexService.cancel();
  });

  ipcMain.handle("codex:models:get", async () => {
    logLine("ipc", "codex:models:get");
    return getCodexModelsInfo(settingsService.get());
  });

  ipcMain.handle("codex:config:path", async () => {
    logLine("ipc", "codex:config:path");
    return resolveCodexConfigPath(logsService, { target: settingsService.get().codexRunTarget });
  });

  ipcMain.handle("build:start", async (_event, request: BuildRequest) =>
    (logLine("ipc", `build:start ${request.filePath}`),
    buildService.compile(request.filePath, settingsService.get()))
  );

  ipcMain.handle("test:start", async (_event, request: TestRequest) =>
    (logLine("ipc", "test:start"), testService.run(request, settingsService.get()))
  );

  ipcMain.handle(
    "terminal:spawn",
    (_event, options: { cwd?: string; shell?: string; env?: Record<string, string> }) => {
      logLine("ipc", `terminal:spawn cwd=${options.cwd ?? ""} shell=${options.shell ?? ""}`);
      return terminalService.spawnSession(options);
    }
  );

  ipcMain.on("window:minimize", () => window.minimize());
  ipcMain.on("window:close", () => window.close());
  ipcMain.on("window:maximize", () => {
    if (window.isMaximized()) {
      window.unmaximize();
    } else {
      window.maximize();
    }
  });

  ipcMain.handle("window:state:get", () => ({ maximized: window.isMaximized() }));
  window.on("maximize", () => {
    window.webContents.send("window:state", { maximized: true });
  });
  window.on("unmaximize", () => {
    window.webContents.send("window:state", { maximized: false });
  });

  let closeInProgress = false;
  let closeRequestId = 0;
  let isClosing = false;

  window.on("close", async (event) => {
    logLine("ipc", `window close event isClosing=${isClosing} closeInProgress=${closeInProgress}`);
    if (isClosing) return;
    if (closeInProgress) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    closeInProgress = true;
    closeRequestId += 1;
    window.webContents.send("app:close-request", { requestId: closeRequestId });
  });

  ipcMain.on("app:close-response", async (_event, payload: { requestId: number; dirtyCount: number }) => {
    logLine("ipc", `app:close-response requestId=${payload.requestId} dirty=${payload.dirtyCount}`);
    if (payload.requestId !== closeRequestId) return;
    if (payload.dirtyCount === 0) {
      isClosing = true;
      window.destroy();
      return;
    }

    const result = await dialog.showMessageBox(window, {
      type: "question",
      buttons: ["Salvar", "Não salvar", "Cancelar"],
      defaultId: 0,
      cancelId: 2,
      message: "Quer salvar as alterações?",
      detail: `Há ${payload.dirtyCount} arquivo(s) com alterações não salvas.`
    });

    if (result.response === 0) {
      window.webContents.send("app:save-all", { requestId: closeRequestId });
      return;
    }
    if (result.response === 1) {
      isClosing = true;
      window.destroy();
      return;
    }

    closeInProgress = false;
  });

  ipcMain.on("app:save-all:done", (_event, payload: { requestId: number; success: boolean }) => {
    logLine("ipc", `app:save-all:done requestId=${payload.requestId} success=${payload.success}`);
    if (payload.requestId !== closeRequestId) return;
    if (payload.success) {
      isClosing = true;
      window.destroy();
      return;
    }
    closeInProgress = false;
  });

  ipcMain.on("terminal:write", (_event, payload: { id: string; data: string }) => {
    terminalService.write(payload.id, payload.data);
  });

  ipcMain.on("terminal:resize", (_event, payload: { id: string; cols: number; rows: number }) =>
    terminalService.resize(payload.id, payload.cols, payload.rows)
  );

  ipcMain.on("terminal:close", (_event, id: string) => terminalService.close(id));

  ipcMain.handle("report:read", async (_event, filePath: string) => {
    logLine("ipc", `report:read ${filePath}`);
    return fs.readFile(filePath, "utf-8");
  });

  ipcMain.handle(
    "dialog:select",
    async (_event, options: { type: "file" | "directory"; title: string }) => {
      logLine("ipc", `dialog:select type=${options.type} title=${options.title}`);
      const result = await dialog.showOpenDialog(window, {
        title: options.title,
        properties: options.type === "directory" ? ["openDirectory"] : ["openFile"]
      });
      if (result.canceled || result.filePaths.length === 0) return null;
      return result.filePaths[0];
    }
  );

  ipcMain.handle(
    "dialog:save",
    async (_event, options: { title: string; defaultPath?: string }) => {
      logLine("ipc", `dialog:save title=${options.title} defaultPath=${options.defaultPath ?? ""}`);
      const result = await dialog.showSaveDialog(window, {
        title: options.title,
        defaultPath: options.defaultPath
      });
      if (result.canceled || !result.filePath) return null;
      return result.filePath;
    }
  );

  ipcMain.on("log:line", (_event, payload: { scope?: string; message: string }) => {
    logLine(payload.scope ?? "renderer", payload.message);
  });

  logLine("ipc", "registerIpc done");
};

const resolveDefaultWorkspacePath = async (current?: string) => {
  const candidates = await resolveTerminalRoots();
  if (current && (await pathExists(current))) {
    const parent = path.dirname(current);
    const match = candidates.find((root) => samePath(root, parent));
    return match ?? current;
  }

  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate;
  }

  return app.getPath("home");
};

const samePath = (left: string, right: string) =>
  path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();

const pathExists = async (value: string) => {
  try {
    await fs.access(value);
    return true;
  } catch {
    return false;
  }
};

const resolveTerminalRoots = async () => {
  const candidates: string[] = [];
  const isWsl =
    process.platform === "linux" &&
    (Boolean(process.env.WSL_INTEROP) || Boolean(process.env.WSL_DISTRO_NAME));

  if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    if (appData) {
      candidates.push(path.join(appData, "MetaQuotes", "Terminal"));
    }
  }

  if (isWsl) {
    const winUsersRoot = "/mnt/c/Users";
    const winUser = process.env.WINUSER || process.env.USERNAME || process.env.USER;
    if (winUser) {
      candidates.push(
        path.join(winUsersRoot, winUser, "AppData", "Roaming", "MetaQuotes", "Terminal")
      );
    }

    const discovered = await findMetaTraderTerminalRoots(winUsersRoot);
    candidates.push(...discovered);
  }

  return candidates;
};

const findMetaTraderTerminalRoots = async (winUsersRoot: string) => {
  const results: string[] = [];
  try {
    const entries = await fs.readdir(winUsersRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(
        winUsersRoot,
        entry.name,
        "AppData",
        "Roaming",
        "MetaQuotes",
        "Terminal"
      );
      if (await pathExists(candidate)) {
        results.push(candidate);
      }
    }
  } catch {
    return results;
  }
  return results;
};

const findLatestTerminalHash = async () => {
  const roots = await resolveTerminalRoots();
  let latestPath: string | null = null;
  let latestMtime = 0;

  for (const root of roots) {
    if (!(await pathExists(root))) continue;
    try {
      const entries = await fs.readdir(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const candidate = path.join(root, entry.name);
        if (!(await isTerminalHashDir(candidate))) continue;
        const stat = await fs.stat(candidate);
        if (stat.mtimeMs > latestMtime) {
          latestMtime = stat.mtimeMs;
          latestPath = candidate;
        }
      }
    } catch {
      continue;
    }
  }

  return latestPath;
};

const isTerminalHashDir = async (candidate: string) => {
  const mql5 = path.join(candidate, "MQL5");
  const mql4 = path.join(candidate, "MQL4");
  return (await pathExists(mql5)) || (await pathExists(mql4));
};
