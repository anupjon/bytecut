import { Box, Text } from "ink";
import type { ReactNode } from "react";
import {
  IMAGE_FORMAT_CHOICES,
  MAX_EDGE_CHOICES,
  MAX_SIZE_CHOICES,
  SEARCH_DEFAULTS,
  describeMaxSize,
} from "../../core/config/image-options.js";
import { setupOptions, type ImageSetup } from "../state.js";
import { CommandBar } from "./commandbar.js";

const FORMAT_LABELS = { jpg: "JPEG", webp: "WebP", avif: "AVIF" } as const;

/** One row of choices; the chosen one is marked, the highlighted one is cyan on the active row. */
function Choices(props: {
  label: string;
  active: boolean;
  items: Array<{ label: string; on: boolean }>;
  cursor: number;
}): ReactNode {
  return (
    <Box>
      <Text color={props.active ? "cyan" : undefined}>
        {props.active ? "› " : "  "}
        {props.label.padEnd(18)}
      </Text>
      {props.items.map((item, i) => (
        <Text
          key={item.label}
          color={props.active && i === props.cursor ? "cyan" : undefined}
          bold={item.on}
          dimColor={!item.on && !(props.active && i === props.cursor)}
        >
          {item.on ? "◉ " : "○ "}
          {item.label}
          {"   "}
        </Text>
      ))}
    </Box>
  );
}

export function ImageSetupPanel(props: { setup: ImageSetup; input: string }): ReactNode {
  const { setup } = props;
  const customEdge = setup.customEdge === null ? "Custom…" : `Custom: ${setup.customEdge} px`;
  const customSize =
    setup.customSize === null ? "Custom…" : `Custom: ${describeMaxSize(setup.customSize)}`;
  const chosen = setupOptions(setup);
  const capped = typeof chosen === "object" ? chosen.maxSize !== null : setup.size > 0;

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>Image output</Text>
      <Text dimColor>
        How should the optimized images be written? (photo and hero; icons stay PNG)
      </Text>
      <Box flexDirection="column" marginTop={1}>
        <Choices
          label="Formats"
          active={setup.question === 0}
          cursor={setup.formatCursor}
          items={IMAGE_FORMAT_CHOICES.map((f) => ({
            label: FORMAT_LABELS[f],
            on: setup.formats.includes(f),
          }))}
        />
        <Choices
          label="Max edge"
          active={setup.question === 1}
          cursor={setup.edge}
          items={[
            ...MAX_EDGE_CHOICES.map((px, i) => ({ label: `${px} px`, on: i === setup.edge })),
            { label: customEdge, on: setup.edge === MAX_EDGE_CHOICES.length },
          ]}
        />
        <Choices
          label="Max size per file"
          active={setup.question === 2}
          cursor={setup.size}
          items={[
            ...MAX_SIZE_CHOICES.map((bytes, i) => ({
              label: bytes === null ? "No cap" : describeMaxSize(bytes),
              on: i === setup.size,
            })),
            { label: customSize, on: setup.size === MAX_SIZE_CHOICES.length },
          ]}
        />
      </Box>
      {capped ? (
        <Text dimColor>
          A size cap uses a quality search (target {SEARCH_DEFAULTS.ssimulacra2}, floor{" "}
          {SEARCH_DEFAULTS.floor}): slower, paid once per image and cached.
        </Text>
      ) : null}
      {setup.typing ? (
        <Box marginTop={1}>
          <CommandBar
            prompt={setup.typing === "maxEdge" ? "Max edge (px):" : "Max size (e.g. 250 KB):"}
            input={props.input}
            suggestions={{ kind: "none", items: [] }}
            selected={0}
            hint="enter sets it · esc cancels"
          />
        </Box>
      ) : (
        <Text dimColor>
          ↑↓ question · ←→ choose · space tick / type custom · enter apply · esc cancel
        </Text>
      )}
    </Box>
  );
}
