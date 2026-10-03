import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { api, internal } from "../../convex/_generated/api";
import { GameError } from "../../convex/lib/errors";
import type { Color } from "../../convex/lib/ludo";
import { mulberry32 } from "../game/fixtures/dice";
import { moveCall, rollCall } from "./concurrency/helpers";
import {
  advance,
  bundle,
  expectLiveEqualsReplay,
  expectRejectedUnchanged,
  nextAction,
  playActions,
  rawRoom,
  seatClient,
  setupConvex,
  snapshot,
  startedRoom,
  storedEvents,
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
  dice.clear();
  teardownConvex(dice);
});

async function head(roomId: RoomId): Promise<number> {
  return (await rawRoom(t, roomId))!.eventSeq!;
}

/** Rooms with disjoint session ids, so no player sits in two rooms. */
async function rooms(playerCounts: number[]): Promise<StartedRoom[]> {
  const out: StartedRoom[] = [];
  for (const [i, players] of playerCounts.entries()) {
    out.push(await startedRoom(t, { players, clientBase: i * 10 }));
  }
  return out;
}

describe("concurrently running rooms stay isolated", () => {
  it("rooms played in parallel to the end each keep their own log and verify", async () => {
    const all = await rooms([2, 2, 2]);
    const rng = mulberry32(31);
    dice.seedFallback(31);

    for (let round = 0; round < 4000; round++) {
      await advance(t);
      const batch: Array<{ room: StartedRoom; headBefore: number; run: () => Promise<unknown> }> = [];
      for (const room of all) {
        const action = await nextAction(t, room, rng);
        if (!action) continue;
        const args = await turnArgs(t, room.roomId);
        batch.push({
          room,
          headBefore: args.expectedSeq,
          run: () =>
            action.kind === "roll"
              ? rollCall(t, dice, room.roomId, action.client, args, action.face)
              : moveCall(t, room.roomId, action.client, args, action.tokenColor, action.tokenIndex),
        });
      }
      if (batch.length === 0) break;

      const results = await Promise.allSettled(batch.map((b) => b.run()));
      dice.clear();
      expect(results.filter((r) => r.status === "rejected")).toEqual([]);
      for (const b of batch) expect(await head(b.room.roomId)).toBeGreaterThan(b.headBefore);
    }

    for (const room of all) {
      expect((await rawRoom(t, room.roomId))!.status).toBe("finished");
      const events = await storedEvents(t, room.roomId);
      for (const e of events) {
        expect(e.gameId).toBe(room.roomId);
        expect(e.eventId).toBe(`${room.roomId}:${e.seq}`);
      }
      const final = await expectLiveEqualsReplay(t, room.roomId);
      expect(final.seats.map((s) => s.color).sort()).toEqual((Object.keys(room.clients) as Color[]).sort());
    }

    const totalRows = await t.run(async (ctx) => (await ctx.db.query("gameEvents").collect()).length);
    let perRoom = 0;
    for (const room of all) perRoom += await head(room.roomId);
    expect(totalRows).toBe(perRoom);
  });

  it("actions in one room never change another room's head, log or tokens", async () => {
    const [a, b] = await rooms([2, 2]);
    const rng = mulberry32(8);
    dice.seedFallback(8);
    await playActions(t, dice, b!, rng, 5);
    const bBefore = await snapshot(t, b!.roomId);
    const aStart = await head(a!.roomId);

    await playActions(t, dice, a!, rng, 25);

    expect(await head(a!.roomId)).toBeGreaterThan(aStart);
    const bAfter = await snapshot(t, b!.roomId);
    expect(bAfter.events).toEqual(bBefore.events);
    expect(bAfter.tokens).toEqual(bBefore.tokens);
    expect(bAfter.room!.eventSeq).toBe(bBefore.room!.eventSeq);
    expect(bAfter.room!.turnId).toBe(bBefore.room!.turnId);
    await expectLiveEqualsReplay(t, a!.roomId);
    await expectLiveEqualsReplay(t, b!.roomId);
  });

  it("a player of one room cannot act in another, even with that room's fresh args", async () => {
    const [a, b] = await rooms([2, 2]);
    const bTurn = (await bundle(t, b!.roomId)).room.currentTurn;
    const outsider = seatClient(a!, (await bundle(t, a!.roomId)).room.currentTurn);
    await advance(t);
    const bArgs = await turnArgs(t, b!.roomId);
    const aBefore = await snapshot(t, a!.roomId);

    await expectRejectedUnchanged(
      t,
      b!.roomId,
      () => rollCall(t, dice, b!.roomId, outsider, bArgs, 6),
      GameError.notInRoom,
    );
    dice.clear();
    await expectRejectedUnchanged(
      t,
      b!.roomId,
      () => moveCall(t, b!.roomId, outsider, bArgs, bTurn, 0),
      GameError.notInRoom,
    );
    await expect(
      t.query(api.gameEvents.listEvents, { roomId: b!.roomId, clientId: outsider }),
    ).rejects.toThrow(GameError.notInRoom);
    expect(await snapshot(t, a!.roomId)).toEqual(aBefore);

    await rollCall(t, dice, b!.roomId, seatClient(b!, bTurn), bArgs, 6);
    dice.clear();
    expect(await snapshot(t, a!.roomId)).toEqual(aBefore);
    expect(await t.query(internal.gameEvents.verifyReplay, { roomId: a!.roomId })).toMatchObject({ ok: true });
  });
});
