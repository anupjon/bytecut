export type BinaryName = "ffmpeg" | "ffprobe";

/** Where a binary path came from, in resolution order (§4 "ffmpeg sourcing"). */
export type BinarySource = "flag" | "env" | "config" | "ffmpeg-dir" | "path";

export type ResolvedBinary =
  | { found: true; path: string; source: BinarySource }
  /** `source` is set when the user explicitly named a path that does not exist. */
  | { found: false; source: BinarySource | null; attempted?: string };

export interface Capabilities {
  libsvtav1: boolean;
  libaomAv1: boolean;
  libx264: boolean;
  libvpxVp9: boolean;
  libvmaf: boolean;
}

export interface BinaryInfo {
  path: string;
  version: string;
  capabilities: Capabilities;
}
