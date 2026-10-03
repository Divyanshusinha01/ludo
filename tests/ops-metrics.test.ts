import { describe, expect, it } from "vitest";
import { GameError } from "../convex/lib/errors";
import {
  clampLatency,
  emptyHistogram,
  ERROR_CODES,
  errorCodeFor,
  histogramPercentile,
  isMetricKind,
  isMetricOutcome,
  LATENCY_BUCKETS_MS,
  latencyBucket,
  MAX_LATENCY_MS,
  mergeHistograms,
  METRIC_KINDS,
  METRIC_OUTCOMES,
  minuteOf,
  outcomeForCode,
} from "../convex/lib/metrics";
import { mulberry32 } from "./game/fixtures/dice";

function histogramOf(latencies: number[]): number[] {
  const hist = emptyHistogram();
  for (const ms of latencies) hist[latencyBucket(ms)]!++;
  return hist;
}

/** Nearest-rank percentile of the raw values: the reference the estimate must bracket. */
function nearestRank(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

describe("latency buckets", () => {
  it("bounds are strictly increasing and end at the latency clamp", () => {
    for (let i = 1; i < LATENCY_BUCKETS_MS.length; i++) {
      expect(LATENCY_BUCKETS_MS[i]!).toBeGreaterThan(LATENCY_BUCKETS_MS[i - 1]!);
    }
    expect(LATENCY_BUCKETS_MS.at(-1)).toBe(MAX_LATENCY_MS);
  });

  it("each bound is inclusive and the next value falls in the next bucket", () => {
    LATENCY_BUCKETS_MS.forEach((bound, i) => {
      expect(latencyBucket(bound)).toBe(i);
      if (i < LATENCY_BUCKETS_MS.length - 1) expect(latencyBucket(bound + 1)).toBe(i + 1);
    });
    expect(latencyBucket(0)).toBe(0);
  });

  it("clamps negative, non-finite and oversized latencies", () => {
    expect(clampLatency(-5)).toBe(0);
    expect(clampLatency(Number.NaN)).toBe(0);
    expect(clampLatency(Number.POSITIVE_INFINITY)).toBe(0);
    expect(clampLatency(12.6)).toBe(13);
    expect(clampLatency(MAX_LATENCY_MS * 10)).toBe(MAX_LATENCY_MS);
    expect(latencyBucket(MAX_LATENCY_MS * 10)).toBe(LATENCY_BUCKETS_MS.length - 1);
  });

  it("merging adds bucket counts", () => {
    const a = histogramOf([1, 7, 7, 300]);
    const b = histogramOf([7, 300, 59_000]);
    expect(mergeHistograms(a, b)).toEqual(histogramOf([1, 7, 7, 300, 7, 300, 59_000]));
  });
});

describe("histogramPercentile", () => {
  it("is null for an empty histogram", () => {
    expect(histogramPercentile(emptyHistogram(), 50)).toBeNull();
  });

  it("matches exact percentiles for 1..100 ms (uniform within buckets)", () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    const hist = histogramOf(values);
    expect(histogramPercentile(hist, 50)).toBe(50);
    expect(histogramPercentile(hist, 95)).toBe(95);
    expect(histogramPercentile(hist, 99)).toBe(99);
    expect(histogramPercentile(hist, 100)).toBe(100);
  });

  it("interpolates inside a single bucket", () => {
    const hist = histogramOf(Array.from({ length: 10 }, () => 3));
    expect(histogramPercentile(hist, 50)).toBe(2.5);
    expect(histogramPercentile(hist, 100)).toBe(5);
  });

  it("is monotonic in p", () => {
    const rng = mulberry32(7);
    const hist = histogramOf(Array.from({ length: 500 }, () => Math.floor(rng() * 3_000)));
    let prev = 0;
    for (let p = 1; p <= 100; p++) {
      const value = histogramPercentile(hist, p)!;
      expect(value).toBeGreaterThanOrEqual(prev);
      prev = value;
    }
  });

  it.each([1, 2, 3, 4, 5])("seed %i: estimate lies in the bucket holding the true percentile", (seed) => {
    const rng = mulberry32(seed);
    const values = Array.from({ length: 1 + Math.floor(rng() * 400) }, () =>
      Math.round(Math.exp(rng() * Math.log(MAX_LATENCY_MS))),
    );
    const hist = histogramOf(values);
    for (const p of [50, 95, 99]) {
      const exact = nearestRank(values, p);
      const bucket = latencyBucket(exact);
      const lower = bucket === 0 ? 0 : LATENCY_BUCKETS_MS[bucket - 1]!;
      const upper = LATENCY_BUCKETS_MS[bucket]!;
      const estimate = histogramPercentile(hist, p)!;
      expect(estimate).toBeGreaterThanOrEqual(lower);
      expect(estimate).toBeLessThanOrEqual(upper);
    }
  });
});

