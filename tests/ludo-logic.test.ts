import { describe, expect, it } from "vitest";
import {
  allTokensInYard,
  canRelease,
  createInitialTokens,
  decideRollOutcome,
  findCaptureTargets,
  buildFinalRankings,
  gainsExtraTurn,
  getLegalMoves,
  hasWon,
  legalIndexesAtSameCell,
  nextColorAmong,
  pickNextColor,
  rankHouseLabel,
  resolveTokenHit,
  rollFairDice,
  shouldAssignAutomaticLoser,
  snapshotTokens,
  stackFanOffset,
  startsSixStreak,
  tokensShareCell,
  tryMoveSteps,
  absoluteTrackPosition,
  YARD_SIX_WEIGHT,
} from "../convex/lib/ludo";
import {
  isInImmediateDanger,
  isOutsideEnemyYard,
  pickBotMove,
  trackDistanceBehind,
} from "../convex/lib/bot";
import { assertValidClientId, assertValidRoomCode, assertActionInterval } from "../convex/lib/session";
import { GameError } from "../convex/lib/errors";
import { normalizeCode } from "../src/lib/player";
import {
  HOME_FINISHED_SLOTS,
  tokenStackKey,
  tokenSvgPosition,
} from "../src/lib/boardGeometry";

describe("release and movement", () => {
  it("requires a 6 to leave home", () => {
    expect(canRelease(6)).toBe(true);
    expect(canRelease(5)).toBe(false);
    expect(tryMoveSteps(-1, 6)).toBe(0);
    expect(tryMoveSteps(-1, 3)).toBeNull();
  });

  it("requires exact count to finish", () => {
    expect(tryMoveSteps(50, 6)).toBe(56);
    expect(tryMoveSteps(55, 2)).toBeNull();
    expect(tryMoveSteps(54, 2)).toBe(56);
  });

  it("blocks non-6 moves from the yard", () => {
    const tokens = createInitialTokens();
    expect(tokens).toHaveLength(16);
    expect(getLegalMoves(tokens, "red", 5)).toHaveLength(0);
    expect(getLegalMoves(tokens, "red", 6)).toHaveLength(4);
  });
});

describe("turn order and seating", () => {
  it("creates tokens only for seated colours", () => {
    const two = createInitialTokens(["red", "blue"]);
    expect(two).toHaveLength(8);
    expect(nextColorAmong("red", ["red", "blue"])).toBe("blue");
    expect(nextColorAmong("blue", ["red", "blue"])).toBe("red");
  });

  it("prefers opposite houses for 2-player seating", () => {
    expect(pickNextColor(["red"])).toBe("yellow");
    expect(pickNextColor(["green"])).toBe("blue");
    expect(pickNextColor(["red", "yellow"])).toBe("green");
    expect(pickNextColor(["red", "yellow", "green"])).toBe("blue");
    expect(pickNextColor(["red", "green", "yellow", "blue"])).toBeUndefined();
    expect(nextColorAmong("red", ["red", "yellow"])).toBe("yellow");
  });
});

