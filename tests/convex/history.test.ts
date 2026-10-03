import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { INITIAL_RATING } from "../../convex/lib/rating";
import { settleRankedRoom } from "../../convex/lib/settlement";
import { loadGameState } from "../../convex/lib/gameStore";
import { stubAuthEnv } from "./auth-helpers";
import {
  asStartedRoom,
  join,
  queuePlayers,
  rankedRooms,
  runScheduledMatcher,
  seatsOf,
  type QueuePlayer,
} from "./matchmaking-helpers";
import {
  advance,
  expectLiveEqualsReplay,
  playToEnd,
  rawRoom,
  setClock,
  setupConvex,
  teardownConvex,
  type DiceQueue,
  type T,
} from "./setup";
import type { QueueName } from "../../convex/lib/matchmaking";

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

const FIRST_PAGE = { numItems: 10, cursor: null };

async function matchOf(players: QueuePlayer[], queue: QueueName) {
  for (const p of players) await join(p, queue);
  await runScheduledMatcher(t);
  const room = (await rankedRooms(t)).find((r) => r.status === "playing");
  if (!room) throw new Error("no live ranked room");
  return room;
}

async function leave(roomId: Id<"rooms">, p: QueuePlayer) {
  await t.mutation(api.rooms.leaveRoom, { roomId, clientId: p.clientId });
}

async function allMatches() {
  return await t.run(async (ctx) => ({
    matches: await ctx.db.query("matches").collect(),
    participants: await ctx.db.query("matchParticipants").collect(),
  }));
}

async function historyOf(p: QueuePlayer, paginationOpts: { numItems: number; cursor: string | null } = FIRST_PAGE) {
  return await p.user.query(api.history.listMine, { paginationOpts });
}

