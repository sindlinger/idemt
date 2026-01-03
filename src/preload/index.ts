import { contextBridge, ipcRenderer } from "electron";
import type {
  BuildRequest,
  BuildResult,
  CodexEvent,
  CodexRunRequest,
  CodexRunStatus,
  FileChangePayload,
  LogsAppendPayload,
  OpenFile,
  Settings,
  TestRequest,
  TestStatus,
  WorkspaceNode,
  FileFilters,
  WorkspaceDirUpdate
} from "../shared/ipc";

const on = <T>(channel: string, handler: (payload: T) => void) => {
  const listener = (_event: Electron.IpcRendererEvent, payload: T) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld("api", {
  settingsGet: (): Promise<Settings> => ipcRenderer.invoke("settings:get"),
  settingsSet: (settings: Settings): Promise<Settings> => ipcRenderer.invoke("settings:set", settings),
  settingsValidate: (settings: Settings): Promise<Record<string, boolean>> =>
    ipcRenderer.invoke("settings:validate", settings),
  selectWorkspace: (): Promise<string | null> => ipcRenderer.invoke("workspace:select"),
  activateWorkspace: (root: string): Promise<WorkspaceNode | null> =>
    ipcRenderer.invoke("workspace:activate", root),
  closeWorkspace: (
    root: string
  ): Promise<{ workspaceRoot: string; recentWorkspaces: string[]; tree?: WorkspaceNode | null }> =>
    ipcRenderer.invoke("workspace:close", root),
  requestWorkspaceTree: (filters?: FileFilters): Promise<WorkspaceNode | null> =>
    ipcRenderer.invoke("workspace:tree:get", filters),
  listDirectory: (dirPath: string, filters?: FileFilters): Promise<WorkspaceNode[] | null> =>
    ipcRenderer.invoke("workspace:dir:list", { dirPath, filters }),
  setWorkspaceFilters: (filters: FileFilters) => ipcRenderer.send("workspace:filters:set", filters),
  setWatchedDirs: (dirs: string[]) => ipcRenderer.send("workspace:watch:set", { dirs }),
  openFile: (filePath: string): Promise<OpenFile | null> => ipcRenderer.invoke("file:open", filePath),
  saveFile: (filePath: string, content: string): Promise<boolean> =>
    ipcRenderer.invoke("file:save", { filePath, content }),
  onWorkspaceSelected: (handler: (root: string) => void) => on("workspace:selected", handler),
  onWorkspaceTree: (handler: (tree: WorkspaceNode) => void) => on("workspace:tree", handler),
  onWorkspaceDirUpdate: (handler: (payload: WorkspaceDirUpdate) => void) =>
    on("workspace:dir:update", handler),
  onFileChanged: (handler: (payload: FileChangePayload) => void) => on("file:changed", handler),
  runCodex: (request: CodexRunRequest): Promise<CodexRunStatus> =>
    ipcRenderer.invoke("codex:run:start", request),
  cancelCodex: (): void => ipcRenderer.send("codex:run:cancel"),
  onCodexEvent: (handler: (event: CodexEvent) => void) => on("codex:run:event", handler),
  onCodexDone: (handler: (status: CodexRunStatus) => void) => on("codex:run:done", handler),
  buildStart: (request: BuildRequest): Promise<BuildResult> => ipcRenderer.invoke("build:start", request),
  onBuildResult: (handler: (result: BuildResult) => void) => on("build:result", handler),
  testStart: (request: TestRequest): Promise<TestStatus> => ipcRenderer.invoke("test:start", request),
  onTestStatus: (handler: (status: TestStatus) => void) => on("test:status", handler),
  onTestDone: (handler: (status: TestStatus) => void) => on("test:done", handler),
  logsAppend: (handler: (payload: LogsAppendPayload) => void) => on("logs:append", handler),
  terminalSpawn: (options: { cwd?: string; shell?: string }) =>
    ipcRenderer.invoke("terminal:spawn", options),
  terminalWrite: (id: string, data: string) => ipcRenderer.send("terminal:write", { id, data }),
  terminalResize: (id: string, cols: number, rows: number) =>
    ipcRenderer.send("terminal:resize", { id, cols, rows }),
  terminalClose: (id: string) => ipcRenderer.send("terminal:close", id),
  onTerminalData: (handler: (payload: { id: string; data: string }) => void) =>
    on("terminal:data", handler),
  readReport: (filePath: string): Promise<string> => ipcRenderer.invoke("report:read", filePath),
  selectPath: (options: { type: "file" | "directory"; title: string }) =>
    ipcRenderer.invoke("dialog:select", options),
  savePath: (options: { title: string; defaultPath?: string }) =>
    ipcRenderer.invoke("dialog:save", options),
  windowMinimize: () => ipcRenderer.send("window:minimize"),
  windowMaximize: () => ipcRenderer.send("window:maximize"),
  windowClose: () => ipcRenderer.send("window:close"),
  windowStateGet: () => ipcRenderer.invoke("window:state:get"),
  onWindowState: (handler: (payload: { maximized: boolean }) => void) =>
    on("window:state", handler),
  onAppCloseRequest: (handler: (payload: { requestId: number }) => void) =>
    on("app:close-request", handler),
  replyAppCloseRequest: (payload: { requestId: number; dirtyCount: number }) =>
    ipcRenderer.send("app:close-response", payload),
  onAppSaveAll: (handler: (payload: { requestId: number }) => void) =>
    on("app:save-all", handler),
  replyAppSaveAll: (payload: { requestId: number; success: boolean }) =>
    ipcRenderer.send("app:save-all:done", payload),
  log: (payload: { scope?: string; message: string }) => ipcRenderer.send("log:line", payload)
});
