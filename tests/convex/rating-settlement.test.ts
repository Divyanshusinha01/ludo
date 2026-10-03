import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { INITIAL_RATING, K_ESTABLISHED, PROVISIONAL_GAMES } from "../../convex/lib/rating";
import { recordUnrankedStats, settleRankedRoom } from "../../convex/lib/settlement";
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
  expectLiveEqualsReplay,
  playToEnd,
  rawRoom,
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

async function profileOf(accountId: Id<"accounts">) {
  const profile = await t.run(async (ctx) =>
    ctx.db
      .query("profiles")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .unique(),
  );
  if (!profile) throw new Error("profile missing");
  return profile;
}

async function matched(queue: QueueName, count: number) {
  const players = await queuePlayers(t, count);
  for (const p of players) await join(p, queue);
  await runScheduledMatcher(t);
  const [room] = await rankedRooms(t);
  if (!room) throw new Error("no ranked room");
  return { players, room };
}

async function leave(roomId: Id<"rooms">, p: QueuePlayer) {
  await t.mutation(api.rooms.leaveRoom, { roomId, clientId: p.clientId });
}

describe("rating settlement", () => {
  it("a full seeded duel moves the winner up and the loser down", async () => {
    const { players, room } = await matched("duel", 2);
    const started = await asStartedRoom(t, room._id);
    await playToEnd(t, dice, started, { seed: 11 });

    const finished = await rawRoom(t, room._id);
    expect(finished?.status).toBe("finished");
    expect(finished?.ratingSettledAt).toBeDefined();
    const seats = await seatsOf(t, room._id);
    const winnerAccount = seats.find((s) => s.color === finished!.winner)!.accountId!;

    for (const p of players) {
      const profile = await profileOf(p.accountId);
      const won = p.accountId === winnerAccount;
      expect(profile).toMatchObject({
        rating: won ? INITIAL_RATING + 20 : INITIAL_RATING - 20,
        peakRating: won ? INITIAL_RATING + 20 : INITIAL_RATING,
        ratedGames: 1,
        gamesPlayed: 1,
        wins: won ? 1 : 0,
      });
    }

    const captureEvents = await t.run(async (ctx) =>
      (await ctx.db
        .query("gameEvents")
        .withIndex("by_game_seq", (q) => q.eq("gameId", room._id))
        .collect()
      ).flatMap((e) => (e.eventType === "TOKEN_CAPTURED" ? [e.payload] : [])),
    );
    for (const seat of seats) {
      const profile = await profileOf(seat.accountId!);
      expect(profile.tokensCaptured).toBe(captureEvents.filter((c) => c.byColor === seat.color).length);
      expect(profile.tokensLost).toBe(captureEvents.filter((c) => c.victimColor === seat.color).length);
    }
    await expectLiveEqualsReplay(t, room._id);
  });

  it("settles exactly once", async () => {
    const { players, room } = await matched("duel", 2);
    await leave(room._id, players[0]!);
    const before = await Promise.all(players.map((p) => profileOf(p.accountId)));
    const settledAt = (await rawRoom(t, room._id))!.ratingSettledAt;

    const again = await t.run(async (ctx) => {
      const fresh = (await ctx.db.get(room._id))!;
      return await settleRankedRoom(ctx, room._id, await loadGameState(ctx, fresh), "sole_survivor", Date.now() + 1);
    });
    expect(again).toEqual({ status: "skipped" });
    expect(await Promise.all(players.map((p) => profileOf(p.accountId)))).toEqual(before);
    expect((await rawRoom(t, room._id))!.ratingSettledAt).toBe(settledAt);
  });

  it("a leaver loses rating to the player who stayed", async () => {
    const { players, room } = await matched("duel", 2);
    const [quitter, stayer] = players as [QueuePlayer, QueuePlayer];
    await leave(room._id, quitter);
    expect((await profileOf(quitter.accountId)).rating).toBe(INITIAL_RATING - 20);
    expect((await profileOf(stayer.accountId)).rating).toBe(INITIAL_RATING + 20);
    expect((await profileOf(stayer.accountId)).wins).toBe(1);
    await expectLiveEqualsReplay(t, room._id);
  });

  it("uses each player's own K", async () => {
    const { players, room } = await matched("duel", 2);
    const [vet, rookie] = players as [QueuePlayer, QueuePlayer];
    await t.run(async (ctx) => {
      const p = await ctx.db
        .query("profiles")
        .withIndex("by_account", (q) => q.eq("accountId", vet.accountId))
        .unique();
      await ctx.db.patch(p!._id, { ratedGames: PROVISIONAL_GAMES });
    });
    await leave(room._id, rookie);
    expect((await profileOf(vet.accountId)).rating).toBe(INITIAL_RATING + K_ESTABLISHED / 2);
    expect((await profileOf(rookie.accountId)).rating).toBe(INITIAL_RATING - 20);
  });

  it("ffa4 rates by final placement: leavers in reverse order of leaving", async () => {
    const { players, room } = await matched("ffa4", 4);
    const [first, second, third, survivor] = players as QueuePlayer[];
    await leave(room._id, first!);
    await leave(room._id, second!);
    expect((await rawRoom(t, room._id))!.ratingSettledAt).toBeUndefined();
    await leave(room._id, third!);

    expect((await rawRoom(t, room._id))!.status).toBe("finished");
    const ratings = await Promise.all([first, second, third, survivor].map((p) => profileOf(p!.accountId)));
    expect(ratings.map((r) => r.rating - INITIAL_RATING)).toEqual([-20, -7, 7, 20]);
    expect(ratings.map((r) => r.wins)).toEqual([0, 0, 0, 1]);
    await expectLiveEqualsReplay(t, room._id);
  });

  it("2v2 applies the team result to both members", async () => {
    const { players, room } = await matched("team2v2", 4);
    const seats = await seatsOf(t, room._id);
    const teamOf = (p: QueuePlayer) => seats.find((s) => s.accountId === p.accountId)!.team;
    const teamA = players.filter((p) => teamOf(p) === "A");
    const teamB = players.filter((p) => teamOf(p) === "B");
    expect(teamA).toHaveLength(2);

    await leave(room._id, teamA[0]!);
    await leave(room._id, teamA[1]!);

    const finished = await rawRoom(t, room._id);
    expect(finished).toMatchObject({ status: "finished", winningTeam: "B" });
    for (const p of teamA) {
      expect(await profileOf(p.accountId)).toMatchObject({ rating: INITIAL_RATING - 20, wins: 0 });
    }
    for (const p of teamB) {
      expect(await profileOf(p.accountId)).toMatchObject({ rating: INITIAL_RATING + 20, wins: 1 });
    }
    await expectLiveEqualsReplay(t, room._id);
  });

  it("an abandoned finish closes the game without moving ratings", async () => {
    const { players, room } = await matched("duel", 2);
    const result = await t.run(async (ctx) => {
      const fresh = (await ctx.db.get(room._id))!;
      const state = await loadGameState(ctx, fresh);
      return await settleRankedRoom(ctx, room._id, { ...state, phase: "finished" }, "abandoned", Date.now());
    });
    expect(result).toEqual({ status: "void" });
    expect((await rawRoom(t, room._id))!.ratingSettledAt).toBeDefined();
    for (const p of players) {
      expect(await profileOf(p.accountId)).toMatchObject({ rating: INITIAL_RATING, ratedGames: 0 });
    }
  });

  it("the next ticket carries the new rating", async () => {
    const { players, room } = await matched("duel", 2);
    await leave(room._id, players[0]!);
    await join(players[1]!, "duel");
    const ticket = await t.run(async (ctx) =>
      ctx.db
        .query("matchQueue")
        .withIndex("by_account", (q) => q.eq("accountId", players[1]!.accountId))
        .unique(),
    );
    expect(ticket).toMatchObject({ status: "waiting", rating: INITIAL_RATING + 20 });
  });
});

