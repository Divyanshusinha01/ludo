import { internalMutation, mutation, query, type MutationCtx } from "./_generated/server";
import { armJob } from "./lib/jobs";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { optionalAccount } from "./lib/auth";
import { GameError, fail } from "./lib/errors";
import { logEvent } from "./lib/log";
import { assertValidClientId } from "./lib/session";
import {
  MATCHMAKE_POLL_MS,
  QUEUE_NAMES,
  QUEUE_PING_MIN_INTERVAL_MS,
  queueValidator,
  type QueueName,
} from "./lib/matchmaking";
import {
  purgeQueueTickets,
  activeRankedGame,
  IDLE,
  queueStatusValidator,
  runMatchmaker,
  ticketForAccount,
  ticketStatus,
} from "./lib/matchQueue";

/**
 * Idempotent: a second join returns the same ticket (switching queue if asked),
 * a matched ticket returns its room, and an account still playing a ranked
 * game gets that game back instead of a new ticket.
 */
export const joinQueue = mutation({
  args: { clientId: v.string(), queue: queueValidator },
  returns: queueStatusValidator,
  handler: async (ctx, args) => {
    const now = Date.now();
    const signedIn = await optionalAccount(ctx, now);
    if (!signedIn) fail(GameError.signInToQueue);
    const clientId = assertValidClientId(args.clientId);
    const accountId = signedIn.account._id;

    let ticket = await ticketForAccount(ctx, accountId);
    if (ticket?.status === "matched") {
      const current = await ticketStatus(ctx, ticket);
      if (current.status === "matched") return current;
      await ctx.db.delete(ticket._id);
      ticket = null;
    }

    const active = await activeRankedGame(ctx, accountId);
    if (active) {
      if (ticket) await ctx.db.delete(ticket._id);
      return { status: "inGame" as const, roomId: active.room._id, code: active.room.code };
    }

    if (ticket) {
      const switching = ticket.queue !== args.queue;
      await ctx.db.patch(ticket._id, {
        clientId,
        displayName: signedIn.profile.displayName,
        rating: signedIn.profile.rating,
        lastPingAt: now,
        ...(switching ? { queue: args.queue, joinedAt: now } : {}),
      });
      if (switching) {
        await ctx.scheduler.runAfter(0, internal.matchmaking.matchmake, { queue: args.queue });
      }
      return {
        status: "waiting" as const,
        queue: args.queue,
        joinedAt: switching ? now : ticket.joinedAt,
      };
    }

    await ctx.db.insert("matchQueue", {
      accountId,
      clientId,
      displayName: signedIn.profile.displayName,
      queue: args.queue,
      rating: signedIn.profile.rating,
      status: "waiting",
      joinedAt: now,
      lastPingAt: now,
    });
    await ctx.scheduler.runAfter(0, internal.matchmaking.matchmake, { queue: args.queue });
    logEvent("queue_joined", { queue: args.queue, clientId });
    return { status: "waiting" as const, queue: args.queue, joinedAt: now };
  },
});

/**
 * Leaving with no ticket is a no-op. Leaving after the matcher already seated
 * the player returns the match: the seat exists, so the client should go play.
 */
export const leaveQueue = mutation({
  args: {},
  returns: queueStatusValidator,
  handler: async (ctx) => {
    const signedIn = await optionalAccount(ctx, Date.now());
    if (!signedIn) return IDLE;
    const ticket = await ticketForAccount(ctx, signedIn.account._id);
    if (!ticket) return IDLE;
    if (ticket.status === "waiting") {
      await ctx.db.delete(ticket._id);
      return IDLE;
    }
    const current = await ticketStatus(ctx, ticket);
    if (current.status !== "matched") await ctx.db.delete(ticket._id);
    return current;
  },
});

/** Keeps a waiting ticket alive; tickets with no ping for STALE_TICKET_MS are dropped. */
export const queuePing = mutation({
  args: {},
  returns: queueStatusValidator,
  handler: async (ctx) => {
    const now = Date.now();
    const signedIn = await optionalAccount(ctx, now);
    if (!signedIn) return IDLE;
    const ticket = await ticketForAccount(ctx, signedIn.account._id);
    if (ticket?.status === "waiting" && now - ticket.lastPingAt >= QUEUE_PING_MIN_INTERVAL_MS) {
      await ctx.db.patch(ticket._id, { lastPingAt: now });
    }
    // Restarts the poll chain if it died; read-only while one is pending.
    if (ticket?.status === "waiting") await armMatchmaker(ctx, ticket.queue, now);
    return await ticketStatus(ctx, ticket);
  },
});

export const queueStatus = query({
  args: {},
  returns: v.union(queueStatusValidator, v.null()),
  handler: async (ctx) => {
    const signedIn = await optionalAccount(ctx);
    if (!signedIn) return null;
    const ticket = await ticketForAccount(ctx, signedIn.account._id);
    if (ticket) return await ticketStatus(ctx, ticket);
    const active = await activeRankedGame(ctx, signedIn.account._id);
    return active
      ? { status: "inGame" as const, roomId: active.room._id, code: active.room.code }
      : IDLE;
  },
});

/** Scheduled after every join; reschedules itself while full batches keep matching. */
export const matchmake = internalMutation({
  args: { queue: queueValidator },
  returns: v.object({ rooms: v.number() }),
  handler: async (ctx, args) => {
    const now = Date.now();
    const { rooms, more, pending } = await runMatchmaker(ctx, args.queue, now);
    if (more) {
      await ctx.scheduler.runAfter(0, internal.matchmaking.matchmake, { queue: args.queue });
    } else if (pending > 0) {
      await armMatchmaker(ctx, args.queue, now);
    }
    return { rooms };
  },
});

/** Poll this queue again soon; a no-op while a poll is already pending. */
async function armMatchmaker(ctx: MutationCtx, queue: QueueName, now: number): Promise<void> {
  await armJob(
    ctx,
    `matchmake:${queue}`,
    MATCHMAKE_POLL_MS,
    (delay) => ctx.scheduler.runAfter(delay, internal.matchmaking.matchmake, { queue }),
    now,
  );
}

/**
 * Cron safety net (every few minutes): drops dead tickets and restarts the
 * matcher for any queue that still has someone waiting. Idle queues cost one
 * indexed read each and schedule nothing.
 */
export const sweep = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    await purgeQueueTickets(ctx, Date.now(), 200);
    for (const queue of QUEUE_NAMES) {
      const waiting = await ctx.db
        .query("matchQueue")
        .withIndex("by_queue_status_joinedAt", (q) => q.eq("queue", queue).eq("status", "waiting"))
        .first();
      if (waiting) {
        await ctx.scheduler.runAfter(0, internal.matchmaking.matchmake, { queue });
      }
    }
    return null;
  },
});
