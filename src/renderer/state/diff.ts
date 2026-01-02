import { createTwoFilesPatch } from "diff";

export const calculateChangedLines = (before: string, after: string) => {
  const beforeLines = before.split(/\r?\n/);
  const afterLines = after.split(/\r?\n/);
  const max = Math.max(beforeLines.length, afterLines.length);
  const changed: number[] = [];
  for (let i = 0; i < max; i += 1) {
    if ((beforeLines[i] ?? "") !== (afterLines[i] ?? "")) {
      changed.push(i + 1);
    }
  }
  return changed;
};

export const createUnifiedDiff = (filePath: string, before: string, after: string) =>
  createTwoFilesPatch(filePath, filePath, before, after, "before", "after", {
    context: 3
  });
