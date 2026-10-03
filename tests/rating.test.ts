import { describe, expect, it } from "vitest";
import {
  computeRatingChanges,
  expectedScore,
  INITIAL_RATING,
  K_ESTABLISHED,
  K_PROVISIONAL,
  kFactor,
  mutuallyAcceptable,
  PROVISIONAL_GAMES,
  RATING_FLOOR,
  ratingWindow,
  WINDOW_MAX,
  type RatingInput,
} from "../convex/lib/rating";

function p(key: string, placement: number, extra: Partial<RatingInput> = {}): RatingInput {
  return { key, rating: INITIAL_RATING, ratedGames: 0, placement, ...extra };
}

function deltas(players: RatingInput[]): Record<string, number> {
  return Object.fromEntries(computeRatingChanges(players).map((c) => [c.key, c.delta]));
}

describe("expectedScore", () => {
  it("is 0.5 for equal ratings and complementary otherwise", () => {
    expect(expectedScore(1200, 1200)).toBe(0.5);
    expect(expectedScore(1400, 1200) + expectedScore(1200, 1400)).toBeCloseTo(1, 12);
    expect(expectedScore(1600, 1200)).toBeCloseTo(10 / 11, 6);
  });
});

describe("duel", () => {
  it("equal provisional ratings move by K/2", () => {
    expect(deltas([p("a", 1), p("b", 2)])).toEqual({ a: K_PROVISIONAL / 2, b: -K_PROVISIONAL / 2 });
  });

  it("is symmetric in input order", () => {
    const one = deltas([p("a", 1, { rating: 1350 }), p("b", 2, { rating: 1180 })]);
    const two = deltas([p("b", 2, { rating: 1180 }), p("a", 1, { rating: 1350 })]);
    expect(one).toEqual(two);
  });

  it("is zero-sum within rounding when both use the same K", () => {
    for (const [ra, rb] of [[1200, 1200], [1500, 1100], [900, 1700], [1234, 1321]]) {
      const changes = computeRatingChanges([p("a", 1, { rating: ra }), p("b", 2, { rating: rb })]);
      expect(Math.abs(changes[0]!.delta + changes[1]!.delta)).toBeLessThanOrEqual(1);
    }
  });

  it("an upset moves ratings more than an expected win", () => {
    const expected = deltas([p("fav", 1, { rating: 1500 }), p("dog", 2, { rating: 1200 })]);
    const upset = deltas([p("fav", 2, { rating: 1500 }), p("dog", 1, { rating: 1200 })]);
    expect(upset.dog!).toBeGreaterThan(expected.fav!);
    expect(expected.fav!).toBeGreaterThan(0);
    expect(upset.fav!).toBeLessThan(-K_PROVISIONAL / 2);
  });

  it("K drops after the provisional games", () => {
    expect(kFactor(0)).toBe(K_PROVISIONAL);
    expect(kFactor(PROVISIONAL_GAMES - 1)).toBe(K_PROVISIONAL);
    expect(kFactor(PROVISIONAL_GAMES)).toBe(K_ESTABLISHED);
    const d = deltas([p("vet", 1, { ratedGames: PROVISIONAL_GAMES }), p("new", 2)]);
    expect(d).toEqual({ vet: K_ESTABLISHED / 2, new: -K_PROVISIONAL / 2 });
  });

  it("never drops below the floor", () => {
    const changes = computeRatingChanges([
      p("low", 2, { rating: RATING_FLOOR + 5 }),
      p("high", 1, { rating: RATING_FLOOR + 5 }),
    ]);
    const low = changes.find((c) => c.key === "low")!;
    expect(low.ratingAfter).toBe(RATING_FLOOR);
    expect(low.delta).toBe(-5);
  });

  it("returns before, after and delta consistently", () => {
    for (const c of computeRatingChanges([p("a", 1, { rating: 1310 }), p("b", 2, { rating: 1290 })])) {
      expect(c.ratingAfter - c.ratingBefore).toBe(c.delta);
      expect(Number.isInteger(c.ratingAfter)).toBe(true);
    }
  });
});

