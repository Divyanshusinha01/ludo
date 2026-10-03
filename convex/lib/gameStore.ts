import { MutationCtx, QueryCtx } from "../_generated/server";
import { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import {
  Color,
  GameMode,
  MAX_TIMEOUT_LIVES,
  TURN_TIMEOUT_MS,
} from "./ludo";
import { BOT_THINK_MS } from "./bot";
import { GameError, fail } from "./errors";
import { withEvents } from "./events";
import { logEvent } from "./log";
import { recordUnrankedStats, settleRankedRoom } from "./settlement";
import {
  decide,
  describeEvent,
  diffGameStates,
  eventIdFor,
  LudoEvent,
  LudoEventDraft,
  reduce,
  type GameCommand,
} from "./game";
import type { GameState, GameSeat } from "./game/state";

type DbCtx = QueryCtx | MutationCtx;

export function assertEventSourcedRoom(room: Doc<"rooms">): void {
  if (room.eventSeq === undefined) {
    fail(GameError.legacyRoom);
  }
}

export type StaleReason = "seq_mismatch" | "tail_mismatch" | "turn_mismatch";

/**
 * Reject a call made against an outdated room version. The log line survives
 * the mutation's rollback, so it is the server-side record of the rejection.
 */
export function rejectStale(
  room: Doc<"rooms">,
  reason: StaleReason,
  fields: {
    headSeq: number | undefined;
    expectedSeq?: number;
    tailSeq?: number | null;
    turnId?: number;
    expectedTurnId?: number;
  },
): never {
  logEvent("mutation_rejected", {
    code: "stale",
    reason,
    roomCode: room.code,
    ...fields,
  });
  fail(GameError.staleAction);
}

export async function loadGameState(
  ctx: DbCtx,
  room: Doc<"rooms">,
): Promise<GameState> {
  const players = await ctx.db
    .query("players")
    .withIndex("by_room", (q) => q.eq("roomId", room._id))
    .collect();
  const tokens = await ctx.db
    .query("tokens")
    .withIndex("by_room", (q) => q.eq("roomId", room._id))
    .collect();

  const mode: GameMode = room.mode === "2v2" ? "2v2" : "1v1";
  const phase =
    room.status === "lobby"
      ? "lobby"
      : room.status === "finished"
        ? "finished"
        : "playing";

  const seats: GameSeat[] = players
    .sort((a, b) => a.color.localeCompare(b.color))
    .map((p) => ({
      color: p.color as Color,
      name: p.name,
      isBot: !!p.isBot,
      team: p.team ?? undefined,
      lives: p.lives ?? MAX_TIMEOUT_LIVES,
      eliminated: !!p.eliminated,
      finishRank: p.finishRank ?? null,
    }));

  return {
    phase,
    mode,
    vsComputer: !!room.vsComputer,
    rulesVersion: room.rulesVersion ?? 1,
    seats,
    tokens: tokens.map((t) => ({
      color: t.color as Color,
      index: t.index,
      steps: t.steps,
    })),
    currentTurn: room.currentTurn as Color,
    diceValue: room.diceValue,
    diceRolled: room.diceRolled,
    consecutiveSixes: room.consecutiveSixes,
    sixStreakSnapshot: room.sixStreakSnapshot ?? null,
    passedRollTo: (room.passedRollTo ?? null) as Color | null,
    turnNumber: room.turnId ?? 0,
    rankings: (room.rankings ?? []) as Color[],
    winner: room.winner as Color | null,
    winningTeam: room.winningTeam ?? null,
    settle: null,
    finishedAt: room.finishedAt ?? null,
  };
}

export type CommitOptions = {
  expectedSeq?: number;
  actorClientId?: string;
  now: number;
  scheduleJobs?: boolean;
};

export type CommitResult = {
  state: GameState;
  headSeq: number;
  turnNumber: number;
  events: LudoEvent[];
};

export async function deleteEventsForRoom(
  ctx: MutationCtx,
  roomId: Id<"rooms">,
): Promise<void> {
  const batchSize = 100;
  for (;;) {
    const rows = await ctx.db
      .query("gameEvents")
      .withIndex("by_game_seq", (q) => q.eq("gameId", roomId))
      .take(batchSize);
    if (rows.length === 0) break;
    for (const row of rows) {
      await ctx.db.delete(row._id);
    }
  }
}

async function assertTailMatchesHead(
  ctx: MutationCtx,
  room: Doc<"rooms">,
  head: number,
): Promise<void> {
  if (head === 0) return;
  const tail = await ctx.db
    .query("gameEvents")
    .withIndex("by_game_seq", (q) => q.eq("gameId", room._id))
    .order("desc")
    .first();
  if (!tail || tail.seq !== head) {
    rejectStale(room, "tail_mismatch", { headSeq: head, tailSeq: tail?.seq ?? null });
  }
}

/** Per-seat capture counts from one commit's events. */
type CaptureTally = {
  /** A GAME_STARTED in this commit zeroes the counters before adding. */
  restarted: boolean;
  captured: Map<Color, number>;
  lost: Map<Color, number>;
};

function tallyCaptures(events: LudoEvent[]): CaptureTally {
  const tally: CaptureTally = { restarted: false, captured: new Map(), lost: new Map() };
  for (const event of events) {
    if (event.eventType === "GAME_STARTED") {
      tally.restarted = true;
      tally.captured.clear();
      tally.lost.clear();
    } else if (event.eventType === "TOKEN_CAPTURED") {
      const { byColor, victimColor } = event.payload;
      tally.captured.set(byColor, (tally.captured.get(byColor) ?? 0) + 1);
      tally.lost.set(victimColor, (tally.lost.get(victimColor) ?? 0) + 1);
    }
  }
  return tally;
}

async function materializeState(
  ctx: MutationCtx,
  room: Doc<"rooms">,
  state: GameState,
  narratedTexts: string[],
  now: number,
  turnStartedAt: number | undefined,
  tally: CaptureTally,
): Promise<void> {
  const players = await ctx.db
    .query("players")
    .withIndex("by_room", (q) => q.eq("roomId", room._id))
    .collect();
  const tokens = await ctx.db
    .query("tokens")
    .withIndex("by_room", (q) => q.eq("roomId", room._id))
    .collect();

  for (const seat of state.seats) {
    const doc = players.find((p) => p.color === seat.color);
    if (!doc) continue;
    const patch: Partial<Doc<"players">> = {};
    if ((doc.lives ?? MAX_TIMEOUT_LIVES) !== seat.lives) {
      patch.lives = seat.lives;
    }
    if (!!doc.eliminated !== seat.eliminated) patch.eliminated = seat.eliminated;
    const fr = seat.finishRank ?? undefined;
    if (doc.finishRank !== fr) patch.finishRank = fr;
    const captures = (tally.restarted ? 0 : (doc.captures ?? 0)) + (tally.captured.get(seat.color) ?? 0);
    if ((doc.captures ?? 0) !== captures) patch.captures = captures;
    const tokensLost = (tally.restarted ? 0 : (doc.tokensLost ?? 0)) + (tally.lost.get(seat.color) ?? 0);
    if ((doc.tokensLost ?? 0) !== tokensLost) patch.tokensLost = tokensLost;
    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(doc._id, patch);
    }
  }

  const tokenKeys = new Set(
    state.tokens.map((t) => `${t.color}:${t.index}`),
  );
  for (const doc of tokens) {
    const key = `${doc.color}:${doc.index}`;
    if (!tokenKeys.has(key)) {
      await ctx.db.delete(doc._id);
    }
  }
  for (const tok of state.tokens) {
    const doc = tokens.find(
      (t) => t.color === tok.color && t.index === tok.index,
    );
    if (doc) {
      if (doc.steps !== tok.steps) {
        await ctx.db.patch(doc._id, { steps: tok.steps });
      }
    } else {
      await ctx.db.insert("tokens", {
        roomId: room._id,
        color: tok.color,
        index: tok.index,
        steps: tok.steps,
      });
    }
  }

  const seatedColors = state.seats.map((s) => s.color);
  const status =
    state.phase === "lobby"
      ? "lobby"
      : state.phase === "finished"
        ? "finished"
        : "playing";

  const eventProjection =
    narratedTexts.length > 0
      ? withEvents(room, narratedTexts, now)
      : { lastEvent: room.lastEvent ?? "", events: room.events ?? [] };

  const roomPatch: Partial<Doc<"rooms">> = {
    status,
    currentTurn: state.currentTurn,
    diceValue: state.diceValue,
    diceRolled: state.diceRolled,
    consecutiveSixes: state.consecutiveSixes,
    sixStreakSnapshot: state.sixStreakSnapshot,
    passedRollTo: state.passedRollTo,
    turnId: state.turnNumber,
    rankings: state.rankings,
    winner: state.winner,
    winningTeam: state.winningTeam,
    rulesVersion: state.rulesVersion,
    seatedColors,
    lastActivityAt: now,
    ...eventProjection,
  };

  if (state.phase === "finished" && room.status !== "finished") {
    roomPatch.finishedAt = now;
  }
  if (turnStartedAt !== undefined) {
    roomPatch.turnStartedAt = turnStartedAt;
  }

  await ctx.db.patch(room._id, roomPatch);
}

