import { describe, expect, it } from "vitest";
import { cmykOr16bit } from "../../../src/core/audit/rules/cmyk-or-16bit.js";
import { heavy } from "../../../src/core/audit/rules/heavy.js";
import { metadata } from "../../../src/core/audit/rules/metadata.js";
import { noModernFormat } from "../../../src/core/audit/rules/no-modern-format.js";
import { noResponsiveSet } from "../../../src/core/audit/rules/no-responsive-set.js";
import { oversizedDimensions } from "../../../src/core/audit/rules/oversized-dimensions.js";
import { photoAsPng } from "../../../src/core/audit/rules/photo-as-png.js";
import { reencodeSavings } from "../../../src/core/audit/rules/reencode-savings.js";
import { context, estimate, image } from "../../audit-helpers.js";

const covered = { cache: { kind: "hit" } as const };

describe("rule metadata (§5)", () => {
  it.each([
    [noModernFormat, "image/no-modern-format", "warn"],
    [oversizedDimensions, "image/oversized-dimensions", "warn"],
    [heavy, "image/heavy", "warn"],
    [photoAsPng, "image/photo-as-png", "warn"],
    [reencodeSavings, "image/reencode-savings", "info"],
    [metadata, "image/metadata", "info"],
    [noResponsiveSet, "image/no-responsive-set", "info"],
    [cmykOr16bit, "image/cmyk-or-16bit", "warn"],
  ] as const)("%s", (rule, id, severity) => {
    expect(rule).toMatchObject({ id, category: "image", defaultSeverity: severity, fix: null });
  });
});

describe("image/no-modern-format", () => {
  it("flags a legacy source and reports the estimated saving", async () => {
    const f = await noModernFormat.check(context({ images: [image({ bytes: 100_000 })] }));
    expect(f).toEqual([
      expect.objectContaining({
        ruleId: "image/no-modern-format",
        severity: "warn",
        source: "img/a.jpg",
        current: 100_000,
        estimated: 10_000,
        savingsBytes: 90_000,
      }),
    ]);
  });

  it.each(["jpeg", "png", "gif"] as const)("applies to %s", async (format) => {
    const f = await noModernFormat.check(context({ images: [image({ analysis: { format } })] }));
    expect(f).toHaveLength(1);
  });

  it("ignores sources that are already modern formats", async () => {
    for (const format of ["webp", "avif"] as const) {
      expect(
        await noModernFormat.check(context({ images: [image({ analysis: { format } })] })),
      ).toEqual([]);
    }
  });

  it("ignores images whose outputs are already up to date", async () => {
    expect(await noModernFormat.check(context({ images: [image(covered)] }))).toEqual([]);
  });

  it("stays quiet when optimizing would not help (§6.7)", async () => {
    const same = image({ bytes: 2_000, estimate: estimate(1_900) });
    expect(await noModernFormat.check(context({ images: [same] }))).toEqual([]);
    const larger = image({ bytes: 2_000, estimate: estimate(5_000) });
    expect(await noModernFormat.check(context({ images: [larger] }))).toEqual([]);
  });

  it("honours minSavingsBytes", async () => {
    const small = image({ bytes: 5_000, estimate: estimate(3_500) });
    expect(await noModernFormat.check(context({ images: [small] }))).toHaveLength(1);
    const strict = context({
      images: [small],
      opts: { "image/no-modern-format": { minSavingsBytes: 4_000 } },
    });
    expect(await noModernFormat.check(strict)).toEqual([]);
  });
});

