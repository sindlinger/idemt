import { app } from "electron";
import fs from "node:fs";
import path from "node:path";

const resolveLogDirs = () => {
  const dirs = new Set<string>();
  try {
    if (app.isReady()) {
      dirs.add(path.join(app.getPath("userData"), "logs"));
    }
  } catch {
    // ignore
  }
  dirs.add(path.join(process.cwd(), "logs"));
  return Array.from(dirs);
};

export const getTraceLogPath = () =>
  path.join(app.isReady() ? app.getPath("userData") : process.cwd(), "logs", "trace.log");

export const logLine = (scope: string, message: string) => {
  const line = `[${new Date().toISOString()}] [${scope}] ${message}\n`;
  const dirs = resolveLogDirs();
  for (const dir of dirs) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, "trace.log"), line, "utf8");
    } catch {
      // ignore logging errors
    }
  }
};
