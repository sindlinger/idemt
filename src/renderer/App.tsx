import { useEffect, useMemo, useRef, useState } from "react";
import { Pin, PinOff } from "lucide-react";
import type {
  CodexModelsInfo,
  CodexRunStatus,
  Diagnostic,
  FileChangePayload,
  FileFilters,
  TestRequest,
  TestStatus,
  WorkspaceNode
} from "@shared/ipc";
import { useAppStore } from "@state/store";
import { calculateChangedLines, createUnifiedDiff } from "@state/diff";
import TopBar from "./components/TopBar";
import LeftSidebar from "./components/LeftSidebar";
import EditorPane from "./components/EditorPane";
import CodexSidebar from "./components/CodexSidebar";
import BottomPanel from "./components/BottomPanel";
import SettingsModal from "./components/SettingsModal";

const defaultTestConfig: TestRequest = {
  expertPath: "",
  symbol: "EURUSD",
  timeframe: "M5",
  fromDate: "2020.01.01",
  toDate: "2020.12.31",
  deposit: 10000
};

const joinPath = (base: string, file: string) => {
  if (!base) return file;
  const slash = base.includes("\\") ? "\\" : "/";
  return `${base.replace(/[\\/]+$/, "")}${slash}${file}`;
};

const getLanguageForExtension = (ext: string) => {
  switch (ext.toLowerCase()) {
    case "mq4":
    case "mq5":
    case "mqh":
      return "mql";
    case "py":
      return "python";
    case "c":
      return "c";
    case "cpp":
    case "cc":
    case "cxx":
    case "hpp":
    case "hh":
    case "h":
      return "cpp";
    default:
      return "plaintext";
  }
};

const CODEX_STORAGE_KEY = "mt5ide.codex.session";
const LOCAL_WORKSPACE_ID = "__local__";
const getCodexStorageKey = (workspaceId: string) => `${CODEX_STORAGE_KEY}:${workspaceId}`;
const WORKSPACE_STATE_STORAGE_KEY = "mt5ide.workspace.state";
const LAYOUT_STORAGE_KEY = "mt5ide.layout.state";
const SPLITTER_SIZE = 8;

type LayoutState = {
  leftWidth: number;
  rightWidth: number;
  bottomHeight: number;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
};

const DEFAULT_LAYOUT: LayoutState = {
  leftWidth: 260,
  rightWidth: 320,
  bottomHeight: 260,
  leftCollapsed: false,
  rightCollapsed: false
};

type WorkspaceStateCache = Record<
  string,
  { openFiles: string[]; activeFilePath?: string; expandedDirs?: string[] }
>;

const readWorkspaceState = () => {
  try {
    const raw = window.localStorage.getItem(WORKSPACE_STATE_STORAGE_KEY);
    if (!raw) return {} as WorkspaceStateCache;
    return JSON.parse(raw) as WorkspaceStateCache;
  } catch {
    return {} as WorkspaceStateCache;
  }
};

const writeWorkspaceState = (state: WorkspaceStateCache) => {
  try {
    window.localStorage.setItem(WORKSPACE_STATE_STORAGE_KEY, JSON.stringify(state));
  } catch {
    return;
  }
};

const readLayoutState = (): LayoutState => {
  try {
    const raw = window.localStorage.getItem(LAYOUT_STORAGE_KEY);
    if (!raw) return DEFAULT_LAYOUT;
    const parsed = JSON.parse(raw) as Partial<LayoutState>;
    return {
      leftWidth: Number.isFinite(parsed.leftWidth) ? parsed.leftWidth! : DEFAULT_LAYOUT.leftWidth,
      rightWidth: Number.isFinite(parsed.rightWidth)
        ? parsed.rightWidth!
        : DEFAULT_LAYOUT.rightWidth,
      bottomHeight: Number.isFinite(parsed.bottomHeight)
        ? parsed.bottomHeight!
        : DEFAULT_LAYOUT.bottomHeight,
      leftCollapsed: Boolean(parsed.leftCollapsed),
      rightCollapsed: Boolean(parsed.rightCollapsed)
    };
  } catch {
    return DEFAULT_LAYOUT;
  }
};

const writeLayoutState = (state: LayoutState) => {
  try {
    window.localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(state));
  } catch {
    return;
  }
};

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

const removeWorkspaceState = (workspaceId: string) => {
  const state = readWorkspaceState();
  delete state[workspaceId];
  writeWorkspaceState(state);
  try {
    window.localStorage.removeItem(getCodexStorageKey(workspaceId));
  } catch {
    return;
  }
};

const buildCodexContextBundle = (messages: { role: string; text: string }[]) => {
  const recent = messages.slice(-8);
  const lines = recent.map((message) => `${message.role.toUpperCase()}: ${message.text}`);
  return lines.join("\n");
};

