import { request } from "node:http";
import { createServer } from "node:net";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startCompareServer, type CompareServer } from "../../../src/core/compare/index.js";
import { comparePage } from "../../../src/core/compare/page.js";
import type { Manifest } from "../../../src/core/manifest/types.js";
import { hashAll, tempDir } from "../../helpers.js";

const SHA = "a".repeat(64);
const output = (path: string, over: Record<string, unknown> = {}) => ({
  path,
  url: `/_bytecut/${path}`,
  format: "webp" as const,
  width: 640,
  height: 480,
  bytes: 11,
  sha256: SHA,
  lossless: false,
  quality: 70,
  effort: 4,
  encoder: "libwebp",
  status: "written" as const,
  ...over,
});

function manifest(outputs: unknown[]): Manifest {
  return {
    version: 3,
    tools: {},
    publicPath: "/_bytecut",
    sources: {
      "public/img/a.jpg": {
        sha256: SHA,
        bytes: 5000,
        width: 1280,
        height: 960,
        preset: "photo",
        outputs: outputs as never,
      },
    },
    videos: {},
  };
}

async function project(over: { outputs?: unknown[] } = {}) {
  const root = await tempDir();
  await mkdir(join(root, "public/img"), { recursive: true });
  await mkdir(join(root, "out/img/a"), { recursive: true });
  await writeFile(join(root, "public/img/a.jpg"), "ORIGINAL-BYTES");
  await writeFile(join(root, "out/img/a/a-640.webp"), "0123456789A");
  const outputs = over.outputs ?? [
    output("img/a/a-640.webp", {
      search: { metric: "ssimulacra2", target: 75 },
      score: 76.4,
      scorer: "wasm",
    }),
  ];
  return { root, manifest: manifest(outputs) };
}

const servers: CompareServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function start(p: Awaited<ReturnType<typeof project>>, extra = {}) {
  const server = await startCompareServer({
    projectRoot: p.root,
    outDir: "out",
    manifest: p.manifest,
    source: "public/img/a.jpg",
    ...extra,
  });
  servers.push(server);
  return server;
}

