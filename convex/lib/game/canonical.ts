import { COLORS, type Color, type TokenSnapshot } from "../ludo";
import type { GameSeat, GameState } from "./state";

/**
 * Order-independent, wall-clock-free view of a GameState. Two states describe
 * the same game iff their canonical forms are deep-equal. `finishedAt` is
 * dropped: the projection stores wall-clock time, the reducer does not.
 */
export type CanonicalGameState = Omit<GameState, "finishedAt" | "seats"> & {
  seats: Array<Omit<GameSeat, "team"> & { team: GameSeat["team"] | null }>;
};

function byColorThenIndex<T extends { color: Color; index: number }>(
  a: T,
  b: T,
): number {
  return COLORS.indexOf(a.color) - COLORS.indexOf(b.color) || a.index - b.index;
}

function sortedTokens<T extends TokenSnapshot>(tokens: T[]): TokenSnapshot[] {
  return [...tokens]
    .sort(byColorThenIndex)
    .map((t) => ({ color: t.color, index: t.index, steps: t.steps }));
}

export function canonicalGameState(state: GameState): CanonicalGameState {
  const { finishedAt: _finishedAt, ...rest } = state;
  return {
    ...rest,
    seats: [...state.seats]
      .sort((a, b) => COLORS.indexOf(a.color) - COLORS.indexOf(b.color))
      .map((s) => ({
        color: s.color,
        name: s.name,
        isBot: s.isBot,
        team: s.team ?? null,
        lives: s.lives,
        eliminated: s.eliminated,
        finishRank: s.finishRank ?? null,
      })),
    tokens: sortedTokens(state.tokens),
    sixStreakSnapshot: state.sixStreakSnapshot
      ? sortedTokens(state.sixStreakSnapshot)
      : null,
  };
}

/** Human-readable list of every field path where the two states differ. */
export function diffGameStates(a: GameState, b: GameState): string[] {
  const diffs: string[] = [];
  walk(canonicalGameState(a), canonicalGameState(b), "", diffs);
  return diffs;
}

function walk(a: unknown, b: unknown, path: string, out: string[]): void {
  if (Object.is(a, b)) return;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      out.push(`${path || "<root>"}: length ${a.length} vs ${b.length}`);
      return;
    }
    a.forEach((item, i) => walk(item, b[i], `${path}[${i}]`, out));
    return;
  }
  if (isRecord(a) && isRecord(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of [...keys].sort()) {
      walk(a[key], b[key], path ? `${path}.${key}` : key, out);
    }
    return;
  }
  out.push(`${path || "<root>"}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
