import { internalMutation, MutationCtx } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { Color } from "./lib/ludo";
import { logEvent } from "./lib/log";
import { ATTEMPT_ROW_TTL_MS } from "./lib/rateLimit";
import { purgeQueueTickets } from "./lib/matchQueue";
import { purgeStaleSpectators } from "./lib/spectate";
import { commitCommand, loadGameState } from "./lib/gameStore";
import { clearChatForRoom, clearVoiceForRoom, deleteRoomCascade } from "./lib/roomAuth";

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
/** Expire unanswered rejoin requests after this long. */
const REJOIN_PENDING_TTL_MS = 3 * 60 * 1000;
/** Drop orphaned WebRTC signals (tab died mid-negotiation). */
const VOICE_SIGNAL_TTL_MS = 3 * 60 * 1000;

/** Bounded per tick; leftovers are picked up next minute. */
const AUTH_PURGE_BATCH = 200;

export const tick = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();

    const expiredSessions = await ctx.db
      .query("authSessions")
      .withIndex("by_expiresAt", (q) => q.lt("expiresAt", now))
      .take(AUTH_PURGE_BATCH);
    for (const s of expiredSessions) await ctx.db.delete(s._id);

    const staleAttempts = await ctx.db
      .query("authAttempts")
      .withIndex("by_windowStart", (q) => q.lt("windowStart", now - ATTEMPT_ROW_TTL_MS))
      .take(AUTH_PURGE_BATCH);
    for (const a of staleAttempts) {
      if (a.lockedUntil !== undefined && a.lockedUntil > now) continue;
      await ctx.db.delete(a._id);
    }

    await purgeQueueTickets(ctx, now, AUTH_PURGE_BATCH);
    await purgeStaleSpectators(ctx, now, AUTH_PURGE_BATCH);

    // Orphaned voice signals (no by_createdAt index — scan is fine; volume is low).
    const voiceSignals = await ctx.db.query("voiceSignals").collect();
    for (const s of voiceSignals) {
      if (now - s.createdAt > VOICE_SIGNAL_TTL_MS) {
        await ctx.db.delete(s._id);
      }
    }

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

    const lobbyRooms = await ctx.db
      .query("rooms")
      .withIndex("by_status", (q) => q.eq("status", "lobby"))
      .collect();

    // Expire pending rejoin requests in live rooms.
    for (const room of [...lobbyRooms, ...playingRooms]) {
      const pending = await ctx.db
        .query("rejoinRequests")
        .withIndex("by_room_status", (q) =>
          q.eq("roomId", room._id).eq("status", "pending"),
        )
        .collect();
      for (const req of pending) {
        if (now - req.createdAt > REJOIN_PENDING_TTL_MS) {
          await ctx.db.patch(req._id, {
            status: "denied",
            resolvedAt: now,
          });
        }
      }
    }

    for (const room of playingRooms) {
      const activityAge = now - (room.lastActivityAt ?? room.createdAt);

      const players = await ctx.db
        .query("players")
        .withIndex("by_room", (q) => q.eq("roomId", room._id))
        .collect();

      for (const p of players) {
        // Bots stay connected; they do not heartbeat.
        if (p.isBot) continue;
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

      const humans = refreshed.filter((p) => !p.isBot);
      const connectedHumans = humans.filter((p) => p.connected);

      // No connected humans — abandon after grace (bots alone must not keep the room).
      if (connectedHumans.length === 0) {
        const newestHumanSeen =
          humans.length > 0
            ? humans.reduce((max, p) => Math.max(max, p.lastSeenAt), 0)
            : refreshed.reduce((max, p) => Math.max(max, p.lastSeenAt), 0);
        if (now - newestHumanSeen > PLAYING_ABANDON_MS) {
          await deleteRoomCascade(ctx, room._id);
          continue;
        }
      }

      // Vs-computer / solo-shaped: skip underpopulated auto-win.
      if (room.vsComputer) {
        continue;
      }

      const connected = refreshed.filter((p) => p.connected && !p.isBot);
      // Only auto-crown when exactly one human is still connected.
      // If everyone is offline, wait for abandon/idle TTL so reconnects can resume.
      if (connected.length === 1 && humans.length >= 2) {
        // Grace runs from the last heartbeat of any other human; the sole
        // connected human is always recent and must not reset it.
        const othersNewestSeen = humans
          .filter((p) => p._id !== connected[0]!._id)
          .reduce((max, p) => Math.max(max, p.lastSeenAt), 0);
        if (now - othersNewestSeen > UNDERPOPULATED_MS) {
          await crownSoleConnected(ctx, room._id, connected[0]!.color as Color, now);
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

/**
 * End an underpopulated match: every other seat still in play forfeits as
 * abandoned, so the reducer crowns the sole connected human.
 */
async function crownSoleConnected(
  ctx: MutationCtx,
  roomId: Id<"rooms">,
  sole: Color,
  now: number,
): Promise<void> {
  for (;;) {
    const room = await ctx.db.get(roomId);
    if (!room || room.status !== "playing" || room.eventSeq === undefined) return;
    const state = await loadGameState(ctx, room);
    const target = state.seats.find(
      (s) => s.color !== sole && !s.eliminated && s.finishRank == null,
    );
    if (!target) return;
    await commitCommand(
      ctx,
      room,
      { type: "ForfeitSeat", color: target.color, reason: "abandoned" },
      { now },
    );
  }
}

