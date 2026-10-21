import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/*
 * A fake provider API for the adapter tests: a local HTTP server that records every request
 * (method, path, headers, parsed body) and answers from a script, one handler per request, the
 * last one repeating. No network beyond loopback.
 */

export interface Recorded {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
  body: unknown;
}

export type Handler = (req: Recorded, res: ServerResponse) => void | Promise<void>;

export interface FakeApi {
  url: string;
  requests: Recorded[];
  /** Replaces the script. */
  script(...handlers: Handler[]): void;
  close(): Promise<void>;
}

export async function fakeApi(...initial: Handler[]): Promise<FakeApi> {
  let handlers = initial;
  let served = 0;
  const requests: Recorded[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: unknown = raw;
      try {
        body = JSON.parse(raw);
      } catch {
        // kept as text
      }
      const recorded = {
        method: req.method ?? "",
        path: req.url ?? "",
        headers: req.headers,
        body,
      };
      requests.push(recorded);
      const handler = handlers[Math.min(served++, handlers.length - 1)];
      if (!handler) {
        res.writeHead(500).end();
        return;
      }
      void Promise.resolve(handler(recorded, res)).catch(() => res.destroy());
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    script(...next) {
      handlers = next;
      served = 0;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Answers JSON with a status and headers. */
export const json =
  (body: unknown, status = 200, headers: Record<string, string> = {}): Handler =>
  (_req, res) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  };

/** Never answers (until the connection is closed). */
export const hang: Handler = () => new Promise(() => {});
