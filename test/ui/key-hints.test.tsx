import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { fitHints, hintsWidth, KeyHints, type KeyHint } from "../../src/ui/key-hints.js";

const hints: KeyHint[] = [
  ["tab", "focus"],
  ["pgup/pgdn", "scroll"],
  ["ctrl+c", "quit"],
];

describe("KeyHints", () => {
  it("renders keys with their labels", () => {
    const { lastFrame, unmount } = render(<KeyHints hints={hints} />);
    expect(lastFrame()).toBe("tab focus · pgup/pgdn scroll · ctrl+c quit");
    unmount();
  });

  it("measures the rendered width", () => {
    expect(hintsWidth(hints)).toBe("tab focus · pgup/pgdn scroll · ctrl+c quit".length);
    expect(hintsWidth([])).toBe(0);
  });

  it("drops trailing hints until they fit", () => {
    expect(fitHints(hints, 100)).toEqual(hints);
    expect(fitHints(hints, 28)).toEqual(hints.slice(0, 2));
    expect(fitHints(hints, 3)).toEqual([]);
  });
});
