import { sep } from "node:path";

/** Plans and manifests store POSIX-style relative paths (§7); convert only at the fs boundary. */
export function toPosix(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}
