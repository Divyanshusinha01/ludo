export type Color = "red" | "green" | "yellow" | "blue";

export const COLORS: Color[] = ["red", "green", "yellow", "blue"];

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

export type TokenState = {
  color: Color;
  index: number;
  steps: number;
};

export function nextColor(color: Color): Color {
  const i = COLORS.indexOf(color);
  return COLORS[(i + 1) % COLORS.length]!;
}

export function absoluteTrackPosition(color: Color, steps: number): number | null {
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

    // Block stacking beyond finished; allow same-color stacking on track/home.
    // Own token already on exact finished is fine; cannot land on own token
    // that is finished from another token — finished tokens stay.
    if (dest < FINISHED_STEPS) {
      const blockedByOwn = mine.some(
        (o) => o.index !== token.index && o.steps === dest && dest >= 0,
      );
      // Same-cell stacking of own tokens is allowed in many house rules;
      // keep allowed for simplicity (no block).
      void blockedByOwn;
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

  for (const t of tokens) {
    if (t.color === moverColor) continue;
    if (t.steps < 0 || t.steps > MAX_TRACK_STEPS) continue;
    const otherAbs = absoluteTrackPosition(t.color, t.steps);
    if (otherAbs === abs) return t;
  }
  return null;
}

export function hasWon(tokens: TokenState[], color: Color): boolean {
  return tokens
    .filter((t) => t.color === color)
    .every((t) => t.steps === FINISHED_STEPS);
}

export function createInitialTokens(): TokenState[] {
  const out: TokenState[] = [];
  for (const color of COLORS) {
    for (let index = 0; index < 4; index++) {
      out.push({ color, index, steps: -1 });
    }
  }
  return out;
}

export function generateRoomCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}
