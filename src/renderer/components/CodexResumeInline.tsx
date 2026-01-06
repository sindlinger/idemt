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

const CodexResumeInline = ({
  command,
  cwd,
  runTarget,
  onReady
}: {
  command: string;
  cwd?: string;
  runTarget?: "windows" | "wsl";
  onReady?: () => void;
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sessionRef = useRef<string | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const platform = window.api?.platform ?? "unknown";
  const effectivePlatform = runTarget === "wsl" ? "linux" : platform;
  const resumeCommand = useMemo(
    () => buildCommand(command || "codex", effectivePlatform),
    [command, effectivePlatform]
  );
  const [configPath, setConfigPath] = useState<string | null>(null);

  useEffect(() => {
    if (runTarget === "wsl") {
      setConfigPath(null);
      return;
    }
    if (typeof window.api?.codexConfigPathGet !== "function") return;
    window.api.codexConfigPathGet().then((path) => setConfigPath(path)).catch(() => setConfigPath(null));
  }, [runTarget]);

  useEffect(() => {
    const terminal = new Terminal({
      fontSize: 11,
      theme: {
        background: "transparent",
        foreground: "#e7ecf4"
      }
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    fitAddonRef.current = fitAddon;

    if (containerRef.current) {
      terminal.open(containerRef.current);
      fitAddon.fit();
    }

    let unsubscribe: (() => void) | undefined;

    if (typeof window.api?.terminalSpawn === "function") {
      window.api
        .terminalSpawn({
          cwd,
          shell: runTarget === "wsl" ? "wsl.exe" : undefined,
          env: configPath ? { CODEX_CONFIG: configPath } : undefined
        })
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
          if (resumeCommand) {
            window.api?.terminalWrite?.(id, `${resumeCommand}\r`);
          }
          onReady?.();
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
  }, [cwd, resumeCommand, configPath, runTarget, onReady]);

  return <div className="codex-resume-inline" ref={containerRef} />;
};

export default CodexResumeInline;
