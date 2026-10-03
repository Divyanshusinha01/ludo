import { query } from "./_generated/server";
import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { optionalAccount } from "./lib/auth";
import { colorValidator } from "./lib/colors";
import { finishReasonValidator } from "./lib/game/eventValidators";
import { queueValidator } from "./lib/matchmaking";

export const LEADERBOARD_DEFAULT = 20;
export const LEADERBOARD_MAX = 50;
/** Bounds the leaderboard scan when many top profiles have no rated games yet. */
const LEADERBOARD_SCAN = 500;

const teamValidator = v.union(v.literal("A"), v.literal("B"));

const historyEntryValidator = v.object({
  matchId: v.id("matches"),
  queue: queueValidator,
  rated: v.boolean(),
  finishedAt: v.number(),
  color: colorValidator,
  team: v.optional(teamValidator),
  placement: v.number(),
  won: v.boolean(),
  ratingBefore: v.number(),
  ratingAfter: v.number(),
  delta: v.number(),
});

const participantValidator = v.object({
  username: v.string(),
  displayName: v.string(),
  color: colorValidator,
  team: v.optional(teamValidator),
  placement: v.number(),
  won: v.boolean(),
  ratingBefore: v.number(),
  ratingAfter: v.number(),
  delta: v.number(),
});

const matchDetailValidator = v.object({
  matchId: v.id("matches"),
  queue: queueValidator,
  mode: v.union(v.literal("1v1"), v.literal("2v2")),
  rated: v.boolean(),
  endReason: v.union(finishReasonValidator, v.null()),
  startedAt: v.number(),
  finishedAt: v.number(),
  participants: v.array(participantValidator),
});

const leaderboardEntryValidator = v.object({
  rank: v.number(),
  username: v.string(),
  displayName: v.string(),
  rating: v.number(),
  ratedGames: v.number(),
  wins: v.number(),
});

function toHistoryEntry(p: Doc<"matchParticipants">) {
  return {
    matchId: p.matchId,
    queue: p.queue,
    rated: p.rated,
    finishedAt: p.finishedAt,
    color: p.color,
    ...(p.team ? { team: p.team } : {}),
    placement: p.placement,
    won: p.won,
    ratingBefore: p.ratingBefore,
    ratingAfter: p.ratingAfter,
    delta: p.delta,
  };
}

function toParticipant(p: Doc<"matchParticipants">) {
  return {
    username: p.username,
    displayName: p.displayName,
    color: p.color,
    ...(p.team ? { team: p.team } : {}),
    placement: p.placement,
    won: p.won,
    ratingBefore: p.ratingBefore,
    ratingAfter: p.ratingAfter,
    delta: p.delta,
  };
}

async function matchDetail(ctx: QueryCtx, match: Doc<"matches">) {
  const participants = await ctx.db
    .query("matchParticipants")
    .withIndex("by_match", (q) => q.eq("matchId", match._id))
    .collect();
  participants.sort((a, b) => a.placement - b.placement);
  return {
    matchId: match._id,
    queue: match.queue,
    mode: match.mode,
    rated: match.rated,
    endReason: match.endReason,
    startedAt: match.startedAt,
    finishedAt: match.finishedAt,
    participants: participants.map(toParticipant),
  };
}

/** The caller's ranked games, newest first. Anonymous callers get an empty page. */
export const listMine = query({
  args: { paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(historyEntryValidator),
  handler: async (ctx, args) => {
    const signedIn = await optionalAccount(ctx);
    if (!signedIn) return { page: [], isDone: true, continueCursor: "" };
    const result = await ctx.db
      .query("matchParticipants")
      .withIndex("by_account_finishedAt", (q) => q.eq("accountId", signedIn.account._id))
      .order("desc")
      .paginate(args.paginationOpts);
    return {
      page: result.page.map(toHistoryEntry),
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});

export const getMatch = query({
  args: { matchId: v.string() },
  returns: v.union(matchDetailValidator, v.null()),
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("matches", args.matchId);
    if (!id) return null;
    const match = await ctx.db.get(id);
    return match ? await matchDetail(ctx, match) : null;
  },
});

/** Result of a settled ranked room (for the post-game banner); null until settled. */
export const getRoomResult = query({
  args: { roomId: v.id("rooms") },
  returns: v.union(matchDetailValidator, v.null()),
  handler: async (ctx, args) => {
    const match = await ctx.db
      .query("matches")
      .withIndex("by_room", (q) => q.eq("roomId", args.roomId))
      .first();
    return match ? await matchDetail(ctx, match) : null;
  },
});

/** Top profiles by rating among accounts that have played at least one rated game. */
export const leaderboard = query({
  args: { limit: v.optional(v.number()) },
  returns: v.array(leaderboardEntryValidator),
  handler: async (ctx, args) => {
    const raw = Math.floor(args.limit ?? LEADERBOARD_DEFAULT);
    const limit = Math.min(LEADERBOARD_MAX, Math.max(1, Number.isFinite(raw) ? raw : LEADERBOARD_DEFAULT));
    const out: Array<typeof leaderboardEntryValidator.type> = [];
    let scanned = 0;
    for await (const p of ctx.db.query("profiles").withIndex("by_rating").order("desc")) {
      if (++scanned > LEADERBOARD_SCAN || out.length >= limit) break;
      if (p.ratedGames === 0) continue;
      out.push({
        rank: out.length + 1,
        username: p.username,
        displayName: p.displayName,
        rating: p.rating,
        ratedGames: p.ratedGames,
        wins: p.wins,
      });
    }
    return out;
  },
});
