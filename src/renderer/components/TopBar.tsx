import { useEffect, useState } from "react";
import {
  Copy,
  Crosshair,
  FolderOpen,
  Hammer,
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
  newFileExtension,
  onNewFileExtensionChange,
  onNewFile
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
  newFileExtension: string;
  onNewFileExtensionChange: (value: string) => void;
  onNewFile: () => void;
}) => {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (typeof window.api.windowStateGet !== "function") return;
    window.api.windowStateGet().then((state) => setMaximized(state.maximized));
    const unsub = window.api.onWindowState((state) => setMaximized(state.maximized));
    return () => unsub();
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
          <button className="window-btn" onClick={() => window.api.windowMinimize()}>
            <Minus size={12} />
          </button>
          <button className="window-btn" onClick={() => window.api.windowMaximize()}>
            {maximized ? (
              <Copy size={12} />
            ) : (
              <Square size={12} />
            )}
          </button>
          <button className="window-btn close" onClick={() => window.api.windowClose()}>
            <X size={12} />
          </button>
        </div>
      </div>
      <div className="toolbar">
        <div className="toolbar-actions">
          <div className="new-file-group">
            <button className="toolbar-btn" onClick={onNewFile} title="New File">
              <Plus size={14} />
            </button>
            <select
              className="new-file-select"
              value={newFileExtension}
              onChange={(event) => onNewFileExtensionChange(event.target.value)}
            >
              <option value="mq5">.mq5</option>
              <option value="mq4">.mq4</option>
              <option value="mqh">.mqh</option>
              <option value="py">.py</option>
              <option value="c">.c</option>
              <option value="cpp">.cpp</option>
            </select>
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
