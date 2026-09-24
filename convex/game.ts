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
  findCaptureTarget,
  FINISHED_STEPS,
  gainsExtraTurn,
  getLegalMoves,
  hasWon,
  MAX_TIMEOUT_LIVES,
  nextColorAmong,
  pickThreeSixesPenaltyToken,
  rollFairDice,
  TokenState,
  tryMoveSteps,
  TURN_TIMEOUT_MS,
} from "./lib/ludo";
import { GameError, fail } from "./lib/errors";
import { logEvent } from "./lib/log";
import {
  ACTION_MIN_INTERVAL_MS,
  assertActionInterval,
  assertValidClientId,
} from "./lib/session";

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

/** Colours that still take turns. */
function playableColors(players: Doc<"players">[]): Color[] {
  return (["red", "green", "yellow", "blue"] as Color[]).filter((c) =>
    players.some((p) => p.color === c && !p.eliminated),
  );
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

/** Advance to `next` and arm a fresh 60s timeout. */
async function beginTurn(
  ctx: MutationCtx,
  room: Doc<"rooms">,
  next: Color,
  patch: Record<string, unknown>,
) {
  const turnId = (room.turnId ?? 0) + 1;
  const now = Date.now();
  // `patch` may include lastEvent / diceValue (last face for UI).
  // Turn-control fields below always win over patch.
  await ctx.db.patch(room._id, {
    diceValue: null,
    ...patch,
    currentTurn: next,
    diceRolled: false,
    consecutiveSixes: 0,
    lastMovedTokenIndex: null,
    turnId,
    turnStartedAt: now,
    lastActivityAt: now,
  });
  await scheduleTurnTimeout(ctx, room._id, turnId);
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
 * When only one playable colour remains, they win.
 * Rankings: existing finishers first, then survivor, then eliminated/forfeits last.
 */
async function maybeFinishSoleSurvivor(
  ctx: MutationCtx,
  room: Doc<"rooms">,
  players: Doc<"players">[],
): Promise<boolean> {
  const alive = players.filter((p) => !p.eliminated);
  if (alive.length !== 1) return false;

  const sole = alive[0]!;
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
    finishedAt: now,
    lastActivityAt: now,
    lastEvent: `${sole.name} wins — others eliminated`,
  });
  logEvent("game_finished", {
    roomCode: room.code,
    winner: sole.color,
    reason: "sole_survivor",
  });
  return true;
}

/** Apply timeout life loss / elimination / turn advance. Shared by cron + eager expiry. */
async function applyTurnTimeout(
  ctx: MutationCtx,
  room: Doc<"rooms">,
): Promise<void> {
  const players = await seatedPlayers(ctx, room._id);
  const current = players.find((p) => p.color === room.currentTurn);
  if (!current || current.eliminated) return;

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

    if (await maybeFinishSoleSurvivor(ctx, room, refreshed)) return;

    const seated = playableColors(refreshed);
    if (seated.length < 2) return;

    const next = nextColorAmong(room.currentTurn, seated);
    await beginTurn(ctx, room, next, {
      lastEvent: `${current.name} timed out — eliminated (0 lives)`,
    });
    return;
  }

  await ctx.db.patch(current._id, { lives });
  const seated = playableColors(players);
  const next = nextColorAmong(room.currentTurn, seated);
  await beginTurn(ctx, room, next, {
    lastEvent: `${current.name} timed out — ${lives} ${lives === 1 ? "life" : "lives"} left`,
  });
}

/**
 * Server-authoritative turn clock. If expired, apply timeout and reject the action.
 * Prevents acting in the window after expiry but before the scheduled job runs.
 */
async function assertTurnNotExpired(
  ctx: MutationCtx,
  room: Doc<"rooms">,
): Promise<void> {
  const started = room.turnStartedAt;
  if (started === undefined) return;
  if (Date.now() <= started + TURN_TIMEOUT_MS) return;
  await applyTurnTimeout(ctx, room);
  fail(GameError.turnExpired);
}

function assertFreshTurn(room: Doc<"rooms">, expectedTurnId: number) {
  if ((room.turnId ?? 0) !== expectedTurnId) {
    fail(GameError.staleAction);
  }
}

