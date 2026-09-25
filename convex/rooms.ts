import { mutation, query, MutationCtx, QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import {
  COLORS,
  Color,
  buildFinalRankings,
  createInitialTokens,
  generateRoomCode,
  MAX_TIMEOUT_LIVES,
  nextColorAmong,
  pickNextColor,
  shouldAssignAutomaticLoser,
  TURN_TIMEOUT_MS,
} from "./lib/ludo";
import { BOT_THINK_MS, botClientId, botDisplayName } from "./lib/bot";
import { GameError, fail } from "./lib/errors";
import { logEvent } from "./lib/log";
import {
  assertValidClientId,
  assertValidRoomCode,
  CREATE_RATE_WINDOW_MS,
  HEARTBEAT_MIN_INTERVAL_MS,
  JOIN_RATE_WINDOW_MS,
  MAX_JOINS_PER_WINDOW,
  sanitizePlayerName,
} from "./lib/session";
import { colorValidator } from "./schema";
import { freshEvents, withEvent, withEvents } from "./lib/events";
import { clearChatForRoom, requirePlayer } from "./lib/roomAuth";

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

/** Newest hosted room only — avoid scanning every room this client ever created. */
async function assertCreateNotRateLimited(
  ctx: MutationCtx,
  clientId: string,
  now: number,
) {
  const latest = await ctx.db
    .query("rooms")
    .withIndex("by_host", (q) => q.eq("hostClientId", clientId))
    .order("desc")
    .first();
  if (latest && now - latest.createdAt < CREATE_RATE_WINDOW_MS) {
    fail(GameError.rateLimited);
  }
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
    turnId: room.turnId ?? 0,
    turnStartedAt: room.turnStartedAt ?? null,
    turnTimeoutMs: TURN_TIMEOUT_MS,
    winner: room.winner,
    rankings: room.rankings ?? [],
    lastEvent: room.lastEvent,
    events: room.events ?? [],
    createdAt: room.createdAt,
    finishedAt: room.finishedAt ?? null,
    vsComputer: !!room.vsComputer,
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
    lives: p.lives ?? MAX_TIMEOUT_LIVES,
    eliminated: !!p.eliminated,
    finishRank: p.finishRank ?? null,
    isMe: sessionId !== null && p.clientId === sessionId,
    isHost: p.clientId === room.hostClientId,
    isBot: !!p.isBot,
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

function seatedFromPlayers(players: Doc<"players">[]): Color[] {
  return COLORS.filter((c) => players.some((p) => p.color === c)) as Color[];
}

/** Next host among humans only — bots must never become host. */
function pickNextHumanHost(
  players: Doc<"players">[],
): Doc<"players"> | null {
  const humans = players
    .filter((p) => !p.isBot && !p.eliminated)
    .sort((a, b) => COLORS.indexOf(a.color) - COLORS.indexOf(b.color));
  return humans[0] ?? null;
}

function playableHumans(players: Doc<"players">[]): Doc<"players">[] {
  return players.filter(
    (p) => !p.isBot && !p.eliminated && p.finishRank == null,
  );
}

async function deleteRoomCascade(
  ctx: MutationCtx,
  roomId: Id<"rooms">,
) {
  await clearChatForRoom(ctx, roomId);
  const players = await ctx.db
    .query("players")
    .withIndex("by_room", (q) => q.eq("roomId", roomId))
    .collect();
  for (const p of players) await ctx.db.delete(p._id);
  const tokens = await ctx.db
    .query("tokens")
    .withIndex("by_room", (q) => q.eq("roomId", roomId))
    .collect();
  for (const t of tokens) await ctx.db.delete(t._id);
  await ctx.db.delete(roomId);
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
  await Promise.all(existingTokens.map((t) => ctx.db.delete(t._id)));

  await Promise.all(
    createInitialTokens(activeColors).map((token) =>
      ctx.db.insert("tokens", {
        roomId,
        color: token.color,
        index: token.index,
        steps: token.steps,
      }),
    ),
  );

  const firstTurn = activeColors[0]!;
  const turnId = 1;

  // Players still have old finish state until patched below; names/colors are fine.
  const playersForNames = await ctx.db
    .query("players")
    .withIndex("by_room", (q) => q.eq("roomId", roomId))
    .collect();
  const firstPlayer = playersForNames.find((p) => p.color === firstTurn);
  const turnText = firstPlayer
    ? `${firstPlayer.name}'s turn`
    : `${firstTurn}'s turn`;

  await ctx.db.patch(roomId, {
    status: "playing",
    currentTurn: firstTurn,
    diceValue: null,
    diceRolled: false,
    consecutiveSixes: 0,
    lastMovedTokenIndex: null,
    sixStreakSnapshot: null,
    turnId,
    turnStartedAt: now,
    winner: null,
    rankings: [],
    lastActivityAt: now,
    ...freshEvents([lastEvent, turnText], now),
  });

  const players = playersForNames;
  await Promise.all(
    players.map((p) =>
      ctx.db.patch(p._id, {
        lives: MAX_TIMEOUT_LIVES,
        eliminated: false,
        finishRank: undefined,
      }),
    ),
  );

  await ctx.scheduler.runAfter(TURN_TIMEOUT_MS, internal.game.handleTurnTimeout, {
    roomId,
    turnId,
  });
  // Bots act after a short delay (no-op when the current seat is human).
  await ctx.scheduler.runAfter(BOT_THINK_MS, internal.game.playBotTurn, {
    roomId,
    turnId,
  });
}

const joinResultValidator = v.object({
  roomId: v.id("rooms"),
  code: v.string(),
  color: colorValidator,
  reconnected: v.optional(v.boolean()),
});

export const createRoom = mutation({
  args: {
    clientId: v.string(),
    name: v.string(),
  },
  returns: joinResultValidator,
  handler: async (ctx, args) => {
    const clientId = assertValidClientId(args.clientId);
    const name = sanitizePlayerName(args.name);
    const now = Date.now();

    await assertCreateNotRateLimited(ctx, clientId, now);

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
      lives: MAX_TIMEOUT_LIVES,
      eliminated: false,
    });

    logEvent("room_created", { roomCode: code, clientId });
    return { roomId, code, color };
  },
});

