import { COLORS } from "../ludo";

/**
 * Structural check for events read back from storage. Convex validators guard
 * writes, but replay also runs on hand-built or corrupted logs, so the reducer
 * must reject a bad shape instead of crashing on it.
 */
type Check = (value: unknown) => boolean;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const num: Check = (x) => typeof x === "number";
const int: Check = (x) => Number.isInteger(x);
const str: Check = (x) => typeof x === "string";
const bool: Check = (x) => typeof x === "boolean";
const color: Check = (x) => COLORS.includes(x as never);
const team: Check = (x) => x === "A" || x === "B";
const oneOf =
  (...values: string[]): Check =>
  (x) =>
    values.includes(x as string);
const optional =
  (check: Check): Check =>
  (x) =>
    x === undefined || check(x);
const nullable =
  (check: Check): Check =>
  (x) =>
    x === null || check(x);
function shape(fields: Record<string, Check>): Check {
  return (x) =>
    isRecord(x) && Object.entries(fields).every(([key, check]) => check(x[key]));
}

const seatSnapshot = shape({
  color,
  name: str,
  isBot: bool,
  team: optional(team),
});

const startedSeat = shape({
  color,
  name: str,
  isBot: bool,
  team: optional(team),
  lives: int,
  eliminated: bool,
  finishRank: optional(nullable(int)),
});

const PAYLOADS: Record<string, Check> = {
  GAME_CREATED: shape({
    mode: optional(oneOf("1v1", "2v2")),
    vsComputer: bool,
    rulesVersion: num,
    host: seatSnapshot,
  }),
  PLAYER_JOINED: shape({ seat: seatSnapshot }),
  PLAYER_LEFT: shape({ color, reason: oneOf("left", "kicked") }),
  GAME_STARTED: shape({
    rulesVersion: num,
    mode: oneOf("1v1", "2v2"),
    seats: (x) => Array.isArray(x) && x.every(startedSeat),
  }),
  TURN_STARTED: shape({ seat: color }),
  DICE_ROLLED: shape({ color, value: num }),
  ROLL_PASSED: shape({ from: color, to: color }),
  TOKEN_MOVED: shape({ tokenColor: color, tokenIndex: int }),
  TOKEN_CAPTURED: shape({ byColor: color, victimColor: color, victimIndex: int }),
  EXTRA_TURN_GRANTED: shape({ color, reason: oneOf("six", "capture", "home") }),
  TURN_ENDED: shape({
    reason: oneOf("moved", "no_moves", "three_sixes", "timeout", "finished", "eliminated"),
  }),
  TURN_TIMED_OUT: shape({ color }),
  PLAYER_ELIMINATED: shape({ color, reason: oneOf("timeout", "left", "abandoned") }),
  PLAYER_FINISHED: shape({ color, rank: int }),
  TEAM_FINISHED: shape({ team }),
  GAME_FINISHED: shape({
    reason: oneOf(
      "all_home",
      "team_home",
      "team_eliminated",
      "sole_survivor",
      "automatic_loser",
      "all_ranked",
      "abandoned",
    ),
  }),
};

const actor: Check = (x) =>
  isRecord(x) && (x.kind === "system" || (x.kind === "seat" && color(x.color)));

/** Why `event` is structurally invalid, or null when it is well formed. */
export function malformedEventReason(event: unknown): string | null {
  if (!isRecord(event)) return "event is not an object";
  const payloadCheck = PAYLOADS[event.eventType as string];
  if (!payloadCheck) return null;
  if (!actor(event.actor)) return `${String(event.eventType)} has an invalid actor`;
  if (!payloadCheck(event.payload)) return `${String(event.eventType)} has an invalid payload`;
  return null;
}
