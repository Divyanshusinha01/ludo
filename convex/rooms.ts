import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { MutationCtx } from "./_generated/server";
import { COLORS, createInitialTokens, generateRoomCode } from "./lib/ludo";

async function uniqueCode(ctx: MutationCtx): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const code = generateRoomCode();
    const existing = await ctx.db
      .query("rooms")
      .withIndex("by_code", (q) => q.eq("code", code))
      .unique();
    if (!existing) return code;
  }
  throw new Error("Could not generate room code");
}

export const createRoom = mutation({
  args: {
    clientId: v.string(),
    name: v.string(),
  },
  handler: async (ctx, args) => {
    const name = args.name.trim().slice(0, 20) || "Player";
    const code = await uniqueCode(ctx);
    const now = Date.now();
    const color = COLORS[0]!;

    const roomId = await ctx.db.insert("rooms", {
      code,
      status: "lobby",
      hostClientId: args.clientId,
      currentTurn: "red",
      diceValue: null,
      diceRolled: false,
      consecutiveSixes: 0,
      winner: null,
      lastEvent: `${name} created the room`,
      createdAt: now,
    });

    await ctx.db.insert("players", {
      roomId,
      clientId: args.clientId,
      name,
      color,
      connected: true,
      lastSeenAt: now,
    });

    return { roomId, code, color };
  },
});

export const joinRoom = mutation({
  args: {
    code: v.string(),
    clientId: v.string(),
    name: v.string(),
  },
  handler: async (ctx, args) => {
    const code = args.code.trim();
    const name = args.name.trim().slice(0, 20) || "Player";
    const room = await ctx.db
      .query("rooms")
      .withIndex("by_code", (q) => q.eq("code", code))
      .unique();

    if (!room) throw new Error("Room not found");

    const existing = await ctx.db
      .query("players")
      .withIndex("by_room_client", (q) =>
        q.eq("roomId", room._id).eq("clientId", args.clientId),
      )
      .unique();

    const now = Date.now();

    if (existing) {
      await ctx.db.patch(existing._id, {
        connected: true,
        lastSeenAt: now,
        name,
      });
      return {
        roomId: room._id,
        code: room.code,
        color: existing.color,
        reconnected: true,
      };
    }

    if (room.status !== "lobby") {
      throw new Error("Game already started");
    }

    const players = await ctx.db
      .query("players")
      .withIndex("by_room", (q) => q.eq("roomId", room._id))
      .collect();

    if (players.length >= 4) throw new Error("Room is full");

    const taken = new Set(players.map((p) => p.color));
    const color = COLORS.find((c) => !taken.has(c));
    if (!color) throw new Error("No colour available");

    await ctx.db.insert("players", {
      roomId: room._id,
      clientId: args.clientId,
      name,
      color,
      connected: true,
      lastSeenAt: now,
    });

    await ctx.db.patch(room._id, {
      lastEvent: `${name} joined as ${color}`,
    });

    return { roomId: room._id, code: room.code, color, reconnected: false };
  },
});

export const heartbeat = mutation({
  args: {
    roomId: v.id("rooms"),
    clientId: v.string(),
  },
  handler: async (ctx, args) => {
    const player = await ctx.db
      .query("players")
      .withIndex("by_room_client", (q) =>
        q.eq("roomId", args.roomId).eq("clientId", args.clientId),
      )
      .unique();
    if (!player) return;
    await ctx.db.patch(player._id, {
      connected: true,
      lastSeenAt: Date.now(),
    });
  },
});

export const markDisconnected = mutation({
  args: {
    roomId: v.id("rooms"),
    clientId: v.string(),
  },
  handler: async (ctx, args) => {
    const player = await ctx.db
      .query("players")
      .withIndex("by_room_client", (q) =>
        q.eq("roomId", args.roomId).eq("clientId", args.clientId),
      )
      .unique();
    if (!player) return;
    await ctx.db.patch(player._id, { connected: false });
  },
});

export const startGame = mutation({
  args: {
    roomId: v.id("rooms"),
    clientId: v.string(),
  },
  handler: async (ctx, args) => {
    const room = await ctx.db.get(args.roomId);
    if (!room) throw new Error("Room not found");
    if (room.hostClientId !== args.clientId) {
      throw new Error("Only the host can start");
    }
    if (room.status !== "lobby") throw new Error("Already started");

    const players = await ctx.db
      .query("players")
      .withIndex("by_room", (q) => q.eq("roomId", args.roomId))
      .collect();

    if (players.length !== 4) {
      throw new Error("Need exactly 4 players to start");
    }

    const existingTokens = await ctx.db
      .query("tokens")
      .withIndex("by_room", (q) => q.eq("roomId", args.roomId))
      .collect();
    for (const t of existingTokens) {
      await ctx.db.delete(t._id);
    }

    for (const token of createInitialTokens()) {
      await ctx.db.insert("tokens", {
        roomId: args.roomId,
        color: token.color,
        index: token.index,
        steps: token.steps,
      });
    }

    await ctx.db.patch(args.roomId, {
      status: "playing",
      currentTurn: "red",
      diceValue: null,
      diceRolled: false,
      consecutiveSixes: 0,
      winner: null,
      lastEvent: "Game started — red rolls first",
    });
  },
});

export const getRoomByCode = query({
  args: { code: v.string() },
  handler: async (ctx, args) => {
    const room = await ctx.db
      .query("rooms")
      .withIndex("by_code", (q) => q.eq("code", args.code.trim()))
      .unique();
    if (!room) return null;

    const players = await ctx.db
      .query("players")
      .withIndex("by_room", (q) => q.eq("roomId", room._id))
      .collect();

    const tokens = await ctx.db
      .query("tokens")
      .withIndex("by_room", (q) => q.eq("roomId", room._id))
      .collect();

    players.sort((a, b) => COLORS.indexOf(a.color) - COLORS.indexOf(b.color));
    tokens.sort(
      (a, b) =>
        COLORS.indexOf(a.color) - COLORS.indexOf(b.color) || a.index - b.index,
    );

    return { room, players, tokens };
  },
});

export const getRoom = query({
  args: { roomId: v.id("rooms") },
  handler: async (ctx, args) => {
    const room = await ctx.db.get(args.roomId);
    if (!room) return null;

    const players = await ctx.db
      .query("players")
      .withIndex("by_room", (q) => q.eq("roomId", args.roomId))
      .collect();

    const tokens = await ctx.db
      .query("tokens")
      .withIndex("by_room", (q) => q.eq("roomId", args.roomId))
      .collect();

    players.sort((a, b) => COLORS.indexOf(a.color) - COLORS.indexOf(b.color));
    tokens.sort(
      (a, b) =>
        COLORS.indexOf(a.color) - COLORS.indexOf(b.color) || a.index - b.index,
    );

    return { room, players, tokens };
  },
});
