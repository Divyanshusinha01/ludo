import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { colorValidator } from "./schema";
import type { Color } from "./lib/ludo";
import { GameError, fail } from "./lib/errors";
import { clearVoiceForColor, requirePlayer } from "./lib/roomAuth";
import { assertValidClientId } from "./lib/session";

/** Peers with no heartbeat within this window are treated as gone. */
const PEER_STALE_MS = 20_000;

/** Cap SDP / ICE JSON payload size. */
const MAX_SIGNAL_PAYLOAD = 16_000;

const signalTypeValidator = v.union(
  v.literal("offer"),
  v.literal("answer"),
  v.literal("ice"),
);

export const joinVoice = mutation({
  args: {
    roomId: v.id("rooms"),
    clientId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const clientId = assertValidClientId(args.clientId);
    const player = await requirePlayer(ctx, args.roomId, clientId);
    if (player.isBot) fail(GameError.notInRoom);

    const now = Date.now();
    const existing = await ctx.db
      .query("voicePeers")
      .withIndex("by_room_color", (q) =>
        q.eq("roomId", args.roomId).eq("color", player.color),
      )
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, { updatedAt: now });
    } else {
      await ctx.db.insert("voicePeers", {
        roomId: args.roomId,
        color: player.color,
        updatedAt: now,
      });
    }
    return null;
  },
});

export const leaveVoice = mutation({
  args: {
    roomId: v.id("rooms"),
    clientId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const clientId = assertValidClientId(args.clientId);
    const player = await requirePlayer(ctx, args.roomId, clientId);
    if (player.isBot) fail(GameError.notInRoom);

    await clearVoiceForColor(ctx, args.roomId, player.color as Color);
    return null;
  },
});

export const listPeers = query({
  args: {
    roomId: v.id("rooms"),
    clientId: v.string(),
    /** Client clock — avoids Date.now() inside the query. */
    now: v.number(),
  },
  returns: v.array(colorValidator),
  handler: async (ctx, args) => {
    const clientId = assertValidClientId(args.clientId);
    const me = await requirePlayer(ctx, args.roomId, clientId);
    if (me.isBot) fail(GameError.notInRoom);

    const peers = await ctx.db
      .query("voicePeers")
      .withIndex("by_room", (q) => q.eq("roomId", args.roomId))
      .collect();

    const roomPlayers = await ctx.db
      .query("players")
      .withIndex("by_room", (q) => q.eq("roomId", args.roomId))
      .collect();
    const botColors = new Set(
      roomPlayers.filter((p) => p.isBot).map((p) => p.color),
    );

    const cutoff = args.now - PEER_STALE_MS;
    return peers
      .filter(
        (p) =>
          p.color !== me.color &&
          !botColors.has(p.color) &&
          p.updatedAt >= cutoff,
      )
      .map((p) => p.color);
  },
});

export const sendSignal = mutation({
  args: {
    roomId: v.id("rooms"),
    clientId: v.string(),
    toColor: colorValidator,
    type: signalTypeValidator,
    payload: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const clientId = assertValidClientId(args.clientId);
    const player = await requirePlayer(ctx, args.roomId, clientId);
    if (player.isBot) fail(GameError.notInRoom);

    if (args.payload.length === 0 || args.payload.length > MAX_SIGNAL_PAYLOAD) {
      fail(GameError.illegalMove);
    }
    if (args.toColor === player.color) {
      fail(GameError.illegalMove);
    }

    const target = await ctx.db
      .query("players")
      .withIndex("by_room_color", (q) =>
        q.eq("roomId", args.roomId).eq("color", args.toColor),
      )
      .unique();
    if (!target || target.isBot) fail(GameError.notInRoom);

    await ctx.db.insert("voiceSignals", {
      roomId: args.roomId,
      fromColor: player.color,
      toColor: args.toColor,
      type: args.type,
      payload: args.payload,
      createdAt: Date.now(),
    });
    return null;
  },
});

export const listSignals = query({
  args: {
    roomId: v.id("rooms"),
    clientId: v.string(),
  },
  returns: v.array(
    v.object({
      _id: v.id("voiceSignals"),
      fromColor: colorValidator,
      type: signalTypeValidator,
      payload: v.string(),
      createdAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const clientId = assertValidClientId(args.clientId);
    const me = await requirePlayer(ctx, args.roomId, clientId);
    if (me.isBot) fail(GameError.notInRoom);

    const signals = await ctx.db
      .query("voiceSignals")
      .withIndex("by_room_to", (q) =>
        q.eq("roomId", args.roomId).eq("toColor", me.color),
      )
      .collect();

    signals.sort((a, b) => a.createdAt - b.createdAt);

    return signals.map((s) => ({
      _id: s._id,
      fromColor: s.fromColor,
      type: s.type,
      payload: s.payload,
      createdAt: s.createdAt,
    }));
  },
});

export const ackSignals = mutation({
  args: {
    roomId: v.id("rooms"),
    clientId: v.string(),
    ids: v.array(v.id("voiceSignals")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const clientId = assertValidClientId(args.clientId);
    const me = await requirePlayer(ctx, args.roomId, clientId);
    if (me.isBot) fail(GameError.notInRoom);

    // Cap batch size to avoid abuse.
    const ids = args.ids.slice(0, 64);
    for (const id of ids) {
      const signal = await ctx.db.get(id);
      if (!signal) continue;
      if (signal.roomId !== args.roomId || signal.toColor !== me.color) {
        continue;
      }
      await ctx.db.delete(id);
    }
    return null;
  },
});
