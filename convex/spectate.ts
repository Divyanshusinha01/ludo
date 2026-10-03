import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { COLORS } from "./lib/ludo";
import { colorValidator } from "./lib/colors";
import { fail, GameError } from "./lib/errors";
import { queueValidator } from "./lib/matchmaking";
import { assertValidClientId, assertValidRoomCode } from "./lib/session";
import {
  LIVE_LIST_DEFAULT,
  LIVE_LIST_MAX,
  spectatorCount,
  touchSpectator,
} from "./lib/spectate";
import { loadRoomBundle, roomBundleObjectValidator } from "./rooms";

/** Bounds the scan of playing rooms when most of them are unranked. */
const LIVE_SCAN = 200;

const liveGameValidator = v.object({
  code: v.string(),
  queue: v.union(queueValidator, v.null()),
  mode: v.union(v.literal("1v1"), v.literal("2v2")),
  startedAt: v.number(),
  spectators: v.number(),
  players: v.array(
    v.object({
      name: v.string(),
      color: colorValidator,
      team: v.union(v.literal("A"), v.literal("B"), v.null()),
      rating: v.union(v.number(), v.null()),
      connected: v.boolean(),
    }),
  ),
});

/** Ranked games in progress, newest first. Private code rooms and vs-computer games are never listed. */
export const listLive = query({
  args: { limit: v.optional(v.number()) },
  returns: v.array(liveGameValidator),
  handler: async (ctx, args) => {
    const raw = Math.floor(args.limit ?? LIVE_LIST_DEFAULT);
    const limit = Math.min(LIVE_LIST_MAX, Math.max(1, Number.isFinite(raw) ? raw : LIVE_LIST_DEFAULT));
    const out: Array<typeof liveGameValidator.type> = [];
    let scanned = 0;
    for await (const room of ctx.db
      .query("rooms")
      .withIndex("by_status_createdAt", (q) => q.eq("status", "playing"))
      .order("desc")) {
      if (++scanned > LIVE_SCAN || out.length >= limit) break;
      if (!room.ranked || room.vsComputer) continue;
      const seats = await ctx.db
        .query("players")
        .withIndex("by_room", (q) => q.eq("roomId", room._id))
        .collect();
      seats.sort((a, b) => COLORS.indexOf(a.color) - COLORS.indexOf(b.color));
      const players = [];
      for (const seat of seats) {
        const profile = seat.accountId
          ? await ctx.db
              .query("profiles")
              .withIndex("by_account", (q) => q.eq("accountId", seat.accountId!))
              .unique()
          : null;
        players.push({
          name: seat.name,
          color: seat.color,
          team: seat.team ?? null,
          rating: profile?.rating ?? null,
          connected: seat.connected,
        });
      }
      out.push({
        code: room.code,
        queue: room.queue ?? null,
        mode: room.mode === "2v2" ? ("2v2" as const) : ("1v1" as const),
        startedAt: room.createdAt,
        spectators: await spectatorCount(ctx, room._id),
        players,
      });
    }
    return out;
  },
});

/**
 * Read-only view of a room by code: the same public bundle players get, built
 * with no session, so it carries no `me`, no `isMe` and no client ids.
 */
export const getSpectatorRoom = query({
  args: { code: v.string() },
  returns: v.union(
    v.object({ view: roomBundleObjectValidator, spectators: v.number() }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    let code: string;
    try {
      code = assertValidRoomCode(args.code);
    } catch {
      return null;
    }
    const room = await ctx.db
      .query("rooms")
      .withIndex("by_code", (q) => q.eq("code", code))
      .unique();
    if (!room || room.vsComputer) return null;
    return {
      view: await loadRoomBundle(ctx, room, null),
      spectators: await spectatorCount(ctx, room._id),
    };
  },
});

/** Start (or resume) watching. Idempotent per room + spectatorId. */
export const joinSpectate = mutation({
  args: { roomId: v.id("rooms"), spectatorId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const spectatorId = assertValidClientId(args.spectatorId);
    const room = await ctx.db.get(args.roomId);
    if (!room) fail(GameError.roomNotFound);
    const blocked = await touchSpectator(ctx, room, spectatorId, Date.now());
    if (blocked) fail(blocked);
    return null;
  },
});

/**
 * Keep-alive. Re-creates a reaped row (tab slept, socket reconnected).
 * Never throws for a room that ended or vanished; returns whether the caller is watching.
 */
export const spectatorPing = mutation({
  args: { roomId: v.id("rooms"), spectatorId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    let spectatorId: string;
    try {
      spectatorId = assertValidClientId(args.spectatorId);
    } catch {
      return false;
    }
    const room = await ctx.db.get(args.roomId);
    if (!room) return false;
    return (await touchSpectator(ctx, room, spectatorId, Date.now())) === null;
  },
});

/** Stop watching. Leaving when not watching is a no-op. */
export const leaveSpectate = mutation({
  args: { roomId: v.id("rooms"), spectatorId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    let spectatorId: string;
    try {
      spectatorId = assertValidClientId(args.spectatorId);
    } catch {
      return null;
    }
    const rows = await ctx.db
      .query("spectators")
      .withIndex("by_room_spectator", (q) => q.eq("roomId", args.roomId).eq("spectatorId", spectatorId))
      .collect();
    for (const r of rows) await ctx.db.delete(r._id);
    return null;
  },
});
