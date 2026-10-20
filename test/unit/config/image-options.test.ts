import { describe, expect, it } from "vitest";
import { applyChoices } from "../../../src/core/config/choices.js";
import {
  applyImageOptions,
  changedPresets,
  currentImageOptions,
  IMAGE_OPTION_DEFAULTS,
  parseMaxEdge,
  parseMaxSize,
  sizeForConfig,
  type ImageOptions,
} from "../../../src/core/config/image-options.js";
import { buildCatalog } from "../../../src/core/config/presets.js";
import { parseConfig } from "../../../src/core/config/schema.js";

/** The catalog a config with these presets resolves to, validated as a file would be. */
const catalogOf = (presets: Record<string, unknown> | undefined) =>
  buildCatalog(parseConfig(presets ? { presets } : {}, "test").presets);

const opts = (over: Partial<ImageOptions>): ImageOptions => ({ ...IMAGE_OPTION_DEFAULTS, ...over });

/** Applies options to a raw config's presets and resolves the result. */
function resolveWith(raw: Record<string, unknown> | undefined, options: ImageOptions) {
  const next = applyImageOptions(raw, catalogOf(raw), options);
  return { next, catalog: catalogOf(Object.keys(next).length > 0 ? next : undefined) };
}

describe("currentImageOptions", () => {
  it("reads the built-in defaults: one JPEG, longest side 1920, no cap", () => {
    expect(currentImageOptions(catalogOf(undefined))).toEqual(IMAGE_OPTION_DEFAULTS);
  });

  it("reads what the config already says about photo", () => {
    const catalog = catalogOf({
      photo: { formats: ["webp", "jpg"], ssimulacra2: 75, floor: 60, maxSize: "200 KB" },
    });
    expect(currentImageOptions(catalog)).toEqual({
      formats: ["jpg", "webp"],
      maxEdge: 1920,
      maxSize: 200 * 1024,
    });
  });

  it("reads a widths list as its widest width", () => {
    expect(currentImageOptions(catalogOf({ photo: { widths: [640, 1280] } })).maxEdge).toBe(1280);
  });
});

describe("applyImageOptions", () => {
  it("writes nothing when the options are what the presets already do", () => {
    expect(applyImageOptions(undefined, catalogOf(undefined), IMAGE_OPTION_DEFAULTS)).toEqual({});
  });

  it("writes only the fields that change, on photo and hero, and leaves icon alone", () => {
    const { next, catalog } = resolveWith(undefined, opts({ formats: ["webp", "avif"] }));
    expect(next).toEqual({
      photo: { formats: ["webp", "avif"] },
      hero: { formats: ["webp", "avif"] },
    });
    expect(catalog.image.photo!.formats).toEqual(["webp", "avif"]);
    expect(catalog.image.hero!.formats).toEqual(["webp", "avif"]);
    expect(catalog.image.icon!.formats).toEqual(["png"]);
    // Changing a built-in in place keeps its quality and priority.
    expect(catalog.image.hero!.priority).toBe(true);
    expect(catalog.image.hero!.encoders.webp.quality).toBe(82);
  });

  it("sets the max edge, replacing a widths list", () => {
    const { next, catalog } = resolveWith(
      { photo: { widths: [640, 1280] } },
      opts({ maxEdge: 2560 }),
    );
    expect(next.photo).toEqual({ maxEdge: 2560 });
    expect(catalog.image.photo!.maxEdge).toBe(2560);
    expect(catalog.image.photo!.widths).toEqual([]);
  });

  it("a size cap turns on the search with target 80 and floor 65", () => {
    const { next, catalog } = resolveWith(undefined, opts({ maxSize: 150 * 1024 }));
    expect(next.photo).toEqual({ ssimulacra2: 80, floor: 65, maxSize: "150 KB" });
    expect(catalog.image.photo!.search).toEqual({
      metric: "ssimulacra2",
      target: 80,
      floor: 65,
      maxBytes: 150 * 1024,
    });
    expect(catalog.image.icon!.search).toBeUndefined();
  });

  it("keeps the config's own target and floor when adding or changing a cap", () => {
    const raw = { photo: { ssimulacra2: 60 } };
    const { next } = resolveWith(raw, opts({ maxSize: 300 * 1024 }));
    // The floor may not exceed the target.
    expect(next.photo).toEqual({ ssimulacra2: 60, floor: 60, maxSize: "300 KB" });

    const capped = { photo: { ssimulacra2: 85, floor: 70, maxSize: "1 MB" } };
    expect(resolveWith(capped, opts({ maxSize: 500 * 1024 })).next.photo).toEqual({
      ssimulacra2: 85,
      floor: 70,
      maxSize: "500 KB",
    });
  });

  it("No cap removes the cap but keeps a target the config set", () => {
    const raw = { photo: { ssimulacra2: 85, floor: 70, maxSize: "1 MB" } };
    const { next, catalog } = resolveWith(raw, opts({ maxSize: null }));
    expect(next.photo).toEqual({ ssimulacra2: 85 });
    expect(catalog.image.photo!.search).toEqual({ metric: "ssimulacra2", target: 85 });
  });

  it("keeps a PNG the config asked for alongside the chosen formats", () => {
    const raw = { photo: { formats: ["jpg", "png"] } };
    expect(resolveWith(raw, opts({ formats: ["avif"] })).next.photo).toEqual({
      formats: ["avif", "png"],
    });
  });

  it("a config preset built on photo inherits, unless it sets the field itself", () => {
    const raw = {
      thumbs: { extends: "photo", quality: { jpg: 70 } },
      banner: { extends: "hero", formats: ["jpg"], maxEdge: 3000 },
      logos: { extends: "icon" },
    };
    const { next, catalog } = resolveWith(raw, opts({ formats: ["webp"], maxEdge: 1280 }));
    expect(next.thumbs).toEqual({ extends: "photo", quality: { jpg: 70 } });
    expect(next.banner).toEqual({ extends: "hero", formats: ["webp"], maxEdge: 1280 });
    expect(next.logos).toEqual({ extends: "icon" });
    for (const name of ["photo", "hero", "thumbs", "banner"]) {
      expect(catalog.image[name]!.formats).toEqual(["webp"]);
      expect(catalog.image[name]!.maxEdge).toBe(1280);
    }
    expect(catalog.image.logos!.formats).toEqual(["png"]);
  });

  it("does not mutate the config it is given", () => {
    const raw = { photo: { widths: [640] } };
    const copy = structuredClone(raw);
    applyImageOptions(raw, catalogOf(raw), opts({ maxEdge: 2560 }));
    expect(raw).toEqual(copy);
  });

  it("refuses an empty format list", () => {
    expect(() => applyImageOptions(undefined, catalogOf(undefined), opts({ formats: [] }))).toThrow(
      /at least one/,
    );
  });
});

