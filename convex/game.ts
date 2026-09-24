import { mutation, query, MutationCtx, QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { Id } from "./_generated/dataModel";
import {
  Color,
  findCaptureTarget,
  getLegalMoves,
  hasWon,
  nextColor,
  TokenState,
  tryMoveSteps,
} from "./lib/ludo";

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

export const rollDice = mutation({
  args: {
    roomId: v.id("rooms"),
    clientId: v.string(),
  },
  handler: async (ctx, args) => {
    const room = await ctx.db.get(args.roomId);
    if (!room) throw new Error("Room not found");
    if (room.status !== "playing") throw new Error("Game not in progress");
    if (room.diceRolled) throw new Error("Dice already rolled");

    const player = await ctx.db
      .query("players")
      .withIndex("by_room_client", (q) =>
        q.eq("roomId", args.roomId).eq("clientId", args.clientId),
      )
      .unique();

    if (!player) throw new Error("Not in this room");
    if (player.color !== room.currentTurn) throw new Error("Not your turn");

    const value = 1 + Math.floor(Math.random() * 6);
    const consecutiveSixes = value === 6 ? room.consecutiveSixes + 1 : 0;

    if (consecutiveSixes >= 3) {
      await ctx.db.patch(args.roomId, {
        diceValue: value,
        diceRolled: false,
        consecutiveSixes: 0,
        currentTurn: nextColor(room.currentTurn),
        lastEvent: `${player.color} rolled three 6s — turn skipped`,
      });
      return { value, skipped: true, legalMoves: [] as number[] };
    }

    const tokens = await loadTokens(ctx, args.roomId);
    const legalMoves = getLegalMoves(tokens, player.color, value);

    if (legalMoves.length === 0) {
      if (value === 6) {
        await ctx.db.patch(args.roomId, {
          diceValue: value,
          diceRolled: false,
          consecutiveSixes,
          lastEvent: `${player.color} rolled 6 but cannot move — roll again`,
        });
        return { value, skipped: false, legalMoves, rollAgain: true };
      }

      await ctx.db.patch(args.roomId, {
        diceValue: value,
        diceRolled: false,
        consecutiveSixes: 0,
        currentTurn: nextColor(room.currentTurn),
        lastEvent: `${player.color} rolled ${value} — no moves`,
      });
      return { value, skipped: true, legalMoves };
    }

    await ctx.db.patch(args.roomId, {
      diceValue: value,
      diceRolled: true,
      consecutiveSixes,
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
    const room = await ctx.db.get(args.roomId);
    if (!room) throw new Error("Room not found");
    if (room.status !== "playing") throw new Error("Game not in progress");
    if (!room.diceRolled || room.diceValue === null) {
      throw new Error("Roll the dice first");
    }

    const player = await ctx.db
      .query("players")
      .withIndex("by_room_client", (q) =>
        q.eq("roomId", args.roomId).eq("clientId", args.clientId),
      )
      .unique();

    if (!player) throw new Error("Not in this room");
    if (player.color !== room.currentTurn) throw new Error("Not your turn");

    const dice = room.diceValue;
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

    if (hasWon(updatedTokens, player.color)) {
      await ctx.db.patch(args.roomId, {
        status: "finished",
        winner: player.color,
        diceRolled: false,
        diceValue: dice,
        consecutiveSixes: 0,
        lastEvent: `${player.name} (${player.color}) wins!`,
      });
      return { won: true, captured: !!captured };
    }

    const extraTurn = dice === 6 || !!captured;
    if (extraTurn) {
      await ctx.db.patch(args.roomId, {
        diceRolled: false,
        diceValue: dice,
        consecutiveSixes: dice === 6 ? room.consecutiveSixes : 0,
        lastEvent: captured
          ? `${player.color} captured ${captured.color} — roll again`
          : `${player.color} rolled 6 — roll again`,
      });
    } else {
      await ctx.db.patch(args.roomId, {
        diceRolled: false,
        diceValue: dice,
        consecutiveSixes: 0,
        currentTurn: nextColor(room.currentTurn),
        lastEvent: `${player.color} moved`,
      });
    }

    return { won: false, captured: !!captured, extraTurn };
  },
});
