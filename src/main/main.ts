import { app, BrowserWindow, screen } from "electron";
import path from "node:path";
import { registerIpc } from "./ipc";
import { logLine } from "./logger";
import { SettingsService } from "./services/SettingsService";
import type { WindowBounds } from "../shared/ipc";

let mainWindow: BrowserWindow | null = null;
let isQuitting = false;
let saveBoundsTimer: NodeJS.Timeout | null = null;

const settingsService = new SettingsService();
let settingsReady = false;

const WINDOW_DEFAULTS = {
  width: 1600,
  height: 900,
  minWidth: 1200,
  minHeight: 720
};

const isDev = process.env.NODE_ENV === "development";
const isWsl =
  process.platform === "linux" &&
  (Boolean(process.env.WSL_INTEROP) || Boolean(process.env.WSL_DISTRO_NAME));

if (isWsl) {
  // Avoid GPU/ANGLE issues on WSL + X servers (ex: X410).
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("use-gl", "swiftshader");
}

const DEV_URLS = ["http://localhost:5173", "http://127.0.0.1:5173"];

const ensureSettingsLoaded = async () => {
  if (settingsReady) return;
  await settingsService.load();
  settingsReady = true;
  logLine("main", "settings loaded");
};

const resolveWindowBounds = (saved?: WindowBounds) => {
  if (!saved) return null;
  const { x, y, width, height } = saved;
  if (![x, y, width, height].every((value) => Number.isFinite(value))) return null;
  const display = screen.getDisplayMatching({ x, y, width, height });
  const area = display.workArea;
  const safeWidth = Math.min(Math.max(width, WINDOW_DEFAULTS.minWidth), area.width);
  const safeHeight = Math.min(Math.max(height, WINDOW_DEFAULTS.minHeight), area.height);
  let safeX = x;
  let safeY = y;
  const maxX = area.x + area.width - 64;
  const maxY = area.y + area.height - 64;
  if (safeX < area.x) safeX = area.x;
  if (safeY < area.y) safeY = area.y;
  if (safeX > maxX) safeX = area.x + Math.max(0, area.width - safeWidth);
  if (safeY > maxY) safeY = area.y + Math.max(0, area.height - safeHeight);
  return { x: safeX, y: safeY, width: safeWidth, height: safeHeight };
};

const scheduleWindowBoundsSave = () => {
  if (!mainWindow || !settingsReady) return;
  if (saveBoundsTimer) clearTimeout(saveBoundsTimer);
  saveBoundsTimer = setTimeout(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const bounds = mainWindow.getNormalBounds();
    void settingsService.set({
      windowBounds: { ...bounds, isMaximized: mainWindow.isMaximized() }
    });
  }, 300);
};

const createWindow = async () => {
  logLine("main", "createWindow start");
  await ensureSettingsLoaded();
  const savedBounds = resolveWindowBounds(settingsService.get().windowBounds);
  mainWindow = new BrowserWindow({
    width: savedBounds?.width ?? WINDOW_DEFAULTS.width,
    height: savedBounds?.height ?? WINDOW_DEFAULTS.height,
    minWidth: WINDOW_DEFAULTS.minWidth,
    minHeight: WINDOW_DEFAULTS.minHeight,
    x: savedBounds?.x,
    y: savedBounds?.y,
    backgroundColor: "#0b0f15",
    transparent: false,
    frame: false,
    roundedCorners: true,
    thickFrame: process.platform === "win32" ? false : true,
    hasShadow: process.platform === "win32" ? false : true,
    ...(process.platform === "win32" ? { backgroundMaterial: "mica" } : {}),
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "../preload/index.js")
    }
  });

  await registerIpc(mainWindow, settingsService);
  mainWindow.setMenuBarVisibility(false);
  logLine("main", "ipc registered + menu hidden");

  mainWindow.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    const label = `renderer:${level}`;
    logLine(label, `${message} (${sourceId}:${line})`);
    if (isDev) {
      console.log(`[${label}] ${message} (${sourceId}:${line})`);
    }
  });

  mainWindow.on("closed", () => {
    logLine("main", "window closed");
    mainWindow = null;
  });
  mainWindow.on("move", scheduleWindowBoundsSave);
  mainWindow.on("resize", scheduleWindowBoundsSave);
  mainWindow.on("close", scheduleWindowBoundsSave);
  mainWindow.on("maximize", scheduleWindowBoundsSave);
  mainWindow.on("unmaximize", scheduleWindowBoundsSave);

  mainWindow.webContents.on("did-fail-load", (_event, code, desc, validatedURL) => {
    logLine("main", `did-fail-load code=${code} desc=${desc} url=${validatedURL}`);
  });
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    logLine("main", `render-process-gone reason=${details.reason} exitCode=${details.exitCode}`);
  });
  mainWindow.webContents.on("did-finish-load", () => {
    logLine("main", "did-finish-load");
  });
  mainWindow.webContents.on("dom-ready", () => {
    logLine("main", "dom-ready");
  });

  try {
    if (isDev) {
      logLine("main", "loading dev URL");
      await loadDevUrl(0);
      mainWindow.webContents.openDevTools({ mode: "detach" });
    } else {
      logLine("main", "loading file index.html");
      await mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
    }
  } catch (error) {
    console.error("Failed to load renderer:", error);
    logLine("main", `load renderer error ${String(error)}`);
  }

  if (settingsService.get().windowBounds?.isMaximized) {
    mainWindow.maximize();
  }
};

const loadDevUrl = async (attempt: number) => {
  if (!mainWindow) return;
  const url = DEV_URLS[attempt % DEV_URLS.length];
  try {
    await mainWindow.loadURL(url);
    logLine("main", `loadURL ok ${url}`);
  } catch (error) {
    console.error(`Failed to load dev URL: ${url}`, error);
    logLine("main", `loadURL failed ${url} err=${String(error)}`);
    const delay = Math.min(1000 + attempt * 500, 5000);
    setTimeout(() => void loadDevUrl(attempt + 1), delay);
  }
};

app.whenReady().then(async () => {
  logLine("main", "app ready");
  await ensureSettingsLoaded();
  void createWindow();
});

app.on("before-quit", () => {
  isQuitting = true;
  logLine("main", "before-quit");
});

app.on("will-quit", () => {
  logLine("main", "will-quit");
});

app.on("quit", (_event, exitCode) => {
  logLine("main", `quit exitCode=${exitCode ?? "unknown"}`);
});

app.on("window-all-closed", () => {
  logLine("main", "window-all-closed");
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    logLine("main", "activate -> createWindow");
    void createWindow();
  }
});

process.on("uncaughtException", (error) => {
  console.error("uncaughtException", error);
  logLine("main", `uncaughtException ${String(error)}`);
});

process.on("unhandledRejection", (reason) => {
  console.error("unhandledRejection", reason);
  logLine("main", `unhandledRejection ${String(reason)}`);
});

process.on("exit", (code) => {
  logLine("main", `process exit code=${code}`);
});

process.on("SIGTERM", () => {
  logLine("main", "SIGTERM received");
});

process.on("SIGINT", () => {
  logLine("main", "SIGINT received");
});

process.on("SIGHUP", () => {
  logLine("main", "SIGHUP received");
});
