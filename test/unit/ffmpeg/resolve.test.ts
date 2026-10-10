import { describe, expect, it } from "vitest";
import { installHint, resolveBinary } from "../../../src/core/ffmpeg/index.js";

const fsWith = (files: string[]) => ({ isFile: (p: string) => files.includes(p) });
const base = { platform: "linux" as const, env: {} as Record<string, string | undefined> };

describe("resolveBinary order", () => {
  const all = ["/flag/ffmpeg", "/env/ffmpeg", "/cfg/ffmpeg", "/usr/bin/ffmpeg"];
  const options = {
    ...base,
    flag: "/flag/ffmpeg",
    config: "/cfg/ffmpeg",
    env: { BYTECUT_FFMPEG: "/env/ffmpeg", PATH: "/usr/bin" },
  };

  it("prefers the flag", () => {
    expect(resolveBinary("ffmpeg", options, fsWith(all))).toEqual({
      found: true,
      path: "/flag/ffmpeg",
      source: "flag",
    });
  });
  it("then the env var", () => {
    expect(resolveBinary("ffmpeg", { ...options, flag: undefined }, fsWith(all))).toMatchObject({
      path: "/env/ffmpeg",
      source: "env",
    });
  });
  it("then config", () => {
    const env = { PATH: "/usr/bin" };
    expect(
      resolveBinary("ffmpeg", { ...options, flag: undefined, env }, fsWith(all)),
    ).toMatchObject({ path: "/cfg/ffmpeg", source: "config" });
  });
  it("then PATH", () => {
    const env = { PATH: "/nope:/usr/bin" };
    expect(resolveBinary("ffmpeg", { ...base, env }, fsWith(all))).toEqual({
      found: true,
      path: "/usr/bin/ffmpeg",
      source: "path",
    });
  });
  it("reports not found when nothing matches", () => {
    expect(resolveBinary("ffmpeg", { ...base, env: { PATH: "/usr/bin" } }, fsWith([]))).toEqual({
      found: false,
      source: null,
    });
  });
  it("does not fall through when an explicit path is missing", () => {
    const result = resolveBinary(
      "ffmpeg",
      { ...base, flag: "/typo/ffmpeg", env: { PATH: "/usr/bin" } },
      fsWith(["/usr/bin/ffmpeg"]),
    );
    expect(result).toEqual({ found: false, source: "flag", attempted: "/typo/ffmpeg" });
  });
});

describe("ffprobe resolution", () => {
  it("uses its own env var and flag", () => {
    const fs = fsWith(["/p/ffprobe", "/e/ffprobe"]);
    expect(
      resolveBinary(
        "ffprobe",
        { ...base, flag: "/p/ffprobe", env: { BYTECUT_FFPROBE: "/e/ffprobe" } },
        fs,
      ),
    ).toMatchObject({ source: "flag" });
    expect(
      resolveBinary("ffprobe", { ...base, env: { BYTECUT_FFPROBE: "/e/ffprobe" } }, fs),
    ).toMatchObject({ source: "env", path: "/e/ffprobe" });
  });
  it("defaults to the directory of the resolved ffmpeg before PATH", () => {
    const fs = fsWith(["/opt/ff/ffprobe", "/usr/bin/ffprobe"]);
    expect(
      resolveBinary("ffprobe", { ...base, ffmpegDir: "/opt/ff", env: { PATH: "/usr/bin" } }, fs),
    ).toEqual({ found: true, path: "/opt/ff/ffprobe", source: "ffmpeg-dir" });
  });
  it("falls back to PATH when the ffmpeg directory has none", () => {
    const fs = fsWith(["/usr/bin/ffprobe"]);
    expect(
      resolveBinary("ffprobe", { ...base, ffmpegDir: "/opt/ff", env: { PATH: "/usr/bin" } }, fs),
    ).toMatchObject({ source: "path" });
  });
});

describe("windows", () => {
  it("finds .exe on PATH using PATHEXT", () => {
    const result = resolveBinary(
      "ffmpeg",
      { platform: "win32", env: { PATH: "C:\\ff", PATHEXT: ".EXE;.CMD" } },
      { isFile: (p) => p.endsWith("ffmpeg.exe") },
    );
    expect(result).toMatchObject({ found: true, source: "path" });
  });
});

describe("installHint", () => {
  it("is OS specific", () => {
    expect(installHint("darwin")).toBe("brew install ffmpeg");
    expect(installHint("win32")).toBe("winget install ffmpeg");
    expect(installHint("linux", "ubuntu")).toBe("sudo apt install ffmpeg");
    expect(installHint("linux", "fedora")).toBe("sudo dnf install ffmpeg");
    expect(installHint("linux")).toBe("sudo apt install ffmpeg");
  });
});
