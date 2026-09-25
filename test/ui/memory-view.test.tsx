import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import type { TaskSummaryRecord } from "../../src/memory/store.js";
import { MemoryView } from "../../src/ui/views/memory-view.js";

const now = Date.parse("2026-07-02T12:00:00Z");

function record(overrides: Partial<TaskSummaryRecord> = {}): TaskSummaryRecord {
  return {
    id: 1,
    taskId: "t-1",
    attempt: 1,
    ok: true,
    title: "Title",
    headline: "Cleaned the repository",
    summary: "",
    error: undefined,
    sessionId: undefined,
    createdAt: new Date(now - 3 * 3_600_000).toISOString(),
    ...overrides,
  };
}

describe("MemoryView", () => {
  it("aligns the task ids and shows failures and retries", () => {
    const { lastFrame, unmount } = render(
      <MemoryView
        entries={[
          record(),
          record({
            id: 2,
            taskId: "gh-1024",
            ok: false,
            attempt: 2,
            headline: "Gave up",
          }),
        ]}
        height={8}
        now={now}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toMatch(/✔ t-1 {6}Cleaned the repository +3h ago/);
    expect(frame).toMatch(/✖ gh-1024 {2}Gave up +attempt 2 · 3h ago/);
    unmount();
  });

  it("explains an empty memory and an empty search", () => {
    const empty = render(<MemoryView entries={[]} height={6} now={now} />);
    expect(empty.lastFrame()).toContain("no memory entries yet");
    empty.unmount();

    const search = render(
      <MemoryView entries={[]} query="deploy" height={6} now={now} />,
    );
    expect(search.lastFrame()).toContain('Memory  search "deploy" · 0 results');
    expect(search.lastFrame()).toContain("no matching entries");
    search.unmount();
  });

  it("scrolls through more entries than fit", () => {
    const entries = Array.from({ length: 12 }, (_, index) =>
      record({
        id: index,
        taskId: `t-${String(index)}`,
        headline: `Entry ${String(index)}`,
      }),
    );
    const { lastFrame, unmount } = render(
      <MemoryView entries={entries} height={6} now={now} offset={8} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("9–12 of 12 · pgup/pgdn");
    expect(frame).toContain("Entry 11");
    expect(frame).not.toContain("Entry 0 ");
    unmount();
  });
});