async function requireActivePlayer(
  ctx: MutationCtx,
  roomId: Id<"rooms">,
  clientId: string,
  room: Doc<"rooms">,
) {
  const player = await ctx.db
    .query("players")
    .withIndex("by_room_client", (q) =>
      q.eq("roomId", roomId).eq("clientId", clientId),
    )
    .unique();

  if (!player) fail(GameError.notInRoom);
  if (player.eliminated) fail(GameError.eliminated);
  if (player.color !== room.currentTurn) fail(GameError.notYourTurn);
  return player;
}

const rollResultValidator = v.object({
  value: v.number(),
  skipped: v.boolean(),
  legalMoves: v.array(v.number()),
  threeSixes: v.optional(v.boolean()),
  rollAgain: v.optional(v.boolean()),
  returnedToken: v.optional(v.union(v.number(), v.null())),
});

export const rollDice = mutation({
  args: {
    roomId: v.id("rooms"),
    clientId: v.string(),
    /** Client's view of turnId — rejects stale tabs. */
    turnId: v.number(),
  },
  returns: rollResultValidator,
  handler: async (ctx, args) => {
    const clientId = assertValidClientId(args.clientId);
    const room = await ctx.db.get(args.roomId);
    if (!room) fail(GameError.roomNotFound);
    if (room.status !== "playing") fail(GameError.gameNotPlaying);

    assertFreshTurn(room, args.turnId);

    if (room.diceRolled) fail(GameError.diceAlreadyRolled);

    const player = await requireActivePlayer(ctx, args.roomId, clientId, room);
    await assertTurnNotExpired(ctx, room);

    // Re-read after possible timeout (assertTurnNotExpired throws if expired).
    const fresh = (await ctx.db.get(args.roomId))!;
    if (fresh.diceRolled) fail(GameError.diceAlreadyRolled);
    // Re-check seat against post-timeout state (should have thrown already).
    if (player.color !== fresh.currentTurn) fail(GameError.notYourTurn);

    const now = assertActionInterval(player.lastActionAt, ACTION_MIN_INTERVAL_MS);
    await ctx.db.patch(player._id, { lastActionAt: now });

    const players = await seatedPlayers(ctx, args.roomId);
    const seated = playableColors(players);
    const tokens = await loadTokens(ctx, args.roomId);
    const value = rollFairDice(allTokensInYard(tokens, player.color as Color));
    const legalMoves = getLegalMoves(tokens, player.color, value);
    const decision = decideRollOutcome(
      value,
      fresh.consecutiveSixes,
      legalMoves.length,
    );

    logEvent("dice_rolled", {
      roomCode: fresh.code,
      color: player.color,
      value,
      decision: decision.kind,
      turnId: fresh.turnId ?? 0,
      clientId,
    });

    if (decision.kind === "three_sixes") {
      const penaltyIndex = pickThreeSixesPenaltyToken(
        tokens,
        player.color,
        fresh.lastMovedTokenIndex ?? null,
      );
      if (penaltyIndex !== null) {
        const tokenList = await ctx.db
          .query("tokens")
          .withIndex("by_room_color", (q) =>
            q.eq("roomId", args.roomId).eq("color", player.color),
          )
          .collect();
        const doc = tokenList.find((t) => t.index === penaltyIndex);
        if (doc) await ctx.db.patch(doc._id, { steps: -1 });
      }

      const next = nextColorAmong(fresh.currentTurn, seated);
      const event =
        penaltyIndex !== null
          ? `${player.color} rolled three 6s — token returned home, turn skipped`
          : `${player.color} rolled three 6s — turn skipped`;

      await beginTurn(ctx, fresh, next, {
        diceValue: value,
        lastEvent: event,
      });
      return {
        value,
        skipped: true,
        threeSixes: true,
        legalMoves: [] as number[],
        returnedToken: penaltyIndex,
      };
    }

    if (decision.kind === "no_moves_six") {
      await ctx.db.patch(args.roomId, {
        diceValue: value,
        diceRolled: false,
        consecutiveSixes: decision.consecutiveSixes,
        lastActivityAt: now,
        lastEvent: `${player.color} rolled 6 but cannot move — roll again`,
      });
      return { value, skipped: false, legalMoves, rollAgain: true };
    }

    if (decision.kind === "no_moves") {
      const next = nextColorAmong(fresh.currentTurn, seated);
      await beginTurn(ctx, fresh, next, {
        diceValue: value,
        lastEvent: `${player.color} rolled ${value} — no moves`,
      });
      return { value, skipped: true, legalMoves };
    }

    await ctx.db.patch(args.roomId, {
      diceValue: value,
      diceRolled: true,
      consecutiveSixes: decision.consecutiveSixes,
      lastActivityAt: now,
      lastEvent: `${player.color} rolled ${value}`,
    });

    return { value, skipped: false, legalMoves };
  },
});

