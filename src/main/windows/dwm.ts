import { BrowserWindow } from "electron";
import { execFile } from "node:child_process";
import { logLine } from "../logger";

const DWMWA_WINDOW_CORNER_PREFERENCE = 33;
const DWMWA_BORDER_COLOR = 34;

const DWMWCP_DEFAULT = 0;
const DWMWCP_DONOTROUND = 1;
const DWMWCP_ROUND = 2;
const DWMWCP_ROUNDSMALL = 3;

type CornerPreference = "default" | "donotround" | "round" | "roundsmall";

const cornerToValue = (corner?: CornerPreference) => {
  switch (corner) {
    case "donotround":
      return DWMWCP_DONOTROUND;
    case "roundsmall":
      return DWMWCP_ROUNDSMALL;
    case "round":
      return DWMWCP_ROUND;
    default:
      return DWMWCP_DEFAULT;
  }
};

const colorRefFromHex = (hex?: string) => {
  if (!hex) return undefined;
  const cleaned = hex.replace("#", "");
  if (cleaned.length !== 6) return undefined;
  const r = parseInt(cleaned.slice(0, 2), 16);
  const g = parseInt(cleaned.slice(2, 4), 16);
  const b = parseInt(cleaned.slice(4, 6), 16);
  if ([r, g, b].some((value) => Number.isNaN(value))) return undefined;
  return (b << 16) | (g << 8) | r;
};

const readHwnd = (win: BrowserWindow) => {
  const handle = win.getNativeWindowHandle();
  if (handle.length >= 8) {
    try {
      return handle.readBigUInt64LE(0).toString();
    } catch {
      return Number(handle.readUInt32LE(0)).toString();
    }
  }
  return Number(handle.readUInt32LE(0)).toString();
};

const buildDwmScript = (hwnd: string, corner: number, borderColor?: number) => {
  const borderLine =
    borderColor !== undefined
      ? `$border = ${borderColor}; [void][Dwm]::DwmSetWindowAttribute($h, ${DWMWA_BORDER_COLOR}, [ref]$border, 4);`
      : "";
  return `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class Dwm {
  [DllImport("dwmapi.dll")]
  public static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int attrValue, int attrSize);
}
"@;
$h = [IntPtr]::new(${hwnd});
$corner = ${corner};
[void][Dwm]::DwmSetWindowAttribute($h, ${DWMWA_WINDOW_CORNER_PREFERENCE}, [ref]$corner, 4);
${borderLine}
`;
};

export const applyWindowsFrameTweaks = (
  win: BrowserWindow,
  options?: { corners?: CornerPreference; borderColor?: string }
) => {
  if (process.platform !== "win32") return;
  try {
    const hwnd = readHwnd(win);
    const cornerValue = cornerToValue(options?.corners ?? "round");
    const borderColor = colorRefFromHex(options?.borderColor);
    const script = buildDwmScript(hwnd, cornerValue, borderColor);
    execFile(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
      (error, stdout, stderr) => {
        if (error) {
          logLine("main", `dwm powershell failed ${String(error)} ${stderr ?? ""}`);
        } else if (stderr) {
          logLine("main", `dwm powershell stderr ${stderr}`);
        } else if (stdout) {
          logLine("main", `dwm powershell ${stdout}`);
        }
      }
    );
  } catch (error) {
    logLine("main", `dwm apply failed ${String(error)}`);
  }
};
