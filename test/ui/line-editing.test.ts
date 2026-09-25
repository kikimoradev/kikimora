import type { Key } from "ink";
import { describe, expect, it } from "vitest";
import {
  lineEdits,
  readlineEdit,
  wordEndAfter,
  wordStartBefore,
  type LineState,
} from "../../src/ui/line-editing.js";

function key(overrides: Partial<Key> = {}): Key {
  return {
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    pageDown: false,
    pageUp: false,
    home: false,
    end: false,
    return: false,
    escape: false,
    ctrl: false,
    shift: false,
    tab: false,
    backspace: false,
    delete: false,
    meta: false,
    super: false,
    hyper: false,
    capsLock: false,
    numLock: false,
    ...overrides,
  };
}

const at = (value: string, cursor: number): LineState => ({ value, cursor });

describe("word boundaries", () => {
  it("skips separators, then the word before the cursor", () => {
    expect(wordStartBefore("/memory deploy  ", 16)).toBe(8);
    expect(wordStartBefore("/memory deploy", 8)).toBe(1);
    expect(wordStartBefore("", 0)).toBe(0);
  });

  it("skips separators, then the word after the cursor", () => {
    expect(wordEndAfter("fix the  deploy", 3)).toBe(7);
    expect(wordEndAfter("fix", 3)).toBe(3);
  });

  it("treats letters with diacritics as word characters", () => {
    expect(wordStartBefore("zażółć gęślą", 12)).toBe(7);
  });
});

describe("lineEdits", () => {
  it("inserts at the cursor", () => {
    expect(lineEdits.insert("XY")(at("abcd", 2))).toEqual(at("abXYcd", 4));
  });

  it("deletes before and after the cursor", () => {
    expect(lineEdits.deleteBefore(at("abcd", 2))).toEqual(at("acd", 1));
    expect(lineEdits.deleteBefore(at("abcd", 0))).toEqual(at("abcd", 0));
    expect(lineEdits.deleteAfter(at("abcd", 2))).toEqual(at("abd", 2));
    expect(lineEdits.deleteAfter(at("abcd", 4))).toEqual(at("abcd", 4));
  });

  it("deletes whole words", () => {
    expect(lineEdits.deleteWordBefore(at("fix the deploy", 14))).toEqual(
      at("fix the ", 8),
    );
    expect(lineEdits.deleteWordAfter(at("fix the deploy", 3))).toEqual(
      at("fix deploy", 3),
    );
  });

  it("kills to either end of the line", () => {
    expect(lineEdits.killToStart(at("abcd", 2))).toEqual(at("cd", 0));
    expect(lineEdits.killToEnd(at("abcd", 2))).toEqual(at("ab", 2));
  });

  it("moves the cursor within bounds", () => {
    expect(lineEdits.left(at("ab", 0))).toEqual(at("ab", 0));
    expect(lineEdits.right(at("ab", 2))).toEqual(at("ab", 2));
    expect(lineEdits.wordLeft(at("one two", 7))).toEqual(at("one two", 4));
    expect(lineEdits.wordRight(at("one two", 0))).toEqual(at("one two", 3));
    expect(lineEdits.home(at("ab", 1))).toEqual(at("ab", 0));
    expect(lineEdits.end(at("ab", 1))).toEqual(at("ab", 2));
  });
});

describe("readlineEdit", () => {
  const state = at("one two", 4);

  it("maps the ctrl shortcuts", () => {
    expect(readlineEdit("a", key({ ctrl: true }))?.(state)).toEqual(at("one two", 0));
    expect(readlineEdit("e", key({ ctrl: true }))?.(state)).toEqual(at("one two", 7));
    expect(readlineEdit("u", key({ ctrl: true }))?.(state)).toEqual(at("two", 0));
    expect(readlineEdit("k", key({ ctrl: true }))?.(state)).toEqual(at("one ", 4));
    expect(readlineEdit("w", key({ ctrl: true }))?.(state)).toEqual(at("two", 0));
    expect(readlineEdit("b", key({ ctrl: true }))?.(state)).toEqual(at("one two", 3));
    expect(readlineEdit("f", key({ ctrl: true }))?.(state)).toEqual(at("one two", 5));
    expect(readlineEdit("x", key({ ctrl: true }))).toBeUndefined();
  });

  it("maps the alt shortcuts in both terminal encodings", () => {
    expect(readlineEdit("b", key({ meta: true }))?.(state)).toEqual(at("one two", 0));
    expect(readlineEdit("", key({ meta: true, leftArrow: true }))?.(state)).toEqual(
      at("one two", 0),
    );
    expect(readlineEdit("f", key({ meta: true }))?.(state)).toEqual(at("one two", 7));
    expect(readlineEdit("", key({ meta: true, rightArrow: true }))?.(state)).toEqual(
      at("one two", 7),
    );
    expect(readlineEdit("", key({ meta: true, backspace: true }))?.(state)).toEqual(
      at("two", 0),
    );
    expect(readlineEdit("d", key({ meta: true }))?.(state)).toEqual(at("one ", 4));
    expect(readlineEdit("z", key({ meta: true }))).toBeUndefined();
  });

  it("maps the plain editing keys", () => {
    expect(readlineEdit("", key({ backspace: true }))?.(state)).toEqual(at("onetwo", 3));
    expect(readlineEdit("", key({ delete: true }))?.(state)).toEqual(at("one wo", 4));
    expect(readlineEdit("", key({ leftArrow: true }))?.(state)).toEqual(at("one two", 3));
    expect(readlineEdit("", key({ rightArrow: true }))?.(state)).toEqual(
      at("one two", 5),
    );
    expect(readlineEdit("", key({ home: true }))?.(state)).toEqual(at("one two", 0));
    expect(readlineEdit("", key({ end: true }))?.(state)).toEqual(at("one two", 7));
    expect(readlineEdit("q", key())).toBeUndefined();
  });
});
