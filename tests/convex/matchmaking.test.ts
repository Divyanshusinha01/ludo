import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../../convex/_generated/api";
import { GameError } from "../../convex/lib/errors";
import { STALE_TICKET_MS, SEAT_LIVE_MS } from "../../convex/lib/matchmaking";
import { mulberry32 } from "../game/fixtures/dice";
import { stubAuthEnv } from "./auth-helpers";
import {
  asStartedRoom,
  join,
  matchNow,
  queuePlayer,
  queuePlayers,
  rankedRooms,
  runScheduledMatcher,
  seatsOf,
  tickets,
  type QueuePlayer,
} from "./matchmaking-helpers";
import {
  clientId,
  expectLiveEqualsReplay,
  playActions,
  setClock,
  setupConvex,
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

describe("queue membership", () => {
  it("anonymous callers cannot queue and see no status", async () => {
    await expect(
      t.mutation(api.matchmaking.joinQueue, { clientId: clientId(1), queue: "duel" }),
    ).rejects.toThrow(GameError.signInToQueue);
    expect(await t.query(api.matchmaking.queueStatus, {})).toBeNull();
    expect(await t.mutation(api.matchmaking.leaveQueue, {})).toEqual({ status: "idle" });
    expect(await tickets(t)).toHaveLength(0);
  });

  it("rejects a malformed tab id", async () => {
    const [a] = await queuePlayers(t, 1);
    await expect(
      a!.user.mutation(api.matchmaking.joinQueue, { clientId: "nope", queue: "duel" }),
    ).rejects.toThrow();
  });

  it("joining twice returns the same ticket", async () => {
    const [a] = await queuePlayers(t, 1);
    const first = await join(a!, "duel");
    setClock(T0 + 1_000);
    const second = await join(a!, "duel");
    expect(first).toEqual({ status: "waiting", queue: "duel", joinedAt: T0 });
    expect(second).toEqual(first);
    expect(await tickets(t)).toHaveLength(1);
    expect(await a!.user.query(api.matchmaking.queueStatus, {})).toEqual(first);
  });

  it("joining another queue moves the single ticket", async () => {
    const [a] = await queuePlayers(t, 1);
    await join(a!, "duel");
    setClock(T0 + 1_000);
    const moved = await join(a!, "ffa4");
    expect(moved).toEqual({ status: "waiting", queue: "ffa4", joinedAt: T0 + 1_000 });
    const rows = await tickets(t);
    expect(rows.map((r) => r.queue)).toEqual(["ffa4"]);
  });

  it("leaving is idempotent", async () => {
    const [a] = await queuePlayers(t, 1);
    expect(await a!.user.mutation(api.matchmaking.leaveQueue, {})).toEqual({ status: "idle" });
    await join(a!, "duel");
    expect(await a!.user.mutation(api.matchmaking.leaveQueue, {})).toEqual({ status: "idle" });
    expect(await a!.user.mutation(api.matchmaking.leaveQueue, {})).toEqual({ status: "idle" });
    expect(await tickets(t)).toHaveLength(0);
  });

  it("tickets store no secrets and status exposes no client ids", async () => {
    const [a] = await queuePlayers(t, 1);
    await join(a!, "duel");
    const status = await a!.user.query(api.matchmaking.queueStatus, {});
    expect(JSON.stringify(status)).not.toContain(a!.clientId);
    expect(JSON.stringify(status)).not.toContain(a!.accountId);
  });
});

describe("matching", () => {
  it("two duel players get one ranked room with account-linked seats", async () => {
    const [a, b] = await queuePlayers(t, 2);
    await join(a!, "duel");
    await join(b!, "duel");
    await runScheduledMatcher(t);

    const rooms = await rankedRooms(t);
    expect(rooms).toHaveLength(1);
    const room = rooms[0]!;
    expect(room).toMatchObject({ status: "playing", ranked: true, queue: "duel", mode: "1v1" });

    const seats = await seatsOf(t, room._id);
    expect(seats.map((s) => [s.accountId, s.clientId, s.color, !!s.isBot]).sort()).toEqual(
      [
        [a!.accountId, a!.clientId, "red", false],
        [b!.accountId, b!.clientId, "yellow", false],
      ].sort(),
    );
    expect(seats.map((s) => s.name).sort()).toEqual(["P1", "P2"]);

    for (const p of [a!, b!]) {
      const status = await p.user.query(api.matchmaking.queueStatus, {});
      expect(status).toMatchObject({ status: "matched", queue: "duel", roomId: room._id, code: room.code });
    }
    const bundle = await t.query(api.rooms.getRoom, { roomId: room._id, clientId: a!.clientId });
    expect(bundle?.room.ranked).toBe(true);
    expect(bundle?.me?.color).toBe("red");
    await expectLiveEqualsReplay(t, room._id);
  });

  it("a single waiting player is not matched", async () => {
    const [a] = await queuePlayers(t, 1);
    await join(a!, "duel");
    await runScheduledMatcher(t);
    expect(await rankedRooms(t)).toHaveLength(0);
    expect((await tickets(t))[0]?.status).toBe("waiting");
  });

  it("queues do not mix", async () => {
    const [a, b] = await queuePlayers(t, 2);
    await join(a!, "duel");
    await join(b!, "ffa4");
    await runScheduledMatcher(t);
    expect(await rankedRooms(t)).toHaveLength(0);
  });

  it("ffa4 seats four accounts on every colour", async () => {
    const players = await queuePlayers(t, 4);
    for (const p of players) await join(p, "ffa4");
    await runScheduledMatcher(t);
    const [room] = await rankedRooms(t);
    expect(room).toMatchObject({ queue: "ffa4", mode: "1v1", status: "playing" });
    const seats = await seatsOf(t, room!._id);
    expect(seats.map((s) => s.color).sort()).toEqual(["blue", "green", "red", "yellow"]);
    expect(new Set(seats.map((s) => s.accountId)).size).toBe(4);
    await expectLiveEqualsReplay(t, room!._id);
  });

  it("team2v2 builds balanced teams", async () => {
    const ratings = [1250, 1200, 1240, 1210];
    const players: QueuePlayer[] = [];
    for (let i = 0; i < 4; i++) players.push(await queuePlayer(t, i + 1, { rating: ratings[i] }));
    for (const p of players) await join(p, "team2v2");
    await runScheduledMatcher(t);
    const [room] = await rankedRooms(t);
    expect(room).toMatchObject({ queue: "team2v2", mode: "2v2" });
    const seats = await seatsOf(t, room!._id);
    const teamOf = (n: number) => seats.find((s) => s.accountId === players[n]!.accountId)!.team;
    expect(teamOf(0)).toBe(teamOf(1));
    expect(teamOf(2)).toBe(teamOf(3));
    expect(teamOf(0)).not.toBe(teamOf(2));
    for (const s of seats) {
      expect(s.team === "A" ? ["red", "yellow"] : ["green", "blue"]).toContain(s.color);
    }
    await expectLiveEqualsReplay(t, room!._id);
  });

  it("matched players can play and the log still replays to the live state", async () => {
    const [a, b] = await queuePlayers(t, 2);
    await join(a!, "duel");
    await join(b!, "duel");
    await runScheduledMatcher(t);
    const [room] = await rankedRooms(t);
    const started = await asStartedRoom(t, room!._id);
    expect(await playActions(t, dice, started, mulberry32(7), 30)).toBe(30);
    await expectLiveEqualsReplay(t, room!._id);
  });

  it("far-apart ratings wait until both windows widen", async () => {
    const a = await queuePlayer(t, 1, { rating: 1200 });
    const b = await queuePlayer(t, 2, { rating: 1500 });
    await join(a, "duel");
    await join(b, "duel");
    await runScheduledMatcher(t);
    expect(await rankedRooms(t)).toHaveLength(0);

    // Windows reach ±300 after 40s of waiting; the cron sweep re-runs the matcher.
    for (let s = 10; s <= 40; s += 10) {
      setClock(T0 + s * 1_000);
      await a.user.mutation(api.matchmaking.queuePing, {});
      await b.user.mutation(api.matchmaking.queuePing, {});
      await matchNow(t, "duel");
      expect(await rankedRooms(t)).toHaveLength(s < 40 ? 0 : 1);
    }
    const [room] = await rankedRooms(t);
    expect((await seatsOf(t, room!._id)).map((s) => s.accountId).sort()).toEqual(
      [a.accountId, b.accountId].sort(),
    );
  });

  it("a rejoin refreshes the ticket's rating", async () => {
    const [a] = await queuePlayers(t, 1);
    await join(a!, "duel");
    await t.run(async (ctx) => {
      const profile = await ctx.db
        .query("profiles")
        .withIndex("by_account", (q) => q.eq("accountId", a!.accountId))
        .unique();
      await ctx.db.patch(profile!._id, { rating: 1337 });
    });
    await join(a!, "duel");
    expect((await tickets(t))[0]?.rating).toBe(1337);
  });

  it("bots are never queued or seated in ranked rooms", async () => {
    const players = await queuePlayers(t, 4);
    for (const p of players) await join(p, "ffa4");
    await runScheduledMatcher(t);
    const [room] = await rankedRooms(t);
    const seats = await seatsOf(t, room!._id);
    expect(seats.every((s) => !s.isBot && s.accountId)).toBe(true);
  });
});

describe("already-in-game guard", () => {
  it("joining while matched returns the match instead of a new ticket", async () => {
    const [a, b] = await queuePlayers(t, 2);
    await join(a!, "duel");
    await join(b!, "duel");
    await runScheduledMatcher(t);
    const [room] = await rankedRooms(t);
    const again = await join(a!, "ffa4");
    expect(again).toMatchObject({ status: "matched", roomId: room!._id });
    expect((await tickets(t)).every((r) => r.status === "matched")).toBe(true);
  });

  it("an account with a live ranked seat but no ticket gets that game back", async () => {
    const [a, b] = await queuePlayers(t, 2);
    await join(a!, "duel");
    await join(b!, "duel");
    await runScheduledMatcher(t);
    const [room] = await rankedRooms(t);
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("matchQueue").collect()) await ctx.db.delete(row._id);
    });
    expect(await join(a!, "duel")).toEqual({ status: "inGame", roomId: room!._id, code: room!.code });
    expect(await a!.user.query(api.matchmaking.queueStatus, {})).toEqual({
      status: "inGame",
      roomId: room!._id,
      code: room!.code,
    });
    expect(await tickets(t)).toHaveLength(0);
  });

  it("leaving a ranked game frees the account to queue again", async () => {
    const [a, b] = await queuePlayers(t, 2);
    await join(a!, "duel");
    await join(b!, "duel");
    await runScheduledMatcher(t);
    const [room] = await rankedRooms(t);
    await t.mutation(api.rooms.leaveRoom, { roomId: room!._id, clientId: a!.clientId });
    expect((await t.run(async (ctx) => ctx.db.get(room!._id)))?.status).toBe("finished");

    expect(await a!.user.query(api.matchmaking.queueStatus, {})).toEqual({ status: "idle" });
    expect(await b!.user.query(api.matchmaking.queueStatus, {})).toEqual({ status: "idle" });
    expect(await join(a!, "duel")).toMatchObject({ status: "waiting", queue: "duel" });
  });
});

