import { describe, expect, it } from "vitest";
import { formatAuditReport, formatBytes, formatSummary } from "../../src/cli/format.js";
import type { AuditReport } from "../../src/core/commands/audit.js";

describe("formatBytes", () => {
  it("scales units", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.50 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.00 MB");
  });
});

describe("formatSummary", () => {
  it("totals only what was written and flags already-optimal outputs", () => {
    const text = formatSummary({
      cancelled: false,
      warnings: [],
      items: [
        {
          source: "a.jpg",
          sourceBytes: 1000,
          sourceSha256: "0".repeat(64),
          sourceWidth: 10,
          sourceHeight: 10,
          preset: "photo",
          status: "done",
          outputs: [
            {
              path: "a/640.avif",
              format: "avif",
              width: 640,
              height: 1,
              bytes: 250,
              status: "written",
              lossless: false,
              quality: 60,
              effort: 4,
            },
            {
              path: "a/640.webp",
              format: "webp",
              width: 640,
              height: 1,
              bytes: 1200,
              status: "already-optimal",
              lossless: false,
              quality: 78,
              effort: 4,
            },
          ],
        },
      ],
    });
    expect(text).toContain("-75%");
    expect(text).toContain("already optimal");
    expect(text).toContain("Total: 1 file written (250 B across all widths)");
    // The already-optimal webp is not served; the avif at the widest size is.
    expect(text).toContain("Largest size per image: 1000 B → 250 B (-75%)");
  });

  it("omits the size comparison when nothing was written", () => {
    const text = formatSummary({
      cancelled: false,
      warnings: [],
      items: [
        {
          source: "a.jpg",
          sourceBytes: 1000,
          sourceSha256: "0".repeat(64),
          sourceWidth: 10,
          sourceHeight: 10,
          preset: "photo",
          status: "cached",
          outputs: [],
        },
      ],
    });
    expect(text).toContain("Total: 0 files written, 1 image unchanged");
    expect(text).not.toContain("Largest size per image");
  });
});

describe("formatAuditReport: videos without ffmpeg", () => {
  const report = (unprobed: Array<{ source: string; bytes: number }>): AuditReport => ({
    findings: [],
    unprobed,
    files: [],
    counts: { images: 0, svgs: 0, videos: unprobed.length, skipped: 0 },
    totals: { sourceBytes: 5000, potentialSavingsBytes: 0, optimizedImages: 0 },
    notes: ["2 video files need ffmpeg to be analysed: install ffmpeg with: brew install ffmpeg"],
  });

  it("names each video that could not be analysed and what to install", () => {
    const text = formatAuditReport(
      report([
        { source: "public/a.mp4", bytes: 2048 },
        { source: "public/b.gif", bytes: 1024 },
      ]),
    );
    expect(text).toContain("Needs ffmpeg (not analysed):");
    expect(text).toContain("public/a.mp4  2.00 KB");
    expect(text).toContain("public/b.gif  1.00 KB");
    expect(text).toContain("install ffmpeg with: brew install ffmpeg");
  });

  it("omits the section when everything was analysed, and truncates long lists", () => {
    expect(formatAuditReport(report([]))).not.toContain("Needs ffmpeg");
    const many = Array.from({ length: 14 }, (_, i) => ({ source: `v${i}.mp4`, bytes: 10 }));
    expect(formatAuditReport(report(many))).toContain("… and 4 more");
  });
});
