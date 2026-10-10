import { describe, expect, it } from "vitest";
import { AnalysisCache, CACHE_FILE } from "../../../src/core/cache/store.js";
import { fakeAnalysis } from "../../helpers.js";

function memoryFs() {
  const files = new Map<string, Buffer>();
  return {
    files,
    async readOutput(path: string) {
      return files.get(path) ?? null;
    },
    async writeOutput(path: string, data: Uint8Array) {
      files.set(path, Buffer.from(data));
    },
  };
}

describe("AnalysisCache", () => {
  it("round-trips analyses and estimates", async () => {
    const fs = memoryFs();
    const cache = await AnalysisCache.load(fs, "fp");
    cache.setAnalysis("sha-a", fakeAnalysis({ width: 10 }));
    cache.setEstimate("k", { bytes: 123, basis: "exact" });
    await cache.save(fs);

    const again = await AnalysisCache.load(fs, "fp");
    expect(again.getAnalysis("sha-a")?.width).toBe(10);
    expect(again.getEstimate("k")).toEqual({ bytes: 123, basis: "exact" });
    expect(again.getAnalysis("missing")).toBeUndefined();
  });

  it("writes a self-ignoring .gitignore next to the cache", async () => {
    const fs = memoryFs();
    const cache = await AnalysisCache.load(fs, "fp");
    cache.setAnalysis("a", fakeAnalysis());
    await cache.save(fs);
    expect(fs.files.get(".bytecut-cache/.gitignore")?.toString()).toBe("*\n");
    expect(fs.files.has(CACHE_FILE)).toBe(true);
  });

  it("writes nothing when nothing changed", async () => {
    const fs = memoryFs();
    const cache = await AnalysisCache.load(fs, "fp");
    await cache.save(fs);
    expect(fs.files.size).toBe(0);

    cache.setAnalysis("a", fakeAnalysis());
    await cache.save(fs);
    const before = fs.files.get(CACHE_FILE)!.toString();
    const warm = await AnalysisCache.load(fs, "fp");
    expect(warm.isDirty).toBe(false);
    await warm.save(fs);
    expect(fs.files.get(CACHE_FILE)!.toString()).toBe(before);
  });

  it("discards entries made under a different fingerprint", async () => {
    const fs = memoryFs();
    const cache = await AnalysisCache.load(fs, "sharp=1");
    cache.setAnalysis("a", fakeAnalysis());
    await cache.save(fs);
    expect((await AnalysisCache.load(fs, "sharp=2")).getAnalysis("a")).toBeUndefined();
  });

  it.each(["{ nope", "null", '{"schema":99}', '{"schema":1,"fingerprint":"fp"}'])(
    "treats %j as a cold cache",
    async (content) => {
      const fs = memoryFs();
      fs.files.set(CACHE_FILE, Buffer.from(content));
      const cache = await AnalysisCache.load(fs, "fp");
      expect(cache.getAnalysis("a")).toBeUndefined();
    },
  );

  it("survives a reader that throws", async () => {
    const cache = await AnalysisCache.load(
      {
        async readOutput() {
          throw new Error("EACCES");
        },
      },
      "fp",
    );
    expect(cache.getAnalysis("a")).toBeUndefined();
  });

  it("drops the oldest entries past the cap", async () => {
    const fs = memoryFs();
    const cache = await AnalysisCache.load(fs, "fp");
    for (let i = 0; i < 5005; i++) cache.setAnalysis(`sha-${i}`, fakeAnalysis({ width: i }));
    await cache.save(fs);
    const again = await AnalysisCache.load(fs, "fp");
    expect(again.getAnalysis("sha-0")).toBeUndefined();
    expect(again.getAnalysis("sha-5004")?.width).toBe(5004);
    expect(again.getAnalysis("sha-4")).toBeUndefined();
    expect(again.getAnalysis("sha-5")?.width).toBe(5);
  });
});
