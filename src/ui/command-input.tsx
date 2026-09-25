import { Box, Text } from "ink";
import type { JSX } from "react";
import { glyphs, theme } from "./theme.js";

export const COMMAND_PLACEHOLDER = "type / for commands";

export interface CommandInputProps {
  value: string;
  cursor: number;
  ghost?: string | undefined;
}

export function CommandInput({ value, cursor, ghost }: CommandInputProps): JSX.Element {
  const before = value.slice(0, cursor);
  const at = value.slice(cursor, cursor + 1);
  const after = value.slice(cursor + 1);
  const atEnd = cursor >= value.length;
  return (
    <Box borderStyle="round" borderColor={theme.muted} paddingX={1} flexShrink={0}>
      <Text wrap="truncate-end">
        <Text bold>{`${glyphs.prompt} `}</Text>
        {before}
        <Text inverse>{at === "" ? " " : at}</Text>
        {after}
        {value === "" ? <Text dimColor>{COMMAND_PLACEHOLDER}</Text> : null}
        {atEnd && ghost !== undefined ? <Text dimColor>{ghost}</Text> : null}
      </Text>
    </Box>
  );
}
