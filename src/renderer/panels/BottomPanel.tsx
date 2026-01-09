import type { Diagnostic, LogsAppendPayload, TestStatus } from "@shared/ipc";
import { AlertTriangle, FileText, List, Terminal } from "lucide-react";
import type { BottomTab } from "@state/store";
import ProblemsPanel from "./ProblemsPanel";
import OutputPanel from "./OutputPanel";
import ReportPanel from "./ReportPanel";
import TerminalPanel from "./TerminalPanel";

const BottomPanel = ({
  open,
  activeTab,
  diagnostics,
  logs,
  reportHtml,
  testStatus,
  workspaceRoot,
  onTabChange,
  onNavigateDiagnostic
}: {
  open: boolean;
  activeTab: BottomTab;
  diagnostics: Diagnostic[];
  logs: LogsAppendPayload[];
  reportHtml?: string;
  testStatus?: TestStatus;
  workspaceRoot?: string;
  onTabChange: (tab: BottomTab) => void;
  onNavigateDiagnostic: (diag: Diagnostic) => void;
}) => {
  return (
    <div className={`bottom-panel ${open ? "" : "hidden"}`}>
      <div className="bottom-tabs">
        {(["terminal", "problems", "output", "report"] as BottomTab[]).map((tab) => {
          const Icon =
            tab === "terminal"
              ? Terminal
              : tab === "problems"
              ? AlertTriangle
              : tab === "output"
              ? List
              : FileText;
          return (
            <div
              key={tab}
              className={`bottom-tab ${tab === activeTab ? "active" : ""}`}
              onClick={() => onTabChange(tab)}
            >
              <Icon size={12} />
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
            </div>
          );
        })}
        {testStatus?.running ? <span className="status-pill">Tester running</span> : null}
      </div>
      <div className="panel-content">
        {open && activeTab === "terminal" ? <TerminalPanel cwd={workspaceRoot} /> : null}
        {activeTab === "problems" ? (
          <ProblemsPanel diagnostics={diagnostics} onNavigate={onNavigateDiagnostic} />
        ) : null}
        {activeTab === "output" ? <OutputPanel logs={logs} /> : null}
        {activeTab === "report" ? <ReportPanel html={reportHtml} /> : null}
      </div>
    </div>
  );
};

export default BottomPanel;
