export type WorkspaceNode = {
  type: "file" | "dir";
  path: string;
  name: string;
  children?: WorkspaceNode[];
};

export type FileFilters = {
  mql: boolean;
  python: boolean;
  cpp: boolean;
};

export type OpenFile = {
  path: string;
  content: string;
  version: number;
  language: "mql" | "plaintext" | "python" | "c" | "cpp";
};

export type Diagnostic = {
  filePath: string;
  line: number;
  column: number;
  severity: "error" | "warning" | "info";
  message: string;
  source?: string;
};

export type CodexRunRequest = {
  userMessage: string;
  activeFilePath?: string;
  selection?: string;
  contextBundle?: string;
  model?: string;
  level?: string;
  sessionActive?: boolean;
};

export type CodexModelsInfo = {
  models: string[];
  defaultModel?: string;
  defaultLevel?: string;
  source: "config" | "empty";
};

export type CodexEvent = {
  type: "stdout" | "stderr" | "json" | "status" | "timeline" | "log";
  data: string;
  timestamp: number;
};

export type CodexRunStatus = {
  running: boolean;
  startedAt: number;
  endedAt?: number;
  exitCode?: number;
};

export type ReviewChangePayload = {
  path: string;
  before: string;
  after: string;
  source?: string;
  changeId?: string;
  timestamp: number;
};

export type BuildRequest = {
  filePath: string;
};

export type BuildResult = {
  success: boolean;
  diagnostics: Diagnostic[];
  rawLogPath?: string;
  rawOutput?: string;
};

export type TestRequest = {
  expertPath: string;
  symbol: string;
  timeframe: string;
  fromDate: string;
  toDate: string;
  deposit?: number;
  reportPath?: string;
};

export type TestStatus = {
  running: boolean;
  phase: string;
  lastLogLines: string[];
  reportReady?: boolean;
  reportPath?: string;
};

export type TerminalSpawnOptions = {
  cwd?: string;
  shell?: string;
  env?: Record<string, string>;
};

export type Settings = {
  workspaceRoot?: string;
  recentWorkspaces?: string[];
  metaeditorPath?: string;
  terminalPath?: string;
  codexPath?: string;
  codexPathWsl?: string;
  codexArgs?: string;
  codexRunTarget?: "windows" | "wsl";
  mtDataDir?: string;
  reportsDir?: string;
  uiTheme?: "windows11" | "windowsClassic" | "macos" | "metatrader";
  uiMode?: "dark" | "light";
  editorFontSize?: number;
  editorLineNumbers?: boolean;
  editorShowRulers?: boolean;
  editorRulers?: number[];
  editorShowCursorPosition?: boolean;
  codexReviewProvider?: "local" | "googleDrive";
  codexReviewMaxMb?: number;
  codexReviewKeepDays?: number;
  codexReviewGoogleCredentials?: string;
  codexReviewGoogleFolderId?: string;
  windowBounds?: WindowBounds;
};

export type WindowBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
  isMaximized?: boolean;
};

export const IPC_CHANNELS = {
  workspaceSelected: "workspace:selected",
  workspaceTree: "workspace:tree",
  fileOpen: "file:open",
  fileSave: "file:save",
  fileChanged: "file:changed",
  codexRunStart: "codex:run:start",
  codexRunEvent: "codex:run:event",
  codexRunDone: "codex:run:done",
  codexRunCancel: "codex:run:cancel",
  buildStart: "build:start",
  buildResult: "build:result",
  testStart: "test:start",
  testStatus: "test:status",
  testDone: "test:done",
  logsAppend: "logs:append",
  settingsGet: "settings:get",
  settingsSet: "settings:set"
} as const;

export type FileChangePayload = {
  path: string;
  content: string;
  previousContent?: string;
  source?: "watcher" | "codex" | "unknown";
  changeId?: string;
};

export type LogsAppendPayload = {
  source: "build" | "test" | "codex" | "terminal" | "system";
  line: string;
  timestamp: number;
};

export type WorkspaceDirUpdate = {
  dirPath: string;
  children: WorkspaceNode[];
};
