import { internalQuery, query } from "./_generated/server";
import { v } from "convex/values";
import { ludoEventValidator } from "./lib/game/eventValidators";
import { createEmptyState, replayGame } from "./lib/game";
import { gameStateDiffSummary, loadGameState } from "./lib/gameStore";
import { requirePlayer } from "./lib/roomAuth";
import type { LudoEvent } from "./lib/game/eventValidators";

function stripServerFields(row: LudoEvent & { _id: string; _creationTime: number; actorClientId?: string }): LudoEvent {
  const { actorClientId: _omit, ...rest } = row;
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
      .withIndex("by_game_seq", (q) => q.eq("gameId", args.roomId))
      .collect();
    const filtered = rows
      .filter((r) => r.seq > afterSeq)
      .sort((a, b) => a.seq - b.seq);
    const page = filtered.slice(0, limit);
    const hasMore = filtered.length > limit;
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
    let replayed;
    try {
      replayed = replayGame(createEmptyState(), events).state;
    } catch (e) {
      return {
        ok: false,
        headSeq: room.eventSeq,
        diffs: [e instanceof Error ? e.message : "replay failed"],
      };
    }

    const diffs = gameStateDiffSummary(materialized, replayed);
    return {
      ok: diffs.length === 0,
      headSeq: room.eventSeq,
      diffs,
    };
  },
});
