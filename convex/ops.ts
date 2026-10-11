import {
  internalMutation,
  mutation,
  query,
  MutationCtx,
} from "./_generated/server";
import { v } from "convex/values";
import { Doc } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { GameError, fail } from "./lib/errors";
import {
  emptyHistogram,
  ERROR_CODES,
  errorCodeFor,
  histogramPercentile,
  latencyBucket,
  mergeHistograms,
  metricKindValidator,
  metricOutcomeValidator,
  minuteOf,
  MINUTE_MS,
  recordSample,
  type MetricKind,
  type MetricOutcome,
} from "./lib/metrics";
import { requirePlayer } from "./lib/roomAuth";
import {
  assertValidClientId,
  MAX_METRICS_BATCH,
  METRICS_MIN_INTERVAL_MS,
} from "./lib/session";

/** Raw samples folded per rollup run; a full batch reschedules the rollup. */
export const ROLLUP_BATCH = 2_000;
/** opsMinute / opsGauges retention. */
export const OPS_RETENTION_MS = 24 * 60 * 60 * 1000;
/** opsErrors keeps only the newest rows. */
export const OPS_ERRORS_CAP = 200;
/** Minutes of history the dashboard aggregates. */
export const DASHBOARD_WINDOW_MINUTES = 60;
const MAX_GAUGE_ROOMS = 1_000;
const RETENTION_DELETE_BATCH = 500;
const MAX_ERROR_MESSAGE_LEN = 200;

const clientEventValidator = v.object({
  kind: metricKindValidator,
  outcome: metricOutcomeValidator,
  latencyMs: v.optional(v.number()),
  code: v.optional(v.string()),
  message: v.optional(v.string()),
});

function sanitizeMessage(raw: string | undefined): string {
  return (raw ?? "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_ERROR_MESSAGE_LEN);
}

function reportedCode(
  outcome: MetricOutcome,
  code: string | undefined,
  message: string,
): string {
  if (code !== undefined && ERROR_CODES.has(code)) return code;
  if (message) return errorCodeFor(message);
  if (outcome === "stale") return "stale";
  if (outcome === "rate_limited") return "rate_limited";
  return "internal";
}

/**
 * Client-observed outcomes and end-to-end latencies, batched by the browser.
 * Rejected mutations roll back their own writes, so this is the only place
 * rejections and latencies become persistent metrics.
 */
export const reportClientEvents = mutation({
  args: {
    roomId: v.id("rooms"),
    clientId: v.string(),
    events: v.array(clientEventValidator),
  },
  returns: v.object({ accepted: v.number() }),
  handler: async (ctx, args) => {
    const clientId = assertValidClientId(args.clientId);
    if (args.events.length > MAX_METRICS_BATCH) fail(GameError.invalidMetrics);
    const player = await requirePlayer(ctx, args.roomId, clientId);
    if (player.isBot) fail(GameError.notInRoom);
    if (args.events.length === 0) return { accepted: 0 };

    const now = Date.now();
    if (
      player.lastMetricsAt !== undefined &&
      now - player.lastMetricsAt < METRICS_MIN_INTERVAL_MS
    ) {
      return { accepted: 0 };
    }
    await ctx.db.patch(player._id, { lastMetricsAt: now });

    for (const event of args.events) {
      await recordSample(ctx, {
        kind: event.kind,
        outcome: event.outcome,
        source: "client",
        at: now,
        ...(event.latencyMs !== undefined ? { latencyMs: event.latencyMs } : {}),
      });
      if (event.outcome === "rejected" || event.outcome === "error") {
        const message = sanitizeMessage(event.message);
        const code = reportedCode(event.outcome, event.code, message);
        await ctx.db.insert("opsErrors", {
          at: now,
          kind: event.kind,
          code,
          message: message || code,
        });
      }
    }
    return { accepted: args.events.length };
  },
});

type Bucket = {
  minute: number;
  kind: MetricKind;
  outcome: MetricOutcome;
  source: Doc<"opsSamples">["source"];
  count: number;
  hist: number[];
};

/**
 * Fold every complete minute of raw samples into opsMinute, snapshot the
 * gauges, and prune old rows. Raw rows are deleted in the same transaction
 * they are counted in, so re-running never double counts.
 */
export const rollup = internalMutation({
  args: {},
  returns: v.object({ folded: v.number(), backlog: v.boolean() }),
  handler: async (ctx) => {
    const now = Date.now();
    const currentMinute = minuteOf(now);

    const samples = await ctx.db
      .query("opsSamples")
      .withIndex("by_at", (q) => q.lt("at", currentMinute))
      .take(ROLLUP_BATCH);

    const buckets = new Map<string, Bucket>();
    for (const s of samples) {
      const minute = minuteOf(s.at);
      const key = `${minute}|${s.kind}|${s.outcome}|${s.source}`;
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = {
          minute,
          kind: s.kind,
          outcome: s.outcome,
          source: s.source,
          count: 0,
          hist: emptyHistogram(),
        };
        buckets.set(key, bucket);
      }
      bucket.count++;
      if (s.latencyMs !== undefined) bucket.hist[latencyBucket(s.latencyMs)]!++;
    }

    for (const b of buckets.values()) {
      const existing = await ctx.db
        .query("opsMinute")
        .withIndex("by_minute", (q) =>
          q
            .eq("minute", b.minute)
            .eq("kind", b.kind)
            .eq("outcome", b.outcome)
            .eq("source", b.source),
        )
        .unique();
      if (existing) {
        await ctx.db.patch(existing._id, {
          count: existing.count + b.count,
          hist: mergeHistograms(existing.hist, b.hist),
        });
      } else {
        await ctx.db.insert("opsMinute", b);
      }
    }
    for (const s of samples) await ctx.db.delete(s._id);

    await snapshotGauges(ctx, currentMinute);
    await pruneOps(ctx, now);

    const backlog = samples.length === ROLLUP_BATCH;
    if (backlog) {
      await ctx.scheduler.runAfter(0, internal.ops.rollup, {});
    }
    return { folded: samples.length, backlog };
  },
});

