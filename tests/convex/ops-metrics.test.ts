import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../../convex/_generated/api";
import { GameError } from "../../convex/lib/errors";
import {
  emptyHistogram,
  latencyBucket,
  MAX_LATENCY_MS,
  MINUTE_MS,
  minuteOf,
  type MetricKind,
  type MetricOutcome,
} from "../../convex/lib/metrics";
import {
  DASHBOARD_WINDOW_MINUTES,
  OPS_ERRORS_CAP,
  OPS_RETENTION_MS,
  ROLLUP_BATCH,
} from "../../convex/ops";
import { HEARTBEAT_MIN_INTERVAL_MS, MAX_METRICS_BATCH, METRICS_MIN_INTERVAL_MS } from "../../convex/lib/session";
import {
  advance,
  bundle,
  clientId,
  rollAs,
  seatClient,
  setClock,
  setupConvex,
  startedRoom,
  teardownConvex,
  turnArgs,
  type DiceQueue,
  type T,
} from "./setup";

const TOKEN = "test-ops-token";

let t: T;
let dice: DiceQueue;

beforeEach(() => {
  ({ t, dice } = setupConvex());
});

afterEach(() => {
  teardownConvex(dice);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function samples() {
  return await t.run(async (ctx) => await ctx.db.query("opsSamples").collect());
}

async function sampleKinds(source: "server" | "client" = "server"): Promise<string[]> {
  return (await samples()).filter((s) => s.source === source).map((s) => s.kind);
}

async function minuteRows() {
  const rows = await t.run(async (ctx) => await ctx.db.query("opsMinute").collect());
  return rows
    .map((r) => ({ minute: r.minute, kind: r.kind, outcome: r.outcome, source: r.source, count: r.count, hist: r.hist }))
    .sort(
      (a, b) =>
        a.minute - b.minute ||
        a.source.localeCompare(b.source) ||
        a.kind.localeCompare(b.kind) ||
        a.outcome.localeCompare(b.outcome),
    );
}

async function insertSample(at: number, kind: MetricKind, outcome: MetricOutcome = "ok", latencyMs?: number) {
  await t.run(async (ctx) => {
    await ctx.db.insert("opsSamples", {
      at,
      kind,
      outcome,
      source: latencyMs === undefined ? "server" : "client",
      ...(latencyMs !== undefined ? { latencyMs } : {}),
    });
  });
}

describe("server samples", () => {
  it("successful lifecycle and gameplay mutations insert one ok sample each", async () => {
    const room = await startedRoom(t, { players: 3 });
    expect(await sampleKinds()).toEqual(["create", "join", "join", "start"]);

    const seat = (await bundle(t, room.roomId)).room.currentTurn;
    await rollAs(t, dice, room.roomId, seatClient(room, seat), 3);
    const all = await samples();
    expect(all.map((s) => s.kind)).toEqual(["create", "join", "join", "start", "roll"]);
    for (const s of all) {
      expect(s).toMatchObject({ outcome: "ok", source: "server" });
      expect(s.latencyMs).toBeUndefined();
    }
  });

  it("rejected mutations insert nothing", async () => {
    const room = await startedRoom(t, { players: 2 });
    const seat = (await bundle(t, room.roomId)).room.currentTurn;
    const other = (Object.keys(room.clients) as Array<keyof typeof room.clients>).find((c) => c !== seat)!;
    await advance(t);
    const args = await turnArgs(t, room.roomId);
    const before = await samples();

    await expect(
      t.mutation(api.game.rollDice, {
        roomId: room.roomId,
        clientId: seatClient(room, seat),
        ...args,
        expectedSeq: args.expectedSeq - 1,
      }),
    ).rejects.toThrow(GameError.staleAction);
    await expect(
      t.mutation(api.game.rollDice, { roomId: room.roomId, clientId: seatClient(room, other), ...args }),
    ).rejects.toThrow(GameError.notYourTurn);
    await expect(
      t.mutation(api.rooms.startGame, { roomId: room.roomId, clientId: room.host }),
    ).rejects.toThrow(GameError.gameStarted);

    expect(await samples()).toEqual(before);
  });

  it("presence: a heartbeat after a disconnect records a reconnect, floods record nothing", async () => {
    const room = await startedRoom(t, { players: 2 });
    const seat = (Object.keys(room.clients) as Array<keyof typeof room.clients>)[0]!;
    const client = seatClient(room, seat);
    const base = (await samples()).length;

    setClock(Date.now() + HEARTBEAT_MIN_INTERVAL_MS);
    await t.mutation(api.rooms.heartbeat, { roomId: room.roomId, clientId: client });
    await t.mutation(api.rooms.heartbeat, { roomId: room.roomId, clientId: client });
    await t.mutation(api.rooms.markDisconnected, { roomId: room.roomId, clientId: client });
    setClock(Date.now() + HEARTBEAT_MIN_INTERVAL_MS);
    await t.mutation(api.rooms.heartbeat, { roomId: room.roomId, clientId: client });

    expect((await sampleKinds()).slice(base)).toEqual(["heartbeat", "reconnect"]);
  });

  it("joinRoom by a seated client records a reconnect, not a join", async () => {
    const room = await startedRoom(t, { players: 2 });
    const guest = (Object.keys(room.clients) as Array<keyof typeof room.clients>).find(
      (c) => room.clients[c] !== room.host,
    )!;
    const base = (await samples()).length;
    await t.mutation(api.rooms.joinRoom, { code: room.code, clientId: seatClient(room, guest), name: "P2" });
    expect((await sampleKinds()).slice(base)).toEqual(["reconnect"]);
  });

  it("logs mutation_ok and mutation_rejected with the function and code", async () => {
    const room = await startedRoom(t, { players: 2 });
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(
      t.mutation(api.rooms.startGame, { roomId: room.roomId, clientId: room.host }),
    ).rejects.toThrow(GameError.gameStarted);
    const seat = (await bundle(t, room.roomId)).room.currentTurn;
    await rollAs(t, dice, room.roomId, seatClient(room, seat), 3);

    const lines = spy.mock.calls
      .map((c) => {
        try {
          return JSON.parse(String(c[0])) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((l): l is Record<string, unknown> => l !== null);
    expect(lines).toContainEqual(
      expect.objectContaining({ event: "mutation_rejected", fn: "rooms:startGame", code: "game_started" }),
    );
    expect(lines).toContainEqual(expect.objectContaining({ event: "mutation_ok", fn: "game:rollDice" }));
  });
});

describe("reportClientEvents", () => {
  async function seated() {
    const room = await startedRoom(t, { players: 2 });
    return { room, client: room.host };
  }

  it("stores client samples with clamped latency and records rejections in opsErrors", async () => {
    const { room, client } = await seated();
    const result = await t.mutation(api.ops.reportClientEvents, {
      roomId: room.roomId,
      clientId: client,
      events: [
        { kind: "roll", outcome: "ok", latencyMs: -20 },
        { kind: "move", outcome: "ok", latencyMs: 10 * MAX_LATENCY_MS },
        { kind: "move", outcome: "stale", latencyMs: 80 },
        { kind: "roll", outcome: "rejected", latencyMs: 40, code: "bogus", message: GameError.notYourTurn },
        { kind: "pass", outcome: "error", message: "boom\u0000\nline two" },
        { kind: "resync", outcome: "ok" },
      ],
    });
    expect(result).toEqual({ accepted: 6 });

    const client_ = (await samples()).filter((s) => s.source === "client");
    expect(client_.map((s) => [s.kind, s.outcome, s.latencyMs])).toEqual([
      ["roll", "ok", 0],
      ["move", "ok", MAX_LATENCY_MS],
      ["move", "stale", 80],
      ["roll", "rejected", 40],
      ["pass", "error", undefined],
      ["resync", "ok", undefined],
    ]);

    const errors = await t.run(async (ctx) => await ctx.db.query("opsErrors").collect());
    expect(errors.map(({ kind, code, message }) => ({ kind, code, message }))).toEqual([
      { kind: "roll", code: "not_your_turn", message: GameError.notYourTurn },
      { kind: "pass", code: "internal", message: "boom line two" },
    ]);
  });

  it("validates labels, batch size and the reporter's seat", async () => {
    const { room, client } = await seated();
    await expect(
      t.mutation(api.ops.reportClientEvents, {
        roomId: room.roomId,
        clientId: client,
        // @ts-expect-error unknown kind must be rejected by the validator
        events: [{ kind: "chat", outcome: "ok" }],
      }),
    ).rejects.toThrow();
    await expect(
      t.mutation(api.ops.reportClientEvents, {
        roomId: room.roomId,
        clientId: client,
        // @ts-expect-error unknown outcome must be rejected by the validator
        events: [{ kind: "roll", outcome: "timeout" }],
      }),
    ).rejects.toThrow();
    await expect(
      t.mutation(api.ops.reportClientEvents, {
        roomId: room.roomId,
        clientId: client,
        events: Array.from({ length: MAX_METRICS_BATCH + 1 }, () => ({ kind: "roll" as const, outcome: "ok" as const })),
      }),
    ).rejects.toThrow(GameError.invalidMetrics);
    await expect(
      t.mutation(api.ops.reportClientEvents, {
        roomId: room.roomId,
        clientId: clientId(99),
        events: [{ kind: "roll", outcome: "ok" }],
      }),
    ).rejects.toThrow(GameError.notInRoom);
    await expect(
      t.mutation(api.ops.reportClientEvents, {
        roomId: room.roomId,
        clientId: "not-a-session",
        events: [{ kind: "roll", outcome: "ok" }],
      }),
    ).rejects.toThrow(GameError.invalidSession);

    expect(await sampleKinds("client")).toEqual([]);
  });

  it("is rate-limited per seat", async () => {
    const { room, client } = await seated();
    const report = () =>
      t.mutation(api.ops.reportClientEvents, {
        roomId: room.roomId,
        clientId: client,
        events: [{ kind: "roll", outcome: "ok", latencyMs: 50 }],
      });

    expect(await report()).toEqual({ accepted: 1 });
    setClock(Date.now() + METRICS_MIN_INTERVAL_MS - 1);
    expect(await report()).toEqual({ accepted: 0 });
    expect(await sampleKinds("client")).toEqual(["roll"]);
    setClock(Date.now() + 1);
    expect(await report()).toEqual({ accepted: 1 });
    expect(await sampleKinds("client")).toEqual(["roll", "roll"]);
  });
});

describe("rollup", () => {
  const M0 = minuteOf(Date.UTC(2026, 0, 1, 12, 0));

  it("folds complete minutes into opsMinute, keeps the current minute, and prunes raw rows", async () => {
    setClock(M0 + 5 * MINUTE_MS);
    await insertSample(M0 + 1_000, "roll");
    await insertSample(M0 + 2_000, "roll");
    await insertSample(M0 + 3_000, "move");
    await insertSample(M0 + 4_000, "roll", "ok", 30);
    await insertSample(M0 + 5_000, "roll", "ok", 30);
    await insertSample(M0 + 6_000, "roll", "stale", 700);
    await insertSample(M0 + MINUTE_MS + 1, "roll");
    await insertSample(M0 + 5 * MINUTE_MS + 10, "move");

    const result = await t.mutation(internal.ops.rollup, {});
    expect(result).toEqual({ folded: 7, backlog: false });

    const hist = (latencies: number[]) => {
      const h = emptyHistogram();
      for (const ms of latencies) h[latencyBucket(ms)]!++;
      return h;
    };
    expect(await minuteRows()).toEqual([
      { minute: M0, kind: "roll", outcome: "ok", source: "client", count: 2, hist: hist([30, 30]) },
      { minute: M0, kind: "roll", outcome: "stale", source: "client", count: 1, hist: hist([700]) },
      { minute: M0, kind: "move", outcome: "ok", source: "server", count: 1, hist: emptyHistogram() },
      { minute: M0, kind: "roll", outcome: "ok", source: "server", count: 2, hist: emptyHistogram() },
      { minute: M0 + MINUTE_MS, kind: "roll", outcome: "ok", source: "server", count: 1, hist: emptyHistogram() },
    ]);
    expect((await samples()).map((s) => s.at)).toEqual([M0 + 5 * MINUTE_MS + 10]);
  });

  it("is idempotent and merges late batches into existing minute rows", async () => {
    setClock(M0 + 2 * MINUTE_MS);
    await insertSample(M0 + 1_000, "roll");
    await t.mutation(internal.ops.rollup, {});
    const once = await minuteRows();
    await t.mutation(internal.ops.rollup, {});
    expect(await minuteRows()).toEqual(once);

    await insertSample(M0 + 2_000, "roll");
    await t.mutation(internal.ops.rollup, {});
    expect(await minuteRows()).toEqual([{ ...once[0]!, count: 2 }]);
  });

  it("snapshots gauges from live rooms and seats", async () => {
    const room = await startedRoom(t, { players: 3 });
    await startedRoom(t, { players: 2, start: false, clientBase: 10 });
    const away = (Object.keys(room.clients) as Array<keyof typeof room.clients>).find(
      (c) => room.clients[c] !== room.host,
    )!;
    await t.mutation(api.rooms.markDisconnected, { roomId: room.roomId, clientId: seatClient(room, away) });

    await t.mutation(internal.ops.rollup, {});
    const gauges = await t.run(async (ctx) => await ctx.db.query("opsGauges").collect());
    expect(gauges.map(({ minute, activeRooms, activePlayers, connectedPlayers }) => ({
      minute,
      activeRooms,
      activePlayers,
      connectedPlayers,
    }))).toEqual([{ minute: minuteOf(Date.now()), activeRooms: 2, activePlayers: 5, connectedPlayers: 4 }]);
  });

  it("drops minute and gauge rows past retention and caps opsErrors", async () => {
    const now = M0 + OPS_RETENTION_MS + 10 * MINUTE_MS;
    setClock(now);
    await t.run(async (ctx) => {
      await ctx.db.insert("opsMinute", { minute: M0, kind: "roll", outcome: "ok", source: "server", count: 1, hist: emptyHistogram() });
      await ctx.db.insert("opsMinute", { minute: now - MINUTE_MS, kind: "roll", outcome: "ok", source: "server", count: 1, hist: emptyHistogram() });
      await ctx.db.insert("opsGauges", { minute: M0, activeRooms: 1, activePlayers: 1, connectedPlayers: 1 });
      for (let i = 0; i < OPS_ERRORS_CAP + 15; i++) {
        await ctx.db.insert("opsErrors", { at: M0 + i, kind: "roll", code: "internal", message: `e${i}` });
      }
    });

    await t.mutation(internal.ops.rollup, {});

    expect((await minuteRows()).map((r) => r.minute)).toEqual([now - MINUTE_MS]);
    const gauges = await t.run(async (ctx) => await ctx.db.query("opsGauges").collect());
    expect(gauges.map((g) => g.minute)).toEqual([minuteOf(now)]);
    const errors = await t.run(async (ctx) => await ctx.db.query("opsErrors").withIndex("by_at").collect());
    expect(errors).toHaveLength(OPS_ERRORS_CAP);
    expect(errors[0]!.message).toBe("e15");
  });

  it("reschedules itself when the backlog exceeds one batch", async () => {
    setClock(M0 + 2 * MINUTE_MS);
    await t.run(async (ctx) => {
      for (let i = 0; i < ROLLUP_BATCH + 5; i++) {
        await ctx.db.insert("opsSamples", { at: M0 + (i % 50_000), kind: "heartbeat", outcome: "ok", source: "server" });
      }
    });

    const first = await t.mutation(internal.ops.rollup, {});
    expect(first).toEqual({ folded: ROLLUP_BATCH, backlog: true });
    expect(await samples()).toHaveLength(5);

    await t.finishAllScheduledFunctions(() => vi.runOnlyPendingTimers());
    expect(await samples()).toHaveLength(0);
    expect(await minuteRows()).toEqual([
      { minute: M0, kind: "heartbeat", outcome: "ok", source: "server", count: ROLLUP_BATCH + 5, hist: emptyHistogram() },
    ]);
  });
});

describe("dashboard", () => {
  it("rejects a missing or wrong token", async () => {
    const nowMinute = minuteOf(Date.now());
    await expect(t.query(api.ops.dashboard, { token: TOKEN, nowMinute })).rejects.toThrow(GameError.unauthorized);
    vi.stubEnv("OPS_DASHBOARD_TOKEN", TOKEN);
    await expect(t.query(api.ops.dashboard, { token: "wrong", nowMinute })).rejects.toThrow(GameError.unauthorized);
    await expect(t.query(api.ops.dashboard, { token: "", nowMinute })).rejects.toThrow(GameError.unauthorized);
  });

  it("returns an explicit empty state for an empty database", async () => {
    vi.stubEnv("OPS_DASHBOARD_TOKEN", TOKEN);
    const nowMinute = minuteOf(Date.now());
    expect(await t.query(api.ops.dashboard, { token: TOKEN, nowMinute })).toEqual({
      windowStart: nowMinute - (DASHBOARD_WINDOW_MINUTES - 1) * MINUTE_MS,
      windowEnd: nowMinute,
      hasData: false,
      gauges: null,
      perMinute: [],
      latency: [],
      totals: {
        mutations: 0,
        clientCalls: 0,
        stale: 0,
        rateLimited: 0,
        rejected: 0,
        errors: 0,
        resyncs: 0,
        serverReconnects: 0,
      },
      errorRate: null,
      reconnectSuccessRate: null,
      recentErrors: [],
    });
  });

  it("aggregates only what real traffic produced", async () => {
    vi.stubEnv("OPS_DASHBOARD_TOKEN", TOKEN);
    const room = await startedRoom(t, { players: 2 });
    const seat = (await bundle(t, room.roomId)).room.currentTurn;
    await rollAs(t, dice, room.roomId, seatClient(room, seat), 3);
    const trafficMinute = minuteOf(Date.now());

    await t.mutation(api.ops.reportClientEvents, {
      roomId: room.roomId,
      clientId: room.host,
      events: [
        { kind: "roll", outcome: "ok", latencyMs: 40 },
        { kind: "roll", outcome: "ok", latencyMs: 60 },
        { kind: "roll", outcome: "stale", latencyMs: 90 },
        { kind: "move", outcome: "rejected", latencyMs: 120, message: GameError.illegalMove },
        { kind: "resync", outcome: "ok" },
        { kind: "reconnect", outcome: "ok", latencyMs: 900 },
        { kind: "reconnect", outcome: "error" },
      ],
    });

    setClock(trafficMinute + MINUTE_MS);
    await t.mutation(internal.ops.rollup, {});
    const d = await t.query(api.ops.dashboard, { token: TOKEN, nowMinute: minuteOf(Date.now()) });

    expect(d.hasData).toBe(true);
    // create + join + start + roll on the server.
    expect(d.totals).toEqual({
      mutations: 4,
      clientCalls: 4,
      stale: 1,
      rateLimited: 0,
      rejected: 1,
      errors: 0,
      resyncs: 1,
      serverReconnects: 0,
    });
    expect(d.errorRate).toBe(1 / 4);
    expect(d.reconnectSuccessRate).toBe(1 / 2);
    expect(d.perMinute).toEqual([{ minute: trafficMinute, mutations: 4, clientCalls: 4, failures: 1, stale: 1 }]);
    expect(d.latency.map((l) => [l.kind, l.count])).toEqual([
      ["move", 1],
      ["reconnect", 1],
      ["roll", 3],
    ]);
    const roll = d.latency.find((l) => l.kind === "roll")!;
    expect(roll.p50).toBeGreaterThan(25);
    expect(roll.p50).toBeLessThanOrEqual(75);
    expect(roll.p99).toBeLessThanOrEqual(100);
    expect(d.gauges).toMatchObject({ activeRooms: 1, activePlayers: 2, connectedPlayers: 2 });
    expect(d.recentErrors.map(({ kind, code }) => ({ kind, code }))).toEqual([
      { kind: "reconnect", code: "internal" },
      { kind: "move", code: "illegal_move" },
    ]);
  });

  it("ignores minutes outside the window", async () => {
    vi.stubEnv("OPS_DASHBOARD_TOKEN", TOKEN);
    const nowMinute = minuteOf(Date.now());
    await t.run(async (ctx) => {
      await ctx.db.insert("opsMinute", {
        minute: nowMinute - DASHBOARD_WINDOW_MINUTES * MINUTE_MS,
        kind: "roll",
        outcome: "ok",
        source: "server",
        count: 9,
        hist: emptyHistogram(),
      });
    });
    const d = await t.query(api.ops.dashboard, { token: TOKEN, nowMinute });
    expect(d.hasData).toBe(false);
    expect(d.totals.mutations).toBe(0);
  });
});
