import { MutationCtx, QueryCtx } from "../_generated/server";
import { Doc, Id } from "../_generated/dataModel";
import { GameError, fail } from "./errors";

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
