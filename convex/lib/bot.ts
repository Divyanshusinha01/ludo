import {
  COLOR_START,
  COLORS,
  Color,
  FINISHED_STEPS,
  HOME_ENTRY_STEPS,
  MAX_TRACK_STEPS,
  TokenState,
  absoluteTrackPosition,
  findCaptureTarget,
  getLegalMoves,
  isSafeAbsolute,
  tryMoveSteps,
} from "./ludo";

/** Delay before a bot rolls or moves so the UI can show dice / turn change. */
export const BOT_THINK_MS = 700;

/**
 * Synthetic session id for a bot seat. Not a UUID — public mutations reject it
 * via assertValidClientId, so clients cannot impersonate bots.
 */
export function botClientId(roomId: string, color: Color): string {
  return `bot:${roomId}:${color}`;
}

export function botDisplayName(botIndex: number): string {
  return botIndex === 0 ? "Computer" : `Computer ${botIndex + 1}`;
}

/** Circular track distance from attackerAbs forward to defenderAbs (0–51). */
export function trackDistanceBehind(
  attackerAbs: number,
  defenderAbs: number,
): number {
  return (defenderAbs - attackerAbs + 52) % 52;
}

/** First cell after any opponent's yard exit (COLOR_START). */
export function isOutsideEnemyYard(abs: number, myColor: Color): boolean {
  for (const color of COLORS) {
    if (color === myColor) continue;
    if (abs === (COLOR_START[color] + 1) % 52) return true;
  }
  return false;
}

/** Tokens on the board or home stretch (not yard, not finished). */
export function countActiveTokens(
  tokens: TokenState[],
  color: Color,
): number {
  return tokens.filter(
    (t) =>
      t.color === color && t.steps >= 0 && t.steps < FINISHED_STEPS,
  ).length;
}

/**
 * True when an opponent on the main track is 1–6 cells behind this token
 * (7-step rule). Tokens on safe cells or off-track are not in danger.
 */
export function isInImmediateDanger(
  tokens: TokenState[],
  color: Color,
  steps: number,
): boolean {
  const abs = absoluteTrackPosition(color, steps);
  if (abs === null || isSafeAbsolute(abs)) return false;

  for (const t of tokens) {
    if (t.color === color) continue;
    if (t.steps < 0 || t.steps > MAX_TRACK_STEPS) continue;
    const enemyAbs = absoluteTrackPosition(t.color, t.steps);
    if (enemyAbs === null) continue;
    const dist = trackDistanceBehind(enemyAbs, abs);
    if (dist >= 1 && dist <= 6) return true;
  }
  return false;
}

function friendlyOnAbsolute(
  tokens: TokenState[],
  color: Color,
  abs: number,
  excludeIndex: number,
): boolean {
  for (const t of tokens) {
    if (t.color !== color || t.index === excludeIndex) continue;
    if (t.steps < 0 || t.steps > MAX_TRACK_STEPS) continue;
    if (absoluteTrackPosition(t.color, t.steps) === abs) return true;
  }
  return false;
}

/**
 * Hard difficulty: Dynamic Weight Formula.
 * Priority = kill + goal + safe + escape + progress + deploy + home stretch
 *            + spacing/yard balance − risk − stack penalty.
 */
export function pickBotMove(
  tokens: TokenState[],
  color: Color,
  dice: number,
): number | null {
  const legal = getLegalMoves(tokens, color, dice);
  if (legal.length === 0) return null;
  if (legal.length === 1) return legal[0]!;

  const activeCount = countActiveTokens(tokens, color);
  const mine = tokens.filter((t) => t.color === color);
  const maxActiveSteps = mine.reduce(
    (max, t) =>
      t.steps >= 0 && t.steps < FINISHED_STEPS
        ? Math.max(max, t.steps)
        : max,
    -1,
  );
  const hasLaggingLegal = legal.some((index) => {
    const t = mine.find((x) => x.index === index);
    return t !== undefined && t.steps >= 0 && t.steps < maxActiveSteps - 10;
  });

  let best = legal[0]!;
  let bestScore = -Infinity;

  for (const index of legal) {
    const token = tokens.find((t) => t.color === color && t.index === index);
    if (!token) continue;
    const dest = tryMoveSteps(token.steps, dice);
    if (dest === null) continue;

    let score = 0;

    // Kill bonus
    if (findCaptureTarget(tokens, color, dest)) score += 100;

    // Goal
    if (dest === FINISHED_STEPS) score += 80;

    // Enter home stretch
    if (token.steps < HOME_ENTRY_STEPS && dest >= HOME_ENTRY_STEPS) {
      score += 70;
    }

    const destAbs = absoluteTrackPosition(color, dest);

    // Safe zone landing
    if (destAbs !== null && isSafeAbsolute(destAbs)) score += 60;

    // Escape danger (7-step: only 1–6 behind counts)
    const inDanger = isInImmediateDanger(tokens, color, token.steps);
    if (inDanger) {
      const stillDangerous =
        destAbs !== null &&
        !isSafeAbsolute(destAbs) &&
        dest < HOME_ENTRY_STEPS &&
        isInImmediateDanger(
          // Simulate token at dest for threat check
          tokens.map((t) =>
            t.color === color && t.index === index
              ? { ...t, steps: dest }
              : t,
          ),
          color,
          dest,
        );
      if (!stillDangerous) score += 50;
    }

    // Deploy on 6
    if (token.steps === -1) {
      score += 55;
      if (activeCount < 2) score += 40;
    }

    // Progress: spaces moved / 2 (yard release uses deploy bonus instead)
    if (token.steps !== -1) score += dice / 2;

    // Risk: landing (or remaining) directly outside an enemy yard
    if (destAbs !== null && isOutsideEnemyYard(destAbs, color)) {
      score -= 30;
    }

    // Spacing: avoid stacking on the same tile
    if (
      destAbs !== null &&
      friendlyOnAbsolute(tokens, color, destAbs, index)
    ) {
      score -= 25;
    }

    // Yard management: discourage runaway when others lag
    if (
      activeCount >= 3 &&
      hasLaggingLegal &&
      token.steps === maxActiveSteps &&
      token.steps >= 0
    ) {
      score -= 20;
    }

    // Stable tie-break
    score -= index * 0.01;

    if (score > bestScore) {
      bestScore = score;
      best = index;
    }
  }

  return best;
}
