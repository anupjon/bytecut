import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

export function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Streaming hash for files too large to hold in memory (videos). Read-only. */
export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}