export const createVsComputer = mutation({
  args: {
    clientId: v.string(),
    name: v.string(),
    botCount: v.number(),
  },
  returns: joinResultValidator,
  handler: async (ctx, args) => {
    const clientId = assertValidClientId(args.clientId);
    const name = sanitizePlayerName(args.name);
    const botCount = Math.floor(args.botCount);
    if (botCount < 1 || botCount > 3) fail(GameError.invalidBotCount);

    const now = Date.now();
    await assertCreateNotRateLimited(ctx, clientId, now);

    const code = await uniqueCode(ctx);
    const hostColor = COLORS[0]!;

    const roomId = await ctx.db.insert("rooms", {
      code,
      status: "lobby",
      hostClientId: clientId,
      currentTurn: "red",
      diceValue: null,
      diceRolled: false,
      consecutiveSixes: 0,
      winner: null,
      lastEvent: `${name} vs computer`,
      createdAt: now,
      lastActivityAt: now,
      seatedColors: [hostColor],
      vsComputer: true,
    });

    await ctx.db.insert("players", {
      roomId,
      clientId,
      name,
      color: hostColor,
      connected: true,
      lastSeenAt: now,
      joinedAt: now,
      lives: MAX_TIMEOUT_LIVES,
      eliminated: false,
      isBot: false,
    });

    const seated: Color[] = [hostColor];
    const botInserts: Promise<Id<"players">>[] = [];
    for (let i = 0; i < botCount; i++) {
      const color = pickNextColor(seated);
      if (!color) break;
      seated.push(color);
      botInserts.push(
        ctx.db.insert("players", {
          roomId,
          clientId: botClientId(roomId, color),
          name: botDisplayName(i),
          color,
          connected: true,
          lastSeenAt: now,
          joinedAt: now,
          lives: MAX_TIMEOUT_LIVES,
          eliminated: false,
          isBot: true,
        }),
      );
    }
    await Promise.all(botInserts);

    await resetBoard(
      ctx,
      roomId,
      seated,
      `Game started — ${name} rolls first`,
      now,
    );
    await ctx.db.patch(roomId, { seatedColors: seated });

    logEvent("vs_computer_created", {
      roomCode: code,
      clientId,
      bots: botCount,
    });
    return { roomId, code, color: hostColor };
  },
});

