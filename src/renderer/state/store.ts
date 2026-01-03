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

export type CodexMessage = {
  role: "user" | "codex" | "system";
  text: string;
  timestamp: number;
};

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

export type WorkspaceSession = {
  root: string;
  tree?: WorkspaceNode;
  openFiles: OpenFileState[];
  activeFilePath?: string;
  expandedDirs: string[];
  diagnostics: Diagnostic[];
  outputLogs: LogsAppendPayload[];
  codexEvents: CodexEvent[];
  codexMessages: CodexMessage[];
  codexStatus: CodexRunStatus;
  codexSessionActive: boolean;
  reviewChanges: Record<string, ReviewChange>;
  testStatus?: TestStatus;
  reportHtml?: string;
};

const LOCAL_WORKSPACE_ID = "__local__";
const MAX_WORKSPACES = 4;

const createWorkspaceSession = (root: string): WorkspaceSession => ({
  root,
  tree: undefined,
  openFiles: [],
  activeFilePath: undefined,
  expandedDirs: [],
  diagnostics: [],
  outputLogs: [],
  codexEvents: [],
  codexMessages: [],
  codexStatus: { running: false, startedAt: 0 },
  codexSessionActive: false,
  reviewChanges: {},
  testStatus: undefined,
  reportHtml: undefined
});

type AppState = {
  settings: Settings;
  workspaces: Record<string, WorkspaceSession>;
  workspaceOrder: string[];
  activeWorkspaceId?: string;
  bottomPanelOpen: boolean;
  bottomTab: BottomTab;
  settingsOpen: boolean;
  setSettings: (settings: Settings) => void;
  addWorkspace: (root: string) => void;
  removeWorkspace: (root: string) => void;
  setActiveWorkspace: (root?: string) => void;
  setTree: (tree?: WorkspaceNode, workspaceId?: string) => void;
  setExpandedDirs: (dirs: string[], workspaceId?: string) => void;
  openFile: (file: OpenFile, workspaceId?: string) => void;
  setActiveFile: (path: string, workspaceId?: string) => void;
  updateFileContent: (
    path: string,
    content: string,
    savedContent?: string,
    workspaceId?: string
  ) => void;
  markSaved: (path: string, content: string, workspaceId?: string) => void;
  setDiagnostics: (diagnostics: Diagnostic[], workspaceId?: string) => void;
  addOutputLog: (log: LogsAppendPayload, workspaceId?: string) => void;
  addCodexEvent: (event: CodexEvent, workspaceId?: string) => void;
  addCodexMessage: (message: CodexMessage, workspaceId?: string) => void;
  setCodexMessages: (messages: CodexMessage[], workspaceId?: string) => void;
  setCodexStatus: (status: CodexRunStatus, workspaceId?: string) => void;
  setCodexSessionActive: (active: boolean, workspaceId?: string) => void;
  clearCodexSession: (workspaceId?: string) => void;
  renameOpenFile: (oldPath: string, newPath: string, content: string, workspaceId?: string) => void;
  addReviewChange: (change: ReviewChange, workspaceId?: string) => void;
  removeReviewChange: (path: string, workspaceId?: string) => void;
  setTestStatus: (status: TestStatus, workspaceId?: string) => void;
  setReportHtml: (html?: string, workspaceId?: string) => void;
  toggleBottomPanel: (open?: boolean) => void;
  setBottomTab: (tab: BottomTab) => void;
  setSettingsOpen: (open: boolean) => void;
};

const ensureWorkspace = (state: AppState, root: string) => {
  if (state.workspaces[root]) {
    return state;
  }
  return {
    ...state,
    workspaces: { ...state.workspaces, [root]: createWorkspaceSession(root) }
  };
};

const ensureWorkspaceOrder = (state: AppState, root: string) => {
  if (root === LOCAL_WORKSPACE_ID) return state;
  if (state.workspaceOrder.includes(root)) {
    const nextOrder = state.workspaceOrder.filter((item) => item !== root);
    return { ...state, workspaceOrder: [...nextOrder, root] };
  }
  return { ...state, workspaceOrder: [...state.workspaceOrder, root] };
};

