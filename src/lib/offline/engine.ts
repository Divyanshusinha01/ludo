/**
 * Client-side turn engine for offline play.
 * Rule decisions delegate to convex/lib/ludo.ts (unchanged).
 *
 * Out of scope: 60s turn timeout / lives / elimination, disconnect/rejoin, chat.
 */

import { freshEvents, withEvent, withEvents } from "../../../convex/lib/events";
import {
  allTokensInYard,
  buildFinalRankings,
  Color,
  COLORS,
  createInitialTokens,
  decideRollOutcome,
  findCaptureTargets,
  FINISHED_STEPS,
  gainsExtraTurn,
  getLegalMoves,
  hasWon,
  nextColorAmong,
  rollFairDice,
  shouldAssignAutomaticLoser,
  snapshotTokens,
  startsSixStreak,
  TokenSnapshot,
  tryMoveSteps,
} from "../../../convex/lib/ludo";
import type { OfflineGameState, OfflineSeat, OfflineSeatInput } from "./types";

export type MoveResult = {
  won: boolean;
  matchOver?: boolean;
  rank?: number;
  captured: boolean;
  reachedHome: boolean;
  leftYard: boolean;
  fromSteps: number;
  toSteps: number;
  extraTurn?: boolean;
  captures: Array<{ color: string; index: number }>;
};

export type RollResult = {
  value: number;
  skipped: boolean;
  legalMoves: number[];
  threeSixes?: boolean;
  rollAgain?: boolean;
  autoMoved?: boolean;
  autoMove?: MoveResult;
};

export class OfflineGameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OfflineGameError";
  }
}

function fail(message: string): never {
  throw new OfflineGameError(message);
}

function cloneState(state: OfflineGameState): OfflineGameState {
  return structuredClone(state);
}

function seatByColor(state: OfflineGameState, color: Color): OfflineSeat | undefined {
  return state.seats.find((s) => s.color === color);
}

/** Colours still in rotation (not finished). */
function playableColors(state: OfflineGameState): Color[] {
  return COLORS.filter((c) =>
    state.seats.some((s) => s.color === c && s.finishRank == null),
  );
}

function restoreTokenSnapshot(
  state: OfflineGameState,
  snapshot: TokenSnapshot[],
): OfflineGameState {
  const next = cloneState(state);
  for (const snap of snapshot) {
    const token = next.tokens.find(
      (t) => t.color === snap.color && t.index === snap.index,
    );
    if (token) token.steps = snap.steps;
  }
  return next;
}

function appendEvents(
  state: OfflineGameState,
  texts: string[],
  now: number,
): Pick<OfflineGameState, "lastEvent" | "events"> {
  return withEvents(state, texts, now);
}

function beginTurn(
  state: OfflineGameState,
  next: Color,
  patch: {
    diceValue?: number | null;
    lastEvent?: string;
    extraEvents?: string[];
  },
  now: number,
): OfflineGameState {
  const nextState = cloneState(state);
  const turnId = nextState.turnId + 1;
  const seat = seatByColor(nextState, next);
  const turnText = seat ? `${seat.name}'s turn` : `${next}'s turn`;

  const eventTexts = [
    ...(patch.extraEvents ?? []),
    ...(patch.lastEvent ? [patch.lastEvent] : []),
    turnText,
  ].filter(Boolean) as string[];

  const { lastEvent, events } = withEvents(nextState, eventTexts, now);

  nextState.currentTurn = next;
  nextState.diceValue = patch.diceValue ?? null;
  nextState.diceRolled = false;
  nextState.consecutiveSixes = 0;
  nextState.sixStreakSnapshot = null;
  nextState.turnId = turnId;
  nextState.lastEvent = lastEvent;
  nextState.events = events;
  return nextState;
}

function assignFinishRank(
  state: OfflineGameState,
  color: Color,
): { state: OfflineGameState; rankings: Color[] } {
  const next = cloneState(state);
  const seat = seatByColor(next, color);
  if (!seat) fail("Seat not found");

  const rankings = [...next.rankings];
  if (seat.finishRank != null) {
    return { state: next, rankings };
  }
  if (rankings.includes(color)) {
    seat.finishRank = rankings.indexOf(color) + 1;
    return { state: next, rankings };
  }
  rankings.push(color);
  seat.finishRank = rankings.length;
  next.rankings = rankings;
  return { state: next, rankings };
}