export const addBot = mutation({
  args: {
    roomId: v.id("rooms"),
    clientId: v.string(),
  },
  returns: v.object({
    color: colorValidator,
  }),
  handler: async (ctx, args) => {
    const clientId = assertValidClientId(args.clientId);
    const room = await ctx.db.get(args.roomId);
    if (!room) fail(GameError.roomNotFound);
    if (room.hostClientId !== clientId) fail(GameError.onlyHost);
    if (room.status !== "lobby") fail(GameError.gameStarted);
    if (room.vsComputer) fail(GameError.vsComputerOnly);

    await requirePlayer(ctx, args.roomId, clientId);

    const players = await ctx.db
      .query("players")
      .withIndex("by_room", (q) => q.eq("roomId", args.roomId))
      .collect();
    if (players.length >= 4) fail(GameError.roomFull);

    const seated = (room.seatedColors ?? seatedFromPlayers(players)) as Color[];
    if (seated.length >= 4) fail(GameError.roomFull);

    const color = pickNextColor(seated);
    if (!color) fail(GameError.roomFull);

    const botIndex = players.filter((p) => p.isBot).length;
    const name = botDisplayName(botIndex);
    const now = Date.now();
    const nextSeated = [...seated, color];

    await ctx.db.patch(args.roomId, {
      seatedColors: nextSeated,
      lastActivityAt: now,
      lastEvent: `${name} joined`,
    });

    await ctx.db.insert("players", {
      roomId: args.roomId,
      clientId: botClientId(args.roomId, color),
      name,
      color,
      connected: true,
      lastSeenAt: now,
      joinedAt: now,
      lives: MAX_TIMEOUT_LIVES,
      eliminated: false,
      isBot: true,
    });

    // Defend against rare double-insert same colour.
    const sameColor = await ctx.db
      .query("players")
      .withIndex("by_room_color", (q) =>
        q.eq("roomId", args.roomId).eq("color", color),
      )
      .collect();
    if (sameColor.length > 1) {
      const mine = sameColor.find((p) => p.isBot && p.color === color);
      if (mine) await ctx.db.delete(mine._id);
      await ctx.db.patch(args.roomId, {
        seatedColors: seatedFromPlayers(
          await ctx.db
            .query("players")
            .withIndex("by_room", (q) => q.eq("roomId", args.roomId))
            .collect(),
        ),
      });
      fail(GameError.rateLimited);
    }

    logEvent("bot_added", { roomCode: room.code, color, clientId });
    return { color };
  },
});

export const joinRoom = mutation({
  args: {
    code: v.string(),
    clientId: v.string(),
    name: v.string(),
  },
  returns: joinResultValidator,
  handler: async (ctx, args) => {
    const clientId = assertValidClientId(args.clientId);
    const code = assertValidRoomCode(args.code);
    const name = sanitizePlayerName(args.name);
    const room = await ctx.db
      .query("rooms")
      .withIndex("by_code", (q) => q.eq("code", code))
      .unique();

    if (!room) fail(GameError.roomNotFound);

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
      logEvent("player_reconnected", {
        roomCode: room.code,
        color: existing.color,
        clientId,
      });
      return {
        roomId: room._id,
        code: room.code,
        color: existing.color,
        reconnected: true,
      };
    }

    if (room.vsComputer) fail(GameError.vsComputerOnly);

    if (room.status !== "lobby") {
      if (room.status === "finished") fail(GameError.gameFinished);
      fail(GameError.gameStarted);
    }

    // Bound the scan — only need enough recent seats to enforce the join cap.
    const mySeats = await ctx.db
      .query("players")
      .withIndex("by_client", (q) => q.eq("clientId", clientId))
      .order("desc")
      .take(MAX_JOINS_PER_WINDOW + 2);
    const recentJoins = mySeats.filter(
      (p) => now - (p.joinedAt ?? 0) < JOIN_RATE_WINDOW_MS,
    );
    if (recentJoins.length >= MAX_JOINS_PER_WINDOW) {
      fail(GameError.rateLimited);
    }

    const players = await ctx.db
      .query("players")
      .withIndex("by_room", (q) => q.eq("roomId", room._id))
      .collect();

    if (players.length >= 4) fail(GameError.roomFull);

    const seated = (room.seatedColors ?? seatedFromPlayers(players)) as Color[];
    if (seated.length >= 4) fail(GameError.roomFull);

    const color = pickNextColor(seated);
    if (!color) fail(GameError.roomFull);

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
      lives: MAX_TIMEOUT_LIVES,
      eliminated: false,
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
      fail(GameError.rateLimited);
    }

    logEvent("player_joined", { roomCode: room.code, color, clientId });
    return { roomId: room._id, code: room.code, color, reconnected: false };
  },
});

