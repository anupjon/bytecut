export type BytecutErrorCode =
  | "FFMPEG_NOT_FOUND"
  | "FFMPEG_PROBE_FAILED"
  | "UNSUPPORTED_NODE"
  | "SHARP_UNAVAILABLE"
  | "UNSAFE_OUT_DIR"
  | "UNSAFE_PATH"
  | "INPUT_NOT_FOUND"
  | "SOURCE_OUTSIDE_PROJECT"
  | "OUTPUT_COLLISION"
  | "PLAN_INVALID"
  | "MANIFEST_INVALID"
  | "MANIFEST_UNSUPPORTED"
  | "MANIFEST_OUTDATED"
  | "CONFIG_INVALID"
  | "CONFIG_EXISTS"
  | "GIT_UNAVAILABLE"
  | "BAD_ARGUMENTS";

/** Expected, user-facing failure. The CLI layer prints `message` without a stack trace. */
export class BytecutError extends Error {
  readonly code: BytecutErrorCode;

  constructor(code: BytecutErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BytecutError";
    this.code = code;
  }
}
