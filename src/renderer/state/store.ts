import { create } from "zustand";
import type {
  CodexEvent,
  CodexRunStatus,
  Diagnostic,
  LogsAppendPayload,
  OpenFile,
  Settings,
  TestStatus,
  WorkspaceNode
} from "@shared/ipc";

export type OpenFileState = OpenFile & {
  savedContent: string;
  dirty: boolean;
};

export type ReviewChange = {
  path: string;
  before: string;
  after: string;
  diff: string;
  changedLines: number[];
  source?: string;
  changeId?: string;
};

export type BottomTab = "terminal" | "problems" | "output" | "report";

type AppState = {
  settings: Settings;
  workspaceRoot?: string;
  tree?: WorkspaceNode;
  openFiles: OpenFileState[];
  activeFilePath?: string;
  diagnostics: Diagnostic[];
  outputLogs: LogsAppendPayload[];
  codexEvents: CodexEvent[];
  codexStatus: CodexRunStatus;
  reviewChanges: Record<string, ReviewChange>;
  testStatus?: TestStatus;
  reportHtml?: string;
  bottomPanelOpen: boolean;
  bottomTab: BottomTab;
  settingsOpen: boolean;
  setSettings: (settings: Settings) => void;
  setWorkspaceRoot: (root?: string) => void;
  setTree: (tree?: WorkspaceNode) => void;
  openFile: (file: OpenFile) => void;
  setActiveFile: (path: string) => void;
  updateFileContent: (path: string, content: string, savedContent?: string) => void;
  markSaved: (path: string, content: string) => void;
  setDiagnostics: (diagnostics: Diagnostic[]) => void;
  addOutputLog: (log: LogsAppendPayload) => void;
  addCodexEvent: (event: CodexEvent) => void;
  setCodexStatus: (status: CodexRunStatus) => void;
  addReviewChange: (change: ReviewChange) => void;
  removeReviewChange: (path: string) => void;
  setTestStatus: (status: TestStatus) => void;
  setReportHtml: (html?: string) => void;
  toggleBottomPanel: (open?: boolean) => void;
  setBottomTab: (tab: BottomTab) => void;
  setSettingsOpen: (open: boolean) => void;
};

export const useAppStore = create<AppState>((set, get) => ({
  settings: {},
  openFiles: [],
  diagnostics: [],
  outputLogs: [],
  codexEvents: [],
  codexStatus: { running: false, startedAt: 0 },
  reviewChanges: {},
  bottomPanelOpen: false,
  bottomTab: "terminal",
  settingsOpen: false,
  setSettings: (settings) => set({ settings }),
  setWorkspaceRoot: (workspaceRoot) => set({ workspaceRoot }),
  setTree: (tree) => set({ tree }),
  openFile: (file) =>
    set((state) => {
      const existing = state.openFiles.find((open) => open.path === file.path);
      if (existing) {
        return { activeFilePath: file.path };
      }
      return {
        openFiles: [
          ...state.openFiles,
          {
            ...file,
            savedContent: file.content,
            dirty: false
          }
        ],
        activeFilePath: file.path
      };
    }),
  setActiveFile: (path) => set({ activeFilePath: path }),
  updateFileContent: (path, content, savedContent) =>
    set((state) => ({
      openFiles: state.openFiles.map((open) => {
        if (open.path !== path) return open;
        const nextSaved = savedContent ?? open.savedContent;
        return {
          ...open,
          content,
          savedContent: nextSaved,
          dirty: content !== nextSaved
        };
      })
    })),
  markSaved: (path, content) =>
    set((state) => ({
      openFiles: state.openFiles.map((open) =>
        open.path === path
          ? {
              ...open,
              content,
              savedContent: content,
              dirty: false
            }
          : open
      )
    })),
  setDiagnostics: (diagnostics) => set({ diagnostics }),
  addOutputLog: (log) => set((state) => ({ outputLogs: [...state.outputLogs, log] })),
  addCodexEvent: (event) => set((state) => ({ codexEvents: [...state.codexEvents, event] })),
  setCodexStatus: (status) => set({ codexStatus: status }),
  addReviewChange: (change) =>
    set((state) => ({
      reviewChanges: { ...state.reviewChanges, [change.path]: change }
    })),
  removeReviewChange: (path) =>
    set((state) => {
      const next = { ...state.reviewChanges };
      delete next[path];
      return { reviewChanges: next };
    }),
  setTestStatus: (status) => set({ testStatus: status }),
  setReportHtml: (reportHtml) => set({ reportHtml }),
  toggleBottomPanel: (open) =>
    set((state) => ({ bottomPanelOpen: open ?? !state.bottomPanelOpen })),
  setBottomTab: (tab) => set({ bottomTab: tab }),
  setSettingsOpen: (open) => set({ settingsOpen: open })
}));
