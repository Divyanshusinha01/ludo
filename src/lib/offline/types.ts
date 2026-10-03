import type { Id } from "../../../convex/_generated/dataModel";
import type { GameEvent } from "../../../convex/lib/events";
import type {
  Color,
  TokenSnapshot,
  TokenState,
} from "../../../convex/lib/ludo";
import type { RoomBundle } from "@/components/Lobby";

/** Seat configuration when starting a local game. */
export type OfflineSeatInput = {
  color: Color;
  name: string;
  isBot: boolean;
};

/** One seat at the table (human or bot). */
export type OfflineSeat = OfflineSeatInput & {
  finishRank: number | null;
};

/**
 * Full offline match state persisted to localStorage.
 * Mirrors the subset of Convex room + players + tokens fields the game UI needs.
 *
 * Out of scope offline: turn timeout / lives / elimination, disconnect/rejoin, chat.
 */
export type OfflineGameState = {
  status: "playing" | "finished";
  currentTurn: Color;
  diceValue: number | null;
  diceRolled: boolean;
  consecutiveSixes: number;
  sixStreakSnapshot: TokenSnapshot[] | null;
  winner: Color | null;
  rankings: Color[];
  events: GameEvent[];
  lastEvent?: string;
  turnId: number;
  seats: OfflineSeat[];
  tokens: TokenState[];
  createdAt: number;
  finishedAt: number | null;
};

/** Same shape as online `RoomBundle` for reusing Board / Dice / GameScreen layout. */
export type OfflineBundle = RoomBundle;

const OFFLINE_ROOM_ID = "offline_local" as Id<"rooms">;

function playerId(color: Color): Id<"players"> {
  return `offline_player_${color}` as Id<"players">;
}

function tokenId(color: Color, index: number): Id<"tokens"> {
  return `offline_token_${color}_${index}` as Id<"tokens">;
}

/** Derive UI bundle from raw offline state. */
export function toOfflineBundle(state: OfflineGameState): OfflineBundle {
  const currentSeat = state.seats.find((s) => s.color === state.currentTurn);
  const me =
    currentSeat && !currentSeat.isBot
      ? {
          color: currentSeat.color,
          name: currentSeat.name,
          isHost: true,
        }
      : null;

  const players = state.seats.map((s) => ({
    _id: playerId(s.color),
    name: s.name,
    color: s.color,
    connected: true,
    lives: 3,
    eliminated: false,
    finishRank: s.finishRank,
    isMe: me?.color === s.color,
    isHost: true,
    isBot: s.isBot,
    team: null,
  }));

  const tokens = state.tokens.map((t) => ({
    _id: tokenId(t.color, t.index),
    color: t.color,
    index: t.index,
    steps: t.steps,
  }));

  return {
    room: {
      _id: OFFLINE_ROOM_ID,
      code: "LOCAL",
      status: state.status,
      currentTurn: state.currentTurn,
      diceValue: state.diceValue,
      diceRolled: state.diceRolled,
      consecutiveSixes: state.consecutiveSixes,
      turnId: state.turnId,
      turnStartedAt: null,
      turnTimeoutMs: 60_000,
      winner: state.winner,
      rankings: state.rankings,
      lastEvent: state.lastEvent,
      events: state.events,
      eventSeq: 0,
      createdAt: state.createdAt,
      finishedAt: state.finishedAt,
      vsComputer: false,
      ranked: false,
      mode: "1v1" as const,
      winningTeam: null,
      passedRollTo: null,
    },
    players,
    tokens,
    me,
  };
}
