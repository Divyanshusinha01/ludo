import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { api } from "../../convex/_generated/api";
import { GameError } from "../../convex/lib/errors";
import { commitEvents } from "../../convex/lib/gameStore";
import type { LudoEventDraft } from "../../convex/lib/game";
import {
  advance,
  bundle,
  expectLiveEqualsReplay,
  expectRejectedUnchanged,
  moveAs,
  rawRoom,
  rollAs,
  seatClient,
  setupConvex,
  snapshot,
  startedRoom,
  storedEvents,
  teardownConvex,
  turnArgs,
  type DiceQueue,
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
});

async function currentClient(room: StartedRoom): Promise<string> {
  const b = await bundle(t, room.roomId);
  return seatClient(room, b.room.currentTurn);
}

async function rollWith(
  room: StartedRoom,
  client: string,
  args: { turnId: number; expectedSeq: number },
  face = 6,
) {
  dice.clear();
  dice.push(face);
  try {
    return await t.mutation(api.game.rollDice, { roomId: room.roomId, clientId: client, ...args });
  } finally {
    dice.clear();
  }
}

describe("event sequence numbers through the store", () => {
  it("every commit appends contiguous seqs, deterministic ids and the room's gameId", async () => {
    const room = await startedRoom(t, { players: 2 });
    const seat = (await bundle(t, room.roomId)).room.currentTurn;
    const client = seatClient(room, seat);
    await rollAs(t, dice, room.roomId, client, 6);
    await moveAs(t, room.roomId, client, seat, 0);
    await rollAs(t, dice, room.roomId, client, 3);

    const events = await storedEvents(t, room.roomId);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    for (const e of events) {
      expect(e.gameId).toBe(room.roomId);
      expect(e.eventId).toBe(`${room.roomId}:${e.seq}`);
    }
    expect((await rawRoom(t, room.roomId))?.eventSeq).toBe(events.length);
    await expectLiveEqualsReplay(t, room.roomId);
  });

  it("records the acting session on seat events and nothing on system events", async () => {
    const room = await startedRoom(t, { players: 2 });
    const seat = (await bundle(t, room.roomId)).room.currentTurn;
    const client = seatClient(room, seat);
    const head = (await rawRoom(t, room.roomId))!.eventSeq!;
    await rollAs(t, dice, room.roomId, client, 3);
    const added = (await storedEvents(t, room.roomId)).filter((e) => e.seq > head);
    expect(added.map((e) => e.eventType)).toEqual(["DICE_ROLLED", "TURN_ENDED", "TURN_STARTED"]);
    expect(added[0]!.actor).toEqual({ kind: "seat", color: seat });
    expect(added.every((e) => e.actorClientId === client)).toBe(true);
  });

  it("rejects an expectedSeq behind the head", async () => {
    const room = await startedRoom(t, { players: 2 });
    const client = await currentClient(room);
    await advance(t);
    const args = await turnArgs(t, room.roomId);
    await expectRejectedUnchanged(
      t,
      room.roomId,
      () => rollWith(room, client, { ...args, expectedSeq: args.expectedSeq - 1 }),
      GameError.staleAction,
    );
  });

  it("rejects an expectedSeq ahead of the head", async () => {
    const room = await startedRoom(t, { players: 2 });
    const client = await currentClient(room);
    await advance(t);
    const args = await turnArgs(t, room.roomId);
    await expectRejectedUnchanged(
      t,
      room.roomId,
      () => rollWith(room, client, { ...args, expectedSeq: args.expectedSeq + 1 }),
      GameError.staleAction,
    );
  });

  it("rejects a stale turnId", async () => {
    const room = await startedRoom(t, { players: 2 });
    const client = await currentClient(room);
    await advance(t);
    const args = await turnArgs(t, room.roomId);
    await expectRejectedUnchanged(
      t,
      room.roomId,
      () => rollWith(room, client, { ...args, turnId: args.turnId - 1 }),
      GameError.staleAction,
    );
  });

  it("rejects a commit when the stored tail event is missing", async () => {
    const room = await startedRoom(t, { players: 2 });
    const client = await currentClient(room);
    await t.run(async (ctx) => {
      const tail = await ctx.db
        .query("gameEvents")
        .withIndex("by_game_seq", (q) => q.eq("gameId", room.roomId))
        .order("desc")
        .first();
      await ctx.db.delete(tail!._id);
    });
    await advance(t);
    const args = await turnArgs(t, room.roomId);
    await expectRejectedUnchanged(
      t,
      room.roomId,
      () => rollWith(room, client, args),
      GameError.staleAction,
    );
  });

  it("rejects a commit when an event was written past the head", async () => {
    const room = await startedRoom(t, { players: 2 });
    const client = await currentClient(room);
    const head = (await rawRoom(t, room.roomId))!.eventSeq!;
    await t.run(async (ctx) => {
      await ctx.db.insert("gameEvents", {
        gameId: room.roomId,
        seq: head + 1,
        eventId: `${room.roomId}:${head + 1}`,
        createdAt: 0,
        actor: { kind: "system" },
        eventType: "TURN_ENDED",
        payload: { reason: "moved" },
      });
    });
    await advance(t);
    const args = await turnArgs(t, room.roomId);
    await expectRejectedUnchanged(
      t,
      room.roomId,
      () => rollWith(room, client, args),
      GameError.staleAction,
    );
  });

  it("commitEvents itself rejects a stale expectedSeq and writes nothing", async () => {
    const room = await startedRoom(t, { players: 2 });
    const before = await snapshot(t, room.roomId);
    const seat = before.room!.currentTurn;
    const drafts: LudoEventDraft[] = [
      {
        gameId: room.roomId,
        createdAt: 0,
        actor: { kind: "seat", color: seat },
        eventType: "DICE_ROLLED",
        payload: { color: seat, value: 3 },
      },
    ];
    await expect(
      t.run(async (ctx) => {
        const doc = (await ctx.db.get(room.roomId))!;
        await commitEvents(ctx, doc, drafts, { expectedSeq: doc.eventSeq! - 1, now: Date.now() });
      }),
    ).rejects.toThrow(GameError.staleAction);
    expect(await snapshot(t, room.roomId)).toEqual(before);
  });

  it("commitEvents rejects an illegal draft and writes nothing", async () => {
    const room = await startedRoom(t, { players: 2 });
    const before = await snapshot(t, room.roomId);
    const seat = before.room!.currentTurn;
    const drafts: LudoEventDraft[] = [
      {
        gameId: room.roomId,
        createdAt: 0,
        actor: { kind: "seat", color: seat },
        eventType: "TOKEN_MOVED",
        payload: { tokenColor: seat, tokenIndex: 0 },
      },
    ];
    await expect(
      t.run(async (ctx) => {
        const doc = (await ctx.db.get(room.roomId))!;
        await commitEvents(ctx, doc, drafts, { expectedSeq: doc.eventSeq!, now: Date.now() });
      }),
    ).rejects.toThrow();
    expect(await snapshot(t, room.roomId)).toEqual(before);
  });
});
