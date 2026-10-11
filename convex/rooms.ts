import { mutation, query, MutationCtx, QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { Doc, Id } from "./_generated/dataModel";
import {
  COLORS,
  Color,
  MAX_TIMEOUT_LIVES,
  pickNextColor,
  pickNextColorForTeam,
  teamOfColor,
  TURN_TIMEOUT_MS,
  Team,
} from "./lib/ludo";
import { botClientId, botDisplayName } from "./lib/bot";
import { GameError, fail } from "./lib/errors";
import { logEvent, withOutcomeLogging } from "./lib/log";
import { recordSample } from "./lib/metrics";
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
import { optionalAccount } from "./lib/auth";
import {
  clearChatForRoom,
  clearVoiceForColor,
  clearVoiceForRoom,
  deleteRoomCascade,
  requirePlayer,
} from "./lib/roomAuth";
import {
  commitCommand,
  commitEventsBootstrap,
  commitEvents,
  assertEventSourcedRoom,
} from "./lib/gameStore";
import {
  CURRENT_RULES_VERSION,
  type LudoEventDraft,
} from "./lib/game/eventValidators";
import {
  buildMatchStartDrafts,
  createStartedRoom,
  playerJoinedDraft,
  seatedFromPlayers,
  uniqueCode,
  type StartedSeat,
} from "./lib/roomFactory";
import { SEAT_LIVE_MS } from "./lib/matchmaking";

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
    eventSeq: room.eventSeq ?? 0,
    createdAt: room.createdAt,
    finishedAt: room.finishedAt ?? null,
    vsComputer: !!room.vsComputer,
    ranked: !!room.ranked,
    mode: room.mode === "2v2" ? ("2v2" as const) : ("1v1" as const),
    winningTeam: room.winningTeam ?? null,
    passedRollTo: room.passedRollTo ?? null,
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
    team: p.team ?? null,
  }));
}

function countOnTeam(players: Doc<"players">[], team: Team): number {
  return players.filter((p) => p.team === team).length;
}

