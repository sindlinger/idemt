import { useEffect, useMemo } from "react";
import type { WorkspaceNode } from "@shared/ipc";

type FileFilter = "mql" | "python" | "cpp";

const MQL_EXT = new Set(["mq4", "mq5", "mqh", "ex4", "ex5", "dll"]);
const PY_EXT = new Set(["py"]);
const CPP_EXT = new Set(["c", "cpp", "cc", "cxx", "h", "hpp", "hh"]);

const getIcon = (node: WorkspaceNode) => {
  if (node.type === "dir") {
    return { label: "", className: "folder" };
  }
  const ext = node.name.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "mq5") return { label: "M5", className: "mql" };
  if (ext === "mq4") return { label: "M4", className: "mql" };
  if (ext === "mqh") return { label: "H", className: "mql" };
  if (ext === "ex5") return { label: "EX5", className: "mql" };
  if (ext === "ex4") return { label: "EX4", className: "mql" };
  if (ext === "dll") return { label: "DLL", className: "mql" };
  if (ext === "py") return { label: "PY", className: "python" };
  if (CPP_EXT.has(ext)) return { label: ext === "c" ? "C" : "C++", className: "cpp" };
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
  activeFilePath?: string,
  rootPath?: string
): JSX.Element[] => {
  const entries: JSX.Element[] = [];
  const key = `${node.path}-${depth}`;
  const icon = getIcon(node);
  if (node.type === "dir") {
    const expanded = expandedDirs.has(node.path);
    const isRoot = Boolean(rootPath && node.path === rootPath && depth === 0);
    entries.push(
      <div
        key={key}
        className={`file-node dir ${expanded ? "open" : ""} ${isRoot ? "root" : ""}`}
        data-depth={depth}
        style={
          {
            paddingLeft: 10 + depth * 12,
            "--depth": depth
          } as React.CSSProperties
        }
        onClick={() => onToggleDir(node)}
      >
        <span className={`file-caret ${expanded ? "open" : ""}`}>{expanded ? "▾" : "▸"}</span>
        <span className="file-name">{node.name}</span>
      </div>
    );
    if (expanded) {
      if (!node.children) {
        entries.push(
          <div
            key={`${key}-loading`}
            className="file-node placeholder"
            data-depth={depth + 1}
            style={
              {
                paddingLeft: 10 + (depth + 1) * 12,
                "--depth": depth + 1
              } as React.CSSProperties
            }
          >
            Loading...
          </div>
        );
      } else if (node.children.length === 0) {
        entries.push(
          <div
            key={`${key}-empty`}
            className="file-node placeholder"
            data-depth={depth + 1}
            style={
              {
                paddingLeft: 10 + (depth + 1) * 12,
                "--depth": depth + 1
              } as React.CSSProperties
            }
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
              activeFilePath,
              rootPath
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
        data-depth={depth}
        style={
          {
            paddingLeft: 10 + depth * 12,
            "--depth": depth
          } as React.CSSProperties
        }
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
  onOpenFile,
  onLoadDir,
  onWatchDirsChange,
  activeFilePath,
  collapsed
}: LeftSidebarProps) => {
  const rootName = workspaceRoot ?? "";
  const expandedSet = useMemo(() => new Set(expandedDirs), [expandedDirs]);

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

  const rootNode =
    tree && workspaceRoot
      ? {
          ...tree,
          name: workspaceRoot
        }
      : tree;
  const treeNodes = rootNode ? [rootNode] : [];
  return (
    <aside className={`sidebar ${collapsed ? "collapsed" : ""}`}>
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
              activeFilePath,
              rootName
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
