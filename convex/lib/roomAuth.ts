import { MutationCtx, QueryCtx } from "../_generated/server";
import { Doc, Id } from "../_generated/dataModel";
import { GameError, fail } from "./errors";
import { logEvent } from "./log";
import { deleteEventsForRoom } from "./gameStore";
import type { Color } from "./ludo";

type DbCtx = QueryCtx | MutationCtx;

/** Seated player for this room + clientId, or fail. */
export async function requirePlayer(
  ctx: DbCtx,
  roomId: Id<"rooms">,
  clientId: string,
): Promise<Doc<"players">> {
  const player = await ctx.db
    .query("players")
    .withIndex("by_room_client", (q) =>
      q.eq("roomId", roomId).eq("clientId", clientId),
    )
    .unique();
  if (!player) fail(GameError.notInRoom);
  return player;
}

/** Delete all chat messages for a room (rematch / cascade). */
export async function clearChatForRoom(
  ctx: MutationCtx,
  roomId: Id<"rooms">,
): Promise<void> {
  const messages = await ctx.db
    .query("chatMessages")
    .withIndex("by_room", (q) => q.eq("roomId", roomId))
    .collect();
  for (const msg of messages) {
    await ctx.db.delete(msg._id);
  }
}

/** Delete voicePeers row + signals involving this seat color. */
export async function clearVoiceForColor(
  ctx: MutationCtx,
  roomId: Id<"rooms">,
  color: Color,
): Promise<void> {
  const peer = await ctx.db
    .query("voicePeers")
    .withIndex("by_room_color", (q) =>
      q.eq("roomId", roomId).eq("color", color),
    )
    .unique();
  if (peer) await ctx.db.delete(peer._id);

  const signals = await ctx.db
    .query("voiceSignals")
    .withIndex("by_room", (q) => q.eq("roomId", roomId))
    .collect();
  for (const s of signals) {
    if (s.fromColor === color || s.toColor === color) {
      await ctx.db.delete(s._id);
    }
  }
}

/** Delete all voice peers + signals for a room (rematch / cascade). */
export async function clearVoiceForRoom(
  ctx: MutationCtx,
  roomId: Id<"rooms">,
): Promise<void> {
  const peers = await ctx.db
    .query("voicePeers")
    .withIndex("by_room", (q) => q.eq("roomId", roomId))
    .collect();
  for (const p of peers) {
    await ctx.db.delete(p._id);
  }
  const signals = await ctx.db
    .query("voiceSignals")
    .withIndex("by_room", (q) => q.eq("roomId", roomId))
    .collect();
  for (const s of signals) {
    await ctx.db.delete(s._id);
  }
}

/** Delete room graph including append-only game events. */
export async function deleteRoomCascade(
  ctx: MutationCtx,
  roomId: Id<"rooms">,
): Promise<void> {
  const room = await ctx.db.get(roomId);
  await deleteEventsForRoom(ctx, roomId);
  await clearChatForRoom(ctx, roomId);
  await clearVoiceForRoom(ctx, roomId);
  const players = await ctx.db
    .query("players")
    .withIndex("by_room", (q) => q.eq("roomId", roomId))
    .collect();
  for (const p of players) await ctx.db.delete(p._id);

  const tokens = await ctx.db
    .query("tokens")
    .withIndex("by_room", (q) => q.eq("roomId", roomId))
    .collect();
  for (const t of tokens) await ctx.db.delete(t._id);

  for (const status of ["pending", "approved", "denied"] as const) {
    const requests = await ctx.db
      .query("rejoinRequests")
      .withIndex("by_room_status", (q) =>
        q.eq("roomId", roomId).eq("status", status),
      )
      .collect();
    for (const r of requests) await ctx.db.delete(r._id);
  }

  const spectators = await ctx.db
    .query("spectators")
    .withIndex("by_room", (q) => q.eq("roomId", roomId))
    .collect();
  for (const s of spectators) await ctx.db.delete(s._id);

  await ctx.db.delete(roomId);
  if (room) {
    logEvent("room_cleaned", {
      roomCode: room.code,
      status: room.status,
    });
  }
}
