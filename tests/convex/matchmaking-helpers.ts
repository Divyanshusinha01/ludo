import { api, internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import type { QueueName } from "../../convex/lib/matchmaking";
import { asUser, identityFor, signUp, tokenOf } from "./auth-helpers";
import { advance, clientId, type StartedRoom, type T } from "./setup";

export type QueuePlayer = {
  username: string;
  accountId: Id<"accounts">;
  clientId: string;
  user: Awaited<ReturnType<typeof asUser>>;
};

/** A signed-up account with its own tab id. Distinct IPs keep the signup cap out of the way. */
export async function queuePlayer(
  t: T,
  n: number,
  opts: { rating?: number } = {},
): Promise<QueuePlayer> {
  const username = `player${n}`;
  const token = tokenOf(await signUp(t, username, { ipHash: `ip-q-${n}`, displayName: `P${n}` }));
  const identity = await identityFor(t, token);
  const accountId = identity.subject as Id<"accounts">;
  if (opts.rating !== undefined) {
    const rating = opts.rating;
    await t.run(async (ctx) => {
      const profile = await ctx.db
        .query("profiles")
        .withIndex("by_account", (q) => q.eq("accountId", accountId))
        .unique();
      await ctx.db.patch(profile!._id, { rating });
    });
  }
  return {
    username,
    accountId,
    clientId: clientId(1000 + n),
    user: t.withIdentity(identity),
  };
}

export async function queuePlayers(t: T, count: number, base = 0): Promise<QueuePlayer[]> {
  const out: QueuePlayer[] = [];
  for (let i = 1; i <= count; i++) out.push(await queuePlayer(t, base + i));
  return out;
}

export async function join(p: QueuePlayer, queue: QueueName) {
  return await p.user.mutation(api.matchmaking.joinQueue, { clientId: p.clientId, queue });
}

/** Let the matcher jobs scheduled by joinQueue run (and nothing far in the future). */
export async function runScheduledMatcher(t: T): Promise<void> {
  await advance(t, 1);
}

export async function matchNow(t: T, queue: QueueName) {
  return await t.mutation(internal.matchmaking.matchmake, { queue });
}

export async function tickets(t: T) {
  return await t.run(async (ctx) => await ctx.db.query("matchQueue").collect());
}

export async function rankedRooms(t: T) {
  return (await t.run(async (ctx) => await ctx.db.query("rooms").collect())).filter((r) => r.ranked);
}

export async function seatsOf(t: T, roomId: Id<"rooms">) {
  return await t.run(async (ctx) =>
    ctx.db
      .query("players")
      .withIndex("by_room", (q) => q.eq("roomId", roomId))
      .collect(),
  );
}

/** A matched room in the shape the gameplay helpers in setup.ts expect. */
export async function asStartedRoom(t: T, roomId: Id<"rooms">): Promise<StartedRoom> {
  const room = await t.run(async (ctx) => ctx.db.get(roomId));
  if (!room) throw new Error("room missing");
  const seats = await seatsOf(t, roomId);
  return {
    roomId,
    code: room.code,
    host: room.hostClientId,
    clients: Object.fromEntries(seats.map((s) => [s.color, s.clientId])),
  };
}
