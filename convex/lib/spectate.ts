import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { GameError, type GameErrorMessage } from "./errors";

/** A watcher with no ping for this long no longer counts and is reaped by cleanup. */
export const SPECTATOR_STALE_MS = 45_000;
/** Client ping cadence; comfortably inside the stale window. */
export const SPECTATOR_PING_MS = 15_000;
/** Pings closer together than this are accepted without a write. */
export const SPECTATOR_PING_MIN_INTERVAL_MS = 5_000;
export const MAX_SPECTATORS_PER_ROOM = 50;
export const LIVE_LIST_DEFAULT = 20;
export const LIVE_LIST_MAX = 50;

type DbCtx = QueryCtx | MutationCtx;

/** Rows for the room, stale ones included until cleanup reaps them (queries can't read the clock). */
export async function spectatorCount(ctx: DbCtx, roomId: Id<"rooms">): Promise<number> {
  const rows = await ctx.db
    .query("spectators")
    .withIndex("by_room", (q) => q.eq("roomId", roomId))
    .take(MAX_SPECTATORS_PER_ROOM * 2);
  return rows.length;
}

/** Why this room can't be watched right now, or null if it can. */
export function spectateBlocker(room: Doc<"rooms">): GameErrorMessage | null {
  if (room.vsComputer) return GameError.notSpectatable;
  if (room.status === "lobby") return GameError.spectateNotStarted;
  return null;
}

/**
 * Insert or refresh this watcher's row. Never touches the room, its players or
 * its event log, so watching cannot change game state or `eventSeq`.
 */
export async function touchSpectator(
  ctx: MutationCtx,
  room: Doc<"rooms">,
  spectatorId: string,
  now: number,
): Promise<GameErrorMessage | null> {
  const blocker = spectateBlocker(room);
  if (blocker) return blocker;

  const seated = await ctx.db
    .query("players")
    .withIndex("by_room_client", (q) => q.eq("roomId", room._id).eq("clientId", spectatorId))
    .unique();
  if (seated) return GameError.spectatorIsPlayer;

  const existing = await ctx.db
    .query("spectators")
    .withIndex("by_room_spectator", (q) => q.eq("roomId", room._id).eq("spectatorId", spectatorId))
    .first();
  if (existing) {
    if (now - existing.lastSeenAt >= SPECTATOR_PING_MIN_INTERVAL_MS) {
      await ctx.db.patch(existing._id, { lastSeenAt: now });
    }
    return null;
  }

  const rows = await ctx.db
    .query("spectators")
    .withIndex("by_room", (q) => q.eq("roomId", room._id))
    .collect();
  const live = rows.filter((r) => now - r.lastSeenAt < SPECTATOR_STALE_MS);
  if (live.length >= MAX_SPECTATORS_PER_ROOM) return GameError.spectatorsFull;

  await ctx.db.insert("spectators", { roomId: room._id, spectatorId, lastSeenAt: now });
  return null;
}

/** Delete watcher rows with no ping inside the stale window. Bounded per call. */
export async function purgeStaleSpectators(
  ctx: MutationCtx,
  now: number,
  batch: number,
): Promise<number> {
  const stale = await ctx.db
    .query("spectators")
    .withIndex("by_lastSeenAt", (q) => q.lt("lastSeenAt", now - SPECTATOR_STALE_MS))
    .take(batch);
  for (const s of stale) await ctx.db.delete(s._id);
  return stale.length;
}