/**
 * The turn clock restarts whenever someone must act afresh: a new turn, an
 * extra roll (extra turn / six without a move), or a delegated roll. A roll
 * that leaves a move pending keeps the deadline of the turn it belongs to.
 */
function restartsTurnClock(before: GameState, after: GameState): boolean {
  if (after.phase !== "playing") return false;
  const rollsAgain =
    !after.diceRolled &&
    (before.diceRolled || after.consecutiveSixes !== before.consecutiveSixes);
  return (
    before.phase !== "playing" ||
    after.turnNumber !== before.turnNumber ||
    after.passedRollTo !== before.passedRollTo ||
    rollsAgain
  );
}

/**
 * `rooms.eventSeq` is the room's state version: every successful commit moves
 * it strictly forward by the number of events appended, and nothing else
 * writes it after bootstrap.
 */
export async function commitEvents(
  ctx: MutationCtx,
  room: Doc<"rooms">,
  drafts: LudoEventDraft[],
  opts: CommitOptions,
): Promise<CommitResult> {
  assertEventSourcedRoom(room);
  if (drafts.length === 0) {
    throw new Error("commitEvents: refusing an empty commit");
  }
  const freshRoom = await ctx.db.get(room._id);
  if (!freshRoom) fail(GameError.roomNotFound);

  const head = freshRoom.eventSeq ?? 0;
  if (opts.expectedSeq !== undefined && opts.expectedSeq !== head) {
    rejectStale(freshRoom, "seq_mismatch", { headSeq: head, expectedSeq: opts.expectedSeq });
  }
  await assertTailMatchesHead(ctx, freshRoom, head);

  const before = await loadGameState(ctx, freshRoom);
  let state = before;
  const narrated: string[] = [];
  const committed: LudoEvent[] = [];

  for (let i = 0; i < drafts.length; i++) {
    const seq = head + i + 1;
    const draft = drafts[i]!;
    const prevState = state;
    const event: LudoEvent = {
      ...draft,
      gameId: room._id,
      seq,
      eventId: eventIdFor(room._id, seq),
      actorClientId: opts.actorClientId ?? draft.actorClientId,
    } as LudoEvent;

    const result = reduce(state, event);
    if (!result.ok) {
      throw result.error;
    }
    state = result.state;
    narrated.push(...describeEvent(prevState, event));

    await ctx.db.insert("gameEvents", event);
    committed.push(event);
  }

  if (state.settle !== null) {
    throw new Error("commitEvents: settle must be cleared");
  }

  const newHead = head + drafts.length;
  if (newHead <= head) {
    throw new Error(`commitEvents: head must advance (head ${head}, new ${newHead})`);
  }
  const clockRestart = restartsTurnClock(before, state);
  const turnStartedAt = clockRestart ? opts.now : (freshRoom.turnStartedAt ?? opts.now);
  await ctx.db.patch(room._id, { eventSeq: newHead });
  await materializeState(
    ctx,
    freshRoom,
    state,
    narrated,
    opts.now,
    clockRestart ? opts.now : undefined,
    tallyCaptures(committed),
  );

  if (before.phase === "playing" && state.phase === "finished") {
    const finished = committed.find((e) => e.eventType === "GAME_FINISHED");
    const reason = finished?.eventType === "GAME_FINISHED" ? finished.payload.reason : null;
    if (freshRoom.ranked) {
      await settleRankedRoom(ctx, room._id, state, reason, opts.now);
    } else {
      await recordUnrankedStats(ctx, room._id, state, reason, opts.now);
    }
  }

  // Every in-play commit re-arms both jobs at the new head; jobs armed at an
  // older head see a different eventSeq and do nothing.
  if (opts.scheduleJobs !== false && state.phase === "playing") {
    await ctx.scheduler.runAt(
      turnStartedAt + TURN_TIMEOUT_MS,
      internal.game.handleTurnTimeout,
      { roomId: room._id, turnId: state.turnNumber, expectedSeq: newHead },
    );
    await ctx.scheduler.runAfter(BOT_THINK_MS, internal.game.playBotTurn, {
      roomId: room._id,
      turnId: state.turnNumber,
      expectedSeq: newHead,
    });
  }

  return {
    state,
    headSeq: newHead,
    turnNumber: state.turnNumber,
    events: committed,
  };
}

