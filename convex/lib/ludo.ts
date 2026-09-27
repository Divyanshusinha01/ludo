export type Color = "red" | "green" | "yellow" | "blue";

export const COLORS: Color[] = ["red", "green", "yellow", "blue"];

/** Opposite houses on the board (classic 2-player seating). */
export const OPPOSITE_COLOR: Record<Color, Color> = {
  red: "yellow",
  yellow: "red",
  green: "blue",
  blue: "green",
};

export type Team = "A" | "B";
export type GameMode = "1v1" | "2v2";

export const TEAM_COLORS: Record<Team, Color[]> = {
  A: ["red", "yellow"],
  B: ["green", "blue"],
};

export function teamOfColor(color: Color): Team {
  return TEAM_COLORS.A.includes(color) ? "A" : "B";
}

/** Next free seat colour on a fixed team (red/yellow or green/blue). */
export function pickNextColorForTeam(
  seated: Color[],
  team: Team,
): Color | undefined {
  return TEAM_COLORS[team].find((c) => !seated.includes(c));
}

export type TeamPlayerLike = {
  color: Color;
  team?: Team;
  eliminated?: boolean;
  finishRank?: number | null;
};

export function playerTeam(p: TeamPlayerLike): Team {
  return p.team ?? teamOfColor(p.color);
}

function teamMembers(players: TeamPlayerLike[], team: Team): TeamPlayerLike[] {
  return players.filter((p) => playerTeam(p) === team);
}

/** Both teammates finished home (not eliminated). */
export function teamIsAllHome(players: TeamPlayerLike[], team: Team): boolean {
  const members = teamMembers(players, team);
  if (members.length < 2) return false;
  return members.every((p) => !p.eliminated && p.finishRank != null);
}

/**
 * Every teammate is home or eliminated, but not both home — team cannot win.
 */
export function teamIsSpent(players: TeamPlayerLike[], team: Team): boolean {
  const members = teamMembers(players, team);
  if (members.length < 2) return false;
  const allDone = members.every(
    (p) => p.eliminated || p.finishRank != null,
  );
  const allHome = members.every(
    (p) => !p.eliminated && p.finishRank != null,
  );
  return allDone && !allHome;
}

/** Fixed 2v2 partner (red↔yellow, green↔blue). */
export function teamTeammateColor(color: Color): Color {
  return OPPOSITE_COLOR[color];
}

export function isPlayerFinished(p: TeamPlayerLike): boolean {
  return !p.eliminated && p.finishRank != null;
}

/**
 * Who rolls and moves for this rotation seat. In 2v2, a finished seat is
 * played by their teammate.
 */
export function turnActorColor(
  seatColor: Color,
  players: TeamPlayerLike[],
  mode?: GameMode,
): Color {
  if (mode !== "2v2") return seatColor;
  const seat = players.find((p) => p.color === seatColor);
  if (seat && isPlayerFinished(seat)) {
    return teamTeammateColor(seatColor);
  }
  return seatColor;
}

/** Token colours the actor may move (own + finished teammate's in 2v2). */
export function controllableColorsForActor(
  actorColor: Color,
  players: TeamPlayerLike[],
  mode?: GameMode,
): Color[] {
  if (mode !== "2v2") return [actorColor];
  const team = teamOfColor(actorColor);
  const colors: Color[] = [actorColor];
  for (const c of TEAM_COLORS[team]) {
    if (c === actorColor) continue;
    const p = players.find((pl) => pl.color === c);
    if (p && isPlayerFinished(p)) colors.push(c);
  }
  return colors;
}

/**
 * Turn rotation pool. 1v1 skips finished players; 2v2 keeps finished seats so
 * the teammate can play those turns.
 */
export function rotationColors(
  players: TeamPlayerLike[],
  mode?: GameMode,
): Color[] {
  const seated = COLORS.filter((c) =>
    players.some((p) => p.color === c && !p.eliminated),
  );
  if (mode !== "2v2") {
    return seated.filter((c) => {
      const p = players.find((pl) => pl.color === c);
      return p && !isPlayerFinished(p);
    });
  }
  return seated;
}

export function nextTurnSeatColor(
  currentSeat: Color,
  players: TeamPlayerLike[],
  mode?: GameMode,
): Color {
  return nextColorAmong(currentSeat, rotationColors(players, mode));
}

export type TokenMoveChoice = { color: Color; index: number };

/** Who may roll on this turn (2v2: seat actor while no delegated roll pending). */
export function rollControllerColor(
  seatColor: Color,
  players: TeamPlayerLike[],
  mode: GameMode | undefined,
  _passedRollTo: Color | null | undefined,
): Color {
  return turnActorColor(seatColor, players, mode);
}

/** Who may move tokens now (2v2 delegate or normal seat actor). */
export function moveControllerColor(
  seatColor: Color,
  players: TeamPlayerLike[],
  mode: GameMode | undefined,
  passedRollTo: Color | null | undefined,
): Color {
  if (passedRollTo != null) return passedRollTo;
  return turnActorColor(seatColor, players, mode);
}

