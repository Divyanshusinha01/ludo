import { describe, expect, it } from "vitest";
import { absoluteTrackPosition, isSafeAbsolute } from "../../../convex/lib/ludo";
import { ev } from "../fixtures/events";
import { deepFreeze, playingState } from "../fixtures/states";
import { apply, expectReject } from "../support/reduce";

/** Yellow steps that share red's absolute cell at `redSteps`. */
function yellowOn(redSteps: number): number {
  const abs = absoluteTrackPosition("red", redSteps)!;
  return (abs - 26 + 52) % 52;
}

function movedOnto(redFrom: number, dice: number, yellow: number[], mode: "1v1" | "2v2" = "1v1") {
  const colors = mode === "2v2" ? (["red", "green", "yellow", "blue"] as const) : (["red", "yellow"] as const);
  return deepFreeze(
    apply(
      playingState({ colors: [...colors], mode, steps: { red: [redFrom], yellow } }),
      ev.diceRolled("red", dice),
      ev.tokenMoved("red", "red", 0),
    ),
  );
}

describe("TOKEN_CAPTURED", () => {
  it("geometry sanity: red 5 and yellow 31 share a non-safe cell", () => {
    expect(yellowOn(5)).toBe(31);
    expect(isSafeAbsolute(absoluteTrackPosition("red", 5)!)).toBe(false);
    expect(isSafeAbsolute(absoluteTrackPosition("red", 8)!)).toBe(true);
  });

  it("sends the victim back to the yard and records the capture", () => {
    const s = apply(movedOnto(2, 3, [yellowOn(5)]), ev.tokenCaptured("red", "red", "yellow", 0));
    expect(s.tokens.find((t) => t.color === "yellow" && t.index === 0)!.steps).toBe(-1);
    expect(s.settle).toMatchObject({ captures: 1 });
  });

  it("captures every opponent token in a stack", () => {
    const y = yellowOn(5);
    const s = apply(
      movedOnto(2, 3, [y, y]),
      ev.tokenCaptured("red", "red", "yellow", 0),
      ev.tokenCaptured("red", "red", "yellow", 1),
    );
    expect(s.tokens.filter((t) => t.color === "yellow" && t.steps === -1)).toHaveLength(4);
  });

  it("rejects capturing on a safe cell", () => {
    expectReject(movedOnto(5, 3, [yellowOn(8)]), ev.tokenCaptured("red", "red", "yellow", 0), "invalid_capture");
  });

  it("rejects capturing a token that is not on the landing cell", () => {
    expectReject(movedOnto(2, 3, [yellowOn(6)]), ev.tokenCaptured("red", "red", "yellow", 0), "invalid_capture");
  });

  it("rejects a capture with no move pending", () => {
    expectReject(
      deepFreeze(playingState({ colors: ["red", "yellow"], steps: { red: [5], yellow: [yellowOn(5)] } })),
      ev.tokenCaptured("red", "red", "yellow", 0),
      "unexpected_capture",
    );
  });

  it("rejects settling a move that skipped a required capture", () => {
    const s = movedOnto(2, 3, [yellowOn(5)]);
    expectReject(s, ev.turnEnded("moved"), "capture_missing");
    expectReject(s, ev.extraTurn("red", "capture"), "capture_missing");
  });

  it("2v2: never captures a teammate", () => {
    expectReject(
      movedOnto(2, 3, [yellowOn(5)], "2v2"),
      ev.tokenCaptured("red", "red", "yellow", 0),
      "invalid_capture",
    );
    const s = apply(movedOnto(2, 3, [yellowOn(5)], "2v2"), ev.turnEnded("moved"));
    expect(s.tokens.find((t) => t.color === "yellow" && t.index === 0)!.steps).toBe(yellowOn(5));
  });
});
