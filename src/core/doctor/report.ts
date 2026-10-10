import {
  ffmpegDirOf,
  installHint,
  pickAv1Encoder,
  probeFfmpeg,
  probeFfprobeVersion,
  resolveBinary,
  type BinaryInfo,
  type BinarySource,
  type ResolvedBinary,
  type Run,
} from "../ffmpeg/index.js";

export const MIN_NODE_MAJOR = 22;

export interface DoctorDeps {
  nodeVersion: string;
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  osReleaseId?: string | undefined;
  isFile(path: string): boolean;
  run: Run;
  /** Resolves with sharp's version, rejects if it cannot be loaded. */
  loadSharp(): Promise<{ version: string; libvips: string }>;
}

export interface DoctorOptions {
  ffmpegFlag?: string | undefined;
  ffprobeFlag?: string | undefined;
  /** Wired up in M7 when the config loader exists. */
  ffmpegConfig?: string | undefined;
  ffprobeConfig?: string | undefined;
}

export interface ProjectReport {
  framework: string;
  /** Config file in use, relative to the project root; null means zero-config. */
  configFile: string | null;
  /** Set when the config exists but could not be used. */
  configError?: string;
  outDir: string;
  /** The output folder is matched by a .gitignore; outputs are meant to be committed. */
  outDirIgnored: boolean;
}

export interface BinaryReport {
  resolved: ResolvedBinary;
  version?: string;
  /** Set when the binary was found but could not be executed. */
  error?: string;
}

