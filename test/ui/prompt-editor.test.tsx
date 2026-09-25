import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import {
  cursorRowIndex,
  PromptEditor,
  visualRows,
  type PromptEditorProps,
} from "../../src/ui/prompt-editor.js";
import { eventually, inputReady, makeStdinLossless } from "../helpers.js";

const ARROW_UP = "\u001B[A";
const ARROW_DOWN = "\u001B[B";
const ARROW_RIGHT = "\u001B[C";
const ARROW_LEFT = "\u001B[D";
const HOME = "\u001B[H";
const END = "\u001B[F";
const ESCAPE = "\u001B";
const BACKSPACE = "\u007F";
const CTRL_C = "\u0003";
const CTRL_D = "\u0004";
const ENTER = "\r";
const TAB = "\t";
const DELETE = "\u001B[3~";
const CTRL_A = "\u0001";
const CTRL_E = "\u0005";
const CTRL_K = "\u000B";
const CTRL_U = "\u0015";
const CTRL_W = "\u0017";

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

async function editor(overrides: Partial<PromptEditorProps> = {}) {
  const onSubmit = vi.fn();
  const onCancel = vi.fn();
  const rendered = render(
    <PromptEditor
      title="What should the monitor watch?"
      step="1/2"
      onSubmit={onSubmit}
      onCancel={onCancel}
      {...overrides}
    />,
  );
  makeStdinLossless(rendered.stdin);
  await inputReady(rendered.stdin);
  const type = async (data: string) => {
    rendered.stdin.write(data);
    await tick();
  };
  return { ...rendered, onSubmit, onCancel, type };
}

