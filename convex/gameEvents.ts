import { internalQuery, query } from "./_generated/server";
import { v } from "convex/values";
import { ludoEventValidator } from "./lib/game/eventValidators";
import { createEmptyState, replayWithTrace } from "./lib/game";
import { gameStateDiffSummary, loadGameState } from "./lib/gameStore";
import { requirePlayer } from "./lib/roomAuth";
import type { LudoEvent } from "./lib/game/eventValidators";

/** Drop document metadata and the private session id before returning an event. */
function stripServerFields(row: LudoEvent & { _id: string; _creationTime: number; actorClientId?: string }): LudoEvent {
  const { _id: _id, _creationTime: _ct, actorClientId: _omit, ...rest } = row;
  return rest as LudoEvent;
}

export const listEvents = query({
  args: {
    roomId: v.id("rooms"),
    clientId: v.string(),
    afterSeq: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  returns: v.object({
    events: v.array(ludoEventValidator),
    nextAfterSeq: v.union(v.number(), v.null()),
  }),
  handler: async (ctx, args) => {
    await requirePlayer(ctx, args.roomId, args.clientId);
    const limit = Math.min(args.limit ?? 200, 200);
    const afterSeq = args.afterSeq ?? 0;

    const rows = await ctx.db
      .query("gameEvents")
      .withIndex("by_game_seq", (q) =>
        q.eq("gameId", args.roomId).gt("seq", afterSeq),
      )
      .take(limit + 1);
    const page = rows.slice(0, limit);
    const hasMore = rows.length > limit;
    const events = page.map((row) => stripServerFields(row as LudoEvent & { _id: string; _creationTime: number; actorClientId?: string }));
    const nextAfterSeq = hasMore ? (page[page.length - 1]?.seq ?? null) : null;

    return { events, nextAfterSeq };
  },
});

export const verifyReplay = internalQuery({
  args: { roomId: v.id("rooms") },
  returns: v.object({
    ok: v.boolean(),
    headSeq: v.number(),
    diffs: v.array(v.string()),
  }),
  handler: async (ctx, args) => {
    const room = await ctx.db.get(args.roomId);
    if (!room) {
      return { ok: false, headSeq: 0, diffs: ["room missing"] };
    }
    if (room.eventSeq === undefined) {
      return { ok: false, headSeq: 0, diffs: ["legacy room"] };
    }

    const events = await ctx.db
      .query("gameEvents")
      .withIndex("by_game_seq", (q) => q.eq("gameId", args.roomId))
      .collect();

    const materialized = await loadGameState(ctx, room);
    const trace = replayWithTrace(createEmptyState(), events);
    if (trace.error) {
      const { seq, eventType, reason } = trace.error;
      return {
        ok: false,
        headSeq: room.eventSeq,
        diffs: [`replay failed at seq ${seq} (${eventType}): ${reason}`],
      };
    }
    const replayed = trace.states[trace.states.length - 1]!;

    const diffs = gameStateDiffSummary(materialized, replayed);
    const tailSeq = events.at(-1)?.seq ?? 0;
    if (tailSeq !== room.eventSeq) {
      diffs.unshift(`log ends at seq ${tailSeq} but the room head is ${room.eventSeq}`);
    }
    return {
      ok: diffs.length === 0,
      headSeq: room.eventSeq,
      diffs,
    };
  },
});
