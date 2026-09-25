import { Box, Text } from "ink";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { Panel, PanelTitle } from "../../src/ui/panel.js";

describe("Panel", () => {
  it("writes the title and the aside into the top border", () => {
    const { lastFrame, unmount } = render(
      <Box width={40}>
        <Panel title="Tasks" aside={<Text>3 running</Text>} grow>
          <Text>row</Text>
        </Panel>
      </Box>,
    );
    const lines = (lastFrame() ?? "").split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^╭─ Tasks ─+ 3 running ─╮$/);
    expect(lines[1]).toMatch(/^│ row +│$/);
    expect(lines[2]).toMatch(/^╰─+╯$/);
    expect(lines.every((line) => line.length === 40)).toBe(true);
    unmount();
  });

  it("writes the footer into the bottom border", () => {
    const { lastFrame, unmount } = render(
      <Panel
        title="Monitor"
        footer={<Text>✔ cycle #1</Text>}
        footerAside={<Text>3.7s</Text>}
        width={30}
        height={4}
      >
        <Text>body</Text>
      </Panel>,
    );
    const lines = (lastFrame() ?? "").split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[3]).toBe("╰─ ✔ cycle #1 ──────── 3.7s ─╯");
    unmount();
  });

  it("truncates a title that does not fit instead of wrapping it", () => {
    const { lastFrame, unmount } = render(
      <Panel title="A very long panel title that cannot fit" width={24}>
        <Text>x</Text>
      </Panel>,
    );
    const top = (lastFrame() ?? "").split("\n")[0] ?? "";
    expect(top).toMatch(/^╭─ A very long .*…/);
    expect(top.length).toBe(24);
    unmount();
  });

  it("renders a subtitle next to the title", () => {
    const { lastFrame, unmount } = render(
      <Panel
        title={<PanelTitle subtitle="sonnet · medium">Monitor</PanelTitle>}
        width={40}
      >
        <Text>x</Text>
      </Panel>,
    );
    expect(lastFrame()).toContain("╭─ Monitor  sonnet · medium ─");
    unmount();
  });
});