describe("image/oversized-dimensions", () => {
  it("flags the longer edge beyond the limit and names the cap", async () => {
    const wide = image({ analysis: { width: 3000, height: 1000 } });
    const f = await oversizedDimensions.check(context({ images: [wide] }));
    expect(f).toHaveLength(1);
    expect(f[0]!.message).toBe("3000x1000 exceeds 2560px; outputs are capped at 1920w");
    const tall = image({ analysis: { width: 1000, height: 3000 } });
    expect(await oversizedDimensions.check(context({ images: [tall] }))).toHaveLength(1);
  });

  it("does not flag at the limit, nor covered images", async () => {
    const at = image({ analysis: { width: 2560, height: 1000 } });
    expect(await oversizedDimensions.check(context({ images: [at] }))).toEqual([]);
    const done = image({ ...covered, analysis: { width: 5000, height: 1000 } });
    expect(await oversizedDimensions.check(context({ images: [done] }))).toEqual([]);
  });

  it("honours maxDimension", async () => {
    const ctx = context({
      images: [image({ analysis: { width: 1500, height: 900 } })],
      opts: { "image/oversized-dimensions": { maxDimension: 1200 } },
    });
    expect(await oversizedDimensions.check(ctx)).toHaveLength(1);
  });
});

describe("image/heavy", () => {
  it("flags sources over the byte limit", async () => {
    const f = await heavy.check(
      context({ images: [image({ bytes: 600_000 }), image({ source: "b.jpg", bytes: 400_000 })] }),
    );
    expect(f.map((x) => x.source)).toEqual(["img/a.jpg"]);
    expect(f[0]).toMatchObject({ current: 600_000, savingsBytes: 540_000 });
  });

  it("is exclusive at the limit, honours maxBytes, and skips covered images", async () => {
    expect(await heavy.check(context({ images: [image({ bytes: 500_000 })] }))).toEqual([]);
    const tight = context({
      images: [image({ bytes: 60_000 })],
      opts: { "image/heavy": { maxBytes: 50_000 } },
    });
    expect(await heavy.check(tight)).toHaveLength(1);
    expect(await heavy.check(context({ images: [image({ ...covered, bytes: 900_000 })] }))).toEqual(
      [],
    );
  });
});

describe("image/photo-as-png", () => {
  const png = { format: "png" as const, colorCount: 800 };

  it("flags continuous-tone PNGs without transparency", async () => {
    const f = await photoAsPng.check(context({ images: [image({ analysis: png })] }));
    expect(f).toHaveLength(1);
    expect(f[0]!.message).toMatch(/800 colours/);
  });

  it("leaves flat art, transparent images, JPEGs and few-colour PNGs alone", async () => {
    const cases = [
      image({ analysis: png, classification: { preset: "icon", confidence: "high", reason: "" } }),
      image({ analysis: { ...png, alphaUsed: true, hasAlpha: true } }),
      image({ analysis: { format: "jpeg", colorCount: 800 } }),
      image({ analysis: { ...png, colorCount: 100 } }),
      image({ ...covered, analysis: png }),
    ];
    for (const c of cases) expect(await photoAsPng.check(context({ images: [c] }))).toEqual([]);
  });

  it("honours minColors", async () => {
    const ctx = context({
      images: [image({ analysis: { ...png, colorCount: 100 } })],
      opts: { "image/photo-as-png": { minColors: 50 } },
    });
    expect(await photoAsPng.check(ctx)).toHaveLength(1);
  });
});

describe("image/reencode-savings", () => {
  const webp = { format: "webp" as const };

  it("flags a modern-format source that re-encodes much smaller", async () => {
    const f = await reencodeSavings.check(
      context({ images: [image({ bytes: 100_000, analysis: webp })] }),
    );
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ severity: "info", savingsBytes: 90_000 });
  });

  it("requires both the percentage and the byte threshold", async () => {
    const smallPercent = image({ bytes: 100_000, analysis: webp, estimate: estimate(80_000) });
    expect(await reencodeSavings.check(context({ images: [smallPercent] }))).toEqual([]);
    const tinyBytes = image({ bytes: 4_000, analysis: webp, estimate: estimate(1_000) });
    expect(await reencodeSavings.check(context({ images: [tinyBytes] }))).toEqual([]);
  });

  it("does not apply to legacy formats or covered images, and honours its options", async () => {
    expect(await reencodeSavings.check(context({ images: [image()] }))).toEqual([]);
    expect(
      await reencodeSavings.check(context({ images: [image({ ...covered, analysis: webp })] })),
    ).toEqual([]);
    const ctx = context({
      images: [image({ bytes: 100_000, analysis: webp, estimate: estimate(80_000) })],
      opts: { "image/reencode-savings": { minPercent: 10 } },
    });
    expect(await reencodeSavings.check(ctx)).toHaveLength(1);
  });
});

