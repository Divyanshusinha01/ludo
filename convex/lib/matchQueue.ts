import { v } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { colorValidator } from "./colors";
import { COLORS } from "./ludo";
import { logEvent } from "./log";
import {
  assignSeats,
  formGroups,
  MATCH_BATCH,
  MATCHED_TICKET_RECHECK_MS,
  MAX_GROUPS_PER_RUN,
  QUEUES,
  queueValidator,
  STALE_TICKET_MS,
  type QueueName,
} from "./matchmaking";
import { createStartedRoom } from "./roomFactory";

type DbCtx = QueryCtx | MutationCtx;

/** What a client may know about its own ticket: no ids of other players, no clientIds. */
export const queueStatusValidator = v.union(
  v.object({ status: v.literal("idle") }),
  v.object({
    status: v.literal("waiting"),
    queue: queueValidator,
    joinedAt: v.number(),
  }),
  v.object({
    status: v.literal("matched"),
    queue: queueValidator,
    roomId: v.id("rooms"),
    code: v.string(),
    color: colorValidator,
  }),
  v.object({
    status: v.literal("inGame"),
    roomId: v.id("rooms"),
    code: v.string(),
  }),
);

export type QueueStatus =
  | { status: "idle" }
  | { status: "waiting"; queue: QueueName; joinedAt: number }
  | {
      status: "matched";
      queue: QueueName;
      roomId: Id<"rooms">;
      code: string;
      color: Doc<"players">["color"];
    }
  | { status: "inGame"; roomId: Id<"rooms">; code: string };

export const IDLE: QueueStatus = { status: "idle" };

export async function ticketForAccount(
  ctx: DbCtx,
  accountId: Id<"accounts">,
): Promise<Doc<"matchQueue"> | null> {
  return await ctx.db
    .query("matchQueue")
    .withIndex("by_account", (q) => q.eq("accountId", accountId))
    .first();
}

function seatStillInPlay(seat: Doc<"players">): boolean {
  return seat.leftAt === undefined && !seat.eliminated && seat.finishRank == null;
}

/** The account's seat in this room, if the room is a live ranked game it is still playing in. */
async function liveRankedSeat(
  ctx: DbCtx,
  roomId: Id<"rooms">,
  accountId: Id<"accounts">,
): Promise<{ room: Doc<"rooms">; seat: Doc<"players"> } | null> {
  const room = await ctx.db.get(roomId);
  if (!room || !room.ranked || room.status !== "playing") return null;
  const seat = (
    await ctx.db
      .query("players")
      .withIndex("by_room", (q) => q.eq("roomId", roomId))
      .collect()
  ).find((p) => p.accountId === accountId);
  if (!seat || !seatStillInPlay(seat)) return null;
  return { room, seat };
}

/**
 * An unfinished ranked game the account still has a live seat in. Seats are
 * deleted with their room, so the recent-first scan stays short.
 */
export async function activeRankedGame(
  ctx: DbCtx,
  accountId: Id<"accounts">,
): Promise<{ room: Doc<"rooms">; seat: Doc<"players"> } | null> {
  const seats = await ctx.db
    .query("players")
    .withIndex("by_account", (q) => q.eq("accountId", accountId))
    .order("desc")
    .take(20);
  for (const seat of seats) {
    if (!seatStillInPlay(seat)) continue;
    const room = await ctx.db.get(seat.roomId);
    if (room?.ranked && room.status === "playing") return { room, seat };
  }
  return null;
}

/** The client view of a ticket; a matched ticket whose game is over reads as idle. */
export async function ticketStatus(
  ctx: DbCtx,
  ticket: Doc<"matchQueue"> | null,
): Promise<QueueStatus> {
  if (!ticket) return IDLE;
  if (ticket.status === "waiting") {
    return { status: "waiting", queue: ticket.queue, joinedAt: ticket.joinedAt };
  }
  if (!ticket.roomId) return IDLE;
  const live = await liveRankedSeat(ctx, ticket.roomId, ticket.accountId);
  if (!live) return IDLE;
  return {
    status: "matched",
    queue: ticket.queue,
    roomId: live.room._id,
    code: live.room.code,
    color: live.seat.color,
  };
}

/**
 * Group the oldest waiting tickets of `queue` into ranked rooms. Every ticket
 * read here is part of this transaction, so two concurrent runs (or a run
 * racing leaveQueue) conflict and retry instead of matching a ticket twice.
 */
export async function runMatchmaker(
  ctx: MutationCtx,
  queue: QueueName,
  now: number,
): Promise<{ rooms: number; more: boolean }> {
  const config = QUEUES[queue];
  const waiting = await ctx.db
    .query("matchQueue")
    .withIndex("by_queue_status_joinedAt", (q) => q.eq("queue", queue).eq("status", "waiting"))
    .take(MATCH_BATCH);
  const groups = formGroups(waiting, config.size, now);

  for (const group of groups) {
    const seats = assignSeats(queue, group).sort(
      (a, b) => COLORS.indexOf(a.color) - COLORS.indexOf(b.color),
    );
    const { roomId, code } = await createStartedRoom(ctx, {
      kind: "ranked",
      mode: config.mode,
      queue,
      seats: seats.map((s) => ({
        clientId: s.ticket.clientId,
        name: s.ticket.displayName,
        color: s.color,
        accountId: s.ticket.accountId,
        ...(s.team ? { team: s.team } : {}),
      })),
      lastEvent: `Ranked ${config.label} started`,
      now,
    });
    for (const s of seats) {
      await ctx.db.patch(s.ticket._id, { status: "matched", roomId, color: s.color });
    }
    logEvent("match_made", { roomCode: code, queue, players: seats.length });
  }
  return { rooms: groups.length, more: groups.length >= MAX_GROUPS_PER_RUN };
}

/**
 * Drop waiting tickets whose tab stopped pinging, and matched tickets whose
 * game is over. Matched tickets for live games are pushed back a minute so
 * they do not crowd the batch on every tick.
 */
export async function purgeQueueTickets(
  ctx: MutationCtx,
  now: number,
  batch: number,
): Promise<{ stale: number; finished: number }> {
  const stale = await ctx.db
    .query("matchQueue")
    .withIndex("by_status_lastPing", (q) =>
      q.eq("status", "waiting").lt("lastPingAt", now - STALE_TICKET_MS),
    )
    .take(batch);
  for (const t of stale) await ctx.db.delete(t._id);

  const matched = await ctx.db
    .query("matchQueue")
    .withIndex("by_status_lastPing", (q) =>
      q.eq("status", "matched").lt("lastPingAt", now - MATCHED_TICKET_RECHECK_MS),
    )
    .take(batch);
  let finished = 0;
  for (const t of matched) {
    if ((await ticketStatus(ctx, t)).status === "matched") {
      await ctx.db.patch(t._id, { lastPingAt: now });
    } else {
      await ctx.db.delete(t._id);
      finished++;
    }
  }
  return { stale: stale.length, finished };
}
