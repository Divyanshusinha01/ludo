import { v, type Infer } from "convex/values";
import { colorValidator } from "../colors";

export const CURRENT_RULES_VERSION = 1;

const teamValidator = v.union(v.literal("A"), v.literal("B"));

export const eventActorValidator = v.union(
  v.object({ kind: v.literal("seat"), color: colorValidator }),
  v.object({ kind: v.literal("system") }),
);

const seatSnapshotValidator = v.object({
  color: colorValidator,
  name: v.string(),
  isBot: v.boolean(),
  team: v.optional(teamValidator),
});

const gameStartedSeatValidator = v.object({
  color: colorValidator,
  name: v.string(),
  isBot: v.boolean(),
  team: v.optional(teamValidator),
  lives: v.number(),
  eliminated: v.boolean(),
  finishRank: v.optional(v.union(v.number(), v.null())),
});

const eventBaseFields = {
  gameId: v.id("rooms"),
  seq: v.number(),
  eventId: v.string(),
  createdAt: v.number(),
  actor: eventActorValidator,
  actorClientId: v.optional(v.string()),
};

function eventVariant<
  T extends string,
  P extends ReturnType<typeof v.object>,
>(eventType: T, payload: P) {
  return v.object({
    ...eventBaseFields,
    eventType: v.literal(eventType),
    payload,
  });
}

export const gameCreatedEventValidator = eventVariant(
  "GAME_CREATED",
  v.object({
    mode: v.optional(v.union(v.literal("1v1"), v.literal("2v2"))),
    vsComputer: v.boolean(),
    rulesVersion: v.number(),
    host: seatSnapshotValidator,
  }),
);

export const playerJoinedEventValidator = eventVariant(
  "PLAYER_JOINED",
  v.object({
    seat: seatSnapshotValidator,
  }),
);

export const playerLeftEventValidator = eventVariant(
  "PLAYER_LEFT",
  v.object({
    color: colorValidator,
    reason: v.union(v.literal("left"), v.literal("kicked")),
  }),
);

export const gameStartedEventValidator = eventVariant(
  "GAME_STARTED",
  v.object({
    rulesVersion: v.number(),
    mode: v.union(v.literal("1v1"), v.literal("2v2")),
    seats: v.array(gameStartedSeatValidator),
  }),
);

export const turnStartedEventValidator = eventVariant(
  "TURN_STARTED",
  v.object({
    seat: colorValidator,
  }),
);

export const diceRolledEventValidator = eventVariant(
  "DICE_ROLLED",
  v.object({
    color: colorValidator,
    value: v.number(),
  }),
);

export const rollPassedEventValidator = eventVariant(
  "ROLL_PASSED",
  v.object({
    from: colorValidator,
    to: colorValidator,
  }),
);

export const tokenMovedEventValidator = eventVariant(
  "TOKEN_MOVED",
  v.object({
    tokenColor: colorValidator,
    tokenIndex: v.number(),
  }),
);

export const tokenCapturedEventValidator = eventVariant(
  "TOKEN_CAPTURED",
  v.object({
    byColor: colorValidator,
    victimColor: colorValidator,
    victimIndex: v.number(),
  }),
);

export const extraTurnGrantedEventValidator = eventVariant(
  "EXTRA_TURN_GRANTED",
  v.object({
    color: colorValidator,
    reason: v.union(
      v.literal("six"),
      v.literal("capture"),
      v.literal("home"),
    ),
  }),
);

export const turnEndedEventValidator = eventVariant(
  "TURN_ENDED",
  v.object({
    reason: v.union(
      v.literal("moved"),
      v.literal("no_moves"),
      v.literal("three_sixes"),
      v.literal("timeout"),
      v.literal("finished"),
      v.literal("eliminated"),
    ),
  }),
);

export const turnTimedOutEventValidator = eventVariant(
  "TURN_TIMED_OUT",
  v.object({
    color: colorValidator,
  }),
);

export const playerEliminatedEventValidator = eventVariant(
  "PLAYER_ELIMINATED",
  v.object({
    color: colorValidator,
    reason: v.union(
      v.literal("timeout"),
      v.literal("left"),
      v.literal("abandoned"),
    ),
  }),
);

export const playerFinishedEventValidator = eventVariant(
  "PLAYER_FINISHED",
  v.object({
    color: colorValidator,
    rank: v.number(),
  }),
);

export const teamFinishedEventValidator = eventVariant(
  "TEAM_FINISHED",
  v.object({
    team: teamValidator,
  }),
);

export const gameFinishedEventValidator = eventVariant(
  "GAME_FINISHED",
  v.object({
    reason: v.union(
      v.literal("all_home"),
      v.literal("team_home"),
      v.literal("team_eliminated"),
      v.literal("sole_survivor"),
      v.literal("automatic_loser"),
      v.literal("all_ranked"),
      v.literal("abandoned"),
    ),
  }),
);

export const ludoEventValidator = v.union(
  gameCreatedEventValidator,
  playerJoinedEventValidator,
  playerLeftEventValidator,
  gameStartedEventValidator,
  turnStartedEventValidator,
  diceRolledEventValidator,
  rollPassedEventValidator,
  tokenMovedEventValidator,
  tokenCapturedEventValidator,
  extraTurnGrantedEventValidator,
  turnEndedEventValidator,
  turnTimedOutEventValidator,
  playerEliminatedEventValidator,
  playerFinishedEventValidator,
  teamFinishedEventValidator,
  gameFinishedEventValidator,
);

export type LudoEvent = Infer<typeof ludoEventValidator>;
export type LudoEventType = LudoEvent["eventType"];
export type EventActor = Infer<typeof eventActorValidator>;
export type SeatSnapshot = Infer<typeof seatSnapshotValidator>;
export type GameStartedSeat = Infer<typeof gameStartedSeatValidator>;

/** Event without server-assigned seq/eventId (draft for commit). */
export type LudoEventDraft = Omit<LudoEvent, "seq" | "eventId"> & {
  seq?: number;
  eventId?: string;
};

export function eventIdFor(gameId: string, seq: number): string {
  return `${gameId}:${seq}`;
}
