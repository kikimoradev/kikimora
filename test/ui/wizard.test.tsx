import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { Wizard, type WizardProps } from "../../src/ui/wizard.js";
import { eventually, inputReady, makeStdinLossless } from "../helpers.js";

const ESCAPE = "\u001B";
const CTRL_D = "\u0004";

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

async function wizard(overrides: Partial<WizardProps> = {}) {
  const onComplete = vi.fn();
  const rendered = render(<Wizard onComplete={onComplete} {...overrides} />);
  makeStdinLossless(rendered.stdin);
  await inputReady(rendered.stdin);
  const type = async (data: string) => {
    rendered.stdin.write(data);
    await tick();
  };
  return { ...rendered, onComplete, type };
}

describe("Wizard", () => {
  it("collects both prompts across two steps", async () => {
    const { lastFrame, onComplete, type, unmount } = await wizard();

    expect(lastFrame()).toContain("Kikimora setup");
    expect(lastFrame()).toContain("What should the monitor watch?");
    expect(lastFrame()).toContain("step 1/2");

    await type("watch GitHub issues");
    await type(CTRL_D);

    await eventually(() => {
      expect(lastFrame()).toContain(
        "Who is the executor and how should it complete tasks?",
      );
    });
    expect(lastFrame()).toContain("step 2/2");
    expect(onComplete).not.toHaveBeenCalled();

    await type("a diligent engineer");
    await type(CTRL_D);

    await eventually(() => {
      expect(onComplete).toHaveBeenCalledWith({
        monitorPrompt: "watch GitHub issues",
        executorPrompt: "a diligent engineer",
      });
    });
    unmount();
  });

  it("pre-fills both editors from the initial values", async () => {
    const { lastFrame, onComplete, type, unmount } = await wizard({
      initialMonitorPrompt: "existing monitor prompt",
      initialExecutorPrompt: "existing executor prompt",
    });

    expect(lastFrame()).toContain("existing monitor prompt");
    await type(CTRL_D);
    await eventually(() => {
      expect(lastFrame()).toContain("existing executor prompt");
    });
    await type(CTRL_D);

    await eventually(() => {
      expect(onComplete).toHaveBeenCalledWith({
        monitorPrompt: "existing monitor prompt",
        executorPrompt: "existing executor prompt",
      });
    });
    unmount();
  });

  it("cancelling the first step completes with null", async () => {
    const { onComplete, type, unmount } = await wizard();
    await type(ESCAPE);
    await eventually(() => {
      expect(onComplete).toHaveBeenCalledWith(null);
    });
    unmount();
  });

  it("cancelling the second step completes with null", async () => {
    const { onComplete, type, unmount } = await wizard();
    await type("monitor prompt");
    await type(CTRL_D);
    await type(ESCAPE);
    await eventually(() => {
      expect(onComplete).toHaveBeenCalledWith(null);
    });
    unmount();
  });
});
