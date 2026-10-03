import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { deleteRoomCascade } from "./lib/roomAuth";

/** One-shot: remove rooms created before event sourcing (no eventSeq). */
export const purgeLegacyRooms = internalMutation({
  args: {},
  returns: v.object({ deleted: v.number() }),
  handler: async (ctx) => {
    let deleted = 0;
    const rooms = await ctx.db.query("rooms").collect();
    for (const room of rooms) {
      if (room.eventSeq !== undefined) continue;
      await deleteRoomCascade(ctx, room._id);
      deleted += 1;
    }
    return { deleted };
  },
});
