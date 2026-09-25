import { describe, expect, it } from "vitest";
import {
  allTokensInYard,
  canRelease,
  createInitialTokens,
  decideRollOutcome,
  findCaptureTarget,
  buildFinalRankings,
  gainsExtraTurn,
  getLegalMoves,
  hasWon,
  isBarrierAbsolute,
  legalIndexesAtSameCell,
  nextColorAmong,
  pickNextColor,
  rollFairDice,
  snapshotTokens,
  stackFanOffset,
  startsSixStreak,
  tokensShareCell,
  tryMoveSteps,
  absoluteTrackPosition,
  YARD_SIX_WEIGHT,
} from "../convex/lib/ludo";
import { pickBotMove } from "../convex/lib/bot";
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

describe("capture and barriers", () => {
  it("captures on overlapping non-safe cells", () => {
    const tokens = createInitialTokens();
    tokens[0]!.steps = 5;
    const green = tokens.find((t) => t.color === "green" && t.index === 0)!;
    green.steps = 44;
    expect(findCaptureTarget(tokens, "red", 5)?.color).toBe("green");
  });

  it("does not capture on safe cells", () => {
    const tokens = createInitialTokens();
    tokens[0]!.steps = 0;
    const green = tokens.find((t) => t.color === "green" && t.index === 0)!;
    green.steps = 39;
    expect(findCaptureTarget(tokens, "red", 0)).toBeNull();
  });

  it("blocks landing on and capturing barriers", () => {
    const barrierTokens = createInitialTokens();
    const g0 = barrierTokens.find((t) => t.color === "green" && t.index === 0)!;
    const g1 = barrierTokens.find((t) => t.color === "green" && t.index === 1)!;
    g0.steps = 44;
    g1.steps = 44;
    expect(absoluteTrackPosition("green", 44)).toBe(5);
    expect(isBarrierAbsolute(barrierTokens, 5, "red")).toBe(true);
    expect(findCaptureTarget(barrierTokens, "red", 5)).toBeNull();

    const red0 = barrierTokens.find((t) => t.color === "red" && t.index === 0)!;
    red0.steps = 0;
    expect(getLegalMoves(barrierTokens, "red", 5)).not.toContain(0);

    red0.steps = 3;
    expect(getLegalMoves(barrierTokens, "red", 3)).toContain(0);
  });

  it("captures a lone opponent", () => {
    const lone = createInitialTokens();
    lone[0]!.steps = 5;
    const loneGreen = lone.find((t) => t.color === "green" && t.index === 0)!;
    loneGreen.steps = 44;
    expect(findCaptureTarget(lone, "red", 5)?.color).toBe("green");
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

describe("bot move picker", () => {
  it("prefers a capture over a plain advance", () => {
    // Red at steps 5 can move 3 → abs 8 (safe) or we put yellow alone on abs of dest.
    // Red start=0; yellow start=26. Put red at 10, yellow at absolute overlapping with red+3.
    // red steps 10 → abs 10; dice 3 → dest 13 → abs 13 (green start, safe — no capture).
    // Use red steps 4, dice 4 → dest 8 → abs 8 (safe).
    // red steps 1, dice 2 → dest 3 → abs 3. Place yellow so its abs is 3:
    // yellow abs = (26 + steps) % 52 = 3 → steps = (3 - 26 + 52) % 52 = 29.
    const tokens = [
      { color: "red" as const, index: 0, steps: 1 },
      { color: "red" as const, index: 1, steps: -1 },
      { color: "red" as const, index: 2, steps: -1 },
      { color: "red" as const, index: 3, steps: -1 },
      { color: "yellow" as const, index: 0, steps: 29 },
      { color: "yellow" as const, index: 1, steps: -1 },
      { color: "yellow" as const, index: 2, steps: -1 },
      { color: "yellow" as const, index: 3, steps: -1 },
    ];
    // Also give red a farther token that does not capture.
    tokens[1] = { color: "red", index: 1, steps: 20 };
    const pick = pickBotMove(tokens, "red", 2);
    expect(pick).toBe(0);
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
});