describe("leave racing a match", () => {
  it("leave after the matcher seated the player returns the match", async () => {
    const [a, b] = await queuePlayers(t, 2);
    await join(a!, "duel");
    await join(b!, "duel");
    await matchNow(t, "duel");
    const [room] = await rankedRooms(t);
    const left = await a!.user.mutation(api.matchmaking.leaveQueue, {});
    expect(left).toMatchObject({ status: "matched", roomId: room!._id, color: "red" });
    expect(await tickets(t)).toHaveLength(2);
  });

  it("leave before the matcher runs keeps the player out of the room", async () => {
    const [a, b, c] = await queuePlayers(t, 3);
    await join(a!, "duel");
    await join(b!, "duel");
    await a!.user.mutation(api.matchmaking.leaveQueue, {});
    await join(c!, "duel");
    await runScheduledMatcher(t);
    const [room] = await rankedRooms(t);
    const accounts = (await seatsOf(t, room!._id)).map((s) => s.accountId).sort();
    expect(accounts).toEqual([b!.accountId, c!.accountId].sort());
  });
});

describe("stale tickets", () => {
  it("a ticket that stops pinging is not matched and is removed by cleanup", async () => {
    const [a, b] = await queuePlayers(t, 2);
    await join(a!, "duel");
    await runScheduledMatcher(t);
    setClock(T0 + STALE_TICKET_MS + 1_000);
    await join(b!, "duel");
    await runScheduledMatcher(t);
    expect(await rankedRooms(t)).toHaveLength(0);

    await t.mutation(internal.cleanup.tick, {});
    const rows = await tickets(t);
    expect(rows.map((r) => r.accountId)).toEqual([b!.accountId]);
    expect(await a!.user.query(api.matchmaking.queueStatus, {})).toEqual({ status: "idle" });
  });

  it("pinging keeps a ticket alive", async () => {
    const [a, b] = await queuePlayers(t, 2);
    await join(a!, "duel");
    for (let i = 1; i <= 4; i++) {
      setClock(T0 + i * 10_000);
      expect(await a!.user.mutation(api.matchmaking.queuePing, {})).toMatchObject({ status: "waiting" });
    }
    await t.mutation(internal.cleanup.tick, {});
    expect(await tickets(t)).toHaveLength(1);
    await join(b!, "duel");
    await runScheduledMatcher(t);
    expect(await rankedRooms(t)).toHaveLength(1);
  });

  it("cleanup drops matched tickets once their game is over", async () => {
    const [a, b] = await queuePlayers(t, 2);
    await join(a!, "duel");
    await join(b!, "duel");
    await runScheduledMatcher(t);
    const [room] = await rankedRooms(t);

    setClock(T0 + 2 * 60_000);
    await t.mutation(internal.cleanup.tick, {});
    expect(await tickets(t)).toHaveLength(2);

    await t.mutation(api.rooms.leaveRoom, { roomId: room!._id, clientId: a!.clientId });
    setClock(T0 + 5 * 60_000);
    await t.mutation(internal.cleanup.tick, {});
    expect(await tickets(t)).toHaveLength(0);
  });

  it("the sweep cron matches tickets a scheduled run missed", async () => {
    const [a, b] = await queuePlayers(t, 2);
    await t.run(async (ctx) => {
      for (const p of [a!, b!]) {
        await ctx.db.insert("matchQueue", {
          accountId: p.accountId,
          clientId: p.clientId,
          displayName: p.username,
          queue: "duel",
          rating: 1200,
          status: "waiting",
          joinedAt: T0,
          lastPingAt: T0,
        });
      }
    });
    await t.mutation(internal.matchmaking.sweep, {});
    await runScheduledMatcher(t);
    expect(await rankedRooms(t)).toHaveLength(1);
  });
});

