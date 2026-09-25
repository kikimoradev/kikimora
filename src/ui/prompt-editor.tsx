import { Box, Text, useInput, type Key } from "ink";
import type { JSX } from "react";
import { useState } from "react";
import { countLabel } from "./format.js";
import { KeyHints } from "./key-hints.js";
import { readlineEdit } from "./line-editing.js";
import { Panel, PanelTitle } from "./panel.js";
import { theme } from "./theme.js";

export interface PromptEditorProps {
  title: string;
  subtitle?: string | undefined;
  step?: string | undefined;
  description?: string | undefined;
  submitLabel?: string | undefined;
  cancelLabel?: string | undefined;
  placeholder?: string | undefined;
  initialValue?: string | undefined;
  width?: number | undefined;
  maxVisibleLines?: number | undefined;
  fill?: boolean | undefined;
  error?: string | undefined;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

export interface EditorState {
  lines: readonly string[];
  row: number;
  col: number;
}

export interface VisualRow {
  line: number;
  start: number;
  text: string;
}

const DEFAULT_MAX_VISIBLE_LINES = 12;
const DEFAULT_WIDTH = 80;
const EDITOR_CHROME_WIDTH = 4;
const MIN_TEXT_WIDTH = 8;
const PASTE_MARKER = /^\[20[01]~$/;

function initialState(value: string): EditorState {
  const lines = value === "" ? [""] : value.split("\n");
  const row = lines.length - 1;
  return { lines, row, col: lines[row]?.length ?? 0 };
}

function currentLine(state: EditorState): string {
  return state.lines[state.row] ?? "";
}

function editorValue(state: EditorState): string {
  return state.lines.join("\n");
}

function insertText(state: EditorState, text: string): EditorState {
  const line = currentLine(state);
  const before = line.slice(0, state.col) + text + line.slice(state.col);
  const inserted = before.split("\n");
  const lines = [
    ...state.lines.slice(0, state.row),
    ...inserted,
    ...state.lines.slice(state.row + 1),
  ];
  const row = state.row + inserted.length - 1;
  const lastChunkLength = inserted[inserted.length - 1]?.length ?? 0;
  const col = lastChunkLength - (line.length - state.col);
  return { lines, row, col };
}

function joinWithPrevious(state: EditorState): EditorState {
  if (state.row === 0) return state;
  const previous = state.lines[state.row - 1] ?? "";
  const lines = [
    ...state.lines.slice(0, state.row - 1),
    previous + currentLine(state),
    ...state.lines.slice(state.row + 1),
  ];
  return { lines, row: state.row - 1, col: previous.length };
}

function joinWithNext(state: EditorState): EditorState {
  if (state.row === state.lines.length - 1) return state;
  const lines = [
    ...state.lines.slice(0, state.row),
    currentLine(state) + (state.lines[state.row + 1] ?? ""),
    ...state.lines.slice(state.row + 2),
  ];
  return { ...state, lines };
}

function moveLeft(state: EditorState): EditorState {
  if (state.col > 0) return { ...state, col: state.col - 1 };
  if (state.row === 0) return state;
  const row = state.row - 1;
  return { ...state, row, col: state.lines[row]?.length ?? 0 };
}

function moveRight(state: EditorState): EditorState {
  if (state.col < currentLine(state).length) return { ...state, col: state.col + 1 };
  if (state.row === state.lines.length - 1) return state;
  return { ...state, row: state.row + 1, col: 0 };
}

export function visualRows(lines: readonly string[], width: number): VisualRow[] {
  const safeWidth = Math.max(1, width);
  return lines.flatMap((text, line) =>
    Array.from({ length: Math.floor(text.length / safeWidth) + 1 }, (_, index) => ({
      line,
      start: index * safeWidth,
      text: text.slice(index * safeWidth, (index + 1) * safeWidth),
    })),
  );
}

export function cursorRowIndex(
  rows: readonly VisualRow[],
  state: EditorState,
  width: number,
): number {
  const index = rows.findIndex(
    (row) =>
      row.line === state.row && state.col >= row.start && state.col < row.start + width,
  );
  return Math.max(0, index);
}

function moveVertically(state: EditorState, delta: number, width: number): EditorState {
  const rows = visualRows(state.lines, width);
  const index = cursorRowIndex(rows, state, width);
  const target = rows[Math.min(Math.max(0, index + delta), rows.length - 1)];
  const current = rows[index];
  if (target === undefined || current === undefined || target === current) return state;
  const lineLength = state.lines[target.line]?.length ?? 0;
  const col = Math.min(target.start + (state.col - current.start), lineLength);
  return { ...state, row: target.line, col };
}

function editLine(state: EditorState, input: string, key: Key): EditorState | undefined {
  const edit = readlineEdit(input, key);
  if (edit === undefined) return undefined;
  const next = edit({ value: currentLine(state), cursor: state.col });
  return {
    lines: state.lines.with(state.row, next.value),
    row: state.row,
    col: next.cursor,
  };
}

function normalizePaste(input: string): string {
  return input.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function EditorRow({
  text,
  cursor,
}: {
  text: string;
  cursor: number | null;
}): JSX.Element {
  if (cursor === null) return <Text>{text === "" ? " " : text}</Text>;
  const at = text.slice(cursor, cursor + 1);
  return (
    <Text>
      {text.slice(0, cursor)}
      <Text inverse>{at === "" ? " " : at}</Text>
      {text.slice(cursor + 1)}
    </Text>
  );
}

function editorAside(
  hiddenAbove: number,
  step: string | undefined,
  modified: boolean,
): JSX.Element | undefined {
  const plain = [hiddenAbove > 0 ? `↑ ${hiddenAbove} more` : undefined, step]
    .filter((part) => part !== undefined)
    .join(" · ");
  if (plain === "" && !modified) return undefined;
  return (
    <Text>
      <Text dimColor>{plain}</Text>
      {modified ? (
        <Text color={theme.warn}>{plain === "" ? "modified" : " · modified"}</Text>
      ) : null}
    </Text>
  );
}

export function PromptEditor({
  title,
  subtitle,
  step,
  description,
  submitLabel = "submit",
  cancelLabel = "cancel",
  placeholder,
  initialValue,
  width = DEFAULT_WIDTH,
  maxVisibleLines = DEFAULT_MAX_VISIBLE_LINES,
  fill = false,
  error,
  onSubmit,
  onCancel,
}: PromptEditorProps): JSX.Element {
  const [state, setState] = useState<EditorState>(() => initialState(initialValue ?? ""));
  const [warning, setWarning] = useState<string | null>(null);
  const textWidth = Math.max(MIN_TEXT_WIDTH, width - EDITOR_CHROME_WIDTH);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      onCancel();
      return;
    }
    if (key.ctrl && input === "d") {
      const value = editorValue(state).trimEnd();
      if (value === "") {
        setWarning("enter at least one line, or press Esc to cancel");
        return;
      }
      onSubmit(value);
      return;
    }
    if (key.escape) {
      onCancel();
      return;
    }
    setWarning(null);
    if (key.return) {
      setState((current) => insertText(current, "\n"));
      return;
    }
    if (key.upArrow || key.downArrow) {
      setState((current) => moveVertically(current, key.upArrow ? -1 : 1, textWidth));
      return;
    }
    if (key.tab) {
      setState((current) => insertText(current, "  "));
      return;
    }
    setState((current) => {
      const atStart = current.col === 0;
      const atEnd = current.col === currentLine(current).length;
      if ((key.backspace || (key.ctrl && input === "w")) && atStart) {
        return joinWithPrevious(current);
      }
      if (key.delete && atEnd) return joinWithNext(current);
      if (key.leftArrow && !key.meta && atStart) return moveLeft(current);
      if (key.rightArrow && !key.meta && atEnd) return moveRight(current);
      const edited = editLine(current, input, key);
      if (edited !== undefined) return edited;
      if (input.length === 0 || key.ctrl || key.meta) return current;
      const text = normalizePaste(input);
      return PASTE_MARKER.test(text) ? current : insertText(current, text);
    });
  });

