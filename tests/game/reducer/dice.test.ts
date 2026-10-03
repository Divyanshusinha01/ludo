import { describe, expect, it } from "vitest";
import { snapshotTokens } from "../../../convex/lib/ludo";
import { ev } from "../fixtures/events";
import { lobbyHistory } from "../fixtures/histories";
import { deepFreeze, playingState, replayState } from "../fixtures/states";
import { apply, expectReject } from "../support/reduce";

const base = () => deepFreeze(playingState({ colors: ["red", "yellow"], steps: { red: [10] } }));

describe("DICE_ROLLED outcomes", () => {
  it("normal roll leaves the die pending for a move", () => {
    const s = apply(base(), ev.diceRolled("red", 4));
    expect(s.diceValue).toBe(4);
    expect(s.diceRolled).toBe(true);
    expect(s.consecutiveSixes).toBe(0);
  });

  it("no legal move: die stays rolled until TURN_ENDED(no_moves)", () => {
    const s = apply(playingState({ colors: ["red", "yellow"] }), ev.diceRolled("red", 2));
    expect(s.diceRolled).toBe(true);
    expect(s.consecutiveSixes).toBe(0);
  });

  it("six with no legal move: roll again, streak counted and snapshotted", () => {
    const start = playingState({ colors: ["red", "yellow"], steps: { red: [51, 52, 53, 56] } });
    const s = apply(start, ev.diceRolled("red", 6));
    expect(s.diceRolled).toBe(false);
    expect(s.diceValue).toBe(6);
    expect(s.consecutiveSixes).toBe(1);
    expect(s.sixStreakSnapshot).toEqual(snapshotTokens(start.tokens));
  });

  it("first six of a streak snapshots the board", () => {
    const s = apply(base(), ev.diceRolled("red", 6));
    expect(s.consecutiveSixes).toBe(1);
    expect(s.sixStreakSnapshot).toEqual(snapshotTokens(base().tokens));
  });

  it("third six voids the streak and restores the snapshot board", () => {
    const snapshot = snapshotTokens(playingState({ colors: ["red", "yellow"], steps: { red: [10] } }).tokens);
    const s = apply(
      playingState({
        colors: ["red", "yellow"],
        steps: { red: [22, 0] },
        consecutiveSixes: 2,
        sixStreakSnapshot: snapshot,
      }),
      ev.diceRolled("red", 6),
    );
    expect(s.tokens).toEqual(snapshot);
    expect(s.consecutiveSixes).toBe(0);
    expect(s.sixStreakSnapshot).toBeNull();
    expect(s.diceRolled).toBe(false);
    expect(s.diceValue).toBe(6);
  });
});

describe("DICE_ROLLED rejections", () => {
  it.each([0, 7, -1, 3.5, Number.NaN])("rejects dice value %s", (value) => {
    expectReject(base(), ev.diceRolled("red", value), "invalid_dice");
  });

  it("rejects a roll by someone other than the roll controller", () => {
    expectReject(base(), ev.diceRolled("yellow", 3), "wrong_actor");
  });

  it("rejects a seat actor that differs from the payload colour", () => {
    expectReject(
      base(),
      { ...ev.diceRolled("red", 3), actor: { kind: "seat", color: "yellow" } },
      "wrong_actor",
    );
  });

  it("rejects rolling twice", () => {
    expectReject(deepFreeze(apply(base(), ev.diceRolled("red", 3))), ev.diceRolled("red", 3), "dice_rolled");
  });

  it("rejects rolling while a move is unresolved", () => {
    const s = apply(base(), ev.diceRolled("red", 3), ev.tokenMoved("red", "red", 0));
    expectReject(deepFreeze(s), ev.diceRolled("red", 3), "settle_pending");
  });

  it("rejects rolling in the lobby or after the match", () => {
    expectReject(deepFreeze(replayState(lobbyHistory())), ev.diceRolled("red", 3), "wrong_phase");
    expectReject(
      deepFreeze(playingState({ colors: ["red", "yellow"], phase: "finished", winner: "red", rankings: ["red", "yellow"] })),
      ev.diceRolled("red", 3),
      "game_finished",
    );
  });
});
