import { mutation, query, MutationCtx, QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { Id } from "./_generated/dataModel";
import {
  Color,
  decideRollOutcome,
  findCaptureTarget,
  gainsExtraTurn,
  getLegalMoves,
  hasWon,
  nextColorAmong,
  TokenState,
  tryMoveSteps,
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

async function activeColors(
  ctx: MutationCtx | QueryCtx,
  roomId: Id<"rooms">,
): Promise<Color[]> {
  const players = await ctx.db
    .query("players")
    .withIndex("by_room", (q) => q.eq("roomId", roomId))
    .collect();
  const set = new Set(players.map((p) => p.color as Color));
  return (["red", "green", "yellow", "blue"] as Color[]).filter((c) =>
    set.has(c),
  );
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
    if (player.color !== room.currentTurn) throw new Error("Not your turn");

    const seated = await activeColors(ctx, args.roomId);
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
      await ctx.db.patch(args.roomId, {
        diceValue: value,
        diceRolled: false,
        consecutiveSixes: 0,
        currentTurn: nextColorAmong(room.currentTurn, seated),
        lastActivityAt: now,
        lastEvent: `${player.color} rolled three 6s — turn skipped`,
      });
      return { value, skipped: true, legalMoves: [] as number[] };
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
      await ctx.db.patch(args.roomId, {
        diceValue: value,
        diceRolled: false,
        consecutiveSixes: 0,
        currentTurn: nextColorAmong(room.currentTurn, seated),
        lastActivityAt: now,
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

    if (hasWon(updatedTokens, player.color)) {
      await ctx.db.patch(args.roomId, {
        status: "finished",
        winner: player.color,
        diceRolled: false,
        diceValue: dice,
        consecutiveSixes: 0,
        finishedAt: now,
        lastActivityAt: now,
        lastEvent: `${player.name} (${player.color}) wins!`,
      });
      return { won: true, captured: !!captured };
    }

    const seated = await activeColors(ctx, args.roomId);
    const extraTurn = gainsExtraTurn(dice, !!captured);
    if (extraTurn) {
      await ctx.db.patch(args.roomId, {
        diceRolled: false,
        diceValue: dice,
        consecutiveSixes: dice === 6 ? room.consecutiveSixes : 0,
        lastActivityAt: now,
        lastEvent: captured
          ? `${player.color} captured ${captured.color} — roll again`
          : `${player.color} rolled 6 — roll again`,
      });
    } else {
      await ctx.db.patch(args.roomId, {
        diceRolled: false,
        diceValue: dice,
        consecutiveSixes: 0,
        currentTurn: nextColorAmong(room.currentTurn, seated),
        lastActivityAt: now,
        lastEvent: `${player.color} moved`,
      });
    }

    return { won: false, captured: !!captured, extraTurn };
  },
});

/** Kept for diagnostics; UI derives legal moves client-side. */
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

    if (!player || player.color !== room.currentTurn) return [];

    const tokens = await loadTokens(ctx, args.roomId);
    return getLegalMoves(tokens, player.color, room.diceValue);
  },
});
