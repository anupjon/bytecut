import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { defineCommand } from "citty";
import { guarded } from "../errors.js";
import { isFile, readOsReleaseId } from "../system.js";
import { BytecutError } from "../../core/errors.js";
import { collectDoctorReport, formatDoctorReport } from "../../core/doctor/report.js";
import type { Run } from "../../core/ffmpeg/index.js";

const execFileAsync = promisify(execFile);

// Argument array, never a shell string (§6.14).
const run: Run = async (file, args) => {
  const { stdout } = await execFileAsync(file, args, { maxBuffer: 16 * 1024 * 1024 });
  return { stdout };
};

export default defineCommand({
  meta: {
    name: "doctor",
    description: "Check Node, sharp and ffmpeg, and report what is degraded",
  },
  args: {
    ffmpeg: { type: "string", description: "Path to the ffmpeg binary" },
    ffprobe: { type: "string", description: "Path to the ffprobe binary" },
    json: { type: "boolean", description: "Print the report as JSON" },
  },
  run: guarded(async ({ args }) => {
    const report = await collectDoctorReport(
      {
        nodeVersion: process.version,
        platform: process.platform,
        env: process.env,
        osReleaseId: readOsReleaseId(),
        isFile,
        run,
        async loadSharp() {
          try {
            const sharp = (await import("sharp")).default;
            return { version: sharp.versions.sharp ?? "unknown", libvips: sharp.versions.vips };
          } catch (error) {
            throw new BytecutError(
              "SHARP_UNAVAILABLE",
              error instanceof Error ? error.message.split("\n")[0]! : String(error),
              { cause: error },
            );
          }
        },
      },
      { ffmpegFlag: args.ffmpeg, ffprobeFlag: args.ffprobe },
    );

    console.log(args.json ? JSON.stringify(report, null, 2) : formatDoctorReport(report));
    if (!report.ok) process.exitCode = 1;
  }),
});