const trimWorkspaceOrder = (state: AppState) => {
  if (state.workspaceOrder.length <= MAX_WORKSPACES) return state;
  const overflow = state.workspaceOrder.length - MAX_WORKSPACES;
  const removed = state.workspaceOrder.slice(0, overflow);
  const nextOrder = state.workspaceOrder.slice(overflow);
  const nextWorkspaces = { ...state.workspaces };
  for (const root of removed) {
    delete nextWorkspaces[root];
  }
  const activeWorkspaceId = nextOrder.includes(state.activeWorkspaceId ?? "")
    ? state.activeWorkspaceId
    : nextOrder[nextOrder.length - 1] ?? LOCAL_WORKSPACE_ID;
  return { ...state, workspaceOrder: nextOrder, workspaces: nextWorkspaces, activeWorkspaceId };
};

const resolveWorkspaceId = (state: AppState, workspaceId?: string) =>
  workspaceId ?? state.activeWorkspaceId ?? LOCAL_WORKSPACE_ID;

const updateWorkspace = (
  state: AppState,
  workspaceId: string,
  updater: (workspace: WorkspaceSession) => WorkspaceSession
) => {
  const existing = state.workspaces[workspaceId] ?? createWorkspaceSession(workspaceId);
  const updated = updater(existing);
  return {
    ...state,
    workspaces: { ...state.workspaces, [workspaceId]: updated }
  };
};

