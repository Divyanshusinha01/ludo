import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { internal } from "../../convex/_generated/api";
import { MAX_TIMEOUT_LIVES } from "../../convex/lib/ludo";
import {
  bundle,
  expectLiveEqualsReplay,
  rollAs,
  seatClient,
  setupConvex,
  startedRoom,
  teardownConvex,
  type DiceQueue,
  type RoomId,
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

/** A 1v1 mid-match: one token out, a pending move on the table. */
async function midMatch(): Promise<RoomId> {
  const room = await startedRoom(t, { players: 2 });
  const seat = (await bundle(t, room.roomId)).room.currentTurn;
  await rollAs(t, dice, room.roomId, seatClient(room, seat), 6);
  await expectLiveEqualsReplay(t, room.roomId);
  return room.roomId;
}

async function verify(roomId: RoomId) {
  return await t.query(internal.gameEvents.verifyReplay, { roomId });
}

describe("verifyReplay compares the whole normalized state", () => {
  it("detects drift in a seat's lives", async () => {
    const roomId = await midMatch();
    await t.run(async (ctx) => {
      const p = await ctx.db
        .query("players")
        .withIndex("by_room", (q) => q.eq("roomId", roomId))
        .first();
      await ctx.db.patch(p!._id, { lives: 1 });
    });
    const verdict = await verify(roomId);
    expect(verdict.ok).toBe(false);
    expect(verdict.diffs).toHaveLength(1);
    expect(verdict.diffs[0]).toMatch(new RegExp(`^seats\\[\\d\\]\\.lives: 1 vs ${MAX_TIMEOUT_LIVES}$`));
  });

  it("detects drift in a token's steps", async () => {
    const roomId = await midMatch();
    await t.run(async (ctx) => {
      const tok = await ctx.db
        .query("tokens")
        .withIndex("by_room", (q) => q.eq("roomId", roomId))
        .first();
      await ctx.db.patch(tok!._id, { steps: 12 });
    });
    const verdict = await verify(roomId);
    expect(verdict.ok).toBe(false);
    expect(verdict.diffs).toHaveLength(1);
    expect(verdict.diffs[0]).toMatch(/^tokens\[\d+\]\.steps: 12 vs -1$/);
  });

  it("detects drift in turn bookkeeping the old summary ignored", async () => {
    const roomId = await midMatch();
    await t.run(async (ctx) => {
      await ctx.db.patch(roomId, { consecutiveSixes: 2, passedRollTo: "green" });
    });
    const verdict = await verify(roomId);
    expect(verdict.ok).toBe(false);
    expect(verdict.diffs).toEqual([
      "consecutiveSixes: 2 vs 1",
      'passedRollTo: "green" vs null',
    ]);
  });

  it("reports a broken log as a replay failure", async () => {
    const roomId = await midMatch();
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("gameEvents")
        .withIndex("by_game_seq", (q) => q.eq("gameId", roomId).eq("seq", 3))
        .unique();
      await ctx.db.delete(row!._id);
    });
    const verdict = await verify(roomId);
    expect(verdict.ok).toBe(false);
    expect(verdict.diffs).toHaveLength(1);
    expect(verdict.diffs[0]).toMatch(/^replay failed at seq 4 \(\w+\): Seq not contiguous$/);
  });

  it("reports a log truncated behind the room head", async () => {
    const roomId = await midMatch();
    const head = await t.run(async (ctx) => {
      const room = await ctx.db.get(roomId);
      const tail = await ctx.db
        .query("gameEvents")
        .withIndex("by_game_seq", (q) => q.eq("gameId", roomId))
        .order("desc")
        .first();
      await ctx.db.delete(tail!._id);
      return room!.eventSeq!;
    });
    const verdict = await verify(roomId);
    expect(verdict.ok).toBe(false);
    expect(verdict.diffs[0]).toBe(`log ends at seq ${head - 1} but the room head is ${head}`);
    expect(verdict.diffs).toContain("diceRolled: true vs false");
  });
});
