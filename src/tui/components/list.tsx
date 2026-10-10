import { Box, Text } from "ink";
import type { ReactNode } from "react";
import type { Finding } from "../../core/audit/types.js";
import { formatBytes, percentChange } from "../../core/units.js";
import type { Model, Row } from "../model.js";
import { effectivePreset, type State } from "../state.js";

const SEVERITY_COLOR = { error: "red", warn: "yellow", info: "gray" } as const;

/** First visible index so the cursor stays inside a window of `height` rows. */
export function windowStart(cursor: number, total: number, height: number): number {
  if (total <= height) return 0;
  return Math.max(0, Math.min(cursor - Math.floor(height / 2), total - height));
}

const BADGE_WIDTH = 26;

/** First rule's short name, then how many more: bounded so a long list line never overflows. */
function badges(row: Row): string {
  const names = [...new Set(row.findings.map((f) => f.ruleId.split("/")[1] ?? f.ruleId))];
  const text = names.length > 1 ? `${names[0]} +${names.length - 1}` : (names[0] ?? "");
  return text.length > BADGE_WIDTH ? `${text.slice(0, BADGE_WIDTH - 1)}…` : text;
}

export function FileList(props: { state: State; height: number; width: number }): ReactNode {
  const { state, height, width } = props;
  const rows = state.model.rows;
  if (rows.length === 0) {
    return (
      <Text color="green">
        Nothing to optimize
        {state.model.covered > 0 ? ` (${state.model.covered} already optimized)` : ""}.
      </Text>
    );
  }
  const start = windowStart(state.cursor, rows.length, height);
  const visible = rows.slice(start, start + height);
  const sizeText = (row: Row) =>
    row.estimatedBytes !== null
      ? `${formatBytes(row.bytes)} → ~${formatBytes(row.estimatedBytes)} (${percentChange(row.bytes, row.estimatedBytes)})`
      : formatBytes(row.bytes);
  // Aligned columns: pad to the widest in the whole list so scrolling doesn't shift them.
  const sizeWidth = Math.max(...rows.map((r) => sizeText(r).length));
  const presetWidth = Math.max(...rows.map((r) => effectivePreset(state, r).length + 1));
  // Explicit widths instead of flexbox: a row that is even one column too wide gets wrapped by
  // the terminal and corrupts the layout. Leave the last column free.
  const fixed = 2 + 4 + 1 + sizeWidth + 1 + 1 + presetWidth + 1 + BADGE_WIDTH;
  const pathWidth = Math.max(12, width - 1 - fixed);

  return (
    <Box flexDirection="column">
      {start > 0 ? <Text dimColor> ↑ {start} more</Text> : null}
      {visible.map((row, i) => {
        const index = start + i;
        const here = index === state.cursor;
        const on = state.selected.has(row.source);
        const preset = effectivePreset(state, row);
        const overridden = state.presets[row.source] !== undefined;
        const size = sizeText(row).padStart(sizeWidth);
        const presetText = `${preset}${overridden ? "*" : ""}`.padEnd(presetWidth);
        return (
          <Box key={row.source}>
            <Text color={here ? "cyan" : undefined}>{here ? "›" : " "} </Text>
            <Text color={on ? "green" : "gray"}>{on ? "[x]" : "[ ]"} </Text>
            <Box width={pathWidth} flexShrink={0}>
              <Text bold={here} wrap="truncate-middle">
                {row.source}
              </Text>
            </Box>
            <Text dimColor> {size} </Text>
            <Text color={overridden ? "magenta" : "blue"}> {presetText}</Text>
            <Text color={SEVERITY_COLOR[row.severity]}> {badges(row)}</Text>
          </Box>
        );
      })}
      {start + height < rows.length ? (
        <Text dimColor> ↓ {rows.length - start - height} more</Text>
      ) : null}
    </Box>
  );
}

/** Findings optimize cannot fix: shown, never selectable. */
export function ReportOnly(props: { findings: Finding[]; skipped: Model["skipped"] }): ReactNode {
  const { findings, skipped } = props;
  if (findings.length === 0 && skipped.length === 0) return null;

  const byRule = new Map<string, number>();
  for (const f of findings) byRule.set(f.ruleId, (byRule.get(f.ruleId) ?? 0) + 1);

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text dimColor>Report only (optimize can't fix these yet):</Text>
      {[...byRule.entries()].map(([rule, count]) => (
        <Text key={rule} dimColor>
          {"  "}
          {rule} ×{count}
        </Text>
      ))}
      {skipped.map((s) => (
        <Text key={s.source} dimColor wrap="truncate-middle">
          {"  "}skipped {s.source}: {s.reason}
        </Text>
      ))}
    </Box>
  );
}

export function Details(props: { state: State; row: Row | undefined }): ReactNode {
  const { state, row } = props;
  if (!row) return null;
  const preset = effectivePreset(state, row);
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold wrap="truncate-middle">
        {row.source}
      </Text>
      <Text>
        {formatBytes(row.bytes)} · {row.width}x{row.height} · preset {preset}
        {state.presets[row.source] ? " (your override)" : ""}
      </Text>
      <Text dimColor>classified: {row.reason}</Text>
      {row.estimatedBytes !== null ? (
        <Text>
          estimate: ~{formatBytes(row.estimatedBytes)} at the largest width ({row.plannedOutputs}{" "}
          outputs planned)
        </Text>
      ) : null}
      <Text bold>Findings</Text>
      {row.findings.map((f) => (
        <Text key={`${f.ruleId}${f.message}`}>
          <Text color={SEVERITY_COLOR[f.severity]}>{f.severity.padEnd(5)}</Text> {f.ruleId}:{" "}
          {f.message}
        </Text>
      ))}
      <Text dimColor>esc closes this</Text>
    </Box>
  );
}