export const heartbeat = mutation({
  args: {
    roomId: v.id("rooms"),
    clientId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const clientId = assertValidClientId(args.clientId);
    const player = await ctx.db
      .query("players")
      .withIndex("by_room_client", (q) =>
        q.eq("roomId", args.roomId).eq("clientId", clientId),
      )
      .unique();
    if (!player) return null;
    const now = Date.now();
    // Soft rate limit — ignore floods without erroring.
    if (now - player.lastSeenAt < HEARTBEAT_MIN_INTERVAL_MS) return null;
    await ctx.db.patch(player._id, {
      connected: true,
      lastSeenAt: now,
    });
    return null;
  },
});

export const markDisconnected = mutation({
  args: {
    roomId: v.id("rooms"),
    clientId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    let clientId: string;
    try {
      clientId = assertValidClientId(args.clientId);
    } catch {
      return null;
    }
    const player = await ctx.db
      .query("players")
      .withIndex("by_room_client", (q) =>
        q.eq("roomId", args.roomId).eq("clientId", clientId),
      )
      .unique();
    if (!player) return null;
    await ctx.db.patch(player._id, { connected: false });
    logEvent("player_disconnected", {
      color: player.color,
      clientId,
    });
    return null;
  },
});

const leaveResultValidator = v.object({
  emptied: v.boolean(),
});

