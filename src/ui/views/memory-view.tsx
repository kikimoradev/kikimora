import { Box, Text } from "ink";
import type { JSX } from "react";
import type { TaskSummaryRecord } from "../../memory/store.js";
import { countLabel, formatAge } from "../format.js";
import { Panel, PanelTitle } from "../panel.js";
import { describeWindow, listWindow, PANEL_BORDER_ROWS } from "../scroll.js";
import { glyphs, theme } from "../theme.js";

export interface MemoryViewProps {
  entries: readonly TaskSummaryRecord[];
  query?: string | undefined;
  height: number;
  now: number;
  offset?: number | undefined;
}

const MAX_ID_WIDTH = 24;

function entryMeta(entry: TaskSummaryRecord, now: number): string {
  const age = formatAge(entry.createdAt, now);
  return entry.attempt > 1 ? `attempt ${entry.attempt} · ${age}` : age;
}

export function MemoryView({
  entries,
  query,
  height,
  now,
  offset = 0,
}: MemoryViewProps): JSX.Element {
  const window = listWindow(entries, height - PANEL_BORDER_ROWS, offset);
  const range = describeWindow(window);
  const idWidth =
    Math.min(
      MAX_ID_WIDTH,
      entries.reduce((max, entry) => Math.max(max, entry.taskId.length), 0),
    ) + 2;
  return (
    <Panel
      title={
        <PanelTitle
          subtitle={
            query === undefined
              ? "recent entries"
              : `search "${query}" · ${countLabel(entries.length, "result", "results")}`
          }
        >
          Memory
        </PanelTitle>
      }
      footerAside={range === undefined ? undefined : <Text dimColor>{range}</Text>}
      height={height}
    >
      {entries.length === 0 ? (
        <Text dimColor>
          {query === undefined
            ? "no memory entries yet — the summarizer writes one after each task"
            : "no matching entries"}
        </Text>
      ) : null}
      {window.visible.map((entry) => (
        <Box key={entry.id} height={1} gap={2}>
          <Box flexGrow={1} flexShrink={1} flexBasis={0} overflow="hidden">
            <Box width={2} flexShrink={0}>
              <Text color={entry.ok ? theme.ok : theme.error}>
                {entry.ok ? glyphs.ok : glyphs.error}
              </Text>
            </Box>
            <Box width={idWidth} flexShrink={0} overflow="hidden">
              <Text dimColor wrap="truncate-end">
                {entry.taskId}
              </Text>
            </Box>
            <Box flexGrow={1} flexShrink={1} overflow="hidden">
              <Text wrap="truncate-end">{entry.headline}</Text>
            </Box>
          </Box>
          <Box flexShrink={0}>
            <Text dimColor>{entryMeta(entry, now)}</Text>
          </Box>
        </Box>
      ))}
    </Panel>
  );
}
