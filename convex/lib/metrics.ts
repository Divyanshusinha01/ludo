import { v } from "convex/values";
import type { MutationCtx } from "../_generated/server";
import { GameError } from "./errors";

/**
 * Fixed, low-cardinality metric labels. Room ids, client ids and room codes
 * must never become labels: every label value comes from these lists.
 */
export const METRIC_KINDS = [
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
] as const;

export const METRIC_OUTCOMES = [
  "ok",
  "stale",
  "rate_limited",
  "rejected",
  "error",
] as const;

export const METRIC_SOURCES = ["server", "client"] as const;

export type MetricKind = (typeof METRIC_KINDS)[number];
export type MetricOutcome = (typeof METRIC_OUTCOMES)[number];
export type MetricSource = (typeof METRIC_SOURCES)[number];

export const metricKindValidator = v.union(
  ...METRIC_KINDS.map((k) => v.literal(k)),
);
export const metricOutcomeValidator = v.union(
  ...METRIC_OUTCOMES.map((o) => v.literal(o)),
);
export const metricSourceValidator = v.union(
  ...METRIC_SOURCES.map((s) => v.literal(s)),
);

export function isMetricKind(value: string): value is MetricKind {
  return (METRIC_KINDS as readonly string[]).includes(value);
}

export function isMetricOutcome(value: string): value is MetricOutcome {
  return (METRIC_OUTCOMES as readonly string[]).includes(value);
}

/** Client-observed latencies are clamped into this range before storage. */
export const MAX_LATENCY_MS = 60_000;

/**
 * Upper bounds (inclusive, ms) of the latency histogram buckets. Roughly
 * log-scale; the last bound equals MAX_LATENCY_MS so every clamped sample fits.
 */
export const LATENCY_BUCKETS_MS = [
  5, 10, 25, 50, 75, 100, 150, 250, 400, 600, 1_000, 1_500, 2_500, 4_000,
  6_000, 10_000, 15_000, 30_000, MAX_LATENCY_MS,
] as const;

export function clampLatency(ms: number): number {
  if (!Number.isFinite(ms) || ms < 0) return 0;
  return Math.min(Math.round(ms), MAX_LATENCY_MS);
}

export function latencyBucket(ms: number): number {
  const clamped = clampLatency(ms);
  const i = LATENCY_BUCKETS_MS.findIndex((bound) => clamped <= bound);
  return i === -1 ? LATENCY_BUCKETS_MS.length - 1 : i;
}

export function emptyHistogram(): number[] {
  return LATENCY_BUCKETS_MS.map(() => 0);
}

export function mergeHistograms(a: number[], b: number[]): number[] {
  return LATENCY_BUCKETS_MS.map((_, i) => (a[i] ?? 0) + (b[i] ?? 0));
}

/**
 * Percentile estimate from a bucketed histogram, interpolating linearly inside
 * the bucket that holds the target rank. Null when the histogram is empty.
 */
export function histogramPercentile(hist: number[], p: number): number | null {
  const total = hist.reduce((sum, n) => sum + n, 0);
  if (total === 0) return null;
  const rank = Math.max(1, Math.ceil((Math.min(Math.max(p, 0), 100) / 100) * total));
  let before = 0;
  for (let i = 0; i < LATENCY_BUCKETS_MS.length; i++) {
    const count = hist[i] ?? 0;
    if (count > 0 && before + count >= rank) {
      const lower = i === 0 ? 0 : LATENCY_BUCKETS_MS[i - 1]!;
      const upper = LATENCY_BUCKETS_MS[i]!;
      return lower + ((rank - before) / count) * (upper - lower);
    }
    before += count;
  }
  return LATENCY_BUCKETS_MS[LATENCY_BUCKETS_MS.length - 1]!;
}

type GameErrorKey = keyof typeof GameError;

/** Stable machine codes for rejections; messages may change, codes must not. */
const CODE_OVERRIDES: Partial<Record<GameErrorKey, string>> = {
  staleAction: "stale",
  rateLimited: "rate_limited",
};

function snakeCase(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

const CODE_BY_MESSAGE: ReadonlyMap<string, string> = new Map(
  (Object.keys(GameError) as GameErrorKey[]).map((key) => [
    GameError[key],
    CODE_OVERRIDES[key] ?? snakeCase(key),
  ]),
);

/** Every code `errorCodeFor` can return, so clients can be validated against it. */
export const ERROR_CODES: ReadonlySet<string> = new Set([
  ...CODE_BY_MESSAGE.values(),
  "internal",
]);

/** Map a thrown error message to a stable code; unknown errors are `internal`. */
export function errorCodeFor(message: string): string {
  return CODE_BY_MESSAGE.get(message) ?? "internal";
}

/** Metric outcome for a rejection with the given stable code. */
export function outcomeForCode(code: string): MetricOutcome {
  if (code === "stale") return "stale";
  if (code === "rate_limited") return "rate_limited";
  if (code === "internal") return "error";
  return "rejected";
}

export const opsSampleFields = {
  at: v.number(),
  kind: metricKindValidator,
  outcome: metricOutcomeValidator,
  latencyMs: v.optional(v.number()),
  source: metricSourceValidator,
};

/**
 * One insert per sample: no shared counter rows, so the gameplay hot path
 * never contends on metrics writes. The minute rollup aggregates later.
 */
export async function recordSample(
  ctx: MutationCtx,
  sample: {
    kind: MetricKind;
    outcome?: MetricOutcome;
    latencyMs?: number;
    source?: MetricSource;
    at?: number;
  },
): Promise<void> {
  await ctx.db.insert("opsSamples", {
    at: sample.at ?? Date.now(),
    kind: sample.kind,
    outcome: sample.outcome ?? "ok",
    source: sample.source ?? "server",
    ...(sample.latencyMs !== undefined
      ? { latencyMs: clampLatency(sample.latencyMs) }
      : {}),
  });
}

export const MINUTE_MS = 60_000;

export function minuteOf(at: number): number {
  return Math.floor(at / MINUTE_MS) * MINUTE_MS;
}