/** Public room view. A null session (spectators) yields no `me` and every `isMe` false. */
export async function loadRoomBundle(
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

function playerLeftDraft(
  roomId: Id<"rooms">,
  color: Color,
  reason: "left" | "kicked",
  now: number,
): LudoEventDraft {
  return {
    gameId: roomId,
    createdAt: now,
    actor: reason === "left" ? { kind: "seat", color } : { kind: "system" },
    eventType: "PLAYER_LEFT",
    payload: { color, reason },
  };
}

/** Next host among humans only — bots must never become host. */
function pickNextHumanHost(
  players: Doc<"players">[],
): Doc<"players"> | null {
  const humans = players
    .filter((p) => !p.isBot && !p.eliminated && p.leftAt === undefined)
    .sort((a, b) => COLORS.indexOf(a.color) - COLORS.indexOf(b.color));
  return humans[0] ?? null;
}

function playableHumans(players: Doc<"players">[]): Doc<"players">[] {
  return players.filter(
    (p) => !p.isBot && !p.eliminated && p.finishRank == null,
  );
}

const joinResultValidator = v.union(
  v.object({
    roomId: v.id("rooms"),
    code: v.string(),
    color: colorValidator,
    reconnected: v.optional(v.boolean()),
  }),
  v.object({
    pending: v.literal(true),
    requestId: v.id("rejoinRequests"),
  }),
);

function namesMatch(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

async function claimDisconnectedSeat(
  ctx: MutationCtx,
  seat: Doc<"players">,
  room: Doc<"rooms">,
  clientId: string,
  now: number,
) {
  // The seat keeps its name: names are part of the event-sourced seat snapshot.
  await ctx.db.patch(seat._id, {
    clientId,
    connected: true,
    lastSeenAt: now,
  });
  // If this seat was the previous host and room still points at old id, keep host.
  // Host stays whoever currently holds hostClientId; reclaiming does not steal it
  // unless the room's hostClientId still equals the old seat clientId.
  if (room.hostClientId === seat.clientId) {
    await ctx.db.patch(room._id, {
      hostClientId: clientId,
      lastActivityAt: now,
    });
  } else {
    await ctx.db.patch(room._id, { lastActivityAt: now });
  }
  // Resolve any pending rejoin requests for this seat.
  const pending = await ctx.db
    .query("rejoinRequests")
    .withIndex("by_player", (q) => q.eq("playerId", seat._id))
    .collect();
  for (const req of pending) {
    if (req.status === "pending") {
      await ctx.db.patch(req._id, {
        status: "approved",
        resolvedAt: now,
      });
    }
  }
  logEvent("player_reconnected", {
    roomCode: room.code,
    color: seat.color,
    clientId,
  });
  await recordSample(ctx, { kind: "reconnect", at: now });
  return {
    roomId: room._id,
    code: room.code,
    color: seat.color,
    reconnected: true as const,
  };
}

export const createRoom = mutation({
  args: {
    clientId: v.string(),
    name: v.string(),
    mode: v.optional(v.union(v.literal("1v1"), v.literal("2v2"))),
  },
  returns: joinResultValidator,
  handler: (ctx, args) => withOutcomeLogging(ctx, "rooms:createRoom", undefined, async () => {
    const clientId = assertValidClientId(args.clientId);
    const now = Date.now();
    const signedIn = await optionalAccount(ctx, now);
    const name = sanitizePlayerName(args.name, signedIn?.profile.displayName);
    const gameMode = args.mode === "2v2" ? "2v2" : "1v1";

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
      mode: gameMode,
      lastEvent: `${name} created the room`,
      createdAt: now,
      lastActivityAt: now,
      seatedColors: [color],
      eventSeq: 0,
      rulesVersion: CURRENT_RULES_VERSION,
    });

    const hostSeat = {
      color,
      name,
      isBot: false,
      ...(gameMode === "2v2" ? { team: "A" as const } : {}),
    };
    // Commit before seating: the projection is read from player rows, so the
    // reducer must see the lobby as it was before this seat existed.
    await commitEventsBootstrap(
      ctx,
      roomId,
      [
        {
          gameId: roomId,
          createdAt: now,
          actor: { kind: "system" },
          eventType: "GAME_CREATED",
          payload: {
            mode: gameMode,
            vsComputer: false,
            rulesVersion: CURRENT_RULES_VERSION,
            host: hostSeat,
          },
        },
        playerJoinedDraft(roomId, hostSeat, now),
      ],
      { now, actorClientId: clientId },
    );

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
      ...(gameMode === "2v2" ? { team: "A" as const } : {}),
      ...(signedIn ? { accountId: signedIn.account._id } : {}),
    });

    logEvent("room_created", { roomCode: code, clientId });
    await recordSample(ctx, { kind: "create", at: now });
    return { roomId, code, color };
  }),
});

