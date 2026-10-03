import {
  createEmptyState,
  replayGame,
  type GameSeat,
  type GameState,
  type LudoEvent,
} from "../../../convex/lib/game";
import {
  createInitialTokens,
  MAX_TIMEOUT_LIVES,
  teamOfColor,
  type Color,
  type GameMode,
} from "../../../convex/lib/ludo";
import { firstSeat } from "./events";

export function replayState(events: LudoEvent[]): GameState {
  return replayGame(createEmptyState(), events).state;
}

export type PlayingStateOpts = {
  colors: Color[];
  mode?: GameMode;
  /** Steps per colour, index 0..3. Missing colours stay in the yard. */
  steps?: Partial<Record<Color, number[]>>;
  seats?: Partial<Record<Color, Partial<GameSeat>>>;
} & Partial<Omit<GameState, "seats" | "tokens" | "mode">>;

/** Hand-built mid-game state for focused reducer tests. */
export function playingState(opts: PlayingStateOpts): GameState {
  const mode = opts.mode ?? "1v1";
  const { colors, steps, seats: seatPatches, ...rest } = opts;
  const tokens = createInitialTokens(colors).map((t) => ({
    ...t,
    steps: steps?.[t.color]?.[t.index] ?? -1,
  }));
  const seats: GameSeat[] = colors.map((color) => ({
    color,
    name: color.toUpperCase(),
    isBot: false,
    ...(mode === "2v2" ? { team: teamOfColor(color) } : {}),
    lives: MAX_TIMEOUT_LIVES,
    eliminated: false,
    finishRank: null,
    ...seatPatches?.[color],
  }));
  return {
    ...createEmptyState(),
    phase: "playing",
    currentTurn: firstSeat(colors),
    turnNumber: 1,
    ...rest,
    mode,
    seats,
    tokens,
  };
}

/** Recursively freeze so any in-place mutation by the reducer throws. */
export function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) {
      deepFreeze(v);
    }
  }
  return value;
}

export function clone<T>(value: T): T {
  return structuredClone(value);
}
