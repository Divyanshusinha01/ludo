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
import {
  describeEvent,
  eventIdFor,
  LudoEvent,
  LudoEventDraft,
  reduce,
} from "./game";
import type { GameState, GameSeat } from "./game/state";

type DbCtx = QueryCtx | MutationCtx;

export function assertEventSourcedRoom(room: Doc<"rooms">): void {
  if (room.eventSeq === undefined) {
    fail(GameError.legacyRoom);
  }
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
  roomId: Id<"rooms">,
  head: number,
): Promise<void> {
  if (head === 0) return;
  const tail = await ctx.db
    .query("gameEvents")
    .withIndex("by_game_seq", (q) => q.eq("gameId", roomId))
    .order("desc")
    .first();
  if (!tail || tail.seq !== head) {
    fail(GameError.staleAction);
  }
}

async function materializeState(
  ctx: MutationCtx,
  room: Doc<"rooms">,
  state: GameState,
  narratedTexts: string[],
  now: number,
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
  if (state.phase === "playing" && room.status === "lobby") {
    roomPatch.turnStartedAt = now;
  }

  await ctx.db.patch(room._id, roomPatch);
}

export async function commitEvents(
  ctx: MutationCtx,
  room: Doc<"rooms">,
  drafts: LudoEventDraft[],
  opts: CommitOptions,
): Promise<CommitResult> {
  assertEventSourcedRoom(room);
  const freshRoom = await ctx.db.get(room._id);
  if (!freshRoom) fail(GameError.roomNotFound);

  const head = freshRoom.eventSeq ?? 0;
  if (opts.expectedSeq !== undefined && opts.expectedSeq !== head) {
    fail(GameError.staleAction);
  }
  await assertTailMatchesHead(ctx, room._id, head);

  let state = await loadGameState(ctx, freshRoom);
  const narrated: string[] = [];
  let turnBefore = state.turnNumber;
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
  await ctx.db.patch(room._id, { eventSeq: newHead });
  await materializeState(ctx, freshRoom, state, narrated, opts.now);

  const turnChanged = state.turnNumber !== turnBefore;
  if (
    opts.scheduleJobs !== false &&
    state.phase === "playing" &&
    (turnChanged || state.diceRolled)
  ) {
    await ctx.scheduler.runAfter(
      TURN_TIMEOUT_MS,
      internal.game.handleTurnTimeout,
      {
        roomId: room._id,
        turnId: state.turnNumber,
        expectedSeq: newHead,
      } as { roomId: typeof room._id; turnId: number; expectedSeq?: number },
    );
    await ctx.scheduler.runAfter(BOT_THINK_MS, internal.game.playBotTurn, {
      roomId: room._id,
      turnId: state.turnNumber,
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

export function gameStateDiffSummary(
  materialized: GameState,
  replayed: GameState,
): string[] {
  const diffs: string[] = [];
  if (materialized.phase !== replayed.phase) {
    diffs.push(`phase ${materialized.phase} vs ${replayed.phase}`);
  }
  if (materialized.turnNumber !== replayed.turnNumber) {
    diffs.push(`turnNumber ${materialized.turnNumber} vs ${replayed.turnNumber}`);
  }
  if (materialized.diceRolled !== replayed.diceRolled) {
    diffs.push(`diceRolled mismatch`);
  }
  if (materialized.currentTurn !== replayed.currentTurn) {
    diffs.push(`currentTurn mismatch`);
  }
  return diffs;
}
