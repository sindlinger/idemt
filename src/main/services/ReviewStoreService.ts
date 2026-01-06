import { app } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { createSign, randomUUID } from "node:crypto";
import type { ReviewChangePayload, Settings } from "../../shared/ipc";
import type { LogsService } from "./LogsService";

type GoogleCredentials = {
  client_email?: string;
  private_key?: string;
  token_uri?: string;
};

const DEFAULT_KEEP_DAYS = 14;
const DEFAULT_MAX_MB = 200;
const GOOGLE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const GOOGLE_TOKEN_URI = "https://oauth2.googleapis.com/token";
const REVIEW_PREFIX = "change-";

export class ReviewStoreService {
  private baseDir: string;
  private logs: LogsService;

  constructor(logs: LogsService) {
    this.logs = logs;
    this.baseDir = path.join(app.getPath("userData"), "codex-review");
  }

  async storeChange(change: ReviewChangePayload, settings: Settings): Promise<void> {
    const provider = settings.codexReviewProvider ?? "local";
    const keepDays = settings.codexReviewKeepDays ?? DEFAULT_KEEP_DAYS;
    const maxMb = settings.codexReviewMaxMb ?? DEFAULT_MAX_MB;
    await fs.mkdir(this.baseDir, { recursive: true });

    const payload = { ...change, workspaceRoot: settings.workspaceRoot ?? "" };
    const content = JSON.stringify(payload, null, 2);
    const sizeMb = Buffer.byteLength(content) / (1024 * 1024);
    if (sizeMb > maxMb) {
      this.logs.append(
        "codex",
        `Review change skipped (size ${sizeMb.toFixed(1)}MB > max ${maxMb}MB)`
      );
      return;
    }

    const fileName = `${REVIEW_PREFIX}${change.timestamp}-${randomUUID()}.json`;
    const filePath = path.join(this.baseDir, fileName);
    await fs.writeFile(filePath, content, "utf-8");
    await this.prune(keepDays, maxMb);

    if (provider === "googleDrive") {
      try {
        await this.uploadToGoogleDrive(filePath, settings);
      } catch (error) {
        this.logs.append("codex", `Google Drive upload failed: ${String(error)}`);
      }
    }
  }

  private async prune(keepDays: number, maxMb: number) {
    const entries = await fs.readdir(this.baseDir);
    const records: Array<{ name: string; fullPath: string; size: number; timestamp: number }> = [];
    for (const name of entries) {
      if (!name.startsWith(REVIEW_PREFIX)) continue;
      const fullPath = path.join(this.baseDir, name);
      try {
        const stat = await fs.stat(fullPath);
        const timestamp = parseTimestamp(name) ?? stat.mtimeMs;
        records.push({ name, fullPath, size: stat.size, timestamp });
      } catch {
        continue;
      }
    }

    const now = Date.now();
    const cutoff = now - keepDays * 24 * 60 * 60 * 1000;
    for (const record of records) {
      if (record.timestamp < cutoff) {
        await safeRemove(record.fullPath);
      }
    }

    const remaining = records
      .filter((record) => record.timestamp >= cutoff)
      .sort((a, b) => a.timestamp - b.timestamp);
    const maxBytes = maxMb * 1024 * 1024;
    let total = remaining.reduce((sum, record) => sum + record.size, 0);
    while (total > maxBytes && remaining.length > 0) {
      const oldest = remaining.shift();
      if (!oldest) break;
      await safeRemove(oldest.fullPath);
      total -= oldest.size;
    }
  }

  private async uploadToGoogleDrive(filePath: string, settings: Settings) {
    const credentialsPath = settings.codexReviewGoogleCredentials;
    const folderId = settings.codexReviewGoogleFolderId;
    if (!credentialsPath || !folderId) {
      this.logs.append("codex", "Google Drive not configured (missing credentials or folder ID).");
      return;
    }

    const raw = await fs.readFile(credentialsPath, "utf-8");
    const credentials = JSON.parse(raw) as GoogleCredentials;
    if (!credentials.client_email || !credentials.private_key) {
      this.logs.append("codex", "Google Drive credentials invalid.");
      return;
    }

    const token = await getAccessToken(credentials);
    if (!token) {
      this.logs.append("codex", "Google Drive token acquisition failed.");
      return;
    }

    const name = path.basename(filePath);
    const metadata = { name, parents: [folderId] };
    const fileContent = await fs.readFile(filePath);
    const boundary = `mt5ide-${randomUUID()}`;
    const preamble = Buffer.from(
      `--${boundary}\r\n` +
        `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
        `${JSON.stringify(metadata)}\r\n` +
        `--${boundary}\r\n` +
        `Content-Type: application/json\r\n\r\n`
    );
    const epilogue = Buffer.from(`\r\n--${boundary}--`);
    const body = Buffer.concat([preamble, fileContent, epilogue]);

    const response = await fetch(
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": `multipart/related; boundary=${boundary}`
        },
        body
      }
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Drive upload failed ${response.status}: ${text}`);
    }
  }
}

const parseTimestamp = (name: string) => {
  if (!name.startsWith(REVIEW_PREFIX)) return null;
  const parts = name.replace(REVIEW_PREFIX, "").split("-");
  const maybe = Number(parts[0]);
  return Number.isFinite(maybe) ? maybe : null;
};

const safeRemove = async (filePath: string) => {
  try {
    await fs.unlink(filePath);
  } catch {
    return;
  }
};

const getAccessToken = async (credentials: GoogleCredentials): Promise<string | null> => {
  const tokenUri = credentials.token_uri || GOOGLE_TOKEN_URI;
  const header = { alg: "RS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: credentials.client_email,
    scope: GOOGLE_SCOPE,
    aud: tokenUri,
    iat: now,
    exp: now + 3600
  };

  const unsigned = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(
    JSON.stringify(payload)
  )}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const privateKey = credentials.private_key.replace(/\\n/g, "\n");
  const signature = signer.sign(privateKey);
  const jwt = `${unsigned}.${base64UrlEncode(signature)}`;

  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: jwt
  });

  const response = await fetch(tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  if (!response.ok) {
    return null;
  }
  const data = (await response.json()) as { access_token?: string };
  return data.access_token ?? null;
};

const base64UrlEncode = (input: string | Buffer) =>
  Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
