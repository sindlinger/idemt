import { BrowserWindow } from "electron";
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

export const applyWindowsFrameTweaks = (
  win: BrowserWindow,
  options?: { corners?: CornerPreference; borderColor?: string }
) => {
  if (process.platform !== "win32") return;
  try {
    // Lazy require so non-Windows builds don't break.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ffi = require("ffi-napi");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ref = require("ref-napi");

    const dwm = ffi.Library("dwmapi", {
      DwmSetWindowAttribute: ["int", ["pointer", "uint", "pointer", "uint"]]
    });

    const hwnd = win.getNativeWindowHandle();
    const hwndPtr = ref.readPointer(hwnd, 0);
    const cornerValue = cornerToValue(options?.corners ?? "round");
    const cornerPref = ref.alloc("int", cornerValue);
    const cornerResult = dwm.DwmSetWindowAttribute(
      hwndPtr,
      DWMWA_WINDOW_CORNER_PREFERENCE,
      cornerPref,
      ref.sizeof.int
    );
    if (cornerResult !== 0) {
      logLine("main", `dwm corner set failed ${cornerResult}`);
    }

    const borderColor = colorRefFromHex(options?.borderColor);
    if (borderColor !== undefined) {
      const borderRef = ref.alloc("int", borderColor);
      const borderResult = dwm.DwmSetWindowAttribute(
        hwndPtr,
        DWMWA_BORDER_COLOR,
        borderRef,
        ref.sizeof.int
      );
      if (borderResult !== 0) {
        logLine("main", `dwm border set failed ${borderResult}`);
      }
    }
  } catch (error) {
    logLine("main", `dwm apply failed ${String(error)}`);
  }
};
