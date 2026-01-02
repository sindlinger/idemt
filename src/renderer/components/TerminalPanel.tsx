import { useEffect, useRef, useState } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import "xterm/css/xterm.css";

const TerminalPanel = ({ cwd }: { cwd?: string }) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const sessionRef = useRef<string | null>(null);

  useEffect(() => {
    const terminal = new Terminal({
      fontSize: 12,
      theme: { background: "#141a28", foreground: "#e7ecf4" }
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

    window.api.terminalSpawn({ cwd }).then(({ id }) => {
      setSessionId(id);
      sessionRef.current = id;
      unsubscribe = window.api.onTerminalData(({ id: incoming, data }) => {
        if (incoming === id) {
          terminal.write(data);
        }
      });
    });

    terminal.onData((data) => {
      if (sessionRef.current) {
        window.api.terminalWrite(sessionRef.current, data);
      }
    });

    const handleResize = () => {
      fitAddon.fit();
      if (sessionRef.current) {
        window.api.terminalResize(sessionRef.current, terminal.cols, terminal.rows);
      }
    };

    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      unsubscribe?.();
      if (sessionRef.current) window.api.terminalClose(sessionRef.current);
      terminal.dispose();
    };
  }, [cwd]);

  return <div ref={containerRef} className="terminal-container" />;
};

export default TerminalPanel;
