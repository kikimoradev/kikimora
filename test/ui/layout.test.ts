import { describe, expect, it } from "vitest";
import { computeLayout, MIN_CONTENT_ROWS } from "../../src/ui/layout.js";

const base = {
  rows: 30,
  columns: 120,
  interactive: true,
  editing: false,
  menuRows: 0,
  bannerRows: 0,
};

describe("computeLayout", () => {
  it("leaves the header, the prompt and the status bar outside the content", () => {
    expect(computeLayout(base)).toEqual({
      contentHeight: 25,
      narrow: false,
      showPrompt: true,
      showStatusBar: true,
    });
  });

  it("gives the menu and the banners their rows", () => {
    expect(computeLayout({ ...base, menuRows: 3, bannerRows: 2 }).contentHeight).toBe(20);
  });

  it("gives the editor everything but the header", () => {
    expect(computeLayout({ ...base, editing: true })).toMatchObject({
      contentHeight: 29,
      showPrompt: false,
      showStatusBar: false,
    });
  });

  it("keeps the status bar without a prompt when input is not interactive", () => {
    expect(computeLayout({ ...base, interactive: false })).toMatchObject({
      contentHeight: 28,
      showPrompt: false,
      showStatusBar: true,
    });
  });

  it("switches to the narrow layout below 100 columns", () => {
    expect(computeLayout({ ...base, columns: 99 }).narrow).toBe(true);
    expect(computeLayout({ ...base, columns: 100 }).narrow).toBe(false);
  });

  it("never shrinks the content below the minimum", () => {
    expect(computeLayout({ ...base, rows: 5 }).contentHeight).toBe(MIN_CONTENT_ROWS);
  });
});
