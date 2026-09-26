import { describe, expect, it, vi } from "vitest";
import {
  createOfflineGame,
  moveToken,
  rematch,
  rollDice,
} from "../src/lib/offline/engine";

describe("offline engine", () => {
  it("creates a 2-player local game", () => {
    const state = createOfflineGame([
      { color: "red", name: "Alice", isBot: false },
      { color: "yellow", name: "Bob", isBot: false },
    ]);
    expect(state.status).toBe("playing");
    expect(state.currentTurn).toBe("red");
    expect(state.tokens).toHaveLength(8);
    expect(state.seats).toHaveLength(2);
  });

  it("rolls and moves with a fixed dice sequence", () => {
    let roll = 0;
    const values = [6, 3, 6, 4];
    const random = () => {
      const v = values[roll] ?? 1;
      roll += 1;
      return (v - 1) / 6 + 0.001;
    };

    let state = createOfflineGame([
      { color: "red", name: "Alice", isBot: false },
      { color: "yellow", name: "Bob", isBot: false },
    ]);

    const rolled = rollDice(state, random);
    expect(rolled.result.value).toBe(6);
    expect(rolled.result.legalMoves.length).toBe(4);
    state = rolled.state;

    const moved = moveToken(state, 0);
    expect(moved.result.leftYard).toBe(true);
    expect(moved.result.extraTurn).toBe(true);
    expect(moved.state.currentTurn).toBe("red");
  });

  it("rejects rolling twice without moving", () => {
    const state = createOfflineGame([
      { color: "red", name: "Alice", isBot: false },
      { color: "yellow", name: "Bob", isBot: false },
    ]);
    const random = () => 0.99;
    const { state: afterRoll } = rollDice(state, random);
    expect(() => rollDice(afterRoll, random)).toThrow(/already rolled/i);
  });

  it("rematch resets the board after a finished game", () => {
    let state = createOfflineGame([
      { color: "red", name: "Alice", isBot: false },
      { color: "yellow", name: "Bob", isBot: false },
    ]);
    state = { ...state, status: "finished", winner: "red", finishedAt: Date.now() };
    const next = rematch(state);
    expect(next.status).toBe("playing");
    expect(next.tokens.every((t) => t.steps === -1)).toBe(true);
    expect(next.seats.every((s) => s.finishRank == null)).toBe(true);
  });

  it("requires at least one human", () => {
    expect(() =>
      createOfflineGame([
        { color: "red", name: "Bot 1", isBot: true },
        { color: "yellow", name: "Bot 2", isBot: true },
      ]),
    ).toThrow(/human/i);
  });
});