export interface DoctorReport {
  node: { version: string; supported: boolean };
  sharp: { available: boolean; version?: string; libvips?: string; error?: string };
  ffmpeg: BinaryReport & { info?: BinaryInfo };
  ffprobe: BinaryReport;
  encoders: { av1: "libsvtav1" | "libaom-av1" | null; h264: boolean; vp9: boolean; vmaf: boolean };
  /** The project and its config, when doctor is run for one (filled in by the CLI). */
  project?: ProjectReport;
  /** What will be degraded, each with the reason. Empty when everything is available. */
  degradations: string[];
  /** Hard failures: bytecut cannot run correctly at all. */
  ok: boolean;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function collectDoctorReport(
  deps: DoctorDeps,
  options: DoctorOptions = {},
): Promise<DoctorReport> {
  const major = Number.parseInt(deps.nodeVersion.replace(/^v/, ""), 10);
  const node = { version: deps.nodeVersion, supported: major >= MIN_NODE_MAJOR };

  let sharp: DoctorReport["sharp"];
  try {
    sharp = { available: true, ...(await deps.loadSharp()) };
  } catch (error) {
    sharp = { available: false, error: message(error) };
  }

  const base = { env: deps.env, platform: deps.platform };
  const ffmpegResolved = resolveBinary(
    "ffmpeg",
    { ...base, flag: options.ffmpegFlag, config: options.ffmpegConfig },
    deps,
  );
  const ffprobeResolved = resolveBinary(
    "ffprobe",
    {
      ...base,
      flag: options.ffprobeFlag,
      config: options.ffprobeConfig,
      ffmpegDir: ffmpegDirOf(ffmpegResolved),
    },
    deps,
  );

  const ffmpeg: DoctorReport["ffmpeg"] = { resolved: ffmpegResolved };
  if (ffmpegResolved.found) {
    try {
      ffmpeg.info = await probeFfmpeg(ffmpegResolved.path, deps.run);
      ffmpeg.version = ffmpeg.info.version;
    } catch (error) {
      ffmpeg.error = message(error);
    }
  }

  const ffprobe: DoctorReport["ffprobe"] = { resolved: ffprobeResolved };
  if (ffprobeResolved.found) {
    try {
      ffprobe.version = await probeFfprobeVersion(ffprobeResolved.path, deps.run);
    } catch (error) {
      ffprobe.error = message(error);
    }
  }

  const caps = ffmpeg.info?.capabilities;
  const encoders = {
    av1: caps ? pickAv1Encoder(caps) : null,
    h264: caps?.libx264 ?? false,
    vp9: caps?.libvpxVp9 ?? false,
    vmaf: caps?.libvmaf ?? false,
  };

  const degradations: string[] = [];
  const hint = installHint(deps.platform, deps.osReleaseId);
  if (!ffmpegResolved.found) {
    degradations.push(
      ffmpegResolved.attempted
        ? `ffmpeg not found at ${ffmpegResolved.attempted} (from ${sourceLabel(ffmpegResolved.source)}). Videos and GIFs will be marked "needs ffmpeg"; images are unaffected.`
        : `ffmpeg not found. Videos and GIFs will be marked "needs ffmpeg"; images are unaffected. Install it with: ${hint}`,
    );
  } else if (ffmpeg.error) {
    degradations.push(
      `ffmpeg at ${ffmpegResolved.path} could not be run (${ffmpeg.error}). Videos and GIFs will be marked "needs ffmpeg".`,
    );
  } else {
    if (!ffprobeResolved.found || ffprobe.error) {
      degradations.push(
        `ffprobe is not usable. Videos cannot be probed, so they will be marked "needs ffmpeg". It normally ships alongside ffmpeg; install it with: ${hint}`,
      );
    }
    if (!encoders.av1) {
      degradations.push(
        "No AV1 encoder (libsvtav1 / libaom-av1). AV1 outputs will be skipped; H.264 and poster are still produced.",
      );
    }
    if (!encoders.h264) {
      degradations.push("libx264 is missing. H.264 MP4 fallbacks cannot be produced.");
    }
    if (!encoders.vmaf) {
      degradations.push(
        "libvmaf is missing. Fixed quality settings from the preset target will be used; the VMAF search is skipped.",
      );
    }
  }

  return {
    node,
    sharp,
    ffmpeg,
    ffprobe,
    encoders,
    degradations,
    ok: node.supported && sharp.available,
  };
}

function sourceLabel(source: BinarySource | null): string {
  switch (source) {
    case "flag":
      return "--ffmpeg/--ffprobe flag";
    case "env":
      return "BYTECUT_FFMPEG/BYTECUT_FFPROBE";
    case "config":
      return "config";
    case "ffmpeg-dir":
      return "ffmpeg's directory";
    case "path":
      return "PATH";
    default:
      return "not found";
  }
}

export function describeSource(source: BinarySource | null): string {
  return sourceLabel(source);
}

function binaryLine(label: string, report: BinaryReport): string {
  const { resolved } = report;
  if (!resolved.found) {
    return resolved.attempted
      ? `${label}: not found at ${resolved.attempted} (${sourceLabel(resolved.source)})`
      : `${label}: not found`;
  }
  const detail = report.error ? `failed to run: ${report.error}` : `version ${report.version}`;
  return `${label}: ${resolved.path} (${sourceLabel(resolved.source)}), ${detail}`;
}

const yesNo = (value: boolean) => (value ? "yes" : "no");

export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = ["bytecut doctor", ""];
  lines.push(
    `Node:    ${report.node.version}${report.node.supported ? "" : ` (needs >= ${MIN_NODE_MAJOR})`}`,
  );
  lines.push(
    report.sharp.available
      ? `sharp:   ${report.sharp.version} (libvips ${report.sharp.libvips})`
      : `sharp:   unavailable (${report.sharp.error})`,
  );
  lines.push(binaryLine("ffmpeg ", report.ffmpeg));
  lines.push(binaryLine("ffprobe", report.ffprobe));

  if (report.ffmpeg.info) {
    lines.push("", "Encoders:");
    lines.push(`  AV1:     ${report.encoders.av1 ?? "none"}`);
    lines.push(`  H.264:   ${yesNo(report.encoders.h264)} (libx264)`);
    lines.push(`  VP9:     ${yesNo(report.encoders.vp9)} (libvpx-vp9)`);
    lines.push(`  libvmaf: ${yesNo(report.encoders.vmaf)}`);
  }

  if (report.project) {
    const p = report.project;
    lines.push("", `Project: ${p.framework} → ${p.outDir}`);
    lines.push(`Config:  ${p.configFile ?? "none (zero-config)"}`);
    if (p.configError) lines.push(`  problem: ${p.configError}`);
    if (p.outDirIgnored) {
      lines.push(
        `  note: ${p.outDir} is matched by a .gitignore. bytecut's outputs are meant to be committed, so deploys need no encoding step. Nothing was changed.`,
      );
    }
  }

  lines.push("");
  if (report.degradations.length === 0) {
    lines.push("Everything is available. No degradation.");
  } else {
    lines.push("Degraded:");
    for (const item of report.degradations) lines.push(`  - ${item}`);
  }
  return lines.join("\n");
}
