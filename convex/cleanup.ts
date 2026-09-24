import { internalMutation, MutationCtx } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { COLORS, Color, nextColorAmong } from "./lib/ludo";

/** Mark away if no heartbeat within this window. */
const STALE_MS = 45_000;
/** Skip turn when current player has been away this long. */
const AFK_SKIP_MS = 60_000;
const FINISHED_TTL_MS = 6 * 60 * 60 * 1000;
const LOBBY_TTL_MS = 2 * 60 * 60 * 1000;
/** Delete playing rooms with no activity this long. */
const PLAYING_IDLE_MS = 2 * 60 * 60 * 1000;
/** Delete playing rooms where everyone has been disconnected this long. */
const PLAYING_ABANDON_MS = 30 * 60 * 1000;
/** End game when fewer than 2 connected humans for this long. */
const UNDERPOPULATED_MS = 90_000;

export const tick = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();

    // Lobby TTL — createdAt is required, so a range query is exact.
    const expiredLobbies = await ctx.db
      .query("rooms")
      .withIndex("by_status_createdAt", (q) =>
        q.eq("status", "lobby").lt("createdAt", now - LOBBY_TTL_MS),
      )
      .collect();
    for (const room of expiredLobbies) {
      await deleteRoomCascade(ctx, room._id);
    }

    // Finished TTL — prefer finishedAt index; also catch docs missing finishedAt.
    const expiredFinished = await ctx.db
      .query("rooms")
      .withIndex("by_status_finishedAt", (q) =>
        q.eq("status", "finished").lt("finishedAt", now - FINISHED_TTL_MS),
      )
      .collect();
    for (const room of expiredFinished) {
      await deleteRoomCascade(ctx, room._id);
    }

    const finishedRooms = await ctx.db
      .query("rooms")
      .withIndex("by_status", (q) => q.eq("status", "finished"))
      .collect();
    for (const room of finishedRooms) {
      if (room.finishedAt !== undefined) continue;
      if (now - room.createdAt > FINISHED_TTL_MS) {
        await deleteRoomCascade(ctx, room._id);
      }
    }

    // Presence / AFK / idle only matter for active games.
    const playingRooms = await ctx.db
      .query("rooms")
      .withIndex("by_status", (q) => q.eq("status", "playing"))
      .collect();

    for (const room of playingRooms) {
      const activityAge = now - (room.lastActivityAt ?? room.createdAt);

      const players = await ctx.db
        .query("players")
        .withIndex("by_room", (q) => q.eq("roomId", room._id))
        .collect();

      for (const p of players) {
        if (p.connected && now - p.lastSeenAt > STALE_MS) {
          await ctx.db.patch(p._id, { connected: false });
        }
      }

      const refreshed = await ctx.db
        .query("players")
        .withIndex("by_room", (q) => q.eq("roomId", room._id))
        .collect();

      if (activityAge > PLAYING_IDLE_MS) {
        await deleteRoomCascade(ctx, room._id);
        continue;
      }

      const allDisconnected =
        refreshed.length === 0 || refreshed.every((p) => !p.connected);
      if (allDisconnected) {
        const newestSeen = refreshed.reduce(
          (max, p) => Math.max(max, p.lastSeenAt),
          0,
        );
        if (now - newestSeen > PLAYING_ABANDON_MS) {
          await deleteRoomCascade(ctx, room._id);
          continue;
        }
      }

      const connected = refreshed.filter((p) => p.connected);
      if (refreshed.length >= 1 && connected.length < 2) {
        const newestSeen = refreshed.reduce(
          (max, p) => Math.max(max, p.lastSeenAt),
          0,
        );
        if (now - newestSeen > UNDERPOPULATED_MS) {
          const sole = connected[0];
          await ctx.db.patch(room._id, {
            status: "finished",
            winner: sole ? (sole.color as Color) : null,
            finishedAt: now,
            diceRolled: false,
            lastEvent: sole
              ? `${sole.name} wins — others left`
              : "Game ended — no players left",
          });
          continue;
        }
      }

      const current = refreshed.find((p) => p.color === room.currentTurn);
      if (!current) continue;
      if (current.connected) continue;
      if (now - current.lastSeenAt < AFK_SKIP_MS) continue;

      const active = COLORS.filter((c) =>
        refreshed.some((p) => p.color === c),
      ) as Color[];
      if (active.length < 2) continue;

      const next = nextColorAmong(room.currentTurn, active);
      if (next === room.currentTurn) continue;

      await ctx.db.patch(room._id, {
        currentTurn: next,
        diceRolled: false,
        diceValue: null,
        consecutiveSixes: 0,
        lastEvent: `${current.color} away — turn skipped`,
      });
    }
  },
});

async function deleteRoomCascade(ctx: MutationCtx, roomId: Id<"rooms">) {
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

  await ctx.db.delete(roomId);
}
