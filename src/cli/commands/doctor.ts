import { defineCommand } from "citty";
import { resolve } from "node:path";
import { loadConfig } from "../../core/config/load.js";
import { resolveConfig } from "../../core/config/resolve.js";
import { collectDoctorReport, formatDoctorReport } from "../../core/doctor/report.js";
import { BytecutError } from "../../core/errors.js";
import { detectProject } from "../../core/scan/detect.js";
import { isGitIgnored } from "../../core/scan/gitignore.js";
import { guarded } from "../errors.js";
import { doctorDeps } from "../system.js";

export default defineCommand({
  meta: {
    name: "doctor",
    description: "Check Node, sharp and ffmpeg, and report what is degraded",
  },
  args: {
    config: {
      type: "string",
      description: "Path to a config file (default: bytecut.config.* in the project)",
    },
    ffmpeg: { type: "string", description: "Path to the ffmpeg binary" },
    ffprobe: { type: "string", description: "Path to the ffprobe binary" },
    json: { type: "boolean", description: "Print the report as JSON" },
  },
  run: guarded(async ({ args }) => {
    // A broken config is something to report here, not a reason to refuse to diagnose.
    const projectRoot = process.cwd();
    let configError: string | undefined;
    let resolved = await resolveConfig(projectRoot, null);
    try {
      resolved = await resolveConfig(projectRoot, await loadConfig(projectRoot, args.config));
    } catch (error) {
      if (!(error instanceof BytecutError)) throw error;
      configError = error.message;
      resolved = { ...resolved, project: await detectProject(projectRoot) };
    }
    const report = await collectDoctorReport(doctorDeps(), {
      ffmpegFlag: args.ffmpeg,
      ffprobeFlag: args.ffprobe,
      ffmpegConfig: resolved.ffmpegPath,
      ffprobeConfig: resolved.ffprobePath,
    });
    report.project = {
      framework: resolved.project.framework,
      configFile: resolved.loaded?.name ?? null,
      ...(configError ? { configError } : {}),
      outDir: resolved.project.outDir,
      outDirIgnored: await isGitIgnored(projectRoot, resolve(projectRoot, resolved.project.outDir)),
    };

    console.log(args.json ? JSON.stringify(report, null, 2) : formatDoctorReport(report));
    if (!report.ok) process.exitCode = 1;
  }),
});