describe("error codes", () => {
  it("maps stale and rate-limit messages to the outcome codes", () => {
    expect(errorCodeFor(GameError.staleAction)).toBe("stale");
    expect(errorCodeFor(GameError.rateLimited)).toBe("rate_limited");
    expect(outcomeForCode("stale")).toBe("stale");
    expect(outcomeForCode("rate_limited")).toBe("rate_limited");
  });

  it("maps other game errors to stable snake_case codes with a rejected outcome", () => {
    expect(errorCodeFor(GameError.notYourTurn)).toBe("not_your_turn");
    expect(errorCodeFor(GameError.illegalMove)).toBe("illegal_move");
    expect(errorCodeFor(GameError.roomNotFound)).toBe("room_not_found");
    expect(outcomeForCode("not_your_turn")).toBe("rejected");
  });

  it("maps unknown errors to internal with an error outcome", () => {
    expect(errorCodeFor("TypeError: x is undefined")).toBe("internal");
    expect(errorCodeFor("")).toBe("internal");
    expect(outcomeForCode("internal")).toBe("error");
  });

  it("gives every game error a distinct code", () => {
    const messages = Object.values(GameError);
    const codes = new Set(messages.map(errorCodeFor));
    expect(codes.size).toBe(messages.length);
    expect(codes.has("internal")).toBe(false);
    for (const code of codes) expect(ERROR_CODES.has(code)).toBe(true);
    expect(ERROR_CODES.has("internal")).toBe(true);
  });
});

describe("label whitelists", () => {
  it("kinds and outcomes are the fixed lists from the plan", () => {
    expect([...METRIC_KINDS]).toEqual([
      "roll",
      "move",
      "pass",
      "join",
      "create",
      "start",
      "leave",
      "heartbeat",
      "reconnect",
      "resync",
      "timeout",
      "bot",
    ]);
    expect([...METRIC_OUTCOMES]).toEqual(["ok", "stale", "rate_limited", "rejected", "error"]);
  });

  it("rejects unknown kinds and outcomes", () => {
    for (const kind of METRIC_KINDS) expect(isMetricKind(kind)).toBe(true);
    for (const outcome of METRIC_OUTCOMES) expect(isMetricOutcome(outcome)).toBe(true);
    for (const bogus of ["", "ROLL", "chat", "room:ABC123", "00000000-0000-4000-8000-000000000001"]) {
      expect(isMetricKind(bogus)).toBe(false);
      expect(isMetricOutcome(bogus)).toBe(false);
    }
  });
});

describe("minuteOf", () => {
  it("floors to the start of the minute", () => {
    const t = Date.UTC(2026, 0, 1, 12, 34, 56, 789);
    expect(minuteOf(t)).toBe(Date.UTC(2026, 0, 1, 12, 34));
    expect(minuteOf(Date.UTC(2026, 0, 1, 12, 34))).toBe(Date.UTC(2026, 0, 1, 12, 34));
  });
});
