import { describe, expect, it } from "vitest";
import {
  MAX_ANIMATED_MOVE_STEPS,
  moveStepDistance,
  stepsAlongPath,
} from "../src/hooks/useTokenAnimation";

describe("token animation path", () => {
  it("yard release is one hop to the entry cell, not 0..to", () => {
    expect(stepsAlongPath(-1, 0)).toEqual([0]);
    expect(stepsAlongPath(-1, 6)).toEqual([6]);
    expect(moveStepDistance(-1, 0)).toBe(1);
    expect(moveStepDistance(-1, 6)).toBe(1);
  });

  it("walks six board cells for a six-step move without crossing snap threshold", () => {
    expect(stepsAlongPath(4, 10)).toEqual([5, 6, 7, 8, 9, 10]);
    expect(moveStepDistance(4, 10)).toBe(6);
    expect(moveStepDistance(4, 10)).toBeLessThanOrEqual(
      MAX_ANIMATED_MOVE_STEPS,
    );
  });

  it("treats seven or more board cells as over the snap threshold", () => {
    expect(moveStepDistance(3, 10)).toBe(7);
    expect(moveStepDistance(3, 10)).toBeGreaterThan(
      MAX_ANIMATED_MOVE_STEPS,
    );
  });
});
