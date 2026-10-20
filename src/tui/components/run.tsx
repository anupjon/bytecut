import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { formatSummary } from "../../cli/format.js";
import { formatBytes, plural } from "../../core/units.js";
import type { OutputResult, VideoOutputResult } from "../../core/execute/run.js";
import type { Review, SnippetView, State, SaveView } from "../state.js";

const BAR_WIDTH = 30;

function bar(done: number, total: number): string {
  const filled = total === 0 ? 0 : Math.round((done / total) * BAR_WIDTH);
  return "█".repeat(filled) + "░".repeat(BAR_WIDTH - filled);
}

const STATUS_COLOR: Record<(OutputResult | VideoOutputResult)["status"], string> = {
  written: "green",
  unchanged: "gray",
  "already-optimal": "gray",
  protected: "yellow",
  unavailable: "yellow",
  failed: "red",
  unmet: "red",
  cancelled: "yellow",
};

export function ReviewView(props: { review: Review; outDir: string }): ReactNode {
  const { review } = props;
  const LIMIT = 12;
  const shown = review.items.slice(0, LIMIT);
  return (
    <Box flexDirection="column">
      <Text bold>
        Review: {plural(review.willEncode, "image")} → {plural(review.outputs, "output")} in{" "}
        {props.outDir}
      </Text>
      {review.unchanged > 0 ? (
        <Text dimColor>{review.unchanged} already up to date (will be skipped)</Text>
      ) : null}
      <Box flexDirection="column" marginTop={1}>
        {shown.map((item) => (
          <Box key={item.source}>
            <Box flexGrow={1} flexShrink={1}>
              <Text wrap="truncate-middle" dimColor={item.state !== "encode"}>
                {item.source}
              </Text>
            </Box>
            <Text dimColor>
              {" "}
              {item.state === "encode"
                ? `${item.preset} · ${plural(item.outputs, "output")}`
                : item.state === "unchanged"
                  ? "unchanged"
                  : `skipped: ${item.note}`}
            </Text>
          </Box>
        ))}
        {review.items.length > LIMIT ? (
          <Text dimColor>… and {review.items.length - LIMIT} more</Text>
        ) : null}
      </Box>
      {review.findings.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="yellow">Heads up:</Text>
          {review.findings.slice(0, 4).map((f) => (
            <Text key={`${f.source}${f.path}${f.message}`} color="yellow" wrap="truncate-end">
              {"  "}
              {f.source}: {f.message}
            </Text>
          ))}
        </Box>
      ) : null}
      <Text bold color="cyan">
        enter to write these files · esc to go back
      </Text>
    </Box>
  );
}

export function RunView(props: { state: State }): ReactNode {
  const run = props.state.run;
  if (!run) return null;
  const tail = run.log.slice(-8);
  return (
    <Box flexDirection="column">
      <Text>
        {bar(run.done, run.total)} {run.done}/{run.total}
      </Text>
      {run.current ? (
        <Text dimColor wrap="truncate-middle">
          {props.state.cancelling ? "finishing " : "optimizing "}
          {run.current}
        </Text>
      ) : null}
      {props.state.cancelling ? (
        <Text color="yellow">
          Cancelling: finishing the current encode so no partial file is left behind…
        </Text>
      ) : null}
      {Object.entries(run.progress)
        .filter(([, f]) => f > 0 && f < 1)
        .slice(-2)
        .map(([path, f]) => (
          <Text key={path} dimColor wrap="truncate-end">
            {path} {Math.round(f * 100)}%
          </Text>
        ))}
      <Box flexDirection="column" marginTop={1}>
        {tail.map(({ source, output }, i) => (
          <Text
            key={`${source}${output.path}${i}`}
            color={STATUS_COLOR[output.status]}
            wrap="truncate-end"
          >
            {output.status === "written" ? "✓" : output.status === "failed" ? "✗" : "·"}{" "}
            {output.path} {output.bytes > 0 ? formatBytes(output.bytes) : ""} {output.status}
          </Text>
        ))}
      </Box>
    </Box>
  );
}

