import type { Team } from "./ludo";

export const INITIAL_RATING = 1200;
export const RATING_FLOOR = 100;
/** K for a player's first PROVISIONAL_GAMES rated games, so new ratings settle quickly. */
export const K_PROVISIONAL = 40;
export const K_ESTABLISHED = 24;
export const PROVISIONAL_GAMES = 30;

/** Matchmaking acceptance window: starts at ±100 and widens by 50 every 10s, capped. */
export const WINDOW_BASE = 100;
export const WINDOW_STEP = 50;
export const WINDOW_STEP_MS = 10_000;
export const WINDOW_MAX = 500;

export function kFactor(ratedGames: number): number {
  return ratedGames < PROVISIONAL_GAMES ? K_PROVISIONAL : K_ESTABLISHED;
}

/** Probability that a player rated `a` beats one rated `b`. */
export function expectedScore(a: number, b: number): number {
  return 1 / (1 + Math.pow(10, (b - a) / 400));
}

export function ratingWindow(waitedMs: number): number {
  const steps = Math.floor(Math.max(0, waitedMs) / WINDOW_STEP_MS);
  return Math.min(WINDOW_MAX, WINDOW_BASE + WINDOW_STEP * steps);
}

/** Two waiting tickets may share a room only when each is inside the other's window. */
export function mutuallyAcceptable(
  a: { rating: number; joinedAt: number },
  b: { rating: number; joinedAt: number },
  now: number,
): boolean {
  const gap = Math.abs(a.rating - b.rating);
  return gap <= ratingWindow(now - a.joinedAt) && gap <= ratingWindow(now - b.joinedAt);
}

export type RatingInput<K extends string = string> = {
  key: K;
  rating: number;
  ratedGames: number;
  /** 1 = best. Equal placements count as a draw between those players. */
  placement: number;
  /** Set on every player for team games; the team's best placement is its result. */
  team?: Team;
};

export type RatingChange<K extends string = string> = {
  key: K;
  ratingBefore: number;
  ratingAfter: number;
  delta: number;
};

function score(placementA: number, placementB: number): number {
  if (placementA < placementB) return 1;
  if (placementA > placementB) return 0;
  return 0.5;
}

function rawDeltas(players: RatingInput[]): number[] {
  const isTeamGame =
    players.length > 0 &&
    players.every((p) => p.team !== undefined) &&
    new Set(players.map((p) => p.team)).size === 2;

  if (isTeamGame) {
    const teams = (["A", "B"] as Team[]).map((team) => {
      const members = players.filter((p) => p.team === team);
      return {
        team,
        average: members.reduce((sum, p) => sum + p.rating, 0) / members.length,
        placement: Math.min(...members.map((p) => p.placement)),
      };
    });
    return players.map((p) => {
      const mine = teams.find((t) => t.team === p.team)!;
      const theirs = teams.find((t) => t.team !== p.team)!;
      const s = score(mine.placement, theirs.placement);
      return kFactor(p.ratedGames) * (s - expectedScore(mine.average, theirs.average));
    });
  }

  const n = players.length;
  return players.map((p, i) => {
    let sum = 0;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const o = players[j]!;
      sum += score(p.placement, o.placement) - expectedScore(p.rating, o.rating);
    }
    return n > 1 ? (kFactor(p.ratedGames) * sum) / (n - 1) : 0;
  });
}

/**
 * Elo for one finished game. Free-for-all is pairwise Elo over the final
 * placements, scaled by 1/(n-1) so a 4-player game moves ratings about as
 * much as a duel. Team games compare team-average ratings and apply the
 * team result to every member.
 */
export function computeRatingChanges<K extends string>(
  players: RatingInput<K>[],
): RatingChange<K>[] {
  const deltas = rawDeltas(players);
  return players.map((p, i) => {
    const ratingAfter = Math.max(RATING_FLOOR, Math.round(p.rating + deltas[i]!));
    return {
      key: p.key,
      ratingBefore: p.rating,
      ratingAfter,
      delta: ratingAfter - p.rating,
    };
  });
}
