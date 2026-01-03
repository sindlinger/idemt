import { useEffect, useMemo } from "react";
import { Activity, Braces, Code2, Layers } from "lucide-react";
import type { WorkspaceNode } from "@shared/ipc";

type FileFilter = "mql" | "python" | "cpp";

const MQL_EXT = new Set(["mq4", "mq5", "mqh", "ex4", "ex5", "dll"]);
const PY_EXT = new Set(["py"]);
const CPP_EXT = new Set(["c", "cpp", "cc", "cxx", "h", "hpp", "hh"]);

const getIcon = (node: WorkspaceNode) => {
  if (node.type === "dir") {
    return { label: "DIR", className: "folder" };
  }
  const ext = node.name.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "mq5") return { label: "M5", className: "mql" };
  if (ext === "mq4") return { label: "M4", className: "mql" };
  if (ext === "mqh") return { label: "H", className: "mql" };
  if (ext === "ex5") return { label: "EX5", className: "mql" };
  if (ext === "ex4") return { label: "EX4", className: "mql" };
  if (ext === "dll") return { label: "DLL", className: "mql" };
  if (ext === "py") return { label: "PY", className: "python" };
  if (ext === "ini") return { label: "INI", className: "ini" };
  if (ext === "json") return { label: "JS", className: "json" };
  if (ext === "md") return { label: "MD", className: "doc" };
  return { label: "FILE", className: "file" };
};

const getCategory = (node: WorkspaceNode): FileFilter | "other" => {
  if (node.type === "dir") return "other";
  const ext = node.name.split(".").pop()?.toLowerCase() ?? "";
  if (MQL_EXT.has(ext)) return "mql";
  if (PY_EXT.has(ext)) return "python";
  if (CPP_EXT.has(ext)) return "cpp";
  return "other";
};

const renderNode = (
  node: WorkspaceNode,
  depth: number,
  onOpenFile: (path: string) => void,
  expandedDirs: Set<string>,
  onToggleDir: (node: WorkspaceNode) => void,
  allowFile: (node: WorkspaceNode) => boolean,
  activeFilePath?: string
): JSX.Element[] => {
  const entries: JSX.Element[] = [];
  const key = `${node.path}-${depth}`;
  const icon = getIcon(node);
  if (node.type === "dir") {
    const expanded = expandedDirs.has(node.path);
    entries.push(
      <div
        key={key}
        className="file-node dir"
        style={{ paddingLeft: depth * 12 }}
        onClick={() => onToggleDir(node)}
      >
        <span className={`file-caret ${expanded ? "open" : ""}`}>{expanded ? "▾" : "▸"}</span>
        <span className={`file-icon ${icon.className}`}>{icon.label}</span>
        <span className="file-name">{node.name}</span>
      </div>
    );
    if (expanded) {
      if (!node.children) {
        entries.push(
          <div
            key={`${key}-loading`}
            className="file-node placeholder"
            style={{ paddingLeft: (depth + 1) * 12 }}
          >
            Loading...
          </div>
        );
      } else if (node.children.length === 0) {
        entries.push(
          <div
            key={`${key}-empty`}
            className="file-node placeholder"
            style={{ paddingLeft: (depth + 1) * 12 }}
          >
            Empty
          </div>
        );
      } else {
        node.children.forEach((child) => {
          entries.push(
            ...renderNode(
              child,
              depth + 1,
              onOpenFile,
              expandedDirs,
              onToggleDir,
              allowFile,
              activeFilePath
            )
          );
        });
      }
    }
  } else {
    if (!allowFile(node)) return entries;
    const isActive = activeFilePath === node.path;
    entries.push(
      <div
        key={key}
        className={`file-node ${isActive ? "active" : ""}`}
        style={{ paddingLeft: depth * 12 }}
        onDoubleClick={() => onOpenFile(node.path)}
      >
        <span className={`file-icon ${icon.className}`}>{icon.label}</span>
        <span className="file-name">{node.name}</span>
      </div>
    );
  }
  return entries;
};

