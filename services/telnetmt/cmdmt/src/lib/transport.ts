import net from "node:net";

export type TransportOpts = {
  hosts: string[];
  port: number;
  timeoutMs: number;
};

export function parseHosts(hosts?: string): string[] {
  if (!hosts) return [];
  return hosts
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
}

async function connectOnce(host: string, port: number, timeoutMs: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let data = "";
    let done = false;

    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      try {
        socket.destroy();
      } catch {
        // ignore
      }
      if (err) reject(err);
    };

    socket.setTimeout(timeoutMs);
    socket.on("timeout", () => finish(new Error("timeout")));
    socket.on("error", (err) => finish(err));
    socket.on("connect", () => {
      socket.write(payload, "utf8");
    });
    socket.on("data", (chunk) => {
      data += chunk.toString("utf8");
    });
    socket.on("end", () => {
      if (done) return;
      done = true;
      resolve(data);
    });
    socket.on("close", () => {
      if (done) return;
      done = true;
      resolve(data);
    });
  });
}

export async function sendLine(line: string, opts: TransportOpts): Promise<string> {
  const payload = line.endsWith("\n") ? line : line + "\n";
  let lastErr: Error | null = null;
  for (const host of opts.hosts) {
    try {
      return await connectOnce(host, opts.port, opts.timeoutMs, payload);
    } catch (err) {
      lastErr = err as Error;
    }
  }
  throw lastErr ?? new Error("connection failed");
}

export async function sendJson(obj: unknown, opts: TransportOpts): Promise<string> {
  const payload = JSON.stringify(obj) + "\n";
  return sendLine(payload, opts);
}
