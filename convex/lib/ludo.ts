export type Color = "red" | "green" | "yellow" | "blue";

export const COLORS: Color[] = ["red", "green", "yellow", "blue"];

/** Opposite houses on the board (classic 2-player seating). */
export const OPPOSITE_COLOR: Record<Color, Color> = {
  red: "yellow",
  yellow: "red",
  green: "blue",
  blue: "green",
};

/**
 * Next free house. When only one seat is taken, prefer the opposite corner
 * so a 2-player game sits across the board (red↔yellow / green↔blue).
 */
export function pickNextColor(seated: Color[]): Color | undefined {
  if (seated.length === 1) {
    const opposite = OPPOSITE_COLOR[seated[0]!];
    if (!seated.includes(opposite)) return opposite;
  }
  return COLORS.find((c) => !seated.includes(c));
}

export const COLOR_START: Record<Color, number> = {
  red: 0,
  green: 13,
  yellow: 26,
  blue: 39,
};

/** Absolute track indices that are always safe. */
export const SAFE_CELLS = new Set<number>([
  0, 8, 13, 21, 26, 34, 39, 47,
]);

export const FINISHED_STEPS = 56;
export const HOME_ENTRY_STEPS = 51;
export const MAX_TRACK_STEPS = 50;

/** Per-turn deadline (server-authoritative). */
export const TURN_TIMEOUT_MS = 60_000;
/** Timeouts before a player is eliminated. */
export const MAX_TIMEOUT_LIVES = 3;
/** How long a disconnected seat is kept before AFK skip / abandon logic. */
export const RECONNECT_WINDOW_MS = 60_000;

/**
 * Winner-first standings. Existing finishers stay at the front; the winner
 * is next if missing; everyone else follows by finishRank ascending
 * (higher finishRank = worse place = later in the list).
 */
export function buildFinalRankings(
  existing: Color[],
  winner: Color,
  others: Array<{ color: Color; finishRank?: number | null }>,
): Color[] {
  const rankings: Color[] = [];
  for (const c of existing) {
    if (!rankings.includes(c)) rankings.push(c);
  }
  if (!rankings.includes(winner)) rankings.push(winner);

  const rest = others
    .filter((p) => p.color !== winner && !rankings.includes(p.color))
    .sort(
      (a, b) =>
        (a.finishRank ?? 999) - (b.finishRank ?? 999) ||
        COLORS.indexOf(a.color) - COLORS.indexOf(b.color),
    );
  for (const p of rest) rankings.push(p.color);
  return rankings;
}

/** Ambiguity-free charset for room codes (no 0/O/1/I). */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export type TokenState = {
  color: Color;
  index: number;
  steps: number;
};

/** Next colour in seating order among active players. */
export function nextColorAmong(color: Color, active: Color[]): Color {
  const ordered = COLORS.filter((c) => active.includes(c));
  if (ordered.length === 0) return color;
  const i = ordered.indexOf(color);
  if (i < 0) return ordered[0]!;
  return ordered[(i + 1) % ordered.length]!;
}

/** @deprecated Prefer nextColorAmong with seated colours. */
export function nextColor(color: Color): Color {
  return nextColorAmong(color, COLORS);
}

export function absoluteTrackPosition(
  color: Color,
  steps: number,
): number | null {
  if (steps < 0 || steps > MAX_TRACK_STEPS) return null;
  return (COLOR_START[color] + steps) % 52;
}

export function isSafeAbsolute(abs: number): boolean {
  return SAFE_CELLS.has(abs);
}

export function canRelease(dice: number): boolean {
  return dice === 6;
}

/** Returns destination steps after applying dice, or null if illegal. */
export function tryMoveSteps(steps: number, dice: number): number | null {
  if (steps === -1) {
    return canRelease(dice) ? 0 : null;
  }
  if (steps >= FINISHED_STEPS) return null;

  const dest = steps + dice;
  if (dest > FINISHED_STEPS) return null;
  return dest;
}

/** Count tokens on an absolute track cell, grouped by colour. */
export function countByColorOnAbsolute(
  tokens: TokenState[],
  abs: number,
): Partial<Record<Color, number>> {
  const counts: Partial<Record<Color, number>> = {};
  for (const t of tokens) {
    if (t.steps < 0 || t.steps > MAX_TRACK_STEPS) continue;
    const otherAbs = absoluteTrackPosition(t.color, t.steps);
    if (otherAbs !== abs) continue;
    counts[t.color] = (counts[t.color] ?? 0) + 1;
  }
  return counts;
}

/**
 * Two or more tokens of the same colour on one cell form a barrier:
 * opponents cannot *land* there or capture them. Path-through is allowed
 * (classic family rules — barriers block destination only, not jumps).
 */
export function isBarrierAbsolute(
  tokens: TokenState[],
  abs: number,
  forMover: Color,
): boolean {
  const counts = countByColorOnAbsolute(tokens, abs);
  for (const color of COLORS) {
    if (color === forMover) continue;
    if ((counts[color] ?? 0) >= 2) return true;
  }
  return false;
}

export function getLegalMoves(
  tokens: TokenState[],
  color: Color,
  dice: number,
): number[] {
  const mine = tokens.filter((t) => t.color === color);
  const legal: number[] = [];

  for (const token of mine) {
    const dest = tryMoveSteps(token.steps, dice);
    if (dest === null) continue;

    // Track landing blocked by an opponent barrier (2+ stacked).
    if (dest >= 0 && dest <= MAX_TRACK_STEPS) {
      const abs = absoluteTrackPosition(color, dest);
      if (abs !== null && isBarrierAbsolute(tokens, abs, color)) continue;
    }

    legal.push(token.index);
  }

  return legal;
}