describe("capture", () => {
  it("captures on overlapping non-safe cells", () => {
    const tokens = createInitialTokens();
    tokens[0]!.steps = 5;
    const green = tokens.find((t) => t.color === "green" && t.index === 0)!;
    green.steps = 44;
    expect(findCaptureTargets(tokens, "red", 5).map((t) => t.color)).toEqual([
      "green",
    ]);
  });

  it("does not capture on safe cells", () => {
    const tokens = createInitialTokens();
    tokens[0]!.steps = 0;
    const green = tokens.find((t) => t.color === "green" && t.index === 0)!;
    green.steps = 39;
    expect(findCaptureTargets(tokens, "red", 0)).toEqual([]);
  });

  it("captures all stacked tokens on landing (no barrier)", () => {
    const stacked = createInitialTokens();
    const g0 = stacked.find((t) => t.color === "green" && t.index === 0)!;
    const g1 = stacked.find((t) => t.color === "green" && t.index === 1)!;
    g0.steps = 44;
    g1.steps = 44;
    expect(absoluteTrackPosition("green", 44)).toBe(5);

    const captured = findCaptureTargets(stacked, "red", 5);
    expect(captured).toHaveLength(2);
    expect(captured.map((t) => t.index).sort()).toEqual([0, 1]);
    expect(captured.every((t) => t.color === "green")).toBe(true);

    const red0 = stacked.find((t) => t.color === "red" && t.index === 0)!;
    red0.steps = 0;
    expect(getLegalMoves(stacked, "red", 5)).toContain(0);

    red0.steps = 4;
    expect(getLegalMoves(stacked, "red", 1)).toContain(0);
  });

  it("captures a lone opponent", () => {
    const lone = createInitialTokens();
    lone[0]!.steps = 5;
    const loneGreen = lone.find((t) => t.color === "green" && t.index === 0)!;
    loneGreen.steps = 44;
    expect(findCaptureTargets(lone, "red", 5).map((t) => t.color)).toEqual([
      "green",
    ]);
  });
});

describe("win and roll policy", () => {
  it("detects a finished colour", () => {
    const winners = createInitialTokens().map((t) =>
      t.color === "blue" ? { ...t, steps: 56 } : t,
    );
    expect(hasWon(winners, "blue")).toBe(true);
    expect(hasWon(winners, "red")).toBe(false);
  });

  it("applies three-sixes and no-move roll decisions", () => {
    expect(decideRollOutcome(6, 2, 4).kind).toBe("three_sixes");
    expect(decideRollOutcome(6, 1, 0).kind).toBe("no_moves_six");
    expect(decideRollOutcome(4, 0, 0).kind).toBe("no_moves");
    expect(decideRollOutcome(5, 0, 2).kind).toBe("ok");
    expect(gainsExtraTurn(6, false)).toBe(true);
    expect(gainsExtraTurn(3, true)).toBe(true);
    expect(gainsExtraTurn(3, false)).toBe(false);
    expect(gainsExtraTurn(3, false, true)).toBe(true);
  });

  it("captures six-streak snapshots and detects shared cells", () => {
    expect(startsSixStreak(6, 0)).toBe(true);
    expect(startsSixStreak(6, 1)).toBe(false);
    expect(startsSixStreak(5, 0)).toBe(false);

    const tokens = createInitialTokens(["red", "green"]);
    tokens[0]!.steps = 10;
    tokens[1]!.steps = 10;
    const snap = snapshotTokens(tokens);
    expect(snap).toHaveLength(8);
    expect(snap[0]).toEqual({ color: "red", index: 0, steps: 10 });

    expect(
      tokensShareCell(
        { color: "red", index: 0, steps: 10 },
        { color: "red", index: 1, steps: 10 },
      ),
    ).toBe(true);
    expect(
      tokensShareCell(
        { color: "red", index: 0, steps: 10 },
        { color: "green", index: 0, steps: 49 },
      ),
    ).toBe(true); // red@10 abs=10; green start 13 + 49 = 62 % 52 = 10
    expect(
      legalIndexesAtSameCell(tokens, "red", [0, 1], 0).sort(),
    ).toEqual([0, 1]);
    expect(legalIndexesAtSameCell(tokens, "red", [0], 0)).toEqual([0]);
  });

  it("puts leavers/eliminated after the winner in rankings", () => {
    expect(
      buildFinalRankings([], "green", [
        { color: "red", finishRank: 2 },
        { color: "green", finishRank: null },
        { color: "yellow", finishRank: 3 },
      ]),
    ).toEqual(["green", "red", "yellow"]);

    // First to leave (higher finishRank) is last place.
    expect(
      buildFinalRankings([], "blue", [
        { color: "blue" },
        { color: "red", finishRank: 3 },
        { color: "green", finishRank: 2 },
      ]),
    ).toEqual(["blue", "green", "red"]);
  });

  it("ends after N−1 home finishers (automatic last-place loser)", () => {
    // 2 players: first finisher → remaining is loser
    expect(
      shouldAssignAutomaticLoser([
        { eliminated: false, finishRank: 1 },
        { eliminated: false, finishRank: null },
      ]),
    ).toBe(true);

    // 3 players: only 1 finisher → continue
    expect(
      shouldAssignAutomaticLoser([
        { eliminated: false, finishRank: 1 },
        { eliminated: false, finishRank: null },
        { eliminated: false, finishRank: null },
      ]),
    ).toBe(false);

    // 3 players: 2 finishers → remaining is loser
    expect(
      shouldAssignAutomaticLoser([
        { eliminated: false, finishRank: 1 },
        { eliminated: false, finishRank: 2 },
        { eliminated: false, finishRank: null },
      ]),
    ).toBe(true);

    // 4 players: 3 finishers → remaining is loser
    expect(
      shouldAssignAutomaticLoser([
        { eliminated: false, finishRank: 1 },
        { eliminated: false, finishRank: 2 },
        { eliminated: false, finishRank: 3 },
        { eliminated: false, finishRank: null },
      ]),
    ).toBe(true);

    // Sole survivor via eliminations is NOT an automatic loser
    expect(
      shouldAssignAutomaticLoser([
        { eliminated: true, finishRank: 2 },
        { eliminated: true, finishRank: 3 },
        { eliminated: false, finishRank: null },
      ]),
    ).toBe(false);
  });

  it("labels house ranks as WINNER / LOSE", () => {
    expect(rankHouseLabel(1, 2)).toBe("WINNER");
    expect(rankHouseLabel(2, 2)).toBe("LOSE");
    expect(rankHouseLabel(2, 4)).toBe(null);
    expect(rankHouseLabel(4, 4)).toBe("LOSE");
    expect(rankHouseLabel(1, 4)).toBe("WINNER");
  });

  it("resolves overlapping token hits by nearest centre", () => {
    const a = { index: 0, x: 100, y: 100 };
    const b = { index: 1, x: 128, y: 100 }; // 28px apart (2-stack fan)
    // Click nearer to B
    expect(resolveTokenHit({ x: 120, y: 100 }, [a, b], 48)).toBe(1);
    // Click nearer to A
    expect(resolveTokenHit({ x: 105, y: 100 }, [a, b], 48)).toBe(0);
    // Outside both hit circles
    expect(resolveTokenHit({ x: 300, y: 300 }, [a, b], 48)).toBe(null);
  });
});