  const empty = state.lines.length === 1 && state.lines[0] === "";
  const rows = visualRows(state.lines, textWidth);
  const cursorIndex = cursorRowIndex(rows, state, textWidth);
  const viewportStart = Math.min(
    Math.max(0, cursorIndex - maxVisibleLines + 1),
    Math.max(0, rows.length - maxVisibleLines),
  );
  const visible = rows.slice(viewportStart, viewportStart + maxVisibleLines);
  const hiddenBelow = rows.length - viewportStart - visible.length;
  const value = editorValue(state);
  const modified = value !== (initialValue ?? "");

  return (
    <Box flexDirection="column" flexShrink={0} width={width}>
      <Panel
        title={<PanelTitle subtitle={subtitle}>{title}</PanelTitle>}
        aside={editorAside(viewportStart, step, step === undefined && modified)}
        footer={
          description === undefined ? undefined : (
            <Text dimColor wrap="truncate-end">
              {description}
            </Text>
          )
        }
        footerAside={
          hiddenBelow > 0 ? <Text dimColor>{`↓ ${hiddenBelow} more`}</Text> : undefined
        }
        width={width}
        height={fill ? maxVisibleLines + 2 : undefined}
      >
        {empty && placeholder !== undefined ? (
          <Text wrap="truncate-end">
            <Text inverse> </Text>
            <Text dimColor>{placeholder}</Text>
          </Text>
        ) : (
          visible.map((row, index) => (
            <EditorRow
              key={viewportStart + index}
              text={row.text}
              cursor={
                viewportStart + index === cursorIndex ? state.col - row.start : null
              }
            />
          ))
        )}
      </Panel>
      <Box height={1} paddingX={1} gap={2}>
        <Box flexGrow={1} flexShrink={1} overflow="hidden">
          {warning !== null || error !== undefined ? (
            <Text color={warning === null ? theme.error : theme.warn} wrap="truncate-end">
              {warning ?? error}
            </Text>
          ) : (
            <KeyHints
              hints={[
                ["enter", "new line"],
                ["ctrl+d", submitLabel],
                ["esc", cancelLabel],
              ]}
            />
          )}
        </Box>
        <Box flexShrink={0}>
          <Text dimColor>
            {`${countLabel(state.lines.length, "line", "lines")} · ${countLabel(value.length, "char", "chars")}`}
          </Text>
        </Box>
      </Box>
    </Box>
  );
}
