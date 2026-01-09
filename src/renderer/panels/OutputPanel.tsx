import type { LogsAppendPayload } from "@shared/ipc";

type OutputPanelProps = {
  logs: LogsAppendPayload[];
};

const OutputPanel = ({ logs }: OutputPanelProps) => {
  return (
    <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 12, whiteSpace: "pre-wrap" }}>
      {logs.map((log, index) => (
        <div key={`${log.timestamp}-${index}`}>
          [{log.source}] {log.line}
        </div>
      ))}
    </div>
  );
};

export default OutputPanel;
