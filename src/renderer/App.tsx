import { useEffect, useMemo, useState } from "react";
import type { Diagnostic, FileChangePayload, TestRequest, TestStatus } from "@shared/ipc";
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

const App = () => {
  const {
    settings,
    setSettings,
    workspaceRoot,
    setWorkspaceRoot,
    tree,
    setTree,
    openFiles,
    activeFilePath,
    setActiveFile,
    openFile,
    updateFileContent,
    markSaved,
    diagnostics,
    setDiagnostics,
    outputLogs,
    addOutputLog,
    codexEvents,
    addCodexEvent,
    codexStatus,
    setCodexStatus,
    reviewChanges,
    addReviewChange,
    removeReviewChange,
    testStatus,
    setTestStatus,
    reportHtml,
    setReportHtml,
    bottomPanelOpen,
    toggleBottomPanel,
    bottomTab,
    setBottomTab,
    settingsOpen,
    setSettingsOpen
  } = useAppStore();

  const [selection, setSelection] = useState("");
  const [navigationTarget, setNavigationTarget] = useState<{
    path: string;
    line: number;
    column: number;
  } | null>(null);
  const [testConfig, setTestConfig] = useState<TestRequest>(defaultTestConfig);

  useEffect(() => {
    window.api.settingsGet().then((loaded) => {
      setSettings(loaded);
      if (loaded.workspaceRoot) {
        setWorkspaceRoot(loaded.workspaceRoot);
        window.api.requestWorkspaceTree().then((tree) => tree && setTree(tree));
      }
    });
  }, [setSettings, setTree, setWorkspaceRoot]);

  useEffect(() => {
    const unsubscribers = [
      window.api.onWorkspaceSelected((root) => setWorkspaceRoot(root)),
      window.api.onWorkspaceTree((tree) => setTree(tree)),
      window.api.onFileChanged((payload) => handleFileChanged(payload)),
      window.api.onCodexEvent((event) => addCodexEvent(event)),
      window.api.onCodexDone((status) => setCodexStatus(status)),
      window.api.onBuildResult((result) => setDiagnostics(result.diagnostics)),
      window.api.onTestStatus((status) => handleTestStatus(status)),
      window.api.onTestDone((status) => handleTestStatus(status)),
      window.api.logsAppend((payload) => addOutputLog(payload))
    ];
    return () => {
      unsubscribers.forEach((unsub) => unsub());
    };
  }, [
    addCodexEvent,
    addOutputLog,
    setCodexStatus,
    setDiagnostics,
    setTree,
    setWorkspaceRoot
  ]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key.toLowerCase() === "s") {
        event.preventDefault();
        handleSave();
      }
      if (event.ctrlKey && event.key.toLowerCase() === "j") {
        event.preventDefault();
        toggleBottomPanel();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [toggleBottomPanel, openFiles, activeFilePath]);

  useEffect(() => {
    if (!activeFilePath) return;
    if (activeFilePath.endsWith(".mq4") || activeFilePath.endsWith(".mq5")) {
      setTestConfig((prev) => ({ ...prev, expertPath: activeFilePath }));
    }
  }, [activeFilePath]);

  const handleOpenWorkspace = async () => {
    const root = await window.api.selectWorkspace();
    if (root) setWorkspaceRoot(root);
  };

  const handleOpenFile = async (path: string) => {
    const file = await window.api.openFile(path);
    if (file) openFile(file);
  };

  const handleSave = async () => {
    const current = openFiles.find((file) => file.path === activeFilePath);
    if (!current) return;
    const saved = await window.api.saveFile(current.path, current.content);
    if (saved) {
      markSaved(current.path, current.content);
    }
  };

  const handleCompile = async () => {
    const current = openFiles.find((file) => file.path === activeFilePath) ?? openFiles[0];
    if (!current) return;
    await window.api.buildStart({ filePath: current.path });
    setBottomTab("problems");
    toggleBottomPanel(true);
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
    await window.api.testStart(request);
    setBottomTab("output");
    toggleBottomPanel(true);
  };

  const handleCodexRun = async (message: string) => {
    const status = await window.api.runCodex({
      userMessage: message,
      activeFilePath,
      selection
    });
    setCodexStatus(status);
  };

  const handleFileChanged = (payload: FileChangePayload) => {
    const state = useAppStore.getState();
    const current = state.openFiles.find((file) => file.path === payload.path);
    const before = payload.previousContent ?? current?.content;
    const after = payload.content;
    if (!before || before === after) return;

    if (current) {
      state.updateFileContent(current.path, after);
    }

    const existing = state.reviewChanges[payload.path];
    if (existing && existing.after === after) return;

    const diff = createUnifiedDiff(payload.path, before, after);
    const changedLines = calculateChangedLines(before, after);
    state.addReviewChange({
      path: payload.path,
      before,
      after,
      diff,
      changedLines,
      source: payload.source,
      changeId: payload.changeId
    });
  };

  const handleAcceptChange = (path: string) => {
    const change = reviewChanges[path];
    if (!change) return;
    markSaved(path, change.after);
    removeReviewChange(path);
  };

  const handleRevertChange = async (path: string) => {
    const change = reviewChanges[path];
    if (!change) return;
    await window.api.saveFile(path, change.before);
    updateFileContent(path, change.before, change.before);
    removeReviewChange(path);
  };

  const handleDiagnosticNavigate = async (diag: Diagnostic) => {
    await handleOpenFile(diag.filePath);
    setNavigationTarget({
      path: diag.filePath,
      line: diag.line,
      column: diag.column
    });
  };

  const handleTestStatus = async (status: TestStatus) => {
    setTestStatus(status);
    if (status.reportReady && status.reportPath) {
      const html = await window.api.readReport(status.reportPath);
      setReportHtml(html);
      setBottomTab("report");
    }
  };

  const activeReviewChange = useMemo(() => {
    if (!activeFilePath) return undefined;
    return reviewChanges[activeFilePath];
  }, [activeFilePath, reviewChanges]);

  return (
    <div className="app">
      <TopBar
        workspaceRoot={workspaceRoot}
        onSave={handleSave}
        onCompile={handleCompile}
        onRunTest={handleRunTest}
        onSettings={() => setSettingsOpen(true)}
      />
      <div className="main-layout">
        <LeftSidebar
          tree={tree}
          workspaceRoot={workspaceRoot}
          onOpenWorkspace={handleOpenWorkspace}
          onOpenFile={handleOpenFile}
        />
        <EditorPane
          files={openFiles}
          activeFilePath={activeFilePath}
          reviewChange={activeReviewChange}
          onSelectTab={setActiveFile}
          onChangeContent={updateFileContent}
          onSelectionChange={setSelection}
          navigationTarget={navigationTarget}
          onNavigationHandled={() => setNavigationTarget(null)}
        />
        <CodexSidebar
          codexEvents={codexEvents}
          codexStatus={codexStatus}
          reviewChanges={reviewChanges}
          onRun={handleCodexRun}
          onCancel={() => window.api.cancelCodex()}
          onAcceptChange={handleAcceptChange}
          onRevertChange={handleRevertChange}
        />
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
          window.api.settingsSet(next);
          if (next.workspaceRoot) {
            setWorkspaceRoot(next.workspaceRoot);
            window.api.requestWorkspaceTree().then((tree) => tree && setTree(tree));
          }
        }}
      />
    </div>
  );
};

export default App;
