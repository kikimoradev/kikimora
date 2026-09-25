import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { WorkerStatusStore } from "../../src/status.js";
import { AnimationProvider } from "../../src/ui/spinner.js";
import {
  DashboardView,
  type DashboardViewProps,
} from "../../src/ui/views/dashboard-view.js";
import { buildConfig } from "../helpers.js";

function renderDashboard(overrides: Partial<DashboardViewProps> = {}) {
  const store = new WorkerStatusStore({ notifyDelayMs: 0 });
  store.executor.session({ type: "text", text: "EXECUTOR_TAIL" });
  store.monitor.session({ type: "text", text: "MONITOR_TAIL" });
  store.flush();
  const rendered = render(
    <AnimationProvider value={false}>
      <DashboardView
        status={store.getSnapshot()}
        config={buildConfig()}
        width={100}
        height={20}
        now={Date.now()}
        interactive
        narrow={false}
        focusedPanel="monitor"
        scrollOffsets={{ monitor: 0, executor: 0 }}
        expanded={false}
        {...overrides}
      />
    </AnimationProvider>,
  );
  return { ...rendered, store };
}

describe("DashboardView", () => {
  it("puts both agents side by side, each with its model in the border", () => {
    const { lastFrame, store, unmount } = renderDashboard();
    const frame = lastFrame() ?? "";
    expect(frame).toMatch(
      /╭─ Monitor {2}haiku · medium · every 5 min ─+╮╭─ Executor {2}opus · high ─+╮/,
    );
    expect(frame).toContain("MONITOR_TAIL");
    expect(frame).toContain("EXECUTOR_TAIL");
    unmount();
    store.dispose();
  });

  it("shows only the focused agent with tabs in the narrow layout", () => {
    const { lastFrame, store, unmount } = renderDashboard({
      narrow: true,
      focusedPanel: "executor",
      width: 80,
    });
    const frame = lastFrame() ?? "";
    expect(frame).toContain("╭─ Monitor │ Executor  opus · high ─");
    expect(frame).toContain("EXECUTOR_TAIL");
    expect(frame).not.toContain("MONITOR_TAIL");
    unmount();
    store.dispose();
  });
});