export const useAppStore = create<AppState>((set, get) => ({
  settings: {},
  workspaces: { [LOCAL_WORKSPACE_ID]: createWorkspaceSession(LOCAL_WORKSPACE_ID) },
  workspaceOrder: [],
  activeWorkspaceId: LOCAL_WORKSPACE_ID,
  bottomPanelOpen: false,
  bottomTab: "terminal",
  settingsOpen: false,
  setSettings: (settings) => set({ settings }),
  addWorkspace: (root) =>
    set((state) => {
      if (!root) return state;
      let next = ensureWorkspace(state, root);
      next = ensureWorkspaceOrder(next, root);
      next = trimWorkspaceOrder(next);
      return next;
    }),
  removeWorkspace: (root) =>
    set((state) => {
      if (!root || root === LOCAL_WORKSPACE_ID) return state;
      const nextWorkspaces = { ...state.workspaces };
      delete nextWorkspaces[root];
      const nextOrder = state.workspaceOrder.filter((item) => item !== root);
      const activeWorkspaceId =
        state.activeWorkspaceId === root
          ? nextOrder[nextOrder.length - 1] ?? LOCAL_WORKSPACE_ID
          : state.activeWorkspaceId;
      return {
        ...state,
        workspaces: nextWorkspaces,
        workspaceOrder: nextOrder,
        activeWorkspaceId
      };
    }),
  setActiveWorkspace: (root) =>
    set((state) => {
      if (!root) return { activeWorkspaceId: LOCAL_WORKSPACE_ID };
      let next = ensureWorkspace(state, root);
      next = ensureWorkspaceOrder(next, root);
      return { ...next, activeWorkspaceId: root };
    }),
  setTree: (tree, workspaceId) =>
    set((state) => {
      const id = resolveWorkspaceId(state, workspaceId);
      return updateWorkspace(state, id, (workspace) => ({ ...workspace, tree }));
    }),
  setExpandedDirs: (dirs, workspaceId) =>
    set((state) => {
      const id = resolveWorkspaceId(state, workspaceId);
      return updateWorkspace(state, id, (workspace) => ({ ...workspace, expandedDirs: dirs }));
    }),
  openFile: (file, workspaceId) =>
    set((state) => {
      const id = resolveWorkspaceId(state, workspaceId);
      const nextState = updateWorkspace(state, id, (workspace) => {
        const existing = workspace.openFiles.find((open) => open.path === file.path);
        if (existing) {
          return { ...workspace, activeFilePath: file.path };
        }
        return {
          ...workspace,
          openFiles: [
            ...workspace.openFiles,
            {
              ...file,
              savedContent: file.content,
              dirty: false
            }
          ],
          activeFilePath: file.path
        };
      });
      return nextState;
    }),
  setActiveFile: (path, workspaceId) =>
    set((state) => {
      const id = resolveWorkspaceId(state, workspaceId);
      return updateWorkspace(state, id, (workspace) => ({ ...workspace, activeFilePath: path }));
    }),
  updateFileContent: (path, content, savedContent, workspaceId) =>
    set((state) => {
      const id = resolveWorkspaceId(state, workspaceId);
      return updateWorkspace(state, id, (workspace) => ({
        ...workspace,
        openFiles: workspace.openFiles.map((open) => {
          if (open.path !== path) return open;
          const nextSaved = savedContent ?? open.savedContent;
          return {
            ...open,
            content,
            savedContent: nextSaved,
            dirty: content !== nextSaved
          };
        })
      }));
    }),
  markSaved: (path, content, workspaceId) =>
    set((state) => {
      const id = resolveWorkspaceId(state, workspaceId);
      return updateWorkspace(state, id, (workspace) => ({
        ...workspace,
        openFiles: workspace.openFiles.map((open) =>
          open.path === path
            ? {
                ...open,
                content,
                savedContent: content,
                dirty: false
              }
            : open
        )
      }));
    }),
  setDiagnostics: (diagnostics, workspaceId) =>
    set((state) => {
      const id = resolveWorkspaceId(state, workspaceId);
      return updateWorkspace(state, id, (workspace) => ({ ...workspace, diagnostics }));
    }),
  addOutputLog: (log, workspaceId) =>
    set((state) => {
      const id = resolveWorkspaceId(state, workspaceId);
      return updateWorkspace(state, id, (workspace) => ({
        ...workspace,
        outputLogs: [...workspace.outputLogs, log]
      }));
    }),
  addCodexEvent: (event, workspaceId) =>
    set((state) => {
      const id = resolveWorkspaceId(state, workspaceId);
      return updateWorkspace(state, id, (workspace) => ({
        ...workspace,
        codexEvents: [...workspace.codexEvents, event]
      }));
    }),
  addCodexMessage: (message, workspaceId) =>
    set((state) => {
      const id = resolveWorkspaceId(state, workspaceId);
      return updateWorkspace(state, id, (workspace) => ({
        ...workspace,
        codexMessages: [...workspace.codexMessages, message]
      }));
    }),
  setCodexMessages: (messages, workspaceId) =>
    set((state) => {
      const id = resolveWorkspaceId(state, workspaceId);
      return updateWorkspace(state, id, (workspace) => ({ ...workspace, codexMessages: messages }));
    }),
  setCodexStatus: (status, workspaceId) =>
    set((state) => {
      const id = resolveWorkspaceId(state, workspaceId);
      return updateWorkspace(state, id, (workspace) => ({ ...workspace, codexStatus: status }));
    }),
  setCodexSessionActive: (active, workspaceId) =>
    set((state) => {
      const id = resolveWorkspaceId(state, workspaceId);
      return updateWorkspace(state, id, (workspace) => ({
        ...workspace,
        codexSessionActive: active
      }));
    }),
  clearCodexSession: (workspaceId) =>
    set((state) => {
      const id = resolveWorkspaceId(state, workspaceId);
      return updateWorkspace(state, id, (workspace) => ({ ...workspace, codexMessages: [] }));
    }),
  renameOpenFile: (oldPath, newPath, content, workspaceId) =>
    set((state) => {
      const id = resolveWorkspaceId(state, workspaceId);
      return updateWorkspace(state, id, (workspace) => {
        const openFiles = workspace.openFiles.map((open) =>
          open.path === oldPath
            ? {
                ...open,
                path: newPath,
                content,
                savedContent: content,
                dirty: false
              }
            : open
        );
        const activeFilePath =
          workspace.activeFilePath === oldPath ? newPath : workspace.activeFilePath;
        return { ...workspace, openFiles, activeFilePath };
      });
    }),
  addReviewChange: (change, workspaceId) =>
    set((state) => {
      const id = resolveWorkspaceId(state, workspaceId);
      return updateWorkspace(state, id, (workspace) => ({
        ...workspace,
        reviewChanges: { ...workspace.reviewChanges, [change.path]: change }
      }));
    }),
  removeReviewChange: (path, workspaceId) =>
    set((state) => {
      const id = resolveWorkspaceId(state, workspaceId);
      return updateWorkspace(state, id, (workspace) => {
        const next = { ...workspace.reviewChanges };
        delete next[path];
        return { ...workspace, reviewChanges: next };
      });
    }),
  setTestStatus: (status, workspaceId) =>
    set((state) => {
      const id = resolveWorkspaceId(state, workspaceId);
      return updateWorkspace(state, id, (workspace) => ({ ...workspace, testStatus: status }));
    }),
  setReportHtml: (reportHtml, workspaceId) =>
    set((state) => {
      const id = resolveWorkspaceId(state, workspaceId);
      return updateWorkspace(state, id, (workspace) => ({ ...workspace, reportHtml }));
    }),
  toggleBottomPanel: (open) =>
    set((state) => ({ bottomPanelOpen: open ?? !state.bottomPanelOpen })),
  setBottomTab: (tab) => set({ bottomTab: tab }),
  setSettingsOpen: (open) => set({ settingsOpen: open })
}));
