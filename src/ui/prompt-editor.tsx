import { Box, Text, useInput } from "ink";
import type { JSX } from "react";
import { useState } from "react";
import { theme } from "./theme.js";

export interface PromptEditorProps {
  title: string;
  step?: string | undefined;
  hint?: string | undefined;
  placeholder?: string | undefined;
  initialValue?: string | undefined;
  maxVisibleLines?: number | undefined;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

interface EditorState {
  lines: readonly string[];
  row: number;
  col: number;
}

const DEFAULT_MAX_VISIBLE_LINES = 12;
const DEFAULT_HINT = "Enter: new line · Ctrl+D: submit · Esc: cancel";
const PASTE_MARKER = /^\[20[01]~$/;

function initialState(value: string): EditorState {
  const lines = value === "" ? [""] : value.split("\n");
  const row = lines.length - 1;
  return { lines, row, col: lines[row]?.length ?? 0 };
}

function currentLine(state: EditorState): string {
  return state.lines[state.row] ?? "";
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

function deleteBefore(state: EditorState): EditorState {
  if (state.col > 0) {
    const line = currentLine(state);
    const updated = line.slice(0, state.col - 1) + line.slice(state.col);
    const lines = state.lines.with(state.row, updated);
    return { lines, row: state.row, col: state.col - 1 };
  }
  if (state.row === 0) return state;
  const previous = state.lines[state.row - 1] ?? "";
  const lines = [
    ...state.lines.slice(0, state.row - 1),
    previous + currentLine(state),
    ...state.lines.slice(state.row + 1),
  ];
  return { lines, row: state.row - 1, col: previous.length };
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

function moveVertically(state: EditorState, delta: number): EditorState {
  const row = Math.min(Math.max(0, state.row + delta), state.lines.length - 1);
  if (row === state.row) return state;
  return { ...state, row, col: Math.min(state.col, state.lines[row]?.length ?? 0) };
}

function normalizePaste(input: string): string {
  return input.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

interface EditorLineProps {
  line: string;
  cursorCol: number | null;
}

function EditorLine({ line, cursorCol }: EditorLineProps): JSX.Element {
  if (cursorCol === null) {
    return <Text wrap="wrap">{line === "" ? " " : line}</Text>;
  }
  const before = line.slice(0, cursorCol);
  const at = line.slice(cursorCol, cursorCol + 1);
  const after = line.slice(cursorCol + 1);
  return (
    <Text wrap="wrap">
      {before}
      <Text inverse>{at === "" ? " " : at}</Text>
      {after}
    </Text>
  );
}

export function PromptEditor({
  title,
  step,
  hint = DEFAULT_HINT,
  placeholder,
  initialValue,
  maxVisibleLines = DEFAULT_MAX_VISIBLE_LINES,
  onSubmit,
  onCancel,
}: PromptEditorProps): JSX.Element {
  const [state, setState] = useState<EditorState>(() => initialState(initialValue ?? ""));
  const [warning, setWarning] = useState<string | null>(null);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      onCancel();
      return;
    }
    if (key.ctrl && input === "d") {
      const value = state.lines.join("\n").trimEnd();
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
    if (key.backspace || key.delete) {
      setState(deleteBefore);
      return;
    }
    if (key.leftArrow) {
      setState(moveLeft);
      return;
    }
    if (key.rightArrow) {
      setState(moveRight);
      return;
    }
    if (key.upArrow) {
      setState((current) => moveVertically(current, -1));
      return;
    }
    if (key.downArrow) {
      setState((current) => moveVertically(current, 1));
      return;
    }
    if (key.home) {
      setState((current) => ({ ...current, col: 0 }));
      return;
    }
    if (key.end) {
      setState((current) => ({ ...current, col: currentLine(current).length }));
      return;
    }
    if (key.tab) {
      setState((current) => insertText(current, "  "));
      return;
    }
    if (input.length > 0 && !key.ctrl && !key.meta) {
      const text = normalizePaste(input);
      if (PASTE_MARKER.test(text)) return;
      setState((current) => insertText(current, text));
    }
  });

  const empty = state.lines.length === 1 && state.lines[0] === "";
  const viewportStart = Math.min(
    Math.max(0, state.row - maxVisibleLines + 1),
    Math.max(0, state.lines.length - maxVisibleLines),
  );
  const visible = state.lines.slice(viewportStart, viewportStart + maxVisibleLines);
  const hiddenAbove = viewportStart;
  const hiddenBelow = state.lines.length - viewportStart - visible.length;

  return (
    <Box flexDirection="column">
      <Box borderStyle="round" paddingX={1} flexDirection="column">
        <Box justifyContent="space-between" gap={2}>
          <Text bold wrap="truncate-end">
            {title}
          </Text>
          {step === undefined ? null : <Text dimColor>{`step ${step}`}</Text>}
        </Box>
        {hiddenAbove > 0 ? (
          <Text dimColor>{`… ${hiddenAbove} more lines above`}</Text>
        ) : null}
        {empty && placeholder !== undefined ? (
          <Text wrap="truncate-end">
            <Text inverse> </Text>
            <Text dimColor>{placeholder}</Text>
          </Text>
        ) : (
          visible.map((line, index) => (
            <EditorLine
              key={viewportStart + index}
              line={line}
              cursorCol={viewportStart + index === state.row ? state.col : null}
            />
          ))
        )}
        {hiddenBelow > 0 ? (
          <Text dimColor>{`… ${hiddenBelow} more lines below`}</Text>
        ) : null}
      </Box>
      {warning === null ? (
        <Text dimColor>{hint}</Text>
      ) : (
        <Text color={theme.warn}>{warning}</Text>
      )}
    </Box>
  );
}