describe("ranked room rules", () => {
  async function matchedDuel() {
    const [a, b] = await queuePlayers(t, 2);
    await join(a!, "duel");
    await join(b!, "duel");
    await runScheduledMatcher(t);
    const [room] = await rankedRooms(t);
    return { a: a!, b: b!, room: room! };
  }

  it("strangers and anonymous tabs cannot take a seat", async () => {
    const { room } = await matchedDuel();
    const stranger = await queuePlayer(t, 9);
    await expect(
      stranger.user.mutation(api.rooms.joinRoom, { code: room.code, clientId: stranger.clientId, name: "P1" }),
    ).rejects.toThrow(GameError.rankedSeatsOnly);
    await expect(
      t.mutation(api.rooms.joinRoom, { code: room.code, clientId: clientId(77), name: "P1" }),
    ).rejects.toThrow(GameError.rankedSeatsOnly);
  });

  it("the owner reclaims the seat from a new tab without host approval", async () => {
    const { a, room } = await matchedDuel();
    const newTab = clientId(4242);
    await expect(
      a.user.mutation(api.rooms.joinRoom, { code: room.code, clientId: newTab, name: "anything" }),
    ).rejects.toThrow(GameError.seatInUse);

    setClock(T0 + SEAT_LIVE_MS + 1_000);
    const result = await a.user.mutation(api.rooms.joinRoom, { code: room.code, clientId: newTab, name: "x" });
    expect(result).toMatchObject({ roomId: room._id, color: "red", reconnected: true });
    const seat = (await seatsOf(t, room._id)).find((s) => s.accountId === a.accountId)!;
    expect(seat.clientId).toBe(newTab);
    expect(seat.name).toBe("P1");
    expect(await t.run(async (ctx) => ctx.db.query("rejoinRequests").collect())).toHaveLength(0);
    await expectLiveEqualsReplay(t, room._id);
  });

  it("a disconnected seat is reclaimed immediately", async () => {
    const { b, room } = await matchedDuel();
    await t.mutation(api.rooms.markDisconnected, { roomId: room._id, clientId: b.clientId });
    const result = await b.user.mutation(api.rooms.joinRoom, { code: room.code, clientId: clientId(5555), name: "" });
    expect(result).toMatchObject({ color: "yellow", reconnected: true });
  });

  it("a player who left cannot sit back down from another tab", async () => {
    const players = await queuePlayers(t, 4);
    for (const p of players) await join(p, "ffa4");
    await runScheduledMatcher(t);
    const [room] = await rankedRooms(t);
    const quitter = players[0]!;
    await t.mutation(api.rooms.leaveRoom, { roomId: room!._id, clientId: quitter.clientId });
    await expect(
      quitter.user.mutation(api.rooms.joinRoom, { code: room!.code, clientId: clientId(6000), name: "P1" }),
    ).rejects.toThrow(GameError.seatForfeited);
  });

  it("host powers are disabled", async () => {
    const { a, room } = await matchedDuel();
    await expect(
      t.mutation(api.rooms.kickPlayer, { roomId: room._id, clientId: a.clientId, targetColor: "yellow" }),
    ).rejects.toThrow(GameError.rankedLocked);
    await expect(
      t.mutation(api.rooms.addBot, { roomId: room._id, clientId: a.clientId }),
    ).rejects.toThrow(GameError.rankedLocked);
    await t.mutation(api.rooms.leaveRoom, { roomId: room._id, clientId: a.clientId });
    await expect(
      t.mutation(api.rooms.rematch, { roomId: room._id, clientId: a.clientId }),
    ).rejects.toThrow(GameError.rankedNoRematch);
  });

  it("private rooms and vs-computer rooms stay unranked", async () => {
    const [a] = await queuePlayers(t, 1);
    const own = await a!.user.mutation(api.rooms.createRoom, { clientId: a!.clientId, name: "" });
    const solo = await t.mutation(api.rooms.createVsComputer, { clientId: clientId(31), name: "Solo", botCount: 2 });
    for (const created of [own, solo]) {
      if (!("roomId" in created)) throw new Error("pending");
      const room = await t.run(async (ctx) => ctx.db.get(created.roomId));
      expect(room?.ranked).toBeUndefined();
    }
    if (!("roomId" in solo)) throw new Error("pending");
    const seats = await seatsOf(t, solo.roomId);
    expect(seats.filter((s) => s.isBot).map((s) => s.clientId)).toEqual(
      seats.filter((s) => s.isBot).map((s) => `bot:${solo.roomId}:${s.color}`),
    );
    await expectLiveEqualsReplay(t, solo.roomId);
  });
});