describe("unrated games", () => {
  it("a private room between signed-in players counts toward stats but leaves ratings alone", async () => {
    const [a, b] = (await queuePlayers(t, 2)) as [QueuePlayer, QueuePlayer];
    const created = await a.user.mutation(api.rooms.createRoom, { clientId: a.clientId, name: "" });
    if (!("roomId" in created)) throw new Error("pending");
    await b.user.mutation(api.rooms.joinRoom, { code: created.code, clientId: b.clientId, name: "" });
    await t.mutation(api.rooms.startGame, { roomId: created.roomId, clientId: a.clientId });
    await leave(created.roomId, a);

    const room = await rawRoom(t, created.roomId);
    expect(room?.status).toBe("finished");
    expect(room?.ratingSettledAt).toBeUndefined();
    for (const p of [a, b]) {
      expect(await profileOf(p.accountId)).toMatchObject({
        rating: INITIAL_RATING,
        ratedGames: 0,
        gamesPlayed: 1,
        wins: p === b ? 1 : 0,
      });
      const history = await p.user.query(api.history.listMine, {
        paginationOpts: { numItems: 10, cursor: null },
      });
      expect(history.page).toHaveLength(1);
      expect(history.page[0]).toMatchObject({
        kind: "private",
        rated: false,
        won: p === b,
        delta: 0,
        ratingAfter: INITIAL_RATING,
      });
    }
  });

  it("each finished game in the same private room gets its own history entry", async () => {
    const [a, b] = (await queuePlayers(t, 2)) as [QueuePlayer, QueuePlayer];
    const created = await a.user.mutation(api.rooms.createRoom, { clientId: a.clientId, name: "" });
    if (!("roomId" in created)) throw new Error("pending");
    await b.user.mutation(api.rooms.joinRoom, { code: created.code, clientId: b.clientId, name: "" });
    await t.mutation(api.rooms.startGame, { roomId: created.roomId, clientId: a.clientId });
    await t.run(async (ctx) => {
      const fresh = (await ctx.db.get(created.roomId))!;
      const state = await loadGameState(ctx, fresh);
      await recordUnrankedStats(ctx, created.roomId, { ...state, phase: "finished" }, "sole_survivor", 1);
      await recordUnrankedStats(ctx, created.roomId, { ...state, phase: "finished" }, "sole_survivor", 2);
    });
    const history = await a.user.query(api.history.listMine, {
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(history.page.map((e) => e.finishedAt)).toEqual([2, 1]);
  });

  it("an abandoned private game is not counted", async () => {
    const [a, b] = (await queuePlayers(t, 2)) as [QueuePlayer, QueuePlayer];
    const created = await a.user.mutation(api.rooms.createRoom, { clientId: a.clientId, name: "" });
    if (!("roomId" in created)) throw new Error("pending");
    await b.user.mutation(api.rooms.joinRoom, { code: created.code, clientId: b.clientId, name: "" });
    await t.mutation(api.rooms.startGame, { roomId: created.roomId, clientId: a.clientId });
    await t.run(async (ctx) => {
      const fresh = (await ctx.db.get(created.roomId))!;
      const state = await loadGameState(ctx, fresh);
      await recordUnrankedStats(ctx, created.roomId, { ...state, phase: "finished" }, "abandoned", Date.now());
    });
    for (const p of [a, b]) {
      expect(await profileOf(p.accountId)).toMatchObject({ gamesPlayed: 0, wins: 0 });
      const history = await p.user.query(api.history.listMine, {
        paginationOpts: { numItems: 10, cursor: null },
      });
      expect(history.page).toHaveLength(0);
    }
  });

  it("a signed-in vs-computer game that ends is never settled", async () => {
    const [a] = (await queuePlayers(t, 1)) as [QueuePlayer];
    const created = await a.user.mutation(api.rooms.createVsComputer, {
      clientId: a.clientId,
      name: "",
      botCount: 1,
    });
    if (!("roomId" in created)) throw new Error("pending");
    await leave(created.roomId, a);
    const room = await rawRoom(t, created.roomId);
    expect(room?.ranked).toBeUndefined();
    expect(room?.ratingSettledAt).toBeUndefined();
    expect(await profileOf(a.accountId)).toMatchObject({ rating: INITIAL_RATING, ratedGames: 0 });
    const history = await a.user.query(api.history.listMine, {
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(history.page).toEqual([]);
  });});
