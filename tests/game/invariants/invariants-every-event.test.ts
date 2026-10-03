import { describe, expect, it } from "vitest";
import {
  createEmptyState,
  replayWithTrace,
  type GameState,
  type LudoEvent,
} from "../../../convex/lib/game";
import { FINISHED_STEPS } from "../../../convex/lib/ludo";
import { seededDice } from "../fixtures/dice";
import { ev, makeEvent } from "../fixtures/events";
import {
  finishedGame,
  lobbyHistory,
  midGame,
  scriptedOpening1v1,
  started1v1,
  started2v2,
  started3p,
  started4p,
} from "../fixtures/histories";
import { playingState } from "../fixtures/states";
import {
  assertHistoryInvariants,
  assertInvariants,
  InvariantError,
} from "../support/invariants";
import { simulateGame } from "../support/simulate";

function traceOf(events: LudoEvent[]): GameState[] {
  const trace = replayWithTrace(createEmptyState(), events);
  expect(trace.error).toBeUndefined();
  return trace.states;
}

describe("invariants hold after every event of every fixture", () => {
  const handWritten: Array<[string, () => LudoEvent[]]> = [
    ["lobby", lobbyHistory],
    ["started 1v1", started1v1],
    ["started 3p", started3p],
    ["started 4p", started4p],
    ["started 2v2", started2v2],
    ["scripted opening", scriptedOpening1v1],
    ["mid-game", () => midGame(9, 150)],
  ];

  it.each(handWritten)("%s", (_label, history) => {
    const events = history();
    assertHistoryInvariants(events, traceOf(events));
  });

  it.each([
    ["1v1", 1, ["red", "yellow"], "1v1"],
    ["3p", 3, ["red", "green", "yellow"], "1v1"],
    ["4p", 4, ["red", "green", "yellow", "blue"], "1v1"],
    ["2v2", 6, ["red", "green", "yellow", "blue"], "2v2"],
  ] as const)("finished %s game, with transaction boundaries", (_l, seed, colors, mode) => {
    const sim = finishedGame(seed, [...colors], mode);
    assertHistoryInvariants(sim.events, sim.states, sim.boundaries);
    assertHistoryInvariants(sim.events, traceOf(sim.events));
  });

  it.each([
    ["1v1", ["red", "yellow"], "1v1"],
    ["4p", ["red", "green", "yellow", "blue"], "1v1"],
    ["2v2", ["red", "green", "yellow", "blue"], "2v2"],
  ] as const)("%s game with timeouts and forfeits", (_l, colors, mode) => {
    const sim = simulateGame({
      colors: [...colors],
      mode,
      dice: seededDice(31),
      choiceSeed: 31,
      timeoutRate: 0.05,
      forfeitRate: 0.01,
    });
    expect(sim.final.phase).toBe("finished");
    assertHistoryInvariants(sim.events, sim.states, sim.boundaries);
  });

  it("a finished game followed by a rematch", () => {
    const sim = finishedGame(2);
    const start = sim.events.find((e) => e.eventType === "GAME_STARTED")!;
    const firstTurn = sim.events.find((e) => e.eventType === "TURN_STARTED")!;
    const n = sim.events.length;
    const events = [
      ...sim.events,
      makeEvent(start, n + 1),
      makeEvent(firstTurn, n + 2),
    ];
    const states = traceOf(events);
    assertHistoryInvariants(events, states);
    expect(states.at(-1)!.phase).toBe("playing");
  });
});

describe("assertInvariants is not vacuous", () => {
  const base = () => playingState({ colors: ["red", "yellow"], steps: { red: [10] } });

  it.each<[string, (s: GameState) => GameState]>([
    ["token past home", (s) => ({ ...s, tokens: s.tokens.map((t, i) => (i === 0 ? { ...t, steps: 57 } : t)) })],
    ["fractional steps", (s) => ({ ...s, tokens: s.tokens.map((t, i) => (i === 0 ? { ...t, steps: 1.5 } : t)) })],
    ["token for an unseated colour", (s) => ({ ...s, tokens: [...s.tokens, { color: "blue", index: 0, steps: -1 }] })],
    ["duplicate token", (s) => ({ ...s, tokens: [...s.tokens, s.tokens[0]!] })],
    ["dice out of range", (s) => ({ ...s, diceValue: 7 })],
    ["three sixes pending", (s) => ({ ...s, consecutiveSixes: 3 })],
    ["duplicate ranking", (s) => ({ ...s, rankings: ["red", "red"] })],
    ["roll passed in 1v1", (s) => ({ ...s, passedRollTo: "yellow" })],
    ["finished with a pending move", (s) => ({ ...s, phase: "finished", rankings: ["red", "yellow"], winner: "red", settle: { kind: "after_token_move", seat: "red", actorColor: "red", tokenColor: "red", tokenIndex: 0, dice: 1, fromSteps: 9, toSteps: 10, wasDelegated: false, captures: 0 } })],
    ["finished without full rankings", (s) => ({ ...s, phase: "finished", rankings: ["red"], winner: "red" })],
    ["winner is not rank one", (s) => ({ ...s, phase: "finished", rankings: ["red", "yellow"], winner: "yellow" })],
  ])("rejects %s", (_label, corrupt) => {
    expect(() => assertInvariants(corrupt(base()))).toThrow(InvariantError);
  });

  it("rejects a turn held by an eliminated seat at a boundary", () => {
    const s = playingState({
      colors: ["red", "yellow"],
      seats: { red: { eliminated: true, lives: 0, finishRank: 2 } },
    });
    expect(() => assertInvariants(s, { boundary: true })).toThrow(/eliminated/);
    expect(() => assertInvariants(s, { boundary: false })).not.toThrow();
  });

  it("rejects a finished token moving", () => {
    const prev = playingState({ colors: ["red", "yellow"], steps: { red: [FINISHED_STEPS] } });
    const next = { ...prev, tokens: prev.tokens.map((t, i) => (i === 0 ? { ...t, steps: 3 } : t)) };
    expect(() =>
      assertInvariants(next, { prev, event: makeEvent(ev.turnStarted("yellow"), 9) }),
    ).toThrow(/finished token/);
  });

  it("rejects leaving the finished phase other than by GAME_STARTED", () => {
    const prev = { ...base(), phase: "finished" as const, rankings: ["red", "yellow"] as GameState["rankings"], winner: "red" as const };
    const next = { ...prev, phase: "playing" as const };
    expect(() =>
      assertInvariants(next, { prev, event: makeEvent(ev.turnStarted("red"), 9) }),
    ).toThrow(/left finished/);
  });

  it("rejects an eliminated seat acting", () => {
    const prev = playingState({
      colors: ["red", "yellow", "green"],
      seats: { green: { eliminated: true, lives: 0, finishRank: 3 } },
    });
    expect(() =>
      assertInvariants(prev, { prev, event: makeEvent(ev.diceRolled("green", 3), 9) }),
    ).toThrow(/eliminated green acted/);
  });
});