export const leaveRoom = mutation({
  args: {
    roomId: v.id("rooms"),
    clientId: v.string(),
  },
  returns: leaveResultValidator,
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
    logEvent("player_left", {
      roomCode: room.code,
      color: player.color,
      status: room.status,
      clientId,
    });

    // Solo vs-computer: human leaving ends the room (bots alone are useless).
    if (room.vsComputer && !player.isBot) {
      await deleteRoomCascade(ctx, args.roomId);
      return { emptied: true };
    }

    if (room.status === "playing") {
      // Forfeit: keep the seat so final rankings can show their name last.
      const color = player.color as Color;
      if (player.eliminated) {
        await ctx.db.delete(player._id);
        return { emptied: false };
      }

      const allPlayers = await ctx.db
        .query("players")
        .withIndex("by_room", (q) => q.eq("roomId", args.roomId))
        .collect();
      const playableBefore = allPlayers.filter(
        (p) => !p.eliminated && p.finishRank == null,
      );
      const place =
        (room.rankings?.length ?? 0) + playableBefore.length; // later leavers get worse ranks after finishers

      await ctx.db.patch(player._id, {
        eliminated: true,
        connected: false,
        lives: 0,
        finishRank: place,
        lastSeenAt: now,
      });

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
      const playable = remaining.filter(
        (p) => !p.eliminated && p.finishRank == null,
      );
      const stillSeated = remaining.filter((p) => !p.eliminated);
      const seated = seatedFromPlayers(remaining);
      const leaveText = `${player.name} left the game`;
      const patches: Record<string, unknown> = {
        seatedColors: seated,
        lastActivityAt: now,
        ...withEvent(room, leaveText, now),
      };

      // No playable humans left — tear down (bots must not finish alone).
      if (playableHumans(remaining).length === 0) {
        await deleteRoomCascade(ctx, args.roomId);
        return { emptied: true };
      }

      const hostStillSeated = remaining.some(
        (p) =>
          p.clientId === room.hostClientId &&
          !p.eliminated &&
          !p.isBot,
      );
      if (!hostStillSeated) {
        const nextHost = pickNextHumanHost(stillSeated);
        if (nextHost) patches.hostClientId = nextHost.clientId;
      }

      if (stillSeated.length === 0) {
        await deleteRoomCascade(ctx, args.roomId);
        return { emptied: true };
      }

      // Sole remaining active seat wins only when everyone else forfeited.
      if (playable.length === 1 && remaining.every((p) => p._id === playable[0]!._id || p.eliminated)) {
        const sole = playable[0]!;
        const rankings = buildFinalRankings(
          room.rankings ?? [],
          sole.color as Color,
          remaining.map((p) => ({
            color: p.color as Color,
            finishRank: p.finishRank,
          })),
        );
        await ctx.db.patch(sole._id, {
          finishRank: rankings.indexOf(sole.color as Color) + 1,
        });
        patches.status = "finished";
        patches.winner = sole.color;
        patches.finishedAt = now;
        patches.diceRolled = false;
        patches.rankings = rankings;
        patches.sixStreakSnapshot = null;
        Object.assign(
          patches,
          withEvents(
            room,
            [leaveText, `${sole.name} wins — ${player.name} left`],
            now,
          ),
        );
        await ctx.db.patch(args.roomId, patches);
        logEvent("game_finished", {
          roomCode: room.code,
          winner: sole.color,
          reason: "forfeit",
        });
        return { emptied: false };
      }

      // N−1 home finishers already ranked — remaining seat is automatic loser.
      if (shouldAssignAutomaticLoser(remaining)) {
        const loser = playable[0]!;
        const rankings = [...(room.rankings ?? [])];
        if (!rankings.includes(loser.color as Color)) {
          rankings.push(loser.color as Color);
        }
        for (const p of remaining) {
          if (!rankings.includes(p.color as Color)) {
            rankings.push(p.color as Color);
          }
        }
        const loserRank = rankings.indexOf(loser.color as Color) + 1;
        await ctx.db.patch(loser._id, { finishRank: loserRank });
        patches.status = "finished";
        patches.winner = rankings[0] ?? room.winner;
        patches.finishedAt = now;
        patches.diceRolled = false;
        patches.rankings = rankings;
        patches.sixStreakSnapshot = null;
        Object.assign(
          patches,
          withEvents(
            room,
            [leaveText, `${loser.name} places #${loserRank} — match over`],
            now,
          ),
        );
        await ctx.db.patch(args.roomId, patches);
        logEvent("game_finished", {
          roomCode: room.code,
          winner: rankings[0] ?? null,
          reason: "automatic_loser",
        });
        return { emptied: false };
      }

      // Everyone finished or left — close the match.
      if (playable.length === 0) {
        const rankings =
          (room.rankings ?? []).length > 0
            ? [...(room.rankings ?? [])]
            : remaining
                .filter((p) => p.finishRank != null)
                .sort(
                  (a, b) => (a.finishRank ?? 99) - (b.finishRank ?? 99),
                )
                .map((p) => p.color as Color);
        for (const p of remaining) {
          if (!rankings.includes(p.color as Color)) {
            rankings.push(p.color as Color);
          }
        }
        patches.status = "finished";
        patches.winner = rankings[0] ?? room.winner;
        patches.finishedAt = now;
        patches.diceRolled = false;
        patches.rankings = rankings;
        patches.sixStreakSnapshot = null;
        Object.assign(
          patches,
          withEvents(room, [leaveText, "Match complete"], now),
        );
        await ctx.db.patch(args.roomId, patches);
        return { emptied: false };
      }

      if (
        room.currentTurn === color ||
        !playable.some((p) => p.color === room.currentTurn)
      ) {
        const nextTurn = nextColorAmong(
          color,
          playable.map((p) => p.color as Color),
        );
        const turnId = (room.turnId ?? 0) + 1;
        const nextPlayer = playable.find((p) => p.color === nextTurn);
        const turnText = nextPlayer
          ? `${nextPlayer.name}'s turn`
          : `${nextTurn}'s turn`;
        patches.currentTurn = nextTurn;
        patches.diceRolled = false;
        patches.diceValue = null;
        patches.consecutiveSixes = 0;
        patches.turnId = turnId;
        patches.turnStartedAt = now;
        patches.lastMovedTokenIndex = null;
        patches.sixStreakSnapshot = null;
        Object.assign(
          patches,
          withEvents(room, [leaveText, turnText], now),
        );

        await ctx.db.patch(args.roomId, patches);
        await ctx.scheduler.runAfter(
          TURN_TIMEOUT_MS,
          internal.game.handleTurnTimeout,
          { roomId: args.roomId, turnId },
        );
        await ctx.scheduler.runAfter(BOT_THINK_MS, internal.game.playBotTurn, {
          roomId: args.roomId,
          turnId,
        });
        return { emptied: false };
      }

      await ctx.db.patch(args.roomId, patches);
      return { emptied: false };
    }

    await ctx.db.delete(player._id);

    const remaining = await ctx.db
      .query("players")
      .withIndex("by_room", (q) => q.eq("roomId", args.roomId))
      .collect();

    if (remaining.length === 0 || !remaining.some((p) => !p.isBot)) {
      await deleteRoomCascade(ctx, args.roomId);
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
      const nextHost = pickNextHumanHost(remaining);
      if (nextHost) {
        patches.hostClientId = nextHost.clientId;
        patches.lastEvent = `${player.name} left — ${nextHost.name} is host`;
      }
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
  returns: v.null(),
  handler: async (ctx, args) => {
    const clientId = assertValidClientId(args.clientId);
    const room = await ctx.db.get(args.roomId);
    if (!room) fail(GameError.roomNotFound);
    if (room.hostClientId !== clientId) {
      fail(GameError.onlyHost);
    }
    if (room.status !== "lobby") {
      fail(GameError.gameStarted);
    }

    const target = await ctx.db
      .query("players")
      .withIndex("by_room_color", (q) =>
        q.eq("roomId", args.roomId).eq("color", args.targetColor),
      )
      .unique();
    if (!target) fail(GameError.notInRoom);
    if (target.clientId === clientId) {
      fail(GameError.onlyHost);
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
    logEvent("player_kicked", {
      roomCode: room.code,
      color: target.color,
      clientId,
    });
    return null;
  },
});

export const startGame = mutation({
  args: {
    roomId: v.id("rooms"),
    clientId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const clientId = assertValidClientId(args.clientId);
    const room = await ctx.db.get(args.roomId);
    if (!room) fail(GameError.roomNotFound);
    if (room.hostClientId !== clientId) {
      fail(GameError.onlyHost);
    }
    if (room.status !== "lobby") fail(GameError.gameStarted);

    const players = await ctx.db
      .query("players")
      .withIndex("by_room", (q) => q.eq("roomId", args.roomId))
      .collect();

    if (players.length < 2) {
      fail(GameError.needPlayers);
    }
    if (players.length > 4) {
      fail(GameError.roomFull);
    }

    const activeColors = seatedFromPlayers(players);
    const now = Date.now();
    const first = players.find((p) => p.color === activeColors[0]);
    await resetBoard(
      ctx,
      args.roomId,
      activeColors,
      `Game started — ${first?.name ?? activeColors[0]} rolls first`,
      now,
    );
    await ctx.db.patch(args.roomId, { seatedColors: activeColors });
    logEvent("game_started", {
      roomCode: room.code,
      players: players.length,
      clientId,
    });
    return null;
  },
});

export const rematch = mutation({
  args: {
    roomId: v.id("rooms"),
    clientId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const clientId = assertValidClientId(args.clientId);
    const room = await ctx.db.get(args.roomId);
    if (!room) fail(GameError.roomNotFound);
    if (room.status !== "finished") {
      fail(GameError.notFinished);
    }
    if (room.hostClientId !== clientId) {
      fail(GameError.onlyHost);
    }
    await requirePlayer(ctx, args.roomId, clientId);

    const now = Date.now();
    const STALE_SEAT_MS = 90_000;
    const players = await ctx.db
      .query("players")
      .withIndex("by_room", (q) => q.eq("roomId", args.roomId))
      .collect();

    // Drop forfeits who already left, and seats away since before the finish.
    // Keep bots — they never "go away".
    for (const p of players) {
      if (p.isBot) continue;
      const forfeitGone = !!p.eliminated && !p.connected;
      const staleAway = !p.connected && now - p.lastSeenAt > STALE_SEAT_MS;
      if (forfeitGone || staleAway) {
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
      fail(GameError.needPlayers);
    }
    if (!remaining.some((p) => !p.isBot)) {
      fail(GameError.needPlayers);
    }

    const activeColors = seatedFromPlayers(remaining);
    const first = remaining.find((p) => p.color === activeColors[0]);
    await resetBoard(
      ctx,
      args.roomId,
      activeColors,
      `Rematch — ${first?.name ?? activeColors[0]} rolls first`,
      now,
    );
    await clearChatForRoom(ctx, args.roomId);
    await ctx.db.patch(args.roomId, { seatedColors: activeColors });
    logEvent("game_started", {
      roomCode: room.code,
      players: remaining.length,
      rematch: true,
      clientId,
    });
    return null;
  },
});

const roomBundleValidator = v.union(
  v.object({
    room: v.object({
      _id: v.id("rooms"),
      code: v.string(),
      status: v.union(
        v.literal("lobby"),
        v.literal("playing"),
        v.literal("finished"),
      ),
      currentTurn: colorValidator,
      diceValue: v.union(v.number(), v.null()),
      diceRolled: v.boolean(),
      consecutiveSixes: v.number(),
      turnId: v.number(),
      turnStartedAt: v.union(v.number(), v.null()),
      turnTimeoutMs: v.number(),
      winner: v.union(colorValidator, v.null()),
      rankings: v.array(colorValidator),
      lastEvent: v.optional(v.string()),
      events: v.array(
        v.object({
          at: v.number(),
          text: v.string(),
        }),
      ),
      createdAt: v.number(),
      finishedAt: v.union(v.number(), v.null()),
      vsComputer: v.boolean(),
    }),
    players: v.array(
      v.object({
        _id: v.id("players"),
        name: v.string(),
        color: colorValidator,
        connected: v.boolean(),
        lives: v.number(),
        eliminated: v.boolean(),
        finishRank: v.union(v.number(), v.null()),
        isMe: v.boolean(),
        isHost: v.boolean(),
        isBot: v.boolean(),
      }),
    ),
    tokens: v.array(
      v.object({
        _id: v.id("tokens"),
        color: colorValidator,
        index: v.number(),
        steps: v.number(),
      }),
    ),
    me: v.union(
      v.object({
        color: colorValidator,
        name: v.string(),
        isHost: v.boolean(),
      }),
      v.null(),
    ),
  }),
  v.null(),
);

export const getRoomByCode = query({
  args: {
    code: v.string(),
    clientId: v.optional(v.string()),
  },
  returns: roomBundleValidator,
  handler: async (ctx, args) => {
    let code: string;
    try {
      code = assertValidRoomCode(args.code);
    } catch {
      return null;
    }
    const room = await ctx.db
      .query("rooms")
      .withIndex("by_code", (q) => q.eq("code", code))
      .unique();
    if (!room) return null;
    let session: string | null = null;
    if (args.clientId) {
      try {
        session = assertValidClientId(args.clientId);
      } catch {
        session = null;
      }
    }
    return loadRoomBundle(ctx, room, session);
  },
});

export const getRoom = query({
  args: {
    roomId: v.id("rooms"),
    clientId: v.optional(v.string()),
  },
  returns: roomBundleValidator,
  handler: async (ctx, args) => {
    const room = await ctx.db.get(args.roomId);
    if (!room) return null;
    let session: string | null = null;
    if (args.clientId) {
      try {
        session = assertValidClientId(args.clientId);
      } catch {
        session = null;
      }
    }
    return loadRoomBundle(ctx, room, session);
  },
});
