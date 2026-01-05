import { useEffect, useRef, useState } from "react";
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
  Moon,
  Plus,
  Ruler,
  Save,
  Settings as SettingsIcon,
  Square,
  Sun,
  Terminal,
  X,
  Play
} from "lucide-react";
import iconMt4 from "../assets/icons/mt4.png";
import iconMt5 from "../assets/icons/mt5.svg";
import iconPython from "../assets/icons/python.svg";
import iconC from "../assets/icons/c.svg";
import iconCpp from "../assets/icons/cpp.svg";
import type { OpenFileState } from "@state/store";

const TopBar = ({
  onOpenWorkspace,
  onSave,
  onCompile,
  onRunTest,
  onSettings,
  onToggleTerminal,
  onToggleGuides,
  onToggleCursorPos,
  onToggleTheme,
  files,
  activeFilePath,
  onSelectTab,
  onCloseTab,
  onNewFile,
  newFileExtension,
  onNewFileExtensionChange,
  showGuides,
  showCursorPos,
  uiMode,
  terminalActive,
  uiTheme,
  filters,
  onFiltersChange
}: {
  onOpenWorkspace: () => void;
  onSave: () => void;
  onCompile: () => void;
  onRunTest: () => void;
  onSettings: () => void;
  onToggleTerminal: () => void;
  onToggleGuides: () => void;
  onToggleCursorPos: () => void;
  onToggleTheme: () => void;
  files: OpenFileState[];
  activeFilePath?: string;
  onSelectTab: (path: string) => void;
  onCloseTab: (path: string) => void;
  onNewFile?: () => void;
  newFileExtension?: string;
  onNewFileExtensionChange?: (value: string) => void;
  showGuides: boolean;
  showCursorPos: boolean;
  uiMode?: "dark" | "light";
  terminalActive: boolean;
  uiTheme?: "windows11" | "windowsClassic" | "macos" | "metatrader";
  filters: { mql: boolean; python: boolean; cpp: boolean };
  onFiltersChange: (filters: { mql: boolean; python: boolean; cpp: boolean }) => void;
}) => {
  const [maximized, setMaximized] = useState(false);
  const [extMenuOpen, setExtMenuOpen] = useState(false);
  const extMenuRef = useRef<HTMLDivElement | null>(null);
  const isClassic = uiTheme === "windowsClassic";
  const allSelected = filters.mql && filters.python && filters.cpp;
  const isDark = (uiMode ?? "dark") === "dark";

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

  useEffect(() => {
    const handleClick = (event: MouseEvent) => {
      if (!extMenuRef.current) return;
      if (!extMenuRef.current.contains(event.target as Node)) {
        setExtMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const extensionOptions = [
    { id: "mq5", label: "MQL5", icon: iconMt5 },
    { id: "mq4", label: "MQL4", icon: iconMt4 },
    { id: "mqh", label: "MQL Header" },
    { id: "py", label: "Python", icon: iconPython },
    { id: "c", label: "C", icon: iconC },
    { id: "cpp", label: "C++", icon: iconCpp }
  ];

  const currentExt =
    extensionOptions.find((option) => option.id === newFileExtension) ?? extensionOptions[0];

  return (
    <>
      <div className="title-left">
        <span className="app-title">MT5 IDE</span>
        <div className="tabs">
          <div className="tab-list">
            {files.map((file) => (
              <div
                key={file.path}
                className={`tab ${file.path === activeFilePath ? "active" : ""}`}
                onClick={() => onSelectTab(file.path)}
              >
                <span>{file.path.split(/[\\/]/).pop()}</span>
                {file.dirty ? <span className="dirty" /> : null}
                <button
                  className="tab-close"
                  onClick={(event) => {
                    event.stopPropagation();
                    onCloseTab(file.path);
                  }}
                  title="Close"
                  type="button"
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
          <div className="tab-right">
            <button
              className="editor-plus"
              onClick={() => onNewFile?.()}
              title="New File"
              type="button"
            >
              <Plus size={12} />
            </button>
          </div>
        </div>
      </div>
      <div className="window-controls">
        <div className="window-buttons">
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
      <div className="toolbar-row">
        <div className="toolbar-right">
          <div className="toolbar-actions">
            <button
              className="toolbar-btn"
              onClick={onOpenWorkspace}
              title="Open Workspace"
            >
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
          <button
            className={`toolbar-btn ${terminalActive ? "active" : ""}`}
            onClick={onToggleTerminal}
            title="Terminal"
          >
            <Terminal size={14} />
          </button>
          <button className="toolbar-btn" onClick={onToggleTheme} title="Tema claro/escuro">
            {isDark ? <Sun size={14} /> : <Moon size={14} />}
          </button>
          <div className="toolbar-ext" ref={extMenuRef}>
            <button
              className="ext-trigger"
              onClick={() => setExtMenuOpen((open) => !open)}
              type="button"
              title={`New file extension: .${currentExt.id}`}
            >
              {currentExt.icon ? (
                <span className="ext-icon">
                  <img className="ext-icon-img" src={currentExt.icon} alt={currentExt.label} />
                </span>
              ) : (
                <span className="ext-label">{currentExt.label}</span>
              )}
            </button>
            {extMenuOpen ? (
              <div className="ext-menu">
                {extensionOptions.map((option) => (
                  <button
                    key={option.id}
                    className={`ext-option ${newFileExtension === option.id ? "active" : ""}`}
                    onClick={() => {
                      onNewFileExtensionChange?.(option.id);
                      setExtMenuOpen(false);
                    }}
                    type="button"
                  >
                    {option.icon ? (
                      <span className="ext-icon">
                        <img className="ext-icon-img" src={option.icon} alt={option.label} />
                      </span>
                    ) : null}
                    <span className="ext-label">{option.label}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </>
  );
};

export default TopBar;
