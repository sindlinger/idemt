import { useEffect, useMemo, useRef, useState } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import "xterm/css/xterm.css";

const buildCommand = (raw: string, platform: string) => {
  if (!raw) return "";
  if (platform === "win32") {
    if (raw.includes("\\") || raw.includes(" ")) {
      return `& "${raw}" resume`;
    }
    return `${raw} resume`;
  }
  if (raw.includes(" ") || raw.includes("/")) {
    return `"${raw.replace(/\"/g, "\\\"")}" resume`;
  }
  return `${raw} resume`;
};

const CodexResumePanel = ({ command, cwd }: { command: string; cwd?: string }) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const sessionRef = useRef<string | null>(null);
  const [ready, setReady] = useState(false);
  const platform = window.api?.platform ?? "unknown";
  const resumeCommand = useMemo(() => buildCommand(command || "codex", platform), [command, platform]);
  const terminalTheme = useMemo(() => {
    const app = document.querySelector(".app");
    const mode = app?.getAttribute("data-mode") ?? "dark";
    if (mode === "light") {
      return { background: "#ffffff", foreground: "#1e2431" };
    }
    return { background: "transparent", foreground: "#e7ecf4" };
  }, []);

  const runPicker = () => {
    if (!resumeCommand || !sessionRef.current) return;
    window.api?.terminalWrite?.(sessionRef.current, `${resumeCommand}\r`);
  };

  useEffect(() => {
    const terminal = new Terminal({
      fontSize: 11,
      theme: terminalTheme
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    if (containerRef.current) {
      terminal.open(containerRef.current);
      fitAddon.fit();
    }

    let unsubscribe: (() => void) | undefined;

    if (typeof window.api?.terminalSpawn === "function") {
      window.api
        .terminalSpawn({ cwd })
        .then(({ id }) => {
          if (!id) return;
          sessionRef.current = id;
          fitAddon.fit();
          window.api?.terminalResize?.(id, terminal.cols, terminal.rows);
          unsubscribe = window.api?.onTerminalData?.(({ id: incoming, data }) => {
            if (incoming === id) {
              terminal.write(data);
            }
          });
          setReady(true);
          runPicker();
        })
        .catch((err) => {
          const message = err ? String(err) : "resume spawn failed";
          terminal.write(`\r\n[codex resume error] ${message}\r\n`);
          if (typeof window?.api?.log === "function") {
            window.api.log({ scope: "renderer:codex-resume", message });
          }
        });
    } else {
      terminal.write("\r\n[codex resume error] API unavailable.\r\n");
    }

    const handleResize = () => {
      fitAddon.fit();
      if (sessionRef.current) {
        window.api?.terminalResize?.(sessionRef.current, terminal.cols, terminal.rows);
      }
    };

    const resizeObserver =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => handleResize())
        : null;
    if (containerRef.current && resizeObserver) {
      resizeObserver.observe(containerRef.current);
    }
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      resizeObserver?.disconnect();
      unsubscribe?.();
      if (sessionRef.current) window.api?.terminalClose?.(sessionRef.current);
      terminal.dispose();
    };
  }, [cwd, resumeCommand]);

  return (
    <div className="codex-resume">
      <div className="codex-resume-toolbar">
        <span className="codex-resume-title">Resume picker</span>
        <button
          className="codex-resume-button"
          type="button"
          onClick={runPicker}
          disabled={!ready}
        >
          Run picker
        </button>
      </div>
      <div className="codex-resume-terminal" ref={containerRef} />
      <div className="codex-resume-hint">Use arrows + Enter to choose a session.</div>
    </div>
  );
};

export default CodexResumePanel;
