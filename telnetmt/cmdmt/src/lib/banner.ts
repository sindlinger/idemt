import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BLUE_BG = "\x1b[44m";
const WHITE = "\x1b[97m";
const RESET = "\x1b[0m";

const ANSI_RE = /\x1b\[[0-9;]*m/g;

function visibleLen(s: string): number {
  return s.replace(ANSI_RE, "").length;
}

function pad(s: string, width: number): string {
  const len = visibleLen(s);
  if (len >= width) return s;
  return s + " ".repeat(width - len);
}

function resolveVersion(): string {
  const env = process.env.npm_package_version?.trim();
  if (env) return env;
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.resolve(here, "../../package.json");
    const raw = fs.readFileSync(pkgPath, "utf8");
    const pkg = JSON.parse(raw) as { version?: string };
    if (pkg.version) return String(pkg.version);
  } catch {
    // ignore
  }
  return "dev";
}

export function renderBanner(opts: {
  label: string;
  owner: string;
  socket: string;
}): string {
  const version = resolveVersion();
  const lines: string[] = [
    `${opts.label} (socket)`,
    `Autor: ${opts.owner}`,
    `Versao: v${version}`,
    `Socket: ${opts.socket}`
  ];
  const width = Math.max(...lines.map((l) => l.length)) + 2;
  const out: string[] = [];
  for (const line of lines) {
    out.push(`${BLUE_BG}${WHITE}${pad(" " + line + " ", width)}${RESET}`);
  }
  return out.join("\n") + "\n";
}