export function SnippetOverlay(props: { snippet: SnippetView }): ReactNode {
  const { snippet } = props;
  const lines = snippet.code.split("\n");
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold wrap="truncate-middle">
        {snippet.source}
      </Text>
      {lines.map((line, i) => (
        <Text key={i} wrap="truncate-end">
          {line}
        </Text>
      ))}
      <Box flexDirection="column" marginTop={1}>
        {snippet.copied ? (
          <Text color="green">Copied to the clipboard ({snippet.copied}).</Text>
        ) : (
          <Text color="yellow">
            Could not reach the clipboard: select the text above to copy it.
          </Text>
        )}
        {snippet.hints.map((h) => (
          <Text key={h} dimColor wrap="truncate-end">
            Note: {h}
          </Text>
        ))}
        <Text dimColor>c copy again · esc close</Text>
      </Box>
    </Box>
  );
}

/** `formats jpg, webp · maxEdge 1280 · maxSize 150 KB`: the image fields a save writes. */
function describeSettings(def: Record<string, unknown>): string {
  const parts: string[] = [];
  if (Array.isArray(def.formats)) parts.push(`formats ${def.formats.join(", ")}`);
  if (def.maxEdge !== undefined) parts.push(`maxEdge ${String(def.maxEdge)}`);
  if (def.maxSize !== undefined) parts.push(`maxSize ${String(def.maxSize)}`);
  else if (!("maxSize" in def) && def.ssimulacra2 === undefined) parts.push("no size cap");
  return parts.join(" · ");
}

export function SaveOverlay(props: { save: SaveView; outDir: string }): ReactNode {
  const { save } = props;
  const { choices, outcome } = save;
  const entries = Object.entries(choices.presets ?? {});
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>Save these choices to the project config?</Text>
      <Box flexDirection="column" marginTop={1}>
        {entries.slice(0, 10).map(([source, preset]) => (
          <Text key={source} wrap="truncate-middle">
            {source} → {preset}
          </Text>
        ))}
        {entries.length > 10 ? <Text dimColor>… and {entries.length - 10} more</Text> : null}
        {choices.outDir !== undefined ? <Text>output folder → {choices.outDir}</Text> : null}
        {Object.entries(choices.presetSettings ?? {}).map(([name, def]) => (
          <Text key={`preset:${name}`} wrap="truncate-end">
            preset {name} → {describeSettings(def)}
          </Text>
        ))}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {outcome === null ? (
          <Text dimColor>y save · n not now</Text>
        ) : outcome.kind === "written" ? (
          <Text color="green">
            {outcome.created ? "Created" : "Updated"} {outcome.file}. Later runs use it.
          </Text>
        ) : outcome.kind === "manual" ? (
          <>
            <Text color="yellow">
              {outcome.file} is a file you maintain, so it was not rewritten. Add:
            </Text>
            {outcome.snippet.split("\n").map((line, i) => (
              <Text key={i}>{line}</Text>
            ))}
          </>
        ) : outcome.kind === "error" ? (
          <Text color="red">{outcome.message}</Text>
        ) : (
          <Text dimColor>Nothing to save.</Text>
        )}
        {outcome !== null ? <Text dimColor>any key closes this</Text> : null}
      </Box>
    </Box>
  );
}

export function DoneView(props: { state: State }): ReactNode {
  const { result } = props.state;
  if (!result) return null;
  const summary = formatSummary(result).split("\n");
  // formatSummary ends with a blank line and then the totals; per-file lines come before it.
  const split = summary.lastIndexOf("");
  const totals = summary.slice(split + 1);
  const files = summary.slice(0, Math.max(0, split)).filter((l) => !l.startsWith("  "));
  return (
    <Box flexDirection="column">
      <Text bold color={result.cancelled ? "yellow" : "green"}>
        {result.cancelled ? "Cancelled" : "Done"}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {files.slice(0, 12).map((line, i) => (
          <Text
            key={i}
            wrap="truncate-end"
            color={i === props.state.doneCursor ? "cyan" : undefined}
          >
            {i === props.state.doneCursor ? "› " : "  "}
            {line}
          </Text>
        ))}
        {files.length > 12 ? <Text dimColor>… and {files.length - 12} more files</Text> : null}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {totals.map((line, i) => (
          <Text key={i}>{line}</Text>
        ))}
      </Box>
      {result.warnings.map((w) => (
        <Text key={w} color="yellow" wrap="truncate-end">
          warning: {w}
        </Text>
      ))}
    </Box>
  );
}