type LeftSidebarProps = {
  tree?: WorkspaceNode;
  workspaceRoot?: string;
  expandedDirs: string[];
  onExpandedDirsChange: (dirs: string[]) => void;
  filters: Record<FileFilter, boolean>;
  onFiltersChange: (filters: Record<FileFilter, boolean>) => void;
  onOpenFile: (path: string) => void;
  onLoadDir: (path: string) => void;
  onWatchDirsChange: (dirs: string[]) => void;
  activeFilePath?: string;
  collapsed?: boolean;
};

const LeftSidebar = ({
  tree,
  workspaceRoot,
  expandedDirs,
  onExpandedDirsChange,
  filters,
  onFiltersChange,
  onOpenFile,
  onLoadDir,
  onWatchDirsChange,
  activeFilePath,
  collapsed
}: LeftSidebarProps) => {
  const rootName = workspaceRoot?.split(/[\\/]/).pop();
  const expandedSet = useMemo(() => new Set(expandedDirs), [expandedDirs]);

  useEffect(() => {
    if (!workspaceRoot) return;
    if (!expandedSet.has(workspaceRoot)) {
      onExpandedDirsChange([workspaceRoot, ...expandedDirs]);
    }
  }, [expandedDirs, expandedSet, onExpandedDirsChange, workspaceRoot]);

  useEffect(() => {
    if (!workspaceRoot) return;
    onWatchDirsChange(Array.from(expandedSet));
  }, [expandedSet, onWatchDirsChange, workspaceRoot]);

  const allSelected = useMemo(
    () => Object.values(filters).every(Boolean),
    [filters.mql, filters.python, filters.cpp]
  );

  const anySelected = useMemo(
    () => Object.values(filters).some(Boolean),
    [filters.mql, filters.python, filters.cpp]
  );

  const allowFile = (node: WorkspaceNode) => {
    if (allSelected) return true;
    if (!anySelected) return false;
    const category = getCategory(node);
    if (category === "other") return false;
    return filters[category];
  };

  const toggleFilter = (filter: FileFilter) => {
    onFiltersChange({ ...filters, [filter]: !filters[filter] });
  };

  const selectAll = () => {
    onFiltersChange({ mql: true, python: true, cpp: true });
  };

  const handleToggleDir = (node: WorkspaceNode) => {
    if (node.type !== "dir") return;
    const next = new Set(expandedSet);
    if (next.has(node.path)) {
      next.delete(node.path);
    } else {
      next.add(node.path);
      if (!node.children) {
        onLoadDir(node.path);
      }
    }
    onExpandedDirsChange(Array.from(next));
  };

  const treeNodes = tree?.children ?? [];
  return (
    <aside className={`sidebar ${collapsed ? "collapsed" : ""}`}>
      <div className="panel-title">Workspace</div>
      {workspaceRoot ? (
        <div className="workspace-meta">
          <div className="workspace-name">{rootName}</div>
          <div className="workspace-path">{workspaceRoot}</div>
        </div>
      ) : null}
      <div className="panel-title" style={{ marginTop: 12 }}>
        Files
      </div>
      <div className="file-filters">
        <button
          className={`filter-btn ${allSelected ? "active" : ""}`}
          onClick={selectAll}
        >
          <Layers size={12} />
          Todos
        </button>
        <button
          className={`filter-btn ${filters.mql ? "active" : ""}`}
          onClick={() => toggleFilter("mql")}
        >
          <Activity size={12} />
          MT5
        </button>
        <button
          className={`filter-btn ${filters.python ? "active" : ""}`}
          onClick={() => toggleFilter("python")}
        >
          <Code2 size={12} />
          Python
        </button>
        <button
          className={`filter-btn ${filters.cpp ? "active" : ""}`}
          onClick={() => toggleFilter("cpp")}
        >
          <Braces size={12} />
          C/C++
        </button>
      </div>
      <div className="file-tree">
        {tree ? (
          treeNodes.flatMap((node) =>
            renderNode(
              node,
              0,
              onOpenFile,
              expandedSet,
              handleToggleDir,
              allowFile,
              activeFilePath
            )
          )
        ) : (
          <div>No workspace selected.</div>
        )}
      </div>
    </aside>
  );
};

export default LeftSidebar;