describe("free-for-all", () => {
  it("4 equal players: pairwise, scaled by 1/(n-1)", () => {
    expect(deltas([p("a", 1), p("b", 2), p("c", 3), p("d", 4)])).toEqual({ a: 20, b: 7, c: -7, d: -20 });
  });

  it("3 equal players", () => {
    expect(deltas([p("a", 1), p("b", 2), p("c", 3)])).toEqual({ a: 20, b: 0, c: -20 });
  });

  it("deltas follow placement and sum to about zero with equal K", () => {
    const players = [
      p("a", 3, { rating: 1400 }),
      p("b", 1, { rating: 1100 }),
      p("c", 4, { rating: 1250 }),
      p("d", 2, { rating: 1320 }),
    ];
    const d = deltas(players);
    expect(d.b!).toBeGreaterThan(d.d!);
    expect(d.d!).toBeGreaterThan(d.a!);
    expect(d.a!).toBeGreaterThan(d.c!);
    const sum = Object.values(d).reduce((s, x) => s + x, 0);
    expect(Math.abs(sum)).toBeLessThanOrEqual(2);
  });

  it("one player alone does not move", () => {
    expect(deltas([p("a", 1)])).toEqual({ a: 0 });
  });
});

describe("2v2", () => {
  it("uses team averages and applies the team result to both members", () => {
    const d = deltas([
      p("a1", 1, { team: "A", rating: 1300 }),
      p("a2", 2, { team: "A", rating: 1100 }),
      p("b1", 3, { team: "B", rating: 1250 }),
      p("b2", 4, { team: "B", rating: 1150 }),
    ]);
    // Both team averages are 1200, so this plays like an even duel.
    expect(d).toEqual({ a1: 20, a2: 20, b1: -20, b2: -20 });
  });

  it("the team's best placement is its result", () => {
    const d = deltas([
      p("a1", 2, { team: "A" }),
      p("a2", 4, { team: "A" }),
      p("b1", 1, { team: "B" }),
      p("b2", 3, { team: "B" }),
    ]);
    expect(d).toEqual({ a1: -20, a2: -20, b1: 20, b2: 20 });
  });

  it("an underdog team gains more for winning", () => {
    const d = deltas([
      p("a1", 1, { team: "A", rating: 1100 }),
      p("a2", 1, { team: "A", rating: 1100 }),
      p("b1", 2, { team: "B", rating: 1400 }),
      p("b2", 2, { team: "B", rating: 1400 }),
    ]);
    expect(d.a1!).toBeGreaterThan(20);
    expect(d.a1).toBe(d.a2);
    expect(d.b1).toBe(-d.a1!);
  });

  it("each member uses their own K", () => {
    const d = deltas([
      p("a1", 1, { team: "A" }),
      p("a2", 1, { team: "A", ratedGames: PROVISIONAL_GAMES }),
      p("b1", 2, { team: "B" }),
      p("b2", 2, { team: "B" }),
    ]);
    expect(d).toEqual({ a1: 20, a2: 12, b1: -20, b2: -20 });
  });
});

describe("acceptance window", () => {
  it("starts at 100, widens 50 per 10s, and caps", () => {
    expect(ratingWindow(0)).toBe(100);
    expect(ratingWindow(9_999)).toBe(100);
    expect(ratingWindow(10_000)).toBe(150);
    expect(ratingWindow(35_000)).toBe(250);
    expect(ratingWindow(10 * 60_000)).toBe(WINDOW_MAX);
    expect(ratingWindow(-5)).toBe(100);
  });

  it("requires both tickets' windows to cover the gap", () => {
    const now = 100_000;
    const old = { rating: 1200, joinedAt: now - 60_000 };
    const fresh = { rating: 1400, joinedAt: now };
    expect(mutuallyAcceptable(old, fresh, now)).toBe(false);
    expect(mutuallyAcceptable(old, fresh, now + 20_000)).toBe(true);
    expect(mutuallyAcceptable(old, { rating: 1300, joinedAt: now }, now)).toBe(true);
  });
});
