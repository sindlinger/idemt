import type { WorkspaceNode } from "@shared/ipc";

const renderNode = (
  node: WorkspaceNode,
  depth: number,
  onOpenFile: (path: string) => void
): JSX.Element[] => {
  const entries: JSX.Element[] = [];
  const key = `${node.path}-${depth}`;
  if (node.type === "dir") {
    entries.push(
      <div key={key} className="file-node dir" style={{ paddingLeft: depth * 12 }}>
        {node.name}
      </div>
    );
    node.children?.forEach((child) => {
      entries.push(...renderNode(child, depth + 1, onOpenFile));
    });
  } else {
    entries.push(
      <div
        key={key}
        className="file-node"
        style={{ paddingLeft: depth * 12 }}
        onClick={() => onOpenFile(node.path)}
      >
        {node.name}
      </div>
    );
  }
  return entries;
};

type LeftSidebarProps = {
  tree?: WorkspaceNode;
  workspaceRoot?: string;
  onOpenWorkspace: () => void;
  onOpenFile: (path: string) => void;
};

const LeftSidebar = ({ tree, workspaceRoot, onOpenWorkspace, onOpenFile }: LeftSidebarProps) => {
  return (
    <aside className="sidebar">
      <div className="panel-title">Workspace</div>
      <button className="button" onClick={onOpenWorkspace}>
        Open Workspace
      </button>
      {workspaceRoot ? (
        <p className="muted" style={{ fontSize: 12, color: "var(--muted)" }}>
          {workspaceRoot}
        </p>
      ) : null}
      <div className="panel-title" style={{ marginTop: 12 }}>
        Files
      </div>
      <div className="file-tree">
        {tree ? renderNode(tree, 0, onOpenFile) : <div>No workspace selected.</div>}
      </div>
    </aside>
  );
};

export default LeftSidebar;
