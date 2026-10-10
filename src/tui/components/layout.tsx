import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { formatBytes, plural } from "../../core/units.js";
import type { Model } from "../model.js";
import { selectionTotals } from "../model.js";
import type { State } from "../state.js";

export function Header(props: { framework: string; scanning: string; outDir: string }): ReactNode {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        <Text bold color="cyan">
          bytecut
        </Text>
        <Text dimColor> · </Text>
        <Text>{props.framework}</Text>
        <Text dimColor> · scanning </Text>
        <Text>{props.scanning}</Text>
        <Text dimColor> → </Text>
        <Text>{props.outDir}</Text>
      </Text>
    </Box>
  );
}

const HINTS: Record<string, string> = {
  list: "↑↓ move · space select · p preset · d details · o out dir · enter review · / cmds · ? help",
  review: "enter run · esc back",
  running: "esc cancel",
  done: "enter/esc back to list · q quit",
  scanning: "q quit",
  error: "q quit",
};

export function StatusLine(props: { state: State; model: Model }): ReactNode {
  const { state, model } = props;
  let left = "";
  if (state.view === "list") {
    const t = selectionTotals(model.rows, state.selected);
    left = `${t.count} of ${plural(model.rows.length, "file")} selected`;
    if (t.savings > 0) left += ` · est. save ~${formatBytes(t.savings)}`;
    if (model.covered > 0) left += ` · ${model.covered} already optimized`;
  }
  return (
    <Box flexDirection="column" marginTop={1}>
      {state.status ? <Text color="yellow">{state.status}</Text> : null}
      {left ? <Text>{left}</Text> : null}
      <Text dimColor>{HINTS[state.view]}</Text>
    </Box>
  );
}

export function Help(): ReactNode {
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>Keys</Text>
      <Text>↑/↓ or k/j move · space toggle · a select all/none</Text>
      <Text>enter review the plan, then run it · esc go back / cancel a run</Text>
      <Text>p cycle preset for the highlighted file · o change output folder</Text>
      <Text>d details · / command bar · @ jump to a file · ? this help · q quit</Text>
      <Text bold>Commands</Text>
      <Text>
        /audit /optimize [@file…] /preset {"<name>"} [@file…] /out {"<dir>"}
      </Text>
      <Text>/select all|none|warn /doctor /help /quit</Text>
      <Text dimColor>esc closes this</Text>
    </Box>
  );
}
