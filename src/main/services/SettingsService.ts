import { app } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import type { Settings } from "../../shared/ipc";

const DEFAULTS: Settings = {
  workspaceRoot: "",
  recentWorkspaces: [],
  metaeditorPath: "",
  terminalPath: "",
  codexPath: "codex",
  codexPathWsl: "",
  codexArgs: "",
  codexArgsWindows: "",
  codexArgsWsl: "",
  codexRunTarget: "windows",
  mtDataDir: "",
  reportsDir: "",
  uiTheme: "windows11",
  uiMode: "dark",
  editorFontSize: 13,
  editorLineNumbers: true,
  editorShowRulers: false,
  editorRulers: [80, 120],
  editorShowCursorPosition: false,
  codexReviewProvider: "local",
  codexReviewMaxMb: 200,
  codexReviewKeepDays: 14,
  codexReviewGoogleCredentials: "",
  codexReviewGoogleFolderId: "",
  windowBounds: undefined
};

export class SettingsService {
  private settingsPath: string;
  private cache: Settings = { ...DEFAULTS };

  constructor() {
    this.settingsPath = path.join(app.getPath("userData"), "settings.json");
  }

  async load(): Promise<Settings> {
    try {
      const raw = await fs.readFile(this.settingsPath, "utf-8");
      const parsed = JSON.parse(raw) as Settings;
      this.cache = { ...DEFAULTS, ...parsed };
    } catch {
      this.cache = { ...DEFAULTS };
    }
    return this.cache;
  }

  get(): Settings {
    return this.cache;
  }

  async set(partial: Settings): Promise<Settings> {
    this.cache = { ...this.cache, ...partial };
    await fs.mkdir(path.dirname(this.settingsPath), { recursive: true });
    await fs.writeFile(this.settingsPath, JSON.stringify(this.cache, null, 2), "utf-8");
    return this.cache;
  }

  async validate(settings: Settings): Promise<Record<string, boolean>> {
    const checks: Record<string, boolean> = {};
    const entries: Array<[keyof Settings, string | undefined]> = [
      ["workspaceRoot", settings.workspaceRoot],
      ["metaeditorPath", settings.metaeditorPath],
      ["terminalPath", settings.terminalPath],
      ["codexPath", settings.codexPath],
      ["mtDataDir", settings.mtDataDir],
      ["reportsDir", settings.reportsDir]
    ];

    if (settings.codexReviewProvider === "googleDrive") {
      entries.push(["codexReviewGoogleCredentials", settings.codexReviewGoogleCredentials]);
    }

    for (const [key, value] of entries) {
      if (!value) {
        checks[key] = false;
        continue;
      }
      const ok = await resolvePathOrCommand(value);
      checks[key] = ok;
    }

    return checks;
  }
}

const resolvePathOrCommand = async (value: string): Promise<boolean> => {
  const hasSeparator = value.includes(path.sep) || value.includes("/") || value.includes("\\");
  if (hasSeparator) {
    try {
      await fs.access(value);
      return true;
    } catch {
      return false;
    }
  }

  const envPath = process.env.PATH ?? "";
  if (!envPath) return false;
  const segments = envPath.split(path.delimiter).filter(Boolean);
  const extList =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")
      : [""];

  for (const segment of segments) {
    for (const ext of extList) {
      const suffix = ext && value.toLowerCase().endsWith(ext.toLowerCase()) ? "" : ext;
      const candidate = path.join(segment, `${value}${suffix}`);
      try {
        await fs.access(candidate);
        return true;
      } catch {
        continue;
      }
    }
  }
  return false;
};