function maybeFinishAutomaticLoser(
  state: OfflineGameState,
  now: number,
): { state: OfflineGameState; finished: boolean } {
  const players = state.seats.map((s) => ({
    color: s.color,
    finishRank: s.finishRank,
    eliminated: false,
  }));
  if (!shouldAssignAutomaticLoser(players)) {
    return { state, finished: false };
  }

  const loser = state.seats.find((s) => s.finishRank == null);
  if (!loser) return { state, finished: false };

  const next = cloneState(state);
  const rankings = [...next.rankings];
  if (!rankings.includes(loser.color)) {
    rankings.push(loser.color);
  }
  for (const s of next.seats) {
    if (!rankings.includes(s.color)) rankings.push(s.color);
  }

  const loserSeat = seatByColor(next, loser.color)!;
  loserSeat.finishRank = rankings.indexOf(loser.color) + 1;
  next.rankings = rankings;
  const winner = rankings[0] ?? next.winner ?? null;
  const loserRank = loserSeat.finishRank;

  next.status = "finished";
  next.winner = winner;
  next.diceRolled = false;
  next.sixStreakSnapshot = null;
  next.finishedAt = now;
  Object.assign(
    next,
    withEvent(next, `${loser.name} places #${loserRank} — match over`, now),
  );
  return { state: next, finished: true };
}

function maybeFinishAllRanked(
  state: OfflineGameState,
  now: number,
): { state: OfflineGameState; finished: boolean } {
  if (state.seats.length === 0) return { state, finished: false };
  if (!state.seats.every((s) => s.finishRank != null)) {
    return { state, finished: false };
  }

  const next = cloneState(state);
  const rankings =
    next.rankings.length > 0
      ? [...next.rankings]
      : buildFinalRankings(
          [],
          next.seats[0]!.color,
          next.seats.map((s) => ({
            color: s.color,
            finishRank: s.finishRank,
          })),
        );

  for (const s of next.seats) {
    if (!rankings.includes(s.color)) rankings.push(s.color);
  }

  next.rankings = rankings;
  next.status = "finished";
  next.winner = rankings[0] ?? null;
  next.diceRolled = false;
  next.sixStreakSnapshot = null;
  next.finishedAt = now;
  Object.assign(
    next,
    withEvent(next, "Match complete — final rankings set", now),
  );
  return { state: next, finished: true };
}

