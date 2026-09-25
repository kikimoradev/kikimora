import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { COMMAND_GROUPS } from "../../src/ui/commands.js";
import { helpColumns, helpRows, HelpView } from "../../src/ui/views/help-view.js";

describe("HelpView", () => {
  it("groups the commands under their sections", () => {
    const { lastFrame, unmount } = render(<HelpView width={100} height={80} />);
    const frame = lastFrame() ?? "";
    for (const group of COMMAND_GROUPS) expect(frame).toContain(group);
    expect(frame).toMatch(/\/model <agent> <model> +set the model/);
    expect(frame).toMatch(/ctrl\+w +delete the previous word/);
    unmount();
  });

  it("puts the keys next to the commands on a wide terminal", () => {
    expect(helpColumns(100)).toHaveLength(1);
    expect(helpColumns(160)).toHaveLength(2);
    const wide = helpRows(160);
    expect(wide.some((row) => row[1]?.kind === "title")).toBe(true);
    expect(wide.length).toBeLessThan(helpRows(100).length);
  });
});
