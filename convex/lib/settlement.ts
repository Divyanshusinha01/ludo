import type { MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { teamOfColor, type Color } from "./ludo";
import { logEvent } from "./log";
import type { QueueName } from "./matchmaking";
import { computeRatingChanges, type RatingInput } from "./rating";
import type { LudoEvent } from "./game";
import type { GameState } from "./game/state";

export type FinishReason = Extract<LudoEvent, { eventType: "GAME_FINISHED" }>["payload"]["reason"];

/** Reasons that end a game without a real result; the ranked game is closed with no rating change. */
const VOID_REASONS: ReadonlySet<FinishReason> = new Set<FinishReason>(["abandoned"]);

export type SettlementResult =
  | { status: "skipped" }
  | { status: "void" }
  | {
      status: "rated";
      changes: Array<{
        accountId: Id<"accounts">;
        color: Color;
        placement: number;
        won: boolean;
        ratingBefore: number;
        ratingAfter: number;
        delta: number;
      }>;
    };

/**
 * Apply rating changes for a ranked room that just finished. Runs inside the
 * finishing commit's transaction and reads only the final GameState and the
 * seats, never the event log. `rooms.ratingSettledAt` makes it idempotent:
 * a second call for the same room is a no-op.
 */
export async function settleRankedRoom(
  ctx: MutationCtx,
  roomId: Id<"rooms">,
  state: GameState,
  reason: FinishReason | null,
  now: number,
): Promise<SettlementResult> {
  const room = await ctx.db.get(roomId);
  if (!room || !room.ranked || room.ratingSettledAt !== undefined) {
    return { status: "skipped" };
  }
  if (state.phase !== "finished") return { status: "skipped" };

  const seats = await ctx.db
    .query("players")
    .withIndex("by_room", (q) => q.eq("roomId", roomId))
    .collect();
  const rated: Array<{ seat: Doc<"players">; profile: Doc<"profiles">; placement: number; won: boolean }> = [];
  const isTeamGame = state.mode === "2v2";
  for (const seat of seats) {
    if (!seat.accountId || seat.isBot) continue;
    const profile = await ctx.db
      .query("profiles")
      .withIndex("by_account", (q) => q.eq("accountId", seat.accountId!))
      .unique();
    if (!profile) continue;
    const color = seat.color as Color;
    const index = state.rankings.indexOf(color);
    const placement = index >= 0 ? index + 1 : state.seats.length;
    const won = isTeamGame
      ? state.winningTeam !== null && (seat.team ?? teamOfColor(color)) === state.winningTeam
      : placement === 1;
    rated.push({ seat, profile, placement, won });
  }

  const voided =
    (reason !== null && VOID_REASONS.has(reason)) ||
    rated.length < 2 ||
    (isTeamGame && state.winningTeam === null);
  if (voided) {
    await recordMatch(ctx, room, state, reason, now, false, rated.map((entry) => ({
      ...entry,
      ratingBefore: entry.profile.rating,
      ratingAfter: entry.profile.rating,
      delta: 0,
    })));
    await ctx.db.patch(roomId, { ratingSettledAt: now });
    logEvent("rating_void", { roomCode: room.code, reason: reason ?? "unknown" });
    return { status: "void" };
  }

  const inputs: RatingInput<Id<"accounts">>[] = rated.map(({ seat, profile, placement, won }) => ({
    key: profile.accountId,
    rating: profile.rating,
    ratedGames: profile.ratedGames,
    placement: isTeamGame ? (won ? 1 : 2) : placement,
    ...(isTeamGame ? { team: seat.team ?? teamOfColor(seat.color as Color) } : {}),
  }));
  const changes = computeRatingChanges(inputs);

  await recordMatch(ctx, room, state, reason, now, true, changes.map((change) => ({
    ...rated.find((r) => r.profile.accountId === change.key)!,
    ratingBefore: change.ratingBefore,
    ratingAfter: change.ratingAfter,
    delta: change.delta,
  })));

  const out: Extract<SettlementResult, { status: "rated" }>["changes"] = [];
  for (const change of changes) {
    const entry = rated.find((r) => r.profile.accountId === change.key)!;
    const { profile } = entry;
    await ctx.db.patch(profile._id, {
      rating: change.ratingAfter,
      peakRating: Math.max(profile.peakRating, change.ratingAfter),
      ratedGames: profile.ratedGames + 1,
      gamesPlayed: profile.gamesPlayed + 1,
      wins: profile.wins + (entry.won ? 1 : 0),
      lastActiveAt: now,
    });
    out.push({
      accountId: change.key,
      color: entry.seat.color as Color,
      placement: entry.placement,
      won: entry.won,
      ratingBefore: change.ratingBefore,
      ratingAfter: change.ratingAfter,
      delta: change.delta,
    });
  }
  await ctx.db.patch(roomId, { ratingSettledAt: now });
  logEvent("rating_settled", {
    roomCode: room.code,
    queue: room.queue ?? null,
    deltas: out.map((c) => c.delta).join(","),
  });
  return { status: "rated", changes: out };
}

type ParticipantRow = {
  seat: Doc<"players">;
  profile: Doc<"profiles">;
  placement: number;
  won: boolean;
  ratingBefore: number;
  ratingAfter: number;
  delta: number;
};

function queueOf(room: Doc<"rooms">, state: GameState): QueueName {
  if (room.queue) return room.queue;
  if (state.mode === "2v2") return "team2v2";
  return state.seats.length === 2 ? "duel" : "ffa4";
}

/**
 * Write the self-contained history snapshot for a settled ranked room.
 * `matches.by_room` keeps it to one row per room even if called twice.
 */
async function recordMatch(
  ctx: MutationCtx,
  room: Doc<"rooms">,
  state: GameState,
  reason: FinishReason | null,
  now: number,
  rated: boolean,
  rows: ParticipantRow[],
): Promise<void> {
  if (rows.length === 0) return;
  const existing = await ctx.db
    .query("matches")
    .withIndex("by_room", (q) => q.eq("roomId", room._id))
    .first();
  if (existing) return;

  const queue = queueOf(room, state);
  const matchId = await ctx.db.insert("matches", {
    roomId: room._id,
    roomCode: room.code,
    queue,
    mode: state.mode === "2v2" ? "2v2" : "1v1",
    startedAt: room.createdAt,
    finishedAt: now,
    endReason: reason,
    rated,
    winnerAccountIds: rated ? rows.filter((r) => r.won).map((r) => r.profile.accountId) : [],
  });
  for (const row of rows) {
    const team = row.seat.team ?? (state.mode === "2v2" ? teamOfColor(row.seat.color as Color) : undefined);
    await ctx.db.insert("matchParticipants", {
      matchId,
      accountId: row.profile.accountId,
      username: row.profile.username,
      displayName: row.seat.name || row.profile.displayName,
      color: row.seat.color,
      ...(team ? { team } : {}),
      placement: row.placement,
      won: rated && row.won,
      ratingBefore: row.ratingBefore,
      ratingAfter: row.ratingAfter,
      delta: row.delta,
      queue,
      rated,
      finishedAt: now,
    });
  }
}
