import { Text } from "ink";
import { render } from "ink-testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnimationProvider, Spinner, SPINNER_INTERVAL_MS } from "../../src/ui/spinner.js";
import { SPINNER_FRAMES } from "../../src/ui/theme.js";

describe("Spinner", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("advances every spinner from one shared clock", async () => {
    vi.useFakeTimers();
    const baseline = render(<Text>idle</Text>);
    baseline.unmount();
    const idleTimers = vi.getTimerCount();
    const { lastFrame, unmount } = render(
      <>
        <Spinner />
        <Spinner color="cyan" />
      </>,
    );
    const first = lastFrame();
    await vi.advanceTimersByTimeAsync(SPINNER_INTERVAL_MS);
    const second = lastFrame() ?? "";
    expect(second).not.toBe(first);
    const [top, bottom] = second.split("\n");
    expect(top).toBe(bottom);
    expect(SPINNER_FRAMES).toContain(top);
    unmount();
    expect(vi.getTimerCount()).toBe(idleTimers);
  });

  it("holds the first frame when animation is off", async () => {
    vi.useFakeTimers();
    const { lastFrame, unmount } = render(
      <AnimationProvider value={false}>
        <Spinner />
      </AnimationProvider>,
    );
    const timers = vi.getTimerCount();
    await vi.advanceTimersByTimeAsync(SPINNER_INTERVAL_MS * 3);
    expect(lastFrame()).toBe(SPINNER_FRAMES[0]);
    expect(vi.getTimerCount()).toBeLessThanOrEqual(timers);
    unmount();
  });
});
