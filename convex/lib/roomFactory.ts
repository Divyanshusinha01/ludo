import type { MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import {
  COLORS,
  generateRoomCode,
  MAX_TIMEOUT_LIVES,
  type Color,
  type GameMode,
  type Team,
} from "./ludo";
import { botClientId } from "./bot";
import { commitEventsBootstrap } from "./gameStore";
import { CURRENT_RULES_VERSION, type LudoEventDraft } from "./game/eventValidators";
import type { QueueName } from "./matchmaking";

export async function uniqueCode(ctx: MutationCtx): Promise<string> {
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

export function seatedFromPlayers(players: Array<Pick<Doc<"players">, "color">>): Color[] {
  return COLORS.filter((c) => players.some((p) => p.color === c)) as Color[];
}

export type SeatSource = Pick<Doc<"players">, "color" | "name" | "isBot" | "team">;

export function seatSnapshot(p: SeatSource) {
  return {
    color: p.color as Color,
    name: p.name,
    isBot: !!p.isBot,
    ...(p.team ? { team: p.team } : {}),
  };
}

export function playerJoinedDraft(
  roomId: Id<"rooms">,
  p: SeatSource,
  now: number,
): LudoEventDraft {
  return {
    gameId: roomId,
    createdAt: now,
    actor: { kind: "seat", color: p.color as Color },
    eventType: "PLAYER_JOINED",
    payload: { seat: seatSnapshot(p) },
  };
}

export function buildMatchStartDrafts(
  room: Doc<"rooms">,
  players: SeatSource[],
  now: number,
): LudoEventDraft[] {
  const mode = room.mode === "2v2" ? "2v2" : "1v1";
  const seats = players.map((p) => ({
    color: p.color as Color,
    name: p.name,
    isBot: !!p.isBot,
    team: p.team,
    lives: MAX_TIMEOUT_LIVES,
    eliminated: false,
    finishRank: null as number | null,
  }));
  const activeColors = seatedFromPlayers(players);
  const first = activeColors[0] ?? ("red" as Color);
  return [
    {
      gameId: room._id,
      createdAt: now,
      actor: { kind: "system" },
      eventType: "GAME_STARTED",
      payload: {
        rulesVersion: room.rulesVersion ?? CURRENT_RULES_VERSION,
        mode,
        seats,
      },
    },
    {
      gameId: room._id,
      createdAt: now,
      actor: { kind: "system" },
      eventType: "TURN_STARTED",
      payload: { seat: first },
    },
  ];
}

export type StartedSeat = {
  /** Ignored for bots: their id is derived from the new room id. */
  clientId: string;
  name: string;
  color: Color;
  isBot?: boolean;
  team?: Team;
  accountId?: Id<"accounts">;
};

export type StartedRoomOptions = {
  /** First seat is the host. */
  seats: StartedSeat[];
  lastEvent: string;
  now: number;
} & (
  | { kind: "vsComputer" }
  | { kind: "ranked"; mode: GameMode; queue: QueueName }
);

/**
 * Create a room that is already playing, in one transaction: GAME_CREATED,
 * every PLAYER_JOINED, GAME_STARTED and TURN_STARTED are committed before the
 * seats are inserted, so the reducer sees the same history a lobby would build.
 */
export async function createStartedRoom(
  ctx: MutationCtx,
  opts: StartedRoomOptions,
): Promise<{ roomId: Id<"rooms">; code: string }> {
  const host = opts.seats[0];
  if (!host) throw new Error("createStartedRoom: no seats");
  const mode: GameMode = opts.kind === "ranked" ? opts.mode : "1v1";
  const code = await uniqueCode(ctx);
  const roomId = await ctx.db.insert("rooms", {
    code,
    status: "lobby",
    hostClientId: host.clientId,
    currentTurn: "red",
    diceValue: null,
    diceRolled: false,
    consecutiveSixes: 0,
    winner: null,
    lastEvent: opts.lastEvent,
    createdAt: opts.now,
    lastActivityAt: opts.now,
    seatedColors: [host.color],
    eventSeq: 0,
    rulesVersion: CURRENT_RULES_VERSION,
    ...(opts.kind === "vsComputer"
      ? { vsComputer: true }
      : { mode, ranked: true, queue: opts.queue }),
  });

  const roomDoc = (await ctx.db.get(roomId))!;
  await commitEventsBootstrap(
    ctx,
    roomId,
    [
      {
        gameId: roomId,
        createdAt: opts.now,
        actor: { kind: "system" },
        eventType: "GAME_CREATED",
        payload: {
          mode,
          vsComputer: opts.kind === "vsComputer",
          rulesVersion: CURRENT_RULES_VERSION,
          host: seatSnapshot(host),
        },
      },
      ...opts.seats.map((s) => playerJoinedDraft(roomId, s, opts.now)),
      ...buildMatchStartDrafts(roomDoc, opts.seats, opts.now),
    ],
    { now: opts.now, actorClientId: host.clientId },
  );

  for (const s of opts.seats) {
    await ctx.db.insert("players", {
      roomId,
      clientId: s.isBot ? botClientId(roomId, s.color) : s.clientId,
      name: s.name,
      color: s.color,
      connected: true,
      lastSeenAt: opts.now,
      joinedAt: opts.now,
      lives: MAX_TIMEOUT_LIVES,
      eliminated: false,
      isBot: !!s.isBot,
      ...(s.team ? { team: s.team } : {}),
      ...(s.accountId ? { accountId: s.accountId } : {}),
    });
  }
  return { roomId, code };
}