async function snapshotGauges(ctx: MutationCtx, minute: number): Promise<void> {
  let activeRooms = 0;
  let activePlayers = 0;
  let connectedPlayers = 0;
  for (const status of ["lobby", "playing"] as const) {
    const rooms = await ctx.db
      .query("rooms")
      .withIndex("by_status", (q) => q.eq("status", status))
      .take(MAX_GAUGE_ROOMS);
    activeRooms += rooms.length;
    for (const room of rooms) {
      const players = await ctx.db
        .query("players")
        .withIndex("by_room", (q) => q.eq("roomId", room._id))
        .take(8);
      for (const p of players) {
        if (p.isBot || p.leftAt !== undefined) continue;
        activePlayers++;
        if (p.connected) connectedPlayers++;
      }
    }
  }

  const gauges = { minute, activeRooms, activePlayers, connectedPlayers };
  const existing = await ctx.db
    .query("opsGauges")
    .withIndex("by_minute", (q) => q.eq("minute", minute))
    .unique();
  if (existing) await ctx.db.patch(existing._id, gauges);
  else await ctx.db.insert("opsGauges", gauges);
}

async function pruneOps(ctx: MutationCtx, now: number): Promise<void> {
  const cutoff = now - OPS_RETENTION_MS;
  const oldMinutes = await ctx.db
    .query("opsMinute")
    .withIndex("by_minute", (q) => q.lt("minute", cutoff))
    .take(RETENTION_DELETE_BATCH);
  for (const row of oldMinutes) await ctx.db.delete(row._id);

  const oldGauges = await ctx.db
    .query("opsGauges")
    .withIndex("by_minute", (q) => q.lt("minute", cutoff))
    .take(RETENTION_DELETE_BATCH);
  for (const row of oldGauges) await ctx.db.delete(row._id);

  const newestErrors = await ctx.db
    .query("opsErrors")
    .withIndex("by_at")
    .order("desc")
    .take(OPS_ERRORS_CAP + RETENTION_DELETE_BATCH);
  for (const row of newestErrors.slice(OPS_ERRORS_CAP)) {
    await ctx.db.delete(row._id);
  }
}

/** Compares in time that depends only on the lengths, not on where they differ. */
function timingSafeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

const percentilesValidator = v.object({
  kind: metricKindValidator,
  count: v.number(),
  p50: v.number(),
  p95: v.number(),
  p99: v.number(),
});

const dashboardValidator = v.object({
  windowStart: v.number(),
  windowEnd: v.number(),
  hasData: v.boolean(),
  gauges: v.union(
    v.null(),
    v.object({
      minute: v.number(),
      activeRooms: v.number(),
      activePlayers: v.number(),
      connectedPlayers: v.number(),
    }),
  ),
  perMinute: v.array(
    v.object({
      minute: v.number(),
      mutations: v.number(),
      clientCalls: v.number(),
      failures: v.number(),
      stale: v.number(),
    }),
  ),
  latency: v.array(percentilesValidator),
  totals: v.object({
    mutations: v.number(),
    clientCalls: v.number(),
    stale: v.number(),
    rateLimited: v.number(),
    rejected: v.number(),
    errors: v.number(),
    resyncs: v.number(),
    serverReconnects: v.number(),
  }),
  errorRate: v.union(v.number(), v.null()),
  reconnectSuccessRate: v.union(v.number(), v.null()),
  recentErrors: v.array(
    v.object({
      at: v.number(),
      kind: metricKindValidator,
      code: v.string(),
      message: v.string(),
    }),
  ),
});

