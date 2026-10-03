import {
  Color,
  COLORS,
  createInitialTokens,
  GameMode,
  MAX_TIMEOUT_LIVES,
  Team,
  TeamPlayerLike,
  TokenSnapshot,
  TokenState,
} from "../ludo";
import { CURRENT_RULES_VERSION } from "./eventValidators";
import type { SeatSnapshot } from "./eventValidators";

export type GamePhase = "lobby" | "playing" | "finished";

export type GameSeat = {
  color: Color;
  name: string;
  isBot: boolean;
  team?: Team;
  lives: number;
  eliminated: boolean;
  finishRank: number | null;
};

export type SettleMarker =
  | null
  | {
      kind: "after_token_move";
      seat: Color;
      actorColor: Color;
      tokenColor: Color;
      tokenIndex: number;
      dice: number;
      fromSteps: number;
      toSteps: number;
      wasDelegated: boolean;
      /** TOKEN_CAPTURED events applied for this move so far. */
      captures: number;
    }
  /** Between TURN_ENDED and the TURN_STARTED that must follow it. */
  | { kind: "turn_ended" };

export type GameState = {
  phase: GamePhase;
  mode: GameMode;
  vsComputer: boolean;
  rulesVersion: number;
  seats: GameSeat[];
  tokens: TokenState[];
  currentTurn: Color;
  diceValue: number | null;
  diceRolled: boolean;
  consecutiveSixes: number;
  sixStreakSnapshot: TokenSnapshot[] | null;
  passedRollTo: Color | null;
  /** Persisted as rooms.turnId */
  turnNumber: number;
  rankings: Color[];
  winner: Color | null;
  winningTeam: Team | null;
  settle: SettleMarker;
  /** Set when match ends (materialized finishedAt uses wall clock in store). */
  finishedAt: number | null;
};

export function createEmptyState(): GameState {
  return {
    phase: "lobby",
    mode: "1v1",
    vsComputer: false,
    rulesVersion: CURRENT_RULES_VERSION,
    seats: [],
    tokens: [],
    currentTurn: "red",
    diceValue: null,
    diceRolled: false,
    consecutiveSixes: 0,
    sixStreakSnapshot: null,
    passedRollTo: null,
    turnNumber: 0,
    rankings: [],
    winner: null,
    winningTeam: null,
    settle: null,
    finishedAt: null,
  };
}

export function seatToTeamPlayer(seat: GameSeat): TeamPlayerLike {
  return {
    color: seat.color,
    team: seat.team,
    eliminated: seat.eliminated,
    finishRank: seat.finishRank,
  };
}

export function teamPlayers(state: GameState): TeamPlayerLike[] {
  return state.seats.map(seatToTeamPlayer);
}

export function seatByColor(state: GameState, color: Color): GameSeat | undefined {
  return state.seats.find((s) => s.color === color);
}

export function updateSeat(
  state: GameState,
  color: Color,
  patch: Partial<GameSeat>,
): GameState {
  return {
    ...state,
    seats: state.seats.map((s) =>
      s.color === color ? { ...s, ...patch } : s,
    ),
  };
}

export function lobbySeatFromSnapshot(s: SeatSnapshot): GameSeat {
  return {
    color: s.color,
    name: s.name,
    isBot: s.isBot,
    team: s.team,
    lives: MAX_TIMEOUT_LIVES,
    eliminated: false,
    finishRank: null,
  };
}

export function seatedColors(state: GameState): Color[] {
  return COLORS.filter((c) => state.seats.some((s) => s.color === c));
}

export function activeColorsForMatch(state: GameState): Color[] {
  return state.seats.map((s) => s.color);
}

export function replaceTokens(
  state: GameState,
  tokens: TokenState[],
): GameState {
  return { ...state, tokens: [...tokens] };
}

export function patchTokenSteps(
  state: GameState,
  color: Color,
  index: number,
  steps: number,
): GameState {
  return replaceTokens(
    state,
    state.tokens.map((t) =>
      t.color === color && t.index === index ? { ...t, steps } : t,
    ),
  );
}

export function tokensForColors(colors: Color[]): TokenState[] {
  return createInitialTokens(colors);
}
