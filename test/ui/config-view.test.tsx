import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { ConfigView } from "../../src/ui/views/config-view.js";
import { buildConfig } from "../helpers.js";

describe("ConfigView", () => {
  it("shows no shutdown grace by default", () => {
    const { lastFrame, unmount } = render(
      <ConfigView config={buildConfig()} height={40} />,
    );

    expect(lastFrame()).toContain("shutdown grace    none");
    unmount();
  });

  it("shows the shutdown grace SIGTERM gets", () => {
    const { lastFrame, unmount } = render(
      <ConfigView config={buildConfig({ shutdownGraceMs: 120_000 })} height={40} />,
    );

    expect(lastFrame()).toContain("shutdown grace    2 min");
    unmount();
  });
});
