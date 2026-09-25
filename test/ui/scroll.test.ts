import { describe, expect, it } from "vitest";
import { describeWindow, listWindow, maxListOffset } from "../../src/ui/scroll.js";

const rows = Array.from({ length: 10 }, (_, index) => index);

describe("listWindow", () => {
  it("shows the rows from the offset", () => {
    expect(listWindow(rows, 4, 3)).toEqual({
      visible: [3, 4, 5, 6],
      start: 3,
      total: 10,
      capacity: 4,
    });
  });

  it("clamps the offset to the last full page and to zero", () => {
    expect(listWindow(rows, 4, 99).start).toBe(6);
    expect(listWindow(rows, 4, -5).start).toBe(0);
  });

  it("keeps room for at least one row", () => {
    expect(listWindow(rows, 0, 0).visible).toEqual([0]);
  });

  it("computes the largest useful offset", () => {
    expect(maxListOffset(10, 4)).toBe(6);
    expect(maxListOffset(3, 4)).toBe(0);
  });
});

describe("describeWindow", () => {
  it("describes the visible range only when the list overflows", () => {
    expect(describeWindow(listWindow(rows, 4, 3))).toBe("4–7 of 10 · pgup/pgdn");
    expect(describeWindow(listWindow(rows, 20, 0))).toBeUndefined();
  });
});
