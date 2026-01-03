import { useEffect, useState } from "react";
import {
  Activity,
  Braces,
  Code2,
  Copy,
  Crosshair,
  FolderOpen,
  Hammer,
  Layers,
  Minus,
  Plus,
  Ruler,
  Save,
  Settings as SettingsIcon,
  Square,
  Terminal,
  X,
  Play
} from "lucide-react";

const TopBar = ({
  workspaces,
  activeWorkspaceId,
  onSelectWorkspace,
  onCloseWorkspace,
  onOpenWorkspace,
  onSave,
  onCompile,
  onRunTest,
  onSettings,
  onToggleTerminal,
  onToggleGuides,
  onToggleCursorPos,
  showGuides,
  showCursorPos,
  onNewFile,
  uiTheme,
  filters,
  onFiltersChange
}: {
  workspaces: string[];
  activeWorkspaceId?: string;
  onSelectWorkspace: (root: string) => void;
  onCloseWorkspace: (root: string) => void;
  onOpenWorkspace: () => void;
  onSave: () => void;
  onCompile: () => void;
  onRunTest: () => void;
  onSettings: () => void;
  onToggleTerminal: () => void;
  onToggleGuides: () => void;
  onToggleCursorPos: () => void;
  showGuides: boolean;
  showCursorPos: boolean;
  onNewFile: () => void;
  uiTheme?: "windows11" | "windowsClassic" | "macos";
  filters: { mql: boolean; python: boolean; cpp: boolean };
  onFiltersChange: (filters: { mql: boolean; python: boolean; cpp: boolean }) => void;
}) => {
  const [maximized, setMaximized] = useState(false);
  const isClassic = uiTheme === "windowsClassic";
  const allSelected = filters.mql && filters.python && filters.cpp;

  const toggleFilter = (key: "mql" | "python" | "cpp") => {
    onFiltersChange({ ...filters, [key]: !filters[key] });
  };

  const selectAll = () => {
    onFiltersChange({ mql: true, python: true, cpp: true });
  };

  useEffect(() => {
    if (typeof window.api?.windowStateGet !== "function") return;
    window.api.windowStateGet().then((state) => setMaximized(state.maximized));
    const unsub = window.api.onWindowState?.((state) => setMaximized(state.maximized));
    return () => unsub?.();
  }, []);

  return (
    <div className="topbar">
      <div className="titlebar">
        <div className="title-left">
          <span className="app-title">MT5 Sidecar IDE</span>
          {workspaces.map((root) => {
            const name = root.split(/[\\/]/).pop() ?? root;
            const isActive = root === activeWorkspaceId;
            return (
              <div
                key={root}
                className={`workspace-chip ${isActive ? "active" : ""}`}
                title={root}
              >
                <button
                  className="workspace-chip-name"
                  onClick={() => onSelectWorkspace(root)}
                >
                  {name}
                </button>
                <button
                  className="workspace-chip-close"
                  onClick={(event) => {
                    event.stopPropagation();
                    onCloseWorkspace(root);
                  }}
                  aria-label={`Close ${name}`}
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
        <div className="window-controls">
          <button className="window-btn" onClick={() => window.api?.windowMinimize?.()}>
            {isClassic ? <span className="win-icon win-min" /> : <Minus size={12} />}
          </button>
          <button className="window-btn" onClick={() => window.api?.windowMaximize?.()}>
            {isClassic ? (
              <span className={`win-icon ${maximized ? "win-restore" : "win-max"}`} />
            ) : maximized ? (
              <Copy size={12} />
            ) : (
              <Square size={12} />
            )}
          </button>
          <button className="window-btn close" onClick={() => window.api?.windowClose?.()}>
            {isClassic ? <span className="win-icon win-close" /> : <X size={12} />}
          </button>
        </div>
      </div>
      <div className="toolbar">
        <div className="toolbar-actions">
          <div className="new-file-group">
            <button className="toolbar-btn" onClick={onNewFile} title="New File">
              <Plus size={14} />
            </button>
          </div>
          <button className="toolbar-btn" onClick={onOpenWorkspace} title="Open Workspace">
            <FolderOpen size={14} />
          </button>
          <button className="toolbar-btn" onClick={onSave} title="Save">
            <Save size={14} />
          </button>
          <button className="toolbar-btn" onClick={onCompile} title="Compile">
            <Hammer size={14} />
          </button>
          <button className="toolbar-btn" onClick={onRunTest} title="Run Test">
            <Play size={14} />
          </button>
          <button className="toolbar-btn" onClick={onSettings} title="Settings">
            <SettingsIcon size={14} />
          </button>
        </div>
        <div className="toolbar-filters">
          <button
            className={`filter-btn ${allSelected ? "active" : ""}`}
            onClick={selectAll}
            title="Todos"
          >
            <Layers size={12} />
          </button>
          <button
            className={`filter-btn ${filters.mql ? "active" : ""}`}
            onClick={() => toggleFilter("mql")}
            title="MT5"
          >
            <Activity size={12} />
          </button>
          <button
            className={`filter-btn ${filters.python ? "active" : ""}`}
            onClick={() => toggleFilter("python")}
            title="Python"
          >
            <Code2 size={12} />
          </button>
          <button
            className={`filter-btn ${filters.cpp ? "active" : ""}`}
            onClick={() => toggleFilter("cpp")}
            title="C/C++"
          >
            <Braces size={12} />
          </button>
        </div>
        <div className="toolbar-right">
          <button
            className={`toolbar-btn ${showGuides ? "active" : ""}`}
            onClick={onToggleGuides}
            title="Guides"
          >
            <Ruler size={14} />
          </button>
          <button
            className={`toolbar-btn ${showCursorPos ? "active" : ""}`}
            onClick={onToggleCursorPos}
            title="Cursor"
          >
            <Crosshair size={14} />
          </button>
          <button className="toolbar-btn" onClick={onToggleTerminal} title="Terminal">
            <Terminal size={14} />
          </button>
        </div>
      </div>
    </div>
  );
};

export default TopBar;