describe("fair dice", () => {
  it("detects when every token is still in the yard", () => {
    const tokens = createInitialTokens(["red", "green"]);
    expect(allTokensInYard(tokens, "red")).toBe(true);
    tokens[0]!.steps = 0;
    expect(allTokensInYard(tokens, "red")).toBe(false);
    expect(allTokensInYard(tokens, "green")).toBe(true);
  });

  it("rolls uniform 1–6 when not all in yard", () => {
    const seen = new Set<number>();
    for (let i = 0; i < 6; i++) {
      seen.add(rollFairDice(false, () => i / 6));
    }
    expect([...seen].sort()).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("boosts six mildly in the yard without guaranteeing it", () => {
    expect(YARD_SIX_WEIGHT).toBe(2);
    // Weights [1,1,1,1,1,2] total 7 — last 2/7 of the unit interval → 6
    expect(rollFairDice(true, () => 0)).toBe(1);
    expect(rollFairDice(true, () => 5 / 7)).toBe(6);
    expect(rollFairDice(true, () => 4.9 / 7)).toBe(5);
  });

  it("does not pick faces from legal-move advantage", () => {
    // Same RNG in yard or not must not inspect board state beyond the flag.
    expect(rollFairDice(false, () => 0.99)).toBe(6);
    expect(rollFairDice(true, () => 0.99)).toBe(6);
    expect(rollFairDice(true, () => 0.1)).toBe(1);
  });
});

describe("session, codes, and board geometry", () => {
  it("validates client ids", () => {
    expect(() =>
      assertValidClientId("550e8400-e29b-41d4-a716-446655440000"),
    ).not.toThrow();
    expect(() => assertValidClientId("not-a-uuid")).toThrow(GameError.invalidSession);
    expect(() => assertValidClientId("host-1")).toThrow(GameError.invalidSession);
  });

  it("validates room codes", () => {
    expect(assertValidRoomCode("ab23cd")).toBe("AB23CD");
    expect(() => assertValidRoomCode("ABC")).toThrow(GameError.invalidCode);
    expect(() => assertValidRoomCode("OOOOOO")).toThrow(GameError.invalidCode);
    expect(() => assertValidRoomCode("AB1ICD")).toThrow(GameError.invalidCode);
  });

  it("enforces action intervals", () => {
    const now = 1_000_000;
    expect(assertActionInterval(undefined, 100, now)).toBe(now);
    expect(() => assertActionInterval(now - 50, 100, now)).toThrow(
      GameError.rateLimited,
    );
    expect(assertActionInterval(now - 150, 100, now)).toBe(now);
  });

  it("normalizes room codes and fans stacked tokens", () => {
    expect(normalizeCode("ab-12!")).toBe("AB12");
    expect(stackFanOffset(0, 1).x).toBe(0);
    const pair = stackFanOffset(0, 2);
    expect(pair.x !== 0 || pair.y !== 0).toBe(true);

    const a = { color: "red" as const, index: 0, steps: 5 };
    const b = { color: "blue" as const, index: 0, steps: 18 };
    expect(tokenStackKey(a.color, a.index, a.steps)).toBe(
      tokenStackKey(b.color, b.index, b.steps),
    );
    const posA = tokenSvgPosition("red", 0, 5, 0, 2);
    const posB = tokenSvgPosition("blue", 0, 18, 1, 2);
    expect(posA.x !== posB.x || posA.y !== posB.y).toBe(true);
  });

  it("keeps finished tokens inside their own home triangle", () => {
    // Board polygons use corner-space pixels: vertex (c,r) → (c*CELL, r*CELL).
    const distToSegment = (
      px: number,
      py: number,
      ax: number,
      ay: number,
      bx: number,
      by: number,
    ) => {
      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy || 1;
      const t = Math.max(
        0,
        Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2),
      );
      return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    };

    const inside = (
      px: number,
      py: number,
      a: [number, number],
      b: [number, number],
      c: [number, number],
    ) => {
      const sign = (
        x1: number,
        y1: number,
        x2: number,
        y2: number,
        x3: number,
        y3: number,
      ) => (x1 - x3) * (y2 - y3) - (x2 - x3) * (y1 - y3);
      const d1 = sign(px, py, a[0], a[1], b[0], b[1]);
      const d2 = sign(px, py, b[0], b[1], c[0], c[1]);
      const d3 = sign(px, py, c[0], c[1], a[0], a[1]);
      const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
      const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
      return !(hasNeg && hasPos);
    };

    const CELL = 100;
    // Finished tokens use body radius 16 + stroke ≤3 → need ≥19px clearance.
    const MIN_EDGE_PX = 19;
    const triangles = {
      red: [
        [6 * CELL, 6 * CELL],
        [6 * CELL, 9 * CELL],
        [7.5 * CELL, 7.5 * CELL],
      ] as [[number, number], [number, number], [number, number]],
      green: [
        [6 * CELL, 6 * CELL],
        [9 * CELL, 6 * CELL],
        [7.5 * CELL, 7.5 * CELL],
      ] as [[number, number], [number, number], [number, number]],
      yellow: [
        [9 * CELL, 6 * CELL],
        [9 * CELL, 9 * CELL],
        [7.5 * CELL, 7.5 * CELL],
      ] as [[number, number], [number, number], [number, number]],
      blue: [
        [6 * CELL, 9 * CELL],
        [9 * CELL, 9 * CELL],
        [7.5 * CELL, 7.5 * CELL],
      ] as [[number, number], [number, number], [number, number]],
    };

    for (const color of ["red", "green", "yellow", "blue"] as const) {
      const tri = triangles[color];
      for (let i = 0; i < 4; i++) {
        const slot = HOME_FINISHED_SLOTS[color][i]!;
        const pos = tokenSvgPosition(color, i, 56);
        expect(pos.x).toBe(slot[0] * CELL);
        expect(pos.y).toBe(slot[1] * CELL);

        expect(inside(pos.x, pos.y, ...tri)).toBe(true);
        const edge = Math.min(
          distToSegment(pos.x, pos.y, tri[0][0], tri[0][1], tri[1][0], tri[1][1]),
          distToSegment(pos.x, pos.y, tri[1][0], tri[1][1], tri[2][0], tri[2][1]),
          distToSegment(pos.x, pos.y, tri[2][0], tri[2][1], tri[0][0], tri[0][1]),
        );
        expect(edge).toBeGreaterThanOrEqual(MIN_EDGE_PX);

        for (const other of ["red", "green", "yellow", "blue"] as const) {
          if (other === color) continue;
          expect(inside(pos.x, pos.y, ...triangles[other])).toBe(false);
        }
      }
    }
  });
});

describe("bot weight helpers", () => {
  it("trackDistanceBehind wraps the 52-cell track", () => {
    expect(trackDistanceBehind(50, 2)).toBe(4);
    expect(trackDistanceBehind(10, 10)).toBe(0);
    expect(trackDistanceBehind(5, 10)).toBe(5);
  });

  it("isOutsideEnemyYard detects the cell after an opponent start", () => {
    // Yellow start 26 → outside is 27; green start 13 → 14.
    expect(isOutsideEnemyYard(27, "red")).toBe(true);
    expect(isOutsideEnemyYard(14, "red")).toBe(true);
    expect(isOutsideEnemyYard(1, "red")).toBe(false); // after own start
    expect(isOutsideEnemyYard(8, "red")).toBe(false);
  });

  it("isInImmediateDanger uses the 7-step rule", () => {
    // Red at abs 10; yellow at abs 7 → dist 3 (danger).
    // yellow abs = (26 + steps) % 52 = 7 → steps = 33.
    const danger = [
      { color: "red" as const, index: 0, steps: 10 },
      { color: "yellow" as const, index: 0, steps: 33 },
    ];
    expect(isInImmediateDanger(danger, "red", 10)).toBe(true);

    // Yellow at abs 3 → dist 7 (not immediate).
    // (26 + steps) % 52 = 3 → steps = 29.
    const far = [
      { color: "red" as const, index: 0, steps: 10 },
      { color: "yellow" as const, index: 0, steps: 29 },
    ];
    expect(isInImmediateDanger(far, "red", 10)).toBe(false);

    // Safe cell is never in danger (red start abs 0).
    expect(isInImmediateDanger(danger, "red", 0)).toBe(false);
  });
});

describe("bot move picker", () => {
  it("prefers a capture over a plain advance", () => {
    // red steps 1, dice 2 → dest 3 → abs 3. Place yellow so its abs is 3:
    // yellow abs = (26 + steps) % 52 = 3 → steps = 29.
    const tokens = [
      { color: "red" as const, index: 0, steps: 1 },
      { color: "red" as const, index: 1, steps: 20 },
      { color: "red" as const, index: 2, steps: -1 },
      { color: "red" as const, index: 3, steps: -1 },
      { color: "yellow" as const, index: 0, steps: 29 },
      { color: "yellow" as const, index: 1, steps: -1 },
      { color: "yellow" as const, index: 2, steps: -1 },
      { color: "yellow" as const, index: 3, steps: -1 },
    ];
    expect(pickBotMove(tokens, "red", 2)).toBe(0);
  });

  it("prefers finishing over leaving the yard", () => {
    const tokens = [
      { color: "red" as const, index: 0, steps: 55 },
      { color: "red" as const, index: 1, steps: -1 },
      { color: "red" as const, index: 2, steps: -1 },
      { color: "red" as const, index: 3, steps: -1 },
    ];
    expect(pickBotMove(tokens, "red", 1)).toBe(0);
  });

  it("returns null when there are no legal moves", () => {
    const tokens = createInitialTokens(["red", "yellow"]);
    expect(pickBotMove(tokens, "red", 3)).toBeNull();
  });

  it("prefers a safe landing over a farther unsafe advance", () => {
    // Token 0: steps 20 + 3 → 23 (unsafe). Token 1: steps 5 + 3 → 8 (safe).
    const tokens = [
      { color: "red" as const, index: 0, steps: 20 },
      { color: "red" as const, index: 1, steps: 5 },
      { color: "red" as const, index: 2, steps: -1 },
      { color: "red" as const, index: 3, steps: -1 },
    ];
    expect(pickBotMove(tokens, "red", 3)).toBe(1);
  });

  it("escapes when an enemy is 1–6 spaces behind", () => {
    // Token 0 at abs 10 threatened by yellow at abs 7 (dist 3).
    // Dice 4 → dest 14 leaves threat range (+50 escape).
    // Token 1 at 25 is safe; plain advance only gets progress.
    const tokens = [
      { color: "red" as const, index: 0, steps: 10 },
      { color: "red" as const, index: 1, steps: 25 },
      { color: "red" as const, index: 2, steps: -1 },
      { color: "red" as const, index: 3, steps: -1 },
      { color: "yellow" as const, index: 0, steps: 33 }, // abs 7
      { color: "yellow" as const, index: 1, steps: -1 },
      { color: "yellow" as const, index: 2, steps: -1 },
      { color: "yellow" as const, index: 3, steps: -1 },
    ];
    expect(pickBotMove(tokens, "red", 4)).toBe(0);
  });

  it("does not treat an enemy 7+ behind as immediate danger", () => {
    // Token 1 has yellow 7 behind — must not get escape bonus.
    // Both land unsafe with equal progress → stable tie-break prefers index 0.
    // If escape were wrongly applied to token 1, it would win instead.
    const tokens = [
      { color: "red" as const, index: 0, steps: 22 },
      { color: "red" as const, index: 1, steps: 15 },
      { color: "red" as const, index: 2, steps: -1 },
      { color: "red" as const, index: 3, steps: -1 },
      // yellow abs 8; red1 abs 15 → dist 7
      // (26 + steps) % 52 = 8 → steps = 34
      { color: "yellow" as const, index: 0, steps: 34 },
      { color: "yellow" as const, index: 1, steps: -1 },
      { color: "yellow" as const, index: 2, steps: -1 },
      { color: "yellow" as const, index: 3, steps: -1 },
    ];
    // dice 2: token0 22→24, token1 15→17 — both unsafe, equal progress
    expect(pickBotMove(tokens, "red", 2)).toBe(0);
  });

  it("prefers deploying a new token when fewer than 2 are active", () => {
    // Lone runner at 30 vs yard release on 6: deploy (+55+40) beats progress.
    const tokens = [
      { color: "red" as const, index: 0, steps: 30 },
      { color: "red" as const, index: 1, steps: -1 },
      { color: "red" as const, index: 2, steps: -1 },
      { color: "red" as const, index: 3, steps: -1 },
    ];
    expect(pickBotMove(tokens, "red", 6)).toBe(1);
  });

  it("prefers a non-stacking landing when scores are otherwise close", () => {
    // Token 0: steps 10 + 2 → 12, stacks on token 1 (−25).
    // Token 2: steps 5 + 2 → 7, empty cell.
    const tokens = [
      { color: "red" as const, index: 0, steps: 10 },
      { color: "red" as const, index: 1, steps: 12 },
      { color: "red" as const, index: 2, steps: 5 },
      { color: "red" as const, index: 3, steps: -1 },
    ];
    expect(pickBotMove(tokens, "red", 2)).toBe(2);
  });
});
