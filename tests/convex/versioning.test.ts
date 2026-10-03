import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../../convex/_generated/api";
import { BOT_THINK_MS } from "../../convex/lib/bot";
import { GameError } from "../../convex/lib/errors";
import { commitEvents } from "../../convex/lib/gameStore";
import { TURN_TIMEOUT_MS, type Color } from "../../convex/lib/ludo";
import {
  advance,
  bundle,
  clientId,
  expectLiveEqualsReplay,
  expectRejectedUnchanged,
  playToEnd,
  rawRoom,
  rollAs,
  seatClient,
  setClock,
  setupConvex,
  snapshot,
  startedRoom,
  teardownConvex,
  turnArgs,
  type DiceQueue,
  type RoomId,
  type StartedRoom,
  type T,
} from "./setup";

let t: T;
let dice: DiceQueue;

beforeEach(() => {
  ({ t, dice } = setupConvex());
});

afterEach(() => {
  teardownConvex(dice);
  vi.restoreAllMocks();
});

async function head(roomId: RoomId): Promise<number> {
  return (await rawRoom(t, roomId))!.eventSeq!;
}

/** Assert the head moved strictly forward since `prev`; returns the new head. */
async function expectAdvanced(roomId: RoomId, prev: number): Promise<number> {
  const next = await head(roomId);
  expect(next).toBeGreaterThan(prev);
  return next;
}

function otherSeat(clients: Partial<Record<Color, string>>, seat: Color): Color {
  return (Object.keys(clients) as Color[]).find((c) => c !== seat)!;
}

function guestSeat(room: StartedRoom): Color {
  return (Object.keys(room.clients) as Color[]).find((c) => room.clients[c] !== room.host)!;
}