const moveResultValidator = v.object({
  won: v.boolean(),
  captured: v.boolean(),
  reachedHome: v.boolean(),
  leftYard: v.boolean(),
  fromSteps: v.number(),
  toSteps: v.number(),
  extraTurn: v.optional(v.boolean()),
  capturedColor: v.optional(v.union(v.string(), v.null())),
  capturedIndex: v.optional(v.union(v.number(), v.null())),
});

export const moveToken = mutation({
  args: {
    roomId: v.id("rooms"),
    clientId: v.string(),
    tokenIndex: v.number(),
    /** Client's view of turnId — rejects stale tabs. */
    turnId: v.number(),
  },
  returns: moveResultValidator,
  handler: async (ctx, args) => {
    const clientId = assertValidClientId(args.clientId);
    const room = await ctx.db.get(args.roomId);
    if (!room) fail(GameError.roomNotFound);
    if (room.status !== "playing") fail(GameError.gameNotPlaying);

    assertFreshTurn(room, args.turnId);

    if (
      !Number.isInteger(args.tokenIndex) ||
      args.tokenIndex < 0 ||
      args.tokenIndex > 3
    ) {
      fail(GameError.illegalMove);
    }

    const player = await requireActivePlayer(ctx, args.roomId, clientId, room);
    await assertTurnNotExpired(ctx, room);

    const fresh = (await ctx.db.get(args.roomId))!;
    if (player.color !== fresh.currentTurn) fail(GameError.notYourTurn);
    if (!fresh.diceRolled || fresh.diceValue === null) {
      fail(GameError.rollFirst);
    }
    const dice = fresh.diceValue;
    if (!Number.isInteger(dice) || dice < 1 || dice > 6) {
      fail(GameError.invalidDice);
    }

    const now = assertActionInterval(player.lastActionAt, ACTION_MIN_INTERVAL_MS);
    await ctx.db.patch(player._id, { lastActionAt: now });

    const tokens = await loadTokens(ctx, args.roomId);
    const legal = getLegalMoves(tokens, player.color, dice);
    if (!legal.includes(args.tokenIndex)) {
      logEvent("rejected_move", {
        roomCode: fresh.code,
        color: player.color,
        tokenIndex: args.tokenIndex,
        dice,
        clientId,
      });
      fail(GameError.illegalMove);
    }

    const tokenList = await ctx.db
      .query("tokens")
      .withIndex("by_room_color", (q) =>
        q.eq("roomId", args.roomId).eq("color", player.color),
      )
      .collect();
    const tokenDoc = tokenList.find((t) => t.index === args.tokenIndex);
    if (!tokenDoc) fail(GameError.illegalMove);

    const fromSteps = tokenDoc.steps;
    const dest = tryMoveSteps(tokenDoc.steps, dice);
    if (dest === null) fail(GameError.illegalMove);

    const captured = findCaptureTarget(tokens, player.color, dest);
    if (captured) {
      const capList = await ctx.db
        .query("tokens")
        .withIndex("by_room_color", (q) =>
          q.eq("roomId", args.roomId).eq("color", captured.color),
        )
        .collect();
      const capDoc = capList.find((t) => t.index === captured.index);
      if (capDoc) {
        await ctx.db.patch(capDoc._id, { steps: -1 });
      }
      logEvent("capture", {
        roomCode: fresh.code,
        attacker: player.color,
        victim: captured.color,
        clientId,
      });
    }

    await ctx.db.patch(tokenDoc._id, { steps: dest });

    // Clear dice immediately so concurrent move requests cannot reuse this roll.
    await ctx.db.patch(args.roomId, {
      diceRolled: false,
      lastActivityAt: now,
    });

    const updatedTokens = tokens.map((t) =>
      t.color === player.color && t.index === args.tokenIndex
        ? { ...t, steps: dest }
        : captured &&
            t.color === captured.color &&
            t.index === captured.index
          ? { ...t, steps: -1 }
          : t,
    );

    const reachedHome = dest === FINISHED_STEPS;
    const leftYard = fromSteps === -1;

    logEvent("token_moved", {
      roomCode: fresh.code,
      color: player.color,
      tokenIndex: args.tokenIndex,
      fromSteps,
      toSteps: dest,
      dice,
      clientId,
    });

    if (hasWon(updatedTokens, player.color)) {
      const rankings = [...(fresh.rankings ?? []), player.color as Color];
      await ctx.db.patch(player._id, { finishRank: rankings.length });
      await ctx.db.patch(args.roomId, {
        status: "finished",
        winner: player.color,
        rankings,
        diceRolled: false,
        diceValue: dice,
        consecutiveSixes: 0,
        lastMovedTokenIndex: null,
        finishedAt: now,
        lastActivityAt: now,
        lastEvent: `${player.name} (${player.color}) wins!`,
      });
      logEvent("game_finished", {
        roomCode: fresh.code,
        winner: player.color,
        reason: "all_home",
      });
      return {
        won: true,
        captured: !!captured,
        reachedHome,
        leftYard,
        fromSteps,
        toSteps: dest,
      };
    }

    const players = await seatedPlayers(ctx, args.roomId);
    const seated = playableColors(players);
    const extraTurn = gainsExtraTurn(dice, !!captured, reachedHome);

    if (extraTurn) {
      const turnId = (fresh.turnId ?? 0) + 1;
      const reason = reachedHome
        ? `${player.color} reached home — roll again`
        : captured
          ? `${player.color} captured ${captured.color} — roll again`
          : `${player.color} rolled 6 — roll again`;

      await ctx.db.patch(args.roomId, {
        diceRolled: false,
        diceValue: dice,
        consecutiveSixes: dice === 6 ? fresh.consecutiveSixes : 0,
        lastMovedTokenIndex: dice === 6 ? args.tokenIndex : null,
        turnId,
        turnStartedAt: now,
        lastActivityAt: now,
        lastEvent: reason,
      });
      await scheduleTurnTimeout(ctx, args.roomId, turnId);
    } else {
      const next = nextColorAmong(fresh.currentTurn, seated);
      await beginTurn(ctx, fresh, next, {
        diceValue: dice,
        lastEvent: `${player.color} moved`,
      });
    }

    return {
      won: false,
      captured: !!captured,
      extraTurn,
      reachedHome,
      leftYard,
      fromSteps,
      toSteps: dest,
      capturedColor: captured?.color ?? null,
      capturedIndex: captured?.index ?? null,
    };
  },
});

/** Server-side turn timeout: lose a life, maybe eliminate, advance turn. */
export const handleTurnTimeout = internalMutation({
  args: {
    roomId: v.id("rooms"),
    turnId: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const room = await ctx.db.get(args.roomId);
    if (!room || room.status !== "playing") return null;
    if ((room.turnId ?? 0) !== args.turnId) return null;

    // Idempotent: only fire if the clock has actually elapsed.
    const started = room.turnStartedAt ?? 0;
    if (Date.now() < started + TURN_TIMEOUT_MS - 50) return null;

    await applyTurnTimeout(ctx, room);
    return null;
  },
});

export const getLegalTokenIndexes = query({
  args: {
    roomId: v.id("rooms"),
    clientId: v.string(),
  },
  returns: v.array(v.number()),
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
      return [] as number[];
    }

    const player = await ctx.db
      .query("players")
      .withIndex("by_room_client", (q) =>
        q.eq("roomId", args.roomId).eq("clientId", clientId),
      )
      .unique();

    if (!player || player.eliminated || player.color !== room.currentTurn) {
      return [];
    }

    const tokens = await loadTokens(ctx, args.roomId);
    return getLegalMoves(tokens, player.color, room.diceValue);
  },
});
