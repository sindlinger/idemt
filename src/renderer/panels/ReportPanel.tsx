const ReportPanel = ({ html }: { html?: string }) => {
  if (!html) {
    return <div style={{ color: "var(--muted)" }}>No report loaded.</div>;
  }
  return <iframe className="report-viewer" title="Report" srcDoc={html} />;
};

export default ReportPanel;