function executeMove(
  state: OfflineGameState,
  color: Color,
  tokenIndex: number,
  now: number,
): { state: OfflineGameState; result: MoveResult } {
  if (!Number.isInteger(tokenIndex) || tokenIndex < 0 || tokenIndex > 3) {
    fail("Illegal move");
  }
  if (!state.diceRolled || state.diceValue === null) {
    fail("Roll the dice first");
  }
  const dice = state.diceValue;
  if (!Number.isInteger(dice) || dice < 1 || dice > 6) {
    fail("Invalid dice");
  }

  const seat = seatByColor(state, color);
  if (!seat || seat.finishRank != null) fail("Not your turn");

  const tokens = state.tokens;
  const legal = getLegalMoves(tokens, color, dice);
  if (!legal.includes(tokenIndex)) fail("Illegal move");

  const mover = tokens.find((t) => t.color === color && t.index === tokenIndex);
  if (!mover) fail("Illegal move");

  const fromSteps = mover.steps;
  const dest = tryMoveSteps(fromSteps, dice);
  if (dest === null) fail("Illegal move");

  let next = cloneState(state);
  const captures = findCaptureTargets(tokens, color, dest);
  const capturedKeys = new Set(captures.map((c) => `${c.color}:${c.index}`));

  next.tokens = next.tokens.map((t) => {
    if (t.color === color && t.index === tokenIndex) {
      return { ...t, steps: dest };
    }
    if (capturedKeys.has(`${t.color}:${t.index}`)) {
      return { ...t, steps: -1 };
    }
    return t;
  });

  next.diceRolled = false;

  const updatedTokens = next.tokens;
  const didCapture = captures.length > 0;
  const reachedHome = dest === FINISHED_STEPS;
  const leftYard = fromSteps === -1;
  const captureResult = {
    captured: didCapture,
    captures: captures.map((c) => ({ color: c.color, index: c.index })),
  };

  if (hasWon(updatedTokens, color)) {
    const ranked = assignFinishRank(next, color);
    next = ranked.state;
    const rank = ranked.rankings.indexOf(color) + 1;
    const isFirst = rank === 1;
    const placeNote = didCapture
      ? `${seat.name} captured and finished — #${rank}!`
      : `${seat.name} finished — #${rank}!`;

    next.diceValue = dice;
    next.consecutiveSixes = 0;
    next.sixStreakSnapshot = null;
    next.winner = isFirst ? color : (next.winner ?? color);
    Object.assign(next, withEvent(next, placeNote, now));

    let auto = maybeFinishAutomaticLoser(next, now);
    if (auto.finished) {
      return {
        state: auto.state,
        result: {
          won: true,
          matchOver: true,
          rank,
          ...captureResult,
          reachedHome,
          leftYard,
          fromSteps,
          toSteps: dest,
        },
      };
    }

    auto = maybeFinishAllRanked(next, now);
    if (auto.finished) {
      return {
        state: auto.state,
        result: {
          won: true,
          matchOver: true,
          rank,
          ...captureResult,
          reachedHome,
          leftYard,
          fromSteps,
          toSteps: dest,
        },
      };
    }

    const stillPlaying = playableColors(next);
    if (stillPlaying.length === 0) {
      auto = maybeFinishAllRanked(next, now);
      return {
        state: auto.state,
        result: {
          won: true,
          matchOver: true,
          rank,
          ...captureResult,
          reachedHome,
          leftYard,
          fromSteps,
          toSteps: dest,
        },
      };
    }

    next = beginTurn(
      next,
      nextColorAmong(state.currentTurn, stillPlaying),
      {
        diceValue: dice,
        lastEvent: `${seat.name} is done (#${rank}) — game continues`,
      },
      now,
    );

    return {
      state: next,
      result: {
        won: true,
        matchOver: false,
        rank,
        ...captureResult,
        reachedHome,
        leftYard,
        fromSteps,
        toSteps: dest,
      },
    };
  }

  const seated = playableColors(next);
  const extraTurn = gainsExtraTurn(dice, didCapture, reachedHome);
  let capturedLabel: string | undefined;
  if (captures.length === 1) {
    const only = captures[0]!;
    const victim = seatByColor(next, only.color);
    capturedLabel = victim?.name ?? only.color;
  } else if (captures.length > 1) {
    capturedLabel = `${captures.length} tokens`;
  }

  if (extraTurn) {
    const reason = reachedHome
      ? `${seat.name} reached home — roll again`
      : didCapture
        ? `${seat.name} captured ${capturedLabel} — roll again`
        : `${seat.name} rolled 6 — roll again`;
    const keepSixStreak = dice === 6;
    next.turnId = next.turnId + 1;
    next.diceValue = dice;
    next.consecutiveSixes = keepSixStreak ? next.consecutiveSixes : 0;
    next.sixStreakSnapshot = keepSixStreak ? next.sixStreakSnapshot : null;
    Object.assign(next, withEvent(next, reason, now));
  } else {
    const moveText = didCapture
      ? `${seat.name} captured ${capturedLabel}`
      : `${seat.name} moved`;
    next = beginTurn(
      next,
      nextColorAmong(state.currentTurn, seated),
      { diceValue: dice, lastEvent: moveText },
      now,
    );
  }

  return {
    state: next,
    result: {
      won: false,
      extraTurn,
      ...captureResult,
      reachedHome,
      leftYard,
      fromSteps,
      toSteps: dest,
    },
  };
}

