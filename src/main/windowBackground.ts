import type { Settings } from "../shared/ipc";

export const resolveWindowBackground = (settings: Settings) => {
  if (settings.uiMode === "light") {
    return "#f1f4f8";
  }
  if (settings.uiTheme === "windowsClassic") {
    return "#d9d9d9";
  }
  return "#0b0f15";
};
