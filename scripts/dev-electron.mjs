import { execSync, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const isWsl = Boolean(process.env.WSL_INTEROP || process.env.WSL_DISTRO_NAME);
const requiredFiles = [
  path.join(root, "dist", "main", "main.js"),
  path.join(root, "dist", "preload", "index.js")
];

const waitForFiles = async () => {
  console.log(`[dev-electron] waiting for dist outputs in ${root}`);
  while (true) {
    const checks = await Promise.all(
      requiredFiles.map((file) =>
        fs
          .access(file)
          .then(() => true)
          .catch(() => false)
      )
    );
    if (checks.every(Boolean)) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
};

await waitForFiles();

const env = {
  ...process.env,
  NODE_ENV: "development",
  ELECTRON_ENABLE_LOGGING: "1",
  ELECTRON_ENABLE_STACK_DUMPING: "1"
};

const resolveWslDevUrl = () => {
  try {
    const output = execSync("hostname -I", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
    const ip = output.split(/\s+/)[0];
    if (!ip) return null;
    return `http://${ip}:5173`;
  } catch {
    return null;
  }
};

if (isWsl && !env.MT5IDE_DEV_URL) {
  const wslDevUrl = resolveWslDevUrl();
  if (wslDevUrl) {
    env.MT5IDE_DEV_URL = wslDevUrl;
    console.log(`[dev-electron] Using WSL dev URL ${wslDevUrl}`);
  }
}

const launchWindowsElectron = async () => {
  const winElectron = path.join(root, "node_modules", ".bin", "electron.cmd");
  try {
    await fs.access(winElectron);
  } catch {
    console.error(
      "[dev-electron] Windows node_modules not found. Run in Windows PowerShell:\n" +
        "  cd C:\\git\\mt5ide\n" +
        "  npm install"
    );
    process.exit(1);
  }
  const winRoot = root
    .replace(/^\/mnt\/([a-z])\//i, (_, drive) => `${drive.toUpperCase()}:\\`)
    .replace(/\//g, "\\");
  const cmdExe = process.env.WSL_INTEROP
    ? "cmd.exe"
    : "/mnt/c/Windows/System32/cmd.exe";
  const psExe = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
  try {
    await fs.access(cmdExe);
  } catch {
    try {
      await fs.access(psExe);
    } catch {
      console.error(
        "[dev-electron] cmd.exe not found. WSL interop may be disabled.\n" +
          "Enable interop or run from Windows PowerShell:\n" +
          "  cd C:\\git\\mt5ide\n" +
          "  npm run dev"
      );
      process.exit(1);
    }
  }
  console.log(`[dev-electron] Launching Windows Electron from ${winRoot}`);
  const electronArgs = [".", "--disable-gpu-shader-disk-cache"].join(" ");
  const cmd = ["/c", `cd /d "${winRoot}" && .\\node_modules\\.bin\\electron.cmd ${electronArgs}`];
  const child = await fs
    .access(cmdExe)
    .then(() => spawn(cmdExe, cmd, { env, stdio: "inherit" }))
    .catch(() =>
      spawn(
        psExe,
        [
          "-NoProfile",
          "-Command",
          `Set-Location -LiteralPath '${winRoot}'; .\\node_modules\\.bin\\electron.cmd .`
        ],
        { env, stdio: "inherit" }
      )
    );
  child.on("exit", (code) => {
    process.exit(code ?? 0);
  });
};

if (isWsl) {
  await launchWindowsElectron();
} else {
  const electronPath = path.join(root, "node_modules", ".bin", "electron");
  const child = spawn(electronPath, ["."], { env, stdio: "inherit" });
  child.on("exit", (code) => {
    process.exit(code ?? 0);
  });
}