function executeRoll(
  state: OfflineGameState,
  color: Color,
  now: number,
  random: () => number = Math.random,
): { state: OfflineGameState; result: RollResult } {
  if (state.diceRolled) fail("Dice already rolled");

  const seat = seatByColor(state, color);
  if (!seat || seat.finishRank != null) fail("Not your turn");

  const seated = playableColors(state);
  const tokens = state.tokens;
  const value = rollFairDice(allTokensInYard(tokens, color), random);
  const legalMoves = getLegalMoves(tokens, color, value);
  const decision = decideRollOutcome(value, state.consecutiveSixes, legalMoves.length);
  const captureSnapshot = startsSixStreak(value, state.consecutiveSixes);

  if (decision.kind === "three_sixes") {
    let next = state;
    const snapshot = state.sixStreakSnapshot;
    if (snapshot && snapshot.length > 0) {
      next = restoreTokenSnapshot(state, snapshot);
    }
    const event = snapshot?.length
      ? `${seat.name} rolled three 6s — moves undone, turn skipped`
      : `${seat.name} rolled three 6s — turn skipped`;
    next = beginTurn(next, nextColorAmong(state.currentTurn, seated), {
      diceValue: value,
      lastEvent: event,
    }, now);
    return {
      state: next,
      result: { value, skipped: true, threeSixes: true, legalMoves: [] },
    };
  }

  if (decision.kind === "no_moves_six") {
    const next = cloneState(state);
    next.diceValue = value;
    next.diceRolled = false;
    next.consecutiveSixes = decision.consecutiveSixes;
    if (captureSnapshot) {
      next.sixStreakSnapshot = snapshotTokens(tokens);
    }
    Object.assign(
      next,
      withEvent(next, `${seat.name} rolled 6 but cannot move — roll again`, now),
    );
    return { state: next, result: { value, skipped: false, legalMoves, rollAgain: true } };
  }

  if (decision.kind === "no_moves") {
    const next = beginTurn(state, nextColorAmong(state.currentTurn, seated), {
      diceValue: value,
      lastEvent: `${seat.name} rolled ${value} — no moves`,
    }, now);
    return { state: next, result: { value, skipped: true, legalMoves } };
  }

  const next = cloneState(state);
  next.diceValue = value;
  next.diceRolled = true;
  next.consecutiveSixes = decision.consecutiveSixes;
  if (captureSnapshot) {
    next.sixStreakSnapshot = snapshotTokens(tokens);
  }
  Object.assign(next, withEvent(next, `${seat.name} rolled ${value}`, now));

  if (legalMoves.length === 1) {
    const moved = executeMove(next, color, legalMoves[0]!, now);
    return {
      state: moved.state,
      result: {
        value,
        skipped: false,
        legalMoves,
        autoMoved: true,
        autoMove: moved.result,
      },
    };
  }

  return { state: next, result: { value, skipped: false, legalMoves } };
}

export function createOfflineGame(seats: OfflineSeatInput[]): OfflineGameState {
  if (seats.length < 2 || seats.length > 4) {
    fail("Need 2–4 players");
  }
  if (!seats.some((s) => !s.isBot)) {
    fail("Need at least one human player");
  }
  const colors = new Set(seats.map((s) => s.color));
  if (colors.size !== seats.length) {
    fail("Duplicate seat colours");
  }

  const activeColors = seats.map((s) => s.color);
  const now = Date.now();
  const first = activeColors[0]!;
  const firstSeat = seats.find((s) => s.color === first)!;
  const { lastEvent, events } = freshEvents(
    ["Local game started", `${firstSeat.name}'s turn`],
    now,
  );

  const initialSeats = seats.map((s) => ({
    ...s,
    finishRank: null as number | null,
  }));

  return {
    status: "playing",
    currentTurn: first,
    diceValue: null,
    diceRolled: false,
    consecutiveSixes: 0,
    sixStreakSnapshot: null,
    winner: null,
    rankings: [],
    events,
    lastEvent,
    turnId: 1,
    seats: initialSeats,
    tokens: createInitialTokens(activeColors),
    createdAt: now,
    finishedAt: null,
  };
}

export function rollDice(
  state: OfflineGameState,
  random: () => number = Math.random,
): { state: OfflineGameState; result: RollResult } {
  if (state.status !== "playing") fail("Game is not in progress");
  return executeRoll(state, state.currentTurn, Date.now(), random);
}

export function moveToken(
  state: OfflineGameState,
  tokenIndex: number,
): { state: OfflineGameState; result: MoveResult } {
  if (state.status !== "playing") fail("Game is not in progress");
  return executeMove(state, state.currentTurn, tokenIndex, Date.now());
}

export function rematch(state: OfflineGameState): OfflineGameState {
  if (state.status !== "finished") fail("Game is not finished");

  const seats: OfflineSeat[] = state.seats.map((s) => ({
    color: s.color,
    name: s.name,
    isBot: s.isBot,
    finishRank: null,
  }));

  const activeColors = seats.map((s) => s.color);
  const now = Date.now();
  const first = activeColors[0]!;
  const firstSeat = seats.find((s) => s.color === first)!;
  const { lastEvent, events } = freshEvents(
    [`Rematch — ${firstSeat.name} rolls first`, `${firstSeat.name}'s turn`],
    now,
  );

  return {
    status: "playing",
    currentTurn: first,
    diceValue: null,
    diceRolled: false,
    consecutiveSixes: 0,
    sixStreakSnapshot: null,
    winner: null,
    rankings: [],
    events,
    lastEvent,
    turnId: 1,
    seats,
    tokens: createInitialTokens(activeColors),
    createdAt: state.createdAt,
    finishedAt: null,
  };
}

/** Whether the current seat is a bot that should act automatically. */
export function isBotTurn(state: OfflineGameState): boolean {
  if (state.status !== "playing") return false;
  const seat = seatByColor(state, state.currentTurn);
  return !!seat?.isBot && seat.finishRank == null;
}
