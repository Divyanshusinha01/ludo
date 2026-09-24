import {
  Color,
  FINISHED_STEPS,
  HOME_ENTRY_STEPS,
  TokenState,
  findCaptureTarget,
  getLegalMoves,
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

/**
 * Pick a legal token index. Prefers capture → finish → enter home stretch →
 * leave yard → advance the farthest token on track.
 */
export function pickBotMove(
  tokens: TokenState[],
  color: Color,
  dice: number,
): number | null {
  const legal = getLegalMoves(tokens, color, dice);
  if (legal.length === 0) return null;
  if (legal.length === 1) return legal[0]!;

  let best = legal[0]!;
  let bestScore = -Infinity;

  for (const index of legal) {
    const token = tokens.find((t) => t.color === color && t.index === index);
    if (!token) continue;
    const dest = tryMoveSteps(token.steps, dice);
    if (dest === null) continue;

    let score = 0;
    if (findCaptureTarget(tokens, color, dest)) score += 1000;
    if (dest === FINISHED_STEPS) score += 800;
    if (token.steps < HOME_ENTRY_STEPS && dest >= HOME_ENTRY_STEPS) score += 400;
    if (token.steps === -1) score += 200;
    // Prefer advancing tokens already on the board / home stretch.
    score += Math.max(0, dest);
    // Slight preference for lower index on ties (stable).
    score -= index * 0.01;

    if (score > bestScore) {
      bestScore = score;
      best = index;
    }
  }

  return best;
}
