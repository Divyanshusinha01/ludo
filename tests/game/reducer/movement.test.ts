import { describe, expect, it } from "vitest";
import { ev } from "../fixtures/events";
import { deepFreeze, playingState } from "../fixtures/states";
import { apply, expectReject } from "../support/reduce";

function rolled(steps: number[], dice: number) {
  return deepFreeze(
    apply(playingState({ colors: ["red", "yellow"], steps: { red: steps } }), ev.diceRolled("red", dice)),
  );
}

function stepsOf(state: ReturnType<typeof rolled>, index: number) {
  return state.tokens.find((t) => t.color === "red" && t.index === index)!.steps;
}

describe("TOKEN_MOVED", () => {
  it("leaves the yard on a six", () => {
    const s = apply(rolled([-1, -1, -1, -1], 6), ev.tokenMoved("red", "red", 2));
    expect(stepsOf(s, 2)).toBe(0);
    expect(s.diceRolled).toBe(false);
    expect(s.settle).toMatchObject({ tokenColor: "red", tokenIndex: 2, fromSteps: -1, toSteps: 0, dice: 6, captures: 0 });
  });

  it("cannot leave the yard without a six", () => {
    expectReject(rolled([-1, 10, -1, -1], 4), ev.tokenMoved("red", "red", 0), "illegal_move");
  });

  it("moves along the track", () => {
    expect(stepsOf(apply(rolled([10], 4), ev.tokenMoved("red", "red", 0)), 0)).toBe(14);
  });

  it("enters the home stretch", () => {
    expect(stepsOf(apply(rolled([49], 4), ev.tokenMoved("red", "red", 0)), 0)).toBe(53);
  });

  it("reaches home on an exact roll and rejects overshooting", () => {
    expect(stepsOf(apply(rolled([52], 4), ev.tokenMoved("red", "red", 0)), 0)).toBe(56);
    expectReject(rolled([54, 10], 4), ev.tokenMoved("red", "red", 0), "illegal_move");
  });

  it("rejects moving before rolling", () => {
    expectReject(
      deepFreeze(playingState({ colors: ["red", "yellow"], steps: { red: [10] } })),
      ev.tokenMoved("red", "red", 0),
      "roll_first",
    );
  });

  it("rejects moving an opponent's token or a non-existent token", () => {
    const s = deepFreeze(
      apply(
        playingState({ colors: ["red", "yellow"], steps: { red: [10], yellow: [10] } }),
        ev.diceRolled("red", 3),
      ),
    );
    expectReject(s, ev.tokenMoved("red", "yellow", 0), "illegal_move");
    expectReject(s, ev.tokenMoved("red", "red", 9), "illegal_move");
  });

  it("rejects a move whose seat actor is not the mover", () => {
    expectReject(rolled([10], 3), ev.tokenMoved("yellow", "red", 0), "wrong_actor");
  });

  it("rejects moving a finished token", () => {
    expectReject(rolled([56, 10], 3), ev.tokenMoved("red", "red", 0), "illegal_move");
  });
});