/** Lobby / lifecycle commits when room has no eventSeq yet (creates head at 0). */
export async function commitEventsBootstrap(
  ctx: MutationCtx,
  roomId: Id<"rooms">,
  drafts: LudoEventDraft[],
  opts: Omit<CommitOptions, "expectedSeq"> & { initialEventSeq?: number },
): Promise<CommitResult> {
  let room = await ctx.db.get(roomId);
  if (!room) fail(GameError.roomNotFound);
  if (room.eventSeq === undefined) {
    await ctx.db.patch(roomId, {
      eventSeq: opts.initialEventSeq ?? 0,
      rulesVersion: room.rulesVersion ?? 1,
    });
    room = (await ctx.db.get(roomId))!;
  }
  return commitEvents(ctx, room, drafts, opts);
}

/** Decide `command` against the current projection and commit the result. */
export async function commitCommand(
  ctx: MutationCtx,
  room: Doc<"rooms">,
  command: GameCommand,
  opts: CommitOptions,
): Promise<CommitResult> {
  assertEventSourcedRoom(room);
  const fresh = await ctx.db.get(room._id);
  if (!fresh) fail(GameError.roomNotFound);
  const state = await loadGameState(ctx, fresh);
  const decision = decide(state, command, { gameId: room._id, createdAt: opts.now });
  if (!decision.ok) {
    throw new Error(`${command.type} rejected: ${decision.error.message}`);
  }
  return await commitEvents(ctx, fresh, decision.events, opts);
}

/** Every field where the materialized projection and the replay disagree. */
export function gameStateDiffSummary(
  materialized: GameState,
  replayed: GameState,
): string[] {
  return diffGameStates(materialized, replayed);
}
