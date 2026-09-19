import { Box, Text } from "ink";
import type { JSX } from "react";
import { COMMANDS } from "../commands.js";
import { theme } from "../theme.js";
import { wrapText } from "../wrap.js";

export interface HelpViewProps {
  width: number;
  height: number;
}

const KEYS: readonly [string, string][] = [
  ["↑/↓", "pick a suggestion / browse command history"],
  ["tab", "complete the selected command / switch panel"],
  ["pgup/pgdn", "scroll the focused panel"],
  ["ctrl+o", "expand or collapse tool output"],
  ["esc", "clear the input / follow the tail"],
  ["ctrl+c", "quit"],
];

interface HelpRow {
  label: string;
  text: string;
}

function columnRows(
  entries: readonly [string, string][],
  labelWidth: number,
  columnWidth: number,
): HelpRow[] {
  const textWidth = Math.max(10, columnWidth - labelWidth);
  return entries.flatMap(([label, summary]) =>
    wrapText(summary, textWidth, textWidth).map((chunk, index) => ({
      label: index === 0 ? label.padEnd(labelWidth) : " ".repeat(labelWidth),
      text: chunk,
    })),
  );
}

function HelpColumn({
  title,
  rows,
  capacity,
}: {
  title: string;
  rows: HelpRow[];
  capacity: number;
}): JSX.Element {
  return (
    <Box flexDirection="column" flexBasis={0} flexGrow={1} overflow="hidden">
      <Text bold>{title}</Text>
      {rows.slice(0, capacity).map((row, index) => (
        <Text key={index} wrap="truncate-end">
          <Text bold>{row.label}</Text>
          <Text dimColor>{row.text}</Text>
        </Text>
      ))}
    </Box>
  );
}

export function HelpView({ width, height }: HelpViewProps): JSX.Element {
  const columnWidth = Math.max(30, Math.floor((width - 6) / 2));
  const capacity = Math.max(1, height - 3);
  const commandRows = columnRows(
    COMMANDS.map((command) => [
      `/${command.name}${command.args === undefined ? "" : ` ${command.args}`}`,
      command.summary,
    ]),
    27,
    columnWidth,
  );
  const keyRows = columnRows(KEYS, 11, columnWidth);
  return (
    <Box
      borderStyle="round"
      borderColor={theme.muted}
      paddingX={1}
      height={height}
      overflow="hidden"
    >
      <HelpColumn title="Commands" rows={commandRows} capacity={capacity} />
      <Box width={2} />
      <HelpColumn title="Keys" rows={keyRows} capacity={capacity} />
    </Box>
  );
}
