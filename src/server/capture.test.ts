import { describe, expect, it } from "vitest";
import { calculateAdaptiveScale, calculateSlices } from "./capture.js";

describe("screenshot A4 pagination", () => {
  it("fits a small trailing fragment onto the preceding page with subtle scaling", () => {
    const scale = calculateAdaptiveScale(2_180, 1_000);
    expect(scale).toBeCloseTo(0.899, 2);

    const slices = calculateSlices({
      x: 0,
      y: 0,
      width: 1_280,
      height: 2_180,
      blockBounds: []
    }, 1_000 / scale);
    expect(slices).toHaveLength(2);
  });

  it("does not shrink long articles aggressively", () => {
    expect(calculateAdaptiveScale(2_450, 1_000)).toBe(1);
  });

  it("moves a page boundary above a crossing text line", () => {
    const slices = calculateSlices({
      x: 0,
      y: 0,
      width: 1_280,
      height: 1_800,
      blockBounds: [{ top: 990, bottom: 1_015 }]
    }, 1_000);
    expect(slices[0]?.height).toBe(986);
    expect(slices.reduce((sum, slice) => sum + slice.height, 0)).toBe(1_800);
  });

  it("does not create a nearly-empty final page after a text-aware boundary", () => {
    const slices = calculateSlices({
      x: 300,
      y: 2_000,
      width: 677,
      height: 1_034,
      blockBounds: [{ top: 2_980, bottom: 3_010 }]
    }, 1_000);

    expect(slices).toEqual([{ top: 2_000, height: 1_034 }]);
  });

  it("does not let repeated text-aware adjustments add an extra toolbar-only page", () => {
    const slices = calculateSlices({
      x: 300,
      y: 20,
      width: 677,
      height: 3_080,
      blockBounds: [
        { top: 1_005, bottom: 1_035 },
        { top: 1_985, bottom: 2_015 },
        { top: 3_010, bottom: 3_075 }
      ]
    }, 1_030);

    expect(slices).toHaveLength(3);
    expect(slices.every((slice) => slice.height <= 1_030)).toBe(true);
    expect(slices.reduce((sum, slice) => sum + slice.height, 0)).toBe(3_080);
  });
});
