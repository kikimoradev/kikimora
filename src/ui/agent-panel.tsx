import { Box, Text } from "ink";
import type { JSX, ReactNode } from "react";
import { formatDroppedLines } from "../session-events.js";
import type { TailLine, TailTone } from "../status.js";
import type { AgentPanelModel } from "./agent-visuals.js";
import type { OutcomeLine, StatusLine } from "./format.js";
import { Panel, PanelTitle } from "./panel.js";
import { StatusGlyph } from "./status-glyph.js";
import { glyphs, theme, toneColor } from "./theme.js";
import { capRows, wrapText } from "./wrap.js";

export interface AgentPanelProps {
  title: string;
  subtitle: string;
  heading?: ReactNode;
  model: AgentPanelModel;
  width: number;
  height: number;
  active: boolean;
  scrollOffset: number;
  expanded: boolean;
  showOutcome?: boolean | undefined;
}

const PANEL_CHROME_WIDTH = 4;
const PANEL_CHROME_ROWS = 4;
const MIN_INNER_WIDTH = 16;
const TOOL_MAX_ROWS = 2;
const RESULT_MAX_ROWS = 3;
const EXPANDED_MAX_ROWS = 40;
const RULE = glyphs.rule.repeat(512);

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

function SessionRule({ text }: { text: string }): JSX.Element {
  return (
    <Box height={1}>
      <Box flexShrink={1} overflow="hidden">
        <Text
          dimColor
          wrap="truncate-end"
        >{`${glyphs.rule}${glyphs.rule} ${text} `}</Text>
      </Box>
      <Box flexGrow={1} flexBasis={0} height={1} overflow="hidden">
        <Text dimColor>{RULE}</Text>
      </Box>
    </Box>
  );
}

function TailRow({ row }: { row: TailRowSpec }): JSX.Element {
  const { line, chunk, first } = row;
  switch (line.kind) {
    case "message":
      if (first && line.cont !== true) {
        return (
          <Text wrap="truncate-end">
            <Text>{`${glyphs.bullet} `}</Text>
            {chunk}
          </Text>
        );
      }
      return <Text wrap="truncate-end">{`  ${chunk}`}</Text>;
    case "tool":
      if (first) {
        return (
          <Text wrap="truncate-end">
            <Text>{`${glyphs.bullet} `}</Text>
            <Text bold>{line.tool ?? "?"}</Text>
            {chunk ? <Text dimColor>{`(${chunk}`}</Text> : null}
          </Text>
        );
      }
      return <Text dimColor wrap="truncate-end">{`    ${chunk}`}</Text>;
    case "result": {
      const text = first ? `  ${glyphs.result} ${chunk}` : `    ${chunk}`;
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
    case "session":
      return <SessionRule text={chunk} />;
    case "notice":
      return (
        <Text color={noticeColor(line.tone)} wrap="truncate-end">
          {chunk}
        </Text>
      );
  }
}

function StatusRow({ status }: { status: StatusLine }): JSX.Element {
  return (
    <Box height={1} gap={1}>
      <StatusGlyph status={status} />
      <Box flexGrow={1} flexShrink={1} flexBasis={0} overflow="hidden">
        <Text dimColor={status.tone === "muted"} wrap="truncate-end">
          {status.text}
        </Text>
      </Box>
      {status.aside === undefined ? null : (
        <Box flexShrink={0}>
          <Text dimColor>{status.aside}</Text>
        </Box>
      )}
    </Box>
  );
}

export function OutcomeText({ outcome }: { outcome: OutcomeLine }): JSX.Element {
  return (
    <Text wrap="truncate-end">
      <Text color={toneColor(outcome.tone)}>{`${outcome.glyph} `}</Text>
      {outcome.text}
    </Text>
  );
}

function Rule(): JSX.Element {
  return (
    <Box height={1} overflow="hidden" flexShrink={0}>
      <Text dimColor>{RULE}</Text>
    </Box>
  );
}

export function AgentPanel({
  title,
  subtitle,
  heading,
  model,
  width,
  height,
  active,
  scrollOffset,
  expanded,
  showOutcome = true,
}: AgentPanelProps): JSX.Element {
  const innerWidth = Math.max(MIN_INNER_WIDTH, width - PANEL_CHROME_WIDTH);
  const allRows = model.tail.flatMap((line) => rowsFor(line, innerWidth, expanded));
  const capacity = Math.max(0, height - PANEL_CHROME_ROWS);

  const scrolled = scrollOffset > 0 && allRows.length > capacity;
  const offset = scrolled ? Math.min(scrollOffset, allRows.length - capacity) : 0;
  const end = allRows.length - offset;
  const visible = allRows.slice(Math.max(0, end - capacity), end);
  const outcome = showOutcome ? model.outcome : undefined;
  return (
    <Panel
      title={
        heading ?? (
          <PanelTitle active={active} subtitle={subtitle}>
            {title}
          </PanelTitle>
        )
      }
      aside={
        scrolled ? <Text dimColor>{`↓ ${offset} newer · esc to follow`}</Text> : undefined
      }
      footer={outcome === undefined ? undefined : <OutcomeText outcome={outcome} />}
      footerAside={
        outcome === undefined ? undefined : <Text dimColor>{outcome.meta}</Text>
      }
      active={active}
      width={width}
      height={height}
    >
      <StatusRow status={model.status} />
      {visible[0]?.line.kind === "session" ? null : <Rule />}
      {visible.length === 0 ? (
        <Box flexGrow={1} justifyContent="center" alignItems="center">
          <Text dimColor wrap="truncate-end">
            {model.emptyHint}
          </Text>
        </Box>
      ) : (
        <Box flexDirection="column" flexGrow={1} overflow="hidden">
          {visible.map((row, index) => (
            <TailRow key={index} row={row} />
          ))}
        </Box>
      )}
    </Panel>
  );
}
