import { Box, Text } from "ink";
import type { JSX } from "react";
import { formatDroppedLines } from "../session-events.js";
import type { TailLine, TailTone } from "../status.js";
import { theme } from "./theme.js";
import { capRows, wrapText } from "./wrap.js";

export interface AgentPanelProps {
  title: string;
  borderColor: string;
  phaseLabel: string;
  phaseColor: string;
  tail: readonly TailLine[];
  outcomeLabel?: string | undefined;
  outcomeColor: string;
  width: number;
  height: number;
  focused: boolean;
  scrollOffset: number;
  expanded: boolean;
}

const PANEL_CHROME_WIDTH = 4;
const MIN_INNER_WIDTH = 16;
const TOOL_MAX_ROWS = 2;
const RESULT_MAX_ROWS = 3;
const EXPANDED_MAX_ROWS = 40;

interface TailRowSpec {
  line: TailLine;
  chunk: string;
  first: boolean;
}

function rowsFor(line: TailLine, innerWidth: number, expanded: boolean): TailRowSpec[] {
  const toSpecs = (chunks: string[]): TailRowSpec[] =>
    chunks.map((chunk, index) => ({ line, chunk, first: index === 0 }));
  switch (line.kind) {
    case "message":
      return toSpecs(wrapText(line.text, innerWidth - 2, innerWidth - 2));
    case "tool": {
      if (!line.text) return [{ line, chunk: "", first: true }];
      const label = line.tool ?? "?";
      const firstWidth = innerWidth - 2 - label.length - 1;
      const restWidth = innerWidth - 4;
      return toSpecs(
        capRows(
          wrapText(`${line.text})`, firstWidth, restWidth),
          expanded ? EXPANDED_MAX_ROWS : TOOL_MAX_ROWS,
          restWidth,
        ),
      );
    }
    case "result": {
      const bodyWidth = innerWidth - 4;
      const extra = line.extra ?? [];
      const dropped = line.dropped ?? 0;
      if (!expanded) {
        const hidden = extra.length + dropped;
        const summary =
          hidden > 0 ? `${line.text}${formatDroppedLines(hidden)}` : line.text;
        return toSpecs(
          capRows(wrapText(summary, bodyWidth, bodyWidth), RESULT_MAX_ROWS, bodyWidth),
        );
      }
      const rows = [line.text, ...extra].flatMap((body) =>
        wrapText(body, bodyWidth, bodyWidth),
      );
      const capped = capRows(rows, EXPANDED_MAX_ROWS, bodyWidth);
      if (dropped > 0 && capped.length === rows.length) {
        capped.push(formatDroppedLines(dropped).trimStart());
      }
      return toSpecs(capped);
    }
    default:
      return [{ line, chunk: line.text, first: true }];
  }
}

function noticeColor(tone: TailTone | undefined): string {
  switch (tone) {
    case "ok":
      return theme.ok;
    case "warn":
      return theme.warn;
    case "error":
      return theme.error;
    default:
      return theme.muted;
  }
}

function TailRow({ row }: { row: TailRowSpec }): JSX.Element {
  const { line, chunk, first } = row;
  switch (line.kind) {
    case "message":
      if (first && line.cont !== true) {
        return (
          <Text wrap="truncate-end">
            <Text>{"⏺ "}</Text>
            {chunk}
          </Text>
        );
      }
      return <Text wrap="truncate-end">{`  ${chunk}`}</Text>;
    case "tool":
      if (first) {
        return (
          <Text wrap="truncate-end">
            <Text>{"⏺ "}</Text>
            <Text bold>{line.tool ?? "?"}</Text>
            {chunk ? <Text dimColor>{`(${chunk}`}</Text> : null}
          </Text>
        );
      }
      return <Text dimColor wrap="truncate-end">{`    ${chunk}`}</Text>;
    case "result": {
      const text = first ? `  ⎿ ${chunk}` : `    ${chunk}`;
      if (line.tone === "error") {
        return (
          <Text color={theme.error} wrap="truncate-end">
            {text}
          </Text>
        );
      }
      return (
        <Text dimColor wrap="truncate-end">
          {text}
        </Text>
      );
    }
    case "meta":
      return (
        <Text dimColor wrap="truncate-end">
          {chunk}
        </Text>
      );
    case "notice":
      return (
        <Text color={noticeColor(line.tone)} wrap="truncate-end">
          {chunk}
        </Text>
      );
  }
}

export function AgentPanel({
  title,
  borderColor,
  phaseLabel,
  phaseColor,
  tail,
  outcomeLabel,
  outcomeColor,
  width,
  height,
  focused,
  scrollOffset,
  expanded,
}: AgentPanelProps): JSX.Element {
  const innerWidth = Math.max(MIN_INNER_WIDTH, width - PANEL_CHROME_WIDTH);
  const allRows = tail.flatMap((line) => rowsFor(line, innerWidth, expanded));
  const chromeLines = 4 + (outcomeLabel === undefined ? 0 : 1);
  const fullCapacity = Math.max(0, height - chromeLines);
  const scrolled = scrollOffset > 0 && allRows.length > fullCapacity;
  const capacity = scrolled ? Math.max(1, fullCapacity - 1) : fullCapacity;
  const offset = scrolled ? Math.min(scrollOffset, allRows.length - capacity) : 0;
  const end = allRows.length - offset;
  const visible = allRows.slice(Math.max(0, end - capacity), end);
  return (
    <Box
      borderStyle={focused ? "bold" : "round"}
      borderColor={borderColor}
      flexDirection="column"
      flexBasis={0}
      flexGrow={1}
      paddingX={1}
      height={height}
      overflow="hidden"
    >
      <Text bold>{title}</Text>
      <Text color={phaseColor} wrap="truncate-end">
        {phaseLabel}
      </Text>
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {visible.map((row, index) => (
          <TailRow key={index} row={row} />
        ))}
      </Box>
      {scrolled ? (
        <Text dimColor wrap="truncate-end">
          {`↓ ${offset} newer lines · esc: follow`}
        </Text>
      ) : null}
      {outcomeLabel === undefined ? null : (
        <Text color={outcomeColor} wrap="truncate-end">
          {outcomeLabel}
        </Text>
      )}
    </Box>
  );
}
