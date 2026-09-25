import { Box, Text } from "ink";
import type { JSX } from "react";
import type { MenuItem } from "./commands.js";
import { glyphs } from "./theme.js";

export const SUGGESTION_WINDOW = 10;

export interface CommandSuggestionsProps {
  items: readonly MenuItem[];
  selected: number;
  matchLength: number;
}

function labelText(item: MenuItem): string {
  return item.args === undefined ? item.label : `${item.label} ${item.args}`;
}

export function CommandSuggestions({
  items,
  selected,
  matchLength,
}: CommandSuggestionsProps): JSX.Element {
  const labelWidth = items.reduce(
    (max, item) => Math.max(max, labelText(item).length),
    0,
  );
  const windowStart = Math.min(
    Math.max(0, selected - SUGGESTION_WINDOW + 1),
    Math.max(0, items.length - SUGGESTION_WINDOW),
  );
  const visible = items.slice(windowStart, windowStart + SUGGESTION_WINDOW);
  return (
    <Box flexDirection="column" paddingLeft={1} flexShrink={0}>
      {visible.map((item, offset) => {
        const active = windowStart + offset === selected;
        const head = item.label.slice(0, matchLength);
        const tail = item.label.slice(matchLength);
        const args = item.args === undefined ? "" : ` ${item.args}`;
        const padding = " ".repeat(Math.max(0, labelWidth - labelText(item).length));
        return (
          <Text key={item.key} wrap="truncate-end">
            <Text dimColor={!active}>{active ? `${glyphs.prompt} ` : "  "}</Text>
            <Text bold>{head}</Text>
            <Text bold={active} dimColor={!active}>
              {tail}
            </Text>
            <Text dimColor>{`${args}${padding}`}</Text>
            {item.summary === undefined ? null : (
              <Text dimColor={!active}>{`  ${item.summary}`}</Text>
            )}
          </Text>
        );
      })}
    </Box>
  );
}