const trimCodexMessage = (text: string, limit = 4000) => {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n...`;
};

const log = (message: string, scope = "renderer") => {
  if (typeof window?.api?.log === "function") {
    window.api.log({ scope, message });
  }
};

const updateTreeChildren = (
  node: WorkspaceNode,
  dirPath: string,
  children: WorkspaceNode[]
): WorkspaceNode => {
  if (node.type === "dir" && node.path === dirPath) {
    return { ...node, children };
  }
  if (!node.children || node.children.length === 0) return node;
  return {
    ...node,
    children: node.children.map((child) => updateTreeChildren(child, dirPath, children))
  };
};

const App = () => {
  const {
    settings,
    setSettings,
    workspaces,
    workspaceOrder,
    activeWorkspaceId,
    addWorkspace,
    removeWorkspace,
    setActiveWorkspace,
    setTree,
    setExpandedDirs,
    setActiveFile,
    openFile,
    closeOpenFile,
    updateFileContent,
    markSaved,
    renameOpenFile,
    setDiagnostics,
    addOutputLog,
    addCodexEvent,
    addCodexMessage,
    setCodexMessages,
    setCodexStatus,
    setCodexSessionActive,
    clearCodexSession,
    addReviewChange,
    removeReviewChange,
    setTestStatus,
    setReportHtml,
    bottomPanelOpen,
    toggleBottomPanel,
    bottomTab,
    setBottomTab,
    settingsOpen,
    setSettingsOpen
  } = useAppStore();
  const api = window.api as Partial<typeof window.api>;

  const activeWorkspace = activeWorkspaceId ? workspaces[activeWorkspaceId] : undefined;
  const workspaceRoot =
    activeWorkspaceId && activeWorkspaceId !== LOCAL_WORKSPACE_ID ? activeWorkspaceId : undefined;
  const tree = activeWorkspace?.tree;
  const openFiles = activeWorkspace?.openFiles ?? [];
  const activeFilePath = activeWorkspace?.activeFilePath;
  const expandedDirs = activeWorkspace?.expandedDirs ?? [];
  const diagnostics = activeWorkspace?.diagnostics ?? [];
  const outputLogs = activeWorkspace?.outputLogs ?? [];
  const codexEvents = activeWorkspace?.codexEvents ?? [];
  const codexMessages = activeWorkspace?.codexMessages ?? [];
  const codexStatus = activeWorkspace?.codexStatus ?? { running: false, startedAt: 0 };
  const codexSessionActive = activeWorkspace?.codexSessionActive ?? false;
  const reviewChanges = activeWorkspace?.reviewChanges ?? {};
  const testStatus = activeWorkspace?.testStatus;
  const reportHtml = activeWorkspace?.reportHtml;

  const [selection, setSelection] = useState("");
  const [fileFilters, setFileFilters] = useState<FileFilters>({
    mql: true,
    python: true,
    cpp: true
  });
  const [codexModelsInfo, setCodexModelsInfo] = useState<CodexModelsInfo>({
    models: [],
    source: "empty"
  });
  const [newFileExt, setNewFileExt] = useState("mq5");
  const [layout, setLayout] = useState<LayoutState>(() => readLayoutState());
  const [viewport, setViewport] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight
  }));
  const [cursorPos, setCursorPos] = useState({ line: 1, column: 1 });
  const [navigationTarget, setNavigationTarget] = useState<{
    path: string;
    line: number;
    column: number;
  } | null>(null);
  const [testConfig, setTestConfig] = useState<TestRequest>(defaultTestConfig);
  const codexRunStartIndexRef = useRef<Record<string, number>>({});
  const codexWorkspaceRef = useRef<string | null>(null);
  const untitledCounterRef = useRef(1);

  const openBottomPanel = () => {
    toggleBottomPanel(true);
  };

  const toggleBottomPanelOpen = () => {
    toggleBottomPanel(!bottomPanelOpen);
  };

  useEffect(() => {
    writeLayoutState(layout);
  }, [layout]);

  useEffect(() => {
    log("App mounted", "renderer:startup");
    requestAnimationFrame(() => {
      const appEl = document.querySelector(".app");
      if (!appEl) return;
      const styles = getComputedStyle(appEl);
      const height = styles.getPropertyValue("--titlebar-height").trim();
      const width = styles.getPropertyValue("--titlebar-width").trim();
      const offset = styles.getPropertyValue("--titlebar-x").trim();
      log(
        `titlebar overlay css height=${height} width=${width} x=${offset}`,
        "renderer:startup"
      );
      const overlay = (window.navigator as Navigator & {
        windowControlsOverlay?: { visible?: boolean; addEventListener?: Function };
      }).windowControlsOverlay;
      const visible = Boolean(overlay?.visible);
      appEl.setAttribute("data-titlebar-overlay", visible ? "true" : "false");
      log(`titlebar overlay api visible=${visible}`, "renderer:startup");
      if (overlay?.addEventListener) {
        overlay.addEventListener("geometrychange", () => {
          const nextVisible = Boolean(overlay.visible);
          appEl.setAttribute("data-titlebar-overlay", nextVisible ? "true" : "false");
          log(`titlebar overlay geometrychange visible=${nextVisible}`, "renderer:startup");
        });
      }
    });
    if (typeof api.settingsGet !== "function") {
      log("window.api.settingsGet missing", "renderer:startup");
      return;
    }
    api.settingsGet().then((loaded) => {
      log("settings loaded", "renderer:startup");
      setSettings(loaded);
      const recent = (loaded.recentWorkspaces ?? []).filter(Boolean);
      const roots = recent.length
        ? recent
        : loaded.workspaceRoot
        ? [loaded.workspaceRoot]
        : [];
      roots.forEach((root) => addWorkspace(root));
      const activeRoot = roots[roots.length - 1];
      if (activeRoot) {
        setActiveWorkspace(activeRoot);
        if (typeof api.activateWorkspace === "function") {
          api.activateWorkspace(activeRoot).then((tree) => {
            if (tree) setTree(tree, activeRoot);
            log("workspace tree requested", "renderer:startup");
          });
        } else if (typeof api.requestWorkspaceTree === "function") {
          api.requestWorkspaceTree(fileFilters).then((tree) => {
            if (tree) setTree(tree, activeRoot);
            log("workspace tree requested", "renderer:startup");
          });
        }
        api.setWatchedDirs?.([activeRoot]);
      }
    });
  }, [addWorkspace, api, fileFilters, setActiveWorkspace, setSettings, setTree]);

  useEffect(() => {
    if (typeof api.codexModelsGet !== "function") return;
    api.codexModelsGet()
      .then((info) => setCodexModelsInfo(info))
      .catch(() => setCodexModelsInfo({ models: [], source: "empty" }));
  }, [api]);

  useEffect(() => {
    api.setWorkspaceFilters?.(fileFilters);
    if (!workspaceRoot) return;
    api.requestWorkspaceTree?.(fileFilters).then((tree) => {
      if (tree) {
        const id = activeWorkspaceId ?? LOCAL_WORKSPACE_ID;
        setTree(tree, id);
      }
    });
  }, [activeWorkspaceId, api, fileFilters, workspaceRoot, setTree]);

  useEffect(() => {
    if (!workspaceRoot) return;
    api.setWatchedDirs?.([workspaceRoot]);
  }, [api, workspaceRoot]);

  useEffect(() => {
    const handleResize = () =>
      setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useEffect(() => {
    const workspaceId = activeWorkspaceId ?? LOCAL_WORKSPACE_ID;
    if (openFiles.length > 0) return;
    if (workspaceId !== LOCAL_WORKSPACE_ID) {
      const saved = readWorkspaceState()[workspaceId];
      if (saved?.openFiles?.length) return;
    }
    openFile(
      {
        path: "untitled:1",
        content: "",
        version: 1,
        language: "mql"
      },
      workspaceId
    );
    log("opened untitled:1", "renderer:startup");
    untitledCounterRef.current = 2;
  }, [activeWorkspaceId, openFiles.length, openFile]);

  useEffect(() => {
    const workspaceId = activeWorkspaceId ?? LOCAL_WORKSPACE_ID;
    try {
      const raw = window.localStorage.getItem(getCodexStorageKey(workspaceId));
      if (!raw) return;
      const parsed = JSON.parse(raw) as {
        messages?: typeof codexMessages;
        sessionActive?: boolean;
      };
      if (parsed.messages && Array.isArray(parsed.messages)) {
        setCodexMessages(parsed.messages, workspaceId);
      }
      if (typeof parsed.sessionActive === "boolean") {
        setCodexSessionActive(parsed.sessionActive, workspaceId);
      }
    } catch {
      return;
    }
  }, [activeWorkspaceId, setCodexMessages, setCodexSessionActive]);

  useEffect(() => {
    const workspaceId = activeWorkspaceId ?? LOCAL_WORKSPACE_ID;
    try {
      window.localStorage.setItem(
        getCodexStorageKey(workspaceId),
        JSON.stringify({ messages: codexMessages, sessionActive: codexSessionActive })
      );
    } catch {
      return;
    }
  }, [activeWorkspaceId, codexMessages, codexSessionActive]);

  useEffect(() => {
    const handleCodexDone = (status: CodexRunStatus) => {
      const workspaceId =
        codexWorkspaceRef.current ??
        useAppStore.getState().activeWorkspaceId ??
        LOCAL_WORKSPACE_ID;
      setCodexStatus(status, workspaceId);
      const state = useAppStore.getState();
      const workspace = state.workspaces[workspaceId];
      const startIndex = codexRunStartIndexRef.current[workspaceId] ?? 0;
      const recent = workspace?.codexEvents.slice(startIndex) ?? [];
      delete codexRunStartIndexRef.current[workspaceId];
      codexWorkspaceRef.current = null;
      const response = recent
        .filter((event) => event.type === "stdout" || event.type === "stderr")
        .map((event) => event.data)
        .join("")
        .trim();
      const finalText = response ? trimCodexMessage(response) : "Codex finished.";
      addCodexMessage({ role: "codex", text: finalText, timestamp: Date.now() }, workspaceId);
    };

    const handleAppCloseRequest = ({ requestId }: { requestId: number }) => {
      log(`app:close-request id=${requestId}`, "renderer:close");
      const state = useAppStore.getState();
      const dirtyCount = Object.values(state.workspaces).reduce(
        (count, workspace) =>
          count + workspace.openFiles.filter((file) => file.dirty).length,
        0
      );
      api.replyAppCloseRequest?.({ requestId, dirtyCount });
    };

    const handleAppSaveAll = async ({ requestId }: { requestId: number }) => {
      log(`app:save-all id=${requestId}`, "renderer:close");
      const state = useAppStore.getState();
      const dirtyFiles = Object.entries(state.workspaces).flatMap(([workspaceId, workspace]) =>
        workspace.openFiles
          .filter((file) => file.dirty)
          .map((file) => ({ workspaceId, file }))
      );
      for (const { file, workspaceId } of dirtyFiles) {
        const ok = await saveOpenFile(file, workspaceId);
        if (!ok) {
          api.replyAppSaveAll?.({ requestId, success: false });
          return;
        }
      }
      api.replyAppSaveAll?.({ requestId, success: true });
    };

    const unsubscribers: Array<() => void> = [];

    if (api.onWorkspaceSelected) {
      unsubscribers.push(
        api.onWorkspaceSelected((root) => {
          addWorkspace(root);
          setActiveWorkspace(root);
        })
      );
    }
    if (api.onWorkspaceTree) {
      unsubscribers.push(
        api.onWorkspaceTree((tree) => {
          const state = useAppStore.getState();
          const id = state.activeWorkspaceId ?? LOCAL_WORKSPACE_ID;
          setTree(tree, id);
        })
      );
    }
    if (api.onWorkspaceDirUpdate) {
      unsubscribers.push(
        api.onWorkspaceDirUpdate((payload) => {
          const state = useAppStore.getState();
          const id = state.activeWorkspaceId ?? LOCAL_WORKSPACE_ID;
          const current = state.workspaces[id]?.tree;
          if (!current) return;
          setTree(updateTreeChildren(current, payload.dirPath, payload.children), id);
        })
      );
    }
    if (api.onFileChanged) {
      unsubscribers.push(api.onFileChanged((payload) => handleFileChanged(payload)));
    }
    if (api.onCodexEvent) {
      unsubscribers.push(
        api.onCodexEvent((event) => {
          const id =
            codexWorkspaceRef.current ??
            useAppStore.getState().activeWorkspaceId ??
            LOCAL_WORKSPACE_ID;
          addCodexEvent(event, id);
        })
      );
    }
    if (api.onCodexDone) {
      unsubscribers.push(api.onCodexDone((status) => handleCodexDone(status)));
    }
    if (api.onBuildResult) {
      unsubscribers.push(
        api.onBuildResult((result) => {
          const id = useAppStore.getState().activeWorkspaceId ?? LOCAL_WORKSPACE_ID;
          setDiagnostics(result.diagnostics, id);
        })
      );
    }
    if (api.onTestStatus) {
      unsubscribers.push(
        api.onTestStatus((status) => {
          const id = useAppStore.getState().activeWorkspaceId ?? LOCAL_WORKSPACE_ID;
          handleTestStatus(status, id);
        })
      );
    }
    if (api.onTestDone) {
      unsubscribers.push(
        api.onTestDone((status) => {
          const id = useAppStore.getState().activeWorkspaceId ?? LOCAL_WORKSPACE_ID;
          handleTestStatus(status, id);
        })
      );
    }
    if (api.logsAppend) {
      unsubscribers.push(
        api.logsAppend((payload) => {
          const id = useAppStore.getState().activeWorkspaceId ?? LOCAL_WORKSPACE_ID;
          addOutputLog(payload, id);
        })
      );
    }

    if (api.onAppCloseRequest) {
      unsubscribers.push(api.onAppCloseRequest(handleAppCloseRequest));
    }
    if (api.onAppSaveAll) {
      unsubscribers.push(api.onAppSaveAll(handleAppSaveAll));
    }
    return () => {
      unsubscribers.forEach((unsub) => unsub());
    };
  }, [
    addCodexEvent,
    addCodexMessage,
    addOutputLog,
    addWorkspace,
    setActiveWorkspace,
    setCodexStatus,
    setDiagnostics,
    setTree
  ]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key.toLowerCase() === "s") {
        event.preventDefault();
        handleSave();
      }
      if (event.ctrlKey && event.key.toLowerCase() === "j") {
        event.preventDefault();
        toggleBottomPanelOpen();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [toggleBottomPanelOpen, openFiles, activeFilePath]);

  useEffect(() => {
    if (!settingsOpen) return;
    api.settingsGet?.().then((loaded) => loaded && setSettings(loaded));
  }, [api, settingsOpen, setSettings]);

  useEffect(() => {
    if (!activeFilePath) return;
    if (activeFilePath.endsWith(".mq4") || activeFilePath.endsWith(".mq5")) {
      setTestConfig((prev) => ({ ...prev, expertPath: activeFilePath }));
    }
  }, [activeFilePath]);

  useEffect(() => {
    const workspaceId = activeWorkspaceId ?? LOCAL_WORKSPACE_ID;
    if (workspaceId === LOCAL_WORKSPACE_ID) return;
    const workspace = workspaces[workspaceId];
    if (!workspace) return;
    const saved = readWorkspaceState()[workspaceId];
    if (saved?.expandedDirs?.length && workspace.expandedDirs.length === 0) {
      setExpandedDirs(saved.expandedDirs, workspaceId);
    }
    if (workspace.openFiles.length > 0) return;
    if (!saved?.openFiles?.length) return;
    let cancelled = false;
    const load = async () => {
      for (const filePath of saved.openFiles) {
        if (cancelled) return;
        const file = await api.openFile?.(filePath);
        if (file) openFile(file, workspaceId);
      }
      if (!cancelled && saved.activeFilePath) {
        setActiveFile(saved.activeFilePath, workspaceId);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [activeWorkspaceId, openFile, setActiveFile, setExpandedDirs, workspaces]);

  useEffect(() => {
    const workspaceId = activeWorkspaceId ?? LOCAL_WORKSPACE_ID;
    if (workspaceId === LOCAL_WORKSPACE_ID) return;
    const state = readWorkspaceState();
    state[workspaceId] = {
      openFiles: openFiles.map((file) => file.path),
      activeFilePath,
      expandedDirs
    };
    writeWorkspaceState(state);
  }, [activeWorkspaceId, activeFilePath, expandedDirs, openFiles]);

  const handleOpenWorkspace = async () => {
    const root = await api.selectWorkspace?.();
    if (root) {
      addWorkspace(root);
      setActiveWorkspace(root);
    }
  };

  const handleActivateWorkspace = async (root: string) => {
    if (!root) return;
    addWorkspace(root);
    setActiveWorkspace(root);
    if (typeof api.activateWorkspace === "function") {
      const tree = await api.activateWorkspace(root);
      if (tree) setTree(tree, root);
    } else if (typeof api.requestWorkspaceTree === "function") {
      const tree = await api.requestWorkspaceTree(fileFilters);
      if (tree) setTree(tree, root);
    }
  };

  const handleCloseWorkspace = async (root: string) => {
    if (!root) return;
    const result = await api.closeWorkspace?.(root);
    if (!result) return;
    removeWorkspaceState(root);
    removeWorkspace(root);
    if (result.workspaceRoot) {
      addWorkspace(result.workspaceRoot);
      setActiveWorkspace(result.workspaceRoot);
      if (result.tree) {
        setTree(result.tree, result.workspaceRoot);
      }
    } else {
      setActiveWorkspace(undefined);
    }
  };

  const handleOpenFile = async (path: string) => {
    const file = await api.openFile?.(path);
    if (!file) return;
    const workspaceId = activeWorkspaceId ?? LOCAL_WORKSPACE_ID;
    openFile(file, workspaceId);
  };

  const handleCloseFile = (path: string) => {
    const workspaceId = activeWorkspaceId ?? LOCAL_WORKSPACE_ID;
    closeOpenFile(path, workspaceId);
  };

  const handleLoadDir = async (dirPath: string) => {
    const children = await api.listDirectory?.(dirPath, fileFilters);
    if (!children) return;
    const state = useAppStore.getState();
    const workspaceId = state.activeWorkspaceId ?? LOCAL_WORKSPACE_ID;
    const current = state.workspaces[workspaceId]?.tree;
    if (!current) return;
    setTree(updateTreeChildren(current, dirPath, children), workspaceId);
  };

  const handleFiltersChange = (next: FileFilters) => {
    setFileFilters(next);
  };

  const handleWatchDirsChange = (dirs: string[]) => {
    if (typeof api.setWatchedDirs !== "function") return;
    const next = new Set(dirs);
    if (workspaceRoot) next.add(workspaceRoot);
    const MAX_WATCH_DIRS = 48;
    api.setWatchedDirs(Array.from(next).slice(0, MAX_WATCH_DIRS));
  };

  const handleSave = async () => {
    const current = openFiles.find((file) => file.path === activeFilePath);
    if (!current) return;
    await saveOpenFile(current);
  };

  const MIN_LEFT = 180;
  const MAX_LEFT = 560;
  const MIN_RIGHT = 240;
  const MAX_RIGHT = 520;
  const MIN_BOTTOM = 160;

  const leftPaneWidth = layout.leftCollapsed
    ? 0
    : clamp(layout.leftWidth, MIN_LEFT, MAX_LEFT);
  const rightPaneWidth = layout.rightCollapsed
    ? 0
    : clamp(layout.rightWidth, MIN_RIGHT, MAX_RIGHT);
  const bottomPaneHeight = bottomPanelOpen
    ? clamp(layout.bottomHeight, MIN_BOTTOM, Math.max(MIN_BOTTOM, viewport.height - 220))
    : 0;

  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("app");
    root.dataset.theme = settings.uiTheme ?? "windows11";
    root.dataset.mode = settings.uiMode ?? "dark";
    root.dataset.nativeFrame = window.api?.nativeFrame ? "true" : "false";
    root.style.setProperty("--splitter-size", `${SPLITTER_SIZE}px`);
    root.style.setProperty("--left-pane", `${leftPaneWidth}px`);
    root.style.setProperty("--right-pane", `${rightPaneWidth}px`);
    root.style.setProperty("--bottom-pane", `${bottomPaneHeight}px`);
  }, [
    bottomPaneHeight,
    leftPaneWidth,
    rightPaneWidth,
    settings.uiMode,
    settings.uiTheme
  ]);

  const startResize = (axis: "left" | "right" | "bottom", event: React.MouseEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const startLeft = layout.leftWidth;
    const startRight = layout.rightWidth;
    const startBottom = layout.bottomHeight;

    document.body.style.userSelect = "none";
    document.body.style.cursor = axis === "bottom" ? "row-resize" : "col-resize";

    if (axis === "left") {
      setLayout((prev) => ({ ...prev, leftCollapsed: false }));
    }
    if (axis === "right") {
      setLayout((prev) => ({ ...prev, rightCollapsed: false }));
    }
    if (axis === "bottom" && !bottomPanelOpen) {
      toggleBottomPanel(true);
    }

    const onMove = (moveEvent: MouseEvent) => {
      if (axis === "left") {
        const next = clamp(startLeft + (moveEvent.clientX - startX), MIN_LEFT, MAX_LEFT);
        setLayout((prev) => ({ ...prev, leftWidth: next, leftCollapsed: false }));
      } else if (axis === "right") {
        const next = clamp(startRight + (startX - moveEvent.clientX), MIN_RIGHT, MAX_RIGHT);
        setLayout((prev) => ({ ...prev, rightWidth: next, rightCollapsed: false }));
      } else {
        const next = clamp(
          startBottom + (startY - moveEvent.clientY),
          MIN_BOTTOM,
          viewport.height - 220
        );
        setLayout((prev) => ({ ...prev, bottomHeight: next }));
      }
    };

    const onUp = () => {
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const saveOpenFile = async (
    file: typeof openFiles[number],
    workspaceId: string = activeWorkspaceId ?? LOCAL_WORKSPACE_ID
  ) => {
    if (typeof api.saveFile !== "function") return false;
    if (file.path.startsWith("untitled:")) {
      const extMatch = file.path.match(/\.(\w+)$/);
      const ext = extMatch ? `.${extMatch[1]}` : ".mq5";
      const defaultName = `Untitled${ext}`;
      const defaultRoot =
        workspaceId && workspaceId !== LOCAL_WORKSPACE_ID ? workspaceId : workspaceRoot;
      const defaultPath = defaultRoot ? joinPath(defaultRoot, defaultName) : defaultName;
      const target = await api.savePath?.({
        title: "Save File",
        defaultPath
      });
      if (!target) return false;
      const saved = await api.saveFile(target, file.content);
      if (saved) {
        renameOpenFile(file.path, target, file.content, workspaceId);
        return true;
      }
      return false;
    }
    const saved = await api.saveFile(file.path, file.content);
    if (saved) {
      markSaved(file.path, file.content, workspaceId);
    }
    return saved;
  };

  const handleNewFile = () => {
    const count = untitledCounterRef.current++;
    const ext = newFileExt ? `.${newFileExt}` : "";
    const path = `untitled:${count}${ext}`;
    const language = getLanguageForExtension(newFileExt);
    const workspaceId = activeWorkspaceId ?? LOCAL_WORKSPACE_ID;
    openFile({
      path,
      content: "",
      version: 1,
      language
    }, workspaceId);
  };

  const handleToggleSetting = (key: "editorShowRulers" | "editorShowCursorPosition") => {
    const next = { ...settings, [key]: !settings[key] };
    setSettings(next);
    api.settingsSet?.(next);
  };

  const handleFontSizeChange = (size: number) => {
    const normalized = clamp(Math.round(size), 10, 24);
    if (settings.editorFontSize === normalized) return;
    const next = { ...settings, editorFontSize: normalized };
    setSettings(next);
    api.settingsSet?.(next);
  };

  const handleCompile = async () => {
    const current = openFiles.find((file) => file.path === activeFilePath) ?? openFiles[0];
    if (!current) return;
    if (typeof api.buildStart !== "function") return;
    await api.buildStart({ filePath: current.path });
    setBottomTab("problems");
    openBottomPanel();
  };

  const handleRunTest = async () => {
    if (!testConfig.expertPath) {
      addOutputLog({
        source: "system",
        line: "Select an expert (.mq5/.mq4) to run a test.",
        timestamp: Date.now()
      });
      return;
    }
    const reportDir = settings.reportsDir || (workspaceRoot ? joinPath(workspaceRoot, "reports") : "reports");
    const reportPath = joinPath(reportDir, `report-${Date.now()}.html`);
    const request: TestRequest = { ...testConfig, reportPath };
    if (typeof api.testStart !== "function") return;
    await api.testStart(request);
    setBottomTab("output");
    openBottomPanel();
  };

  const handleCodexRun = async (
    message: string,
    options?: { model?: string; level?: string }
  ) => {
    const workspaceId = activeWorkspaceId ?? LOCAL_WORKSPACE_ID;
    addCodexMessage({ role: "user", text: message, timestamp: Date.now() }, workspaceId);
    codexWorkspaceRef.current = workspaceId;
    codexRunStartIndexRef.current[workspaceId] = codexEvents.length;
    if (typeof api.runCodex !== "function") return;
    const status = await api.runCodex({
      userMessage: message,
      activeFilePath,
      selection,
      contextBundle: codexSessionActive ? buildCodexContextBundle(codexMessages) : undefined,
      model: options?.model,
      level: options?.level
    });
    setCodexStatus(status, workspaceId);
  };

  const resolveWorkspaceForPath = (filePath: string) => {
    const normalize = (value: string) => value.replace(/\\/g, "/").toLowerCase();
    const target = normalize(filePath);
    const state = useAppStore.getState();
    const candidates = state.workspaceOrder.length
      ? state.workspaceOrder
      : Object.keys(state.workspaces).filter((id) => id !== LOCAL_WORKSPACE_ID);
    const match = candidates.find((root) => {
      const normalizedRoot = normalize(root).replace(/\/+$/, "");
      return target === normalizedRoot || target.startsWith(`${normalizedRoot}/`);
    });
    return match ?? state.activeWorkspaceId ?? LOCAL_WORKSPACE_ID;
  };

  const handleFileChanged = (payload: FileChangePayload) => {
    const state = useAppStore.getState();
    const workspaceId = resolveWorkspaceForPath(payload.path);
    const workspace = state.workspaces[workspaceId];
    const current = workspace?.openFiles.find((file) => file.path === payload.path);
    const before = payload.previousContent ?? current?.content;
    const after = payload.content;
    if (!before || before === after) return;

    if (current) {
      state.updateFileContent(current.path, after, undefined, workspaceId);
    }

    const existing = workspace?.reviewChanges[payload.path];
    if (existing && existing.after === after) return;

    const diff = createUnifiedDiff(payload.path, before, after);
    const changedLines = calculateChangedLines(before, after);
    state.addReviewChange(
      {
        path: payload.path,
        before,
        after,
        diff,
        changedLines,
        source: payload.source,
        changeId: payload.changeId
      },
      workspaceId
    );
  };

  const handleAcceptChange = (path: string) => {
    const change = reviewChanges[path];
    if (!change) return;
    const workspaceId = activeWorkspaceId ?? LOCAL_WORKSPACE_ID;
    markSaved(path, change.after, workspaceId);
    removeReviewChange(path, workspaceId);
  };

  const handleRevertChange = async (path: string) => {
    const change = reviewChanges[path];
    if (!change) return;
    if (typeof api.saveFile === "function") {
      await api.saveFile(path, change.before);
    }
    const workspaceId = activeWorkspaceId ?? LOCAL_WORKSPACE_ID;
    updateFileContent(path, change.before, change.before, workspaceId);
    removeReviewChange(path, workspaceId);
  };

  const handleDiagnosticNavigate = async (diag: Diagnostic) => {
    await handleOpenFile(diag.filePath);
    setNavigationTarget({
      path: diag.filePath,
      line: diag.line,
      column: diag.column
    });
  };

  const handleTestStatus = async (status: TestStatus, workspaceId: string) => {
    setTestStatus(status, workspaceId);
    if (status.reportReady && status.reportPath) {
      const html = await api.readReport?.(status.reportPath);
      if (html) {
        setReportHtml(html, workspaceId);
        setBottomTab("report");
      }
    }
  };

  const activeReviewChange = useMemo(() => {
    if (!activeFilePath) return undefined;
    return reviewChanges[activeFilePath];
  }, [activeFilePath, reviewChanges]);

  return (
    <>
      <TopBar
        onOpenWorkspace={handleOpenWorkspace}
        onSave={handleSave}
        onCompile={handleCompile}
        onRunTest={handleRunTest}
        onSettings={() => setSettingsOpen(true)}
        onToggleTerminal={() => {
          if (bottomPanelOpen && bottomTab === "terminal") {
            toggleBottomPanel(false);
            return;
          }
          setBottomTab("terminal");
          openBottomPanel();
        }}
        onToggleGuides={() => handleToggleSetting("editorShowRulers")}
        onToggleCursorPos={() => handleToggleSetting("editorShowCursorPosition")}
        onToggleTheme={() => {
          const nextMode = (settings.uiMode ?? "dark") === "dark" ? "light" : "dark";
          const next = { ...settings, uiMode: nextMode };
          setSettings(next);
          api.settingsSet?.(next);
        }}
        files={openFiles}
        activeFilePath={activeFilePath}
        onSelectTab={setActiveFile}
        onCloseTab={handleCloseFile}
        onNewFile={handleNewFile}
        newFileExtension={newFileExt}
        onNewFileExtensionChange={setNewFileExt}
        showGuides={settings.editorShowRulers ?? false}
        showCursorPos={settings.editorShowCursorPosition ?? false}
        uiMode={settings.uiMode}
        terminalActive={bottomPanelOpen && bottomTab === "terminal"}
        uiTheme={settings.uiTheme}
        filters={fileFilters}
        onFiltersChange={handleFiltersChange}
      />
      <div className="main-layout">
          <LeftSidebar
            tree={tree}
            workspaceRoot={workspaceRoot}
            workspaces={workspaceOrder}
            activeWorkspaceId={activeWorkspaceId}
            onSelectWorkspace={handleActivateWorkspace}
            onCloseWorkspace={handleCloseWorkspace}
            expandedDirs={expandedDirs}
            onExpandedDirsChange={(dirs) => {
              const workspaceId = activeWorkspaceId ?? LOCAL_WORKSPACE_ID;
              setExpandedDirs(dirs, workspaceId);
            }}
            filters={fileFilters}
            onOpenFile={handleOpenFile}
            onLoadDir={handleLoadDir}
            onWatchDirsChange={handleWatchDirsChange}
            activeFilePath={activeFilePath}
            collapsed={layout.leftCollapsed}
          />
          <div
            className={`splitter vertical left ${layout.leftCollapsed ? "ghost" : ""}`}
            onMouseDown={(event) => startResize("left", event)}
          >
            <button
              className={`split-pin ${layout.leftCollapsed ? "" : "active"}`}
              title={layout.leftCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              onClick={(event) => {
                event.stopPropagation();
                setLayout((prev) => ({ ...prev, leftCollapsed: !prev.leftCollapsed }));
              }}
            >
              {layout.leftCollapsed ? <PinOff size={12} /> : <Pin size={12} />}
            </button>
          </div>
          <EditorPane
            files={openFiles}
            activeFilePath={activeFilePath}
            reviewChange={activeReviewChange}
            onAcceptChange={handleAcceptChange}
            onRevertChange={handleRevertChange}
            onSelectTab={setActiveFile}
            onChangeContent={updateFileContent}
            onSelectionChange={setSelection}
            navigationTarget={navigationTarget}
            onNavigationHandled={() => setNavigationTarget(null)}
            uiTheme={settings.uiTheme}
            uiMode={settings.uiMode}
            editorFontSize={settings.editorFontSize}
            editorShowRulers={settings.editorShowRulers}
            editorRulers={settings.editorRulers}
            onFontSizeChange={handleFontSizeChange}
            onCursorPositionChange={setCursorPos}
          />
          <div
            className={`splitter vertical right ${layout.rightCollapsed ? "ghost" : ""}`}
            onMouseDown={(event) => startResize("right", event)}
          >
            <button
              className={`split-pin ${layout.rightCollapsed ? "" : "active"}`}
              title={layout.rightCollapsed ? "Expand Codex" : "Collapse Codex"}
              onClick={(event) => {
                event.stopPropagation();
                setLayout((prev) => ({ ...prev, rightCollapsed: !prev.rightCollapsed }));
              }}
            >
              {layout.rightCollapsed ? <PinOff size={12} /> : <Pin size={12} />}
            </button>
          </div>
          <CodexSidebar
            codexEvents={codexEvents}
            codexMessages={codexMessages}
            codexStatus={codexStatus}
            sessionActive={codexSessionActive}
            reviewChanges={reviewChanges}
            models={codexModelsInfo.models}
            defaultModel={codexModelsInfo.defaultModel}
            defaultLevel={codexModelsInfo.defaultLevel}
            onRun={handleCodexRun}
            onCancel={() => api.cancelCodex?.()}
            onToggleSession={(active) => {
              const workspaceId = activeWorkspaceId ?? LOCAL_WORKSPACE_ID;
              setCodexSessionActive(active, workspaceId);
              if (!active) clearCodexSession(workspaceId);
            }}
            onAcceptChange={handleAcceptChange}
            onRevertChange={handleRevertChange}
            collapsed={layout.rightCollapsed}
          />
        </div>
        <div className="app-statusbar">
          <div className="status-left">
            {activeFilePath
              ? activeFilePath.split(/[\\/]/).pop()
              : workspaceRoot
              ? workspaceRoot.split(/[\\/]/).pop()
              : "Ready"}
          </div>
          <div className="status-right">
            {settings.editorShowCursorPosition ? (
              <span>
                Ln {cursorPos.line}, Col {cursorPos.column}
              </span>
            ) : (
              <span />
            )}
          </div>
        </div>
        <div
          className={`splitter horizontal ${bottomPanelOpen ? "" : "ghost"}`}
          onMouseDown={(event) => startResize("bottom", event)}
        >
          <button
            className={`split-pin ${bottomPanelOpen ? "active" : ""}`}
            title={bottomPanelOpen ? "Collapse panel" : "Expand panel"}
            onClick={(event) => {
              event.stopPropagation();
              toggleBottomPanelOpen();
            }}
          >
            {bottomPanelOpen ? <Pin size={12} /> : <PinOff size={12} />}
          </button>
        </div>
      <BottomPanel
        open={bottomPanelOpen}
        activeTab={bottomTab}
        diagnostics={diagnostics}
        logs={outputLogs}
        reportHtml={reportHtml}
        testStatus={testStatus}
        workspaceRoot={workspaceRoot}
        onTabChange={setBottomTab}
        onNavigateDiagnostic={handleDiagnosticNavigate}
      />
      <SettingsModal
        open={settingsOpen}
        settings={settings}
        onClose={() => setSettingsOpen(false)}
        onSave={(next) => {
          setSettings(next);
          api.settingsSet?.(next);
          const recent = (next.recentWorkspaces ?? []).filter(Boolean);
          const activeRoot = next.workspaceRoot || recent[recent.length - 1];
          const state = useAppStore.getState();
          const existing = Object.keys(state.workspaces).filter(
            (id) => id !== LOCAL_WORKSPACE_ID
          );
          for (const root of existing) {
            if (!recent.includes(root)) {
              removeWorkspaceState(root);
              removeWorkspace(root);
            }
          }
          for (const root of recent) {
            addWorkspace(root);
          }
          if (activeRoot) {
            setActiveWorkspace(activeRoot);
            if (typeof api.activateWorkspace === "function") {
              api.activateWorkspace(activeRoot).then((tree) => {
                if (tree) setTree(tree, activeRoot);
              });
            } else if (typeof api.requestWorkspaceTree === "function") {
              api.requestWorkspaceTree(fileFilters).then((tree) => {
                if (tree) setTree(tree, activeRoot);
              });
            }
            api.setWatchedDirs?.([activeRoot]);
          } else {
            setActiveWorkspace(undefined);
          }
        }}
      />
    </>
  );
};

export default App;
