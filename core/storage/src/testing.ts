import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/*
 * A fake S3 for tests (no Docker, no network): one in-memory bucket, path-style, with what
 * OpenHoard's blob store uses of S3 (PutObject, CopyObject, GetObject with ranges, HeadObject,
 * DeleteObject) and S3's errors for a bucket that isn't there and an access key it doesn't know.
 * Signatures aren't checked: only the access key id in the Authorization header.
 */

export interface FakeS3 {
  /** `http://127.0.0.1:<port>`: the endpoint to give the client. */
  endpoint: string;
  bucket: string;
  /** Objects by key. */
  objects: Map<string, Buffer>;
  /** Requests seen, as `METHOD key`. */
  requests: string[];
  close(): Promise<void>;
}

const xml = (res: ServerResponse, status: number, body: string) => {
  res.writeHead(status, { "content-type": "application/xml" });
  res.end(`<?xml version="1.0" encoding="UTF-8"?>${body}`);
};
const error = (res: ServerResponse, status: number, code: string) =>
  xml(res, status, `<Error><Code>${code}</Code><Message>${code}</Message></Error>`);

async function bodyOf(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

/** Starts a fake S3 holding `bucket`, accepting requests signed with `accessKeyId`. */
export async function startFakeS3(
  options: {
    bucket?: string;
    accessKeyId?: string;
    /**
     * Whether the key may list the bucket (s3:ListBucket). Without it, S3 answers a request for a
     * key that isn't there with 403 AccessDenied, not 404.
     */
    canList?: boolean;
  } = {},
): Promise<FakeS3> {
  const bucket = options.bucket ?? "hoard";
  const accessKeyId = options.accessKeyId ?? "AKIAFAKE";
  const objects = new Map<string, Buffer>();
  const requests: string[] = [];
  const etag = (b: Buffer) => `"${createHash("md5").update(b).digest("hex")}"`;

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://fake");
      const [, name, ...rest] = url.pathname.split("/");
      const key = decodeURIComponent(rest.join("/"));
      requests.push(`${req.method} ${key}`);
      const body = await bodyOf(req);
      if (!(req.headers.authorization ?? "").includes(`Credential=${accessKeyId}/`)) {
        return error(res, 403, "InvalidAccessKeyId");
      }
      if (name !== bucket) return error(res, 404, "NoSuchBucket");
      switch (req.method) {
        case "PUT": {
          const source = req.headers["x-amz-copy-source"];
          if (typeof source === "string") {
            const from = decodeURIComponent(source.replace(/^\/?[^/]+\//, ""));
            const data = objects.get(from);
            if (!data) return error(res, 404, "NoSuchKey");
            objects.set(key, Buffer.from(data));
            return xml(
              res,
              200,
              `<CopyObjectResult><ETag>${etag(data)}</ETag><LastModified>${new Date().toISOString()}</LastModified></CopyObjectResult>`,
            );
          }
          objects.set(key, body);
          res.writeHead(200, { etag: etag(body) });
          return res.end();
        }
        case "GET":
        case "HEAD": {
          if (key === "") {
            // A listing: nothing listed (OpenHoard's sweep only).
            return xml(
              res,
              200,
              `<ListBucketResult><Name>${bucket}</Name><KeyCount>0</KeyCount><IsTruncated>false</IsTruncated></ListBucketResult>`,
            );
          }
          const data = objects.get(key);
          if (!data) {
            const status = options.canList === false ? 403 : 404;
            if (req.method === "HEAD") {
              res.writeHead(status);
              return res.end();
            }
            return error(res, status, status === 403 ? "AccessDenied" : "NoSuchKey");
          }
          const headers = {
            etag: etag(data),
            "last-modified": new Date().toUTCString(),
            "content-type": "application/octet-stream",
          };
          const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? "");
          if (range && req.method === "GET") {
            const start = Number(range[1]);
            const end =
              range[2] === "" ? data.length - 1 : Math.min(Number(range[2]), data.length - 1);
            const part = data.subarray(start, end + 1);
            res.writeHead(206, {
              ...headers,
              "content-length": part.length,
              "content-range": `bytes ${start}-${end}/${data.length}`,
            });
            return res.end(part);
          }
          res.writeHead(200, { ...headers, "content-length": data.length });
          return res.end(req.method === "HEAD" ? undefined : data);
        }
        case "DELETE":
          objects.delete(key);
          res.writeHead(204);
          return res.end();
        default:
          return error(res, 405, "MethodNotAllowed");
      }
    })().catch(() => {
      res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    bucket,
    objects,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}