export const createVsComputer = mutation({
  args: {
    clientId: v.string(),
    name: v.string(),
    botCount: v.number(),
  },
  returns: joinResultValidator,
  handler: (ctx, args) => withOutcomeLogging(ctx, "rooms:createVsComputer", undefined, async () => {
    const clientId = assertValidClientId(args.clientId);
    const name = sanitizePlayerName(args.name);
    const botCount = Math.floor(args.botCount);
    if (botCount < 1 || botCount > 3) fail(GameError.invalidBotCount);

    const now = Date.now();

    // Browser back / double-Start leave an active solo room behind. Reuse a
    // just-created one (debounce), otherwise replace it so Start always works
    // instead of hitting the shared create rate limit.
    const latest = await ctx.db
      .query("rooms")
      .withIndex("by_host", (q) => q.eq("hostClientId", clientId))
      .order("desc")
      .first();

    if (
      latest?.vsComputer &&
      (latest.status === "playing" || latest.status === "lobby")
    ) {
      if (now - latest.createdAt < 2_000) {
        const hostPlayer = await ctx.db
          .query("players")
          .withIndex("by_room_client", (q) =>
            q.eq("roomId", latest._id).eq("clientId", clientId),
          )
          .unique();
        if (hostPlayer) {
          await ctx.db.patch(hostPlayer._id, {
            connected: true,
            lastSeenAt: now,
          });
          return {
            roomId: latest._id,
            code: latest.code,
            color: hostPlayer.color,
          };
        }
      }
      await deleteRoomCascade(ctx, latest._id);
    } else {
      await assertCreateNotRateLimited(ctx, clientId, now);
    }

    const hostColor = COLORS[0]!;
    const seats: StartedSeat[] = [{ color: hostColor, name, isBot: false, clientId }];
    for (let i = 0; i < botCount; i++) {
      const color = pickNextColor(seats.map((s) => s.color));
      if (!color) break;
      seats.push({ color, name: botDisplayName(i), isBot: true, clientId: "" });
    }

    const { roomId, code } = await createStartedRoom(ctx, {
      kind: "vsComputer",
      seats,
      lastEvent: `${name} vs computer`,
      now,
    });

    logEvent("vs_computer_created", {
      roomCode: code,
      clientId,
      bots: botCount,
    });
    await recordSample(ctx, { kind: "create", at: now });
    return { roomId, code, color: hostColor };
  }),
});

