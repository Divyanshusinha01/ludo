import { describe, expect, it } from "vitest";
import { absoluteTrackPosition } from "../../../convex/lib/ludo";
import { ev } from "../fixtures/events";
import { deepFreeze, playingState } from "../fixtures/states";
import { apply, expectReject } from "../support/reduce";

const yellowOn = (redSteps: number) =>
  (absoluteTrackPosition("red", redSteps)! - 26 + 52) % 52;

function moved(redSteps: number[], dice: number, yellow: number[] = []) {
  return deepFreeze(
    apply(
      playingState({ colors: ["red", "yellow"], steps: { red: redSteps, yellow } }),
      ev.diceRolled("red", dice),
      ev.tokenMoved("red", "red", 0),
    ),
  );
}

describe("EXTRA_TURN_GRANTED", () => {
  it("six: same seat rolls again, streak kept", () => {
    const s = apply(moved([10], 6), ev.extraTurn("red", "six"));
    expect(s.currentTurn).toBe("red");
    expect(s.settle).toBeNull();
    expect(s.diceRolled).toBe(false);
    expect(s.consecutiveSixes).toBe(1);
    expect(s.sixStreakSnapshot).not.toBeNull();
  });

  it("capture: granted after the capture is applied, streak reset", () => {
    const s = apply(
      moved([2], 3, [yellowOn(5)]),
      ev.tokenCaptured("red", "red", "yellow", 0),
      ev.extraTurn("red", "capture"),
    );
    expect(s.settle).toBeNull();
    expect(s.consecutiveSixes).toBe(0);
    expect(s.diceRolled).toBe(false);
  });

  it("home: reaching the centre with a non-six grants another roll", () => {
    const s = apply(moved([53, 10], 3), ev.extraTurn("red", "home"));
    expect(s.settle).toBeNull();
    expect(s.tokens.find((t) => t.color === "red" && t.index === 0)!.steps).toBe(56);
  });

  it("rejects an extra turn for a plain move", () => {
    expectReject(moved([10], 3), ev.extraTurn("red", "six"), "no_extra");
  });

  it("rejects a reason that does not match the move", () => {
    expectReject(moved([10], 6), ev.extraTurn("red", "capture"), "extra_reason");
  });

  it("rejects an extra turn for a different seat", () => {
    expectReject(moved([10], 6), ev.extraTurn("yellow", "six"), "wrong_seat");
  });

  it("rejects an extra turn with no move pending", () => {
    expectReject(
      deepFreeze(playingState({ colors: ["red", "yellow"] })),
      ev.extraTurn("red", "six"),
      "unexpected_extra",
    );
  });
});