/** Legal moves when a teammate is consuming a passed roll (own colour only). */
export function legalMovesForDelegatedRoll(
  tokens: TokenState[],
  delegateColor: Color,
  dice: number,
): TokenMoveChoice[] {
  const moves: TokenMoveChoice[] = [];
  for (const index of getLegalMoves(tokens, delegateColor, dice)) {
    moves.push({ color: delegateColor, index });
  }
  return moves;
}

/**
 * After a delegated move, rotation stays on the seat; extra rolls stay with the seat actor.
 */
export function turnSeatAfterDelegatedMove(
  seatColor: Color,
  dice: number,
  didCapture: boolean,
  reachedHome: boolean,
  players: TeamPlayerLike[],
  mode: GameMode | undefined,
): { nextSeat: Color; grantsExtraRoll: boolean } {
  const grantsExtraRoll = gainsExtraTurn(dice, didCapture, reachedHome);
  if (grantsExtraRoll) {
    return { nextSeat: seatColor, grantsExtraRoll: true };
  }
  return {
    nextSeat: nextTurnSeatColor(seatColor, players, mode),
    grantsExtraRoll: false,
  };
}

/**
 * In 2v2, passing hands off a pending rolled die for one teammate move.
 */
export function shouldTransferRollToTeammate(
  room: { diceRolled: boolean; diceValue: number | null },
  _actorColor: Color,
  teammateColor: Color,
  tokens: TokenState[],
  _players: TeamPlayerLike[],
  mode: GameMode | undefined,
): boolean {
  const dice = room.diceValue;
  if (dice === null || !room.diceRolled) return false;
  if (mode !== "2v2") return false;
  return legalMovesForDelegatedRoll(tokens, teammateColor, dice).length > 0;
}

/**
 * 2v2 seat holder rolled but cannot move — hand the die to a live teammate
 * when they can use it on their own tokens.
 */
export function shouldKeepRollForTeammatePass(
  mode: GameMode | undefined,
  seatColor: Color,
  dice: number,
  tokens: TokenState[],
  players: TeamPlayerLike[],
): boolean {
  if (mode !== "2v2") return false;
  const teammateColor = teamTeammateColor(seatColor);
  const teammate = players.find((p) => p.color === teammateColor);
  if (
    !teammate ||
    teammate.eliminated ||
    teammate.finishRank != null
  ) {
    return false;
  }
  return shouldTransferRollToTeammate(
    { diceRolled: true, diceValue: dice },
    seatColor,
    teammateColor,
    tokens,
    players,
    mode,
  );
}

export function getLegalMovesForActor(
  tokens: TokenState[],
  actorColor: Color,
  players: TeamPlayerLike[],
  mode: GameMode | undefined,
  dice: number,
): TokenMoveChoice[] {
  const colors = controllableColorsForActor(actorColor, players, mode);
  const moves: TokenMoveChoice[] = [];
  for (const color of colors) {
    for (const index of getLegalMoves(tokens, color, dice)) {
      moves.push({ color, index });
    }
  }
  return moves;
}

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

/** Fixed seat order for a full table of `count` players (2–4). */
export function seatingColors(count: number): Color[] {
  const seated: Color[] = [];
  const n = Math.min(4, Math.max(0, Math.floor(count)));
  for (let i = 0; i < n; i++) {
    const next = pickNextColor(seated);
    if (!next) break;
    seated.push(next);
  }
  return seated;
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

/** True when all 8 tokens for a team are in the centre (2v2 win). */
export function teamAllTokensHome(
  tokens: TokenState[],
  team: Team,
): boolean {
  for (const color of TEAM_COLORS[team]) {
    const mine = tokens.filter((t) => t.color === color);
    if (mine.length === 0) return false;
    if (!mine.every((t) => t.steps === FINISHED_STEPS)) return false;
  }
  return true;
}

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

/**
 * True when exactly one seat can still play and at least one other seat
 * finished by completing home. Ranking can no longer change — the remaining
 * player is the automatic last-place loser (N players → end after N−1 finishers).
 *
 * Does NOT fire when every other seat was eliminated/forfeited (that case is
 * a sole-survivor win, not a last-place assignment).
 */
export function shouldAssignAutomaticLoser(
  players: Array<{ eliminated?: boolean; finishRank?: number | null }>,
): boolean {
  const playable = players.filter(
    (p) => !p.eliminated && p.finishRank == null,
  );
  if (playable.length !== 1) return false;
  return players.some(
    (p) => !p.eliminated && p.finishRank != null,
  );
}

/** Label shown under #rank inside a finished player's house. */
export function rankHouseLabel(
  rank: number,
  playerCount: number,
): "WINNER" | "LOSE" | null {
  if (rank === 1) return "WINNER";
  if (playerCount > 0 && rank === playerCount) return "LOSE";
  return null;
}

/**
 * Among candidate token centres, pick the one whose hit circle contains
 * `point` and is closest to the pointer (stable tie-break by index).
 * Does not rely on SVG paint order.
 */
export function resolveTokenHit(
  point: { x: number; y: number },
  candidates: Array<{ index: number; x: number; y: number }>,
  hitRadius: number = 44,
): number | null {
  let best: { index: number; dist: number } | null = null;
  for (const c of candidates) {
    const dist = Math.hypot(point.x - c.x, point.y - c.y);
    if (dist > hitRadius) continue;
    if (
      !best ||
      dist < best.dist ||
      (dist === best.dist && c.index < best.index)
    ) {
      best = { index: c.index, dist };
    }
  }
  return best?.index ?? null;
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
    legal.push(token.index);
  }

  return legal;
}