export function findCaptureTarget(
  tokens: TokenState[],
  moverColor: Color,
  destSteps: number,
): TokenState | null {
  if (destSteps < 0 || destSteps > MAX_TRACK_STEPS) return null;
  const abs = absoluteTrackPosition(moverColor, destSteps);
  if (abs === null || isSafeAbsolute(abs)) return null;
  if (isBarrierAbsolute(tokens, abs, moverColor)) return null;

  const counts = countByColorOnAbsolute(tokens, abs);
  for (const t of tokens) {
    if (t.color === moverColor) continue;
    if (t.steps < 0 || t.steps > MAX_TRACK_STEPS) continue;
    const otherAbs = absoluteTrackPosition(t.color, t.steps);
    if (otherAbs !== abs) continue;
    // Only capture a lone token (not part of a barrier stack).
    if ((counts[t.color] ?? 0) >= 2) continue;
    return t;
  }
  return null;
}

export function hasWon(tokens: TokenState[], color: Color): boolean {
  const mine = tokens.filter((t) => t.color === color);
  if (mine.length === 0) return false;
  return mine.every((t) => t.steps === FINISHED_STEPS);
}

export function createInitialTokens(
  colors: Color[] = COLORS,
): TokenState[] {
  const out: TokenState[] = [];
  for (const color of colors) {
    for (let index = 0; index < 4; index++) {
      out.push({ color, index, steps: -1 });
    }
  }
  return out;
}

export function generateRoomCode(): string {
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]!;
  }
  return code;
}

/** Weight for faces 1–5. Face 6 uses this too unless yard anti-stall applies. */
export const DICE_FACE_WEIGHT = 1;
/**
 * Mild anti-stall: when every token is still in the yard, face 6 gets this
 * weight (others stay at 1). P(6) = 2/7 ≈ 28.6% instead of 1/6 ≈ 16.7%.
 * Never guarantees a 6 and does not consider legal moves.
 */
export const YARD_SIX_WEIGHT = 2;

/** True when the colour has tokens and every one is still in the yard. */
export function allTokensInYard(
  tokens: TokenState[],
  color: Color,
): boolean {
  const mine = tokens.filter((t) => t.color === color);
  return mine.length > 0 && mine.every((t) => t.steps === -1);
}

/**
 * Server-authoritative fair roll. Uniform 1–6 normally; mild extra weight
 * on 6 only when all of that player's tokens are still in the yard.
 * `random` is injectable for tests (must return [0, 1)).
 */
export function rollFairDice(
  allInYard: boolean,
  random: () => number = Math.random,
): number {
  if (!allInYard) {
    return 1 + Math.floor(random() * 6);
  }

  const weights = [
    DICE_FACE_WEIGHT,
    DICE_FACE_WEIGHT,
    DICE_FACE_WEIGHT,
    DICE_FACE_WEIGHT,
    DICE_FACE_WEIGHT,
    YARD_SIX_WEIGHT,
  ];
  const total = weights.reduce((sum, w) => sum + w, 0);
  let cursor = random() * total;
  for (let face = 0; face < 6; face++) {
    cursor -= weights[face]!;
    if (cursor < 0) return face + 1;
  }
  return 6;
}

/** Pure roll outcome used by rollDice and unit tests. */
export type RollDecision =
  | { kind: "three_sixes"; consecutiveSixes: 0 }
  | { kind: "no_moves_six"; consecutiveSixes: number }
  | { kind: "no_moves"; consecutiveSixes: 0 }
  | { kind: "ok"; consecutiveSixes: number };

export function decideRollOutcome(
  value: number,
  consecutiveSixesBefore: number,
  legalMoveCount: number,
): RollDecision {
  const consecutiveSixes = value === 6 ? consecutiveSixesBefore + 1 : 0;
  if (consecutiveSixes >= 3) {
    return { kind: "three_sixes", consecutiveSixes: 0 };
  }
  if (legalMoveCount === 0) {
    if (value === 6) {
      return { kind: "no_moves_six", consecutiveSixes };
    }
    return { kind: "no_moves", consecutiveSixes: 0 };
  }
  return { kind: "ok", consecutiveSixes };
}

/**
 * Extra turn after a successful move: roll of 6, capture, or reaching home.
 * (Classic family Ludo — finishing a token grants another roll.)
 */
export function gainsExtraTurn(
  dice: number,
  captured: boolean,
  reachedHome = false,
): boolean {
  return dice === 6 || captured || reachedHome;
}

/**
 * On three consecutive sixes the turn is voided. If a token was moved
 * during the six-streak, that token returns to the yard; otherwise the
 * player's furthest token still on the board/home stretch is returned.
 */
export function pickThreeSixesPenaltyToken(
  tokens: TokenState[],
  color: Color,
  lastMovedIndex: number | null,
): number | null {
  const mine = tokens.filter(
    (t) => t.color === color && t.steps >= 0 && t.steps < FINISHED_STEPS,
  );
  if (mine.length === 0) return null;

  if (lastMovedIndex !== null) {
    const last = mine.find((t) => t.index === lastMovedIndex);
    if (last) return last.index;
  }

  mine.sort((a, b) => b.steps - a.steps || a.index - b.index);
  return mine[0]!.index;
}

/** Fan-out offsets for N tokens sharing one cell (SVG units). */
export function stackFanOffset(
  indexInStack: number,
  stackSize: number,
): { x: number; y: number } {
  if (stackSize <= 1) return { x: 0, y: 0 };
  const radius = stackSize === 2 ? 14 : stackSize === 3 ? 16 : 18;
  const angle =
    (Math.PI * 2 * indexInStack) / stackSize - Math.PI / 2;
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}