interface Reply {
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}
function get(
  url: string,
  options: { method?: string; headers?: Record<string, string>; path?: string } = {},
): Promise<Reply> {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: u.port,
        path: options.path ?? u.pathname,
        method: options.method ?? "GET",
        headers: options.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            headers: res.headers,
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("compare server", () => {
  it("listens on the loopback interface only, on a random port, under an unguessable path", async () => {
    const a = await start(await project());
    const b = await start(await project());
    expect(a.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\/$/);
    expect(a.port).not.toBe(b.port);
    expect(a.url).not.toBe(b.url);
  });

  it("serves the page, the data and the files only under the token", async () => {
    const server = await start(await project());
    const page = await get(server.url);
    expect(page.status).toBe(200);
    expect(page.headers["content-type"]).toMatch(/text\/html/);
    expect(page.body).toContain("bytecut compare");

    const data = JSON.parse((await get(`${server.url}data.json`)).body);
    expect(data.source).toMatchObject({ path: "public/img/a.jpg", bytes: 5000, kind: "image" });
    expect(data.outputs).toHaveLength(1);
    expect(data.outputs[0]).toMatchObject({
      index: 0,
      path: "img/a/a-640.webp",
      score: 76.4,
      search: { metric: "ssimulacra2", target: 75 },
    });

    expect((await get(`${server.url}file/0`)).body).toBe("0123456789A");
    expect((await get(`${server.url}file/original`)).body).toBe("ORIGINAL-BYTES");

    const u = new URL(server.url);
    for (const path of ["/", "/data.json", "/file/0", `/${"0".repeat(32)}/`]) {
      expect((await get(server.url, { path })).status, path).toBe(404);
    }
    expect(u.pathname.length).toBe(34);
  });

  it("never lets a request name a path", async () => {
    const server = await start(await project());
    const base = new URL(server.url).pathname;
    for (const rest of [
      "file/..%2f..%2fout%2fimg%2fa%2fa-640.webp",
      "file/1",
      "file/-1",
      "file/0/extra",
      "file/original/../../package.json",
      "file/%2e%2e/%2e%2e/etc/passwd",
    ]) {
      const r = await get(server.url, { path: `${base}${rest}` });
      expect(r.status, rest).toBe(404);
    }
  });

  it("refuses a request whose Host is not the loopback address (DNS rebinding)", async () => {
    const server = await start(await project());
    const r = await get(server.url, { headers: { host: "evil.example" } });
    expect(r.status).toBe(403);
    expect((await get(server.url, { headers: { host: `localhost:${server.port}` } })).status).toBe(
      200,
    );
  });

  it("is read-only: other methods are refused and nothing on disk changes", async () => {
    const p = await project();
    const server = await start(p);
    const before = {
      out: await hashAll(join(p.root, "out/img/a"), ["a-640.webp"]),
      src: await hashAll(join(p.root, "public/img"), ["a.jpg"]),
    };
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const r = await get(server.url, { method, path: `${new URL(server.url).pathname}file/0` });
      expect(r.status, method).toBe(405);
    }
    await get(`${server.url}file/0`);
    expect(await hashAll(join(p.root, "out/img/a"), ["a-640.webp"])).toEqual(before.out);
    expect(await hashAll(join(p.root, "public/img"), ["a.jpg"])).toEqual(before.src);
  });

  it("supports range requests so video can seek", async () => {
    const server = await start(await project());
    const r = await get(`${server.url}file/0`, { headers: { range: "bytes=2-5" } });
    expect(r.status).toBe(206);
    expect(r.body).toBe("2345");
    expect(r.headers["content-range"]).toBe("bytes 2-5/11");
    const tail = await get(`${server.url}file/0`, { headers: { range: "bytes=-3" } });
    expect(tail.body).toBe("89A");
    const bad = await get(`${server.url}file/0`, { headers: { range: "bytes=50-60" } });
    expect(bad.status).toBe(416);
  });

  it("serves only outputs the manifest says were written, and none outside the output folder", async () => {
    const p = await project({
      outputs: [
        output("img/a/a-640.webp"),
        output("img/a/gone.avif", { status: "already-optimal" }),
        output("img/a/old.webp", { status: "stale" }),
        output("../../public/img/a.jpg"),
      ],
    });
    // The files exist: only the manifest's status keeps these two from being served.
    await writeFile(join(p.root, "out/img/a/gone.avif"), "GONE");
    await writeFile(join(p.root, "out/img/a/old.webp"), "OLD");
    await symlink(join(p.root, "public/img/a.jpg"), join(p.root, "out/img/a/link.webp"));
    p.manifest.sources["public/img/a.jpg"]!.outputs.push(output("img/a/link.webp") as never);
    const server = await start(p);
    const data = JSON.parse((await get(`${server.url}data.json`)).body);
    expect(data.outputs.map((o: { path: string }) => o.path)).toEqual(["img/a/a-640.webp"]);
    expect((await get(`${server.url}file/1`)).status).toBe(404);
  });

  it("describes a video with its poster and the CRF the search chose", async () => {
    const root = await tempDir();
    await mkdir(join(root, "media"), { recursive: true });
    await mkdir(join(root, "out/media/v"), { recursive: true });
    await writeFile(join(root, "media/v.mp4"), "SRC");
    await writeFile(join(root, "out/media/v/v-640.h264.mp4"), "MP4");
    await writeFile(join(root, "out/media/v/v-poster.avif"), "POSTER");
    const m: Manifest = {
      version: 3,
      tools: {},
      publicPath: "/_bytecut",
      sources: {},
      videos: {
        "media/v.mp4": {
          sha256: SHA,
          bytes: 900,
          width: 640,
          height: 360,
          durationSec: 4,
          preset: "content-video",
          outputs: [
            {
              path: "media/v/v-640.h264.mp4",
              url: "/x",
              role: "video",
              format: "mp4",
              codec: "h264",
              width: 640,
              height: 360,
              bytes: 3,
              sha256: SHA,
              crf: 31,
              encoder: "libx264",
              status: "written",
              search: { metric: "vmaf", target: 90 },
              score: 91.2,
              scorer: "libvmaf",
            },
            {
              path: "media/v/v-poster.avif",
              url: "/y",
              role: "poster",
              format: "avif",
              width: 640,
              height: 360,
              bytes: 6,
              sha256: SHA,
              encoder: "libaom",
              status: "written",
            },
          ],
        },
      },
    };
    const server = await startCompareServer({
      projectRoot: root,
      outDir: "out",
      manifest: m,
      source: "media/v.mp4",
    });
    servers.push(server);
    const data = JSON.parse((await get(`${server.url}data.json`)).body);
    expect(data.source.kind).toBe("video");
    expect(data.poster).toEqual({ index: 1 });
    expect(data.outputs[0]).toMatchObject({
      codec: "h264",
      crf: 31,
      scorer: "libvmaf",
      search: { metric: "vmaf", target: 90 },
    });
    expect((await get(`${server.url}file/0`)).headers["content-type"]).toBe("video/mp4");
  });

  it("refuses a file that was never optimized", async () => {
    const p = await project();
    await expect(
      startCompareServer({
        projectRoot: p.root,
        outDir: "out",
        manifest: p.manifest,
        source: "public/img/other.jpg",
      }),
    ).rejects.toMatchObject({ code: "INPUT_NOT_FOUND" });
  });

  it("stops listening when closed", async () => {
    const server = await start(await project());
    await server.close();
    servers.length = 0;
    await expect(get(server.url)).rejects.toThrow();
  });

  it("reports a port that is taken", async () => {
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", r));
    const port = (blocker.address() as { port: number }).port;
    try {
      await expect(start(await project(), { port })).rejects.toMatchObject({
        code: "PORT_IN_USE",
      });
    } finally {
      blocker.close();
    }
  });
});

describe("compare page", () => {
  it("makes no request beyond its own server", () => {
    const html = comparePage();
    // No absolute URLs, protocol-relative URLs, imports or external fonts of any kind.
    expect(html).not.toMatch(/https?:\/\//i);
    expect(html).not.toMatch(/(?:src|href)=["']\/\//i);
    expect(html).not.toMatch(/@import|<link\b/i);
    expect(html).not.toMatch(/<script[^>]+src=/i);
  });
});
