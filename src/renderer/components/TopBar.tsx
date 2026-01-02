const TopBar = ({
  workspaceRoot,
  onSave,
  onCompile,
  onRunTest,
  onSettings
}: {
  workspaceRoot?: string;
  onSave: () => void;
  onCompile: () => void;
  onRunTest: () => void;
  onSettings: () => void;
}) => {
  return (
    <div className="topbar">
      <h1>MT5 Sidecar IDE</h1>
      <div className="toolbar-actions">
        <button className="button" onClick={onSave}>
          Save (Ctrl+S)
        </button>
        <button className="button" onClick={onCompile}>
          Compile
        </button>
        <button className="button" onClick={onRunTest}>
          Run Test
        </button>
        <button className="button" onClick={onSettings}>
          Settings
        </button>
      </div>
      {workspaceRoot ? <span className="status-pill">{workspaceRoot}</span> : null}
    </div>
  );
};

export default TopBar;
