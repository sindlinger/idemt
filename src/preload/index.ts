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
  WorkspaceNode
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
  requestWorkspaceTree: (): Promise<WorkspaceNode | null> => ipcRenderer.invoke("workspace:tree:get"),
  openFile: (filePath: string): Promise<OpenFile | null> => ipcRenderer.invoke("file:open", filePath),
  saveFile: (filePath: string, content: string): Promise<boolean> =>
    ipcRenderer.invoke("file:save", { filePath, content }),
  onWorkspaceSelected: (handler: (root: string) => void) => on("workspace:selected", handler),
  onWorkspaceTree: (handler: (tree: WorkspaceNode) => void) => on("workspace:tree", handler),
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
    ipcRenderer.invoke("dialog:select", options)
});