describe("match persistence", () => {
  it("a settled duel writes one match and a participant row per account", async () => {
    const players = await queuePlayers(t, 2);
    const [quitter, stayer] = players as [QueuePlayer, QueuePlayer];
    const room = await matchOf(players, "duel");
    await leave(room._id, quitter);

    const { matches, participants } = await allMatches();
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      roomId: room._id,
      roomCode: room.code,
      queue: "duel",
      mode: "1v1",
      rated: true,
      endReason: "sole_survivor",
      winnerAccountIds: [stayer.accountId],
    });
    expect(participants).toHaveLength(2);
    const byAccount = Object.fromEntries(participants.map((p) => [p.accountId, p]));
    expect(byAccount[stayer.accountId]).toMatchObject({
      username: stayer.username,
      displayName: "P2",
      placement: 1,
      won: true,
      ratingBefore: INITIAL_RATING,
      ratingAfter: INITIAL_RATING + 20,
      delta: 20,
    });
    expect(byAccount[quitter.accountId]).toMatchObject({
      placement: 2,
      won: false,
      ratingAfter: INITIAL_RATING - 20,
      delta: -20,
    });
  });

  it("a full seeded game is recorded with its finish reason", async () => {
    const players = await queuePlayers(t, 2);
    const room = await matchOf(players, "duel");
    await playToEnd(t, dice, await asStartedRoom(t, room._id), { seed: 11 });

    const finished = await rawRoom(t, room._id);
    const detail = await t.query(api.history.getRoomResult, { roomId: room._id });
    expect(detail).toMatchObject({ rated: true, queue: "duel", endReason: "automatic_loser" });
    expect(detail!.participants.map((p) => p.placement)).toEqual([1, 2]);
    const seats = await seatsOf(t, room._id);
    const winnerName = seats.find((s) => s.color === finished!.winner)!.name;
    expect(detail!.participants[0]).toMatchObject({ displayName: winnerName, won: true, delta: 20 });
    await expectLiveEqualsReplay(t, room._id);
  });

  it("2v2 records teams and both winners", async () => {
    const players = await queuePlayers(t, 4);
    const room = await matchOf(players, "team2v2");
    const seats = await seatsOf(t, room._id);
    const teamA = players.filter((p) => seats.find((s) => s.accountId === p.accountId)!.team === "A");
    await leave(room._id, teamA[0]!);
    await leave(room._id, teamA[1]!);

    const detail = await t.query(api.history.getRoomResult, { roomId: room._id });
    expect(detail).toMatchObject({ mode: "2v2", queue: "team2v2", rated: true });
    expect(detail!.participants).toHaveLength(4);
    for (const p of detail!.participants) {
      expect(p.team).toBeDefined();
      expect(p.won).toBe(p.team === "B");
      expect(p.delta).toBe(p.team === "B" ? 20 : -20);
    }
    const { matches } = await allMatches();
    expect(matches[0]!.winnerAccountIds).toHaveLength(2);
  });

  it("settling again never writes a second match", async () => {
    const players = await queuePlayers(t, 2);
    const room = await matchOf(players, "duel");
    await leave(room._id, players[0]!);

    await t.run(async (ctx) => {
      const fresh = (await ctx.db.get(room._id))!;
      await settleRankedRoom(ctx, room._id, await loadGameState(ctx, fresh), "sole_survivor", Date.now() + 1);
    });
    const { matches, participants } = await allMatches();
    expect(matches).toHaveLength(1);
    expect(participants).toHaveLength(2);
  });

  it("an abandoned ranked game is kept as unrated history with no rating change", async () => {
    const players = await queuePlayers(t, 2);
    const room = await matchOf(players, "duel");
    await t.run(async (ctx) => {
      const fresh = (await ctx.db.get(room._id))!;
      const state = await loadGameState(ctx, fresh);
      await settleRankedRoom(ctx, room._id, { ...state, phase: "finished" }, "abandoned", Date.now());
    });

    const detail = await t.query(api.history.getRoomResult, { roomId: room._id });
    expect(detail).toMatchObject({ rated: false, endReason: "abandoned" });
    for (const p of detail!.participants) {
      expect(p).toMatchObject({ won: false, delta: 0, ratingBefore: INITIAL_RATING, ratingAfter: INITIAL_RATING });
    }
    const page = await historyOf(players[0]!);
    expect(page.page).toEqual([expect.objectContaining({ rated: false, delta: 0 })]);
  });

  it("private rooms write unrated history with the real result", async () => {
    const [a, b] = (await queuePlayers(t, 2)) as [QueuePlayer, QueuePlayer];
    const created = await a.user.mutation(api.rooms.createRoom, { clientId: a.clientId, name: "" });
    if (!("roomId" in created)) throw new Error("pending");
    await b.user.mutation(api.rooms.joinRoom, { code: created.code, clientId: b.clientId, name: "" });
    await t.mutation(api.rooms.startGame, { roomId: created.roomId, clientId: a.clientId });
    await leave(created.roomId, a);
    expect((await rawRoom(t, created.roomId))?.status).toBe("finished");

    const { matches, participants } = await allMatches();
    expect(matches).toEqual([
      expect.objectContaining({ kind: "private", rated: false, winnerAccountIds: [b.accountId] }),
    ]);
    expect(participants).toHaveLength(2);
    expect((await historyOf(a)).page).toEqual([
      expect.objectContaining({ kind: "private", rated: false, won: false, delta: 0 }),
    ]);
    expect((await historyOf(b)).page).toEqual([
      expect.objectContaining({ kind: "private", rated: false, won: true, delta: 0 }),
    ]);
  });
});

