import { describe, expect, it } from "vitest";
import {
  createEmptyState,
  replayGame,
  type GameState,
} from "../../../convex/lib/game";
import { createInitialTokens, MAX_TIMEOUT_LIVES } from "../../../convex/lib/ludo";
import { finishedGame, midGame, scriptedOpening1v1 } from "../fixtures/histories";

describe("replay correctness", () => {
  it("hand-written opening replays to an exact, fully specified state", () => {
    const events = scriptedOpening1v1();
    const { state, applied } = replayGame(createEmptyState(), events);
    const expected: GameState = {
      phase: "playing",
      mode: "1v1",
      vsComputer: false,
      rulesVersion: 1,
      seats: [
        { color: "red", name: "RED", isBot: false, team: undefined, lives: MAX_TIMEOUT_LIVES, eliminated: false, finishRank: null },
        { color: "yellow", name: "YELLOW", isBot: false, team: undefined, lives: MAX_TIMEOUT_LIVES, eliminated: false, finishRank: null },
      ],
      tokens: createInitialTokens(["red", "yellow"]).map((t) =>
        t.color === "red" && t.index === 0 ? { ...t, steps: 3 } : t,
      ),
      currentTurn: "red",
      diceValue: null,
      diceRolled: false,
      consecutiveSixes: 0,
      sixStreakSnapshot: null,
      passedRollTo: null,
      turnNumber: 3,
      rankings: [],
      winner: null,
      winningTeam: null,
      settle: null,
      finishedAt: null,
    };
    expect(applied).toBe(events.length);
    expect(state).toEqual(expected);
  });

  it.each([
    ["1v1", 1, ["red", "yellow"], "1v1"],
    ["1v1", 2, ["red", "yellow"], "1v1"],
    ["3p", 3, ["red", "green", "yellow"], "1v1"],
    ["4p", 4, ["red", "green", "yellow", "blue"], "1v1"],
    ["2v2", 6, ["red", "green", "yellow", "blue"], "2v2"],
    ["2v2", 7, ["red", "green", "yellow", "blue"], "2v2"],
  ] as const)("finished %s game (seed %i) replays to its final state", (_l, seed, colors, mode) => {
    const sim = finishedGame(seed, [...colors], mode);
    const { state } = replayGame(createEmptyState(), sim.events);
    expect(state).toEqual(sim.final);
    expect(state.phase).toBe("finished");
    expect(state.winner).toBe(state.rankings[0]);
  });

  it("a mid-game history replays to the state at that point", () => {
    const sim = finishedGame(9);
    const events = midGame(9, 150);
    expect(replayGame(createEmptyState(), events).state).toEqual(sim.states[events.length]);
  });
});
