import { describe, expect, it } from "vitest";
import {
  absoluteTrackPosition,
  controllableColorsForActor,
  createInitialTokens,
  findCaptureTargets,
  FINISHED_STEPS,
  getLegalMovesForActor,
  nextTurnSeatColor,
  shouldTransferRollToTeammate,
  legalMovesForDelegatedRoll,
  pickNextColorForTeam,
  rotationColors,
  turnSeatAfterDelegatedMove,
  teamAllTokensHome,
  teamIsAllHome,
  teamIsSpent,
  teamOfColor,
  teamTeammateColor,
  turnActorColor,
  TEAM_COLORS,
} from "../convex/lib/ludo";

describe("team colour mapping", () => {
  it("maps colours to fixed teams", () => {
    expect(TEAM_COLORS.A).toEqual(["red", "yellow"]);
    expect(TEAM_COLORS.B).toEqual(["green", "blue"]);
    expect(teamOfColor("red")).toBe("A");
    expect(teamOfColor("yellow")).toBe("A");
    expect(teamOfColor("green")).toBe("B");
    expect(teamOfColor("blue")).toBe("B");
  });

  it("assigns the next free seat on a team", () => {
    expect(pickNextColorForTeam([], "A")).toBe("red");
    expect(pickNextColorForTeam(["red"], "A")).toBe("yellow");
    expect(pickNextColorForTeam(["red", "yellow"], "A")).toBeUndefined();
    expect(pickNextColorForTeam(["red"], "B")).toBe("green");
  });
});

describe("2v2 capture rules", () => {
  it("does not capture teammates in 2v2 mode", () => {
    const tokens = createInitialTokens();
    const destSteps = 5;
    tokens[0]!.steps = destSteps;
    const yellow = tokens.find((t) => t.color === "yellow" && t.index === 0)!;
    const redAbs = absoluteTrackPosition("red", destSteps);
    expect(redAbs).not.toBeNull();
    for (let s = 0; s <= 50; s++) {
      if (absoluteTrackPosition("yellow", s) === redAbs) {
        yellow.steps = s;
        break;
      }
    }
    expect(absoluteTrackPosition("yellow", yellow.steps)).toBe(redAbs);
    expect(
      findCaptureTargets(tokens, "red", destSteps, "2v2").map((t) => t.color),
    ).toEqual([]);
    expect(
      findCaptureTargets(tokens, "red", destSteps).map((t) => t.color),
    ).toEqual(["yellow"]);
  });

  it("still captures opponents in 2v2 mode", () => {
    const tokens = createInitialTokens();
    tokens[0]!.steps = 5;
    const green = tokens.find((t) => t.color === "green" && t.index === 0)!;
    green.steps = 44;
    expect(
      findCaptureTargets(tokens, "red", 5, "2v2").map((t) => t.color),
    ).toEqual(["green"]);
  });

  it("keeps 1v1 capture behaviour when mode is omitted", () => {
    const tokens = createInitialTokens();
    tokens[0]!.steps = 5;
    const green = tokens.find((t) => t.color === "green" && t.index === 0)!;
    green.steps = 44;
    expect(findCaptureTargets(tokens, "red", 5).map((t) => t.color)).toEqual([
      "green",
    ]);
  });
});

describe("2v2 finished-player turns", () => {
  const roster = [
    { color: "red" as const, team: "A" as const, eliminated: false, finishRank: 1 },
    { color: "yellow" as const, team: "A" as const, eliminated: false, finishRank: null },
    { color: "green" as const, team: "B" as const, eliminated: false, finishRank: null },
    { color: "blue" as const, team: "B" as const, eliminated: false, finishRank: null },
  ];

  it("routes a finished seat to the teammate", () => {
    expect(teamTeammateColor("red")).toBe("yellow");
    expect(turnActorColor("red", roster, "2v2")).toBe("yellow");
    expect(turnActorColor("yellow", roster, "2v2")).toBe("yellow");
  });

  it("keeps finished colours in rotation", () => {
    expect(rotationColors(roster, "2v2")).toEqual([
      "red",
      "green",
      "yellow",
      "blue",
    ]);
    expect(rotationColors(roster, "1v1")).toEqual(["green", "yellow", "blue"]);
  });

  it("advances to the finished seat so the teammate can play it", () => {
    expect(nextTurnSeatColor("green", roster, "2v2")).toBe("yellow");
    expect(nextTurnSeatColor("yellow", roster, "2v2")).toBe("blue");
  });

  it("lets the actor move finished teammate tokens", () => {
    expect(controllableColorsForActor("yellow", roster, "2v2")).toEqual([
      "yellow",
      "red",
    ]);
    const tokens = createInitialTokens();
    tokens.find((t) => t.color === "red" && t.index === 0)!.steps = 10;
    const moves = getLegalMovesForActor(tokens, "yellow", roster, "2v2", 6);
    expect(moves.some((m) => m.color === "red")).toBe(true);
  });
});

