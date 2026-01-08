/// <reference types="vite/client" />
import type {
  BuildRequest,
  BuildResult,
  CodexEvent,
  CodexModelsInfo,
  CodexRunRequest,
  CodexRunStatus,
  CodexReviewRequest,
  FileChangePayload,
  LogsAppendPayload,
  OpenFile,
  Settings,
  TestRequest,
  TestStatus,
  WorkspaceNode,
  FileFilters,
  WorkspaceDirUpdate
} from "@shared/ipc";

declare global {
  interface Window {
    api: {
      platform: string;
      nativeFrame: boolean;
      settingsGet: () => Promise<Settings>;
      settingsSet: (settings: Settings) => Promise<Settings>;
      settingsValidate: (settings: Settings) => Promise<Record<string, boolean>>;
      selectWorkspace: () => Promise<string | null>;
      activateWorkspace: (root: string) => Promise<WorkspaceNode | null>;
      closeWorkspace: (
        root: string
      ) => Promise<{ workspaceRoot: string; recentWorkspaces: string[]; tree?: WorkspaceNode | null }>;
      requestWorkspaceTree: (filters?: FileFilters) => Promise<WorkspaceNode | null>;
      listDirectory: (dirPath: string, filters?: FileFilters) => Promise<WorkspaceNode[] | null>;
      setWorkspaceFilters: (filters: FileFilters) => void;
      setWatchedDirs: (dirs: string[]) => void;
      openFile: (filePath: string) => Promise<OpenFile | null>;
      saveFile: (filePath: string, content: string) => Promise<boolean>;
      onWorkspaceSelected: (handler: (root: string) => void) => () => void;
      onWorkspaceTree: (handler: (tree: WorkspaceNode) => void) => () => void;
      onWorkspaceDirUpdate: (handler: (payload: WorkspaceDirUpdate) => void) => () => void;
      onFileChanged: (handler: (payload: FileChangePayload) => void) => () => void;
      runCodex: (request: CodexRunRequest) => Promise<CodexRunStatus>;
      codexReviewRun: (request: CodexReviewRequest) => Promise<CodexRunStatus>;
      codexSessionSend: (request: CodexRunRequest) => Promise<CodexRunStatus>;
      codexSessionStop: () => void;
      codexModelsGet: () => Promise<CodexModelsInfo>;
      codexConfigPathGet: () => Promise<string | null>;
      cancelCodex: () => void;
      onCodexEvent: (handler: (event: CodexEvent) => void) => () => void;
      onCodexDone: (handler: (status: CodexRunStatus) => void) => () => void;
      buildStart: (request: BuildRequest) => Promise<BuildResult>;
      onBuildResult: (handler: (result: BuildResult) => void) => () => void;
      testStart: (request: TestRequest) => Promise<TestStatus>;
      onTestStatus: (handler: (status: TestStatus) => void) => () => void;
      onTestDone: (handler: (status: TestStatus) => void) => () => void;
      logsAppend: (handler: (payload: LogsAppendPayload) => void) => () => void;
      terminalSpawn: (options: { cwd?: string; shell?: string; env?: Record<string, string> }) => Promise<{ id: string }>;
      terminalWrite: (id: string, data: string) => void;
      terminalResize: (id: string, cols: number, rows: number) => void;
      terminalClose: (id: string) => void;
      onTerminalData: (handler: (payload: { id: string; data: string }) => void) => () => void;
      readReport: (filePath: string) => Promise<string>;
      selectPath: (options: { type: "file" | "directory"; title: string }) =>
        Promise<string | null>;
      savePath: (options: { title: string; defaultPath?: string }) =>
        Promise<string | null>;
      windowMinimize: () => void;
      windowMaximize: () => void;
      windowClose: () => void;
      windowStateGet: () => Promise<{ maximized: boolean }>;
      onWindowState: (handler: (payload: { maximized: boolean }) => void) => () => void;
      onAppCloseRequest: (handler: (payload: { requestId: number }) => void) => () => void;
      replyAppCloseRequest: (payload: { requestId: number; dirtyCount: number }) => void;
      onAppSaveAll: (handler: (payload: { requestId: number }) => void) => () => void;
      replyAppSaveAll: (payload: { requestId: number; success: boolean }) => void;
      log: (payload: { scope?: string; message: string }) => void;
    };
  }
}

export {};