describe("image/metadata", () => {
  const meta = (
    m: Partial<{ exif: number; xmp: number; iptc: number; icc: number; gps: boolean }>,
  ) => ({
    metadata: { exif: 0, xmp: 0, iptc: 0, icc: 0, gps: false, ...m },
  });

  it("flags embedded metadata at or above the threshold, counting EXIF+XMP+IPTC", async () => {
    const f = await metadata.check(
      context({ images: [image({ analysis: meta({ exif: 600, xmp: 300, iptc: 200 }) })] }),
    );
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ savingsBytes: 1100, severity: "info" });
  });

  it("always mentions GPS, even for tiny metadata", async () => {
    const f = await metadata.check(
      context({ images: [image({ analysis: meta({ exif: 40, gps: true }) })] }),
    );
    expect(f).toHaveLength(1);
    expect(f[0]!.message).toMatch(/GPS/);
  });

  it("ignores small metadata, the ICC profile, and covered images", async () => {
    expect(
      await metadata.check(context({ images: [image({ analysis: meta({ exif: 100 }) })] })),
    ).toEqual([]);
    expect(
      await metadata.check(context({ images: [image({ analysis: meta({ icc: 50_000 }) })] })),
    ).toEqual([]);
    expect(
      await metadata.check(
        context({ images: [image({ ...covered, analysis: meta({ exif: 9_999 }) })] }),
      ),
    ).toEqual([]);
  });
});

describe("image/no-responsive-set", () => {
  it("flags wide images that would get a set of widths", async () => {
    const f = await noResponsiveSet.check(
      context({ images: [image({ analysis: { width: 2400 } })] }),
    );
    expect(f).toHaveLength(1);
    expect(f[0]!.message).toMatch(/2400px wide.*3 widths/);
  });

  it("ignores narrow images, single-width plans and covered images", async () => {
    expect(
      await noResponsiveSet.check(context({ images: [image({ analysis: { width: 800 } })] })),
    ).toEqual([]);
    const single = image({ analysis: { width: 1500 } });
    single.item = { ...single.item, outputs: single.item.outputs.slice(0, 1) };
    expect(await noResponsiveSet.check(context({ images: [single] }))).toEqual([]);
    expect(
      await noResponsiveSet.check(
        context({ images: [image({ ...covered, analysis: { width: 2400 } })] }),
      ),
    ).toEqual([]);
  });

  it("honours minWidth", async () => {
    const ctx = context({
      images: [image({ analysis: { width: 1200 } })],
      opts: { "image/no-responsive-set": { minWidth: 1500 } },
    });
    expect(await noResponsiveSet.check(ctx)).toEqual([]);
  });
});

describe("image/cmyk-or-16bit", () => {
  it("flags CMYK and 16-bit sources with distinct messages", async () => {
    const f = await cmykOr16bit.check(
      context({
        images: [
          image({ source: "a.jpg", analysis: { space: "cmyk" } }),
          image({ source: "b.png", analysis: { depth: "ushort", format: "png" } }),
        ],
      }),
    );
    expect(f.map((x) => x.source)).toEqual(["a.jpg", "b.png"]);
    expect(f[0]!.message).toMatch(/CMYK/);
    expect(f[1]!.message).toMatch(/16-bit/);
  });

  it("ignores ordinary sRGB 8-bit images and covered ones", async () => {
    expect(await cmykOr16bit.check(context({ images: [image()] }))).toEqual([]);
    expect(
      await cmykOr16bit.check(
        context({ images: [image({ ...covered, analysis: { space: "cmyk" } })] }),
      ),
    ).toEqual([]);
  });
});
