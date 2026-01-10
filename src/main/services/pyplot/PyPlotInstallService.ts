import fs from "node:fs/promises";
import path from "node:path";

type InstallRequest = {
  dataDir: string;
  channel: string;
  indicatorFolder?: string;
  capacityMb?: number;
};

const ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..");
const DLL_SRC = path.join(ROOT, "dll", "PyShared_v2.dll");
const IND_TEMPLATE = path.join(
  ROOT,
  "pyplotmt",
  "app",
  "src",
  "pyshared_hub",
  "templates",
  "PyPlotMT_Bridge_v7.mq5"
);
const HUB_CFG = path.join(ROOT, "pyplotmt", "app", "src", "pyshared_hub", "hub_config.py");

const DEFAULT_CHANNEL = "MAIN";
const DEFAULT_CAPACITY_MB = 8;

function toWinPath(p: string): string {
  return p.replace(/^\/(mnt)\/(\w)\//, (_m, _mnt, d) => `${d.toUpperCase()}:\\`).replace(/\//g, "\\");
}

async function detectChannelFromHubConfig(): Promise<string | null> {
  try {
    const text = await fs.readFile(HUB_CFG, "utf8");
    const m = text.match(/"name"\s*:\s*"([^"]+)"/);
    if (m?.[1]) return m[1];
    const m2 = text.match(/'name'\s*:\s*'([^']+)'/);
    if (m2?.[1]) return m2[1];
  } catch {
    return null;
  }
  return null;
}

async function ensureDir(dirPath: string) {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function installPyPlot(request: InstallRequest): Promise<{ ok: boolean; log: string }> {
  const log: string[] = [];
  const dataDir = request.dataDir?.trim();
  if (!dataDir) {
    return { ok: false, log: "dataDir vazio" };
  }

  const dataDirNorm = dataDir.replace(/\\/g, "\\");
  const mql5Root = path.join(dataDirNorm, "MQL5");
  const filesDir = path.join(mql5Root, "Files");
  const libsDir = path.join(mql5Root, "Libraries");
  const indicatorFolder = (request.indicatorFolder || "PyPlotMT").trim() || "PyPlotMT";
  const indDir = path.join(mql5Root, "Indicators", indicatorFolder);

  await ensureDir(filesDir);
  await ensureDir(libsDir);
  await ensureDir(indDir);

  try {
    await fs.access(DLL_SRC);
  } catch {
    return { ok: false, log: `DLL source missing: ${DLL_SRC}` };
  }

  const dllDest = path.join(libsDir, "PyShared_v2.dll");
  await fs.copyFile(DLL_SRC, dllDest);
  log.push(`dll: ${dllDest}`);

  const capacity = request.capacityMb && request.capacityMb > 0 ? request.capacityMb : DEFAULT_CAPACITY_MB;
  let channel = request.channel?.trim();
  if (!channel) channel = (await detectChannelFromHubConfig()) || DEFAULT_CHANNEL;

  const cfgPath = path.join(filesDir, "pyshared_config.json");
  const cfg = {
    dll_path: toWinPath(dllDest),
    dll_name: "PyShared_v2.dll",
    channel,
    capacity_mb: capacity
  };
  await fs.writeFile(cfgPath, JSON.stringify(cfg, null, 2), "utf8");
  log.push(`config: ${cfgPath}`);

  try {
    const template = await fs.readFile(IND_TEMPLATE, "utf8");
    const indName = `PyPlotMT_${channel}.mq5`;
    const out = path.join(indDir, indName);
    const text = template.replace(
      /input string Channel\s*=\s*".*?";/,
      `input string Channel  = "${channel}";`
    );
    await fs.writeFile(out, text, "utf8");
    log.push(`indicator: ${out}`);
  } catch {
    log.push(`indicator: template missing ${IND_TEMPLATE}`);
  }

  return { ok: true, log: log.join("\n") };
}
