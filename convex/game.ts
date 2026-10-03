import {
  internalMutation,
  mutation,
  query,
  MutationCtx,
  QueryCtx,
} from "./_generated/server";
import { v } from "convex/values";
import { Doc, Id } from "./_generated/dataModel";
import {
  allTokensInYard,
  Color,
  getLegalMovesForActor,
  legalMovesForDelegatedRoll,
  moveControllerColor,
  rollControllerColor,
  rollFairDice,
  GameMode,
  TokenState,
  teamTeammateColor,
  TURN_TIMEOUT_MS,
} from "./lib/ludo";
import { colorValidator } from "./schema";
import { chooseBotCommand } from "./lib/bot";
import { GameError, fail } from "./lib/errors";
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

function modeFromRoom(room: Doc<"rooms">): GameMode {
  return room.mode === "2v2" ? "2v2" : "1v1";
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
 * One bot action per invocation: roll if needed, otherwise move. The commit
 * schedules the next invocation, so roll-again, move-after-roll and extra
 * turns chain on their own.
 */
export const playBotTurn = internalMutation({
  args: {
    roomId: v.id("rooms"),
    turnId: v.number(),
    expectedSeq: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const room = await ctx.db.get(args.roomId);
    if (!room || room.status !== "playing") return null;
    if (room.eventSeq === undefined) return null;
    if ((room.turnId ?? 0) !== args.turnId) return null;
    if (args.expectedSeq !== undefined && room.eventSeq !== args.expectedSeq) {
      return null;
    }

    const state = await loadGameState(ctx, room);
    const choice = chooseBotCommand(state);
    if (!choice) return null;

    const now = Date.now();
    const bot = await ctx.db
      .query("players")
      .withIndex("by_room_color", (q) =>
        q.eq("roomId", args.roomId).eq("color", choice.color),
      )
      .unique();
    if (bot) {
      await ctx.db.patch(bot._id, {
        lastActionAt: now,
        connected: true,
        lastSeenAt: now,
      });
    }

    const decision = decide(state, choice.command, {
      gameId: room._id,
      createdAt: now,
    });
    if (!decision.ok) return null;
    await commitEvents(ctx, room, decision.events, {
      expectedSeq: room.eventSeq,
      now,
      actorClientId: bot?.clientId,
    });
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
