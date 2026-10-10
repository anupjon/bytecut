import { describe, expect, it } from "vitest";
import { parsePlan, serializePlan } from "../../../src/core/plan/schema.js";
import type { Plan } from "../../../src/core/plan/types.js";

const plan: Plan = {
  version: 1,
  outDir: "public/_bytecut",
  publicPath: "/_bytecut",
  items: [
    {
      source: "assets/a.jpg",
      sourceBytes: 100,
      sourceSha256: "a".repeat(64),
      sourceWidth: 800,
      sourceHeight: 600,
      preset: "photo",
      outputs: [
        {
          path: "assets/a/a-640.avif",
          format: "avif",
          width: 640,
          lossless: false,
          quality: 60,
          effort: 4,
        },
      ],
    },
  ],
};

const clone = () => structuredClone(plan);

describe("plan schema", () => {
  it("round-trips through serialize and parse", () => {
    expect(parsePlan(serializePlan(plan))).toEqual(plan);
  });

  it("serializes with a trailing newline", () => {
    expect(serializePlan(plan).endsWith("}\n")).toBe(true);
  });

  it("allows an outDir outside the project (validated later by SafeFs)", () => {
    expect(() => parsePlan(JSON.stringify({ ...plan, outDir: "../shared/out" }))).not.toThrow();
  });

  const mutations: Array<[string, (p: Plan) => void]> = [
    ["a source with ..", (p) => (p.items[0]!.source = "../secret.jpg")],
    ["an absolute source", (p) => (p.items[0]!.source = "/etc/passwd")],
    ["a Windows drive source", (p) => (p.items[0]!.source = "C:/x.jpg")],
    ["a backslash source", (p) => (p.items[0]!.source = "a\\b.jpg")],
    ["an output with ..", (p) => (p.items[0]!.outputs[0]!.path = "../x.avif")],
    ["an absolute outDir", (p) => (p.outDir = "/tmp/out")],
    ["a bad hash", (p) => (p.items[0]!.sourceSha256 = "xyz")],
    ["a bad format", (p) => ((p.items[0]!.outputs[0] as { format: string }).format = "gif")],
    ["a wrong version", (p) => ((p as { version: number }).version = 2)],
    ["duplicate output paths", (p) => p.items.push({ ...p.items[0]!, source: "assets/b.jpg" })],
  ];

  it.each(mutations)("rejects %s", (_name, mutate) => {
    const bad = clone();
    mutate(bad);
    expect(() => parsePlan(JSON.stringify(bad))).toThrowError(/not a valid bytecut plan/);
  });

  it("rejects unknown fields and non-JSON", () => {
    expect(() => parsePlan(JSON.stringify({ ...plan, extra: true }))).toThrow();
    expect(() => parsePlan("not json", "my.json")).toThrowError(/my\.json is not valid JSON/);
  });
});
