import { render } from "ink";
import type { ImageEngine } from "../core/engines/types.js";
import type { SvgEngine } from "../core/engines/svg.js";
import type { VideoEngine } from "../core/video/types.js";
import type { ProjectInfo } from "../core/scan/detect.js";
import { App } from "./app.js";
import { createSession, type Session } from "./session.js";

export interface RunTuiOptions {
  projectRoot: string;
  project: ProjectInfo;
  inputs: string[];
  outDir: string;
  engine: ImageEngine;
  svgEngine: SvgEngine;
  toolVersion: string;
  ffmpeg: { found: boolean; installHint: string };
  videoEngine?: VideoEngine | null;
  needsFfmpeg?: string;
  loadDoctor: () => Promise<string>;
  /** Tests inject a session to avoid touching the file system through the core. */
  session?: Session;
}

/** Opens the interactive UI and resolves when the user quits. */
export async function runTui(options: RunTuiOptions): Promise<void> {
  const session =
    options.session ??
    createSession({
      projectRoot: options.projectRoot,
      engine: options.engine,
      svgEngine: options.svgEngine,
      project: options.project,
      inputs: options.inputs,
      toolVersion: options.toolVersion,
      ffmpeg: options.ffmpeg,
      videoEngine: options.videoEngine ?? null,
      ...(options.needsFfmpeg ? { needsFfmpeg: options.needsFfmpeg } : {}),
    });

  // Ctrl+C is handled by the app: it cancels a run first, and only quits when idle.
  const instance = render(
    <App
      session={session}
      project={options.project}
      projectRoot={options.projectRoot}
      inputs={options.inputs}
      outDir={options.outDir}
      loadDoctor={options.loadDoctor}
    />,
    { exitOnCtrlC: false },
  );
  await instance.waitUntilExit();
}
