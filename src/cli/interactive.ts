import pkg from "../../package.json" with { type: "json" };
import { audit } from "../core/commands/audit.js";
import { collectDoctorReport, formatDoctorReport } from "../core/doctor/report.js";
import { sharpImageEngine } from "../core/engines/image.js";
import { svgoEngine } from "../core/engines/svg.js";
import { formatAuditReport } from "./format.js";
import {
  createVideoEngine,
  discover,
  ffmpegInstallText,
  ffmpegStatus,
  noAssetsMessage,
} from "./shared.js";
import { doctorDeps } from "./system.js";

/** TTY on both ends and not CI: only then is an interactive UI appropriate. */
export function isInteractive(
  env: Record<string, string | undefined> = process.env,
  stdin: { isTTY?: boolean } = process.stdin,
  stdout: { isTTY?: boolean } = process.stdout,
): boolean {
  const ci = env.CI;
  const inCi = ci !== undefined && ci !== "" && ci !== "0" && ci.toLowerCase() !== "false";
  return Boolean(stdin.isTTY && stdout.isTTY) && !inCi;
}

/**
 * Plain `bytecut`: the interactive UI when there is a terminal, otherwise the audit report.
 * The headless fallback never prompts and never writes outputs (§6.13).
 */
export async function runDefault(): Promise<void> {
  const found = await discover([]);
  if (found.scanInputs.length === 0) {
    console.error(noAssetsMessage("", found.project));
    process.exitCode = 2;
    return;
  }

  if (isInteractive()) {
    // Loaded lazily so non-interactive commands never pay for React and Ink.
    const { runTui } = await import("../tui/index.js");
    await runTui({
      projectRoot: found.projectRoot,
      project: found.project,
      inputs: found.scanInputs,
      outDir: found.outDir,
      engine: sharpImageEngine,
      svgEngine: svgoEngine,
      toolVersion: pkg.version,
      ffmpeg: ffmpegStatus(),
      videoEngine: createVideoEngine(),
      needsFfmpeg: ffmpegInstallText(),
      loadDoctor: async () => formatDoctorReport(await collectDoctorReport(doctorDeps())),
    });
    return;
  }

  const report = await audit({
    projectRoot: found.projectRoot,
    engine: sharpImageEngine,
    svgEngine: svgoEngine,
    inputs: found.scanInputs,
    outDir: found.outDir,
    staticRoot: found.project.staticRoot,
    ffmpeg: ffmpegStatus(),
    videoEngine: createVideoEngine(),
    needsFfmpeg: ffmpegInstallText(),
    // A bare `npx bytecut` in CI should not create folders in the repo.
    persistCache: false,
  });
  console.log(formatAuditReport(report));
  console.log(
    "\nNot an interactive terminal. Run `bytecut optimize -y` to write the optimized files.",
  );
}