describe("PromptEditor", () => {
  it("shows the title and step in the border, the placeholder and the key hints", async () => {
    const { lastFrame, unmount } = await editor({
      placeholder: "e.g. GitHub issues",
      description: "where to look",
    });
    const frame = lastFrame() ?? "";
    expect(frame).toMatch(/╭─ What should the monitor watch\? ─+ 1\/2 ─╮/);
    expect(frame).toMatch(/╰─ where to look ─+╯/);
    expect(frame).toContain("e.g. GitHub issues");
    expect(frame).toContain("enter new line · ctrl+d submit · esc cancel");
    expect(frame).toContain("1 line · 0 chars");
    unmount();
  });

  it("names the submit and cancel actions it was given", async () => {
    const { lastFrame, unmount } = await editor({
      submitLabel: "save",
      cancelLabel: "close without saving",
    });
    expect(lastFrame()).toContain("ctrl+d save · esc close without saving");
    unmount();
  });

  it("marks unsaved changes when there is no step", async () => {
    const { lastFrame, type, unmount } = await editor({
      step: undefined,
      initialValue: "saved",
    });
    expect(lastFrame()).not.toContain("modified");
    await type("!");
    await eventually(() => {
      expect(lastFrame()).toContain("modified");
    });
    expect(lastFrame()).toContain("1 line · 6 chars");
    unmount();
  });

  it("fills the given height even with little content", async () => {
    const { lastFrame, unmount } = await editor({ maxVisibleLines: 6, fill: true });
    expect((lastFrame() ?? "").split("\n")).toHaveLength(9);
    unmount();
  });

  it("types text and hides the placeholder", async () => {
    const { lastFrame, type, unmount } = await editor({ placeholder: "gone" });
    await type("watch issues");
    await eventually(() => {
      expect(lastFrame()).toContain("watch issues");
    });
    expect(lastFrame()).not.toContain("gone");
    unmount();
  });

  it("wraps long lines instead of truncating them", async () => {
    const { lastFrame, onSubmit, type, unmount } = await editor();
    const long = `${"a".repeat(120)}END`;
    await type(long);
    await eventually(() => {
      expect(lastFrame()).toContain("END");
    });
    expect(lastFrame()).not.toContain("…");
    await type(CTRL_D);
    await eventually(() => {
      expect(onSubmit).toHaveBeenCalledWith(long);
    });
    unmount();
  });

  it("Enter inserts a new line instead of submitting", async () => {
    const { lastFrame, onSubmit, type, unmount } = await editor();
    await type("first");
    await type(ENTER);
    await type("second");
    expect(onSubmit).not.toHaveBeenCalled();
    await eventually(() => {
      expect(lastFrame()).toContain("second");
    });
    expect(lastFrame()).toContain("first");
    unmount();
  });

  it("a pasted chunk with \\r and \\r\\n becomes multiple lines", async () => {
    const { lastFrame, onSubmit, type, unmount } = await editor();
    await type("# Role\rBe diligent\r\n- rule one");
    await eventually(() => {
      expect(lastFrame()).toContain("- rule one");
    });
    expect(lastFrame()).toContain("# Role");
    expect(lastFrame()).toContain("Be diligent");
    await type(CTRL_D);
    await eventually(() => {
      expect(onSubmit).toHaveBeenCalledWith("# Role\nBe diligent\n- rule one");
    });
    unmount();
  });

  it("filters stray bracketed paste markers", async () => {
    const { lastFrame, type, unmount } = await editor();
    await type("[200~");
    await type("safe");
    await type("[201~");
    await eventually(() => {
      expect(lastFrame()).toContain("safe");
    });
    expect(lastFrame()).not.toContain("[200~");
    expect(lastFrame()).not.toContain("[201~");
    unmount();
  });

  it("backspace joins lines at the start of a line", async () => {
    const { lastFrame, onSubmit, type, unmount } = await editor();
    await type("ab");
    await type(ENTER);
    await type("cd");
    await type(HOME);
    await type(BACKSPACE);
    await type(END);
    await eventually(() => {
      expect(lastFrame()).toContain("abcd");
    });
    await type(CTRL_D);
    await eventually(() => {
      expect(onSubmit).toHaveBeenCalledWith("abcd");
    });
    unmount();
  });

  it("moves across line boundaries with arrows and edits mid-text", async () => {
    const { onSubmit, type, unmount } = await editor();
    await type("one");
    await type(ENTER);
    await type("two");
    await type(ARROW_UP);
    await type(END);
    await type(ARROW_RIGHT);
    await type("X");
    await type(ARROW_LEFT);
    await type(ARROW_LEFT);
    await type("Y");
    await type(ARROW_DOWN);
    await type(CTRL_D);
    await eventually(() => {
      expect(onSubmit).toHaveBeenCalledWith("oneY\nXtwo");
    });
    unmount();
  });

  it("tab inserts two spaces", async () => {
    const { onSubmit, type, unmount } = await editor();
    await type("a");
    await type(TAB);
    await type("b");
    await type(CTRL_D);
    await eventually(() => {
      expect(onSubmit).toHaveBeenCalledWith("a  b");
    });
    unmount();
  });

  it("keeps the cursor visible in a limited viewport", async () => {
    const { lastFrame, type, unmount } = await editor({ maxVisibleLines: 3 });
    await type("l1\rl2\rl3\rl4\rl5");
    await eventually(() => {
      expect(lastFrame()).toContain("↑ 2 more · 1/2");
    });
    await type(ARROW_UP);
    await type(ARROW_UP);
    await type(ARROW_UP);
    await type(ARROW_UP);
    await eventually(() => {
      expect(lastFrame()).toContain("↓ 2 more");
    });
    expect(lastFrame()).not.toContain("↑ 2 more");
    unmount();
  });

  it("counts wrapped rows in the viewport so the frame never outgrows it", async () => {
    const { lastFrame, type, unmount } = await editor({ maxVisibleLines: 3, width: 24 });
    await type("x".repeat(100));
    await eventually(() => {
      expect(lastFrame()).toContain("↑ 3 more");
    });
    expect((lastFrame() ?? "").split("\n")).toHaveLength(6);
    unmount();
  });

  it("moves up and down through the rows of a wrapped line", async () => {
    const { onSubmit, type, unmount } = await editor({ width: 14 });
    await type("abcdefghijklmnopqrst");
    await type(ARROW_UP);
    await type("^");
    await type(ARROW_DOWN);
    await type("$");
    await type(CTRL_D);
    await eventually(() => {
      expect(onSubmit).toHaveBeenCalledWith("abcdefghij^klmnopqrst$");
    });
    unmount();
  });

  it("supports readline keys within a line", async () => {
    const { onSubmit, type, unmount } = await editor();
    await type("keep drop this");
    await type(CTRL_W);
    await type(CTRL_W);
    await type(CTRL_A);
    await type(">");
    await type(CTRL_E);
    await type("!");
    await type(ENTER);
    await type("gone");
    await type(CTRL_U);
    await type("tail cut");
    await type(ARROW_LEFT);
    await type(ARROW_LEFT);
    await type(ARROW_LEFT);
    await type(CTRL_K);
    await type(CTRL_D);
    await eventually(() => {
      expect(onSubmit).toHaveBeenCalledWith(">keep !\ntail");
    });
    unmount();
  });

  it("forward delete removes the next character and joins at the end of a line", async () => {
    const { onSubmit, type, unmount } = await editor();
    await type("ab");
    await type(ENTER);
    await type("cd");
    await type(ARROW_UP);
    await type(END);
    await type(DELETE);
    await type(HOME);
    await type(DELETE);
    await type(CTRL_D);
    await eventually(() => {
      expect(onSubmit).toHaveBeenCalledWith("bcd");
    });
    unmount();
  });

  it("starts from the initial value with the cursor at the end", async () => {
    const { lastFrame, onSubmit, type, unmount } = await editor({
      initialValue: "existing\ncontent",
    });
    expect(lastFrame()).toContain("existing");
    await type("!");
    await type(CTRL_D);
    await eventually(() => {
      expect(onSubmit).toHaveBeenCalledWith("existing\ncontent!");
    });
    unmount();
  });

  it("refuses to submit empty content and shows a warning", async () => {
    const { lastFrame, onSubmit, type, unmount } = await editor();
    await type(CTRL_D);
    expect(onSubmit).not.toHaveBeenCalled();
    await eventually(() => {
      expect(lastFrame()).toContain("enter at least one line");
    });
    await type("now filled");
    await eventually(() => {
      expect(lastFrame()).toContain("enter new line");
    });
    unmount();
  });

  it("trims trailing whitespace on submit", async () => {
    const { onSubmit, type, unmount } = await editor();
    await type("text");
    await type(ENTER);
    await type(ENTER);
    await type(CTRL_D);
    await eventually(() => {
      expect(onSubmit).toHaveBeenCalledWith("text");
    });
    unmount();
  });

  it("cancels on Esc and on Ctrl+C", async () => {
    const first = await editor();
    await first.type(ESCAPE);
    await eventually(() => {
      expect(first.onCancel).toHaveBeenCalledTimes(1);
    });
    first.unmount();

    const second = await editor();
    await second.type(CTRL_C);
    await eventually(() => {
      expect(second.onCancel).toHaveBeenCalledTimes(1);
    });
    second.unmount();
  });
});

describe("visualRows", () => {
  it("splits long lines into rows of the given width and keeps a row for the cursor", () => {
    expect(visualRows(["abcdef", ""], 3)).toEqual([
      { line: 0, start: 0, text: "abc" },
      { line: 0, start: 3, text: "def" },
      { line: 0, start: 6, text: "" },
      { line: 1, start: 0, text: "" },
    ]);
  });

  it("finds the row that holds the cursor", () => {
    const rows = visualRows(["abcdef", "gh"], 4);
    expect(cursorRowIndex(rows, { lines: ["abcdef", "gh"], row: 0, col: 5 }, 4)).toBe(1);
    expect(cursorRowIndex(rows, { lines: ["abcdef", "gh"], row: 1, col: 2 }, 4)).toBe(2);
  });
});
