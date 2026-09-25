import { Box, Text } from "ink";
import type { JSX } from "react";
import { COMMAND_GROUPS, COMMANDS } from "../commands.js";
import { Panel } from "../panel.js";
import { describeWindow, listWindow, PANEL_BORDER_ROWS } from "../scroll.js";
import { wrapText } from "../wrap.js";

export interface HelpViewProps {
  width: number;
  height: number;
  offset?: number | undefined;
}

type HelpEntries = readonly (readonly [string, string])[];

const KEY_SECTIONS: readonly [string, HelpEntries][] = [
  [
    "Keys",
    [
      ["tab", "switch panel · complete a command or value"],
      ["↑/↓", "pick a suggestion · browse history"],
      ["pgup/pgdn", "scroll the focused panel or list"],
      ["esc", "clear the input · follow the tail"],
      ["ctrl+o", "expand or collapse tool output"],
      ["ctrl+c", "quit"],
    ],
  ],
  [
    "Editing",
    [
      ["ctrl+a/e", "start / end of the line"],
      ["alt+←/→", "previous / next word"],
      ["ctrl+w", "delete the previous word"],
      ["ctrl+u/k", "delete to the start / end of the line"],
    ],
  ],
];

const COMMAND_LABEL_WIDTH = 28;
const KEY_LABEL_WIDTH = 11;
const COLUMN_GAP = 3;
const KEYS_COLUMN_WIDTH = 56;
export const HELP_TWO_COLUMN_WIDTH = 140;

type HelpLine =
  | { kind: "title"; text: string }
  | { kind: "entry"; label: string; text: string }
  | { kind: "gap" };

export type HelpRow = readonly (HelpLine | undefined)[];

function commandSections(): [string, HelpEntries][] {
  return COMMAND_GROUPS.map((group) => [
    group,
    COMMANDS.filter((command) => command.group === group).map(
      (command) =>
        [
          `/${command.name}${command.args === undefined ? "" : ` ${command.args}`}`,
          command.summary,
        ] as const,
    ),
  ]);
}

function sectionLines(
  sections: readonly [string, HelpEntries][],
  labelWidth: number,
  columnWidth: number,
): HelpLine[] {
  const textWidth = Math.max(10, columnWidth - labelWidth);
  return sections.flatMap(([title, entries], index): HelpLine[] => [
    ...(index === 0 ? [] : [{ kind: "gap" } as const]),
    { kind: "title", text: title },
    ...entries.flatMap(([label, summary]) =>
      wrapText(summary, textWidth, textWidth).map((chunk, chunkIndex): HelpLine => ({
        kind: "entry",
        label: chunkIndex === 0 ? label.padEnd(labelWidth) : " ".repeat(labelWidth),
        text: chunk,
      })),
    ),
  ]);
}

export function helpColumns(width: number): number[] {
  const inner = Math.max(30, width - 4);
  if (inner < HELP_TWO_COLUMN_WIDTH) return [inner];
  return [inner - KEYS_COLUMN_WIDTH - COLUMN_GAP, KEYS_COLUMN_WIDTH];
}

export function helpRows(width: number): HelpRow[] {
  const [commandsWidth = 30, keysWidth] = helpColumns(width);
  const commands = sectionLines(commandSections(), COMMAND_LABEL_WIDTH, commandsWidth);
  if (keysWidth === undefined) {
    return [
      ...commands,
      { kind: "gap" } as const,
      ...sectionLines(KEY_SECTIONS, KEY_LABEL_WIDTH, commandsWidth),
    ].map((line) => [line]);
  }
  const keys = sectionLines(KEY_SECTIONS, KEY_LABEL_WIDTH, keysWidth);
  return Array.from({ length: Math.max(commands.length, keys.length) }, (_, index) => [
    commands[index],
    keys[index],
  ]);
}

function Line({
  line,
  width,
}: {
  line: HelpLine | undefined;
  width: number | undefined;
}): JSX.Element {
  if (line === undefined || line.kind === "gap") {
    return (
      <Box width={width} flexShrink={0}>
        <Text> </Text>
      </Box>
    );
  }
  return (
    <Box width={width} flexShrink={0} overflow="hidden">
      {line.kind === "title" ? (
        <Text bold>{line.text}</Text>
      ) : (
        <Text wrap="truncate-end">
          {line.label}
          <Text dimColor>{line.text}</Text>
        </Text>
      )}
    </Box>
  );
}

export function HelpView({ width, height, offset = 0 }: HelpViewProps): JSX.Element {
  const window = listWindow(helpRows(width), height - PANEL_BORDER_ROWS, offset);
  const columns = helpColumns(width);
  const range = describeWindow(window);
  return (
    <Panel
      title="Help"
      aside={<Text dimColor>type / to open the command menu</Text>}
      footerAside={range === undefined ? undefined : <Text dimColor>{range}</Text>}
      height={height}
    >
      {window.visible.map((row, index) => (
        <Box key={index} height={1} gap={COLUMN_GAP}>
          {row.map((line, column) => (
            <Line key={column} line={line} width={columns[column]} />
          ))}
        </Box>
      ))}
    </Panel>
  );
}
