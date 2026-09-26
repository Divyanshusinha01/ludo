import { describe, expect, it } from "vitest";
import { shouldAnimateRemoteRoll } from "../src/hooks/useOpponentDiceRoll";

describe("opponent dice roll animation triggers", () => {
  it("animates when opponent finishes a roll on the same turn", () => {
    expect(
      shouldAnimateRemoteRoll(
        { turnId: 3, diceRolled: false, diceValue: null },
        { turnId: 3, diceRolled: true, diceValue: 4 },
      ),
    ).toBe(true);
  });

  it("animates roll-again (six) without clearing dice face", () => {
    expect(
      shouldAnimateRemoteRoll(
        { turnId: 5, diceRolled: true, diceValue: 6 },
        { turnId: 5, diceRolled: false, diceValue: 6 },
      ),
    ).toBe(true);
  });

  it("does not animate when dice clears between turns", () => {
    expect(
      shouldAnimateRemoteRoll(
        { turnId: 2, diceRolled: true, diceValue: 3 },
        { turnId: 3, diceRolled: false, diceValue: null },
      ),
    ).toBe(false);
  });

  it("animates when the face appears before diceRolled is set", () => {
    expect(
      shouldAnimateRemoteRoll(
        { turnId: 3, diceRolled: false, diceValue: null },
        { turnId: 3, diceRolled: false, diceValue: 4 },
      ),
    ).toBe(true);
  });
});
