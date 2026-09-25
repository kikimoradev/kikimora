import type { Key } from "ink";

export interface LineState {
  value: string;
  cursor: number;
}

export type LineEdit = (state: LineState) => LineState;

const WORD_CHAR = /[\p{L}\p{N}_]/u;

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && WORD_CHAR.test(char);
}

export function wordStartBefore(value: string, cursor: number): number {
  let index = cursor;
  while (index > 0 && !isWordChar(value[index - 1])) index -= 1;
  while (index > 0 && isWordChar(value[index - 1])) index -= 1;
  return index;
}

export function wordEndAfter(value: string, cursor: number): number {
  let index = cursor;
  while (index < value.length && !isWordChar(value[index])) index += 1;
  while (index < value.length && isWordChar(value[index])) index += 1;
  return index;
}

interface LineEdits {
  insert: (text: string) => LineEdit;
  deleteBefore: LineEdit;
  deleteAfter: LineEdit;
  deleteWordBefore: LineEdit;
  deleteWordAfter: LineEdit;
  killToStart: LineEdit;
  killToEnd: LineEdit;
  left: LineEdit;
  right: LineEdit;
  wordLeft: LineEdit;
  wordRight: LineEdit;
  home: LineEdit;
  end: LineEdit;
}

export const lineEdits: LineEdits = {
  insert:
    (text: string): LineEdit =>
    ({ value, cursor }) => ({
      value: value.slice(0, cursor) + text + value.slice(cursor),
      cursor: cursor + text.length,
    }),
  deleteBefore: ({ value, cursor }) =>
    cursor === 0
      ? { value, cursor }
      : { value: value.slice(0, cursor - 1) + value.slice(cursor), cursor: cursor - 1 },
  deleteAfter: ({ value, cursor }) => ({
    value: value.slice(0, cursor) + value.slice(cursor + 1),
    cursor,
  }),
  deleteWordBefore: ({ value, cursor }) => {
    const start = wordStartBefore(value, cursor);
    return { value: value.slice(0, start) + value.slice(cursor), cursor: start };
  },
  deleteWordAfter: ({ value, cursor }) => ({
    value: value.slice(0, cursor) + value.slice(wordEndAfter(value, cursor)),
    cursor,
  }),
  killToStart: ({ value, cursor }) => ({ value: value.slice(cursor), cursor: 0 }),
  killToEnd: ({ value, cursor }) => ({ value: value.slice(0, cursor), cursor }),
  left: ({ value, cursor }) => ({ value, cursor: Math.max(0, cursor - 1) }),
  right: ({ value, cursor }) => ({ value, cursor: Math.min(value.length, cursor + 1) }),
  wordLeft: ({ value, cursor }) => ({ value, cursor: wordStartBefore(value, cursor) }),
  wordRight: ({ value, cursor }) => ({ value, cursor: wordEndAfter(value, cursor) }),
  home: ({ value }) => ({ value, cursor: 0 }),
  end: ({ value }) => ({ value, cursor: value.length }),
};

export function readlineEdit(input: string, key: Key): LineEdit | undefined {
  if (key.ctrl) {
    switch (input) {
      case "a":
        return lineEdits.home;
      case "e":
        return lineEdits.end;
      case "u":
        return lineEdits.killToStart;
      case "k":
        return lineEdits.killToEnd;
      case "w":
        return lineEdits.deleteWordBefore;
      case "b":
        return lineEdits.left;
      case "f":
        return lineEdits.right;
      default:
        return undefined;
    }
  }
  if (key.meta) {
    if (key.leftArrow || input === "b") return lineEdits.wordLeft;
    if (key.rightArrow || input === "f") return lineEdits.wordRight;
    if (key.backspace) return lineEdits.deleteWordBefore;
    if (input === "d") return lineEdits.deleteWordAfter;
    return undefined;
  }
  if (key.backspace) return lineEdits.deleteBefore;
  if (key.delete) return lineEdits.deleteAfter;
  if (key.leftArrow) return lineEdits.left;
  if (key.rightArrow) return lineEdits.right;
  if (key.home) return lineEdits.home;
  if (key.end) return lineEdits.end;
  return undefined;
}