describe("saving the options", () => {
  it("changedPresets keeps only what differs from the file, and a save round-trips", () => {
    const raw = { photo: { quality: { jpg: 75 } }, thumbs: { extends: "photo" } };
    const options = opts({ formats: ["jpg", "avif"], maxEdge: 1280, maxSize: 300 * 1024 });
    const next = applyImageOptions(raw, catalogOf(raw), options);
    const changed = changedPresets(raw, next);
    expect(Object.keys(changed).sort()).toEqual(["hero", "photo"]);

    const written = applyChoices(
      { outDir: "x", presets: raw },
      { presetSettings: changed as never },
    );
    expect(written.outDir).toBe("x");
    expect((written.presets as Record<string, unknown>).thumbs).toEqual({ extends: "photo" });
    expect((written.presets as Record<string, unknown>).photo).toEqual({
      quality: { jpg: 75 },
      formats: ["jpg", "avif"],
      maxEdge: 1280,
      ssimulacra2: 80,
      floor: 65,
      maxSize: "300 KB",
    });
    // The file now resolves to the same presets the session ran with.
    const reread = buildCatalog(parseConfig(JSON.parse(JSON.stringify(written)), "test").presets);
    expect(reread.image).toEqual(catalogOf(next).image);
    expect(currentImageOptions(reread)).toEqual(options);
    // ...and applying the same options again changes nothing.
    expect(
      changedPresets(written.presets, applyImageOptions(written.presets, reread, options)),
    ).toEqual({});
  });
});

describe("custom values", () => {
  it("parses a max edge in pixels within the schema's bounds", () => {
    expect(parseMaxEdge("2000")).toBe(2000);
    expect(parseMaxEdge(" 1600 px ")).toBe(1600);
    expect(parseMaxEdge("8")).toMatch(/16 to 16384/);
    expect(parseMaxEdge("12.5")).toMatch(/whole number/);
    expect(parseMaxEdge("big")).toMatch(/whole number/);
  });

  it("parses a max size like the config does", () => {
    expect(parseMaxSize("250 KB")).toBe(250 * 1024);
    expect(parseMaxSize("1.5mb")).toBe(Math.round(1.5 * 1024 * 1024));
    expect(parseMaxSize("12")).toMatch(/at least 1 KB/);
    expect(parseMaxSize("lots")).toMatch(/not a size/);
  });

  it("writes sizes readably and losslessly", () => {
    expect(sizeForConfig(150 * 1024)).toBe("150 KB");
    expect(sizeForConfig(1024 * 1024)).toBe("1 MB");
    expect(sizeForConfig(1500)).toBe(1500);
  });
});
