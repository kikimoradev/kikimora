import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { configRows, ConfigView } from "../../src/ui/views/config-view.js";
import { buildConfig } from "../helpers.js";

describe("ConfigView", () => {
  it("shows no shutdown grace by default", () => {
    const { lastFrame, unmount } = render(
      <ConfigView config={buildConfig()} width={100} height={40} />,
    );

    expect(lastFrame()).toContain("shutdown grace   none");
    unmount();
  });

  it("shows the shutdown grace SIGTERM gets", () => {
    const { lastFrame, unmount } = render(
      <ConfigView
        config={buildConfig({ shutdownGraceMs: 120_000 })}
        width={100}
        height={40}
      />,
    );

    expect(lastFrame()).toContain("shutdown grace   2 min");
    unmount();
  });

  it("names the command that changes an entry and the settings file", () => {
    const { lastFrame, unmount } = render(
      <ConfigView config={buildConfig()} width={100} height={40} />,
    );

    const frame = lastFrame() ?? "";
    expect(frame).toMatch(/model +haiku +\/model monitor/);
    expect(frame).toMatch(/interval +every 5 min +\/interval/);
    expect(frame).toContain(".kikimora/settings.json");
    unmount();
  });

  it("lays sections out in two columns on a wide terminal", () => {
    const narrow = configRows(buildConfig(), 100);
    const wide = configRows(buildConfig(), 140);
    expect(narrow.every((row) => row.length <= 1)).toBe(true);
    expect(wide.some((row) => row.length === 2)).toBe(true);
    expect(wide.length).toBeLessThan(narrow.length);
  });

  it("scrolls instead of silently cutting entries off", () => {
    const { lastFrame, unmount } = render(
      <ConfigView config={buildConfig()} width={100} height={10} offset={30} />,
    );

    const frame = lastFrame() ?? "";
    expect(frame).toMatch(/of \d+ · pgup\/pgdn/);
    expect(frame).toContain("mcp servers");
    expect(frame).not.toContain("Monitor");
    unmount();
  });
});