export const addBot = mutation({
  args: {
    roomId: v.id("rooms"),
    clientId: v.string(),
    color: v.optional(colorValidator),
    team: v.optional(v.union(v.literal("A"), v.literal("B"))),
  },
  returns: v.object({
    color: colorValidator,
  }),
  handler: async (ctx, args) => {
    const clientId = assertValidClientId(args.clientId);
    const room = await ctx.db.get(args.roomId);
    if (!room) fail(GameError.roomNotFound);
    if (room.hostClientId !== clientId) fail(GameError.onlyHost);
    if (room.ranked) fail(GameError.rankedLocked);
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

    const isTeamMode = room.mode === "2v2";
    let color: Color | undefined;
    let botTeam: Team | undefined;

    if (isTeamMode) {
      if (args.color) {
        if (seated.includes(args.color)) fail(GameError.seatTaken);
        color = args.color;
        botTeam = teamOfColor(color);
      } else if (args.team) {
        if (countOnTeam(players, args.team) >= 2) fail(GameError.teamFull);
        color = pickNextColorForTeam(seated, args.team);
        botTeam = args.team;
      } else {
        const countA = countOnTeam(players, "A");
        const countB = countOnTeam(players, "B");
        if (countA >= 2 && countB >= 2) fail(GameError.roomFull);
        const team: Team =
          countA < countB ? "A" : countB < countA ? "B" : "A";
        if (countOnTeam(players, team) >= 2) fail(GameError.teamFull);
        color = pickNextColorForTeam(seated, team);
        botTeam = team;
      }
      if (!color) fail(GameError.teamFull);
    } else {
      if (args.color && seated.includes(args.color)) fail(GameError.seatTaken);
      color = args.color ?? pickNextColor(seated);
      if (!color || seated.includes(color)) fail(GameError.roomFull);
    }

    const botIndex = players.filter((p) => p.isBot).length;
    const name = botDisplayName(botIndex);
    const now = Date.now();
    const nextSeated = [...seated, color];

    await ctx.db.patch(args.roomId, {
      seatedColors: nextSeated,
      lastActivityAt: now,
      lastEvent: `${name} joined`,
    });

    assertEventSourcedRoom(room);
    await commitEvents(
      ctx,
      room,
      [playerJoinedDraft(room._id, { color, name, isBot: true, team: botTeam }, now)],
      { now, actorClientId: clientId },
    );

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
      ...(botTeam ? { team: botTeam } : {}),
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
    team: v.optional(v.union(v.literal("A"), v.literal("B"))),
  },
  returns: joinResultValidator,
  handler: (ctx, args) => withOutcomeLogging(ctx, "rooms:joinRoom", undefined, async () => {
    const clientId = assertValidClientId(args.clientId);
    const code = assertValidRoomCode(args.code);
    const signedIn = await optionalAccount(ctx, Date.now());
    const name = sanitizePlayerName(args.name, signedIn?.profile.displayName);
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
        leftAt: undefined,
      });
      await ctx.db.patch(room._id, { lastActivityAt: now });
      logEvent("player_reconnected", {
        roomCode: room.code,
        color: existing.color,
        clientId,
      });
      await recordSample(ctx, { kind: "reconnect", at: now });
      return {
        roomId: room._id,
        code: room.code,
        color: existing.color,
        reconnected: true,
      };
    }

    if (room.vsComputer) fail(GameError.vsComputerOnly);

    const players = await ctx.db
      .query("players")
      .withIndex("by_room", (q) => q.eq("roomId", room._id))
      .collect();

    // Ranked seats belong to accounts: the owner reclaims from any tab with
    // no host approval; nobody else can sit down.
    if (room.ranked) {
      const seat = signedIn
        ? players.find((p) => p.accountId === signedIn.account._id)
        : undefined;
      if (!seat) fail(GameError.rankedSeatsOnly);
      if (seat.leftAt !== undefined) fail(GameError.seatForfeited);
      if (seat.connected && now - seat.lastSeenAt < SEAT_LIVE_MS) {
        fail(GameError.seatInUse);
      }
      return await claimDisconnectedSeat(ctx, seat, room, clientId, now);
    }

    // Name-based reclaim: same name as a disconnected seat, different clientId.
    const nameMatch = players.find(
      (p) =>
        !p.isBot &&
        p.clientId !== clientId &&
        namesMatch(p.name, name),
    );

    if (nameMatch) {
      if (nameMatch.connected) {
        fail(GameError.nameTaken);
      }
      // An account-linked seat can only be reclaimed by that same account.
      if (nameMatch.accountId && nameMatch.accountId !== signedIn?.account._id) {
        fail(GameError.nameTaken);
      }
      if (nameMatch.eliminated) {
        fail(GameError.eliminated);
      }

      const otherConnectedHumans = players.filter(
        (p) =>
          !p.isBot &&
          p.connected &&
          p._id !== nameMatch._id,
      );

      // Nobody left to approve, or reclaiming the host seat (host is offline
      // and cannot approve themselves) — reclaim immediately.
      const reclaimingHost = room.hostClientId === nameMatch.clientId;
      if (otherConnectedHumans.length === 0 || reclaimingHost) {
        return await claimDisconnectedSeat(ctx, nameMatch, room, clientId, now);
      }

      // Reuse an existing pending request from this client for this seat.
      const existingPending = await ctx.db
        .query("rejoinRequests")
        .withIndex("by_player", (q) => q.eq("playerId", nameMatch._id))
        .collect();
      const mine = existingPending.find(
        (r) =>
          r.status === "pending" && r.requesterClientId === clientId,
      );
      if (mine) {
        await ctx.db.patch(mine._id, {
          requesterName: name,
          createdAt: now,
        });
        return { pending: true as const, requestId: mine._id };
      }

      // Deny any other pending requests for the same seat (one reclaim at a time).
      for (const r of existingPending) {
        if (r.status === "pending") {
          await ctx.db.patch(r._id, {
            status: "denied",
            resolvedAt: now,
          });
        }
      }

      const requestId = await ctx.db.insert("rejoinRequests", {
        roomId: room._id,
        playerId: nameMatch._id,
        requesterClientId: clientId,
        requesterName: name,
        status: "pending",
        createdAt: now,
      });
      await ctx.db.patch(room._id, {
        lastActivityAt: now,
        lastEvent: `${name} wants to rejoin as ${nameMatch.color}`,
      });
      logEvent("rejoin_requested", {
        roomCode: room.code,
        color: nameMatch.color,
        clientId,
      });
      return { pending: true as const, requestId };
    }

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

    if (players.length >= 4) fail(GameError.roomFull);

    const seated = (room.seatedColors ?? seatedFromPlayers(players)) as Color[];
    if (seated.length >= 4) fail(GameError.roomFull);

    const isTeamMode = room.mode === "2v2";
    let color: Color;
    let joinTeam: Team | undefined;

    if (isTeamMode) {
      if (!args.team) fail(GameError.teamRequired);
      joinTeam = args.team;
      if (countOnTeam(players, joinTeam) >= 2) {
        fail(GameError.teamFull);
      }
      const teamColor = pickNextColorForTeam(seated, joinTeam);
      if (!teamColor) fail(GameError.teamFull);
      color = teamColor;
    } else {
      const next = pickNextColor(seated);
      if (!next) fail(GameError.roomFull);
      color = next;
    }

    const nextSeated = [...seated, color];
    // OCC lock: concurrent joins both patch seatedColors; one retries.
    await ctx.db.patch(room._id, {
      seatedColors: nextSeated,
      lastActivityAt: now,
      lastEvent: `${name} joined as ${color}`,
    });

    assertEventSourcedRoom(room);
    await commitEvents(
      ctx,
      room,
      [playerJoinedDraft(room._id, { color, name, isBot: false, team: joinTeam }, now)],
      { now, actorClientId: clientId },
    );

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
      ...(joinTeam ? { team: joinTeam } : {}),
      ...(signedIn ? { accountId: signedIn.account._id } : {}),
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
    await recordSample(ctx, { kind: "join", at: now });
    return { roomId: room._id, code: room.code, color, reconnected: false };
  }),
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
    await recordSample(ctx, {
      kind: player.connected ? "heartbeat" : "reconnect",
      at: now,
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

const rejoinRequestPublicValidator = v.object({
  _id: v.id("rejoinRequests"),
  requesterName: v.string(),
  playerColor: colorValidator,
  createdAt: v.number(),
});

export const getRejoinRequestStatus = query({
  args: {
    requestId: v.id("rejoinRequests"),
  },
  returns: v.union(
    v.object({
      status: v.union(
        v.literal("pending"),
        v.literal("approved"),
        v.literal("denied"),
      ),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const req = await ctx.db.get(args.requestId);
    if (!req) return null;
    return { status: req.status };
  },
});

export const listPendingRejoinRequests = query({
  args: {
    roomId: v.id("rooms"),
    clientId: v.string(),
  },
  returns: v.array(rejoinRequestPublicValidator),
  handler: async (ctx, args) => {
    let clientId: string;
    try {
      clientId = assertValidClientId(args.clientId);
    } catch {
      return [];
    }
    const room = await ctx.db.get(args.roomId);
    if (!room || room.hostClientId !== clientId) return [];

    const pending = await ctx.db
      .query("rejoinRequests")
      .withIndex("by_room_status", (q) =>
        q.eq("roomId", args.roomId).eq("status", "pending"),
      )
      .collect();

    const results: Array<{
      _id: Id<"rejoinRequests">;
      requesterName: string;
      playerColor: Color;
      createdAt: number;
    }> = [];

    for (const req of pending) {
      const seat = await ctx.db.get(req.playerId);
      if (!seat) continue;
      results.push({
        _id: req._id,
        requesterName: req.requesterName,
        playerColor: seat.color as Color,
        createdAt: req.createdAt,
      });
    }
    return results;
  },
});

export const respondRejoinRequest = mutation({
  args: {
    requestId: v.id("rejoinRequests"),
    clientId: v.string(),
    approve: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const clientId = assertValidClientId(args.clientId);
    const req = await ctx.db.get(args.requestId);
    if (!req) fail(GameError.roomNotFound);
    if (req.status !== "pending") return null;

    const room = await ctx.db.get(req.roomId);
    if (!room) fail(GameError.roomNotFound);
    if (room.hostClientId !== clientId) fail(GameError.onlyHost);

    const now = Date.now();

    if (!args.approve) {
      await ctx.db.patch(req._id, {
        status: "denied",
        resolvedAt: now,
      });
      await ctx.db.patch(room._id, {
        lastActivityAt: now,
        lastEvent: `Host denied ${req.requesterName}'s rejoin`,
      });
      logEvent("rejoin_denied", {
        roomCode: room.code,
        clientId: req.requesterClientId,
      });
      return null;
    }

    const seat = await ctx.db.get(req.playerId);
    if (!seat || seat.connected) {
      await ctx.db.patch(req._id, {
        status: "denied",
        resolvedAt: now,
      });
      fail(GameError.rejoinExpired);
    }

    // Ensure requester isn't already seated as someone else in this room.
    const requesterSeat = await ctx.db
      .query("players")
      .withIndex("by_room_client", (q) =>
        q
          .eq("roomId", room._id)
          .eq("clientId", req.requesterClientId),
      )
      .unique();
    if (requesterSeat && requesterSeat._id !== seat._id) {
      await ctx.db.patch(req._id, {
        status: "denied",
        resolvedAt: now,
      });
      fail(GameError.nameTaken);
    }

    await claimDisconnectedSeat(ctx, seat, room, req.requesterClientId, now);
    await ctx.db.patch(room._id, {
      lastEvent: `${req.requesterName} rejoined as ${seat.color}`,
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
  handler: (ctx, args) => withOutcomeLogging(ctx, "rooms:leaveRoom", args.roomId, async () => {
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
    await recordSample(ctx, { kind: "leave", at: now });
    logEvent("player_left", {
      roomCode: room.code,
      color: player.color,
      status: room.status,
      clientId,
    });

    // Drop from voice immediately so peers tear down (don't wait for stale timeout).
    await clearVoiceForColor(ctx, args.roomId, player.color as Color);

    // Solo vs-computer: human leaving ends the room (bots alone are useless).
    if (room.vsComputer && !player.isBot) {
      await deleteRoomCascade(ctx, args.roomId);
      return { emptied: true };
    }

    const others = (
      await ctx.db
        .query("players")
        .withIndex("by_room", (q) => q.eq("roomId", args.roomId))
        .collect()
    ).filter((p) => p._id !== player._id);

    if (room.status === "playing") {
      // No playable humans left — tear down (bots must not finish alone).
      if (playableHumans(others).length === 0) {
        await deleteRoomCascade(ctx, args.roomId);
        return { emptied: true };
      }
      // Active seats forfeit; finished or eliminated seats keep their place.
      if (!player.eliminated && player.finishRank == null) {
        await commitCommand(
          ctx,
          room,
          { type: "ForfeitSeat", color: player.color as Color, reason: "left" },
          { now, actorClientId: clientId },
        );
      }
      // Keep the row: the seat stays in the game state and final rankings.
      await ctx.db.patch(player._id, { connected: false, lastSeenAt: now, leftAt: now });
      if (room.hostClientId === clientId) {
        const nextHost = pickNextHumanHost(others);
        if (nextHost) await ctx.db.patch(room._id, { hostClientId: nextHost.clientId });
      }
      return { emptied: false };
    }

    if (!others.some((p) => !p.isBot && p.leftAt === undefined)) {
      await deleteRoomCascade(ctx, args.roomId);
      return { emptied: true };
    }

    const patches: {
      hostClientId?: string;
      lastEvent: string;
      lastActivityAt: number;
    } = {
      lastEvent: `${player.name} left`,
      lastActivityAt: now,
    };
    if (room.status === "lobby") {
      assertEventSourcedRoom(room);
      await commitEvents(
        ctx,
        room,
        [playerLeftDraft(room._id, player.color as Color, "left", now)],
        { now, actorClientId: clientId },
      );
      await ctx.db.delete(player._id);
    } else {
      // Finished: the seat stays in the final standings.
      await ctx.db.patch(player._id, { connected: false, lastSeenAt: now, leftAt: now });
    }
    if (room.hostClientId === clientId) {
      const nextHost = pickNextHumanHost(others);
      if (nextHost) {
        patches.hostClientId = nextHost.clientId;
        patches.lastEvent = `${player.name} left — ${nextHost.name} is host`;
      }
    }
    await ctx.db.patch(args.roomId, patches);
    return { emptied: false };
  }),
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
    if (room.ranked) fail(GameError.rankedLocked);
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

    const now = Date.now();
    await clearVoiceForColor(ctx, args.roomId, target.color as Color);
    assertEventSourcedRoom(room);
    await commitEvents(
      ctx,
      room,
      [playerLeftDraft(room._id, target.color as Color, "kicked", now)],
      { now, actorClientId: clientId },
    );
    await ctx.db.delete(target._id);
    await ctx.db.patch(args.roomId, {
      lastActivityAt: now,
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
  handler: (ctx, args) => withOutcomeLogging(ctx, "rooms:startGame", args.roomId, async () => {
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

    if (room.mode === "2v2") {
      if (players.length !== 4) {
        fail(GameError.needFullTeams);
      }
      if (countOnTeam(players, "A") !== 2 || countOnTeam(players, "B") !== 2) {
        fail(GameError.needFullTeams);
      }
    } else {
      if (players.length < 2) {
        fail(GameError.needPlayers);
      }
      if (players.length > 4) {
        fail(GameError.roomFull);
      }
    }

    const activeColors = seatedFromPlayers(players);
    const now = Date.now();
    assertEventSourcedRoom(room);
    await commitEvents(
      ctx,
      room,
      buildMatchStartDrafts(room, players, now),
      { now, actorClientId: clientId },
    );
    await ctx.db.patch(args.roomId, { seatedColors: activeColors });
    logEvent("game_started", {
      roomCode: room.code,
      players: players.length,
      clientId,
    });
    await recordSample(ctx, { kind: "start", at: now });
    return null;
  }),
});

export const rematch = mutation({
  args: {
    roomId: v.id("rooms"),
    clientId: v.string(),
  },
  returns: v.null(),
  handler: (ctx, args) => withOutcomeLogging(ctx, "rooms:rematch", args.roomId, async () => {
    const clientId = assertValidClientId(args.clientId);
    const room = await ctx.db.get(args.roomId);
    if (!room) fail(GameError.roomNotFound);
    if (room.ranked) fail(GameError.rankedNoRematch);
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
      const forfeitGone =
        p.leftAt !== undefined || (!!p.eliminated && !p.connected);
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
    assertEventSourcedRoom(room);
    await commitEvents(
      ctx,
      room,
      buildMatchStartDrafts(room, remaining, now),
      { now, actorClientId: clientId },
    );
    await clearChatForRoom(ctx, args.roomId);
    await clearVoiceForRoom(ctx, args.roomId);
    await ctx.db.patch(args.roomId, { seatedColors: activeColors });
    logEvent("game_started", {
      roomCode: room.code,
      players: remaining.length,
      rematch: true,
      clientId,
    });
    await recordSample(ctx, { kind: "start", at: now });
    return null;
  }),
});

export const roomBundleObjectValidator = v.object({
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
    ranked: v.boolean(),
    mode: v.union(v.literal("1v1"), v.literal("2v2")),
    winningTeam: v.union(v.literal("A"), v.literal("B"), v.null()),
    passedRollTo: v.union(colorValidator, v.null()),
    eventSeq: v.number(),
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
      team: v.union(v.literal("A"), v.literal("B"), v.null()),
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
});

const roomBundleValidator = v.union(roomBundleObjectValidator, v.null());

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
