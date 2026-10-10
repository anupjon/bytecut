export type PlaceholderKind = "dominant-color" | "lqip" | "blurhash";

export const PLACEHOLDER_KINDS: readonly PlaceholderKind[] = ["dominant-color", "lqip", "blurhash"];

export interface Placeholder {
  kind: PlaceholderKind;
  /**
   * `dominant-color`: `#rrggbb`. `lqip`: a `data:image/webp;base64,…` URI. `blurhash`: the hash
   * string (rendering it needs a decoder on the page; snippets only carry it as data).
   */
  value: string;
}

export function isPlaceholderKind(value: string): value is PlaceholderKind {
  return (PLACEHOLDER_KINDS as readonly string[]).includes(value);
}
