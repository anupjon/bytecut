import { createHash } from "node:crypto";

export function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}
