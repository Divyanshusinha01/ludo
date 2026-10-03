import {
  internalMutation,
  mutation,
  query,
  MutationCtx,
  QueryCtx,
} from "./_generated/server";
import { v } from "convex/values";
import { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import {
  allTokensInYard,
  buildFinalRankings,
  Color,
  decideRollOutcome,
  findCaptureTargets,
  FINISHED_STEPS,
  gainsExtraTurn,
  getLegalMovesForActor,
  hasWon,
  legalMovesForDelegatedRoll,
  MAX_TIMEOUT_LIVES,
  moveControllerColor,
  nextColorAmong,
  nextTurnSeatColor,
  rollControllerColor,
  rollFairDice,
  rotationColors,
  shouldAssignAutomaticLoser,
  snapshotTokens,
  GameMode,
  shouldKeepRollForTeammatePass,
  shouldTransferRollToTeammate,
  startsSixStreak,
  TokenMoveChoice,
  TokenSnapshot,
  TokenState,
  tryMoveSteps,
  turnActorColor,
  teamTeammateColor,
  TURN_TIMEOUT_MS,
} from "./lib/ludo";
import { colorValidator } from "./schema";
import { BOT_THINK_MS, pickBotMove } from "./lib/bot";
import {
  maybeFinishTeamByElimination,
  maybeFinishTeamMatch,
} from "./lib/teams";
import { withEvent, withEvents } from "./lib/events";
import { GameError, fail } from "./lib/errors";
import { logEvent } from "./lib/log";
import {
  ACTION_MIN_INTERVAL_MS,
  assertActionInterval,
  assertValidClientId,
} from "./lib/session";
import { decide } from "./lib/game/decide";
import {
  assertEventSourcedRoom,
  commitEvents,
  loadGameState,
} from "./lib/gameStore";
import { summarizeMove, summarizeRoll } from "./lib/gameSummaries";

async function loadTokens(
  ctx: MutationCtx | QueryCtx,
  roomId: Id<"rooms">,
): Promise<TokenState[]> {
  const tokens = await ctx.db
    .query("tokens")
    .withIndex("by_room", (q) => q.eq("roomId", roomId))
    .collect();
  return tokens.map((t) => ({
    color: t.color as Color,
    index: t.index,
    steps: t.steps,
  }));
}

async function seatedPlayers(ctx: MutationCtx | QueryCtx, roomId: Id<"rooms">) {
  return await ctx.db
    .query("players")
    .withIndex("by_room", (q) => q.eq("roomId", roomId))
    .collect();
}

/**
 * Colours that still take turns: seated, not eliminated, and not yet ranked
 * (finished players keep their seat/tokens visible but leave the rotation).
 */
function playableColors(players: Doc<"players">[]): Color[] {
  return (["red", "green", "yellow", "blue"] as Color[]).filter((c) =>
    players.some(
      (p) =>
        p.color === c && !p.eliminated && p.finishRank == null,
    ),
  );
}

function modeFromRoom(room: Doc<"rooms">): GameMode {
  return room.mode === "2v2" ? "2v2" : "1v1";
}

function advanceTurnColor(
  current: Color,
  players: Doc<"players">[],
  mode: GameMode,
): Color {
  if (mode === "2v2") {
    return nextTurnSeatColor(current, players, mode);
  }
  return nextColorAmong(current, playableColors(players));
}

function turnAnnouncement(
  seat: Color,
  players: Doc<"players">[],
  mode: GameMode,
): string {
  const actor = turnActorColor(seat, players, mode);
  const actorPlayer = players.find((p) => p.color === actor);
  const seatPlayer = players.find((p) => p.color === seat);
  if (mode === "2v2" && seat !== actor && seatPlayer && actorPlayer) {
    return `${actorPlayer.name} playing for ${seatPlayer.name} (${seat}'s turn)`;
  }
  if (actorPlayer) return `${actorPlayer.name}'s turn`;
  return `${seat}'s turn`;
}

/** Restore every token to a prior board snapshot (three-six rollback). */
async function restoreTokenSnapshot(
  ctx: MutationCtx,
  roomId: Id<"rooms">,
  snapshot: TokenSnapshot[],
) {
  const docs = await ctx.db
    .query("tokens")
    .withIndex("by_room", (q) => q.eq("roomId", roomId))
    .collect();
  for (const snap of snapshot) {
    const doc = docs.find(
      (t) => t.color === snap.color && t.index === snap.index,
    );
    if (doc && doc.steps !== snap.steps) {
      await ctx.db.patch(doc._id, { steps: snap.steps });
    }
  }
}

async function scheduleTurnTimeout(
  ctx: MutationCtx,
  roomId: Id<"rooms">,
  turnId: number,
) {
  await ctx.scheduler.runAfter(TURN_TIMEOUT_MS, internal.game.handleTurnTimeout, {
    roomId,
    turnId,
  });
}

async function scheduleBotTurn(
  ctx: MutationCtx,
  roomId: Id<"rooms">,
  turnId: number,
  delayMs: number = BOT_THINK_MS,
) {
  await ctx.scheduler.runAfter(delayMs, internal.game.playBotTurn, {
    roomId,
    turnId,
  });
}

/** If the current seat is a bot, queue its next action. */
async function maybeScheduleBotTurn(
  ctx: MutationCtx,
  roomId: Id<"rooms">,
  turnId: number,
  delayMs: number = BOT_THINK_MS,
) {
  const room = await ctx.db.get(roomId);
  if (!room || room.status !== "playing") return;
  if ((room.turnId ?? 0) !== turnId) return;
  const players = await seatedPlayers(ctx, roomId);
  const mode = modeFromRoom(room);
  const seat = room.currentTurn as Color;
  const passedRollTo = room.passedRollTo ?? null;
  const botColor =
    passedRollTo ??
    (room.diceRolled
      ? moveControllerColor(seat, players, mode, null)
      : rollControllerColor(seat, players, mode, null));
  const current = players.find((p) => p.color === botColor);
  if (!current || !current.isBot || current.eliminated || current.finishRank != null) {
    return;
  }
  await scheduleBotTurn(ctx, roomId, turnId, delayMs);
}

/** Advance to `next` and arm a fresh 60s timeout. */
async function beginTurn(
  ctx: MutationCtx,
  room: Doc<"rooms">,
  next: Color,
  patch: Record<string, unknown>,
) {
  const turnId = (room.turnId ?? 0) + 1;
  const now = Date.now();
  const players = await seatedPlayers(ctx, room._id);
  const mode = modeFromRoom(room);
  const turnText = turnAnnouncement(next, players, mode);

  const prior =
    typeof patch.lastEvent === "string" ? patch.lastEvent : undefined;
  const { lastEvent, events } = withEvents(
    room,
    prior ? [prior, turnText] : [turnText],
    now,
  );

  // `patch` may include diceValue (last face for UI). Drop lastEvent —
  // we replace it with the appended log fields below.
  const restPatch = { ...patch };
  delete restPatch.lastEvent;
  // Turn-control fields below always win over patch.
  await ctx.db.patch(room._id, {
    diceValue: null,
    ...restPatch,
    currentTurn: next,
    diceRolled: false,
    passedRollTo: null,
    consecutiveSixes: 0,
    lastMovedTokenIndex: null,
    sixStreakSnapshot: null,
    turnId,
    turnStartedAt: now,
    lastActivityAt: now,
    lastEvent,
    events,
  });
  await scheduleTurnTimeout(ctx, room._id, turnId);
  await maybeScheduleBotTurn(ctx, room._id, turnId);
}

async function returnTokensToYard(
  ctx: MutationCtx,
  roomId: Id<"rooms">,
  color: Color,
) {
  const tokens = await ctx.db
    .query("tokens")
    .withIndex("by_room_color", (q) => q.eq("roomId", roomId).eq("color", color))
    .collect();
  for (const t of tokens) {
    if (t.steps !== -1) {
      await ctx.db.patch(t._id, { steps: -1 });
    }
  }
}

/**
 * When only one colour is still playing and every other seat was eliminated
 * (not finished by completing home), they win.
 */
async function maybeFinishSoleSurvivor(
  ctx: MutationCtx,
  room: Doc<"rooms">,
  players: Doc<"players">[],
): Promise<boolean> {
  const stillPlaying = players.filter(
    (p) => !p.eliminated && p.finishRank == null,
  );
  if (stillPlaying.length !== 1) return false;

  const others = players.filter((p) => p._id !== stillPlaying[0]!._id);
  if (others.length === 0) return false;
  // Only auto-win when every other seat is eliminated (forfeit / lives).
  if (!others.every((p) => p.eliminated)) return false;

  const sole = stillPlaying[0]!;
  const now = Date.now();
  const rankings = buildFinalRankings(
    room.rankings ?? [],
    sole.color as Color,
    players.map((p) => ({
      color: p.color as Color,
      finishRank: p.finishRank,
    })),
  );

  await ctx.db.patch(sole._id, {
    finishRank: rankings.indexOf(sole.color as Color) + 1,
  });
  await ctx.db.patch(room._id, {
    status: "finished",
    winner: sole.color,
    rankings,
    diceRolled: false,
    sixStreakSnapshot: null,
    finishedAt: now,
    lastActivityAt: now,
    ...withEvent(room, `${sole.name} wins — others eliminated`, now),
  });
  logEvent("game_finished", {
    roomCode: room.code,
    winner: sole.color,
    reason: "sole_survivor",
  });
  return true;
}

/**
 * After N−1 home finishers, the one remaining player can no longer change
 * the ranking — assign them last place (loser) and end the match.
 */
async function maybeFinishAutomaticLoser(
  ctx: MutationCtx,
  room: Doc<"rooms">,
  players: Doc<"players">[],
  now: number,
): Promise<boolean> {
  if (!shouldAssignAutomaticLoser(players)) return false;

  const loser = players.find(
    (p) => !p.eliminated && p.finishRank == null,
  );
  if (!loser) return false;

  const rankings = [...(room.rankings ?? [])];
  if (!rankings.includes(loser.color as Color)) {
    rankings.push(loser.color as Color);
  }
  // Ensure every seated colour appears exactly once (eliminated seats too).
  for (const p of players) {
    if (!rankings.includes(p.color as Color)) {
      rankings.push(p.color as Color);
    }
  }

  const loserRank = rankings.indexOf(loser.color as Color) + 1;
  await ctx.db.patch(loser._id, { finishRank: loserRank });

  const winner = rankings[0] ?? room.winner ?? null;
  await ctx.db.patch(room._id, {
    status: "finished",
    winner,
    rankings,
    diceRolled: false,
    sixStreakSnapshot: null,
    finishedAt: now,
    lastActivityAt: now,
    ...withEvent(
      room,
      `${loser.name} places #${loserRank} — match over`,
      now,
    ),
  });
  logEvent("game_finished", {
    roomCode: room.code,
    winner,
    reason: "automatic_loser",
  });
  return true;
}

/**
 * End the match when every seated player has a final rank (all finished or
 * eliminated). Winner is the first entry in rankings (rank #1).
 */
async function maybeFinishAllRanked(
  ctx: MutationCtx,
  room: Doc<"rooms">,
  players: Doc<"players">[],
  now: number,
): Promise<boolean> {
  if (players.length === 0) return false;
  if (!players.every((p) => p.finishRank != null || p.eliminated)) {
    return false;
  }

  const rankings =
    (room.rankings ?? []).length > 0
      ? [...(room.rankings ?? [])]
      : buildFinalRankings(
          [],
          players[0]!.color as Color,
          players.map((p) => ({
            color: p.color as Color,
            finishRank: p.finishRank,
          })),
        );

  // Ensure every seated colour appears exactly once.
  for (const p of players) {
    if (!rankings.includes(p.color as Color)) {
      rankings.push(p.color as Color);
    }
  }

  const winner = rankings[0] ?? null;
  await ctx.db.patch(room._id, {
    status: "finished",
    winner,
    rankings,
    diceRolled: false,
    sixStreakSnapshot: null,
    finishedAt: now,
    lastActivityAt: now,
    ...withEvent(room, "Match complete — final rankings set", now),
  });
  logEvent("game_finished", {
    roomCode: room.code,
    winner,
    reason: "all_ranked",
  });
  return true;
}

/**
 * Record a home-finish rank. Match may end immediately once N−1 players
 * have finished (remaining seat becomes automatic loser).
 */
async function assignFinishRank(
  ctx: MutationCtx,
  room: Doc<"rooms">,
  player: Doc<"players">,
): Promise<Color[]> {
  if (player.finishRank != null) {
    return [...(room.rankings ?? [])];
  }
  const rankings = [...(room.rankings ?? [])];
  if (rankings.includes(player.color as Color)) {
    // Repair missing finishRank if rankings already list this colour.
    await ctx.db.patch(player._id, {
      finishRank: rankings.indexOf(player.color as Color) + 1,
    });
    return rankings;
  }
  rankings.push(player.color as Color);
  await ctx.db.patch(player._id, { finishRank: rankings.length });
  return rankings;
}

/** Apply timeout life loss / elimination / turn advance. Shared by cron + eager expiry. */
async function applyTurnTimeout(
  ctx: MutationCtx,
  room: Doc<"rooms">,
): Promise<void> {
  const players = await seatedPlayers(ctx, room._id);
  const mode = modeFromRoom(room);
  const seat = room.currentTurn as Color;
  const actorColor = turnActorColor(seat, players, mode);
  const current = players.find((p) => p.color === actorColor);
  if (!current || current.eliminated || current.finishRank != null) return;

  const lives = (current.lives ?? MAX_TIMEOUT_LIVES) - 1;

  logEvent("timeout", {
    roomCode: room.code,
    color: current.color,
    livesLeft: Math.max(0, lives),
    turnId: room.turnId ?? 0,
  });

  if (lives <= 0) {
    const place = playableColors(players).length;
    await ctx.db.patch(current._id, {
      lives: 0,
      eliminated: true,
      finishRank: place,
    });
    await returnTokensToYard(ctx, room._id, current.color as Color);

    const refreshed = await seatedPlayers(ctx, room._id);

    if (room.mode === "2v2") {
      if (await maybeFinishTeamByElimination(ctx, room, refreshed, Date.now())) {
        return;
      }
    } else if (await maybeFinishSoleSurvivor(ctx, room, refreshed)) {
      return;
    }

    const pool =
      mode === "2v2"
        ? rotationColors(refreshed, mode)
        : playableColors(refreshed);
    if (pool.length < 2) return;

    const next = advanceTurnColor(seat, refreshed, mode);
    await beginTurn(ctx, room, next, {
      lastEvent: `${current.name} timed out — eliminated (0 lives)`,
    });
    return;
  }

  await ctx.db.patch(current._id, { lives });
  const next = advanceTurnColor(seat, players, mode);
  await beginTurn(ctx, room, next, {
    lastEvent: `${current.name} timed out — ${lives} ${lives === 1 ? "life" : "lives"} left`,
  });
}

/**
 * Server-authoritative turn clock. If expired, apply timeout and reject the action.
 * Prevents acting in the window after expiry but before the scheduled job runs.
 */
async function commitTurnExpiryIfNeeded(
  ctx: MutationCtx,
  room: Doc<"rooms">,
): Promise<boolean> {
  const started = room.turnStartedAt;
  if (started === undefined) return false;
  if (Date.now() <= started + TURN_TIMEOUT_MS) return false;
  assertEventSourcedRoom(room);
  const state = await loadGameState(ctx, room);
  const now = Date.now();
  const result = decide(
    state,
    { type: "ExpireTurn" },
    { gameId: room._id, createdAt: now },
  );
  if (!result.ok) return false;
  await commitEvents(ctx, room, result.events, {
    expectedSeq: room.eventSeq,
    now,
    actorClientId: undefined,
  });
  return true;
}

async function assertTurnNotExpired(
  ctx: MutationCtx,
  room: Doc<"rooms">,
): Promise<void> {
  if (await commitTurnExpiryIfNeeded(ctx, room)) {
    fail(GameError.turnExpired);
  }
}

function assertFreshTurn(room: Doc<"rooms">, expectedTurnId: number) {
  if ((room.turnId ?? 0) !== expectedTurnId) {
    fail(GameError.staleAction);
  }
}

async function requirePlayerInRoom(
  ctx: MutationCtx,
  roomId: Id<"rooms">,
  clientId: string,
) {
  const player = await ctx.db
    .query("players")
    .withIndex("by_room_client", (q) =>
      q.eq("roomId", roomId).eq("clientId", clientId),
    )
    .unique();

  if (!player) fail(GameError.notInRoom);
  if (player.eliminated || player.finishRank != null) {
    fail(GameError.eliminated);
  }
  return player;
}

async function requireRollPlayer(
  ctx: MutationCtx,
  roomId: Id<"rooms">,
  clientId: string,
  room: Doc<"rooms">,
) {
  const player = await requirePlayerInRoom(ctx, roomId, clientId);
  if ((room.passedRollTo ?? null) != null) {
    fail(GameError.notYourTurn);
  }
  const players = await seatedPlayers(ctx, roomId);
  const mode = modeFromRoom(room);
  const rollColor = rollControllerColor(
    room.currentTurn as Color,
    players,
    mode,
    null,
  );
  if (player.color !== rollColor) fail(GameError.notYourTurn);
  return player;
}

async function requireMovePlayer(
  ctx: MutationCtx,
  roomId: Id<"rooms">,
  clientId: string,
  room: Doc<"rooms">,
) {
  const player = await requirePlayerInRoom(ctx, roomId, clientId);
  const players = await seatedPlayers(ctx, roomId);
  const mode = modeFromRoom(room);
  const moveColor = moveControllerColor(
    room.currentTurn as Color,
    players,
    mode,
    room.passedRollTo ?? null,
  );
  if (player.color !== moveColor) fail(GameError.notYourTurn);
  return player;
}

type MoveResult = {
  won: boolean;
  matchOver?: boolean;
  rank?: number;
  captured: boolean;
  reachedHome: boolean;
  leftYard: boolean;
  fromSteps: number;
  toSteps: number;
  extraTurn?: boolean;
  captures: Array<{ color: string; index: number }>;
};

type RollResult = {
  value: number;
  skipped: boolean;
  legalMoves: number[];
  legalTokenMoves?: TokenMoveChoice[];
  threeSixes?: boolean;
  rollAgain?: boolean;
  /** Server auto-moved the sole legal token after this roll. */
  autoMoved?: boolean;
  autoMove?: MoveResult;
};

/** Shared roll logic for humans and bots. Caller must validate turn ownership. */
async function executeRoll(
  ctx: MutationCtx,
  roomId: Id<"rooms">,
  room: Doc<"rooms">,
  player: Doc<"players">,
  now: number,
  clientIdForLog: string,
): Promise<RollResult> {
  if (room.diceRolled) fail(GameError.diceAlreadyRolled);

  const players = await seatedPlayers(ctx, roomId);
  const mode = modeFromRoom(room);
  const tokens = await loadTokens(ctx, roomId);
  const actorColor = player.color as Color;
  const value = rollFairDice(allTokensInYard(tokens, actorColor));
  const legalTokenMoves = getLegalMovesForActor(
    tokens,
    actorColor,
    players,
    mode,
    value,
  );
  const legalMoves = legalTokenMoves.map((m) => m.index);
  const decision = decideRollOutcome(
    value,
    room.consecutiveSixes,
    legalMoves.length,
  );
  const captureSnapshot = startsSixStreak(value, room.consecutiveSixes);

  logEvent("dice_rolled", {
    roomCode: room.code,
    color: player.color,
    value,
    decision: decision.kind,
    turnId: room.turnId ?? 0,
    clientId: clientIdForLog,
  });

  if (decision.kind === "three_sixes") {
    const snapshot = room.sixStreakSnapshot ?? null;
    if (snapshot && snapshot.length > 0) {
      await restoreTokenSnapshot(ctx, roomId, snapshot);
    }

    const next = advanceTurnColor(room.currentTurn as Color, players, mode);
    const event = snapshot?.length
      ? `${player.name} rolled three 6s — moves undone, turn skipped`
      : `${player.name} rolled three 6s — turn skipped`;

    await beginTurn(ctx, room, next, {
      diceValue: value,
      lastEvent: event,
    });
    return {
      value,
      skipped: true,
      threeSixes: true,
      legalMoves: [] as number[],
      legalTokenMoves: [],
    };
  }

  if (decision.kind === "no_moves_six") {
    await ctx.db.patch(roomId, {
      diceValue: value,
      diceRolled: false,
      consecutiveSixes: decision.consecutiveSixes,
      ...(captureSnapshot
        ? { sixStreakSnapshot: snapshotTokens(tokens) }
        : {}),
      lastActivityAt: now,
      ...withEvent(
        room,
        `${player.name} rolled 6 but cannot move — roll again`,
        now,
      ),
    });
    return {
      value,
      skipped: false,
      legalMoves,
      legalTokenMoves,
      rollAgain: true,
    };
  }

  if (decision.kind === "no_moves") {
    const seatColor = room.currentTurn as Color;
    if (
      player.color === seatColor &&
      shouldKeepRollForTeammatePass(mode, seatColor, value, tokens, players)
    ) {
      await ctx.db.patch(roomId, {
        diceValue: value,
        diceRolled: true,
        consecutiveSixes: 0,
        lastActivityAt: now,
      });
      const fresh = (await ctx.db.get(roomId))!;
      const passed = await passRollToTeammateIfLegal(
        ctx,
        fresh,
        player,
        now,
      );
      if (passed) {
        const afterPass = (await ctx.db.get(roomId))!;
        await maybeScheduleBotTurn(
          ctx,
          roomId,
          afterPass.turnId ?? room.turnId ?? 0,
        );
        return { value, skipped: false, legalMoves, legalTokenMoves };
      }
    }
    const next = advanceTurnColor(seatColor, players, mode);
    await beginTurn(ctx, room, next, {
      diceValue: value,
      lastEvent: `${player.name} rolled ${value} — no moves`,
    });
    return { value, skipped: true, legalMoves, legalTokenMoves };
  }

  await ctx.db.patch(roomId, {
    diceValue: value,
    diceRolled: true,
    consecutiveSixes: decision.consecutiveSixes,
    ...(captureSnapshot
      ? { sixStreakSnapshot: snapshotTokens(tokens) }
      : {}),
    lastActivityAt: now,
    ...withEvent(room, `${player.name} rolled ${value}`, now),
  });

  // Exactly one legal token → server-authoritative auto-move.
  if (legalTokenMoves.length === 1) {
    const fresh = (await ctx.db.get(roomId))!;
    const only = legalTokenMoves[0]!;
    const autoMove = await executeMove(
      ctx,
      roomId,
      fresh,
      player,
      only.color,
      only.index,
      now,
      clientIdForLog,
    );
    return {
      value,
      skipped: false,
      legalMoves,
      legalTokenMoves,
      autoMoved: true,
      autoMove,
    };
  }

  return { value, skipped: false, legalMoves, legalTokenMoves };
}

/** Shared move logic for humans and bots. Caller must validate turn ownership. */
async function executeMove(
  ctx: MutationCtx,
  roomId: Id<"rooms">,
  room: Doc<"rooms">,
  player: Doc<"players">,
  tokenColor: Color,
  tokenIndex: number,
  now: number,
  clientIdForLog: string,
): Promise<MoveResult> {
  if (
    !Number.isInteger(tokenIndex) ||
    tokenIndex < 0 ||
    tokenIndex > 3
  ) {
    fail(GameError.illegalMove);
  }

  if (!room.diceRolled || room.diceValue === null) {
    fail(GameError.rollFirst);
  }
  const dice = room.diceValue;
  if (!Number.isInteger(dice) || dice < 1 || dice > 6) {
    fail(GameError.invalidDice);
  }

  const players = await seatedPlayers(ctx, roomId);
  const mode = modeFromRoom(room);
  const seatColor = room.currentTurn as Color;
  const passedRollTo = room.passedRollTo ?? null;
  const wasDelegated = passedRollTo != null;
  const actorColor = player.color as Color;
  const tokens = await loadTokens(ctx, roomId);
  const legalTokenMoves = wasDelegated
    ? legalMovesForDelegatedRoll(tokens, passedRollTo, dice)
    : getLegalMovesForActor(tokens, actorColor, players, mode, dice);
  const legal = legalTokenMoves.some(
    (m) => m.color === tokenColor && m.index === tokenIndex,
  );
  if (!legal) {
    logEvent("rejected_move", {
      roomCode: room.code,
      color: tokenColor,
      tokenIndex,
      dice,
      clientId: clientIdForLog,
    });
    fail(GameError.illegalMove);
  }

  const tokenList = await ctx.db
    .query("tokens")
    .withIndex("by_room_color", (q) =>
      q.eq("roomId", roomId).eq("color", tokenColor),
    )
    .collect();
  const tokenDoc = tokenList.find((t) => t.index === tokenIndex);
  if (!tokenDoc) fail(GameError.illegalMove);

  const fromSteps = tokenDoc.steps;
  const dest = tryMoveSteps(tokenDoc.steps, dice);
  if (dest === null) fail(GameError.illegalMove);

  const gameMode: GameMode = mode;
  const captures = findCaptureTargets(tokens, tokenColor, dest, gameMode);
  if (captures.length > 0) {
    const byColor = new Map<Color, number[]>();
    for (const c of captures) {
      const list = byColor.get(c.color) ?? [];
      list.push(c.index);
      byColor.set(c.color, list);
    }
    for (const [color, indexes] of byColor) {
      const capList = await ctx.db
        .query("tokens")
        .withIndex("by_room_color", (q) =>
          q.eq("roomId", roomId).eq("color", color),
        )
        .collect();
      for (const index of indexes) {
        const capDoc = capList.find((t) => t.index === index);
        if (capDoc) {
          await ctx.db.patch(capDoc._id, { steps: -1 });
        }
      }
      logEvent("capture", {
        roomCode: room.code,
        attacker: tokenColor,
        victim: color,
        count: indexes.length,
        clientId: clientIdForLog,
      });
    }
  }

  await ctx.db.patch(tokenDoc._id, { steps: dest });

  // Clear dice immediately so concurrent move requests cannot reuse this roll.
  await ctx.db.patch(roomId, {
    diceRolled: false,
    lastActivityAt: now,
  });

  const capturedKeys = new Set(
    captures.map((c) => `${c.color}:${c.index}`),
  );
  const updatedTokens = tokens.map((t) =>
    t.color === tokenColor && t.index === tokenIndex
      ? { ...t, steps: dest }
      : capturedKeys.has(`${t.color}:${t.index}`)
        ? { ...t, steps: -1 }
        : t,
  );
  const didCapture = captures.length > 0;

  const reachedHome = dest === FINISHED_STEPS;
  const leftYard = fromSteps === -1;

  logEvent("token_moved", {
    roomCode: room.code,
    color: tokenColor,
    tokenIndex,
    fromSteps,
    toSteps: dest,
    dice,
    clientId: clientIdForLog,
  });

  const tokenOwner = players.find((p) => p.color === tokenColor);
  if (!tokenOwner) fail(GameError.illegalMove);

  if (hasWon(updatedTokens, tokenColor)) {
    const rankings = await assignFinishRank(ctx, room, tokenOwner);
    const rank = rankings.indexOf(tokenColor) + 1;
    const isFirst = rank === 1;
    const finishedLabel =
      tokenOwner._id === player._id
        ? player.name
        : `${player.name} (${tokenOwner.name}'s tokens)`;
    const placeNote = didCapture
      ? `${finishedLabel} captured and finished — #${rank}!`
      : `${finishedLabel} finished — #${rank}!`;

    await ctx.db.patch(roomId, {
      rankings,
      winner: isFirst ? tokenColor : (room.winner ?? tokenColor),
      diceRolled: false,
      diceValue: dice,
      consecutiveSixes: 0,
      lastMovedTokenIndex: null,
      sixStreakSnapshot: null,
      lastActivityAt: now,
      ...withEvent(room, placeNote, now),
    });

    const refreshedRoom = (await ctx.db.get(roomId))!;
    const refreshedPlayers = await seatedPlayers(ctx, roomId);
    const captureResult = {
      captured: didCapture,
      captures: captures.map((c) => ({ color: c.color, index: c.index })),
    };

    if (room.mode === "2v2") {
      if (
        await maybeFinishTeamMatch(
          ctx,
          refreshedRoom,
          refreshedPlayers,
          updatedTokens,
          now,
          tokenColor,
        )
      ) {
        return {
          won: true,
          matchOver: true,
          rank,
          ...captureResult,
          reachedHome,
          leftYard,
          fromSteps,
          toSteps: dest,
        };
      }

      const next = advanceTurnColor(
        room.currentTurn as Color,
        refreshedPlayers,
        mode,
      );
      const teammateNote =
        tokenOwner._id !== player._id
          ? `${tokenOwner.name} finished — ${player.name} plays their turns`
          : `${player.name} finished — teammate plays their turns`;
      await beginTurn(ctx, refreshedRoom, next, {
        diceValue: dice,
        lastEvent: `${teammateNote} (#${rank}) — game continues`,
      });

      return {
        won: true,
        matchOver: false,
        rank,
        ...captureResult,
        reachedHome,
        leftYard,
        fromSteps,
        toSteps: dest,
      };
    }

    if (await maybeFinishAutomaticLoser(ctx, refreshedRoom, refreshedPlayers, now)) {
      return {
        won: true,
        matchOver: true,
        rank,
        ...captureResult,
        reachedHome,
        leftYard,
        fromSteps,
        toSteps: dest,
      };
    }

    if (await maybeFinishAllRanked(ctx, refreshedRoom, refreshedPlayers, now)) {
      return {
        won: true,
        matchOver: true,
        rank,
        ...captureResult,
        reachedHome,
        leftYard,
        fromSteps,
        toSteps: dest,
      };
    }

    const stillPlaying = playableColors(refreshedPlayers);
    if (stillPlaying.length === 0) {
      await maybeFinishAllRanked(ctx, refreshedRoom, refreshedPlayers, now);
      return {
        won: true,
        matchOver: true,
        rank,
        ...captureResult,
        reachedHome,
        leftYard,
        fromSteps,
        toSteps: dest,
      };
    }

    const next = advanceTurnColor(
      room.currentTurn as Color,
      refreshedPlayers,
      modeFromRoom(room),
    );
    await beginTurn(ctx, refreshedRoom, next, {
      diceValue: dice,
      lastEvent: `${tokenOwner.name} is done (#${rank}) — game continues`,
    });

    return {
      won: true,
      matchOver: false,
      rank,
      ...captureResult,
      reachedHome,
      leftYard,
      fromSteps,
      toSteps: dest,
    };
  }

  const extraTurn = gainsExtraTurn(dice, didCapture, reachedHome);
  let capturedLabel: string | undefined;
  if (captures.length === 1) {
    const only = captures[0]!;
    const capturedPlayer = players.find((p) => p.color === only.color);
    capturedLabel = capturedPlayer?.name ?? only.color;
  } else if (captures.length > 1) {
    capturedLabel = `${captures.length} tokens`;
  }

  const seatPlayer = players.find((p) => p.color === seatColor);
  const rollAgainActorName =
    wasDelegated && seatPlayer ? seatPlayer.name : player.name;

  if (extraTurn) {
    const turnId = (room.turnId ?? 0) + 1;
    const reason = reachedHome
      ? `${rollAgainActorName} reached home — roll again`
      : didCapture
        ? `${rollAgainActorName} captured ${capturedLabel} — roll again`
        : `${rollAgainActorName} rolled 6 — roll again`;

    const keepSixStreak = dice === 6;
    await ctx.db.patch(roomId, {
      diceRolled: false,
      diceValue: dice,
      passedRollTo: null,
      consecutiveSixes: keepSixStreak ? room.consecutiveSixes : 0,
      lastMovedTokenIndex: null,
      sixStreakSnapshot: keepSixStreak
        ? (room.sixStreakSnapshot ?? null)
        : null,
      turnId,
      turnStartedAt: now,
      lastActivityAt: now,
      ...withEvent(room, reason, now),
    });
    await scheduleTurnTimeout(ctx, roomId, turnId);
    await maybeScheduleBotTurn(ctx, roomId, turnId);
  } else {
    const next = advanceTurnColor(seatColor, players, mode);
    const moveText = didCapture
      ? `${player.name} captured ${capturedLabel}`
      : `${player.name} moved`;
    await beginTurn(ctx, room, next, {
      diceValue: dice,
      lastEvent: moveText,
    });
  }

  return {
    won: false,
    captured: didCapture,
    extraTurn,
    reachedHome,
    leftYard,
    fromSteps,
    toSteps: dest,
    captures: captures.map((c) => ({ color: c.color, index: c.index })),
  };
}

const moveResultValidator = v.object({
  won: v.boolean(),
  matchOver: v.optional(v.boolean()),
  rank: v.optional(v.number()),
  captured: v.boolean(),
  reachedHome: v.boolean(),
  leftYard: v.boolean(),
  fromSteps: v.number(),
  toSteps: v.number(),
  extraTurn: v.optional(v.boolean()),
  captures: v.array(
    v.object({
      color: v.string(),
      index: v.number(),
    }),
  ),
});

const tokenMoveChoiceValidator = v.object({
  color: colorValidator,
  index: v.number(),
});

const rollResultValidator = v.object({
  value: v.number(),
  skipped: v.boolean(),
  legalMoves: v.array(v.number()),
  legalTokenMoves: v.optional(v.array(tokenMoveChoiceValidator)),
  threeSixes: v.optional(v.boolean()),
  rollAgain: v.optional(v.boolean()),
  autoMoved: v.optional(v.boolean()),
  autoMove: v.optional(moveResultValidator),
  turnExpired: v.optional(v.literal(true)),
});

export const rollDice = mutation({
  args: {
    roomId: v.id("rooms"),
    clientId: v.string(),
    /** Client's view of turnId — rejects stale tabs. */
    turnId: v.number(),
    expectedSeq: v.number(),
  },
  returns: rollResultValidator,
  handler: async (ctx, args) => {
    const clientId = assertValidClientId(args.clientId);
    const room = await ctx.db.get(args.roomId);
    if (!room) fail(GameError.roomNotFound);
    if (room.status !== "playing") fail(GameError.gameNotPlaying);
    assertEventSourcedRoom(room);

    assertFreshTurn(room, args.turnId);

    if (room.diceRolled) fail(GameError.diceAlreadyRolled);

    const player = await requireRollPlayer(ctx, args.roomId, clientId, room);
    if (player.isBot) fail(GameError.notYourTurn);
    if (await commitTurnExpiryIfNeeded(ctx, room)) {
      return {
        value: 0,
        skipped: true,
        legalMoves: [],
        turnExpired: true as const,
      };
    }

    const fresh = (await ctx.db.get(args.roomId))!;
    if (fresh.diceRolled) fail(GameError.diceAlreadyRolled);
    if ((fresh.passedRollTo ?? null) != null) {
      fail(GameError.notYourTurn);
    }

    const now = assertActionInterval(player.lastActionAt, ACTION_MIN_INTERVAL_MS);
    await ctx.db.patch(player._id, { lastActionAt: now });

    const before = await loadGameState(ctx, fresh);
    const value = rollFairDice(
      allTokensInYard(before.tokens, player.color as Color),
    );
    const decision = decide(
      before,
      { type: "RollDice", color: player.color as Color, value },
      { gameId: fresh._id, createdAt: now },
    );
    if (!decision.ok) fail(GameError.illegalMove);

    const committed = await commitEvents(ctx, fresh, decision.events, {
      expectedSeq: args.expectedSeq,
      now,
      actorClientId: clientId,
    });
    return summarizeRoll(before, committed.events, committed.state);
  },
});

export const moveToken = mutation({
  args: {
    roomId: v.id("rooms"),
    clientId: v.string(),
    tokenIndex: v.number(),
    /** Mover colour (required when moving a finished teammate's token in 2v2). */
    tokenColor: v.optional(colorValidator),
    /** Client's view of turnId — rejects stale tabs. */
    turnId: v.number(),
    expectedSeq: v.number(),
  },
  returns: moveResultValidator,
  handler: async (ctx, args) => {
    const clientId = assertValidClientId(args.clientId);
    const room = await ctx.db.get(args.roomId);
    if (!room) fail(GameError.roomNotFound);
    if (room.status !== "playing") fail(GameError.gameNotPlaying);
    assertEventSourcedRoom(room);

    assertFreshTurn(room, args.turnId);

    const player = await requireMovePlayer(ctx, args.roomId, clientId, room);
    if (player.isBot) fail(GameError.notYourTurn);
    if (await commitTurnExpiryIfNeeded(ctx, room)) {
      fail(GameError.turnExpired);
    }

    const fresh = (await ctx.db.get(args.roomId))!;
    const now = assertActionInterval(player.lastActionAt, ACTION_MIN_INTERVAL_MS);
    await ctx.db.patch(player._id, { lastActionAt: now });

    const before = await loadGameState(ctx, fresh);
    const moverColor = (args.tokenColor ?? player.color) as Color;
    const decision = decide(
      before,
      {
        type: "MoveToken",
        actorColor: player.color as Color,
        tokenColor: moverColor,
        tokenIndex: args.tokenIndex,
      },
      { gameId: fresh._id, createdAt: now },
    );
    if (!decision.ok) fail(GameError.illegalMove);

    const committed = await commitEvents(ctx, fresh, decision.events, {
      expectedSeq: args.expectedSeq,
      now,
      actorClientId: clientId,
    });
    return summarizeMove(before, committed.events, committed.state);
  },
});

/** Delegate a pending rolled die to a live teammate (2v2). Returns false if illegal. */
async function passRollToTeammateIfLegal(
  ctx: MutationCtx,
  room: Doc<"rooms">,
  passer: Doc<"players">,
  now: number,
): Promise<boolean> {
  if (modeFromRoom(room) !== "2v2") return false;
  if (passer.color !== (room.currentTurn as Color)) return false;
  if ((room.passedRollTo ?? null) != null) return false;
  if (!room.diceRolled || room.diceValue === null) return false;

  const teammateColor = teamTeammateColor(passer.color as Color);
  const playersAfter = await seatedPlayers(ctx, room._id);
  const teammate = playersAfter.find((p) => p.color === teammateColor);
  if (
    !teammate ||
    teammate.eliminated ||
    teammate.finishRank != null
  ) {
    return false;
  }

  const mode = modeFromRoom(room);
  const tokens = await loadTokens(ctx, room._id);
  if (
    !shouldTransferRollToTeammate(
      room,
      passer.color as Color,
      teammateColor,
      tokens,
      playersAfter,
      mode,
    )
  ) {
    return false;
  }

  const dice = room.diceValue;
  const turnId = (room.turnId ?? 0) + 1;
  const passEvent = `${passer.name} passed a ${dice} to ${teammate.name}`;
  const delegateText = `${teammate.name} — use ${passer.name}'s ${dice}`;
  const { lastEvent, events } = withEvents(
    room,
    [passEvent, delegateText],
    now,
  );
  await ctx.db.patch(room._id, {
    passedRollTo: teammateColor,
    turnId,
    turnStartedAt: now,
    lastActivityAt: now,
    lastEvent,
    events,
  });
  await scheduleTurnTimeout(ctx, room._id, turnId);
  await maybeScheduleBotTurn(ctx, room._id, turnId);
  return true;
}

export const passTurn = mutation({
  args: {
    roomId: v.id("rooms"),
    clientId: v.string(),
    turnId: v.number(),
    targetColor: colorValidator,
    expectedSeq: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const clientId = assertValidClientId(args.clientId);
    const room = await ctx.db.get(args.roomId);
    if (!room) fail(GameError.roomNotFound);
    if (room.status !== "playing") fail(GameError.gameNotPlaying);
    assertEventSourcedRoom(room);

    if (modeFromRoom(room) !== "2v2") fail(GameError.passNotAllowed);

    assertFreshTurn(room, args.turnId);

    const player = await requirePlayerInRoom(ctx, args.roomId, clientId);
    if (player.isBot) fail(GameError.notYourTurn);
    if (await commitTurnExpiryIfNeeded(ctx, room)) {
      fail(GameError.turnExpired);
    }

    const fresh = (await ctx.db.get(args.roomId))!;
    if (fresh.currentTurn !== player.color) fail(GameError.notYourTurn);
    if ((fresh.passedRollTo ?? null) != null) {
      fail(GameError.notYourTurn);
    }

    const teammateColor = teamTeammateColor(player.color as Color);
    if (args.targetColor !== teammateColor) fail(GameError.invalidPassTarget);

    const now = assertActionInterval(player.lastActionAt, ACTION_MIN_INTERVAL_MS);
    await ctx.db.patch(player._id, { lastActionAt: now });

    const state = await loadGameState(ctx, fresh);
    const decision = decide(
      state,
      { type: "PassRoll", from: player.color as Color, to: teammateColor },
      { gameId: fresh._id, createdAt: now },
    );
    if (!decision.ok) fail(GameError.passNothingToPass);
    await commitEvents(ctx, fresh, decision.events, {
      expectedSeq: args.expectedSeq,
      now,
      actorClientId: clientId,
    });
    return null;
  },
});

/** Server-side turn timeout: lose a life, maybe eliminate, advance turn. */
export const handleTurnTimeout = internalMutation({
  args: {
    roomId: v.id("rooms"),
    turnId: v.number(),
    expectedSeq: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const room = await ctx.db.get(args.roomId);
    if (!room || room.status !== "playing") return null;
    if ((room.turnId ?? 0) !== args.turnId) return null;
    if (room.eventSeq === undefined) return null;
    if (
      args.expectedSeq !== undefined &&
      room.eventSeq !== args.expectedSeq
    ) {
      return null;
    }

    const started = room.turnStartedAt ?? 0;
    if (Date.now() < started + TURN_TIMEOUT_MS - 50) return null;

    const state = await loadGameState(ctx, room);
    const now = Date.now();
    const result = decide(
      state,
      { type: "ExpireTurn" },
      { gameId: room._id, createdAt: now },
    );
    if (!result.ok) return null;
    await commitEvents(ctx, room, result.events, {
      expectedSeq: room.eventSeq,
      now,
    });
    return null;
  },
});

/**
 * One bot action per invocation: roll if needed, otherwise move.
 * Re-schedules itself for roll-again / move-after-roll / extra turns.
 */
export const playBotTurn = internalMutation({
  args: {
    roomId: v.id("rooms"),
    turnId: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const room = await ctx.db.get(args.roomId);
    if (!room || room.status !== "playing") return null;
    if ((room.turnId ?? 0) !== args.turnId) return null;

    const players = await seatedPlayers(ctx, args.roomId);
    const mode = modeFromRoom(room);
    const seat = room.currentTurn as Color;
    const passedRollTo = room.passedRollTo ?? null;
    const botColor =
      passedRollTo ??
      (room.diceRolled
        ? moveControllerColor(seat, players, mode, null)
        : rollControllerColor(seat, players, mode, null));
    const player = players.find((p) => p.color === botColor);
    if (
      !player ||
      !player.isBot ||
      player.eliminated ||
      player.finishRank != null
    ) {
      return null;
    }

    const now = Date.now();
    await ctx.db.patch(player._id, {
      lastActionAt: now,
      connected: true,
      lastSeenAt: now,
    });

    if (!room.diceRolled) {
      if (passedRollTo != null) return null;
      const result = await executeRoll(
        ctx,
        args.roomId,
        room,
        player,
        now,
        player.clientId,
      );
      // Need another roll (6 with no moves) or a move after this roll.
      // Auto-moved rolls already advanced turn / scheduled the next bot action.
      if (!result.skipped && !result.autoMoved) {
        const fresh = await ctx.db.get(args.roomId);
        if (fresh && fresh.status === "playing") {
          await maybeScheduleBotTurn(
            ctx,
            args.roomId,
            fresh.turnId ?? args.turnId,
            BOT_THINK_MS,
          );
        }
      }
      return null;
    }

    const dice = room.diceValue;
    if (dice === null) return null;
    const tokens = await loadTokens(ctx, args.roomId);
    const legal =
      passedRollTo != null
        ? legalMovesForDelegatedRoll(tokens, passedRollTo, dice)
        : getLegalMovesForActor(
            tokens,
            player.color as Color,
            players,
            mode,
            dice,
          );
    if (legal.length === 0) {
      const passed = await passRollToTeammateIfLegal(ctx, room, player, now);
      if (passed) {
        const fresh = await ctx.db.get(args.roomId);
        if (fresh && fresh.status === "playing") {
          await maybeScheduleBotTurn(
            ctx,
            args.roomId,
            fresh.turnId ?? args.turnId,
            BOT_THINK_MS,
          );
        }
        return null;
      }
      const next = advanceTurnColor(room.currentTurn as Color, players, mode);
      await beginTurn(ctx, room, next, {
        lastEvent: `${player.name} — no moves`,
      });
      return null;
    }
    const pick =
      legal.length === 1
        ? legal[0]!
        : (() => {
            const idx = pickBotMove(tokens, player.color as Color, dice);
            const fallback = legal.find(
              (m) => m.color === player.color && m.index === idx,
            );
            return fallback ?? legal[0]!;
          })();

    await executeMove(
      ctx,
      args.roomId,
      room,
      player,
      pick.color,
      pick.index,
      now,
      player.clientId,
    );
    return null;
  },
});

export const getLegalTokenIndexes = query({
  args: {
    roomId: v.id("rooms"),
    clientId: v.string(),
  },
  returns: v.array(tokenMoveChoiceValidator),
  handler: async (ctx, args) => {
    let clientId: string;
    try {
      clientId = assertValidClientId(args.clientId);
    } catch {
      return [];
    }

    const room = await ctx.db.get(args.roomId);
    if (
      !room ||
      room.status !== "playing" ||
      !room.diceRolled ||
      room.diceValue === null
    ) {
      return [];
    }

    const player = await ctx.db
      .query("players")
      .withIndex("by_room_client", (q) =>
        q.eq("roomId", args.roomId).eq("clientId", clientId),
      )
      .unique();

    const players = await seatedPlayers(ctx, args.roomId);
    const mode = modeFromRoom(room);
    const moveColor = moveControllerColor(
      room.currentTurn as Color,
      players,
      mode,
      room.passedRollTo ?? null,
    );

    if (
      !player ||
      player.eliminated ||
      player.finishRank != null ||
      player.color !== moveColor
    ) {
      return [];
    }

    const tokens = await loadTokens(ctx, args.roomId);
    const passedRollTo = room.passedRollTo ?? null;
    if (passedRollTo != null) {
      return legalMovesForDelegatedRoll(tokens, passedRollTo, room.diceValue);
    }
    return getLegalMovesForActor(
      tokens,
      moveColor,
      players,
      mode,
      room.diceValue,
    );
  },
});
