import type { AuditRule, ProjectContext } from "../types.js";
import { cmykOr16bit } from "./cmyk-or-16bit.js";
import { duplicate } from "./duplicate.js";
import { svgEmbeddedRaster } from "./embedded-raster.js";
import { gifAnimated } from "./gif-animated.js";
import { gifStatic } from "./gif-static.js";
import { heavy } from "./heavy.js";
import { metadata } from "./metadata.js";
import { noModernFormat } from "./no-modern-format.js";
import { noResponsiveSet } from "./no-responsive-set.js";
import { orphanedOutput } from "./orphaned-output.js";
import { overBudget } from "./over-budget.js";
import { oversizedDimensions } from "./oversized-dimensions.js";
import { photoAsPng } from "./photo-as-png.js";
import { reencodeSavings } from "./reencode-savings.js";
import { staleOutput } from "./stale-output.js";
import { svgUnminified } from "./unminified.js";
import { unreferenced } from "./unreferenced.js";

/** Rules that only need the plan and manifest; `optimize` runs these after every plan. */
export const PROJECT_RULES: AuditRule<ProjectContext>[] = [staleOutput, orphanedOutput];

/** Everything `bytecut audit` runs, in report order. */
export const ALL_RULES: AuditRule[] = [
  noModernFormat,
  oversizedDimensions,
  heavy,
  photoAsPng,
  reencodeSavings,
  metadata,
  noResponsiveSet,
  cmykOr16bit,
  svgUnminified,
  svgEmbeddedRaster,
  gifAnimated,
  gifStatic,
  duplicate,
  unreferenced,
  overBudget,
  staleOutput,
  orphanedOutput,
];
