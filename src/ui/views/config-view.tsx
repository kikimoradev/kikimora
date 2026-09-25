import { Box, Text } from "ink";
import type { JSX } from "react";
import { describeSchedule } from "../../active-hours.js";
import { SETTINGS_PATH_LABEL } from "../../config.js";
import type { WorkerConfig } from "../../types.js";
import { formatInterval } from "../format.js";
import { Panel } from "../panel.js";
import { describeWindow, listWindow, PANEL_BORDER_ROWS } from "../scroll.js";

export interface ConfigViewProps {
  config: WorkerConfig;
  width: number;
  height: number;
  offset?: number | undefined;
}

interface ConfigEntry {
  label: string;
  value: string;
  command?: string | undefined;
}

interface ConfigSection {
  title: string;
  entries: ConfigEntry[];
}

type ConfigCell = { kind: "title"; text: string } | { kind: "entry"; entry: ConfigEntry };

export type ConfigRow = readonly (ConfigCell | undefined)[];

export const CONFIG_TWO_COLUMN_WIDTH = 110;
const LABEL_WIDTH = 17;
const COLUMN_GAP = 4;

function timeout(ms: number | undefined): string {
  return ms === undefined ? "none" : formatInterval(ms);
}

function serverList(names: readonly string[]): string {
  return names.length === 0 ? "none" : names.join(", ");
}

function configSections(config: WorkerConfig): ConfigSection[] {
  return [
    {
      title: "Monitor",
      entries: [
        { label: "model", value: config.monitor.model, command: "/model monitor" },
        { label: "effort", value: config.monitor.effort, command: "/effort monitor" },
        {
          label: "interval",
          value: `every ${formatInterval(config.monitor.intervalMs)}`,
          command: "/interval",
        },
        {
          label: "schedule",
          value: describeSchedule(config.monitor.schedule),
          command: "/hours /days",
        },
        { label: "session timeout", value: timeout(config.monitor.sessionTimeoutMs) },
        { label: "mcp servers", value: serverList(config.monitor.mcpServers) },
      ],
    },
    {
      title: "Executor",
      entries: [
        { label: "model", value: config.executor.model, command: "/model executor" },
        { label: "effort", value: config.executor.effort, command: "/effort executor" },
        { label: "session timeout", value: timeout(config.executor.sessionTimeoutMs) },
        { label: "max attempts", value: String(config.executor.maxTaskAttempts) },
        { label: "retry delay", value: formatInterval(config.executor.retryDelayMs) },
        { label: "mcp servers", value: serverList(config.executor.mcpServers) },
      ],
    },
    {
      title: "Summarizer",
      entries: [
        { label: "model", value: config.summarizer.model, command: "/model summarizer" },
        {
          label: "effort",
          value: config.summarizer.effort,
          command: "/effort summarizer",
        },
        { label: "session timeout", value: timeout(config.summarizer.sessionTimeoutMs) },
      ],
    },
    {
      title: "General",
      entries: [
        { label: "stream partial", value: config.streamPartial ? "on" : "off" },
        { label: "browser", value: config.browser ? "on" : "off" },
        {
          label: "shutdown grace",
          value:
            config.shutdownGraceMs === 0
              ? "none"
              : formatInterval(config.shutdownGraceMs),
        },
        { label: "mcp servers", value: serverList(Object.keys(config.mcpServers)) },
      ],
    },
  ];
}

function sectionCells(section: ConfigSection): ConfigCell[] {
  return [
    { kind: "title", text: section.title },
    ...section.entries.map((entry): ConfigCell => ({ kind: "entry", entry })),
  ];
}

function pairRows(left: ConfigSection, right: ConfigSection): ConfigRow[] {
  const leftCells = sectionCells(left);
  const rightCells = sectionCells(right);
  return Array.from({ length: Math.max(leftCells.length, rightCells.length) }, (_, i) => [
    leftCells[i],
    rightCells[i],
  ]);
}

export function configRows(config: WorkerConfig, width: number): ConfigRow[] {
  const sections = configSections(config);
  const [monitor, executor, summarizer, general] = sections;
  if (
    width >= CONFIG_TWO_COLUMN_WIDTH &&
    monitor !== undefined &&
    executor !== undefined &&
    summarizer !== undefined &&
    general !== undefined
  ) {
    return [...pairRows(monitor, executor), [], ...pairRows(summarizer, general)];
  }
  return sections.flatMap((section, index) => [
    ...(index === 0 ? [] : [[]]),
    ...sectionCells(section).map((cell) => [cell]),
  ]);
}

function Cell({ cell }: { cell: ConfigCell | undefined }): JSX.Element {
  if (cell === undefined) return <Box flexGrow={1} flexBasis={0} />;
  if (cell.kind === "title") {
    return (
      <Box flexGrow={1} flexBasis={0}>
        <Text bold>{cell.text}</Text>
      </Box>
    );
  }
  const { label, value, command } = cell.entry;
  return (
    <Box flexGrow={1} flexBasis={0} gap={2} overflow="hidden">
      <Box flexGrow={1} flexShrink={1} overflow="hidden">
        <Text wrap="truncate-end">
          <Text dimColor>{`  ${label.padEnd(LABEL_WIDTH)}`}</Text>
          {value}
        </Text>
      </Box>
      {command === undefined ? null : (
        <Box flexShrink={0}>
          <Text dimColor>{command}</Text>
        </Box>
      )}
    </Box>
  );
}

export function ConfigView({
  config,
  width,
  height,
  offset = 0,
}: ConfigViewProps): JSX.Element {
  const window = listWindow(
    configRows(config, width),
    height - PANEL_BORDER_ROWS,
    offset,
  );
  const range = describeWindow(window);
  return (
    <Panel
      title="Configuration"
      aside={<Text dimColor>{SETTINGS_PATH_LABEL}</Text>}
      footerAside={range === undefined ? undefined : <Text dimColor>{range}</Text>}
      height={height}
    >
      {window.visible.map((row, index) => (
        <Box key={index} height={1} gap={COLUMN_GAP}>
          {row.length === 0 ? <Text> </Text> : null}
          {row.map((cell, column) => (
            <Cell key={column} cell={cell} />
          ))}
        </Box>
      ))}
    </Panel>
  );
}
