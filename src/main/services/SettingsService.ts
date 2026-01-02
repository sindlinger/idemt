import { app } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import type { Settings } from "../../shared/ipc";

const DEFAULTS: Settings = {
  workspaceRoot: "",
  metaeditorPath: "",
  terminalPath: "",
  codexPath: "codex",
  mtDataDir: "",
  reportsDir: ""
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

    for (const [key, value] of entries) {
      if (!value) {
        checks[key] = false;
        continue;
      }
      try {
        await fs.access(value);
        checks[key] = true;
      } catch {
        checks[key] = false;
      }
    }

    return checks;
  }
}