/**
 * Every opposing token on the destination cell (classic rules: stacks are
 * capturable). Empty on safe cells or when the destination is off-track.
 */
export function findCaptureTargets(
  tokens: TokenState[],
  moverColor: Color,
  destSteps: number,
  mode?: GameMode,
): TokenState[] {
  if (destSteps < 0 || destSteps > MAX_TRACK_STEPS) return [];
  const abs = absoluteTrackPosition(moverColor, destSteps);
  if (abs === null || isSafeAbsolute(abs)) return [];

  const captured: TokenState[] = [];
  for (const t of tokens) {
    if (t.color === moverColor) continue;
    if (
      mode === "2v2" &&
      teamOfColor(t.color) === teamOfColor(moverColor)
    ) {
      continue;
    }
    if (t.steps < 0 || t.steps > MAX_TRACK_STEPS) continue;
    const otherAbs = absoluteTrackPosition(t.color, t.steps);
    if (otherAbs !== abs) continue;
    captured.push(t);
  }
  return captured;
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

/** Board snapshot used to roll back a voided three-six streak. */
export type TokenSnapshot = {
  color: Color;
  index: number;
  steps: number;
};

/** Capture full board positions before the first six of a streak. */
export function snapshotTokens(tokens: TokenState[]): TokenSnapshot[] {
  return tokens.map((t) => ({
    color: t.color,
    index: t.index,
    steps: t.steps,
  }));
}

/**
 * True when this roll starts a new consecutive-six streak (first 6 after a
 * non-six or a fresh turn). Snapshot must be taken on the server at this moment.
 */
export function startsSixStreak(
  value: number,
  consecutiveSixesBefore: number,
): boolean {
  return value === 6 && consecutiveSixesBefore === 0;
}

/**
 * Whether two tokens share the same visual board cell (for overlap selection).
 * Yard tokens occupy unique slots and never share a cell.
 */
export function tokensShareCell(a: TokenState, b: TokenState): boolean {
  if (a.steps < 0 || b.steps < 0) return false;
  if (a.steps === FINISHED_STEPS && b.steps === FINISHED_STEPS) {
    return a.color === b.color;
  }
  if (
    a.steps >= HOME_ENTRY_STEPS &&
    a.steps < FINISHED_STEPS &&
    b.steps >= HOME_ENTRY_STEPS &&
    b.steps < FINISHED_STEPS
  ) {
    return a.color === b.color && a.steps === b.steps;
  }
  if (a.steps >= 0 && a.steps <= MAX_TRACK_STEPS && b.steps >= 0 && b.steps <= MAX_TRACK_STEPS) {
    const absA = absoluteTrackPosition(a.color, a.steps);
    const absB = absoluteTrackPosition(b.color, b.steps);
    return absA !== null && absA === absB;
  }
  return false;
}

/**
 * Among `legalIndexes` for `color`, return every index that shares a cell with
 * the token at `clickedIndex` (including itself). Used for overlap pickers.
 */
export function legalIndexesAtSameCell(
  tokens: TokenState[],
  color: Color,
  legalIndexes: number[],
  clickedIndex: number,
): number[] {
  const clicked = tokens.find(
    (t) => t.color === color && t.index === clickedIndex,
  );
  if (!clicked || !legalIndexes.includes(clickedIndex)) return [];

  return legalIndexes.filter((index) => {
    const t = tokens.find((x) => x.color === color && x.index === index);
    if (!t) return false;
    if (index === clickedIndex) return true;
    return tokensShareCell(clicked, t);
  });
}

/** Fan-out offsets for N tokens sharing one cell (SVG units). */
export function stackFanOffset(
  indexInStack: number,
  stackSize: number,
): { x: number; y: number } {
  if (stackSize <= 1) return { x: 0, y: 0 };
  // Wider fan so overlapping tokens keep distinct hit areas on mobile.
  const radius = stackSize === 2 ? 28 : stackSize === 3 ? 32 : 36;
  const angle =
    (Math.PI * 2 * indexInStack) / stackSize - Math.PI / 2;
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}