/**
 * Aggregates for the ops dashboard over the last DASHBOARD_WINDOW_MINUTES
 * ending at `nowMinute` (passed in: queries must not read the clock). Every
 * value is derived from stored rows; empty tables yield nulls and zeros.
 */
export const dashboard = query({
  args: {
    token: v.string(),
    nowMinute: v.number(),
  },
  returns: dashboardValidator,
  handler: async (ctx, args) => {
    const expected = process.env.OPS_DASHBOARD_TOKEN;
    if (!expected || !timingSafeEqual(args.token, expected)) fail(GameError.unauthorized);

    const windowEnd = minuteOf(args.nowMinute);
    const windowStart = windowEnd - (DASHBOARD_WINDOW_MINUTES - 1) * MINUTE_MS;

    const rows = await ctx.db
      .query("opsMinute")
      .withIndex("by_minute", (q) =>
        q.gte("minute", windowStart).lte("minute", windowEnd),
      )
      .take(20_000);

    const perMinute = new Map<
      number,
      { minute: number; mutations: number; clientCalls: number; failures: number; stale: number }
    >();
    const histByKind = new Map<MetricKind, number[]>();
    const totals = {
      mutations: 0,
      clientCalls: 0,
      stale: 0,
      rateLimited: 0,
      rejected: 0,
      errors: 0,
      resyncs: 0,
      serverReconnects: 0,
    };
    let clientReconnects = 0;
    let clientReconnectsOk = 0;

    for (const row of rows) {
      let m = perMinute.get(row.minute);
      if (!m) {
        m = { minute: row.minute, mutations: 0, clientCalls: 0, failures: 0, stale: 0 };
        perMinute.set(row.minute, m);
      }
      if (row.source === "server") {
        m.mutations += row.count;
        totals.mutations += row.count;
        if (row.kind === "reconnect") totals.serverReconnects += row.count;
        continue;
      }

      histByKind.set(
        row.kind,
        mergeHistograms(histByKind.get(row.kind) ?? emptyHistogram(), row.hist),
      );
      // Resyncs and reconnects are client events, not calls: they get their
      // own counters and stay out of the error-rate denominator.
      if (row.kind === "resync") {
        totals.resyncs += row.count;
        continue;
      }
      if (row.kind === "reconnect") {
        clientReconnects += row.count;
        if (row.outcome === "ok") clientReconnectsOk += row.count;
        continue;
      }

      m.clientCalls += row.count;
      totals.clientCalls += row.count;
      if (row.outcome === "stale") {
        m.stale += row.count;
        totals.stale += row.count;
      } else if (row.outcome === "rate_limited") {
        totals.rateLimited += row.count;
      } else if (row.outcome === "rejected") {
        m.failures += row.count;
        totals.rejected += row.count;
      } else if (row.outcome === "error") {
        m.failures += row.count;
        totals.errors += row.count;
      }
    }

    const latency = [...histByKind.entries()]
      .map(([kind, hist]) => ({
        kind,
        count: hist.reduce((sum, n) => sum + n, 0),
        p50: histogramPercentile(hist, 50),
        p95: histogramPercentile(hist, 95),
        p99: histogramPercentile(hist, 99),
      }))
      .filter(
        (r): r is { kind: MetricKind; count: number; p50: number; p95: number; p99: number } =>
          r.p50 !== null && r.p95 !== null && r.p99 !== null,
      )
      .sort((a, b) => a.kind.localeCompare(b.kind));

    const latestGauge = await ctx.db
      .query("opsGauges")
      .withIndex("by_minute", (q) => q.lte("minute", windowEnd))
      .order("desc")
      .first();
    const gauges =
      latestGauge && latestGauge.minute >= windowStart
        ? {
            minute: latestGauge.minute,
            activeRooms: latestGauge.activeRooms,
            activePlayers: latestGauge.activePlayers,
            connectedPlayers: latestGauge.connectedPlayers,
          }
        : null;

    const recentErrors = (
      await ctx.db.query("opsErrors").withIndex("by_at").order("desc").take(20)
    ).map((e) => ({ at: e.at, kind: e.kind, code: e.code, message: e.message }));

    const failures = totals.rejected + totals.errors;
    return {
      windowStart,
      windowEnd,
      hasData: rows.length > 0 || gauges !== null || recentErrors.length > 0,
      gauges,
      perMinute: [...perMinute.values()].sort((a, b) => a.minute - b.minute),
      latency,
      totals,
      errorRate: totals.clientCalls > 0 ? failures / totals.clientCalls : null,
      reconnectSuccessRate:
        clientReconnects > 0 ? clientReconnectsOk / clientReconnects : null,
      recentErrors,
    };
  },
});
