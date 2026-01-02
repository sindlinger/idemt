/// <reference types="vite/client" />
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
} from "@shared/ipc";

declare global {
  interface Window {
    api: {
      settingsGet: () => Promise<Settings>;
      settingsSet: (settings: Settings) => Promise<Settings>;
      settingsValidate: (settings: Settings) => Promise<Record<string, boolean>>;
      selectWorkspace: () => Promise<string | null>;
      requestWorkspaceTree: () => Promise<WorkspaceNode | null>;
      openFile: (filePath: string) => Promise<OpenFile | null>;
      saveFile: (filePath: string, content: string) => Promise<boolean>;
      onWorkspaceSelected: (handler: (root: string) => void) => () => void;
      onWorkspaceTree: (handler: (tree: WorkspaceNode) => void) => () => void;
      onFileChanged: (handler: (payload: FileChangePayload) => void) => () => void;
      runCodex: (request: CodexRunRequest) => Promise<CodexRunStatus>;
      cancelCodex: () => void;
      onCodexEvent: (handler: (event: CodexEvent) => void) => () => void;
      onCodexDone: (handler: (status: CodexRunStatus) => void) => () => void;
      buildStart: (request: BuildRequest) => Promise<BuildResult>;
      onBuildResult: (handler: (result: BuildResult) => void) => () => void;
      testStart: (request: TestRequest) => Promise<TestStatus>;
      onTestStatus: (handler: (status: TestStatus) => void) => () => void;
      onTestDone: (handler: (status: TestStatus) => void) => () => void;
      logsAppend: (handler: (payload: LogsAppendPayload) => void) => () => void;
      terminalSpawn: (options: { cwd?: string; shell?: string }) => Promise<{ id: string }>;
      terminalWrite: (id: string, data: string) => void;
      terminalResize: (id: string, cols: number, rows: number) => void;
      terminalClose: (id: string) => void;
      onTerminalData: (handler: (payload: { id: string; data: string }) => void) => () => void;
      readReport: (filePath: string) => Promise<string>;
      selectPath: (options: { type: "file" | "directory"; title: string }) =>
        Promise<string | null>;
    };
  }
}

export {};
