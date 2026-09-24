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
  TokenState,
  tryMoveSteps,
  TURN_TIMEOUT_MS,
} from "./lib/ludo";
import { assertValidClientId } from "./lib/session";

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
  await ctx.db.patch(room._id, {
    ...patch,
    currentTurn: next,
    diceRolled: false,
    diceValue: null,
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
 * Rankings: existing finishers first, then survivor, then eliminated.
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
  const rankings: Color[] = [...(room.rankings ?? [])];
  if (!rankings.includes(sole.color as Color)) {
    rankings.push(sole.color as Color);
  }
  for (const p of players) {
    if (p.eliminated && !rankings.includes(p.color as Color)) {
      rankings.push(p.color as Color);
    }
  }

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
  return true;
}

export const rollDice = mutation({
  args: {
    roomId: v.id("rooms"),
    clientId: v.string(),
  },
  handler: async (ctx, args) => {
    const clientId = assertValidClientId(args.clientId);
    const room = await ctx.db.get(args.roomId);
    if (!room) throw new Error("Room not found");
    if (room.status !== "playing") throw new Error("Game not in progress");
    if (room.diceRolled) throw new Error("Dice already rolled");

    const player = await ctx.db
      .query("players")
      .withIndex("by_room_client", (q) =>
        q.eq("roomId", args.roomId).eq("clientId", clientId),
      )
      .unique();

    if (!player) throw new Error("Not in this room");
    if (player.eliminated) throw new Error("You are eliminated");
    if (player.color !== room.currentTurn) throw new Error("Not your turn");

    const players = await seatedPlayers(ctx, args.roomId);
    const seated = playableColors(players);
    const value = 1 + Math.floor(Math.random() * 6);
    const tokens = await loadTokens(ctx, args.roomId);
    const legalMoves = getLegalMoves(tokens, player.color, value);
    const decision = decideRollOutcome(
      value,
      room.consecutiveSixes,
      legalMoves.length,
    );
    const now = Date.now();

    if (decision.kind === "three_sixes") {
      const penaltyIndex = pickThreeSixesPenaltyToken(
        tokens,
        player.color,
        room.lastMovedTokenIndex ?? null,
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

      const next = nextColorAmong(room.currentTurn, seated);
      const event =
        penaltyIndex !== null
          ? `${player.color} rolled three 6s — token returned home, turn skipped`
          : `${player.color} rolled three 6s — turn skipped`;

      await beginTurn(ctx, room, next, {
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
      const next = nextColorAmong(room.currentTurn, seated);
      await beginTurn(ctx, room, next, {
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

export const moveToken = mutation({
  args: {
    roomId: v.id("rooms"),
    clientId: v.string(),
    tokenIndex: v.number(),
  },
  handler: async (ctx, args) => {
    const clientId = assertValidClientId(args.clientId);
    const room = await ctx.db.get(args.roomId);
    if (!room) throw new Error("Room not found");
    if (room.status !== "playing") throw new Error("Game not in progress");
    if (!room.diceRolled || room.diceValue === null) {
      throw new Error("Roll the dice first");
    }
    const dice = room.diceValue;
    if (!Number.isInteger(dice) || dice < 1 || dice > 6) {
      throw new Error("Invalid dice state");
    }
    if (
      !Number.isInteger(args.tokenIndex) ||
      args.tokenIndex < 0 ||
      args.tokenIndex > 3
    ) {
      throw new Error("Illegal move");
    }

    const player = await ctx.db
      .query("players")
      .withIndex("by_room_client", (q) =>
        q.eq("roomId", args.roomId).eq("clientId", clientId),
      )
      .unique();

    if (!player) throw new Error("Not in this room");
    if (player.eliminated) throw new Error("You are eliminated");
    if (player.color !== room.currentTurn) throw new Error("Not your turn");

    const tokens = await loadTokens(ctx, args.roomId);
    const legal = getLegalMoves(tokens, player.color, dice);
    if (!legal.includes(args.tokenIndex)) {
      throw new Error("Illegal move");
    }

    const tokenList = await ctx.db
      .query("tokens")
      .withIndex("by_room_color", (q) =>
        q.eq("roomId", args.roomId).eq("color", player.color),
      )
      .collect();
    const tokenDoc = tokenList.find((t) => t.index === args.tokenIndex);
    if (!tokenDoc) throw new Error("Token not found");

    const fromSteps = tokenDoc.steps;
    const dest = tryMoveSteps(tokenDoc.steps, dice);
    if (dest === null) throw new Error("Illegal move");

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
    }

    await ctx.db.patch(tokenDoc._id, { steps: dest });

    const updatedTokens = tokens.map((t) =>
      t.color === player.color && t.index === args.tokenIndex
        ? { ...t, steps: dest }
        : captured &&
            t.color === captured.color &&
            t.index === captured.index
          ? { ...t, steps: -1 }
          : t,
    );

    const now = Date.now();
    const reachedHome = dest === FINISHED_STEPS;
    const leftYard = fromSteps === -1;

    if (hasWon(updatedTokens, player.color)) {
      const players = await seatedPlayers(ctx, args.roomId);
      const rankings = [...(room.rankings ?? []), player.color as Color];
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
      const turnId = (room.turnId ?? 0) + 1;
      const reason = reachedHome
        ? `${player.color} reached home — roll again`
        : captured
          ? `${player.color} captured ${captured.color} — roll again`
          : `${player.color} rolled 6 — roll again`;

      await ctx.db.patch(args.roomId, {
        diceRolled: false,
        diceValue: dice,
        consecutiveSixes: dice === 6 ? room.consecutiveSixes : 0,
        lastMovedTokenIndex:
          dice === 6 ? args.tokenIndex : null,
        turnId,
        turnStartedAt: now,
        lastActivityAt: now,
        lastEvent: reason,
      });
      await scheduleTurnTimeout(ctx, args.roomId, turnId);
    } else {
      const next = nextColorAmong(room.currentTurn, seated);
      await beginTurn(ctx, room, next, {
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
  handler: async (ctx, args) => {
    const room = await ctx.db.get(args.roomId);
    if (!room || room.status !== "playing") return;
    if ((room.turnId ?? 0) !== args.turnId) return;

    const players = await seatedPlayers(ctx, args.roomId);
    const current = players.find((p) => p.color === room.currentTurn);
    if (!current || current.eliminated) return;

    const lives = (current.lives ?? MAX_TIMEOUT_LIVES) - 1;

    if (lives <= 0) {
      await ctx.db.patch(current._id, {
        lives: 0,
        eliminated: true,
      });
      await returnTokensToYard(ctx, args.roomId, current.color as Color);

      const refreshed = await seatedPlayers(ctx, args.roomId);
      const rankings = [...(room.rankings ?? [])];
      // Eliminated players append later in sole-survivor finish; mark seat.
      await ctx.db.patch(current._id, {
        finishRank: rankings.length + refreshed.filter((p) => p.eliminated).length,
      });

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
  },
});
export const getLegalTokenIndexes = query({
  args: {
    roomId: v.id("rooms"),
    clientId: v.string(),
  },
  handler: async (ctx, args) => {
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
        q.eq("roomId", args.roomId).eq("clientId", args.clientId),
      )
      .unique();

    if (!player || player.eliminated || player.color !== room.currentTurn) {
      return [];
    }

    const tokens = await loadTokens(ctx, args.roomId);
    return getLegalMoves(tokens, player.color, room.diceValue);
  },
});
