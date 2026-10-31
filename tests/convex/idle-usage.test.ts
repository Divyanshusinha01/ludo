import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../../convex/_generated/api";
import { MATCHMAKE_POLL_MS } from "../../convex/lib/matchmaking";
import { PRESENCE_SWEEP_MS } from "../../convex/lib/jobs";
import { MINUTE_MS } from "../../convex/lib/metrics";
import { stubAuthEnv } from "./auth-helpers";
import { join, queuePlayers, runScheduledMatcher } from "./matchmaking-helpers";
import {
  advance,
  seatClient,
  setClock,
  setupConvex,
  startedRoom,
  T0,
  teardownConvex,
  type DiceQueue,
  type T,
} from "./setup";

let t: T;
let dice: DiceQueue;

beforeEach(() => {
  ({ t, dice } = setupConvex());
  stubAuthEnv();
});

afterEach(() => {
  teardownConvex(dice);
  vi.unstubAllEnvs();
});

async function pending(name: string) {
  const rows = await t.run(async (ctx) => await ctx.db.system.query("_scheduled_functions").collect());
  return rows.filter((r) => r.state.kind === "pending" && r.name.includes(name));
}

async function allPending() {
  const rows = await t.run(async (ctx) => await ctx.db.system.query("_scheduled_functions").collect());
  return rows.filter((r) => r.state.kind === "pending");
}

async function gaugeRows() {
  return await t.run(async (ctx) => await ctx.db.query("opsGauges").collect());
}

describe("idle deployment", () => {
  it("every cron is a no-op that schedules nothing and writes nothing new", async () => {
    // First rollup records the zero baseline gauge; later idle runs write nothing.
    await t.mutation(internal.ops.rollup, {});
    expect(await gaugeRows()).toHaveLength(1);

    // Stay inside the 30 min gauge refresh interval.
    for (let i = 1; i <= 5; i++) {
      setClock(T0 + i * 5 * MINUTE_MS);
      await t.mutation(internal.matchmaking.sweep, {});
      await t.mutation(internal.cleanup.tick, {});
      const result = await t.mutation(internal.ops.rollup, {});
      expect(result).toEqual({ folded: 0, backlog: false });
    }
    expect(await allPending()).toHaveLength(0);
    expect(await gaugeRows()).toHaveLength(1);
    const jobs = await t.run(async (ctx) => await ctx.db.query("jobState").collect());
    expect(jobs).toHaveLength(0);
  });

  it("rewrites an unchanged gauge only after the refresh interval", async () => {
    await t.mutation(internal.ops.rollup, {});
    setClock(T0 + 31 * MINUTE_MS);
    await t.mutation(internal.ops.rollup, {});
    expect(await gaugeRows()).toHaveLength(2);
  });

  it("a gauge change is recorded immediately", async () => {
    await t.mutation(internal.ops.rollup, {});
    await startedRoom(t, { players: 2 });
    setClock(T0 + 5 * MINUTE_MS);
    await t.mutation(internal.ops.rollup, {});
    const rows = await gaugeRows();
    expect(rows).toHaveLength(2);
    expect(rows.at(-1)).toMatchObject({ activeRooms: 1, activePlayers: 2 });
  });
});

describe("matchmaker chain", () => {
  it("polls while someone waits, never stacks, and stops when the queue empties", async () => {
    const [a] = await queuePlayers(t, 1);
    await join(a!, "duel");
    await runScheduledMatcher(t);
    expect(await pending("matchmake")).toHaveLength(1);

    // Pings and further runs re-arm nothing while a poll is already pending.
    await a!.user.mutation(api.matchmaking.queuePing, {});
    await t.mutation(internal.matchmaking.matchmake, { queue: "duel" });
    expect(await pending("matchmake")).toHaveLength(1);

    // Each poll replaces itself with exactly one successor.
    await a!.user.mutation(api.matchmaking.queuePing, {});
    await advance(t, MATCHMAKE_POLL_MS + 1);
    expect(await pending("matchmake")).toHaveLength(1);

    await a!.user.mutation(api.matchmaking.leaveQueue, {});
    await advance(t, MATCHMAKE_POLL_MS + 1);
    expect(await pending("matchmake")).toHaveLength(0);
  });

  it("a ticket that stops pinging ends the chain on its own", async () => {
    const [a] = await queuePlayers(t, 1);
    await join(a!, "duel");
    await runScheduledMatcher(t);
    // No pings: the ticket goes stale and the next poll finds nothing live.
    await advance(t, 25_000);
    await advance(t, MATCHMAKE_POLL_MS + 1);
    expect(await pending("matchmake")).toHaveLength(0);
  });

  it("queuePing restarts a chain that died", async () => {
    const [a] = await queuePlayers(t, 1);
    await join(a!, "duel");
    await runScheduledMatcher(t);
    await t.run(async (ctx) => {
      for (const job of await ctx.db.system.query("_scheduled_functions").collect()) {
        if (job.state.kind === "pending") await ctx.scheduler.cancel(job._id);
      }
    });
    expect(await pending("matchmake")).toHaveLength(0);
    setClock(T0 + 60_000);
    await a!.user.mutation(api.matchmaking.queuePing, {});
    expect(await pending("matchmake")).toHaveLength(1);
  });
});

describe("presence sweep chain", () => {
  it("is armed once by in-play commits and stops when no game is playing", async () => {
    const room = await startedRoom(t, { players: 2 });
    expect(await pending("presenceTick")).toHaveLength(1);

    // More commits do not stack sweeps.
    await advance(t, 200);
    await t.mutation(api.rooms.heartbeat, { roomId: room.roomId, clientId: seatClient(room, "red") }).catch(() => {});
    expect(await pending("presenceTick")).toHaveLength(1);

    // While the game is live, the sweep replaces itself.
    await advance(t, PRESENCE_SWEEP_MS + 1);
    expect(await pending("presenceTick")).toHaveLength(1);

    // Once nothing is playing the chain ends.
    await t.run(async (ctx) => {
      await ctx.db.patch(room.roomId, { status: "finished", finishedAt: Date.now() });
    });
    await advance(t, PRESENCE_SWEEP_MS + 1);
    expect(await pending("presenceTick")).toHaveLength(0);
  });
});

describe("heartbeat contract", () => {
  it("answers ok for a live seat and gone once the seat or room is gone", async () => {
    const room = await startedRoom(t, { players: 2 });
    const client = room.host;
    setClock(Date.now() + 10_000);
    expect(await t.mutation(api.rooms.heartbeat, { roomId: room.roomId, clientId: client })).toBe("ok");

    await t.mutation(api.rooms.leaveRoom, { roomId: room.roomId, clientId: client });
    setClock(Date.now() + 10_000);
    expect(await t.mutation(api.rooms.heartbeat, { roomId: room.roomId, clientId: client })).toBe("gone");
  });

  it("a routine heartbeat writes no metric sample", async () => {
    const room = await startedRoom(t, { players: 2 });
    const count = async () =>
      (await t.run(async (ctx) => await ctx.db.query("opsSamples").collect())).length;
    const before = await count();
    for (let i = 1; i <= 3; i++) {
      setClock(Date.now() + 10_000);
      await t.mutation(api.rooms.heartbeat, { roomId: room.roomId, clientId: room.host });
    }
    expect(await count()).toBe(before);
  });
});
