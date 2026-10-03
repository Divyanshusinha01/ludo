import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { GameError } from "../../convex/lib/errors";
import { INITIAL_RATING } from "../../convex/lib/rating";
import { deleteRoomCascade } from "../../convex/lib/roomAuth";
import {
  MAX_SPECTATORS_PER_ROOM,
  SPECTATOR_STALE_MS,
} from "../../convex/lib/spectate";
import { mulberry32 } from "../game/fixtures/dice";
import { stubAuthEnv } from "./auth-helpers";
import { join, queuePlayers, rankedRooms, runScheduledMatcher } from "./matchmaking-helpers";
import {
  advance,
  bundle,
  bundleView,
  clientId,
  expectLiveEqualsReplay,
  expectRejectedUnchanged,
  playActions,
  rawRoom,
  setClock,
  setupConvex,
  snapshot,
  startedRoom,
  teardownConvex,
  turnArgs,
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

const WATCHER = clientId(900);
const WATCHER_2 = clientId(901);

async function rankedDuel() {
  const players = await queuePlayers(t, 2);
  for (const p of players) await join(p, "duel");
  await runScheduledMatcher(t);
  const room = (await rankedRooms(t)).find((r) => r.status === "playing");
  if (!room) throw new Error("no ranked room");
  return { room, players };
}

async function spectatorRows(roomId?: Id<"rooms">) {
  const rows = await t.run(async (ctx) => await ctx.db.query("spectators").collect());
  return roomId ? rows.filter((r) => r.roomId === roomId) : rows;
}

async function watch(roomId: Id<"rooms">, spectatorId = WATCHER) {
  return await t.mutation(api.spectate.joinSpectate, { roomId, spectatorId });
}

describe("listLive", () => {
  it("lists ranked games in progress with names, ratings and watcher counts", async () => {
    const { room } = await rankedDuel();
    await watch(room._id);
    await watch(room._id, WATCHER_2);

    const live = await t.query(api.spectate.listLive, {});
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({
      code: room.code,
      queue: "duel",
      mode: "1v1",
      spectators: 2,
    });
    expect(live[0]!.players.map((p) => p.name).sort()).toEqual(["P1", "P2"]);
    for (const p of live[0]!.players) expect(p.rating).toBe(INITIAL_RATING);
  });

  it("never lists private code rooms, vs-computer games, lobbies or finished games", async () => {
    await startedRoom(t, { players: 2 });
    await startedRoom(t, { players: 2, start: false, clientBase: 10 });
    await t.mutation(api.rooms.createVsComputer, { clientId: clientId(50), name: "Solo", botCount: 1 });
    const { room, players } = await rankedDuel();
    await t.mutation(api.rooms.leaveRoom, { roomId: room._id, clientId: players[0]!.clientId });
    expect((await rawRoom(t, room._id))?.status).toBe("finished");

    expect(await t.query(api.spectate.listLive, {})).toEqual([]);
  });
});

describe("getSpectatorRoom", () => {
  it("returns the public view with no seat identity and no client ids", async () => {
    const { room, players } = await rankedDuel();
    await watch(room._id);
    const result = await t.query(api.spectate.getSpectatorRoom, { code: room.code.toLowerCase() });
    expect(result).not.toBeNull();
    expect(result!.spectators).toBe(1);
    expect(result!.view.me).toBeNull();
    expect(result!.view.players.every((p) => !p.isMe)).toBe(true);

    const serialized = JSON.stringify(result);
    for (const p of players) {
      expect(serialized).not.toContain(p.clientId);
      expect(serialized).not.toContain(p.accountId);
    }
    expect(serialized).not.toContain(WATCHER);
    for (const key of ["clientId", "spectatorId", "accountId", "hostClientId"]) {
      expect(serialized).not.toContain(`"${key}"`);
    }
  });

  it("shows a private code room only to someone who has the code", async () => {
    const room = await startedRoom(t, { players: 2 });
    const result = await t.query(api.spectate.getSpectatorRoom, { code: room.code });
    expect(result?.view.room.status).toBe("playing");
    expect(await t.query(api.spectate.listLive, {})).toEqual([]);
  });

  it("is null for vs-computer, unknown and malformed codes", async () => {
    const solo = await t.mutation(api.rooms.createVsComputer, { clientId: clientId(50), name: "Solo", botCount: 1 });
    if (!("roomId" in solo)) throw new Error("pending");
    expect(await t.query(api.spectate.getSpectatorRoom, { code: solo.code })).toBeNull();
    expect(await t.query(api.spectate.getSpectatorRoom, { code: "ZZZZZZ" })).toBeNull();
    expect(await t.query(api.spectate.getSpectatorRoom, { code: "nope" })).toBeNull();
  });

  it("matches what seated players see as the game moves", async () => {
    const room = await startedRoom(t, { players: 3 });
    await watch(room.roomId);
    const rng = mulberry32(7);
    for (let i = 0; i < 6; i++) {
      await playActions(t, dice, room, rng, 5);
      const spectated = await t.query(api.spectate.getSpectatorRoom, { code: room.code });
      expect(bundleView(spectated!.view)).toEqual(bundleView(await bundle(t, room.roomId, room.host)));
    }
    await expectLiveEqualsReplay(t, room.roomId);
  });
});

describe("joining and leaving", () => {
  it("duplicate joins keep one row; leaving twice is a no-op", async () => {
    const room = await startedRoom(t, { players: 2 });
    await watch(room.roomId);
    await advance(t, 6_000);
    await watch(room.roomId);
    expect(await spectatorRows(room.roomId)).toHaveLength(1);

    await t.mutation(api.spectate.leaveSpectate, { roomId: room.roomId, spectatorId: WATCHER });
    await t.mutation(api.spectate.leaveSpectate, { roomId: room.roomId, spectatorId: WATCHER });
    expect(await spectatorRows(room.roomId)).toHaveLength(0);
  });

  it("watchers can follow a finished game", async () => {
    const { room, players } = await rankedDuel();
    await t.mutation(api.rooms.leaveRoom, { roomId: room._id, clientId: players[0]!.clientId });
    await watch(room._id);
    const result = await t.query(api.spectate.getSpectatorRoom, { code: room.code });
    expect(result?.view.room.status).toBe("finished");
    expect(result?.spectators).toBe(1);
  });

  it("rejects lobbies, vs-computer games, seated players and bad ids", async () => {
    const lobby = await startedRoom(t, { players: 2, start: false });
    await expect(watch(lobby.roomId)).rejects.toThrow(GameError.spectateNotStarted);

    const solo = await t.mutation(api.rooms.createVsComputer, { clientId: clientId(50), name: "Solo", botCount: 1 });
    if (!("roomId" in solo)) throw new Error("pending");
    await expect(watch(solo.roomId)).rejects.toThrow(GameError.notSpectatable);

    const room = await startedRoom(t, { players: 2, clientBase: 20 });
    await expect(watch(room.roomId, room.host)).rejects.toThrow(GameError.spectatorIsPlayer);
    await expect(watch(room.roomId, "not-a-uuid")).rejects.toThrow(GameError.invalidSession);
    expect(await spectatorRows()).toHaveLength(0);
  });

  it("caps live watchers per room; stale rows do not count", async () => {
    const room = await startedRoom(t, { players: 2 });
    const now = Date.now();
    await t.run(async (ctx) => {
      for (let i = 0; i < MAX_SPECTATORS_PER_ROOM; i++) {
        await ctx.db.insert("spectators", { roomId: room.roomId, spectatorId: clientId(2000 + i), lastSeenAt: now });
      }
    });
    await expect(watch(room.roomId)).rejects.toThrow(GameError.spectatorsFull);
    expect(await t.mutation(api.spectate.spectatorPing, { roomId: room.roomId, spectatorId: WATCHER })).toBe(false);

    await advance(t, SPECTATOR_STALE_MS + 1);
    await watch(room.roomId);
    expect((await spectatorRows(room.roomId)).some((r) => r.spectatorId === WATCHER)).toBe(true);
  });
});

describe("read-only enforcement", () => {
  it("a watcher cannot roll, move, pass, chat, talk, report, or change the room", async () => {
    const room = await startedRoom(t, { players: 4, mode: "2v2" });
    await watch(room.roomId);
    const args = await turnArgs(t, room.roomId);
    const notSeated = new RegExp(`${GameError.notInRoom}|${GameError.onlyHost}`);

    const calls: Array<[string, () => Promise<unknown>]> = [
      ["rollDice", () => t.mutation(api.game.rollDice, { roomId: room.roomId, clientId: WATCHER, ...args })],
      ["moveToken", () => t.mutation(api.game.moveToken, { roomId: room.roomId, clientId: WATCHER, tokenIndex: 0, ...args })],
      ["passTurn", () => t.mutation(api.game.passTurn, { roomId: room.roomId, clientId: WATCHER, targetColor: "yellow", ...args })],
      ["sendMessage", () => t.mutation(api.chat.sendMessage, { roomId: room.roomId, clientId: WATCHER, text: "hi" })],
      ["joinVoice", () => t.mutation(api.voice.joinVoice, { roomId: room.roomId, clientId: WATCHER })],
      ["reportClientEvents", () => t.mutation(api.ops.reportClientEvents, { roomId: room.roomId, clientId: WATCHER, events: [] })],
      ["listEvents", () => t.query(api.gameEvents.listEvents, { roomId: room.roomId, clientId: WATCHER })],
      ["listMessages", () => t.query(api.chat.listMessages, { roomId: room.roomId, clientId: WATCHER })],
    ];
    for (const [name, call] of calls) {
      await advance(t);
      await expectRejectedUnchanged(t, room.roomId, call, notSeated).catch((e: unknown) => {
        throw new Error(`${name}: ${String(e)}`);
      });
    }

    const before = await snapshot(t, room.roomId);
    expect(await t.mutation(api.rooms.leaveRoom, { roomId: room.roomId, clientId: WATCHER })).toEqual({ emptied: false });
    expect(await t.mutation(api.rooms.heartbeat, { roomId: room.roomId, clientId: WATCHER })).toBeNull();
    expect(await snapshot(t, room.roomId)).toEqual(before);
  });

  it("a watcher cannot rematch a finished room or kick from a lobby", async () => {
    const room = await startedRoom(t, { players: 3 });
    await t.mutation(api.rooms.leaveRoom, { roomId: room.roomId, clientId: room.clients.yellow! });
    await t.mutation(api.rooms.leaveRoom, { roomId: room.roomId, clientId: room.clients.green! });
    expect((await rawRoom(t, room.roomId))?.status).toBe("finished");
    await watch(room.roomId);
    await expectRejectedUnchanged(
      t,
      room.roomId,
      () => t.mutation(api.rooms.rematch, { roomId: room.roomId, clientId: WATCHER }),
      GameError.onlyHost,
    );

    const lobby = await startedRoom(t, { players: 2, start: false, clientBase: 30 });
    await expectRejectedUnchanged(
      t,
      lobby.roomId,
      () => t.mutation(api.rooms.kickPlayer, { roomId: lobby.roomId, clientId: WATCHER, targetColor: "yellow" }),
      GameError.onlyHost,
    );
  });

  it("watching never changes the room, its log or eventSeq", async () => {
    const room = await startedRoom(t, { players: 2 });
    const before = await snapshot(t, room.roomId);
    await watch(room.roomId);
    await advance(t, 6_000);
    await t.mutation(api.spectate.spectatorPing, { roomId: room.roomId, spectatorId: WATCHER });
    await watch(room.roomId, WATCHER_2);
    await t.mutation(api.spectate.leaveSpectate, { roomId: room.roomId, spectatorId: WATCHER_2 });
    expect(await snapshot(t, room.roomId)).toEqual(before);
    await expectLiveEqualsReplay(t, room.roomId);
  });
});

describe("presence and reaping", () => {
  it("cleanup reaps silent watchers; a later ping re-joins", async () => {
    const room = await startedRoom(t, { players: 2 });
    await watch(room.roomId);
    await watch(room.roomId, WATCHER_2);

    setClock(Date.now() + SPECTATOR_STALE_MS - 1_000);
    await t.mutation(api.spectate.spectatorPing, { roomId: room.roomId, spectatorId: WATCHER_2 });
    setClock(Date.now() + 2_000);
    await t.mutation(internal.cleanup.tick, {});
    const left = await spectatorRows(room.roomId);
    expect(left.map((r) => r.spectatorId)).toEqual([WATCHER_2]);
    expect((await t.query(api.spectate.getSpectatorRoom, { code: room.code }))?.spectators).toBe(1);

    expect(await t.mutation(api.spectate.spectatorPing, { roomId: room.roomId, spectatorId: WATCHER })).toBe(true);
    expect(await spectatorRows(room.roomId)).toHaveLength(2);
  });

  it("deleting a room removes its watchers; pinging it afterwards is harmless", async () => {
    const room = await startedRoom(t, { players: 2 });
    await watch(room.roomId);
    await t.run(async (ctx) => await deleteRoomCascade(ctx, room.roomId));
    expect(await rawRoom(t, room.roomId)).toBeNull();
    expect(await spectatorRows()).toHaveLength(0);
    expect(await t.mutation(api.spectate.spectatorPing, { roomId: room.roomId, spectatorId: WATCHER })).toBe(false);
    await expect(watch(room.roomId)).rejects.toThrow(GameError.roomNotFound);
  });
});
