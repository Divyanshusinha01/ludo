import { describe, expect, it } from "vitest";
import type { GameState } from "../../../convex/lib/game";
import { absoluteTrackPosition, type Color } from "../../../convex/lib/ludo";
import { seededDice } from "../fixtures/dice";
import { ev } from "../fixtures/events";
import { playingState } from "../fixtures/states";
import { assertHistoryInvariants } from "../support/invariants";
import { apply, run } from "../support/reduce";
import { simulateGame } from "../support/simulate";

const yellowOn = (redSteps: number) =>
  (absoluteTrackPosition("red", redSteps)! - 26 + 52) % 52;
const steps = (s: GameState, color: Color, index: number) =>
  s.tokens.find((t) => t.color === color && t.index === index)!.steps;
const roll = (s: GameState, color: Color, value: number) =>
  run(s, { type: "RollDice", color, value });
const move = (s: GameState, color: Color, index: number) =>
  run(s, { type: "MoveToken", actorColor: color, tokenColor: color, tokenIndex: index });

describe("regression: roll outcomes through decide", () => {
  it("no legal move passes the turn", () => {
    const r = roll(playingState({ colors: ["red", "yellow"] }), "red", 4);
    expect(r.types).toEqual(["DICE_ROLLED", "TURN_ENDED", "TURN_STARTED"]);
    expect(r.state.currentTurn).toBe("yellow");
  });

  it("six with no legal move keeps the turn for another roll", () => {
    const r = roll(playingState({ colors: ["red", "yellow"], steps: { red: [51, 52, 53, 56] } }), "red", 6);
    expect(r.types).toEqual(["DICE_ROLLED"]);
    expect(r.state.currentTurn).toBe("red");
    expect(r.state.diceRolled).toBe(false);
  });

  it("a single legal move is played automatically", () => {
    const r = roll(playingState({ colors: ["red", "yellow"], steps: { red: [10] } }), "red", 3);
    expect(r.types).toEqual(["DICE_ROLLED", "TOKEN_MOVED", "TURN_ENDED", "TURN_STARTED"]);
    expect(steps(r.state, "red", 0)).toBe(13);
  });

  it("several legal moves wait for the player's choice", () => {
    const r = roll(playingState({ colors: ["red", "yellow"], steps: { red: [10, 20] } }), "red", 3);
    expect(r.types).toEqual(["DICE_ROLLED"]);
    expect(r.state.diceRolled).toBe(true);
  });

  it("three sixes in a row void the streak, restore the board and pass the turn", () => {
    let s = playingState({ colors: ["red", "yellow"], steps: { red: [10] } });
    const before = s.tokens;
    s = roll(s, "red", 6).state;
    s = move(s, "red", 0).state;
    expect(steps(s, "red", 0)).toBe(16);
    s = roll(s, "red", 6).state;
    s = move(s, "red", 0).state;
    expect(steps(s, "red", 0)).toBe(22);
    const third = roll(s, "red", 6);
    expect(third.types).toEqual(["DICE_ROLLED", "TURN_ENDED", "TURN_STARTED"]);
    expect(third.state.tokens).toEqual(before);
    expect(third.state.currentTurn).toBe("yellow");
    expect(third.state.consecutiveSixes).toBe(0);
  });
});

describe("regression: movement rules through decide", () => {
  it("safe cell: landing on an opponent does not capture", () => {
    const rolled = apply(
      playingState({ colors: ["red", "yellow"], steps: { red: [5, 30], yellow: [yellowOn(8)] } }),
      ev.diceRolled("red", 3),
    );
    const r = move(rolled, "red", 0);
    expect(r.types).toEqual(["TOKEN_MOVED", "TURN_ENDED", "TURN_STARTED"]);
    expect(steps(r.state, "yellow", 0)).toBe(yellowOn(8));
  });

  it("capture sends the victim to the yard and grants an extra roll", () => {
    const rolled = apply(
      playingState({ colors: ["red", "yellow"], steps: { red: [2, 30], yellow: [yellowOn(5)] } }),
      ev.diceRolled("red", 3),
    );
    const r = move(rolled, "red", 0);
    expect(r.types).toEqual(["TOKEN_MOVED", "TOKEN_CAPTURED", "EXTRA_TURN_GRANTED"]);
    expect(steps(r.state, "yellow", 0)).toBe(-1);
    expect(r.state.currentTurn).toBe("red");
    expect(r.events[2]!.payload).toMatchObject({ reason: "capture" });
  });

  it("home stretch entry is not on the shared track", () => {
    const rolled = apply(
      playingState({ colors: ["red", "yellow"], steps: { red: [49, 30] } }),
      ev.diceRolled("red", 4),
    );
    const r = move(rolled, "red", 0);
    expect(steps(r.state, "red", 0)).toBe(53);
    expect(absoluteTrackPosition("red", 53)).toBeNull();
    expect(r.types).toEqual(["TOKEN_MOVED", "TURN_ENDED", "TURN_STARTED"]);
  });

  it("reaching home with a non-six grants an extra roll", () => {
    const rolled = apply(
      playingState({ colors: ["red", "yellow"], steps: { red: [53, 30] } }),
      ev.diceRolled("red", 3),
    );
    const r = move(rolled, "red", 0);
    expect(r.types).toEqual(["TOKEN_MOVED", "EXTRA_TURN_GRANTED"]);
    expect(r.events[1]!.payload).toMatchObject({ reason: "home" });
  });
});

describe("regression: full seeded games", () => {
  it.each([
    ["1v1", ["red", "yellow"], "1v1"],
    ["4 players", ["red", "green", "yellow", "blue"], "1v1"],
    ["2v2", ["red", "green", "yellow", "blue"], "2v2"],
  ] as const)("%s game finishes with complete rankings", (_label, colors, mode) => {
    const sim = simulateGame({ colors: [...colors], mode, dice: seededDice(42), choiceSeed: 42 });
    expect(sim.final.phase).toBe("finished");
    expect([...sim.final.rankings].sort()).toEqual([...colors].sort());
    if (mode === "2v2") expect(sim.final.winningTeam).not.toBeNull();
    assertHistoryInvariants(sim.events, sim.states, sim.boundaries);
  });
});
