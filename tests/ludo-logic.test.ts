import { describe, expect, it } from "vitest";
import {
  canRelease,
  createInitialTokens,
  decideRollOutcome,
  findCaptureTarget,
  gainsExtraTurn,
  getLegalMoves,
  hasWon,
  isBarrierAbsolute,
  nextColorAmong,
  pickNextColor,
  pickThreeSixesPenaltyToken,
  stackFanOffset,
  tryMoveSteps,
  absoluteTrackPosition,
} from "../convex/lib/ludo";
import { assertValidClientId } from "../convex/lib/session";
import { normalizeCode } from "../src/lib/player";
import {
  tokenStackKey,
  tokenSvgPosition,
} from "../src/lib/boardGeometry";

describe("release and movement", () => {
  it("requires a 6 to leave home", () => {
    expect(canRelease(6)).toBe(true);
    expect(canRelease(5)).toBe(false);
    expect(tryMoveSteps(-1, 6)).toBe(0);
    expect(tryMoveSteps(-1, 3)).toBeNull();
  });

  it("requires exact count to finish", () => {
    expect(tryMoveSteps(50, 6)).toBe(56);
    expect(tryMoveSteps(55, 2)).toBeNull();
    expect(tryMoveSteps(54, 2)).toBe(56);
  });

  it("blocks non-6 moves from the yard", () => {
    const tokens = createInitialTokens();
    expect(tokens).toHaveLength(16);
    expect(getLegalMoves(tokens, "red", 5)).toHaveLength(0);
    expect(getLegalMoves(tokens, "red", 6)).toHaveLength(4);
  });
});

describe("turn order and seating", () => {
  it("creates tokens only for seated colours", () => {
    const two = createInitialTokens(["red", "blue"]);
    expect(two).toHaveLength(8);
    expect(nextColorAmong("red", ["red", "blue"])).toBe("blue");
    expect(nextColorAmong("blue", ["red", "blue"])).toBe("red");
  });

  it("prefers opposite houses for 2-player seating", () => {
    expect(pickNextColor(["red"])).toBe("yellow");
    expect(pickNextColor(["green"])).toBe("blue");
    expect(pickNextColor(["red", "yellow"])).toBe("green");
    expect(pickNextColor(["red", "yellow", "green"])).toBe("blue");
    expect(pickNextColor(["red", "green", "yellow", "blue"])).toBeUndefined();
    expect(nextColorAmong("red", ["red", "yellow"])).toBe("yellow");
  });
});

describe("capture and barriers", () => {
  it("captures on overlapping non-safe cells", () => {
    const tokens = createInitialTokens();
    tokens[0]!.steps = 5;
    const green = tokens.find((t) => t.color === "green" && t.index === 0)!;
    green.steps = 44;
    expect(findCaptureTarget(tokens, "red", 5)?.color).toBe("green");
  });

  it("does not capture on safe cells", () => {
    const tokens = createInitialTokens();
    tokens[0]!.steps = 0;
    const green = tokens.find((t) => t.color === "green" && t.index === 0)!;
    green.steps = 39;
    expect(findCaptureTarget(tokens, "red", 0)).toBeNull();
  });

  it("blocks landing on and capturing barriers", () => {
    const barrierTokens = createInitialTokens();
    const g0 = barrierTokens.find((t) => t.color === "green" && t.index === 0)!;
    const g1 = barrierTokens.find((t) => t.color === "green" && t.index === 1)!;
    g0.steps = 44;
    g1.steps = 44;
    expect(absoluteTrackPosition("green", 44)).toBe(5);
    expect(isBarrierAbsolute(barrierTokens, 5, "red")).toBe(true);
    expect(findCaptureTarget(barrierTokens, "red", 5)).toBeNull();

    const red0 = barrierTokens.find((t) => t.color === "red" && t.index === 0)!;
    red0.steps = 0;
    expect(getLegalMoves(barrierTokens, "red", 5)).not.toContain(0);

    red0.steps = 3;
    expect(getLegalMoves(barrierTokens, "red", 3)).toContain(0);
  });

  it("captures a lone opponent", () => {
    const lone = createInitialTokens();
    lone[0]!.steps = 5;
    const loneGreen = lone.find((t) => t.color === "green" && t.index === 0)!;
    loneGreen.steps = 44;
    expect(findCaptureTarget(lone, "red", 5)?.color).toBe("green");
  });
});

describe("win and roll policy", () => {
  it("detects a finished colour", () => {
    const winners = createInitialTokens().map((t) =>
      t.color === "blue" ? { ...t, steps: 56 } : t,
    );
    expect(hasWon(winners, "blue")).toBe(true);
    expect(hasWon(winners, "red")).toBe(false);
  });

  it("applies three-sixes and no-move roll decisions", () => {
    expect(decideRollOutcome(6, 2, 4).kind).toBe("three_sixes");
    expect(decideRollOutcome(6, 1, 0).kind).toBe("no_moves_six");
    expect(decideRollOutcome(4, 0, 0).kind).toBe("no_moves");
    expect(decideRollOutcome(5, 0, 2).kind).toBe("ok");
    expect(gainsExtraTurn(6, false)).toBe(true);
    expect(gainsExtraTurn(3, true)).toBe(true);
    expect(gainsExtraTurn(3, false)).toBe(false);
    expect(gainsExtraTurn(3, false, true)).toBe(true);
  });

  it("picks a token to return on three sixes", () => {
    const tokens = createInitialTokens(["red"]);
    tokens[0]!.steps = 10;
    tokens[1]!.steps = 20;
    expect(pickThreeSixesPenaltyToken(tokens, "red", 0)).toBe(0);
    expect(pickThreeSixesPenaltyToken(tokens, "red", null)).toBe(1);
  });
});

describe("session, codes, and board geometry", () => {
  it("validates client ids", () => {
    expect(() =>
      assertValidClientId("550e8400-e29b-41d4-a716-446655440000"),
    ).not.toThrow();
    expect(() => assertValidClientId("not-a-uuid")).toThrow();
  });

  it("normalizes room codes and fans stacked tokens", () => {
    expect(normalizeCode("ab-12!")).toBe("AB12");
    expect(stackFanOffset(0, 1).x).toBe(0);
    const pair = stackFanOffset(0, 2);
    expect(pair.x !== 0 || pair.y !== 0).toBe(true);

    const a = { color: "red" as const, index: 0, steps: 5 };
    const b = { color: "blue" as const, index: 0, steps: 18 };
    expect(tokenStackKey(a.color, a.index, a.steps)).toBe(
      tokenStackKey(b.color, b.index, b.steps),
    );
    const posA = tokenSvgPosition("red", 0, 5, 0, 2);
    const posB = tokenSvgPosition("blue", 0, 18, 1, 2);
    expect(posA.x !== posB.x || posA.y !== posB.y).toBe(true);
  });
});
