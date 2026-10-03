import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { QUEUES, type QueueName } from "../../../convex/lib/matchmaking";
import { stubAuthEnv } from "../auth-helpers";
import {
  join,
  matchNow,
  queuePlayers,
  rankedRooms,
  runScheduledMatcher,
  seatsOf,
  tickets,
} from "../matchmaking-helpers";
import { expectLiveEqualsReplay, setupConvex, teardownConvex, type DiceQueue, type T } from "../setup";

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

/** Every ranked room is full, rooms are disjoint, and each matched ticket points at its seat. */
async function expectDisjointFullRooms(queue: QueueName, expectedRooms: number) {
  const rooms = await rankedRooms(t);
  expect(rooms).toHaveLength(expectedRooms);
  const seen = new Map<Id<"accounts">, Id<"rooms">>();
  for (const room of rooms) {
    const seats = await seatsOf(t, room._id);
    expect(seats).toHaveLength(QUEUES[queue].size);
    for (const seat of seats) {
      expect(seat.accountId).toBeDefined();
      expect(seen.has(seat.accountId!)).toBe(false);
      seen.set(seat.accountId!, room._id);
    }
    await expectLiveEqualsReplay(t, room._id);
  }
  for (const ticket of await tickets(t)) {
    if (ticket.status === "matched") {
      expect(seen.get(ticket.accountId)).toBe(ticket.roomId);
    } else {
      expect(seen.has(ticket.accountId)).toBe(false);
    }
  }
  return seen;
}

describe("matchmaking races", () => {
  it("double join from two tabs of one account leaves one ticket", async () => {
    const [a] = await queuePlayers(t, 1);
    const results = await Promise.all([
      join(a!, "duel"),
      a!.user.mutation(api.matchmaking.joinQueue, { clientId: "00000000-0000-4000-8000-00000000abcd", queue: "duel" }),
    ]);
    expect(results.every((r) => r.status === "waiting")).toBe(true);
    expect(await tickets(t)).toHaveLength(1);
  });

  it("double leave is a no-op the second time", async () => {
    const [a] = await queuePlayers(t, 1);
    await join(a!, "duel");
    const results = await Promise.all([
      a!.user.mutation(api.matchmaking.leaveQueue, {}),
      a!.user.mutation(api.matchmaking.leaveQueue, {}),
    ]);
    expect(results).toEqual([{ status: "idle" }, { status: "idle" }]);
    expect(await tickets(t)).toHaveLength(0);
  });

  for (const queue of ["duel", "ffa4", "team2v2"] as const) {
    it(`${queue}: concurrent joiners produce disjoint full rooms`, async () => {
      const size = QUEUES[queue].size;
      const players = await queuePlayers(t, size * 3 + 1);
      await Promise.all(players.map((p) => join(p, queue)));
      await Promise.all([matchNow(t, queue), matchNow(t, queue), matchNow(t, queue)]);
      await runScheduledMatcher(t);
      const seated = await expectDisjointFullRooms(queue, 3);
      expect(seated.size).toBe(size * 3);
      expect((await tickets(t)).filter((r) => r.status === "waiting")).toHaveLength(1);
    });
  }

  it("leave racing the matcher: the player is either seated or out, never both", async () => {
    for (let round = 0; round < 4; round++) {
      const players = await queuePlayers(t, 2, round * 10);
      for (const p of players) await join(p, "duel");
      const leaver = players[round % 2]!;
      const calls =
        round < 2
          ? [leaver.user.mutation(api.matchmaking.leaveQueue, {}), matchNow(t, "duel")]
          : [matchNow(t, "duel"), leaver.user.mutation(api.matchmaking.leaveQueue, {})];
      const [first, second] = await Promise.all(calls);
      const left = (round < 2 ? first : second) as { status: string };

      const ticket = (await tickets(t)).find((r) => r.accountId === leaver.accountId);
      const seatedRooms = [];
      for (const room of await rankedRooms(t)) {
        if ((await seatsOf(t, room._id)).some((s) => s.accountId === leaver.accountId)) {
          seatedRooms.push(room);
        }
      }
      if (left.status === "matched") {
        expect(seatedRooms).toHaveLength(1);
        expect(ticket?.status).toBe("matched");
      } else {
        expect(left.status).toBe("idle");
        expect(seatedRooms).toHaveLength(0);
        expect(ticket).toBeUndefined();
      }
      // Reset for the next round.
      await t.run(async (ctx) => {
        for (const row of await ctx.db.query("matchQueue").collect()) await ctx.db.delete(row._id);
      });
      for (const room of await rankedRooms(t)) {
        await t.run(async (ctx) => ctx.db.patch(room._id, { status: "finished" }));
      }
    }
  });

  it("joins interleaved with matcher runs never seat a ticket twice", async () => {
    const players = await queuePlayers(t, 10);
    await Promise.all(
      players.flatMap((p, i) => (i % 3 === 0 ? [join(p, "duel"), matchNow(t, "duel")] : [join(p, "duel")])),
    );
    await runScheduledMatcher(t);
    await expectDisjointFullRooms("duel", 5);
  });
});