/** Structured log lines with the given `event`, parsed from console.log calls. */
function loggedEvents(spy: { mock: { calls: unknown[][] } }, event: string): Array<Record<string, unknown>> {
  return spy.mock.calls
    .map((args) => {
      try {
        return JSON.parse(String(args[0])) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((line): line is Record<string, unknown> => line?.event === event);
}

describe("eventSeq is the room's state version", () => {
  it("strictly increases on every action of a full match and across a rematch", async () => {
    const room = await startedRoom(t, { players: 2 });
    let prev = await head(room.roomId);
    await playToEnd(t, dice, room, {
      seed: 3,
      afterAction: async () => {
        prev = await expectAdvanced(room.roomId, prev);
      },
    });
    expect((await rawRoom(t, room.roomId))!.status).toBe("finished");

    await t.mutation(api.rooms.rematch, { roomId: room.roomId, clientId: room.host });
    prev = await expectAdvanced(room.roomId, prev);

    const seat = (await bundle(t, room.roomId)).room.currentTurn;
    await rollAs(t, dice, room.roomId, seatClient(room, seat), 3);
    await expectAdvanced(room.roomId, prev);
    await expectLiveEqualsReplay(t, room.roomId);
  });

  it("lobby joins, a kick and the start each advance it", async () => {
    const room = await startedRoom(t, { players: 3, start: false });
    let prev = await head(room.roomId);

    await t.mutation(api.rooms.joinRoom, { code: room.code, clientId: clientId(9), name: "P9" });
    prev = await expectAdvanced(room.roomId, prev);

    await t.mutation(api.rooms.kickPlayer, {
      roomId: room.roomId,
      clientId: room.host,
      targetColor: guestSeat(room),
    });
    prev = await expectAdvanced(room.roomId, prev);

    await t.mutation(api.rooms.startGame, { roomId: room.roomId, clientId: room.host });
    await expectAdvanced(room.roomId, prev);
    await expectLiveEqualsReplay(t, room.roomId);
  });

  it("a leave forfeit advances it", async () => {
    const room = await startedRoom(t, { players: 3 });
    const prev = await head(room.roomId);
    const leaver = otherSeat(room.clients, (await bundle(t, room.roomId)).room.currentTurn);
    await t.mutation(api.rooms.leaveRoom, { roomId: room.roomId, clientId: seatClient(room, leaver) });
    await expectAdvanced(room.roomId, prev);
    await expectLiveEqualsReplay(t, room.roomId);
  });

  it("the cleanup crown advances it through abandoned forfeits", async () => {
    const room = await startedRoom(t, { players: 3 });
    const prev = await head(room.roomId);
    const keeper = (Object.keys(room.clients) as Color[])[0]!;
    setClock(Date.now() + 100_000);
    await t.mutation(api.rooms.heartbeat, { roomId: room.roomId, clientId: seatClient(room, keeper) });
    await t.mutation(internal.cleanup.tick, {});
    await expectAdvanced(room.roomId, prev);
    const final = await expectLiveEqualsReplay(t, room.roomId);
    expect(final.phase).toBe("finished");
  });

  it("a turn timeout advances it", async () => {
    const room = await startedRoom(t, { players: 2 });
    const prev = await head(room.roomId);
    await advance(t, TURN_TIMEOUT_MS + 10);
    await expectAdvanced(room.roomId, prev);
    await expectLiveEqualsReplay(t, room.roomId);
  });

  it("bot jobs never move it backwards and each bot commit advances it", async () => {
    const human = clientId(1);
    const created = await t.mutation(api.rooms.createVsComputer, { clientId: human, name: "Human", botCount: 1 });
    if (!("roomId" in created)) throw new Error("create returned pending");
    const roomId = created.roomId;
    dice.seedFallback(11);
    await rollAs(t, dice, roomId, human, 3);

    let prev = await head(roomId);
    let botCommits = 0;
    for (let i = 0; i < 10; i++) {
      await advance(t, BOT_THINK_MS);
      const next = await head(roomId);
      expect(next).toBeGreaterThanOrEqual(prev);
      if (next > prev) botCommits++;
      prev = next;
      const b = await bundle(t, roomId);
      if (b.room.currentTurn === created.color && !b.room.diceRolled) break;
    }
    expect(botCommits).toBeGreaterThan(0);
    await expectLiveEqualsReplay(t, roomId);
  });

  it("every rejected call leaves it unchanged", async () => {
    const room = await startedRoom(t, { players: 2 });
    const seat = (await bundle(t, room.roomId)).room.currentTurn;
    const client = seatClient(room, seat);
    const other = seatClient(room, otherSeat(room.clients, seat));
    await advance(t);
    const args = await turnArgs(t, room.roomId);
    const start = await head(room.roomId);

    const roll = (c: string, a: { turnId: number; expectedSeq: number }) => () => {
      dice.clear();
      dice.push(6);
      return t.mutation(api.game.rollDice, { roomId: room.roomId, clientId: c, ...a });
    };

    await expectRejectedUnchanged(t, room.roomId, roll(client, { ...args, expectedSeq: args.expectedSeq - 1 }), GameError.staleAction);
    await expectRejectedUnchanged(t, room.roomId, roll(client, { ...args, expectedSeq: args.expectedSeq + 1 }), GameError.staleAction);
    await expectRejectedUnchanged(t, room.roomId, roll(client, { ...args, turnId: args.turnId + 1 }), GameError.staleAction);
    await expectRejectedUnchanged(t, room.roomId, roll(other, args), GameError.notYourTurn);
    await expectRejectedUnchanged(
      t,
      room.roomId,
      () => t.mutation(api.game.moveToken, { roomId: room.roomId, clientId: client, tokenIndex: 0, ...args }),
      GameError.illegalMove,
    );
    await expectRejectedUnchanged(
      t,
      room.roomId,
      () => t.mutation(api.rooms.startGame, { roomId: room.roomId, clientId: room.host }),
      GameError.gameStarted,
    );
    await expectRejectedUnchanged(
      t,
      room.roomId,
      () => t.mutation(api.rooms.rematch, { roomId: room.roomId, clientId: room.host }),
      GameError.notFinished,
    );
    await expectRejectedUnchanged(
      t,
      room.roomId,
      () =>
        t.mutation(api.rooms.kickPlayer, {
          roomId: room.roomId,
          clientId: room.host,
          targetColor: guestSeat(room),
        }),
      GameError.gameStarted,
    );
    expect(await head(room.roomId)).toBe(start);

    await roll(client, args)();
    await expectAdvanced(room.roomId, start);
    await expectLiveEqualsReplay(t, room.roomId);
  });

  it("commitEvents refuses an empty commit and writes nothing", async () => {
    const room = await startedRoom(t, { players: 2 });
    const before = await snapshot(t, room.roomId);
    await expect(
      t.run(async (ctx) => {
        const doc = (await ctx.db.get(room.roomId))!;
        await commitEvents(ctx, doc, [], { expectedSeq: doc.eventSeq!, now: Date.now() });
      }),
    ).rejects.toThrow(/empty commit/);
    expect(await snapshot(t, room.roomId)).toEqual(before);
  });
});

describe("stale rejections are logged with the versions involved", () => {
  it("an expectedSeq mismatch logs headSeq and expectedSeq", async () => {
    const room = await startedRoom(t, { players: 2 });
    const client = seatClient(room, (await bundle(t, room.roomId)).room.currentTurn);
    await advance(t);
    const args = await turnArgs(t, room.roomId);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(
      t.mutation(api.game.rollDice, {
        roomId: room.roomId,
        clientId: client,
        ...args,
        expectedSeq: args.expectedSeq - 1,
      }),
    ).rejects.toThrow(GameError.staleAction);

    expect(loggedEvents(spy, "mutation_rejected")).toEqual([
      expect.objectContaining({
        code: "stale",
        reason: "seq_mismatch",
        roomCode: room.code,
        headSeq: args.expectedSeq,
        expectedSeq: args.expectedSeq - 1,
      }),
    ]);
  });

  it("a turnId mismatch logs both turn ids and seqs", async () => {
    const room = await startedRoom(t, { players: 2 });
    const client = seatClient(room, (await bundle(t, room.roomId)).room.currentTurn);
    await advance(t);
    const args = await turnArgs(t, room.roomId);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(
      t.mutation(api.game.rollDice, { roomId: room.roomId, clientId: client, ...args, turnId: args.turnId - 1 }),
    ).rejects.toThrow(GameError.staleAction);

    expect(loggedEvents(spy, "mutation_rejected")).toEqual([
      expect.objectContaining({
        code: "stale",
        reason: "turn_mismatch",
        headSeq: args.expectedSeq,
        expectedSeq: args.expectedSeq,
        turnId: args.turnId,
        expectedTurnId: args.turnId - 1,
      }),
    ]);
  });

  it("successful actions log no rejection", async () => {
    const room = await startedRoom(t, { players: 2 });
    const client = seatClient(room, (await bundle(t, room.roomId)).room.currentTurn);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await rollAs(t, dice, room.roomId, client, 3);
    expect(loggedEvents(spy, "mutation_rejected")).toEqual([]);
  });
});
