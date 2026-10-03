import type { Id } from "../../../convex/_generated/dataModel";
import {
  CURRENT_RULES_VERSION,
  type EventActor,
  type GameStartedSeat,
  type LudoEvent,
  type LudoEventDraft,
  type SeatSnapshot,
} from "../../../convex/lib/game";
import {
  MAX_TIMEOUT_LIVES,
  teamOfColor,
  type Color,
  type GameMode,
} from "../../../convex/lib/ludo";

export const GAME_ID = "fixture_game" as Id<"rooms">;
export const T0 = 1_700_000_000_000;

const SYSTEM: EventActor = { kind: "system" };
const seatActor = (color: Color): EventActor => ({ kind: "seat", color });

type Body = Pick<LudoEventDraft, "eventType" | "payload" | "actor">;

function body<E extends LudoEvent["eventType"]>(
  eventType: E,
  payload: Extract<LudoEvent, { eventType: E }>["payload"],
  actor: EventActor = SYSTEM,
): Body {
  return { eventType, payload, actor } as Body;
}

/** Event bodies without seq / gameId / createdAt. */
export const ev = {
  gameCreated: (opts: {
    mode?: GameMode;
    vsComputer?: boolean;
    host?: SeatSnapshot;
  } = {}) =>
    body("GAME_CREATED", {
      mode: opts.mode ?? "1v1",
      vsComputer: opts.vsComputer ?? false,
      rulesVersion: CURRENT_RULES_VERSION,
      host: opts.host ?? seatSnapshot("red", opts.mode ?? "1v1"),
    }),
  playerJoined: (seat: SeatSnapshot) =>
    body("PLAYER_JOINED", { seat }, seatActor(seat.color)),
  playerLeft: (color: Color, reason: "left" | "kicked" = "left") =>
    body("PLAYER_LEFT", { color, reason }),
  gameStarted: (seats: GameStartedSeat[], mode: GameMode = "1v1") =>
    body("GAME_STARTED", { rulesVersion: CURRENT_RULES_VERSION, mode, seats }),
  turnStarted: (seat: Color) => body("TURN_STARTED", { seat }),
  diceRolled: (color: Color, value: number) =>
    body("DICE_ROLLED", { color, value }, seatActor(color)),
  rollPassed: (from: Color, to: Color) =>
    body("ROLL_PASSED", { from, to }, seatActor(from)),
  tokenMoved: (actor: Color, tokenColor: Color, tokenIndex: number) =>
    body("TOKEN_MOVED", { tokenColor, tokenIndex }, seatActor(actor)),
  tokenCaptured: (
    actor: Color,
    byColor: Color,
    victimColor: Color,
    victimIndex: number,
  ) =>
    body(
      "TOKEN_CAPTURED",
      { byColor, victimColor, victimIndex },
      seatActor(actor),
    ),
  extraTurn: (color: Color, reason: "six" | "capture" | "home") =>
    body("EXTRA_TURN_GRANTED", { color, reason }),
  turnEnded: (
    reason:
      | "moved"
      | "no_moves"
      | "three_sixes"
      | "timeout"
      | "finished"
      | "eliminated",
  ) => body("TURN_ENDED", { reason }),
  turnTimedOut: (color: Color) => body("TURN_TIMED_OUT", { color }),
  playerEliminated: (color: Color, reason: "timeout" | "left" | "abandoned") =>
    body("PLAYER_ELIMINATED", { color, reason }),
  playerFinished: (color: Color, rank: number) =>
    body("PLAYER_FINISHED", { color, rank }),
  teamFinished: (team: "A" | "B") => body("TEAM_FINISHED", { team }),
  gameFinished: (
    reason: Extract<LudoEvent, { eventType: "GAME_FINISHED" }>["payload"]["reason"],
  ) => body("GAME_FINISHED", { reason }),
};

export function seatSnapshot(
  color: Color,
  mode: GameMode = "1v1",
  opts: { name?: string; isBot?: boolean } = {},
): SeatSnapshot {
  return {
    color,
    name: opts.name ?? color.toUpperCase(),
    isBot: opts.isBot ?? false,
    ...(mode === "2v2" ? { team: teamOfColor(color) } : {}),
  };
}

export function startedSeat(
  color: Color,
  mode: GameMode = "1v1",
  opts: { name?: string; isBot?: boolean } = {},
): GameStartedSeat {
  return {
    ...seatSnapshot(color, mode, opts),
    lives: MAX_TIMEOUT_LIVES,
    eliminated: false,
    finishRank: null,
  };
}

/** Attach seq / eventId / gameId / createdAt to one body. */
export function makeEvent(
  b: Body | LudoEventDraft,
  seq: number,
  opts: { gameId?: Id<"rooms">; createdAt?: number } = {},
): LudoEvent {
  const gameId = opts.gameId ?? GAME_ID;
  return {
    ...b,
    gameId,
    createdAt: opts.createdAt ?? T0 + seq,
    seq,
    eventId: `${gameId}:${seq}`,
  } as LudoEvent;
}

/** Number bodies contiguously after `afterSeq`. */
export function seqify(
  bodies: Array<Body | LudoEventDraft>,
  afterSeq = 0,
  opts: { gameId?: Id<"rooms"> } = {},
): LudoEvent[] {
  return bodies.map((b, i) => makeEvent(b, afterSeq + i + 1, opts));
}

/** Lobby + start bodies for the given colours (host = first colour). */
export function startBodies(colors: Color[], mode: GameMode = "1v1"): Body[] {
  const ordered = [...colors];
  return [
    ev.gameCreated({ mode, host: seatSnapshot(ordered[0]!, mode) }),
    ...ordered.map((c) => ev.playerJoined(seatSnapshot(c, mode))),
    ev.gameStarted(
      ordered.map((c) => startedSeat(c, mode)),
      mode,
    ),
    ev.turnStarted(firstSeat(ordered)),
  ];
}

const ORDER: Color[] = ["red", "green", "yellow", "blue"];
export function firstSeat(colors: Color[]): Color {
  return ORDER.find((c) => colors.includes(c))!;
}
