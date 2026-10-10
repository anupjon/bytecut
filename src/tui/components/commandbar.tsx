import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { activeMention, fuzzyFiles, suggestCommands } from "../commands.js";

export interface Suggestions {
  kind: "command" | "file" | "none";
  items: Array<{ value: string; hint?: string }>;
}

/** What the bar offers for the text typed so far: command names, or files after an `@`. */
export function computeSuggestions(input: string, files: string[]): Suggestions {
  const mention = activeMention(input);
  if (mention !== null) {
    return { kind: "file", items: fuzzyFiles(mention, files).map((value) => ({ value })) };
  }
  const commands = suggestCommands(input);
  if (commands.length > 0) {
    return {
      kind: "command",
      items: commands.map((c) => ({ value: c.name, hint: c.description })),
    };
  }
  return { kind: "none", items: [] };
}

export function CommandBar(props: {
  input: string;
  suggestions: Suggestions;
  selected: number;
  prompt: string;
  hint?: string;
}): ReactNode {
  return (
    <Box flexDirection="column">
      <Box>
        <Text color="cyan">{props.prompt} </Text>
        <Text>{props.input}</Text>
        <Text inverse> </Text>
      </Box>
      {props.hint ? <Text dimColor>{props.hint}</Text> : null}
      {props.suggestions.items.map((item, i) => (
        <Text
          key={item.value}
          color={i === props.selected ? "cyan" : undefined}
          wrap="truncate-end"
        >
          {i === props.selected ? "› " : "  "}
          {props.suggestions.kind === "command" ? "/" : "@"}
          {item.value}
          {item.hint ? <Text dimColor> — {item.hint}</Text> : null}
        </Text>
      ))}
    </Box>
  );
}
