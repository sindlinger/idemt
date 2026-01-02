import type { Diagnostic } from "@shared/ipc";

type ProblemsPanelProps = {
  diagnostics: Diagnostic[];
  onNavigate: (diag: Diagnostic) => void;
};

const ProblemsPanel = ({ diagnostics, onNavigate }: ProblemsPanelProps) => {
  if (diagnostics.length === 0) {
    return <div style={{ color: "var(--muted)" }}>No diagnostics.</div>;
  }

  return (
    <div className="problems-list">
      {diagnostics.map((diag, index) => (
        <div
          key={`${diag.filePath}-${index}`}
          className="problem-item"
          onClick={() => onNavigate(diag)}
        >
          <strong>{diag.severity.toUpperCase()}</strong> {diag.message}
          <div style={{ fontSize: 12, color: "var(--muted)" }}>
            {diag.filePath}:{diag.line}:{diag.column}
          </div>
        </div>
      ))}
    </div>
  );
};

export default ProblemsPanel;
