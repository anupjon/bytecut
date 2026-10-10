import { defineCommand } from "citty";
import { collectDoctorReport, formatDoctorReport } from "../../core/doctor/report.js";
import { guarded } from "../errors.js";
import { doctorDeps } from "../system.js";

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
    const report = await collectDoctorReport(doctorDeps(), {
      ffmpegFlag: args.ffmpeg,
      ffprobeFlag: args.ffprobe,
    });

    console.log(args.json ? JSON.stringify(report, null, 2) : formatDoctorReport(report));
    if (!report.ok) process.exitCode = 1;
  }),
});
