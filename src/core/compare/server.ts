import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { BytecutError } from "../errors.js";
import type { Manifest, ManifestOutput, ManifestVideoOutput } from "../manifest/types.js";
import { comparePage } from "./page.js";

export interface CompareOptions {
  projectRoot: string;
  /** Output folder, absolute or relative to the project root. */
  outDir: string;
  manifest: Manifest;
  /** POSIX path of the source relative to the project root. */
  source: string;
  /** 0 picks a free port. */
  port?: number;
  /** Fixed token, for tests; random otherwise. */
  token?: string;
}

export interface CompareServer {
  /** `http://127.0.0.1:<port>/<token>/` */
  url: string;
  port: number;
  close(): Promise<void>;
}

const TYPES: Record<string, string> = {
  ".avif": "image/avif",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
};
const VIDEO_EXT = new Set([".mp4", ".webm", ".mov", ".m4v", ".gif"]);

interface Entry {
  /** Absolute path, fixed when the server starts: requests never name a path. */
  file: string;
}

type AnyOutput = ManifestOutput | ManifestVideoOutput;

function describe(o: AnyOutput, index: number) {
  const video = "role" in o ? o : null;
  return {
    index,
    path: o.path,
    role: video?.role ?? "image",
    format: o.format,
    ...(video?.codec ? { codec: video.codec } : {}),
    width: o.width,
    height: o.height,
    bytes: o.bytes,
    encoder: o.encoder,
    ...("quality" in o && o.quality !== undefined ? { quality: o.quality } : {}),
    ...(video?.crf !== undefined ? { crf: video.crf } : {}),
    ...(o.search ? { search: o.search } : {}),
    ...(o.score !== undefined ? { score: o.score } : {}),
    ...(o.scorer ? { scorer: o.scorer } : {}),
  };
}

/** A path inside `root` after resolving symlinks, or null. */
async function within(root: string, candidate: string): Promise<string | null> {
  try {
    const [r, c] = await Promise.all([realpath(root), realpath(candidate)]);
    const rel = relative(r, c);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
    return c;
  } catch {
    return null;
  }
}

/**
 * Serves one source and its outputs, read-only, on the loopback interface only. The URL
 * carries an unguessable token, the files are addressed by index into a list fixed at start
 * (so a request can never name a path), and a Host check stops DNS-rebinding pages.
 */
export async function startCompareServer(options: CompareOptions): Promise<CompareServer> {
  const { manifest, source } = options;
  const image = manifest.sources[source];
  const video = manifest.videos[source];
  const entry = image ?? video;
  if (!entry) {
    throw new BytecutError(
      "INPUT_NOT_FOUND",
      `${source} has not been optimized yet. Run \`bytecut optimize -y\` first.`,
    );
  }
  const outDir = resolve(options.projectRoot, options.outDir);
  const sourceFile = await within(options.projectRoot, resolve(options.projectRoot, source));
  if (!sourceFile) {
    throw new BytecutError("INPUT_NOT_FOUND", `${source} is not a readable file in this project.`);
  }

  const files = new Map<string, Entry>();
  const outputs: ReturnType<typeof describe>[] = [];
  let posterIndex: number | undefined;
  const list: AnyOutput[] = entry.outputs;
  for (const out of list) {
    if (out.status !== "written") continue;
    const file = await within(outDir, resolve(outDir, ...out.path.split("/")));
    if (!file) continue;
    const index = outputs.length;
    files.set(String(index), { file });
    outputs.push(describe(out, index));
    if ("role" in out && out.role === "poster" && posterIndex === undefined) posterIndex = index;
  }
  files.set("original", { file: sourceFile });

  const token = options.token ?? randomBytes(16).toString("hex");
  const isVideo = video !== undefined || VIDEO_EXT.has(extname(source).toLowerCase());
  const data = JSON.stringify({
    source: {
      path: source,
      bytes: entry.bytes,
      width: entry.width,
      height: entry.height,
      kind: isVideo ? "video" : "image",
    },
    outputs,
    ...(posterIndex !== undefined ? { poster: { index: posterIndex } } : {}),
  });
  const page = comparePage();
  const prefix = `/${token}/`;

  function send(res: ServerResponse, status: number, body: string, type = "text/plain") {
    res.writeHead(status, {
      "content-type": `${type}; charset=utf-8`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy":
        "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
    });
    res.end(body);
  }

  async function sendFile(req: IncomingMessage, res: ServerResponse, file: string) {
    let size: number;
    try {
      size = (await stat(file)).size;
    } catch {
      return send(res, 404, "Not found");
    }
    const type = TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
    const headers: Record<string, string | number> = {
      "content-type": type,
      "cache-control": "no-store",
      "accept-ranges": "bytes",
      "x-content-type-options": "nosniff",
    };
    // Browsers seek in video with Range requests.
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
    if (range && (range[1] || range[2])) {
      let start = range[1] ? Number(range[1]) : size - Number(range[2]);
      let end = range[1] && range[2] ? Number(range[2]) : size - 1;
      start = Math.max(0, start);
      end = Math.min(size - 1, end);
      if (start > end || start >= size) {
        res.writeHead(416, { "content-range": `bytes */${size}` });
        return res.end();
      }
      res.writeHead(206, {
        ...headers,
        "content-range": `bytes ${start}-${end}/${size}`,
        "content-length": end - start + 1,
      });
      if (req.method === "HEAD") return res.end();
      createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { ...headers, "content-length": size });
    if (req.method === "HEAD") return res.end();
    createReadStream(file).pipe(res);
  }

  let port = 0;
  const hostOk = (host: string | undefined) =>
    host === `127.0.0.1:${port}` || host === `localhost:${port}`;

  const server: Server = createServer((req, res) => {
    void (async () => {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.setHeader("allow", "GET, HEAD");
        return send(res, 405, "Method not allowed");
      }
      if (!hostOk(req.headers.host)) return send(res, 403, "Forbidden");
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (!url.pathname.startsWith(prefix)) return send(res, 404, "Not found");
      const rest = url.pathname.slice(prefix.length);
      if (rest === "") return send(res, 200, page, "text/html");
      if (rest === "data.json") return send(res, 200, data, "application/json");
      const m = /^file\/(original|\d+)$/.exec(rest);
      const target = m ? files.get(m[1]!) : undefined;
      if (!target) return send(res, 404, "Not found");
      return sendFile(req, res, target.file);
    })().catch(() => {
      if (!res.headersSent) send(res, 500, "Internal error");
      else res.destroy();
    });
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    // 127.0.0.1 only: never reachable from another machine.
    server.listen(options.port ?? 0, "127.0.0.1", () => resolveListen());
  }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      throw new BytecutError("PORT_IN_USE", `Port ${options.port} is already in use.`);
    }
    throw error;
  });
  port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}${prefix}`,
    port,
    close: () =>
      new Promise<void>((resolveClose) => {
        server.closeAllConnections();
        server.close(() => resolveClose());
      }),
  };
}
