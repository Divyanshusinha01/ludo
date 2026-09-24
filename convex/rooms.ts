import { mutation, query, MutationCtx, QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { Doc, Id } from "./_generated/dataModel";
import {
  COLORS,
  Color,
  createInitialTokens,
  generateRoomCode,
  nextColorAmong,
  pickNextColor,
} from "./lib/ludo";
import { assertValidClientId, CREATE_RATE_WINDOW_MS, JOIN_RATE_WINDOW_MS, MAX_JOINS_PER_WINDOW } from "./lib/session";
import { colorValidator } from "./schema";

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

function publicRoom(room: Doc<"rooms">) {
  return {
    _id: room._id,
    code: room.code,
    status: room.status,
    currentTurn: room.currentTurn,
    diceValue: room.diceValue,
    diceRolled: room.diceRolled,
    consecutiveSixes: room.consecutiveSixes,
    winner: room.winner,
    lastEvent: room.lastEvent,
    createdAt: room.createdAt,
    finishedAt: room.finishedAt ?? null,
  };
}

function publicPlayers(
  players: Doc<"players">[],
  room: Doc<"rooms">,
  sessionId: string | null,
) {
  return players.map((p) => ({
    _id: p._id,
    name: p.name,
    color: p.color,
    connected: p.connected,
    isMe: sessionId !== null && p.clientId === sessionId,
    isHost: p.clientId === room.hostClientId,
  }));
}

async function loadRoomBundle(
  ctx: QueryCtx,
  room: Doc<"rooms">,
  sessionId: string | null,
) {
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

  const me = sessionId
    ? (players.find((p) => p.clientId === sessionId) ?? null)
    : null;

  return {
    room: publicRoom(room),
    players: publicPlayers(players, room, sessionId),
    tokens: tokens.map((t) => ({
      _id: t._id,
      color: t.color,
      index: t.index,
      steps: t.steps,
    })),
    me: me
      ? {
          color: me.color as Color,
          name: me.name,
          isHost: me.clientId === room.hostClientId,
        }
      : null,
  };
}

async function requirePlayer(
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
  if (!player) throw new Error("Not in this room");
  return player;
}

function seatedFromPlayers(players: Doc<"players">[]): Color[] {
  return COLORS.filter((c) => players.some((p) => p.color === c)) as Color[];
}

async function resetBoard(
  ctx: MutationCtx,
  roomId: Id<"rooms">,
  activeColors: Color[],
  lastEvent: string,
  now: number,
) {
  const existingTokens = await ctx.db
    .query("tokens")
    .withIndex("by_room", (q) => q.eq("roomId", roomId))
    .collect();
  for (const t of existingTokens) {
    await ctx.db.delete(t._id);
  }

  for (const token of createInitialTokens(activeColors)) {
    await ctx.db.insert("tokens", {
      roomId,
      color: token.color,
      index: token.index,
      steps: token.steps,
    });
  }

  const firstTurn = activeColors[0]!;
  await ctx.db.patch(roomId, {
    status: "playing",
    currentTurn: firstTurn,
    diceValue: null,
    diceRolled: false,
    consecutiveSixes: 0,
    winner: null,
    lastActivityAt: now,
    lastEvent,
  });
}

export const createRoom = mutation({
  args: {
    clientId: v.string(),
    name: v.string(),
  },
  handler: async (ctx, args) => {
    const clientId = assertValidClientId(args.clientId);
    const name = args.name.trim().slice(0, 20) || "Player";
    const now = Date.now();

    const hosted = await ctx.db
      .query("rooms")
      .withIndex("by_host", (q) => q.eq("hostClientId", clientId))
      .collect();
    const recent = hosted.some(
      (r) => now - r.createdAt < CREATE_RATE_WINDOW_MS,
    );
    if (recent) throw new Error("Slow down — try again in a moment");

    const code = await uniqueCode(ctx);
    const color = COLORS[0]!;

    const roomId = await ctx.db.insert("rooms", {
      code,
      status: "lobby",
      hostClientId: clientId,
      currentTurn: "red",
      diceValue: null,
      diceRolled: false,
      consecutiveSixes: 0,
      winner: null,
      lastEvent: `${name} created the room`,
      createdAt: now,
      lastActivityAt: now,
      seatedColors: [color],
    });

    await ctx.db.insert("players", {
      roomId,
      clientId,
      name,
      color,
      connected: true,
      lastSeenAt: now,
      joinedAt: now,
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
    const clientId = assertValidClientId(args.clientId);
    const code = args.code.trim().toUpperCase();
    const name = args.name.trim().slice(0, 20) || "Player";
    const room = await ctx.db
      .query("rooms")
      .withIndex("by_code", (q) => q.eq("code", code))
      .unique();

    if (!room) throw new Error("Room not found");

    const existing = await ctx.db
      .query("players")
      .withIndex("by_room_client", (q) =>
        q.eq("roomId", room._id).eq("clientId", clientId),
      )
      .unique();

    const now = Date.now();

    if (existing) {
      await ctx.db.patch(existing._id, {
        connected: true,
        lastSeenAt: now,
        name,
      });
      await ctx.db.patch(room._id, { lastActivityAt: now });
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

    const mySeats = await ctx.db
      .query("players")
      .withIndex("by_client", (q) => q.eq("clientId", clientId))
      .collect();
    const recentJoins = mySeats.filter(
      (p) => now - (p.joinedAt ?? 0) < JOIN_RATE_WINDOW_MS,
    );
    if (recentJoins.length >= MAX_JOINS_PER_WINDOW) {
      throw new Error("Slow down — try again in a moment");
    }

    const players = await ctx.db
      .query("players")
      .withIndex("by_room", (q) => q.eq("roomId", room._id))
      .collect();

    if (players.length >= 4) throw new Error("Room is full");

    const seated = (room.seatedColors ?? seatedFromPlayers(players)) as Color[];
    if (seated.length >= 4) throw new Error("Room is full");

    const color = pickNextColor(seated);
    if (!color) throw new Error("No colour available");

    const nextSeated = [...seated, color];
    // OCC lock: concurrent joins both patch seatedColors; one retries.
    await ctx.db.patch(room._id, {
      seatedColors: nextSeated,
      lastActivityAt: now,
      lastEvent: `${name} joined as ${color}`,
    });

    await ctx.db.insert("players", {
      roomId: room._id,
      clientId,
      name,
      color,
      connected: true,
      lastSeenAt: now,
      joinedAt: now,
    });

    // Defend against rare double-insert same colour.
    const sameColor = await ctx.db
      .query("players")
      .withIndex("by_room_color", (q) =>
        q.eq("roomId", room._id).eq("color", color),
      )
      .collect();
    if (sameColor.length > 1) {
      const mine = sameColor.find((p) => p.clientId === clientId);
      if (mine) await ctx.db.delete(mine._id);
      await ctx.db.patch(room._id, {
        seatedColors: seatedFromPlayers(
          await ctx.db
            .query("players")
            .withIndex("by_room", (q) => q.eq("roomId", room._id))
            .collect(),
        ),
      });
      throw new Error("Could not join — try again");
    }

    return { roomId: room._id, code: room.code, color, reconnected: false };
  },
});

export const heartbeat = mutation({
  args: {
    roomId: v.id("rooms"),
    clientId: v.string(),
  },
  handler: async (ctx, args) => {
    const clientId = assertValidClientId(args.clientId);
    const player = await ctx.db
      .query("players")
      .withIndex("by_room_client", (q) =>
        q.eq("roomId", args.roomId).eq("clientId", clientId),
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
    let clientId: string;
    try {
      clientId = assertValidClientId(args.clientId);
    } catch {
      return;
    }
    const player = await ctx.db
      .query("players")
      .withIndex("by_room_client", (q) =>
        q.eq("roomId", args.roomId).eq("clientId", clientId),
      )
      .unique();
    if (!player) return;
    await ctx.db.patch(player._id, { connected: false });
  },
});

export const leaveRoom = mutation({
  args: {
    roomId: v.id("rooms"),
    clientId: v.string(),
  },
  handler: async (ctx, args) => {
    const clientId = assertValidClientId(args.clientId);
    const room = await ctx.db.get(args.roomId);
    if (!room) return { emptied: true };

    const player = await ctx.db
      .query("players")
      .withIndex("by_room_client", (q) =>
        q.eq("roomId", args.roomId).eq("clientId", clientId),
      )
      .unique();
    if (!player) return { emptied: false };

    const now = Date.now();

    if (room.status === "playing") {
      // Forfeit: remove seat and tokens so turns no longer cycle ghosts.
      const color = player.color as Color;
      await ctx.db.delete(player._id);

      const tokens = await ctx.db
        .query("tokens")
        .withIndex("by_room_color", (q) =>
          q.eq("roomId", args.roomId).eq("color", color),
        )
        .collect();
      for (const t of tokens) await ctx.db.delete(t._id);

      const remaining = await ctx.db
        .query("players")
        .withIndex("by_room", (q) => q.eq("roomId", args.roomId))
        .collect();

      const seated = seatedFromPlayers(remaining);
      const patches: Record<string, unknown> = {
        seatedColors: seated,
        lastActivityAt: now,
        lastEvent: `${player.name} left the game`,
      };

      if (room.hostClientId === clientId && remaining.length > 0) {
        const nextHost = remaining.sort(
          (a, b) => COLORS.indexOf(a.color) - COLORS.indexOf(b.color),
        )[0]!;
        patches.hostClientId = nextHost.clientId;
      }

      if (remaining.length === 0) {
        const tok = await ctx.db
          .query("tokens")
          .withIndex("by_room", (q) => q.eq("roomId", args.roomId))
          .collect();
        for (const t of tok) await ctx.db.delete(t._id);
        await ctx.db.delete(args.roomId);
        return { emptied: true };
      }

      if (remaining.length === 1) {
        const sole = remaining[0]!;
        patches.status = "finished";
        patches.winner = sole.color;
        patches.finishedAt = now;
        patches.diceRolled = false;
        patches.lastEvent = `${sole.name} wins — ${player.name} left`;
      } else if (room.currentTurn === color) {
        patches.currentTurn = nextColorAmong(color, seated);
        patches.diceRolled = false;
        patches.diceValue = null;
        patches.consecutiveSixes = 0;
      }

      await ctx.db.patch(args.roomId, patches);
      return { emptied: false };
    }

    await ctx.db.delete(player._id);

    const remaining = await ctx.db
      .query("players")
      .withIndex("by_room", (q) => q.eq("roomId", args.roomId))
      .collect();

    if (remaining.length === 0) {
      const tokens = await ctx.db
        .query("tokens")
        .withIndex("by_room", (q) => q.eq("roomId", args.roomId))
        .collect();
      for (const t of tokens) await ctx.db.delete(t._id);
      await ctx.db.delete(args.roomId);
      return { emptied: true };
    }

    const seated = seatedFromPlayers(remaining);
    const patches: {
      hostClientId?: string;
      lastEvent: string;
      seatedColors: Color[];
      lastActivityAt: number;
    } = {
      lastEvent: `${player.name} left`,
      seatedColors: seated,
      lastActivityAt: now,
    };
    if (room.hostClientId === clientId) {
      const nextHost = remaining.sort(
        (a, b) => COLORS.indexOf(a.color) - COLORS.indexOf(b.color),
      )[0]!;
      patches.hostClientId = nextHost.clientId;
      patches.lastEvent = `${player.name} left — ${nextHost.name} is host`;
    }
    await ctx.db.patch(args.roomId, patches);
    return { emptied: false };
  },
});

export const kickPlayer = mutation({
  args: {
    roomId: v.id("rooms"),
    clientId: v.string(),
    targetColor: colorValidator,
  },
  handler: async (ctx, args) => {
    const clientId = assertValidClientId(args.clientId);
    const room = await ctx.db.get(args.roomId);
    if (!room) throw new Error("Room not found");
    if (room.hostClientId !== clientId) {
      throw new Error("Only the host can kick");
    }
    if (room.status !== "lobby") {
      throw new Error("Can only kick in lobby");
    }

    const target = await ctx.db
      .query("players")
      .withIndex("by_room_color", (q) =>
        q.eq("roomId", args.roomId).eq("color", args.targetColor),
      )
      .unique();
    if (!target) throw new Error("Player not found");
    if (target.clientId === clientId) {
      throw new Error("Host cannot kick themselves");
    }

    await ctx.db.delete(target._id);
    const remaining = await ctx.db
      .query("players")
      .withIndex("by_room", (q) => q.eq("roomId", args.roomId))
      .collect();
    await ctx.db.patch(args.roomId, {
      seatedColors: seatedFromPlayers(remaining),
      lastActivityAt: Date.now(),
      lastEvent: `${target.name} was removed`,
    });
  },
});

export const startGame = mutation({
  args: {
    roomId: v.id("rooms"),
    clientId: v.string(),
  },
  handler: async (ctx, args) => {
    const clientId = assertValidClientId(args.clientId);
    const room = await ctx.db.get(args.roomId);
    if (!room) throw new Error("Room not found");
    if (room.hostClientId !== clientId) {
      throw new Error("Only the host can start");
    }
    if (room.status !== "lobby") throw new Error("Already started");

    const players = await ctx.db
      .query("players")
      .withIndex("by_room", (q) => q.eq("roomId", args.roomId))
      .collect();

    if (players.length < 2) {
      throw new Error("Need at least 2 players to start");
    }
    if (players.length > 4) {
      throw new Error("Too many players");
    }

    const activeColors = seatedFromPlayers(players);
    const now = Date.now();
    await resetBoard(
      ctx,
      args.roomId,
      activeColors,
      `Game started — ${activeColors[0]} rolls first`,
      now,
    );
    await ctx.db.patch(args.roomId, { seatedColors: activeColors });
  },
});

export const rematch = mutation({
  args: {
    roomId: v.id("rooms"),
    clientId: v.string(),
  },
  handler: async (ctx, args) => {
    const clientId = assertValidClientId(args.clientId);
    const room = await ctx.db.get(args.roomId);
    if (!room) throw new Error("Room not found");
    if (room.status !== "finished") {
      throw new Error("Game is not finished");
    }
    if (room.hostClientId !== clientId) {
      throw new Error("Only the host can start a rematch");
    }
    await requirePlayer(ctx, args.roomId, clientId);

    const now = Date.now();
    const STALE_SEAT_MS = 90_000;
    const players = await ctx.db
      .query("players")
      .withIndex("by_room", (q) => q.eq("roomId", args.roomId))
      .collect();

    // Drop seats that have been away since before the finish.
    for (const p of players) {
      if (!p.connected && now - p.lastSeenAt > STALE_SEAT_MS) {
        await ctx.db.delete(p._id);
        const tokens = await ctx.db
          .query("tokens")
          .withIndex("by_room_color", (q) =>
            q.eq("roomId", args.roomId).eq("color", p.color),
          )
          .collect();
        for (const t of tokens) await ctx.db.delete(t._id);
      }
    }

    const remaining = await ctx.db
      .query("players")
      .withIndex("by_room", (q) => q.eq("roomId", args.roomId))
      .collect();
    if (remaining.length < 2) {
      throw new Error("Need at least 2 players for a rematch");
    }

    const activeColors = seatedFromPlayers(remaining);
    await resetBoard(
      ctx,
      args.roomId,
      activeColors,
      `Rematch — ${activeColors[0]} rolls first`,
      now,
    );
    await ctx.db.patch(args.roomId, { seatedColors: activeColors });
  },
});

export const getRoomByCode = query({
  args: {
    code: v.string(),
    clientId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const room = await ctx.db
      .query("rooms")
      .withIndex("by_code", (q) =>
        q.eq("code", args.code.trim().toUpperCase()),
      )
      .unique();
    if (!room) return null;
    const session = args.clientId?.trim() || null;
    return loadRoomBundle(ctx, room, session);
  },
});

export const getRoom = query({
  args: {
    roomId: v.id("rooms"),
    clientId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const room = await ctx.db.get(args.roomId);
    if (!room) return null;
    const session = args.clientId?.trim() || null;
    return loadRoomBundle(ctx, room, session);
  },
});
