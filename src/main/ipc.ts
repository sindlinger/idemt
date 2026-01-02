import { dialog, ipcMain } from "electron";
import type { BrowserWindow } from "electron";
import type { BuildRequest, CodexRunRequest, Settings, TestRequest } from "../shared/ipc";
import { BuildService } from "./services/BuildService";
import { CodexService } from "./services/CodexService";
import { LogsService } from "./services/LogsService";
import { SettingsService } from "./services/SettingsService";
import { TerminalService } from "./services/TerminalService";
import { TestService } from "./services/TestService";
import { WorkspaceService } from "./services/WorkspaceService";
import fs from "node:fs/promises";

export const registerIpc = async (window: BrowserWindow) => {
  const settingsService = new SettingsService();
  await settingsService.load();

  const workspaceService = new WorkspaceService(window);
  const logsService = new LogsService(window);
  const buildService = new BuildService(window, logsService);
  const codexService = new CodexService(window, logsService, workspaceService, buildService);
  const testService = new TestService(window, logsService);
  const terminalService = new TerminalService(window);

  ipcMain.handle("settings:get", () => settingsService.get());
  ipcMain.handle("settings:set", async (_event, partial: Settings) => {
    const updated = await settingsService.set(partial);
    return updated;
  });
  ipcMain.handle("settings:validate", async (_event, settings: Settings) =>
    settingsService.validate(settings)
  );

  ipcMain.handle("workspace:select", async () => {
    const result = await dialog.showOpenDialog(window, {
      properties: ["openDirectory", "createDirectory"]
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const root = result.filePaths[0];
    await settingsService.set({ workspaceRoot: root });
    await workspaceService.setWorkspace(root);
    window.webContents.send("workspace:selected", root);
    const tree = await workspaceService.buildTree();
    if (tree) window.webContents.send("workspace:tree", tree);
    return root;
  });

  ipcMain.handle("workspace:tree:get", async () => {
    const root = settingsService.get().workspaceRoot;
    if (root) await workspaceService.setWorkspace(root);
    return workspaceService.buildTree();
  });

  ipcMain.handle("file:open", async (_event, filePath: string) => {
    return workspaceService.openFile(filePath);
  });

  ipcMain.handle("file:save", async (_event, payload: { filePath: string; content: string }) => {
    return workspaceService.saveFile(payload.filePath, payload.content);
  });

  ipcMain.handle("codex:run:start", async (_event, request: CodexRunRequest) => {
    return codexService.run(request, settingsService.get());
  });

  ipcMain.on("codex:run:cancel", () => codexService.cancel());

  ipcMain.handle("build:start", async (_event, request: BuildRequest) =>
    buildService.compile(request.filePath, settingsService.get())
  );

  ipcMain.handle("test:start", async (_event, request: TestRequest) =>
    testService.run(request, settingsService.get())
  );

  ipcMain.handle("terminal:spawn", (_event, options: { cwd?: string; shell?: string }) =>
    terminalService.spawnSession(options)
  );

  ipcMain.on("terminal:write", (_event, payload: { id: string; data: string }) =>
    terminalService.write(payload.id, payload.data)
  );

  ipcMain.on("terminal:resize", (_event, payload: { id: string; cols: number; rows: number }) =>
    terminalService.resize(payload.id, payload.cols, payload.rows)
  );

  ipcMain.on("terminal:close", (_event, id: string) => terminalService.close(id));

  ipcMain.handle("report:read", async (_event, filePath: string) => {
    return fs.readFile(filePath, "utf-8");
  });

  ipcMain.handle(
    "dialog:select",
    async (_event, options: { type: "file" | "directory"; title: string }) => {
      const result = await dialog.showOpenDialog(window, {
        title: options.title,
        properties: options.type === "directory" ? ["openDirectory"] : ["openFile"]
      });
      if (result.canceled || result.filePaths.length === 0) return null;
      return result.filePaths[0];
    }
  );
};
