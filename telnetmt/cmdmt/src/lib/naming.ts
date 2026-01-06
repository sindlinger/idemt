import crypto from "node:crypto";

export function stableHash(input: string, length = 8): string {
  return crypto.createHash("sha1").update(input).digest("hex").slice(0, length);
}

export function safeFileBase(input: string): string {
  const cleaned = input
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+/, "")
    .replace(/_+$/, "");
  return cleaned || "item";
}
