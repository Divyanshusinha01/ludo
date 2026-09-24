import { internalMutation, MutationCtx } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { buildFinalRankings, Color } from "./lib/ludo";

/** Mark away if no heartbeat within this window. */
const STALE_MS = 45_000;
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
          if (sole) {
            const rankings = buildFinalRankings(
              room.rankings ?? [],
              sole.color as Color,
              refreshed.map((p) => ({
                color: p.color as Color,
                finishRank: p.finishRank ?? (p.connected ? null : 999),
              })),
            );
            await ctx.db.patch(sole._id, {
              finishRank: rankings.indexOf(sole.color as Color) + 1,
            });
            await ctx.db.patch(room._id, {
              status: "finished",
              winner: sole.color as Color,
              rankings,
              finishedAt: now,
              diceRolled: false,
              lastEvent: `${sole.name} wins — others left`,
            });
          } else {
            await ctx.db.patch(room._id, {
              status: "finished",
              winner: null,
              finishedAt: now,
              diceRolled: false,
              lastEvent: "Game ended — no players left",
            });
          }
          continue;
        }
      }

      const current = refreshed.find((p) => p.color === room.currentTurn);
      if (!current) continue;
      // Turn clock is authoritative via scheduled handleTurnTimeout.
      // Only mark presence; do not double-skip turns here.
      void current;
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