describe("2v2 pass roll transfer", () => {
  const roster = [
    { color: "red" as const, team: "A" as const, eliminated: false, finishRank: null },
    { color: "yellow" as const, team: "A" as const, eliminated: false, finishRank: null },
    { color: "green" as const, team: "B" as const, eliminated: false, finishRank: null },
    { color: "blue" as const, team: "B" as const, eliminated: false, finishRank: null },
  ];

  it("transfers a pending rolled face when the teammate can use it", () => {
    const tokens = createInitialTokens();
    tokens.find((t) => t.color === "yellow" && t.index === 0)!.steps = 10;
    expect(
      shouldTransferRollToTeammate(
        { diceRolled: true, diceValue: 4 },
        "red",
        "yellow",
        tokens,
        roster,
        "2v2",
      ),
    ).toBe(true);
  });

  it("does not transfer before the roll is consumed", () => {
    const tokens = createInitialTokens();
    expect(
      shouldTransferRollToTeammate(
        { diceRolled: false, diceValue: 6 },
        "red",
        "yellow",
        tokens,
        roster,
        "2v2",
      ),
    ).toBe(false);
  });

  it("does not transfer when teammate has no legal use for the die", () => {
    const tokens = createInitialTokens();
    tokens.find((t) => t.color === "red" && t.index === 0)!.steps = 10;
    expect(
      shouldTransferRollToTeammate(
        { diceRolled: true, diceValue: 3 },
        "red",
        "yellow",
        tokens,
        roster,
        "2v2",
      ),
    ).toBe(false);
  });

  it("does not transfer when there is no roll to give", () => {
    const tokens = createInitialTokens();
    expect(
      shouldTransferRollToTeammate(
        { diceRolled: false, diceValue: null },
        "red",
        "yellow",
        tokens,
        roster,
        "2v2",
      ),
    ).toBe(false);
  });
});

describe("2v2 delegated roll", () => {
  const roster = [
    { color: "red" as const, team: "A" as const, eliminated: false, finishRank: null },
    { color: "yellow" as const, team: "A" as const, eliminated: false, finishRank: null },
    { color: "green" as const, team: "B" as const, eliminated: false, finishRank: null },
    { color: "blue" as const, team: "B" as const, eliminated: false, finishRank: null },
  ];

  it("lets delegate enter from yard with a passed 6", () => {
    const tokens = createInitialTokens();
    const moves = legalMovesForDelegatedRoll(tokens, "yellow", 6);
    expect(moves.length).toBeGreaterThan(0);
    expect(moves.every((m) => m.color === "yellow")).toBe(true);
  });

  it("does not let delegate move red tokens while red is still playing", () => {
    const tokens = createInitialTokens();
    tokens.find((t) => t.color === "red" && t.index === 0)!.steps = 10;
    const moves = legalMovesForDelegatedRoll(tokens, "yellow", 4);
    expect(moves.some((m) => m.color === "red")).toBe(false);
  });

  it("keeps rotation on red seat after delegated non-six move", () => {
    const result = turnSeatAfterDelegatedMove(
      "red",
      4,
      false,
      false,
      roster,
      "2v2",
    );
    expect(result.grantsExtraRoll).toBe(false);
    expect(result.nextSeat).toBe("green");
  });

  it("grants extra roll to red seat after delegated 6", () => {
    const result = turnSeatAfterDelegatedMove(
      "red",
      6,
      false,
      false,
      roster,
      "2v2",
    );
    expect(result.grantsExtraRoll).toBe(true);
    expect(result.nextSeat).toBe("red");
  });
});

describe("team token win", () => {
  it("wins when all 8 team tokens are home", () => {
    const tokens = createInitialTokens();
    for (const t of tokens) {
      if (t.color === "red" || t.color === "yellow") {
        t.steps = FINISHED_STEPS;
      }
    }
    expect(teamAllTokensHome(tokens, "A")).toBe(true);
    expect(teamAllTokensHome(tokens, "B")).toBe(false);
  });
});

describe("team finish helpers", () => {
  const base = [
    { color: "red" as const, team: "A" as const, eliminated: false, finishRank: null },
    { color: "yellow" as const, team: "A" as const, eliminated: false, finishRank: null },
    { color: "green" as const, team: "B" as const, eliminated: false, finishRank: null },
    { color: "blue" as const, team: "B" as const, eliminated: false, finishRank: null },
  ];

  it("detects when both teammates are home", () => {
    const players = base.map((p) =>
      p.color === "red" || p.color === "yellow"
        ? { ...p, finishRank: 1 }
        : p,
    );
    expect(teamIsAllHome(players, "A")).toBe(true);
    expect(teamIsAllHome(players, "B")).toBe(false);
  });

  it("detects spent team (one home, one eliminated)", () => {
    const players = base.map((p) => {
      if (p.color === "red") return { ...p, finishRank: 1 };
      if (p.color === "yellow") return { ...p, eliminated: true, finishRank: 3 };
      return p;
    });
    expect(teamIsSpent(players, "A")).toBe(true);
    expect(teamIsAllHome(players, "A")).toBe(false);
  });

  it("detects spent team when both eliminated", () => {
    const players = base.map((p) =>
      p.team === "B" ? { ...p, eliminated: true, finishRank: 3 } : p,
    );
    expect(teamIsSpent(players, "B")).toBe(true);
    expect(teamIsAllHome(players, "B")).toBe(false);
  });
});
