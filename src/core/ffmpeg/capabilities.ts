import type { BinaryInfo, Capabilities } from "./types.js";

export interface RunResult {
  stdout: string;
}
/** Runs a binary with an argument array (never a shell string, §6.14). */
export type Run = (file: string, args: string[]) => Promise<RunResult>;

/** `ffmpeg version 6.1.1-3ubuntu5 Copyright ...` → `6.1.1-3ubuntu5`. */
export function parseVersion(output: string): string | null {
  const match = /^\w+ version (\S+)/m.exec(output);
  return match?.[1] ?? null;
}

/**
 * Names from `-encoders` / `-filters`. Legend lines (` V..... = Video`, `  T.. = Timeline`)
 * look like entries but their "name" is `=`, so those are skipped. Don't key off the
 * `------` rule: `-filters` output has none.
 */
export function parseListing(output: string, kind: "encoders" | "filters"): Set<string> {
  const entry = kind === "encoders" ? /^\s*[VAS][A-Z.]{5}\s+(\S+)/ : /^\s*[T.][S.][C.]\s+(\S+)/;
  const names = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const name = entry.exec(line)?.[1];
    if (name && name !== "=") names.add(name);
  }
  return names;
}

export function toCapabilities(encoders: Set<string>, filters: Set<string>): Capabilities {
  return {
    libsvtav1: encoders.has("libsvtav1"),
    libaomAv1: encoders.has("libaom-av1"),
    libx264: encoders.has("libx264"),
    libvpxVp9: encoders.has("libvpx-vp9"),
    libvmaf: filters.has("libvmaf"),
  };
}

/** Preferred AV1 encoder per §4: libsvtav1, falling back to libaom-av1. */
export function pickAv1Encoder(caps: Capabilities): "libsvtav1" | "libaom-av1" | null {
  if (caps.libsvtav1) return "libsvtav1";
  if (caps.libaomAv1) return "libaom-av1";
  return null;
}

export type CapabilityCache = Map<string, BinaryInfo>;

/** Cached per binary path + version, so only the cheap `-version` call repeats. */
export async function probeFfmpeg(
  path: string,
  run: Run,
  cache: CapabilityCache = new Map(),
): Promise<BinaryInfo> {
  const { stdout } = await run(path, ["-hide_banner", "-version"]);
  const version = parseVersion(stdout) ?? "unknown";
  const key = `${path}\0${version}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const [encoders, filters] = await Promise.all([
    run(path, ["-hide_banner", "-encoders"]),
    run(path, ["-hide_banner", "-filters"]),
  ]);
  const info: BinaryInfo = {
    path,
    version,
    capabilities: toCapabilities(
      parseListing(encoders.stdout, "encoders"),
      parseListing(filters.stdout, "filters"),
    ),
  };
  cache.set(key, info);
  return info;
}

export async function probeFfprobeVersion(path: string, run: Run): Promise<string> {
  const { stdout } = await run(path, ["-hide_banner", "-version"]);
  return parseVersion(stdout) ?? "unknown";
}
