import { describe, expect, it } from "vitest";
import { rollFairDice } from "../../../convex/lib/ludo";
import { randomForFace, scriptedDice, seededDice } from "../fixtures/dice";
import { finishedGame, midGame, scriptedOpening1v1 } from "../fixtures/histories";
import { replayState } from "../fixtures/states";
import { simulateGame } from "./simulate";

describe("test support", () => {
  it("randomForFace drives rollFairDice to every face with and without yard weighting", () => {
    for (let face = 1; face <= 6; face++) {
      const r = randomForFace(face);
      expect(rollFairDice(false, () => r)).toBe(face);
      expect(rollFairDice(true, () => r)).toBe(face);
    }
  });

  it("scripted dice throw when exhausted", () => {
    const dice = scriptedDice([4]);
    expect(dice()).toBe(4);
    expect(() => dice()).toThrow(/exhausted/);
  });

  it("simulateGame is deterministic per seed and finishes", () => {
    const a = simulateGame({ colors: ["red", "yellow"], dice: seededDice(7), choiceSeed: 7 });
    const b = simulateGame({ colors: ["red", "yellow"], dice: seededDice(7), choiceSeed: 7 });
    expect(a.final.phase).toBe("finished");
    expect(a.events).toEqual(b.events);
  });

  it("fixture histories replay", () => {
    expect(replayState(scriptedOpening1v1()).currentTurn).toBe("red");
    expect(replayState(midGame(3)).phase).toBe("playing");
    expect(replayState(finishedGame(3).events).phase).toBe("finished");
  });
});
