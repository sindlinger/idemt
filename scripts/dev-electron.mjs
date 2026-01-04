import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const isWsl = Boolean(process.env.WSL_INTEROP || process.env.WSL_DISTRO_NAME);
const requiredFiles = [
  path.join(root, "dist", "main", "main.js"),
  path.join(root, "dist", "preload", "index.js")
];

const waitForFiles = async () => {
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
    .replace(/^\\/mnt\\/(\\w)\\//, (_, drive) => `${drive.toUpperCase()}:\\\\`)
    .replace(/\\//g, "\\\\");
  const cmd = [
    "/c",
    `cd /d "${winRoot}" && .\\node_modules\\.bin\\electron.cmd .`
  ];
  const child = spawn("cmd.exe", cmd, { env, stdio: "inherit" });
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