describe("history queries", () => {
  it("history survives the room being deleted by cleanup", async () => {
    const players = await queuePlayers(t, 2);
    const room = await matchOf(players, "duel");
    await leave(room._id, players[0]!);
    const matchId = (await allMatches()).matches[0]!._id;

    setClock(Date.now() + 7 * 60 * 60 * 1000);
    await t.mutation(internal.cleanup.tick, {});
    expect(await rawRoom(t, room._id)).toBeNull();

    const page = await historyOf(players[1]!);
    expect(page.page).toEqual([expect.objectContaining({ matchId, delta: 20, won: true })]);
    const detail = await t.query(api.history.getMatch, { matchId });
    expect(detail?.participants.map((p) => p.username)).toEqual([players[1]!.username, players[0]!.username]);
    expect(await t.query(api.history.getRoomResult, { roomId: room._id })).toMatchObject({ matchId });
  });

  it("lists the caller's games newest first across pages", async () => {
    const players = await queuePlayers(t, 2);
    const [a, b] = players as [QueuePlayer, QueuePlayer];
    for (const quitter of [a, b, a]) {
      const room = await matchOf(players, "duel");
      await leave(room._id, quitter);
      await advance(t, 5_000);
    }

    const first = await historyOf(a, { numItems: 2, cursor: null });
    expect(first.page).toHaveLength(2);
    expect(first.isDone).toBe(false);
    const second = await historyOf(a, { numItems: 2, cursor: first.continueCursor });
    expect(second.page).toHaveLength(1);

    const all = [...first.page, ...second.page];
    const times = all.map((e) => e.finishedAt);
    expect(times).toEqual([...times].sort((x, y) => y - x));
    expect(all.map((e) => e.won)).toEqual([false, true, false]);
    expect(all.map((e) => Math.sign(e.delta))).toEqual([-1, 1, -1]);
    // Each game starts from the rating the previous one ended with.
    expect(all[0]!.ratingBefore).toBe(all[1]!.ratingAfter);
    expect(all[1]!.ratingBefore).toBe(all[2]!.ratingAfter);
    expect(all[2]!.ratingBefore).toBe(INITIAL_RATING);
  });

  it("only returns the caller's own rows and nothing to anonymous callers", async () => {
    const players = await queuePlayers(t, 4);
    const room1 = await matchOf(players.slice(0, 2), "duel");
    await leave(room1._id, players[0]!);
    const room2 = await matchOf(players.slice(2, 4), "duel");
    await leave(room2._id, players[2]!);

    expect((await historyOf(players[0]!)).page).toHaveLength(1);
    expect((await historyOf(players[3]!)).page).toHaveLength(1);
    expect((await historyOf(players[0]!)).page[0]!.matchId).not.toBe((await historyOf(players[3]!)).page[0]!.matchId);
    expect(await t.query(api.history.listMine, { paginationOpts: FIRST_PAGE })).toEqual({
      page: [],
      isDone: true,
      continueCursor: "",
    });
  });

  it("history rows expose no client ids, account ids or credentials", async () => {
    const players = await queuePlayers(t, 2);
    const room = await matchOf(players, "duel");
    await leave(room._id, players[0]!);
    const matchId = (await allMatches()).matches[0]!._id;

    const results = [
      await historyOf(players[0]!),
      await t.query(api.history.getMatch, { matchId }),
      await t.query(api.history.getRoomResult, { roomId: room._id }),
      await t.query(api.history.leaderboard, {}),
    ];
    const serialized = JSON.stringify(results);
    for (const p of players) {
      expect(serialized).not.toContain(p.clientId);
      expect(serialized).not.toContain(p.accountId);
    }
    for (const key of ["clientId", "accountId", "roomId", "passwordHash", "tokenHash", "winnerAccountIds"]) {
      expect(serialized).not.toContain(`"${key}"`);
    }
  });

  it("getMatch returns null for malformed or unknown ids", async () => {
    expect(await t.query(api.history.getMatch, { matchId: "not-an-id" })).toBeNull();
    const players = await queuePlayers(t, 2);
    const room = await matchOf(players, "duel");
    expect(await t.query(api.history.getRoomResult, { roomId: room._id })).toBeNull();
  });
});

describe("leaderboard", () => {
  it("ranks rated players by rating and skips accounts with no rated games", async () => {
    const players = await queuePlayers(t, 5);
    const room1 = await matchOf(players.slice(0, 2), "duel");
    await leave(room1._id, players[0]!);
    const room2 = await matchOf(players.slice(2, 4), "duel");
    await leave(room2._id, players[2]!);
    await t.run(async (ctx) => {
      const p = await ctx.db
        .query("profiles")
        .withIndex("by_account", (q) => q.eq("accountId", players[4]!.accountId))
        .unique();
      await ctx.db.patch(p!._id, { rating: 3000 });
    });

    const board = await t.query(api.history.leaderboard, {});
    expect(board.map((e) => e.rank)).toEqual([1, 2, 3, 4]);
    expect(board.map((e) => e.rating)).toEqual([1220, 1220, 1180, 1180]);
    expect(board.some((e) => e.username === players[4]!.username)).toBe(false);
    expect(board[0]).toMatchObject({ ratedGames: 1, wins: 1 });

    expect(await t.query(api.history.leaderboard, { limit: 1 })).toHaveLength(1);
    expect(await t.query(api.history.leaderboard, { limit: 0 })).toHaveLength(1);
    expect(await t.query(api.history.leaderboard, { limit: 1000 })).toHaveLength(4);
  });
});
